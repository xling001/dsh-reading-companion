/**
 * 背景认识的**实体键**与**取代**（P14 / v1.22 `docs/design-v1-archive.md` §211–§213）。
 *
 * ## 为什么要有"实体"
 *
 * `人物关系` 的条目常常不写清"是谁和谁"（`- \`第12章\` 关系出现裂痕`），既让人读
 * 不明白，也让"这条关系属谁"无从追溯。把「人物」用了很久的 `### 名字` 推广成
 * **分组分区的主体**（人物关系 = 一对人、世界观 = 一个设定），每条条目就有了一个
 * **可寻址的主体**——这正是「取代」能指哪打哪的前提。
 *
 * ## 为什么要有"取代"
 *
 * 设计约束是「条目只增不减」，但读者/AI 总会推翻早先的说法（"沈某某其实是女子"
 * 推翻"沈某某是男子"）。只增不减之下，两条互相矛盾的说法会**一起**进提示词。
 * 「取代」把旧条目**搬进归档**而不是删掉：文件里两样都在（能看见、能撤销），
 * 而提示词里只剩新的那一条。
 *
 * ## 这个文件钉住的四类事
 *
 * 1. **分组真的生效**，且只在该生效的分区生效（不能把散文小标题吞掉）。
 * 2. **两个静默丢数据的回归**：`## 人物` 下没有 `###` 的散条目以前会在写盘时
 *    消失；`## 你手写的内容` 之后的内容以前会被归给上一个已知分区。
 * 3. **取代的全部语义**：搬家不删除、不进展、**抑制复活**、幂等、没命中要如实报。
 * 4. **压缩与归档的边界**：归档不进压缩输入，压缩后原样带回，丢了分组主体要拒。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BACKGROUND_GROUPED_SECTIONS,
  BACKGROUND_RETIRED_SECTION,
  BACKGROUND_INJECTED_SECTIONS,
  BACKGROUND_WRITE_ONCE_SECTIONS,
  emptyBackground,
  parseBackground,
  renderBackground,
  renderBackgroundForPrompt,
  mergeBackground,
} from '../lib/host/background.js'
import { createCompactor, validateCompaction } from '../lib/host/compact.js'

/** 造一份背景认识。 */
const docOf = (lines) => parseBackground(lines.join('\n'))

/** 把一段 markdown 当成本批新认识并进来。 */
const mergeIn = (base, lines, range, options) =>
  mergeBackground(base, docOf(lines), range, 'T', options)

//#region 实体键

test('实体键：`###` 在四个分组分区下都是主体（「人物关系」已改回平铺）', () => {
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..20 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：`第12章` 雨夜决裂',
    '- 甲 ↔ 乙：`第20章` 复和',
    '## 人物',
    '### 甲',
    '- `第3章` 沉默寡言',
    '## 世界观',
    '### 落霞谷',
    '- `第8章` 三面环水',
    '## 通用概念',
    '### 科举制',
    '- `第4章` 三年一考，分乡试会试殿试',
  ])

  // 分组的有**四**节。⚠️ 「人物关系」**不在里面**了（读者 2026-10-04 拍板改回平铺）——
  //    它的主体写在**条目文本开头**（`- 甲 ↔ 乙：…`）⇒ 条目落在 `sections` 里。
  assert.deepEqual(
    [...BACKGROUND_GROUPED_SECTIONS],
    ['人物状态', '人物', '世界观', '通用概念'],
  )
  assert.deepEqual(
    doc.sections['人物关系'],
    ['甲 ↔ 乙：`第12章` 雨夜决裂', '甲 ↔ 乙：`第20章` 复和'],
  )
  assert.deepEqual(Object.keys(doc.groups['人物关系'] ?? {}), [], '平铺节里不该有主体')
  assert.deepEqual(doc.groups['人物']['甲'], ['`第3章` 沉默寡言'])
  assert.deepEqual(doc.groups['世界观']['落霞谷'], ['`第8章` 三面环水'])
  assert.deepEqual(doc.groups['通用概念']['科举制'], ['`第4章` 三年一考，分乡试会试殿试'])

  // 向后兼容：`characters` 必须仍是「人物」那一组，而且必须是**同一个对象**
  // （index.js / compact.js / memory.js 都按老形状读它）。
  assert.equal(doc.characters, doc.groups['人物'])
})

test('实体键：非分组分区里的 `###` 不被当成主体', () => {
  // 「文风」「前文脉络」的主体是整本书和时间轴，强行分组只会造出一堆只有一个
  // 成员的分区。更要紧的是：不能把正文里偶然出现的 `###` 当成主体，那会让它
  // 后面的条目全都挂到一个莫名其妙的名字下面。
  const doc = docOf([
    '## 文风',
    '### 这不是主体，只是行文里的一个小标题',
    '- `第5章` 爱用短句',
    '## 前文脉络',
    '- `第1-9章` 初遇',
  ])

  assert.deepEqual(Object.keys(doc.groups['文风（只写一次）'] ?? {}), [])
  assert.deepEqual(Object.keys(doc.groups['前文脉络'] ?? {}), [])
  assert.deepEqual(doc.sections['文风（只写一次）'], ['`第5章` 爱用短句'])
  assert.deepEqual(doc.sections['前文脉络'], ['`第1-9章` 初遇'])
})

test('实体键：分组分区渲染出 `### 主体`，往返后等价', () => {
  const doc = mergeIn(parseBackground(''), [
    '## 世界观',
    '### 落霞谷',
    '- `第12章` 三面环水',
  ], { first: 12, last: 12 })

  const text = renderBackground(doc, '测试书')
  assert.match(text, /^### 落霞谷$/m, '分组分区必须把主体写回文件')

  const again = parseBackground(text)
  assert.deepEqual(again.groups['世界观']['落霞谷'], ['`第12章` 三面环水'])
  assert.deepEqual(again.covered, { first: 12, last: 12 })
})

test('实体键：平铺的「人物关系」往返后**主体前缀原样留着**（不靠 `###` 承载）', () => {
  const doc = mergeIn(parseBackground(''), [
    '## 人物关系',
    '- 甲 ↔ 乙：`第12章` 雨夜决裂',
  ], { first: 12, last: 12 })

  const text = renderBackground(doc, '测试书')
  assert.match(text, /^- 甲 ↔ 乙：`第12章` 雨夜决裂$/m, '平铺条目要原样写回')

  const again = parseBackground(text)
  assert.deepEqual(again.sections['人物关系'], ['甲 ↔ 乙：`第12章` 雨夜决裂'])
  assert.deepEqual(Object.keys(again.groups['人物关系'] ?? {}), [], '平铺节解析后不该冒出主体')
})

test('实体键：主体名下的条目全被取代后，提示词里不留一个空标题', () => {
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..200 -->',
    '## 人物',
    '### 沈某某',
    '- `第5章` 沈某某是男子',
  ])
  const after = mergeIn(before, [], { first: 200, last: 200 }, {
    supersedes: ['`第5章` 沈某某是男子'],
  })

  const prompt = renderBackgroundForPrompt(after, { budgetChars: 6000 })
  // 一个光秃秃的 `### 沈某某` 会让模型看到一个名字却没有任何关于他的信息，
  // 读起来像"这个人被删了"。
  assert.doesNotMatch(prompt.text, /### 沈某某/)
  // 但文件里必须保留（读者要看得见发生了什么）。
  assert.match(renderBackground(after, '测试书'), /### 沈某某/)
})

//#endregion

//#region 两个静默丢数据的回归

test('回归：没有 `###` 的散条目必须留在文件里，不能被写盘时丢掉', () => {
  // 旧实现解析时把「人物」下没有 `###` 的条目塞进 `sections['人物']`，而渲染
  // 只读 `doc.characters` —— 于是那几行在下一次写盘时**静默消失**。
  const markdown = ['## 人物', '- `第3章` 一个还没归类的人'].join('\n')
  const doc = parseBackground(markdown)
  assert.deepEqual(doc.sections['人物'], ['`第3章` 一个还没归类的人'])

  const again = renderBackground(doc, '测试书')
  assert.match(again, /- `第3章` 一个还没归类的人/, '散条目在重写后消失了')
  assert.deepEqual(parseBackground(again).sections['人物'], ['`第3章` 一个还没归类的人'])
})

test('回归：`## 你手写的内容` 之后的内容不得被算进上一个分区', () => {
  // 旧实现遇到认不出的 `## 标题` 时直接 continue，**不重置分区**，于是手写内容
  // 被归给上一个已知分区（这里就是「前文脉络」）——手写条目会被当成 AI 的记忆
  // 渲染出来，散文则直接丢失。
  const doc = docOf([
    '## 前文脉络',
    '- `第9章` 主角进城',
    '## 你手写的内容',
    '- 我觉得作者在这里埋了伏笔',
  ])

  assert.deepEqual(doc.sections['前文脉络'], ['`第9章` 主角进城'], '手写内容被算进了前文脉络')
  assert.match(doc.unknown, /埋了伏笔/, '手写内容丢了')

  // 反向：手写内容**不该**被当成 AI 的记忆送给模型。
  const prompt = renderBackgroundForPrompt(doc, { budgetChars: 6000 })
  assert.doesNotMatch(prompt.text, /埋了伏笔/)
})

test('回归：渲染→解析→渲染 必须逐字相同（顶部说明不得变成内容）', () => {
  // ⚠️ 这条闸本该早点存在。真实故障：顶部那段说明以前写成四行，而 `parseBackground`
  // 的守卫只挡 `<!--` 开头那一行、**挡不住续行** —— 续行漏进 `unknown`，又被
  // `renderBackground` 回写到 `## 你手写的内容` 下，**每写一次盘就长三行**。
  // 读者的文件里实测攒了 4 组（12 行），并且被他导出到 Obsidian 里当代码块看出来了。
  //
  // 判据只用"两次渲染必须逐字相同"。它不依赖任何实现细节，所以能抓住**这一整类**
  // "往返会漂移"的缺陷，而不只是这一次的具体形状。
  const sources = [
    emptyBackground('测试书'),
    ['## 人物', '### 甲', '- `第1章` 身份未明'].join('\n'),
  ]
  for (const source of sources) {
    const once = renderBackground(parseBackground(source), '测试书')
    const twice = renderBackground(parseBackground(once), '测试书')
    assert.equal(twice, once, '第二次渲染与第一次不同：往返在漂移')
  }

  // 顶部那段说明是**注释**，不是内容：它不该在 `## 你手写的内容` 下再出现一次。
  const rendered = renderBackground(parseBackground(emptyBackground('测试书')), '测试书')
  assert.doesNotMatch(rendered, /## 你手写的内容/, '空文档不该长出「你手写的内容」小节')
})

//#endregion

//#region 取代

test('取代：命中的旧条目搬进归档，不删除，且不再进展', () => {
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..5 -->',
    '## 人物',
    '### 沈某某',
    '- `第5章` 沈某某是男子',
  ])

  const after = mergeIn(before, [], { first: 200, last: 200 }, {
    supersedes: ['`第5章` 沈某某是男子'],
  })

  assert.deepEqual(after.groups['人物']['沈某某'], [], '旧条目还留在活分区里')
  assert.equal(after.retired.length, 1)
  assert.match(after.retired[0], /沈某某是男子/, '归档里必须是原文，不能只留个索引')
  assert.match(after.retired[0], /已于第 200 章被取代/)
  assert.deepEqual(after.lastMerge, { superseded: 1, unmatched: [] })

  // 文件里**两样都在**：读者能看见发生了什么，也能把它搬回去撤销。
  const text = renderBackground(after, '测试书')
  assert.match(text, new RegExp(`## ${BACKGROUND_RETIRED_SECTION}`))
  assert.match(text, /沈某某是男子/)

  // 但模型看不到它。
  const prompt = renderBackgroundForPrompt(after, { budgetChars: 6000 })
  assert.doesNotMatch(prompt.text, /沈某某是男子/)
})

test('取代：被推翻的旧说法不会因为重读那一章而复活', () => {
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..5 -->',
    '## 人物',
    '### 沈某某',
    '- `第5章` 沈某某是男子',
  ])
  const corrected = mergeIn(before, [], { first: 200, last: 200 }, {
    supersedes: ['`第5章` 沈某某是男子'],
  })

  // 模型重新总结第 5 章时，又把那句已经被推翻的旧话说了一遍。只按"去重"处理
  // 的话，它会作为一条活条目复活，跟修正后的说法一起进提示词 —— 那正是「取代」
  // 要解决的问题本身。
  const again = mergeIn(corrected, [
    '## 人物',
    '### 沈某某',
    '- `第5章` 沈某某是男子',
  ], { first: 201, last: 201 })

  assert.deepEqual(again.groups['人物']['沈某某'], [], '被取代的旧说法复活了')
  assert.equal(again.retired.length, 1, '不该产生第二条归档')
})

test('取代：归档条目带着尾注，仍能被识别为同一条', () => {
  // 归档条目长这样：`- \`第5章\` 沈某某是男子 <!-- 已于第 200 章被取代 -->`。
  // 如果比对键里留着那段 HTML 注释，它跟"模型重新总结出来的同一句话"就永远
  // 对不上 —— 抑制会整个失效。
  const archived = docOf([
    '<!-- drc-background: schema=1 covered=1..200 -->',
    '## 已取代',
    '- `第5章` 沈某某是男子 <!-- 已于第 200 章被取代 -->',
  ])
  assert.equal(archived.retired.length, 1)
  assert.deepEqual(archived.groups['人物'], {})

  const merged = mergeIn(archived, [
    '## 人物',
    '### 沈某某',
    '- `第5章` 沈某某是男子',
  ], { first: 201, last: 201 })
  assert.deepEqual(merged.groups['人物']['沈某某'] ?? [], [], '尾注干扰了比对，旧说法复活了')
})

test('取代：散条目的抑制同样生效（不只是分组分区）', () => {
  // ⚠️ 这条用例是**变异测试逼出来的**：抑制逻辑在 `mergeBackground` 里写了**两遍**
  // （散条目一遍、分组分区一遍）。只测分组那一遍时，去掉散条目那一边的抑制，
  // 全套测试仍然全绿——一条真实存在的、却没有任何覆盖的守卫。
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..30 -->',
    '## 前文脉络',
    '- `第30章` 主角拿到了钥匙',
  ])
  const corrected = mergeIn(before, [], { first: 60, last: 60 }, {
    supersedes: ['`第30章` 主角拿到了钥匙'],
  })
  assert.equal(corrected.retired.length, 1)

  const again = mergeIn(corrected, [
    '## 前文脉络',
    '- `第30章` 主角拿到了钥匙',
  ], { first: 61, last: 61 })
  assert.deepEqual(again.sections['前文脉络'], [], '散条目里的旧说法复活了')
})

test('取代：同一条取代两次只产生一条归档', () => {
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..5 -->',
    '## 人物',
    '### 沈某某',
    '- `第5章` 沈某某是男子',
  ])
  const once = mergeIn(before, [], { first: 200, last: 200 }, {
    supersedes: ['`第5章` 沈某某是男子'],
  })
  const twice = mergeIn(once, [], { first: 201, last: 201 }, {
    supersedes: ['`第5章` 沈某某是男子'],
  })

  assert.equal(twice.retired.length, 1)
  // 已经取代过了，所以"什么也没做"是实话，不该报成 unmatched。
  assert.deepEqual(twice.lastMerge, { superseded: 0, unmatched: [] })
})

test('取代：没找到目标时如实报告，而不是假装成功', () => {
  const doc = mergeBackground(parseBackground(''), parseBackground(''), { first: 9, last: 9 }, 'T', {
    supersedes: ['`第1章` 这条根本不存在'],
  })

  // 静默什么都没做、而调用方以为修正已生效，是这一节最不该出现的情形。
  assert.deepEqual(doc.lastMerge, { superseded: 0, unmatched: ['`第1章` 这条根本不存在'] })
  assert.deepEqual(doc.retired, [])
})

test('取代：散条目（非分组分区）也能被取代', () => {
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..30 -->',
    '## 前文脉络',
    '- `第30章` 主角拿到了钥匙',
  ])
  const after = mergeIn(before, [], { first: 60, last: 60 }, {
    supersedes: ['`第30章` 主角拿到了钥匙'],
  })

  assert.deepEqual(after.sections['前文脉络'], [])
  assert.equal(after.retired.length, 1)
})

test('取代：分组分区里的条目按主体寻址，不误伤同名条目', () => {
  // 两个主体的条目正文**逐字相同**，取代必须只动一条。
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..30 -->',
    '## 世界观',
    '### 落霞谷',
    '- `第10章` 三面环水',
    '### 断魂崖',
    '- `第10章` 三面环水',
  ])
  const after = mergeIn(before, [], { first: 60, last: 60 }, {
    supersedes: ['`第10章` 三面环水'],
  })

  // 比对键是"去掉章节标记后的正文"，两条正文相同 —— 所以只该取代**一条**，
  // 另一条原样留着。这既是限制也是安全性：宁可少取代，不可连坐。
  const total = Object.values(after.groups['世界观']).flat().length
  assert.equal(after.retired.length, 1)
  assert.equal(total, 1, '取代误伤了另一条同名条目')
})

//#endregion

//#region 压缩与归档的边界

test('压缩保主体：丢了分组主体就拒绝', () => {
  const before = mergeIn(parseBackground(''), [
    '## 世界观',
    '### 落霞谷',
    '- `第12章` 三面环水',
    '## 人物',
    '### 甲',
    '- `第3章` 沉默寡言',
  ], { first: 1, last: 12 })

  // 人物还在，但**那个设定没了** —— 旧校验只看 `characters`，这里会放过去。
  const after = mergeIn(parseBackground(''), [
    '## 人物',
    '### 甲',
    '- `第3章` 沉默寡言',
  ], { first: 1, last: 12 })

  const verdict = validateCompaction(before, after)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /COMPACT_LOST_ENTITIES/)
  assert.match(verdict.reason, /落霞谷/)
  assert.equal(Object.keys(after.characters).length, Object.keys(before.characters).length,
    '这一个用例必须是被"保主体"拦下的，而不是被"保名"顺带拦下')
})

test('压缩保主体（平铺版）：「人物关系」里**对**一个都不能少，但合并是允许的', () => {
  // ⚠️ 2026-10-04：「人物关系」从分组改回平铺之后 `groups` 里没有它 ⇒ 上面那条
  //    「保主体」**管不到它**，而它是权重最高的一节（15/48）且 `compressible: true`。
  //    判据刻意**不是"条目数不许净减"**：压缩对这一节的指令本身就是**合并**
  //    （`buildCompactPrompt` 写的是"合并后一条 ≤80 字"，实测 19 条并成 8 条）
  //    ⇒ 按条数卡会**否决每一次合法压缩**。要保的是"**对不能少**"。
  const before = mergeIn(parseBackground(''), [
    '## 人物关系',
    '- 甲 ↔ 乙：同门 → 对手（`第3章` 起结怨）',
    '- 甲 ↔ 乙：`第8章` 一起拜入师门',
    '- 甲 ↔ 丙：师徒（`第9章`）',
  ], { first: 1, last: 12 })

  // ① **同一对的两条并成一条**（条目变少、正文也真的更短）必须放行。
  const merged = mergeIn(parseBackground(''), [
    '## 人物关系',
    '- 甲 ↔ 乙：同门 → 对手（`第3章`；`第8章` 一起拜师）',
    '- 甲 ↔ 丙：师徒（`第9章`）',
  ], { first: 1, last: 12 })
  assert.equal(validateCompaction(before, merged).ok, true, '同一对合并是合法压缩，不该被拦')

  // ② 丢**一整对**必须被拦下，而且要说出丢的是哪一对。
  const dropped = mergeIn(parseBackground(''), [
    '## 人物关系',
    '- 甲 ↔ 乙：同门 → 对手（`第3章` 起结怨）',
    '- 甲 ↔ 乙：`第8章` 一起拜入师门',
  ], { first: 1, last: 12 })
  const verdict = validateCompaction(before, dropped)
  assert.equal(verdict.ok, false, '整对关系消失必须拦下')
  assert.match(verdict.reason, /COMPACT_LOST_PAIRS/)
  assert.match(verdict.reason, /甲 ↔ 丙/, '要说出丢的是哪一对，读者才知道怎么补救')
})

test('压缩保章号：把条目的**定位锚**弄丢就拒绝（章号是唯一的定位手段）', () => {
  // ⚠️ 章号三处机制都吃：**倒退过滤**（判会不会剧透）、**冷归档**（判是否过老）、
  //    **取代/去重**（`entryKey` 剥掉它之后比对）。丢一个 ⇒ 那条记忆**再也无法被定位**，
  //    而**文件里看不出少了什么**（静默）。
  //    2026-10-04 评审发现：压缩提示词只在两节写了"章号别丢"，其余节没有，而代码
  //    从前**一条都不查**（`validateCompaction` 只查 covered / 主体 / 变小）。
  //
  //    证伪：把 `validateCompaction` 里那段 `COMPACT_LOST_ANCHORS` 删掉 ⇒ 下面第二条红。
  const before = mergeIn(parseBackground(''), [
    '## 人物',
    '### 甲',
    '- `第1章` 出身与处境，这一段特意写长一点，好让"必须变小"有真实余地。',
    '- `第9章` 立场转变，同样写长一点。',
  ], { first: 1, last: 9 })

  // ① 合并成**区间**、两端章号都还在 ⇒ 放行（这是压缩的正常动作）。
  const merged = mergeIn(parseBackground(''), [
    '## 人物',
    '### 甲',
    '- `第1-9章` 出身与处境，后立场转变。',
  ], { first: 1, last: 9 })
  assert.equal(validateCompaction(before, merged).ok, true, '合并成区间、两端章号都在 ⇒ 合法压缩')

  // ② 合并时把章号**并丢** ⇒ 拦下，并说出丢的是哪几章。
  const anchorLost = mergeIn(parseBackground(''), [
    '## 人物',
    '### 甲',
    '- 出身与处境，后立场转变。',
  ], { first: 1, last: 9 })
  const verdict = validateCompaction(before, anchorLost)
  assert.equal(verdict.ok, false, '章号丢光必须拦下')
  assert.match(verdict.reason, /COMPACT_LOST_ANCHORS/)
  assert.match(verdict.reason, /第 1、9 章/, '要说出丢的是哪几章')

  // ③ 反向：**本来就没有章号**的条目不算丢（读者手写的、或通用设定是合法的）。
  const noAnchors = mergeIn(parseBackground(''), [
    '## 世界观',
    '- 江湖与魔教，势力众多、规矩森严，这一段特意写长一些。',
  ], { first: 1, last: 9 })
  const alsoNoAnchors = mergeIn(parseBackground(''), [
    '## 世界观',
    '- 江湖、魔教。',
  ], { first: 1, last: 9 })
  assert.equal(validateCompaction(noAnchors, alsoNoAnchors).ok, true, '没有章号的条目不该被这条拦')
})

test('压缩输入：归档区不送给压缩模型', async () => {
  // ⚠️ 这份夹具必须**留有可压缩的活内容**：如果 before 只剩归档，压缩会因
  // `COMPACT_NO_SHRINK` 而失败，用例就测不到归档那件事了。
  const before = mergeIn(docOf([
    '<!-- drc-background: schema=1 covered=1..5 -->',
    '## 人物',
    '### 沈某某',
    '- `第5章` 沈某某是男子',
    '### 甲',
    `- \`第1章\` ${'一位很啰嗦的配角的重复描述'.repeat(40)}`,
  ]), [], { first: 200, last: 200 }, {
    supersedes: ['`第5章` 沈某某是男子'],
  })
  assert.equal(before.retired.length, 1)

  const calls = []
  const compactor = createCompactor({
    startRun: async (spec) => {
      calls.push(spec)
      return {
        output: [{
          type: 'text',
          text: [
            '<!-- drc-background: schema=1 covered=1..200 -->',
            '## 人物',
            '### 沈某某',
            '- `第200章` 其实是女子',
            '### 甲',
            '- `第1章` 配角',
          ].join('\n'),
        }],
      }
    },
    getAgent: () => ({ id: 'parent' }),
    getSubagents: () => ({ start: async () => { throw new Error('不该走到这里') } }),
    logger: {},
  })

  const result = await compactor({
    sessionId: 's1',
    bookTitle: '测试书',
    markdown: renderBackground(before, '测试书'),
    doc: before,
    targetChars: 100,
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)

  // 送进模型的材料里不能有归档区：既浪费 token，又给了模型把已被推翻的旧说法
  // "重新总结"回正文的机会。
  const sentToModel = JSON.stringify(calls[0])
  assert.doesNotMatch(sentToModel, /沈某某是男子/, '归档内容被送进了压缩输入')

  // 归档必须原样带回：模型没见过它，就没有资格动它。否则一次压缩就把全部取代
  // 记录抹掉，被推翻的旧说法会在下一次合并时复活。
  assert.deepEqual(result.parsed.retired, before.retired)
  assert.match(result.text, new RegExp(`## ${BACKGROUND_RETIRED_SECTION}`))
  assert.match(result.text, /沈某某是男子/)
})

//#endregion

//#region 旧文件兼容

test('兼容：没有任何新语法的旧文件，解析结果与从前一致', () => {
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..9 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：对手（`第2章`）',
    '## 人物',
    '### 甲',
    '- `第1章` 身份未明',
    '## 世界观',
    '- `第1章` 江湖与魔教',
    '## 文风',
    '- `第1章` 爱用短句',
    '## 前文脉络',
    '- `第1-9章` 初遇',
  ])

  assert.deepEqual(doc.sections['人物关系'], ['甲 ↔ 乙：对手（`第2章`）'])
  assert.deepEqual(doc.characters['甲'], ['`第1章` 身份未明'])
  assert.deepEqual(doc.sections['世界观'], ['`第1章` 江湖与魔教'])
  assert.deepEqual(doc.retired, [])
  // ⚠️ 3.0：「前文脉络」并入「时间与分线」⇒ 注入五个（脉络**不再注入**，但旧文件里
  // 它的内容必须仍被解析保留——见 BACKGROUND_LEGACY_SECTIONS）。
  assert.deepEqual(
    [...BACKGROUND_INJECTED_SECTIONS],
    ['人物关系', '人物', '世界观', '文风（只写一次）', '通用概念'],
  )
  // 兼容：旧文件的「前文脉络」原样解析保留（mergeById/写盘都会带着它）
  assert.deepEqual(doc.sections['前文脉络'], ['`第1-9章` 初遇'])
  // 加了「通用概念」之后，旧文件的解析结果必须**逐字段不变**：新分区是空数组
  // （不是 undefined），既有内容一条都不掉进 unknown。这是"加法不是改动"。
  assert.deepEqual(doc.sections['通用概念'], [], '旧文件里新分区应当是空数组')
  assert.deepEqual(doc.groups['通用概念'], {})
  assert.equal(doc.unknown.trim(), '')
  // 归档区**不是**一个普通分区：它进了 BACKGROUND_INJECTED_SECTIONS 就会被渲染进提示词。
  assert.equal(BACKGROUND_INJECTED_SECTIONS.includes(BACKGROUND_RETIRED_SECTION), false)
})

//#endregion

test('「只写一次」：已有内容 ⇒ 丢弃新条目（「文本类型」与「文风」都在这一族）', () => {
  // ⚠️ 2026-10-03 读者拍板：把「文本类型」**放回** `BACKGROUND_WRITE_ONCE_SECTIONS` ——
  //    当天先把它摘出去、放宽为"可重判"，读者随后收回。理由是**稳定性**：
  //    它是"后面每一节该怎么写"的方向指导，一改，后面所有批次的写法方向跟着变。
  //    ⇒ 这一族现在有两节：**文本类型**（会错的判断，误判靠模糊化避免）+ **文风**（稳定特征）。
  assert.deepEqual(
    [...BACKGROUND_WRITE_ONCE_SECTIONS],
    ['文本类型', '文风（只写一次）'],
    '两节都在这一族（顺序 = 文件顺序）',
  )

  const base = parseBackground([
    '<!-- drc-background: schema=1 covered=1..100 -->',
    '# 《书》· 背景认识',
    '',
    '## 文本类型',
    '- 原始指南针：武侠百合，双主角。',
    '',
    '## 文风（只写一次）',
    '- 平实白描，多用短句。',
  ].join('\n'))
  const add = parseBackground([
    '<!-- drc-background: schema=1 covered=101..115 -->',
    '# 《书》· 背景认识',
    '',
    '## 文本类型',
    '- （本批无新增，沿用已有）',
    '- 又一份措辞略不同的指南针。',
    '',
    '## 文风（只写一次）',
    '- 又一份文风描述。',
  ].join('\n'))
  const merged = mergeBackground(base, add, { first: 101, last: 115 })
  assert.deepEqual(merged.sections['文本类型'], ['原始指南针：武侠百合，双主角。'], '已有指南针 ⇒ 模型新写的整条丢弃（不追加、也不重判）')
  assert.deepEqual(merged.sections['文风（只写一次）'], ['平实白描，多用短句。'], '稳定特征不被重复书写')
  // ⚠️ **丢弃不是取代**：一条归档都不留、`superseded` 记 0（"没发生的事不留记录"）。
  assert.equal(merged.retired.length, 0, '丢弃不留归档 —— 与"取代"的区别就在这里')
  assert.equal(merged.lastMerge.superseded, 0)

  // 本批没写这一节 ⇒ 一个字都不动。
  const untouched = mergeBackground(base, parseBackground([
    '## 人物',
    '### 甲',
    '- `第101章` 甲登场。',
  ].join('\n')), { first: 101, last: 115 })
  assert.deepEqual(untouched.sections['文本类型'], ['原始指南针：武侠百合，双主角。'])
  assert.equal(untouched.retired.length, 0)

  // 空节首写照常（第一批写指南针就是这条路）。
  const fresh = parseBackground('<!-- drc-background: schema=1 covered=1..3 -->\n# 《书》· 背景认识')
  const firstWrite = mergeBackground(fresh, parseBackground([
    '<!-- drc-background: schema=1 covered=1..3 -->',
    '## 文本类型',
    '- 第一批写的指南针。',
  ].join('\n')), { first: 1, last: 3 })
  assert.deepEqual(firstWrite.sections['文本类型'], ['第一批写的指南针。'], '空节首写不受守卫影响')
})

test('「只写一次」的例外：调用方**显式点名取代**时换手（不许把这一节清空）', () => {
  // 2026-10-03 修的洞：它在 WRITE_ONCE 里时，一条 `节: 文本类型` + `事实: <新判断>` +
  // `取代: <旧判断>` 的更正会 —— ① 新判断被"已有内容 ⇒ 丢弃一切新条目"挡掉；
  // ② 旧判断被取代循环搬进「已取代」⇒ **指南针整个清空**。
  // 而它是**每批都注入**的方向指导 ⇒ 空掉之后后面每一批都没有方向。
  // 更重的是：重判被收回之后，`#drc-update` 是**唯一**的纠正渠道 —— 唯一那条还坏着。
  //
  // ⚠️ 这个例外与**已删除的"可重判"不是一回事**：
  //    · 可重判 = 模型**每批自己申请**重写 ⇒ 额外一次子代理调用、方向会漂；
  //    · 这个例外 = **只有调用方显式点名 `取代:`** 才生效 ⇒ 零额外调用，
  //      而且"模型自己写的重复内容一律丢弃"**一个字都没变**（见下面第 ③ 段）。
  //
  // ⚠️ `options` 是**第五个**参数（第三是 `range`、第四是 `updatedAt`）——
  //    写错位置时 `supersedes` 会被静默忽略，这个洞就"看不见"了（我第一次就写错了）。
  //
  // 可证伪：① 把 WRITE_ONCE 分支里的 `explicit` 判断去掉（退回无条件丢弃）
  //    ⇒ "新判断必须落地"那条红；② 把"标记成已处理"那几行去掉 ⇒ "同一句话写回来"那条红。
  const base = parseBackground([
    '<!-- drc-background: schema=1 covered=1..100 -->',
    '# 《书》· 背景认识',
    '',
    '## 文本类型',
    '- 原始指南针：武侠百合，双主角。',
  ].join('\n'))
  const correction = parseBackground([
    '<!-- drc-background: schema=1 covered=101..115 -->',
    '# 《书》· 背景认识',
    '',
    '## 文本类型',
    '- 更正后的指南针：其实是男频武侠，单主角。',
  ].join('\n'))

  // ① 正常换手：新判断落地、旧判断进「已取代」。
  const merged = mergeBackground(base, correction, { first: 101, last: 115 }, undefined, {
    supersedes: ['原始指南针：武侠百合，双主角。'],
  })
  assert.deepEqual(
    merged.sections['文本类型'],
    ['更正后的指南针：其实是男频武侠，单主角。'],
    '新判断必须落地（不许被"只写一次"挡掉）',
  )
  assert.equal(merged.sections['文本类型'].length, 1, '这一节永远只有一条（"文本类型是一句话"）')
  assert.equal(merged.retired.length, 1, '旧判断搬进「已取代」（不删除，与取代同一套语义）')
  assert.match(merged.retired[0], /原始指南针：武侠百合，双主角。/)
  assert.match(merged.retired[0], /已于第 115 章被取代/)
  assert.equal(merged.lastMerge.superseded, 1, '如实记一笔"取代了一次"')

  // ② 把**同一句话**写回来 ⇒ 零动作（"没发生的事不留记录"），而且**不许把旧的搬走**。
  //    这条覆盖的是"取代了、却没有可用的新条目"那条路：若不标记成已处理，
  //    下面的取代循环仍会把旧的搬走 ⇒ 又变成"想改却没得改，结果连旧的也没了"。
  const same = mergeBackground(base, parseBackground([
    '## 文本类型',
    '- 原始指南针：武侠百合，双主角。',
  ].join('\n')), { first: 101, last: 115 }, undefined, {
    supersedes: ['原始指南针：武侠百合，双主角。'],
  })
  assert.deepEqual(same.sections['文本类型'], ['原始指南针：武侠百合，双主角。'], '同一句话写回来 ⇒ 原样保留（不许清空）')
  assert.equal(same.retired.length, 0, '没发生的事不留记录')
  assert.equal(same.lastMerge.superseded, 0)

  // ③ 没点名取代 ⇒ 回到"只写一次"的常规：模型自己写的重复内容照样丢弃、零动作。
  const plain = mergeBackground(base, correction, { first: 101, last: 115 })
  assert.deepEqual(plain.sections['文本类型'], ['原始指南针：武侠百合，双主角。'], '模型自己写的重复内容照样丢弃')
  assert.equal(plain.retired.length, 0, '丢弃不是取代 ⇒ 不留归档')
})
