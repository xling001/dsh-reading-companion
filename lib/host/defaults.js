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
})
