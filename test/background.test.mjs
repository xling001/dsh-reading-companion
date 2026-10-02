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
 *      `BACKGROUND_INJECTED_SECTIONS` 的顺序一致。两者一旦错位，"谁是重点"就没有唯一答案。
 *   2. **权重真的被执行**：同一份内容、同一份预算，只改权重表就会改分配结果。
 *      这条是专门用来防"权重又变成死代码"的。
 *   3. **旧文件向后兼容**：`background.md` 是用户可能手改过的文件，加一节
 *      不能让已有的解析崩掉或丢内容。
 *   4. **「文风」天然防剧透**：它是唯一一个不含剧情信息的分区。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BACKGROUND_INJECTED_SECTIONS,
  BACKGROUND_SECTION_WEIGHTS,
  mergeBackground,
  parseBackground,
  renderBackground,
  renderBackgroundForPrompt,
  emptyBackground,
  countBeyondProgress,
  renderExistingForFill,
  FILL_INCREMENTAL_SECTIONS,
} from '../lib/host/background.js'
import { buildMemoryPrompt } from '../lib/host/memory.js'
import { buildCompactPrompt, COMPRESSIBLE_SECTIONS } from '../lib/host/compact.js'

test('分区：五个小节（「前文脉络」已并入「时间与分线」），顺序与权重严格同序', () => {
  assert.deepEqual(
    [...BACKGROUND_INJECTED_SECTIONS],
    ['人物关系', '人物', '世界观', '文风（只写一次）', '通用概念'],
  )

  // 每个分区都必须有权重，否则分配时会静默拿到 0（= 永远被整节丢弃）。
  for (const name of BACKGROUND_INJECTED_SECTIONS) {
    assert.equal(
      typeof BACKGROUND_SECTION_WEIGHTS[name],
      'number',
      `分区「${name}」没有权重 —— 分配时它会静默拿到 0`,
    )
  }
  assert.equal(
    Object.keys(BACKGROUND_SECTION_WEIGHTS).length,
    BACKGROUND_INJECTED_SECTIONS.length,
    '权重表里有 BACKGROUND_INJECTED_SECTIONS 之外的多余条目',
  )

  // 严格递减，且与顺序一致。顺序是"超预算时从后往前丢"的依据，权重是
  // "先按权重保底"的依据 —— 两者必须给出同一个优先级，否则没有唯一答案。
  for (let i = 1; i < BACKGROUND_INJECTED_SECTIONS.length; i += 1) {
    const prev = BACKGROUND_SECTION_WEIGHTS[BACKGROUND_INJECTED_SECTIONS[i - 1]]
    const next = BACKGROUND_SECTION_WEIGHTS[BACKGROUND_INJECTED_SECTIONS[i]]
    assert.ok(
      prev > next,
      `「${BACKGROUND_INJECTED_SECTIONS[i - 1]}」(${prev}) 必须比「${BACKGROUND_INJECTED_SECTIONS[i]}」(${next}) 重`,
    )
  }

  // 权重和是 1：它是预算的份额，和不为 1 意味着保底总额超出或不足预算。
  const sum = Object.values(BACKGROUND_SECTION_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应当是 1，实际 ${sum}`)

  // ★ 「前文脉络」并入后（3.0），**未并入者的相对份额保持不变**。原比例 15:13:9:7:6
  // 去掉脉络的 7 ⇒ 剩五节 15:13:9:6:5、分母 48 —— 它是"减少一节不改变其余分配"的唯一减法。
  // 把它写成断言，是因为这条性质**看不见**——一旦有人为了凑出漂亮的小数把原五节各减一点，
  // 小说那边的分配就悄悄变了。
  const original = [15, 13, 9, 6, 5]
  const factor = BACKGROUND_SECTION_WEIGHTS['人物关系'] / original[0]
  original.forEach((part, index) => {
    assert.ok(
      Math.abs(BACKGROUND_SECTION_WEIGHTS[BACKGROUND_INJECTED_SECTIONS[index]] - part * factor) < 1e-12,
      `「${BACKGROUND_INJECTED_SECTIONS[index]}」的相对份额变了：原比例 ${original.join(':')} 不再成立`,
    )
  })
  // 兜底那节的份额必须**小于**原表里最小的那一节（它是最后一名）。
  assert.ok(
    BACKGROUND_SECTION_WEIGHTS['通用概念'] < BACKGROUND_SECTION_WEIGHTS['文风（只写一次）'],
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
    // （3.0：「前文脉络」不再注入 —— 夹具随注入族走五节。）
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

  // 把权重整个倒过来：「通用概念」变成最重的那一节。
  const flipped = renderBackgroundForPrompt(doc, {
    ...base,
    weights: { 人物关系: 0.12, 人物: 0.12, 世界观: 0.12, '文风（只写一次）': 0.12, 通用概念: 0.52 },
  }).allowances

  assert.ok(
    flipped['通用概念'] > normal['通用概念'],
    `把「通用概念」的权重拉到 0.52 之后它必须变大：${flipped['通用概念']} vs ${normal['通用概念']}`,
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

  const values = BACKGROUND_INJECTED_SECTIONS.map((name) => {
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
  assert.deepEqual(doc.sections['文风（只写一次）'], [], '旧文件没有这一节时应当是空数组，不是 undefined')
  assert.deepEqual(doc.characters['甲'], ['`第1章` 剑客'])
  assert.equal(doc.unknown.trim(), '', '已有的四节内容不该掉进 unknown')
})

test('分区：空骨架里六个节的标题都在（用户打开文件就能看见该往哪写）', () => {
  const skeleton = emptyBackground('某书')
  for (const name of BACKGROUND_INJECTED_SECTIONS) {
    assert.match(skeleton, new RegExp(`^## ${name}$`, 'm'), `空骨架缺少「${name}」节`)
  }
})

test('分区：「文风（只写一次）」能存能渲染（描述叙述特征，不含剧情）', () => {
  // ⚠️ 夹具刻意用**旧节名** `## 文风`：2026-10-01 这一节改名成「文风（只写一次）」，
  //    而读者磁盘上的 `background.md` 里全是旧名 —— 别名表必须继续认它，
  //    否则整节会掉进"认不出的 `## 标题`"（那里的条目会被当成人手写内容，不再作为认识渲染）。
  const doc = parseBackground([
    '## 文风',
    '- `第1章` 第三人称限知，短句为主，对话密集',
    '- `第1章` 善用天气与器物作比喻，几乎不用感叹号',
  ].join('\n'))

  assert.equal(doc.sections['文风（只写一次）'].length, 2, '旧节名必须归一到新节名')
  assert.deepEqual(doc.sections['文风'], undefined, '不该再有一个叫「文风」的分区')
  const out = renderBackgroundForPrompt(doc, { budgetChars: 6000 })
  assert.match(out.text, /### 文风（只写一次）/)
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
  //（夹具用「世界观」——3.0 起「前文脉络」不再是注入节，但**区间判据是通用的**。）
  const doc = parseBackground([
    '## 世界观',
    '- `第5-9章` 一段跨章的设定记载',
  ].join('\n'))

  const kept = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 6, maxChapter: 7 })
  assert.match(kept.text, /一段跨章的设定记载/, '区间起点 5 ≤ 7，必须保留')
  assert.deepEqual(kept.filtered, [])

  const dropped = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 3, maxChapter: 4 })
  assert.doesNotMatch(dropped.text, /一段跨章的设定记载/, '区间起点 5 > 4，必须丢掉')
  assert.deepEqual(dropped.filtered, [{ name: '世界观', dropped: 1 }])
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

  // 正向（落后）时**不再由这里发缺口提示**（2026-09-27 去重）：那句话归「当前情况」那段
  // （`renderSituation`）—— 记录在案的意图是「缺口必须明说，而且只有动态区能说」。
  // 这条因此从"回归保护"改成了"去重守卫"：两处同一轮都进 prompt 就是重复。
  const ahead = renderBackgroundForPrompt(doc, { budgetChars: 6000, progressIndex: 1200 })
  assert.doesNotMatch(ahead.text, /尚未\*\*纳入/, '缺口提示只在「当前情况」那段，别在这里重复')
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

test('读者族：这一节对模型不可见，但重写与合并都不许丢（2026-10-01）', () => {
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..20 -->',
    '# 《魔女霓裳》· 背景认识',
    '## 人物',
    '### 甲',
    '- `第3章` 身份未明',
    '## 时间与分线',
    '### 主线',
    '- `第1-4年` 骨架：她还在渡口一带。',
    '### 【支线】甲线 · 第1–7年',
    '- `第12章` 【第3年春】与乙在渡口分离。',
    // ⚠️ 「伏笔」不再单独成节（读者 2026-10-01）：写在条目里标出来即可。
    '- `第15章` 【伏笔】他多看了一眼那封信（还没解释）',
  ].join('\n'))

  // ① 注入必须**看不到**这一节 —— 判据："这句话会不会让模型顺着说？"（会，就不注入）
  const injected = renderBackgroundForPrompt(doc, { progressIndex: 20 })
  assert.doesNotMatch(injected.text, /时间与分线/, '分线节不许进提示词')
  assert.doesNotMatch(injected.text, /那封信/, '伏笔的正文更不许进（它会诱导提示）')
  assert.match(injected.text, /身份未明/, '注入族照旧要在')

  // ② 写成文件时**必须在** —— 否则重写一次这一节就永久没了
  const rewritten = renderBackground(doc, '魔女霓裳')
  assert.match(rewritten, /## 时间与分线/)
  assert.match(rewritten, /那封信/)

  // ②b ⚠️ **`### 单元` 标题也必须在** —— 这条是 2026-10-01 补的，它原来只断到
  //     `## 时间与分线` 与条目文字，于是"分组判定漏了读者族"（当时"这一节是不是
  //     分组的"散成 6 处 `BACKGROUND_GROUPED_SECTIONS.includes(...)`，读者族那一族
  //     没有接线）让 `### 主线` / `### 【支线】… · 第N-M章` **在每一次写盘时被静默
  //     丢掉**，627 条守卫全绿放行。丢的不只是层级：标题里的章号区间也一起没了。
  assert.match(rewritten, /### 主线/, '主线骨架的标题必须在（丢了这一节就退化成流水账）')
  assert.match(rewritten, /### 【支线】甲线 · 第1–7年/, '支线单元标题（含章号区间）必须在')

  // ②c 写盘往返必须**幂等**：解析 → 渲染 → 再解析 → 再渲染，结构不许逐次退化
  assert.equal(
    renderBackground(parseBackground(rewritten), '魔女霓裳'),
    rewritten,
    '写盘往返必须幂等（结构不许在第二次写盘时再掉一层）',
  )

  // ③ 合并（增量补齐走的就是这条路）也必须保留
  const merged = mergeBackground(doc, parseBackground(''), { from: 21, to: 30 })
  const mergedText = renderBackground(merged, '魔女霓裳')
  assert.match(mergedText, /## 时间与分线/)
  assert.match(mergedText, /### 主线/)
  assert.match(mergedText, /### 【支线】甲线 · 第1–7年/)

  // ④ 两个提示词都得知道这一节：补齐要**写出**它，压缩要**保留**它
  const fill = buildMemoryPrompt({
    bookTitle: '测试书', samples: [{ index: 0, title: '一', text: '正文' }], fromChapter: 1, toChapter: 1,
  })
  assert.ok(fill.includes('## 时间与分线'), '补齐要写出这一节')
  assert.ok(fill.includes('### 主线'), '要先有主线骨架')
  assert.ok(fill.includes('【支线】'), '支线 / 副本要作为一个个单元')
  assert.ok(fill.includes('⭐ 影响'), '每个单元必须收在"影响"上（否则就是流水账）')
  assert.ok(fill.includes('打包说完'), '同一件事跨几十章也是一个单元，不要按章摊平')
  assert.ok(fill.includes('【未闭合】'), '影响暂时看不出来时的标记必须明说')
  assert.ok(fill.includes('【伏笔】'), '伏笔用标记写在条目里（不再单独成节）')
  assert.ok(fill.includes('只写"注意到了什么"'), '伏笔只许写观察')
  // ④b（3.0 分节作业）：压缩 = **逐节调用** ⇒ 读者族根本**不过模型**（结构性保留）。
  //    保证打在作业清单上：它不在「要过模型」的名单里 —— 比在提示词里提一句"要保留"更硬。
  assert.ok(!COMPRESSIBLE_SECTIONS.includes('时间与分线'), '分节作业不含读者族 ⇒ 时间与分线永不过模型')
  assert.ok(
    !COMPRESSIBLE_SECTIONS.includes('冷档案')
    && !COMPRESSIBLE_SECTIONS.includes('文本类型')
    && !COMPRESSIBLE_SECTIONS.includes('人物状态'),
    '冷档案 / 写法指南针 / 状态行同样永不过模型',
  )
})

test('面板信号：文件里"进度之后"的条目要数得准（面板看得见、模型看不见，得说出来）', () => {
  // ⚠️ 2026-10-01 三方评审 P2：`/background` 回给面板的是**全文**，而投喂给模型的
  //    那一份会按进度裁掉超前条目 ⇒ 同一份文件两种视图。处置是**如实说出来**
  //    （不是把读者的文件藏起来 —— 那份文件本来就是给他看、给他改的）。
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..60 -->',
    '## 人物',
    '### 甲',
    '- `第3章` 已经读到的条目',
    '- `第45章` 超前的一条',
    '## 时间与分线',
    '### 主线',
    '- `第5章` 读到过',
    '### 【支线】无面谷 · 第50-58章',
    '- `第52章` 超前的一条',
    '- ⭐ 影响：这一条本身不带章号',
  ].join('\n'))

  const early = countBeyondProgress(doc, 30)
  assert.equal(early.entries, 2, '第45章那条 + 支线里带章号那条')
  assert.equal(early.maxChapter, 52, '最远到第 52 章（58 只是 `###` 标题里的区间，不是条目）')

  // ⚠️ `⭐ 影响` 那一类条目**本身不带章号** ⇒ 不算超前：宁可少报，也不要凭空指控。
  //    它所属的单元里有带章号的条目，那段照样会被点出来。
  assert.deepEqual(countBeyondProgress(doc, 60), { entries: 0, maxChapter: null }, '追上进度后必须归零')
  assert.deepEqual(countBeyondProgress(doc, null), { entries: 0, maxChapter: null }, '不判定时回零')
})

test('后续批次注入：只给三节 + 通用概念（非空才给）+ 时间与分线只给单元名', () => {
  // ⚠️ 2026-10-01 读者定的口径（"除开第一次，后续只需要注入人物、人物关系、世界观"
  // —— 当时还有「前文脉络」；**3.0 它已并入「时间与分线」** ⇒ 现在就是三节 + 概念兜底）。
  // 逐节理由见 `renderExistingForFill` 的说明。
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..20 -->',
    '## 人物关系',
    '### 甲 × 乙',
    '- `第3章` 雨夜决裂',
    '## 人物',
    '### 甲',
    '- `第2章` 身份未明',
    '## 世界观',
    '- `第1章` 三面环水',
    '## 文风（只写一次）',
    '- `第1章` 爱用短句',
    '## 前文脉络',
    '- `第1-5章` 初遇',
    '## 时间与分线',
    '### 主线',
    '- `第1-4年` 骨架：还在渡口。',
    '### 【支线】无面谷 · 第15-20章',
    '- `第15章` 起：接任务入谷。',
    '- `第20章` 收：出谷。',
    '## 已取代',
    '- `第3章` 旧的错说法',
  ].join('\n'))

  const text = renderExistingForFill(doc)

  for (const name of ['人物关系', '人物', '世界观']) {
    assert.match(text, new RegExp(`^## ${name}$`, 'm'), `${name} 必须给（新条目要接在已有主体名下）`)
  }
  assert.match(text, /^### 甲 × 乙$/m, '分组节的布局要与注入侧同源（### 主体 + 名下条目）')
  assert.match(text, /雨夜决裂/)

  // ⚠️ 3.0：「前文脉络」已并入「时间与分线」⇒ **不再注入**（它本来就只在文件里保留）
  assert.doesNotMatch(text, /^## 前文脉络$/m, '脉络并入后不再给（省预算；旧内容在文件里照旧）')
  assert.doesNotMatch(text, /初遇/)
  assert.doesNotMatch(text, /^## 文风（只写一次）$/m, '文风不给：它是稳定特征，后续批次不需要重读')
  assert.doesNotMatch(text, /爱用短句/, '文风的条目更不该给')
  assert.doesNotMatch(text, /^## 已取代$/m, '归档不给：抑制名单已经兜着，塞进来只会给"复活旧说法"的机会')
  assert.doesNotMatch(text, /旧的错说法/)

  assert.match(text, /^### 主线$/m, '时间与分线的**单元名**必须给 —— 否则每批都新建单元，同一个副本被拆成好几个')
  assert.match(text, /^### 【支线】无面谷 · 第15-20章$/m)
  assert.doesNotMatch(text, /接任务入谷/, '单元里的条目**不给**（那是读者的整理，不是模型的记忆）')

  // 通用概念：小说里通常是空的（空节不该占字符）；非小说书它才是主体。
  assert.doesNotMatch(text, /^## 通用概念$/m, '空的通用概念不该出现')
  const withConcept = parseBackground([
    '## 通用概念',
    '### 科举制',
    '- `第4章` 三年一考',
  ].join('\n'))
  assert.match(renderExistingForFill(withConcept), /^## 通用概念$/m, '非空时必须给（非小说书的主体）')
  assert.match(renderExistingForFill(withConcept), /科举制/)
})

test('元判断：「文本类型」排在最前、永远整条注入，而且不占别人的额度', () => {
  // ⚠️ 2026-10-02 读者提的：第一批判断"这是什么类型的书"，写进文件开头的「文本类型」，
  //    之后每一批都带着它当写法依据。它比别的节**更不能被裁** —— 而它又很短，
  //    所以它不进权重表、不参与保底（否则会先拿保底再被裁，恰好把最关键那句砍掉）。
  const doc = parseBackground([
    '## 文本类型',
    '- 武侠小说，主线是感情线；方向：人物卡少建，时间与分线按关系阶段分单元。',
    '## 人物',
    '### 甲',
    `- \`第1章\` ${'很长的条目。'.repeat(60)}`,
  ].join('\n'))

  const out = renderBackgroundForPrompt(doc, { budgetChars: 150 })
  assert.match(out.text, /武侠小说，主线是感情线/, '元判断必须整条在场')
  assert.match(out.text, /按关系阶段分单元/, '连后半句也不许被裁')
  assert.ok(
    out.text.indexOf('文本类型') < out.text.indexOf('人物'),
    '它要排在别的节前面（它是后面几节怎么读的依据）',
  )
  assert.equal('文本类型' in out.allowances, false, '元判断不进额度表 —— 它不参与权重与保底')

  const filled = renderExistingForFill(doc)
  assert.match(filled, /^## 文本类型$/m, '补齐的"已有认识"里也要带上它')
  assert.ok(filled.startsWith('## 文本类型'), '在"已有认识"里它排第一（后面的节按它来写）')
})

test('倒退过滤：段落式人物条目必须**按句**过滤（段落式带来的材料层风险，2026-10-02）', () => {
  // ⚠️ 「人物」改成"一段小传"之后，一段里会有多个章号。若按"行首章号"整段放行，
  //    开头写 `第3章`、中间写着 `第50章` 的段落会**整段**进到"正在读第 20 章"那轮提示词里
  //    —— 那是**材料层漏后文**（防剧透的根本在材料层，不在守则）。
  const doc = parseBackground([
    '## 人物',
    '### 甲',
    '- `第3章` 出身寒门。`第31章` 拜入师门。`第50章` 立下大愿。',
  ].join('\n'))

  const early = renderBackgroundForPrompt(doc, { budgetChars: 9000, maxChapter: 20 })
  assert.match(early.text, /出身寒门/, '已读的那句要给')
  assert.doesNotMatch(early.text, /拜入师门/, '第31章那句不许进提示词')
  assert.doesNotMatch(early.text, /立下大愿/, '第50章那句也不许进提示词')
  assert.equal(
    early.filtered.find((item) => item.name === '人物')?.sentences,
    2,
    '丢了几句必须报出来（"截了就要说"）',
  )

  const later = renderBackgroundForPrompt(doc, { budgetChars: 9000, maxChapter: 60 })
  assert.match(later.text, /立下大愿/, '读到了就整段都在')

  // 同一句里引到的别的章号**不算**新的一句 —— 否则会把一句切成残句。
  const inline = parseBackground(['## 人物', '### 乙', '- `第3章` 出场（`第50章` 才又提到）。'].join('\n'))
  const inlineOut = renderBackgroundForPrompt(inline, { budgetChars: 9000, maxChapter: 20 })
  assert.match(inlineOut.text, /出场/, '同一句里的括注不受影响')
})

//#region 在线折叠（3.0 ②c）：离场人物折叠成锚（注入视图；文件不动）

const OFFLINE_DOC = [
  '<!-- drc-background: schema=1 covered=1..100 -->',
  '# 《书》· 背景认识',
  '',
  '## 人物状态',
  '### 甲',
  '- `第20章` 现状：离开渡口，去向不明。',
  '### 乙',
  '- `第90章` 现状：在城中被围。',
  '',
  '## 人物',
  '### 甲',
  '- `第5章` 渡口少年。',
  '- `第20章` 离开了渡口。',
  '### 乙',
  '- `第90章` 被围城中。',
].join('\n')

test('在线折叠：离场人物（最后提及距今 ≥ 阈值）⇒ 注入只留锚，状态行不进提示词', () => {
  const doc = parseBackground(OFFLINE_DOC)
  const r = renderBackgroundForPrompt(doc, { budgetChars: 9000, progressIndex: 89, personOfflineChapters: 60 })
  // 甲：读第 90 章 − 最后提及第 20 章 = 70 ≥ 60 ⇒ 折叠
  const pessoa段 = r.text.slice(r.text.indexOf('### 人物' + '\n'), r.text.indexOf('（另有'))
  assert.ok(pessoa段.includes('离开了渡口'), '锚（最新一条）必须在')
  assert.ok(!pessoa段.includes('渡口少年'), '更早的条目不随行（折叠成一条）')
  assert.match(r.text, /另有 1 位人物已\*\*离场\*\*/, '折叠要说出来（可解释）')
  const 状态段 = r.text.slice(r.text.indexOf('### 人物状态') + 1, r.text.indexOf('### 人物状态') + 400)
  assert.ok(!状态段.includes('离开渡口，去向不明'), '离场人物的状态行不注入（过期现状误导）')
  // 乙：90 − 90 = 0 < 60 ⇒ 正常展开
  assert.ok(r.text.includes('被围城中'), '在线人物的一切照旧')
})

test('在线折叠：人物**再出场**（有新条目）⇒ 自动展开；文件视图（renderBackground）从头到尾不动', () => {
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..100 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '### 甲',
    '- `第95章` 现状：回来了，落脚在码头。',
    '',
    '## 人物',
    '### 甲',
    '- `第5章` 渡口少年。',
    '- `第95章` 重新出现。',
  ].join('\n'))
  const r = renderBackgroundForPrompt(doc, { budgetChars: 9000, progressIndex: 96, personOfflineChapters: 60 })
  assert.ok(r.text.includes('渡口少年'), 'lastSeen 更新 ⇒ 整卡展开')
  assert.ok(r.text.includes('回来了，落脚在码头'), '状态行跟着回来')
  const 复述 = renderBackground(doc, '《书》')
  assert.match(复述, /渡口少年/, '文件视图不受折叠影响 —— 折叠只动注入')
})

test('在线折叠：设 0（或不给 progressIndex）⇒ 关闭；与旧行为逐字一致', () => {
  const doc = parseBackground(OFFLINE_DOC)
  const off = renderBackgroundForPrompt(doc, { budgetChars: 9000, progressIndex: 89, personOfflineChapters: 0 })
  assert.ok(off.text.includes('渡口少年'), '0 = 不折叠')
  assert.ok(!off.text.includes('已**离场**'), '折叠的说明也不该出现')
})

