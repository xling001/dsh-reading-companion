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
  MEMORY_CHAR_BUDGET,
  MEMORY_ENTRY_BUDGET,
  MEMORY_PERSONA,
  buildMemoryPrompt,
  createMemoryFiller,
  extractText,
  looksTruncated,
  malformedGroupedSections,
  memoryBudgetOverrun,
  orphanEntriesOf,
} from '../lib/host/memory.js'
import {
  FILL_INCREMENTAL_SECTIONS,
  isGroupedSection,
  parseBackground,
  renderExistingForFill,
} from '../lib/host/background.js'

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
  // ⚠️ 2026-10-05：**「文风（只写一次）」从这把尺子里摘出去** ✓ —— 它是"整本书的特征"、只写一次，
  //    而当时正要求它**写细**（可到 120 字）⇒ 与"一条 40 字"直接冲突 ✗（提示词体检抓到的）。
  assert.ok(
    prompt.includes('人物、世界观、通用概念一条 **40 字内**'),
    '人物回到"条"：一条 ≤40 字（2026-10-02 读者实测后从"段 ≤200 字"改回）',
  )
  assert.match(
    prompt,
    /「文风（只写一次）」是\*\*整本书的特征\*\*、且只写这一次 ⇒ 它可以写到 \*\*120 字\*\*/,
    '文风要写明它不受 40 字约束（否则两条指令打架）',
  )
  assert.match(prompt, /写不下就拆成两条/, '上限必须配一条出路，否则模型只会硬塞')
  // ⚠️ 2026-10-04 改了这条的判据：从前钉的是"主线里**同一段不再重写**"，而那条**不可验证** ——
  //    投喂只给「时间与分线」的**单元名**、内容根本不贴（见 `renderExistingForFill`），
  //    模型无从判断"这一段是不是已经写过"。现在钉的是**它真正能执行的那一句**。
  assert.match(prompt, /别新造同义单元/, '时间骨架的"不重写"守着（判据落在"单元名是不是同一个阶段"上）')
  assert.match(prompt, /只给你\*\*单元名\*\*/, '要说清它只拿得到单元名 —— 否则那条判据又是不可执行的')
  // 八个小节与顺序：脉络并入后，输出节 = 文本类型/人物状态/关系/人物/世界观/文风/概念/时间与分线。
  for (const section of ['人物关系', '人物', '世界观', '文风（只写一次）', '通用概念']) {
    assert.ok(prompt.includes(`## ${section}`), `提示词里少了分区 ${section}`)
  }
  // ⚠️ 2026-10-07（工单 A1）：**格式块里「文风」的示例从前带着 `` `第1章` ``** ✗ ——
  //    而规则 1 与下面的条件说明**都说不带锚点**（它是整本书的特征）⇒ **示例在教错形状** ✗。
  //    真机复发过：3.1.23 为《魔女霓裳》的文风带着 `第1章` 修过，但当时只改了**规则文字**、
  //    示例没跟着改 ⇒ 模型照示例写。这条钉的正是**示例本身**（不是规则文字）。
  const styleBlock = prompt.slice(prompt.indexOf('## 文风（只写一次）'))
  const styleExample = styleBlock.split('\n').slice(1).find((line) => line.trim() !== '') ?? ''
  assert.ok(
    styleExample.startsWith('- '),
    `「文风」格式块的第一条示例形状变了（预期以 "- " 开头）：${styleExample}`,
  )
  assert.doesNotMatch(
    styleExample,
    /第\s*\d+\s*章/,
    '「文风」示例不许带章号锚点 —— 它是整本书的特征，带了会被读成"第1章的风格"',
  )
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
  // 正面要求还在，只是不再压过其它节；⚠️ 2026-10-02 曾定稿成"一条写一对人、两个视角一次写全"
  //    （读者实测"按有卡的人分组、两侧各写一条"之后**否掉了它**：25 字上限 + 两侧分写把关系压成
  //     标签 —— 22 字/条 vs 旧版 82 字/条，他说"不如之前的版本"）。
  // ⚠️ 2026-10-05 **读者又反转**：真机《魔女霓裳》上他拍板「**双向关系分开视角算两条，两个视角
  //    不算重复**」✓ —— 与上面那次相反 ✗（两次的差别在**条数上限**：这次一条 80 字，不是 25 字）。
  //    这里改成钉**新口径** ✓（`pairKeyOf` 也因此不排序）。
  assert.match(prompt, /一条写一对人/, '这一节的结构要求仍要给全')
  assert.match(prompt, /双向关系（两个人互相的视角）分开写两条/, '新口径：双向分开两个视角')
  assert.match(prompt, /只写关系，不写经历/, '关系和经历要分开：经历归「人物」')
  // ⚠️ 2026-10-05 **反向**：这一条从前钉着「同一对人可以在不同阶段各写一条」✗ ——
  //    它和第 17b 条（一对人一条）+ 合并层的 `pairKeyOf`（代码会并进）**正好相反** ✗
  //    ⇒ 现在钉「必须说的是同一口径」✓。
  assert.doesNotMatch(prompt, /不同阶段各写一条/, '旧口径已删（它与一对人一条相反）')
  // ⚠️ 2026-10-05 晚：口径再改一次 —— **双向关系分开视角算两条** ✓（读者真机《魔女霓裳》
  //    发现「只有练霓裳的视角」✗）⇒ 合并层也按**方向**并进 ✓ ⇒ 钉的就是这个 ✓。
  assert.match(prompt, /同一对、同一方向只有一条/, '必须与第 17b 条 + 合并层同口径')
  assert.match(prompt, /双向关系.*分开写两条/s, '双向要分开视角（不算重复）')
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

test('补齐提示词：「文本类型」只判**两件事**（类型 + 主视角）；之后按它写、不许重判（2026-10-03 收窄）', () => {
  const base = {
    bookTitle: '书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  }
  const first = buildMemoryPrompt({ ...base, hasTextTypeSection: false })
  assert.match(first, /我\*\*还没判过\*\* ⇒ \*\*这一批请写在最前面\*\*/, '第一批要它判断文本类型')
  // 内容要点（读者 2026-10-03 **收窄**）：只判**两件事** —— 类型 + **主视角是谁**。
  // ⚠️ 从前这里是四项（类型 / 人称 / 写作方式 / 主角是谁）+ 侧重，其中"**有没有 cp？**"
  //    那一问是**实测的祸首**：模型照问作答，在一本女主很晚才出现的书上写下
  //    "有 cp（孟奇 ↔ 江芷微等同伴）" —— 而这一节**只写一次、每批都注入**，
  //    判错会被永久带下去。"人称 / 写作方式"与「文风（只写一次）」重复，一并删掉。
  assert.match(first, /属于什么类型/, '① 类型')
  assert.match(first, /主视角是谁/, '② 主视角（不是"主角是谁"：POV 判得准，"谁是主角"早期判不准）')
  assert.match(first, /省略号/, '③ 剧情只用省略号带过（模糊化的落点）')
  assert.doesNotMatch(first, /有没有 cp/, '⚠️ 不许再问 cp —— 读不出来的问题必然被猜，而它每批都注入')
  assert.doesNotMatch(first, /第几人称|写作方式/, '⚠️ 删掉与「文风」重复的两项（顺带减提示词负载）')
  // ⚠️ 不许写长也不许死板：读者："元判断应该简短一些……不用可以强调"
  const rule = first.split('\n').find((line) => line.includes('「文本类型」只判两件事'))
  assert.ok(rule !== undefined, '找不到那条要求 —— 提取逻辑可疑')
  assert.ok(
    rule.length < 330,
    `这条要求太长了（${rule.length} 字）—— 「文本类型」本身收窄到 40 字，提示词里这条要求也不许膨胀`,
  )

  const later = buildMemoryPrompt({ ...base, existingMarkdown: '## 文本类型\n- 原始判断。', hasTextTypeSection: true })
  // ⚠️ 2026-10-04：这里从前钉的是「**这一批按它来写**」，而那句与规则 20 的"按你读到的判断"
  //    构成**同一权威两处**（评审发现）。现在变动区改成"**把它当判断依据之一**"、
  //    并**点名方向由第 20 条定** ⇒ 权威只在一处。所以断言跟着钉这两件事。
  assert.match(later, /把它当判断依据之一/, '之后每一批把元判断当**依据之一**')
  assert.match(later, /见\*\*第 20 条\*\*/, '要说清"方向怎么定"归第 20 条（权威只有一处）')
  assert.doesNotMatch(later, /这一批请写在最前面/, '不许每批都顺手重判一遍')
  // ⚠️ **2026-10-03 读者把它改回"只写一次"**（同一天先放宽、后收回），理由是**稳定性**：
  //    它是每批都注入的方向指导，一改，后面所有批次的写法方向跟着变。
  //    ⇒ 提示词里**不许**再出现任何"申请重写 / 重判"的路子（那会重新引入纠错口）。
  assert.match(later, /也别改写它/, '要明说：每批注入，别改写它（一改后面全跟着变）')
  assert.doesNotMatch(later, /重判|另起一次单独的调用|已取代/, '不许再给重判这条路')
  assert.doesNotMatch(later, /drc-rejudge/, '标记也一并删干净了')
})

test('补齐预算：提示词里写明**条目数 + 总长**两个数（事前约束），超了要能看见', () => {
  // ⚠️ 这两个数是**事前**约束：写在提示词的固定块里（跨批逐字相同 ⇒ 不破坏稳定前缀），
  //    不再是"事后砍半重试"那一条路唯一的兜底。
  const prompt = buildMemoryPrompt({
    bookTitle: '书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  assert.match(prompt, new RegExp(`最多写 ${MEMORY_ENTRY_BUDGET} 条`), '条目数上限要在提示词里')
  assert.match(prompt, new RegExp(`不超过 ${MEMORY_CHAR_BUDGET} 字`), '总长上限要在提示词里')

  // 预算内 ⇒ 什么都不报。
  const small = parseBackground(['## 人物', '### 甲', '- `第1章` 甲。'].join('\n'))
  assert.equal(memoryBudgetOverrun(small), null)

  // 条目数超了。
  const many = parseBackground([
    '## 人物',
    '### 甲',
    ...Array.from({ length: MEMORY_ENTRY_BUDGET + 1 }, (_, i) => `- \`第${i + 1}章\` 甲。`),
  ].join('\n'))
  const byEntries = memoryBudgetOverrun(many)
  assert.ok(byEntries !== null, '条目数超预算必须能看见')
  assert.equal(byEntries.entries, MEMORY_ENTRY_BUDGET + 1)

  // 总长超了（条目数没超）。
  const long = parseBackground(['## 人物', '### 甲', `- \`第1章\` ${'甲'.repeat(MEMORY_CHAR_BUDGET + 1)}`].join('\n'))
  const byChars = memoryBudgetOverrun(long)
  assert.ok(byChars !== null, '总长超预算必须能看见')
  assert.equal(byChars.entries, 1)
  assert.ok(byChars.chars > MEMORY_CHAR_BUDGET)
})

test('元判断：「文本类型」不许写成"只记哪几个人"的范围限制，也不许替整本书定调（2026-10-02/03 实测）', () => {
  // ⚠️ 读者重建《魔女霓裳》跑前 50 章时，模型在「文本类型」里写下"人物卡只记竹纤、练霓裳和凌慕华三人"，
  //    还推断"后面就是这三人闯荡江湖的故事" —— 那是**拿前几十章给整本书定范围与剧情**。
  //    根因是**我的措辞**：我写的是"人物卡**收到什么程度**"，模型自然把它变成一份名单上限。
  //    2026-10-03 读者进一步要求**模糊化**：只写形态，剧情用省略号带过 ⇒ "不推断后续"那句
  //    由**机制**（省略号 + 不许下判断）承担，不再单列一句重复叮嘱。
  const prompt = buildMemoryPrompt({
    bookTitle: '书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
    hasTextTypeSection: false,
  })
  assert.ok(!prompt.includes('人物卡收到什么程度'), '不许再给"给人物卡定范围"的邀请（那是名单上限的源头）')
  assert.match(prompt, /不写"只记哪几个人"这类范围 \/ 数量限制/, '要明说它不是范围限制')
  assert.match(prompt, /后面出现的重要角色照立/, '立卡范围由逐人判断，不预先限定')
  assert.match(prompt, /省略号/, '剧情只用省略号带过（不替整本书定调）')
  assert.match(prompt, /不对故事走向与内容下判断/, '明确"不评判故事走向与内容"')
  // ⚠️ **2026-10-03 读者拍板：侧重从「文本类型」搬进提示词的固定块（第 20 条）。**
  //    搬家的理由：这条指令的消费者只有**补齐子代理**，而「文本类型」是 `family: 'full'`
  //    —— **每个聊天轮次都整条注入** ⇒ 放在文件里等于让聊天为一份用不上的指令**永久付费**，
  //    还叠上"只写一次 ⇒ 错一次永久定向"的放大器。
  //    ⇒ "侧重必须存在"这件事**没有变**（读者同一天更正过：模糊化的靶子是剧情，
  //    不是"指导条目"），变的是**它住在哪** —— 现在钉的是固定块里那一条。
  assert.match(
    prompt,
    /各节该往哪个方向用力/,
    '必须保留"给各节定用力方向"（2026-10-03 读者更正：模糊化的靶子是剧情，不是指导条目）',
  )
  assert.match(prompt, /只是用力方向，不是例外/, '⚠️ 要明写从属关系：指导不许凌驾于原则之上')
  assert.doesNotMatch(prompt, /再给各条目一点侧重/, '⚠️ 它已经不在「文本类型」里了（搬进固定块第 20 条）')
  // ⚠️ 这一条**从前是空的**（记下来，别重犯）：子代理加的是
  //    `assert.ok(!prompt.includes('各条目一点**侧重**'))`，而原文写的是
  //    `**再给各条目一点侧重**` —— `**` 在**整句外面**，那个字符串**从来没出现过**
  //    ⇒ 断言恒真、删没删都绿。**"钉住某个字符串不存在"必须先证明它在删除前真的存在**
  //    （把删除前的那版跑一遍，或者至少贴出原文），否则它不是守卫，是装饰。
  assert.ok(
    !prompt.includes('各条目一点**侧重**'),
    '夹具自证：上面那个错的写法确实不存在（说明旧断言为什么是空转）',
  )
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
          '- 甲 ↔ 乙：`第2章` 对手',
          '## 世界观',
          '### 落霞谷',
          '- `第1章` 三面环水',
        ].join('\n'),
      }],
    }),
  })
  const result = await grouped.filler(BASE_REQUEST)
  assert.equal(result.ok, true, `不该被判成 ${result.reason}`)
  // ⚠️ 「人物关系」2026-10-04 改回平铺 ⇒ 它的条目在 `sections` 里；
  //    「世界观」仍是分组 ⇒ `### 落霞谷` 那一半继续钉着本用例的原意。
  assert.deepEqual(result.parsed.sections['人物关系'], ['甲 ↔ 乙：`第2章` 对手'])
  assert.deepEqual(result.parsed.groups['世界观']['落霞谷'], ['`第1章` 三面环水'])

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
  // ⚠️ 2026-10-05 去重：13 不再自带一套三问，只留**他专属的那一条** ✓ ⇒ 断言跟着改 ✓。
  assert.match(prompt, /只关于他自己.*够两条吗/s, '门槛：他专属的那一条（够两条）')
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
  //    ⚠️ 2026-10-08（工单 A7-F4）：这句从前钉的是 /这一步\*\*不含\*\*「人物关系」/ ✗ ——
  //    而它紧跟**步骤②**（正是产出「人物关系」的那一步）⇒ 「这一步」的先行词最自然是②
  //    ⇒ **字面自相矛盾**（讽刺的是守卫自己的名字就写着"第①步"✓）。提示词已改成明写
  //    「第①步」✓，这里同步换新措辞 —— **判据一个字没变** ✓。
  assert.match(prompt, /第①步不含「人物关系」/, '第①步不许抢跑写人物关系')
  assert.match(prompt, /② 再回头读「人物」这一节/, '第②步才是人物关系长出来的地方')
  // ⑥ 行首章号必须是**真正依据**的那一章（实测某本书把它填成别的章，合并/取代都会指不准）
  assert.ok(prompt.includes('真正依据'), '行首章号必须说"是你这条真正依据的那一章"')
})

test('「人物状态」收窄到两项 + 必须带章号；名单由代码给（2026-10-03 读者拍板）', () => {
  const base = {
    bookTitle: '书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  }
  const prompt = buildMemoryPrompt(base)
  // ① **字段收敛**：从"当前处境 / 立场 / 目标 / 在哪条线上"砍到**两项**。
  //    "要干什么"是**动机**、归「人物」；"在哪条线上"指的是**分线**，而分线是
  //    **读者族、AI 根本看不到** ⇒ 对 AI 无意义。两条都是**白付注入预算**。
  assert.match(prompt, /此刻在哪 \+ 站在哪边/, '只写这两项')
  assert.doesNotMatch(prompt, /身处哪条线上/, '⚠️ 旧口径不许回来（AI 看不到分线）')
  assert.match(prompt, /他打算干什么"是「人物」的事/, '动机归「人物」，要说清分工')
  // ② **≤30 字**（原 60）。
  assert.match(prompt, /≤30 字/, '一条 ≤30 字')
  // ③ ⚠️ **必须带章号**：注入侧倒退时"没章号 ⇒ 一律丢"（`background.js`），
  //    而代码注释记录了实测"状态行常常没章号" ⇒ 不带就会在倒退时**整批被丢**。
  assert.match(prompt, /行首必须带/, '行首章号要在这一节**就近**要求（别只靠全局第 1 条）')
  // ④ **名单由代码给**：给了就点名，不给就退回兜底判据、不多说一句。
  const named = buildMemoryPrompt({ ...base, stateSubjects: ['甲', '乙'] })
  assert.match(named, /只写这些人的一行/, '给了名单就要说清"只写这些人"')
  assert.ok(named.includes('甲、乙'), '名单本身要出现在提示词里')
  assert.doesNotMatch(prompt, /只写这些人的一行/, '没给名单时不许凭空点名（首批还没有任何卡）')
})

test('格式块：每一节的示例形状必须与注册表一致（分组节必须有 `### 主体`）（2026-10-03 实测）', () => {
  // ⚠️ **这条守卫防的是"同一个概念两个定义点"复发**：一节的形状原本有两处定义 ——
  //    注册表的 `grouped`，和提示词格式块**教给模型的示例**。它们漂移过，代价是：
  //    ① 「世界观」的示例教平铺 ⇒ 这一节永远不会分组；
  //    ② 「人物关系」的示例教平铺 ⇒ 读者**照格式块写**的修正被 `validateUpdate` 拒收（`NO_SUBJECT`），
  //       而注册表给它的理由白纸黑字写着"`###` 让每条关系有**可寻址的主体**，这正是「取代」能
  //       指哪打哪的前提"。
  //    ⭐ 实测（4/4 真实背景文件）：`## 人物关系` 的 `###` 数全是 **0**、条目全是平铺 ——
  //    那正是**提示词教出来的**，不是模型不会分组。
  const prompt = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  const lines = prompt.split('\n')
  const start = lines.findIndex((line) => line.includes('按下面'))
  const end = lines.findIndex((line) => line.trim() === '要求：')
  assert.ok(start >= 0 && end > start, '找不到格式块的边界 —— 提取逻辑可疑')

  const shown = new Map()
  for (let i = start; i < end; i += 1) {
    const m = /^## (.+)$/.exec(lines[i])
    if (!m) continue
    let j = i + 1
    let hasHeading = false
    while (j < end && !/^## /.test(lines[j])) {
      if (/^### /.test(lines[j])) hasHeading = true
      j += 1
    }
    shown.set(m[1].trim(), hasHeading)
  }

  for (const name of FILL_INCREMENTAL_SECTIONS) {
    assert.notEqual(shown.get(name), undefined, `格式块里必须有「${name}」的示例`)
    assert.equal(
      shown.get(name),
      isGroupedSection(name),
      `「${name}」的示例形状与注册表不一致（注册表 grouped=${isGroupedSection(name)}，`
      + `示例里${shown.get(name) ? '有' : '没有'} \`###\`）—— 形状只有一个定义点（注册表），示例必须跟它走`,
    )
  }
})

test('补齐侧：分组节在文件里是平铺时**当场提示归位**（断掉"一次坏批次永久教坏"的回路）', () => {
  // ⚠️ 平铺回显会**自我强化**：子代理看到"这一节长这样"就接着写平铺 ⇒ 一次坏批次永久定型。
  //    实测《一世之尊》的 `## 人物` 就是这么塌成平铺流水账、人物卡全空的。
  const flat = parseBackground([
    '<!-- drc-background: schema=1 covered=1..41 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物',
    '- `第4章` 真定：少林僧人。',
    '- `第28章` 真定：与孟奇同行。',
  ].join('\n'))
  const text = renderExistingForFill(flat)
  assert.match(text, /没有 `###` 主体/, '要说出这一节的形状坏了')
  assert.match(text, /这一批请照 `### 主体` 分组写/, '要给出正确形状（不能只说"坏了"）')
  // ⚠️⚠️ **不许叫它"把已有条目归位 / 重发一遍"**（2026-10-03 实测）：背景认识**只增不减**，
  //    而合并**只在同一个桶里去重** —— 散行在 `sections`、分组在 `groups` ⇒ 同一句话
  //    跨桶重发会**两份都留下、渲染出两次**（探针 `_probe-dedup.mjs` 复现过）。
  //    第一版措辞就是"请把已有条目按主体归到 `### 主体` 下面"，那是个**会制造重复的指令**。
  assert.match(text, /别把上面已有的条目重发一遍/, '必须明说别重发')
  assert.doesNotMatch(text, /按主体归到/, '⚠️ 不许要求"把已有条目归位" —— 那正是制造重复的做法')

  // 正常文件（有 `###`）不许出现这条提示 —— 否则每批都在喊狼来了。
  const good = parseBackground([
    '<!-- drc-background: schema=1 covered=1..41 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物',
    '### 真定',
    '- `第4章` 少林僧人。',
  ].join('\n'))
  assert.doesNotMatch(renderExistingForFill(good), /没有 `###` 主体/, '形状正常时不许出现这条提示')

  // ⚠️ **平级节**（「文本类型」`grouped=false`，一条一行）不许被当成坏的。
  //    ⚠️ 夹具必须挑一个**在 `FILL_INCREMENTAL_SECTIONS` 里**的平级节 —— 第一版用的是
  //    「文风（只写一次）」，它不在那个列表里 ⇒ `renderExistingForFill` 根本不渲染它
  //    ⇒ 这条断言**空转**（变异电池第 ④ 项就是这么发现它是装饰的）。
  const flatOk = parseBackground([
    '<!-- drc-background: schema=1 covered=1..41 -->',
    '# 《书》· 背景认识',
    '',
    '## 文本类型',
    '- 男频武侠，主视角是孟奇。',
  ].join('\n'))
  assert.match(renderExistingForFill(flatOk), /男频武侠/, '夹具要真的被渲染出来（否则断言空转）')
  assert.doesNotMatch(renderExistingForFill(flatOk), /没有 `###` 主体/, '平级节平铺是正常的，不许误报')
})

test('补齐落盘：分组节写成平铺要**如实报**（报告，不是裁剪）（2026-10-03）', () => {
  // ⚠️ 与 `memoryBudgetOverrun` 同一个口径：**条目照常落盘**（背景认识只增不减），
  //    报出来只是让"形状坏了"这件事看得见 —— 否则读者只看到"人物卡空了"，不知道原因。
  //    病根：`NO_SUBJECT` 只管"模型自己写记忆"那条路，**补齐这条路零结构校验**。
  const flat = parseBackground([
    '<!-- drc-background: schema=1 covered=1..41 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物',
    '- `第4章` 真定：少林僧人。',
    '',
    '## 世界观',
    '- `第1章` 少林是名门正派。',
  ].join('\n'))
  assert.deepEqual(malformedGroupedSections(flat), ['人物', '世界观'], '按文件节序报出写坏的分组节')

  const good = parseBackground([
    '<!-- drc-background: schema=1 covered=1..41 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物',
    '### 真定',
    '- `第4章` 少林僧人。',
    '',
    '## 文风（只写一次）',
    '- 爱用短句。',
  ].join('\n'))
  assert.deepEqual(malformedGroupedSections(good), [], '正常文件（含平铺的平级节）一条都不许报')
})

test('补齐落盘：形状坏了要**分两档**报 —— 有名字的会自愈，没名字的是永久孤儿（2026-10-05，两本真机书实测）', () => {
  // ⚠️ 病根（读者真机报告 + 实测）：模型漏写 `### 主体` 时，散行落进平铺桶，而
  //    「散行归位」的判据**刻意窄**（名字必须已经是这一节的一个 `###`）⇒ 搬不动的分两类：
  //      · `- 甲：…`：**有名字**，下一批回显会提示"照 `### 主体` 分组写"，模型给甲建桶之后
  //        这条在**下一次解析**时被自动吸收 ⇒ **会自愈**；
  //      · `- \`第30章\` 少华山…`：**没名字**（`textSubjectOf` 回空串）⇒ 模型也无从知道
  //        它是谁的 ⇒ **永远不会归位、也不会被替换**（替换按主体找）⇒ **只能手工改**。
  //    从前两者报同一句话（"下一批会提示模型归位"）⇒ 对第二类**是假话**。
  //    可证伪：把 `orphanEntriesOf` 的判据从 `=== ''` 改成 `!== ''` ⇒ 本用例第一条红。
  const mixed = parseBackground([
    '<!-- drc-background: schema=1 covered=1..84 -->',
    '# 《书》· 背景认识',
    '',
    '## 人物状态',
    '- `第30章` 少华山轮回世界中，与江芷微一路送内奸名单。',
    '- `第49章` 竹纤：随卓仲廉一行往阳平关。',
    '### 真妙',
    '- `第58章` 真常事发，随众搜索悬崖。',
  ].join('\n'))

  assert.deepEqual(malformedGroupedSections(mixed), ['人物状态'], '这一节有搬不动的散行')
  assert.deepEqual(
    orphanEntriesOf(mixed),
    [{ name: '人物状态', entries: ['`第30章` 少华山轮回世界中，与江芷微一路送内奸名单。'] }],
    '只有取不出主体名的那条才算永久孤儿（`竹纤：…` 有名字 ⇒ 下一批能给竹纤建桶、会被吸收）',
  )

  // ⚠️ **反面一：有名字但本节没有同名 `###`** —— 那是"能自愈"的那一类，不许报成永久孤儿
  //    （真机形态：`## 通用概念` 里 `- \`第18章\` 善功：…`，而这一节没有 `### 善功`）。
  const healable = parseBackground([
    '## 通用概念',
    '- `第18章` 善功：轮回世界通行的兑换点数。',
  ].join('\n'))
  assert.deepEqual(malformedGroupedSections(healable), ['通用概念'], '它确实搬不动（本节没有同名主体）')
  assert.deepEqual(orphanEntriesOf(healable), [], '但它**报了名字** ⇒ 不许报成永久孤儿')

  // ⚠️ **反面二：形状正常** ⇒ 一条都不许报
  const good = parseBackground(['## 人物状态', '### 甲', '- `第9章` 在山门。'].join('\n'))
  assert.deepEqual(orphanEntriesOf(good), [], '形状正常时一条都不许报')
})

test('补齐提示词：散行**必须自带主体名**（写入侧的堵口，2026-10-05 两本真机书实测）', () => {
  // ⚠️ 上报只能让读者看见；**真正防住新孤儿的是写入侧** —— 形状可以退（漏写 `###`），
  //    但名字不能丢：没有主体名的状态行下一批顶不掉、不出卡，而注入时它是
  //    **一句没有主人的"此刻"**（这一节的全部价值恰恰是"**这个人**此刻在哪"）。
  //    ⚠️ **两处都要有，且要分开钉**：格式块（示例旁边）与规则 18（判据旁边）。
  //    第一版把三句一起钉，于是"删掉其中一处"**照样绿** —— 守卫形同虚设
  //    （实测：只删规则 18 那一句，三句断言仍全部命中格式块里的同义句）。
  //    可证伪：删掉格式块那一句 ⇒ 前两条红；删掉规则 18 那一句 ⇒ 后两条红。
  const prompt = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  const lines = prompt.split('\n')
  const start = lines.findIndex((line) => line.includes('按下面'))
  const end = lines.findIndex((line) => line.trim() === '要求：')
  assert.ok(start >= 0 && end > start, '找不到格式块的边界 —— 提取逻辑可疑')
  const formatBlock = lines.slice(start, end).join('\n')
  const rules = lines.slice(end).join('\n')

  assert.match(formatBlock, /万一没写成/, '格式块的示例旁边要说清"没写成 `###` 时怎么办"')
  assert.match(formatBlock, /- 主体：/, '格式块里要给出散行的形状（`- 主体：`第N章` …`）')
  assert.match(rules, /万一写成散行/, '规则 18 要给出同一条兜底')
  assert.match(rules, /没有主体名的状态行/, '规则 18 还要说清代价（没有主体名 ⇒ 没有主人）')
})

//#endregion
