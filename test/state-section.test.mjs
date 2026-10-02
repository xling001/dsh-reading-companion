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
