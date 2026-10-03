/**
 * A3（2026-10-03）：`*_SCHEMA_VERSION` 的**读取侧校验**。
 *
 * 从前这三个常量只写不读：文件里声明着 `schema=1`，解析器一眼都不看。后果是
 * **降级**这一种真实场景会静默吃数据 —— 读者先用新版本插件（写下 schema=2 的
 * 新格式），再回退到本版本；本版本的解析器把不认识的部分当 `unknown` 或直接
 * 忽略，然后**照常写回**，新格式的内容就被永久抹掉了。
 *
 * 所以这一批加的是"声明了就必须校验"：
 *   · 声明的版本 **比我们新** ⇒ 拒绝覆盖，抛可定位的错误 + 一句人话；
 *   · 声明等于 / 更旧 / 干脆没声明（老文件）⇒ **照常写**，升级路径不许被自己挡住。
 *
 * ⚠️ 只挡"会改既有字节"的那几条路。`notes.md` 的追加（`appendNote` /
 * `appendTrashMarker`）刻意不挡：追加不可能丢数据，而挡住它等于"降级之后连笔记
 * 都记不了"，比它要防的事更糟。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSON_SCHEMA_VERSION, mutateJson, readJson, updateJson } from '../lib/host/atomic-json.js'

import {
  BACKGROUND_SCHEMA_VERSION,
  declaredBackgroundSchema,
  emptyBackground,
  readBackground,
  writeBackground,
} from '../lib/host/background.js'
import {
  DRAFTS_SCHEMA_VERSION,
  NOTES_SCHEMA_VERSION,
  appendNote,
  declaredNotesSchema,
  deleteDraft,
  emptyNotesHeader,
  readDrafts,
  remapNoteCoordinates,
  upsertDraft,
} from '../lib/host/notes.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 跑一次并把它抛出的错误交回来（断言文案要用）。 */
function capture(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'drc-schema-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('schema 声明：能从文件里读出来，没声明时是 null（不是 0、不是 NaN）', () => {
  assert.equal(declaredBackgroundSchema(emptyBackground('测试书')), BACKGROUND_SCHEMA_VERSION)
  assert.equal(declaredNotesSchema(emptyNotesHeader('测试书')), NOTES_SCHEMA_VERSION)

  // 老文件（标记还没带 schema= 的那一代）与完全不像背景文件的内容都算"没声明"。
  assert.equal(declaredBackgroundSchema('# 《测试书》· 背景认识\n'), null)
  assert.equal(declaredBackgroundSchema('<!-- drc-background: covered=1..2 -->'), null)
  assert.equal(declaredBackgroundSchema(''), null)
  assert.equal(declaredBackgroundSchema(undefined), null)
  assert.equal(declaredNotesSchema('# 测试书 · 读书笔记\n'), null)
  assert.equal(declaredNotesSchema(null), null)
})

test('背景：声明了比我们新的 schema ⇒ 拒绝覆盖，且文件一个字节都没动', () => {
  withTempDir((dir) => {
    const path = join(dir, 'background.md')
    const future = [
      `<!-- drc-background: schema=${BACKGROUND_SCHEMA_VERSION + 1} covered=1..2 -->`,
      '# 《未来书》· 背景认识',
      '',
      '## 世界观',
      '- `第1章` 新格式才有的一条',
      '',
    ].join('\n')
    writeFileSync(path, future, 'utf8')

    const error = capture(() => writeBackground(path, readBackground(path, '未来书').doc, '未来书'))
    assert.ok(error !== null, '声明了更新的 schema，写盘必须被拒绝')
    assert.match(error.message, /BACKGROUND_SCHEMA_UNSUPPORTED/)
    // 人话三件事：哪一份、声明的版本、我们的版本 —— 否则读者只会看到一串英文。
    assert.match(error.message, new RegExp(`版本是 ${BACKGROUND_SCHEMA_VERSION + 1}`))
    assert.match(error.message, new RegExp(`只认识到 ${BACKGROUND_SCHEMA_VERSION}`))
    assert.match(error.message, /文件原样未动/)
    assert.equal(readFileSync(path, 'utf8'), future, '拒绝之后文件必须逐字节不变')
  })
})

test('背景：声明等于 / 更旧 / 没声明 ⇒ 照常写（升级路径不许被自己挡住）', () => {
  withTempDir((dir) => {
    const cases = [
      ['当前版本', `<!-- drc-background: schema=${BACKGROUND_SCHEMA_VERSION} covered=1..2 -->\n# 《甲》· 背景认识\n`],
      ['更旧版本', '<!-- drc-background: schema=0 covered=1..2 -->\n# 《甲》· 背景认识\n'],
      ['老文件没声明', '# 《甲》· 背景认识\n\n## 世界观\n- `第1章` 老写法\n'],
    ]
    for (const [label, content] of cases) {
      const path = join(dir, `${label}.md`)
      writeFileSync(path, content, 'utf8')
      const doc = readBackground(path, '甲').doc
      const written = writeBackground(path, doc, '甲')
      assert.equal(declaredBackgroundSchema(written), BACKGROUND_SCHEMA_VERSION, `${label}：写出来的是当前版本`)
    }
  })
})

test('笔记：要改既有字节的重切分迁移，声明了更新的 schema ⇒ 拒绝', () => {
  withTempDir((dir) => {
    const path = join(dir, 'notes.md')
    // 先造一份**真的** notes.md（真块、真头部），再把头部版本号顶上去 —— 这样这条
    // 用例挡的就是"一份真文件被降级写回"，而不是一个手搓的假样本。
    appendNote(path, {
      id: 'n1', chapterIndex: 1, charOffset: 0, chapterTitle: '第1章',
      excerpt: '原文一句话', thought: '', reply: '',
    })
    const real = readFileSync(path, 'utf8')
    const future = real.replace(/schema=\d+/, `schema=${NOTES_SCHEMA_VERSION + 1}`)
    assert.notEqual(future, real, '头部必须真的被顶到未来版本')
    writeFileSync(path, future, 'utf8')

    const remaps = new Map([['n1', { chapterIndex: 2, charOffset: 0, chapterTitle: '第2章' }]])
    const error = capture(() => remapNoteCoordinates(path, remaps))
    assert.ok(error !== null, '要改既有字节就得先看声明')
    assert.match(error.message, /NOTES_SCHEMA_UNSUPPORTED/)
    assert.match(error.message, new RegExp(`版本是 ${NOTES_SCHEMA_VERSION + 1}`))
    assert.match(error.message, /文件原样未动/)
    assert.equal(readFileSync(path, 'utf8'), future, '拒绝之后 notes.md 必须逐字节不变')
  })
})

test('笔记：追加这条路刻意不挡（追加不会丢数据，挡住反而更糟）', () => {
  withTempDir((dir) => {
    const path = join(dir, 'notes.md')
    appendNote(path, {
      id: 'n1', chapterIndex: 1, charOffset: 0, chapterTitle: '第1章',
      excerpt: '原文一句话', thought: '', reply: '',
    })
    const real = readFileSync(path, 'utf8')
    writeFileSync(path, real.replace(/schema=\d+/, `schema=${NOTES_SCHEMA_VERSION + 1}`), 'utf8')

    assert.doesNotThrow(() => {
      appendNote(path, {
        id: 'n2', chapterIndex: 2, charOffset: 0, chapterTitle: '第2章',
        excerpt: '又一句话', thought: '', reply: '',
      })
    }, '降级之后仍然要能记笔记')
    assert.match(readFileSync(path, 'utf8'), /id=n2/, '新笔记确实追加进去了')
  })
})

test('草稿：schemaVersion 比我们新 ⇒ 拒绝写；但读不受影响（面板还得能显示）', () => {
  withTempDir((dir) => {
    const path = join(dir, 'drafts.json')
    const future = JSON.stringify({
      schemaVersion: DRAFTS_SCHEMA_VERSION + 1,
      drafts: { d1: { draftId: 'd1', bookId: 'b1', excerpt: '旧的摘抄' } },
    })
    writeFileSync(path, future, 'utf8')

    assert.deepEqual(readDrafts(path), { d1: { draftId: 'd1', bookId: 'b1', excerpt: '旧的摘抄' } }, '读不该被挡住')

    const upsertError = capture(() => upsertDraft(path, { draftId: 'd2', bookId: 'b1' }))
    assert.ok(upsertError !== null, '新建草稿会被拒绝')
    assert.match(upsertError.message, /DRAFTS_SCHEMA_UNSUPPORTED/)
    assert.match(upsertError.message, new RegExp(`版本是 ${DRAFTS_SCHEMA_VERSION + 1}`))

    const deleteError = capture(() => deleteDraft(path, 'd1', 'b1'))
    assert.ok(deleteError !== null, '删草稿也会被拒绝')
    assert.match(deleteError.message, /DRAFTS_SCHEMA_UNSUPPORTED/)

    assert.equal(readFileSync(path, 'utf8'), future, '两次拒绝之后 drafts.json 必须逐字节不变')
  })
})

test('JSON 状态文件：书架 / 绑定 / 分类 / 设置共用同一道"未来格式不覆盖"（2026-10-03，外部评审 #2）', () => {
  // 从前这条保护只有 background.md / notes.md / 草稿有，**四个 JSON 状态文件一个都没装**：
  // `readLibrary` 只查 `books` 是不是数组，`writeLibrary` 把对象**从零重建**成
  // `{ schemaVersion: 1, books }` ⇒ 更新版本写下的 `schemaVersion: 2` 连同它的新字段
  // 会被**静默降级抹掉**，没有任何提示。判据现在只有一处（`atomic-json.js` 的 `updateJson`），
  // 四个文件共用。
  withTempDir((dir) => {
    const path = join(dir, 'library.json')
    const future = JSON.stringify({
      schemaVersion: JSON_SCHEMA_VERSION + 1,
      books: [{ bookId: 'b1' }],
      futureOnlyField: '别弄丢我',
    })
    writeFileSync(path, future, 'utf8')

    const error = capture(() =>
      updateJson(path, { fallback: { schemaVersion: 1, books: [] }, expectedRevision: null, mutate: () => ({ schemaVersion: 1, books: [] }) }),
    )
    assert.ok(error !== null, '声明了更新的 schema，写盘必须被拒绝')
    assert.equal(error.code, 'JSON_SCHEMA_UNSUPPORTED')
    // 错误里要带得走的信息：盘上声明第几版、我们认识到第几版。
    assert.equal(error.declared, JSON_SCHEMA_VERSION + 1)
    assert.equal(error.supported, JSON_SCHEMA_VERSION)
    assert.equal(readFileSync(path, 'utf8'), future, '拒绝之后必须逐字节不变')

    // 绑定 / 分类 / 设置走 `mutateJson` —— 同样被拦，而且**不**误当损坏去挪开：
    // 未来版本写下的文件是**好文件**，挪走等于把读者的数据改名藏起来。
    const mutError = capture(() =>
      mutateJson(path, { fallback: { schemaVersion: 1, books: [] }, mutate: () => ({ schemaVersion: 1, books: [] }) }),
    )
    assert.equal(mutError?.code, 'JSON_SCHEMA_UNSUPPORTED', 'mutateJson 也必须拒写')
    assert.equal(readdirSync(dir).filter((name) => name.includes('.corrupt-')).length, 0, '未来版本不是"损坏"，不许挪走读者的文件')
    assert.equal(readFileSync(path, 'utf8'), future)

    // ⚠️ 反向：同版 / 更旧 / 老文件根本没写版本 ⇒ 照常写（升级路径不许被自己挡住）
    for (const [label, value] of [
      ['同版', { schemaVersion: JSON_SCHEMA_VERSION, books: [] }],
      ['更旧', { schemaVersion: 0, books: [] }],
      ['没写版本', { books: [] }],
    ]) {
      const p = join(dir, `ok-${label}.json`)
      writeFileSync(p, JSON.stringify(value), 'utf8')
      const revision = readJson(p, {}).revision
      assert.doesNotThrow(
        () => updateJson(p, { fallback: { schemaVersion: 1, books: [] }, expectedRevision: revision, mutate: () => ({ schemaVersion: 1, books: ['写了'] }) }),
        `${label}：不该被挡住`,
      )
      assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')).books, ['写了'], label)
    }
  })
})

test('契约：JSON schema 版本号只有一处字面量，书架索引与草稿库都从它派生', () => {
  // "同一概念只有一个定义点" —— 数值本身（1）不重要，重要的是**只有一处**。
  // 分叉的后果不是"数字不一样"，而是"有的文件保护、有的不保护"。
  assert.equal(DRAFTS_SCHEMA_VERSION, JSON_SCHEMA_VERSION, '草稿库与其它 JSON 状态文件共用同一个版本号')

  const src = readFileSync(join(HERE, '..', 'lib', 'host', 'library.js'), 'utf8')
  assert.match(src, /const SCHEMA_VERSION = JSON_SCHEMA_VERSION/, '书架索引的版本号必须从共用常量派生')
  assert.doesNotMatch(src, /const SCHEMA_VERSION = \d/, '不许再写一个字面量')
})
