/**
 * 记忆补齐器测试。
 *
 * 这是整条链上唯一**会起子代理**的地方，也是最容易出现"卡死在那儿没人知道"
 * 的地方。所以这里钉三件事：
 *
 *   1. **绝不挂死** —— 子代理不响应取消时，我们必须靠 `Promise.race` 自己退出；
 *   2. **联网面精确** —— 联网权限由 spawn 时的 `toolFilter` 决定，
 *      因为子代理的 session 与陪读会话不同、工具闸的归属判定认不出它；
 *   3. **失败都要有可读的原因** —— 每条 reason 对应界面上不同的处置建议。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TIMEOUT_MS,
  MEMORY_PERSONA,
  buildMemoryPrompt,
  createMemoryFiller,
  extractText,
  looksTruncated,
} from '../lib/host/memory.js'
import { FILL_INCREMENTAL_SECTIONS } from '../lib/host/background.js'

test('补齐提示词：长度上限（人物关系 80 字、其余 40 字），且明写不重写', () => {
  const prompt = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  // ⚠️ 3.0：「前文脉络」并入「时间与分线」⇒ 不再有"脉络 50 字"这把尺子（时间与分线的主线大事 ≤50）。
  assert.ok(!prompt.includes('前文脉络'), '脉络不该再出现在补齐提示词里（已并入时间与分线）')
  assert.ok(prompt.includes('人物关系一条 **80 字内**'), '「人物关系」一条 80 字（写清关系与变化）')
  assert.ok(
    prompt.includes('人物、世界观、通用概念、「文风（只写一次）」一条 **40 字内**'),
    '人物回到"条"：一条 ≤40 字（2026-10-02 读者实测后从"段 ≤200 字"改回）',
  )
  assert.match(prompt, /写不下就拆成两条/, '上限必须配一条出路，否则模型只会硬塞')
  assert.match(prompt, /同一段不再重写/, '时间骨架的"不重写"守着（原脉络的区间防重语义在这里延续）')
  // 八个小节与顺序：脉络并入后，输出节 = 文本类型/人物状态/关系/人物/世界观/文风/概念/时间与分线。
  for (const section of ['人物关系', '人物', '世界观', '文风（只写一次）', '通用概念']) {
    assert.ok(prompt.includes(`## ${section}`), `提示词里少了分区 ${section}`)
  }
})

test('补齐提示词：同一个人只能有一个 ### 主体，别名写进内容（防"人物卡出现两个同名"）', () => {
  const prompt = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  assert.ok(prompt.includes('一个人只有一个'), '要明写「一个人只有一个 ###」')
  assert.ok(prompt.includes('认出来就补到他名下'), '要明写「不同写法也算同一个人」')
  assert.ok(prompt.includes('标题只写最常用的那个名字'), '要明写标题只留一个名字')
})

test('补齐提示词：「人物关系」是平级的一节，不再点名"重点"（v1.65）', () => {
  const prompt = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  // ⚠️ 这条是**反向守卫**，锚的是带引号的完整句子（不是"重点"这个词）—— 注释里
  // 解释这段历史时会提到"重点"，盯一个词会被自己的文档绊倒（本项目踩过四次）。
  assert.ok(
    !prompt.includes('**人物关系是重点**'),
    '不该再点名"人物关系是重点"：模型会把预算全投在这一节，人物 / 文风只剩一半（实测：关系 744 字 / 人物 476 / 文风 229）',
  )
  // 正面要求还在，只是不再压过其它节；⚠️ 2026-10-02 **定稿成"一条写一对人、两个视角一次写全"**
  //    （读者实测"按有卡的人分组、两侧各写一条"之后**否掉了它**：25 字上限 + 两侧分写把关系压成
  //     标签 —— 22 字/条 vs 旧版 82 字/条，他说"不如之前的版本"）。
  assert.match(prompt, /一条写一对人，两个视角一次写全/, '这一节的结构要求仍要给全')
  assert.match(prompt, /只写关系，不写经历/, '关系和经历要分开：经历归「人物」')
  assert.match(prompt, /不同阶段各写一条/, '同一对人按阶段可以多条（旧文件里本来就是）')
})

test('补齐提示词：两步式（v1.66），且**不**强制龙套进人物卡', () => {
  const prompt = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  // ① 两步式：先写五节，再从「人物」条目推「人物关系」。
  assert.match(prompt, /分两步做，但只输出一份结果/, '要明写"分两步、只输出一份"')
  assert.match(prompt, /依据它整理出「人物关系」/, '第二步必须是从「人物」条目长出来的')
  assert.match(prompt, /要写够、不要为后面留预算/, '第一步不能被"后面还有一步"拖薄')
  // ② ⚠️ **两步都必须明写"只写新的"**（v1.66 修正）：原措辞只说"读你自己**刚写好的**「人物」
  //    一节" —— 那只在首轮（文件为空）成立。增量轮里累积的人物条目在「我之前整理过的认识」
  //    （输入）里，不在"刚写好的"里；不写清就会让模型只用本批一两条推关系 → 碎片化，
  //    或把已有关系换个说法重写 → 被 `mergeBackground` 追加成重复（去重键挡不住换说法）。
  assert.match(prompt, /这几节的新内容/, '第一步要明写"只整理新内容"')
  assert.match(prompt, /「我之前整理过的认识」里/, '第二步的"人物一节"要包含已有认识里的条目')
  assert.match(prompt, /同样只补新的/, '第二步要明写"只补新的"')
  assert.ok(!prompt.includes('你自己刚写好的'), '不许再说"你自己刚写好的「人物」一节"（只在首轮成立）')
  // ② ⚠️ **反向守卫**：不许出现"关系里每一方都必须有卡"这类强制（读者：人物卡不必把 NPC
  //    都写上）。试过的那版（强制闭合 / 只给重要角色立卡 / 禁自检三条一起）在验证臂里
  //    产出掉到 1,878 字，比任何一臂都薄 —— 已撤，只留 11。
  assert.ok(!prompt.includes('都必须在「人物」一节里'), '不许强制"关系里每一方都要有卡"')
  assert.ok(!prompt.includes('只给重要角色立'), '不许再加"只给重要角色立卡"（验证臂里它与产出变薄同时出现）')
  // ③ 规则编号必须**唯一**、而且**与出现顺序一致**（不许插空号）。
  //    ⚠️ 2026-10-01 两件事都查到过：
  //      · 联网那条与「立卡门槛」**重号 15**（按号引用有歧义）；
  //      · 编号**非单调**（1…11, 14, 15, 12, 13）—— 规则是按需要一条条追加的，
  //        读者看到"11 之后就是 14"直接问"是漏了三条吗？"（他原话）。
  //    现在号与位置对齐（1…16）：12 = 时间与分线、13 = 立卡门槛、14 = 只记以后会用到的、
  //    15 = 人物写变化、16 = 联网。**以后再加规则就往后排** —— 这两条断言会拦住插号。
  const withWeb = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
    allowWeb: true,
  })
  const numbers = [...withWeb.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
  assert.ok(numbers.length >= 10, `只提到 ${numbers.length} 条带号的规则 —— 提取逻辑可疑`)
  assert.equal(
    new Set(numbers).size,
    numbers.length,
    `规则编号不许重复（实测：${numbers.join(', ')}）`,
  )
  assert.deepEqual(
    numbers,
    [...numbers].sort((left, right) => left - right),
    `规则号必须与出现顺序一致（实测：${numbers.join(', ')}）—— 插空号会让读者以为漏了规则`,
  )
  assert.match(withWeb, /19\. 某个时代背景/, '联网那条排 19（规则号与出现顺序一致）')
  //      ⚠️ 编号表（改规则前先看这里）：12 = 时间与分线、13 = 立卡门槛、14 = 只留以后会用到的、
  //      15 = 人物写变化、16 = 文本类型（第一批的元判断）、17 = 两处分工、18 = 人物状态、19 = 联网（条件）。

  // ③b **声明与实际必须一致**：开头说"用下面 N 个小节"，格式块里就得真的列出 N 个。
  //     2026-10-01 抓到过一次**真实**的不一致：它写着"六个小节"，而格式块早已是七节
  //     （多了「时间与分线」）—— 模型被同时告知"六个"和看到七个，而它删掉的那一节
  //     恰恰是**不进提示词、只有读者能重建**的那节。这种"两处各写一遍、只改一处"
  //     是本仓库的经典形状，所以钉成不变式。
  const declared = /([五六七八九十])个小节/.exec(withWeb)
  assert.ok(declared !== null, '找不到"几个小节"的声明 —— 提取逻辑可疑')
  const declaredCount = { 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[declared[1]]
  const listedCount = (withWeb.match(/^## (?:文本类型|人物状态|人物关系|人物|世界观|文风（只写一次）|前文脉络|通用概念|时间与分线)$/gm) ?? []).length
  assert.equal(
    declaredCount,
    listedCount,
    `开头声明「${declared[1]}个小节」，格式块却列了 ${listedCount} 节 —— 必须一致`,
  )
  assert.equal(
    listedCount,
    8,
    '补齐输出现在是八节（文本类型 + 人物状态 + 注入四节 + 只给读者看的「时间与分线」；脉络已并入、冷档案不进输出）',
  )
})

test('补齐提示词：「文本类型」只在第一批判（之后按它写、不许重写）', () => {
  const base = {
    bookTitle: '书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  }
  const first = buildMemoryPrompt({ ...base, hasTextTypeSection: false })
  assert.match(first, /我\*\*还没判过\*\* ⇒ \*\*这一批请写在最前面\*\*/, '第一批要它判断文本类型')
  // 内容要点（读者 2026-10-02 定的形状）：像写一句自己的**简介** —— 方向 + 谁的故事 + 一句侧重。
  // 断言打在**要点**上、不钉整句（提示词会一轮轮被压短，见 lessons）。
  assert.match(first, /简介/, '要它像写一句自己的简介')
  assert.match(first, /什么方向/, '① 交代方向')
  assert.match(first, /谁的故事/, '② 交代是谁的故事')
  assert.match(first, /人称|视角/, '③ 人称与视角（读者 2026-10-02 追加要求）')
  assert.match(first, /第二位主角/, '④ 有没有第二位主角（读者追加要求）')
  assert.match(first, /方向/, '⑤ 各条目的大概方向')
  // ⚠️ 不许写长也不许死板：读者："元判断应该简短一些……不用可以强调"
  const rule = first.split('\n').find((line) => line.includes('第一批还要先写'))
  assert.ok(rule !== undefined, '找不到那条要求 —— 提取逻辑可疑')
  assert.ok(
    rule.length < 220,
    `这条要求太长了（${rule.length} 字）—— 产出的「文本类型」放宽到 200 字，但**提示词里这条要求本身**要保持紧凑，不许跟着膨胀`,
  )

  const later = buildMemoryPrompt({ ...base, existingMarkdown: '## 人物\n- 甲', hasTextTypeSection: true })
  assert.match(later, /这一批按它来写/, '之后每一批按元判断来写')
  assert.doesNotMatch(later, /这一批请写在最前面/, '不许每批都重判一遍')
})

test('元判断：「文本类型」不许写成"只记哪几个人"的范围限制，也不许推断后续（2026-10-02 实测）', () => {
  // ⚠️ 读者重建《魔女霓裳》跑前 50 章时，模型在「文本类型」里写下"人物卡只记竹纤、练霓裳和凌慕华三人"，
  //    还推断"后面就是这三人闯荡江湖的故事" —— 那是**拿前几十章给整本书定范围与剧情**。
  //    根因是**我的措辞**：我写的是"人物卡**收到什么程度**"，模型自然把它变成一份名单上限。
  const prompt = buildMemoryPrompt({
    bookTitle: '书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
    hasTextTypeSection: false,
  })
  assert.ok(!prompt.includes('人物卡收到什么程度'), '不许再给"给人物卡定范围"的邀请（那是名单上限的源头）')
  assert.match(prompt, /不写"只记哪几个人"这类范围 \/ 数量限制/, '要明说它不是范围限制')
  assert.match(prompt, /也不从前面几章推断后面会发生什么/, '要明说它不推断后续剧情')
  assert.match(prompt, /后面出现的重要角色照立/, '立卡范围由逐人判断，不预先限定')
  assert.match(prompt, /各条目一点\*\*侧重\*\*/, '给的是"侧重"，不是"范围"')
})

test('注入口径（3.0）：状态行每批注入且要更新；脉络已并入时间与分线', () => {
  assert.deepEqual(
    [...FILL_INCREMENTAL_SECTIONS],
    ['文本类型', '人物状态', '人物关系', '人物', '世界观'],
    '补齐子代理每批要看到的东西，就是这五节（「前文脉络」已并入「时间与分线」）',
  )
  assert.ok(FILL_INCREMENTAL_SECTIONS.includes('文本类型'), '文本类型是条目写法的依据 ⇒ 每批都要注入')
  assert.ok(FILL_INCREMENTAL_SECTIONS.includes('人物状态'), '状态行是"要更新"的东西 ⇒ 每批都要看到旧的才能替换')
  assert.ok(!FILL_INCREMENTAL_SECTIONS.includes('前文脉络'), '脉络不再注入（读者拍板的并入）')
  assert.ok(
    !FILL_INCREMENTAL_SECTIONS.includes('文风（只写一次）'),
    '文风写一次就够（稳定特征），后续补齐不再注入',
  )
  assert.ok(!FILL_INCREMENTAL_SECTIONS.includes('时间与分线'), '读者族（时间与分线/冷档案）不进补齐上下文（只在末尾给单元名）')
  assert.ok(!FILL_INCREMENTAL_SECTIONS.includes('通用概念'), '通用概念按"非空才给"单独处理')
})

test('截断识别：没写完的标题 / 没有句读收尾的条目算可疑；写完的不算', () => {
  // ⚠️ 2026-10-02 读者实测"子代理超出 token 被截断"。插件没给子代理设输出上限（上限在宿主），
  //    而宿主的停止原因**拿不到** ⇒ 只能用文本级启发式，并且只当"值得说一句"，不当拒绝理由。
  assert.equal(looksTruncated('## 人物\n### 甲\n- `第1章` 身份未明。'), false, '写完的不算')
  assert.equal(looksTruncated('## 人物\n### 甲\n- `第1章` 身份未明'), true, '没有句读收尾 ⇒ 可疑')
  assert.equal(looksTruncated('## 人物\n### 甲\n- `第1章` 身份'), true)
  assert.equal(looksTruncated('## 人物\n### 甲'), true, '末尾是个没写完的标题 ⇒ 铁证')
  assert.equal(looksTruncated('## 人物关系\n- 甲 ↔ 乙：对手（`第3章`）'), false, '以右括号收尾也算写完')
  assert.equal(looksTruncated('## 文风（只写一次）\n- `第1章` 短句为主**'), false, '以 ** 收尾也算写完（我们自己的格式常见）')
  assert.equal(looksTruncated(''), false, '空输出交给 UNPARSABLE_OUTPUT，不在这里判')
})

const SAMPLES = [
  { index: 0, title: '第一章 雪', text: '【第1章开头】他站在雪里。\n（中略）\n【第1章结尾】' },
  { index: 1, title: '第二章 夜', text: '【第2章开头】灯灭了。' },
]

/** 一段合法的小节输出。 */
const GOOD_OUTPUT = [
  '## 人物关系',
  '- 甲 ↔ 乙：对手（`第1章`）',
  '## 人物',
  '### 甲',
  '- `第1章` 身份未明',
].join('\n')

/** 造一个记录调用的替身 startRun。 */
function recorder(impl) {
  const calls = []
  return {
    calls,
    startRun: async (spec) => {
      calls.push(spec)
      return impl === undefined ? { output: [{ type: 'text', text: GOOD_OUTPUT }] } : impl(spec)
    },
  }
}

const BASE_REQUEST = {
  sessionId: 'session-abc',
  bookTitle: '夜行',
  samples: SAMPLES,
  fromChapter: 1,
  toChapter: 2,
  webGate: 'block-all',
}

/** 造一个补齐器。 */
function makeFiller(options = {}) {
  const rec = recorder(options.impl)
  const filler = createMemoryFiller({
    getSubagents: () => ({ start: async () => ({}) }),
    getAgent: () => ({ id: 'session-abc' }),
    startRun: rec.startRun,
    timeoutMs: options.timeoutMs,
    logger: {},
  })
  return { filler, calls: rec.calls }
}

//#region 提示词

test('提示词：样本带章节号，「（中略）」原样保留', () => {
  const prompt = buildMemoryPrompt(BASE_REQUEST)
  assert.match(prompt, /第 1 到第 2 章的\*\*节选\*\*/)
  assert.match(prompt, /### 第 1 章 第一章 雪/)
  assert.match(prompt, /### 第 2 章 第二章 夜/)
  // 中略标记必须留着，否则模型会以为文本是连贯的，把两段拼成一句。
  assert.match(prompt, /（中略）/)
  // （3.0 后：注入+读者一共八节 —— 脉络已并入时间与分线。）
  for (const section of ['人物关系', '人物', '世界观', '文风（只写一次）']) {
    assert.match(prompt, new RegExp(`## ${section}`))
  }
  // 顺序也要钉：模型是按这个顺序产出小节的，而解析侧按 BACKGROUND_SECTIONS
  // 认标题。两边顺序不一致时不会报错，只会让某一节静默落进 unknown。
  assert.ok(
    prompt.indexOf('## 文风（只写一次）') < prompt.indexOf('## 通用概念'),
    '「文风（只写一次）」排在「通用概念」前面（2026-10-02 读者要求）',
  )
  // 章节归属是合并去重的依据，必须明确要求。
  assert.match(prompt, /每条都以/)
  // 「文风（只写一次）」的约束是**只描述不评价**：MEMORY_PERSONA 原先明令禁止写文风，
  // 现在放开了，就必须换成"可以写特征、不要评好坏"这个更精确的说法。
  // ⚠️ 断言打在**不变式**上（"只描述" + 举例说明什么不行），不钉某一句原文 ——
  //    提示词的措辞会一轮轮被压短，钉死原句的守卫每轮都要改，还会把注意力从"约束还在不在"引开。
  assert.match(prompt, /只描述特征/)
  assert.match(prompt, /"文笔很好"不行/)
})

test('补齐提示词：「文风（只写一次）」只在**还没有**它的时候要求写（判据必须由调用方显式给）', () => {
  // ⚠️ 这条钉的是一个**真实的坑**（我自己先踩了一次）：后续批次传给 `buildMemoryPrompt`
  //    的 `existingMarkdown` 是 `renderExistingForFill` **过滤过的**（本来就不含文风），
  //    拿它判"有没有文风"会永远得到"没有" ⇒ 每一批都让模型再写一遍 —— 而"盲追加同义条目"
  //    正是这次改动要治的病。所以判据由调用方按**解析结果**显式传（`hasStyleSection`）。
  const filtered = ['## 人物', '### 甲', '- `第1章` 身份未明'].join('\n')
  const samples = [{ index: 9, title: '一', text: '正文' }]
  const base = { bookTitle: '书', samples, fromChapter: 10, toChapter: 10, existingMarkdown: filtered }

  const without = buildMemoryPrompt({ ...base, hasStyleSection: false })
  assert.match(without, /我\*\*还没有\*\* ⇒ \*\*这一批请写它\*\*/, '还没有这一节时要它写')

  const withStyle = buildMemoryPrompt({ ...base, hasStyleSection: true })
  assert.match(withStyle, /不要再写这一节/, '已经有这一节时要它别再写')
  assert.doesNotMatch(withStyle, /这一批请写它/, '不许同时说"请写"')
})

test('提示词：已有认识会被带上，并要求"只补充新东西"', () => {
  const prompt = buildMemoryPrompt({ ...BASE_REQUEST, existingMarkdown: '## 人物关系\n- 甲 ↔ 乙：对手' })
  assert.match(prompt, /这是我之前整理过的认识/)
  assert.match(prompt, /只补充新东西/)
  assert.match(prompt, /甲 ↔ 乙：对手/)
})

test('提示词：联网那句话只在允许联网时出现', () => {
  assert.ok(!buildMemoryPrompt(BASE_REQUEST).includes('联网'))
  assert.match(buildMemoryPrompt({ ...BASE_REQUEST, allowWeb: true }), /联网查\*\*设定类\*\*资料/)
})

test('提示词：不做 {{ 转义（子代理的 prompt 不走宿主插值）', () => {
  // 转义只对 systemPrompt.section 必要。这里转义反而会改动原著文字。
  const prompt = buildMemoryPrompt({ ...BASE_REQUEST, samples: [{ index: 0, title: '', text: '招式叫 {{破天}}' }] })
  assert.match(prompt, /\{\{破天\}\}/)
})

test('取文本：只认 text 块，忽略别的类型', () => {
  assert.equal(extractText({ output: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.equal(extractText({ output: [] }), '')
  assert.equal(extractText({}), '')
  assert.equal(extractText(null), '')
})

//#endregion

//#region 联网面

test('联网面：非 off 档位一律零工具', async () => {
  for (const webGate of ['block-all', 'block-book', undefined]) {
    const { filler, calls } = makeFiller()
    await filler({ ...BASE_REQUEST, webGate })
    assert.deepEqual(calls[0].toolFilter, { allow: [] }, `${webGate} 档位必须零工具`)
  }
})

test('联网面：off 档位给联网工具，但仍然零文件工具', async () => {
  const { filler, calls } = makeFiller()
  await filler({ ...BASE_REQUEST, webGate: 'off' })
  assert.deepEqual(calls[0].toolFilter, { allow: ['web_search', 'web_fetch'] })
  // 关键：不能顺手给它文件工具 —— 它拿不到章节正文以外的任何东西。
  assert.ok(!calls[0].toolFilter.allow.includes('read'))
})

test('联网面：宿主不认识联网工具时退化成零工具，而不是整个搞挂', async () => {
  // tools.restrict() 对未知工具名会直接抛错。这个宿主没装 web 工具，
  // 那是一次能力缺失，不该让补齐失败。
  let call = 0
  const specs = []
  const filler = createMemoryFiller({
    getSubagents: () => ({ start: async () => ({}) }),
    getAgent: () => ({ id: 'x' }),
    startRun: async (spec) => {
      specs.push(spec)
      call += 1
      if (call === 1) throw new Error('tools.restrict() names unknown global tool "web_search"')
      return { output: [{ type: 'text', text: GOOD_OUTPUT }] }
    },
    logger: {},
  })

  const result = await filler({ ...BASE_REQUEST, webGate: 'off' })
  assert.equal(result.ok, true, '应当退化成零工具并成功')
  assert.equal(specs.length, 2, '应当重试一次')
  assert.deepEqual(specs[1].toolFilter, { allow: [] })
})

//#endregion

//#region 绝不挂死

test('超时：子代理不响应取消时，我们必须自己退出（race，而不是只 abort）', async () => {
  // 这是本模块第一版真实踩过的坑：只调 `controller.abort()` 是**信号**，
  // 它不会替我们结束一个忽略该信号的 promise。宿主卡住时这个调用会永远挂着。
  let sawAbort = false
  const filler = createMemoryFiller({
    getSubagents: () => ({ start: async () => ({}) }),
    getAgent: () => ({ id: 'x' }),
    startRun: (spec) => new Promise(() => {
      // 一个永远不 resolve、也永远不看 signal 的 promise。
      spec.signal.addEventListener('abort', () => { sawAbort = true })
    }),
    timeoutMs: 40,
    logger: {},
  })

  const startedAt = Date.now()
  const result = await filler(BASE_REQUEST)
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'TIMEOUT')
  assert.ok(elapsed < 2000, `必须自己退出，实际用了 ${elapsed}ms`)
  // signal 仍然照传，让宿主有机会真正取消底层工作。
  assert.equal(sawAbort, true, '应当把 abort 信号传给子代理')
})

test('超时：默认超时是两分钟（用户选了阻塞式，愿意等）', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120000)
})

//#endregion

//#region 失败语义

test('失败：没有样本 / 没有活会话 / 没有子代理服务，各有各的原因', async () => {
  const { filler } = makeFiller()
  assert.equal((await filler({ ...BASE_REQUEST, samples: [] })).reason, 'NO_SAMPLES')

  const noParent = createMemoryFiller({
    getSubagents: () => ({}),
    getAgent: () => undefined,
    startRun: async () => ({}),
  })
  assert.equal((await noParent(BASE_REQUEST)).reason, 'NO_LIVE_PARENT')

  const noSubagents = createMemoryFiller({
    getSubagents: () => undefined,
    getAgent: () => ({ id: 'x' }),
    logger: {},
  })
  assert.equal((await noSubagents(BASE_REQUEST)).reason, 'SUBAGENTS_UNAVAILABLE')

  // getAgent 自己抛错也要有可读原因，而不是把异常冒到 HTTP 层。
  const throwing = createMemoryFiller({
    getSubagents: () => ({}),
    getAgent: () => { throw new Error('boom') },
    startRun: async () => ({}),
  })
  assert.match((await throwing(BASE_REQUEST)).reason, /PARENT_LOOKUP_FAILED/)
})

test('失败：模型输出为空或解析不出小节，都要能区分', async () => {
  const empty = makeFiller({ impl: () => ({ output: [] }) })
  assert.equal((await empty.filler(BASE_REQUEST)).reason, 'EMPTY_OUTPUT')

  const chatty = makeFiller({ impl: () => ({ output: [{ type: 'text', text: '好的，我读完了。' }] }) })
  assert.equal((await chatty.filler(BASE_REQUEST)).reason, 'UNPARSABLE_OUTPUT')
})

test('内容挂在 `### 主体` 下时不算"解析不出"（v1.22 分组分区）', async () => {
  // ⚠️ 这条钉的是 v1.22 **带出来的一个真 bug**：判据只数散条目（`sections`）与
  // 人物名，而「人物关系」「世界观」的条目现在大多挂在 `### 主体` 下。于是一份
  // **解析得好好的**输出会被判成 `UNPARSABLE_OUTPUT` —— 整批好数据被丢掉，
  // 而给出的理由还是错的。
  const grouped = makeFiller({
    impl: () => ({
      output: [{
        type: 'text',
        text: [
          '<!-- drc-background: schema=1 covered=1..9 -->',
          '## 人物关系',
          '### 甲 × 乙',
          '- `第2章` 对手',
          '## 世界观',
          '### 落霞谷',
          '- `第1章` 三面环水',
        ].join('\n'),
      }],
    }),
  })
  const result = await grouped.filler(BASE_REQUEST)
  assert.equal(result.ok, true, `不该被判成 ${result.reason}`)
  assert.deepEqual(result.parsed.groups['人物关系']['甲 × 乙'], ['`第2章` 对手'])

  // 同一个判据的另一半（旧代码本来就有）：它数了 `characters`，却没数**散条的**
  // 「人物」——那里放的是模型漏了 `###` 的条目。
  const looseOnly = makeFiller({
    impl: () => ({ output: [{ type: 'text', text: '## 人物\n- `第3章` 一个还没归类的人' }] }),
  })
  assert.equal((await looseOnly.filler(BASE_REQUEST)).ok, true)
})

test('失败：子代理抛异常时不冒泡，回结构化原因', async () => {
  const { filler } = makeFiller({ impl: () => { throw new Error('网络断了') } })
  const result = await filler(BASE_REQUEST)
  assert.equal(result.ok, false)
  assert.match(result.reason, /FAILED/)
  assert.match(result.reason, /网络断了/)
})

//#endregion

//#region 成功路径

test('成功：把模型输出解析成背景认识的小节', async () => {
  const { filler, calls } = makeFiller()
  const result = await filler(BASE_REQUEST)

  assert.equal(result.ok, true)
  assert.deepEqual(result.parsed.sections['人物关系'], ['甲 ↔ 乙：对手（`第1章`）'])
  assert.deepEqual(result.parsed.characters['甲'], ['`第1章` 身份未明'])
  assert.ok(result.elapsedMs >= 0)

  // 子代理必须挂在读者自己的会话下：宿主用父 Agent 解析模型路由与凭据。
  assert.equal(calls[0].parent.id, 'session-abc')
  assert.equal(calls[0].maxDepth, 1)
  assert.equal(calls[0].persona, MEMORY_PERSONA)
  assert.match(calls[0].label, /memory:1-2/)
  // prompt 是普通用户消息，不走宿主插值。
  assert.equal(calls[0].prompt[0].type, 'text')
})

test('成功：persona 是"读者自己"，不是陪读助手', () => {
  // 两种任务的身份不能混：陪读 AI 有"不许说后续"的对话约束，
  // 而整理笔记要的是"如实记录我从已读部分看出了什么"。
  assert.match(MEMORY_PERSONA, /你是这位读者自己/)
  assert.match(MEMORY_PERSONA, /不推测后续/)
})

test('补齐提示词：人物写弧线、只记以后会用到的、行首章号说真话（2026-10-01）', () => {
  // 读者（主要读小说）提的质量要求。⚠️ 试过又**撤掉**的一条：让「文风」记细致的"笔法" ——
  //    读者实测"产出太复杂"，明确要求**回到精炼的提炼方式** ⇒ 那条断言已删，别再捡回来。
  const prompt = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })

  // ① 「文风（只写一次）」保持精炼：只写特征（⚠️ 试过"细记笔法"又被读者撤掉了 —— 别再加回来）
  assert.match(prompt, /只描述特征/)
  assert.ok(!prompt.includes('也要记**笔法**'), '细致的笔法分析已经撤掉（读者："产出太复杂"）')
  // ② 「人物」写**变化**（弧线），不只写状态。⚠️ 2026-10-02：先改成"段"，读者实测后又**改回"条"**
  //    （"重复的问题我们已经处理完了，段和条的形式问题……还是用条比较好"）—— 条更细：超预算能逐条丢，
  //    也不会在压缩时被合成 715 字的巨段。
  assert.ok(prompt.includes('「人物」写变化，不只写状态'))
  assert.ok(prompt.includes('弧线比标签有用'))
  assert.match(prompt, /一条说一件事/)
  assert.ok(!prompt.includes('一段写成一条'), '段落式已被读者否掉，别再出现')
  // ③ 筛选标准：这是**工具书**，不是样本的复述
  assert.match(prompt, /只留以后还会用到的/)
  assert.ok(prompt.includes('给"以后的我"用的工具书'))
  // ④ **立卡门槛**（读者反馈"人物卡太多了"）—— 2026-10-02 随"回条"定稿成**两问 + 够两条**：
  //    它比"能不能写出一段小传"更硬（**可数**），也配"一条说一件事"的形态。
  //    ⚠️ 读者点破过的陷阱要防：没达标的人的事实要**归得到他名下**（写进关系条目 / 主要人物名下时带名字），
  //    攒够两条就能升卡 —— 否则"前一次没达标，后续每次增量也可能永远达标不了"。
  assert.match(prompt, /只关于他自己/, '门槛①：有没有只关于他自己的事实')
  assert.match(prompt, /这样的条目够\*\*两条\*\*吗/, '门槛②：够两条')
  assert.match(prompt, /等他攒够两条再立卡/, '没达标的先记在关系/别人名下，攒够两条再立卡')
  // ④b **分工判据**（2026-10-02 读者实测"关系和人物条目重复很多"之后加的）：
  //    实测重复例：`竹纤 ↔ 练霓裳：第29章 竹纤心中认定"她是，我的"` 与竹纤卡里同一句几乎逐字重复。
  assert.match(prompt, /把主语换成别人，这条还成立吗/, '分工判据：换成"他与某人的关系"还成立 ⇒ 那是关系')
  assert.ok(prompt.includes('只写在关系条目里，人物段落里不要再写一遍'))
  // ④c **第二处分工**（3.0 改版：「前文脉络」已并入「时间与分线」（读者拍板））：
  //    无归属人的事现在去「时间与分线」的**主线**（读者看）；设定/势力/规则的变化进「世界观」。
  assert.match(prompt, /这条能挂到某一个人名下吗/, '人物 vs 时间与分线的判据')
  assert.ok(prompt.includes('挂不到人名下的事件') || prompt.includes('挂不到人名下的大事'), '时间与分线收"没有归属人的事"（脉络的语义在这里延续）')
  assert.ok(prompt.includes('「世界观」'), '判据要说清：设定/势力/规则的变化进世界观（AI 也看）')
  // ⑤ ⚠️ **两步法的顺序必须留着**（读者明确要求："不要直接输出人物关系，而是先总结其他内容"）
  assert.match(prompt, /这一步\*\*不含\*\*「人物关系」/, '第①步不许抢跑写人物关系')
  assert.match(prompt, /② 再回头读「人物」这一节/, '第②步才是人物关系长出来的地方')
  // ⑥ 行首章号必须是**真正依据**的那一章（实测某本书把它填成别的章，合并/取代都会指不准）
  assert.ok(prompt.includes('真正依据'), '行首章号必须说"是你这条真正依据的那一章"')
})

//#endregion
