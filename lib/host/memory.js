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

  const lines = [
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

  lines.push(
    '以下是章节样本：',
    '',
    body,
    '',
    '请把这段内容整理成我的**背景认识**，严格用下面六个小节，顺序固定，不要别的话：',
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
    '2. **人物关系是重点**：谁和谁是什么关系、有没有变化，写细一点。',
    '3. **文风只描述特征，不评价好坏**（"爱用短句"可以，"文笔很好"不行）。它不含'
    + '剧情，所以哪怕只从最早的几章看出来也可以放心写。',
    '4. 只写样本里能看出来的。看不出人物关系就留空那一节，不要编。',
    '5. 尽量短：人物、世界观、文风一条 40 字内，前文脉络一条 60 字内。',
    '6. 没有新信息的节可以直接省略。',
    '7. **先把上面「我之前整理过的认识」里已经出现的每一位主体过一遍**：这一段里'
    + '只要关于他有新信息，就补到他名下。没有新信息就一条都不写——**已有的说法不要'
    + '换个说法再写一遍**，那只会让文件在长度上长胖、在信息上一动不动。'
    + '**「前文脉络」尤其如此**：已经写过的章号范围不要再写一遍，只用新条目补它还没覆盖到的部分。',
    '8. **专名照抄原文**：人名、地名、门派、器物、招式、称号都按原文的字面写，'
    + '不要用"某人""那个地方"代替，也不要意译、缩写或改称呼。',
    '9. **「通用概念」是兜底**：一条东西能归进上面任何一节，就归进去；只有归不进去'
    + '时才写在这里。如果这本书本来就没有人物、关系与世界观可言（史书、哲学、技术'
    + '书），把它的核心概念都放在这一节，一个概念一个 `### 概念名`。',
  )

  if (input.allowWeb === true) {
    lines.push(
      '10. 如果某个时代背景、器物、典故需要查证才能理解，可以联网查**设定类**资料；'
      + '但**不要**去查这本书的剧情、结局或后续，那些必须只从样本里得出。',
    )
  }

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
