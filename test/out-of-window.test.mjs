/**
 * 出窗主体的**降级**（3.2）：身份锚退役 M / 名录化 / 回显瘦身 / 归档尾注带主体。
 *
 * 设计记录：`drc-设计-出窗主体三处降级.md`（工作区根目录）。
 *
 * 这一族的共同前提：**一个出了活跃窗口的主体，从前在四处被永久保留**
 * （文件里的身份锚 / 聊天注入 / 补齐回显 / 读者的「已取代」），而四处其实是同一件事。
 * 本文件把四处各自的守卫放在一起 —— 它们必须**同源**（判据都走 `isOutOfWindow`）。
 *
 * ⚠️ 所有新行为都是 **opt-in**：不传对应选项时与从前**逐字相同**（既有 879 条守卫不受影响）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  isOutOfWindow,
  mergeBackground,
  parseBackground,
  planArchive,
  renderBackgroundForPrompt,
  renderExistingForFill,
  subjectOutOfWindow,
  subjectsInSamples,
} from '../lib/host/background.js'
import { buildMemoryPrompt } from '../lib/host/memory.js'

const md = (lines) => [
  '<!-- drc-background: schema=1 covered=1..400 -->',
  '# 《书》· 背景认识',
  '',
  ...lines,
].join('\n')

// ══════════════════════════════════════════════════════════════════
// ① 判据：出窗只有一处定义
// ══════════════════════════════════════════════════════════════════

test('文本契约：判据同源（G4）——"出窗"只有一处实现（`isOutOfWindow`）', () => {
  // ⚠️ 这条防的是本仓库反复栽的"同一概念两个定义点"：3.2 起**四处**都要问
  //    "这个条目/主体出窗了吗"（归档决定 / 身份锚的锚态判定 / 名录化 / 回显分级），
  //    而判据原本只是 `planArchive` 里的一个局部闭包 `isOld`。
  //    可证伪：在别处再写一遍 `latest < keepFromChapter` ⇒ 计数变 2 ⇒ 红。
  const src = readFileSync(new URL('../lib/host/background.js', import.meta.url), 'utf8')
  const hits = [...src.matchAll(/latest\s*<\s*keepFromChapter/g)]
  assert.equal(hits.length, 1, '只有 `isOutOfWindow` 里那一处 —— 别处再写一遍就是两个定义点')
})

test('判据：没有章号的条目**不算**出窗（判不了就不判）', () => {
  assert.equal(isOutOfWindow('第10章 出身寒门。', 100), true)
  assert.equal(isOutOfWindow('第150章 还在。', 100), false)
  assert.equal(isOutOfWindow('出身寒门（无章号）。', 100), false, '无章号 = 通用描述，不算出窗')
  assert.equal(isOutOfWindow('第12-15章 一段往事。', 100), true, '区间取**终点**')
  assert.equal(subjectOutOfWindow([], 100), false, '空数组无所谓"锚态"')
  assert.equal(subjectOutOfWindow(['第10章 a', '第150章 b'], 100), false, '有一条在窗内就不是锚态')
  assert.equal(subjectOutOfWindow(['第10章 a', '第20章 b'], 100), true)
})

// ══════════════════════════════════════════════════════════════════
// ② 身份锚退役（M = 360）
// ══════════════════════════════════════════════════════════════════

test('身份锚退役（G1）：出窗超过 M 章的主体，**连锚一起**进冷档案', () => {
  // 读者 2026-10-06 拍板 M = 360。病根：「人物」一节的下限 = 立卡数 × ~45 字，
  // 而压缩（保主体）与归档（留锚）都动不了它 ⇒ 长书里注入被挤成花名册、压缩撞输出墙。
  const doc = parseBackground(md([
    '## 人物',
    '### 甲',
    '- `第10章` 出身寒门。',
    '### 乙',
    '- `第390章` 最近还在。',
  ]))
  // keepFrom = 400 - 120 + 1 = 281 ⇒ 甲出窗（第 10 章）、乙在窗内（第 390 章）
  const keepFrom = 281

  assert.equal(planArchive(doc, keepFrom).total, 0, '默认（不给 M）**不退役**：整卡出窗只留锚，一条都不搬')
  assert.equal(
    planArchive(doc, keepFrom, { anchorMaxAgeChapters: 360 }).total, 0,
    '给了 M 但不给 readingChapter ⇒ 仍然不退役（兜底安全，判不了就不判）',
  )

  const plan = planArchive(doc, keepFrom, { readingChapter: 400, anchorMaxAgeChapters: 360 })
  assert.deepEqual(
    plan.items.filter((item) => item.section === '人物').flatMap((item) => item.entries),
    ['`第10章` 出身寒门。'],
    '甲距最后一次被提及 390 章 ≥ 360 ⇒ 锚也搬走；乙在窗内，一根汗毛都不动',
  )

  // 反面：M 比 390 大 ⇒ 锚留着（这正是"别把 M 调太大"的那一头）
  assert.equal(
    planArchive(doc, keepFrom, { readingChapter: 400, anchorMaxAgeChapters: 500 }).total, 0,
    'M = 500 ⇒ 390 < 500，锚还没到期',
  )
})

test('身份锚退役：**状态行跟人走**照旧（退役不该把状态行留在注入里）', () => {
  const doc = parseBackground(md([
    '## 人物状态',
    '### 甲',
    '- `第10章` 在华山。',
    '## 人物',
    '### 甲',
    '- `第10章` 出身寒门。',
  ]))
  const plan = planArchive(doc, 281, { readingChapter: 400, anchorMaxAgeChapters: 360 })
  const moved = plan.items.map((item) => item.section)
  assert.ok(moved.includes('人物'), '人物条目搬走')
  assert.ok(moved.includes('人物状态'), '状态行跟着一起搬（一句过期的"他此刻在哪"比没有更糟）')
})

// ══════════════════════════════════════════════════════════════════
// ③ 名录化
// ══════════════════════════════════════════════════════════════════

const ROSTER_DOC = parseBackground(md([
  '## 人物',
  '### 甲',
  '- `第10章` 出身寒门。',
  '### 乙',
  '- `第390章` 最近还在。',
  '- `第395章` 又出现一次。',
]))

test('名录化（G2）：⭐ **活跃主体照旧出 `### 甲` + 全部条目**，只有出窗主体进名录', () => {
  // ⚠️ 这条钉的正是读者问过的那个点："名录化会不会把活跃角色也变成名录？"——**不会**。
  const { text } = renderBackgroundForPrompt(ROSTER_DOC, {
    budgetChars: 9000,
    progressIndex: 399,
    archiveWindowChapters: 120,
  })
  assert.match(text, /### 乙|- 乙：/, '活跃主体照旧在（形状见 C：人物是一行一人）')
  // ⚠️ 2026-10-05（C）：人物是**一人一行**（只给最新一条）⇒ 不再「每一条都在」。
  //    这条用例的**意图**（活跃主体不许被名录化吃掉 ✓）照旧成立 ⇒ 钉最新那条 + 不在名录里。
  assert.ok(text.includes('第395章'), '活跃主体**最新一条**在（C：人物一行一人）')
  assert.doesNotMatch(text, /第390章/, '更早的条目不随行（C：只给最新一条）')
  assert.doesNotMatch(text, /### 甲/, '出窗主体不再渲染成 `###` 块')
  assert.match(text, /（出窗 1：甲）/, '出窗主体进名录（记号与顶部图例逐字对应）')
})

test('名录化：默认**关闭** —— 不给 `archiveWindowChapters` 时不出名录', () => {
  const { text } = renderBackgroundForPrompt(ROSTER_DOC, { budgetChars: 9000, progressIndex: 399 })
  // ⚠️ 搜记号要用**带数字的具体形态**：注入顶部的图例里就有 `（出窗 N）` 的**字面**
  //    （`BACKGROUND_LEGEND`），拿 `/（出窗/` 去搜会先撞上图例。
  assert.doesNotMatch(text, /（出窗 \d+：/, '不给窗口 ⇒ 不名录化（opt-in）')
  assert.match(text, /甲/, '甲照旧在（形状可能是 `### 甲`，或薄主体压成的一行）')
})

test('名录化（G3）：名录是**固定成本**，预算再小也不会像"最旧的单元"那样被丢掉', () => {
  // ⚠️ 名录的 recency 是最旧的（那是"出窗"的定义）⇒ 若当普通单元交给 `selectUnits`，
  //    它会**第一个**被丢掉 —— 那正好把名录的作用抵消掉。
  const { text } = renderBackgroundForPrompt(ROSTER_DOC, {
    budgetChars: 120,
    progressIndex: 399,
    archiveWindowChapters: 120,
  })
  assert.match(text, /（出窗 1：甲）/, '预算极小也照样有名录')
})

test('名录化：名录有**上限**，超出的只报个数（名单随立卡数线性长）', () => {
  const lines = ['## 人物']
  for (let i = 1; i <= 6; i += 1) lines.push(`### 甲${i}`, `- \`第${i}章\` 很早的事。`)
  const doc = parseBackground(md(lines))
  const { text } = renderBackgroundForPrompt(doc, {
    budgetChars: 9000, progressIndex: 399, archiveWindowChapters: 120, rosterMaxNames: 2,
  })
  assert.match(text, /（出窗 6：甲6 \/ 甲5 …另 4）/, '按**最近被提及**降序 —— 最可能被问到的排前面（甲6 的章号最晚）')
})

// ══════════════════════════════════════════════════════════════════
// ④ 回显瘦身
// ══════════════════════════════════════════════════════════════════

const ECHO_DOC = parseBackground(md([
  '## 人物',
  '### 甲',
  '- `第10章` 出身寒门，被唤作小三儿。',
  '### 乙',
  '- `第390章` 最近还在西岳一带行走，隔一两日下山探望竹纤。',
]))

test('回显瘦身（G5）：关注名单给全文、其余给索引；**主体名与章号锚一个都不许少**', () => {
  const full = renderExistingForFill(ECHO_DOC)
  assert.ok(full.includes('被唤作小三儿'), '不给 focusNames ⇒ 全文（默认不瘦身）')

  const slim = renderExistingForFill(ECHO_DOC, { focusNames: ['甲'] })
  assert.ok(slim.includes('被唤作小三儿'), '关注名单里的主体：全文')
  assert.match(slim, /### 乙/, '⭐ 没被关注的主体：**主体名照旧在**（省了它，模型会给同一个人开第二张卡）')
  assert.ok(slim.includes('`第390章`'), '⭐ **章号锚照旧在**（省了它，模型没法判断"这条记过没有"）')
  assert.ok(!slim.includes('隔一两日下山探望竹纤'), '正文换成开头 + 省略号')
  assert.match(slim, /只给了开头/, '瘦身要**如实说明**（"少给了什么"必须可解释）')
  assert.doesNotMatch(
    slim, /拿不准就写/,
    '⭐ **不许替模型做判断**（2026-10-06 删掉的那句）：它是在鼓励多写，而"该不该写"该由合并层的抑制名单兜',
  )
  assert.match(slim, /在这批正文里没有出现/, '改成**陈述事实**：这些条目没出现在这批正文里')
})

test('回显瘦身：关注名单由**样本正文**决定（`subjectsInSamples`，确定性、不用工具）', () => {
  const names = subjectsInSamples(ECHO_DOC, [{ text: '乙今天又提起了那件事。' }])
  assert.deepEqual(names, ['乙'], '只有样本里出现过的名字进名单')
  assert.deepEqual(subjectsInSamples(ECHO_DOC, [{ text: '与这两个人都无关的正文。' }]), [], '都没出现 ⇒ 空名单')
  assert.deepEqual(subjectsInSamples(ECHO_DOC, []), [], '没有样本正文 ⇒ 空（调用方要自己决定给不给）')
})

test('回显瘦身：「人物关系」（平铺）双方都不在名单里才瘦身，且**对名不许丢**', () => {
  const doc = parseBackground(md([
    '## 人物关系',
    '- 孟奇 ↔ 江芷微：`第10章` 洗剑阁少女，`第13章` 并肩杀敌。',
  ]))
  const slim = renderExistingForFill(doc, { focusNames: ['别人'] })
  assert.match(slim, /孟奇 ↔ 江芷微/, '对名（条目开头）必须留着')
  assert.match(slim, /`第10章`/, '章号锚留着')
  assert.ok(!slim.includes('并肩杀敌'), '正文换成开头')
  const kept = renderExistingForFill(doc, { focusNames: ['江芷微'] })
  assert.ok(kept.includes('并肩杀敌'), '任一方在名单里 ⇒ 全文')
})

// ══════════════════════════════════════════════════════════════════
// ⑤ 归档尾注带主体
// ══════════════════════════════════════════════════════════════════

const stateBase = (line) => parseBackground([
  '<!-- drc-background: schema=1 covered=1..30 -->',
  '# 《书》· 背景认识',
  '',
  '## 人物状态',
  line,
].join('\n'))

test('归档尾注带主体（G8）：**分组**形态的旧状态行在「已取代」里能看出是谁的', () => {
  // 实测病根：《一世之尊》「已取代」4 条里 **0 条**带主体名；《魔女霓裳》6 条里 3 条带 ——
  // 差别正好是"平铺形态自带主体 vs 分组形态主体住 `###` 表头"。分组那条**永久丢失了主人**。
  const base = stateBase(['### 竹纤', '- `第30章` 在华山黄龙洞。'].join('\n'))
  const add = parseBackground([
    '<!-- drc-background: schema=1 covered=49..49 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 竹纤',
    '- `第49章` 已过潼关。',
  ].join('\n'))
  const merged = mergeBackground(base, add, { first: 49, last: 49 })
  assert.deepEqual(
    merged.retired,
    ['`第30章` 在华山黄龙洞。 <!-- 已于第 49 章被取代 · 主体：竹纤 -->'],
    '主体进了尾注（注释里），读者在「已取代」里看得出这是谁的状态',
  )
})

test('归档尾注：**平铺**条目自带主体时不重复加（重复一次读起来像另一个人）', () => {
  const base = stateBase('- `第30章` 竹纤：在华山黄龙洞。')
  const add = parseBackground([
    '<!-- drc-background: schema=1 covered=49..49 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 竹纤',
    '- `第49章` 已过潼关。',
  ].join('\n'))
  const merged = mergeBackground(base, add, { first: 49, last: 49 })
  assert.deepEqual(
    merged.retired,
    ['`第30章` 竹纤：在华山黄龙洞。 <!-- 已于第 49 章被取代 -->'],
    '正文已经报了名字 ⇒ 尾注不再加一截',
  )
})

test('归档尾注**不许**写进正文（G9）：正文一动，抑制键就变了 ⇒ 旧状态复活成"此刻"', () => {
  // ⚠️ `entryKey`（抑制名单的比对键）会剥掉 HTML 注释，但**不会**剥主体前缀。
  //    而模型在分组形态下写出的正文里**本来就不含主体** ⇒ 主体写进正文会让键对不上
  //    ⇒ 被顶掉的旧状态**会被重新总结回来**，并作为"此刻"注入。
  const base = stateBase(['### 竹纤', '- `第30章` 在华山黄龙洞。'].join('\n'))
  const add = parseBackground([
    '<!-- drc-background: schema=1 covered=49..49 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 竹纤',
    '- `第49章` 已过潼关。',
  ].join('\n'))
  const merged = mergeBackground(base, add, { first: 49, last: 49 })

  const archived = merged.retired[0]
  assert.ok(archived.startsWith('`第30章` 在华山黄龙洞。'), '原文一字不改（主体只在注释里）')
  assert.ok(!archived.split('<!--')[0].includes('竹纤'), '正文里不许出现主体前缀')

  // 行为面：模型重读第 30 章、又总结出**同一句** ⇒ 必须被抑制名单挡住
  const again = mergeBackground(merged, parseBackground([
    '<!-- drc-background: schema=1 covered=49..49 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 竹纤',
    '- `第30章` 在华山黄龙洞。',
  ].join('\n')), { first: 49, last: 49 })
  const live = [
    ...(again.sections['人物状态'] ?? []),
    ...Object.values(again.groups['人物状态'] ?? {}).flat(),
  ]
  assert.deepEqual(live, ['`第49章` 已过潼关。'], '被顶掉的旧状态**不许**复活成"此刻"')
})

// ══════════════════════════════════════════════════════════════════
// ⑥ A 版（2026-10-06）：注入头部图例 + 注入侧两种粒度压缩 + 判据
// ══════════════════════════════════════════════════════════════════

test('A 版图例：注入头部有一处固定图例，且**计入额度**（预算第一次真是上界）', () => {
  const doc = parseBackground(md(['## 人物', '### 甲', '- `第10章` 一条。']))
  const r = renderBackgroundForPrompt(doc, { budgetChars: 9000, progressIndex: 10 })
  assert.match(r.text, /^> 记号：/m, '顶部要有记号图例（一处说清，不再每节一句长说明）')
  // ⚠️ 图例里必须**逐字**出现它在用的记号，否则模型看到 `（+N）` 不知道是什么。
  assert.match(r.text, /`（\+N）`/, '图例要解释 `（+N）`')
  assert.match(r.text, /`（出窗 N）`/, '图例要解释 `（出窗 N）`')
  assert.match(r.text, /`（一面之缘）`/, '图例要解释 `（一面之缘）`')
  // ⚠️ **它是注入的一部分**：`used` 必须把它算进去。从前那些逐节长说明是在额度**之外**
  //    追加的 ⇒ 实测注入必然超支 2.5%（《一世之尊》9,222 > 9,000）。
  assert.ok(r.used <= 9000, `注入不许超预算，实际 ${r.used}`)
})

test('A 版：预算再小，注入也不超预算（图例与节末记号都算在额度里）', () => {
  const doc = parseBackground(md(['## 人物', '### 甲', `- \`第10章\` ${'很长'.repeat(80)}`]))
  const r = renderBackgroundForPrompt(doc, { budgetChars: 300, progressIndex: 10 })
  assert.ok(r.used <= 300, `预算 300 时注入 ${r.used} —— 记号与图例都必须算在额度里`)
})

test('A 版：薄主体压一行（注入侧）—— 一条的主体不出 `###`，两条的照旧出', () => {
  const doc = parseBackground(md([
    '## 世界观',
    '### 甲',
    '- `第1章` 只有一条。',
    '### 乙',
    '- `第2章` 第一条。',
    '- `第3章` 第二条。',
  ]))
  const r = renderBackgroundForPrompt(doc, { budgetChars: 9000, progressIndex: 5 })
  assert.match(r.text, /^- 甲：/m, '只有一条 ⇒ 压成一行（零内容损失）')
  assert.doesNotMatch(r.text, /### 甲/, '…且不再出表头')
  assert.match(r.text, /### 乙/, '两条的照旧出表头')
  assert.ok(r.text.includes('第二条'), '内容一个字不丢')
})

test('A 版：一对人一条 —— 同一对的多条在注入里并成一条（文件与回显不动）', () => {
  const doc = parseBackground(md([
    '## 人物关系',
    '- 甲 ↔ 乙：`第1章` 同门。',
    '- 乙 ↔ 甲：`第5章` 反目。',
    '- 甲 ↔ 丙：`第2章` 初识。',
    '- 甲 ↔ 丙：`第9章` 结盟。',
  ]))
  const r = renderBackgroundForPrompt(doc, { budgetChars: 9000, progressIndex: 10 })
  const lines = r.text.split('\n').filter((line) => line.startsWith('- ') && line.includes('↔'))
  assert.equal(lines.length, 2, `同一对只该剩一条，实际 ${lines.length} 条：${lines.join(' | ')}`)
  assert.match(r.text, /甲 ↔ 乙：.*第1章.*第5章/, '两段历史并进同一条')
  assert.match(r.text, /甲 ↔ 丙：.*第2章.*第9章/, '与方向无关（`乙 ↔ 甲` 也算同一对）')
  // ⚠️ **文件与回显照旧**：这是注入视图的压缩，不是写盘 —— 回显要教模型"这一节长什么样"。
  assert.match(renderExistingForFill(doc), /乙 ↔ 甲/, '回显必须给文件里的真形状')
})

test('A 版：一面之缘 —— 并完之后只有一个章号锚的关系收进节末一行', () => {
  const doc = parseBackground(md([
    '## 人物关系',
    '- 甲 ↔ 乙：`第1章` 同门。',
    '- 甲 ↔ 乙：`第5章` 反目。',
    '- 甲 ↔ 丁：`第2章` 只见过一面。',
  ]))
  const r = renderBackgroundForPrompt(doc, { budgetChars: 9000, progressIndex: 10 })
  assert.match(r.text, /（一面之缘 1：甲 ↔ 丁 `第2章`）/, '只见过一次的收进节末清单')
  assert.doesNotMatch(r.text, /^- 甲 ↔ 丁：/m, '…不再单独占一条')
  // ⚠️ 判据是**并完之后**的锚数：甲↔乙 见过两次 ⇒ 不算一面之缘。
  assert.match(r.text, /^- 甲 ↔ 乙：/m, '见过两次的照旧单独成条')
})

test('A 版判据：提示词给了「三问 + 复现门槛 + 默认归属」与「一对人一条」', () => {
  const prompt = buildMemoryPrompt({
    bookTitle: '书',
    samples: [{ index: 0, title: '第一章', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  assert.match(prompt, /会不会再次被用到/, '第一问：复现')
  assert.match(prompt, /至少两个不同章号/, '复现要**可数**（≥2 个章号锚，不看后面 ⇒ 不引入剧透）')
  assert.match(prompt, /默认归属/, '要说清"一个事实的默认家是它关于的那个人"')
  // ⚠️ 2026-10-05 晚：**同一对、同一方向**只留一条 ✓；**双向分开两个视角** ✓。
  assert.match(prompt, /同一对、同一方向只留一条/, '同方向一条')
  assert.match(prompt, /双向关系两个视角各一条/, '双向两个视角各一条')
  assert.match(prompt, /不要另起一条/, '…并且明说别另起')
})

test('文本契约：立卡报告要报出"这批新建了几个主体、其中几个只有一条"', () => {
  // ⚠️ 换了判据（三问 + 复现门槛）之后**有没有生效**必须可观测 —— 否则又是"写了四层、
  //    最后一层是空的"。这条是文本契约（报告在 `fillMemoryGap` 的落盘路径里，跑真机才走到）。
  const src = readFileSync(new URL('../lib/host/memory-pipeline.js', import.meta.url), 'utf8')
  assert.match(src, /function memoryGrowthReport/, '报告函数要在')
  assert.match(src, /其中 \$\{growth\.newThin\} 个只有一条/, '要把"只有一条的"单独报出来（那是名词解释）')
})
