/**
 * T3：背景认识的**分层降级**（粗粒度那一级）。
 *
 * ## 这一级在解决什么
 *
 * §197 把背景认识的两个轴说清了：轴 1 是**深度**（一章抽到多少正文），轴 2 是
 * **合并比**（多少章的条目挤得进 `backgroundBudgetChars`）。两者反向，而 T3 的
 * 结构性出路不是"加预算"，是**让同一份预算装下更多主体**。
 *
 * 做法是在既有的降级阶梯**中间插一级**。旧阶梯是：按权重分额度 → 装不下就按
 * "近期优先"丢单元。新阶梯多一层：装不下的单元先降为**粗粒度**（`### 主体` +
 * 它名下章号最晚的那一条），粗粒度也装不下才丢。
 *
 * ## 为什么这一级可以默认开
 *
 * 因为它是**纯补位**，这是本节全部断言围绕的性质：
 *   - `kept` 的算法一个字符都没改，粗粒度只在**本来会被丢掉**的单元里补位；
 *   - 于是预算充足时（没有单元被跳过）**输出逐字节不变**；
 *   - 预算紧张时，每个原本会显示的单元仍然原样显示，只是**多**了一批原本会
 *     消失的主体。集合意义上是严格单调的：`新 ⊇ 旧`。
 *
 * 所以这里钉四件事：**充足时逐字节相同**、**紧张时严格补位（单调）**、
 * **粗粒度只留最新一条且不说谎**、**一行条目不会被"假降级"**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseBackground, renderBackgroundForPrompt } from '../lib/host/background.js'

/** 一批"每个主体名下都有好几条记载"的背景认识。 */
function fatDoc({ characters = 6, linesEach = 4 } = {}) {
  const out = ['<!-- drc-background: schema=1 covered=1..60 -->', '## 人物']
  for (let c = 1; c <= characters; c += 1) {
    out.push(`### 角色${c}`)
    for (let l = 1; l <= linesEach; l += 1) {
      out.push(`- \`第${l}章\` 角色${c}的第${l}条记载${'细'.repeat(8)}`)
    }
  }
  return parseBackground(out.join('\n'))
}

/** 输出里出现过的主体名（`### 名字`）。 */
const subjectsIn = (text) => [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1])

// ------------------------------------------------------------------ 充足时不变

test('分层：预算充足时**逐字节相同**——这一级不参与，就等于没有它', () => {
  const doc = fatDoc()
  const on = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 60 })
  const off = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 60, coarseDegrade: false })

  assert.equal(on.text, off.text, '预算充足时开与关必须一个字节都不差')
  assert.deepEqual(on.coarsened, [], '没有单元被跳过，就不该有单元被粗化')
  assert.deepEqual(on.trimmed, [], '也不该有单元被丢弃')
  assert.equal(on.text.includes('只列出最近一条记载'), false, '不该出现粗粒度说明')
})

// ------------------------------------------------------------------ 紧张时补位

test('分层：预算紧张时严格补位——原本会显示的一个不动，只是**多**了一批主体', () => {
  const doc = fatDoc()
  const budgetChars = 700
  const off = renderBackgroundForPrompt(doc, { budgetChars, progressIndex: 60, coarseDegrade: false })
  const on = renderBackgroundForPrompt(doc, { budgetChars, progressIndex: 60 })

  // 先把前提钉住：这个预算真的紧张到会丢单元，否则下面全是平凡的真话。
  assert.ok(off.trimmed.length > 0, '这个预算必须真的触发丢弃，否则这条用例没有信息量')
  assert.ok(on.coarsened.length > 0, '开了分层就必须真的有主体被粗化')

  const before = subjectsIn(off.text)
  const after = subjectsIn(on.text)
  assert.ok(before.length > 0)

  // ★ 单调性：原来显示的主体**一个都不能少**。
  for (const name of before) {
    assert.ok(after.includes(name), `原本显示的主体「${name}」在开了分层之后消失了`)
  }
  // ★ 而且真的多了。
  assert.ok(after.length > before.length, `主体数应当变多：${before.length} → ${after.length}`)

  // ★ 顺序必须与 `background.md` 一致（角色1 → 角色N）。粗粒度单元与完整单元混排
  //   时最容易写成"粗的全塞前面"——那样模型看到的次序就与文件对不上，排查时会
  //   怀疑人生。（这一条是被一次变异逼出来的：M9 把所有粗粒度单元插到最前面，
  //   当时没有任何断言看得见。）
  const order = after.map((name) => Number(name.replace('角色', '')))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `主体顺序被打乱：${after.join('、')}`)

  // 丢掉的单元数必须相应减少——这是"补位"而不是"换一批"。
  const droppedOff = off.trimmed.reduce((sum, t) => sum + t.dropped, 0)
  const droppedOn = on.trimmed.reduce((sum, t) => sum + t.dropped, 0)
  assert.ok(droppedOn < droppedOff, `被丢弃的单元数应当下降：${droppedOff} → ${droppedOn}`)
})

test('分层：粗粒度留的是**章号最晚**的那一条，而且明说自己是压缩过的', () => {
  const doc = fatDoc({ characters: 1, linesEach: 4 })
  // 预算小到只装得下 `### 角色1` + 一条记载。
  const out = renderBackgroundForPrompt(doc, { budgetChars: 120, progressIndex: 60 })
  const coarsened = out.coarsened.find((entry) => entry.name === '人物')
  assert.ok(coarsened !== undefined, `人物这一节应当出现粗粒度：${JSON.stringify(out.coarsened)}`)

  // 最新的一条在，更早的不在。
  assert.match(out.text, /第4章` 角色1的第4条记载/)
  assert.doesNotMatch(out.text, /第1章` 角色1的第1条记载/)

  // ⚠️ 说明句是**承重的**：一个只带一条记载的 `### 角色1` 会被模型读成"角色1
  // 只做过这一件事"。不说清，粗粒度就从"少给一点"变成"给错的信息"。
  assert.match(out.text, /只列出最近一条记载/)
  assert.match(out.text, /完整内容在 background\.md 里/)
})

test('分层：只有一个主体、且额度连它都装不下时，说明句不出现（没有粗化就别声称粗化）', () => {
  const doc = parseBackground(['## 人物', '### 甲', '- `第1章` 唯一一条'].join('\n'))
  const out = renderBackgroundForPrompt(doc, { budgetChars: 40, progressIndex: 60 })
  // 它只有一行，粗化省不下任何东西 → 要么原样显示、要么整节丢弃，不存在"半显示"。
  assert.deepEqual(out.coarsened, [], '一行条目不该被当成"粗化了"')
})

test('分层：散条目（本来就只有一行）不会被"假降级"占位', () => {
  const doc = parseBackground([
    '## 文风',
    '- 叙述视角偏冷（`第1章`）',
    '- 句子短促，少用形容词（`第2章`）',
    '## 前文脉络',
    '- `第1-3章` 初遇',
  ].join('\n'))

  const off = renderBackgroundForPrompt(doc, { budgetChars: 200, progressIndex: 60, coarseDegrade: false })
  const on = renderBackgroundForPrompt(doc, { budgetChars: 200, progressIndex: 60 })

  // 一行条目没有"粗粒度形态"可言，所以这一级对它们必须**完全没有影响**。
  assert.deepEqual(on.coarsened, [])
  assert.equal(on.text, off.text)
})

test('分层：说明句里的数量与实际被粗化的主体数一致（别写一句对不上的话）', () => {
  const doc = fatDoc({ characters: 8, linesEach: 4 })
  const out = renderBackgroundForPrompt(doc, { budgetChars: 700, progressIndex: 60 })
  const claimed = out.coarsened.reduce((sum, entry) => sum + entry.coarsened, 0)
  assert.ok(claimed > 0, '这个预算必须真的粗化出主体，否则这条用例没有信息量')
  const matched = /本节有 (\d+) 个主体只列出最近一条记载/.exec(out.text)
  assert.ok(matched !== null, `应当出现说明句：${out.text.slice(0, 200)}`)
  assert.equal(Number(matched[1]), claimed, '说明句里的数字必须与实际一致')
})

test('分层：它只用**剩余空间**，不做置换——有些预算点上一点忙都帮不上，而那是对的', () => {
  // 这一条是被一次真实现象逼出来的：同一个夹具、预算 500 时 `coarsened` 是**空的**，
  // 而预算 700 时粗化了 3 个。原因不是 bug，是这一级的设计边界：
  //
  //   完整单元 ~111 字、粗粒度单元 ~33 字。预算 500 时，完整单元先把额度用到只剩
  //   17 字——**装不下任何一个粗粒度单元**（33 > 17），于是它一个都补不进去。
  //
  // 而它**刻意不做置换**（"丢掉一个完整单元，换三个粗粒度单元"在这里能多表示
  //   2 个主体，覆盖率更高）。理由：置换会把"本来能完整显示的主体"降级，破坏
  //   "kept 一个都不动"这条最强的性质——而这条性质正是它敢默认开的原因。
  //   宁可在某些预算点上少帮一点忙，也不要让一次降级改动去动已经显示好的内容。
  const doc = fatDoc({ characters: 8, linesEach: 4 })
  const tight = renderBackgroundForPrompt(doc, { budgetChars: 500, progressIndex: 60 })
  const roomy = renderBackgroundForPrompt(doc, { budgetChars: 700, progressIndex: 60 })

  assert.deepEqual(tight.coarsened, [], '剩余空间不足时，粗粒度一级帮不上忙')
  assert.ok(tight.trimmed.length > 0, '于是该丢的还是丢——如实报告')
  assert.ok(roomy.coarsened.length > 0, '空间够时它才补位')

  // 不论哪种情况，都没出现"粗化了却还声称丢了更多"这种自相矛盾。
  for (const entry of tight.trimmed) assert.ok(entry.dropped >= 0)
})
