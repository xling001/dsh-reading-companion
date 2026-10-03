/**
 * 「人物状态」（3.0 ②，A 方案）的三条性质与它的耦合行为。
 *
 * 这一节是**全文件唯一允许覆盖**的地方：每批**替换**（同一主体永远一行，旧的进 `已取代`）、
 * 只给**活跃窗口内**的人（出窗口跟人一起归档）、整节注入（不进权重表）。
 * 这三条缺一个都会坏：不替换 ⇒ 每批一行越积越多；不跟人走 ⇒ 冷人物挂着一句过期状态；
 * 不整节注入 ⇒ 模型聊"现在"时手里没有现状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  applyArchive,
  BACKGROUND_FULL_SECTIONS,
  BACKGROUND_SECTIONS,
  BACKGROUND_STATE_SECTION,
  mergeBackground,
  parseBackground,
  planArchive,
  renderBackground,
  renderBackgroundForPrompt,
} from '../lib/host/background.js'
import { HOST_DEFAULTS } from '../lib/host/defaults.js'

const md = (stateLines, extra = []) => [
  '<!-- drc-background: schema=1 covered=1..100 -->',
  '# 《书》· 背景认识',
  '',
  '## 文本类型',
  '- 散文式旅记，双主角。',
  '',
  '## 人物状态',
  ...stateLines,
  '',
  '## 人物',
  '### 甲',
  '- `第10章` 出场即伤。',
  '### 乙',
  '- `第80章` 乙在山中。',
  ...extra,
].join('\n')

test('状态行是**替换**：新的顶掉旧的，旧的进「已取代」；同一主体永远只有一行', () => {
  const base = parseBackground(md(['### 甲', '- `第10章` 现状：在山腰养伤。']))
  const add = parseBackground([
    '<!-- drc-background: schema=1 covered=101..115 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 甲',
    '- `第115章` 现状：已离家远行；目标是找回师父。',
  ].join('\n'))

  const merged = mergeBackground(base, add, { first: 101, last: 115 })
  assert.deepEqual(
    merged.groups['人物状态']['甲'],
    ['`第115章` 现状：已离家远行；目标是找回师父。'],
    '同一主体只剩新的一行',
  )
  assert.equal(merged.retired.length, 1, '旧的那行进「已取代」（全文件唯一覆盖例外依然"搬进归档"）')
  assert.match(merged.retired[0], /在山腰养伤.*已于第 115 章被取代/)
  // 「人物」的条目照旧只增不减，不许被状态行的替换语义波及
  assert.deepEqual(merged.groups['人物']['甲'], ['`第10章` 出场即伤。'])
})

test('状态行没变 ⇒ 不产生"取代"日志，也不重复（没发生的事不留记录）', () => {
  const base = parseBackground(md(['### 甲', '- `第10章` 现状：在山腰养伤。']))
  const add = parseBackground([
    '<!-- drc-background: schema=1 covered=101..112 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 甲',
    '- `第10章` 现状：在山腰养伤。',
  ].join('\n'))
  const merged = mergeBackground(base, add, { first: 101, last: 112 })
  assert.deepEqual(merged.groups['人物状态']['甲'], ['`第10章` 现状：在山腰养伤。'])
  assert.equal(merged.retired.length, 0, '同一句话不算"更新"')
})

test('别的主体的状态行不受影响；状态节天然在文件节序里（元判断之后）', () => {
  const base = parseBackground(md([
    '### 甲',
    '- `第10章` 现状：在山腰养伤。',
    '### 乙',
    '- `第60章` 现状：在山下镇上。',
  ]))
  const add = parseBackground([
    '<!-- drc-background: schema=1 covered=101..113 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 乙',
    '- `第113章` 现状：已经进了城。',
  ].join('\n'))
  const merged = mergeBackground(base, add, { first: 101, last: 113 })
  assert.deepEqual(merged.groups['人物状态']['甲'], ['`第10章` 现状：在山腰养伤。'], '没提到的保留原样')
  assert.deepEqual(merged.groups['人物状态']['乙'], ['`第113章` 现状：已经进了城。'])
  // 文件的节序：人物状态紧跟在元判断之后（注入顺序同源，见 BACKGROUND_SECTIONS）
  assert.deepEqual(BACKGROUND_SECTIONS.slice(0, 2), ['文本类型', BACKGROUND_STATE_SECTION])
})

test('注入：人物状态**整条在场**（在文本类型之后、注入节之前），且计入用量', () => {
  const doc = parseBackground(md(
    ['### 甲', '- `第10章` 现状：在山腰养伤。'],
    ['## 人物关系', '- 甲 ↔ 乙：同门'],
  ))
  const { text, used } = renderBackgroundForPrompt(doc, { budgetChars: 9000 })
  const atState = text.indexOf('### 人物状态')
  assert.ok(atState >= 0, '人物状态必须进提示词')
  assert.ok(text.includes('在山腰养伤'), '那行现状必须真的在')
  assert.ok(atState < text.indexOf('### 人物关系'), '它排在注入节之前')
  assert.ok(text.indexOf('### 文本类型') < atState, '排在元判断之后')
  assert.ok(used > 0 && text.length > 0, '长度要计入')
  assert.ok(BACKGROUND_FULL_SECTIONS.includes(BACKGROUND_STATE_SECTION), '它属于"永远整条注入"族')
})

test('写盘 roundtrip：renderBackground → parse 后状态不丢', () => {
  const doc = parseBackground(md(['### 甲', '- `第10章` 现状：在山腰养伤。']))
  const again = parseBackground(renderBackground(doc, '《书》'))
  assert.deepEqual(again.groups['人物状态']['甲'], ['`第10章` 现状：在山腰养伤。'])
})

test('归档耦合：主体的**人物条目全部出窗口** ⇒ 他的状态行跟人一起进冷档案', () => {
  // 甲的条目全在第 20 章之前；乙有一条第 80 章（窗口内）⇒ 只有甲的状态行跟着走。
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..100 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 甲',
    '- `第10章` 现状：在山腰养伤。',
    '### 乙',
    '- `第60章` 现状：在山下镇上。',
    '',
    '## 人物',
    '### 甲',
    '- `第5章` 更早。',
    '- `第20章` 最后一次出场。',
    '### 乙',
    '- `第80章` 乙在山中。',
  ].join('\n'))

  const plan = planArchive(doc, 40)
  const stateItem = plan.items.find((item) => item.section === BACKGROUND_STATE_SECTION)
  assert.ok(stateItem !== undefined, '状态行要跟人一起归档')
  assert.deepEqual(stateItem.entity, '甲')
  assert.ok(!plan.items.some((item) => item.entity === '乙'), '乙（有条目在窗口内）不进归档计划，状态行也不碰')

  const next = applyArchive(doc, 40).doc

  assert.ok(next.groups['人物状态'] === undefined || next.groups['人物状态']['甲'] === undefined,
    '甲的状态行已搬走')
  assert.deepEqual(next.groups['人物状态']['乙'], ['`第60章` 现状：在山下镇上。'], '乙的状态保留')
  // 身份锚仍在活分区（第二刀的性质不回退）
  assert.ok((next.groups['人物']['甲'] ?? []).some((entry) => entry.includes('最后')),
    '甲的身份锚（最新一条）留在活分区')
  // 冷档案里能找到那行状态
  const cold = JSON.stringify(next.groups['冷档案'] ?? {})
  assert.ok(cold.includes('在山腰养伤'), `状态行原文进了冷档案：${cold.slice(0, 120)}`)
})

test('注入上限：主体多于 `backgroundStateMaxSubjects` 时只带**最近的几个**（2026-10-03 读者拍板）', () => {
  // ⚠️ 这一节服务的是**聊天时的陪读 AI**，它只需要一件事：**此刻在场的人站在哪边**。
  //    而"在场"最好的代理就是**状态行自己的章号** —— 那正是它上一次被更新的时刻。
  //    ⚠️ 这是**有意的覆盖面牺牲**：被截掉的人只剩「人物」里的**身份锚**（他最后在干嘛），
  //    拿不到一句现状 —— 那正是**冷归档之后本来就有的形状**，不是新增损失。
  //    换来的是**注入预算有界**：≤ 8 × 30 字，不随书长。
  const total = HOST_DEFAULTS.backgroundStateMaxSubjects + 3
  const lines = []
  for (let i = 1; i <= total; i += 1) {
    // 章号随 i 递增 ⇒ `人1` 最早、`人${total}` 最近 ⇒ 该留下的是**章号大的那几个**。
    lines.push(`### 人${i}`, `- \`第${i * 10}章\` 人${i}在此。`)
  }
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..200 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    ...lines,
  ].join('\n'))

  const { text, filtered } = renderBackgroundForPrompt(doc, { budgetChars: 9000 })
  const shown = (text.match(/^### 人\d+$/gm) ?? []).length
  assert.equal(
    shown,
    HOST_DEFAULTS.backgroundStateMaxSubjects,
    `只带 ${HOST_DEFAULTS.backgroundStateMaxSubjects} 个主体（上限来自 HOST_DEFAULTS，不是这里的字面量）`,
  )
  assert.ok(text.includes(`### 人${total}`), '章号最大的（最近的）一定在')
  assert.ok(text.includes(`### 人${total - HOST_DEFAULTS.backgroundStateMaxSubjects + 1}`), '留下的正是章号最大的那几个')
  assert.ok(!text.includes(`### 人${total - HOST_DEFAULTS.backgroundStateMaxSubjects}\n`), '再往前一个就被截掉了')
  // 「截了就要说」：被截掉的主体数要报出来，否则"我以为 AI 看得到他现在的立场"没人看得见。
  const capped = filtered.filter((item) => item.name === BACKGROUND_STATE_SECTION && item.dropped > 0)
  assert.equal(capped.length, 1, '上限截断要进 filtered')
  assert.equal(capped[0].dropped, 3, '报的是**被截掉的主体数**')

  // 上限可被调用方覆盖（测试钩子，与 `budgetChars` 同一个口径）。
  const small = renderBackgroundForPrompt(doc, { budgetChars: 9000, maxStateSubjects: 2 })
  assert.equal((small.text.match(/^### 人\d+$/gm) ?? []).length, 2, '`maxStateSubjects` 要能覆盖上限')
})

test('注入上限**不碰散行块**：`###` 前缀遗失（手工编辑过的文件）时行照样全部渲染', () => {
  // ⚠️ 散行没有主体可数，硬按"行数"截会砍掉**不同人的半截** —— 比多花点预算糟得多。
  //    （`background.js` 本来就有这条兜底：状态行丢了比它少个标题严重得多。）
  const many = Array.from(
    { length: HOST_DEFAULTS.backgroundStateMaxSubjects + 4 },
    (_, i) => `- \`第${i + 1}章\` 第 ${i + 1} 个人的现状。`,
  )
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..100 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    ...many,
  ].join('\n'))
  const { text } = renderBackgroundForPrompt(doc, { budgetChars: 9000 })
  assert.equal((text.match(/个人的现状/g) ?? []).length, many.length, '散行一行都不许丢')
})

test('上限的**唯一来源**：注入侧与补齐侧读的是同一个常量（不是两个字面量碰巧同值）', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const bg = read('../lib/host/background.js')
  assert.match(bg, /HOST_DEFAULTS\.backgroundStateMaxSubjects/, '注入侧的兜底要读 `HOST_DEFAULTS`')
  const pipeline = read('../lib/host/memory-pipeline.js')
  assert.match(pipeline, /HOST_DEFAULTS\.backgroundStateMaxSubjects/, '补齐侧交给子代理的名单要按**同一个**上限截')
  assert.doesNotMatch(pipeline, /slice\(0,\s*\d+\)/, '不许在补齐侧另写一个字面量上限')
})

test('「人物状态」的**散行**同样是替换、不是追加（2026-10-03 体检：4/4 真实文件这一节都是散行，那个覆盖例外一次都没生效过）', () => {
  // ⚠️ 从前**散行**掉进普通追加 ⇒ "下一批又写一遍现状"会**越长越多**，而这一节的语义是
  //    "**此刻**的现状"（全文件唯一的覆盖例外）。分组那一支一直是对的，散行这一支没有 ——
  //    而现实里 4/4 真实文件的这一节都是散行（提示词曾把它教成平铺）。
  //    可证伪：把 `mergeBackground` 里那段散行替换分支删掉 ⇒ 第一条断言红（实测过）。
  const base = parseBackground(md(['- 第3章 甲 还在山门。']))
  const add = parseBackground([
    '<!-- drc-background: schema=1 covered=9..9 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '- 第9章 甲 已经下山。',
  ].join('\n'))
  const merged = mergeBackground(base, add, { first: 9, last: 9 })
  assert.deepEqual(
    merged.sections[BACKGROUND_STATE_SECTION],
    ['第9章 甲 已经下山。'],
    '散行也必须"新的顶掉旧的"，不许越长越多',
  )
  assert.ok(
    merged.retired.some((entry) => entry.includes('还在山门')),
    '旧的**原文**要搬进「已取代」—— 归档不是删除',
  )
})

test('冷归档：**散行**节不许被搬空（2026-10-03 体检：28 条平铺「人物」越过活跃窗口后 AI 一个人都不认识）', () => {
  // ⚠️ 分组形态按**主体**留最新一条（"他是谁"）；散行没有主体可数，从前**一条都不留**
  //    ⇒ 真实文件里 28 条平铺人物会**整节**出窗口，而冷档案**永不注入** ⇒ AI 一个人都不认识。
  //    可证伪：把 `planArchive` 里那段散行身份锚删掉 ⇒ 第一条断言红（实测过）。
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..100 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物',
    '- 第2章 甲 出身寒门。',
    '- 第4章 乙 是甲的同门。',
  ].join('\n'))
  const plan = planArchive(doc, 40)
  const moved = plan.items
    .filter((item) => item.section === '人物')
    .flatMap((item) => item.entries)
  assert.equal(moved.length, 1, '两条都出窗口时只搬走一条 —— 必须留最新的一条当身份锚')
  assert.ok(moved[0].includes('出身寒门'), '搬走的是更早那条（第 2 章），留下的必须是最新那条')
})
