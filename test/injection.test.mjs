/**
 * **真正的注入路径**的测试。
 *
 * `GET /context`（面板里的「AI 视角预览」）与 `systemPrompt.section` 回调是**两条
 * 不同的代码路径**：前者在路由里现场组装一次给用户看，后者是每一轮对话真正被
 * 调用的那个。路由绿了不代表注入绿了。
 *
 * 这个空白是被一次变异验证抓出来的：把 `companionSection` 里的 `discussions`
 * 改成空数组（等于"讨论时间线根本没接进去"），**所有测试依然全绿**——因为它们
 * 全都只打路由。所以本文件专门打回调。
 *
 * 另一条同样重要：**回调抛错会让整次 prompt 装配失败**，把用户正常的一轮对话
 * 一起毁掉。所以它必须永远吞掉异常、退回"没有贡献"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { call, importBook, makeDir, startServer } from './helpers/server.mjs'

const SESSION = 'sess-inject-1'

/** 以某个会话的身份调用被注册的段落回调。 */
const inject = (hooks, sessionId) => hooks.section.text({ agent: { session: { id: sessionId } } })

/** 建好一本书、绑好会话、设好进度，返回 bookId。 */
async function prepare(base, dir, { progress = 1 } = {}) {
  const bookId = await importBook(base, dir)
  await call(`${base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: SESSION } })
  await call(`${base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: progress, charOffset: 0 } })
  return bookId
}

test('注入：没绑定的会话拿到空串（= 对这个会话毫无影响）', async () => {
  const dir = makeDir('inject-unbound')
  const s = await startServer(dir)
  try {
    await prepare(s.base, dir)
    assert.equal(inject(s.hooks, '别的会话'), '')
    assert.equal(inject(s.hooks, ''), '')
  } finally {
    await s.close()
  }
})

test('注入：绑定了就有内容，而且是**完整**的（守则 + 背景 + 情况 + 正文）', async () => {
  const dir = makeDir('inject-full')
  const s = await startServer(dir)
  try {
    await prepare(s.base, dir)
    const text = inject(s.hooks, SESSION)

    assert.match(text, /# 本地阅读陪读/)
    assert.match(text, /## 陪读守则/)
    assert.match(text, /## 当前情况/)
    assert.match(text, /## 已读内容/)
    assert.match(text, /book-excerpt/)
  } finally {
    await s.close()
  }
})

test('注入：书友设定与讨论时间线必须**真的**接进回调（这是路由测不到的）', async () => {
  const dir = makeDir('inject-wiring')
  const s = await startServer(dir)
  try {
    const bookId = await prepare(s.base, dir)
    await call(`${s.base}/books/${bookId}/persona`, { method: 'PUT', body: { text: '我偏爱克制的语气' } })

    const beforeNote = inject(s.hooks, SESSION)
    assert.match(beforeNote, /## 书友设定（读者自己写的）/, '设定必须进注入链路')
    assert.match(beforeNote, /我偏爱克制的语气/)

    await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { chapterIndex: 1, thought: '这一章我记了一句话' },
    })

    const afterNote = inject(s.hooks, SESSION)
    assert.match(afterNote, /你们之前聊过/, '讨论时间线必须进注入链路')
    assert.match(afterNote, /这一章我记了一句话/)
  } finally {
    await s.close()
  }
})

test('注入：防剧透在**回调**上也成立——进度之后的章节一个字都进不去', async () => {
  const dir = makeDir('inject-spoiler')
  const s = await startServer(dir)
  try {
    // 停在第 2 章（index 1）。第一章标记「甲」、第二章「乙」、第三章「丙」。
    await prepare(s.base, dir, { progress: 1 })
    const text = inject(s.hooks, SESSION)

    assert.match(text, /乙/, '当前章必须在')
    assert.match(text, /甲/, '上一章必须在')
    // v1.24：上一章默认只给**尾部**。上面那条 `/甲/` 命中的是章末的那一次标记
    // （夹具首尾各带一次，见 helpers/server.mjs 的说明）；这里把新契约本身也钉住：
    // 小节标题必须说"结尾"，而且**不能**自称全文。
    assert.match(text, /### 上一章结尾/, '上一章必须以尾部形态出现，且标题要说清')
    assert.doesNotMatch(text, /上一章全文/, '截断了就不能自称全文')
    assert.doesNotMatch(text, /丙/, '进度之后的章节绝不能出现')
  } finally {
    await s.close()
  }
})

test('注入：时间感知进了回调', async () => {
  const dir = makeDir('inject-time')
  const s = await startServer(dir)
  try {
    const bookId = await prepare(s.base, dir)
    await call(`${s.base}/books/${bookId}/notes`, { method: 'POST', body: { chapterIndex: 1, thought: '一句' } })
    const text = inject(s.hooks, SESSION)
    assert.match(text, /今天：\d{4}-\d{2}-\d{2}/)
    assert.match(text, /距上次和这位读者聊这本书：\*\*今天\*\*/)
  } finally {
    await s.close()
  }
})

test('注入：回调**永远不抛错**——它抛一次就毁掉用户一整轮对话', async () => {
  // 把章节索引删掉，让 collectReadWindow 内部真的抛出来。
  // 这是可达的状态（用户手工清理过插件目录、或写入过程中被杀）。
  const dir = makeDir('inject-throw')
  const s = await startServer(dir)
  try {
    const bookId = await prepare(s.base, dir)
    rmSync(join(dir, 'books', bookId, 'chapters.json'), { force: true })

    let text
    assert.doesNotThrow(() => {
      text = inject(s.hooks, SESSION)
    }, '段落回调抛错会让整次 prompt 装配失败')
    assert.equal(text, '', '拿不出上下文时退回"没有贡献"')
  } finally {
    await s.close()
  }
})

test('注入：书被删掉之后回调也退回空串，而不是抛错', async () => {
  const dir = makeDir('inject-removed')
  const s = await startServer(dir)
  try {
    const bookId = await prepare(s.base, dir)
    await call(`${s.base}/library/${bookId}?keepNotes=1`, { method: 'DELETE' })

    let text
    assert.doesNotThrow(() => {
      text = inject(s.hooks, SESSION)
    })
    assert.equal(text, '')
  } finally {
    await s.close()
  }
})

test('注入：宿主没给 agent 时也安全返回空串', async () => {
  const dir = makeDir('inject-noagent')
  const s = await startServer(dir)
  try {
    await prepare(s.base, dir)
    assert.equal(s.hooks.section.text({}), '')
    assert.equal(s.hooks.section.text({ agent: {} }), '')
    assert.equal(s.hooks.section.text(null), '')
  } finally {
    await s.close()
  }
})

test('注入：段落名与顺序是稳定的（换了名字宿主会当成另一个段落）', async () => {
  const dir = makeDir('inject-meta')
  const s = await startServer(dir)
  try {
    assert.equal(s.hooks.section.name, 'dsh-reading-companion:companion')
    assert.equal(typeof s.hooks.section.order, 'number')
    assert.equal(typeof s.hooks.section.text, 'function')
  } finally {
    await s.close()
  }
})

test('注入：稳定前缀在真实回调上同样稳定（跨进度逐字节相同）', async () => {
  const dir = makeDir('inject-cache')
  const s = await startServer(dir)
  try {
    const bookId = await prepare(s.base, dir, { progress: 1 })
    const at1 = inject(s.hooks, SESSION)
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 0 } })
    const at2 = inject(s.hooks, SESSION)

    const marker = '## 当前情况'
    assert.notEqual(at1, at2, '进度变了，整段当然要变')
    assert.equal(at1.slice(0, at1.indexOf(marker)), at2.slice(0, at2.indexOf(marker)), '但稳定前缀必须一模一样')
  } finally {
    await s.close()
  }
})
