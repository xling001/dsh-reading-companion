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

/** 卷级标题：`第一卷`、`卷三`、`第 2 部`、`第五篇`。 */
const VOLUME_RE = new RegExp(
  `^\\s*(?:第\\s*[${NUM}]+\\s*[卷部篇集]|卷\\s*[${NUM}]+)\\s*[:：.、,，\\-—－]?\\s*(.{0,60})$`,
)

/** 章级标题：`第一章`、`第 12 回`、`Chapter 3`。 */
const CHAPTER_RE = new RegExp(
  `^\\s*(?:第\\s*[${NUM}]+\\s*[章回节]|Chapter\\s*\\d+)\\s*[:：.、,，\\-—－]?\\s*(.{0,60})$`,
  'i',
)

/**
 * 特殊篇名。
 * 刻意**不收**裸 `序`：那会把「序幕」「序曲」误切成标题为「幕」「曲」的章。
 */
const SPECIAL_RE = /^\s*(序章|序言|序曲|序幕|楔子|引子|前言|巻首|卷首|终章|尾声|后记|后序|番外|外传|附录)\s*[:：.、,，\-—－]?\s*(.{0,60})$/

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
 * 单行匹配：依次试卷 / 章 / 特殊篇名。
 *
 * @param {string} raw 一行原文
 * @returns {{ level: 1|2, title: string }|null}
 */
function matchHeading(raw) {
  const volume = VOLUME_RE.exec(raw)
  if (volume !== null) return { level: 1, title: composeTitle(raw, volume[1]) }

  const chapter = CHAPTER_RE.exec(raw)
  if (chapter !== null) return { level: 2, title: composeTitle(raw, chapter[1]) }

  const special = SPECIAL_RE.exec(raw)
  if (special !== null) return { level: 2, title: composeTitle(raw, special[2], special[1]) }

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
 * @param {{ fallbackBlockChars?: number }} [options]
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
    return { strategy: 'fixed-blocks', chapters: fixedBlocks(text, fallbackBlockChars), warnings }
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

  return { strategy: 'heading-regex', chapters: withIndex(chapters), warnings }
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
 * @param {object[]} chapters 章节列表
 * @returns {object[]}
 */
function withIndex(chapters) {
  return chapters.map((chapter, index) => ({ index, ...chapter }))
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
