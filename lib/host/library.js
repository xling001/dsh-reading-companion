/**
 * 书库：落盘布局、导入、目录索引、按章读取、进度与会话绑定。
 *
 * 布局（全部在插件自己的目录下，绝不碰官方 `storages/`）：
 *
 *   <storageDir>/
 *     library.json               书架索引
 *     bindings.json              书籍 ↔ 会话 ↔ 进度 ↔ 摘要水位
 *     drafts.json                待写入的笔记草稿
 *     inbox/                     用户把 TXT 丢这里 → 扫导入
 *     books/<bookId>/
 *       meta.json                元信息
 *       source.txt               原始字节（只读，永不改写）
 *       content.txt              解码并归一化换行后的 UTF-8 全文
 *       chapters.json            章节索引（字符 + 字节双区间）
 *       notes.md                 结构化笔记（只追加）
 *
 * 关于 `content.txt`：它是**整本解码后的文本**，章节区间只是它的切片。
 * 导入时按章累加 `Buffer.byteLength`，就同时得到精确的字符区间与字节区间
 * ——不需要任何 char↔byte 映射表，也不需要在读取时重新解码 GB18030。
 * 代价是磁盘上多一份文本，对小说体量而言完全可以接受。
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'

import { atomicWriteJson, atomicWriteText, readJson, updateJson } from './atomic-json.js'
import { decodeBook } from './encoding.js'
import { runExport } from './export.js'
import { parseChapters, validateChapters } from './chapters.js'
import { assertRealPathInsideRoot, inspectImportSource, inspectWorkspaceDir, resolveInsideRoot, sanitizeFolderName } from './paths.js'
import { normalizeSessionId } from './spoiler.js'

/** 书库索引的 schema 版本。改结构时递增，并在这里做迁移。 */
const SCHEMA_VERSION = 1

/** bookId 形态：源文件 sha256 的前 16 位十六进制。 */
const BOOK_ID_RE = /^[0-9a-f]{16}$/

/** 会话工作区里那个文件夹的名字前缀。 */
const COMPANION_DIR_PREFIX = '陪读_'

/** 落在陪读文件夹里的隐藏标记，用来认领这个文件夹属于哪本书。 */
const COMPANION_MARKER = '.dsh-reading-companion.json'

/** 陪读文件夹里的一份说明，让用户点进去就知道这是什么、别删什么。 */
const COMPANION_README = `# 陪读文件夹

这个文件夹由 DSH 插件 \`dsh-reading-companion\` 创建和维护。

- \`notes.md\` —— 你的摘抄与感想（**只追加，插件永不重写既有内容**）
- \`background.md\` —— 陪读 AI 对世界观、人物、人物关系的认识（可手工修改）
- \`persona.md\` —— 你自己写的「书友设定」：AI 用什么口吻、关注什么
- \`background.bak.<时间戳>.md\` —— **每次压缩前**留一代，一份不删。
  压缩是唯一会删掉内容的步骤，而这份认识的价值超出"喂给 AI"（读完一本书要梳理
  角色经历、时间线、走过的地方，全靠它），所以历代都留着。
  （早年只留一个 \`background.bak.md\`，那种老文件仍在原地，一并算作一代。）

## 导出到笔记软件

插件可以把这本书的笔记与背景认识导出成**文件名自带书名**的一组文件，直接丢进
Obsidian 之类的笔记软件，不必再手工改名。落点是**你指定的导出目录下面的一个文件夹**：
\`陪读导出_<书名>/\`。里面有：

- \`<书名>-笔记.md\`
- \`<书名>-背景.md\`
- \`<书名>-背景-压缩前-<时间戳>.md\`（每一代各一份，一代一个文件）

导出**不会改动这个文件夹里的任何东西**：笔记是往目标文件**追加**没有的条目，
背景是整份快照，历代备份一代不漏。重复导出不会产生重复内容。

原书正文、章节索引等大文件**不在这里**，它们在插件自己的数据目录里
（约几十 MB），不会污染你的工作区。

这个文件夹可以安全地加入版本管理，也可以随时删掉——插件会重建。
\`\`\`
$DSH_HOME/dsh-reading-companion/books/<bookId>/
\`\`\`
`

/** `notes.md` 的头部骨架放在 notes.js —— 渲染与创建必须是同一份定义。 */
import { appendNote, appendTrashMarker, deleteDraft, emptyNotesHeader, listDrafts, paginateNotes, readNotes, removeNotes, upsertDraft } from './notes.js'
import {
  backgroundGap,
  mergeBackground,
  parseBackground,
  readBackground,
  renderBackground,
  renderBackgroundForPrompt,
  writeBackground,
} from './background.js'
import {
  maxUpdateChapter,
  supersedesList,
  updatesToIncomingDoc,
} from './background-update.js'
import {
  appendDiscussion,
  lastDiscussionAt as lastOf,
  normalizeDiscussion,
  readDiscussions,
  recentDiscussions,
} from './discussions.js'

/**
 * 书友设定的字数上限。
 *
 * 它进的是注入顺序里的**稳定前缀**，必须短到不挤占背景认识的预算。4000 字
 * 对一个"口吻与关注点"的设定来说已经很宽裕了。
 */
const PERSONA_MAX_CHARS = 4000

/**
 * 分类名的字数上限。
 *
 * 它只进书架界面的一个下拉，不进 prompt，所以不必像书友设定那样算预算；这个
 * 上限纯粹是防止有人把一整段话粘进分类名里把界面撑爆。
 */
const CATEGORY_MAX_CHARS = 40

/**
 * 运行期设置项里自由文本的字数上限。
 *
 * 目前只有 `webGate` 一个字段，值是三个固定档位之一，几十字符纯属宽裕到不像话；
 * 这个上限只是防止有人手动把一整段话粘进 `settings.json` 里。
 */
const SETTING_MAX_CHARS = 64

/**
 * 导出目录的长度上限。
 *
 * 比 `SETTING_MAX_CHARS`（64）松得多，因为它是**路径**。而且它**不做静默截断**：
 * 一条被砍掉尾巴的路径会安静地指向别的地方，比拒绝保存糟得多（同 `persona.md`
 * 那条"超限报错，不静默截断"的规矩）。
 */
const SETTING_PATH_MAX_CHARS = 1024

/**
 * 归一化设置项里的自由文本。
 *
 * 空 / 非字符串 / 只有空白一律回 `null`，含义是**未设置**（跟随 `cordis.yml`），
 * 而不是"设置成了一个叫空串的值"。控制字符会被剥掉：这个值会进界面、也可能被
 * 日志打印，混进控制字符只会让排查变难。
 *
 * ⚠️ 这里**不做档位合法性校验** —— 合法值清单在宿主侧（`WEB_GATE_MODES`），这个
 * 模块不认识它。见 `readSettings` 的说明。
 *
 * @param {unknown} raw 原始值
 * @returns {string|null}
 */
//#region 章节切片的清洁化

/**
 * 章末"非正文"块的行首识别模式。
 *
 * 中文网文的章末几乎总是粘着作者的话、求票、完结标记。它们**紧贴尾部**，而抽样
 * 恰恰把 40% 的配额给了尾部——以默认 100 字配额算，40 字的尾窗会被整块占满，
 * 「于是他明白了那个人是谁」这种收束信号直接归零。所以切片之前先剥掉。
 *
 * ⚠️ 只在章末窗口中、且只在**行首**匹配，避免误伤正文里偶然出现的同名短语。
 */
const TAIL_NOISE_PATTERNS = [
  /^作\s*者\s*(有\s*话\s*说|的\s*话|君|说)/,
  /^求\s*(月\s*票|推\s*荐\s*票|推\s*荐|收\s*藏|订\s*阅|打\s*赏|票|追\s*读|评\s*价\s*票|鲜\s*花|点\s*赞|个\s*收\s*藏)/,
  /^[（(【\[]?\s*本\s*章\s*完\s*[）)】\]]?$/,
  /^[（(【\[]?\s*(未\s*完\s*待\s*续|全\s*书\s*完|全\s*文\s*完|本\s*卷\s*完)\s*[）)】\]]?$/,
  /^字\s*数\s*补\s*丁/,
  /^感\s*谢.{0,40}(打\s*赏|月\s*票|推\s*荐\s*票|支\s*持|投\s*票)/,
  /^p\s*\.?\s*s\s*[.．:：]/i,
  /^(今\s*天\s*就\s*到\s*这\s*里|明\s*天\s*(见|继\s*续)|加\s*更|稍\s*后\s*还\s*有)/,
]

/** 纯分隔线：三连以上的同种符号。 */
const SEPARATOR_LINE_RE = /^(?:[-—–=*＊※·+_~]\s*){3,}$/

/**
 * 剥掉章末的非正文块，返回**清洁后的正文**。
 *
 * 三步，每一步都是刻意的保守选择：
 *  1. **只看尾部窗口**（默认章长的 15%）——前半章一律不碰；
 *  2. 在窗口内**从前往后**找第一个可接受的行首标记（附言、求票、分隔线），
 *     但**跳过**那些"后面还剩大段内容"的候选——那种更像是正文里的偶然短语；
 *  3. 找到就从那里切到底。切完为空则判定有误，**退回原文**。
 *
 * @param {string} text 章节正文（调用方已 trim）
 * @param {{tailRatio?: number}} [options]
 * @returns {{text: string, removedChars: number, cutAt: number|null}}
 */
export function stripChapterTrailingNoise(text, options = {}) {
  const ratio = options.tailRatio ?? 0.15
  if (typeof text !== 'string' || text === '') return { text: '', removedChars: 0, cutAt: null }

  const windowChars = Math.max(1, Math.floor(text.length * ratio))
  const windowStart = text.length - windowChars

  // 逐行记起始偏移，才能判断"这一行是否落在尾窗里"。
  const lines = text.split('\n')
  const starts = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1 // +1 = 被 split 吃掉的换行
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (starts[i] < windowStart) continue
    const bare = lines[i].trim()
    if (bare === '') continue
    const hit = SEPARATOR_LINE_RE.test(bare) || TAIL_NOISE_PATTERNS.some((re) => re.test(bare))
    if (hit === false) continue
    // 标记之后剩太多，说明它不像"章末附言"——继续往后找，别在这里切。
    if (text.length - starts[i] > Math.floor(windowChars * 0.6)) continue

    const kept = text.slice(0, starts[i]).replace(/\s+$/, '')
    if (kept === '') return { text, removedChars: 0, cutAt: null }
    return { text: kept, removedChars: text.length - kept.length, cutAt: kept.length }
  }

  return { text, removedChars: 0, cutAt: null }
}

/** 句读符。头窗向后对齐用，避免切出半句话或断掉的引号。 */
const SENTENCE_END_RE = /[。！？…；”』」）)]/

/**
 * 把头部切点向后挪到最近的句读**之后**（最多多取 `slack` 字）。
 * 找不到就原样返回——宁可多留半句，也不要丢整句。
 *
 * @param {string} text 清洁后的正文
 * @param {number} cut 期望切点
 * @param {number} [slack] 允许向后多走的字数
 * @returns {number} 对齐后的切点
 */
export function alignHeadCut(text, cut, slack = 24) {
  const limit = Math.min(text.length, cut + slack)
  for (let i = Math.max(0, cut - 1); i < limit; i += 1) {
    if (SENTENCE_END_RE.test(text[i])) return i + 1
  }
  return cut
}

/**
 * 把尾部起点向前挪到最近的换行**之后**（最多多让 `slack` 字），
 * 让尾窗从一个自然段开头开始。找不到就原样返回。
 *
 * @param {string} text 清洁后的正文
 * @param {number} cut 期望起点
 * @param {number} [slack] 允许向后多走的字数
 * @returns {number} 对齐后的起点
 */
export function alignTailCut(text, cut, slack = 24) {
  const limit = Math.min(text.length, cut + slack)
  for (let i = Math.max(0, cut); i < limit; i += 1) {
    if (text[i] === '\n') return i + 1
  }
  return cut
}

//#endregion

function normalizeSettingText(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned === '' ? null : cleaned.slice(0, SETTING_MAX_CHARS)
}

/**
 * 归一化设置项里的**路径**。
 *
 * 与 {@link normalizeSettingText} 的差别只有一条，但很要紧：**不截断**。写成
 * 一个被砍掉尾巴的路径，指向的是另一个目录——静默地把文件导到别处，比拒绝保存
 * 严重得多。超长在**写入路由**那一侧被拒绝（那里能报错给人看）。
 *
 * @param {unknown} raw 原始值
 * @returns {string|null} null = 未设置
 */
function normalizeSettingPath(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (cleaned === '') return null
  return cleaned.slice(0, SETTING_PATH_MAX_CHARS)
}

/**
 * 读文本文件；不存在回 `null`（**与空文件区分开**）。
 *
 * @param {string} path
 * @returns {string|null}
 */
function readTextIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 读原始字节；不存在回 `null`。
 *
 * 导出走字节级搬运（前缀插一行标记），**不经过字符串往返** —— 背景与备份本来就是
 * "原件的副本"，任何转码或换行归一化都是不该发生的事。
 *
 * @param {string} path
 * @returns {Buffer|null}
 */
function readBytesIfExists(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/**
 * 校验 bookId 形态。
 *
 * 这是路径安全的第一道闸：bookId 最终会参与拼路径，必须在进文件系统
 * 之前就证明它只可能是我们自己生成的十六进制串。
 *
 * @param {unknown} bookId 待校验值
 * @returns {string} 合法的 bookId
 * @throws {Error} 形态不合法
 */
function assertBookId(bookId) {
  if (typeof bookId !== 'string' || !BOOK_ID_RE.test(bookId)) {
    throw new Error(`BOOK_ID_INVALID: ${String(bookId)}`)
  }
  return bookId
}

/**
 * 创建书库门面。
 *
 * @param {object} options
 * @param {string} options.storageDir 书库根目录（绝对路径）
 * @param {number} [options.fallbackBlockChars] 无章节结构时的分块长度
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger]
 * @returns {object} 书库门面
 */
export function createLibrary(options) {
  const storageDir = options.storageDir
  const fallbackBlockChars = options.fallbackBlockChars ?? 4000
  const logger = options.logger ?? {}
  /**
   * 导入白名单（可选）。非空时，`importBook` 只接受落在这些根目录内的路径。
   *
   * 默认空数组 = **保持旧行为**（任意可读路径都能导入）。因为"从磁盘任意位置导
   * 一本 TXT"是这个功能的正当用法，把它默认关掉是拿用户的正常操作买单。
   * 它是给**想收窄**的人准备的闸：导入接口是一条本地文件读取面。
   */
  const importRoots = Array.isArray(options.importRoots) ? options.importRoots : []

  const libraryPath = join(storageDir, 'library.json')
  const bindingsPath = join(storageDir, 'bindings.json')
  const draftsPath = join(storageDir, 'drafts.json')
  const categoriesPath = join(storageDir, 'categories.json')
  /**
   * 运行期设置。
   *
   * 与 `library.json`（书架索引）/ `categories.json`（主观归类）分开放。它是
   * **运行期可改的开关**，而 `cordis.yml` 是安装时的默认——两者是覆盖关系，
   * 混进任何一个已有的文件都会让那份文件的损坏范围变大。
   */
  const settingsPath = join(storageDir, 'settings.json')
  // 背景认识是**每本书一份**的 Markdown，放在书自己的目录里（见 background.js）。
  // 它取代了早期的全局 `digest.json`：理解属于某一本书，不该混在一个共享文件里；
  // 而且 .md 你能打开来读、来改。
  const inboxDir = join(storageDir, 'inbox')
  const booksDir = join(storageDir, 'books')

  /** 幂等建目录。 */
  function ensureDirs() {
    for (const dir of [storageDir, inboxDir, booksDir]) mkdirSync(dir, { recursive: true })
  }

  /**
   * 解析某本书的目录，并做真实路径复检（挡 junction 逃逸）。
   *
   * @param {string} bookId 书 id
   * @returns {string} 绝对路径
   */
  function bookDir(bookId) {
    assertBookId(bookId)
    const dir = resolveInsideRoot(booksDir, bookId)
    return assertRealPathInsideRoot(booksDir, dir)
  }

  /**
   * 读书架索引。
   *
   * @returns {{ books: object[], revision: string|null, recovered: boolean }}
   */
  function readLibrary() {
    const { value, revision, recovered } = readJson(libraryPath, { schemaVersion: SCHEMA_VERSION, books: [] })
    const books = Array.isArray(value?.books) ? value.books : []
    return { books, revision, recovered }
  }

  /**
   * 写书架索引（CAS）。
   *
   * @param {object[]} books 新的书籍数组
   * @param {string|null} expectedRevision 上次读到的 revision
   * @returns {string} 新 revision
   */
  function writeLibrary(books, expectedRevision) {
    const result = updateJson(libraryPath, {
      fallback: { schemaVersion: SCHEMA_VERSION, books: [] },
      expectedRevision,
      mutate: () => ({ schemaVersion: SCHEMA_VERSION, books }),
    })
    return result.revision
  }

  /**
   * 读书架的一本书。
   *
   * @param {string} bookId 书 id
   * @returns {object|undefined}
   */
  function findBook(bookId) {
    const { books } = readLibrary()
    return books.find((book) => book.bookId === bookId)
  }

  /**
   * 书架列表，附带每本的进度摘要。
   *
   * @returns {object[]}
   */
  function list() {
    const { books, recovered } = readLibrary()
    const { value: bindings } = readJson(bindingsPath, { schemaVersion: SCHEMA_VERSION, books: {}, bySession: {} })
    const bound = bindings?.books ?? {}
    // 分类表只读一次。每本书各读一遍就是 N 次同步 IO，而书架是打开面板就会拉的。
    const { assignments } = readCategories()
    return {
      books: books.map((book) => {
        const entry = bound[book.bookId]
        return {
          ...book,
          progress: entry?.progress ?? null,
          // 读者是否已声明读完（v1.45）。⚠️ 这里**故意不调 `isFinished()`** ——
          // 那个会再读一次 bindings（书架是打开面板就拉的，N 次同步 IO 不值得）；
          // 判定口径与它一致（见 `isFinished`）。
          finished: typeof entry?.finishedAt === 'string' && entry.finishedAt !== '',
          // 已绑定会话的 id（`null` = 未绑定）。界面靠它显示「已绑定 / 未绑定」，
          // 并决定点书籍时能不能跳到那个会话。
          sessionId: entry?.sessionId ?? null,
          // `null` = 用户没分过类，名字由界面给（「未分类」）。
          category: assignments[book.bookId] ?? null,
        }
      }),
      categories: sortedCategoryNames(assignments),
      recovered,
      storageDir,
    }
  }

  /**
   * 扫 inbox，报告可导入的文件。
   *
   * 刻意**不算 sha**：那要对每个文件做一次全量哈希，在大文件上肉眼可见地慢。
   * 用「同名 + 同字节数」判定"已导入过"，够用且瞬间返回；真正的幂等判定
   * 留给 {@link importBook} 的 sha 比对。
   *
   * @returns {object[]}
   */
  function scanInbox() {
    ensureDirs()
    const { books } = readLibrary()
    const known = new Set(books.map((book) => `${book.sourceName}\u0000${book.byteLength}`))
    const entries = []
    for (const name of readdirSync(inboxDir)) {
      if (name.startsWith('.')) continue
      const absPath = join(inboxDir, name)
      let stat
      try {
        stat = statSync(absPath)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      entries.push({
        name,
        absPath,
        byteLength: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        looksLikeText: ['.txt', '.text', '.md', ''].includes(extname(name).toLowerCase()),
        alreadyImported: known.has(`${name}\u0000${stat.size}`),
      })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return entries
  }

  /**
   * 导入一本书。
   *
   * 幂等：`bookId` 取源文件 sha256 前 16 位，同一份文件重复导入会直接
   * 命中已有记录并原样返回，不重复落盘、不覆盖既有笔记。
   *
   * @param {{ absPath: string, title?: string }} input 导入参数
   * @returns {object} 导入结果
   */
  function importBook(input) {
    const absPath = input?.absPath
    const inspected = inspectImportSource(absPath, { importRoots })
    if (!inspected.ok) {
      const error = new Error(`IMPORT_REJECTED: ${inspected.reason}`)
      error.code = inspected.reason
      throw error
    }

    const bytes = readFileSync(absPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const bookId = sha256.slice(0, 16)

    const existing = findBook(bookId)
    if (existing !== undefined) {
      logger.info?.(`[reading] 已存在同一份书，跳过导入 bookId=${bookId}`)
      return { book: existing, deduped: true }
    }

    const decoded = decodeBook(bytes)
    const parsed = parseChapters(decoded.text, { fallbackBlockChars })
    const problems = validateChapters(parsed.chapters, decoded.text.length)
    if (problems.length > 0) {
      // 不变量被打破：宁可拒绝导入，也不要落一个索引自相矛盾的书。
      throw new Error(`CHAPTER_INDEX_INVALID: ${problems.join('; ')}`)
    }

    const withOffsets = attachByteOffsets(decoded.text, parsed.chapters)
    const sourceName = basename(absPath)
    const title = normalizeTitle(input?.title, sourceName)

    const dir = bookDir(bookId)
    mkdirSync(dir, { recursive: true })

    // 原始字节与解码文本各存一份：前者是"原书"承诺，后者是随机读取的载体。
    copyFileSync(absPath, join(dir, 'source.txt'))
    atomicWriteText(join(dir, 'content.txt'), decoded.text)

    const meta = {
      schemaVersion: SCHEMA_VERSION,
      bookId,
      title,
      author: null,
      sourceName,
      importedAt: new Date().toISOString(),
      sourceSha256: sha256,
      byteLength: bytes.length,
      charLength: decoded.text.length,
      encoding: decoded.encoding,
      encodingConfidence: decoded.confidence,
      chapterCount: withOffsets.length,
      strategy: parsed.strategy,
      warnings: [...decoded.warnings, ...parsed.warnings],
    }

    atomicWriteJson(join(dir, 'meta.json'), meta)
    atomicWriteJson(join(dir, 'chapters.json'), {
      schemaVersion: SCHEMA_VERSION,
      strategy: parsed.strategy,
      chapters: withOffsets,
      warnings: parsed.warnings,
    })

    const notesPath = join(dir, 'notes.md')
    if (!existsSync(notesPath)) atomicWriteText(notesPath, emptyNotesHeader(title))

    // 登记进书架。books 为空时 expectedRevision 直接取读到的值。
    const { books, revision } = readLibrary()
    writeLibrary([...books, meta], revision)

    logger.info?.(`[reading] 导入完成 ${title}（${withOffsets.length} 章，${decoded.encoding}）`)
    return { book: meta, deduped: false }
  }

  /**
   * 重新切分一本书的章节索引（就地重写 `chapters.json`）。
   *
   * ## 为什么需要它
   *
   * 切分规则会变，而**已经在书架里的书不会自己更新**：`importBook` 是幂等的
   * （同一份 sha 直接返回旧记录，见上），所以修好解析器只对"以后导入的书"生效。
   * 想让老书也吃到修复，就只能拿着已经解码好的 `content.txt` 重跑一遍切分。
   *
   * ## 三条不变量
   *
   *   1. **正文区间不动。** 存活章节的 `startChar/endChar/startByte/endByte` 必须
   *      与重切前逐字相同。这是硬底线：它们一动，读者的滚动位置、摘抄偏移、
   *      投喂窗口全部会漂。做不到就抛 `REINDEX_RANGE_DRIFT`，不落盘。
   *   2. **锚点跟着走。** `chapterIndex` 是数组位置，删掉章节就会整体移位。
   *      进度与草稿里的章号必须一起搬，搬的依据是「标题行的字符位置」这个
   *      稳定锚（`titleStartChar`）——它只取决于文件本身，与切分规则无关。
   *   3. **人写的东西不擅自改。** `notes.md` / `background.md` /
   *      `discussions.jsonl` 里有按章号写下的内容，重映射它们是不可逆的编辑。
   *      所以这里不猜：检测到漂移就**拒绝落盘**并列进 `drift`，由调用方决定。
   *
   * @param {string} bookId 书 id
   * @param {{ apply?: boolean }} [options] `apply` 为真才落盘，否则只做预演
   * @returns {object} 预演/执行报告
   */
  function reindex(bookId, options = {}) {
    const apply = options.apply === true
    assertBookId(bookId)
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    const dir = bookDir(bookId)
    const text = readFileSync(resolveInsideRoot(dir, 'content.txt'), 'utf8')
    const parsed = parseChapters(text, { fallbackBlockChars })
    const problems = validateChapters(parsed.chapters, text.length)
    if (problems.length > 0) throw new Error(`CHAPTER_INDEX_INVALID: ${problems.join('; ')}`)
    const next = attachByteOffsets(text, parsed.chapters)

    const previousIndex = chapters(bookId)
    const previous = previousIndex.chapters ?? []
    const changed = previous.length !== next.length
      || previous.some((chapter, i) => next[i] === undefined
        || chapter.title !== next[i].title
        || chapter.startChar !== next[i].startChar
        || chapter.endChar !== next[i].endChar)

    const report = {
      bookId,
      title: meta.title,
      changed,
      before: previous.length,
      after: next.length,
      droppedTitles: [],
      remap: { shifted: false, progress: false, drafts: 0 },
      drift: [],
      warnings: parsed.warnings,
      applied: false,
      backupDir: null,
    }
    if (!changed) return report

    // --- 锚点映射：旧位置 → 新位置 ---
    const byAnchor = new Map()
    for (const chapter of next) byAnchor.set(titleAnchor(chapter), chapter.index)

    const direct = new Array(previous.length).fill(null)
    for (let i = 0; i < previous.length; i += 1) {
      const hit = byAnchor.get(titleAnchor(previous[i]))
      if (hit === undefined) report.droppedTitles.push(previous[i].title)
      else direct[i] = hit
    }

    // 不变量 1：活下来的章节，正文区间必须一模一样。
    for (let i = 0; i < previous.length; i += 1) {
      if (direct[i] === null) continue
      const before = previous[i]
      const after = next[direct[i]]
      if (before.startChar !== after.startChar || before.endChar !== after.endChar) {
        throw new Error(
          `REINDEX_RANGE_DRIFT: 第 ${i} 章「${before.title}」的正文区间会变`
          + `（${before.startChar}-${before.endChar} → ${after.startChar}-${after.endChar}），拒绝落盘`,
        )
      }
    }

    // 被删掉的位置（重复目录行）没有归属章节：顺延到它下面那一章。目录行永远
    // 紧跟在它所重复的真标题之前，所以"下一个存活章节"正是它想指的地方。
    const map = direct.slice()
    let nextKnown = null
    for (let i = map.length - 1; i >= 0; i -= 1) {
      if (map[i] === null) map[i] = nextKnown
      else nextKnown = map[i]
    }
    let previousKnown = null
    for (let i = 0; i < map.length; i += 1) {
      if (map[i] === null) map[i] = previousKnown
      else previousKnown = map[i]
    }
    report.remap.shifted = map.some((value, i) => value !== i)

    // --- 会搬什么，预演也要算出来 ---
    // 预演报告里如果永远写着"草稿重映射 0 条"，那这个字段等于没说。
    const progressRecord = bindingForBook(bookId)?.progress ?? null
    const progressTarget = Number.isInteger(progressRecord?.chapterIndex)
      ? map[progressRecord.chapterIndex]
      : null
    report.remap.progress = Number.isInteger(progressTarget) && progressTarget !== progressRecord.chapterIndex
    const draftTargets = listDrafts(draftsPath, bookId)
      .map((draft) => ({ draft, moved: Number.isInteger(draft.chapterIndex) ? map[draft.chapterIndex] : null }))
      .filter((item) => Number.isInteger(item.moved) && item.moved !== item.draft.chapterIndex)
    report.remap.drafts = draftTargets.length

    // --- 不变量 3：先看人工内容会不会漂 ---
    if (report.remap.shifted) {
      const notesPath = artifactPath(bookId, 'notes.md')
      const anchoredNotes = readNotes(notesPath, meta.title).notes
        .filter((note) => Number.isInteger(note.chapterIndex))
      if (anchoredNotes.length > 0) {
        report.drift.push(`${notesPath} 里有 ${anchoredNotes.length} 条按章记录的笔记（chapter= 与标题行都要重写）`)
      }
      const backgroundDoc = background(bookId)
      if (backgroundDoc.covered !== null && backgroundDoc.covered !== undefined) {
        report.drift.push(`${backgroundPathFor(bookId)} 的背景认识覆盖到第 ${backgroundDoc.covered.last} 章（1 起的可见章号会跟着移位）`)
      }
      const discussionCount = listDiscussions(bookId, 1).length
      if (discussionCount > 0) report.drift.push(`${discussionsPathFor(bookId)} 的讨论时间线按章号记录`)
    }

    if (!apply) return report
    if (report.drift.length > 0) {
      throw new Error(`REINDEX_ANCHOR_DRIFT: ${report.drift.join('；')}`)
    }

    // --- 落盘（先备份） ---
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(storageDir, 'backups', `reindex-${bookId}-${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    for (const [name, source] of [
      ['chapters.json', join(dir, 'chapters.json')],
      ['meta.json', join(dir, 'meta.json')],
      ['library.json', libraryPath],
      ['bindings.json', bindingsPath],
      ['drafts.json', draftsPath],
    ]) {
      if (existsSync(source)) copyFileSync(source, join(backupDir, name))
    }
    report.backupDir = backupDir

    atomicWriteJson(join(dir, 'chapters.json'), {
      schemaVersion: SCHEMA_VERSION,
      strategy: parsed.strategy,
      chapters: next,
      warnings: parsed.warnings,
    })

    // meta.warnings 里混着两段来源：解码（编码回退一类）与切分。切分那一段要整体
    // 换成新的，解码那段原样留着——用旧 chapters.json 的 warnings 做差集即可。
    const oldParserWarnings = new Set(previousIndex.warnings ?? [])
    const nextMeta = {
      ...meta,
      chapterCount: next.length,
      strategy: parsed.strategy,
      warnings: [
        ...(meta.warnings ?? []).filter((warning) => !oldParserWarnings.has(warning)),
        ...parsed.warnings,
      ],
    }
    atomicWriteJson(join(dir, 'meta.json'), nextMeta)

    const { books, revision } = readLibrary()
    writeLibrary(books.map((book) => (book.bookId === bookId ? nextMeta : book)), revision)

    // 进度：直接命中被删位置的章号顺延到下一章，字符偏移不动（区间没变）。
    if (report.remap.progress) {
      mutateBindings((current) => ({
        schemaVersion: SCHEMA_VERSION,
        books: {
          ...current.books,
          [bookId]: {
            ...(current.books[bookId] ?? {}),
            progress: { ...progressRecord, chapterIndex: progressTarget, updatedAt: new Date().toISOString() },
          },
        },
        bySession: current.bySession,
      }))
    }

    // 草稿：按章记录，同样搬。
    for (const item of draftTargets) {
      upsertDraft(draftsPath, { ...item.draft, chapterIndex: item.moved })
    }

    report.applied = true
    logger.info?.(`[reading] 重新切分 ${meta.title}：${previous.length} → ${next.length} 章，合并 ${report.droppedTitles.length} 条目录行`)
    return report
  }

  /**
   * 移除一本书。
   *
   * @param {string} bookId 书 id
   * @param {{ keepNotes?: boolean }} [opts] keepNotes 为真时保留 notes.md 的副本
   * @returns {{ removed: boolean, notesKeptAt?: string }}
   */
  function remove(bookId, opts = {}) {
    assertBookId(bookId)
    const { books, revision } = readLibrary()
    const index = books.findIndex((book) => book.bookId === bookId)
    if (index === -1) return { removed: false }

    let notesKeptAt
    const dir = bookDir(bookId)
    if (opts.keepNotes === true && existsSync(join(dir, 'notes.md'))) {
      // 笔记是用户手写内容，移除书时给一次保留机会。
      notesKeptAt = join(storageDir, `removed-${bookId}-notes.md`)
      copyFileSync(join(dir, 'notes.md'), notesKeptAt)
    }

    rmSync(dir, { recursive: true, force: true })

    const nextBooks = books.filter((book) => book.bookId !== bookId)
    writeLibrary(nextBooks, revision)

    // 绑定关系必须一起清，否则会出现指向不存在书籍的悬垂会话绑定。
    updateJson(bindingsPath, {
      fallback: { schemaVersion: SCHEMA_VERSION, books: {}, bySession: {} },
      mutate: (current) => {
        const state = current ?? { schemaVersion: SCHEMA_VERSION, books: {}, bySession: {} }
        const boundEntry = state.books?.[bookId]
        const bySession = { ...(state.bySession ?? {}) }
        if (boundEntry?.sessionId) delete bySession[boundEntry.sessionId]
        const boundBooks = { ...(state.books ?? {}) }
        delete boundBooks[bookId]
        return { schemaVersion: SCHEMA_VERSION, books: boundBooks, bySession }
      },
    })

    // 分类也要一起清。否则「导入 → 删除」会不断往 `categories.json` 里堆悬垂
    // 条目，而 `listCategories()` 会把它们当成真实存在的分类显示在下拉里——一个
    // 永远分不进去的幽灵分类。
    mutateCategories((state) => {
      const assignments = { ...state.assignments }
      delete assignments[bookId]
      return { ...state, assignments }
    })

    return notesKeptAt === undefined ? { removed: true } : { removed: true, notesKeptAt }
  }

  /**
   * 读一本书的元信息。
   *
   * @param {string} bookId 书 id
   * @returns {object|undefined}
   */
  function get(bookId) {
    assertBookId(bookId)
    return findBook(bookId)
  }

  /**
   * 读章节索引。
   *
   * 先确认书在书架里，再去看文件：否则一本不存在的书会以
   * `CHAPTERS_MISSING`（索引文件缺失）的形式暴露出来，把"没有这本书"
   * 和"这本书的索引坏了"混成同一个错误，HTTP 层也就无从给出正确的状态码。
   *
   * @param {string} bookId 书 id
   * @returns {object}
   */
  function chapters(bookId) {
    assertBookId(bookId)
    if (findBook(bookId) === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const dir = bookDir(bookId)
    const { value } = readJson(join(dir, 'chapters.json'), null)
    if (value === null) throw new Error(`CHAPTERS_MISSING: ${bookId}`)
    return value
  }

  /**
   * 按区间读 `content.txt`。
   *
   * 用 `readSync` 定位读取，不把整本书拉进内存——一本 10MB 的书整本读
   * 会把宿主进程的内存与 GC 压力推高（`dsh-reader` 正是整本进内存 +
   * 整本过 HTTP）。
   *
   * @param {string} bookId 书 id
   * @param {number} startByte 起始字节（含）
   * @param {number} endByte 结束字节（不含）
   * @returns {string} UTF-8 文本
   */
  function readRange(bookId, startByte, endByte) {
    const dir = bookDir(bookId)
    const target = resolveInsideRoot(dir, 'content.txt')
    const length = Math.max(0, endByte - startByte)
    if (length === 0) return ''
    const buffer = Buffer.allocUnsafe(length)
    const fd = openSync(target, 'r')
    try {
      let read = 0
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, startByte + read)
        if (n <= 0) break
        read += n
      }
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  }

  /**
   * 读某一章的正文。
   *
   * @param {string} bookId 书 id
   * @param {number} chapterIndex 章序号
   * @returns {{ index: number, title: string, volume: string|null, kind: string, text: string }}
   */
  function readChapter(bookId, chapterIndex) {
    const index = chapters(bookId)
    const chapter = index.chapters[chapterIndex]
    if (chapter === undefined) throw new Error(`CHAPTER_NOT_FOUND: ${chapterIndex}`)
    return {
      index: chapter.index,
      title: chapter.title,
      volume: chapter.volume ?? null,
      kind: chapter.kind,
      text: readRange(bookId, chapter.startByte, chapter.endByte),
    }
  }

  //#region 分类

  /**
   * 读分类表。
   *
   * 为什么是**独立**的 `categories.json`，而不是塞进 `library.json` 或书的
   * `meta.json`：
   *
   *   - `meta.json` 是**从源文件派生**的客观信息（sha、编码、章数）。分类是用户
   *     的主观归类，混进去会让「重导入时能不能覆盖 meta」变成一个没有干净答案的
   *     问题。
   *   - `library.json` 是书架索引，它的损坏范围应当被限制在"书架列不出来"。
   *   - 独立文件还有一个实际好处：分类**全丢了**也不会伤到书架本身。
   *
   * 结构是 `{ schemaVersion, assignments: { [bookId]: 分类名 } }`。刻意**不维护
   * 分类清单**——分类存在当且仅当至少有一本书属于它。于是不存在"删掉最后一本书
   * 之后还留着一个空分类"这种需要额外清理的状态。
   *
   * @returns {{ assignments: Record<string, string> }}
   */
  function readCategories() {
    const { value } = readJson(categoriesPath, null)
    if (value === null || typeof value !== 'object') return { assignments: {} }
    return { assignments: value.assignments ?? {} }
  }

  /**
   * 以 CAS 方式改分类表。
   *
   * @param {(state: object) => object} mutate 变换函数
   * @returns {object} 新状态
   */
  function mutateCategories(mutate) {
    const result = updateJson(categoriesPath, {
      fallback: { schemaVersion: SCHEMA_VERSION, assignments: {} },
      mutate: (current) => {
        const state = current === null || typeof current !== 'object'
          ? { schemaVersion: SCHEMA_VERSION, assignments: {} }
          : { schemaVersion: SCHEMA_VERSION, assignments: current.assignments ?? {} }
        return mutate(state)
      },
    })
    return result.value
  }

  /**
   * 归一化一个分类名。
   *
   * 空/非字符串/只有空白一律回 `null`，含义是**取消分类**而不是"分到一个叫空
   * 字符串的类"——后者会在界面上变成一个点不中、也删不掉的空分组。
   *
   * @param {unknown} raw 原始分类名
   * @returns {string|null}
   */
  function normalizeCategory(raw) {
    if (typeof raw !== 'string') return null
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    if (cleaned === '') return null
    return cleaned.slice(0, CATEGORY_MAX_CHARS)
  }

  /**
   * 从 assignments 里导出**去重、已排序**的分类名。
   *
   * 排序用 `zh-Hans-CN`：默认的 `localeCompare` 会把中文按码位排，出来的顺序
   * 对中文读者是随机的。
   *
   * @param {Record<string, string>} assignments 分类表
   * @returns {string[]}
   */
  function sortedCategoryNames(assignments) {
    const names = new Set()
    for (const name of Object.values(assignments ?? {})) {
      if (typeof name === 'string' && name !== '') names.add(name)
    }
    return [...names].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
  }

  /**
   * 读一本书的分类。
   *
   * @param {string} bookId 书 id
   * @returns {string|null} 分类名；`null` = 未分类
   */
  function categoryFor(bookId) {
    assertBookId(bookId)
    const name = readCategories().assignments[bookId]
    return typeof name === 'string' && name !== '' ? name : null
  }

  /**
   * 设置（或清除）一本书的分类。
   *
   * 刻意**不校验分类名是否"已存在"**：分类没有清单，用户输入一个新名字就是
   * 创建一个新分类。这是"未分类 → 整理"这条路上最少的仪式感。
   *
   * @param {string} bookId 书 id
   * @param {unknown} category 分类名；空值表示取消分类
   * @returns {{ bookId: string, category: string|null }}
   */
  function setCategory(bookId, category) {
    assertBookId(bookId)
    if (findBook(bookId) === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const name = normalizeCategory(category)
    mutateCategories((state) => {
      const assignments = { ...state.assignments }
      if (name === null) delete assignments[bookId]
      else assignments[bookId] = name
      return { ...state, assignments }
    })
    return { bookId, category: name }
  }

  /**
   * 列出所有用过的分类名（去重、已排序）。
   *
   * @returns {string[]}
   */
  function listCategories() {
    return sortedCategoryNames(readCategories().assignments)
  }

  //#endregion

  //#region 运行期设置

  /**
   * 读运行期设置（`settings.json`）。
   *
   * ## 为什么需要一层文件覆盖
   *
   * `cordis.yml` 里的 `config.webGate` 是**安装时的默认值**——改它要动 YAML
   * 再重启。但"陪读会话能不能联网"是随场景切换的东西（想让你查史料时开、
   * 只想安静看剧情时关），所以需要一层运行期覆盖。
   *
   * 优先级：`settings.json` > `cordis.yml`。
   *
   * ## 为什么没设过是 null
   *
   * 只存用户**显式改过**的字段，没设过就是 `null`（= 跟随配置）。不把默认值抄
   * 进来的原因是：抄进来之后"我改过"和"我没改过"就不可区分了——以后插件调整
   * 默认值时，老用户的库会永远停在旧默认上。
   *
   * ## 这里不做档位合法性校验
   *
   * 合法值清单（`WEB_GATE_MODES`）在宿主侧，这个模块不认识它。校验分两处：
   * 写入路由拒绝非法值；读取时宿主归一化（`effectiveWebGate`）。所以即使有人
   * 手动把文件改成乱码，闸门也只会**回落到配置文件里的值**，不会静默打开。
   *
   * @returns {{ webGate: string|null, path: string }}
   */
  function readSettings() {
    const { value } = readJson(settingsPath, null)
    const source = value !== null && typeof value === 'object' ? value : {}
    return {
      webGate: normalizeSettingText(source.webGate),
      // 导出目录：同样"没设过就是 null"（= 跟随 cordis 配置 / 再回落到会话工作区根）。
      exportDir: normalizeSettingPath(source.exportDir),
      path: settingsPath,
    }
  }

  /**
   * 写运行期设置（部分更新）。
   *
   * `webGate: null` 或空串的含义是**清除覆盖**（回到跟随配置），不是一个叫
   * "null" 的档位。
   *
   * @param {{ webGate?: unknown }} patch 要改的字段
   * @returns {{ webGate: string|null, path: string }}
   */
  function writeSettings(patch) {
    const result = updateJson(settingsPath, {
      fallback: { schemaVersion: SCHEMA_VERSION, webGate: null, exportDir: null },
      mutate: (current) => {
        const state = current === null || typeof current !== 'object'
          ? { schemaVersion: SCHEMA_VERSION, webGate: null, exportDir: null }
          : {
              schemaVersion: SCHEMA_VERSION,
              webGate: normalizeSettingText(current.webGate),
              exportDir: normalizeSettingPath(current.exportDir),
            }
        if (patch !== null && typeof patch === 'object' && 'webGate' in patch) {
          state.webGate = normalizeSettingText(patch.webGate)
        }
        if (patch !== null && typeof patch === 'object' && 'exportDir' in patch) {
          state.exportDir = normalizeSettingPath(patch.exportDir)
        }
        return state
      },
    })
    const written = result.value !== null && typeof result.value === 'object' ? result.value : {}
    return {
      webGate: normalizeSettingText(written.webGate),
      exportDir: normalizeSettingPath(written.exportDir),
      path: settingsPath,
    }
  }

  //#endregion

  //#region 绑定与进度

  /**
   * 读绑定表的原始状态。
   *
   * @returns {object}
   */
  function readBindings() {
    const { value } = readJson(bindingsPath, null)
    if (value === null) return { schemaVersion: SCHEMA_VERSION, books: {}, bySession: {} }
    return {
      schemaVersion: SCHEMA_VERSION,
      books: value.books ?? {},
      bySession: value.bySession ?? {},
    }
  }

  /**
   * 以 CAS 方式改绑定表。
   *
   * @param {(state: object) => object} mutate 变换函数
   * @returns {object} 新状态
   */
  function mutateBindings(mutate) {
    const result = updateJson(bindingsPath, {
      fallback: { schemaVersion: SCHEMA_VERSION, books: {}, bySession: {} },
      mutate: (current) => {
        const state = current === null || typeof current !== 'object'
          ? { schemaVersion: SCHEMA_VERSION, books: {}, bySession: {} }
          : {
              schemaVersion: SCHEMA_VERSION,
              books: current.books ?? {},
              bySession: current.bySession ?? {},
            }
        return mutate(state)
      },
    })
    return result.value
  }

  /**
   * 读一本书的绑定关系。
   *
   * @param {string} bookId 书 id
   * @returns {object|undefined}
   */
  function bindingForBook(bookId) {
    assertBookId(bookId)
    return readBindings().books[bookId]
  }

  /**
   * 反查：一个会话当前绑的是哪本书。
   *
   * 这是防剧透链路的入口——systemPrompt 段与 tools.guard 都靠它判断
   * 「当前这个会话是不是陪读会话」。
   *
   * @param {string} sessionId 会话 id
   * @returns {string|undefined} bookId
   */
  function bookForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const { bySession } = readBindings()
    const direct = bySession[sessionId]
    if (direct !== undefined) return direct
    // 客户端给的 id 与 agent 侧的 id 未必同形（一个带 `session-` 前缀、一个不带）。
    // 先精确命中，再按归一化形态兜底——否则绑定成功但防剧透链路整个看不见。
    const wanted = normalizeSessionId(sessionId)
    if (wanted === '') return undefined
    for (const [key, bookId] of Object.entries(bySession)) {
      if (normalizeSessionId(key) === wanted) return bookId
    }
    return undefined
  }

  /**
   * 绑定书籍与会话。
   *
   * 一本书只允许绑一个会话；一个会话也只允许绑一本书（否则防剧透的
   * 「当前读到哪」就没有唯一答案）。已绑定到别的书时会抛错，由调用方
   * 决定是否先解绑。
   *
   * @param {string} bookId 书 id
   * @param {string} sessionId 会话 id
   * @param {string} [workspaceId] 工作区 id
   * @param {string} [workspaceDir] 工作区绝对路径（客户端解析后上报）
   * @returns {object} 绑定记录
   */
  function bind(bookId, sessionId, workspaceId, workspaceDir) {
    assertBookId(bookId)
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('SESSION_ID_INVALID')
    const state = readBindings()
    const holder = state.bySession[sessionId]
    if (holder !== undefined && holder !== bookId) {
      throw new Error(`SESSION_ALREADY_BOUND: ${sessionId} -> ${holder}`)
    }

    // 工作区路径由客户端解析后上报（宿主侧没有 workspaces 服务）。
    // **无效就保留旧值**：不要因为一次解析失败丢掉用户已经设好的好路径。
    const inspected = inspectWorkspaceDir(workspaceDir)

    const record = {
      ...(state.books[bookId] ?? {}),
      sessionId,
      workspaceId: workspaceId ?? state.books[bookId]?.workspaceId ?? null,
      workspaceDir: inspected.ok ? inspected.path : (state.books[bookId]?.workspaceDir ?? null),
      boundAt: state.books[bookId]?.boundAt ?? new Date().toISOString(),
      progress: state.books[bookId]?.progress ?? null,
    }

    mutateBindings((current) => ({
      schemaVersion: SCHEMA_VERSION,
      books: { ...current.books, [bookId]: record },
      bySession: { ...current.bySession, [sessionId]: bookId },
    }))
    return record
  }

  /**
   * 解除一本书的绑定（进度保留）。
   *
   * @param {string} bookId 书 id
   * @returns {boolean} 是否确实解除了
   */
  function unbind(bookId) {
    assertBookId(bookId)
    const state = readBindings()
    const record = state.books[bookId]
    if (record === undefined) return false

    mutateBindings((current) => {
      const bySession = { ...current.bySession }
      if (record.sessionId) delete bySession[record.sessionId]
      const books = { ...current.books }
      books[bookId] = { ...record, sessionId: null, boundAt: null }
      return { schemaVersion: SCHEMA_VERSION, books, bySession }
    })
    return true
  }

  /**
   * 读进度。
   *
   * @param {string} bookId 书 id
   * @returns {object|null}
   */
  function getProgress(bookId) {
    const record = bindingForBook(bookId)
    return record?.progress ?? null
  }

  /**
   * 写进度。
   *
   * 进度必须**单调不回退地合理**，但允许用户主动往回翻，所以这里只做
   * 合法性校验（章号在范围内、字符偏移非负），不做单调性强制。
   *
   * @param {string} bookId 书 id
   * @param {{ chapterIndex: number, charOffset: number }} progress 进度
   * @returns {object} 落盘后的进度
   */
  function setProgress(bookId, progress) {
    assertBookId(bookId)
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    const chapterIndex = Number(progress?.chapterIndex)
    const charOffset = Number(progress?.charOffset ?? 0)
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('PROGRESS_CHAPTER_INVALID')
    if (!Number.isFinite(charOffset) || charOffset < 0) throw new Error('PROGRESS_OFFSET_INVALID')

    // 章号越界时夹到合法范围，而不是报错：客户端可能拿着过期目录
    // （比如刚重新导入过同一本书），此时丢进度比丢可用性更糟。
    const index = chapters(bookId)
    const maxChapter = Math.max(0, index.chapters.length - 1)
    const clampedChapter = Math.min(chapterIndex, maxChapter)
    const chapter = index.chapters[clampedChapter]
    const maxOffset = chapter === undefined ? 0 : chapter.endChar - chapter.startChar
    const clampedOffset = Math.min(Math.max(0, Math.floor(charOffset)), maxOffset)

    const record = {
      chapterIndex: clampedChapter,
      charOffset: clampedOffset,
      updatedAt: new Date().toISOString(),
    }

    mutateBindings((current) => ({
      schemaVersion: SCHEMA_VERSION,
      books: {
        ...current.books,
        [bookId]: { ...(current.books[bookId] ?? {}), progress: record },
      },
      bySession: current.bySession,
    }))

    return { ...record, clamped: clampedChapter !== chapterIndex || clampedOffset !== charOffset }
  }

  /**
   * 这本书是否已被读者**声明读完**（v1.45）。
   *
   * ⚠️ 语义是"**读者的声明**"，不是我们推断出来的：进度推到最后一章**不等于**读完
   * （跳读、弃书、只看结尾都可能）。所以这里只读那个标记本身，绝不由进度推导。
   *
   * @param {string} bookId 书 id
   * @returns {boolean}
   */
  function isFinished(bookId) {
    const record = bindingForBook(bookId)
    return typeof record?.finishedAt === 'string' && record.finishedAt !== ''
  }

  /**
   * 标记 / 取消「已读完」。
   *
   * 置位写一个时间戳（留痕：什么时候宣布读完的），取消写 `null`。
   * ⚠️ **只影响这一本** —— 判定侧用工具参数里捕获的 bookId 精确匹配（见 `spoiler.js`
   * 的 `deps.isBookFinished`）。
   *
   * @param {string} bookId 书 id
   * @param {boolean} finished 读完为 true
   * @returns {{ finishedAt: string|null }}
   */
  function setFinished(bookId, finished) {
    assertBookId(bookId)
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    const finishedAt = finished === true ? new Date().toISOString() : null
    mutateBindings((current) => ({
      schemaVersion: SCHEMA_VERSION,
      books: {
        ...current.books,
        [bookId]: { ...(current.books[bookId] ?? {}), finishedAt },
      },
      bySession: current.bySession,
    }))

    return { finishedAt }
  }

  //#endregion

  //#region 已读窗口

  /**
   * 上一章默认保留的比例（尾部）。
   *
   * 见 `collectReadWindow` 里那段说明。放在这里而不是散在函数体内，是为了让
   * "60% 这个数"只有一个出处：README、测试与实现引用的是同一个值。
   */
  const PREVIOUS_TAIL_RATIO = 0.6

  /**
   * 收集「陪读 AI 此刻可以看的内容」。
   *
   * 这是防剧透的**正向**一半：所有给模型的书本文字都只能从这里出去。
   *
   * ## 分层（v1.24 修订）
   *
   *   - `current`  当前章**完整**（见下方 `currentChapterMode` 的取舍说明）
   *   - `previous` 上一章的**尾部**（见下方 `previousChapterMode`）
   *   - 更早的章节由**背景认识**代表（`backgroundText`），不逐章给梗概
   *
   * ⚠️ 这里**没有** `earlier` / `earlierText`。v0.5 之前是"每章一条梗概"，
   * 窗口里确实有一个 `earlierText` 字段，注释与 `spoiler.js` 里的渲染分支都是
   * 那个时候留下的。v0.5 把前文换成了一份背景认识，**但这两处没跟着改**：
   * 注释描述了一个不存在的字段，代码里留着一条永远不会走到的分支。v1.24 一并
   * 清掉——一份文档说了算、代码不认账的说明，比没有说明更容易误导。
   *
   * ## 关于 `currentChapterMode`
   *
   * `'full'`（默认）给出整章；`'read-so-far'` 只给到进度光标。
   *
   * 默认取 `'full'` 是因为读者明确要求「完整阅读本章」，而且同一章之内的
   * 前向知识与"第 400 章的结局"完全不是一个量级。但如果就是想保持"严格到
   * 光标"的旧语义，把配置改成 `read-so-far` 即可——那时会退回
   * `headAllowanceChars` 的章首豁免。⚠️ 那个豁免**只在 `read-so-far` 模式下、
   * 且只作用于当前章**：`full` 模式下它完全不参与计算，上一章也不受它影响。
   *
   * ## 关于 `previousChapterMode`
   *
   * `'tail'`（默认）只给上一章的**尾部** `PREVIOUS_TAIL_RATIO`；`'full'` 是旧
   * 行为（整章）。
   *
   * 为什么默认改成尾部：跨章讨论回看的几乎总是**上一章的结尾**（"刚才那句是
   * 什么意思"），而上一章的开头对理解当前这一章几乎没有贡献。整章投喂等于每轮
   * 白带几千字，并且它是 prompt 里第二大的可变块。代价如实说：AI 看不到上一章
   * 的开头——真需要时读者会在自己的消息里带上那一段。
   *
   * @param {string} bookId 书 id
   * @param {object} [options] 预算参数
   * @returns {object} 已读窗口
   */
  function collectReadWindow(bookId, options = {}) {
    const book = findBook(bookId)
    if (book === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    const index = chapters(bookId)
    const all = index.chapters
    const total = all.length
    const progress = getProgress(bookId)

    const currentChapterMode = options.currentChapterMode === 'read-so-far' ? 'read-so-far' : 'full'
    const headAllowanceChars = options.headAllowanceChars ?? 1500
    // 兜底必须与 `lib/index.js` 的配置缺省值同值（v1.26：9000）。两者分叉过一次，
    // 现在有测试专门钉住。
    const backgroundBudgetChars = options.backgroundBudgetChars ?? 9000
    // 降级阶梯的第二级（粗粒度）默认开。`false` 回到 v1.24 的两级降级。
    const backgroundCoarseDegrade = options.backgroundCoarseDegrade !== false

    // 进度缺失时按「第 0 章开头」算 —— 这是最保守的边界。
    const boundaryChapter = progress === null
      ? 0
      : Math.min(Math.max(progress.chapterIndex, 0), Math.max(0, total - 1))
    const boundaryOffset = progress === null ? 0 : Math.max(0, progress.charOffset)

    let current = null
    if (total > 0) {
      const chapter = all[boundaryChapter]
      const full = readChapter(bookId, boundaryChapter)
      if (currentChapterMode === 'full') {
        current = { index: boundaryChapter, title: chapter.title, text: full.text, truncatedBefore: false, mode: 'full' }
      } else {
        const uptoLength = Math.max(boundaryOffset, Math.min(headAllowanceChars, full.text.length))
        current = {
          index: boundaryChapter,
          title: chapter.title,
          text: full.text.slice(0, uptoLength),
          truncatedBefore: false,
          mode: 'read-so-far',
        }
      }
    }

    // 上一章：默认只给**尾部**（见 `previousChapterMode` 的说明）。
    const previousChapterMode = options.previousChapterMode === 'full' ? 'full' : 'tail'
    let previous = null
    if (boundaryChapter > 0) {
      const previousIndex = boundaryChapter - 1
      const full = readChapter(bookId, previousIndex)
      const text = full.text.trim()
      let start = 0
      if (previousChapterMode === 'tail' && text.length > 0) {
        const keep = Math.max(1, Math.floor(text.length * PREVIOUS_TAIL_RATIO))
        // 对齐到**段首**：从一个自然段中间开始的窗口读起来像被截断的残句，
        // 而"上一章结尾"恰恰是最需要读得完整的一段。
        start = alignTailCut(text, text.length - keep)
      }
      previous = {
        index: previousIndex,
        title: full.title,
        text: text.slice(start),
        // ⚠️ 截了就必须说。渲染层原先写死「上一章全文」，截断之后那句话就是假的
        // ——产物不能替我们声称一件没发生的事（§204）。
        truncatedBefore: start > 0,
        mode: previousChapterMode,
      }
    }

    // 更早的章节：由「背景认识」代表。
    //
    // 这是相对早期设计的关键改动：以前是"每章一条梗概"（急切、逐章生成、
    // 一本 300 章的书要 300 次调用），现在是**一份随进度增量丰富的理解**
    // （世界观 / 人物 / 人物关系 / 前文脉络），一次补齐一大段缺口。
    const { doc: backgroundDoc } = readBackground(backgroundPathFor(bookId), book.title)
    // ---- 倒退过滤 ----
    //
    // 读者从目录直接点开第 1000 章、补完记忆之后又回到第 50 章时，`covered`
    // 已经推到 999，而进度是 50。旧实现只在"落后"方向发缺口警告，这一情形
    // **完全静默**：第 900 章的条目原样注入，静默剧透。
    //
    // 判据刻意是"倒退"而不是"有任何超前条目"：过滤会让这一段随进度变化，
    // 而它是缓存里最值钱的稳定前缀。只在真正倒退时付这个代价。
    //
    // ⚠️ 章号基准：`boundaryChapter` 是 **0 起**的索引，而 `covered.last` 是
    // **1 起**的章号。同一件事的两种编号正好差 1，所以读者"正在读"的那一章
    // （1 起）是 `boundaryChapter + 1`。允许背景记到当前章为止——那一章整章
    // 本来就要投喂，不算剧透；再往后才是。
    const readingChapter = boundaryChapter + 1
    const backward = backgroundDoc.covered !== null && backgroundDoc.covered.last > readingChapter
    const backgroundRender = renderBackgroundForPrompt(backgroundDoc, {
      budgetChars: backgroundBudgetChars,
      progressIndex: boundaryChapter,
      coarseDegrade: backgroundCoarseDegrade,
      ...(backward ? { maxChapter: readingChapter } : {}),
    })

    return {
      bookId,
      title: book.title,
      totalChapters: total,
      strategy: index.strategy,
      progress,
      boundary: { chapterIndex: boundaryChapter, charOffset: boundaryOffset },
      current,
      previous,
      backgroundText: backgroundRender.text,
      backgroundChars: backgroundRender.used,
      backgroundCovered: backgroundDoc.covered,
      backgroundOmitted: backgroundRender.omitted,
      // 被节内截断的分区（超预算且还没压缩时才会非空）。面板据此提示用户压缩。
      backgroundTrimmed: backgroundRender.trimmed,
      // 被**降级为粗粒度**的分区（同上，只是降级较轻：主体还在，更早的记载未展开）。
      backgroundCoarsened: backgroundRender.coarsened,
      // 被**倒退过滤**挡住的单元（非空 = 读者跳到了记忆水位线之前）。
      backgroundFiltered: backgroundRender.filtered,
      // 读者是否处于"倒退"状态。面板据此把话说清，而不是只报"过滤了 N 条"。
      backgroundBackward: backward,
      // 缺口：前文里尚未纳入认识的连续区间（1 起章号）。
      memoryGap: backgroundGap(backgroundDoc.covered, boundaryChapter),
      // 书友设定与讨论时间线都属于"动态区"，但它们各自只在自己那一份变化时变。
      ...(function () {
        const records = readDiscussions(discussionsPathFor(bookId))
        return {
          persona: persona(bookId),
          discussions: recentDiscussions(records, options.discussionLimit ?? 8),
          lastDiscussionAt: lastOf(records),
        }
      })(),
    }
  }

  //#endregion

  //#region 背景认识

  //#region 陪读文件夹落点

  /**
   * 解析某本书「人可读产物」的落地目录。
   *
   * 优先落在**绑定会话的工作区**下（`<workspace>/陪读_<书名>/`）；拿不到工作区
   * 时回落到插件自己的 `books/<bookId>/`。
   *
   * **为什么回落而不是报错**：笔记是用户亲手写的东西。宁可落在一个不那么理想
   * 的位置，也绝不能因为"工作区路径没解析出来"而让笔记写不进去。
   *
   * **为什么只有两个文件搬过去**：`source.txt` / `content.txt` / `chapters.json`
   * 是 MB 级（本机实测一本 14 MB），把用户的工作区当仓库使是冒犯；而且它们是
   * 可从原书重建的派生数据。搬过去的只有 `notes.md` 与 `background.md` ——
   * 用户要读、要改、要提交的那两份。
   *
   * @param {string} bookId 书 id
   * @returns {{ dir: string, scope: 'workspace'|'plugin', workspaceDir: string|null, reason: string|null }}
   */
  function companionDir(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    const fallback = { dir: bookDir(bookId), scope: 'plugin', workspaceDir: null, reason: null }

    const record = bindingForBook(bookId)
    const workspaceDir = record?.workspaceDir
    if (typeof workspaceDir !== 'string' || workspaceDir === '') return fallback

    const inspected = inspectWorkspaceDir(workspaceDir)
    if (!inspected.ok) return { ...fallback, reason: inspected.reason }

    const baseName = `${COMPANION_DIR_PREFIX}${sanitizeFolderName(meta.title, bookId)}`
    const markerAt = (folder) => join(inspected.path, folder, COMPANION_MARKER)

    // 撞名消歧：同一个工作区里两本**不同**的书如果书名相同（同一部书的两个
    // 版本、或名字都叫「未命名」），绝不能共用文件夹——那正是用户担心的事。
    let folder = baseName
    if (existsSync(markerAt(folder))) {
      const { value } = readJson(markerAt(folder), null)
      if (typeof value?.bookId === 'string' && value.bookId !== bookId) {
        folder = `${baseName}_${bookId.slice(0, 6)}`
      }
    }

    return { dir: join(inspected.path, folder), scope: 'workspace', workspaceDir: inspected.path, reason: null }
  }

  /**
   * 确保陪读文件夹存在（认领标记 + 老数据迁移 + 说明文件）。
   *
   * 迁移是**复制**而不是移动：老位置留作安全网，用户确认无误后自己删即可。
   * 迁移失败不抛错——它不该阻断"把笔记写进去"这件正事。
   *
   * @param {string} bookId 书 id
   * @returns {{ dir: string, scope: string, workspaceDir: string|null, reason: string|null, migrated: string[] }}
   */
  function ensureCompanionDir(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    const location = companionDir(bookId)
    mkdirSync(location.dir, { recursive: true })

    const markerPath = join(location.dir, COMPANION_MARKER)
    if (!existsSync(markerPath)) {
      atomicWriteJson(markerPath, {
        schemaVersion: SCHEMA_VERSION,
        bookId,
        title: meta.title,
        createdBy: 'dsh-reading-companion',
      })
    }

    const migrated = []
    if (location.scope === 'workspace') {
      const legacy = bookDir(bookId)
      for (const name of ['notes.md', 'background.md', 'persona.md']) {
        const target = join(location.dir, name)
        const source = join(legacy, name)
        if (!existsSync(target) && existsSync(source)) {
          try {
            copyFileSync(source, target)
            migrated.push(name)
          } catch {
            /* 迁移失败不该阻断写入 */
          }
        }
      }
      // 历代背景备份也要跟着走。它们是**带时间戳的多个文件**，不在上面那份固定
      // 名单里，所以单独扫一遍 —— 否则落点一变（工作区 ↔ 插件目录），历代快照就
      // 留在了插件目录里，而它们正是"压缩前的完整认识"唯一的载体。
      try {
        for (const name of readdirSync(legacy)) {
          if (!/^background\.bak.*\.md$/.test(name)) continue
          const target = join(location.dir, name)
          if (existsSync(target)) continue
          try {
            copyFileSync(join(legacy, name), target)
            migrated.push(name)
          } catch {
            /* 同上：迁移失败不该阻断写入 */
          }
        }
      } catch {
        /* legacy 目录不可读就跳过 */
      }

      const readme = join(location.dir, 'README.md')
      if (!existsSync(readme)) {
        try {
          atomicWriteText(readme, COMPANION_README)
        } catch {
          /* 说明文件写不上不算错误 */
        }
      }
    }

    return { ...location, migrated }
  }

  /**
   * 设置（或清除）某本书的陪读文件夹位置。
   *
   * @param {string} bookId 书 id
   * @param {string|null} workspaceDir 工作区绝对路径；null / 空串 = 回到插件目录
   * @returns {object} 落定后的位置信息
   */
  function setCompanionDir(bookId, workspaceDir) {
    assertBookId(bookId)
    if (findBook(bookId) === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    let next = null
    if (workspaceDir !== null && workspaceDir !== undefined && workspaceDir !== '') {
      const inspected = inspectWorkspaceDir(workspaceDir)
      // 与 bind 不同，这里**显式报错**：用户是主动指定位置，
      // 静默忽略会让他以为设置成功了。
      if (!inspected.ok) throw new Error(`WORKSPACE_DIR_INVALID: ${inspected.reason}`)
      next = inspected.path
    }

    mutateBindings((current) => ({
      schemaVersion: SCHEMA_VERSION,
      books: {
        ...current.books,
        [bookId]: { ...(current.books[bookId] ?? {}), workspaceDir: next },
      },
      bySession: current.bySession,
    }))

    return ensureCompanionDir(bookId)
  }

  /**
   * 当前落点信息（面板显示用）。
   *
   * `fallbackReason` 是刻意暴露的：让「为什么没落在工作区」是一个**可回答的
   * 问题**，而不是黑盒。否则用户只会看到笔记莫名其妙在别处。
   *
   * @param {string} bookId 书 id
   * @returns {object}
   */
  function location(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const info = companionDir(bookId)
    return {
      bookId,
      scope: info.scope,
      workspaceDir: info.workspaceDir,
      folderName: basename(info.dir),
      dir: info.dir,
      notesPath: join(info.dir, 'notes.md'),
      backgroundPath: join(info.dir, 'background.md'),
      personaPath: join(info.dir, 'persona.md'),
      fallbackReason: info.reason,
      boundSessionId: bindingForBook(bookId)?.sessionId ?? null,
    }
  }

  /**
   * 解析某本书内部制品的路径（含存在性校验）。
   *
   * ⚠️ 这是**唯一的收口**：`notes.md` 与 `background.md` 都从这里取路径，
   * 所以落点策略只在这一个地方生效，不存在"改了一处漏了另一处"。
   *
   * ⚠️ 它**有副作用**（建目录、写认领标记、迁移老文件），这是刻意的：
   *   1. 撞名消歧**依赖认领标记**——如果只走"纯解析"，两本同名的书会算出
   *      同一个文件夹，而标记永远不会被写下来（这正是第一版的 bug：
   *      `notes.md` 由 `atomicWriteText` 顺手建了目录，标记却没写，
   *      于是第二本同名书根本检测不到撞名）；
   *   2. 在读路径上也迁移，用户打开笔记页就能在工作区里看到自己的笔记，
   *      而不是"必须点一下迁移按钮"。
   *
   * @param {string} bookId 书 id
   * @param {string} name 制品文件名
   * @returns {string} 绝对路径
   */
  function artifactPath(bookId, name) {
    assertBookId(bookId)
    if (findBook(bookId) === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    return resolveInsideRoot(ensureCompanionDir(bookId).dir, name)
  }

  /**
   * `background.md` 的路径。
   *
   * @param {string} bookId 书 id
   * @returns {string} 绝对路径
   */
  function backgroundPathFor(bookId) {
    return artifactPath(bookId, 'background.md')
  }

  /**
   * 读一本书的背景认识。
   *
   * @param {string} bookId 书 id
   * @returns {{ covered: object|null, updated: string|null, sections: object, characters: object, markdown: string, exists: boolean }}
   */
  function background(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const { doc, markdown, exists } = readBackground(backgroundPathFor(bookId), meta.title)
    return { ...doc, markdown, exists }
  }

  /**
   * 备份名里那段时间戳：**本地时间**、`yyyyMMdd-HHmmss`，按名字排序即时间线。
   *
   * 与仓库既有的备份命名一致（`edge-bookmarks-backup-20260924-174404` 那套）。
   *
   * @param {Date} [date]
   * @returns {string}
   */
  function backupStamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
      + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  }

  /** 备份文件名：`background.bak.<时间戳>.md`，以及**遗留的单槽** `background.bak.md`。 */
  const BACKUP_NAME_RE = /^background\.bak(?:\.(\d{8}-\d{6}(?:-\d+)?))?\.md$/

  /**
   * 把当前 `background.md` 备份成**一代**。
   *
   * ## 为什么不再是单槽的 `background.bak.md`
   *
   * 单槽意味着**每次压缩都把上一代覆盖掉**。而压缩是唯一会删内容的一步，那份认识
   * 的价值又超出"喂给 AI"——读完一本书要梳理角色经历、时间线、走过的地方，全靠它。
   * 更要紧的是：压缩后活下来的 `background.md` 就是**下一次压缩的"压缩前"**，所以
   * 压第二次之后，单槽里剩下的已经是压缩过的产物，"压缩前 = 完整信息"就不再成立。
   * 改成**一代一个文件、一份不删**，历代的并集才真的把细节留住。
   *
   * ## 为什么必须有同秒去重
   *
   * 一次补齐是"先压缩再合并"，两处都会写备份，**可能落在同一秒**。不去重的话
   * 第二代会把第一代盖掉——丢的恰好是覆盖更全的那一份。所以撞名就加 `-2`、`-3`。
   *
   * ## 它不引入新的剧透面
   *
   * 历代备份覆盖的章节范围只会**等于或窄于**当前 `background.md`（它是更早的状态），
   * 而当前那份本来就已经在读者的文件夹里、本来就能被 `read` 读到。所以这里没有
   * 多出任何"模型不该看到的东西"。它们也**永不进 prompt**。
   *
   * @param {string} bookId
   * @returns {string|null} 备份落点；源文件不存在时回 null（不造空备份）
   */
  function backupBackground(bookId) {
    const source = backgroundPathFor(bookId)
    if (!existsSync(source)) return null
    const dir = ensureCompanionDir(bookId).dir
    const stamp = backupStamp()
    let name = `background.bak.${stamp}.md`
    let seq = 1
    while (existsSync(join(dir, name))) {
      seq += 1
      name = `background.bak.${stamp}-${seq}.md`
    }
    const target = resolveInsideRoot(dir, name)
    copyFileSync(source, target)
    return target
  }

  /**
   * 列出这本书的历代背景备份（按时间升序）。
   *
   * 遗留的单槽 `background.bak.md` 也在结果里：它没有时间戳，用**文件 mtime** 兜底
   * 补一个，这样导出时的目标名不会缺一段。**不改名、不删除** —— 它是用户的文件，
   * 插件没有理由动它（旧文件留在原地，新的一代用新名字，两边共存）。
   *
   * @param {string} bookId
   * @returns {Array<{ name: string, path: string, stamp: string, legacy: boolean, bytes: number }>}
   */
  function listBackgroundBackups(bookId) {
    if (findBook(bookId) === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const dir = ensureCompanionDir(bookId).dir
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const found = []
    for (const name of names) {
      const matched = BACKUP_NAME_RE.exec(name)
      if (matched === null) continue
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      found.push({
        name,
        path: full,
        stamp: matched[1] ?? backupStamp(stat.mtime),
        legacy: matched[1] === undefined,
        bytes: stat.size,
      })
    }
    found.sort((left, right) => (left.stamp < right.stamp ? -1 : left.stamp > right.stamp ? 1 : 0))
    return found
  }

  /**
   * 合并一批新认识进去（**只追加、去重、从不删除**）。
   *
   * ## `options.base`：把"压缩 + 合并"并成**一次落盘**
   *
   * 补齐流程里压缩排在合并之前（先压小，合并提示词才装得下现有认识）。但压缩是
   * **唯一会删掉内容**的一步，而合并是**会失败**的一步。写两次就有这个洞：压缩
   * 已经落盘（内容真少了），合并失败（缺口还在）——净损失，且没有任何进展换来它。
   *
   * `base` 让调用方把手上那份（可能是压缩后的）文档直接当底，于是两者共用**一次**
   * 写入：合并成功，压缩与合并结果一起生效；合并失败，**什么都没写**，压缩下轮重来。
   * 不传 `base` 时行为与从前完全一致（重新读盘）。
   *
   * @param {string} bookId 书 id
   * @param {object} incoming 新的解析结果（来自模型输出，见 background.js）
   * @param {{ first: number, last: number }} range 本批覆盖的章号（1 起，闭区间）
   * @param {object} [options]
   * @param {object} [options.base] 合并的底稿；不给则重新读盘
   * @param {boolean} [options.backup] 落盘前是否把原文件备份成**一代**（带时间戳、
   *   一份不删，见 `backupBackground`）。只有当这次写入**连带**了一次压缩
   *   （会删内容）时才该为 `true`。
   * @returns {object} 落盘后的结果（含 `backupPath`）
   */
  function backgroundMerge(bookId, incoming, range, options = {}) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const path = backgroundPathFor(bookId)
    const base = options.base ?? readBackground(path, meta.title).doc
    const merged = mergeBackground(base, incoming, range)

    // 只有确实存在旧文件时才备份；否则会造出一个空备份，反而让人困惑。
    let backupPath = null
    if (options.backup === true) {
      try {
        // 备份成**一代**（带时间戳、一份不删），见 backupBackground 的说明。
        backupPath = backupBackground(bookId)
      } catch {
        // 备份失败不该阻断写入——但要让调用方知道没留后路。
        backupPath = null
      }
    }

    writeBackground(path, merged, meta.title)
    return { ...merged, backupPath }
  }

  /**
   * 写入一批「背景更新」（T1-②）：陪读 AI 或读者顺手带回的修正。
   *
   * ## 与 {@link backgroundMerge} 的两点不同
   *
   * 1. **不动覆盖区间**（`extendCoverage: false`）。一条修正是"这句话说错了"，
   *    不是"这些章补过了"。若照常取并集，一条关于第 30 章的修正会让文件声称
   *    `covered=1..30`，真正的第 1–29 章缺口就此**静默消失**。
   * 2. **取代是逐条指定的**，不是整份重写。`supersedes` 命中的旧条目搬进
   *    「已取代」归档，没命中的记进 `lastMerge.unmatched`——调用方必须能看到
   *    它，否则模型写错旧说法时，它会以为修正已经生效。
   *
   * @param {string} bookId 书 id
   * @param {object[]} updates 已校验的更新（见 background-update.js）
   * @param {object} [options]
   * @param {number} [options.progressIndex] 读者当前章（0 起），仅用于落款
   * @returns {object} 落盘后的结果（含 `lastMerge`）
   */
  function backgroundApplyUpdates(bookId, updates, options = {}) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const path = backgroundPathFor(bookId)
    const { doc } = readBackground(path, meta.title)

    const last = maxUpdateChapter(updates)
    const fallback = Number.isInteger(options.progressIndex) ? options.progressIndex + 1 : last
    const merged = mergeBackground(
      doc,
      updatesToIncomingDoc(updates),
      // `range` 只用于「已于第 N 章被取代」的落款——区间本身按上面的理由不动。
      { first: 1, last: last > 0 ? last : fallback },
      undefined,
      { supersedes: supersedesList(updates), extendCoverage: false },
    )
    writeBackground(path, merged, meta.title)
    return merged
  }

  /**
   *
   * 刻意做成显式动作而不是自动行为：清空是不可逆的，只有用户自己点才做。
   *
   * @param {string} bookId 书 id
   * @returns {object} 清空后的结果
   */
  function backgroundReset(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const path = backgroundPathFor(bookId)
    const empty = mergeBackground(parseBackground(''), parseBackground(''), { first: 1, last: 0 })
    // mergeBackground 会把区间收敛成 {1,0}（即空），这里显式还原成"没有区间"。
    writeBackground(path, { ...empty, covered: null, updated: null }, meta.title)
    return { ...empty, covered: null, updated: null }
  }

  /**
   * 背景认识的 Markdown 原文（面板直接显示/编辑用）。
   *
   * @param {string} bookId 书 id
   * @returns {string}
   */
  function backgroundMarkdown(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const { markdown } = readBackground(backgroundPathFor(bookId), meta.title)
    return markdown
  }

  /**
   * 用压缩后的版本替换背景认识。
   *
   * ## 这是「只增不减」的唯一例外
   *
   * 所以它做两件额外的事：
   *   1. 落盘前把原文件复制成 `background.bak.md`——压缩是唯一步骤会**删掉**
   *      用户可见内容，留个后路；
   *   2. 只接受调用方**已经校验过**的结果（保名 / 保号 / 真的变小，见
   *      `compact.js` 的 `validateCompaction`）。这里不再重复校验，但也不
   *      允许任何未经校验的路径走到这个函数。
   *
   * @param {string} bookId 书 id
   * @param {object} doc 校验通过的压缩结果
   * @returns {{ markdown: string, backupPath: string|null }}
   */
  function backgroundCompact(bookId, doc) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const path = backgroundPathFor(bookId)

    // 只有确实存在旧文件时才备份；否则会造出一个空备份，反而让人困惑。
    let backupPath = null
    try {
      backupPath = backupBackground(bookId)
    } catch {
      // 备份失败不该阻断压缩本身——但要让调用方知道没留后路。
      backupPath = null
    }

    const markdown = writeBackground(path, doc, meta.title)
    return { markdown, backupPath }
  }

  //#endregion

  //#region 导出

  /**
   * 把这本书的可读产物导出到目标目录。
   *
   * 语义、命名与拒绝规则都在 `host/export.js` 的文件头；这里只负责**取源**：
   * 当前笔记的全文、当前背景认识的原始字节、以及历代备份的原始字节。
   *
   * ⚠️ 源文件**一个字节都不改**（导出是纯加法），所以老数据不需要任何迁移 ——
   * 这正是选"只加导出动作"而不是"改内建文件名"的理由。
   *
   * @param {string} bookId
   * @param {object} options
   * @param {string} options.dir 导出目录（绝对路径）
   * @param {string} [options.now] ISO 时间（注入以便可测）
   * @returns {{ dir: string, files: object[], notes: object, warnings: string[] }}
   */
  function exportBook(bookId, options = {}) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    const dir = typeof options.dir === 'string' ? options.dir.trim() : ''
    if (dir === '') throw new Error('EXPORT_DIR_REQUIRED')
    if (!isAbsolute(dir)) throw new Error('EXPORT_DIR_NOT_ABSOLUTE')

    // ⚠️ 回收站里的笔记**不导出**（v1.55）。这里不改 export 那边的逻辑，而是把回收站
    // 那几个块**从全文里抠掉**再交给它 —— 用的正是 `removeNotes` 这个纯函数，
    // 于是"导出跳过回收站"和"彻底删除"共享同一段删块代码，不会有两套实现。
    const rawNotes = readTextIfExists(artifactPath(bookId, 'notes.md'))
    const trashedIds = trashedNoteIds(bookId)
    const notesSource = rawNotes === null || trashedIds.length === 0
      ? rawNotes
      : removeNotes(rawNotes, trashedIds).markdown
    const backgroundSource = readBytesIfExists(backgroundPathFor(bookId))
    const backups = listBackgroundBackups(bookId)
      .map((item) => ({ stamp: item.stamp, bytes: readBytesIfExists(item.path) }))
      .filter((item) => Buffer.isBuffer(item.bytes))

    return runExport({
      bookId,
      // 书名要先清洗才能当文件名：它来自用户导入的文件名，完全可能叫
      // `../../evil`，也可能带 Windows 非法字符（同 sanitizeFolderName 的理由）。
      title: sanitizeFolderName(meta.title),
      targetDir: dir,
      notesMarkdown: notesSource,
      backgroundBytes: backgroundSource,
      backups,
      now: options.now,
    })
  }

  //#endregion

  //#region 书友设定

  /**
   * `persona.md` 的路径。
   *
   * 与 `notes.md` / `background.md` 走**同一条**落点策略（`artifactPath`），
   * 所以它也在陪读文件夹里、也会跟着绑定会话的工作区走、也会被迁移。
   * 这很重要：它是**人可读、人会想改**的东西，放在插件目录里就别指望有人找得到。
   *
   * @param {string} bookId 书 id
   * @returns {string} 绝对路径
   */
  function personaPathFor(bookId) {
    return artifactPath(bookId, 'persona.md')
  }

  /**
   * 读书友设定。文件不存在时回空串（= 没有设定，不产出任何段落）。
   *
   * @param {string} bookId 书 id
   * @returns {string}
   */
  function persona(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    try {
      return readFileSync(personaPathFor(bookId), 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * 写书友设定。
   *
   * 上限 4000 字：它进的是**稳定前缀**，必须短到不挤占背景认识的预算。
   * 超限**报错而不是静默截断**——用户的设定被悄悄砍掉一截，比拒绝保存更糟。
   *
   * @param {string} bookId 书 id
   * @param {unknown} text 设定原文
   * @returns {{ text: string, chars: number }}
   */
  function setPersona(bookId, text) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const body = typeof text === 'string' ? text : ''
    if (body.length > PERSONA_MAX_CHARS) throw new Error(`PERSONA_TOO_LONG: ${body.length}`)
    atomicWriteText(personaPathFor(bookId), body)
    return { text: body, chars: body.length }
  }

  //#endregion

  //#region 讨论历史

  /**
   * `discussions.jsonl` 的路径。
   *
   * ⚠️ 刻意**不**走 `artifactPath`：它是机器数据，按既定约定留在插件目录里，
   * 不该占用用户的工作区。
   *
   * @param {string} bookId 书 id
   * @returns {string} 绝对路径
   */
  function discussionsPathFor(bookId) {
    assertBookId(bookId)
    return resolveInsideRoot(bookDir(bookId), 'discussions.jsonl')
  }

  /**
   * 记录一条讨论。
   *
   * @param {string} bookId 书 id
   * @param {object} input 原始输入（见 `discussions.js` 的 normalizeDiscussion）
   * @returns {object|null} 落盘后的那条；输入无意义时 null
   */
  function recordDiscussion(bookId, input) {
    // ⚠️ 先验形态再查存在性。bookId 会参与拼路径，形态必须先证明它是我们自己
    // 生成的十六进制串；顺序反了的话非法 id 会以 BOOK_NOT_FOUND 溜出去，
    // 掩盖掉"这根本不是一个合法 id"这个更重要的事实。
    assertBookId(bookId)
    if (findBook(bookId) === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const record = normalizeDiscussion(input)
    if (record === null) return null
    appendDiscussion(discussionsPathFor(bookId), record)
    return record
  }

  /**
   * 读讨论历史（新在前）。
   *
   * @param {string} bookId 书 id
   * @param {number} [limit] 条数
   * @returns {object[]}
   */
  function listDiscussions(bookId, limit = 20) {
    assertBookId(bookId)
    if (findBook(bookId) === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    return recentDiscussions(readDiscussions(discussionsPathFor(bookId)), limit)
  }

  /**
   * 读讨论历史的一页，**同时给出总条数**。
   *
   * 存在的理由：面板只显示最近几条，而"被截断了"必须是**可见的**——否则
   * 读者会以为历史就这么多，把那几条当成了全部。
   *
   * 总数和这一页刻意来自**同一次读取**。分两次读的话，中间又追加了一条就会
   * 出现「共 3 条，以下是最新 5 条」这种自相矛盾的输出。
   *
   * @param {string} bookId 书 id
   * @param {number} [limit] 条数
   * @returns {{ items: object[], total: number }} `items` 新在前
   */
  function discussionPage(bookId, limit = 20) {
    assertBookId(bookId)
    if (findBook(bookId) === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const all = readDiscussions(discussionsPathFor(bookId))
    return { items: recentDiscussions(all, limit), total: all.length }
  }

  //#endregion

  //#region 抽样

  /**
   * 抽样一批章节，作为生成/更新背景认识的原料。
   *
   * ## 为什么要抽样而不是给全文
   *
   * 一段 200 章的缺口，全文可能有 2MB。全塞进一次子代理调用既贵又没必要——
   * 我们要的是"这一章发生了什么"，不是逐字复现。
   *
   * ## 抽样形状
   *
   * 每章取**头 + 尾**而不是只取头：长章的开头多半是场景与对话，情节推进
   * 往往压在章末。只取头会得到一堆"他走进屋子"，取尾才能抓到"于是他明白了
   * 那个人是谁"。中间用 `（中略）` 明确标出被跳过，免得模型以为文本是连贯的。
   *
   * ## 预算与分片
   *
   * 预算不够覆盖整个区间时，**从前往后**覆盖能覆盖的部分（`partial: true`），
   * 剩余留给下一次补齐。往前的方向是刻意的：背景认识的作用是"打底"，
   * 而最近的内容已经由阅读窗口全文投喂了。
   *
   * ## 加权
   *
   * 抽样**不是均匀的**：重点章拿到 `emphasisFactor` 倍的字数。理由是读者实测的
   * 感受——均匀抽样 240 章各 100 字（约两句半）得到的是"覆盖极广、深度为零"的
   * 认识，从里面看不出任何一个人的性格；而一本书的开头恰好是世界观与人物的
   * 密集区，值得读厚。
   *
   * ⚠️ 判据必须**全部是绝对的**（"这本书里的某个固定位置"），不能是"本批的前几
   * 章"。否则第二批（比如第 51 章起）又会把它自己的头 5 章当成重点，而那 5 章
   * 并不特殊。目前有两个判据：
   *
   *   1. 全书开头的 `emphasisChapters` 章（§105 的老规矩）；
   *   2. **卷首章**——`volume` 与前一章不同的那一章。这是 §105 那条思路的推广：
   *      卷首同样是人物与设定的密集区，而"哪几章是卷首"是书自己的属性，与这一批
   *      从哪开始无关。没有卷标记的书一条都不受影响。
   *
   * 代价要如实说：加权会让同一批预算能覆盖的章数变少（权重总和 = 章数 + 额外
   * 权重），因为重点章多吃的那部分是从总预算里出的。
   *
   * ## 额度从哪里来（v1.25 起默认**按预算均分**）
   *
   * 均分（默认，`lengthRatio: 0`）：`u = clamp(预算 ÷ 权重和, minPerChapter,
   * maxPerChapter)`——每章拿到同样一份基准额度。
   *
   * 按章长比例（`lengthRatio > 0`，**可选**）：`u_i = clamp(lengthRatio × 章长,
   * minPerChapter, maxPerChapter)`，再乘它的权重。两种形状各有专测。
   *
   * ⚠️ **v1.24 曾把比例设为默认，v1.25 按读者要求回退到均分。** 理由只有一条，
   * 但它足够硬：**短章在比例模式下被截得比从前狠**——一章 200 字的短章只拿得到
   * 下限那一小段，而均分模式下它整章都装得下。读者读的不只是长篇，短章（笔记体、
   * 段子、诗歌、公文体）是他的真实用法。§197 记的那笔"两个轴反向"仍然成立，
   * 它是按比例那条路的**动机**；但动机不足以抵掉这个副作用，所以那条路降级为选项。
   *
   * ⚠️ 章长取自**索引里的字符偏移**（`startChar` / `endChar`），不读正文：缺口
   * 可能有上千章，而"这一章多长"在导入时就量好了。它量的是**原始**章长（含标题
   * 与章末附言），与实际切片时用的清洁后长度差几个百分点——对一个用来分配预算
   * 的比例来说，这个误差无关紧要，但要知道它在。只有比例模式读它。
   *
   * ## 首次批次（打底）
   *
   * `options.foundation === true` 时本批最多包含 `foundationChapters` 章。
   * 读者读到第 300 章才第一次补齐时，与其把 24000 字平摊成 240 章，不如先把
   * 开头读厚，剩下的留到第二次——两次就补完，第一次深、第二次全。
   *
   * @param {string} bookId 书 id
   * @param {number} fromIndex 起始章（0 起，含）
   * @param {number} toIndex 结束章（0 起，含）
   * @param {object} [options]
   * @param {number} [options.budgetChars] 样本总字数预算
   * @param {number} [options.minPerChapter] 每章下限（均分模式下是均分额度的封底）
   * @param {number} [options.maxPerChapter] 每章上限（**基准**；重点章可达它的 `emphasisFactor` 倍）
   * @param {number} [options.lengthRatio] 基准额度占章长的比例；**默认 `0` = 按预算均分**
   * @param {boolean} [options.foundation] 是否按"首次批次"处理
   * @param {number} [options.foundationChapters] 首次批次的章数上限
   * @param {number} [options.emphasisChapters] 全书开头的重点章数
   * @param {number} [options.emphasisFactor] 重点章的加权倍数
   * @returns {{ from: number, to: number, requestedTo: number, partial: boolean,
   *             perChapter: number, totalChars: number, foundation: boolean,
   *             emphasisChapters: number, emphasisFactor: number, lengthRatio: number,
   *             chapters: object[] }}
   */
  function sampleChapters(bookId, fromIndex, toIndex, options = {}) {
    const all = chapters(bookId).chapters
    const from = Math.max(0, Math.floor(fromIndex))
    const to = Math.min(all.length - 1, Math.floor(toIndex))
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
      return {
        from,
        to,
        requestedTo: to,
        partial: false,
        perChapter: 0,
        totalChars: 0,
        foundation: false,
        emphasisChapters: 0,
        emphasisFactor: 1,
        lengthRatio: 0,
        chapters: [],
      }
    }

    const budgetChars = options.budgetChars ?? 24000
    // 下限默认 **600**（v1.67，读者选定走"温和"档；v2.0.2 曾是 150、v1.25 曾是 100）。
    // 它同时决定"一批最多吃多少章"（`budgetChars ÷ minPerChapter`）—— 600 对应约 40 章。
    // ⚠️ 它**不能高过 `maxPerChapter`**：限额是 `min(max, max(min, 预算÷权重和))`，
    // 下限高过上限时 `unit` 恒等于上限，"每章至少 N 字"就成了假话。
    // ⚠️ 这个数必须与 `lib/index.js` 的 `DEFAULTS.sample.minPerChapter` 同值 ——
    // 两处写同一份默认值是这一仓库反复出现的形状，`sampling.test.mjs` 有一条断言
    // 专门钉住"库侧兜底 == 配置缺省"，改一处忘一处会当场变红。
    const minPerChapter = options.minPerChapter ?? 600
    const maxPerChapter = options.maxPerChapter ?? 1200
    const foundationChapters = Number.isInteger(options.foundationChapters) && options.foundationChapters > 0
      ? options.foundationChapters
      : 30
    const emphasisChapters = Number.isInteger(options.emphasisChapters) && options.emphasisChapters > 0
      ? options.emphasisChapters
      : 5
    // `emphasisFactor: 1` 是合法的，含义是**均匀抽样**（等价于关掉加权）。
    const emphasisFactor = Number.isInteger(options.emphasisFactor) && options.emphasisFactor >= 1
      ? options.emphasisFactor
      : 3
    // `lengthRatio: 0` 是**默认**，含义是**按预算均分**（见上方「额度从哪里来」）。
    // v1.24 曾默认 `0.2`，v1.25 按读者要求回退——短章在比例模式下被截得比从前狠。
    const lengthRatio = Number.isFinite(options.lengthRatio) && options.lengthRatio >= 0
      ? options.lengthRatio
      : 0

    /** 某章在**本批里**是不是重点。两个判据都是绝对的（见上方「加权」）。 */
    const emphasized = (index) => {
      if (index < emphasisChapters) return true
      const volume = all[index]?.volume
      if (volume === null || volume === undefined || volume === '') return false
      return all[index - 1]?.volume !== volume
    }

    /** 某章的权重，见上方「加权」。 */
    const weightOf = (index) => (emphasized(index) ? emphasisFactor : 1)

    /** 章长：用索引里的字符偏移，**不读正文**（缺口可能有上千章）。 */
    const chapterLength = (index) => {
      const meta = all[index]
      if (meta === undefined) return 0
      return Math.max(0, (meta.endChar ?? 0) - (meta.startChar ?? 0))
    }

    /** 比例模式下某章的基准额度（还没乘权重）。 */
    const quotaOf = (index) => {
      const raw = Math.floor(chapterLength(index) * lengthRatio)
      return Math.min(maxPerChapter, Math.max(minPerChapter, raw))
    }

    // ---- 第一刀：本批最多包含多少章 ----
    let reach = to
    if (options.foundation === true) {
      reach = Math.min(reach, from + foundationChapters - 1)
    }

    // ---- 第二刀：预算装不下时，从**后往前**丢章 ----
    //
    // 两种形状共用这一把刀，只是"一章要多少"的算法不同：
    //   - 均分（`lengthRatio === 0`）：先假定每章只吃下限，反解出能装几章；
    //   - 比例：逐章算出它自己的额度再累加。
    // 两者都只做整数运算——比例模式**不必读正文**，章长就在索引里。
    let unit = 0
    if (lengthRatio === 0) {
      let totalWeight = 0
      for (let index = from; index <= reach; index += 1) totalWeight += weightOf(index)
      while (reach > from && totalWeight * minPerChapter > budgetChars) {
        totalWeight -= weightOf(reach)
        reach -= 1
      }
      unit = Math.min(maxPerChapter, Math.max(minPerChapter, Math.floor(budgetChars / totalWeight)))
    } else {
      let total = 0
      for (let index = from; index <= reach; index += 1) total += quotaOf(index) * weightOf(index)
      while (reach > from && total > budgetChars) {
        total -= quotaOf(reach) * weightOf(reach)
        reach -= 1
      }
    }

    /** 某章的**基准**额度（还没乘权重）。 */
    const baseOf = (index) => (lengthRatio === 0 ? unit : quotaOf(index))

    // `perChapter` 报出去的是**基准**字数（还没乘权重）。均分模式下它是一张单一
    // 的额度；比例模式下每章不同，于是取本批**实际发出的最小值**——"每章至少这么
    // 多"是它唯一的承诺，不能因为换了形状就把它悄悄变成一句平均值。
    let perChapter = unit
    if (lengthRatio !== 0) {
      perChapter = quotaOf(from)
      for (let index = from + 1; index <= reach; index += 1) {
        perChapter = Math.min(perChapter, quotaOf(index))
      }
    }

    const samples = []
    let totalChars = 0
    for (let index = from; index <= reach; index += 1) {
      const full = readChapter(bookId, index)
      const raw = full.text.trim()
      if (raw === '') continue // 只有标题的空章不进样本

      // ⚠️ 先剥章末附言，**再**量长度、再切片。顺序不能反：
      // 剥完之后这一章可能整章都装得下（原样全给）；反过来先切后剥，会把
      // 「（中略）」尾窗削掉一截，切点全乱。
      const cleaned = stripChapterTrailingNoise(raw)
      const text = cleaned.text

      const allowance = baseOf(index) * weightOf(index)
      let piece
      if (text.length <= allowance) {
        piece = text
      } else {
        // 头 60% / 尾 40%：铺垫与收束都要，重心略偏开头。
        // 两个切点都对齐到自然边界（头到句读之后、尾到段首），否则会切出半句话和断引号。
        const budgetHead = Math.floor(allowance * 0.6)
        const headEnd = alignHeadCut(text, budgetHead)
        // 头窗对齐的溢出从尾窗里扣掉，保证正文部分不超过配额。
        const tailBudget = allowance - headEnd
        if (tailBudget <= 0 || headEnd >= text.length) {
          piece = text.slice(0, allowance)
        } else {
          const tailStart = alignTailCut(text, text.length - tailBudget)
          piece = `${text.slice(0, headEnd)}\n（中略）\n${text.slice(tailStart)}`
        }
      }
      samples.push({ index, title: full.title, text: piece })
      totalChars += piece.length
    }

    return {
      from,
      to: reach,
      requestedTo: to,
      partial: reach < to,
      perChapter,
      totalChars,
      foundation: options.foundation === true,
      emphasisChapters,
      emphasisFactor,
      lengthRatio,
      chapters: samples,
    }
  }

  //#endregion

  //#region 笔记与草稿

  /**
   * 解析某本书 `notes.md` 的路径（含存在性校验）。
   *
   * @param {string} bookId 书 id
   * @returns {string} 绝对路径
   */
  function notesPathFor(bookId) {
    return artifactPath(bookId, 'notes.md')
  }

  /**
   * 读一本书的笔记。
   *
   * 文件被外部编辑器改坏也不会抛错——{@link parseNotes} 对不成对的标记是跳过
   * 而不是报错，半条笔记不该让整个列表打不开。
   *
   * @param {string} bookId 书 id
   * @returns {object[]}
   */
  function notes(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    return readNotes(notesPathFor(bookId), meta.title).notes
  }

  /**
   * 读一本书的**一页**笔记（新的在前）。
   *
   * 和 {@link notes} 并存而不是替代它：`notes()` 是"全部"，语义简单、被单测
   * 和内部逻辑直接使用；分页只属于 HTTP 那一层，所以单独一个入口。
   *
   * ⚠️ 代价要说清楚：这里仍然**解析整个文件**再做切片。解析本身很便宜
   * （实测 1000 条 4.2 ms），真正昂贵的是响应体大小与客户端 DOM 节点数，
   * 而分页恰好把这两样按住了。所以没做增量解析——那是另一个量级的复杂度，
   * 换不来可感知的收益。
   *
   * @param {string} bookId 书 id
   * @param {{ limit?: unknown, before?: string|null }} [options] 分页参数
   * @returns {{ notes: object[], total: number, hasMore: boolean,
   *             nextCursor: string|null, reset: boolean }}
   */
  function notesPage(bookId, options = {}) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const all = readNotes(notesPathFor(bookId), meta.title).notes
    // ⚠️ 回收站里的笔记**默认不出现在列表里**（v1.55）。`trashed: true` 时反过来
    // ——只列它们，那就是界面上的「回收站」页。
    const wanted = all.filter((note) => note.trashed === (options?.trashed === true))
    return paginateNotes(wanted, options)
  }

  /**
   * 一章里的笔记（**新的在前**，与笔记列表同序）。
   *
   * 与 {@link notesPage} 的分工：那个是"全部笔记翻页"，这个是"**这一章我记过什么**"。
   * 正文页每翻一章就要问一次，所以它必须是**范围查询**而不是搜索：
   * 只看 `chapterIndex` 相等，不碰正文、不引入任何检索面。
   *
   * 没有这一章的笔记是**正常结果**（空数组），不是错误——大多数章本来就没记过。
   *
   * ⚠️ 与 `notesPage` 一样会**解析整个 notes.md**（实测 1000 条 4.2 ms）；这里的量级
   * 更小（一章通常 0–3 条），所以不值得为它做索引。
   *
   * @param {string} bookId 书 id
   * @param {number} chapterIndex 章序号（0 起）
   * @returns {object[]}
   */
  function notesForChapter(bookId, chapterIndex) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) return []
    const all = readNotes(notesPathFor(bookId), meta.title).notes
    // 文件里是旧→新，`filter` 出来仍保持该序；笔记列表约定"新的在前"，这里跟着翻一次。
    // ⚠️ 回收站里的不算：正文页那个「本章你记过 N 条」数的是**你还在用的**笔记（v1.55）。
    return all
      .filter((note) => note.chapterIndex === chapterIndex && note.trashed !== true)
      .reverse()
  }

  /**
   * 把一条笔记放进回收站 / 从回收站恢复（v1.55）。
   *
   * ⚠️ **纯追加**：只在 `notes.md` **文件尾**加一条标记，既不读也不改既有字节 ——
   * 所以读者同时在 Obsidian 里编辑也不会丢东西（见 `notes.js` 开头那段说明）。
   * 每个 id 的状态 = **最后一条相关标记**，所以重复删除 / 重复恢复都幂等。
   *
   * @param {string} bookId 书 id
   * @param {string} noteId 笔记 id
   * @param {'deleted'|'restored'} kind
   * @returns {{ id: string, trashed: boolean }}
   */
  function setNoteTrashed(bookId, noteId, kind) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    if (typeof noteId !== 'string' || noteId === '') throw new Error(`NOTE_NOT_FOUND: ${noteId}`)
    const path = notesPathFor(bookId)
    const notes = readNotes(path, meta.title).notes
    if (notes.some((note) => note.id === noteId) !== true) throw new Error(`NOTE_NOT_FOUND: ${noteId}`)
    appendTrashMarker(path, noteId, kind)
    return { id: noteId, trashed: kind === 'deleted' }
  }

  /** 进回收站。 */
  function trashNote(bookId, noteId) {
    return setNoteTrashed(bookId, noteId, 'deleted')
  }

  /**
   * 回收站里**所有**笔记的 id（「清空回收站」用）。
   *
   * 刻意不走 `notesPage`：那一层有分页上限（`NOTES_PAGE_MAX`），清空只清掉一页就成了
   * 半个动作 —— 而"清空"要的就是清干净。
   *
   * @param {string} bookId 书 id
   * @returns {string[]}
   */
  function trashedNoteIds(bookId) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    return readNotes(notesPathFor(bookId), meta.title).notes
      .filter((note) => note.trashed === true)
      .map((note) => note.id)
  }

  /** 从回收站恢复。 */
  function restoreNote(bookId, noteId) {
    return setNoteTrashed(bookId, noteId, 'restored')
  }

  /**
   * **彻底删除**：把点名的笔记从 `notes.md` 里真正抹掉（连同它们的标记）。
   *
   * ⚠️ 这是全插件**第二处**会改读者已有文件的地方（第一处是背景认识的压缩），所以
   * 照同一套纪律来，三步缺一不可：
   *   ① **先备份**（`notes.md.bak.<时间戳>.md`，用 `atomicWriteText` 写原样内容）；
   *   ② **写前再读一次核对**：两次读到的全文必须逐字相同 —— 读者可能正在 Obsidian 里
   *      编辑那个文件，变了就**中止并让他重试**，绝不覆盖；
   *   ③ 只按 **id** 定位块（`removeNotes` 用的是 `splitNoteBlocks` 给出的原样块），
   *      从不按行号 —— 行号会因为别处的编辑而移位。
   *
   * @param {string} bookId 书 id
   * @param {string[]} ids 要彻底删掉的笔记 id
   * @returns {{ removed: number, backupPath: string|null }}
   */
  function purgeNotes(bookId, ids) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id !== '')
    if (list.length === 0) return { removed: 0, backupPath: null }

    const path = notesPathFor(bookId)
    const first = readNotes(path, meta.title).markdown
    const { markdown, removed } = removeNotes(first, list)
    if (removed === 0) return { removed: 0, backupPath: null }

    if (readNotes(path, meta.title).markdown !== first) throw new Error('NOTES_CHANGED_SINCE_READ')

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backupPath = `${path}.bak.${stamp}.md`
    atomicWriteText(backupPath, first)
    atomicWriteText(path, markdown)
    return { removed, backupPath }
  }

  /**
   * 追加一条笔记。
   *
   * `reply` 为空的语义就是「AI 回应不落盘」——渲染层根本不会产出那个小节。
   *
   * @param {string} bookId 书 id
   * @param {object} note 笔记
   * @returns {{ created: boolean, id: string }}
   */
  function writeNote(bookId, note) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)

    const excerpt = typeof note?.excerpt === 'string' ? note.excerpt.trim() : ''
    const thought = typeof note?.thought === 'string' ? note.thought.trim() : ''
    const rawReply = note?.reply === null || note?.reply === undefined ? '' : String(note.reply).trim()
    if (excerpt === '' && thought === '') throw new Error('NOTE_EMPTY')

    // 章号越界时留空而不是夹取：笔记的坐标是要给人看的，宁可少一个字段。
    const chapterIndex = Number.isInteger(note?.chapterIndex) ? note.chapterIndex : null

    return appendNote(notesPathFor(bookId), {
      bookTitle: meta.title,
      chapterIndex,
      chapterTitle: typeof note?.chapterTitle === 'string' ? note.chapterTitle : '',
      charOffset: Number.isFinite(note?.charOffset) ? note.charOffset : null,
      excerpt,
      thought,
      reply: rawReply === '' ? null : rawReply,
      tags: note?.tags,
    })
  }

  /**
   * 从草稿写一条笔记，并删掉该草稿。
   *
   * 把「写笔记 + 清草稿」合成一次调用，是为了让面板上的按钮只有一个语义：
   * 要么笔记进去了、草稿清了，要么两边都没动。分两次调用的中间态（笔记写成功
   * 但草稿没删）会让用户以为没写进去，然后重复写第二条。
   *
   * @param {string} bookId 书 id
   * @param {string} draftId 草稿 id
   * @param {{ attachReply?: boolean }} [options] attachReply 为真才把草稿上的 AI 回应写进笔记
   * @returns {{ created: boolean, id: string, draftRemoved: boolean }}
   */
  function writeNoteFromDraft(bookId, draftId, options = {}) {
    const draft = listDrafts(draftsPath, bookId).find((item) => item.draftId === draftId)
    if (draft === undefined) throw new Error(`DRAFT_NOT_FOUND: ${draftId}`)

    const written = writeNote(bookId, {
      chapterIndex: draft.chapterIndex,
      chapterTitle: draft.chapterTitle,
      charOffset: draft.charOffset,
      excerpt: draft.excerpt,
      thought: draft.thought,
      // 「AI 回应默认不落盘」在这里是**默认值**：不显式要求就不带。
      reply: options.attachReply === true ? draft.reply : null,
      tags: draft.tags,
    })

    deleteDraft(draftsPath, draftId)
    return { ...written, draftRemoved: true }
  }

  //#endregion

  return {
    storageDir,
    paths: {
      root: storageDir,
      inbox: inboxDir,
      books: booksDir,
      library: libraryPath,
      bindings: bindingsPath,
      drafts: draftsPath,
      bookDir,
      // ⚠️ 人可读制品（notes/background）跟着 `artifactPath` 走，可能落在
      // 会话工作区；`content.txt` 等大文件永远在插件目录里。
      notes: (bookId) => artifactPath(bookId, 'notes.md'),
      content: (bookId) => resolveInsideRoot(bookDir(bookId), 'content.txt'),
    },
    ensureDirs,
    list,
    scanInbox,
    importBook,
    remove,
    // 切分规则改了之后，让**已经在书架里**的书也吃到修复（见 reindex 的说明）。
    reindex,
    // 分类：独立于书架索引与书元信息的主观归类（见 readCategories 的说明）。
    categoryFor,
    setCategory,
    listCategories,
    // 运行期设置：覆盖 cordis.yml 里的安装时默认值（见 readSettings 的说明）。
    readSettings,
    writeSettings,
    get,
    chapters,
    readChapter,
    readRange,
    bind,
    unbind,
    bindingForBook,
    bookForSession,
    getProgress,
    setProgress,
    isFinished,
    setFinished,
    collectReadWindow,
    companionDir,
    ensureCompanionDir,
    setCompanionDir,
    location,
    background,
    backgroundApplyUpdates,
    backgroundMerge,
    backgroundReset,
    backgroundMarkdown,
    backgroundPath: backgroundPathFor,
    // 压缩：唯一会"往下减"的一步，所以它只接受已经校验过的结果（见 compact.js）。
    backgroundCompact,
    // 历代备份：压缩前的完整认识，一份不删（见 backupBackground 的说明）。
    listBackgroundBackups,
    // 导出：把笔记/背景/历代备份写成"文件名自带书名"的一组文件（见 host/export.js）。
    exportBook,
    persona,
    setPersona,
    personaPath: personaPathFor,
    recordDiscussion,
    listDiscussions,
    discussionPage,
    discussionsPath: discussionsPathFor,
    // 抽样一批章节，交给 memory.js 生成/更新背景认识。放在书库层是因为
    // 只有这里知道字节区间、能按章精确读。
    sampleChapters: (bookId, fromChapter, toChapter, options) =>
      sampleChapters(bookId, fromChapter, toChapter, options),
    notes,
    notesPage,
    notesForChapter,
    writeNote,
    trashNote,
    restoreNote,
    purgeNotes,
    trashedNoteIds,
    writeNoteFromDraft,
    listDrafts: (bookId) => listDrafts(draftsPath, bookId),
    saveDraft: (draft) => upsertDraft(draftsPath, draft),
    removeDraft: (draftId) => deleteDraft(draftsPath, draftId),
  }
}

/**
 * 把源文件名规整成书名。
 *
 * @param {string|undefined} explicit 用户显式给的标题
 * @param {string} sourceName 源文件名
 * @returns {string}
 */
function normalizeTitle(explicit, sourceName) {
  const trimmed = typeof explicit === 'string' ? explicit.trim() : ''
  if (trimmed !== '') return trimmed.slice(0, 200)
  const withoutExt = sourceName.replace(/\.[^.]+$/, '')
  return withoutExt.trim().slice(0, 200) || sourceName
}

/**
 * 章节的稳定锚：**标题行**在全文里的起始字符位置。
 *
 * 重新切分时，`index` 会变；`startChar` 是正文起点，也会随着标题行的判定变化；
 * 只有标题行本身的位置只由文件内容决定。所以跨切分规则对照同一章，只能靠它
 * （见 {@link createLibrary} 的 `reindex`）。
 *
 * @param {object} chapter 章节
 * @returns {number}
 */
function titleAnchor(chapter) {
  return chapter.titleStartChar ?? chapter.startChar
}

/**
 * 给章节补上精确的字节区间。
 *
 * `content.txt` 写的就是 `text` 的 UTF-8 编码，因此某字符位置 N 的字节
 * 偏移 = `Buffer.byteLength(text.slice(0, N), 'utf8')`。逐章累加即可，
 * 总复杂度 O(n)，不需要任何映射表。
 *
 * @param {string} text 解码后的全文
 * @param {object[]} chapters 字符区间形式的章节
 * @returns {object[]} 补上 startByte / endByte 的章节
 */
export function attachByteOffsets(text, chapters) {
  const out = []
  let byteCursor = 0
  let charCursor = 0

  for (const chapter of chapters) {
    // 区间是首尾相接的，正常情况 charCursor 恒等于 chapter.startChar；
    // 若因故不等（未来放宽切分策略），这里也能算对。
    if (chapter.startChar > charCursor) {
      byteCursor += Buffer.byteLength(text.slice(charCursor, chapter.startChar), 'utf8')
      charCursor = chapter.startChar
    }
    const startByte = byteCursor
    const piece = text.slice(chapter.startChar, chapter.endChar)
    const bytes = Buffer.byteLength(piece, 'utf8')
    byteCursor += bytes
    charCursor = chapter.endChar

    out.push({
      ...chapter,
      startByte,
      endByte: startByte + bytes,
      length: piece.length,
    })
  }

  return out
}

