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
  BACKGROUND_INJECTED_SECTIONS,
  BACKGROUND_LEGACY_SECTIONS,
  BACKGROUND_PROMPT_SECTIONS,
  BACKGROUND_READER_SECTIONS,
  BACKGROUND_SECTION_WEIGHTS,
  BACKGROUND_SECTIONS,
  emptyBackground,
  isGroupedSection,
  mergeBackground,
  normalizeSectionName,
  parseBackground,
  renderBackground,
  renderBackgroundForPrompt,
} from '../lib/host/background.js'
import { COMPRESSIBLE_SECTIONS, buildCompactPrompt } from '../lib/host/compact.js'
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
  for (const name of ['人物关系', '人物', '世界观', '文风（只写一次）', '前文脉络', '已取代']) {
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
  //（⚠️ 3.0：注入少了一节（脉络并入）⇒ 同一预算的紧张度变了 ⇒ 夹紧它。） 
  const options = { budgetChars: 150, progressIndex: 24 }
  const a = renderBackgroundForPrompt(legacy, options)
  const b = renderBackgroundForPrompt(withFallback, options)

  assert.deepEqual(b.allowances, a.allowances, '空兜底节不该改变任何一节的额度')
  assert.deepEqual(b.omitted, a.omitted)
  assert.equal(b.text, a.text, '空兜底节不该改变提示词的任何一个字节')
  // 顺带证明这个预算真的紧张：否则上面的"一样"是平凡的。
  assert.ok(a.omitted.length > 0 || a.trimmed.length > 0, '夹具的预算必须真的不够，否则差分没有意义')
})

test('兜底：内容再多也不会被饿死（保底与权重无关）', () => {
  // 兜底权重最低，于是它是最容易被整节丢掉的那一节。**保底与权重
  // 无关**（见 `SECTION_FLOOR_RATIO`），所以它必须仍然露头——否则非小说文本
  // 会遇到"所有概念都不进提示词"，而那正是这一节存在的理由。
  const entries = (label) => Array.from({ length: 20 }, (_, i) => `- \`第${i + 1}章\` ${label}${i}`)
  const doc = parseBackground([
    '## 人物关系', ...entries('关系'), '',
    '## 人物', ...entries('人物'), '',
    '## 世界观', ...entries('设定'), '',
    '## 文风', ...entries('风格'), '',
    // ⚠️ 2026-10-06（B1-B）：「时间与分线」进了注入族 ⇒ 夹具要给它内容，
    //    否则"每节都要露头"会对一个空分区要额度（它本来就不该有额度）✗。
    '## 时间与分线', '### 主线', ...entries('脉络'), '',
    '## 通用概念', ...entries('概念'),
  ].join('\n'))

  // 预算刻意紧张：只有超预算时分配才真的在按权重取舍。
  const { allowances, omitted } = renderBackgroundForPrompt(doc, { budgetChars: 900 })
  assert.deepEqual(omitted, [], '每节都要露头，兜底也不例外')

  const values = BACKGROUND_INJECTED_SECTIONS.map((name) => ({ name, value: allowances[name] }))
  for (const { name, value } of values) {
    assert.ok(value > 0, `「${name}」没有拿到额度`)
  }
  // ⚠️ **2026-10-06（C）不再要求"额度严格随权重递减"**（分区顺序只是平手兜底，见
  //    `allocateSections`）⇒ 改钉"每节都 ≥ 保底"（整节消失才是要防的那件事）。
  for (const { name, value } of values) {
    assert.ok(value >= 900 * 0.12 - 1, `「${name}」的额度 ${value} 低于保底（整节会消失）`)
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
  // ⚠️ 2026-10-06（B1-B）：「时间与分线」进了注入族且权重最低（3/51 < 兜底 5/51）
  //    ⇒ **排在最后的是它**。这条断言从前写着"兜底必须排在最后"——那条性质是
  //    "表内顺序 = 权重降序"的一个**结果**，不是原因；现在换个数最少的即可。
  assert.equal(
    BACKGROUND_INJECTED_SECTIONS[BACKGROUND_INJECTED_SECTIONS.length - 1],
    FALLBACK,
    '排最后的是权重最低的那一节（B1-B 之后是「时间与分线」）',
  )
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

test('接线：补齐提示词说清了「世界观 = 规则 / 通用概念 = 术语」这条判据', () => {
  const prompt = buildMemoryPrompt({
    bookTitle: '某史书',
    samples: [{ index: 0, title: '第一章', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })

  assert.match(prompt, new RegExp(`^## ${FALLBACK}$`, 'm'), '格式清单里必须有这一节')
  // ⚠️ 2026-10-08（工单 **A6**）**这条判据又换了一次**，别只看结论：
  //    ① 旧措辞（2026-10-06 之前）："「通用概念」是最后的兜底，能归进上面任何一节都归进去"
  //       （按**东西**分类）✗；
  //    ② 2026-10-06 换成**按功能切**（读者："世界观和通用概念可以紧一点，一本小说不是什么
  //       细枝末节都非要记上去"）：**能约束情节的规则 ⇒ 「世界观」；只是名字与叫法 ⇒
  //       「通用概念」** ✓ —— 但它有个洞：**人名也是名字** ✗ ⇒ 真机《魔女霓裳》的通用概念
  //       17 条里收了 **9 个人** ✗（卓一航 / 红花鬼母 / 霍天都 …）⇒ 人物卡只剩 4 张 ✓；
  //    ③ 现在（读者拍板"「通用概念」是兜底，只收归不进其他几类的"）：判据改成**按顺序过三问**，
  //       第②问专门问"**是不是人**"⇒ 人一律归「人物」或「人物关系」✓。
  //    ⚠️ 守卫的**意图一个字没变**：模型必须拿到一条**明确的判据**，否则这一节会变成
  //    垃圾桶（旧措辞防的是"被当成第七个平级分类"，新措辞防的是"什么都往里塞"）。
  assert.match(prompt, /约束了"后面能发生什么"/, '必须给出「规则 vs 名字」的判据')
  assert.match(prompt, /它是个人吗/, '必须明写"是个人吗"这一问 —— 人一律归「人物」/「人物关系」')
  assert.match(prompt, /收专名与术语/, '必须说清什么归「通用概念」')
  // ⚠️ 2026-10-08（A6 的**反向**守卫）：旧措辞必须**彻底消失** —— "只是名字与叫法"读宽了
  //    就包括**人名** ✗（真机《魔女霓裳》的通用概念 17 条里收了 9 个人 ⇒ 人物卡只剩 4 张）。
  //    把它钉成"不许回来"，比只钉新措辞更能防回退 ✓。
  assert.ok(
    !prompt.includes('只是名字与叫法'),
    '旧的宽措辞"只是名字与叫法"不许回来（人名也是名字 ⇒ 会把人物收进通用概念）',
  )
  // ⚠️ 2026-10-05 去重：这句话改成指向第 13b 条（通用判据只写一处 ✓），措辞也变了 ✓。
  assert.match(prompt, /只出现过一次的名字\*\*不必单开一条\*\*/, '必须说清「只出现一次的名字不必单开一条」')
  assert.match(prompt, /史书 \/ 哲学 \/ 技术书/, '必须点名非虚构文本，否则那一类的兜底永远空着')
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

  assert.match(prompt, /先过一遍「我之前整理过的认识」里已有的主体/)
  assert.match(prompt, /专名照抄原文/)
  // ⚠️ 断言打在**不变式**上，不钉某一句原文：提示词会一轮轮被压短（读者："约束太过了"），
  //    钉死原句的守卫每轮都要改，还会把注意力从"这条约束还在不在"引开。
  assert.match(
    prompt,
    /只是换个说法的都不写|一条都不写|不要.*换个说法(再写一遍|重写)/,
    '必须明确禁止同义重写（那是只长胖不长信息）',
  )
})

test('接线（3.0 分节作业）：要过模型的节只有清单里那六个，顺序与文件节序一致', () => {
  // ⚠️ 3.0 起压缩是**逐节调用**：不变的保证从"提示词清单里有一节"升级成
  //    "**结构上不在作业清单里**" —— 读者族 / 指南针 / 状态行根本不会变成输入。
  for (const name of ['文本类型', '人物状态', '时间与分线', '冷档案']) {
    assert.ok(!COMPRESSIBLE_SECTIONS.includes(name), `「${name}」必须永不过模型`)
  }
  // 作业清单的顺序必须与文件节序一致（逐节调用按清单顺序发出 ⇒ 顺序 = 节序）。
  const inOrder = BACKGROUND_SECTIONS.filter((name) => COMPRESSIBLE_SECTIONS.includes(name))
  assert.deepEqual(
    inOrder,
    [...COMPRESSIBLE_SECTIONS],
    '分节作业的顺序必须与文件节序一致',
  )
  // 每次调用都是独立上下文 ⇒ 共用原则（宁可少合/不许巨段）每一遍都要带全。
  const prompt = buildCompactPrompt({
    bookTitle: '某书',
    section: '人物',
    sectionMarkdown: '## 人物\n### 甲\n- `第1章` 出场。',
    targetChars: 100,
  })
  assert.ok(prompt.includes('宁可少合'), '共用原则要带全')
  assert.ok(prompt.includes('语义重复的条目'), '要允许"语义重复就合并"')
  assert.ok(prompt.includes('扁平节') === prompt.includes('前文脉络'), '扁平节的说明只在前文脉络自己的提示词里')
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

  // 端到端：说明里给出的**节名清单必须与"聊天看得见的节"一致**。
  // ⚠️ 2026-10-03 改成**关系断言**：原先这里钉的是手写的 5 个名字（`includes('「人物 / …」之一')`），
  //    而校验器接受 9 节 —— 于是"清单与校验器一致"这句承诺**根本没有代码载体**，
  //    两处漂移了也不知道（正是本仓库反复栽的"同一概念多份定义"）。现在两边都从注册表派生。
  //
  // ⚠️ 2026-10-04 **口径修正**：从"校验器接受的全部节"改成"**聊天 AI 真正看得到的节**"
  //    （`BACKGROUND_PROMPT_SECTIONS` = 元判断族 + 注入族，7 节）。差别是读者族的
  //    「时间与分线」「冷档案」—— 它们**永不注入**，聊天 AI 从没见过，而 `冷档案`
  //    更是代码侧归档区。列进清单的后果不是"白写"：模型会以为那些节它也该管，
  //    把修正**写进永不被它读到的分区**（记了等于没记）。
  //    校验器**照旧接受**那些名字（接受得宽是为了不悄悄丢掉一条修正），只是**不宣传**。
  const instruction = renderUpdateInstruction()
  for (const name of BACKGROUND_PROMPT_SECTIONS) {
    assert.ok(instruction.includes(name), `说明书必须列出聊天看得见的每一节，缺「${name}」`)
  }
  for (const hidden of BACKGROUND_READER_SECTIONS) {
    assert.equal(
      instruction.includes(hidden),
      false,
      `永不注入的「${hidden}」不许出现在"照抄这个"的清单里（模型会往一个它永远读不到的分区写）`,
    )
  }
  for (const legacy of BACKGROUND_LEGACY_SECTIONS) {
    assert.equal(instruction.includes(legacy), false, `legacy 名「${legacy}」不许出现在"照抄这个"的清单里`)
  }
  // "必须给 `主体`"点名的必须**正好是清单里的分组节**（走 isGroupedSection，别手写第二份清单）
  const subjectClause = /其中「([^」]+)」\*\*必须给/.exec(instruction)
  assert.ok(subjectClause !== null, '说明书必须点明哪些节需要 `主体`')
  assert.deepEqual(
    subjectClause[1].split(' / ').slice().sort(),
    BACKGROUND_PROMPT_SECTIONS.filter((name) => isGroupedSection(name)).slice().sort(),
    '「必须给主体」点名错了会让模型照说明书写、然后被 NO_SUBJECT 拒掉（「文风」不是分组节、「通用概念」是）',
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
