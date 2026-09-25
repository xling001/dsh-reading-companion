/**
 * 背景认识的**预算分配**与**压缩**。
 *
 * 两条主线：
 *
 * 1. **超预算时的降级**。旧版按整节丢弃，于是一旦某一节自己就吃满预算，其余
 *    会被整节丢掉，最后附一句"未提供：人物、世界观、前文脉络"——读起来像在说
 *    这本书没有人物。现在改成按权重分配 + 节内按"近期优先"丢，并写明丢了多少。
 *
 * 2. **压缩的安全校验**。压缩是"只增不减"唯一的例外，所以它必须过三道关：
 *    保名（人物一个都不能少）、保号（覆盖区间只能不变或变大）、真的变小。
 *    任何一条不过就**整批丢弃**——一次没压成只浪费一次调用；一次丢了人物的
 *    压缩是不可逆的记忆损失。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  needsCompaction,
  parseBackground,
  renderBackgroundForPrompt,
} from '../lib/host/background.js'
import { createCompactor, validateCompaction } from '../lib/host/compact.js'
import { createSubagentRunner } from '../lib/host/subagent-run.js'
import { createLibrary } from '../lib/host/library.js'
import { BOOK, call, importBook, makeDir, startServer } from './helpers/server.mjs'

/** 造一份背景认识。 */
const docOf = (lines) => parseBackground(lines.join('\n'))

//#region 预算分配

test('预算充足时**一节都不能少**（这是旧版最刺眼的一个 bug）', () => {
  // 旧版把分区标题漏在额度之外，渲染时又扣了一次标题长度，于是每节凭空少
  // 十来个字符——预算充足也会因为"一条短条目 + 标题"刚好越界而整节被丢，
  // 产出"未提供：人物关系、人物、世界观、前文脉络"这种自己打自己脸的输出。
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..3 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第2章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '## 世界观',
    '- `第1章` 江湖与魔教',
    '## 前文脉络',
    '- `第1-3章` 初遇',
  ])

  const out = renderBackgroundForPrompt(doc, { progressIndex: 3 })
  assert.deepEqual(out.omitted, [], '预算充足时不该丢任何一节')
  assert.deepEqual(out.trimmed, [], '也不该截断任何一节')
  assert.match(out.text, /甲 ↔ 乙/)
  assert.match(out.text, /### 甲/)
  assert.match(out.text, /江湖与魔教/)
  assert.match(out.text, /初遇/)
})

test('预算紧张时：人物关系优先保住，其余明说丢了多少', () => {
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..9 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：很重要（`第2章`）',
    '## 前文脉络',
    `- \`第1-9章\` ${'很长'.repeat(300)}`,
  ])

  const out = renderBackgroundForPrompt(doc, { budgetChars: 400, progressIndex: 9 })
  assert.match(out.text, /甲 ↔ 乙/, '人物关系是点名的重点')
  assert.ok(
    out.omitted.includes('前文脉络') || out.trimmed.some((item) => item.name === '前文脉络'),
    '前文脉络要被降级',
  )
})

test('节内截断：保留近期条目，并写明还剩几条没展示', () => {
  const entries = Array.from({ length: 40 }, (_, i) => `- \`第${i + 1}章\` ${'内容'.repeat(6)}`)
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..40 -->',
    '## 前文脉络',
    ...entries,
  ])

  const out = renderBackgroundForPrompt(doc, { budgetChars: 800, progressIndex: 40 })
  assert.equal(out.trimmed.length, 1, '应当报出被截断的分区')
  assert.equal(out.trimmed[0].name, '前文脉络')
  assert.ok(out.trimmed[0].dropped > 0)
  assert.equal(out.trimmed[0].shown + out.trimmed[0].dropped, out.trimmed[0].total)
  // 丢掉多少必须写在文本里——否则模型会以为"没提到的就是不存在"。
  assert.match(out.text, /另有 \d+ 条脉络未在此展示/)
  // 近期的优先：最后一条（第40章）一定在。
  assert.match(out.text, /第40章/)
})

test('节内截断：人物以"位"为单位取舍，不会把某个人截成半条', () => {
  const characters = Array.from({ length: 30 }, (_, i) => [`### 人物${i}`, `- \`第${i + 1}章\` ${'描述'.repeat(8)}`]).flat()
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..30 -->',
    '## 人物',
    ...characters,
  ])

  const out = renderBackgroundForPrompt(doc, { budgetChars: 700, progressIndex: 30 })
  assert.equal(out.trimmed.length, 1)
  assert.match(out.text, /另有 \d+ 位人物未在此展示/)

  // 每一位出现的人物都必须带着他名下的条目，不能只有 `### 名字`。
  // ⚠️ 得把分区标题 `### 人物` 本身排除掉——它是分区标题，不是人名。
  const names = [...out.text.matchAll(/^### (.+)$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== '人物')
  assert.ok(names.length > 0, '预算足够时应当至少留下一位人物')
  for (const name of names) {
    const after = out.text.slice(out.text.indexOf(`### ${name}`))
    const nextHeading = after.indexOf('\n### ', 1)
    const block = nextHeading === -1 ? after : after.slice(0, nextHeading)
    assert.match(block, /\n- /, `${name} 名下一条都没有，等于留了个空壳`)
  }
})

test('没有任何认识时给一句明确说明，而不是空白', () => {
  const out = renderBackgroundForPrompt(parseBackground(''), { progressIndex: 0 })
  assert.match(out.text, /还没有建立/)
  assert.deepEqual(out.omitted, [])
})

//#endregion

//#region 该不该压缩

test('该不该压缩：判据用**不设预算**的完整用量，而不是被截断后的用量', () => {
  // 用实际渲染结果判断会形成自我实现的循环：超预算 → 被截断 → 看起来不大 →
  // 永远不触发压缩。
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..5 -->',
    '## 前文脉络',
    `- \`第1-5章\` ${'很长的内容'.repeat(80)}`,
  ])

  const over = needsCompaction(doc, { budgetChars: 300, threshold: 0.5 })
  assert.equal(over.over, true)
  assert.ok(over.fullChars > 300, 'fullChars 必须是完整体量')

  const notOver = needsCompaction(doc, { budgetChars: 100000, threshold: 0.85 })
  assert.equal(notOver.over, false)
})

test('该不该压缩：阈值被夹在 0.1–1，配置写飞了也不会失控', () => {
  const doc = docOf(['<!-- drc-background: schema=1 covered=1..3 -->', '## 世界观', '- 一句话'])
  assert.equal(needsCompaction(doc, { budgetChars: 100, threshold: 99 }).over, false)
  assert.equal(needsCompaction(doc, { budgetChars: 100, threshold: -5 }).over, true)
})

//#endregion

//#region 安全校验

/** 一份压缩前的认识：两位人物、覆盖到第 10 章。 */
const BEFORE = docOf([
  '<!-- drc-background: schema=1 covered=1..10 -->',
  '## 人物关系',
  '- 甲 ↔ 乙：对手（`第2章`）',
  '## 人物',
  '### 甲',
  '- `第1章` 身份未明',
  '- `第5章` 立场转变',
  '### 乙',
  '- `第3章` 初登场',
  '## 世界观',
  '- `第1章` 江湖与魔教',
])

test('校验：正常压缩通过，并报出省了多少', () => {
  const after = docOf([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第2章`）',
    '## 人物',
    '### 甲',
    '- `第1-5章` 身份未明后立场转变',
    '### 乙',
    '- `第3章` 初登场',
  ])

  const verdict = validateCompaction(BEFORE, after)
  assert.equal(verdict.ok, true)
  assert.ok(verdict.savedChars > 0)
  assert.ok(verdict.afterChars < verdict.beforeChars)
})

test('校验：丢了人物 → 整批丢弃（这是最不可接受的一种）', () => {
  const after = docOf([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物',
    '### 甲',
    '- `第1-5章` 身份未明后立场转变',
  ])

  const verdict = validateCompaction(BEFORE, after)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /^COMPACT_LOST_CHARACTERS/)
  assert.match(verdict.reason, /乙/, '要说出丢的是谁，用户才知道怎么补救')
})

test('校验：覆盖区间被改小 → 整批丢弃（那等于凭空忘掉一段前文）', () => {
  const after = docOf([
    '<!-- drc-background: schema=1 covered=1..4 -->',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '### 乙',
    '- `第3章` 初登场',
  ])

  const verdict = validateCompaction(BEFORE, after)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'COMPACT_SHRANK_COVERAGE')
})

test('校验：覆盖区间整个没了 → 整批丢弃', () => {
  const after = docOf([
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '### 乙',
    '- `第3章` 初登场',
  ])
  assert.equal(validateCompaction(BEFORE, after).reason, 'COMPACT_LOST_COVERAGE')
})

test('校验：没变小 → 整批丢弃（否则会陷入压缩→没效果→再压缩的循环）', () => {
  const verdict = validateCompaction(BEFORE, BEFORE)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'COMPACT_NO_SHRINK')
  assert.equal(verdict.beforeChars, verdict.afterChars)
})

test('校验：覆盖区间变大是允许的（合并了别处的内容时）', () => {
  const after = docOf([
    '<!-- drc-background: schema=1 covered=1..12 -->',
    '## 人物',
    '### 甲',
    '- `第1-5章` 身份未明后立场转变',
    '### 乙',
    '- `第3章` 初登场',
  ])
  assert.equal(validateCompaction(BEFORE, after).ok, true)
})

//#endregion

//#region 压缩器

test('压缩器：把模型输出解析并校验后返回，且不问联网', async () => {
  const calls = []
  const compactor = createCompactor({
    startRun: async (spec) => {
      calls.push(spec)
      return {
        output: [{
          type: 'text',
          text: [
            '<!-- drc-background: schema=1 covered=1..10 -->',
            '## 人物',
            '### 甲',
            '- `第1-5章` 身份未明后立场转变',
            '### 乙',
            '- `第3章` 初登场',
          ].join('\n'),
        }],
      }
    },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => ({ start: async () => { throw new Error('不该走到这里') } }),
    logger: {},
  })

  const result = await compactor({
    sessionId: 's1',
    bookTitle: '测试书',
    markdown: '原文',
    doc: BEFORE,
    targetChars: 100,
  })

  assert.equal(result.ok, true)
  assert.ok(result.savedChars > 0)
  assert.equal(calls.length, 1)
  // 压缩**不需要联网**：材料全在手上，联网只会引进外部信息。
  assert.deepEqual(calls[0].toolFilter, { allow: [] })
})

test('压缩器：校验不过时回失败，且**不**返回任何可落盘的东西', async () => {
  const compactor = createCompactor({
    startRun: async () => ({
      // 只留了一位人物 —— 必须被拦下。
      output: [{ type: 'text', text: '<!-- drc-background: schema=1 covered=1..10 -->\n## 人物\n### 甲\n- `第1章` 身份未明' }],
    }),
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })

  const result = await compactor({ sessionId: 's1', bookTitle: '测试书', markdown: 'x', doc: BEFORE })
  assert.equal(result.ok, false)
  assert.match(result.reason, /COMPACT_LOST_CHARACTERS/)
  assert.equal(result.parsed, undefined, '校验没过就绝不能给出可落盘的结果')
})

test('压缩器：空背景直接拒绝，不白花一次调用', async () => {
  let started = 0
  const compactor = createCompactor({
    startRun: async () => { started += 1; return { output: [] } },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  const result = await compactor({ sessionId: 's1', bookTitle: 'x', markdown: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'NO_BACKGROUND')
  assert.equal(started, 0)
})

//#endregion

//#region 共用机制：超时

test('机制：超时必须靠 race 兜住，不能只 abort —— 否则会永远挂着', async () => {
  // 宿主若卡在一个不响应取消的等待上，只 `controller.abort()` 是没用的：
  // AbortSignal 只是一个信号，它不会替我们结束 promise。第一版就是这样，
  // 被超时用例当场抓出来（测试跑满 120 秒）。
  const runner = createSubagentRunner({
    timeoutMs: 40,
    startRun: () => new Promise(() => {}),   // 永远不 resolve，且无视 signal
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })

  const startedAt = Date.now()
  const result = await runner({ sessionId: 's1', label: 'x', prompt: 'p', persona: 'persona' })
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'TIMEOUT')
  assert.ok(elapsed < 5000, `应当很快返回，实际用了 ${elapsed}ms`)
})

test('机制：没有活 Agent 时报可预期的状态，而不是错误', async () => {
  const runner = createSubagentRunner({
    startRun: async () => ({ output: [] }),
    getAgent: () => undefined,
    getSubagents: () => undefined,
    logger: {},
  })
  assert.equal((await runner({ sessionId: 's1', label: 'x', prompt: 'p', persona: 'z' })).reason, 'NO_LIVE_PARENT')
})

test('机制：宿主没有子代理服务时报 SUBAGENTS_UNAVAILABLE', async () => {
  const runner = createSubagentRunner({
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  assert.equal((await runner({ sessionId: 's1', label: 'x', prompt: 'p', persona: 'z' })).reason, 'SUBAGENTS_UNAVAILABLE')
})

test('机制：先查环境能力，再查会话状态——顺序反了会给出**无法执行**的建议', async () => {
  // 这台机器既没有子代理服务，这个会话也没有活 Agent。该报哪一个？
  // 报"宿主没装子代理"才是对的：那是**部署事实**，用户做任何事都改不了它。
  // 反过来的话，用户会看到"先在会话里说一句话"，照做之后仍然失败，
  // 而且永远不知道该去改配置。
  const runner = createSubagentRunner({
    getAgent: () => undefined,
    getSubagents: () => undefined,
    logger: {},
  })
  assert.equal((await runner({ sessionId: 's1', label: 'x', prompt: 'p', persona: 'z' })).reason, 'SUBAGENTS_UNAVAILABLE')
})

test('机制：顺序在**语义**上也必须成立——查父 Agent 本身是会抛错的', async () => {
  // 上一条测试只是"先调用了谁"，而**语义**差异在这里：如果先查父 Agent，
  // 它抛错（宿主没有 `agents` 服务、或服务正在抖）就会把结论变成
  // PARENT_LOOKUP_FAILED——而那是一条**用户无法执行**的建议（"去查父会话"）。
  // 环境能力是更强的约束：它不成立时，后面查什么都是白查。
  const runner = createSubagentRunner({
    getAgent: () => { throw new Error('agents 服务不可用') },
    getSubagents: () => undefined,
    logger: {},
  })
  assert.equal(
    (await runner({ sessionId: 's1', label: 'x', prompt: 'p', persona: 'z' })).reason,
    'SUBAGENTS_UNAVAILABLE',
    '环境能力不成立时，不该因为父 Agent 查询失败而改口',
  )
})

test('机制：注入了自己的 startRun 时，不该被"没有 subagents 服务"挡住', async () => {
  // 单测就是这么用的，生产里也是"宿主装了但服务名不同"时的降级口子。
  const runner = createSubagentRunner({
    startRun: async () => ({ output: [{ type: 'text', text: '好的' }] }),
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  assert.equal((await runner({ sessionId: 's1', label: 'x', prompt: 'p', persona: 'z' })).ok, true)
})

test('机制：允许联网时给白名单；宿主不认识这些工具名就退化成无工具（而不是整批失败）', async () => {
  const seen = []
  let attempt = 0
  const runner = createSubagentRunner({
    startRun: async (spec) => {
      seen.push(spec.toolFilter)
      attempt += 1
      if (attempt === 1) throw new Error('unknown global tool: web_search')
      return { output: [{ type: 'text', text: '好的' }] }
    },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })

  const result = await runner({ sessionId: 's1', label: 'x', prompt: 'p', persona: 'z', allowWeb: true })
  assert.equal(result.ok, true)
  assert.deepEqual(seen[0], { allow: ['web_search', 'web_fetch'] })
  assert.deepEqual(seen[1], { allow: [] }, '退化后必须真的无工具')
})

//#endregion

//#region 书库层：备份与落盘

test('书库：压缩会留一份备份，内容是压缩前的原文', () => {
  const storageDir = makeDir('compact-lib')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: 'x' })

  library.backgroundMerge(book.bookId, parseBackground([
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '- `第5章` 立场转变',
    '### 乙',
    '- `第3章` 初登场',
  ].join('\n')), { first: 1, last: 5 })

  const beforeMarkdown = library.background(book.bookId).markdown
  const compacted = parseBackground([
    '<!-- drc-background: schema=1 covered=1..5 -->',
    '## 人物',
    '### 甲',
    '- `第1-5章` 身份未明后立场转变',
    '### 乙',
    '- `第3章` 初登场',
  ].join('\n'))

  const written = library.backgroundCompact(book.bookId, compacted)
  assert.ok(written.backupPath !== null, '应当留下备份路径')
  assert.equal(existsSync(written.backupPath), true)
  assert.equal(readFileSync(written.backupPath, 'utf8'), beforeMarkdown)

  // 压缩后的内容真的落盘了。
  assert.match(readFileSync(library.backgroundPath(book.bookId), 'utf8'), /第1-5章/)
})

test('书库：还没有背景认识时不造空备份（那只会让人困惑）', () => {
  const storageDir = makeDir('compact-nobackup')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: 'x' })

  // 先让 artifactPath 建出目录与标记，但**不**写 background.md。
  library.location(book.bookId)
  const written = library.backgroundCompact(book.bookId, parseBackground('<!-- drc-background: schema=1 covered=1..2 -->\n## 世界观\n- `第1章` 一句'))
  assert.equal(written.backupPath, null)
})

//#endregion

//#region 压缩失败的人话

test('压缩：没有绑定会话时明确拒绝，不谈压缩', async () => {
  const dir = makeDir('compact-http-nosession')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    const res = await call(`${s.base}/books/${bookId}/background/compact`, { method: 'POST', body: {} })
    assert.equal(res.status, 400)
    assert.match(res.body.message, /还没有绑定会话/)
  } finally {
    await s.close()
  }
})

test('压缩：没有子代理服务时回 501 并且说清"文件没动"', async () => {
  const dir = makeDir('compact-http-nosub')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-x' } })
    const res = await call(`${s.base}/books/${bookId}/background/compact`, { method: 'POST', body: {} })
    assert.equal(res.status, 501)
    assert.match(res.body.message, /子代理/)
  } finally {
    await s.close()
  }
})

test('自动压缩：补齐时背景太胖会先压一次，并把结果如实回报', async () => {
  // 假子代理：按 label 分辨这是"整理记忆"还是"压缩"。
  const big = [
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第1章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '- `第2章` 立场转变',
    '### 乙',
    '- `第1章` 初登场',
    '## 世界观',
    `- \`第1章\` ${'设定'.repeat(60)}`,
  ].join('\n')

  const compacted = [
    '<!-- drc-background: schema=1 covered=1..2 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第1章`）',
    '## 人物',
    '### 甲',
    '- `第1-2章` 身份未明后立场转变',
    '### 乙',
    '- `第1章` 初登场',
  ].join('\n')

  const labels = []
  const fakeSubagents = {
    start: async (kind, spec) => {
      labels.push(spec.label)
      const text = String(spec.label).includes(':compact') ? compacted : big
      return { result: Promise.resolve({ output: [{ type: 'text', text }] }), dispose: async () => {} }
    },
  }
  const fakeAgents = { get: () => ({ id: 'parent' }) }

  const dir = makeDir('compact-auto')
  // 预算调小，让"胖"这件事容易触发。
  const s = await startServer(dir, {
    subagents: fakeSubagents,
    agents: fakeAgents,
    config: { window: { backgroundBudgetChars: 300, compactThreshold: 0.5 } },
  })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-auto' } })

    // 第一次补齐：起点是空的，所以不会压缩，只会把认识建起来。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    const first = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })
    assert.equal(first.status, 200)
    assert.equal(first.body.compact, null, '空背景没什么可压的')
    assert.equal(first.body.covered.last, 1)
    assert.ok(!labels.some((label) => label.includes(':compact')), '第一次不该压缩')

    // 第二次：背景已经胖了 → 先压缩，再合并新的一段。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 0 } })
    const second = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })
    assert.equal(second.status, 200)
    assert.equal(second.body.compact?.ok, true, `压缩应当成功：${JSON.stringify(second.body.compact)}`)
    assert.ok(second.body.compact.savedChars > 0)
    assert.ok(second.body.compact.backupPath !== null, '压缩前必须留备份')
    assert.equal(existsSync(second.body.compact.backupPath), true)

    // 压缩之后，两位人物都还在——这正是安全校验要保的东西。
    const bg = await call(`${s.base}/books/${bookId}/background`)
    assert.match(bg.body.markdown, /### 甲/)
    assert.match(bg.body.markdown, /### 乙/)
    assert.deepEqual(bg.body.characters.sort(), ['乙', '甲'])
    assert.equal(bg.body.covered.last, 2, '合并后覆盖区间推到了第 2 章')
  } finally {
    await s.close()
  }
})

test('自动压缩：压缩失败**不阻断**补齐——记忆该长还得长', async () => {
  const big = `## 人物关系\n- 甲 ↔ 乙：对手（\`第1章\`）\n## 人物\n### 甲\n- \`第1章\` 身份未明\n## 世界观\n- \`第1章\` ${'设定'.repeat(80)}`

  const fakeSubagents = {
    start: async (kind, spec) => {
      // 压缩那一次故意丢掉一位人物 —— 安全校验必须拦下它。
      const text = String(spec.label).includes(':compact')
        ? '<!-- drc-background: schema=1 covered=1..2 -->\n## 人物\n### 丙\n- `第1章` 换了个人'
        : big
      return { result: Promise.resolve({ output: [{ type: 'text', text }] }), dispose: async () => {} }
    },
  }

  const dir = makeDir('compact-auto-fail')
  const s = await startServer(dir, {
    subagents: fakeSubagents,
    agents: { get: () => ({ id: 'parent' }) },
    config: { window: { backgroundBudgetChars: 300, compactThreshold: 0.5 } },
  })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-a' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    assert.equal(res.status, 200, '压缩失败不该让补齐一起失败')
    assert.equal(res.body.compact.ok, false)
    assert.match(res.body.compact.reason, /COMPACT_LOST_CHARACTERS/)
    // 关键：原文件没被那次糟糕的压缩覆盖。甲还在。
    const bg = await call(`${s.base}/books/${bookId}/background`)
    assert.match(bg.body.markdown, /### 甲/)
    assert.equal(bg.body.covered.last, 2, '补齐照常推进了水位线')
  } finally {
    await s.close()
  }
})

//#region T4：压缩失败与水位的交互

/**
 * 这一组治的是同一个形状：**压缩排在合并之前，而水位线随合并写入**。
 * `dsh-adaptive-context` 实测踩过它——压缩侧连续失败 24 批，水位线永不推进。
 *
 * 两个方向都要防：
 *   - 压缩**抛异常**时若挡住合并 → 水位线永不推进（每次重试都再抛一次）= **卡死**；
 *   - 压缩**成功**、合并失败时若压缩已落盘 → 内容少了、缺口还在 = **净损失**。
 */

/** 一份够胖的背景认识（用于触发自动压缩）。 */
const FAT = [
  '## 人物关系',
  '- 甲 ↔ 乙：对手（`第1章`）',
  '## 人物',
  '### 甲',
  '- `第1章` 身份未明',
  '- `第1章` 立场转变',
  '### 乙',
  '- `第1章` 初登场',
  '## 世界观',
  `- \`第1章\` ${'设定'.repeat(60)}`,
].join('\n')

test('T4：压缩侧**传输失败**也不能挡住补齐——那是"水位线永不推进"的形状', async () => {
  // ⚠️ 这条用例的**机制**要说准（第一版我写错了）：子代理的 `start` 抛异常时，
  // `createSubagentRunner` 自己会把它转成 `{ok:false, reason:'FAILED: …'}`，
  // 所以补压那条 `try/catch`（防的是 `compactor` 直接抛）**在这条路径上并不会
  // 被触发**。这里真正验证的是 T4 那条不变式本身：
  // **压缩怎么坏（传输层坏、校验层坏），都不能让水位线停住。**
  const fakeSubagents = {
    start: async (kind, spec) => {
      if (String(spec.label).includes(':compact')) throw new Error('模拟压缩器崩了')
      return { result: Promise.resolve({ output: [{ type: 'text', text: FAT }] }), dispose: async () => {} }
    },
  }

  const dir = makeDir('compact-throw')
  const s = await startServer(dir, {
    subagents: fakeSubagents,
    agents: { get: () => ({ id: 'parent' }) },
    config: { window: { backgroundBudgetChars: 300, compactThreshold: 0.5 } },
  })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-throw' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    assert.equal(res.status, 200, '压缩侧崩了不该让补齐一起失败')
    assert.equal(res.body.compact.ok, false)
    // 失败原因是**原样的**，不是一句没信息量的"压缩失败"——否则读者无从判断
    // 该重试还是该改配置。
    assert.match(res.body.compact.reason, /FAILED/)
    const bg = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(bg.body.covered.last, 2, '水位线必须照常推进——否则每次重试都会再崩一次，永远卡住')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T4：压缩成功但合并失败时，压缩**不落盘**——不为零进展付不可逆的代价', async () => {
  const compacted = [
    '<!-- drc-background: schema=1 covered=1..1 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第1章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明后立场转变',
    '### 乙',
    '- `第1章` 初登场',
    '## 世界观',
    `- \`第1章\` ${'设定'.repeat(20)}`,
  ].join('\n')

  let memoryCalls = 0
  const fakeSubagents = {
    start: async (kind, spec) => {
      if (String(spec.label).includes(':compact')) {
        return { result: Promise.resolve({ output: [{ type: 'text', text: compacted }] }), dispose: async () => {} }
      }
      memoryCalls += 1
      // 第一次补齐照常成功（先把背景建起来），第二次故意给一段解析不出东西的
      // 输出 —— 于是"压缩成功了，但合并失败了"这个组合真的发生。
      const text = memoryCalls === 1 ? FAT : '好的，我明白了。'
      return { result: Promise.resolve({ output: [{ type: 'text', text }] }), dispose: async () => {} }
    },
  }

  const dir = makeDir('compact-merge-fail')
  const s = await startServer(dir, {
    subagents: fakeSubagents,
    agents: { get: () => ({ id: 'parent' }) },
    config: { window: { backgroundBudgetChars: 300, compactThreshold: 0.5 } },
  })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-mf' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    assert.notEqual(res.status, 200, '合并失败必须如实失败')
    assert.equal(res.body.compact.ok, true, '压缩这一趟本身是成功的')
    assert.equal(res.body.compact.persisted, false, '但它**没有**落盘——这是这条用例的全部意义')

    // 文件必须还是**压缩前**那份：合并前的两条记载原样在，且没有出现压缩后
    // 才有的合并写法。若这里换成压缩版，读者就白白丢了一次细节而没换来任何进展。
    const bg = await call(`${s.base}/books/${bookId}/background`)
    assert.match(bg.body.markdown, /`第1章` 立场转变/, '压缩前才有的分开记载必须还在')
    assert.doesNotMatch(bg.body.markdown, /身份未明后立场转变/, '压缩版不能已经落盘')
    assert.equal(bg.body.covered.last, 1, '水位线不动')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T4：没有缺口时，压缩就是唯一成果——它该落盘，而且明确报告 skipped', async () => {
  const compacted = [
    '<!-- drc-background: schema=1 covered=1..1 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第1章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明后立场转变',
    '### 乙',
    '- `第1章` 初登场',
    '## 世界观',
    `- \`第1章\` ${'设定'.repeat(20)}`,
  ].join('\n')

  const fakeSubagents = {
    start: async (kind, spec) => {
      const text = String(spec.label).includes(':compact') ? compacted : FAT
      return { result: Promise.resolve({ output: [{ type: 'text', text }] }), dispose: async () => {} }
    },
  }

  const dir = makeDir('compact-no-gap')
  const s = await startServer(dir, {
    subagents: fakeSubagents,
    agents: { get: () => ({ id: 'parent' }) },
    config: { window: { backgroundBudgetChars: 300, compactThreshold: 0.5 } },
  })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-ng' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    // 进度不动 → 没有缺口。压缩仍然该发生（文件还是胖的），而这一次它后面
    // **没有**任何会失败的步骤压着，所以可以安全落盘。
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.body.skipped, true, '没有缺口要如实说 skipped')
    assert.equal(res.body.compact?.ok, true)
    assert.equal(res.body.compact.persisted, true, '没有后续失败步骤时应当落盘')
    assert.ok(res.body.compact.backupPath !== null, '落盘前必须留备份')

    const bg = await call(`${s.base}/books/${bookId}/background`)
    assert.match(bg.body.markdown, /身份未明后立场转变/, '压缩版这次应当真的写下去了')
    assert.match(bg.body.markdown, /### 甲/, '保名仍然成立')
    assert.match(bg.body.markdown, /### 乙/)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T4：压缩与合并共用**那一次写入**——内容、备份、覆盖区间一起生效', async () => {
  // ⚠️ 这条用例是被一次变异逼出来的，值得记下来：上面那条"自动压缩：背景太胖会
  // 先压一次"**其实走的是"没有缺口"那条分支**——因为它的假压缩结果头部写着
  // `covered=1..2`，而进度正好是第 2 章，于是 `backgroundGap` 判定无缺口，压缩
  // 走的是 `backgroundCompact` 那条路。也就是说"压缩成功 **且** 合并成功"这条最
  // 常见的组合此前**一次都没被测过**：备份带没带（M2 逃逸）、合并到底用的是压缩
  // 后的底稿还是盘上那份（M4 逃逸），两条都无人守卫。
  const compacted = [
    '<!-- drc-background: schema=1 covered=1..1 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第1章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明后立场转变',
    '### 乙',
    '- `第1章` 初登场',
    '## 世界观',
    `- \`第1章\` ${'设定'.repeat(20)}`,
  ].join('\n')

  const fresh = [
    '## 人物',
    '### 甲',
    '- `第2章` 拿到了关键线索',
  ].join('\n')

  let memoryCalls = 0
  const fakeSubagents = {
    start: async (kind, spec) => {
      const label = String(spec.label)
      if (label.includes(':compact')) {
        return { result: Promise.resolve({ output: [{ type: 'text', text: compacted }] }), dispose: async () => {} }
      }
      memoryCalls += 1
      return {
        result: Promise.resolve({ output: [{ type: 'text', text: memoryCalls === 1 ? FAT : fresh }] }),
        dispose: async () => {},
      }
    },
  }

  const dir = makeDir('compact-merge-ok')
  const s = await startServer(dir, {
    subagents: fakeSubagents,
    agents: { get: () => ({ id: 'parent' }) },
    config: { window: { backgroundBudgetChars: 300, compactThreshold: 0.5 } },
  })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-mok' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    // 进度推到最后一章（这本夹具只有三章，进度会被夹到第 3 章）：缺口是第 2 章，
    // 而压缩结果只声称覆盖到第 1 章 → **走合并那条路**（这才是这条用例的目的）。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 3, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.compact?.ok, true)
    assert.equal(res.body.compact.persisted, true, '合并成功 → 压缩与合并一起生效')
    assert.equal(res.body.skipped, false, '这一趟必须真的走了合并，不能又是"没有缺口"那条分支')

    // ① 备份必须带（压缩是唯一会删内容的一步，落盘前要留后路）。
    assert.ok(res.body.compact.backupPath !== null, '共用一次写入时也必须先备份')
    assert.equal(existsSync(res.body.compact.backupPath), true)

    const bg = await call(`${s.base}/books/${bookId}/background`)
    // ② 合并用的底稿必须是**压缩后的那份**，不是盘上那份。这一条专治 M4：
    //    忽略 `base` 时，文件里会是压缩前那两条分开的记载。
    assert.match(bg.body.markdown, /身份未明后立场转变/, '合并必须以压缩结果为底稿')
    assert.doesNotMatch(bg.body.markdown, /`第1章` 立场转变/, '压缩前那两条不应再各自成条')
    // ③ 这一批的新内容也要在，覆盖区间推到第 2 章。
    assert.match(bg.body.markdown, /第2章` 拿到了关键线索/)
    assert.equal(bg.body.covered.last, 2, JSON.stringify({ fill: res.body, covered: bg.body.covered }))
    // ④ 保名仍然成立（压缩的四条硬约束之一）。
    assert.match(bg.body.markdown, /### 甲/)
    assert.match(bg.body.markdown, /### 乙/)

    // ⑤ 备份里是**压缩前**的原文——留后路的意思就是这一条。
    const backup = readFileSync(res.body.compact.backupPath, 'utf8')
    assert.match(backup, /`第1章` 立场转变/)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

//#endregion
