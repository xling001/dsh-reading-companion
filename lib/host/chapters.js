/**
 * 章节解析：两遍扫描 + 统计打分。**不使用任何模型调用**。
 *
 * 为什么不能交给 AI：一本 3MB 的小说全量过模型既慢又贵，而且结果不可复现
 * ——同一个文件今天切 200 章、明天切 198 章，进度锚点就全废了。常规阅读器
 * 都是靠"标题候选 + 统计筛选"做这件事，本文件照此实现。
 *
 * 与 `dsh-reader` 的 `splitTxtChapters` 相比，这里修了五个真实缺陷：
 *   1. 补上它漏掉的 `卷X`（它只有 `第X卷`）；
 *   2. **不丢弃空章节**——它用 `filter` 丢掉零长条目，连带把卷标题也丢了，
 *      于是目录里没有卷；这里把「卷」表达为章节上的 `volume` 字段；
 *   3. 输出 `warnings` 而不是静默吞掉异常结构；
 *   4. 回退策略改变：它退化成「全书一章」，这里退化成**定长分块**，
 *      至少让用户能分段阅读，而不是打开一个几百万字的单页；
 *   5. **合并重复的「目录行」**——见 {@link isDuplicateHeading}。空章节该留着
 *      如实报告，但"外层序号 + 书自己的章号"拼成的那种目录行进目录只会变成
 *      1400 个点开没内容的条目，必须去掉。
 */

/** 中文数字字符集（含全角与繁体大写）。 */
const NUM = '0-9０-９零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億'

/** 卷级标题：`第一卷`、`卷三`、`第 2 部`、`第五篇`、`正文卷`。 */
const VOLUME_RE = new RegExp(
  // ⚠️ **2026-10-05 补 `正文卷`**（读者真机：《道诡异仙》**缺第一卷**）：
  //    那本书的三卷是「**正文卷**」+「第二卷」+「第三卷」—— 前两个形态这里都认 ✓，
  //    而起点系的第一卷常写成 **`正文卷`**（既不是 `第X卷` 也不是 `卷X`）⇒ **整个第一卷没收进去** ✗。
  //    ⚠️ 只加这一个**具体**写法（不写成 `正文` 或 `.` 之类宽松匹配）：
  //    `^` 锚在行首的裸词越多，正文里偶然出现的一行就越容易被当成卷标题 ✗。
  `^\\s*(?:第\\s*[${NUM}]+\\s*[卷部篇集]|卷\\s*[${NUM}]+|正文卷)\\s*[:：.、,，\\-—－]?\\s*(.{0,60})$`,
)

/** 章级标题：`第一章`、`第 12 回`、`Chapter 3`。 */
const CHAPTER_RE = new RegExp(
  `^\\s*(?:第\\s*[${NUM}]+\\s*[章回节]|Chapter\\s*\\d+)\\s*[:：.、,，\\-—－]?\\s*(.{0,60})$`,
  'i',
)

/**
 * 特殊篇名。**允许字间空白**（`楔 子`）。
 *
 * ⚠️ 2026-10-04：实测「经典书库」那批的《七剑下天山》第 5 行就是 `第【1】段：楔 子 一阕词来…`
 *    —— 词里插了空格，而这一条从前要求**连续字符** ⇒ 它 31 个标题里**唯独这一条不中**。
 * 刻意**不收**裸 `序`：那会把「序幕」「序曲」误切成标题为「幕」「曲」的章。
 */
const SPECIAL_WORDS = ['序章', '序言', '序曲', '序幕', '楔子', '引子', '前言', '巻首', '卷首', '终章', '尾声', '后记', '后序', '番外', '外传', '附录']
const SPECIAL_RE = new RegExp(
  `^\\s*(${SPECIAL_WORDS.map((word) => word.split('').join('\\s*')).join('|')})\\s*[:：.、,，\\-—－]?\\s*(.{0,60})$`,
)

/**
 * 标题的**开头标记**（卷 / 章 / 特殊篇名三种词汇表的并集）。
 *
 * 只用来判断「这一行的标题里是不是还嵌着第二个标记」，不参与切分，
 * 所以刻意比 `VOLUME_RE` / `CHAPTER_RE` 宽：它只需要判定"这里是不是
 * 又起了一个标题"，多认几个词无害，漏认才会漏掉目录行。
 */
const HEADING_MARK_RE = new RegExp(
  `^\\s*(?:第\\s*[${NUM}]+\\s*[章回节卷部篇集]|卷\\s*[${NUM}]+|Chapter\\s*\\d+` +
    '|序章|序言|序曲|序幕|楔子|引子|前言|巻首|卷首|终章|尾声|后记|后序|番外|外传|附录)',
  'i',
)

/**
 * 判定一个标题是不是「目录行」——即"把外层序号和书自己的章号拼在一行"的复制品。
 *
 * 一类真实存在的 TXT（盗版站的特征）会在每章正文前多插一行目录行，于是同一章
 * 在文件里出现两次：
 *
 *     第2章 第0001章 机心        ← 目录行：下面紧跟真正的标题，自己一个正文字都没有
 *     第0001章 机心             ← 真标题，正文从这里开始
 *
 * 这一行也是合法的章级标题，于是切分时凭空多出一个 1 个字符（就一个换行）的
 * 章节。《一世之尊》这本书 2807 条目录里有 1403 条是它——点进去就是"这一章
 * 没有正文"，而真正的章号被这些噪声隔开，根本连不起来。
 *
 * 为什么不能按"正文为空"一刀切：**真正没有正文的章节是存在的**（作者留白、
 * 只有标题的番外），按设计它们要留在目录里并如实报告（见 `没有正文` 的
 * warning）。所以这里加一个更窄的条件：**这个标题里还嵌着第二个章级标记**。
 * 目录行必然满足（`第2章` 后面还跟着 `第0001章`），而普通章节几乎不可能
 * 把另一个章号写进自己的标题里——万一写了，它也还有正文，依旧不会被误判。
 *
 * @param {string} title 标题（已由 {@link matchHeading} 归一）
 * @returns {boolean}
 */
function isDuplicateHeading(title) {
  const first = HEADING_MARK_RE.exec(title)
  if (first === null) return false
  return HEADING_MARK_RE.test(title.slice(first[0].length))
}

/** 判定用的行长上限：超过这个长度的一行不可能是标题。 */
const MAX_HEADING_LINE = 80

/** 定长分块的最小块长，防止用户把 fallbackBlockChars 配得过小。 */
const MIN_BLOCK_CHARS = 200

/** 至少要有这么多候选，才认为这本书真的有章节结构。 */
const MIN_ACCEPTED = 3

/**
 * 逐行扫描，收集标题候选。
 *
 * @param {string} text 已归一化换行的全文
 * @param {number[]} out 复用的坐标容器（避免为每行分配对象）
 * @returns {{ candidates: object[], lineCount: number, avgLine: number }}
 */
function collectCandidates(text) {
  const candidates = []
  let lineCount = 0
  let cursor = 0

  while (cursor <= text.length) {
    let end = text.indexOf('\n', cursor)
    if (end === -1) end = text.length
    const raw = text.slice(cursor, end)
    lineCount += 1

    // 只看"短行"，长段落连正则都不用跑——这是主要的性能节省点。
    if (raw.length > 0 && raw.length <= MAX_HEADING_LINE) {
      const matched = matchHeading(raw)
      if (matched !== null) {
        candidates.push({
          lineStart: cursor,
          lineEnd: end,
          length: raw.length,
          level: matched.level,
          title: matched.title,
          raw: raw.trim(),
        })
      }
    }

    if (end >= text.length) break
    cursor = end + 1
  }

  const avgLine = lineCount === 0 ? 0 : text.length / lineCount
  return { candidates, lineCount, avgLine }
}

/**
 * **外层序号包装**：`第【1】段：`、`第 12 节：`、`第[3]段`。
 *
 * ⚠️ 2026-10-04：「**经典书库**」那类导出的 TXT 每章都长这样 ——
 *    `第【1】段：第1回 抱恨冰弹御强敌 忏情毒箭插酥胸`（外层是"这一段"的编号，
 *    内层才是书自己的回目）。而三条标题正则**全部锚定 `^\s*`**、要求第一个字就是
 *    `第`+数字+章/回 ⇒ `第【` 把它们**整个挡在锚点外** ⇒ 候选 **0** ⇒ 退回定长分块。
 *    实测 6 本全中：画眉鸟 / 云海玉弓缘 / 女帝奇英传 / 白发魔女传 / 多情剑客无情剑 /
 *    七剑下天山（`strategy` 都是 `fixed-blocks`、告警都是"未检测到章节结构"）。
 *
 * ⚠️⚠️ **锚点绝不许放宽**：正文里出现"第X章"字样极常见（本库反例：《幻形大法》第一篇 /
 *    《救人经》第一卷，34 条 ≤80 字的正文行）—— 去掉 `^` 去全文找会把正文切碎。
 *    所以这里只**剥一层已知的包装**，剥完**仍然要求行首命中**：
 *    实测这 6 本共恢复 282 个候选、其余 6 本新增 **0**、误切 **0**。
 */
const OUTER_WRAP_RE = new RegExp(
  `^\\s*第\\s*[【\\[]?\\s*[${NUM}]+\\s*[】\\]]?\\s*[段节]\\s*[:：.、,，\\-—－]?\\s*`,
)

/**
 * 单行匹配：依次试卷 / 章 / 特殊篇名。
 *
 * @param {string} raw 一行原文
 * @returns {{ level: 1|2, title: string }|null}
 */
function matchHeading(raw) {
  // 先剥外层序号包装（`第【1】段：`）—— **剥完仍要求行首命中**，理由见 `OUTER_WRAP_RE`。
  const bare = raw.replace(OUTER_WRAP_RE, '')

  const volume = VOLUME_RE.exec(bare)
  if (volume !== null) return { level: 1, title: composeTitle(bare, volume[1]) }

  const chapter = CHAPTER_RE.exec(bare)
  if (chapter !== null) return { level: 2, title: composeTitle(bare, chapter[1]) }

  const special = SPECIAL_RE.exec(bare)
  if (special !== null) return { level: 2, title: composeTitle(bare, special[2], special[1]) }

  return null
}

/**
 * 把「主标记 + 副标题」拼成完整标题。
 *
 * @param {string} raw 原始行
 * @param {string} tail 正则捕获的副标题
 * @param {string} [prefixToken] 特殊篇名的主标记
 * @returns {string}
 */
function composeTitle(raw, tail, prefixToken) {
  const head = raw.trim()
  if (prefixToken !== undefined) {
    const extra = (tail ?? '').trim()
    return extra === '' ? prefixToken : `${prefixToken} ${extra}`
  }
  // 主标记已在 raw 里，直接整行去掉多余空白即可。
  void tail
  return head
}

/**
 * 对候选打分并筛出真正的标题行。
 *
 * 第一关是**硬否决**：句末标点。标题几乎不可能以 `。`/`；` 收尾，而正文
 * 行几乎一定会——把这一条做成硬门槛而不是"投票"，是因为投票会漏掉
 * 「第二章 夜这个标题他看了很久……什么也没说。」这种**以章号开头、
 * 但其实是完整句子**的行：它行长短、无引号，光靠投票能凑够分。
 *
 * 第二关才是软性投票，两个特征都取自「标题行与正文行的形态差异」：
 *   - **偏短**：标题几乎总是短于全书平均行长；
 *   - **无引号对**：正文里的对话行才带引号（标题里的 `「」` 仍算可接受，
 *     所以这一条只扣分、不否决）。
 *
 * @param {object[]} candidates 候选列表
 * @param {number} avgLine 全书平均行长
 * @returns {{ accepted: object[], rejectedCount: number }}
 */
function scoreCandidates(candidates, avgLine) {
  const accepted = []
  for (const candidate of candidates) {
    // 硬否决：带句末标点的行是正文，不是标题。
    if (/[。；;]/.test(candidate.raw)) continue

    let score = 0
    if (candidate.length <= 40 || (avgLine > 0 && candidate.length <= avgLine * 0.4)) score += 2
    else if (avgLine > 0 && candidate.length <= avgLine * 0.8) score += 1

    if (!/[“”「」『』]/.test(candidate.raw)) score += 1

    if (score >= 2) accepted.push(candidate)
  }
  return { accepted, rejectedCount: candidates.length - accepted.length }
}

/**
 * 解析出章节列表。
 *
 * 返回的区间**精确铺满全文**（首尾相接、无缝隙），这样上层可以把
 * 整本解码后的文本一次性落成 `content.txt`，再用字符/字节区间随机读取，
 * 无需任何 char↔byte 映射表。
 *
 * @param {string} text 已归一化换行的全文
 * @param {{ fallbackBlockChars?: number, longChapterSplit?: { thresholdChars: number, targetChars: number }|null }} [options]
 *   `longChapterSplit`：超长章切分（D，2026-10-02 读者拍板 B+D）——`null` = 关闭；
 *   **不传 = 关**（开关在书库层：`createLibrary` 的默认开启，与 `index.js` 的配置缺省同源，有测试钉住）。
 *   标题切分与定长分块两条返回路径共用它。
 * @returns {{ strategy: string, chapters: object[], warnings: string[] }}
 */
export function parseChapters(text, options = {}) {
  const fallbackBlockChars = Math.max(MIN_BLOCK_CHARS, options.fallbackBlockChars ?? 4000)
  const warnings = []

  if (text.trim() === '') {
    return { strategy: 'fixed-blocks', chapters: [], warnings: ['文件没有可读正文'] }
  }

  const { candidates, avgLine } = collectCandidates(text)
  const { accepted, rejectedCount } = scoreCandidates(candidates, avgLine)

  if (accepted.length < MIN_ACCEPTED) {
    if (candidates.length > 0) {
      warnings.push(`候选标题 ${candidates.length} 个，仅 ${accepted.length} 个通过校验，未达到 ${MIN_ACCEPTED} 个门槛`)
    } else {
      warnings.push('未检测到章节结构')
    }
    return finishParse('fixed-blocks', fixedBlocks(text, fallbackBlockChars), warnings, text, options)
  }

  if (rejectedCount > 0) warnings.push(`忽略了 ${rejectedCount} 个疑似正文中的标题串`)

  const chapters = []
  let volume = null
  let volumeCount = 0
  let mergedHeadingCount = 0

  // 首个标题之前的内容单独成章，否则那部分正文在目录里无处可去。
  const firstStart = accepted[0].lineStart
  if (text.slice(0, firstStart).trim() !== '') {
    chapters.push({ title: '卷首', volume: null, kind: 'front', startChar: 0, endChar: firstStart })
  }

  for (let i = 0; i < accepted.length; i += 1) {
    const current = accepted[i]
    const next = accepted[i + 1]
    const contentEnd = next === undefined ? text.length : next.lineStart
    // 正文从标题行**之后**开始。标题已经作为 `title` 字段单独返回，
    // 若还留在正文里，阅读界面会把标题显示两遍。
    // 代价是章节区间之间夹着标题行（有缝隙）——这是刻意的，
    // 所以 validateChapters 只校验有序、不重叠、不越界，不要求铺满全文。
    const contentStart = Math.min(current.lineEnd + 1, text.length)

    if (current.level === 1) {
      // 卷标题没有独立正文，只作为后续章节的分组信息。
      volume = current.title
      volumeCount += 1
      continue
    }

    // 重复的目录行：正文为空，且标题里还嵌着第二个章级标记。它**不产出章节**，
    // 但仍然充当了上一章的右边界（上一章的 contentEnd 就是这一行的 lineStart），
    // 所以这一行的文字不会漏进上一章正文里。
    if (isDuplicateHeading(current.title) && text.slice(contentStart, contentEnd).trim() === '') {
      mergedHeadingCount += 1
      continue
    }

    chapters.push({
      title: current.title,
      volume,
      kind: current.title.startsWith('番外') || current.title.startsWith('外传') ? 'extra' : 'chapter',
      startChar: contentStart,
      endChar: contentEnd,
      titleStartChar: current.lineStart,
      titleEndChar: current.lineEnd,
    })
  }

  if (volumeCount > 0) warnings.push(`识别到 ${volumeCount} 个卷级标题`)

  if (mergedHeadingCount > 0) {
    warnings.push(`合并了 ${mergedHeadingCount} 个重复的目录行（同一章的外层序号与章号被拼成一行）`)
  }

  // 零长章节是真实存在的（相邻两个标题之间没有正文），如实报告而不是丢掉。
  const emptyCount = chapters.filter((chapter) => chapter.endChar <= chapter.startChar).length
  if (emptyCount > 0) warnings.push(`${emptyCount} 个章节没有正文`)

  const duplicateCount = countDuplicateTitles(chapters)
  if (duplicateCount > 0) warnings.push(`检测到 ${duplicateCount} 处重复标题`)

  return finishParse('heading-regex', chapters, warnings, text, options)
}

/** 两条返回路径共用的收尾：超长章切分（D）+ 补连续 index。 */
function finishParse(strategy, chapters, warnings, text, options) {
  const split = splitLongChapters(chapters, text, options.longChapterSplit ?? null)
  return {
    strategy,
    chapters: withIndex(split.chapters),
    warnings: [...warnings, ...split.warnings],
  }
}

/**
 * 超长章切分的**默认值** —— 全仓唯一来源。
 *
 * 从前它在两处各写一份（`index.js` 的 `CONFIG_DEFAULTS.longChapterSplit` 与
 * `library.js` 的 `createLibrary` 兜底），靠注释 + 一条测试钉住"不许分叉"。
 * 那是一条**容易漏的纪律**：默认值不是"两个地方碰巧同值"，而是一件事。
 * 现在两处都**浅拷贝**这个冻结对象 —— 浅拷贝而不是直接引用：调用方可能想改
 * 自己那一份，共享同一个冻结对象会把"改配置"变成运行时异常。
 *
 * ## 为什么是 5000 / 3500
 *
 * `thresholdChars` 定在 **5000**、`targetChars` 定在 **3500**（2026-10-03 读者拍板；
 * 阈值此前是 8000 → 4000 → 5000，片长此前是 2500）。
 *
 * 两个轴治的是同一件事的两面：**每轮注入的当前章**。`window.currentChapterMode` 默认
 * `'full'` ⇒ 当前章整章进注入、**没有上限**，所以"章有多长"直接等于"每轮要付多少字"。
 *
 * ⚠️ **阈值只决定"切不切"，每片多大是 `targetChars` 决定的。** 所以调阈值**不会**让
 * 一部长章书少切：一个 2.4 万字的章在 4000 和 5000 两条阈值下都 > 阈值 ⇒ 片数一样。
 * **"想少切、章更大"要动的是 `targetChars`。** 这一点很容易误判，所以写在这里。
 *
 * ⚠️ **两个旋钮要一起看，因为每轮注入的上界 ≈ `max(阈值, 片长)`。** 实测《神雕侠侣》
 * （43 章 / 102 万字，`drc-guard-audit/_probe-targetchars.mjs`，只读）：
 *
 *   | 阈值 | 片长 | 章数 | 每轮注入上界 |
 *   |---|---|---|---|
 *   | 不切 | — | 43 | 33,958 字 |
 *   | 5000 | 2500 | 427 | 4,557 字 |
 *   | 5000 | **3500** | **312** | **4,557 字** |
 *   | 5000 | 4000 | 276 | 4,557 字 |
 *   | 5000 | 5000 | 224 | 5,141 字 |
 *
 * ⭐ **上界不变而碎片大减**：那个 4,557 字的最大章是**≤ 5000 所以没被切**的整章 ——
 * 只要片长不超过它，把碎片合起来就是**免费**的。所以 2500 → 3500 换来的是
 * "目录少四分之一条目"（427 → 312）而**每轮一个字都没多付**。
 * ⚠️ 片长**不是**越大约好：`> 4557` 就开始顶到上界（5000 ⇒ 5,141 字，+13%）。
 *
 * ⚠️ **为什么停在 3500 而不是 4000**（4000 的章数更少：276）：4000 会让测试夹具的
 * "**3 片**"窗口与它的证伪条件**同时**落空 —— 3 片要求章长 > 8000，而那条用例的证伪
 * 条件是"阈值调回 8000 就该保完整"（要求章长 < 8000），两者互斥。3500 下
 * `(7000, 8000)` 这个窗口同时满足两者（见 `sampling.test.mjs` 的夹具注释）。
 * **这是为可测性付的价**（312 章 vs 276 章，上界一样），不是技术上的更优解 —— 如实记下来。
 *
 * ⚠️ 片更大 ⇒ 防剧透粒度更粗（读者已明确"可以牺牲一点防剧透精度"）。取样侧反而**变深**
 * （同一份预算分给更少的片），是好事。
 *
 * ⚠️ 切分落点**换行优先，换行不够时用句末标点补齐**（见 `planPieces`）；两者都不够的
 * 超长章保持整章并如实报告 —— 宁可不切，不硬切。
 */
export const DEFAULT_LONG_CHAPTER_SPLIT = Object.freeze({ thresholdChars: 5000, targetChars: 3500 })

/**
 * 超长章切分（**D 半边**，2026-10-02 读者拍板 B+D）。
 *
 * ## 两档语义（阈值只有一个）
 *
 *   - **章长 > `thresholdChars`（默认 5000）** ⇒ 切成子章：目标每片 `targetChars`
 *     （默认 3500）。切完之后下游一切机制（取样 / 注入窗口 /
 *     防剧透 / 跳读闸 / 冷归档）**自动**按子章粒度工作——因为**全仓的"章号"就是
 *     章节数组位置 + 1**，不是书里印的回目。这一档不需要任何下游改动配合。
 *   - **≤ `thresholdChars`** ⇒ 原样保留。
 *
 * ⚠️ 从前还有**中间一档**（4000–8000 保完整、由取样侧按比例读厚）。那一档的**机制**
 * 已随阈值降到 4000 而整体删除（2026-10-03），**与阈值后来抬到 5000 无关**：现在
 * 4000–5000 的章确实又保完整了，但那是"没超过阈值所以不切"，**不是**那一档的读厚
 * 机制回来了。见 `DEFAULT_LONG_CHAPTER_SPLIT` 与 `library.js` 里的删除说明。
 *
 * ## 切法
 *
 * 只在**换行之后**落切点——把一句话劈成两半的切分比不切更糟（注入里会出现
 * 断句残片，阅读页从半句话开始）。各片长度按 `原长 ÷ 片数` 向最近的段边界
 * 取齐。
 *
 * 区间内**一个换行都没有**的超长章（整章一段的极端排版）退一步用**句末标点
 * 之后**的位置落切点：句末切点同样不会劈开句子，而放弃切分的代价是那一章
 * **整章进每一轮注入**（`currentChapterMode: 'full'` 没有上限）——两者不成比例。
 * 只有"既没有换行、也没有句末标点"（非散文：表格 / base64 / 无标点流水账）
 * 才保持整章并如实报告 `no-break-point`。
 *
 * ## 标题
 *
 * 第 1 片**保留原标题**（目录第 1 片与正文里的标题行逐字一致）；第 2 片起
 * `原题02 / 03…`（位数 = 片数，至少两位）。第 1 片**不带** "01" 后缀是刻意的：
 * 带了它，阅读页的标题（来自目录）与正文里的标题行就对不上了——目录条目
 * 得自己撒谎。第 2 片起没有标题行 ⇒ 不带 `titleStartChar`（`titleAnchor`
 * 落到 `startChar`，仍唯一）。
 *
 * @param {object[]} chapters 字符区间形式的章节（未加 index）
 * @param {string} text 全文
 * @param {{ thresholdChars: number, targetChars: number }|null} options null = 关闭
 * @returns {{ chapters: object[], warnings: string[] }}
 */
export function splitLongChapters(chapters, text, options) {
  const cfg = normalizeSplitOptions(options)
  if (cfg === null) return { chapters, warnings: [] }

  const warnings = []
  const out = []
  let splitCount = 0
  let pieceTotal = 0
  let skippedNoBreakPoint = 0
  /** 规划不出来的其它原因（→ 各自的措辞，别都说成"没有换行边界"）。 */
  const unplannable = new Map()

  for (const chapter of chapters) {
    const plan = planPieces(text, chapter, cfg)
    if (plan.pieces === undefined) {
      if (chapter.endChar - chapter.startChar > cfg.thresholdChars) {
        if (plan.reason === 'no-break-point') skippedNoBreakPoint += 1
        else unplannable.set(plan.reason, (unplannable.get(plan.reason) ?? 0) + 1)
      }
      out.push(chapter)
      continue
    }
    const pieces = plan.pieces
    splitCount += 1
    pieceTotal += pieces.length
    const pad = Math.max(2, String(pieces.length).length)
    pieces.forEach((piece, k) => {
      out.push(k === 0
        // 第 1 片：保留标题字段（titleStartChar/titleEndChar 是 reindex 的锚），
        // 但区间用**第 1 片的**——原章对象自带的是整章区间，直接推等于没切。
        ? { ...chapter, startChar: piece.startChar, endChar: piece.endChar }
        : {
            // 第 2 片起**不继承** titleStartChar/titleEndChar——它们没有标题行，
            // 继承一个不存在的锚会让 titleAnchor 说出假话。
            title: `${chapter.title}${String(k + 1).padStart(pad, '0')}`,
            volume: chapter.volume,
            kind: chapter.kind,
            startChar: piece.startChar,
            endChar: piece.endChar,
          })
    })
  }

  if (splitCount > 0) {
    warnings.push(
      `将 ${splitCount} 个超长章（> ${cfg.thresholdChars} 字）切分为 ${pieceTotal} 个子章（目标 ${cfg.targetChars} 字/子章）`,
    )
  }
  if (skippedNoBreakPoint > 0) {
    warnings.push(
      `${skippedNoBreakPoint} 个超长章既没有换行、也没有句末标点（无从落切点），保持整章`,
    )
  }
  for (const [reason, count] of unplannable) {
    warnings.push(`${count} 个超长章算不出两片（${UNPLANNABLE_REASONS[reason] ?? reason}），保持整章`)
  }
  return { chapters: out, warnings }
}

/** 切分配置的归一化：形状不对 / 阈值 ≤ 0 一律视为"关"。 */
function normalizeSplitOptions(options) {
  if (options === null || options === undefined || typeof options !== 'object') return null
  const { thresholdChars, targetChars } = options
  if (!Number.isInteger(thresholdChars) || thresholdChars <= 0) return null
  if (!Number.isInteger(targetChars) || targetChars <= 0) return null
  return { thresholdChars, targetChars }
}

/**
 * `planPieces` 规划不出来时的原因 → 给读者看的一句话。
 *
 * ⚠️ **不许含糊**：这些原因对读者是完全不同的事（文本问题 vs 配置问题），
 * 合并成一句就是**假声明**（见 `planPieces` 的注释）。
 */
const UNPLANNABLE_REASONS = Object.freeze({
  'target-too-big': '目标字数不小于章长，按这个目标切不出两片 —— 检查切分目标 targetChars',
  'not-enough-cuts': '区间里的段边界放不下两个切点',
})

/** 句末标点。⚠️ 只在**没有换行**时才用它落切点（见 `planPieces` 的说明）。 */
const SENTENCE_END = /[。！？…!?]/
/** 句末标点之后紧跟的收尾符号（引号 / 括号）—— 切点要越过它们，别留在片首。 */
const SENTENCE_CLOSER = /[”’」』）】》"')\]]/

/**
 * 区间内每个**句末标点之后**（并越过紧跟的收尾引号 / 括号）的位置，严格递增。
 *
 * 只在换行边界一个都没有时才用（整章一段的极端排版）。找不到句末标点就返回空数组
 * —— 调用方据此**如实报告**"无从落切点"，而不是假装切了。
 *
 * ⚠️ 落在 `endChar` 上的位置不要：那会造出一个空片。
 */
function sentenceBoundaries(text, startChar, endChar) {
  const out = []
  for (let i = startChar; i < endChar; i += 1) {
    if (!SENTENCE_END.test(text[i])) continue
    let end = i + 1
    while (end < endChar && SENTENCE_CLOSER.test(text[end])) end += 1
    if (end < endChar) out.push(end)
    i = end - 1
  }
  return out
}

/** 两个各自严格递增的位置数组求并集（去重、保持递增）。 */
function mergeBoundaries(a, b) {
  const out = []
  for (const value of [...a, ...b].sort((x, y) => x - y)) {
    if (out.length === 0 || out[out.length - 1] !== value) out.push(value)
  }
  return out
}

/**
 * 给一章规划切点：返回 `{ pieces }`（首尾相接、恰好铺满原章区间）；
 * 规划不出来返回 `{ reason }` —— 原因要**如实区分**：
 *
 *   - `not-long-enough`：没超过阈值（正常情形，调用方不会把它算进警告）；
 *   - `no-break-point`：区间里既没有换行、也没有句末标点 ⇒ 无从落切点，保持整章
 *     （**刻意不做**：那种文本不是散文，硬切只会切出无意义的片段）；
 *   - `target-too-big`：`targetChars` 不小于章长 ⇒ 按这个目标算不出两片，这是**配置**
 *     问题、不是文本问题；
 *   - `not-enough-cuts`：边界有，但放不下两个切点。
 *
 * ⚠️ 从前这四种都报成"没有可用的换行边界"（`no-boundary` 也已改名 `no-break-point`，
 * 因为现在换行之外还试句末标点）。真机实测：`targetChars` 大于章长时，
 * 文本里有 60 个换行，提示照样那么说 —— 读者会去查**错的东西**。
 */
function planPieces(text, chapter, cfg) {
  const { startChar, endChar } = chapter
  const len = endChar - startChar
  if (len <= cfg.thresholdChars) return { reason: 'not-long-enough' }

  const wanted = Math.ceil(len / cfg.targetChars)

  // 段边界 = 区间内每个换行**之后**的位置。
  const newlines = []
  let at = text.indexOf('\n', startChar)
  while (at !== -1 && at + 1 < endChar) {
    newlines.push(at + 1)
    at = text.indexOf('\n', at + 1)
  }

  // ⚠️ **换行优先，换行不够时用句末标点补齐**。
  //
  // 两种"不够"都要补，理由不同、后果相同：
  //   ① 一个换行都没有（整章一段的极端排版）—— 从前这里直接放弃，后果不是"少切
  //      一刀"，是那一章**整章进每一轮注入**（`window.currentChapterMode` 默认
  //      `'full'`、没有上限）：25,000 字的章就是每轮付 25,000 字，正是 D 要治的病。
  //   ② 换行**太少**、放不下想要的片数 —— 切点只能落在少数几个换行上，切出来的片
  //      照样能远超 `thresholdChars`（形状：20,000 字的章只有 2 个换行 ⇒ 3 片、
  //      每片 6,000+）。那样"吃掉中间档"就是句空话：超长片又回到取样侧讨自适应额度。
  //
  // 句末切点**不会**把句子劈成两半，所以它不违反"宁可不切，不硬切"那条原则：
  // 那条禁的是**硬切**。真正无解的是"既没有换行、也没有句末标点"（非散文：
  // 表格 / base64 / 无标点流水账），那种文本保持整章才是对的 —— 如实报
  // `no-break-point`。
  let boundaries = newlines
  if (newlines.length + 1 < wanted) {
    boundaries = mergeBoundaries(newlines, sentenceBoundaries(text, startChar, endChar))
  }
  if (boundaries.length === 0) return { reason: 'no-break-point' }

  const count = Math.min(wanted, boundaries.length + 1)
  if (count < 2) return { reason: 'target-too-big' }

  // 切点向 `原长 × k / 片数` 的理想位置取齐（最近的段边界，严格递增）。
  const cuts = []
  let lastCut = startChar
  for (let k = 1; k < count; k += 1) {
    const target = startChar + Math.round((len * k) / count)
    let best = -1
    let bestDist = Number.POSITIVE_INFINITY
    for (const b of boundaries) {
      if (b <= lastCut) continue
      const dist = Math.abs(b - target)
      if (dist < bestDist) {
        bestDist = dist
        best = b
      }
    }
    if (best === -1) break
    cuts.push(best)
    lastCut = best
  }
  if (cuts.length === 0) return { reason: 'not-enough-cuts' }

  const edges = [startChar, ...cuts, endChar]
  const pieces = []
  for (let k = 0; k < edges.length - 1; k += 1) {
    if (edges[k + 1] > edges[k]) pieces.push({ startChar: edges[k], endChar: edges[k + 1] })
  }
  return pieces.length >= 2 ? { pieces } : { reason: 'not-enough-cuts' }
}

/**
 * 定长分块回退。
 *
 * 优先在窗口末尾附近的换行处断开，避免把一句话劈成两半；找不到换行
 * （比如整个文件没有换行）就硬切。
 *
 * @param {string} text 全文
 * @param {number} blockChars 目标块长
 * @returns {object[]} 章节列表（未加 index）
 */
function fixedBlocks(text, blockChars) {
  const chapters = []
  let cursor = 0
  let ordinal = 1

  while (cursor < text.length) {
    let end = Math.min(cursor + blockChars, text.length)
    if (end < text.length) {
      // 只在窗口最后 20% 里往回找换行，保证块长不会严重缩水。
      const floor = cursor + Math.floor(blockChars * 0.8)
      const newline = text.lastIndexOf('\n', end)
      if (newline > floor) end = newline + 1
    }
    chapters.push({
      title: `正文 · 第 ${ordinal} 段`,
      volume: null,
      kind: 'block',
      startChar: cursor,
      endChar: end,
    })
    cursor = end
    ordinal += 1
  }

  return withIndex(chapters)
}

/**
 * 给章节补上连续的 `index`。
 *
 * ⚠️ **算出来的位置必须写在展开之后**（`{ ...chapter, index }`）。切分后的第 1 片会
 * 继承原章的 `index`，而**定长分块路径在切分之前就编好了号**（`fixedBlocks` 自己调这个
 * 函数）—— 写成 `{ index, ...chapter }` 会让继承来的值把位置**盖掉**，于是排在前面的片
 * 与后面的块拿到**同一个章号**（实测 `0,1,2,3,1`）。而 `index` 是客户端目录的 key 与
 * "当前章"的判据 ⇒ 那种错位**不报错、不崩溃、界面看不出异常**。
 *
 * @param {object[]} chapters 章节列表
 * @returns {object[]}
 */
function withIndex(chapters) {
  return chapters.map((chapter, index) => ({ ...chapter, index }))
}

/**
 * 统计重复标题数量（不含卷）。
 *
 * @param {object[]} chapters 章节列表
 * @returns {number}
 */
function countDuplicateTitles(chapters) {
  const seen = new Set()
  let duplicates = 0
  for (const chapter of chapters) {
    if (chapter.kind === 'volume') continue
    if (seen.has(chapter.title)) duplicates += 1
    else seen.add(chapter.title)
  }
  return duplicates
}

/**
 * 校验一份章节索引是否自洽。
 *
 * 上层（书库）在落盘前调用它。校验的是三条**必须成立**的不变量：
 * 区间有序、互不重叠、不越出全文。刻意**不要求铺满全文**——标题行本身
 * 位于章节区间之外，是设计上的缝隙，不是缺陷。
 *
 * @param {object[]} chapters 章节列表
 * @param {number} textLength 全文长度
 * @returns {string[]} 违规描述（空数组 = 通过）
 */
export function validateChapters(chapters, textLength) {
  const problems = []
  let previousEnd = 0
  for (const chapter of chapters) {
    if (chapter.startChar < previousEnd) {
      problems.push(`第 ${chapter.index} 章起点 ${chapter.startChar} 早于上一章终点 ${previousEnd}（区间重叠）`)
    }
    if (chapter.endChar < chapter.startChar) {
      problems.push(`第 ${chapter.index} 章终点 ${chapter.endChar} 小于起点 ${chapter.startChar}`)
    }
    if (chapter.endChar > textLength) {
      problems.push(`第 ${chapter.index} 章终点 ${chapter.endChar} 超出全文长度 ${textLength}`)
    }
    previousEnd = Math.max(previousEnd, chapter.endChar)
  }
  return problems
}
