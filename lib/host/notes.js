/**
 * 结构化 Markdown 笔记（P3）。
 *
 * ## 三条硬约束
 *
 * 1. **只追加，永不重写既有内容。**
 *    实现方式是用 `appendFileSync`（`O_APPEND`）而不是"读全文 → 拼字符串 →
 *    原子写回"。后者在任何读-改-写竞态下都可能吞掉别的写入（另一个标签页、
 *    或者你用外部编辑器同时开着这个 md）。`O_APPEND` 根本不读文件，内核保证
 *    既有字节不被触碰——这是这条约束最强的实现，而不是"小心一点"。
 *
 * 2. **AI 回应默认不落盘。**
 *    `reply` 为空时，块里**根本不出现**「AI 回应」小节。所以"不落盘"不是靠
 *    调用方自觉少传字段，而是渲染层就没有那条路径。
 *
 * 3. **块可被机器读回。**
 *    每条笔记用 `<!-- drc-note:begin … -->` / `<!-- drc-note:end -->` 夹住，
 *    HTML 注释在渲染后的 Markdown 里不可见，但让 {@link parseNotes} 能稳定
 *    还原结构化数据——用户手改正文也不会破坏解析。
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { atomicWriteText, readJson, updateJson } from './atomic-json.js'
import { mergeTags, normalizeTags } from './tags.js'
import { chapterLabel } from './spoiler.js'

/** 笔记文件 schema 版本，写进头部注释。 */
export const NOTES_SCHEMA_VERSION = 1

/** 草稿库 schema 版本。 */
export const DRAFTS_SCHEMA_VERSION = 1

/** 笔记块的结束标记。 */
const END_MARKER = '<!-- drc-note:end -->'

/**
 * `notes.md` 的头部骨架。
 *
 * @param {string} title 书名
 * @returns {string}
 */
export function emptyNotesHeader(title, options = {}) {
  // ⚠️ 导出副本传 `schema: false`。这条机器标记是 `notes.md` **自己**解析与游标
  // 用的，导出文件里没有任何东西读它 —— 少一行机器码，读者在笔记软件里就少一分噪音。
  const schema = options.schema === false
    ? ''
    : `\n<!-- dsh-reading-companion:notes schema=${NOTES_SCHEMA_VERSION} -->`
  return `# ${title} · 读书笔记\n${schema}\n`
}

/**
 * 把属性对象渲染成 `k=v` 串。
 *
 * 值是书名/标题派生的，可能含空格，因此统一做 `%20` 转义——否则属性解析会在
 * 第一个空格处断开。`%` 自身先转义，避免往返丢失。
 *
 * @param {Record<string, string|number>} attrs 属性
 * @returns {string}
 */
function renderAttrs(attrs) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/%/g, '%25').replace(/\s/g, '%20')}`)
    .join(' ')
}

/**
 * 解析 `k=v` 属性串。
 *
 * @param {string} text 属性串
 * @returns {Record<string, string>}
 */
function parseAttrs(text) {
  const out = {}
  for (const piece of text.trim().split(/\s+/)) {
    const at = piece.indexOf('=')
    if (at <= 0) continue
    const key = piece.slice(0, at)
    const value = piece.slice(at + 1).replace(/%20/g, ' ').replace(/%25/g, '%')
    out[key] = value
  }
  return out
}

/**
 * 把一段文本渲染成 Markdown 引用块（每行加 `> `）。
 *
 * @param {string} text 原文
 * @returns {string}
 */
function quote(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * 渲染一条笔记的**标题行**：章节与 tag 合并到同一行。
 *
 * 形状是 `第16章 带子 #人设 #文笔`。三条规则：
 *
 *   - **有章节有 tag**：章节在前，tag 依次跟在后面，空格分隔。
 *   - **没有 tag**：只留章节名（`第16章 带子`）。
 *   - **这本书没有章节**（分块成"章"的纯文本、卷首一类）：连章节那部分一起
 *     省掉，只留 tag；tag 也没有时回落到 `读书笔记`——标题是块的骨架，空着会
 *     让整个 md 的结构散掉。
 *
 * 为什么不分两行：`notes.md` 是给人读的。一条笔记的第一行应该一眼说清
 * 「这是哪一章、我关心什么」；tag 单独占一行只是把正文推得更远。
 *
 * @param {number|null} chapterIndex 章序号（0 起）
 * @param {string} [chapterTitle] 章标题
 * @param {unknown} [tags] tag 列表
 * @returns {string}
 */
export function noteHeading(chapterIndex, chapterTitle, tags) {
  const parts = []
  if (Number.isInteger(chapterIndex)) parts.push(chapterLabel(chapterIndex, chapterTitle))
  for (const tag of normalizeTags(tags)) parts.push(`#${tag}`)
  return parts.length === 0 ? '读书笔记' : parts.join(' ')
}

/**
 * 渲染一条笔记块。
 *
 * @param {object} note 笔记
 * @param {string} note.excerpt 原文摘抄
 * @param {string} [note.thought] 我的感想
 * @param {string|null} [note.reply] AI 回应（为空则**整个小节不出现**）
 * @param {string[]} [note.tags] tag
 * @param {number} [note.chapterIndex] 章序号（从 0 起）
 * @param {string} [note.chapterTitle] 章标题
 * @param {string} [note.bookTitle] 书名（仅创建头部时用）
 * @param {number} [note.charOffset] 章内字符偏移
 * @param {string} [note.createdAt] ISO 时间
 * @param {string} [note.id] 笔记 id
 * @returns {string}
 */
export function renderNoteBlock(note) {
  const tags = normalizeTags(note?.tags)
  const id = typeof note?.id === 'string' && note.id !== '' ? note.id : randomUUID()
  const createdAt = typeof note?.createdAt === 'string' && note.createdAt !== ''
    ? note.createdAt
    : new Date().toISOString()

  const chapterIndex = Number.isInteger(note?.chapterIndex) ? note.chapterIndex : null

  const lines = [
    `<!-- drc-note:begin ${renderAttrs({
      id,
      created: createdAt,
      chapter: chapterIndex === null ? '' : chapterIndex,
      offset: Number.isFinite(note?.charOffset) ? note.charOffset : '',
      tags: tags.join(','),
    })} -->`,
    // 章节与 tag 同一行（tag 不再单独占一行），见 {@link noteHeading}。
    `### ${noteHeading(chapterIndex, note?.chapterTitle, tags)}`,
    '',
  ]

  if (note?.excerpt !== undefined && note.excerpt !== '') {
    lines.push(quote(note.excerpt), '')
  }

  if (note?.thought !== undefined && note.thought !== '') {
    lines.push(`**我的感想**：${String(note.thought).replace(/\r\n?/g, '\n').trim()}`, '')
  }

  // ⚠️ 这是「AI 回应默认不落盘」的落点：没有 reply 就**没有这个分支**，
  //    渲染出的块里不存在「AI 回应」四个字。
  if (note?.reply !== undefined && note.reply !== null && note.reply !== '') {
    lines.push(`**AI 回应**：${String(note.reply).replace(/\r\n?/g, '\n').trim()}`, '')
  }

  lines.push(END_MARKER)
  return lines.join('\n')
}

/**
 * 匹配一整条笔记块。
 *
 * 中间那段是**tempered greedy token**：块体里不允许再出现 `drc-note:begin`。
 * 没有这个约束，一条忘记写 `end` 的笔记会一路吞掉下一条的 `end`，
 * 于是后面所有笔记一起消失——用户只会在外部编辑器里少打一行，代价却是
 * 整份笔记列表空掉。
 *
 * 有了它，未闭合的块就是"匹配不上"，正则引擎会自行推进到下一个 `begin`，
 * 天然把坏块跳过。
 */
const NOTE_BLOCK_RE = /<!--\s*drc-note:begin\s+([^>]*?)-->((?:(?!<!--\s*drc-note:begin)[\s\S])*?)<!--\s*drc-note:end\s*-->/g

/**
 * 从标题行末尾按**已知 tag**精确剥掉 `#tag` 后缀。
 *
 * 面板已经用属性里的 `tags` 单独渲染一行，而新格式把 tag 也写进了标题行；
 * 不剥掉的话同一个标签会显示两次。
 *
 * 为什么不按空白切分、见到 `#` 就当 tag：tag 是用户手写的，中文 tag 完全正常
 * （`#人设`），而章节标题里也可能出现 `#`。只有属性里确实记着的那几个才算数，
 * 所以这里逐个 `endsWith` 匹配——精确、且不可能误伤章节名。
 *
 * @param {string} heading 标题行文本（不含 `### `）
 * @param {string[]} tags 已知 tag
 * @returns {string}
 */
function stripKnownTags(heading, tags) {
  let out = heading
  let changed = true
  // 循环是因为 `第16章 带子 #人设 #文笔` 要从尾部连剥两个。
  while (changed) {
    changed = false
    for (const tag of tags) {
      const suffix = `#${tag}`
      if (out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length).trimEnd()
        changed = true
      }
    }
  }
  return out
}

/**
 * 把一条笔记块的正文拆成「摘抄 / 感想 / 回应」三段。
 *
 * 面板要能**读**笔记，而不只是列出标题——否则用户记完就再也看不见内容了。
 * 这里刻意做得很宽容：用户在外部编辑器里改过格式（多一个空行、少一个星号）
 * 也不该让内容消失，所以顺序扫描 + 前缀识别，认不出来就归到当前段。
 *
 * @param {string} body 笔记块体（不含 begin/end 标记）
 * @param {string[]} [tags] 已知 tag（用于从标题行剥掉，见 {@link stripKnownTags}）
 * @returns {{ heading: string, excerpt: string, thought: string, reply: string }}
 */
function splitNoteBody(body, tags = []) {
  const headingMatch = body.match(/^###\s+(.*)$/m)
  const heading = stripKnownTags(headingMatch === null ? '' : headingMatch[1].trim(), tags)

  const excerptLines = []
  const thoughtLines = []
  const replyLines = []
  let mode = ''

  for (const raw of body.split('\n')) {
    const line = raw.trim()

    if (line.startsWith('**我的感想**')) {
      mode = 'thought'
      thoughtLines.push(line.replace(/^\*\*我的感想\*\*\s*[:：]?\s*/, ''))
      continue
    }
    if (line.startsWith('**AI 回应**')) {
      mode = 'reply'
      replyLines.push(line.replace(/^\*\*AI 回应\*\*\s*[:：]?\s*/, ''))
      continue
    }
    if (line.startsWith('###')) continue
    // tag 行形如 `` `#人设` `#文笔` ``，不属于任何正文段。
    if (line.startsWith('`#')) continue

    if (line.startsWith('>')) {
      mode = 'excerpt'
      excerptLines.push(line.replace(/^>\s?/, ''))
      continue
    }
    if (line === '') continue

    if (mode === 'thought') thoughtLines.push(line)
    else if (mode === 'reply') replyLines.push(line)
    else if (mode === 'excerpt') excerptLines.push(line)
  }

  const join = (lines) => lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return {
    heading,
    excerpt: join(excerptLines),
    thought: join(thoughtLines),
    reply: join(replyLines),
  }
}

/**
 * 从 `notes.md` 全文里解析出所有笔记。
 *
 * 用户可以在外部编辑器里改这个文件，所以解析必须宽容：标记不成对时跳过该块
 * 而不是抛错——半条笔记不该让整个列表打不开。
 *
 * @param {string} markdown 文件全文
 * @returns {Array<object>} 笔记数组
 */
export function parseNotes(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return []

  // 每次新建正则实例：带 `g` 的正则有 lastIndex 状态，共享一个实例会让
  // 重入调用互相踩。
  const re = new RegExp(NOTE_BLOCK_RE.source, 'g')
  const notes = []
  let match = re.exec(markdown)
  while (match !== null) {
    const attrs = parseAttrs(match[1])
    const body = match[2]
    const tags = normalizeTags((attrs.tags ?? '').split(','))
    const parts = splitNoteBody(body, tags)
    notes.push({
      id: attrs.id ?? '',
      createdAt: attrs.created ?? '',
      chapterIndex: attrs.chapter === undefined || attrs.chapter === '' ? null : Number.parseInt(attrs.chapter, 10),
      charOffset: attrs.offset === undefined || attrs.offset === '' ? null : Number.parseInt(attrs.offset, 10),
      tags,
      heading: parts.heading,
      // 面板要显示的三段。hasReply 判的是"回应段真的非空"，而不是"有没有那
      // 四个字"：用户在外部编辑器里删掉内容却留下小节标题时，不该还标成
      // 「含 AI 回应」。
      excerpt: parts.excerpt,
      thought: parts.thought,
      reply: parts.reply,
      hasReply: parts.reply !== '',
      // ⚠️ 刻意**不**返回整块原文（曾经有 `body` 字段）。
      //
      // 面板从来没用过它，但它和上面三段是**同一份内容的重复**：一条笔记的
      // 整块原文 ≈ excerpt + thought + reply 再加上标记行与标题。
      //
      // 实测（1000 条真实长度的笔记，三段都非空）：单条响应体 940 KB，其中
      // 488 KB 是它——**占了一半**。删掉没有任何信息损失：`excerpt`/`thought`/
      // `reply` 已经覆盖了用户能看见的全部内容，机器读取也只需要属性字段。
    })
    match = re.exec(markdown)
  }
  return notes
}

/**
 * 把笔记文件切成**原样的块**（连同 `<!-- drc-note:begin … -->` 与 `end` 一起）。
 *
 * ## 为什么需要它，而不是复用 {@link parseNotes}
 *
 * `parseNotes` 刻意把笔记拆成结构化字段（三段 + 属性），**它不返回整块原文**
 * ——那是有意的：整块原文与三段是同一份内容的重复，实测占了一半响应体。
 *
 * 但**导出**要的恰好是原文：导出必须逐字节搬运，不能"解析出来再重新渲染"。
 * 重新渲染会走过 `renderNoteBlock`，于是 tag 归一化、空白、标题行的组装都可能
 * 与用户磁盘上那份产生**无声的差异**——而"只追加、永不重写"是这个仓库对笔记
 * 的硬承诺，导出只是它的延伸，不能比它更松。
 *
 * 复用 `NOTE_BLOCK_RE` 是刻意的：格式只有一处定义，导出不会成为第二个真相。
 *
 * @param {string} markdown 文件全文
 * @returns {Array<{ id: string, raw: string }>} 原样块；`id` 为空表示手写块（无法去重）
 */
export function splitNoteBlocks(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return []
  const re = new RegExp(NOTE_BLOCK_RE.source, 'g')
  const blocks = []
  let match = re.exec(markdown)
  while (match !== null) {
    const attrs = parseAttrs(match[1])
    blocks.push({
      id: typeof attrs.id === 'string' ? attrs.id : '',
      raw: match[0],
    })
    match = re.exec(markdown)
  }
  return blocks
}

/**
 * 读笔记文件。
 *
 * @param {string} notesPath `notes.md` 绝对路径
 * @param {string} [title] 文件不存在时用于生成头部的书名
 * @returns {{ exists: boolean, markdown: string, notes: object[] }}
 */
export function readNotes(notesPath, title = '这本书') {
  let markdown = ''
  let exists = false
  try {
    markdown = readFileSync(notesPath, 'utf8')
    exists = true
  } catch {
    markdown = emptyNotesHeader(title)
  }
  return { exists, markdown, notes: parseNotes(markdown) }
}

/** `GET /notes` 的默认页大小。 */
export const NOTES_PAGE_DEFAULT = 10

/** `GET /notes` 允许的最大页大小——防止某个调用方一次把整个文件要走。 */
export const NOTES_PAGE_MAX = 200

/**
 * 把外部传入的 `limit` 夹到合法区间。
 *
 * 缺省/非法/非正数一律回落到默认值，而不是抛错：分页参数是**体验参数**，
 * 传错了只该"少给一点"，不该让笔记列表整个打不开。
 *
 * @param {unknown} value 原始 limit（通常来自 query string，是字符串）
 * @returns {number}
 */
function normalizePageLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return NOTES_PAGE_DEFAULT
  return Math.min(parsed, NOTES_PAGE_MAX)
}

/**
 * 为一条笔记生成它的"下一页从这里开始"游标。
 *
 * 正常情况游标就是笔记 id（由 {@link renderNoteBlock} 保证存在）。只有在
 * **手写的、没有 id 属性的块**上才回落到下标形式——否则 `nextCursor` 会是
 * 空串，被当成"没有游标"而回到第一页，表现为「加载更多」按钮点不动。
 *
 * @param {object} note 本页最后一条笔记
 * @param {number} nextIndex 下一页的起始下标
 * @returns {string}
 */
function cursorFor(note, nextIndex) {
  const id = typeof note?.id === 'string' ? note.id : ''
  return id === '' ? `at:${nextIndex}` : id
}

/**
 * 把游标解析成"下一页从哪个下标开始"。
 *
 * @param {object[]} ordered 全部笔记（新 → 旧）
 * @param {string|null} before 游标
 * @returns {{ start: number, reset: boolean }}
 */
function resolveCursor(ordered, before) {
  if (before === null) return { start: 0, reset: false }

  if (before.startsWith('at:')) {
    const at = Number.parseInt(before.slice(3), 10)
    if (Number.isInteger(at) && at >= 0 && at <= ordered.length) return { start: at, reset: false }
    return { start: 0, reset: true }
  }

  const at = ordered.findIndex((note) => note?.id === before)
  if (at === -1) return { start: 0, reset: true }
  return { start: at + 1, reset: false }
}

/**
 * 把笔记切成"新的在前"的一页。
 *
 * ## 为什么需要它
 *
 * 笔记全量返回在 1000 条时是 524 KB 的响应体，而面板**每次打开、每次保存
 * 草稿、每次写入笔记**都要重取一遍；更要命的是列表会把每条笔记的三段正文
 * 都渲染出来，于是 1000 条笔记 ≈ 7000+ 个元素参与每一次按键的重渲染。
 * 分页把这两件事一起按住。
 *
 * ## 为什么游标是 id 而不是下标
 *
 * 面板是"新的在前、向下加载更旧的"。若游标用下标，读者在翻页途中又写了一条
 * 新笔记（新笔记插在**头部**），下标会整体后移一位，下一页就会**重复**上一页
 * 的最后一条。用"最后一条已加载笔记的 id"作锚点，向头部追加不影响它。
 *
 * 锚点找不到（笔记被外部编辑器删了，或 id 被改了）说明文件已经变了。此时
 * 返回第一页并置 `reset: true`——让面板**替换**而不是追加，比悄悄产生重复好。
 *
 * ## 为什么在宿主侧 reverse
 *
 * 面板要"新的在前"。这个次序**必须在宿主侧定下来**，因为客户端一旦在渲染里
 * 写 `notes.slice().reverse()`，每次渲染都会产生一个新数组，把子组件的
 * `memo` 全部打掉——那正是这次改动的另一半目的。
 *
 * @param {object[]} notes 全部笔记（文件顺序：旧 → 新）
 * @param {{ limit?: unknown, before?: string|null }} [options] 分页参数
 * @returns {{ notes: object[], total: number, hasMore: boolean,
 *             nextCursor: string|null, reset: boolean }}
 */
export function paginateNotes(notes, options = {}) {
  const all = Array.isArray(notes) ? notes : []
  const ordered = all.slice().reverse()

  const limit = normalizePageLimit(options.limit)
  const rawBefore = options.before
  const before = typeof rawBefore === 'string' && rawBefore !== '' ? rawBefore : null

  const { start, reset } = resolveCursor(ordered, before)
  const page = ordered.slice(start, start + limit)
  const consumed = start + page.length
  const hasMore = consumed < ordered.length
  const last = page[page.length - 1]

  return {
    notes: page,
    // total 是**全部**笔记数，不是本页条数——面板要用它显示「已落盘的笔记（N）」。
    total: ordered.length,
    hasMore,
    nextCursor: hasMore && last !== undefined ? cursorFor(last, consumed) : null,
    // 仅在游标失效时为 true，见上面的说明。
    reset,
  }
}

/**
 * 追加一条笔记。
 *
 * @param {string} notesPath `notes.md` 绝对路径
 * @param {object} note 笔记（见 {@link renderNoteBlock}）
 * @returns {{ created: boolean, id: string }}
 */
export function appendNote(notesPath, note) {
  const id = typeof note?.id === 'string' && note.id !== '' ? note.id : randomUUID()
  const block = renderNoteBlock({ ...note, id })

  if (!existsSync(notesPath)) {
    // 首次：连头部一起原子写。此刻文件还不存在，所以"重写"无从谈起。
    atomicWriteText(notesPath, `${emptyNotesHeader(note?.bookTitle ?? '这本书')}\n${block}\n`)
    return { created: true, id }
  }

  // O_APPEND：不读、不改既有字节，内核保证追加落在文件末尾。
  // 这比任何"读全文再写回"都更可靠——它连丢失一次并发写入的机会都没有。
  appendFileSync(notesPath, `\n${block}\n`, 'utf8')
  return { created: false, id }
}

//#region 草稿
//
// 草稿是「摘抄 + 感想」在落盘成正式笔记之前的暂存区。
//
// 它存在的原因正是那条约束：读者写完感想要先发给 AI、拿到回应，**之后**才
// 决定要不要把这条记进笔记。这中间可能隔了几分钟甚至一次页面刷新，
// 所以必须持久化，而不能只放在组件 state 里。

/**
 * 读草稿库。
 *
 * @param {string} draftsPath `drafts.json` 绝对路径
 * @returns {Record<string, object>}
 */
export function readDrafts(draftsPath) {
  const { value } = readJson(draftsPath, null)
  const drafts = value?.drafts
  return drafts !== null && typeof drafts === 'object' ? drafts : {}
}

/**
 * 新建或更新一条草稿。
 *
 * @param {string} draftsPath `drafts.json` 绝对路径
 * @param {object} draft 草稿字段
 * @returns {object} 落盘后的草稿
 */
export function upsertDraft(draftsPath, draft) {
  const bookId = String(draft?.bookId ?? '')
  if (bookId === '') throw new Error('DRAFT_BOOK_INVALID')

  const draftId = typeof draft?.draftId === 'string' && draft.draftId !== '' ? draft.draftId : randomUUID()
  const now = new Date().toISOString()

  let saved = null
  updateJson(draftsPath, {
    fallback: { schemaVersion: DRAFTS_SCHEMA_VERSION, drafts: {} },
    mutate: (current) => {
      const drafts = current !== null && typeof current === 'object' && typeof current.drafts === 'object' && current.drafts !== null
        ? current.drafts
        : {}
      const previous = drafts[draftId] ?? {}
      saved = {
        draftId,
        bookId,
        chapterIndex: Number.isInteger(draft?.chapterIndex) ? draft.chapterIndex : (previous.chapterIndex ?? null),
        chapterTitle: typeof draft?.chapterTitle === 'string' ? draft.chapterTitle : (previous.chapterTitle ?? ''),
        charOffset: Number.isFinite(draft?.charOffset) ? draft.charOffset : (previous.charOffset ?? null),
        excerpt: typeof draft?.excerpt === 'string' ? draft.excerpt : (previous.excerpt ?? ''),
        thought: typeof draft?.thought === 'string' ? draft.thought : (previous.thought ?? ''),
        // reply 允许被显式置空：用户可能先贴了回应又决定不写进去。
        reply: draft?.reply === undefined ? (previous.reply ?? null) : (draft.reply === null ? null : String(draft.reply)),
        tags: mergeTags(draft?.tags, previous.tags),
        createdAt: previous.createdAt ?? now,
        updatedAt: now,
      }
      return {
        schemaVersion: DRAFTS_SCHEMA_VERSION,
        drafts: { ...drafts, [draftId]: saved },
      }
    },
  })

  return saved
}

/**
 * 删掉一条草稿。
 *
 * @param {string} draftsPath `drafts.json` 绝对路径
 * @param {string} draftId 草稿 id
 * @returns {boolean} 是否确实删掉了
 */
export function deleteDraft(draftsPath, draftId) {
  let removed = false
  updateJson(draftsPath, {
    fallback: { schemaVersion: DRAFTS_SCHEMA_VERSION, drafts: {} },
    mutate: (current) => {
      const drafts = current !== null && typeof current === 'object' && typeof current.drafts === 'object' && current.drafts !== null
        ? { ...current.drafts }
        : {}
      if (Object.hasOwn(drafts, draftId)) {
        delete drafts[draftId]
        removed = true
      }
      return { schemaVersion: DRAFTS_SCHEMA_VERSION, drafts }
    },
  })
  return removed
}

/**
 * 列出某本书的草稿（新的在前）。
 *
 * @param {string} draftsPath `drafts.json` 绝对路径
 * @param {string} bookId 书 id
 * @returns {object[]}
 */
export function listDrafts(draftsPath, bookId) {
  const all = readDrafts(draftsPath)
  return Object.values(all)
    .filter((draft) => draft?.bookId === bookId)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}
