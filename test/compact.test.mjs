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
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  isGroupedSection,
  needsCompaction,
  parseBackground,
  renderBackgroundForPrompt,
} from '../lib/host/background.js'
import { buildCompactPrompt, COMPRESSIBLE_SECTIONS, createCompactor, renderOneSectionMarkdown, validateCompaction } from '../lib/host/compact.js'
import { createSubagentRunner } from '../lib/host/subagent-run.js'
import { createLibrary } from '../lib/host/library.js'
import { BOOK, call, importBook, makeDir, startServer } from './helpers/server.mjs'

/** 造一份背景认识。 */
const docOf = (lines) => parseBackground(lines.join('\n'))

//#region 预算分配

test('预算充足时**一节都不能少**（这是旧版最刺眼的一个 bug）', () => {  // 旧版把分区标题漏在额度之外，渲染时又扣了一次标题长度，于是每节凭空少
  // 十来个字符——预算充足也会因为"一条短条目 + 标题"刚好越界而整节被丢，
  // 产出"未提供：人物关系、人物、世界观"这种自己打自己脸的输出。
  //（⚠️ 3.0：「前文脉络」并入「时间与分线」 ⇒ 不再注入 —— 夹具里的那一行删掉。）
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..3 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第2章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '## 世界观',
    '- `第1章` 江湖与魔教',
  ])

  const out = renderBackgroundForPrompt(doc, { progressIndex: 3 })
  assert.deepEqual(out.omitted, [], '预算充足时不该丢任何一节')
  assert.deepEqual(out.trimmed, [], '也不该截断任何一节')
  assert.match(out.text, /甲 ↔ 乙/)
  assert.match(out.text, /### 甲/)
  assert.match(out.text, /江湖与魔教/)
})

test('预算紧张时：人物关系优先保住，其余明说丢了多少', () => {
  //（3.0：「前文脉络」不再注入；"被降级"的演示换「世界观」——同样是最重的下一节。）
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..9 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：很重要（`第2章`）',
    '## 世界观',
    `- \`第1-9章\` ${'很长'.repeat(300)}`,
  ])

  const out = renderBackgroundForPrompt(doc, { budgetChars: 400, progressIndex: 9 })
  assert.match(out.text, /甲 ↔ 乙/, '人物关系是注入里第一个被保住的分区（裁剪优先级最高）')
  assert.ok(
    out.omitted.includes('世界观') || out.trimmed.some((item) => item.name === '世界观'),
    '世界观（最重的下一节）要被降级',
  )
})

test('节内截断：保留近期条目，并写明还剩几条没展示', () => {
  const entries = Array.from({ length: 40 }, (_, i) => `- \`第${i + 1}章\` ${'内容'.repeat(6)}`)
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..40 -->',
    '## 世界观',
    ...entries,
  ])

  const out = renderBackgroundForPrompt(doc, { budgetChars: 800, progressIndex: 40 })
  assert.equal(out.trimmed.length, 1, '应当报出被截断的分区')
  assert.equal(out.trimmed[0].name, '世界观')
  assert.ok(out.trimmed[0].dropped > 0)
  assert.equal(out.trimmed[0].shown + out.trimmed[0].dropped, out.trimmed[0].total)
  // 丢掉多少必须写在文本里——否则模型会以为"没提到的就是不存在"。
  assert.match(out.text, /另有 \d+ 条设定未在此展示/)
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
    '## 世界观',
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

test('压缩提示词（3.0 分节作业）：每节只看自己的尺子，共用原则每一遍都要带', () => {
  // ⚠️ 2026-10-01 读者问"压缩时是否每个条目压缩程度和方法不同"。3.0 起**物理隔离**：
  //    每节一次独立调用，提示词里只有它自己的尺子 —— 想串尺都串不了。
  const 人物 = buildCompactPrompt({ bookTitle: '测试书', section: '人物', sectionMarkdown: '## 人物\n### 甲\n- `第1章` 出场。' })
  const 关系 = buildCompactPrompt({ bookTitle: '测试书', section: '人物关系', sectionMarkdown: '## 人物关系\n- 甲 ↔ 乙：对手（`第2章`）。' })
  const 文风 = buildCompactPrompt({ bookTitle: '测试书', section: '文风（只写一次）', sectionMarkdown: '## 文风（只写一次）\n- 平实白描。' })

  assert.match(人物, /合并后一条 ≤40 字/, '「人物」拿自己的尺子')
  assert.match(人物, /别把整张卡并成一条长条目/, '「人物」不许并成整卡一条')
  assert.ok(!人物.includes('≤80 字'), '「人物」**拿不到**「人物关系」的尺子（分节作业 = 物理隔离）')
  assert.match(关系, /合并后一条 ≤80 字/, '「人物关系」拿自己的尺子')
  assert.match(关系, /保持分阶段的多条/, '并起来超长就保持分阶段的多条')
  assert.match(文风, /可以压得最狠/, '文风压得最狠')
  // ⚠️ 3.0：「前文脉络」并入「时间与分线」⇒ **不再是分节作业**（旧文件里的它由代码原样搬运）
  assert.ok(!COMPRESSIBLE_SECTIONS.includes('前文脉络'), '脉络不在作业清单里')
  for (const prompt of [人物, 关系, 文风]) {
    assert.match(prompt, /同一主体名下的多条 = 合并；不同主体之间 = 不许动/, '总原则每一遍都要带（每次调用都是独立上下文）')
    assert.match(prompt, /一个都不能少/, '主体保全每遍都要说')
  }
})

test('压缩：不许用"合出巨段 / 超长条"来达标（2026-10-02 真机实测暴露）', () => {
  // ⚠️ 读者手动压缩那次（第一份成功的 `background.bak`）：**练霓裳整张卡被并成一条 715 字的巨段**
  //    （而规则是"一段 ≤200 字"），人物关系从 19 条并成 8 条、平均 **162 字**（规则是"一条 ≤80 字"）。
  //    根因是当时这份提示词**只说"合并"、通篇没有任何长度上限** —— 而"分条/按阶段多条"是上一版故意设计的形态。
  //    3.0 的分节作业里，这些上限跟着**各自的节**走（上一条用例）。
  const 人物 = buildCompactPrompt({ bookTitle: '测试书', section: '人物', sectionMarkdown: '## 人物\n### 甲\n- `第1章` 出场。' })
  assert.match(人物, /合并后一条 ≤40 字/, '「人物」合并后仍受 40 字约束')
  assert.match(人物, /别把整张卡并成一条长条目/, '「人物」不许把整张卡并成一条')
  const 关系 = buildCompactPrompt({ bookTitle: '测试书', section: '人物关系', sectionMarkdown: '## 人物关系\n- 甲 ↔ 乙：对手（`第2章`）。' })
  assert.match(关系, /合并后一条 ≤80 字/, '「人物关系」合并后仍受 80 字约束')
  assert.match(人物, /宁可少合/, '总原则：宁可少合')
  assert.match(人物, /不许用"合出巨段\/超长条"来达标/, '不许用巨段达标')
})

test('校验：读者族被删 → 整批丢弃（它不进提示词，前两条口径都够不到它）', () => {
  // ⚠️ 这条守卫是 2026-10-01 三方评审的 P1 补的：`beforeChars/afterChars` 量的是
  //    **注入**六节（`renderBackgroundForPrompt` 只遍历 `BACKGROUND_INJECTED_SECTIONS`），
  //    而当时的「保主体」只跑注入族 ⇒ 压缩模型把整个「时间与分线」（含每个单元的
  //    `⭐ 影响`）删光，只要注入六节小了一点，这次压缩仍然判 `ok:true` 并落盘。
  //    而这一族**只有读者能重建**：AI 永远读不到它，也就永远纠不了它。
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明，且这一段特意写长一些好让"注入六节变小"有个真实的余地',
    '## 时间与分线',
    '### 主线',
    '- `第1-4年` 骨架：她还在渡口一带。',
    '### 【支线】无面谷 · 第5-9章',
    '- `第5章` 起：接任务入谷。',
    '- `第9章` 收：出谷。',
    '- ⭐ 影响：得《X 功法》。',
  ])

  // 注入六节**真的变小了** —— 所以 `COMPACT_NO_SHRINK` 不会顺手兜住这件事
  // （一次被接受的压缩，前提本来就是"注入六节变小了"）。
  const shrunk = docOf([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '## 时间与分线',
    '### 主线',
    '- `第1-4年` 骨架：她还在渡口一带。',
    '### 【支线】无面谷 · 第5-9章',
    '- `第5章` 起：接任务入谷。',
  ])

  const verdict = validateCompaction(before, shrunk)
  assert.equal(verdict.ok, false, '读者族丢了条目却判通过 —— 这一节只有读者能重建')
  assert.match(verdict.reason, /^COMPACT_LOST_READER_ENTRIES/)
  assert.match(verdict.reason, /时间与分线/, '要说出是哪一节丢了')

  // 反面：读者族**原样照抄**、只压注入六节 ⇒ 必须通过（否则这条守卫会挡住正常压缩）
  const untouched = docOf([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '## 时间与分线',
    '### 主线',
    '- `第1-4年` 骨架：她还在渡口一带。',
    '### 【支线】无面谷 · 第5-9章',
    '- `第5章` 起：接任务入谷。',
    '- `第9章` 收：出谷。',
    '- ⭐ 影响：得《X 功法》。',
  ])
  const pass = validateCompaction(before, untouched)
  assert.equal(pass.ok, true, `照抄读者族的压缩必须通过（实际：${pass.reason ?? ''}）`)
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

test('压缩器（3.0 分节）：按节调用，逐段解析并校验后返回，且不问联网', async () => {
  const calls = []
  // ⚠️ 3.0 分节作业：每个**非空**的可压缩节各得一次调用；各节的回执按节名给
  //    （真实模型就是"只回自己那一节"）。BEFORE 里的非空可压缩节 = 关系/人物/世界观。
  const canned = {
    //（⚠️ 各节的回执都要**不比素材长**，否则"关二：不许变大"会拦下 —— 那也是真实模型的验收口径）
    '人物关系': ['## 人物关系', '- 甲 ↔ 乙：结怨（`第2章`）'].join('\n'),
    '人物': ['## 人物', '### 甲', '- `第1-5章` 身份未明后立场转变', '### 乙', '- `第3章` 初登场'].join('\n'),
    '世界观': ['## 世界观', '- `第1章` 江湖与魔教'].join('\n'),
  }
  const compactor = createCompactor({
    startRun: async (spec) => {
      calls.push(spec)
      const section = String(spec.label).split(':').pop()
      return { output: [{ type: 'text', text: canned[section] ?? '' }] }
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

  assert.equal(result.ok, true, `分节作业应当全部通过：${JSON.stringify({ ok: result.ok, reason: result.reason })}`)
  assert.ok(result.savedChars > 0)
  assert.deepEqual(
    calls.map((spec) => String(spec.label).split(':').pop()),
    ['人物关系', '人物', '世界观'],
    '按文件节序逐节调用；空节（通用概念/文风/前文脉络）不调用',
  )
  // 压缩**不需要联网**：材料全在手上，联网只会引进外部信息。
  assert.deepEqual(calls[0].toolFilter, { allow: [] })
})

test('压缩器：校验不过时回失败，且**不**返回任何可落盘的东西', async () => {
  const compactor = createCompactor({
    startRun: async () => ({
      // 每次都只回了「人物」一节 —— 第一次按节来问「人物关系」，回执里**没有那一节**
      // ⇒ 逐节的"回执必须有这一节"必须拦下（不许静默把一节内容搬空）。
      output: [{ type: 'text', text: '## 人物\n### 甲\n- `第1章` 身份未明' }],
    }),
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })

  const result = await compactor({ sessionId: 's1', bookTitle: '测试书', markdown: 'x', doc: BEFORE })
  assert.equal(result.ok, false)
  assert.match(result.reason, /^COMPACT_SECTION_MISSING: 人物关系/, '回执缺节要按节拦（不丢内容、不留半成品）')
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

//#region 分节作业的行为守卫（3.0 ③b）

test('分节作业：一次调用只看到**一节**——大文件压 60k 字，单次提示词不超过一节的量级（天花板消失）', async () => {
  // ⚠️ 整份重写的死因 = "模型单次输出 32768 tokens" ⇒ 分节的每一种死法都来自
  //    "一次调用看到太多"。这里用一个大夹具证明：素材 60k 字，每次调用的提示词仍然小。
  const fat = [
    '## 人物关系',
    ...Array.from({ length: 120 }, (_, i) => `- 群众${i + 1} ↔ 甲：点头之交（\`第${i + 1}章\`），有过一面之缘。`),
    '## 人物',
    '### 甲',
    ...Array.from({ length: 40 }, (_, i) => `- \`第${i + 1}章\` 一步一步的经历，此处不值大书特书但也不能丢。`),
    //（⚠️ 3.0：「前文脉络」并入「时间与分线」不再压缩；大体积的例子换「世界观」。）
    '## 世界观',
    ...Array.from({ length: 100 }, (_, i) => `- \`第${i + 5}章\` 这段设定与规则的粗略记载。`),
  ].join('\n')
  const sizes = []
  const compactor = createCompactor({
    startRun: async (spec) => {
      sizes.push(spec.prompt.length)
      const section = String(spec.label).split(':').pop()
      // 回执 = 一小节压缩后的内容（人物是分组节 ⇒ 带上主体；另外两节是扁平节）
      const text = section === '人物'
        ? `## ${section}\n### 甲\n- \`第1-40章\` 平步成长的四十年。`
        : `## ${section}\n- \`第1章\` 压缩后的代表条目。`
      return { output: [{ type: 'text', text }] }
    },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  const result = await compactor({ sessionId: 's', bookTitle: '大书', markdown: fat, doc: parseBackground(fat), targetChars: 800 })
  // 每次提示词都 < 1.4 万字（素材 60k+ ⇒ 一次调用只拿一小片）；分节路径不会再有"整份重写"的输入。
  assert.ok(sizes.length >= 3, `应有多次分节调用：${sizes.length}`)
  assert.ok(
    sizes.every((size) => size < 14000),
    `每次调用只该看到一节（实际：${sizes.join('、')}）`,
  )
  assert.ok(result.ok === true || result.ok === false, '形状健全即可（回执是否达标由别的用例管）')
})

test('分节作业：一节**变大** ⇒ 整次压缩失败（模型写飞了不是压缩）', async () => {
  const before = parseBackground([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 世界观',
    '- `第1章` 江湖与魔教。',
  ].join('\n'))
  const compactor = createCompactor({
    startRun: async () => ({ output: [{ type: 'text', text: '## 世界观\n- `第1章` 江湖与魔教，还有一段模型自己发挥的、素材里没有的expanded描述，长得比原来长得多。' }] }),
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  const result = await compactor({ sessionId: 's', bookTitle: '书', markdown: 'x', doc: before })
  assert.equal(result.ok, false)
  assert.match(result.reason, /^COMPACT_SECTION_GREW: 世界观/)
  assert.equal(result.parsed, undefined)
})

test('分节作业：一节的调用**失败** ⇒ 整次压缩失败，且点名是哪一节', async () => {
  const before = parseBackground([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第2章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
  ].join('\n'))
  const compactor = createCompactor({
    // "人物"那一节的调用**永远不返回** ⇒ 配合 40ms 超时 ⇒ 变成 TIMEOUT；
    //（⚠️ 不能 return {ok:false, reason:'TIMEOUT'} —— startRun 的回执形状是 output，
    //    那样会被 runner 当成"空输出"。）
    timeoutMs: 40,
    startRun: async (spec) => {
      const section = String(spec.label).split(':').pop()
      if (section === '人物') return new Promise(() => {})
      return { output: [{ type: 'text', text: `## ${section}\n- \`第1章\` 原样。` }] }
    },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  const result = await compactor({ sessionId: 's', bookTitle: '书', markdown: 'x', doc: before })
  assert.equal(result.ok, false, `实际原因：${JSON.stringify(result.reason)}`)
  assert.match(result.reason, /^COMPACT_SECTION_FAILED: 人物 · TIMEOUT/, `失败要能定位到节与原因；实际 reason=${result.reason}`)
  assert.equal(result.parsed, undefined)
})

test('分节作业：一节的失败**重试一次** —— "没睡醒"不该让整次白跑（2026-10-02 真机形状）', async () => {
  // 真机形状：一次调用把 32768 输出全烧在推理里、正文 0 字（与"跑了多少子代理"无关）。
  // 处置与补齐同款：同一节**重试一次**；这里钉"第一次空输出 ⇒ 重试成功 ⇒ 整次成功"。
  let attemptsOnPerson = 0
  const before = parseBackground([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第2章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
  ].join('\n'))
  const compactor = createCompactor({
    startRun: async (spec) => {
      const section = String(spec.label).split(':').pop()
      if (section === '人物') {
        attemptsOnPerson += 1
        if (attemptsOnPerson === 1) return { output: [] }  // 第一次"没睡醒"（空输出）
        return { output: [{ type: 'text', text: '## 人物\n### 甲\n- `第1章` 身份未明。' }] }
      }
      return { output: [{ type: 'text', text: `## ${section}\n- \`第1章\` 原样。` }] }
    },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  const result = await compactor({ sessionId: 's', bookTitle: '书', markdown: 'x', doc: before })
  assert.equal(result.ok, true, `重试一次应该救回来：${JSON.stringify(result.reason ?? '')}`)
  assert.equal(attemptsOnPerson, 2, '同一节恰好两次调用（不多烧）')
  assert.equal(result.retriedSections.length, 1, '重试记录要如实带出来（少一层就静默失效）')
  const retried = result.retriedSections[0]
  assert.equal(retried.section, '人物', '要说清是哪一节重试过')
  assert.equal(retried.reason, 'EMPTY_OUTPUT', '要说清为什么重试（空输出 ≠ 部署故障）')
  assert.equal(retried.ok, true, '重试的**成绩**也要带上（重试成没成，界面要说得出）')
  // ⚠️ `wastedMs` 是**真实测得的**时长（`one.elapsedMs`），这里钉的是"是个非负毫秒数"：
  //    这个假 startRun 空跑一次通常 0ms、偶尔 1ms，写死 0 等于让守卫按运气红
  //    （2026-10-02 批 3 实测：同一份代码连跑 5 次红 2 次 —— 假红比不测更坏，
  //    它教人忽略红色）。"耗时含重试那趟、且两趟相加"的口径另有专测（P3-4 那条）。
  assert.ok(
    Number.isFinite(retried.wastedMs) && retried.wastedMs >= 0,
    `wastedMs 必须是个非负毫秒数，实际 ${JSON.stringify(retried.wastedMs)}`,
  )
})

test('分节作业：报出来的耗时**含重试那一趟**（2026-10-02 三方评审 P3-4）', async () => {
  // ⚠️ 从前 `elapsedTotal = Math.max(one.elapsedMs)`，只取**最终那一次** ⇒
  //    "某节重试过一次"时界面报的耗时**偏小**——而读者恰恰是靠这个数判断
  //    "这次为什么慢了一倍"。重试与正试是同一节串行发生的，所以是**相加**。
  const before = parseBackground([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：曾经是很好的朋友，后来因为门派的事闹翻了（`第2章`）',
  ].join('\n'))
  let attempts = 0
  const compactor = createCompactor({
    startRun: async (spec) => {
      const section = String(spec.label).split(':').pop()
      if (section === '人物关系') {
        attempts += 1
        await new Promise((resolve) => setTimeout(resolve, 30))
        if (attempts === 1) return { output: [] } // 第一次"没睡醒"（空输出）
        return { output: [{ type: 'text', text: '## 人物关系\n- 甲 ↔ 乙：朋友反目。' }] }
      }
      return { output: [{ type: 'text', text: `## ${section}\n- \`第1章\` 原样。` }] }
    },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  const result = await compactor({ sessionId: 's', bookTitle: '书', markdown: 'x', doc: before })
  assert.equal(result.ok, true, `应当重试成功：${JSON.stringify(result.reason ?? '')}`)
  assert.equal(attempts, 2, '前提：这一节确实重试过一次')
  assert.ok(
    result.elapsedMs >= 55,
    `耗时必须含重试那一趟（两趟各 ~30ms），实际 ${result.elapsedMs}ms`,
  )
  assert.ok(
    result.retriedSections?.[0]?.wastedMs >= 25,
    `重试那趟的耗时也要如实带着，实际 ${JSON.stringify(result.retriedSections)}`,
  )
})

test('分节作业（并发）：各节的调用**同时开跑** —— wall-clock ≈ 最慢的一节，不是相加', async () => {
  // 读者拍板（2026-10-02）：分节压缩并发跑。钉法：每次 startRun 记下开始时刻并拖 60ms
  // ⇒ 若是串行，第二节的 start 必然晚于第一节的 end；并发的⇒ 两个 start 都早于任一 end。
  const events = []
  const compactor = createCompactor({
    startRun: async (spec) => {
      const section = String(spec.label).split(':').pop()
      events.push({ kind: 'start', section, at: Date.now() })
      await new Promise((resolve) => setTimeout(resolve, 60))
      events.push({ kind: 'end', section, at: Date.now() })
      return { output: [{ type: 'text', text: `## ${section}\n### 甲\n- \`第1章\` 压缩后的条目。` }] }
    },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  const before = parseBackground([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第2章`）',
    '- 甲 ↔ 乙：和解（`第5章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '- `第2章` 立场转变',
  ].join('\n'))
  const result = await compactor({ sessionId: 's', bookTitle: '书', markdown: 'x', doc: before, targetChars: 200 })
  assert.equal(result.ok, true, JSON.stringify(result.reason ?? ''))
  const starts = events.filter((event) => event.kind === 'start')
  const ends = events.filter((event) => event.kind === 'end')
  assert.equal(starts.length, 2)
  const firstEnd = Math.min(...ends.map((event) => event.at))
  assert.ok(
    starts.every((event) => event.at < firstEnd),
    `两次调用应当同时开跑（${JSON.stringify(events)}）`,
  )
  assert.ok(result.savedChars > 0, '夹具的回执必须真的变小（否则差分没有意义）')
})

test('分节作业：模型在回执里**夹带别的节**⇒ 只取自己那节，其余照旧原样（包括读者族）', async () => {
  const before = parseBackground([
    '<!-- drc-background: schema=1 covered=1..10 -->',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明，白衣，站在渡口。',
    '- `第3章` 还是那身白衣，还在渡口两头打听。',
    '## 时间与分线',
    '### 主线',
    '- `第1-4年` 骨架：他还在渡口。',
  ].join('\n'))
  const compactor = createCompactor({
    startRun: async () => ({
      output: [{
        type: 'text',
        // 回执故意比素材短（要通过"必须变小"），**并夹带一节模型没被问过的「时间与分线」**
        text: `## 人物\n### 甲\n- \`第1-3章\` 身份未明，白衣，在渡口打听。\n## 时间与分线\n### 主线\n- \`第1-4年\` 【篡改】被模型偷改的骨架。`,
      }],
    }),
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => undefined,
    logger: {},
  })
  const result = await compactor({ sessionId: 's', bookTitle: '书', markdown: 'x', doc: before })
  assert.equal(result.ok, true, JSON.stringify(result.reason ?? ''))
  // 模型夹带的"时间与分线"**必须被丢弃**：读者族的骨架原样在
  assert.match(result.text, /他还在渡口/, '读者族原文原样保留')
  assert.ok(!result.text.includes('【篡改】'), '模型没资格改读者族（它没被问过那一节）')
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

test('机制：不注入 startRun 时，超时也必须释放子代理（回归：默认实现的 dispose 挂在永不 settle 的 result 上）', async () => {
  // ⚠️ 2026-10-02 三方评审 P2-3：这条守卫**刻意不注入 `startRun`**。
  //
  // 上面那条超时用例（以及 `memory.test.mjs` 里的同类）都注入了自己的
  // `startRun`，而 `run.dispose()` 只存在于**默认实现**里 —— 注入恰好把唯一
  // 持有 dispose 的那段代码整个换掉了。于是"超时后有没有释放子代理"从来没被
  // 跑过。真正的泄漏点是：默认实现把 dispose 写在 `await run.result` 的
  // `finally` 里，而超时是从 `Promise.race` 提前返回的 —— `result` 永不 settle
  // ⇒ `finally` 永不执行 ⇒ 每次补齐失败都漏一个会话。
  let disposed = 0
  let started = 0
  const runner = createSubagentRunner({
    timeoutMs: 40,
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => ({
      start: async () => {
        started += 1
        return {
          // 宿主卡在一个不响应取消的等待上（与上一条同一个前提）。
          result: new Promise(() => {}),
          dispose: async () => { disposed += 1 },
        }
      },
    }),
    logger: {},
  })

  const result = await runner({ sessionId: 's1', label: 'x', prompt: 'p', persona: 'persona' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'TIMEOUT')
  assert.equal(started, 1, '应当真的走了默认启动实现')

  // 释放可能排在本轮 microtask 之后，给它一拍。
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disposed, 1, '超时后必须释放子代理，且只释放一次')
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
    `- \`第1章\` ${'设定'.repeat(60)}。`,
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
  // ⚠️ 3.0 分节作业：压缩的回执按**节名**给（真实模型只回自己那一节）。
  const perSectionCanned = (section) => ({
    '人物关系': '## 人物关系\n- 甲 ↔ 乙：对手（`第1章`）',
    '人物': '## 人物\n### 甲\n- `第1-2章` 身份未明后立场转变\n### 乙\n- `第1章` 初登场',
    '世界观': '## 世界观\n- `第1章` 核心设定。',
  }[section])
  const fakeSubagents = {
    start: async (kind, spec) => {
      labels.push(spec.label)
      const section = String(spec.label).startsWith('dsh-reading-companion:compact:')
        ? String(spec.label).split(':').pop()
        : null
      const text = section !== null ? perSectionCanned(section) : big
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
      // ⚠️ 3.0 分节作业：每个非空的可压缩节各来一次调用；**「人物」那一次故意只给丙**
      // —— 逐节的"主体一个都不能少"必须拦下（丢的甲乙由节内守卫点名）。
      if (String(spec.label).startsWith('dsh-reading-companion:compact:')) {
        const section = String(spec.label).split(':').pop()
        const text = section === '人物'
          ? '## 人物\n### 丙\n- `第1章` 换了个人'
          : section === '人物关系'
            ? '## 人物关系\n- 甲 ↔ 乙：对手（`第1章`）'
            : `## ${section}\n- \`第1章\` 原样保留。`
        return { result: Promise.resolve({ output: [{ type: 'text', text }] }), dispose: async () => {} }
      }
      return { result: Promise.resolve({ output: [{ type: 'text', text: big }] }), dispose: async () => {} }
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
    assert.match(res.body.compact.reason, /^COMPACT_SECTION_LOST_ENTITIES: 人物/, `逐节的"保主体"要拦下丢人的那次：${res.body.compact.reason}`)
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

    assert.notEqual(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.compact?.ok, true, `压缩这一趟本身是成功的：${JSON.stringify(res.body)}`)
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

//#region 冷归档（3.0）：超预算先归档、不叫模型

test('自动压缩：**先归档、后压缩** —— 窗口外的旧条目搬走之后就不叫模型了（3.0）', async () => {
  // 背景与"自动压缩"那条用例同一份（条目落在第 1–2 章）。把**活跃窗口调成 2 章**、读者在第 2 章
  // ⇒ 窗口起点 = 第 2 章 ⇒ "最晚章号 < 2"的条目（第 1 章那几条）会被冷归档搬走。
  const big = [
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第1章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '- `第2章` 立场转变',
    '## 世界观',
    `- \`第1章\` ${'设定'.repeat(60)}。`,
  ].join('\n')

  const labels = []
  const fakeSubagents = {
    start: async (kind, spec) => {
      labels.push(spec.label)
      return { result: Promise.resolve({ output: [{ type: 'text', text: big }] }), dispose: async () => {} }
    },
  }
  const fakeAgents = { get: () => ({ id: 'parent' }) }

  const dir = makeDir('archive-before-compact')
  const s = await startServer(dir, {
    subagents: fakeSubagents,
    agents: fakeAgents,
    config: { window: { backgroundBudgetChars: 9000, compactThreshold: 0.95, archiveWindowChapters: 2 } },
  })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-archive' } })

    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    const first = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })
    assert.equal(first.status, 200)

    // 读者读到第 3 章（chapterIndex 2）⇒ 与 covered 1..2 之间**没有缺口** ⇒ 这一趟只会 skipped，
    // 而**冷归档发生在缺口判断之前**（它是代码做的，与有没有缺口无关）—— 这一条正好把它钉住：
    // 窗口起点 = 3-2+1 = 第 2 章 ⇒ "最晚章号 < 2"的条目（第 1 章那几条）出窗口。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 0 } })
    const second = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })
    assert.equal(second.status, 200)

    const archived = second.body.archived
    const nowProgress = await call(`${s.base}/books/${bookId}/progress`)
    assert.ok(
      archived !== null && archived !== undefined,
      '补齐结果里要如实报告冷归档；'
      + `实际 keys=${Object.keys(second.body).join(',')} `
      + `covered=${JSON.stringify(second.body.covered)} `
      + `progress=${JSON.stringify(nowProgress.body)}`,
    )
    assert.ok(archived.moved > 0, `应当归档窗口外的旧条目：${JSON.stringify(archived)}`)
    assert.ok(
      !labels.some((label) => String(label).includes(':compact')),
      `归档是纯代码的，不该叫模型压缩：${labels.join(' / ')}`,
    )

    // 文件层面：条目搬进「冷档案」且**原文还在**（只搬运、不删除），并留了整份备份
    const read = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(read.status, 200)
    assert.match(read.body.markdown, /^## 冷档案$/m, '文件里要有冷档案节')
    assert.ok(read.body.markdown.includes('身份未明'), '被归档的条目仍然留在文件里')
    assert.ok(read.body.markdown.includes('`第2章` 立场转变'), '窗口内的条目留在活分区')
    assert.ok(archived.backupPath !== null, '落盘前必须留整份备份')

    // ⚠️ **自动备份**（3.0，读者 2026-10-02 提的）：自动归档要往**导出文件夹**的
    //    「自动备份」子文件夹里写一份处理后的全文，命名 `<书名>-第1次自动备份.md`
    //    （后缀只有一个 —— 归档与压缩共用，读者 2026-10-02 定）。
    //    （手动压缩的备份位置不变 —— 所以这条只盯"自动"那条路。）
    //    落点就用响应里给的路径断言：测试环境的工作区布局与真机不同（真机 =
    //    工作区根/陪读导出_<书名>/，测试 = <storage>/books/陪读导出_<书名>/），但形态一致。
    const auto = archived.autoBackup
    assert.ok(auto !== null && auto !== undefined, `自动备份要真的落盘：${JSON.stringify(archived)}`)
    assert.match(
      auto.path.replace(/\\/g, '/'),
      /自动备份\/.*第1次自动备份\.md$/,
      `命名要按读者的口径：${auto.path}`,
    )
    assert.ok(existsSync(auto.path), '写出的文件要真的存在')
    assert.equal(auto.seq, 1, '第一次归档 = 第 1 次')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话固定（3.0）：补齐子代理先问**绑定会话**，而不是"点按钮的会话"', async () => {
  // ⚠️ 读者实测："子代理跟着当前会话跑，而不是固定到绑定会话里跑" —— 从哪个会话点补齐，
  //    那批记忆子代理就散落在谁的下面。定稿：**绑定会话优先**（记忆维护属于那本书，
  //    而那本书的会话是绑定会话）；绑定的不在线 ⇒ runner 落回当前会话（不会变得不能补）。
  const asked = []
  const fakeAgents = { get: (id) => { asked.push(id); return { id } } } // 每个会话都"在线"
  const fakeSubagents = {
    start: async (kind, spec) => ({ result: Promise.resolve({ output: [{ type: 'text', text: '## 人物\n### 甲\n- `第1章` 出场。' }] }), dispose: async () => {} }),
  }
  const dir = makeDir('session-pinning')
  const s = await startServer(dir, { subagents: fakeSubagents, agents: fakeAgents })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-book' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    // 从**另一个**会话（sess-live）来点补齐：
    const res = await call(`${s.base}/books/${bookId}/background/fill`, {
      method: 'POST',
      body: { sessionId: 'sess-live' },
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(asked[0], 'sess-book', `第一次问的必须是绑定会话（实际：${asked.join(' / ')}）`)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话固定（3.0）：绑定会话**不在线**时落回当前会话（不会变得不能补）', async () => {
  // 只有"当前会话"在线：绑定会话查不到 ⇒ 落回，补齐照旧成功 —— 与旧行为一致。
  const asked = []
  const fakeAgents = { get: (id) => { asked.push(id); return id === 'sess-live' ? { id: 'sess-live' } : undefined } }
  const fakeSubagents = {
    start: async (kind, spec) => ({ result: Promise.resolve({ output: [{ type: 'text', text: '## 人物\n### 甲\n- `第1章` 出场。' }] }), dispose: async () => {} }),
  }
  const dir = makeDir('session-pin-fallback')
  const s = await startServer(dir, { subagents: fakeSubagents, agents: fakeAgents })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-book' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, {
      method: 'POST',
      body: { sessionId: 'sess-live' },
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(asked, ['sess-book', 'sess-live'], '先问绑定、再落回当前')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自适应重试（3.0 ③a）：截断嫌疑 ⇒ 砍半重试；重试**更好才换**，且要如实报告', async () => {
  // 第一次的输出"像被截断"（最后一条没有句读收尾）⇒ 3.0 会自动重新采样一半章数再试一次；
  // 第二次给了完整输出 ⇒ 用第二次，retried.ok = true。
  const calls = []
  const fakeSubagents = {
    start: async (kind, spec) => {
      calls.push(spec.label)
      const text = calls.length === 1
        ? '## 人物关系\n- `第1章` 甲与乙结怨'   // ✗ 无句读收尾 ⇒ 判为截断嫌疑
        : '## 人物关系\n- `第1章` 甲与乙结怨。'  // ✓ 完整
        + '\n## 人物\n### 甲\n- `第1章` 出场。'
      return { result: Promise.resolve({ output: [{ type: 'text', text }] }), dispose: async () => {} }
    },
  }
  const dir = makeDir('retry-better')
  const s = await startServer(dir, { subagents: fakeSubagents, agents: { get: () => ({ id: 'parent' }) } })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(calls.length, 2, `截断嫌疑要触发一次重试：${calls.join(' / ')}`)
    assert.equal(res.body.retried?.ok, true, '重试成功要如实报告')
    assert.equal(res.body.retried.reason, 'TRUNCATED_SUSPECTED')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自适应重试（3.0 ③a）：重试**没带来更好的结果**⇒ 保守保留第一次（截断批写进去的部分仍有效）', async () => {
  // 第一次 ok+截断；重试给了垃圾（解析不出）⇒ **不能把成功换成失败**（那是倒退）。
  let calls = 0
  const fakeSubagents = {
    start: async (kind, spec) => {
      if (String(spec.label).includes(':compact')) {
        return { result: Promise.resolve({ output: [{ type: 'text', text: '## 文本类型\n- 测试。' }] }), dispose: async () => {} }
      }
      calls += 1
      const text = calls === 1 ? '## 人物\n### 甲\n- `第1章` 出场但忘了句号' : '好的，我明白了。'
      return { result: Promise.resolve({ output: [{ type: 'text', text }] }), dispose: async () => {} }
    },
  }
  const dir = makeDir('retry-keep-first')
  const s = await startServer(dir, {
    subagents: fakeSubagents,
    agents: { get: () => ({ id: 'parent' }) },
    config: { window: { backgroundBudgetChars: 300, compactThreshold: 0.5 } },
  })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess' } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })
    assert.equal(res.status, 200, JSON.stringify(res.body), '第一次的成功不能被重试的失败顶掉')
    assert.equal(res.body.retried?.ok, false, '重试没成好要如实报告')
    assert.equal(res.body.truncatedSuspected, true, '截断嫌疑仍然要说（保留的是第一次的截断产物）')
    assert.equal(res.body.covered.last, 1, '第一次的成果照常合并落盘')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('压缩提示：分组节的尺子不许把它说成"扁平条目"（形状跟注册表走）（2026-10-03 体检）', () => {
  // ⚠️ **压缩是整份重写文件** ⇒ 它在提示词里教什么形状，压缩后就是什么形状。
  //    这里曾经写着「人物关系」= "**扁平条目**，一条写一对人（`甲 ↔ 乙：…`）" —— 而
  //    注册表 `grouped: true`、**同一个文件里**另一处又写着"人物关系的主体是**一对人**
  //    （`### 甲 × 乙`）"。两条口径打架，代价具体而硬：
  //      · 模型照"扁平"写 ⇒ 输出里没有 `###` 主体 ⇒ **「保主体」判 `COMPACT_LOST_ENTITIES`**
  //        ⇒ 整批丢弃 ⇒ 这一节**永远压不掉**（只增不减、无上限）；
  //      · 与补齐侧格式块当时教平铺是**同一个根因**：一个概念两个定义点。
  for (const name of COMPRESSIBLE_SECTIONS) {
    if (!isGroupedSection(name)) continue
    const prompt = buildCompactPrompt({
      bookTitle: '测试书',
      section: name,
      sectionMarkdown: `## ${name}\n### 甲 × 乙\n- 一条`,
    })
    assert.doesNotMatch(
      prompt,
      /扁平条目/,
      `「${name}」是分组节（注册表 grouped=true），压缩提示不许把它说成"扁平条目"`,
    )
  }
})

//#endregion

//#region 素材形状的往返契约

test('压缩的素材/成品必须是 `parseBackground` 能**原样读回**的形状（2026-10-03 体检：条目从前不带 `- `）', () => {
  // ⚠️ `renderOneSectionMarkdown` 的文档注释写着"只用于切分节作业的素材/复核成品 ——
  //    **输出会被 `parseBackground` 原样读回**"，而它从前是 `lines.push(entry)`
  //    （**不带 `- ` 前缀**），`parseBackground` 又只认 `- ` 开头的行 ⇒ 契约当场失效：
  //    送给压缩模型的素材形状是错的，模型"照材料的形状回"时那些行**不是条目** ⇒
  //    整条静默消失，而五道校验全过（保主体只比主体名、只要求变小）、`ok: true`、
  //    `savedChars` 照报 —— 这是唯一"删掉内容且不搬进任何归档"的路径。
  //    这条守卫钉**往返**：渲染出来再解析回去，条目必须一条不少、一条不多、一字不差。
  //    ⚠️ 别改成"数条数"：压缩本来就要**合并**条目（读者族才需要"净减少即失败"）。
  for (const name of COMPRESSIBLE_SECTIONS) {
    const doc = {
      sections: { [name]: ['第1章 散着的一条。', '第2章 又一条。'] },
      groups: isGroupedSection(name) ? { [name]: { 甲: ['第3章 分组里的一条。'] } } : {},
    }
    const text = renderOneSectionMarkdown(doc, name)
    assert.match(text, /^- /m, `「${name}」：条目必须带 "- " 前缀（否则 parseBackground 读不回来）`)
    const back = parseBackground(text)
    assert.deepEqual(back.sections[name], doc.sections[name], `「${name}」：散条目必须原样读回`)
    if (isGroupedSection(name)) {
      assert.deepEqual(back.groups[name], doc.groups[name], `「${name}」：分组条目必须原样读回`)
    }
  }
})

//#endregion

