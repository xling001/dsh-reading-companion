/**
 * 背景认识的**实体键**与**取代**（P14 / v1.22 §211–§213）。
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
  BACKGROUND_SECTIONS,
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

test('实体键：`###` 在四个分组分区下都是主体', () => {
  const doc = docOf([
    '<!-- drc-background: schema=1 covered=1..20 -->',
    '## 人物关系',
    '### 甲 × 乙',
    '- `第12章` 雨夜决裂',
    '- `第20章` 复和',
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

  // 四个分区都要认 `###`。只认「人物」就是旧行为，等于人物关系永远是一条条
  // 不知道属谁的散条目。
  assert.deepEqual(
    [...BACKGROUND_GROUPED_SECTIONS],
    ['人物关系', '人物', '世界观', '通用概念'],
  )
  assert.deepEqual(doc.groups['人物关系']['甲 × 乙'], ['`第12章` 雨夜决裂', '`第20章` 复和'])
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

  assert.deepEqual(Object.keys(doc.groups['文风'] ?? {}), [])
  assert.deepEqual(Object.keys(doc.groups['前文脉络'] ?? {}), [])
  assert.deepEqual(doc.sections['文风'], ['`第5章` 爱用短句'])
  assert.deepEqual(doc.sections['前文脉络'], ['`第1-9章` 初遇'])
})

test('实体键：分组分区渲染出 `### 主体`，往返后等价', () => {
  const doc = mergeIn(parseBackground(''), [
    '## 人物关系',
    '### 甲 × 乙',
    '- `第12章` 雨夜决裂',
  ], { first: 12, last: 12 })

  const text = renderBackground(doc, '测试书')
  assert.match(text, /^### 甲 × 乙$/m, '分组分区必须把主体写回文件')

  const again = parseBackground(text)
  assert.deepEqual(again.groups['人物关系']['甲 × 乙'], ['`第12章` 雨夜决裂'])
  assert.deepEqual(again.covered, { first: 12, last: 12 })
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
  // 两条关系都提到"信任"，取代必须只动指定主体下的那一条。
  const before = docOf([
    '<!-- drc-background: schema=1 covered=1..30 -->',
    '## 人物关系',
    '### 甲 × 乙',
    '- `第10章` 建立信任',
    '### 甲 × 丙',
    '- `第10章` 建立信任',
  ])
  const after = mergeIn(before, [], { first: 60, last: 60 }, {
    supersedes: ['`第10章` 建立信任'],
  })

  // 比对键是"去掉章节标记后的正文"，两条正文相同 —— 所以只该取代**一条**，
  // 另一条原样留着。这既是限制也是安全性：宁可少取代，不可连坐。
  const total = Object.values(after.groups['人物关系']).flat().length
  assert.equal(after.retired.length, 1)
  assert.equal(total, 1, '取代误伤了另一条同名条目')
})

//#endregion

//#region 压缩与归档的边界

test('压缩保主体：丢了分组主体就拒绝', () => {
  const before = mergeIn(parseBackground(''), [
    '## 人物关系',
    '### 甲 × 乙',
    '- `第12章` 雨夜决裂',
    '## 人物',
    '### 甲',
    '- `第3章` 沉默寡言',
  ], { first: 1, last: 12 })

  // 人物还在，但**关系那一对没了** —— 旧校验只看 `characters`，这里会放过去。
  const after = mergeIn(parseBackground(''), [
    '## 人物',
    '### 甲',
    '- `第3章` 沉默寡言',
  ], { first: 1, last: 12 })

  const verdict = validateCompaction(before, after)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /COMPACT_LOST_ENTITIES/)
  assert.match(verdict.reason, /甲 × 乙/)
  assert.equal(Object.keys(after.characters).length, Object.keys(before.characters).length,
    '这一个用例必须是被"保主体"拦下的，而不是被"保名"顺带拦下')
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
  // 六个分区一个都不能少，且顺序不变（顺序即超预算时的丢弃优先级）。
  assert.deepEqual(
    [...BACKGROUND_SECTIONS],
    ['人物关系', '人物', '世界观', '文风', '前文脉络', '通用概念'],
  )
  // 加了「通用概念」之后，旧文件的解析结果必须**逐字段不变**：新分区是空数组
  // （不是 undefined），既有内容一条都不掉进 unknown。这是"加法不是改动"。
  assert.deepEqual(doc.sections['通用概念'], [], '旧文件里新分区应当是空数组')
  assert.deepEqual(doc.groups['通用概念'], {})
  assert.equal(doc.unknown.trim(), '')
  // 归档区**不是**一个普通分区：它进了 BACKGROUND_SECTIONS 就会被渲染进提示词。
  assert.equal(BACKGROUND_SECTIONS.includes(BACKGROUND_RETIRED_SECTION), false)
})

//#endregion
