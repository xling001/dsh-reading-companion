/**
 * 「通用概念」——非小说文本的兜底分区。
 *
 * ## 这一节要证明的只有一件事
 *
 * **对小说是纯加法。** 前面五节是为小说定的（人物、关系、世界观、文风、脉络），
 * 读者读史书/哲学/技术书时那五节可能全是空的，于是内容无处可写。加一节兜底是
 * 为了解决这件事，而不是顺手改一改既有行为——所以本文件里最要紧的断言是**差分**
 * 的：同一份"五节都有"的内容，兜底有没有、有没有标题，提示词必须逐字节一样。
 *
 * 其余用例钉的是"兜底真的能装卸内容"：异名能归一（模型换个说法不能把内容弄丢）、
 * 提示词与压缩提示词里真的列出了它（**接线**，函数对而没接线照样是 bug）、
 * 取代与更新块在它下面同样生效。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BACKGROUND_GROUPED_SECTIONS,
  BACKGROUND_SECTIONS,
  BACKGROUND_SECTION_WEIGHTS,
  emptyBackground,
  mergeBackground,
  normalizeSectionName,
  parseBackground,
  renderBackground,
  renderBackgroundForPrompt,
} from '../lib/host/background.js'
import { buildCompactPrompt } from '../lib/host/compact.js'
import { buildMemoryPrompt } from '../lib/host/memory.js'
import {
  parseBackgroundUpdates,
  renderUpdateInstruction,
  updatesToIncomingDoc,
  validateUpdate,
} from '../lib/host/background-update.js'

const FALLBACK = '通用概念'

/** 五节都有一点内容的旧文件（**没有**兜底节）。 */
const LEGACY = [
  '<!-- drc-background: schema=1 covered=1..40 -->',
  '## 人物关系',
  '### 甲 × 乙',
  '- `第12章` 雨夜决裂',
  '## 人物',
  '### 甲',
  '- `第3章` 沉默寡言',
  '### 乙',
  '- `第4章` 话多',
  '## 世界观',
  '### 落霞谷',
  '- `第8章` 三面环水',
  '## 文风',
  '- `第1章` 第三人称限知，短句为主',
  '## 前文脉络',
  '- `第1-9章` 初遇',
].join('\n')

//#region 异名归一

test('兜底：模型换一种写法也不会把内容弄丢', () => {
  // 分区的识别是**精确匹配**，而这一节的名字是提示词里现写的。模型写成
  // 「通用概念（兜底）」时，旧行为会让整节落进"认不出的 ## 标题"分支——那里的
  // 条目会被当成人手写的内容，**不再作为认识渲染，也不再进压缩**。静默丢失比
  // 报错难查得多。
  for (const alias of [
    '通用概念',
    '通用概念（兜底）',
    '通用概念(兜底)',
    '通用文本概念',
    '通用文本概念兜底',
    '其他概念',
  ]) {
    assert.equal(normalizeSectionName(alias), FALLBACK, `「${alias}」应当归一到「${FALLBACK}」`)
  }
})

test('兜底：归一**只**认兜底，既有分区名与真正的未知标题都不受影响', () => {
  // 既有五节的名字不动：它们已经在读者手上的文件里出现了几千次。
  for (const name of ['人物关系', '人物', '世界观', '文风', '前文脉络', '已取代']) {
    assert.equal(normalizeSectionName(name), name)
  }
  // 认不出的标题必须**原样返回**：`parseBackground` 靠"认不出就重置分区"这条
  // 行为把手写内容隔离在 `unknown` 里。
  assert.equal(normalizeSectionName('参考书目'), '参考书目')
  assert.equal(normalizeSectionName('  通用概念（兜底）  '), FALLBACK, '前后空格不该影响归一')
})

test('兜底：异名解析出来的条目，落在同一个分区里', () => {
  const doc = parseBackground([
    '## 通用概念（兜底）',
    '### 科举制',
    '- `第4章` 三年一考',
  ].join('\n'))

  assert.deepEqual(doc.groups[FALLBACK]['科举制'], ['`第4章` 三年一考'])
  assert.equal(doc.unknown.trim(), '', '认得出的标题不该把内容漏进 unknown')
})

test('兜底：真正的未知标题仍然把手写内容隔在 unknown，不会被兜底吸走', () => {
  // 这是反向风险：归一表要是写得太松（比如"认不出的都算兜底"），读者手写的
  // 散文就会被当成 AI 的认识渲染进提示词。
  const doc = parseBackground([
    '## 参考书目',
    '某出版社 2019 年版',
    '## 通用概念',
    '### 概念甲',
    '- `第2章` 一句话',
  ].join('\n'))

  assert.match(doc.unknown, /某出版社/)
  assert.deepEqual(doc.groups[FALLBACK]['概念甲'], ['`第2章` 一句话'])
})

//#endregion

//#region 对小说是纯加法

test('兜底：**空的兜底节不改变任何分配**（差分断言）', () => {
  // ★ 本文件最重要的一条。旧文件里没有这一节，新文件里有一节空的——两者在
  // 提示词里的分配必须逐键相同。这是"不破坏现有成果"的可执行版本。
  const legacy = parseBackground(LEGACY)
  const withFallback = parseBackground(`${LEGACY}\n## ${FALLBACK}\n`)

  // 预算刻意调到**紧张**：只有超预算时分配才真的在取舍，也才看得出差异。
  const options = { budgetChars: 260, progressIndex: 24 }
  const a = renderBackgroundForPrompt(legacy, options)
  const b = renderBackgroundForPrompt(withFallback, options)

  assert.deepEqual(b.allowances, a.allowances, '空兜底节不该改变任何一节的额度')
  assert.deepEqual(b.omitted, a.omitted)
  assert.equal(b.text, a.text, '空兜底节不该改变提示词的任何一个字节')
  // 顺带证明这个预算真的紧张：否则上面的"一样"是平凡的。
  assert.ok(a.omitted.length > 0 || a.trimmed.length > 0, '夹具的预算必须真的不够，否则差分没有意义')
})

test('兜底：内容再多也不会被饿死，且是六节里最少的一份', () => {
  // 兜底排在最后、权重最低，于是它是最容易被整节丢掉的那一节。**保底与权重
  // 无关**（见 `SECTION_FLOOR_RATIO`），所以它必须仍然露头——否则非小说文本
  // 会遇到"所有概念都不进提示词"，而那正是这一节存在的理由。
  const entries = (label) => Array.from({ length: 20 }, (_, i) => `- \`第${i + 1}章\` ${label}${i}`)
  const doc = parseBackground([
    '## 人物关系', ...entries('关系'), '',
    '## 人物', ...entries('人物'), '',
    '## 世界观', ...entries('设定'), '',
    '## 文风', ...entries('风格'), '',
    '## 前文脉络', ...entries('脉络'), '',
    '## 通用概念', ...entries('概念'),
  ].join('\n'))

  // 预算刻意紧张：只有超预算时分配才真的在按权重取舍。
  const { allowances, omitted } = renderBackgroundForPrompt(doc, { budgetChars: 900 })
  assert.deepEqual(omitted, [], '每节都要露头，兜底也不例外')

  const values = BACKGROUND_SECTIONS.map((name) => ({ name, value: allowances[name] }))
  for (const { name, value } of values) {
    assert.ok(value > 0, `「${name}」没有拿到额度`)
  }
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(
      values[i - 1].value > values[i].value,
      `额度必须严格随权重递减：「${values[i - 1].name}」${values[i - 1].value} vs 「${values[i].name}」${values[i].value}`,
    )
  }
  assert.ok(BACKGROUND_SECTION_WEIGHTS[FALLBACK] > 0, '兜底的权重不能是 0（那等于永远拿不到额度）')
})

test('兜底：空骨架里有这一节，用户打开文件就知道该往哪写', () => {
  const skeleton = emptyBackground('某书')
  assert.match(skeleton, new RegExp(`^## ${FALLBACK}$`, 'm'))
})

test('兜底：能存能渲染，且往返等价', () => {
  const doc = parseBackground([
    '## 通用概念',
    '### 科举制',
    '- `第4章` 三年一考，分乡试会试殿试',
  ].join('\n'))

  const text = renderBackground(doc, '某史书')
  assert.match(text, new RegExp(`^## ${FALLBACK}$`, 'm'))
  assert.match(text, /^### 科举制$/m)
  assert.deepEqual(parseBackground(text).groups[FALLBACK]['科举制'], ['`第4章` 三年一考，分乡试会试殿试'])

  const prompt = renderBackgroundForPrompt(doc, { budgetChars: 6000 })
  assert.match(prompt.text, /科举制/)
})

test('兜底：是**分组**分区（能按主体寻址），与世界观同形', () => {
  assert.ok(BACKGROUND_GROUPED_SECTIONS.includes(FALLBACK))
  assert.equal(BACKGROUND_SECTIONS[BACKGROUND_SECTIONS.length - 1], FALLBACK, '兜底必须排在最后')
})

test('兜底：取代在它下面同样生效（旧概念搬进归档，不再进提示词）', () => {
  const doc = parseBackground([
    '## 通用概念',
    '### 地心说',
    '- `第3章` 天体绕地运行',
  ].join('\n'))
  const incoming = parseBackground([`## ${FALLBACK}`, '### 日心说', '- `第9章` 天体绕日运行'].join('\n'))

  // 直接复用 background.js 的合并入口（这里只关心兜底这一节走的是同一套机制）。
  const merged = mergeBackground(doc, incoming, { first: 9, last: 9 }, 'T', {
    supersedes: ['`第3章` 天体绕地运行'],
  })

  assert.equal(merged.lastMerge.superseded, 1, '兜底下的条目必须能被取代')
  assert.equal(merged.lastMerge.unmatched.length, 0)
  assert.deepEqual(merged.groups[FALLBACK]['地心说'], [], '被取代的条目要搬走')
  assert.deepEqual(merged.groups[FALLBACK]['日心说'], ['`第9章` 天体绕日运行'])
  assert.ok(merged.retired.some((entry) => entry.includes('天体绕地运行')), '取代是搬进归档，不是删掉')
  assert.doesNotMatch(renderBackgroundForPrompt(merged, { budgetChars: 6000 }).text, /天体绕地运行/)
})

//#endregion

//#region 接线：提示词里真的说了这一节

test('接线：补齐提示词列出了兜底节，并说清它只在归不进前面时才用', () => {
  const prompt = buildMemoryPrompt({
    bookTitle: '某史书',
    samples: [{ index: 0, title: '第一章', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })

  assert.match(prompt, new RegExp(`^## ${FALLBACK}$`, 'm'), '格式清单里必须有这一节')
  assert.match(prompt, /兜底/, '必须说清它是兜底，否则模型会把它当第七个平级分类')
  assert.match(prompt, /能归进上面任何一节/, '必须给出"能归就别放兜底"的判据')
  assert.match(prompt, /史书、哲学、技术/, '必须点名非小说文本，否则兜底永远空着')
})

test('接线：补齐提示词要求**逐主体过一遍**并**照抄专名**（T2-4）', () => {
  // 这两条是"零额外调用地提高写进去的信息密度"的全部手段：模型不逐主体检查就
  // 会漏掉新信息，不照抄专名就会把"沈某某"写成"某人"、把门派名意译掉。
  const prompt = buildMemoryPrompt({
    bookTitle: '某书',
    samples: [{ index: 0, title: '第一章', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })

  assert.match(prompt, /已有的每一位主体/)
  assert.match(prompt, /专名照抄原文/)
  assert.match(prompt, /不要.*换个说法(再写一遍|重写)/, '必须明确禁止同义重写（那是只长胖不长信息）')
})

test('接线：压缩提示词的**顺序清单**里六节一个不少、且顺序一致', () => {
  const prompt = buildCompactPrompt({ bookTitle: '某书', markdown: '## 人物\n', targetChars: 100 })

  // ⚠️ 断言打在**那一行清单**上，不是"整段文本里出现过这个名字"。
  // 第一版就是这么写的（`prompt.includes('`## 通用概念`')`），而变异验证证明它
  // **抓不住"从清单里删掉一节"**——因为提示词下面还有一行"这几节要写 `### 主体`"，
  // 那里也提到了同一节，于是"存在性"仍然成立，而清单已经少了一节、句子还写着
  // "六个小节"。**"出现过"不等于"清单里有"，更不等于"顺序对"。**
  const listLine = prompt.split('\n').find((line) => line.includes('个小节'))
  assert.ok(listLine !== undefined, '压缩提示词必须有一条"顺序不变"的小节清单')

  for (const name of BACKGROUND_SECTIONS) {
    assert.ok(listLine.includes(`\`## ${name}\``), `顺序清单里缺「${name}」`)
  }
  const positions = BACKGROUND_SECTIONS.map((name) => listLine.indexOf(`\`## ${name}\``))
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i - 1] < positions[i],
      `清单顺序必须与 BACKGROUND_SECTIONS 一致：「${BACKGROUND_SECTIONS[i]}」的位置不对`,
    )
  }
  assert.match(prompt, /每一个 `###` 主体都要在/, '校验器会拒绝丢主体的压缩，提示词得跟它说同一件事')
})

test('接线：更新块说明里有兜底，且点明分组分区必须给 `主体`', () => {
  const instruction = renderUpdateInstruction()
  assert.ok(instruction.includes(FALLBACK), '`节` 的可选值里必须有兜底')
  assert.match(instruction, /兜底/)
  assert.match(instruction, /必须给 `主体`/)
})

test('接线：更新块指定兜底 + 主体时才通过；缺主体被拒', () => {
  const ok = validateUpdate({ 节: FALLBACK, 主体: '科举制', 章: '4', 事实: '三年一考' }, { progressIndex: 4 })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.section, FALLBACK)
  assert.equal(ok.value.grouped, true)

  const missing = validateUpdate({ 节: FALLBACK, 章: '4', 事实: '三年一考' }, { progressIndex: 4 })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'NO_SUBJECT')

  // 端到端：说明里给出的**节名**（模型要照抄的那串字）真能通过校验，并且装成
  // `mergeBackground` 认的形状。说明文本本身也含一个示例块，所以这里只喂自己
  // 这一块——说明的可解析性由 background-update.test.mjs 的往返用例负责。
  assert.ok(
    renderUpdateInstruction().includes('「人物 / 人物关系 / 世界观 / 文风 / 前文脉络 / 通用概念」之一'),
    '说明书里那串"照抄这个"的节名必须与校验器接受的一致',
  )
  const text = [
    '<!--drc-update',
    `节: ${FALLBACK}`,
    '主体: 科举制',
    '章: 4',
    '事实: 三年一考，分乡试会试殿试',
    '-->',
  ].join('\n')
  const { accepted, rejected } = parseBackgroundUpdates(text, { progressIndex: 4 })
  assert.deepEqual(rejected, [])
  assert.equal(accepted.length, 1)
  const incoming = updatesToIncomingDoc(accepted)
  assert.deepEqual(incoming.groups[FALLBACK]['科举制'], ['`第4章` 三年一考，分乡试会试殿试'])
})

//#endregion
