/**
 * 「人物卡」：把背景认识里**「人物」这一节**按主体归堆、并按"读者读到第几章"过滤。
 *
 * 三条盯的东西：
 *   ① **只取「人物」一节** —— 世界观 / 通用概念里的是设定与概念（真机反馈：
 *      《魔女霓裳》里「廿年之约 / 缘 / 情分 / 心魔 / 作者有话要说」全被当成了人物卡）；
 *      人物关系的主体是**成对**的（`### 甲 × 乙`），也不在这里；
 *   ② **章号过滤**与注入侧同一条边界（条目里最早的章号都超过当前章的丢掉）；
 *   ③ **没写章号的条目一律保留** —— 读者手写的或通用设定不该被章号过滤误伤。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { entityCardsFor, parseBackground } from '../lib/host/background.js'

const MD = [
  '## 人物关系',
  '### 甲 × 乙',
  '- `第3章` 师徒',
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
  assert.ok(!names.some((name) => name.includes('×')), '人物关系的主体是成对的，另算')
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
