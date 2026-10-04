/**
 * 「人物卡」：把背景认识里**「人物」这一节**按主体归堆、并按"读者读到第几章"过滤。
 *
 * 三条盯的东西：
 *   ① **只取「人物」一节** —— 世界观 / 通用概念里的是设定与概念（真机反馈：
 *      《魔女霓裳》里「廿年之约 / 缘 / 情分 / 心魔 / 作者有话要说」全被当成了人物卡）；
 *      人物关系是**成对**的（`- 甲 ↔ 乙：…`），也不在这里；
 *   ② **章号过滤**与注入侧同一条边界（条目里最早的章号都超过当前章的丢掉）；
 *   ③ **没写章号的条目一律保留** —— 读者手写的或通用设定不该被章号过滤误伤。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { entityCardsFor, parseBackground } from '../lib/host/background.js'

const MD = [
  '## 人物关系',
  '- 甲 ↔ 乙：`第3章` 师徒',
  '',
  '## 人物',
  '### 甲',
  '- `第1章` 出场的少年',
  '- `第40章` 当上了掌门',
  '### 乙',
  '- `第900章` 才登场',
  '### 丙',
  '- 读者手写的一条，没写章号',
  '',
  '## 世界观',
  '### 某门派',
  '- `第2章` 三块大陆',
  '',
  '## 通用概念',
  '### 廿年之约',
  '- `第5章` 一个约定',
  '',
].join('\n')

test('人物卡：只取「人物」一节 —— 世界观 / 通用概念 / 人物关系 都不算人', () => {
  const doc = parseBackground(MD)
  const names = entityCardsFor(doc, null).map((card) => card.name)
  // 两边都排序再比，免得把中文字符的码点顺序当成断言内容。
  assert.deepEqual([...names].sort(), ['丙', '乙', '甲'].sort(), '只有「人物」一节里的主体才出卡')
  assert.ok(!names.includes('廿年之约'), '通用概念里的是概念，不是人（真机反馈的第一例）')
  assert.ok(!names.includes('某门派'), '世界观里的是设定，不是人')
  assert.ok(!names.some((name) => name.includes('↔')), '人物关系是成对的，另算')
})

test('人物卡排序：**有关系的人排最前**（"主要人物"），不是按话多话少', () => {
  const cards = entityCardsFor(parseBackground(MD), null)
  const names = cards.map((card) => card.name)
  // 甲、乙 挂在「人物关系」的 `### 甲 × 乙` 上 ⇒ 他们"有自己的线"；丙 一条关系都没有。
  assert.deepEqual(names, ['乙', '甲', '丙'], '有关系的排前面；同有关系时按"最近说到"')
  // ⚠️ 判据要能被读出来：面板将来想标"主要"、或读者想核对排序，都靠这个字段。
  assert.equal(cards.find((card) => card.name === '甲').relations, 1, '甲 挂着一条关系')
  assert.equal(cards.find((card) => card.name === '丙').relations, 0, '丙 没有关系')
})

test('人物卡：按"读者读到第几章"过滤；没写章号的条目一律保留', () => {
  const doc = parseBackground(MD)

  // 读到第 50 章（0 起 49）：甲的两条都在（1、40 ≤ 50）；乙整张卡消失（900 太靠后）；
  // 丙那条没写章号 → 保留。
  const at50 = entityCardsFor(doc, 49)
  assert.deepEqual([...at50.map((card) => card.name)].sort(), ['丙', '甲'].sort())
  const jia = at50.find((card) => card.name === '甲')
  assert.equal(jia.entries.length, 2)
  assert.equal(jia.latest, 40, '最新的章号要如实报出来（界面用它显示"最新：第 N 章"）')
  assert.equal(jia.earliest, 1)

  // 读到第 1 章：甲只剩第一条（40 那条被挡掉）—— 这就是"进度门控"的意义。
  const at1 = entityCardsFor(doc, 0)
  assert.equal(at1.find((card) => card.name === '甲').entries.length, 1)
  assert.ok(at1.some((card) => card.name === '丙'), '没章号的条目在任何进度下都在')

  // 排序：按**最新章号**降序（"最近说到的排前面"）。甲 40 → 丙 0。
  assert.deepEqual(entityCardsFor(doc, 49).map((card) => card.name), ['甲', '丙'])
})

test('主要人物排序：关系数按**条目开头的双方**数（平铺「人物关系」）', () => {
  // ⚠️ 「人物关系」2026-10-04 改回平铺之后，关系的主体写在**条目开头**
  //    （`- 甲 ↔ 乙：…`）⇒ 双方的名字都在正文里，"名字出现在条目里"这一条判据就够。
  //    （从前还有一条分支数"关系挂在有卡的人名下"那种形状（`### 甲` + `- 与某人：关系`，
  //     条目正文里**没有甲**）—— 那是 2026-10-02 被读者**否掉**的实验形状；
  //     平铺之后 `groups['人物关系']` 恒空，那条分支再也走不到，已随本次改动删掉。）
  const doc = parseBackground([
    '## 人物关系',
    '- 孟奇 ↔ 顾小桑：互相试探 → 结盟（`第30章`）',
    '- 孟奇 ↔ 江芷微：同门（`第5章`）',
    '## 人物',
    '### 孟奇',
    '- `第3章` 穿越成杂役僧',
    '### 顾小桑',
    '- `第29章` 第一次见面',
    '### 江芷微',
    '- `第5章` 同门师姐',
  ].join('\n'))

  const cards = entityCardsFor(doc, 99)
  const by = Object.fromEntries(cards.map((card) => [card.name, card.relations]))
  assert.equal(by['孟奇'], 2, '孟奇出现在两条关系里 ⇒ 2')
  assert.ok(by['顾小桑'] >= 1, `「顾小桑」也必须数得到（实际 ${by['顾小桑']}）`)
  assert.ok(by['江芷微'] >= 1, `「江芷微」同理（实际 ${by['江芷微']}）`)
  assert.equal(cards[0].name, '孟奇', '关系多的排最前（不再退化成"按最近说到"）')

  // ⚠️ 反向：**一对都没提到的第三个人**不该凭空拿到关系数。
  const bystander = parseBackground([
    '## 人物关系',
    '- 甲 ↔ 乙：同门（`第1章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 出场',
    '### 丙',
    '- `第2章` 出场',
  ].join('\n'))
  const byStand = Object.fromEntries(entityCardsFor(bystander, 99).map((c) => [c.name, c.relations]))
  assert.equal(byStand['丙'], 0, '没被任何关系提到的「丙」必须是 0（否则排序全是并列）')
})
