/**
 * 讨论历史（`discussions.jsonl`）的测试。
 *
 * 这里要钉住的最重要一条是**兼容性**：这个功能是后加的，用户已有的书
 * （插件目录里根本没有 `discussions.jsonl`）必须照常工作——读回空列表，
 * 而不是报错或者让面板整块挂掉。
 *
 * 第二条是**坏行容忍**：这个文件是追加写的，最可能坏的方式就是最后一行
 * 写了一半。为一行坏数据让整个时间线读不出来，是不成比例的。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  appendDiscussion,
  DISCUSSIONS_LIMIT_DEFAULT,
  DISCUSSIONS_LIMIT_MAX,
  findDiscussionMergeTarget,
  lastDiscussionAt,
  MAX_DISCUSSIONS,
  mergeDiscussion,
  normalizeDiscussion,
  normalizeDiscussionLimit,
  parseDiscussions,
  readDiscussions,
  recentDiscussions,
  sameDiscussionTopic,
} from '../lib/host/discussions.js'
import { createLibrary } from '../lib/host/library.js'
import { BOOK, call, importBook, makeDir, startServer, TMP } from './helpers/server.mjs'

//#region 纯函数

test('时间线：归一化会截断长文本——这里存的是"聊过什么话题"，不是原话', () => {
  const record = normalizeDiscussion({
    kind: 'note',
    chapterIndex: 3,
    thought: '很'.repeat(500),
  })
  assert.ok(record.thought.length < 260, `没截断：${record.thought.length}`)
  assert.match(record.thought, /…$/)
})

test('时间线：非法来源回落到 note，非法时间回落到当下（而不是丢掉这条）', () => {
  const record = normalizeDiscussion({ kind: 'nonsense', at: '不是时间', thought: '一句' }, { now: '2026-01-01T00:00:00.000Z' })
  assert.equal(record.kind, 'note')
  assert.equal(record.at, '2026-01-01T00:00:00.000Z')
})

test('时间线：全空的记录不落盘（它只会污染时间线）', () => {
  assert.equal(normalizeDiscussion({ kind: 'note' }), null)
  assert.equal(normalizeDiscussion({ kind: 'note', excerpt: '   ', thought: '' }), null)
  assert.equal(normalizeDiscussion(null), null)
  assert.equal(normalizeDiscussion('字符串'), null)
})

test('时间线：坏行跳过，不抛错——追加写的文件最可能坏在最后一行', () => {
  const text = [
    JSON.stringify({ at: '2026-01-01T00:00:00.000Z', kind: 'note', thought: '好的一条' }),
    '{"at":"2026-01-02T00:00:00.000Z","kind":',   // 写了一半
    '',
    'not json at all',
    JSON.stringify({ at: '2026-01-03T00:00:00.000Z', kind: 'note', thought: '后面的一条' }),
  ].join('\n')

  const records = parseDiscussions(text)
  assert.equal(records.length, 2, '只应跳过坏行，保留好行')
  assert.equal(records[0].thought, '好的一条')
  assert.equal(records[1].thought, '后面的一条')
})

test('时间线：顺序约定是"文件里旧在前"，而对外一律新在前', () => {
  const records = [
    { at: '2026-01-01T00:00:00.000Z', chapterIndex: 1 },
    { at: '2026-01-02T00:00:00.000Z', chapterIndex: 2 },
    { at: '2026-01-03T00:00:00.000Z', chapterIndex: 3 },
  ]
  const recent = recentDiscussions(records, 2)
  assert.equal(recent[0].chapterIndex, 3, '对外必须新在前')
  assert.equal(recent[1].chapterIndex, 2)
  assert.equal(lastDiscussionAt(records), '2026-01-03T00:00:00.000Z')
})

test('时间线：合并过的那条即使留在原位，"最新一次"也必须按时间算（2026-10-01 三方评审 P2）', () => {
  // 真实形状：10:00 那条先写；11:00 的回应**并进它**（`mergeDiscussion` 更新 `at`、
  // 但位置不动）；随后又有一次 10:30 的讨论。于是文件里的顺序不再等于时间顺序 ——
  // 旧实现按数组位置取"最新"，会报出 10:30，而真正最新是 11:00（面板上"距上次
  // 聊这本书"因此说了假话，时间线首条也错）。
  const records = [
    { at: '2026-01-01T11:00:00.000Z', chapterIndex: 1, thought: '合并进去的回应' },
    { at: '2026-01-01T10:30:00.000Z', chapterIndex: 2, thought: '后来那次单独的讨论' },
  ]
  assert.equal(
    lastDiscussionAt(records),
    '2026-01-01T11:00:00.000Z',
    '最新一次是 11:00，不是数组里最后那条',
  )
  assert.equal(recentDiscussions(records, 1)[0].chapterIndex, 1, '面板时间线首条也必须是最新那次')
})

test('时间线：at 缺失或不可解析时不许把排序搅乱（NaN 参与比较会让结果不可预测）', () => {
  const records = [
    { at: '不是时间', chapterIndex: 1, thought: '坏时间' },
    { chapterIndex: 2, thought: '没时间' },
    { at: '2026-01-02T00:00:00.000Z', chapterIndex: 3, thought: '好时间' },
  ]
  assert.equal(recentDiscussions(records, 1)[0].chapterIndex, 3, '有合法时间的必须排在前面')
  assert.equal(recentDiscussions(records, 3).length, 3, '坏时间不该让元素凭空消失')
  assert.equal(lastDiscussionAt(records), '2026-01-02T00:00:00.000Z')
})

test('时间线：**同一毫秒**的记录也必须"新在前"（2026-10-02 发布核查；CI 上 ubuntu+node22.19 每跑必红）', () => {
  // ⚠️ `at` 只有**毫秒**精度，而"写笔记 → 发到会话 → 抓回回应"三次调用完全可能落在
  //    同一毫秒里。旧实现靠"稳定排序保持文件顺序"⇒ 同毫秒时**最旧的排在最前**，
  //    与"新在前"的契约正好相反。它只在**快的机器**上现形：GitHub 的
  //    `ubuntu-latest + node 22.19` 一条腿每跑必红，而 Windows / node 24 上因为
  //    两次调用恰好差 1ms 而一直绿 —— 这正是"测试是对的、实现是错的"那种形状。
  //    文件是**追加写**的 ⇒ 位置就是插入顺序 ⇒ 靠后的那条更新。
  const same = '2026-10-02T10:00:00.000Z'
  const tied = recentDiscussions([
    { at: same, chapterIndex: 0, thought: '先记的' },
    { at: same, chapterIndex: 2, thought: '后记的' },
  ], 10)
  assert.equal(tied[0].chapterIndex, 2, '同毫秒时靠后写入的那条更新（新在前）')
  assert.equal(tied[1].chapterIndex, 0)

  // 没有 `at`（timeOf 回 0）时同理：**不许**把先写入的排到前面。
  const noAt = recentDiscussions([{ chapterIndex: 0 }, { chapterIndex: 2 }], 10)
  assert.equal(noAt[0].chapterIndex, 2, '缺 at 时也按插入顺序倒排')

  // 差 1 毫秒时仍然按时间（别把这条修成"只看位置"）。
  const stepped = recentDiscussions([
    { at: '2026-10-02T10:00:00.000Z', chapterIndex: 2 },
    { at: '2026-10-02T10:00:00.001Z', chapterIndex: 0 },
  ], 10)
  assert.equal(stepped[0].chapterIndex, 0, '时间不同时以时间戳为准，与位置无关')
})

test('时间线：条数封顶，旧的直接丢（信息已沉淀进 background.md）', () => {
  const path = join(makeDir('discussions-cap'), 'discussions.jsonl')
  for (let i = 0; i < 12; i += 1) {
    appendDiscussion(path, { at: '2026-01-01T00:00:00.000Z', kind: 'note', chapterIndex: i, thought: `第${i}条` }, { max: 5 })
  }
  const kept = readDiscussions(path)
  assert.equal(kept.length, 5)
  assert.equal(kept[4].thought, '第11条', '留下的应当是最新的那几条')
})

test('时间线：未满仓时走追加 —— 旧字节必须逐字节仍是前缀（缓存前提）', () => {
  // ⚠️ 这条盯的是**前缀稳定性**，不是"写对没有"。
  //
  // 讨论历史是动态区的一部分，而动态区也想吃到 prompt 缓存：只要它按同一个
  // 方向增长，前面那段的字节就不变，缓存就能复用。旧实现每次"读全文 → 拼 →
  // 整份重写"，**内容**上等价，所以之前没有正确性问题；但它把这条性质押在了
  // 实现细节上，而且满仓后前缀必然失效（头部平移）。未满仓的整个阶段恰恰是
  // 缓存最可能命中的阶段，更不该白白牺牲。
  const path = join(makeDir('discussions-prefix'), 'discussions.jsonl')
  const opts = { max: 50 }

  appendDiscussion(path, { at: '2026-01-01T00:00:00.000Z', kind: 'note', chapterIndex: 0, thought: '第一条' }, opts)
  const md1 = readFileSync(path, 'utf8')

  appendDiscussion(path, { at: '2026-01-02T00:00:00.000Z', kind: 'note', chapterIndex: 1, thought: '第二条' }, opts)
  const md2 = readFileSync(path, 'utf8')

  assert.ok(md2.startsWith(md1), '追加之后，旧内容必须逐字节仍是前缀')
  assert.ok(md2.length > md1.length, '追加应当让文件变长')
  assert.equal(readDiscussions(path).length, 2)
})

test('时间线：满仓后前缀**必然**失效（这是 max 的真实代价，不是 bug）', () => {
  // 写下来是为了让下一个人知道"这不是坏了"：满仓后每次都要丢最旧一条、
  // 整份位移，前缀不可能还稳定。想恢复缓存命中，唯一办法是提高 max 或改结构，
  // 而不是"修"这个测试。
  const path = join(makeDir('discussions-cap-prefix'), 'discussions.jsonl')
  const opts = { max: 3 }
  for (let i = 0; i < 3; i += 1) {
    appendDiscussion(path, { at: '2026-01-01T00:00:00.000Z', kind: 'note', chapterIndex: i, thought: `第${i}条` }, opts)
  }
  const full = readFileSync(path, 'utf8')
  appendDiscussion(path, { at: '2026-01-02T00:00:00.000Z', kind: 'note', chapterIndex: 9, thought: '第9条' }, opts)
  const after = readFileSync(path, 'utf8')

  assert.equal(after.startsWith(full), false, '满仓后必须整份位移 —— 前缀不可能还稳定')
  const back = readDiscussions(path)
  assert.equal(back.length, 3)
  assert.equal(back[0].thought, '第1条', '丢的应当是最旧那条')
})

test('时间线：文件末尾缺换行时先补一个，不把两行粘成一行', () => {
  // 手改过、或被别的工具写过的文件可能不带结尾换行。直接 append 会把新记录
  // 接到上一行屁股后面，那一行整条变成坏行 —— 而坏行是**静默跳过**的，
  // 用户只会看到"我记的那条不见了"，不会有任何报错。
  const path = join(makeDir('discussions-no-newline'), 'discussions.jsonl')
  writeFileSync(
    path,
    '{"at":"2026-01-01T00:00:00.000Z","kind":"note","chapterIndex":0,"thought":"手写的"}',
    'utf8',
  )

  appendDiscussion(path, { at: '2026-01-02T00:00:00.000Z', kind: 'note', chapterIndex: 1, thought: '追加的' }, { max: 50 })

  const back = readDiscussions(path)
  assert.equal(back.length, 2, '两行被粘成一行了，手写的那条会变成坏行')
  assert.equal(back[0].thought, '手写的')
  assert.equal(back[1].thought, '追加的')
})

test('时间线：文件不存在时读回空数组（这是老数据能继续用的前提）', () => {
  assert.deepEqual(readDiscussions(join(makeDir('discussions-missing'), 'nope.jsonl')), [])
})

//#endregion

//#region 同一次交互并成一条
//
// 读者实测："一次记笔记的行为可能产生四五条讨论历史"。成因是三处各记一条：
// 宿主在笔记落盘时记 `note`，客户端在"发去聊"记 `sent`、在"抓回回应"记 `reply`。
// 它们说的是同一件事，所以现在**并进第一条**。

test('时间线：判据分级（reply 那条没有摘抄，只退回比感想）', () => {
  const at = '2026-09-27T10:00:00.000Z'
  const note = normalizeDiscussion({ kind: 'note', chapterIndex: 3, excerpt: '他站在雪里。', thought: '这句真好', at })
  const sent = normalizeDiscussion({ kind: 'sent', chapterIndex: 3, excerpt: '他站在雪里。', thought: '这句真好', at })
  const reply = normalizeDiscussion({ kind: 'reply', chapterIndex: 3, thought: '这句真好', reply: '冷得能听见声音。', at })

  assert.equal(sameDiscussionTopic(note, sent), true, '同章 + 同摘抄 = 同一件事')
  assert.equal(sameDiscussionTopic(note, reply), true, 'reply 没有摘抄 → 退回比感想')
  // 章号不同 = 不是同一件事。
  const other = normalizeDiscussion({ kind: 'note', chapterIndex: 9, excerpt: '他站在雪里。', thought: '这句真好', at })
  assert.equal(sameDiscussionTopic(note, other), false)
  // 两边都拿不出可比字段 → **不合并**（宁可不并，也不要错并两条不同的讨论）。
  assert.equal(sameDiscussionTopic(note, { chapterIndex: 3, excerpt: '', thought: '' }), false)
  // 章号缺失 → 不合并。
  assert.equal(sameDiscussionTopic({ chapterIndex: null, excerpt: 'x', thought: '' }, sent), false)
})

test('时间线：合并保留先到的 kind、补齐 reply、时间戳往前走', () => {
  const note = normalizeDiscussion({ kind: 'note', chapterIndex: 3, excerpt: '他站在雪里。', thought: '这句真好', at: '2026-09-27T10:00:00.000Z' })
  const reply = normalizeDiscussion({ kind: 'reply', chapterIndex: 3, thought: '这句真好', reply: '冷得能听见声音。', at: '2026-09-27T10:10:00.000Z' })

  const merged = mergeDiscussion(note, reply)
  assert.equal(merged.kind, 'note', 'kind 保持先到的那个（那一行代表这件事从哪一步开始）')
  assert.equal(merged.excerpt, '他站在雪里。', '已有的字段不动')
  assert.equal(merged.reply, '冷得能听见声音。', '后来的空字段补齐')
  assert.equal(merged.at, reply.at, '时间戳往前走——"距上次聊过去多久"靠它')
  assert.equal(note.reply, '', '不许改原对象')
})

test('时间线：合并有时间窗与回看条数（改天再记一次是两次真实讨论）', () => {
  const note = { at: '2026-09-27T10:00:00.000Z', kind: 'note', chapterIndex: 3, excerpt: '同一段', thought: '', reply: '' }
  const soon = { at: '2026-09-27T10:30:00.000Z', kind: 'sent', chapterIndex: 3, excerpt: '同一段', thought: '', reply: '' }
  const nextDay = { at: '2026-09-28T10:00:00.000Z', kind: 'sent', chapterIndex: 3, excerpt: '同一段', thought: '', reply: '' }

  assert.equal(findDiscussionMergeTarget([note], soon), 0, '半小时内 = 同一次交互')
  assert.equal(findDiscussionMergeTarget([note], nextDay), -1, '隔了一天不该并')
  // 只往前找固定条数：中间夹了别的话题就不并（窗口小到不会翻出上一个话题）。
  const filler = Array.from({ length: 6 }, (_, i) => (
    { at: '2026-09-27T10:31:00.000Z', kind: 'note', chapterIndex: 8, excerpt: `别的 ${i}`, thought: '', reply: '' }
  ))
  assert.equal(findDiscussionMergeTarget([note, ...filler], soon), -1)
  // 时间戳读不出来时不合并（宁可多一条，也不要错并）。
  assert.equal(findDiscussionMergeTarget([{ ...note, at: '不是时间' }], soon), -1)
})

//#endregion

//#region 书库层

test('书库：讨论记录能往返，且第 0 章不会被当成"没有章节"', () => {
  const storageDir = makeDir('discussions-lib')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  library.recordDiscussion(book.bookId, { kind: 'note', chapterIndex: 0, thought: '开篇的感受' })
  library.recordDiscussion(book.bookId, { kind: 'sent', chapterIndex: 2, thought: '第二章的想法' })

  const list = library.listDiscussions(book.bookId, 10)
  assert.equal(list.length, 2)
  assert.equal(list[0].chapterIndex, 2, '新在前')
  // ⚠️ 第 0 章是**合法章节**。用 `chapterIndex || null` 之类的写法会把它
  // 变成 null，面板上就会显示"—"。这里专门钉住这个边界。
  assert.equal(list[1].chapterIndex, 0)
  assert.equal(list[1].thought, '开篇的感受')
})

test('书库：一次记笔记的三步只留一条历史（读者实测的"四五条"就是这个）', () => {
  const storageDir = makeDir('discussions-merge')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  // 一次真实的交互：写笔记 → 发去聊 → 抓回回应。
  library.recordDiscussion(book.bookId, { kind: 'note', chapterIndex: 1, excerpt: '他站在雪里。', thought: '这句真好' })
  library.recordDiscussion(book.bookId, { kind: 'sent', chapterIndex: 1, excerpt: '他站在雪里。', thought: '这句真好' })
  library.recordDiscussion(book.bookId, { kind: 'reply', chapterIndex: 1, thought: '这句真好', reply: '冷得能听见声音。' })

  const list = library.listDiscussions(book.bookId, 10)
  assert.equal(list.length, 1, '三步 = 一条')
  assert.equal(list[0].kind, 'note', 'kind 保持先到的那个')
  assert.equal(list[0].reply, '冷得能听见声音。', '回应补进来了')

  // ⚠️ 磁盘上也**真的**只有一行 —— 读取时才合并是不够的（那样文件仍会无限膨胀）。
  const raw = readFileSync(join(storageDir, 'books', book.bookId, 'discussions.jsonl'), 'utf8')
  assert.equal(raw.trim().split('\n').length, 1)
})

test('书库：记一条无意义的输入不落盘，但也不报错', () => {  const storageDir = makeDir('discussions-noop')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  assert.equal(library.recordDiscussion(book.bookId, { kind: 'note' }), null)
  assert.equal(library.listDiscussions(book.bookId).length, 0)
})

test('书库：讨论历史留在插件目录，不占用户工作区', () => {
  // 与 notes.md / background.md 的约定相反，这是刻意的：它是机器数据。
  const storageDir = makeDir('discussions-loc')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })
  library.recordDiscussion(book.bookId, { kind: 'note', chapterIndex: 1, thought: '一句' })

  assert.equal(library.discussionsPath(book.bookId), join(storageDir, 'books', book.bookId, 'discussions.jsonl'))
})

test('书库：未知书回 BOOK_NOT_FOUND，而不是静默写到一个诡异的地方', () => {
  const library = createLibrary({ storageDir: makeDir('discussions-404'), fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  assert.throws(() => library.recordDiscussion('0'.repeat(16), { kind: 'note', thought: 'x' }), /BOOK_NOT_FOUND/)
  assert.throws(() => library.recordDiscussion('不是id', { kind: 'note', thought: 'x' }), /BOOK_ID_INVALID/)
})

//#endregion

//#region HTTP 面

test('HTTP：写笔记会自动记一条时间线（服务端记的，不依赖面板）', async () => {
  const dir = makeDir('discussions-http')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { chapterIndex: 1, chapterTitle: '第二章 夜', excerpt: '摘抄', thought: '我的感想' },
    })

    const got = await call(`${s.base}/books/${bookId}/discussions`)
    assert.equal(got.status, 200)
    assert.equal(got.body.discussions.length, 1)
    assert.equal(got.body.discussions[0].kind, 'note')
    assert.equal(got.body.discussions[0].thought, '我的感想')
    assert.equal(got.body.discussions[0].chapterIndex, 1)
  } finally {
    await s.close()
  }
})

test('HTTP：客户端可以补记「发去聊」「抓回回应」，且能读回来', async () => {
  const dir = makeDir('discussions-http2')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    assert.equal((await call(`${s.base}/books/${bookId}/discussions`, {
      method: 'POST',
      body: { kind: 'sent', chapterIndex: 2, thought: '发去聊了' },
    })).status, 200)
    await call(`${s.base}/books/${bookId}/discussions`, {
      method: 'POST',
      body: { kind: 'reply', chapterIndex: 2, thought: '我的感想', reply: 'AI 的回应' },
    })

    const got = (await call(`${s.base}/books/${bookId}/discussions`)).body.discussions
    assert.equal(got.length, 2)
    assert.equal(got[0].kind, 'reply')
    assert.equal(got[0].reply, 'AI 的回应')
    assert.equal(got[1].kind, 'sent')
  } finally {
    await s.close()
  }
})

test('HTTP：limit 参与约束，非法值回落到 20', async () => {
  const dir = makeDir('discussions-http3')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    for (let i = 0; i < 8; i += 1) {
      await call(`${s.base}/books/${bookId}/discussions`, {
        method: 'POST',
        body: { kind: 'note', chapterIndex: i, thought: `第${i}条` },
      })
    }
    assert.equal((await call(`${s.base}/books/${bookId}/discussions?limit=3`)).body.discussions.length, 3)
    assert.equal((await call(`${s.base}/books/${bookId}/discussions?limit=abc`)).body.discussions.length, 8)
  } finally {
    await s.close()
  }
})

test('HTTP：兼容性——老书（没有 discussions.jsonl）读回空列表，不是 500', async () => {
  const dir = makeDir('discussions-legacy')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    const path = join(dir, 'books', bookId, 'discussions.jsonl')
    assert.equal(existsSync(path), false, '这个测试的前提就是这个文件不存在')

    const got = await call(`${s.base}/books/${bookId}/discussions`)
    assert.equal(got.status, 200)
    assert.deepEqual(got.body.discussions, [])
  } finally {
    await s.close()
  }
})

test('HTTP：讨论历史进了 AI 视角预览，且在动态区', async () => {
  const dir = makeDir('discussions-context')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-1' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { chapterIndex: 1, thought: '一句很特别的感想' },
    })

    const ctx = await call(`${s.base}/books/${bookId}/context`)
    assert.match(ctx.body.section, /你们之前聊过/)
    assert.match(ctx.body.section, /一句很特别的感想/)
    assert.equal(ctx.body.summary.discussionCount, 1)

    // 时间线必须是动态的——它每聊一次就变，混进稳定前缀会让缓存失效。
    const stable = ctx.body.section.slice(0, ctx.body.summary.cacheSplit.stable)
    assert.doesNotMatch(stable, /你们之前聊过/)
  } finally {
    await s.close()
  }
})

test('HTTP：绑定前的书也能记笔记与时间线（不因为没绑定就丢记录）', async () => {
  const dir = makeDir('discussions-unbound')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    const wrote = await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { chapterIndex: 0, excerpt: '第一章的一句', thought: '开头就好' },
    })
    assert.equal(wrote.status, 200)
    assert.equal((await call(`${s.base}/books/${bookId}/discussions`)).body.discussions.length, 1)
  } finally {
    await s.close()
  }
})

//#endregion

//#region 与 prompt 的衔接

test('端到端：时间线进 prompt 时只带摘要，且不重复投喂对话原文', async () => {
  const dir = makeDir('discussions-prompt')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-2' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 0 } })

    const longThought = '这段感想故意写得很长'.repeat(40)
    await call(`${s.base}/books/${bookId}/notes`, {
      method: 'POST',
      body: { chapterIndex: 2, thought: longThought, reply: 'AI 回了很长的一段'.repeat(40) },
    })

    const ctx = await call(`${s.base}/books/${bookId}/context`)
    // 时间线里出现的是被截断的摘要（60 字 + 省略号），不是整段。
    assert.match(ctx.body.section, /你们之前聊过/)
    assert.ok(!ctx.body.section.includes(longThought), '不该把整段感想塞进时间线')
  } finally {
    await s.close()
  }
})

//#endregion

//#region 文件形态

test('落盘形态：一行一条 JSONL，末尾带换行（追加友好）', async () => {
  const dir = makeDir('discussions-shape')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/discussions`, { method: 'POST', body: { kind: 'note', chapterIndex: 1, thought: '一' } })
    await call(`${s.base}/books/${bookId}/discussions`, { method: 'POST', body: { kind: 'note', chapterIndex: 2, thought: '二' } })

    const raw = readFileSync(join(dir, 'books', bookId, 'discussions.jsonl'), 'utf8')
    assert.ok(raw.endsWith('\n'))
    const lines = raw.trim().split('\n')
    assert.equal(lines.length, 2)
    for (const line of lines) JSON.parse(line)
  } finally {
    await s.close()
  }
})

test('模块自洽：所有导出的读函数都能容忍 null 输入', async () => {
  // 这些函数会被面板/注入链路以"可能没有数据"的姿态调用，抛错就会毁掉整段
  // prompt 装配（那是最贵的失败）。
  assert.deepEqual(readDiscussions(join(TMP, '不存在的目录', 'x.jsonl')), [])
  assert.deepEqual(recentDiscussions(null), [])
  assert.equal(lastDiscussionAt(null), null)
  assert.deepEqual(parseDiscussions(undefined), [])
})

//#endregion

//#region 限条

test('限条：外部 limit 必须被夹上限，非法值一律回落默认', () => {
  assert.equal(normalizeDiscussionLimit('5'), 5)
  assert.equal(normalizeDiscussionLimit(5), 5)

  // 这一条是重点：limit 来自 URL，是**外部输入**。光判正数不够——一个
  // `?limit=100000` 就足以让宿主把整份文件切片、序列化、再回传。
  assert.equal(normalizeDiscussionLimit('99999'), DISCUSSIONS_LIMIT_MAX, 'limit 没有夹上限')
  assert.equal(normalizeDiscussionLimit(String(MAX_DISCUSSIONS * 10)), DISCUSSIONS_LIMIT_MAX)

  // 读的上限不该超过存的上限——读比存还多没有意义。
  assert.equal(DISCUSSIONS_LIMIT_MAX, MAX_DISCUSSIONS)

  // 非法值回落到默认，而不是抛错：这一类参数只是"想少要一点"的提示。
  for (const bad of ['abc', '0', '-5', '', null, undefined, {}, 'NaN']) {
    assert.equal(
      normalizeDiscussionLimit(bad),
      DISCUSSIONS_LIMIT_DEFAULT,
      `非法 limit ${JSON.stringify(bad)} 应当回落默认值`,
    )
  }
})

test('限条：total 是未截断的总条数，不随 limit 缩水', async () => {
  // 面板只显示最近几条，靠 total 把「只显示了最近几条」讲清楚。如果 total
  // 也跟着 limit 缩水，那句说明就变成谎话（"共 3 条"而实际有 8 条）。
  const dir = makeDir('discussions-total')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    for (let i = 1; i <= 8; i += 1) {
      await call(`${s.base}/books/${bookId}/discussions`, {
        method: 'POST',
        body: { kind: 'note', chapterIndex: i, thought: `第 ${i} 条` },
      })
    }

    const page = (await call(`${s.base}/books/${bookId}/discussions?limit=3`)).body
    assert.equal(page.discussions.length, 3, 'limit=3 只该回 3 条')
    assert.equal(page.total, 8, 'total 必须是全部条数，否则面板没法说清"只显示最近几条"')
    // 顺序仍然是新在前（不然"最近 N 条"取到的是最早的 N 条）。
    assert.equal(page.discussions[0].thought, '第 8 条')

    // 不传 limit 时也不该丢掉 total。
    const dflt = (await call(`${s.base}/books/${bookId}/discussions`)).body
    assert.equal(dflt.discussions.length, 8)
    assert.equal(dflt.total, 8)
  } finally {
    await s.close()
  }
})

//#endregion
