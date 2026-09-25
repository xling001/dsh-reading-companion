/**
 * 回收站（`notes.js` 的**文件层**）：删除 / 恢复是**纯追加**，只有 `removeNotes` 才改既有字节。
 *
 * 这一层是全插件**第二处**会改读者文件的地方（第一处是背景认识的压缩），所以它只做机械的事：
 * 追加标记、按 id 移除块。**备份与"写前核对文件没被别人改过"**在 `library.js` 的 `purgeNotes`
 * 里（那一层负责碰文件系统，这一层是纯函数 + 两个追加）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendNote,
  appendTrashMarker,
  parseNotes,
  parseTrashState,
  removeNotes,
} from '../lib/host/notes.js'

/** 造一个干净的 notes.md 路径（目录用系统临时目录，不落进仓库）。 */
function freshFile() {
  const dir = mkdtempSync(join(tmpdir(), 'drc-trash-'))
  return join(dir, 'notes.md')
}

test('回收站：删除与恢复都是纯追加，状态 = 最后一条标记（重复点幂等）', () => {
  const path = freshFile()
  const a = appendNote(path, { bookTitle: '测试书', excerpt: '摘抄甲', thought: '感想甲' })
  const b = appendNote(path, { bookTitle: '测试书', excerpt: '摘抄乙', thought: '感想乙' })
  const before = readFileSync(path, 'utf8')

  appendTrashMarker(path, a.id, 'deleted')
  const afterDelete = readFileSync(path, 'utf8')
  // ⚠️ 这条断言是整套设计的地基：读者可能同时在 Obsidian 里编辑，
  // 所以"删除"绝不能碰他已有的字节。
  assert.ok(afterDelete.startsWith(before), '删除必须是纯追加：旧字节一字不改')
  assert.equal(parseTrashState(afterDelete).get(a.id), true)
  assert.equal(parseTrashState(afterDelete).get(b.id), undefined, '没删的那条不受影响')

  appendTrashMarker(path, a.id, 'deleted')
  assert.equal(parseTrashState(readFileSync(path, 'utf8')).get(a.id), true, '重复删除幂等')

  appendTrashMarker(path, a.id, 'restored')
  assert.equal(parseTrashState(readFileSync(path, 'utf8')).get(a.id), false, '恢复要生效')

  appendTrashMarker(path, a.id, 'deleted')
  appendTrashMarker(path, a.id, 'restored')
  assert.equal(parseTrashState(readFileSync(path, 'utf8')).get(a.id), false, '最后一条赢')
})

test('回收站：removeNotes 只删点名的块与它们的标记，别的一条不动', () => {
  const path = freshFile()
  const a = appendNote(path, { bookTitle: '测试书', excerpt: '摘抄甲', thought: '感想甲' })
  const b = appendNote(path, { bookTitle: '测试书', excerpt: '摘抄乙', thought: '感想乙' })
  appendTrashMarker(path, a.id, 'deleted')
  const text = readFileSync(path, 'utf8')

  const { markdown, removed } = removeNotes(text, [a.id])
  assert.equal(removed, 1)
  const left = parseNotes(markdown)
  assert.equal(left.length, 1, '另一条必须还在')
  assert.equal(left[0].id, b.id)
  assert.ok(!markdown.includes(a.id), '被删那条的 id 连标记一起清掉（不留孤儿标记）')
  assert.ok(markdown.includes('摘抄乙'), '没点名的内容一字不动')

  // 手写块（没有 id）永远不在回收站里，也不许被误删。
  const hand = `${markdown}
<!-- drc-note:begin created=2026-01-01 chapter= offset= tags= -->
### 手写的一条

**我的感想**：手写的

<!-- drc-note:end -->
`
  const again = removeNotes(hand, [''])
  assert.equal(again.markdown, hand, 'id 为空的手写块不许被删')
  assert.equal(again.removed, 0)
})

test('回收站：readNotes 给每条笔记带上 trashed（手写块永远是 false）', async () => {
  const path = freshFile()
  const a = appendNote(path, { bookTitle: '测试书', excerpt: '摘抄甲', thought: '感想甲' })
  const b = appendNote(path, { bookTitle: '测试书', excerpt: '摘抄乙', thought: '感想乙' })
  appendTrashMarker(path, a.id, 'deleted')
  // 手写块：没有 id。
  writeFileSync(path, `${readFileSync(path, 'utf8')}
<!-- drc-note:begin created=2026-01-01 chapter= offset= tags= -->
### 手写的一条

**我的感想**：手写的

<!-- drc-note:end -->
`, 'utf8')

  const { readNotes } = await import('../lib/host/notes.js')
  const notes = readNotes(path, '测试书').notes
  const byId = new Map(notes.map((note) => [note.id, note]))
  assert.equal(byId.get(a.id).trashed, true, '被删的那条要标成 trashed')
  assert.equal(byId.get(b.id).trashed, false)
  const hand = notes.find((note) => note.id === '')
  assert.equal(hand.trashed, false, '手写块没有 id，永远不在回收站里')
})
