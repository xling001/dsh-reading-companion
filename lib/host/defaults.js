/**
 * 宿主侧的**共享缺省值** —— "同一个数只能写一次"。
 *
 * ## 为什么要有这个文件（2026-10-03）
 *
 * 这些数各有**两个落点**：`lib/index.js` 的 `DEFAULTS`（配置缺省，读者改配置时覆盖它）
 * 与 `lib/host/library.js` 里的 `options.xxx ?? <同一个数>`（直接调用 `createLibrary`
 * 时的兜底 —— 测试、脚本、以及 `apply` 之外的入口走这条路）。
 *
 * 两边**必须同值**，而从前这件事靠**纪律**维持：`library.js` 里写着
 * "⚠️ 这个数必须与 `lib/index.js` 的 `DEFAULTS.…` 同值 —— 有测试钉住不许分叉"，
 * 而那句注释本身就是证据：**它分叉过一次**（`backgroundBudgetChars`）。
 *
 * 现在改成**由 import 保证**：两边都读这里的同一个常量，"同值"不再是需要被记住的事，
 * 也不再需要一条守卫去盯着两个字面量。
 *
 * ## 先例（同一个做法，2026-10-03 早些时候）
 *
 * `longChapterSplit` 的 `thresholdChars` / `targetChars` 已经是这样：唯一来源
 * `host/chapters.js` 的 `DEFAULT_LONG_CHAPTER_SPLIT`，`DEFAULTS` 与 `createLibrary`
 * 的兜底都从它取。守卫在 `long-chapter-split.test.mjs`：「书库：createLibrary 的兜底与
 * CONFIG_DEFAULTS **同源于唯一常量**（不是两个字面量碰巧同值）」—— 本文件是把同一件事
 * 推广到剩下的几对。
 *
 * ## ⚠️ 只收"两边确实是同一个概念"的
 *
 * 扫描时**按值配对必然出假阳性**。已剔除的（别再合并回去）：
 *   · `1024`：`EXPORT_DIR_MAX_CHARS`（导出目录名上限）与 `SETTING_PATH_MAX_CHARS`
 *     （设置文件路径上限）是两个**不相干**的上限，同值纯属巧合；
 *   · `24000`：`DEFAULTS.sample.foundationBudgetChars` 与 `library.js` 里
 *     `options.budgetChars ?? 24000` —— **`budgetChars` 是通用参数**，它的调用方常传
 *     `window.backgroundBudgetChars`（9000）⇒ 两者不是同一个概念；
 *   · `1200`：`recentMinPerChapter` 与 `maxPerChapter` 同值但语义相反（一个下限一个上限）。
 *
 * @type {Readonly<Record<string, number>>}
 */
export const HOST_DEFAULTS = Object.freeze({
  /** 背景认识段落的字符上限。超过 `backgroundBudgetChars × 压缩阈值` 就先压缩再合并。 */
  backgroundBudgetChars: 9000,

  /** 无标题降级时的**定长分块**大小（`chapters.js` 的 fallback 切分）。 */
  fallbackBlockChars: 4000,

  /** 每章**头部预留**的字符数（章首的"这一段在讲什么"要留在窗口里）。 */
  headAllowanceChars: 1500,

  /** 采样：每章**下限**（均分额度的封底；同时决定"一批最多吃多少章"）。 */
  minPerChapter: 600,

  /** 采样：每章**上限**（**基准**；重点章可达它的 `emphasisFactor` 倍）。 */
  maxPerChapter: 1200,

  /** 陪读段落里带几条讨论（`discussionLimit`）。 */
  discussionLimit: 8,

  /**
   * 「人物状态」**最多**带 / 写几个主体（按状态行的最后提及章号取最近的几个）。
   *
   * 两个落点，所以住在这里：注入侧（`background.js` 只把最近的几个带进提示词）与
   * 补齐侧（`memory-pipeline.js` 交给子代理的名单同样截到这里）。
   *
   * ⚠️ 它是**有意的覆盖面牺牲**（2026-10-03 读者拍板）：这一节服务的是**聊天时的陪读 AI**，
   * 它只需要"**此刻在场**的人站在哪边"；而"在场"最好的代理就是"最近被提到"。
   * 截断的代价是：更早的人只剩「人物」里的**身份锚**（他最后在干嘛），拿不到一句现状 ——
   * 那正是冷归档之后本来就有的形状，不是新增损失。
   * 换来的是**注入预算有界**：≤8 × 30 字 ≈ 240 字，不随书长。
   */
  backgroundStateMaxSubjects: 8,

  /**
   * **在线折叠**：人物"最后被提及"距今超过这么多章 ⇒ 注入时折叠成锚（只留最新一条）。
   *
   * ⚠️ **2026-10-06 修掉一处静默失效**：这个值从前只在 `index.js` 的 `DEFAULTS` 里声明，
   *    而 `createLibrary({...})` 的调用点**从没把它传下去** ⇒ `library.js` 拿到 `undefined`
   *    ⇒ `renderBackgroundForPrompt` 里 `offlineAfter = null` ⇒ **在线折叠在生产里一次都没
   *    生效过**（与 `index.js:95` 记的 `inboxDir` 是同一个病：配置声明了、没接线、不报错）。
   *    现在两边都从这一处取。
   */
  personOfflineChapters: 60,

  /**
   * **冷归档的活跃窗口**（章数）：章号**全部**早于 `readingChapter - 本值 + 1` 的条目
   * 搬进「冷档案」。⚠️ 它同时是「名录化」的判据来源（出窗主体在注入里只留名字）。
   */
  archiveWindowChapters: 120,

  /**
   * **身份锚的退役窗口 M**（章）：出窗超过 M 章的主体，连"他是谁"的锚一起进冷档案。
   * 理由与实测见 `background.js` 的 `planArchive` JSDoc（《一世之尊》外推 476 张卡
   * ⇒ 锚占 ~21,420 字 ⇒ 压缩撞墙 + 注入被挤成花名册）。`0` = 关闭（锚永不退役）。
   */
  anchorMaxAgeChapters: 360,

  /** 「名录化」最多列几个名字（超出的只报个数）—— 名录随立卡数线性长，得有个头。 */
  rosterMaxNames: 120,

  /**
   * **打底批**（首次补齐那一批）专用的字符预算（3.0）。
   *
   * ⚠️ 为什么与 `budgetChars` 分开：`budgetChars` 降到 18000 是为了**后续批次**的输出更小
   * （不撞 32768、不 stall）；而打底批**只有一个**、章数还被 `foundationChapters` 钉在 30 章
   * ⇒ 它的**输出**天生有界（2–4 千字）⇒ 可以放心保留 24000 —— 这是读者的要求：
   * "打底还是希望能够跑 30 章，或者 25 章，现在的 20 章有些太少了"。
   *
   * ⚠️ **2026-10-07（工单 B3）**：它的**第二个落点不在 `library.js`**，而在
   * `lib/host/memory-pipeline.js`（`config.sample?.foundationBudgetChars` 的兜底）——
   * 所以它是本文件里唯一"落点是 index.js + memory-pipeline.js"的一对 ✓（守卫在
   * `test/contract.test.mjs`，那条把两个文件都读）。
   */
  foundationBudgetChars: 24000,
})
