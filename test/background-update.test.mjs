/**
 * 背景更新（T1-②）的测试。
 *
 * 分三层，因为这条路径有三段各自会坏：
 *   1. **解析与校验**（纯函数）——块的写法五花八门，安全闸必须在每一条上都成立；
 *   2. **合并语义**——"取代"要真的搬走旧条目，而覆盖区间**不能**被顺手改大；
 *   3. **接线**——事件订阅、观察者、"函数对但没接线"（本仓库栽过三次的坑）。
 *
 * ⚠️ 第 3 层刻意走**真实的那条路**（`hooks.emit` → 观察者 → 落盘），
 * 不直接调纯函数：纯函数全绿而事件没接上是完全可能的。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeBackground } from '../lib/host/background.js'
import {
  createBackgroundUpdateWatcher,
  maxUpdateChapter,
  parseBackgroundUpdates,
  renderUpdateInstruction,
  supersedesList,
  updatesToIncomingDoc,
} from '../lib/host/background-update.js'
import { renderPolicy } from '../lib/host/spoiler.js'
import { call, importBook, makeDir, startServer } from './helpers/server.mjs'

/** 拼一个更新块。 */
const block = (body) => `<!--drc-update\n${body}\n-->`

/** 拼一条 assistant 消息事件（形状照 `SessionEventMap` 的 `assistant/message`）。 */
const assistantEvent = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

/** 拼一条读者消息事件（`user/message` 的 data **就是** UserMessage）。 */
const userEvent = (text) => ({
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text }] },
})

/** 校验通过的更新对象（手动构造，等价于 validateUpdate 的产物）。 */
const update = (fields = {}) => ({
  section: '人物',
  grouped: true,
  subject: '沈某',
  chapter: 3,
  fact: '他其实没死',
  supersedes: [],
  ...fields,
})

//#region 解析与校验

test('建议：一个完整块被解析成一条带章节归属的更新', () => {
  const text = `嗯，我记住了。\n${block('节: 人物\n主体: 沈某\n章: 30\n事实: 第 30 章里他其实没死，是被救走了')}`
  const { accepted, rejected } = parseBackgroundUpdates(text, { progressIndex: 29 })

  assert.equal(rejected.length, 0)
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].section, '人物')
  assert.equal(accepted[0].grouped, true)
  assert.equal(accepted[0].subject, '沈某')
  assert.equal(accepted[0].chapter, 30)
  assert.equal(accepted[0].fact, '第 30 章里他其实没死，是被救走了')
})

test('建议：事实的续行被接上，不会被悄悄截断', () => {
  // 截断后的句子仍然像一句完整的话，这是这条测试存在的理由。
  const text = block('主体: 沈某\n章: 3\n事实: 第一句。\n第二句。\n第三句。')
  const { accepted } = parseBackgroundUpdates(text, { progressIndex: 9 })
  assert.equal(accepted[0].fact, '第一句。 第二句。 第三句。')
})

test('建议：取代可以写多条', () => {
  const text = block('主体: 沈某\n章: 3\n事实: 新说法\n取代: 旧说法甲\n取代: 旧说法乙')
  const { accepted } = parseBackgroundUpdates(text, { progressIndex: 9 })
  assert.deepEqual(accepted[0].supersedes, ['旧说法甲', '旧说法乙'])
})

test('建议：省掉章号时归到当前章（读者正在读它，必然安全）', () => {
  const { accepted } = parseBackgroundUpdates(block('主体: 沈某\n事实: 没写章号'), { progressIndex: 6 })
  assert.equal(accepted[0].chapter, 7)
})

test('建议：全角冒号与前后空格都能认', () => {
  const { accepted } = parseBackgroundUpdates(block('主体：沈某\n章 ： 3\n事实： 全角冒号'), { progressIndex: 9 })
  assert.equal(accepted[0].subject, '沈某')
  assert.equal(accepted[0].chapter, 3)
  assert.equal(accepted[0].fact, '全角冒号')
})

test('安全：章号超前进度一律拒绝，并列明是哪一章超了', () => {
  const { accepted, rejected } = parseBackgroundUpdates(
    block('主体: 沈某\n章: 300\n事实: 结局是……'),
    { progressIndex: 29 },
  )
  assert.equal(accepted.length, 0)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason, 'CHAPTER_AHEAD')
  // 详情要能直接看出来是哪一章超了——日志里只有一个"拒绝"等于没有日志。
  assert.match(String(rejected[0].detail), /300/)
})

test('安全：章号等于"进度 + 1"是允许的（读者正在读这一章）', () => {
  const { accepted, rejected } = parseBackgroundUpdates(block('主体: 沈某\n章: 30\n事实: 正好当前章'), { progressIndex: 29 })
  assert.equal(rejected.length, 0)
  assert.equal(accepted[0].chapter, 30)
})

test('建议：三种"没写全"给出各自不同的理由', () => {
  const cases = [
    ['节: 天干地支\n主体: 沈某\n章: 3\n事实: 甲', 'UNKNOWN_SECTION'],
    ['节: 人物\n章: 3\n事实: 缺主体', 'NO_SUBJECT'],
    ['节: 人物\n主体: 沈某\n章: 3', 'EMPTY_FACT'],
    ['节: 人物\n主体: 沈某\n章: 第三章\n事实: 章号不是数字', 'CHAPTER_INVALID'],
  ]
  for (const [body, reason] of cases) {
    const { accepted, rejected } = parseBackgroundUpdates(block(body), { progressIndex: 9 })
    assert.equal(accepted.length, 0, `${reason} 不该被接受`)
    assert.equal(rejected[0].reason, reason)
  }
})

test('建议：平铺分区（文风 / 前文脉络）不需要主体', () => {
  const { accepted, rejected } = parseBackgroundUpdates(
    block('节: 文风\n章: 3\n事实: 多用短句，少用形容词'),
    { progressIndex: 9 },
  )
  assert.equal(rejected.length, 0)
  assert.equal(accepted[0].grouped, false)
  assert.equal(accepted[0].subject, '')
})

test('安全：说明里的示例必须能被它自己的解析器接受（否则等于教模型写废块）', () => {
  // 第一版示例写的是 `章: <这个事实属于第几章>`，它通不过本模块自己的校验。
  // 一个要模型照抄的示例，起码得是它自己的解析器接受的形状。
  const { accepted, rejected } = parseBackgroundUpdates(renderUpdateInstruction(), { progressIndex: 999 })
  assert.deepEqual(rejected, [], '守则里的示例块被自己的校验拒绝了')
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].section, '人物')
  assert.equal(accepted[0].subject, '沈某')
  assert.equal(accepted[0].chapter, 30)
})

test('建议：没有标记的文本直接回空，且不跑正则', () => {
  const { accepted, rejected } = parseBackgroundUpdates('这就是一句普通的话，什么标记也没有。', { progressIndex: 9 })
  assert.deepEqual(accepted, [])
  assert.deepEqual(rejected, [])
})

test('建议：进文件的条目与补齐路径同形（带章号标记，才能参与分区配平与取代匹配）', () => {
  const doc = updatesToIncomingDoc([update({ chapter: 30, fact: '他其实没死' })])
  assert.deepEqual(doc.groups['人物']['沈某'], ['`第30章` 他其实没死'])
  // 平铺分区进 sections，不建组。
  const flat = updatesToIncomingDoc([update({ section: '文风', grouped: false, subject: '', fact: '短句为主' })])
  assert.deepEqual(flat.sections['文风'], ['`第3章` 短句为主'])
  assert.deepEqual(maxUpdateChapter([update({ chapter: 7 }), update({ chapter: 30 })]), 30)
})

//#endregion

//#region 合并语义

test('取代：旧条目搬进归档、不删除，新条目留在活分区', () => {
  const base = {
    covered: { first: 1, last: 10 },
    sections: {},
    groups: { 人物: { 沈某: ['`第12章` 沈某已死'] } },
    retired: [],
    unknown: '',
  }
  const updates = [update({ chapter: 30, fact: '未死，被救走', supersedes: ['沈某已死'] })]

  const merged = mergeBackground(
    base,
    updatesToIncomingDoc(updates),
    { first: 1, last: 30 },
    undefined,
    { supersedes: supersedesList(updates), extendCoverage: false },
  )

  assert.deepEqual(merged.groups['人物']['沈某'], ['`第30章` 未死，被救走'])
  // 归档而不是删掉：搬回去就能撤销这次取代。
  assert.equal(merged.retired.length, 1)
  assert.match(merged.retired[0], /沈某已死/)
  assert.match(merged.retired[0], /已于第 30 章被取代/)
  assert.equal(merged.lastMerge.superseded, 1)
})

test('取代：没命中任何旧条目时记进 unmatched，不静默', () => {
  const updates = [update({ fact: '新说法', supersedes: ['一句根本不存在的话'] })]
  const merged = mergeBackground(
    { covered: { first: 1, last: 3 }, sections: {}, groups: {}, retired: [], unknown: '' },
    updatesToIncomingDoc(updates),
    { first: 1, last: 3 },
    undefined,
    { supersedes: supersedesList(updates), extendCoverage: false },
  )
  // 调用方必须能看到它——否则模型写错旧说法时会以为修正已经生效。
  assert.deepEqual(merged.lastMerge.unmatched, ['一句根本不存在的话'])
  assert.equal(merged.lastMerge.superseded, 0)
})

test('安全：背景更新不改覆盖区间——写进去一条修正，不等于这些章被补过', () => {
  const incoming = updatesToIncomingDoc([update({ chapter: 30, fact: '一条修正' })])
  const empty = { covered: null, sections: {}, groups: {}, retired: [], unknown: '' }

  // 反例：默认行为（补齐路径用的就是它）会把区间撑到 1..30——那是**虚报覆盖**，
  // 真正的第 1–29 章缺口会就此静默消失。这里显式钉住这个差别，
  // 因为"某个选项是承重的"这件事，只有对照才看得出来。
  const loose = mergeBackground(empty, incoming, { first: 1, last: 30 })
  assert.deepEqual(loose.covered, { first: 1, last: 30 })

  const strict = mergeBackground(empty, incoming, { first: 1, last: 30 }, undefined, { extendCoverage: false })
  assert.equal(strict.covered, null, '背景更新绝不能让文件声称有了覆盖')

  // 已有覆盖时也必须原样不动（既不变大也不变小）。
  const had = mergeBackground(
    { covered: { first: 1, last: 5 }, sections: {}, groups: {}, retired: [], unknown: '' },
    incoming,
    { first: 1, last: 30 },
    undefined,
    { extendCoverage: false },
  )
  assert.deepEqual(had.covered, { first: 1, last: 5 })
})

//#endregion

//#region 观察者

/** 造一个只够观察者用的假书库。 */
function fakeLibrary(overrides = {}) {
  const applied = []
  return {
    applied,
    bookForSession: (sessionId) => (sessionId === 'bound' ? 'book-1' : undefined),
    getProgress: () => ({ chapterIndex: 4 }),
    backgroundApplyUpdates: (bookId, updates) => {
      applied.push({ bookId, updates })
      return { covered: { first: 1, last: 4 }, lastMerge: { superseded: 0, unmatched: [] } }
    },
    ...overrides,
  }
}

test('观察者：非陪读会话完全不碰（书库里没有这条绑定）', () => {
  const library = fakeLibrary()
  const watcher = createBackgroundUpdateWatcher({ library })
  const result = watcher.handleEvent({ id: 'someone-else' }, assistantEvent(block('主体: 沈某\n事实: 甲')))
  assert.equal(result, null)
  assert.equal(library.applied.length, 0)
})

test('观察者：非消息类事件不查书（这是热路径，每次追加都会走到）', () => {
  let looked = 0
  const library = fakeLibrary({
    bookForSession: () => {
      looked += 1
      return 'book-1'
    },
  })
  const watcher = createBackgroundUpdateWatcher({ library })
  for (const type of ['turn/start', 'step/end', 'tool/call', 'assistant/attempt']) {
    assert.equal(watcher.handleEvent({ id: 'bound' }, { type, data: {} }), null)
  }
  assert.equal(looked, 0, '非消息事件不该去查书——热路径上这一步要能短路')
})

test('观察者：消息里没有块时不落盘', () => {
  const library = fakeLibrary()
  const watcher = createBackgroundUpdateWatcher({ library })
  assert.equal(watcher.handleEvent({ id: 'bound' }, assistantEvent('这本书真好看。')), null)
  assert.equal(library.applied.length, 0)
})

test('观察者：助手消息里的块真的走到落盘', () => {
  const library = fakeLibrary()
  const watcher = createBackgroundUpdateWatcher({ library })
  const result = watcher.handleEvent({ id: 'bound' }, assistantEvent(block('主体: 沈某\n章: 3\n事实: 他其实没死')))

  assert.equal(result.accepted, 1)
  assert.equal(library.applied.length, 1)
  assert.equal(library.applied[0].bookId, 'book-1')
  assert.equal(library.applied[0].updates[0].fact, '他其实没死')
})

test('观察者：读者自己的消息也算数（同一个 durable 流，同一套校验）', () => {
  const library = fakeLibrary()
  const watcher = createBackgroundUpdateWatcher({ library })
  const result = watcher.handleEvent({ id: 'bound' }, userEvent(block('主体: 沈某\n章: 3\n事实: 读者自己贴的修正')))
  assert.equal(result.accepted, 1)
  assert.equal(library.applied[0].updates[0].fact, '读者自己贴的修正')
})

test('观察者：只被拒绝时不落盘，但一定留痕（否则"AI 记下了"是错觉）', () => {
  const warnings = []
  const library = fakeLibrary()
  const watcher = createBackgroundUpdateWatcher({ library, logger: { warn: (m) => warnings.push(m) } })
  // 进度在第 5 章（chapterIndex 4），块却说第 300 章。
  const result = watcher.handleEvent({ id: 'bound' }, assistantEvent(block('主体: 沈某\n章: 300\n事实: 结局')))

  assert.equal(result.accepted, 0)
  assert.equal(result.rejected[0].reason, 'CHAPTER_AHEAD')
  assert.equal(library.applied.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /CHAPTER_AHEAD/)
})

test('观察者：自己吞掉异常，绝不让一条背景更新影响读者的对话', () => {
  const errors = []
  const library = fakeLibrary({
    backgroundApplyUpdates: () => {
      throw new Error('磁盘炸了')
    },
  })
  const watcher = createBackgroundUpdateWatcher({ library, logger: { error: (m) => errors.push(m) } })

  let result
  assert.doesNotThrow(() => {
    result = watcher.handleEvent({ id: 'bound' }, assistantEvent(block('主体: 沈某\n章: 3\n事实: 甲')))
  })
  assert.equal(result, null)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /磁盘炸了/)
})

//#endregion

//#region 接线与端到端

test('接线：守则里确实带着第 8 条，而且用的就是解析器认的那个格式', () => {
  const policy = renderPolicy('测试书', { webGate: 'block-all' })
  assert.ok(policy.includes(renderUpdateInstruction()), '守则里必须逐字包含那段格式说明')
  assert.ok(policy.includes('drc-update'))
})

test('接线：session/event 订阅真的注册了（假 ctx 会断言，这里再显式钉一次）', async () => {
  const dir = makeDir('bgwire')
  const server = await startServer(dir)
  try {
    assert.ok((server.listeners.get('session/event')?.size ?? 0) > 0)
  } finally {
    await server.close()
  }
})

test('端到端：一条事件真的写进 background.md，而且没有谎报覆盖', async () => {
  const dir = makeDir('bge2e')
  const server = await startServer(dir)
  try {
    const bookId = await importBook(server.base, dir)
    const sessionId = '0123456789abcdef'

    const bound = await call(`${server.base}/books/${bookId}/binding`, {
      method: 'PUT',
      body: { sessionId },
    })
    assert.equal(bound.status, 200, `绑定失败：${JSON.stringify(bound.body)}`)
    await call(`${server.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1 } })

    // 走真实那条路：事件 → 观察者 → 落盘。
    server.hooks.emit('session/event', { id: sessionId }, assistantEvent(
      `嗯，是我记错了。\n${block('节: 人物\n主体: 沈某\n章: 2\n事实: 他其实没死，是被救走了\n取代: 沈某已死')}`,
    ))

    const res = await call(`${server.base}/books/${bookId}/background`)
    assert.equal(res.status, 200)
    assert.match(res.body.markdown, /他其实没死/)
    assert.match(res.body.markdown, /第2章/, '条目必须带章号标记')
    assert.deepEqual(res.body.characters, ['沈某'])
    // ⚠️ 这一条是整条路径的安全性所在：内容进去了，覆盖区间**没有**跟着长出来。
    assert.equal(res.body.covered, null, '一条修正不该让文件声称有了覆盖')
  } finally {
    await server.close()
  }
})

//#endregion
