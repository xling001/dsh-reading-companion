/**
 * 前文记忆补齐的**编排**：一趟补齐从头到尾只有这一个入口。
 *
 * ⚠️ 为什么单独成文件（2026-10-03 甲-4a）：它是 `index.js` 里最大的一块域
 *（598 行），而 `index.js` 的职责是"cordis 装配 + 路由分发表"。
 * **纯搬迁，行为一字未改** —— 判据是全量测试 + 依赖闭包实测
 *（`fillMemoryGap` 对模块作用域的全部依赖只有下面这些 import 加三个同迁的辅助函数，
 * 而它们在 `index.js` 正文之外**只出现在自己的声明行**，没有第二处调用者）。
 *
 * 这一趟的形状（细节在各段注释里）：
 *   **第 -1 趟** 跳读闸判定（在写盘之前）→ 缺口调整 → 归档 → 压缩 → 抽样 →
 *   一次子代理调用 → 与压缩**共用同一次写入** → 返回一份"这一趟干了什么"。
 *
 * ⚠️ 返回对象的**每个成功出口都给出同一套键**（见 `contract.test.mjs` 的键集契约）：
 * 路由是整包转发，不再替它兜默认值，少一个键客户端拿到的就是 `undefined`。
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAutoBackup } from './export.js'
import { BACKGROUND_SECTIONS, applyArchive, backgroundGap, entityCardsFor, needsCompaction, parseBackground, renderExistingForFill, subjectsInSamples } from './background.js'
import { HISTORY_DIR, buildArchiveDelta, historyFileName, nextHistorySeq } from './background-history.js'
import { HOST_DEFAULTS } from './defaults.js'
/**
 * 把摘要失败的原因翻译成 HTTP 语义与给人看的话。
 *
 * 这里刻意区分「环境不具备」（501/409，用户改配置或换个会话就能解决）与
 * 「这次生成失败了」（502/504，重试有意义）——把它们混成一个 500 会让用户
 * 完全不知道下一步该做什么。
 *
 * @param {string} reason 摘要器给的失败原因
 * @returns {{ status: number, message: string }}
 */
function describeMemoryFailure(reason) {
  const text = String(reason ?? '')
  if (text === 'SUBAGENTS_UNAVAILABLE') {
    return { status: 501, message: '当前部署没有可用的子代理服务，无法补齐背景认识。陪读本身不受影响，只是 AI 对前文的理解有限。' }
  }
  if (text === 'NO_LIVE_PARENT') {
    return { status: 409, message: '这个会话当前没有活的 Agent（还没发过消息，或已被回收）。先在会话里说一句话，再回来补齐。' }
  }
  if (text === 'TIMEOUT') {
    return { status: 504, message: '补齐超时。可以调大插件配置里的 memoryTimeoutMs，或先缩小缺口再试。' }
  }
  if (text === 'NO_SAMPLES') {
    return { status: 400, message: '缺口区间里没有可抽样的正文（都是空章或只有标题）。' }
  }
  if (text === 'EMPTY_OUTPUT' || text === 'UNPARSABLE_OUTPUT') {
    return { status: 502, message: '模型这次的输出没能解析成背景认识。重试一次通常就好。' }
  }
  return { status: 502, message: `补齐背景认识失败：${text}` }
}

/**
 * 「**大缺口 + 读者没表态 + 是手动点补齐**」时的 409 响应（跳读闸）。
 *
 * ## 为什么抽成函数（2026-10-02 三方评审 P2）
 *
 * 这条响应现在有**两个**触发点：函数开头的"第 -1 趟"前置判定（**在任何写盘之前**）
 * 与后面那道防御性的第二道闸。两份内联的字符串迟早会漂 —— 而这一屏是读者据以
 * 做决定的唯一依据（"全部纳入还是只记最近"），漂了就会让他按一段过时的说明做选择。
 *
 * ## 预估怎么算（只服务弹窗，不编造耗时）
 *
 * ⚠️ 刻意只算"批数 × 每章下限"这两个**由配置直接决定**的数。"每批几十秒"是经验值，
 * 写进代码只会随模型换代而过时。⚠️ 重点章（开头 5 章 + 卷首章）会多拿字数，所以
 * 实际一批可能**少于**这里的估值 ⇒ 这一屏的措辞必须带"约"。
 *
 * ⚠️ `recent` 那一项按**窗口**算，而不是按整个缺口 —— 否则"只记最近一段"会被显示成
 * 和"全部纳入"一样久，那就等于没给读者选择。
 *
 * @param {object} input
 * @param {{ from: number, to: number }} input.gap 1 起的缺口区间
 * @param {number} input.gate 闸门阈值（章）
 * @param {number} input.recentWindow 「只记最近这一段」的窗口大小
 * @param {number} input.allMin 「全部纳入」的每章下限
 * @param {number} input.recentMin 「只记最近」的每章下限（更厚）
 * @param {(chapters: number, min: number, firstIsFoundation: boolean) => number} input.batchesFor 批数估算
 * @param {boolean} input.foundation 这一趟是不是**首次**补齐（还没建立任何背景认识）
 * @returns {object} 路由层直接回给客户端的结果对象
 */
function largeGapResult({ gap, gate, recentWindow, allMin, recentMin, batchesFor, foundation }) {
  const span = gap.to - gap.from + 1
  const windowSize = Math.min(recentWindow, span)
  return {
    ok: false,
    reason: 'LARGE_GAP',
    status: 409,
    message: `这次要补的是第 ${gap.from}–${gap.to} 章，共 ${span} 章，超过跳读闸（${gate} 章）。`
      + '如果这些你确实都读过了，选「全部纳入」；如果只是从这里接着读，选「只记最近这一段」——'
      + '后者不会把远处的条目写进 background.md，回到前面读时也不会被剧透。',
    gap: { from: gap.from, to: gap.to, chapters: span },
    gate,
    recentWindow,
    estimate: {
      all: { batches: batchesFor(span, allMin, foundation === true), perChapter: allMin },
      recent: { window: windowSize, batches: batchesFor(windowSize, recentMin, false), perChapter: recentMin },
    },
  }
}

/**
 * 这一批让文件**长了多少、长在哪** —— 立卡门槛的**可观测面**（2026-10-06，A 版）。
 *
 * ⚠️ 这是**报告**，不是裁剪（与 `memory.js` 的 `memoryBudgetOverrun` 同一个口径）：
 *    条目照常落盘，报出来只是让"门槛有没有生效"看得见。
 *
 * 报两个数（按**分组节的主体**统计，人物与设定都算）：
 *   · `newSubjects`：这一批**新开了几个 `### 主体`**；
 *   · `newThin`：其中**只有一条**的有几个 —— 这类是"名词解释"。实测《一世之尊》重建后
 *     「世界观」57 个主体里 **52 个只有一条**，吃 2,890 字（应得 1,688 = **1.7×**）
 *     ⇒ 代价是人物卡被粗化 20/35（AI 只看到一半人的细节）。
 *
 * @param {object} before 这一批之前的解析结果
 * @param {object} after 落盘之后的解析结果
 * @returns {{ newSubjects: number, newThin: number }}
 */
function memoryGrowthReport(before, after) {
  const count = (doc) => {
    let subjects = 0
    let thin = 0
    for (const name of BACKGROUND_SECTIONS) {
      for (const list of Object.values(doc?.groups?.[name] ?? {})) {
        subjects += 1
        if (Array.isArray(list) && list.length === 1) thin += 1
      }
    }
    return { subjects, thin }
  }
  const a = count(before)
  const b = count(after)
  return { newSubjects: b.subjects - a.subjects, newThin: b.thin - a.thin }
}

/**
 * 补齐背景认识：一次调用，处理「缺失的全部前文」这一整段。
 *
 * 单独抽出来是因为「发笔记时自动补」与「手动点按钮」两条路由共用它，而且它是
 * 唯一需要同时碰书库、记忆器与会话的地方。
 *
 * ## 一次调用能补多少
 *
 * 取决于 `sample.budgetChars` 与缺口大小。缺口太大时**只覆盖前一段**
 * （抽样器会从前往后取），水位线推到覆盖到的地方，剩下的下次再补。
 * 用户能在「陪读」页看到 `记忆到第 M 章 / 阅读到第 N 章` 的差距在缩小。
 *
 * ## 为什么压缩也塞在这里
 *
 * 因为它们共用同一个前提：**读者已经同意为这次操作等一次模型调用**。既然
 * 已经要等，把"该压缩了"顺手做掉比让用户再点一次按钮更合理。
 *
 * 顺序是**先压缩、再补缺口**：压缩会让文件变小，于是本次合并后的结果更可能
 * 留在预算内，下一次就不用再压缩。反过来做的话，刚合并完就又胖了。
 *
 * 压缩是**尽力而为**的：它失败（模型没变小、丢了人物……）不影响补齐。宁可
 * 背景认识长一点被截断，也不能因为压缩不顺就让记忆停住。
 *
 * @param {object} deps 依赖
 * @returns {Promise<object>}
 */
export async function fillMemoryGap(deps) {
  const { library, memory, compactor, config, bookId, sessionId, getWebGate, mode, recentWindow: askedWindow, atChapter, ask, logger } = deps

  const book = library.get(bookId)
  if (book === undefined) return { ok: false, reason: 'BOOK_NOT_FOUND', status: 404, message: '没有这本书。' }

  // 用哪个会话来挂子代理：⚠️ **绑定的读书会话优先**（3.0，读者实测："子代理跟着当前会话跑，
  // 而不是固定到绑定会话里跑"——从哪个会话点补齐，记忆的子代理会话就散落在谁的下面）。
  // 客户端给的当前会话作为**兜底**传给 runner：绑定的会话不在线时落回去，不会变得"不能补"。
  const bound = library.bindingForBook(bookId)
  const subagentSession = typeof bound?.sessionId === 'string' && bound.sessionId !== ''
    ? bound.sessionId
    : sessionId
  const effective = typeof sessionId === 'string' && sessionId !== '' ? sessionId : bound?.sessionId
  if (typeof effective !== 'string' || effective === '') {
    return { ok: false, reason: 'NO_SESSION', status: 400, message: '这本书还没有绑定会话，无法补齐背景认识。先在「陪读」页绑定。' }
  }

  const budgetChars = config.window.backgroundBudgetChars
  const threshold = config.window.compactThreshold

  // ---- 读者坐标：**先把进度落定，再用它算一切** ----
  //
  // ⚠️ **`atChapter` = 把"边界"移到读者正在看的那一章。**
  //
  // 背景：进度此前**只在滚动时**回写（`ReaderView` 的 `flush`），于是"用目录跳到
  // 第 430 章、读首屏、没滚动"这条很常见的路径**一次都不会写盘** —— 服务端仍以为
  // 读者在第 3 章。后果不是"进度显示不准"，而是缺口算错：缺口 = 前文里还没纳入的
  // 区间，上界是**当前章的前一章**，于是它被算成 `1..2`（甚至 null），跳读闸不弹、
  // 记忆补到了错误的地方（读者实测：读第 430 章发笔记，界面一声不响）。
  //
  // 处置（读者选定）：**只在他主动的那两个动作里把边界推过去** —— 发笔记、点补齐。
  // 普通翻页与纯浏览一律不动（"偷看一眼最后一章"不该把防剧透边界也推过去）。
  // 所以这里要**落盘**：投喂（`collectReadWindow`）读的就是这个进度，而
  // **投喂与补齐必须用同一个数** —— 否则 AI 会拿到"覆盖到 429 章的记忆"、
  // 同时每轮仍被告知"你在读第 3 章"，那比现状更糟。
  //
  // ⚠️ **它必须在跳读闸与冷归档之前**（2026-10-02 三方评审 P2 时一并提前）：
  //    闸门要用"读者读到第几章"算缺口，归档要用它算活跃窗口起点 —— 两处都得先有它。
  //    从前它写在压缩之后，归档只能**就地重复算一遍**（并且带着一句"不能用下面的
  //    `progressIndex`，它在后面才声明，`const` 有 TDZ"的注释）—— 同一件事两处算，
  //    正是本仓库反复踩过的形状。现在只有一处。
  if (Number.isInteger(atChapter) && atChapter >= 0) {
    // ⚠️ **章号没变就保留章内偏移**（乙-1，2026-10-03）。从前这里一律 `charOffset: 0`
    //    ⇒ "读第 3 章读到一半、顺手发条笔记"会把读者**弹回章首**：他之后不滚动就关掉，
    //    下次打开落在章首而不是他读到的位置。
    //    这两件事本来就无关：这一段要推的是**章号边界**（缺口算错的那个 bug），
    //    而章内位置是读者的阅读落点 —— 章号**真的变了**才归零（新章的位置就是章首，
    //    旧偏移对它没有意义）。
    const before = library.getProgress(bookId)
    const charOffset = before?.chapterIndex === atChapter ? Math.max(0, before.charOffset ?? 0) : 0
    library.setProgress(bookId, { chapterIndex: atChapter, charOffset })
  }
  const progress = library.getProgress(bookId)
  const progressIndex = progress?.chapterIndex ?? 0
  /** 读者**正在读**的那一章（1 起）。归档窗口与闸门都用这一个数。 */
  const readingChapter = progressIndex + 1

  // ---- 跳读闸与"预算→批数"的粗算常量（**纯计算，提前到这里**）----
  //
  // ⚠️ 这些常量本身不写任何东西，纯函数式的取值。提前只是为了**让闸门能在归档之前
  //    做出判定**（见下面"第 -1 趟"）—— 判据与取值口径一个字都没改。
  //
  // 闸门见 `config.sample.jumpGateChapters`。闸门只拦"一次补一大段"的情形；
  // 缺口本来就小、或者读者已经明确表态（`mode`）时直接放行。
  // ⚠️ 缺省必须是**开**（50），不是 0。`sample` 是整体替换的配置对象，早于这个键
  // 写下的 profile 配置里根本没有它——退成 0 等于把安全闸**静默关掉**，而"静默失效"
  // 恰恰是它要防的那类失败。要关就显式写 0。
  const gate = Number.isInteger(config.sample?.jumpGateChapters) ? config.sample.jumpGateChapters : 50
  const asked = mode === 'all' || mode === 'recent' ? mode : null
  const budget = Number.isInteger(config.sample?.budgetChars) ? config.sample.budgetChars : 18000
  const allMin = Number.isInteger(config.sample?.minPerChapter) ? config.sample.minPerChapter : 600
  const recentMin = Number.isInteger(config.sample?.recentMinPerChapter) ? config.sample.recentMinPerChapter : 1200
  const foundationChapters = Number.isInteger(config.sample?.foundationChapters)
    ? config.sample.foundationChapters
    : 30
  // ⚠️ 打底批专用预算（3.0）——见 `HOST_DEFAULTS.foundationBudgetChars` 的说明。
  //    ⚠️ 2026-10-07（工单 B3）：这个兜底从前写的是字面量 `24000` ✗ —— 它与
  //    `lib/index.js` 的配置缺省是**同一个概念**（这行注释从前就指着 `CONFIG_DEFAULTS` 那条 ✓），
  //    却各写一份 ⇒ 改了一边忘另一边就是静默漂移 ✗。现在两边同源于 `lib/host/defaults.js`。
  const foundationBudget = Number.isInteger(config.sample?.foundationBudgetChars)
    ? config.sample.foundationBudgetChars
    : HOST_DEFAULTS.foundationBudgetChars
  const batchOf = (min) => Math.max(1, Math.floor(budget / Math.max(1, min)))
  /**
   * 估一批数。`firstIsFoundation` 要如实算进去 —— 首次那批只吃
   * `foundationChapters` 章，漏掉它就会把"2 批"报成"1 批"。
   */
  const batchesFor = (chapters, min, firstIsFoundation) => {
    const per = batchOf(min)
    if (firstIsFoundation !== true) return Math.max(1, Math.ceil(chapters / per))
    const first = Math.min(chapters, foundationChapters)
    return chapters <= first ? 1 : 1 + Math.ceil((chapters - first) / per)
  }
  // ⚠️ 窗口**独立于闸门阈值**（v2.0.2 拆开）。优先取请求体（读者在弹窗里逐次改），
  // 再回落配置，最后兜底 200。上限 5000 是防手改请求体传一个荒唐的数。
  const configuredWindow = Number.isInteger(config.sample?.recentWindowChapters)
    ? config.sample.recentWindowChapters
    : 200
  const recentWindow = Number.isInteger(askedWindow)
    ? Math.min(Math.max(askedWindow, 10), 5000)
    : configuredWindow

  // ---- 第一趟：够胖就先压缩 ----
  //
  // ⚠️ **这一趟刻意「算而不写」。** 压缩是整条流程里**唯一会删掉内容**的一步，
  // 而第二趟（合并）是**会失败**的一步。旧形状"先压缩落盘、再合并"有两个洞，
  // 都是 `dsh-adaptive-context` 实测踩过的形状（连续 24 批失败 → 水位永不推进）：
  //
  //   1. **压缩侧的失败必须只降级、不可致命。** 传输层的崩溃（子代理 `start`
  //      抛异常）已经被 `createSubagentRunner` 转成 `{ok:false}`，但压缩器**自己**
  //      抛（`compact.js` 里 run 之后的解析 / 校验 / 渲染）会从 `await` 处直接冒
  //      出去。⚠️ 如实说明：按现在的接线，后者**没有已知的可达路径**，所以这个
  //      `try/catch` 是**守卫**，不是已复现 bug 的修复——它钉的是一条不变式：
  //      "压缩怎么坏，都不能让水位线停住"。
  //   2. **压缩成功、合并失败**时，删过的文件已经写下去了：内容少了，缺口还在，
  //      没有任何进展换来这次损失。**这一条是已复现的真问题**（旧形状里
  //      `backgroundCompact` 的落盘就压在合并之前），由下面的"算而不写"修掉。
  //
  // 所以现在：抛异常降级成"这一次不压"，补齐照走；压缩结果先拿在手上，等合并
  // 真的成功了，再和它**一次写下去**（`backgroundMerge` 的 `base` / `backup`）。
  let compact = null
  let compacted = null
  let archived = null
  let before = library.background(bookId)

  // ---- 「读者在这期间清空过吗」的基准（2026-10-02 三方评审 P2-9）----
  //
  // ⚠️ 这一趟会**先读 `before`、再叫模型跑几十秒到十分钟、最后才落盘**。读者完全
  //    可以在那期间点「清空重建」。而落盘前的 CAS（`expectedMarkdown`）**挡不住它**：
  //    那条路撞上 `BACKGROUND_CHANGED` 时会**故意不复核、直接用当前文件重做一次合并**
  //    （那是为"读者在 Obsidian 里改了一句"设计的恢复路径）⇒ 飞在路上的那一批会把结果
  //    合并进**刚被清空的**文件。读者看到的是"已清空"，几十秒后旧内容又回来了，
  //    而且**没有任何一处会说**。
  //
  // 所以清空时会把计数 +1（`library.backgroundReset`），这里存下基准、落盘前比对：
  // 变了就**整批丢弃、一个字都不写**，并如实回报 `resetDuringFill`。
  const resetEpochAtStart = library.resetEpochOf(bookId)
  /** 读者在这一次补齐跑的过程中点过「清空重建」吗。 */
  const resetByReader = () => library.resetEpochOf(bookId) !== resetEpochAtStart

  // ---- 第 -1 趟：跳读闸的**前置判定**（2026-10-02 三方评审 P2）----
  //
  // ⚠️⚠️ **它必须排在"任何写盘"之前。** 旧形状是"先归档、再压缩、最后才问闸门"，
  //    于是"点「补齐前文记忆」→ 缺口很大 → 返回 409 让读者选"这一趟会**先**把旧条目
  //    搬进「冷档案」并落盘（连增量记录与自动备份一起写）。读者看到的是**一次征询**
  //    （"还没做，你来选"），实际发生的是**记忆已经被改了**：那些条目从此不再进上下文。
  //    而 409 的响应体里**没有** `archived` 这个字段 ⇒ 连"发生过什么"都不会被说出来。
  //    这与本插件反复写下的原则直接冲突（"静默改变不可见 = 不可接受"）。
  //
  // ⚠️ **判据与下游那一次完全等价**，不是"另写一套"：
  //    · `covered` 不被冷归档改动（它只搬条目）；
  //    · `covered` 也不被压缩改动（`validateCompaction` 有"保号"那一关，且压缩器
  //      只重建 sections / groups）。
  //    ⇒ 这里用 `before.covered` 算出的 gap / span，与归档+压缩之后算出来的**逐字相同**。
  //    响应体由 {@link largeGapResult} **同一处**产出，所以措辞与预估也不会漂。
  {
    const preGap = backgroundGap(before.covered, progressIndex)
    if (gate > 0 && preGap !== null
      && preGap.to - preGap.from + 1 > gate && asked === null && ask === true) {
      return largeGapResult({
        gap: preGap,
        gate,
        recentWindow,
        allMin,
        recentMin,
        batchesFor,
        foundation: before.covered === null,
      })
    }
  }

  // ---- 第 0 趟：**冷归档**（纯代码；3.0）----
  //
  // ⚠️ **顺序是"先归档、后压缩"**，这不是风格问题：
  //   · 冷归档 = 把"整条都在活跃窗口之外"的旧条目搬进「冷档案」—— **零模型调用、原文只搬运**；
  //   · 压缩 = 叫模型把**整份文件重写一遍** —— 有 32768 输出上限（实测：文件到 1.2–1.5 万字
  //     就压不出来，还出现过"响应 0 字"的白跑）。
  //   所以能靠归档降下来，就**根本不叫模型**；只有归档之后仍然超预算，才轮到压缩。
  //
  // ⚠️ 归档失败（CAS 冲突 / 写盘失败）**不影响补齐**：如实记一笔，然后照旧往下走。
  // ⚠️ **归档窗口起点用上面那个 `readingChapter`**（读者正在读的 1 起章号）—— 它和闸门
  //    用的是**同一个数**。从前这里只能就地重算一遍（因为 `progressIndex` 声明在后面，
  //    `const` 有 TDZ），现在那个隐患连同重复计算一起消掉了。
  const archiveWindow = config.window.archiveWindowChapters
  const keepFrom = Number.isInteger(archiveWindow) && archiveWindow > 0
    ? readingChapter - archiveWindow + 1
    : 0
  // ⚠️ **身份锚的退役窗口**（M = 360，2026-10-06 读者拍板）：出窗超过 M 章的主体，
  //    连"他是谁"的锚一起进冷档案 —— 否则「人物」一节的下限 = 立卡数 × ~45 字，
  //    压缩与注入同时被它拖死（见 `planArchive` 的 JSDoc）。`0`/不给 = 关闭。
  const anchorMaxAge = config.window.anchorMaxAgeChapters
  if (keepFrom > 1) {
    try {
      const plan = applyArchive(before, keepFrom, {
        readingChapter,
        anchorMaxAgeChapters: anchorMaxAge,
      })
      if (plan.moved > 0) {
        const written = library.backgroundArchive(bookId, plan.doc, { expectedMarkdown: before.markdown })
        // ⚠️ 增量记录的成败**要如实带上**（2026-10-02 三方评审 P3-5）：从前这一行的返回值
        //    被直接丢掉 —— 于是"历代备份三件套"里的那件（`background.history/` 增量）
        //    写失败时，`archived` 里没有这个事实，读者以为备份齐全。少一件备份是**不可逆**
        //    的损失（那条 delta 记的是"这一笔搬走了什么"原文）。
        const historyWritten = writeArchiveDelta(library, bookId, plan, keepFrom)
        archived = {
          moved: plan.moved,
          sections: plan.sections,
          backupPath: written.backupPath ?? null,
          historyWritten,
          // ⚠️ 自动备份（3.0）：处理后的全文导出到导出文件夹的「自动备份」。
          autoBackup: writeAutoBackup({
            root: deps.autoExportRoot,
            title: book.title,
            bookId,
            markdown: written.markdown,
          }),
        }
        before = library.background(bookId)
      }
    } catch (error) {
      archived = { moved: 0, failed: `ARCHIVE_FAILED: ${error?.message ?? String(error)}` }
      before = library.background(bookId)
    }
  }

  const weight = needsCompaction(before, { budgetChars, threshold })
  if (weight.over === true && typeof compactor === 'function') {
    try {
      const result = await compactor({
        sessionId: subagentSession,
        fallbackSessionId: effective,
        bookTitle: book.title,
        markdown: before.markdown,
        doc: before,
        // 目标留出余量：压到刚好等于预算，下一次合并立刻又超。
        targetChars: Math.round(budgetChars * 0.6),
      })
      if (result.ok === true) {
        compact = {
          ok: true,
          savedChars: result.savedChars,
          beforeChars: result.beforeChars,
          afterChars: result.afterChars,
          elapsedMs: result.elapsedMs ?? 0,
          // 落盘与否在下面决定；写到这一步为止它还在内存里。
          persisted: false,
        }
        compacted = result.parsed
      } else {
        // 压缩失败不该伪装成成功，但也不该阻断补齐——如实回报原因即可。
        compact = { ok: false, reason: result.reason, elapsedMs: result.elapsedMs ?? 0 }
      }
    } catch (error) {
      // 这里是 T4 的关键一行：**压缩怎么坏，都不能让它挡住补齐**。
      // 失败方向选"这次不压"而不是"这次不补"——压缩只是省 token，补齐才是进度。
      compact = {
        ok: false,
        reason: `COMPACT_THREW: ${error?.message ?? String(error)}`,
        elapsedMs: 0,
      }
    }
  }

  // ---- 第二趟：补缺口 ----
  //
  // ⚠️ 读者坐标（`atChapter` → 进度）已经在**函数开头**落定了 —— 闸门、归档窗口、
  //    这里都用同一个 `progressIndex`（见那里的说明）。
  //
  // ⚠️ **这一趟之前要先看读者有没有清空过**（上面的 `resetByReader`）：压缩本身也等了
  //    一次模型调用，那段窗口里同样可能发生清空 —— 那一趟压缩的结果也不该写回去。
  const clearedDuringFill = resetByReader()
  if (clearedDuringFill && compacted !== null) {
    compact = { ...compact, persisted: false }
    compacted = null
  }

  // 合并的底稿：压缩成了就用压缩后的，否则重新读盘（= 旧行为）。
  const doc = compacted ?? library.background(bookId)
  let gap = backgroundGap(doc.covered, progressIndex)
  // 没有缺口就直接回——这是"发笔记时顺手补"的常态，不该白花一次调用。
  if (gap === null) {
    // 这时压缩就是这一趟**唯一的成果**，得单独落盘（仍带备份）。它没换来章号
    // 进展，但它换了 token，而且没有任何失败步骤压在它后面——可以安全生效。
    if (compacted !== null) {
      try {
        const written = library.backgroundCompact(bookId, compacted, { expectedMarkdown: before.markdown })
        compact = {
          ...compact,
          backupPath: written.backupPath,
          persisted: true,
          // ⚠️ 自动压缩也要导一份"处理后的全文"到导出文件夹的「自动备份」（手动压缩不改）。
          autoBackup: writeAutoBackup({
            root: deps.autoExportRoot,
            title: book.title,
            bookId,
            markdown: written.markdown,
          }),
        }
      } catch (error) {
        if (error?.code !== 'BACKGROUND_CHANGED') throw error
        // 窗口里 `background.md` 被改过（补齐落盘 / 读者手工编辑）：这次压缩作废，
        // **如实报**，别让读者以为文件已经小了。这一趟本来就没有缺口，没有别的东西要保。
        compact = { ok: false, reason: 'BACKGROUND_CHANGED', elapsedMs: compact?.elapsedMs ?? 0, persisted: false }
      }
    }
    // 没有缺口这一趟也要报冷归档（它发生在缺口判断**之前**：归档是代码做的，与有没有缺口无关）。
    // ⚠️ 读者在这期间清空过时**连这一趟也不落盘**（`clearedDuringFill` 已经在上游把
    //    `compacted` 丢掉了）—— 清空是读者的显式动作，不能被在飞的补齐悄悄撤销。
    return {
      ok: true,
      skipped: true,
      covered: library.background(bookId).covered,
      compact,
      archived,
      resetDuringFill: clearedDuringFill,
      // ⚠️ 这一条出口从前**少了这五个键**，而路由的 `?? null` / `=== true` 把它兜住了
      //    ⇒ 谁都没发现。2026-10-03 整包转发之后路由不再兜底，于是它当场变红 ——
      //    **这正是那个 bug 类的现场**（跨四层少一层就静默失效，只不过这次是
      //    "少一层兜底"）。这一趟没有子代理调用，所以重试 / 截断 / 抽样都不存在。
      retried: null,
      truncatedSuspected: false,
      // ⚠️ **这一趟没有子代理调用**（没有缺口 / 读者清空过）⇒ 没有"挂在谁下面"可说。
      subagentParent: null,
      sampled: null,
      partial: false,
      autoFoundation: false,
      elapsedMs: 0,
    }
  }

  // ---- 跳读闸（**判定本身已经提前到写盘之前**，见"第 -1 趟"）----
  //
  // 这里只做**缺口调整**：`recent` 那条路把窗口夹进缺口、`autoFoundation` 那条路把
  // 缺口夹到全书开头。⚠️ `gate` / `asked` / 预算常量与 `readingChapter` 都在函数开头
  // 取好了（口径一处定义），这里不再重复声明。
  const span = gap.to - gap.from + 1

  /** 这一趟是不是"自动打底"（大缺口 + 读者没表态）——回报给客户端，好把话说准。 */
  let autoFoundation = false

  if (gate > 0 && span > gate) {
    if (asked === 'recent') {
      // 「只记最近这一段」：读者从中间开始读时的正确答案。不碰前面那几百章，
      // 于是既不会把远处的条目写进文件，也不用烧掉十几次调用。
      //
      // ⚠️ 窗口比缺口还大时**夹到缺口起点**：不然 `from` 会算成 0 或负数，而章号
      // 是 1 起的（实测触发过：缺口 149 章、窗口 200）。
      gap = { from: Math.max(gap.from, gap.to - recentWindow + 1), to: gap.to }
    } else if (asked !== 'all') {
      // ---- 大缺口的两种处理（读者选定）----
      //
      // 从前这里**一律**回 409。读者实测到的后果是：发笔记那一路只拿到一句**无法
      // 操作**的文字 —— 笔记栏根本没有渲染那些选项（选项只存在于面板），于是他
      // "发了笔记，而 AI 对本章一无所知"。
      //
      // 现在按**调用方**分：
      //   · `ask === true`（面板手动点「补齐前文记忆」）→ 仍然回 409 让他选
      //     「全部纳入 / 只记最近」—— 他本来就打算补，问一句才有意义；
      //   · 其余（发笔记顺手补）→ **自动把全书开头的 `foundationChapters` 章跑完**，
      //     绝不空手而归；剩下的缺口留在那里，由他到面板手动补。
      if (ask !== true) {
        autoFoundation = true
        // ⚠️ 夹的是**全书前 N 章**，不是"缺口起点的 N 章" —— 读者明确要的是
        // "至少把 1–30 章跑完"。夹完可能是空缺口（开头早就纳入过），那条路在
        // 下面单独如实回报，不硬造一次调用。
        gap = { from: gap.from, to: Math.min(gap.to, foundationChapters) }
      } else {
        // ⚠️ **第二道闸**：正常路径上已经在"第 -1 趟"（**任何写盘之前**）拦过一次了，
        //    能走到这里说明前置判定被绕开了（例如以后有人把归档挪到它前面）。
        //    留着它是因为"被拒的请求不许改状态"这条不变式比省一次判断重要 ——
        //    代价是那一刻文件可能已经动过，但至少**不会连回应都不给**。
        //    响应体与前置判定共用 {@link largeGapResult}，所以两处不会漂。
        return largeGapResult({
          gap,
          gate,
          recentWindow,
          allMin,
          recentMin,
          batchesFor,
          foundation: doc.covered === null,
        })
      }
    }
  }

  // 自动打底夹完可能是**空缺口**（开头那几十章早就纳入过了）：那种情况没有可补的东西，
  // 如实回一句"只剩手动补"，而不是报一个 `NO_SAMPLES` 的 400 让读者以为出错了。
  // ⚠️ 此时**不落盘压缩**：这一趟没换来任何进展 —— 与"补齐失败就不写压缩"同一条规矩。
  if (autoFoundation && gap.from > gap.to) {
    return {
      ok: true,
      skipped: true,
      // ⚠️ **三个成功出口的键集必须一致**（2026-10-03 整包转发）：路由不再替结果补
      //    默认值，少一个键客户端拿到的就是 `undefined`（`compact.test.mjs` 的 T4
      //    就是这么红的 —— 它断言 `skipped === false`，而当时那条路干脆没有这个键）。
      //    缺什么就显式写什么，别指望下游兜。
      resetDuringFill: false,
      compact: null, // 这一趟没落盘压缩（见上面那条规矩）
      archived: null,
      retried: null,
      truncatedSuspected: false,
      // 同上：自动打底却"没事可干"的那条路也没调子代理。
      subagentParent: null,
      sampled: null,
      partial: false,
      autoFoundation: true,
      covered: doc.covered,
      elapsedMs: 0,
    }
  }

  // `foundation` = 这是**首次**补齐（还没有任何背景认识）。首次走"打底"模式：
  // 限制章数、把开头读厚，剩下的留到第二次。之后开头已经读厚过了，不必再照顾。
  //
  // ⚠️ 用 `covered === null` 而不是"水位线是 0"：补齐失败时 `covered` 不变，
  // 于是下一次仍然是打底模式——这是对的，第一次没成功就该重来。
  //
  // ⚠️ `mode === 'recent'` 时**强制关掉打底**：读者已经明确说了"只要最近这
  // 一段"，再把批次缩到 30 章从窗口**起点**往后读，等于把他要的那段砍掉一半。
  // ⚠️ `let` 不是手滑：③a 的自适应重试在"第一次失败"时要**重新采样一个砍半的批次**
  //    （预算/权重重算）—— 那是对 `sample` 的合法再赋值，`const` 会当场炸（实测 500）。
  let sample = library.sampleChapters(bookId, gap.from - 1, gap.to - 1, {
    ...config.sample,
    // ⚠️ 「只记最近这一段」那条路用**更厚**的每章下限（见 `recentMinPerChapter`）。
    // 这一个数同时决定"每章多厚"与"一批多宽"，所以换它 = 换深度（代价是批数）。
    minPerChapter: asked === 'recent' ? recentMin : allMin,
    foundation: doc.covered === null && asked !== 'recent',
    // ⚠️ **打底批用自己的预算**（3.0）：`budgetChars` 降到 18000 是为了管住**后续批次**的输出，
    // 而打底批只有一个、输出有界 ⇒ 保留 24000 ⇒ "开头 30 章"能一次跑满（读者的要求）。
    budgetChars: doc.covered === null && asked !== 'recent'
      ? foundationBudget
      : config.sample.budgetChars,
  })
  if (sample.chapters.length === 0) {
    return { ok: false, reason: 'NO_SAMPLES', status: 400, message: '缺口区间里没有可抽样的正文。' }
  }

  // ⚠️ **回显按批算**（2026-10-06 回显瘦身）：它要按"**这批样本正文里出现过的名字**"
  //    决定给谁全文（{@link subjectsInSamples}）。从前它在循环外只算一次 ⇒ 关注名单
  //    只能是全局的，而瘦身要的正是"这一批要用的人"。代价只是每批重渲染一次字符串。
  const echoFor = (batchSample) => (doc.covered === null
    ? doc.markdown
    : renderExistingForFill(doc, { focusNames: subjectsInSamples(doc, batchSample.chapters) }))
  const hasTextType = (Array.isArray(doc.sections?.['文本类型']) ? doc.sections['文本类型'].length : 0) > 0
  const hasStyle = (Array.isArray(doc.sections?.['文风（只写一次）']) ? doc.sections['文风（只写一次）'].length : 0) > 0
  // ⚠️ 「人物状态」这一批**该写谁**由这里算，**不让子代理自己从 markdown 里认**（2026-10-03 读者拍板）。
  //    实测塌掉的样子：《一世之尊》整节写成平铺条目、一个 `###` 都没有 ⇒ 人物卡全空；
  //    而"谁有卡"这件事代码本来就知道。
  //    来源 = `entityCardsFor`（"谁有卡"的权威判定：**只看「人物」一节的主体**，
  //    已按读者进度过滤、已按最新章号降序），再按 `HOST_DEFAULTS.backgroundStateMaxSubjects`
  //    截到最近的几个 —— 与注入侧**同一个上限**（两边同源于那一个常量）。
  //    ⚠️ 首批（还没有任何卡）时是空数组 ⇒ 提示词退回规则 18 的兜底判据，不多说一句。
  const stateSubjects = entityCardsFor(doc, progressIndex)
    .slice(0, HOST_DEFAULTS.backgroundStateMaxSubjects)
    .map((card) => card.name)
  /** 一批 = 一次补齐子代理调用（抽出函数是为了下面的自适应重试）。 */
  const runOneBatch = (batchSample) => memory({
    sessionId: subagentSession,
    fallbackSessionId: effective,
    bookTitle: book.title,
    samples: batchSample.chapters,
    existingMarkdown: echoFor(batchSample),
    hasTextTypeSection: hasTextType,
    hasStyleSection: hasStyle,
    stateSubjects,
    fromChapter: batchSample.from + 1,
    toChapter: batchSample.to + 1,
    // ⚠️ 走依赖注入而不是直接读 `config.webGate`：档位现在是**运行期**的
    // （界面上能改），这个函数在 `apply` 之外，拿不到那个闭包。
    webGate: getWebGate(),
  })

  // ---- 自适应重试（3.0 ③a，读者 2026-10-02 定："因为进度差一次补齐太多，或者输出的
  //      文字太多，应该有别的处理方式"）----
  //
  // ⚠️ 实测的死法有两种：**32768 输出上限**（一批的字多 ⇒ 模型要写的多 ⇒ 撞顶，且"响应 0 字"=
  //    整批白跑）与 **stall**（首 token 之后一个字不吐，直到超时 abort —— 19 章的批卡满 5 分钟）。
  //    两者都是"这一次要写的东西太大"的形状 ⇒ **自动砍半章数重试一次**：更小的批给出更小的回复。
  //
  // 值得砍半重试的失败：TIMEOUT / EMPTY_OUTPUT / UNPARSABLE_OUTPUT（memory.js 判过："重试可能就好"）/
  // 截断嫌疑（`truncatedSuspected` —— 半截产物里可能挂着一条没写完的条目，合并它不如重写它）。
  // ⚠️ **只重试一次**：两次都卡就不是运气问题了，硬试是烧钱。
  // ⚠️ 不值得重试的绝不重试：SUBAGENTS_UNAVAILABLE / NO_LIVE_PARENT 是**部署事实**，
  //    重试一万次也一样（还会把"没装子代理"的提示拖慢一倍）。
  let result = await runOneBatch(sample)
  let retried = null
  // ⚠️⚠️ **砍半前的样本要留一份**（2026-10-05 真机 BUG，两条都由它引起）：
  //    重试那一段会 `sample = halfSample` **就地**把范围改成半截，而后面
  //    `partial` 与 `sampled.first/last` 都拿 `sample` 算 ✗ ⇒
  //      ① **补 107 章时第一批砍半成 1-15**，`partial` 由"半截补完了"算出 `false`
  //         ⇒ **客户端把整个循环停掉** ✗（缺口还剩 16..107 ✗）；
  //      ② 万一第一次（未砍半的）结果胜出，上报的区间还是**半截**的 ✗（界面说谎）。
  //    ⇒ 留一份 `askedSample`（这一批**真正要补**的范围），选完结果再决定用哪一份上报。
  const askedSample = sample
  let halfChosen = false
  const retryWanted = (result.ok !== true && RETRYABLE.has(result.reason))
    || (result.ok === true && result.truncatedSuspected === true)
  if (retryWanted) {
    const first = result
    retried = { reason: first.ok !== true ? first.reason : 'TRUNCATED_SUSPECTED', wastedMs: first.elapsedMs ?? 0 }
    const span = Math.max(1, sample.to - sample.from + 1)
    const halfTo = sample.from + Math.max(2, Math.floor(span / 2)) - 1
    if (halfTo < sample.to) {
      // 砍半 = **重新采样**（预算/权重重算），不是把章数组一切两半
      const halfSample = library.sampleChapters(bookId, sample.from, halfTo, {
        ...config.sample,
        minPerChapter: asked === 'recent' ? recentMin : allMin,
        foundation: false,
        budgetChars: config.sample.budgetChars,
      })
      if (halfSample.chapters.length > 0) sample = halfSample
    }
    const second = await runOneBatch(sample)
    // ⚠️ **择优，不是替换** —— 这是真机测试钉出来的语义：
    //   截断批"写进去的部分是有效的"（memory.js 的原判词），用一次失败的尝试把它**换掉**，
    //   等于把本来能落盘的一批变成整批白跑（测试里 fill#1 就这样从成功变成了失败）。
    //   成绩排序：**没截断的成功 > 截断的成功 > 失败**；同级时保守用第一次（截断两次都一样多）。
    const rank = (r) => (r.ok === true ? (r.truncatedSuspected === true ? 1 : 2) : 0)
    if (rank(second) > rank(first)) {
      result = second
      halfChosen = true
      retried.ok = true
    } else {
      result = first
      retried.ok = false
    }
  }

  // ⚠️ 上报/`partial` 用**与胜出结果对应的那一份样本**（见上面 `askedSample` 的说明）。
  const reported = halfChosen ? sample : askedSample

  if (result.ok !== true) {
    const described = describeMemoryFailure(result.reason)
    // 缺口没补成。压缩这一趟**刻意没有落盘**（见上）：它是唯一会删内容的一步，
    // 没换来任何进展就不该生效。如实把"压了但没写"报出去，别让读者以为文件变小了。
    if (compacted !== null) compact = { ...compact, persisted: false }
    // 缺口没补成，但压缩可能成功了——把两件事分别报出来，别让用户以为白等一场。
    // ⚠️ **`archived` 同理，而且它比压缩更早发生**（2026-10-03 体检）：冷归档的搬移与
    //    `background-history` 的备份增量都在**模型调用之前**就落盘了（上面 `archived` 那一
    //    段），而这条出口从前只说 `compact` ⇒ 读者看到"补齐失败"，**不知道这一趟已经搬走
    //    了 N 条、写过一份备份**。少报一件已落盘的事，与"没有缺口就说没缺口"是同一个病
    //    （客户端那边修的是同族的 `skipped` 出口）。
    return { ok: false, reason: result.reason, status: described.status, message: described.message, compact, archived, retried }
  }

  // ---- ⚠️⚠️ 落盘前的最后一道闸：读者在补齐期间**清空过背景认识**吗（2026-10-02 三方评审 P2-9）----
  //
  // 清空（`backgroundReset`）会把这个计数 +1，而这里正是"跑完模型、准备写回去"的那一刻。
  // 变了 ⇒ **整批丢弃、一个字都不写**，并如实回报 `resetDuringFill`。
  //
  // ⚠️ 为什么不能指望下面的 CAS：那条路撞上 `BACKGROUND_CHANGED` 时会**故意不复核、
  //    直接用当前文件重做一次合并**（下下一行的 `catch` 分支，是为"读者在 Obsidian 里
  //    改了一句"设计的）⇒ 那一批会被合并进**刚被清空的**文件，清空等于被悄悄撤销，
  //    而且没有任何一处会说。所以这一闸必须**在 CAS 之前**独立存在。
  if (resetByReader()) {
    if (compacted !== null) compact = { ...compact, persisted: false }
    return {
      ok: true,
      skipped: true,
      resetDuringFill: true,
      // 清空之后水位线是 null —— 客户端据此把话说准（"下次补齐会从头建立"）。
      covered: library.background(bookId).covered,
      compact,
      archived,
      retried,
      // 这一批**被整批丢弃**（一个字都没写回去）⇒ 截断嫌疑不必再说（说了也是在讲
      // 一个已被扔掉的东西）。`autoFoundation` 同理：没补进去就不该说"补了开头"。
      truncatedSuspected: false,
      // 子代理**确实跑过**（只是这一批被整批丢弃）⇒ 照实报它挂在谁下面。
      subagentParent: result.parent ?? null,
      sampled: null,
      partial: false,
      autoFoundation: false,
      elapsedMs: (result.elapsedMs ?? 0) + (compact?.elapsedMs ?? 0),
    }
  }

  // ⚠️ 这里曾经是「文本类型」重判那一次独立调用（2026-10-03 读者当天把它改回"只写一次"）。
  //    删掉之后这一趟**最多只有一次子代理调用**（补齐），不再可能多发一次。

  // 压缩与合并**共用这一次写入**：合并成功，两者一起生效；合并失败就什么都没写。
  //
  // ⚠️ 带 `base` 的那条路是**整份重写**（底稿是窗口开始时的快照），所以把
  //    `expectedMarkdown` 交给 library 侧在落盘前复核。窗口里被改过时**不能就这么
  //    失败**：这一趟的成果是"补来的条目"，丢了它等于白烧一次子代理调用。
  //    处置 = 丢掉那份过期的压缩结果，用**当前**的文件重新合并一次 ——
  //    压缩只是省 token，补齐才是进度。
  const mergeRange = { first: sample.from + 1, last: sample.to + 1 }
  let merged
  let compactPersisted = false
  try {
    merged = library.backgroundMerge(bookId, result.parsed, mergeRange, compacted === null
      ? {}
      : { base: compacted, backup: true, expectedMarkdown: before.markdown })
    compactPersisted = compacted !== null
  } catch (error) {
    if (error?.code !== 'BACKGROUND_CHANGED') throw error
    merged = library.backgroundMerge(bookId, result.parsed, mergeRange, {})
    compact = { ok: false, reason: 'BACKGROUND_CHANGED', elapsedMs: compact?.elapsedMs ?? 0, persisted: false }
  }
  // ---- 立卡报告（2026-10-06，A 版）：让"门槛有没有生效"第一次**看得见** ----
  //
  // 读者 2026-10-06："不能细枝末节都记进去…也不能丢掉真正重要的，不能一刀切降低质量。"
  // 提示词 13b 换了判据（三问 + 复现门槛）之后，**有没有生效**必须可观测 —— 否则又是
  // "写了四层、最后一层是空的"（这个仓库最烦的形状）。这里只报**增量**。
  const growth = memoryGrowthReport(before, parseBackground(merged.markdown))
  if (growth.newSubjects > 0) {
    logger?.warn?.(
      `[reading] 这一批新建了 ${growth.newSubjects} 个主体（人物 / 设定），其中 ${growth.newThin} 个只有一条`
      + ' —— 只有一条的多半是"名词解释"，多了会把人物卡的细节挤掉（提示词 13b 的复现门槛治的就是它）。',
    )
  }

  if (compactPersisted) {
    compact = {
      ...compact,
      backupPath: merged.backupPath ?? null,
      persisted: true,
      // ⚠️ 自动压缩（随补齐跑的那次）也导一份到哪里去……见上面"没有缺口"那一支。
      autoBackup: writeAutoBackup({
        root: deps.autoExportRoot,
        title: book.title,
        bookId,
        markdown: merged.markdown,
      }),
    }
  }

  // ⚠️ 刻意**不**往讨论时间线里写一条。补齐是维护动作，不是"聊过"——
  // 写进去会让"距上次聊这本书"在用户只点了个按钮之后变成「今天」，那是撒谎。
  return {
    ok: true,
    // 走到这里就是**真的补了**（没走上面那条"只剩手动补"的短路）⇒ 显式给 `false`，
    // 别让客户端拿到 `undefined`（键集一致性见上面那条注释）。
    skipped: false,
    covered: merged.covered,
    compact,
    // 大缺口时**这一趟只自动补了全书开头那几十章**（读者选定）。客户端据此把话说准：
    // 不是"没补"，而是"补了开头，剩下的要手动补"。
    autoFoundation,
    sampled: {
      first: reported.from + 1,
      last: reported.to + 1,
      chapters: reported.chapters.length,
      chars: reported.totalChars,
      // 这一批**实际给出的每章额度**（重点章再乘权重）。它就是"深度"这个数 ——
      // 界面上用得到，测试也靠它把"recent 那条路更厚"钉死。
      perChapter: reported.perChapter,
    },
    // ⚠️ **自动打底批的 partial 恒为 false**（3.0 起预算 18000，打底批装不满它被夹到的
    //    1..30 章 ⇒ 采样器会报 partial）。但打底的**语义**是"把开头补完就停"——
    //    客户端靠它停循环；"还剩多少"由 gap 如实说。所以这不算说谎，是这一批自己的定义。
    // ⚠️⚠️ **砍半重试胜出时 `partial` 恒为 true**（2026-10-05 真机 BUG）：砍半只在
    //    `halfTo < sample.to` 时发生 ⇒ 半截**必然没补到这一批要的末尾** ⇒ 缺口没补完 ✗。
    //    从前拿半截样本算 `partial` ⇒ 算出 false ⇒ **客户端停循环** ✗（真机：补 107 章，
    //    第一批砍半成 1-15 就"结束"了，剩下的 16..107 再也没补）。
    //    死循环由客户端另一条判据兜（水位线没推进 ⇒ 停），所以这里保守报 true 是安全的。
    partial: halfChosen
      ? true
      : (askedSample.partial === true && autoFoundation !== true),
    // ⚠️ 输出**像是被截断**（超出子代理单次输出上限）⇒ 面板要如实说一句
    //   （2026-10-02 读者实测过；判据与"为什么不拒绝"见 `looksTruncated`）。
    truncatedSuspected: result.truncatedSuspected === true,
    // ⚠️ **子代理挂在谁下面**（2026-10-06 读者实机提问）：绑定会话在线 ⇒ 挂它；不在线 ⇒
    //    落回"点补齐的那个会话"。这件事从前**没有任何地方说**，读者只会看到子代理会话
    //    散落在会话列表里而不知道为什么。面板据此说一句。
    subagentParent: result.parent ?? null,
    // 自适应重试（3.0 ③a）：这一批第一次没成（超时/空输出/截断嫌疑）⇒ 自动砍半重试的成绩
    //   —— 面板要说出来，读者才知道为什么这一批慢了一倍。
    retried,
    // 冷归档（3.0）：**纯代码**把超出活跃窗口的旧条目搬进「冷档案」的成绩 ——
    //   面板要说出来（"不再进上下文"这件事必须可见），否则读者只会发现"AI 忘事了"。
    archived,
    // ⚠️ 读者在这期间清空过吗。正常路径上走不到这里（清空会在上面那一道闸直接返回），
    //    留着是为了让返回形状**总是**有这个字段 —— 客户端不必猜"它什么时候在"。
    resetDuringFill: false,
    elapsedMs: (result.elapsedMs ?? 0) + (compact?.elapsedMs ?? 0),
  }
}

/**
 * **值得"砍半重试"** 的子代理失败原因（3.0 ③a 自适应重试的准绳）。
 * 这些都可能是"这一次要写的东西太大 / 模型这一次没睡醒"—— 更小的批多半就好；
 * `SUBAGENTS_UNAVAILABLE` / `NO_LIVE_PARENT` / `PARENT_LOOKUP_FAILED` 是部署事实或状态问题，
 * 重试无用（见 `fillMemoryGap` 的注释）。`FAILED: …` 是传输/宿主异常，也不在这张名单里。
 */
const RETRYABLE = new Set(['TIMEOUT', 'EMPTY_OUTPUT', 'UNPARSABLE_OUTPUT'])

/**
 * 写一份**冷归档的增量记录**（`background.history/NNNN-YYYYMMDD-HHMMSS-归档.md`）。
 *
 * 读者的三条要求（2026-10-02）：要有备份、**备份之间不要重复**、**命名有规律有顺序**好取并集。
 *   · 命名：四位序号 + 时间 + 操作 ⇒ 字典序 = 时间序（`background-history.js`）；
 *   · 不重复：**只记这一笔被搬走的条目**（原文），不抄活内容；
 *   · 可取并集：`scripts/merge-background-history.mjs` 按"去掉章号标点后的正文"去重、
 *     把 `人物·甲` 归位成 `甲`。
 *
 * ⚠️ **写不进去也不能影响补齐**：它是历史记录，不是活记忆 —— 失败只记一行日志。
 *
 * @param {object} library library 实例
 * @param {string} bookId 书 id
 * @param {{ items: Array<{section: string, entity: string|null, entries: string[]}> }} plan 搬运计划
 * @param {number} keepFrom 活跃窗口起点（1 起）
 * @returns {boolean} 是否写下
 */
function writeArchiveDelta(library, bookId, plan, keepFrom) {
  try {
    const dir = join(library.companionDir(bookId).dir, HISTORY_DIR)
    mkdirSync(dir, { recursive: true })
    const at = new Date()
    const seq = nextHistorySeq(readdirSync(dir))
    const name = historyFileName(seq, at, '归档')
    writeFileSync(
      join(dir, name),
      buildArchiveDelta({ keepFromChapter: keepFrom, at, items: plan.items }),
      'utf8',
    )
    return true
  } catch {
    return false
  }
}
