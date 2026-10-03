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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'

import { JSON_SCHEMA_VERSION, atomicWriteJson, atomicWriteText, listQuarantined, mutateJson, readJson, updateJson } from './atomic-json.js'
import { decodeBook } from './encoding.js'
// ⚠️ `readBytesIfExists` 从 `export.js` 导入：那一份是**唯一实现**（原来这里有一份
// 逐字相同的副本，2026-10-01 体检合并 —— 同一个函数两份定义，改一处必漏一处）。
import { readBytesIfExists, runExport } from './export.js'
import { DEFAULT_LONG_CHAPTER_SPLIT, parseChapters, validateChapters } from './chapters.js'
import { assertRealPathInsideRoot, inspectImportSource, inspectWorkspaceDir, resolveInsideRoot, sanitizeFolderName } from './paths.js'
import { normalizeSessionId, sameSessionKey } from './spoiler.js'

/**
 * 书库索引的 schema 版本。改结构时递增，并在这里做迁移。
 *
 * ⚠️ 数值**同源于 `atomic-json.js` 的 `JSON_SCHEMA_VERSION`**（2026-10-03）：
 * 所有持久化 JSON 状态文件共用同一个"我认识到第几版"，拒写判据也住在那边
 * （见 `updateJson` 的 `JSON_SCHEMA_UNSUPPORTED`）。从前 `library.js` / `notes.js`
 * 各写一份 `1`，两份一旦分叉就会出现"有的文件保护、有的不保护"。
 */
const SCHEMA_VERSION = JSON_SCHEMA_VERSION

/** bookId 形态：源文件 sha256 的前 16 位十六进制。 */
const BOOK_ID_RE = /^[0-9a-f]{16}$/

/** 收件箱目录的默认名（`inboxDir` 配置为空时用它，相对 `storageDir`）。 */
const DEFAULT_INBOX_DIR = 'inbox'

/**
 * 导入完成后，收件箱里那份副本被搬去哪个子目录。
 *
 * 以点开头是**功能性的**，不是命名口味：`scanInbox` 会跳过点开头的条目
 * （见那里的 `name.startsWith('.')`），所以搬进去的文件天然不再出现在
 * 「扫描导入目录」的结果里 —— 不需要为它改任何扫描逻辑。
 */
const INBOX_IMPORTED_DIR = '.imported'

/**
 * 解析收件箱目录。
 *
 * ⚠️ **v1.71 之前这个配置项是句空话**：它写在 `DEFAULTS`（`lib/index.js:83`）与
 * `cordis.patch.yml` 的注释里、说自己"relative to storageDir"，但 `createLibrary`
 * 收都没收过它，宿主一直写死 `join(storageDir, 'inbox')`。于是"改了配置没反应"
 * 这种最难查的故障就摆在那里（配置像生效了，界面显示的路径也跟着变，而真正被
 * 扫描的还是老地方）。现在接上，并且**两种写法都收**：
 *   · 相对路径 → 相对 `storageDir`（默认 `inbox`）
 *   · 绝对路径 → 原样使用（想把收件箱放别的盘、或放一个看得见的目录时用这个）
 *
 * 不做"必须落在 storageDir 内"的限制是刻意的：这是**读者自己的配置值**，
 * 不是来自网络的输入；而他把它放到别处的理由通常正是"我的 C 盘快满了"。
 *
 * @param {string} storageDir 书库根
 * @param {unknown} configured 配置里的 `inboxDir`
 * @returns {string} 收件箱绝对路径
 */
export function resolveInboxDir(storageDir, configured) {
  const value = typeof configured === 'string' ? configured.trim() : ''
  if (value === '') return join(storageDir, DEFAULT_INBOX_DIR)
  return isAbsolute(value) ? value : join(storageDir, value)
}

/**
 * 导入完成后，把收件箱里那份副本搬进 `.imported/`。
 *
 * ## 为什么必须有它
 *
 * `importBook` 是 **copy 而不是 move**（原始字节要留成 `books/<id>/source.txt`，
 * 那是"原书只读"的承诺）。于是读者按面板提示放进收件箱的那份会**永远留着**：
 * 每次扫描都列出来、标着「已在书架」（`scanInbox` 的 `alreadyImported`），
 * 目录只增不减，读者得自己动手清。这类"收件箱"模式的通病就是它。
 *
 * ## 三条约束（都是刻意的）
 *
 *   1. **不删除，只搬。** 删是不可逆的，而那**是读者自己的文件**；书库里那份
 *      `source.txt` 字节完全相同，所以搬走不丢任何东西，却还能找回来。
 *   2. **只搬收件箱直属的那一份。** 从别处导入（`C:\books\夜行.txt`）的文件
 *      一个字节都不许动 —— 那可能正是读者唯一的那份。
 *   3. **失败不许连累导入。** 书已经在书架上了；搬不动（被占用 / 跨卷 / 权限）
 *      就记一条日志、返回 null。搬家是收尾动作，不该让成功变成失败。
 *
 * ⚠️ 用 `realpath` 比对目录，所以"收件箱里放一个指向别处的链接"不会被误搬：
 * 解出来的真实父目录不是收件箱，于是走"不动"那一侧。保守的方向是对的。
 *
 * @param {string} absPath 刚导入的源文件绝对路径
 * @param {string} inboxDir 收件箱绝对路径
 * @param {{ warn?: Function }} [logger] 日志
 * @returns {string|null} 搬过去之后的新路径；没搬（或搬失败）则 null
 */
export function moveIntoImported(absPath, inboxDir, logger) {
  let realSource
  let realInbox
  try {
    realSource = realpathSync(absPath)
    realInbox = realpathSync(inboxDir)
  } catch {
    return null
  }
  if (dirname(realSource) !== realInbox) return null

  const name = basename(realSource)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  const targetDir = join(realInbox, INBOX_IMPORTED_DIR)

  try {
    mkdirSync(targetDir, { recursive: true })
    let target = join(targetDir, name)
    // 同名不覆盖：`夜行 (2).txt`。同名通常意味着"读者又放进来一份同名的**别的**书"，
    // 覆盖掉上一份等于悄悄毁掉他的东西。找不到空位就干脆不搬（返回 null）。
    if (existsSync(target)) {
      let placed = ''
      for (let n = 2; n < 100; n += 1) {
        const candidate = join(targetDir, `${stem} (${n})${ext}`)
        if (!existsSync(candidate)) {
          placed = candidate
          break
        }
      }
      if (placed === '') return null
      target = placed
    }
    try {
      renameSync(realSource, target)
    } catch {
      // 跨卷 / 被占用时 rename 会失败，退化成"拷过去再删原件"。
      // 这是本函数里**唯一**会真的删东西的路径，而它删的正是刚被复制成功的那份。
      copyFileSync(realSource, target)
      unlinkSync(realSource)
    }
    return target
  } catch (error) {
    logger?.warn?.(`[reading] 收件箱归档失败（不影响导入）：${error?.message ?? String(error)}`)
    return null
  }
}

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
import { appendNote, appendTrashMarker, deleteDraft, emptyNotesHeader, listDrafts, locateNoteAnchor, noteAnchorLabel, paginateNotes, readNotes, remapNoteCoordinates, removeNotes, upsertDraft } from './notes.js'
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
  findDiscussionMergeTarget,
  lastDiscussionAt as lastOf,
  mergeDiscussion,
  normalizeDiscussion,
  readDiscussions,
  recentDiscussions,
} from './discussions.js'
import { HOST_DEFAULTS } from './defaults.js'

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
  // ⚠️ **来源网站宣传**（读者 2026-10-01 反馈：书源差的版本，章末会粘这些）。
  //    它们在别的站上不在行首、还常带域名，所以单独一组，并允许行首空白 / 括号。
  /^\s*(本\s*书|本\s*文|全\s*文|最\s*新)\s*(来\s*自|首\s*发|转\s*载|出\s*自)/,
  /^\s*(更\s*多|想\s*看)\s*(精\s*彩|免\s*费|最\s*新|好\s*看).{0,20}(小\s*说|章\s*节|请)/,
  /^\s*(请\s*记\s*住|手\s*机\s*(用\s*户)?\s*请|电\s*脑\s*用\s*户\s*请|各\s*位\s*书\s*友)/,
  /^\s*[（(【\[]?\s*(顶\s*点|起\s*点|笔\s*趣|番\s*茄|书\s*旗|纵\s*横|飞\s*卢|无\s*错)[^）)】\]]{0,12}[）)】\]]?\s*$/i,
  /^\s*(w\s*w\s*w\s*\.|h\s*t\s*t\s*p\s*s?\s*:)/i,
  /^\s*[a-z0-9-]+\.(com|net|cn|org|cc|xyz|top|info)\s*$/i,
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
  // ⚠️ **超长一律当"没设置"，绝不截断**（2026-10-03 体检：上面那段注释一直写着"不截断"，
  //    代码却在 `slice` —— **注释说了假话**）。被砍掉尾巴的路径指向的是**另一个目录**：
  //    静默把文件导到别处，比让这一项变成"未设置"（界面看得见、读者重选一次）严重得多 ——
  //    这正是上面那段注释自己的判据。
  //    ⚠️ 也不放行超长值：写入路由那一侧会拒（`EXPORT_DIR_TOO_LONG`），于是"存得进去、
  //    读出来还是超长"会一直卡着，而导出每次都在别处发生。
  if (cleaned.length > SETTING_PATH_MAX_CHARS) return null
  return cleaned
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
 * @param {{ thresholdChars: number, targetChars: number }|null} [options.longChapterSplit]
 *   超长章切分（D）。⚠️ **默认开启**，值取 `chapters.js` 的
 *   `DEFAULT_LONG_CHAPTER_SPLIT`（`thresholdChars: 5000` / `targetChars: 3500`）——
 *   与 `index.js` 的 `CONFIG_DEFAULTS.longChapterSplit` **同一个来源**（有测试钉住
 *   两处都等于它）；显式传 `null` = 关闭（旧行为）。
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger]
 * @returns {object} 书库门面
 */
export function createLibrary(options) {
  const storageDir = options.storageDir
  const fallbackBlockChars = options.fallbackBlockChars ?? HOST_DEFAULTS.fallbackBlockChars
  // ⚠️ 库侧兜底**浅拷贝**唯一来源（`chapters.js` 的 `DEFAULT_LONG_CHAPTER_SPLIT`），
  // 不再自己写一份 —— 从前"两处同一份默认值"靠注释 + 测试钉住，改一处忘一处就分叉。
  const longChapterSplit = options.longChapterSplit === undefined
    ? { ...DEFAULT_LONG_CHAPTER_SPLIT }
    : options.longChapterSplit
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
  // 收件箱：读者把 TXT 丢进来再点「扫描」。位置由 `inboxDir` 配置决定
  // （相对路径相对 storageDir，绝对路径原样用），解析规则见 `resolveInboxDir`。
  const inboxDir = resolveInboxDir(storageDir, options.inboxDir)
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
    // ⚠️ **"能解析"不等于"形状对"**（2026-10-03 体检**复现**）：`books` 不是数组时下面会静默
    //    归一成空书架，而 `recovered` 是**解析**失败标志、仍是 `false` ⇒ `importBook` 那道
    //    `LIBRARY_INDEX_CORRUPT` 护栏**看不见这种坏**，读-改-写照样把整个索引换成"只有这一本"
    //    （books/ 里两本书都在盘上，索引里只剩一本，而重建入口只在 CLI 脚本里，读者够不着）。
    //    所以形状错**与解析失败同等对待** —— 报出去让三处各司其职：护栏拦住导入、
    //    书架横幅说出来、`rebuildIndex` 认出它该重建。⚠️ 文件缺失时 `readJson` 回的是
    //    合法骨架（`books: []`）⇒ 不会误报。
    const malformed = !Array.isArray(value?.books)
    const books = malformed ? [] : value.books
    return { books, revision, recovered: recovered || malformed }
  }

  /**
   * 写书架索引（CAS）。
   *
   * @param {object[]} books 新的书籍数组
   * @param {string|null} expectedRevision 上次读到的 revision
   * @param {{ allowCorrupt?: boolean }} [options] `allowCorrupt` 只给**重建**用：
   *   索引已经损坏时，正常路径一律拒写（见 `atomic-json` 的 `STORAGE_CORRUPT`），
   *   而重建恰恰是"从 `books/<bookId>/meta.json` 把它救回来"的那条路。
   * @returns {string} 新 revision
   */
  function writeLibrary(books, expectedRevision, options = {}) {
    const result = updateJson(libraryPath, {
      fallback: { schemaVersion: SCHEMA_VERSION, books: [] },
      expectedRevision,
      allowCorrupt: options.allowCorrupt === true,
      mutate: () => ({ schemaVersion: SCHEMA_VERSION, books }),
    })
    return result.revision
  }

  /**
   * **扫 `books/<bookId>/meta.json` 重建书架索引** —— 索引损坏之后唯一的恢复入口。
   *
   * ⚠️ 注释里**不要**写 `books/` 加星号的 glob —— 那串字符里的"星号 + 斜杠"会
   * 提前闭合这个块注释（本函数第一次提交就是这么炸的：整个文件加载不能）。
   * 写 `<bookId>` 既准确又安全。
   *
   * ## 为什么必须有它（2026-10-01 三方评审 P1）
   *
   * `library.json` 一坏，`readLibrary` 就如实回一个空书架（这是对的：一个坏文件
   * 不该让插件挂不上），于是书架看起来"书全没了" —— 而**每本书的目录、正文、
   * 笔记、背景认识都还在盘上**，只是索引里再也找不到它们。评审当时的结论是：
   * "代码里没有任何重建入口"（`reindex-books.mjs` 只重切章节，它的书单也来自
   * 这份坏索引）。这个函数补上那个入口。
   *
   * ## 四条纪律
   *
   *   1. **默认不写**（`apply` 必须是显式的 true）：它会动 `library.json`；
   *   2. **写之前先整份备份**（`backups/library-<时间戳>.json`，与历代背景备份同一个地方）；
   *   3. **只补不丢**：`meta.json` 读不出来的那些书**保留索引里的原有条目**——
   *      "读不出 meta"不等于"这本书不存在"，宁可留一条查不到的记录，也不删书；
   *   4. **如实报**：找回了几本（`missing`）、索引里的悬垂条目几条（`dangling`，
   *      目录已经不在，这些会被移除）、哪些目录读不出来（`unreadable`）。
   *
   * @param {{ apply?: boolean }} [options]
   * @returns {object} 报告
   */
  function rebuildIndex(options = {}) {
    const apply = options.apply === true
    const found = []
    const unreadable = []

    let names = []
    try {
      names = readdirSync(booksDir)
    } catch {
      names = []
    }
    for (const name of names) {
      let stat
      try {
        stat = statSync(join(booksDir, name))
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      const { value } = readJson(join(booksDir, name, 'meta.json'), null)
      if (value === null || typeof value !== 'object' || typeof value.bookId !== 'string') {
        unreadable.push(name)
        continue
      }
      if (value.bookId !== name) {
        // meta.json 说自己是另一本书：**不能**用它去顶替这个目录对应的条目。
        unreadable.push(`${name}（meta.json 里的 bookId 是 ${value.bookId}）`)
        continue
      }
      found.push(value)
    }

    const { books, revision, recovered } = readLibrary()
    const foundIds = new Set(found.map((book) => book.bookId))
    // 只补不丢：目录在、但 meta.json 读不出来的那些书，保留索引里的原条目。
    const kept = books.filter((book) => {
      if (foundIds.has(book.bookId)) return false
      return unreadable.some((item) => item === book.bookId || item.startsWith(`${book.bookId}（`))
    })
    const missing = found.filter((book) => !books.some((item) => item.bookId === book.bookId))
    const dangling = books.filter((book) => !foundIds.has(book.bookId) && !kept.includes(book))

    const report = {
      indexRecovered: recovered,
      found: found.length,
      indexed: books.length,
      missing: missing.map((book) => ({ bookId: book.bookId, title: book.title })),
      dangling: dangling.map((book) => ({ bookId: book.bookId, title: book.title })),
      unreadable,
      backupPath: null,
      applied: false,
    }

    const next = [...found, ...kept]
    const changed = missing.length > 0 || dangling.length > 0 || recovered || next.length !== books.length
    if (!apply || !changed) return report

    try {
      report.backupPath = backupLibraryIndex()
    } catch {
      // 备份失败不该阻断重建（与 replacement 那条路同一个取舍），但要让调用方知道没留后路。
      report.backupPath = null
    }
    writeLibrary(next, revision, { allowCorrupt: true })
    report.applied = true
    report.indexed = next.length
    logger.info?.(`[reading] 重建书架索引：${books.length} → ${next.length} 本（找回 ${missing.length}，移除悬垂 ${dangling.length}）`)
    return report
  }

  /**
   * 把当前 `library.json` 整份复制到 `backups/`（带时间戳，一份不删）。
   *
   * @returns {string|null} 备份路径；没有原文件时回 null
   */
  function backupLibraryIndex() {
    if (!existsSync(libraryPath)) return null
    const dir = join(storageDir, 'backups')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `library-${stamp}.json`)
    copyFileSync(libraryPath, target)
    return target
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
   * 被挪到一边的**坏文件**清单（空数组 = 一切正常）。
   *
   * ⚠️ 为什么要有这个查询（2026-10-02 三方评审 P2-2）：`bindings.json` /
   * `categories.json` / `settings.json` 是"随时可重建的派生状态"，损坏时**挪开重建**
   * （坏文件一份不丢）—— 设计上是对的，可它对读者是**可见的状态丢失**：
   * 全部书的阅读进度、会话绑定会显示成"没读过 / 没绑过"，紧接着一次翻页
   * （自动且高频）就把这份空状态写实了。而从前这三份文件损坏时读者侧**零提示**
   * （只有书架索引 `library.json` 那条路会说），读者只能自己猜"我的进度去哪了"。
   *
   * ⚠️ 直接读磁盘（见 `listQuarantined`）⇒ 重启后照样说得出事，提示因此能常驻。
   *
   * @returns {Array<{ file: string, base: string, path: string, mtime: string|null }>}
   */
  function storageQuarantined() {
    return listQuarantined(storageDir)
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
      // 被挪走的坏文件（P2-2）。与 `recovered` **是两件事**：`recovered` 说的是
      // "书架索引现在读不出来"，这里说的是"磁盘上躺着几份被挪开的坏文件"（任何一份
      // 派生状态文件损坏都会出现在这里，包括索引那份）。两者都报，读者侧才说得清。
      quarantined: storageQuarantined(),
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
    // ⚠️ **动手之前先确认书架索引是好的。** `readLibrary` 对损坏的 `library.json`
    //    是"静默回空书架 + `recovered:true`"（那本身是对的：一个坏文件不该让整个
    //    插件挂不上）。但**读-改-写**拿到空书架再写回去，就等于把整个索引换成
    //    "只有这一本"：书的目录与笔记都还在盘上，索引里却再也找不到它们，
    //    而代码里**没有任何重建索引的入口**（`reindex-books.mjs` 只重切章节，
    //    它的书单也来自这份索引）。所以这里在**写任何文件之前**拦住，
    //    让读者拿到一个能操作的失败，而不是一次静默的资产失踪。
    if (readLibrary().recovered === true) {
      const error = new Error('LIBRARY_INDEX_CORRUPT: 书架索引（library.json）损坏了，'
        + '为避免把整个书架覆盖成"只有这一本"，这次导入没有执行。'
        + '书的正文与笔记都还在磁盘上（books/ 目录），请先修好或移走那份索引，再重新导入。')
      error.code = 'LIBRARY_INDEX_CORRUPT'
      throw error
    }

    const absPath = input?.absPath
    const inspected = inspectImportSource(absPath, { importRoots })
    if (!inspected.ok) {
      const error = new Error(`IMPORT_REJECTED: ${inspected.reason}`)
      // ⚠️ 2026-10-03 单轨化：`code` 是**线上码**（`guarded()` 靠它分派），
      // `reason` 是给人看的细节（`FILE_NOT_FOUND` 这类枚举，客户端会再翻成人话）。
      // 从前这里把 `code` 设成 `reason` —— 那让"码"有了两个互相矛盾的含义：
      // message 前缀说是 `IMPORT_REJECTED`，`error.code` 说是 `FILE_NOT_FOUND`。
      error.code = 'IMPORT_REJECTED'
      error.reason = inspected.reason
      throw error
    }

    const bytes = readFileSync(absPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const bookId = sha256.slice(0, 16)

    const existing = findBook(bookId)
    if (existing !== undefined) {
      logger.info?.(`[reading] 已存在同一份书，跳过导入 bookId=${bookId}`)
      // 书库里已经有**同一份字节**了，收件箱里那份也没有留下的理由 —— 一样搬走。
      // 否则"手滑又放了一次"会在收件箱里留下一个永远扫得出来的残影。
      return { book: existing, deduped: true, inboxMovedTo: moveIntoImported(absPath, inboxDir, logger) }
    }

    const decoded = decodeBook(bytes)
    const parsed = parseChapters(decoded.text, { fallbackBlockChars, longChapterSplit })
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
    // 收件箱收尾。真相在 `inboxMovedTo` 里，界面据此如实说一句（见 `importOutcomeText`）——
    // "文件自己不见了而界面不吭声"是最让人不放心的那种行为。
    return { book: meta, deduped: false, inboxMovedTo: moveIntoImported(absPath, inboxDir, logger) }
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
    const parsed = parseChapters(text, { fallbackBlockChars, longChapterSplit })
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
      remap: { shifted: false, progress: false, drafts: 0, backgroundCovered: null },
      drift: [],
      // 按章笔记的**逐条核对结果**（只在 `remap.shifted` 时填；形状见下）。
      notes: null,
      warnings: parsed.warnings,
      applied: false,
      backupDir: null,
    }
    if (!changed) return report

    // --- 锚点映射：旧位置 → 新位置（三种归属）---
    //   survivor  标题锚命中且区间逐字相同（原样保留）；
    //   split     标题锚命中第 1 片、且有一串新章**恰好铺满**旧章区间（只细分、不挪字）；
    //   dropped   锚没命中（重复目录行一类）——顺延，见下。
    // split 归属是"超长章切分"（D）的迁移形态：区间当然会变（一章变几片），但
    // **每一个字符都还在原位**——这正是可以把进度/笔记/草稿/覆盖**精确搬家**的根据，
    // 与"猜一个章号"有本质区别（后者才是不变量 3 要拦的）。
    const byAnchor = new Map()
    for (const chapter of next) byAnchor.set(titleAnchor(chapter), chapter.index)

    const direct = new Array(previous.length).fill(null)
    const splits = new Map()
    for (let i = 0; i < previous.length; i += 1) {
      const hit = byAnchor.get(titleAnchor(previous[i]))
      if (hit === undefined) {
        report.droppedTitles.push(previous[i].title)
        continue
      }
      const before = previous[i]
      const after = next[hit]
      if (before.startChar === after.startChar && before.endChar === after.endChar) {
        direct[i] = hit
        continue
      }
      // 标题命中但区间不同：唯一合法的形态是"这一章被切成了子章"——
      // 第 1 片必须从原章起点开始，向后收集仍在原章区间内的新章，恰好铺满为止。
      if (after.startChar !== before.startChar || after.endChar > before.endChar) {
        throw new Error(
          `REINDEX_RANGE_DRIFT: 第 ${i} 章「${before.title}」的正文区间会变`
          + `（${before.startChar}-${before.endChar} → ${after.startChar}-${after.endChar}），拒绝落盘`,
        )
      }
      const run = [hit]
      let cursor = hit
      while (cursor + 1 < next.length
        && next[cursor + 1].startChar === next[cursor].endChar
        && next[cursor + 1].endChar <= before.endChar) {
        cursor += 1
        run.push(cursor)
      }
      if (next[cursor].endChar !== before.endChar) {
        throw new Error(
          `REINDEX_RANGE_DRIFT: 第 ${i} 章「${before.title}」的正文区间会变`
          + `（${before.startChar}-${before.endChar} → 切分后的各片没有恰好铺满原区间），拒绝落盘`,
        )
      }
      direct[i] = hit
      splits.set(i, { first: hit, last: cursor })
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
    // split 归属的章按**字符位置**精确落片：旧章起点 + 片内偏移 = 全文位置，
    // 再找包含它的那一片（每个字符恰属一片，无猜）。
    const pieceForGlobal = (oldIndex, charOffset) => {
      const split = splits.get(oldIndex)
      if (split === undefined) return null
      const globalOffset = previous[oldIndex].startChar + Math.max(0, charOffset ?? 0)
      for (let j = split.first; j <= split.last; j += 1) {
        if (globalOffset < next[j].endChar) {
          return { chapterIndex: j, charOffset: Math.max(0, globalOffset - next[j].startChar) }
        }
      }
      // 偏移恰在章末（或越界）⇒ 最后一片的末尾。
      const last = split.last
      return { chapterIndex: last, charOffset: next[last].endChar - next[last].startChar }
    }

    const progressRecord = bindingForBook(bookId)?.progress ?? null
    let progressTarget = null    // survivor 路径的新章号（0 起；字符偏移不动）
    let progressPiece = null     // split 路径的精确新坐标 { chapterIndex, charOffset }
    if (Number.isInteger(progressRecord?.chapterIndex)) {
      progressPiece = pieceForGlobal(progressRecord.chapterIndex, progressRecord.charOffset)
      if (progressPiece === null) {
        const mapped = map[progressRecord.chapterIndex]
        progressTarget = Number.isInteger(mapped) ? mapped : null
      }
    }
    report.remap.progress = (progressPiece !== null
      && (progressPiece.chapterIndex !== progressRecord.chapterIndex
        || progressPiece.charOffset !== progressRecord.charOffset))
      || (Number.isInteger(progressTarget) && progressTarget !== progressRecord.chapterIndex)
    const draftTargets = listDrafts(draftsPath, bookId)
      .map((draft) => {
        if (!Number.isInteger(draft.chapterIndex)) return { draft, moved: null }
        const piece = pieceForGlobal(draft.chapterIndex, draft.charOffset)
        if (piece !== null) return { draft, moved: piece.chapterIndex, movedCharOffset: piece.charOffset }
        const mapped = map[draft.chapterIndex]
        return { draft, moved: Number.isInteger(mapped) ? mapped : null }
      })
      .filter((item) => Number.isInteger(item.moved) && item.moved !== item.draft.chapterIndex)
    report.remap.drafts = draftTargets.length

    // --- 不变量 3：先看人工内容会不会漂 ---
    //
    // ⚠️ B+D 之后这一块改了口径：**能"按字符位置精确算出来"的重映射不再是漂移**——
    //   - 笔记：落在被切分的章里 ⇒ 新章号/偏移由字符位置唯一确定，且摘抄逐字仍在
    //     原位（字节没动）⇒ 机械重映射，不改一个字的内容；
    //   - 背景 `covered`：旧章号 F..L ⇒ 新章号 =「F 的第 1 片 .. L 的最后一片」，
    //     同样唯一确定；
    //   - 讨论：记录里**没有片内偏移**，落在哪一片无从确定 ⇒ 仍然拒绝（猜一个
    //     章号比拒绝更糟）。
    // ⚠️ `noteRemaps` 声明在 `if` **外面**：落盘区要用它——`const` 在块内声明，
    // 出了块就没了（第一版就是在这里吃到 ReferenceError）。
    const noteRemaps = new Map()
    if (report.remap.shifted) {
      const notesPath = artifactPath(bookId, 'notes.md')
      const anchoredNotes = readNotes(notesPath, meta.title).notes
        .filter((note) => Number.isInteger(note.chapterIndex))
      if (anchoredNotes.length > 0) {
        // ⭐ **有文本锚之后，"书里有笔记"不再等于"一定会漂"**：逐条核对，位置真没变的
        //    就不该拦住重切分（从前的行为是一律拒绝，即使那些笔记的章号根本没动）。
        //    split 归属的笔记在此之上多一档：坐标精确可算 ⇒ 直接算出新坐标并核对摘抄。
        const verified = anchoredNotes.map((note) => {
          if (splits.has(note.chapterIndex)) {
            const piece = pieceForGlobal(note.chapterIndex, note.charOffset)
            const excerpt = typeof note.excerpt === 'string' ? note.excerpt : ''
            const globalOffset = previous[note.chapterIndex].startChar + Math.max(0, note.charOffset ?? 0)
            if (piece === null || excerpt === ''
              || text.slice(globalOffset, globalOffset + excerpt.length) !== excerpt) {
              return { note, status: 'lost', chapterIndex: piece?.chapterIndex ?? null, charOffset: null }
            }
            noteRemaps.set(note.id, {
              chapterIndex: piece.chapterIndex,
              charOffset: piece.charOffset,
              chapterTitle: next[piece.chapterIndex].title,
            })
            // ⚠️ 用独立的 `remap` 状态，**不冒用** `moved`：locateNoteAnchor 的
            // `moved`（在邻近章里唯一找到）历来是"要拦住、让读者拍板"的漂移；
            // 切分重映射是按字符位置算死的，两回事。
            return { note, status: 'remap', chapterIndex: piece.chapterIndex, charOffset: piece.charOffset }
          }
          return { note, ...locateNoteAnchor(note, text, next) }
        })
        const risky = verified.filter((item) => item.status !== 'intact' && item.status !== 'remap')
        const remappedCount = verified.filter((item) => item.status === 'remap').length
        report.notes = {
          total: verified.length,
          intact: verified.filter((item) => item.status === 'intact').length,
          remapped: remappedCount,
          moved: verified.filter((item) => item.status === 'moved').length,
          lost: verified.filter((item) => item.status === 'lost').length,
          unverifiable: verified.filter((item) => item.status === 'unverifiable').length,
        }
        if (risky.length > 0) {
          const moved = risky.filter((item) => item.status === 'moved')
          const lost = risky.filter((item) => item.status === 'lost')
          const unknown = risky.filter((item) => item.status === 'unverifiable')
          const parts = []
          if (moved.length > 0) {
            const head = moved.slice(0, 3)
            const shown = head
              .map((item) => `第 ${item.note.chapterIndex + 1} 章 → 第 ${item.chapterIndex + 1} 章`)
              .join('、')
            parts.push(`${moved.length} 条挪了位置（${shown}${moved.length > head.length ? ' 等' : ''}）`)
          }
          if (lost.length > 0) {
            const head = lost.slice(0, 3).map((item) => noteAnchorLabel(item.note))
            parts.push(`${lost.length} 条对不上（${head.join('；')}${lost.length > head.length ? ' 等' : ''}）`)
          }
          if (unknown.length > 0) {
            parts.push(`${unknown.length} 条没有文本锚（v2.2.0 之前写的笔记），无法核对`)
          }
          report.drift.push(
            `${notesPath} 里有 ${verified.length} 条按章笔记：`
            + `${report.notes.intact} 条位置不变、${remappedCount} 条已算准新坐标；${parts.join('；')}`,
          )
        }
      }
      // 背景 covered：旧章号 F..L ⇒ 「F 的第 1 片 .. L 的最后一片」（1 起章号）。
      // 区间外（陈旧数据）不猜，仍然拒绝。条目正文一个字不动——它们仍按**旧章号**
      // 记载，过滤方向依旧安全（超前条目照切），只是对旧条目而言子章粒度不生效，
      // 这一点在报告里如实说。
      const backgroundDoc = background(bookId)
      if (backgroundDoc.covered !== null && backgroundDoc.covered !== undefined) {
        const firstOld = backgroundDoc.covered.first - 1
        const lastOld = backgroundDoc.covered.last - 1
        const firstNew = splits.has(firstOld) ? splits.get(firstOld).first : direct[firstOld]
        const lastNew = splits.has(lastOld) ? splits.get(lastOld).last : direct[lastOld]
        if (!Number.isInteger(firstNew) || !Number.isInteger(lastNew)) {
          report.drift.push(`${backgroundPathFor(bookId)} 的背景认识覆盖到第 ${backgroundDoc.covered.last} 章，超出了重切后的章数`)
        } else {
          report.remap.backgroundCovered = { from: backgroundDoc.covered, to: { first: firstNew + 1, last: lastNew + 1 } }
          report.warnings.push(
            '背景认识里的旧条目仍按旧章号记载：过滤方向依旧安全（超前条目照切），'
            + '但对旧条目而言"子章"粒度不生效；新写入的条目会用新章号。',
          )
        }
      }
      const discussionCount = listDiscussions(bookId, 1).length
      if (discussionCount > 0) report.drift.push(`${discussionsPathFor(bookId)} 的讨论时间线按章号记录（没有片内偏移，无法机械重映射）`)
    }

    if (!apply) return report
    if (report.drift.length > 0) {
      throw new Error(`REINDEX_ANCHOR_DRIFT: ${report.drift.join('；')}`)
    }

    // --- 落盘（先备份）---
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(storageDir, 'backups', `reindex-${bookId}-${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    for (const [name, source] of [
      ['chapters.json', join(dir, 'chapters.json')],
      ['meta.json', join(dir, 'meta.json')],
      ['library.json', libraryPath],
      ['bindings.json', bindingsPath],
      ['drafts.json', draftsPath],
      // B+D 迁移新增的两份：笔记坐标要外科改写、背景 covered 要换算成新章号——
      // 两者都进了写盘面，就必须与其它落盘物一样有备份兜底。
      ['notes.md', artifactPath(bookId, 'notes.md')],
      ['background.md', backgroundPathFor(bookId)],
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

    // 进度：survivor 直接命中被删位置的章号顺延到下一章（字符偏移不动，区间没变）；
    // split 章按字符位置精确落片，偏移换成**片内**偏移。
    if (report.remap.progress) {
      const nextProgress = progressPiece !== null
        ? { ...progressRecord, ...progressPiece, updatedAt: new Date().toISOString() }
        : { ...progressRecord, chapterIndex: progressTarget, updatedAt: new Date().toISOString() }
      mutateBindings((current) => ({
        schemaVersion: SCHEMA_VERSION,
        books: {
          ...current.books,
          [bookId]: {
            ...(current.books[bookId] ?? {}),
            progress: nextProgress,
          },
        },
        bySession: current.bySession,
      }))
    }

    // 草稿：按章记录，同样搬；split 章的偏移换成片内偏移。
    for (const item of draftTargets) {
      upsertDraft(draftsPath, item.movedCharOffset !== undefined
        ? { ...item.draft, chapterIndex: item.moved, charOffset: item.movedCharOffset }
        : { ...item.draft, chapterIndex: item.moved })
    }

    // 笔记：只动被切分章名下的那几条——属性行与标题行换成新坐标，摘抄/感想/回应
    // 一个字节不动（外科手术，不做整份重渲染）。没有需要搬的就一行都不碰。
    if (report.notes !== null && report.notes.remapped > 0) {
      const outcome = remapNoteCoordinates(artifactPath(bookId, 'notes.md'), noteRemaps)
      logger.info?.(`[reading] 重切分：笔记坐标已更新 ${outcome.remapped} 条`)
    }

    // 背景 covered：换算成新章号（条目正文不动，见不变量 3 的说明）。
    if (report.remap.backgroundCovered !== null && report.remap.backgroundCovered !== undefined) {
      const doc = background(bookId)
      writeBackground(backgroundPathFor(bookId), { ...doc, covered: report.remap.backgroundCovered.to }, meta.title)
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
    if (opts.keepNotes === true) {
      // ⚠️ **活的那一份 `notes.md` 可能在工作区**（落点由 `companionDir` 决定），
      //    而 `bookDir` 下那份可能只是导入时建的空骨架。只从 `bookDir` 拷，
      //    保留下来就是一个空壳 —— 而"我帮你把笔记留了一份"是一句让人放心的话，
      //    **假的安全感比没有更坏**（2026-10-01 三方评审 P2）。
      //    ⚠️ 这里用**无副作用**的 `companionDir`，不用 `artifactPath`：后者会建目录、
      //    写认领标记、迁移老文件，而这本书马上要被删掉，不该在工作区留下空文件夹。
      const live = join(companionDir(bookId).dir, 'notes.md')
      const source = existsSync(live) ? live : join(dir, 'notes.md')
      if (existsSync(source)) {
        // 笔记是用户手写内容，移除书时给一次保留机会。
        // ⚠️ **必须走 `uniqueBackupPath`**（2026-10-03 体检**复现**）：文件名只由 bookId 决定，
        //    而 bookId 是内容 sha 前 16 位 ⇒ **重新导入同一份文件再删一次，就原地覆盖上一代
        //    保留副本**；而那本书的目录已经 `rmSync` 掉了 ⇒ 第一轮的笔记在盘上**一份都不剩**
        //    （探针：第二次删除后整个存储目录里搜不到第一轮的内容）。
        //    界面刚说过"笔记已保留" —— 这是**假的安全感**，也是本插件唯一不可逆丢读者文本的路径。
        //    `uniqueBackupPath` 的注释（见它自己）早就写着"同一件事两份实现，改了一处漏了另一处"。
        notesKeptAt = uniqueBackupPath((seq) => join(storageDir,
          seq === 0 ? `removed-${bookId}-notes.md` : `removed-${bookId}-notes-${seq}.md`))
        copyFileSync(source, notesKeptAt)
      }
    }

    // ⚠️ 顺序：**先写索引（CAS）再删目录**（2026-10-02 三方评审 P3-1）。
    //    旧顺序是"先 `rmSync` 再 `writeLibrary`"，撞上 `REVISION_CONFLICT`（两个窗口同时
    //    删同一本）或任何写盘失败时，**内容已经删了、索引里那本书还在** —— 读者看到一本
    //    打不开的书，而正文与笔记都已不在磁盘上。
    //    现在失败方向倒过来：索引先落定，最坏只是留下一个没有索引指向的目录（磁盘上多占
    //    一份，可手动删；笔记另有 `notesKeptAt` 那份保留）。删除这条路上，宁可多留文件，
    //    不可先丢内容。
    const nextBooks = books.filter((book) => book.bookId !== bookId)
    writeLibrary(nextBooks, revision)

    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 索引已经落定 ⇒ 这本书在书架上确实没了。这里再抛只会让调用方以为"删除失败"，
      // 而重试拿到的是 `removed: false`（更让人困惑）。留下一个空目录比一条假报错轻。
    }

    // 绑定关系必须一起清，否则会出现指向不存在书籍的悬垂会话绑定。
    // 走 `mutateBindings`：状态归一化与"CAS + 撞车重试"在那里只有一份实现。
    mutateBindings((state) => {
      const boundEntry = state.books?.[bookId]
      const bySession = { ...state.bySession }
      // ⚠️ 按**归一化**删（同 unbind 的理由）：老文件里的键可能带 `session-` 前缀，
      //    只删精确键会留下一条指向已删除书籍的幽灵绑定。
      dropSessionKeys(bySession, boundEntry?.sessionId)
      const boundBooks = { ...state.books }
      delete boundBooks[bookId]
      return { ...state, books: boundBooks, bySession }
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
   * 以 CAS 方式改分类表（撞上并发写会重读重试，见 `mutateJson`）。
   *
   * @param {(state: object) => object} mutate 变换函数
   * @returns {object} 新状态
   */
  function mutateCategories(mutate) {
    const result = mutateJson(categoriesPath, {
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
    const result = mutateJson(settingsPath, {
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
   * 以 CAS 方式改绑定表（撞上并发写会重读重试，见 `mutateJson`）。
   *
   * @param {(state: object) => object} mutate 变换函数
   * @returns {object} 新状态
   */
  function mutateBindings(mutate) {
    const result = mutateJson(bindingsPath, {
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
   * 从一张 `bySession` 表里删掉某个会话的**所有别名键**。
   *
   * ⚠️ 为什么不能只删一个键：同一个会话在本仓库里有**两种写法**（agent 侧是裸 UUID、
   * 日志/绑定侧可能带 `session-` 前缀，见 `normalizeSessionId`）。老版本的 `bindings.json`
   * 里存的就是带前缀那一种；如果解绑/删书只删精确键，那条老键会留下 —— 于是"解绑了
   * 却还被认成陪读会话"，或者更糟：它和一条新键**同时**指向不同的书。
   *
   * @param {Record<string, string>} bySession 绑定表（会被就地修改）
   * @param {unknown} sessionId 要删掉的会话 id（任意写法）
   */
  function dropSessionKeys(bySession, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    // 判据只有一份：`sameSessionKey`（先精确、再归一化）—— 从前这里手写了一遍。
    for (const key of Object.keys(bySession)) {
      if (sameSessionKey(key, sessionId)) delete bySession[key]
    }
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
    // 先精确命中（上面那两行），再按归一化形态兜底 —— 判据只有一份：`sameSessionKey`。
    for (const [key, bookId] of Object.entries(bySession)) {
      if (sameSessionKey(key, sessionId)) return bookId
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
   * ⚠️⚠️ **判重与写盘都必须按"归一化后的会话"来做**（2026-10-02 三方评审 P2）：
   * 从前判重只看**精确键** `bySession[sessionId]`，而**反查**（`bookForSession`）会按
   * `normalizeSessionId` 兜底 ⇒ 用 `session-abc` 绑 A、再用 `abc` 绑 B **两次都会成功**，
   * 而同一场对话按两种写法反查会得到**两本不同的书**。这直接破坏"一个会话只绑一本书"，
   * 而 `bookForSession` 正是投喂边界、路径闸、联网闸三者共用的入口 ——
   * 最坏的情形是拿 A 书的进度去裁 B 书的正文（真实剧透），最好也是错书的上下文。
   *
   * 所以这里两件事都改了：判重扫**所有同形键**；写盘前把同形键**清干净**只留归一化
   * 那一个（老文件里带前缀的键也因此被自然收敛）。
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
    const wanted = normalizeSessionId(sessionId)
    if (wanted === '') throw new Error('SESSION_ID_INVALID')
    const state = readBindings()
    // 判重：**同形的都算同一个会话**（老文件里可能是带前缀的那一种）。
    // 判据只有一份：`sameSessionKey`（先精确、再归一化）。
    const holderKey = Object.keys(state.bySession).find((key) => sameSessionKey(key, sessionId))
    const holder = holderKey === undefined ? undefined : state.bySession[holderKey]
    if (holder !== undefined && holder !== bookId) {
      throw new Error(`SESSION_ALREADY_BOUND: ${sessionId} -> ${holder}`)
    }

    // 工作区路径由客户端解析后上报（宿主侧没有 workspaces 服务）。
    // **无效就保留旧值**：不要因为一次解析失败丢掉用户已经设好的好路径。
    const inspected = inspectWorkspaceDir(workspaceDir)

    // ⚠️ 绑定会**隐式换落点**（新会话带来新的工作区，或客户端这次解析出了别的路径）：
    //    同 {@link setCompanionDir}，先把现在这个落点记下来 —— 否则新落点只会拿到插件
    //    目录里那份空骨架，旧落点的真笔记成孤儿（2026-10-02 三方评审 P2-1）。
    const beforeCompanionDir = companionDir(bookId).dir

    const record = {
      ...(state.books[bookId] ?? {}),
      sessionId,
      workspaceId: workspaceId ?? state.books[bookId]?.workspaceId ?? null,
      workspaceDir: inspected.ok ? inspected.path : (state.books[bookId]?.workspaceDir ?? null),
      lastCompanionDir: beforeCompanionDir,
      boundAt: state.books[bookId]?.boundAt ?? new Date().toISOString(),
      progress: state.books[bookId]?.progress ?? null,
    }

    mutateBindings((current) => {
      const bySession = { ...current.bySession }
      // ⚠️ 先清掉这个会话的**所有同形键**，再只写归一化那一个 —— 否则
      //    `session-abc` 与 `abc` 会作为两条记录并存（见上面 bind 的说明）。
      dropSessionKeys(bySession, sessionId)
      bySession[wanted] = bookId
      return { schemaVersion: SCHEMA_VERSION, books: { ...current.books, [bookId]: record }, bySession }
    })
    return record
  }

  /**
   * 解除一本书的绑定（进度保留）。
   *
   * ⚠️ 删键必须走 {@link dropSessionKeys}（按**归一化**删）—— 老文件里键可能带
   * `session-` 前缀，只删精确键会留下一条"解绑了却还被认成陪读会话"的幽灵记录。
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
      dropSessionKeys(bySession, record.sessionId)
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
    const headAllowanceChars = options.headAllowanceChars ?? HOST_DEFAULTS.headAllowanceChars
    // ⚠️ 兜底与配置缺省**同源于 `HOST_DEFAULTS`**（`host/defaults.js`，2026-10-03）。
    // 从前是两处各写一份 `9000`、靠"有测试钉住不许分叉"维持 —— 而那句话本身就说明
    // 它**分叉过一次**（v1.26 的 9000）。现在由 import 保证，纪律不再参与。
    const backgroundBudgetChars = options.backgroundBudgetChars ?? HOST_DEFAULTS.backgroundBudgetChars
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
        // ——产物不能替我们声称一件没发生的事（docs/design-v1-archive.md §204）。
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
      // 在线折叠（3.0 ②c）：离场人物折叠成锚（注入视图；文件不动）。
      personOfflineChapters: options.personOfflineChapters,
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
        // ⚠️ **讨论时间线也要过水位线**（2026-10-02 三方评审 P1-2b）：`backward` 在这里
        //    算出来了，却只传给了背景认识 —— 讨论记录被**原样**取"最近 8 条"，
        //    再渲染成 `- 今天 · 第 900 章：<读者的感想 / 摘抄>` 写进 system 段
        //    （会话被重建 / 换绑时，后文原文就是这样进来的）。
        //    判据与背景认识**同一条**：允许记到**当前章**为止，再往后才是剧透。
        const safe = backward
          ? records.filter((record) => !Number.isInteger(record?.chapterIndex)
            || record.chapterIndex + 1 <= readingChapter)
          : records
        return {
          persona: persona(bookId),
          discussions: recentDiscussions(safe, options.discussionLimit ?? HOST_DEFAULTS.discussionLimit),
          // 「距上次聊过了多久」仍用**全部**记录：它只说时间、不透露聊的是哪一章，
          // 倒退时跟着过滤反而会凭空说一句"很久没聊"。
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
   * 这个源目录里那份制品是不是**真内容**（而不是导入时补下的空骨架）。
   *
   * ⚠️ 存在**不等于**有内容（2026-10-02 三方评审 P2-1）：`notes.md` 在导入时就被写下一份
   * 标题 + schema 注释的骨架，所以"目标已存在就不迁移""源存在就当有所迁移"两条都错。
   * 判据必须落在**内容**上。
   *
   * 先用大小挡一道：骨架只有两三行，大文件不可能是骨架 —— 免得每次解析制品路径
   * （`artifactPath` 是读路径上的唯一收口）都把整个文件读一遍。
   *
   * @param {string} dir 目录
   * @param {string} name 制品文件名
   * @param {string} title 书名（比对笔记骨架用）
   * @returns {boolean}
   */
  function hasRealArtifact(dir, name, title) {
    const full = join(dir, name)
    let size = 0
    try {
      size = statSync(full).size
    } catch {
      return false
    }
    if (size === 0) return false
    if (size > 2048) return true
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      return false
    }
    if (text.trim() === '') return false
    if (name === 'notes.md' && text.trim() === emptyNotesHeader(title).trim()) return false
    return true
  }

  /**
   * 迁移一个制品：把**有真内容**的那一份从旧位置复制到新位置。
   *
   * ⚠️ 三条判据都是被真实缺陷换来的（2026-10-02 三方评审 P2-1）：
   *   1. 目标已有**真内容**就不动它 —— 用户在新位置写的更权威；
   *   2. 目标只有**空骨架**时让它让位，从有内容的源覆盖过去（"存在"不是"有内容"）；
   *   3. 全都只有骨架就什么也不做，**也不报成迁移** —— 报"已把 notes.md 复制过来"却
   *      搬来一份空文件，是本条最坏的部分（假的安全感比没有更坏）。
   *
   * @param {string} targetDir 新落点
   * @param {string} name 制品文件名
   * @param {string[]} sources 迁移源（按优先级）
   * @param {string} title 书名
   * @returns {'migrated'|'skipped'|'copied-empty'} 结果，供调用方决定报不报
   */
  function migrateArtifact(targetDir, name, sources, title) {
    const target = join(targetDir, name)
    if (hasRealArtifact(targetDir, name, title)) return 'skipped'
    const withContent = sources.find((dir) => hasRealArtifact(dir, name, title))
    if (withContent !== undefined) {
      try {
        copyFileSync(join(withContent, name), target)
        return 'migrated'
      } catch {
        return 'skipped'
      }
    }
    // 没有任何源有真内容：新位置连骨架都没有的话，补一份（保持"打开就有文件"的既有形态），
    // 但这**不算迁移**，一个字都不许报给读者。
    if (existsSync(target)) return 'skipped'
    const skeletonSource = sources.find((dir) => existsSync(join(dir, name)))
    if (skeletonSource === undefined) return 'skipped'
    try {
      copyFileSync(join(skeletonSource, name), target)
      return 'copied-empty'
    } catch {
      return 'skipped'
    }
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
    {
      // ⚠️ 迁移源**不止插件目录**（2026-10-02 三方评审 P2-1，本轮触发概率最高的一条）：
      //    换落点（工作区 A → 工作区 B、或"设置里改一次 / 换会话绑定"）时，插件目录里
      //    那份 `notes.md` 只是**导入时写下的空骨架**，真笔记在旧落点 A。只从插件目录
      //    迁移 ⇒ 新落点拿到空文件、A 的笔记成孤儿（笔记页 / 本章笔记数 / 导出 /
      //    prompt 注入全部读到空的），而界面照样报「已把 notes.md 复制过来，原文件保留」。
      //    所以落点一变就把**上一次的落点**记进 binding（`lastCompanionDir`），迁移时它优先；
      //    插件目录是**兜底源**（老数据没有那个字段）。
      //    两个方向都迁移：切到工作区、以及从工作区**还原**回插件目录。
      const sources = []
      const previous = readBindings().books?.[bookId]?.lastCompanionDir
      if (typeof previous === 'string' && previous !== '' && previous !== location.dir) sources.push(previous)
      const legacy = bookDir(bookId)
      if (legacy !== location.dir && !sources.includes(legacy)) sources.push(legacy)

      for (const name of ['notes.md', 'background.md', 'persona.md']) {
        if (migrateArtifact(location.dir, name, sources, meta.title) === 'migrated') migrated.push(name)
      }

      // 历代背景备份也要跟着走。它们是**带时间戳的多个文件**，不在上面那份固定
      // 名单里，所以单独扫一遍 —— 否则落点一变（工作区 ↔ 插件目录），历代快照就
      // 留在了插件目录里，而它们正是"压缩前的完整认识"唯一的载体。
      for (const dir of sources) {
        try {
          for (const name of readdirSync(dir)) {
            if (!/^background\.bak.*\.md$/.test(name)) continue
            const target = join(location.dir, name)
            if (existsSync(target)) continue
            try {
              copyFileSync(join(dir, name), target)
              migrated.push(name)
            } catch {
              /* 同上：迁移失败不该阻断写入 */
            }
          }
        } catch {
          /* 源目录不可读就跳过 */
        }
      }

      if (location.scope === 'workspace') {
        const readme = join(location.dir, 'README.md')
        if (!existsSync(readme)) {
          try {
            atomicWriteText(readme, COMPANION_README)
          } catch {
            /* 说明文件写不上不算错误 */
          }
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

    // ⚠️ 换落点前先把**现在这个落点**记下来（2026-10-02 三方评审 P2-1）：旧目录才是真
    //    内容所在，下一个落点要靠它把笔记 / 背景 / 书友设定带过去。用**无副作用**的
    //    `companionDir`（不建目录、不写认领标记），它只是解析。
    const before = companionDir(bookId).dir

    mutateBindings((current) => ({
      schemaVersion: SCHEMA_VERSION,
      books: {
        ...current.books,
        [bookId]: { ...(current.books[bookId] ?? {}), workspaceDir: next, lastCompanionDir: before },
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
   * 返回一个**不撞名**的备份落点：撞了就把 `-2`、`-3`… 追在时间戳后面。
   *
   * ⚠️ 这是**唯一**的撞名入口，背景备份与笔记备份必须共用它（2026-10-02 三方评审 P1-4）：
   * 两处备份的时间戳都**只到秒**，而"同一秒写两次"是真实常态 ——
   *   · 一次补齐是"先压缩再合并"，`background.bak` 会在同一秒写两次；
   *   · 读者连点两次「彻底删除」，`notes.md` 的备份也会在同一秒写两次。
   * 背景那一侧早就有这个循环，笔记那一侧没有 ⇒ **同一件事两份实现，改了一处漏了另一处**，
   * 而笔记那一侧丢的是"删除之前那份更全的笔记"，是本插件唯一**不可逆**丢读者文本的路径。
   *
   * @param {(seq: number) => string} buildName 序号 → 候选路径（0 = 不带后缀）
   * @returns {string} 第一个不存在的候选（调用方随后自己创建）
   */
  function uniqueBackupPath(buildName) {
    for (let seq = 0; ; seq += 1) {
      const candidate = buildName(seq)
      if (!existsSync(candidate)) return candidate
    }
  }

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
    const target = uniqueBackupPath((seq) => resolveInsideRoot(
      dir,
      seq === 0 ? `background.bak.${stamp}.md` : `background.bak.${stamp}-${seq + 1}.md`,
    ))
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
   * @returns {Array<{ name: string, path: string, stamp: string, bytes: number }>}
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
        bytes: stat.size,
      })
    }
    found.sort((left, right) => (left.stamp < right.stamp ? -1 : left.stamp > right.stamp ? 1 : 0))
    return found
  }

  /**
   * 提交前的一致性检查：磁盘上的文件必须**仍等于**调用方读到的那一份。
   *
   * ## 为什么需要它
   *
   * 背景认识的写入有两类"长窗口"：手动压缩要等一次模型调用（最长
   * `memoryTimeoutMs`），补齐那条路还要再加上补齐自己的时长。窗口里文件完全可能
   * 被别的路径写过（补齐落盘、读者在编辑器里直接改 `background.md`）。
   *
   * 而压缩是**整份覆盖**、`base` 那条合并路也是**整份重写**——拿着过期快照写下去，
   * 就是把那段时间里的成果**静默抹掉**，与 `background.js` 顶部"你可以直接编辑它，
   * 下次补充会尊重你写的内容"那句承诺直接冲突（见 2026-10-01 的三方评审 P1）。
   *
   * 所以落盘前重读比对：不一致就抛 `BACKGROUND_CHANGED`，由调用方决定
   * "如实报失败"还是"用当前版本重做一次"。**失败方向是"这次不写"**——
   * 没压缩成功只是浪费一次调用，吞掉别人的写入是不可逆的。
   *
   * @param {string} path `background.md` 绝对路径
   * @param {string} title 书名（读文件要用）
   * @param {string} [expectedMarkdown] 调用方读到的全文；不给 = 不做检查（老行为）
   */
  function assertUnchanged(path, title, expectedMarkdown) {
    if (typeof expectedMarkdown !== 'string') return
    const { markdown } = readBackground(path, title)
    if (markdown !== expectedMarkdown) {
      const error = new Error('BACKGROUND_CHANGED')
      error.code = 'BACKGROUND_CHANGED'
      throw error
    }
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
   * @param {string} [options.expectedMarkdown] 调用方读到的全文。给了就在落盘前重读
   *   比对，不一致抛 `BACKGROUND_CHANGED` —— 整份重写前的必需品，见 `assertUnchanged`。
   * @returns {object} 落盘后的结果（含 `backupPath`）
   */
  function backgroundMerge(bookId, incoming, range, options = {}) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const path = backgroundPathFor(bookId)
    const base = options.base ?? readBackground(path, meta.title).doc
    const merged = mergeBackground(base, incoming, range)

    // ⚠️ 传了 `base` 就意味着这次是**整份重写**（底稿来自窗口开始时的快照），
    //    所以落盘前必须确认文件没被动过 —— 见 `assertUnchanged`。
    assertUnchanged(path, meta.title, options.expectedMarkdown)

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
   * 每本书的「清空重建」计数（**只在内存里**）。
   *
   * ⚠️ 它守的是一段**同一进程内**的竞态（2026-10-02 三方评审 P2-9）：
   * 补齐那条路会先读一份 `before`、再叫模型跑到几十秒甚至十分钟，最后才落盘。
   * 读者完全可以在那期间点「清空重建」—— 而补齐回来时拿着的是**清空之前**的底稿。
   *
   * 落盘前原有的 CAS（`expectedMarkdown`）**挡不住它**：那条路撞上 `BACKGROUND_CHANGED`
   * 时会**故意不复核、直接用当前文件重做一次合并**（那是为"读者在 Obsidian 里改了一句"
   * 设计的恢复路径）。于是"清空"之后，飞在路上的那一批会**把结果合并进空文件**
   * —— 读者看到的是"已清空"，几十秒后旧内容又回来了，而且**没有任何一处会说**。
   *
   * 所以清空时把计数 +1，补齐在**落盘之前**比对它：变了就**整批丢弃、一个字都不写**。
   * 只在内存里是够的 —— 两个路由跑在同一个进程里，竞态窗口也只在同一个进程内。
   */
  const resetEpochs = new Map()

  /**
   * 这本书的「清空重建」计数。补齐用它判断"我跑的这一趟期间文件被清空过吗"。
   *
   * @param {string} bookId 书 id
   * @returns {number} 从 0 起；没被清空过就是 0
   */
  function resetEpochOf(bookId) {
    return resetEpochs.get(bookId) ?? 0
  }

  /**
   * 清空背景认识（**不可逆**，只有读者自己点才会走到这里）。
   *
   * ⚠️ 每次都把 {@link resetEpochOf} 的计数 +1：飞在路上的补齐据此放弃落盘
   * （见 `resetEpochs` 的说明）。这一步**不能省** —— 省了就等于"清空可以被在飞的
   * 那一批悄悄撤销"。
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
    resetEpochs.set(bookId, resetEpochOf(bookId) + 1)
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
   * @param {object} [options]
   * @param {string} [options.expectedMarkdown] 调用方读到的全文。给了就在落盘前重读
   *   比对，不一致抛 `BACKGROUND_CHANGED` —— 压缩是整份覆盖，见 `assertUnchanged`。
   * @returns {{ markdown: string, backupPath: string|null }}
   */
  function backgroundCompact(bookId, doc, options = {}) {
    const meta = findBook(bookId)
    if (meta === undefined) throw new Error(`BOOK_NOT_FOUND: ${bookId}`)
    const path = backgroundPathFor(bookId)

    // ⚠️ 压缩是**整份覆盖**，而它前面压着一次很长的模型调用 —— 落盘前必须确认
    //    磁盘上还是我读到的那个版本，否则会静默吞掉窗口里的所有写入。
    assertUnchanged(path, meta.title, options.expectedMarkdown)

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

  /**
   * **冷归档落盘**（2026-10-02 / 3.0）。
   *
   * 与 {@link backgroundCompact} 是**同一套保障**（落盘前 CAS 比对 + 整份备份），
   * 区别只在调用方给的是什么：压缩给的是"模型重写过的 doc"，
   * 冷归档给的是"**代码把旧条目搬进「冷档案」之后的 doc**"（原文只搬运、零模型调用）。
   *
   * ⚠️ 两者都是**整份覆盖**，所以都必须带 `expectedMarkdown`。
   *
   * @param {string} bookId 书 id
   * @param {object} doc 搬运过条目的解析结果
   * @param {object} [options] 见 {@link backgroundCompact}
   * @returns {{ markdown: string, backupPath: string|null }}
   */
  function backgroundArchive(bookId, doc, options = {}) {
    return backgroundCompact(bookId, doc, options)
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

    const path = discussionsPathFor(bookId)
    // ⚠️ **一次交互 = 一条历史**（读者实测："一次记笔记的行为可能产生四五条讨论历史"）。
    // 「写笔记 / 发去聊 / 抓回回应」是同一件事的三步，后两步并进第一条，而不是各追加一行。
    // 判据在 `sameDiscussionTopic`（分级比较，因为 reply 那条**没有摘抄**），
    // 并用一小时的窗口把"同一段原文改天再记一次"区分成两次真实讨论。
    const existing = readDiscussions(path)
    const target = findDiscussionMergeTarget(existing, record)
    if (target === -1) {
      appendDiscussion(path, record)
      return record
    }
    const merged = mergeDiscussion(existing[target], record)
    const next = [...existing.slice(0, target), merged, ...existing.slice(target + 1)]
    // 原地改一条**必须整份重写**：JSONL 是追加格式，没有"改中间一行"的原子做法。
    // 走 `atomicWriteText`（先写临时文件再替换），与满仓裁剪那条路径同一个做法。
    atomicWriteText(path, `${next.map((item) => JSON.stringify(item)).join('\n')}\n`)
    return merged
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
   * 章节样本里**开头**拿到的配额比例（其余给结尾）。
   *
   * ⚠️ **2026-10-01 定在 0.6（头 60 / 尾 40）**。当天曾按读者的想法试过 0.55，随即便收回来：
   * 尾部那 40% 是"收束信号"的来源，而**章末垃圾已经被 `stripChapterTrailingNoise` 剥掉**
   * （剥掉之后尾部就干净了，不需要再靠加大比例去抢）✓
   * ⚠️ 注意别和 {@link PREVIOUS_TAIL_RATIO}（上一章只保留尾部 60%）混淆 —— 那是另一件事。
   */
  const SAMPLE_HEAD_RATIO = 0.6

  /**
   * 抽样一批章节，作为生成/更新背景认识的原料。
   *
   * ⚠️ 每章取**头 + 尾**（不是只取头）：长章的情节推进往往压在章末，只取头会得到
   *    一堆"他走进屋子"。中间用 `（中略）` 标出，免得模型以为文本是连贯的。
   * ⚠️ 加权判据必须**全是绝对的**（"这本书里的某个固定位置"），不能是"本批的前几章"——
   *    否则第二批又会把它自己的前几章当成重点。现行两个判据：全书开头的
   *    `emphasisChapters` 章、以及**卷首章**（`volume` 与前一章不同）。没有卷标记的书
   *    一条都不受影响。
   * ⚠️ 额度**按预算均分**。按章长比例那条路（`lengthRatio`）已于 2026-10-03 **整体退役**：
   *    它会把短章截得比均分狠（200 字的短章只剩下限那一段），而短章是读者的真实用法，
   *    读者明确收回了这个机制。动机与那句"两个轴反向"见 `docs/design-v1-archive.md` §197。
   * ⚠️ 章长取自**索引里的字符偏移**（不读正文 —— 缺口可能有上千章），量的是原始章长
   *    （含标题与章末附言）。⚠️ 比例模式删除后**没人再读它**了，留着是给以后可能的分页
   *    之类用途 —— 若一直没人用，它也该走。
   * ⚠️ 预算不够覆盖整个区间时**从前往后**给（`partial: true`）：背景认识是"打底"，而最近的
   *    内容已经由阅读窗口全文投喂。`foundation: true` 时本批最多 `foundationChapters` 章 ——
   *    读到第 300 章才第一次补齐时，先把开头读厚比平摊成 240 章有用。
   *
   * @param {string} bookId 书 id
   * @param {number} fromIndex 起始章（0 起，含）
   * @param {number} toIndex 结束章（0 起，含）
   * @param {object} [options]
   * @param {number} [options.budgetChars] 样本总字数预算
   * @param {number} [options.minPerChapter] 每章下限（均分额度的封底）
   * @param {number} [options.maxPerChapter] 每章上限（**基准**；重点章可达它的 `emphasisFactor` 倍）
   * @param {boolean} [options.foundation] 是否按"首次批次"处理
   * @param {number} [options.foundationChapters] 首次批次的章数上限
   * @param {number} [options.emphasisChapters] 全书开头的重点章数
   * @param {number} [options.emphasisFactor] 重点章的加权倍数
   * @returns {{ from: number, to: number, requestedTo: number, partial: boolean,
   *             perChapter: number, totalChars: number, foundation: boolean,
   *             emphasisChapters: number, emphasisFactor: number,
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
        chapters: [],
      }
    }

    const budgetChars = options.budgetChars ?? 24000
    // 下限默认 **600**（v1.67，读者选定走"温和"档；v2.0.2 曾是 150、v1.25 曾是 100）。
    // 它同时决定"一批最多吃多少章"（`budgetChars ÷ minPerChapter`）—— 600 对应约 40 章。
    // ⚠️ 它**不能高过 `maxPerChapter`**：限额是 `min(max, max(min, 预算÷权重和))`，
    // 下限高过上限时 `unit` 恒等于上限，"每章至少 N 字"就成了假话。
    // ⚠️ 兜底与 `lib/index.js` 的 `DEFAULTS.sample.minPerChapter` **同源于 `HOST_DEFAULTS`**
    //（`host/defaults.js`，2026-10-03）。"两处各写一份默认值"曾是这一仓库反复出现的形状，
    // 靠 `sampling.test.mjs` 那条"库侧兜底 == 配置缺省"的断言盯着；现在字面量只有一处，
    // 那条断言仍在 —— 它现在断言的是"两边都等于同一个来源"。
    const minPerChapter = options.minPerChapter ?? HOST_DEFAULTS.minPerChapter
    const maxPerChapter = options.maxPerChapter ?? HOST_DEFAULTS.maxPerChapter
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
    // ---- `lengthRatio`（按章长比例给额度）已于 2026-10-03 **整体退役** ----
    //
    // 它是"读厚"机制的另一半，读者在 2026-10 明确**收回**了那个机制（短章在比例模式下
    // 被截得比从前狠）。生产上它一直是 `0`（按预算均分），lib 里却还留着一条完整的
    // 比例分支 + 一整档守卫 + 一处 `?? 0` 兜底。
    // ⚠️ **配置项 `sample.lengthRatio` 仍然被接受，但不再有任何效果** —— 老
    // `settings.json` 里带着它不该报错，所以这里既不读也不校验（`options.lengthRatio`
    // 被完全忽略）。**降级是静默的，这一点必须如实**：想让"短章多给点"的人得改用
    // `minPerChapter` / `maxPerChapter`，没有"改一个数就打开"的路了。
    // 与上面「超长章自适应读厚」是同一轮退役、同一个理由：**没人再动的分支就是负债**。

    // ---- 超长章的自适应读厚（B 半边）已于 2026-10-03 **整体删除** ----
    //
    // 它伺候的是"4000–8000 保完整章、由取样侧按比例读厚"那一档。切分阈值降到 4000
    // 之后那一档**不存在了**：> 4000 的章在导入时就被切成子章（换行不够时
    // 用句末标点补齐，见 `chapters.js` 的 `planPieces`），子章各自拿一份均分额度，
    // 比整章按比例读厚**更深**。`isLongChapter` 只对"既没换行也没句末标点"的非散文
    // 章还能命中 —— 留着就是一条几乎走不到的分支 + 三个没人再动的配置项。
    // ⚠️ 阈值后来抬到 5000（4000–5000 的章又保完整了），**但这不改变上面这个结论**：
    //    保完整 ≠ 按比例读厚，那套机制没有回来的理由，也没有回来。
    // 一并删除：`longChapterThreshold` / `longChapterRatio` / `longMaxPerChapter`
    // （配置侧）与 `adaptiveOn` / `isLongChapter` / `longBaseOf`（这里）。

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

    // ---- 第一刀：本批最多包含多少章 ----
    let reach = to
    if (options.foundation === true) {
      reach = Math.min(reach, from + foundationChapters - 1)
    }

    // ---- 第二刀：预算装不下时，从**后往前**丢章 ----
    //
    // ⚠️ 这个循环按每章**真实的**额度累计成本（而不是按"下限 × 权重"反解），是
    // B 半边还在时的需要：那时超长章的真实额度比下限大（多到 5 倍），按 600 反解
    // 出来的批宽会把预算穿掉还不知情（实测：12 章 × 5069 字的书，旧刀给 10 章 /
    // 22,601 字 > 预算 12,000）。**B 删除后每章额度又是同一个 `unit` 了**，所以它
    // 与"按下限反解"在数学上重新等价 —— 但**刻意不改回去**：这条循环有逐字节对照
    // 测试钉着，换回旧形状是一次纯粹的重写，收益只有几行，风险是预算刀出错。
    // 装不下就从后往前丢章——丢章让 Σw 变小 ⇒ unit 变厚，剩下的章读得更深
    // （"两次就补完，第一次深"同一形状）。
    // ⚠️ 2026-10-03 `lengthRatio` 退役后这里**只剩一种形状**（按预算均分），
    //    从前那个"逐章算额度再累加"的 `else` 分支连同 `quotaOf` 一起删了。
    let unit = 0
    {
      let totalWeight = 0
      for (let index = from; index <= reach; index += 1) totalWeight += weightOf(index)
      unit = Math.min(maxPerChapter, Math.max(minPerChapter, Math.floor(budgetChars / totalWeight)))
      while (reach > from) {
        let cost = 0
        for (let index = from; index <= reach; index += 1) {
          cost += unit * weightOf(index)
        }
        if (cost <= budgetChars) break
        totalWeight -= weightOf(reach)
        reach -= 1
        unit = Math.min(maxPerChapter, Math.max(minPerChapter, Math.floor(budgetChars / totalWeight)))
      }
    }

    // `perChapter` 报出去的是**基准**字数（还没乘权重）。现在只有均分这一种形状 ⇒
    // 它就是那个单一的额度。（从前比例模式下每章不同，要取本批实际发出的最小值。）
    const perChapter = unit

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

      const allowance = unit * weightOf(index)
      let piece
      if (text.length <= allowance) {
        piece = text
      } else {
        // 头 60% / 尾 40%：铺垫与收束都要，重心略偏开头。
        // 两个切点都对齐到自然边界（头到句读之后、尾到段首），否则会切出半句话和断引号。
        const budgetHead = Math.floor(allowance * SAMPLE_HEAD_RATIO)
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
   * ⚠️ **章号越界也回空数组**（`chapterIndex < 0`、非整数，或超过本书章数）——
   * 这是**刻意的口径**，2026-10-01 三方评审问过一次，记在这里免得再被当成 bug：
   *   · 面板拿的可能是一份**过期目录**（书刚被重新切分过），越界不是"请求写错了"；
   *   · 这里唯一的消费者是"这一章你记过几条"，越界时正确答案就是 0 条；
   *   · 对比 `GET /chapters/:index` 越界回 `CHAPTER_NOT_FOUND`（404）——那里读者
   *     点名要**一章正文**，给不出内容就必须如实报错。**同一个"越界"，两个入口
   *     的正确答案不同**，所以口径不同是有意的，不是漏改。
   *   刻意**不校验上界**：那要读 `chapters.json`（多一次同步 IO），而结论一样是空数组。
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
    // ⚠️ 撞名必须另起一个，**不能直接写**（2026-10-02 三方评审 P1-4）：时间戳只到秒，
    //    同一秒第二次彻底删除会把上一代备份**覆盖**掉 —— 那份里正是"删掉之前更全的笔记"。
    //    与背景备份共用 `uniqueBackupPath`，不允许再各自写一份循环。
    const backupPath = uniqueBackupPath((seq) => (
      seq === 0 ? `${path}.bak.${stamp}.md` : `${path}.bak.${stamp}-${seq + 1}.md`
    ))
    atomicWriteText(backupPath, first)
    atomicWriteText(path, markdown)
    return { removed, backupPath }
  }

  /** 「文本锚」前后各取多少字符：够消歧，又不至于把标记行撑长。 */
  const ANCHOR_CONTEXT_CHARS = 32

  /**
   * 给一条带位置的笔记算「文本锚」（摘抄前后文 + 源文件指纹）。
   *
   * ## 为什么需要它
   *
   * 笔记的坐标是 `chapter` + `offset`（章内字符偏移），而 `chapters.json` 会因为
   * **重新切分**（`reindex`）或**重新导入**而变 —— 偏移会漂，重切分时连章号都可能
   * 移位。光靠数字没法判断"这条笔记原本指着哪一段"；附上摘抄**前后各一小段原文**
   * 之后，将来就能靠文本把它重新对回去。同一句话在书里出现两次时，前后文也是唯一
   * 的消歧依据。
   *
   * ## 为什么由宿主算、而不是客户端上报
   *
   * 偏移与正文都在宿主这一侧，客户端不必知道这些细节；而且**宿主才是"这份文本是
   * 什么"的权威**（`meta.sourceSha256`）。→ 客户端一行都不用改。
   *
   * ## 为什么不存摘抄原文本身（W3C TextQuoteSelector 的 `exact`）
   *
   * 摘抄就在笔记正文的引用块里。存第二遍 = 同一份内容有两处真相，而且两者会各自漂。
   * 重新定位时用「正文里的摘抄 + 这里的 `pre`/`post`」就够了。
   *
   * ⚠️ **宁缺不猜**：章号越界（书被重新切分过）或没有位置时，只返回能确定的那部分，
   * 绝不用"就近猜一个偏移"的办法把锚点写进文件。
   *
   * @param {object} meta 书的 meta
   * @param {string} bookId 书 id
   * @param {number|null} chapterIndex 章号（0 起）
   * @param {number|null} charOffset 章内字符偏移
   * @param {string} excerpt 摘抄（只用来算后文的起点）
   * @returns {{ sourceSha?: string, quotePrefix?: string, quoteSuffix?: string }}
   */
  function noteAnchor(meta, bookId, chapterIndex, charOffset, excerpt) {
    const sha = typeof meta?.sourceSha256 === 'string' ? meta.sourceSha256 : ''
    const anchor = sha === '' ? {} : { sourceSha: sha.slice(0, 12) }
    if (!Number.isInteger(chapterIndex) || !Number.isFinite(charOffset)) return anchor

    let chapterText = ''
    try {
      chapterText = readChapter(bookId, chapterIndex).text
    } catch {
      return anchor
    }
    const start = Math.max(0, Math.min(chapterText.length, Math.floor(charOffset)))
    const end = Math.max(start, Math.min(chapterText.length, start + String(excerpt).length))
    // 换行与连续空白折成一个空格：标记行是**单行**的，而且这些上下文只用来消歧，
    // 折行不影响它对不对得上（真正的比对字符是正文里的摘抄）。
    const tidy = (text) => text.replace(/\s+/g, ' ').trim()
    return {
      ...anchor,
      quotePrefix: tidy(chapterText.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start)),
      quoteSuffix: tidy(chapterText.slice(end, end + ANCHOR_CONTEXT_CHARS)),
    }
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
    const charOffset = Number.isFinite(note?.charOffset) ? note.charOffset : null

    return appendNote(notesPathFor(bookId), {
      bookTitle: meta.title,
      chapterIndex,
      chapterTitle: typeof note?.chapterTitle === 'string' ? note.chapterTitle : '',
      charOffset,
      excerpt,
      thought,
      reply: rawReply === '' ? null : rawReply,
      tags: note?.tags,
      ...noteAnchor(meta, bookId, chapterIndex, charOffset, excerpt),
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

    deleteDraft(draftsPath, draftId, bookId)
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
    // 索引损坏之后唯一的恢复入口：扫 `books/<bookId>/meta.json` 重建（见 rebuildIndex 的说明）。
    rebuildIndex,
    // 被挪走的坏文件清单（P2-2：`/health` 与书架都报它，读者侧的提示靠它）。
    storageQuarantined,
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
    // 冷归档：**整份覆盖但一字不删**（只把旧条目搬进「冷档案」），同一套 CAS + 备份保障。
    backgroundArchive,
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
    // ⚠️ `removeDraft` **必须带 bookId**：草稿表的键是全局 `draftId`，不带书就等于
    //    "任何一个 id 都能删掉任何一本书的草稿"（2026-10-02 三方评审 P2-4）。
    removeDraft: (bookId, draftId) => deleteDraft(draftsPath, draftId, bookId),
    // 清空重建的计数（补齐用它判断"我这一趟期间读者清空过吗"）。
    resetEpochOf,
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

