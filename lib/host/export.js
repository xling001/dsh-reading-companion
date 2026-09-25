/**
 * 把一本书的可读产物导出成**一组可以直接丢进笔记软件的文件**。
 *
 * ## 它解决什么问题
 *
 * 陪读文件夹是按书隔离的（`陪读_<书名>/`），但**里面的文件名是通用的**：
 * `notes.md`、`background.md`。文件夹一离开它自己的目录（例如被汇进 Obsidian
 * 的 vault），身份就丢了 —— 两本小说的笔记都叫 `notes`，只能手工改名。
 *
 * 导出让**文件名自带书名**，于是复制出去就是成品。
 *
 * ## 三条硬规矩
 *
 * 1. **不动内建文件。** `notes.md` / `background.md` / `persona.md` 的名字与内容
 *    一个字节都不改。导出是**纯加法**，所以老数据不需要任何迁移。
 * 2. **绝不重写别人的文件。** 每个导出文件头部埋一条 `<!-- drc-export book=… -->`
 *    标记。目标已存在时：有标记且是**同一本书** → 按既定语义更新；有标记但是
 *    **别的书** → 拒绝；**没有任何标记** → 拒绝。往一个来路不明的 `.md` 里追加，
 *    正是会毁掉用户现有笔记的那种操作。
 * 3. **笔记按 id 增量追加，绝不覆盖。** 用户在 Obsidian 侧写的批注、加的双链、
 *    改的措辞，一个字都不会被碰 —— 只把目标里**还没有的**块追加到文件末尾。
 *
 * ## 两类文件的语义不同，这是刻意的
 *
 * - **笔记**是用户写字的地方 → 只追加（见上）。
 * - **背景认识**是插件生成的派生物（"条目只增不减"由插件保证）→ **整份快照**。
 *   它没有稳定 id（插件内部去重靠条目文本本身），要"增量"就得往 `### 主体`
 *   底下插入 —— 那是中间插入等于重写整个文件，反而会动到用户改过的地方。
 *
 * ## 压缩前的历代备份
 *
 * 压缩是**唯一会删内容**的一步，而那份认识的价值超出"喂给 AI"（梳理角色经历、
 * 时间线、走过的地方都要靠它）。所以插件侧每次压缩留一代带时间戳的备份，
 * 导出时**一代不漏地跟出去**：`书名-背景-压缩前-<时间戳>.md`，**一代一个文件**。
 *
 * ⚠️ **源时间戳进目标名**，所以重复导出天然幂等：同一代永远写到同一个目标名上，
 * 不会越导越多。**目录里没有"固定名"那一份** —— 早先版本额外写过一个
 * `书名-背景-压缩前.md` 当作"最新一代的稳定入口"，代价是最新那代在目录里出现两次
 * （读者一压缩就实测到了，要求去掉）。时间戳本身可排序（`yyyyMMdd-HHmmss`），
 * 所以"最新"按文件名排序就是最后一个，那个入口的值抵不上这份重复。
 *
 * ## 落在哪里
 *
 * 所有文件写进 `<导出根>/陪读导出_<书名>/`，**不再平铺在导出根里**：导出根通常就是
 * 会话工作区根，而一本书的文件会随压缩代数长到十几个，平铺会把它淹掉。同名书的
 * 消歧规则与 `陪读_<书名>` 一致（后到者加 `_<bookId 前 6 位>`）。
 *
 * ⚠️ **文件夹名与文件名都带书名，是刻意的双保险**：文件夹让一本书自成一块；文件名
 * 保证"从文件夹里单拿一个文件出去"（比如拖进 Obsidian 的另一个目录）也不丢身份
 * —— 那正是这个功能最初的诉求。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { emptyNotesHeader, splitNoteBlocks } from './notes.js'

/** 导出文件夹的前缀，与陪读文件夹的 `陪读_` 同一套风格。 */
export const EXPORT_DIR_PREFIX = '陪读导出_'

/** 归属标记的名字。用 HTML 注释是刻意的：渲染器不显示它，原文里它在。 */
const MARKER_NAME = 'drc-export'

/** 只匹配不捕获，够用且不会被 `>` 之类的字符带偏。 */
const MARKER_RE = /<!--\s*drc-export\s+([^>]*?)-->/

/**
 * 渲染归属标记。
 *
 * ⚠️ **刻意只放 `book` 与 `generated` 两个值**，不放书名：书名是用户可控的自由
 * 文本，可能带 `>`、`--`，塞进注释里会让标记解析变得脆弱。书名从书元信息取即可，
 * 它本来就不需要出现在文件内容里（它已经在文件名上了）。
 *
 * @param {string} bookId
 * @param {string} [generatedAt] ISO 时间
 * @returns {string}
 */
export function renderExportMarker(bookId, generatedAt = new Date().toISOString()) {
  return `<!-- ${MARKER_NAME} book=${bookId} generated=${generatedAt} -->`
}

/**
 * 解析归属标记。
 *
 * 除了两个字段，还回**标记原文** (`raw`)：更新既有文件时要原样复用它，见
 * `runExport` 里关于幂等的说明。
 *
 * @param {string} markdown
 * @returns {{ bookId: string, generated: string, raw: string }|null} 没有标记或标记不完整时回 null
 */
export function parseExportMarker(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return null
  const matched = MARKER_RE.exec(markdown)
  if (matched === null) return null
  const attrs = {}
  for (const part of matched[1].split(/\s+/)) {
    const at = part.indexOf('=')
    if (at > 0) attrs[part.slice(0, at)] = part.slice(at + 1)
  }
  const bookId = typeof attrs.book === 'string' && attrs.book !== '' ? attrs.book : null
  if (bookId === null) return null
  return { bookId, generated: attrs.generated ?? '', raw: matched[0] }
}

/**
 * 判定一个目标文件能不能被这次导出动。
 *
 * 这是**全模块唯一的写入许可判定**，两个拒绝分支都是有意的：
 *
 *   - `TARGET_OTHER_BOOK`：两本同名书导出到同一目录时，谁也不能踩谁。
 *   - `TARGET_NOT_OURS`：**这是最要紧的一条**。用户可能把一个已经写满内容的
 *     `.md` 放在同名位置，往里追加就是在毁他的东西。宁可报错让他改名/换目录。
 *
 * @param {{ existingText: string|null, bookId: string }} input `null` = 文件不存在
 * @returns {{ ok: true, mode: 'create'|'update' }|{ ok: false, reason: string, owner?: string }}
 */
export function decideExportTarget({ existingText, bookId }) {
  if (existingText === null) return { ok: true, mode: 'create' }
  const marker = parseExportMarker(existingText)
  if (marker === null) return { ok: false, reason: 'TARGET_NOT_OURS' }
  if (marker.bookId !== bookId) return { ok: false, reason: 'TARGET_OTHER_BOOK', owner: marker.bookId }
  return { ok: true, mode: 'update' }
}

/**
 * 算出一份笔记导出要追加哪些块（纯函数）。
 *
 * ⚠️ **没有 id 的块不追加，并且要报出来。** 手写块没有 `id` 属性（读笔记那边
 * 的游标也是因此退化成下标的），没有 id 就没有"这条已经导过了"的判据 ——
 * 硬追加会在你每次导出时复制一遍。静默丢掉也不行，所以调用方必须把
 * `skippedNoId` 显示给用户。
 *
 * @param {string} sourceMarkdown 书库里的 `notes.md`
 * @param {string} targetMarkdown 目标文件现有内容（不存在时传空串）
 * @returns {{ missing: Array<{id: string, raw: string}>, sourceCount: number, skippedNoId: number }}
 */
export function mergeExportedNotes(sourceMarkdown, targetMarkdown) {
  const sourceBlocks = splitNoteBlocks(sourceMarkdown)
  const targetIds = new Set(
    splitNoteBlocks(targetMarkdown).map((block) => block.id).filter((id) => id !== ''),
  )
  const missing = []
  let skippedNoId = 0
  for (const block of sourceBlocks) {
    if (block.id === '') {
      skippedNoId += 1
      continue
    }
    if (!targetIds.has(block.id)) missing.push(block)
  }
  return { missing, sourceCount: sourceBlocks.length, skippedNoId }
}

/**
 * 读出文件内容；不存在回 `null`（**与"空文件"区分开**：空文件是有主人的）。
 *
 * @param {string} path
 * @returns {string|null}
 */
function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 读出文件原始字节；不存在回 `null`。
 *
 * 背景与历代备份走字节级搬运（前缀插一行标记），**不经过字符串往返** ——
 * 那两者本来就是"原件的副本"，任何转码/换行归一化都是不该发生的事。
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
 * 挑一个目标文件名。
 *
 * 默认是 `<书名><后缀>`；首选名被别的书（或来路不明的文件）占着时，把消歧后缀
 * `_<bookId 前 6 位>` **插在书名之后**，而不是甩到最末尾：
 *
 *   - 好：`魔女霓裳_a1b2c3-笔记.md`、`魔女霓裳_a1b2c3-背景.md` —— 同一本书的文件
 *     在笔记库里仍然排在一起，前缀一眼就是同一本。
 *   - 差：`魔女霓裳-笔记_a1b2c3.md` —— 按名排序时它和别的书的 `…-笔记` 混在一起，
 *     恰好把这个功能想解决的问题又还回来了。
 *
 * @param {string} dir 导出目录
 * @param {string} title 已经过清洗的书名片段
 * @param {string} suffix 形如 `-笔记.md`
 * @param {string} bookId
 * @returns {{ name: string, disambiguated: boolean }}
 */
export function pickExportName(dir, title, suffix, bookId) {
  const plain = `${title}${suffix}`
  const plainPath = join(dir, plain)
  if (!existsSync(plainPath)) return { name: plain, disambiguated: false }
  const marker = parseExportMarker(readIfExists(plainPath) ?? '')
  if (marker !== null && marker.bookId === bookId) return { name: plain, disambiguated: false }
  return { name: `${title}_${bookId.slice(0, 6)}${suffix}`, disambiguated: true }
}

/**
 * 造一个带错误码的导出错误，供路由层映射 HTTP 状态。
 *
 * ⚠️ **码要写进 message 前缀**：路由层的 `guarded()` 是从 `message.split(':')[0]`
 * 取码的（`IMPORT_REJECTED:` / `BOOK_NOT_FOUND:` 都是这个形状）。只设 `error.code`
 * 而不带前缀，映射就落不到，最后会变成一个没有信息的 500。
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function exportError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/**
 * 写文件，但**内容没变就不写**。
 *
 * 不写是刻意的：写一次就动一次 mtime，而被动的正是 Obsidian / 同步工具要重新
 * 索引的那个信号。重复导出"什么都没发生"应该真的什么都不发生。
 *
 * @param {string} path
 * @param {string|Buffer} content
 * @returns {boolean} 是否真的写了
 */
function writeIfChanged(path, content) {
  const before = readBytesIfExists(path)
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  if (before !== null && before.equals(next)) return false
  writeFileSync(path, next)
  return true
}

/**
 * 跑一次导出。
 *
 * 调用方（`library.exportBook`）负责把**源内容**取好传进来，这个函数只做
 * 判定与落盘，所以它可以被单测直接驱动，不必起一整套书库。
 *
 * @param {object} spec
 * @param {string} spec.bookId
 * @param {string} spec.title 已经过清洗的书名片段
 * @param {string} spec.targetDir **导出根**（用户选的那个）；真正写入的是它下面的
 *   `陪读导出_<书名>/`，见 {@link resolveExportDir}
 * @param {string|null} spec.notesMarkdown 源 `notes.md` 内容（没有则 null）
 * @param {Buffer|null} spec.backgroundBytes 源 `background.md` 原始字节
 * @param {Array<{ stamp: string, bytes: Buffer }>} spec.backups 历代备份（按时间升序）
 * @param {string} [spec.now] ISO 时间（注入以便可测）
 * @returns {{ dir: string, files: Array<object>, notes: object, warnings: string[] }}
 *   `dir` 是**实际写入的文件夹**（不是导出根）—— 调用方要把它显示给用户，
 *   显示导出根会让人找错地方。
 */
export function runExport(spec) {
  const {
    bookId,
    title,
    targetDir,
    notesMarkdown,
    backgroundBytes,
    backups,
    now = new Date().toISOString(),
  } = spec

  // 每本书一个文件夹（见文件头"落在哪里"）。身份由文件夹名与文件名共同承担。
  const dir = resolveExportDir(targetDir, title, bookId)
  mkdirSync(dir, { recursive: true })

  const markerLine = `${renderExportMarker(bookId, now)}\n`
  const files = []
  const warnings = []
  const notesStat = { appended: 0, sourceCount: 0, skippedNoId: 0, written: false }

  /**
   * 统一的"挑名 → 判定许可 → 落盘"三步，避免几条分支各写一遍。
   *
   * ## 为什么更新既有文件时要**复用原来的标记**
   *
   * 标记里带着 `generated=<导出时间>`。如果每次都写一个新的时间戳，那么"源内容一字
   * 未变"的第二次导出，产出仍然与前一次**不同** —— `writeIfChanged` 会认为变了、
   * 写一遍、动一次 mtime，于是"重复导出什么都不该发生"这条性质当场失效（而 mtime
   * 正是 Obsidian / 同步工具重新索引的信号）。
   *
   * 所以 `generated` 的语义定为**首次导出时间**：更新时原样复用旧标记。想判断内容
   * 新旧，看内容本身（源变了，字节自然会变）。
   *
   * @param {string} suffix 形如 `-背景.md`
   * @param {Buffer} body 源文件的原始字节（不含标记）
   * @returns {{ target: string, existingText: string|null, written: boolean }}
   */
  const place = (suffix, body) => {
    const picked = pickExportName(dir, title, suffix, bookId)
    if (picked.disambiguated) {
      warnings.push(`${title}${suffix} 已被别的书或别的文件占用，本次写到 ${picked.name}`)
    }
    const target = join(dir, picked.name)
    const existingText = readIfExists(target)

    // 背景与历代备份**必须**落在本插件导出的文件上：它们没有"追加"的语义，
    // 落错地方就是整份覆盖。
    const decision = decideExportTarget({ existingText, bookId })
    if (!decision.ok) {
      if (decision.reason === 'TARGET_OTHER_BOOK') {
        throw exportError('EXPORT_REJECTED', `${picked.name} 是另一本书（${decision.owner}）的导出文件，已拒绝`)
      }
      throw exportError('EXPORT_REJECTED', `${picked.name} 不是本插件导出的文件，已拒绝写入（换一个导出目录，或先把它改名/移走）`)
    }

    const existingMarker = existingText === null ? null : parseExportMarker(existingText)
    const head = Buffer.from(`${existingMarker === null ? markerLine : `${existingMarker.raw}\n`}`, 'utf8')

    const written = writeIfChanged(target, Buffer.concat([head, body]))
    files.push({
      name: picked.name,
      target,
      action: existingText === null ? 'create' : (written ? 'update' : 'unchanged'),
      bytes: head.byteLength + body.byteLength,
    })
    return { target, existingText, written }
  }

  // ---- 笔记：只追加，绝不重写既有字节 ----
  if (typeof notesMarkdown === 'string' && notesMarkdown !== '') {
    const picked = pickExportName(dir, title, '-笔记.md', bookId)
    if (picked.disambiguated) {
      warnings.push(`${title}-笔记.md 已被占用，本次写到 ${picked.name}`)
    }
    const target = join(dir, picked.name)
    const existingText = readIfExists(target)

    if (existingText !== null) {
      const decision = decideExportTarget({ existingText, bookId })
      if (!decision.ok) {
        throw exportError('EXPORT_REJECTED', decision.reason === 'TARGET_OTHER_BOOK'
          ? `${picked.name} 是另一本书（${decision.owner}）的导出文件，已拒绝`
          : `${picked.name} 不是本插件导出的文件，已拒绝写入`)
      }
    }

    const merge = mergeExportedNotes(notesMarkdown, existingText ?? '')
    notesStat.sourceCount = merge.sourceCount
    notesStat.appended = merge.missing.length
    notesStat.skippedNoId = merge.skippedNoId
    if (merge.skippedNoId > 0) {
      warnings.push(`有 ${merge.skippedNoId} 条笔记没有 id 属性（手写的块），无法判断是否已导出，本次跳过`)
    }

    let content
    if (existingText === null) {
      const blocks = merge.missing.map((block) => block.raw).join('\n\n')
      content = `${markerLine}${emptyNotesHeader(title, { schema: false })}\n${blocks}${blocks === '' ? '' : '\n'}`
    } else if (merge.missing.length > 0) {
      const blocks = merge.missing.map((block) => block.raw).join('\n\n')
      // 纯追加：既有字节一个都不动。
      content = `${existingText.replace(/\n*$/, '\n')}\n${blocks}\n`
    } else {
      content = existingText
    }

    const written = writeIfChanged(target, content)
    notesStat.written = written
    files.push({
      name: picked.name,
      target,
      action: existingText === null ? 'create' : (written ? 'append' : 'unchanged'),
      bytes: Buffer.byteLength(content, 'utf8'),
    })
  }

  // ---- 背景认识：整份快照（它是插件生成的派生物，语义见文件头） ----
  if (Buffer.isBuffer(backgroundBytes)) {
    place('-背景.md', backgroundBytes)
  }

  // ---- 压缩前的历代备份：一代一个文件，只有时间戳名 ----
  //
  // ⚠️ 这里**故意不再**额外写一份"固定名"（`…-背景-压缩前.md`）当稳定入口：
  // 那会让最新那代在目录里出现两次，而时间戳可排序、"最新"按名排序即最后一个，
  // 入口不值这份重复。读者实测到重复后要求去掉（见文件头）。
  if (Array.isArray(backups) && backups.length > 0) {
    const ordered = [...backups].sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0))
    for (const backup of ordered) {
      place(`-背景-压缩前-${backup.stamp}.md`, backup.bytes)
    }
  }

  return { dir, files, notes: notesStat, warnings }
}

/**
 * 解析这本书的导出文件夹：`<导出根>/陪读导出_<书名>/`。
 *
 * ## 同名书消歧
 *
 * 与 `陪读_<书名>` 同一套：两本不同书同名时，后到者加 `_<bookId 前 6 位>`。
 * 判据是"这个文件夹里有没有**本书的**导出文件"（认 `drc-export` 标记），
 * 而不是只看文件夹名 —— 名字可能已经被别的书占了。
 *
 * ⚠️ 文件夹存在、但里面**没有**任何可识别的导出文件时**照用**：那种情况下不存在
 * "两本书被混在一起"的风险（没有别书的标记），而且我们只会往里写自己那几个名字，
 * 文件一级还有一道拒绝兜底（见 `place`）。
 *
 * @param {string} root 用户选的导出根
 * @param {string} title 已清洗的书名片段
 * @param {string} bookId
 * @returns {string} 实际写入的文件夹绝对路径
 */
export function resolveExportDir(root, title, bookId) {
  const plain = join(root, `${EXPORT_DIR_PREFIX}${title}`)
  if (!existsSync(plain)) return plain
  const owner = dirOwner(plain)
  if (owner === null || owner === bookId) return plain
  return join(root, `${EXPORT_DIR_PREFIX}${title}_${bookId.slice(0, 6)}`)
}

/**
 * 这个文件夹里的导出文件属于哪本书。
 *
 * @param {string} dir
 * @returns {string|null} bookId；一个可识别的导出文件都没有时回 null
 */
function dirOwner(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const marker = parseExportMarker(readIfExists(join(dir, name)) ?? '')
    if (marker !== null) return marker.bookId
  }
  return null
}
