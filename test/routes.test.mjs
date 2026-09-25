/**
 * HTTP 数据面的端到端测试。
 *
 * 刻意**不用 mock 的 req/res**：把真实的路由 handler 挂到 `node:http` 上，
 * 再真的发 `fetch` 过去。这样才能覆盖 mock 覆盖不到的东西——URL 解析、
 * 请求体流式读取、状态码与 Content-Type、以及真实的 EventEmitter 时序。
 *
 * 注意：这里测的是**插件自己的 handler**，不是 DSH Desktop 的那层
 * `decideDesktopBrowserAccess`。那一层只放行带 Electron 渲染器令牌的请求，
 * 是宿主的策略，不在本插件的责任范围内。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 临时端口护栏：直接 `listen(0)` 会拿到 fetch 拒绝的端口（`bad port`），
// 踩中时整个文件一起红。现象、根因与"红了怎么办"都在 test/harness-ports.test.mjs。
import { listenOnSafePort } from './helpers/server.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, 'test', '.tmp')
const API_ROOT = '/dsh-reading-companion/api'

let importSeq = 0
/** 每次带不同 query，绕开 ESM 模块缓存。 */
const freshUrl = (rel) => `${pathToFileURL(join(ROOT, rel)).href}?t=${importSeq++}`

const prose = (seed) =>
  `${seed}，他记得那天的雪落得很慢，像有人在半空里把时间掰开了一点点，然后一片一片地放下。`

const BOOK = ['第一章 雪', prose('甲'), '', '第二章 夜', prose('乙'), '', '第三章 归', prose('丙')].join('\n')

/**
 * 启一个真服务器，把插件的 handler 挂上去。
 *
 * @param {string} dir 书库目录
 * @returns {Promise<{ base: string, services: object, close: Function }>}
 */
async function startServer(dir, options = {}) {
  const host = await import(freshUrl('lib/index.js'))
  const registered = []
  const services = {}
  const ctx = {
    get: (name) => {
      if (name === 'dshHomePath') return (...parts) => join(TMP, ...parts)
      // 宿主侧解析工作区的唯一来源。真实实现是 dsh-workspace 的
      // `workspaceRegistry`（`list()` 同步返回带 `sessionIds` 的实体）。
      if (name === 'workspaceRegistry') return options.workspaceRegistry
      return undefined
    },
    effect: (fn) => fn(),
    /**
     * `session/event` 订阅（背景更新 T1-②）。
     *
     * ⚠️ 这个文件只关心路由，所以这里**不**捕获监听器——接线本身由
     * `helpers/server.mjs` 的假 ctx（会断言订阅存在、并能 `emit`）与
     * `background-update.test.mjs` 的端到端用例钉住。
     *
     * 📌 顺带记一笔：本文件这份 ctx 与 `helpers/server.mjs` 那份是**同一段东西
     * 写了两遍**，而这一份正是那个文件顶部警告过的形态（`systemPrompt.section`
     * 写成 `() => () => {}`，把回调丢掉）。两处都在时，宿主契约一改就要改两遍，
     * 漏一处就是一组假绿——这与 §215 的 M4 是同一个形状。
     */
    on: () => () => {},
    provide: (name, value) => {
      services[name] = value
      return () => {}
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
    // P2 起 host 半边把这两者列为硬依赖：少一个 apply 就会抛错。
    systemPrompt: { section: () => () => {} },
    tools: { guard: () => () => {} },
    logger: {},
  }

  host.apply(ctx, { storageDir: dir })
  assert.equal(registered.length, 1, '只应注册一条 prefix 路由')

  const server = createServer(registered[0].handler)
  const port = await listenOnSafePort(server)

  return {
    base: `http://127.0.0.1:${port}${API_ROOT}`,
    services,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

let dirSeq = 0
/** 建一个干净的测试书库目录。 */
function makeDir() {
  dirSeq += 1
  const dir = join(TMP, `routes-${process.pid}-${Date.now()}-${dirSeq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 发一个请求并解析 JSON。
 *
 * @param {string} url 完整 URL
 * @param {object} [options] fetch 选项
 * @returns {Promise<{ status: number, body: any }>}
 */
async function call(url, options = {}) {
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}

test('HTTP：/health 报告版本与书库路径，并发布 readingCompanion 服务', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const { status, body } = await call(`${s.base}/health`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    // 这里曾经是 `assert.equal(body.phase, 'P2')`：一个开发阶段的遗留标签被写死
    // 断言，于是陈旧的 'P2' 变成了对外契约（P3 早就做完了）。现在改成断言版本与
    // package.json 一致 —— 它不会自己漂移，而且真的能在版本忘记同步时炸掉。
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    assert.equal(body.version, pkg.version, '/health 的版本必须与 package.json 一致')
    assert.equal(body.storageDir, dir)

    assert.ok(s.services.readingCompanion, '必须发布 readingCompanion 供 P2 复用')
    assert.equal(typeof s.services.readingCompanion.library.importBook, 'function')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：导入 → 书架 → 目录 → 正文 → 进度 → 绑定 → 移除 全链路', async () => {
  const dir = makeDir()
  const inbox = join(dir, 'inbox')
  mkdirSync(inbox, { recursive: true })
  const sourcePath = join(inbox, '夜行.txt')
  writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))

  const s = await startServer(dir)
  try {
    // --- 扫描 inbox ---
    const scan = await call(`${s.base}/library/scan`, { method: 'POST' })
    assert.equal(scan.status, 200)
    assert.deepEqual(scan.body.entries.map((e) => e.name), ['夜行.txt'])

    // --- 导入 ---
    const imported = await call(`${s.base}/library/import`, {
      method: 'POST',
      body: { absPath: scan.body.entries[0].absPath },
    })
    assert.equal(imported.status, 200)
    const bookId = imported.body.book.bookId
    assert.equal(imported.body.book.chapterCount, 3)

    // --- 书架 ---
    const list = await call(`${s.base}/library`)
    assert.equal(list.body.books.length, 1)
    assert.equal(list.body.books[0].bookId, bookId)

    // --- 目录：只回元信息，不回正文 ---
    const toc = await call(`${s.base}/books/${bookId}/chapters`)
    assert.equal(toc.status, 200)
    assert.equal(toc.body.strategy, 'heading-regex')
    assert.deepEqual(toc.body.chapters.map((c) => c.title), ['第一章 雪', '第二章 夜', '第三章 归'])
    assert.equal(toc.body.chapters[0].text, undefined, '目录里不得夹带正文')

    // --- 正文 ---
    const chapter = await call(`${s.base}/books/${bookId}/chapters/0`)
    assert.equal(chapter.status, 200)
    assert.equal(chapter.body.chapter.title, '第一章 雪')
    assert.match(chapter.body.chapter.text, /^甲，他记得/)
    assert.ok(!chapter.body.chapter.text.includes('第一章 雪'), '正文不该重复标题')

    // --- 进度 ---
    assert.equal((await call(`${s.base}/books/${bookId}/progress`)).body.progress, null)
    const put = await call(`${s.base}/books/${bookId}/progress`, {
      method: 'PUT',
      body: { chapterIndex: 1, charOffset: 9 },
    })
    assert.equal(put.status, 200)
    assert.equal(put.body.progress.chapterIndex, 1)

    const progress = await call(`${s.base}/books/${bookId}/progress`)
    assert.equal(progress.body.progress.charOffset, 9)

    // --- 绑定 ---
    assert.equal((await call(`${s.base}/books/${bookId}/binding`)).body.binding, null)
    const bound = await call(`${s.base}/books/${bookId}/binding`, {
      method: 'PUT',
      body: { sessionId: 'session-abc', workspaceId: 'ws-1' },
    })
    assert.equal(bound.status, 200)
    assert.equal(bound.body.binding.sessionId, 'session-abc')

    const reverse = await call(`${s.base}/session/session-abc/book`)
    assert.equal(reverse.body.bookId, bookId, '防剧透链路要靠这个反查')

    const unbound = await call(`${s.base}/books/${bookId}/binding`, { method: 'DELETE' })
    assert.equal(unbound.body.unbound, true)

    // --- P2：AI 视角预览（用户验证防剧透的入口）---
    await call(`${s.base}/books/${bookId}/progress`, {
      method: 'PUT',
      body: { chapterIndex: 0, charOffset: 5 },
    })
    const preview = await call(`${s.base}/books/${bookId}/context`)
    assert.equal(preview.status, 200)
    assert.equal(preview.body.bookId, bookId)
    assert.equal(typeof preview.body.section, 'string')
    assert.ok(preview.body.section.length > 0, '预览不能是空的，否则用户无法核验')
    assert.equal(preview.body.summary.currentChapter, 0)
    // 关键断言：预览里不能出现后续章节的正文。
    assert.ok(!preview.body.section.includes('乙，他记得'), '预览泄漏了第二章正文')
    assert.ok(!preview.body.section.includes('丙，他记得'), '预览泄漏了第三章正文')
    // 而且它必须是真正投喂给模型的那一份：信封与守则都在。
    assert.match(preview.body.section, /<book-excerpt trust="untrusted">/)
    assert.match(preview.body.section, /陪读守则/)

    // --- 移除 ---
    const removed = await call(`${s.base}/library/${bookId}`, { method: 'DELETE' })
    assert.equal(removed.body.removed, true)
    assert.equal((await call(`${s.base}/library`)).body.books.length, 0)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：笔记全链路 —— 草稿 → 打 tag 建议 → 写入 → AI 回应只在显式要求时落盘', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    // 刚导入时没有任何笔记。
    const empty = await call(`${s.base}/books/${bookId}/notes`)
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.notes, [])

    // --- 建草稿：服务端应当给出 tag 建议 ---
    const created = await call(`${s.base}/books/${bookId}/drafts`, {
      method: 'POST',
      body: {
        chapterIndex: 0,
        chapterTitle: '第一章 雪',
        charOffset: 5,
        excerpt: '他记得那天的雪落得很慢',
        thought: '开篇这段文笔真好，比喻很新。',
      },
    })
    assert.equal(created.status, 200)
    const draft = created.body.draft
    assert.ok(draft.draftId)
    assert.ok(
      created.body.suggestedTags.includes('文笔'),
      `感想里明显在说文笔，建议 tag 应当包含它，实际 ${JSON.stringify(created.body.suggestedTags)}`,
    )

    // --- 默认写入：AI 回应不落盘 ---
    // 先给草稿贴一段"AI 回应"，但提交时不要求附上。
    await call(`${s.base}/books/${bookId}/drafts`, {
      method: 'POST',
      body: { draftId: draft.draftId, reply: '我也觉得，那种冷是听得见的。' },
    })
    const plain = await call(`${s.base}/books/${bookId}/drafts/${draft.draftId}/commit`, {
      method: 'POST',
      body: {},
    })
    assert.equal(plain.status, 200)
    assert.equal(plain.body.written.draftRemoved, true)

    let notes = (await call(`${s.base}/books/${bookId}/notes`)).body.notes
    assert.equal(notes.length, 1)
    assert.equal(notes[0].hasReply, false, '没显式要求却把 AI 回应写进去了')
    // 响应体里不该再有整块原文：它和 excerpt/thought/reply 是同一份内容的
    // 重复。实测 1000 条笔记时占响应体的一半，而面板从来没用过它。
    assert.ok(!Object.hasOwn(notes[0], 'body'), '笔记响应里又出现了冗余的 body 字段')

    // --- 显式要求：才落盘 ---
    const second = await call(`${s.base}/books/${bookId}/drafts`, {
      method: 'POST',
      body: { chapterIndex: 1, chapterTitle: '第二章 夜', excerpt: '灯灭之后', thought: '节奏好。', reply: '前面越静，这里越响。' },
    })
    await call(`${s.base}/books/${bookId}/drafts/${second.body.draft.draftId}/commit`, {
      method: 'POST',
      body: { attachReply: true },
    })
    const page = (await call(`${s.base}/books/${bookId}/notes`)).body
    notes = page.notes
    assert.equal(notes.length, 2)
    // ⚠️ 顺序是**新的在前**。次序必须由宿主定下来，客户端才不用在渲染里
    //    `slice().reverse()`——那会每次渲染产生新数组，把子组件的 memo 打掉。
    assert.equal(notes[0].hasReply, true, '显式要求了却没写进去')
    assert.equal(notes[1].hasReply, false)
    assert.equal(page.total, 2, 'total 应当是全部条数，不是本页条数')
    assert.equal(page.hasMore, false)
    assert.equal(page.nextCursor, null)

    // --- 草稿在提交后应当被清掉 ---
    assert.equal((await call(`${s.base}/books/${bookId}/drafts`)).body.drafts.length, 0)

    // --- 错误语义 ---
    assert.equal((await call(`${s.base}/books/${bookId}/drafts/nope/commit`, { method: 'POST', body: {} })).status, 404)
    assert.equal(
      (await call(`${s.base}/books/${bookId}/notes`, { method: 'POST', body: { excerpt: '  ', thought: '' } })).status,
      400,
      '空笔记应当回 400，而不是落一条空块进 md',
    )
    assert.equal((await call(`${s.base}/books/0123456789abcdef/notes`)).status, 404)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：笔记分页——limit / before 生效，多页之间不重不漏', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    for (let i = 0; i < 25; i += 1) {
      const written = await call(`${s.base}/books/${bookId}/notes`, {
        method: 'POST',
        body: { excerpt: `摘抄 ${i}`, thought: `感想 ${i}` },
      })
      assert.equal(written.status, 200, `第 ${i} 条笔记写入失败`)
    }

    const first = (await call(`${s.base}/books/${bookId}/notes?limit=10`)).body
    assert.equal(first.notes.length, 10)
    assert.equal(first.total, 25, 'total 是全部条数，不是本页条数')
    assert.equal(first.hasMore, true)
    assert.equal(first.notes[0].excerpt, '摘抄 24', '新的应当排在最前')
    assert.equal(first.nextCursor, first.notes[9].id)

    const second = (await call(
      `${s.base}/books/${bookId}/notes?limit=10&before=${encodeURIComponent(first.nextCursor)}`,
    )).body
    assert.equal(second.notes.length, 10)
    assert.equal(second.hasMore, true)
    assert.equal(second.reset, false, '游标还在，不该判定为失效')
    assert.equal(second.notes[0].excerpt, '摘抄 14')

    const third = (await call(
      `${s.base}/books/${bookId}/notes?limit=10&before=${encodeURIComponent(second.nextCursor)}`,
    )).body
    assert.equal(third.notes.length, 5)
    assert.equal(third.hasMore, false)
    assert.equal(third.nextCursor, null, '没有下一页时不该给出游标')

    // 不重不漏：三页合起来恰好是全部 25 条。
    const ids = [...first.notes, ...second.notes, ...third.notes].map((note) => note.id)
    assert.equal(ids.length, 25)
    assert.equal(new Set(ids).size, 25, '分页出现了重复或遗漏')

    // 非法 limit 回落默认值，而不是报错——分页参数传错不该让笔记列表打不开。
    // ⚠️ 这个数是**宿主默认页大小**（`NOTES_PAGE_DEFAULT`，现为 10）。它与客户端
    // `NOTES_PAGE_SIZE` 必须相等这件事由 `contract.test.mjs` 的契约用例盯着；
    // 这里只验证"非法值走回默认"这条路径本身。
    const fallback = (await call(`${s.base}/books/${bookId}/notes?limit=abc`)).body
    assert.equal(fallback.notes.length, 10)
    // 超出上限被夹住。
    const capped = (await call(`${s.base}/books/${bookId}/notes?limit=9999`)).body
    assert.equal(capped.notes.length, 25, '只有 25 条，夹到上限后应当全部给出来')

    // 失效游标：回第一页并置 reset，让面板**替换**而不是追加。
    const stale = (await call(`${s.base}/books/${bookId}/notes?limit=10&before=nope`)).body
    assert.equal(stale.reset, true)
    assert.equal(stale.notes[0].excerpt, '摘抄 24')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：按章取笔记 —— 只回那一章、新的在前、没记过就是空数组', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    // 第 1 章记两条、第 2 章记一条、第 3 章**不记**（用来验证"没记过 = 空数组"）。
    const write = (chapterIndex, excerpt) => call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { excerpt, thought: `感想 ${excerpt}`, chapterIndex, chapterTitle: `第 ${chapterIndex + 1} 章` },
    })
    assert.equal((await write(0, '第一条')).status, 200)
    assert.equal((await write(1, '第二章的')).status, 200)
    assert.equal((await write(0, '第二条')).status, 200)

    const first = (await call(`${s.base}/books/${bookId}/notes/chapter/0`)).body
    assert.equal(first.chapterIndex, 0)
    assert.equal(first.notes.length, 2, '只回第 1 章的笔记')
    assert.equal(first.notes[0].excerpt, '第二条', '新的在前（与笔记列表同序）')
    assert.deepEqual(first.notes.map((note) => note.chapterIndex), [0, 0])

    // 没记过的章是**正常结果**，不是错误 —— 大多数章本来就没记过。
    const empty = (await call(`${s.base}/books/${bookId}/notes/chapter/2`)).body
    assert.deepEqual(empty.notes, [])

    // 非法章号与"没有这一章"同码：CHAPTER_NOT_FOUND → 404。
    const bad = await call(`${s.base}/books/${bookId}/notes/chapter/abc`)
    assert.equal(bad.status, 404)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：已读完标记 —— 默认未标记、落盘留时间戳、面板响应里能看到、可收回', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    // 默认必须是"没读完" —— fail-safe 的另一面：不许默认就开着。
    assert.equal((await call(`${s.base}/books/${bookId}/background`)).body.finished, false)

    const on = await call(`${s.base}/books/${bookId}/finished`, { method: 'POST', body: { finished: true } })
    assert.equal(on.status, 200)
    assert.equal(on.body.finished, true)
    assert.equal(typeof on.body.finishedAt, 'string', '置位要留时间戳（什么时候宣布读完的）')
    assert.equal(
      (await call(`${s.base}/books/${bookId}/background`)).body.finished,
      true,
      '面板只读 /background 这一个响应，所以它必须回这个字段',
    )

    const off = await call(`${s.base}/books/${bookId}/finished`, { method: 'POST', body: { finished: false } })
    assert.equal(off.body.finished, false)
    assert.equal(off.body.finishedAt, null)
    assert.equal((await call(`${s.base}/books/${bookId}/background`)).body.finished, false, '收回要真的落盘')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('回收站：删除只追加标记、默认列表不显示、可恢复；彻底删除会先备份', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    const one = await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { excerpt: '雪落得很慢', thought: '甲', chapterIndex: 0, tags: [] },
    })
    const noteId = one.body.written.id
    await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { excerpt: '夜里的风', thought: '乙', chapterIndex: 1, tags: [] },
    })
    const count = async (query = '') =>
      ((await call(`${s.base}/books/${bookId}/notes${query}`)).body.notes ?? []).length

    assert.equal(await count(), 2, '默认列表应当有两条')

    // ① 删一条 = 纯追加标记 → 默认列表看不到，回收站里看得到。
    const trashed = await call(`${s.base}/books/${bookId}/notes/${noteId}/trash`, { method: 'POST' })
    assert.equal(trashed.status, 200)
    assert.equal(await count(), 1, '删掉的默认不显示')
    assert.equal(await count('?trashed=1'), 1, '回收站里应当有它')

    // ② 恢复 → 回来。
    await call(`${s.base}/books/${bookId}/notes/${noteId}/restore`, { method: 'POST' })
    assert.equal(await count(), 2, '恢复后要回来')

    // ③ 彻底删除：先备份，再抹掉；回收站也要清空它。
    await call(`${s.base}/books/${bookId}/notes/${noteId}/trash`, { method: 'POST' })
    const purged = await call(`${s.base}/books/${bookId}/notes/purge`, { method: 'POST', body: { ids: [noteId] } })
    assert.equal(purged.body.purged.removed, 1)
    assert.ok(
      typeof purged.body.purged.backupPath === 'string' && purged.body.purged.backupPath !== '',
      '彻底删除**必须先备份**（这是它唯一会改既有字节的一步）',
    )
    assert.equal(await count(), 1)
    assert.equal(await count('?trashed=1'), 0, '回收站里也要清掉')

    // ④ 不存在的笔记 → 404，不是 500。
    assert.equal((await call(`${s.base}/books/${bookId}/notes/nope/trash`, { method: 'POST' })).status, 404)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('回收站：清空（all: true）一次删干净，不会只清一页', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    const ids = []
    for (let i = 0; i < 3; i += 1) {
      const written = await call(`${s.base}/books/${bookId}/notes`, {
        method: 'POST',
        body: { excerpt: `摘抄${i}`, thought: `感想${i}`, chapterIndex: 0, tags: [] },
      })
      ids.push(written.body.written.id)
    }
    for (const id of ids) await call(`${s.base}/books/${bookId}/notes/${id}/trash`, { method: 'POST' })
    const bin = await call(`${s.base}/books/${bookId}/notes?trashed=1`)
    assert.equal((bin.body.notes ?? []).length, 3, '三条都该在回收站里')

    const cleared = await call(`${s.base}/books/${bookId}/notes/purge`, { method: 'POST', body: { all: true } })
    assert.equal(cleared.body.purged.removed, 3, '清空要清干净')
    assert.equal(((await call(`${s.base}/books/${bookId}/notes?trashed=1`)).body.notes ?? []).length, 0)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('数据落点：存草稿**不会**让笔记多出一条（读者确认过的期望）', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    // 摘抄照存进草稿 —— 读者问的正是"这段原文会不会进我的笔记文件"。
    const saved = await call(`${s.base}/books/${bookId}/drafts`, {
      method: 'POST',
      body: { excerpt: '风带着一股凛冽', thought: '有感觉，以后再写', chapterIndex: 0, tags: [] },
    })
    assert.equal(saved.status, 200)

    // ⚠️ 承诺：草稿进草稿库（`drafts.json`），**不进** `notes.md`。
    // 用**行为**断言而不是去猜路径：存完草稿之后，笔记仍然是空的，草稿库里有且只有 1 条。
    const notes = await call(`${s.base}/books/${bookId}/notes`)
    assert.equal((notes.body.notes ?? []).length, 0, '存草稿不该让笔记多出一条')
    const drafts = await call(`${s.base}/books/${bookId}/drafts`)
    assert.equal(drafts.body.drafts.length, 1, '草稿要在草稿库里')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：绑定会话时宿主自己解析出工作区，笔记落到「陪读_书名」', async () => {
  const dir = makeDir()
  const workspaceDir = join(dir, 'my-workspace')
  mkdirSync(workspaceDir, { recursive: true })

  // 假 registry：形状照抄 dsh-workspace 的 WorkspaceEntity
  // （`list()` 同步、实体上有 `path` 与已过滤的 `sessionIds`）。
  const registry = {
    list: () => [{ path: workspaceDir, title: '我的项目', sessionIds: ['session-abc'] }],
  }

  const s = await startServer(dir, { workspaceRegistry: registry })
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    // 只给 sessionId —— **不**给 workspaceDir，让宿主自己去 registry 里找。
    const bound = await call(`${s.base}/books/${bookId}/binding`, {
      method: 'PUT',
      body: { sessionId: 'session-abc' },
    })
    assert.equal(bound.status, 200)
    assert.equal(bound.body.location.scope, 'workspace', '宿主应当自己解析出了工作区')
    assert.equal(bound.body.location.folderName, '陪读_夜行')

    // 事件级验证：笔记真的写进了工作区文件夹。
    const notesPath = join(workspaceDir, '陪读_夜行', 'notes.md')
    await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { excerpt: '摘抄', thought: '感想' },
    })
    assert.ok(existsSync(notesPath), '笔记没有落到工作区文件夹里')
    assert.match(readFileSync(notesPath, 'utf8'), /摘抄/)

    // 大文件绝不跟过去。
    assert.ok(!existsSync(join(workspaceDir, '陪读_夜行', 'content.txt')))
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：会话不在任何工作区时，绑定仍然成功并回落到插件目录', async () => {
  const dir = makeDir()
  // registry 里没有这个会话。
  const registry = { list: () => [{ path: dir, title: '别处', sessionIds: ['someone-else'] }] }

  const s = await startServer(dir, { workspaceRegistry: registry })
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    const bound = await call(`${s.base}/books/${bookId}/binding`, {
      method: 'PUT',
      body: { sessionId: 'session-orphan' },
    })
    // 绑定本身必须成功 —— 工作区解析不出来是**位置问题**，不是绑定问题。
    assert.equal(bound.status, 200)
    assert.equal(bound.body.location.scope, 'plugin')

    // 笔记照样写得进去。
    const wrote = await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { excerpt: 'x', thought: 'y' },
    })
    assert.equal(wrote.status, 200)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：registry 抛错也不该让绑定或写入崩掉', async () => {
  const dir = makeDir()
  const registry = { list: () => { throw new Error('registry exploded') } }

  const s = await startServer(dir, { workspaceRegistry: registry })
  try {
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    const bound = await call(`${s.base}/books/${bookId}/binding`, {
      method: 'PUT',
      body: { sessionId: 'session-abc' },
    })
    assert.equal(bound.status, 200, 'registry 崩了不该让绑定回 500')
    assert.equal(bound.body.location.scope, 'plugin')

    const wrote = await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { excerpt: 'x', thought: 'y' },
    })
    assert.equal(wrote.status, 200, '笔记必须仍然写得进去')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：错误语义分明（404 / 405 / 400）', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    // 路径不存在
    const notFound = await call(`${s.base}/nope`)
    assert.equal(notFound.status, 404)
    assert.equal(notFound.body.error, 'NOT_FOUND')

    // 路径存在但方法不对
    const wrongMethod = await call(`${s.base}/health`, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.body.error, 'METHOD_NOT_ALLOWED')

    // 书籍不存在
    const noBook = await call(`${s.base}/books/0123456789abcdef/chapters`)
    assert.equal(noBook.status, 404)

    // bookId 形态非法
    const badId = await call(`${s.base}/books/..%2f..%2fetc/chapters`)
    assert.equal(badId.status, 400)
    assert.equal(badId.body.error, 'BOOK_ID_INVALID')

    // 导入不存在的文件
    const badImport = await call(`${s.base}/library/import`, {
      method: 'POST',
      body: { absPath: join(dir, '没有这本书.txt') },
    })
    assert.equal(badImport.status, 400)
    assert.equal(badImport.body.error, 'IMPORT_REJECTED')

    // 章号越界
    const noChapter = await call(`${s.base}/books/0123456789abcdef/chapters/999`)
    assert.equal(noChapter.status, 404)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：进度写入非法值时回 400，而不是 500', async () => {
  const dir = makeDir()
  const inbox = join(dir, 'inbox')
  mkdirSync(inbox, { recursive: true })
  const sourcePath = join(inbox, '夜行.txt')
  writeFileSync(sourcePath, Buffer.from(BOOK, 'utf8'))

  const s = await startServer(dir)
  try {
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath: sourcePath } })
    const bookId = imported.body.book.bookId

    const bad = await call(`${s.base}/books/${bookId}/progress`, {
      method: 'PUT',
      body: { chapterIndex: -3 },
    })
    // 领域错误必须映射成 4xx；落成 500 会让客户端以为插件坏了。
    assert.ok(bad.status < 500, `不该是 ${bad.status}`)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：请求体不是 JSON 时回 400', async () => {
  const dir = makeDir()
  const s = await startServer(dir)
  try {
    const res = await fetch(`${s.base}/library/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '这不是 JSON',
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'BODY_NOT_JSON')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP：导出把笔记与背景写成"书名-…"，重复导出幂等，无目录可算时回 409', async () => {
  const dir = makeDir()
  const out = makeDir('export-out')
  const s = await startServer(dir)
  try {
    const absPath = join(dir, '夜行.txt')
    writeFileSync(absPath, BOOK, 'utf8')
    const imported = await call(`${s.base}/library/import`, { method: 'POST', body: { absPath, title: '夜行' } })
    const bookId = imported.body.book.bookId

    // 直接写盘造出笔记与背景：这里测的是**导出路由**，不必绕一圈其它路由。
    const lib = s.services.readingCompanion.library
    writeFileSync(lib.paths.notes(bookId), [
      '<!-- drc-note:begin id=n1 created=2026-01-01T00:00:00.000Z chapter=0 tags= -->',
      '### 第一章 雪',
      '',
      '> 他站在雪里。',
      '',
      '**我的感想**：这句真好。',
      '',
      '<!-- drc-note:end -->',
      '',
    ].join('\n'))
    writeFileSync(
      lib.backgroundPath(bookId),
      '<!-- drc-background: schema=1 covered=1..1 -->\n# 背景\n\n## 世界观\n- `第1章` 双女主\n',
    )

    const first = await call(`${s.base}/books/${bookId}/export`, { method: 'POST', body: { dir: out } })
    assert.equal(first.status, 200)
    assert.equal(first.body.origin, 'request')
    assert.deepEqual(first.body.files.map((file) => file.name).sort(), ['夜行-笔记.md', '夜行-背景.md'])
    // 路由回报的 `dir` 必须是**实际写入的那个文件夹**（不是导出根），否则面板会
    // 让人去错地方找文件。
    assert.equal(first.body.dir, join(out, '陪读导出_夜行'))
    assert.equal(existsSync(join(first.body.dir, '夜行-笔记.md')), true)

    const second = await call(`${s.base}/books/${bookId}/export`, { method: 'POST', body: { dir: out } })
    assert.deepEqual(
      second.body.files.map((file) => file.action),
      ['unchanged', 'unchanged'],
      '第二次导出不该写盘（写一次动一次 mtime）',
    )

    // 既没给目录、也没设过设置、又没有绑定会话可算工作区根 → 409，
    // 而不是悄悄导到一个"别的地方"。
    const noDir = await call(`${s.base}/books/${bookId}/export`, { method: 'POST', body: {} })
    assert.equal(noDir.status, 409)
    assert.equal(noDir.body.error, 'EXPORT_DIR_REQUIRED')

    // 相对路径一律拒绝：它会跟着进程的工作目录走。
    const relative = await call(`${s.base}/books/${bookId}/export`, { method: 'POST', body: { dir: 'out' } })
    assert.equal(relative.status, 400)
    assert.equal(relative.body.error, 'EXPORT_DIR_NOT_ABSOLUTE')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})
