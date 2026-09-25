/**
 * 记忆补齐 —— 一次调用，补「缺失的全部前文」这一整段。
 *
 * ## 与早期设计的区别
 *
 * 早期是**每章一条梗概**：翻到第 5 章就为第 5 章起一个子代理，第 6 章再起一个。
 * 一本 300 章的书意味着 300 次模型调用，而每次只处理一章——既贵，又把
 * "理解"切成了互不相干的碎片。
 *
 * 现在是**一次调用处理一整段缺口**：把 `[缺口起点 .. 前文末章]` 抽样后一起交给
 * 一个子代理，让它产出**结构化的背景认识**（世界观 / 人物 / 人物关系 / 文风 /
 * 前文脉络 / 通用概念），合并进 `background.md`，然后水位线推到位。章节数不再
 * 等于调用次数。
 *
 * ## 子代理是谁
 *
 * 它不是"陪读 AI"，而是**读者自己的整理笔记的那一面**。这个身份很重要：
 * 陪读 AI 有"不许说后续"的对话约束，而整理笔记需要的是"如实记录我从已读部分
 * 看出了什么"。两种任务用同一个 persona 只会互相打架。
 *
 * ## 机制部分不在这里
 *
 * 父 Agent 查找、超时 race、联网工具面的降级都在 `subagent-run.js`——压缩
 * （`compact.js`）要的是同一套东西，只写一遍。
 */

import { BACKGROUND_GROUPED_SECTIONS, BACKGROUND_SECTIONS, parseBackground } from './background.js'
import {
  DEFAULT_TIMEOUT_MS,
  createSubagentRunner,
  extractText,
} from './subagent-run.js'

export { DEFAULT_TIMEOUT_MS, extractText }

/**
 * 整理者的身份与硬约束。
 *
 * @type {string}
 */
export const MEMORY_PERSONA = [
  '你是这位读者自己——不是助手，不是评论家，不是百科。',
  '你正在读一本书，边读边把自己对它的理解整理成笔记，供以后的自己查阅。',
  '严格约束：',
  '1. 只使用给你的章节样本里出现过的信息。样本没说的一律不写，绝不推测后续。',
  '2. 不要写读后感、不要复述大段原文。「文风」一节只**描述**风格特征（视角、句式、用词、节奏），不做优劣评价。',
  '3. 严格按要求的 Markdown 小节格式输出，不要任何额外说明。',
].join('\n')

/**
 * 构造补齐提示词。
 *
 * ⚠️ 这里**不做** `{{` 转义：转义只对 `systemPrompt.section/context` 必要
 * （宿主会对那些文本做变量插值）。子代理的 `prompt` 是普通用户消息，不走插值，
 * 转义反而会改动原文。
 *
 * @param {object} input
 * @param {string} input.bookTitle 书名
 * @param {{index: number, title: string, text: string}[]} input.samples 章节样本（0 起 index）
 * @param {string} [input.existingMarkdown] 已有背景认识的原文
 * @param {number} input.fromChapter 本批起始章（1 起）
 * @param {number} input.toChapter 本批结束章（1 起）
 * @param {boolean} [input.allowWeb] 是否允许联网
 * @returns {string}
 */
export function buildMemoryPrompt(input) {
  const samples = Array.isArray(input?.samples) ? input.samples : []
  const body = samples
    .map((sample) => `### 第 ${sample.index + 1} 章${sample.title ? ` ${sample.title}` : ''}\n\n${sample.text}`)
    .join('\n\n')

  // ⚠️ **固定块放在最前面**（v1.59）：它**跨批、跨书都逐字相同**，所以这一段就是提示词的
  // **稳定前缀** —— 同一本书连补十几批时，前几批的这段可以被前缀缓存复用 ✓。
  //
  // 从前的顺序是「开头话 → 已有认识 → 样本 → 要求」✗：每一句都在变（书名、章号、样本），
  // 也就是**没有任何稳定前缀**，1100 多字符每次都全价重发。重排之后不稳定部分只剩尾部：
  // 开头话 + 已有认识 + 章节样本。
  const requirements = [
    '请把**下面**给你的内容整理成我的「背景认识」，严格用下面六个小节，顺序固定，不要别的话：',
    '',
    '## 人物关系',
    '- 甲 ↔ 乙：他们是什么关系、怎么变的（`第3章`）',
    '',
    '## 人物',
    '### 甲',
    '- `第1章` 身份、性格、立场要点',
    '',
    '## 世界观',
    '- `第1章` 设定、势力、规则要点',
    '',
    '## 文风',
    '- `第1章` 叙述视角、句式习惯、用词偏好、节奏、对话密度',
    '',
    '## 前文脉络',
    '- `第1-5章` 这一段发生了什么',
    '',
    '## 通用概念',
    '### 概念名',
    '- `第1章` 这个概念是什么、书中怎么说它',
    '',
    '要求：',
    '1. **每条都用 `` `第N章` `` 标出是从哪一章看出来的**。',
    '2. **人物关系**：谁和谁是什么关系、怎么变的，按章号写清变化。',
    '3. **文风只写特征，不评价好坏**（"爱用短句"可以，"文笔很好"不行）；它不含剧情，'
    + '所以只从最早的几章看出来也能写。',
    '4. **只写样本里能看出来的**；看不出人物关系就留空那一节，不要编。',
    '5. 尽量短：人物、世界观、文风一条 40 字内，前文脉络一条 60 字内。',
    '6. 没有新信息的节可以省略。',
    '7. **先过一遍下面「我之前整理过的认识」里已有的每一位主体**：有新信息就补到他名下，'
    + '没有就一条都不写 —— **已有的说法不要换个说法重写**。'
    + '**「前文脉络」尤其如此：已经写过的章号范围不要再写一遍**，只用新条目补它没覆盖的部分。',
    '8. **专名照抄原文**（人名、地名、门派、器物、招式、称号），不要意译、缩写或改称呼，'
    + '也不要用"某人""那个地方"代替。',
    '9. **「通用概念」是兜底**：能归进上面任何一节的就归进去，只有归不进去才写这里。'
    + '如果这本书本来没有人物 / 关系 / 世界观可言（史书、哲学、技术书），就把它的核心概念'
    + '都放这一节，一个概念一个 `### 概念名`。',
    '10. **一个人只能有一个 `###`**：小名、别称、赐名前后的称呼、带不带括号说明都算同一个人，'
    + '**认出来就补到他名下**，绝不为他新建第二个 `###`。标题只写**一个名字**（最常用的那个），'
    + '小名与别称写进条目内容里。',
    // ⚠️ 11 是 v1.66 加的（读者提的两步式）：让「人物关系」从**人物条目**上长出来，
    // 而不是和别的节抢同一批注意力。实测「人物」一节 655 → 932 字（+42%，单次样本）。
    //
    // ⚠️ v1.66 修正（同一版内）：**两步都必须明写"只写新的"**。原措辞只说"回过头读你
    // **自己刚写好的**「人物」一节" —— 那只在**首轮**（文件为空）成立；**增量轮**里累积的
    // 人物条目在「我之前整理过的认识」（输入）里、不在"刚写好的"里，于是模型可能只用本批
    // 新增的一两条去推导关系 → 关系碎片化，或把已有关系重新推导一遍 → 换个说法 → 被
    // `mergeBackground` 当成新条目**追加成重复**（去重键是"去掉章号与标点后的正文"，挡不住
    // 换说法）。见 design-v1 v1.66。
    //
    // ⚠️ 刻意**只**加这一条。试过但撤掉的两条（都留档在 v1.66）：
    //   · "「人物关系」里每一方都必须在「人物」里有 `###`" → 会把龙套逼进人物卡（读者不要）；
    //   · "「人物」只给重要角色立卡 + 输出里不许留自检" → 验证臂产出掉到 1,878 字（比任何
    //     一臂都薄，n=1 无法归因，但**没有任何证据支持加它**）。
    // 只加 11 时人物卡本来就只出主角（3 个），读者要的效果已经有了 —— 不必为此再写规则。
    '11. **分两步做这件事，但只输出一份结果**：① 先只整理「人物」「世界观」「文风」「前文脉络」'
    + '「通用概念」这五节里的**新内容** —— 已有认识里写过的**不要重写**（见第 7 条），但这一步'
    + '要写够、不要为后面留预算；② 再回过头读「人物」这一节 —— **把「我之前整理过的认识」里'
    + '已有的人物条目，连同你刚写的新条目一起读** —— 依据它整理出「人物关系」，同样**只补新的**：'
    + '已有的关系若只是换个说法，就一条都不写。最后按「人物关系 / 人物 / 世界观 / 文风 / '
    + '前文脉络 / 通用概念」的顺序把六节一起给出（只给一份，别写两次）。',
  ]

  // ⚠️ 联网那条是**条件**的，但它也必须落在固定块里 —— 否则它会跑到变动区后面去，
  // 让稳定前缀白白短一截。（同一本书里 allowWeb 不会中途变，所以前缀依然稳定。）
  if (input.allowWeb === true) {
    requirements.push(
      '12. 某个时代背景、器物、典故需要查证才能理解时，可以联网查**设定类**资料；'
      + '但**不要**去查这本书的剧情、结局或后续，那些必须只从样本里得出。',
    )
  }

  const lines = [
    ...requirements,
    '',
    // ---- 稳定前缀到此结束，以下是**随批变化**的部分 ----
    `我在读《${input.bookTitle}》，现在的进度是第 ${input.toChapter} 章。`,
    `下面是我已经读过的第 ${input.fromChapter} 到第 ${input.toChapter} 章的**节选**（每章可能中间省略，标着「（中略）」）。`,
    '',
  ]

  if (typeof input.existingMarkdown === 'string' && input.existingMarkdown.trim() !== '') {
    lines.push(
      '这是我之前整理过的认识（请**只补充新东西**，不要把已有的换一种说法重写一遍）：',
      '',
      input.existingMarkdown.trim(),
      '',
    )
  }

  // ⚠️ 样本永远放**最后**：它是这一段里最不稳定的部分（每批都换），放尾部才不会破坏前缀。
  lines.push('以下是章节样本：', '', body)

  return lines.join('\n')
}

/**
 * 造一个补齐器。
 *
 * @param {object} deps 依赖
 * @param {() => object|undefined} deps.getSubagents 取 subagents 服务
 * @param {(sessionId: string) => object|undefined} deps.getAgent 取会话对应的活 Agent
 * @param {Function} [deps.startRun] 覆盖子代理启动（单测注入用）
 * @param {number} [deps.timeoutMs] 超时
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @returns {(request: object) => Promise<object>} 补齐函数
 */
export function createMemoryFiller(deps) {
  const run = createSubagentRunner(deps)

  return async function fill(request) {
    const samples = Array.isArray(request?.samples) ? request.samples : []
    if (samples.length === 0) return { ok: false, reason: 'NO_SAMPLES', elapsedMs: 0 }

    const allowWeb = request?.webGate === 'off'
    const result = await run({
      sessionId: request?.sessionId,
      label: `dsh-reading-companion:memory:${request.fromChapter}-${request.toChapter}`,
      prompt: buildMemoryPrompt({ ...request, allowWeb }),
      persona: MEMORY_PERSONA,
      allowWeb,
    })
    if (result.ok !== true) return result

    const parsed = parseBackground(result.text)

    // 「解析不出东西」与「模型什么都没说」要分开报：前者重试可能就好，
    // 后者是模型真的没内容可说。
    //
    // ⚠️ 这个判据**必须把分组分区的主体名下条目也算进来**。v1.22 之后「人物关系」
    // 「世界观」的条目大多挂在 `### 主体` 下，只数散条目（`sections`）会把一份
    // **解析得好好的**输出判成「解析不出」——一次好数据被整批丢掉，而理由还是错的。
    // （同样的漏洞在旧代码里对**散条的「人物」**也存在：它数了 `characters` 却没数
    // `sections['人物']`。这里一并按结构数，而不是按"我记得有哪些分区"数。）
    const looseCount = BACKGROUND_SECTIONS
      .reduce((sum, name) => sum + (parsed.sections?.[name]?.length ?? 0), 0)
    const entityCount = BACKGROUND_GROUPED_SECTIONS
      .reduce((sum, name) => sum + Object.keys(parsed.groups?.[name] ?? {}).length, 0)
    if (looseCount + entityCount === 0) {
      return { ok: false, reason: 'UNPARSABLE_OUTPUT', elapsedMs: result.elapsedMs }
    }

    return { ok: true, parsed, text: result.text, elapsedMs: result.elapsedMs }
  }
}
