/**
 * 背景认识的分区层（P13）。
 *
 * 这一轮加了第五个分区「文风」，并**接通了权重表**。后者值得专门说明：
 * `BACKGROUND_SECTION_WEIGHTS` 早就导出了、文档里也引用了，但分配代码用的是
 * `available / sections.length`（均分）—— 它**从来没被读过**。也就是说"调权重"
 * 是个空动作，改档位、改权重都毫无效果，只有分区顺序真的生效。
 *
 * 这里钉住四件事：
 *
 *   1. **顺序与权重是同一件事的两种表达**：权重必须严格递减，且与
 *      `BACKGROUND_SECTIONS` 的顺序一致。两者一旦错位，"谁是重点"就没有唯一答案。
 *   2. **权重真的被执行**：同一份内容、同一份预算，只改权重表就会改分配结果。
 *      这条是专门用来防"权重又变成死代码"的。
 *   3. **旧文件向后兼容**：`background.md` 是用户可能手改过的文件，加一节
 *      不能让已有的解析崩掉或丢内容。
 *   4. **「文风」天然防剧透**：它是唯一一个不含剧情信息的分区。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BACKGROUND_SECTIONS,
  BACKGROUND_SECTION_WEIGHTS,
  parseBackground,
  renderBackgroundForPrompt,
  emptyBackground,
} from '../lib/host/background.js'

test('分区：六个小节，顺序与权重严格同序', () => {
  assert.deepEqual(
    [...BACKGROUND_SECTIONS],
    ['人物关系', '人物', '世界观', '文风', '前文脉络', '通用概念'],
  )

  // 每个分区都必须有权重，否则分配时会静默拿到 0（= 永远被整节丢弃）。
  for (const name of BACKGROUND_SECTIONS) {
    assert.equal(
      typeof BACKGROUND_SECTION_WEIGHTS[name],
      'number',
      `分区「${name}」没有权重 —— 分配时它会静默拿到 0`,
    )
  }
  assert.equal(
    Object.keys(BACKGROUND_SECTION_WEIGHTS).length,
    BACKGROUND_SECTIONS.length,
    '权重表里有 BACKGROUND_SECTIONS 之外的多余条目',
  )

  // 严格递减，且与顺序一致。顺序是"超预算时从后往前丢"的依据，权重是
  // "先按权重保底"的依据 —— 两者必须给出同一个优先级，否则没有唯一答案。
  for (let i = 1; i < BACKGROUND_SECTIONS.length; i += 1) {
    const prev = BACKGROUND_SECTION_WEIGHTS[BACKGROUND_SECTIONS[i - 1]]
    const next = BACKGROUND_SECTION_WEIGHTS[BACKGROUND_SECTIONS[i]]
    assert.ok(
      prev > next,
      `「${BACKGROUND_SECTIONS[i - 1]}」(${prev}) 必须比「${BACKGROUND_SECTIONS[i]}」(${next}) 重`,
    )
  }

  // 权重和是 1：它是预算的份额，和不为 1 意味着保底总额超出或不足预算。
  const sum = Object.values(BACKGROUND_SECTION_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应当是 1，实际 ${sum}`)

  // ★ 加「通用概念」**不能**改变原五节的相对份额。分配只用比值（注水法的除数
  // 是"还饿着的那些节的权重和"），所以"原比例 15:13:9:7:6 乘同一个因子"是
  // 唯一不改变小说行为的加法。把它写成断言，是因为这条性质**看不见**——
  // 一旦有人为了凑出漂亮的小数把原五节各减一点，小说那边的分配就悄悄变了。
  const original = [15, 13, 9, 7, 6]
  const factor = BACKGROUND_SECTION_WEIGHTS['人物关系'] / original[0]
  original.forEach((part, index) => {
    assert.ok(
      Math.abs(BACKGROUND_SECTION_WEIGHTS[BACKGROUND_SECTIONS[index]] - part * factor) < 1e-12,
      `「${BACKGROUND_SECTIONS[index]}」的相对份额变了：原比例 ${original.join(':')} 不再成立`,
    )
  })
  // 兜底那节的份额必须**小于**原表里最小的那一节（它是最后一名）。
  assert.ok(
    BACKGROUND_SECTION_WEIGHTS['通用概念'] < BACKGROUND_SECTION_WEIGHTS['前文脉络'],
    '「通用概念」是兜底，权重必须最低',
  )
})

/**
 * 造一份"六节都有、每节条目够多"的文档。
 *
 * 两处刻意：
 *
 *   - 条目做**短**。渲染时是按**整条**取舍的，条目越长粒度越粗——权重差 0.02
 *     带来的几十个字符落不满一条时，量出来的长度会一样。那不是权重没生效，
 *     是尺子不够细。
 *   - `人物` 节用**多个角色、每人少量条目**。「人物」的取舍单元是**一位角色**
 *     （见 `sectionUnits` 的说明：拆到条目粒度会产出"甲有八条、乙一条都没有"
 *     这种读起来像残缺的东西）。若把所有条目挂在同一个角色名下，它就是一条
 *     200 多字符、非全有即全无的巨块，预算稍紧就整节消失——那是夹具的形状
 *     问题，不是分配的问题。
 *
 * 兜底那节也放内容：只有**每节都有内容**时，"额度严格随权重递减"才是对
 * 六节全体的断言，而不是默默跳过一个空分区。
 *
 * @param {number} perSection 每节条目数
 * @returns {object} 解析结果
 */
function measureDoc(perSection = 20) {
  const entries = (label, count = perSection) => Array.from(
    { length: count },
    (_, i) => `- \`第${i + 1}章\` ${label}${i}`,
  )
  const cast = Array.from({ length: 8 }, (_, c) => [
    `### 甲${c}`,
    ...entries('身份', 3).map((line, i) => `${line}${i}${c}`),
  ]).flat()

  return parseBackground([
    '## 人物关系', ...entries('关系'), '',
    '## 人物', ...cast, '',
    '## 世界观', ...entries('设定'), '',
    '## 文风', ...entries('风格'), '',
    '## 前文脉络', ...entries('脉络'), '',
    '## 通用概念', ...entries('概念'),
  ].join('\n'))
}

test('分区：权重真的被执行（不是死代码）', () => {
  const doc = measureDoc()

  // ★ 差分断言：同一份内容、同一份预算，**只换权重表**，分配结果必须不同。
  //
  // 这是唯一能证明"权重表被读过"的写法。历史上它被写过两次死代码：第一次是
  // 注释说按权重、实现用均分；第二次是"按权重给保底"但被统一的比例封顶，
  // 于是每节保底一模一样。两次都全绿，因为没有任何断言在**比较**两种权重。
  //
  // 断言打在 `allowances`（分配结果）而不是渲染出的字符数上：后者按整条取舍，
  // 量化噪声会把权重差异吃掉。
  const base = { budgetChars: 900, progressIndex: 24 }
  const normal = renderBackgroundForPrompt(doc, base).allowances

  // 把权重整个倒过来：「前文脉络」变成最重的那一节。
  const flipped = renderBackgroundForPrompt(doc, {
    ...base,
    weights: { 人物关系: 0.12, 人物: 0.12, 世界观: 0.12, 文风: 0.12, 前文脉络: 0.52 },
  }).allowances

  assert.ok(
    flipped['前文脉络'] > normal['前文脉络'],
    `把「前文脉络」的权重拉到 0.52 之后它必须变大：${flipped['前文脉络']} vs ${normal['前文脉络']}`,
  )
  assert.ok(
    flipped['人物关系'] < normal['人物关系'],
    `相应的「人物关系」必须变小：${flipped['人物关系']} vs ${normal['人物关系']}`,
  )
})

test('分区：默认权重下，额度严格随权重递减且每节都露头', () => {
  const doc = measureDoc()
  const { allowances, omitted } = renderBackgroundForPrompt(doc, { budgetChars: 900, progressIndex: 24 })

  // 每一节都要露头。整节消失的输出读起来像"这本书没有人物"，那正是保底存在的
  // 理由，而**保底与权重无关**——它是统一的一份，不能被权重挤掉。
  assert.deepEqual(omitted, [], '预算够时不该有分区被整节丢弃')

  const values = BACKGROUND_SECTIONS.map((name) => {
    assert.ok(allowances[name] > 0, `「${name}」没有拿到任何额度`)
    return { name, value: allowances[name] }
  })

  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i - 1].value > values[i].value,
      `额度必须严格随权重递减：「${values[i - 1].name}」${values[i - 1].value} `
      + `vs 「${values[i].name}」${values[i].value}`,
    )
  }
})

test('分区：旧文件（没有「文风」节）能正常解析，新节为空而不是报错', () => {
  // 这是加分区时最容易翻车的地方：用户的 background.md 是**手改过**的文件，
  // 加一节不能让已有的内容掉进 unknown，也不能抛错。
  const legacy = [
    '<!-- drc-background: schema=1 covered=1..9 -->',
    '# 《旧书》· 背景认识',
    '',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第3章`）',
    '',
    '## 人物',
    '### 甲',
    '- `第1章` 剑客',
    '',
    '## 世界观',
    '- `第1章` 有个门派',
    '',
    '## 前文脉络',
    '- `第1-9章` 一路打上来',
  ].join('\n')

  const doc = parseBackground(legacy)
  assert.deepEqual(doc.covered, { first: 1, last: 9 })
  assert.deepEqual(doc.sections['人物关系'], ['甲 ↔ 乙：对手（`第3章`）'])
  assert.deepEqual(doc.sections['世界观'], ['`第1章` 有个门派'])
  assert.deepEqual(doc.sections['文风'], [], '旧文件没有这一节时应当是空数组，不是 undefined')
  assert.deepEqual(doc.characters['甲'], ['`第1章` 剑客'])
  assert.equal(doc.unknown.trim(), '', '已有的四节内容不该掉进 unknown')
})

test('分区：空骨架里六个节的标题都在（用户打开文件就能看见该往哪写）', () => {
  const skeleton = emptyBackground('某书')
  for (const name of BACKGROUND_SECTIONS) {
    assert.match(skeleton, new RegExp(`^## ${name}$`, 'm'), `空骨架缺少「${name}」节`)
  }
})

test('分区：「文风」能存能渲染（描述叙述特征，不含剧情）', () => {
  const doc = parseBackground([
    '## 文风',
    '- `第1章` 第三人称限知，短句为主，对话密集',
    '- `第1章` 善用天气与器物作比喻，几乎不用感叹号',
  ].join('\n'))

  assert.equal(doc.sections['文风'].length, 2)
  const out = renderBackgroundForPrompt(doc, { budgetChars: 6000 })
  assert.match(out.text, /### 文风/)
  assert.match(out.text, /第三人称限知/)
})

/**
 * 倒退过滤：读者跳到了记忆水位线**之前**。
 *
 * 这是这一轮修的**不可逆**缺陷。旧实现只在"落后"方向发缺口警告
 * （`covered.last < lastReadable`），于是"读者在 1000 章补完记忆、又回到
 * 50 章"这一情形**完全静默**：第 900 章的条目被原样注入。
 *
 * 判据是"最早章号"而不是"最晚章号"：一位人物若在第 5 章和第 900 章都有
 * 条目，他**必须整块保留**——他在第 5 章就已经是这个人了。
 */
test('倒退过滤：丢掉"最早章号都超出上界"的单元，没带章号的一律保留', () => {
  const doc = parseBackground([
    '## 世界观',
    '- `第900章` 那个后来才知道的真相',
    '- `第3章` 开篇就交代的门派',
    '- 通用设定：这个世界有灵气', // 刻意不带章号
  ].join('\n'))

  const out = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 50, maxChapter: 50 })

  assert.doesNotMatch(out.text, /后来才知道的真相/, '第 900 章的条目必须被挡住')
  assert.match(out.text, /开篇就交代的门派/, '第 3 章的条目必须留下')
  assert.match(out.text, /这个世界有灵气/, '没带章号的条目不该被章号过滤误伤')
  assert.deepEqual(out.filtered, [{ name: '世界观', dropped: 1 }])
})

test('倒退过滤：一位人物只要有早于上界的条目，他整块都保留', () => {
  // 这是"用 earliest 而不是 recency 当判据"的专测。若误用 recency（最晚章号），
  // 这位在第 5 章登场、第 900 章还有戏的角色会被整块丢掉——那等于把他从书里删了。
  const doc = parseBackground([
    '## 人物',
    '### 甲',
    '- `第5章` 出场时是个学徒',
    '- `第900章` 后来成了掌门',
    '### 乙',
    '- `第800章` 才登场',
  ].join('\n'))

  const out = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 50, maxChapter: 50 })

  assert.match(out.text, /出场时是个学徒/)
  assert.match(out.text, /后来成了掌门/, '同一位人物名下的条目要跟着他一起保留')
  assert.doesNotMatch(out.text, /才登场/, '只出现在第 800 章的「乙」必须整块丢掉')
  assert.deepEqual(out.filtered, [{ name: '人物', dropped: 1 }])
})

test('倒退过滤：不给 maxChapter 时行为与不过滤逐字相同（默认不动）', () => {
  // 过滤会让这一段随进度变化，而它是缓存里最值钱的稳定前缀。所以这道闸
  // **必须**只由调用方显式打开——否则每次翻章都会毁掉前缀。
  const doc = parseBackground([
    '## 世界观',
    '- `第900章` 后期设定',
    '- `第3章` 早期设定',
  ].join('\n'))

  const plain = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 50 })
  const filtered = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 50, maxChapter: 50 })

  assert.match(plain.text, /后期设定/, '不传 maxChapter 时不该发生任何过滤')
  assert.deepEqual(plain.filtered, [])
  assert.deepEqual(filtered.filtered, [{ name: '世界观', dropped: 1 }])
  assert.notEqual(plain.text, filtered.text, '两条路径必须真的不同，否则这个接缝是死的')
})

test('倒退过滤：区间章号按**最早**那端判，`第5-9章` 在读到第 7 章时要保留', () => {
  // 专治一个**只在区间标记下才暴露**的错：判据若复用 `maxChapterIn` 那一套
  // （取区间的**后**端），`第5-9章` 会被判成"9 > 7，超前的"——而这条的起点是
  // 第 5 章，读者早就读过了。单章标记（`第7章`）下 `matched[1]` 与
  // `matched[2] ?? matched[1]` 恰好相等，所以这个错**不会**被单章用例抓到。
  const doc = parseBackground([
    '## 前文脉络',
    '- `第5-9章` 一段跨章的总述',
  ].join('\n'))

  const kept = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 6, maxChapter: 7 })
  assert.match(kept.text, /一段跨章的总述/, '区间起点 5 ≤ 7，必须保留')
  assert.deepEqual(kept.filtered, [])

  const dropped = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 3, maxChapter: 4 })
  assert.doesNotMatch(dropped.text, /一段跨章的总述/, '区间起点 5 > 4，必须丢掉')
  assert.deepEqual(dropped.filtered, [{ name: '前文脉络', dropped: 1 }])
})

test('倒退提示：covered.last 超过当前进度时明说"超出的已过滤"', () => {
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..999 -->',
    '## 世界观',
    '- `第3章` 早期设定',
  ].join('\n'))

  const back = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 50, maxChapter: 50 })
  assert.match(back.text, /覆盖到第 999 章/)
  assert.match(back.text, /已被过滤/)
  assert.doesNotMatch(back.text, /尚未\*\*纳入/, '倒退时不该发"尚未纳入"那条（方向相反）')

  // 正向（落后）时的措辞不变 —— 这条是回归保护。
  const ahead = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 1200 })
  assert.match(ahead.text, /第 1000–1200 章\*\*尚未\*\*纳入/)
  assert.doesNotMatch(ahead.text, /已被过滤/)

  // 边界：`progressIndex` 是 0 起，所以"正在读的那一章"是 `progressIndex + 1`。
  // 覆盖到那一章为止**不算**倒退——那一章整章本来就要投喂给模型。
  const atEdge = renderBackgroundForPrompt(
    parseBackground([
      '<!-- drc-background: schema=1 covered=1..51 -->',
      '## 世界观',
      '- `第3章` 早期设定',
    ].join('\n')),
    { budgetChars: 6000, progressIndex: 50 },
  )
  assert.doesNotMatch(atEdge.text, /已被过滤/, 'covered.last === 正在读的章号，不该报倒退')
})
