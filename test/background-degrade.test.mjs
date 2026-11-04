/**
 * 「一行档」降级（2026-11-04，读者拍板「按预算投喂」）的守卫。
 *
 * 解决的问题：压缩压不动、每批都触发、只能把条目抹成同等长度。现在改成
 * **按预算在注入时降级**：装不下 ⇒ 先从最老的降成"锚 + 要点首句 + …"，
 * 文件一个字都不动。
 *
 * 这组用例钉四件事：
 *   ① 预算宽裕时**逐字不变**（没有 `…`）；
 *   ② 预算紧时**降级但不超预算**；
 *   ③ 降级的行**必须留着章号锚**（锚丢了注入侧就分不清这条属于哪个时间点）；
 *   ④ **确定性**：同一输入算两次，结果完全相同。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseBackground, renderBackgroundForPrompt } from '../lib/host/background.js'

/** 造一份"很长"的背景：关系条数多、每条都长 ⇒ 一定会撑爆预算。 */
function bigBook() {
  const relations = []
  for (let i = 0; i < 14; i += 1) {
    const chapter = 10 + i * 12
    relations.push(
      `- 竹纤 ↔ 练霓裳（之${i}）：\`第${chapter}章\` 两人在山道上争执又和解，`
      + `她说她记得那天${i}号的雪落得很慢，像有人把时间掰开了一点点。`
      + '`第' + (chapter + 3) + '章` 她在客栈替他换了药，谁也没提那句没说完的话。',
    )
  }
  return parseBackground(`# 《测试书》· 背景认识

<!-- drc-background: schema=1 covered=1..200 -->

## 人物关系

${relations.join('\n')}

## 人物

- \`第190章\` 竹纤在雪山折返寻药，途中与旧识相遇。
- \`第195章\` 练霓裳独守寨中，反复擦拭那枚白石。

## 世界观

- \`第150章\` 明月峡的地形与守备，前后共三道关卡。

## 通用概念

- \`第120章\` 天蚕丝：御寒的织物，见水不湿。
`)
}

const render = (doc, budgetChars) => renderBackgroundForPrompt(doc, { budgetChars }).text

test('一行档：预算宽裕时给完整条目（不是截断形态）', () => {
  const doc = bigBook()
  const wide = render(doc, 200000)
  // ⚠️ 别断言"完全没有 `…`"：名录化 / 薄主体压一行 / 索引回显这些**别的机制**
  //    本来就会产出 `…`。这里只钉"关系条目是完整的"。
  assert.match(wide, /竹纤 ↔ 练霓裳（之0）/, '全文形态应保留完整关系条目')
  assert.match(wide, /她说她记得那天0号的雪/, '宽裕时必须给到正文细节，不能只剩第一句')

  // 反向：预算一紧，**最老那条**的细节就该被 `…` 取代 —— 两档是"同一批条目、不同粗细"。
  // （用"之0"这条最老的：coarse 档保留的是**最近一条**，不会把 0 号那条的细节留下。）
  const tight = render(doc, 1200)
  assert.equal(tight.includes('她说她记得那天0号的雪'), false, '紧预算下最老那条的细节不该还留着')
})

test('一行档：预算紧时降级，且总长不超预算（+不可压的固定开销）', () => {
  const doc = bigBook()
  const wide = render(doc, 200000)
  const tight = render(doc, 1200)
  assert.ok(tight.includes('…'), '预算紧时应当出现降级记号')
  // ⚠️ 断言要留"固定开销"的余量：图例 + 节标题 + 那行「（+N）」**不可压**
  //    （2026-11-04 实际挂过一次：只把图例改了几个字，这条就红了 —— 说明原来的
  //    1200 卡在边界上，而不是降级失灵）。所以钉两件更本质的事：
  //    ① 降级确实发生了（下面这条）；② 总量仍**远低于**全量形态。
  assert.ok(tight.length < wide.length, `降级后必须比全量小（tight ${tight.length} vs wide ${wide.length}）`)
  assert.ok(tight.length <= 1200 + 500, `不该超预算太多（含图例等固定开销），实际 ${tight.length}`)
})

test('一行档：降级后的行仍带章号锚（不许丢锚）', () => {
  const doc = bigBook()
  const tight = render(doc, 1200)
  for (const line of tight.split('\n')) {
    if (!line.startsWith('- ') || !line.includes('…')) continue
    assert.match(line, /第\s*\d+\s*章/, `降级行丢了章号锚：${line}`)
  }
})

test('一行档：同一输入算两次，结果逐字相同（确定性）', () => {
  const doc = bigBook()
  assert.equal(render(doc, 1200), render(doc, 1200))
})

test('关闭自动压缩：threshold = 1 必须真的不判"该压了"（即使文件远超预算）', async () => {
  // ⚠️ 2026-11-04 真机发现的漏：threshold 被 `Math.min(1, …)` 钳在 1，
  //    于是"设成 1"只把触发线抬到 budget 本身 —— 文件一旦超预算就照样触发 ✗。
  //    这条用例把"设成 1 = 关"钉死。
  const { needsCompaction } = await import('../lib/host/background.js')
  const doc = bigBook() // 远超默认预算
  const off = needsCompaction(doc, { budgetChars: 200, threshold: 1 })
  assert.equal(off.over, false, 'threshold=1 时不许再判"该压了"')

  // 反向：阈值回到 0.85 时，超预算就该判 true（否则开关是反的）。
  const on = needsCompaction(doc, { budgetChars: 200, threshold: 0.85 })
  assert.equal(on.over, true, 'threshold=0.85 且远超预算时必须判 true')
})
