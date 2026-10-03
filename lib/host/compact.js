/**
 * 背景认识的**压缩**（compaction）。
 *
 * ## 为什么需要它
 *
 * `background.md` 的核心约定是"只增不减"——那保证了认识是单调累积的，早期细节
 * 不会被反复重写而磨掉。但它有个必然的代价：**文件只会越来越长**，而注入 prompt
 * 的预算是有限的。
 *
 * 超预算时 `renderBackgroundForPrompt` 会截断。截断能保证不超预算，却会
 * **破坏缓存**：每次截断的保留集合都不同，于是这一段前缀每轮都变。
 *
 * 所以真正的解法是让文件本身保持在预算以内——这就是压缩。压缩之后
 * `renderBackgroundForPrompt` 不再触发截断，第 3 段重新变成一个**稳定的增长
 * 前缀**，缓存持续命中。
 *
 * ## 它是"只增不减"的唯一例外，因此有五条硬约束
 *
 * 1. **保名**：压缩前有的每一位人物，压缩后必须还在。丢了谁就是丢了记忆。
 * 2. **保主体**：压缩前有的每一个分组主体（人物关系的一对、世界观的一个条目），
 *    压缩后必须还在——与「保名」同一原则，只是推广到了 v1.22 新增的分组分区。
 *    读者族的「时间与分线」按单元分组，同样走这一条（判分组一律用 `isGroupedSection`）。
 * 3. **保号**：覆盖区间只能不变或变大，绝不能缩小。
 * 4. **必须真的变小**：否则这次调用白花，还会陷入"压缩→没效果→再压缩"的循环。
 * 5. **保读者族的条目**：读者族永不注入 ⇒ 前两条的计数都够不到它，
 *    必须单独按"条目一条都不能少"守（见 {@link validateCompaction}）。
 *
 * 五条都在 {@link validateCompaction} 里检查；**检查不过就整批丢弃**，宁可
 * 保持原样，也不接受一次可能丢了人物的"压缩"。
 *
 * ⚠️ 「已取代」归档区**不进压缩输入**（`renderBackground(..., { includeRetired:
 * false })`），压缩后也**原样保留**。它是历史日志：送进模型既浪费 token，又给了
 * 它把已被推翻的旧说法"重新总结"回正文的机会——那正好把取代白做了。
 *
 * 落盘前还会把原文件复制成 `background.bak.md`——压缩是唯一会**删掉**用户
 * 可见内容的一步，留个后路是应该的。
 */

import {
  BACKGROUND_READER_SECTIONS,
  BACKGROUND_SECTIONS,
  isGroupedSection,
  parseBackground,
  renderBackground,
  renderBackgroundForPrompt,
  renderSectionBody,
} from './background.js'
import { COMPRESSIBLE_SECTIONS } from './sections.js'
import {
  DEFAULT_TIMEOUT_MS,
  createSubagentRunner,
  extractText,
  subagentsInstalled,
} from './subagent-run.js'

export { DEFAULT_TIMEOUT_MS, extractText }

/**
 * 压缩者的身份。
 *
 * 与 `MEMORY_PERSONA` 的区别很关键：整理者是"往上加"，压缩者是"往下减"。
 * 减东西比加东西危险，所以这里把"不许丢人物、不许丢章号"写进约束本身，
 * 而不只依赖代码侧校验——校验是最后一道，不是唯一一道。
 *
 * @type {string}
 */
export const COMPACT_PERSONA = [
  '你在整理自己的读书笔记：把它压短，但**一个信息点都不丢**。',
  '保留范围：人物、关系、设定、概念 —— **每一个主体都要在**（哪怕它后面再没被提到）。',
  // ⚠️ 读者 2026-09-27 问过"这条有没有必要"：**素材本身严格落在进度之内、看不到后文**，
  //    所以旧措辞"不推测后续"几乎打不到东西。但**它防的不是素材，是模型自己** ——
  //    一本名著在它的训练数据里，它完全可能在"压缩"的名义下把**后面**的情节写进来，
  //    而这份文件每轮都会被投喂回去、还会持久化。所以这条**留着，但换了靶子**。
  '只用素材里的事实：这本书后面会怎样**不在素材里**，写进去等于把剧透永久留在记忆里'
  + '（这份文件每轮都投喂回去）。',
  // ⚠️ 2026-10-02 真机形状：模型可以把整次输出上限**全烧在推理里**，正文一个字没吐
  //    （「人物关系」一节的压缩就死于这个：llm=164s、output=32768、响应 0 字）。
  //    提示词侧能做的就是提醒它"边整理边输出"。
  '边整理边输出，不要长篇推理 —— 你的输出就是结果本身。',
].join('\n')

/**
 * **压缩的分节作业清单**（3.0 ③b —— 逐节小调用，取代"一次整份重写"）。
 *
 * ## 为什么必须分节
 *
 * 整份重写有**硬上限**：模型单次输出 = 32768 tokens ≈ 2.6 tokens/字 ⇒ 文件长到
 * 1.2–1.5 万字（≈85–100 章）就**压不出完整输出**（实测撞顶，还有"响应 0 字"的白跑）。
 * 分节之后，每一次调用的输入/输出都只是**一节**的量级，天花板消失。
 *
 * ## 这份清单上是"要过模型"的节；其余节**永不过模型**（代码原样搬运）
 *
 * `文本类型`（写法指南针）/ `人物状态`（每批整体替换，改它反而制造假状态）/
 * `时间与分线`、`冷档案`（读者族 —— 改了删了没有任何人能替你重建）。
 *
 * ⚠️ 各节的**上限数字**（≤40/≤80/≤50）被 `test/compact.test.mjs` 的断言钉着 —— 改一个数要连带改守卫。
 */
// ⚠️ 2026-10-03：这张清单**不再写在这里** —— 它是分区注册表里每行的 `compressible` 字段
//    派生出来的（见 `sections.js`），这里只把它再导出去（外部 API 不变）。
export { COMPRESSIBLE_SECTIONS }

/** 每节只说自己的尺子（全篇统一说的话模型会猜偏 —— 实测出过 715 字巨段）。 */
const SECTION_COMPACT_RULES = {
  '人物': '主体名下是**一条一件事**（每条都以章号开头）——只把语义重复的条目并掉、把同一时期相邻的几条并成一条，**合并后一条 ≤40 字**；⚠️ **别把整张卡并成一条长条目**（2026-10-02 实测：曾有模型把一位人物并成 715 字的一条），章号一个都别丢。',
  '人物关系': '主体是**关系双方**（`### 甲 ↔ 乙`），名下一条写一对人 —— 同一对人不同阶段的多条可以并成一条（各章号按时间排好、全部保留）；⚠️ 但**合并后一条 ≤80 字**，并起来超长就**保持分阶段的多条**；**别把经历细节补回来**（那些在「人物」里）。',
  '世界观': '**合并后一条 ≤40 字**（超了就拆，别写成一大段）。',
  '通用概念': '**合并后一条 ≤40 字**（超了就拆，别写成一大段）。',
  '文风（只写一次）': '**可以压得最狠** —— 它是稳定的特征清单，不随章节变；说同一件事的多条只留最准的一条，宁可少留几条，也不要并列堆着。',
  // ⚠️ 「前文脉络」已并入「时间与分线」（读者 2026-10-02 拍板）：不再单独作业；
  //    旧文件里它的内容在压缩重组里**原样搬运**（它在 LEGACY 清单里，模型从不接触）。
}

/** 部署/状态类失败：重试无用、有专属提示，**原样透传**（不打分节前缀）。 */
const DEPLOYMENT_FAILURES = new Set(['SUBAGENTS_UNAVAILABLE', 'NO_LIVE_PARENT', 'PARENT_LOOKUP_FAILED'])

/** 所有节共用的压法原则（放进每一次的分节调用 —— 每次调用都是独立上下文，所以每次都要带全）。 */
const SHARED_COMPACT_RULES = [
  '一句话原则：**同一主体名下的多条 = 合并；不同主体之间 = 不许动；合完仍超上限 = 宁可少合。**',
  '合并的手段 = 把语义重复、或时间相邻的多条合成一条，保留最有信息量的措辞；合并后章号写成区间（如 `第3-7章`）。',
  '⚠️ **不许用"合出巨段/超长条"来达标** —— 超上限时该做的是删重复、删过场细节，宁可少合。',
  '直接输出 Markdown 正文，不要任何解释、不要用代码块包起来。',
]

/**
 * 渲染**单独一节**的 markdown（分组节照常带 `### 主体`、扁平节渲染散行）。
 *
 * 只用于切分节作业的素材/复核成品 —— 输出会被 `parseBackground` 原样读回。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {string} name 节名
 * @returns {string}
 */
function renderOneSectionMarkdown(doc, name) {
  // ⚠️ **节内形状由 `background.js` 的 `renderSectionBody` 一处定义**（2026-10-03 体检）。
  //    这里从前自己写了一遍，且与文件写入器 `renderBackground` **漂了**两处：
  //    ① 条目**不带 `- ` 前缀**（`lines.push(entry)`）—— 而 `parseBackground` 只认 `- ` 行，
  //       于是送给压缩模型的**素材形状是错的**，模型"照材料的形状回"时那些行不是条目
  //       ⇒ **整条静默消失**，而五道校验全过（保主体只比主体名、只要求变小）、`ok: true`、
  //       `savedChars` 照报。这是唯一"删掉内容且不搬进任何归档"的路径。
  //    ② 分组排在**散条目之前** —— 而解析时 `###` 之后的行归**那个主体**，于是混合形状
  //       （旧散条目 + 新分组，真实文件从下一批起必然如此）重解析时散条目被**并进最后
  //       一个主体**：内容改归属，且不报错。
  //    本函数的文档注释一直写着"输出会被 `parseBackground` 原样读回"—— 那正是契约，
  //    现在由共享实现保证它成立（见 `test/compact.test.mjs` 的往返守卫）。
  return [`## ${name}`, ...renderSectionBody(doc, name)].join('\n')
}

export { renderOneSectionMarkdown }

/**
 * 构造**一节**的压缩提示词（3.0 ③b：签名从"整份重写"改成"单节作业"——
 * 模型不再拿到整份文件；其余节由别的调用处理、由代码原样搬运）。
 *
 * @param {object} input
 * @param {string} input.bookTitle 书名
 * @param {string} input.section 节名（必须在 {@link COMPRESSIBLE_SECTIONS} 里）
 * @param {string} input.sectionMarkdown 这一节的现状（`## 标题` 开头）
 * @param {number} [input.targetChars] 这一节的目标字数
 * @returns {string}
 */
export function buildCompactPrompt(input) {
  const target = Number.isInteger(input?.targetChars) && input.targetChars > 0 ? input.targetChars : 800
  const rule = SECTION_COMPACT_RULES[input?.section] ?? '只把语义重复的多条并掉，少罗列。'
  return [
    `这是我在读《${input?.bookTitle ?? '书'}》时整理的背景认识里的**一节**。整份文件太长了；现在**只压缩这一节**——其余各节由别的调用处理，你不用管它们。`,
    '',
    '这一节的现状：',
    '',
    input?.sectionMarkdown ?? '',
    '',
    '请输出压缩后的**这一节**，要求：',
    '',
    `1. 总长度压到 **${target} 字以内**。`,
    `2. 输出从 \`## ${input?.section ?? ''}\` 的标题开始，标题**原样**；`,
    `3. 这一节的压缩尺度（别的节的尺子对你无效）：${rule}`,
    '4. ⚠️ **这一节里现有的每一个 `###` 主体都要在**，一个都不能少（少一个 = 丢了一位人物或一段关系）。',
    ...SHARED_COMPACT_RULES.map((line, index) => `${5 + index}. ${line}`),
  ].join('\n')
}

/**
 * 压缩的安全校验。
 *
 * 五条硬约束见文件头。**任何一条不过就整批丢弃**——这是刻意的失败方向：
 * 一次没压缩成功只是浪费一次调用，而一次丢了人物的压缩是不可逆的记忆损失。
 *
 * @param {object} before 压缩前的解析结果
 * @param {object} after 压缩后的解析结果
 * @param {object} [options]
 * @param {number} [options.budgetChars] 预算（用于判断是否真的小了）
 * @returns {{ ok: boolean, reason?: string, savedChars?: number, beforeChars?: number, afterChars?: number }}
 */
export function validateCompaction(before, after, options = {}) {
  const beforeFull = renderBackgroundForPrompt(before, { budgetChars: Number.MAX_SAFE_INTEGER })
  const afterFull = renderBackgroundForPrompt(after, { budgetChars: Number.MAX_SAFE_INTEGER })
  const beforeChars = beforeFull.used
  const afterChars = afterFull.used

  // ---- 保号：覆盖区间不能缩 ----
  if (after?.covered === null || after?.covered === undefined) {
    return { ok: false, reason: 'COMPACT_LOST_COVERAGE' }
  }
  const beforeCovered = before?.covered ?? null
  if (beforeCovered !== null && after.covered.last < beforeCovered.last) {
    return { ok: false, reason: 'COMPACT_SHRANK_COVERAGE' }
  }

  // ---- 保名：压缩前有的人，压缩后必须还在 ----
  const beforeNames = Object.keys(before?.characters ?? {})
  const afterNames = new Set(Object.keys(after?.characters ?? {}))
  const lost = beforeNames.filter((name) => !afterNames.has(name))
  if (lost.length > 0) {
    return { ok: false, reason: `COMPACT_LOST_CHARACTERS: ${lost.slice(0, 5).join('、')}` }
  }

  // ---- 保主体：分组分区的主体一个都不能少 ----
  //
  // 与「保名」同一原则。人物关系的主体是**一对人**（`### 甲 ↔ 乙`）、世界观的主体
  // 是一个地名/势力/设定——丢一个和丢一位人物一样，是丢了记忆。
  for (const name of BACKGROUND_SECTIONS) {
    if (!isGroupedSection(name)) continue
    const beforeEntities = Object.keys(before?.groups?.[name] ?? {})
    const afterEntities = new Set(Object.keys(after?.groups?.[name] ?? {}))
    const lostEntities = beforeEntities.filter((entity) => !afterEntities.has(entity))
    if (lostEntities.length > 0) {
      return { ok: false, reason: `COMPACT_LOST_ENTITIES: ${name} · ${lostEntities.slice(0, 5).join('、')}` }
    }
  }

  // ---- 保读者族条目：这一族**上面两条口径都够不到它**，所以必须单独守 ----
  //
  // ⚠️ 两条都漏它：`beforeChars/afterChars` 量的是**注入**六节
  //    （`renderBackgroundForPrompt` 只遍历 `BACKGROUND_INJECTED_SECTIONS`），
  //    而「保主体」在这一版之前只跑注入族。后果：压缩模型把整个「时间与分线」
  //    （含每个单元的 `⭐ 影响`）删光，只要注入六节小了一点，这次压缩仍然判
  //    `ok:true` 并落盘 —— 而这一族**只有读者能重建**（它永不注入，AI 也纠不了）。
  //    判据取"条目一条都不能少"：这一族是读者自己维护的那一半记忆，
  //    压缩对它只该做"原样搬过去"，任何净减少都当失败。
  for (const name of BACKGROUND_READER_SECTIONS) {
    const countOf = (doc) => (Array.isArray(doc?.sections?.[name]) ? doc.sections[name].length : 0)
      + Object.values(doc?.groups?.[name] ?? {})
        .reduce((sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0), 0)
    const beforeCount = countOf(before)
    const afterCount = countOf(after)
    if (afterCount < beforeCount) {
      return {
        ok: false,
        reason: `COMPACT_LOST_READER_ENTRIES: ${name} · ${beforeCount} → ${afterCount}`,
      }
    }
  }

  // ---- 必须真的变小 ----
  if (afterChars >= beforeChars) {
    return { ok: false, reason: 'COMPACT_NO_SHRINK', beforeChars, afterChars }
  }

  return { ok: true, savedChars: beforeChars - afterChars, beforeChars, afterChars }
}

/**
 * 造一个压缩器。
 *
 * 3.0 ③b 起 = **分节编排**：可压缩的节（`COMPRESSIBLE_SECTIONS`）各自独立调用
 * （输入/输出都只是那一节），**永不过模型的节**（文本类型 / 人物状态 / 时间与分线 /
 * 冷档案）在代码里原样搬运。每一节都要过三关（跑成功 / 主体不减 / 不许变大），
 * **任何一节失败 = 整次压缩失败**——压一半留着，比不压更容易出错（校验不过就整批
 * 丢弃是这里的既定失败方向）。
 *
 * @param {object} deps 依赖（同 {@link createSubagentRunner}）
 * @returns {(request: object) => Promise<object>} 压缩函数
 */
export function createCompactor(deps) {
  const run = createSubagentRunner(deps)

  return async function compact(request) {
    const markdown = typeof request?.markdown === 'string' ? request.markdown : ''
    if (markdown.trim() === '') return { ok: false, reason: 'NO_BACKGROUND', elapsedMs: 0 }

    const before = request?.doc ?? parseBackground(markdown)
    // ⚠️ **部署检查先于"有没有可压内容"**：空背景 + 没装子代理时，读者该听到
    //    "没装子代理"（501，换个部署才有解），而不是"没压出效果"（502，听起来像白跑）。
    //    （共享探针，判定与 runner 里一模一样 —— 只有一处定义。）
    if (typeof deps?.startRun !== 'function' && subagentsInstalled(deps) === false) {
      return { ok: false, reason: 'SUBAGENTS_UNAVAILABLE', elapsedMs: 0 }
    }
    const live = renderBackground(before, request?.bookTitle, { includeRetired: false })
    const totalTarget = Number.isInteger(request?.targetChars) && request.targetChars > 0 ? request.targetChars : 3000

    // ---- 分节作业（**并发**：各节互相独立，wall-clock ≈ 最慢的一节；读者 2026-10-02 拍板）----
    const jobs = []
    for (const name of COMPRESSIBLE_SECTIONS) {
      const sectionMarkdown = renderOneSectionMarkdown(before, name)
      // 空节不用调用。⚠️ 别用 `replace(/## .+\n/)` 判空：单行的空节没有尾部换行，
      // 那个正则切不掉标题，空节会被当成有内容 ⇒ 白烧六个调用（测试抓的：6 !== 3）。
      const sectionBody = sectionMarkdown.split('\n').slice(1).join('\n')
      if (sectionBody.trim() === '') continue
      // 这一节分到的目标额度 ∝ 它占总量的份额；压不动的小节给个下限（120 字）。
      const target = Math.max(120, Math.round(totalTarget * sectionMarkdown.length / Math.max(1, live.length)))
      jobs.push({ name, sectionMarkdown, target })
    }

    const specOf = (job) => ({
      sessionId: request?.sessionId,
      // ⚠️ 绑定会话优先、当前会话兜底（3.0，同补齐）。
      fallbackSessionId: request?.fallbackSessionId,
      label: `dsh-reading-companion:compact:${job.name}`,
      prompt: buildCompactPrompt({
        bookTitle: request?.bookTitle,
        section: job.name,
        sectionMarkdown: job.sectionMarkdown,
        targetChars: job.target,
      }),
      persona: COMPACT_PERSONA,
      // 压缩**不需要**联网：材料全在手上，联网只会引进外部信息。
      allowWeb: false,
    })

    // 每节：调用一次；失败（非部署类）⇒ **重试一次**（同节同尺子；"推理烧顶"这类
    // 没睡醒的失败多半瞬时就好 —— 真机 2026-10-02：人物关系一节 32768 顶格、正文 0 字）。
    // ⚠️ 部署类失败不重试（重试一万次也一样），当场透传。
    const runOne = async (job) => {
      let one = await run(specOf(job))
      let retried = null
      if (one.ok !== true && !DEPLOYMENT_FAILURES.has(one.reason)) {
        retried = { reason: one.reason, wastedMs: one.elapsedMs ?? 0 }
        one = await run(specOf(job))
        if (one.ok === true) retried.ok = true
      }
      return { one, retried }
    }

    // ⚠️ **并发发出所有节的调用**；结果按**文件节序**处理 —— 失败信息里点名的
    //    是"文件顺序里第一个失败的节"（确定性优先）。部署类失败原样透传（501 语义）。
    //    ⚠️ 取舍（读者知情）：一节失败时其余节的白跑无法避免 —— 换来的是 wall-clock
    //    ≈ 最慢的一节而不是各节相加（读者实测四节要 4 倍时间）。
    const settled = await Promise.all(jobs.map(async (job) => {
      try {
        const { one, retried } = await runOne(job)
        return { job, one, retried }
      } catch (error) {
        return { job, one: { ok: false, reason: `FAILED: ${error?.message ?? String(error)}`, elapsedMs: 0 }, retried: null }
      }
    }))

    let elapsedTotal = 0
    const outputs = {}
    const sectionRetrieds = []
    for (const { job, one, retried } of settled) {
      const name = job.name
      // 并发下 wall-clock ≈ 最慢的一节（串行才是相加）。
      // ⚠️ **重试那一趟的耗时也得算进去**（2026-10-02 三方评审 P3-4）：从前只取
      //    `one.elapsedMs`（最终那一次），于是"某节重试过一次"时界面报的耗时**偏小**
      //    —— 而读者恰恰是靠这个数判断"这次为什么慢了一倍"。重试与正试是**同一节
      //    串行**发生的，所以这里是**相加**；节与节之间才是取最大。
      elapsedTotal = Math.max(elapsedTotal, (one.elapsedMs ?? 0) + (retried?.wastedMs ?? 0))
      if (retried !== null) {
        retried.ok = retried.ok === true
        retried.section = name
        sectionRetrieds.push(retried)
      }
      if (one.ok !== true) {
        // ⚠️ **部署类失败原样透传**（SUBAGENTS_UNAVAILABLE 等）：它们有自己的 HTTP 语义
        //    （501"没装子代理"）与专属提示语 —— 打上分节前缀反而让路由认不出来。
        if (DEPLOYMENT_FAILURES.has(one.reason)) return { ...one, elapsedMs: elapsedTotal }
        return { ok: false, reason: `COMPACT_SECTION_FAILED: ${name} · ${one.reason}`, elapsedMs: elapsedTotal }
      }

      // 只收**这一节**的产物：模型被要求输出单节，但保险起见按节名取件。
      const parsed = parseBackground(one.text)
      const outpost = {
        sections: Array.isArray(parsed.sections?.[name]) ? parsed.sections[name] : [],
        groups: parsed.groups?.[name] ?? {},
      }
      // 关零：**回执里必须有这一节** —— 模型没接住任务（回了个别的东西）时，
      //   **不许静默把一节内容搬空**：那会把"压缩失败"伪装成"内容丢了"。空进 ⇒ 空出还不算错。
      if (outpost.sections.length === 0 && Object.keys(outpost.groups).length === 0) {
        return { ok: false, reason: `COMPACT_SECTION_MISSING: ${name}`, elapsedMs: elapsedTotal }
      }
      // 关一：主体一个都不能少（逐节落实"保主体"；文风是扁平节，没有主体）
      const beforeEntities = Object.keys(before.groups?.[name] ?? {})
      if (isGroupedSection(name) && beforeEntities.length > 0) {
        const afterEntities = new Set(Object.keys(outpost.groups))
        const lostEntities = beforeEntities.filter((entity) => !afterEntities.has(entity))
        if (lostEntities.length > 0) {
          return {
            ok: false,
            reason: `COMPACT_SECTION_LOST_ENTITIES: ${name} · ${lostEntities.slice(0, 5).join('、')}`,
            elapsedMs: elapsedTotal,
          }
        }
      }
      // 关二：这一节**不许变大**（变大 = 模型写飞了，那不是压缩）。
      // ⚠️ 容差 8 字：只"补一个句读"这类标点级变化的幅度 —— 语义上的增长照样拦。
      const outMarkdown = renderOneSectionMarkdown(
        { sections: { [name]: outpost.sections }, groups: { [name]: outpost.groups } },
        name,
      )
      if (outMarkdown.length > job.sectionMarkdown.length + 8) {
        return {
          ok: false,
          reason: `COMPACT_SECTION_GREW: ${name} · ${job.sectionMarkdown.length} → ${outMarkdown.length}`,
          elapsedMs: elapsedTotal,
        }
      }
      outputs[name] = outpost
    }

    // ---- 组装：可压缩节用分节结果替换，其余（含读者族）原样搬运 ----
    const after = JSON.parse(JSON.stringify(before))
    after.sections = {}
    after.groups = {}
    for (const name of BACKGROUND_SECTIONS) {
      if (outputs[name] !== undefined) {
        after.sections[name] = outputs[name].sections
        after.groups[name] = outputs[name].groups
      } else {
        after.sections[name] = [...(before.sections?.[name] ?? [])]
        after.groups[name] = JSON.parse(JSON.stringify(before.groups?.[name] ?? {}))
      }
    }
    // ⚠️ **必须把 `characters` 的别名接回去**（2026-10-04 修）。
    //
    //    `parseBackground`（`background.js:215`）与 `mergeBackground`（`:571`）都让
    //    `characters` **指向** `groups['人物']` 这个对象，注释写明"指向同一个对象，
    //    所以两边永远不会不同步"。而上面那句深拷贝把别名切断了，紧接着
    //    `after.groups = {}` 又换了一整套新对象 ⇒ `after.characters` 还指着**压缩前**
    //    那一份 —— 本文件是全仓**唯一**打破这条不变量的地方。
    //
    //    后果不是丢数据（真正的保护是紧接着的「保主体」，它比的是重建后的
    //    `groups['人物']`），而是**假保护**：`validateCompaction` 的「保名」拿
    //    `before.characters` 与 `after.characters` 相比，而两边恒等 ⇒
    //    `COMPACT_LOST_CHARACTERS` 在生产路径上**永远不可能触发**。可它是有消费者
    //    的（`index.js` 为它写了整档 502 文案、`compact.test.mjs` 也测了它）——
    //    那条测试手工造 `after` 直接喂 `validateCompaction`，所以从没红过。
    after.characters = after.groups['人物']

    const verdict = validateCompaction(before, after)
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, elapsedMs: elapsedTotal }
    }

    // 归档区**原样带回**：模型没见过它，所以它没有资格动它。不这样做的话，一次
    // 压缩就会把全部取代记录抹掉，被推翻的旧说法会在下一次合并时复活。
    after.retired = [...(before.retired ?? [])]

    return {
      ok: true,
      parsed: after,
      text: renderBackground(after, request?.bookTitle),
      elapsedMs: elapsedTotal,
      savedChars: verdict.savedChars,
      beforeChars: verdict.beforeChars,
      afterChars: verdict.afterChars,
      // ⚠️ 有节"重试过一次才成"时必须如实带 shangliang（跨四层惯例：算出来 → 结果 → 路由 → 客户端）。
      ...(sectionRetrieds.length > 0 ? { retriedSections: sectionRetrieds } : {}),
    }
  }
}
