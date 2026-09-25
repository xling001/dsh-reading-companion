/**
 * 讨论历史（`discussions.jsonl`）。
 *
 * ## 它不做什么
 *
 * **它不是对话历史的副本。** 陪读会话本身就有完整的对话，把它再存一份、再投喂
 * 回去，是纯粹的 token 浪费。这个模块刻意只存**摘要**，每条几十字。
 *
 * ## 它做什么
 *
 * 三件事，都是会话本身给不了的：
 *
 * 1. **时间感知**。"距上次和这位读者聊这本书过去了多久"需要一个跨会话、跨重启
 *    的时间戳。会话消息里有时间，但读取它要依赖会话内部结构；这里一行记录
 *    就够，且不依赖任何宿主契约。
 * 2. **换绑/重建后的最低连续性**。会话被重建、或书被换绑到另一个会话之后，
 *    AI 至少知道"我们聊过哪几章的什么话题"。
 * 3. **上下文被压缩后的时间线**。长会话的老轮次会掉出上下文，而这条时间线不会。
 *
 * ## 为什么是 JSONL
 *
 * 一行一条，追加不会破坏已有内容，坏了也只有一行坏。
 * 而"只追加"正好对上我们的缓存目标——时间线是动态区的一部分，但**前缀稳定**
 * 意味着往同一个方向增长，比反复重写更友好。
 *
 * ⚠️ **"前缀稳定"只到满仓为止。** `MAX_DISCUSSIONS` 一到，每写一条就要丢掉
 * 最旧一条，整份文件整体位移，于是从第 `MAX_DISCUSSIONS + 1` 条起，每一轮
 * 装配看到的都是不同的文本，"你们之前聊过"那一块永远不命中缓存。这是这个
 * 上限的**真实代价**，不是可以忽略的细节——换上限之前先读这一段。
 * 在这个上限之内，`appendDiscussion` 走 `O_APPEND`（见该函数的注释）。
 *
 * ## 为什么放在插件目录而不是陪读文件夹
 *
 * 它是**机器数据**，不是给人读的东西——按既定约定（`notes.md` / `background.md`
 * 走工作区，其余留插件目录）它不该占用用户的工作区。
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { atomicWriteText } from './atomic-json.js'

/** 记录的来源。 */
export const DISCUSSION_KINDS = Object.freeze(['note', 'sent', 'reply'])

/**
 * 默认保留的最大条数。
 *
 * 需要封顶的理由很实际：文件无限增长会让每次"读最近几条"都变成整文件解析。
 * 200 条覆盖相当长的阅读周期，而单条只有几十字。
 */
export const MAX_DISCUSSIONS = 200

/**
 * 单次读取的默认条数。
 *
 * 刻意和面板显示的条数**分开**：调用方可以要一页多的（比如以后做"看全部"），
 * 面板自己决定一次显示几条。
 */
export const DISCUSSIONS_LIMIT_DEFAULT = 20

/**
 * 单次读取的硬上限。
 *
 * 就等于落盘上限——读比存的还多没有意义。存在的理由是 `limit` 来自 URL，
 * 是**外部输入**：不夹住的话一个 `?limit=100000` 会让宿主把整份文件切片、
 * 序列化、再回传。落盘侧的第二道防线不该被当成唯一一道。
 */
export const DISCUSSIONS_LIMIT_MAX = MAX_DISCUSSIONS

/**
 * 把外部传进来的 `limit` 归一化成一个**安全**的条数。
 *
 * 抽成纯函数是为了能直接测：内联在路由里的话，"夹上限"这条性质就只能靠
 * 造 200 条以上记录去间接观察，而那种测试跑一遍要几百次写盘。
 *
 * 三种非法输入全部回落到默认值，而不是报错：`?limit=abc`（解析不出整数）、
 * `?limit=0` / `?limit=-5`（非正数）、以及缺失。回落的理由是这一类参数属于
 * "调用方想少要一点"的提示，为它中断一次读取不成比例。
 *
 * @param {unknown} raw 原始值（URL 字符串、数字，或任意垃圾）
 * @param {number} [fallback] 非法时用哪个值
 * @returns {number} `1 … DISCUSSIONS_LIMIT_MAX` 之间的整数
 */
export function normalizeDiscussionLimit(raw, fallback = DISCUSSIONS_LIMIT_DEFAULT) {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, DISCUSSIONS_LIMIT_MAX)
}

/**
 * 单条摘要字段的截断长度。
 *
 * 讨论历史的价值在"聊过什么话题"，不在"原话是什么"。原话在 `notes.md` 里
 * 完整存着——这里存全文只会让文件膨胀，而信息是重复的。
 */
const FIELD_LIMIT = 240

/**
 * 把任意输入归一化成一条讨论记录。
 *
 * 无法解析出时间时**回落到当前时间**，而不是丢弃：一条时间不准的记录，
 * 也胜过"我明明记过这一条，历史里却没有"。
 *
 * @param {unknown} input 原始输入
 * @param {object} [options]
 * @param {string} [options.now] 当前时间（ISO），便于单测固定
 * @returns {object|null} 归一化后的记录；输入无意义时 null
 */
export function normalizeDiscussion(input, options = {}) {
  if (input === null || typeof input !== 'object') return null

  const kind = DISCUSSION_KINDS.includes(input.kind) ? input.kind : 'note'
  const at = typeof input.at === 'string' && Number.isFinite(Date.parse(input.at))
    ? input.at
    : (options.now ?? new Date().toISOString())

  const chapterIndex = Number.isInteger(input.chapterIndex) && input.chapterIndex >= 0
    ? input.chapterIndex
    : null

  const clip = (value) => {
    if (typeof value !== 'string') return ''
    const trimmed = value.trim()
    return trimmed.length > FIELD_LIMIT ? `${trimmed.slice(0, FIELD_LIMIT)}…` : trimmed
  }

  const record = {
    at,
    kind,
    chapterIndex,
    chapterTitle: clip(input.chapterTitle).slice(0, 80),
    excerpt: clip(input.excerpt),
    thought: clip(input.thought),
    reply: clip(input.reply),
  }

  // 全空的记录没有任何信息量，只会污染时间线。
  if (record.excerpt === '' && record.thought === '' && record.reply === '' && record.chapterIndex === null) {
    return null
  }
  return record
}

/**
 * 解析 JSONL。
 *
 * **坏行跳过，不抛错。** 这个文件是追加写的，最可能坏的方式就是最后一行写了一半
 * （断电、进程被杀）。为一行坏数据让整个讨论历史读不出来，是不成比例的。
 *
 * @param {string} text 文件全文
 * @returns {object[]} 记录（文件顺序，旧在前）
 */
export function parseDiscussions(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') out.push(parsed)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/**
 * 读讨论历史。
 *
 * @param {string} path 文件路径
 * @returns {object[]} 记录（旧在前）
 */
export function readDiscussions(path) {
  try {
    return parseDiscussions(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/**
 * 追加一条讨论记录。
 *
 * ## 未满仓时走 `O_APPEND`，满仓才整份重写
 *
 * 之前这里是"读全文 → 拼字符串 → 整份重写"，与模块开头声称的"只追加"不符。
 * 两者在**内容**上等价（重写出来的字节就是旧字节加一行），所以之前没有正确性
 * 问题；真正的差别有两个：
 *
 *   1. **写入量**。满仓前每次写整份文件（200 条约 25 KB），而实际只多了一行
 *      约 126 字节，而且是**同步**写。改成追加之后写的就是那一行。
 *   2. **前缀稳定性**只在追加路径上成立。满仓后必然要丢最旧一条、整份位移，
 *      这没法避免，但至少不该在没满仓时就白白牺牲掉——而那恰好是缓存最可能
 *      命中的整个阶段。
 *
 * `appendFileSync` 的写法与 `notes.js` 的 `appendNote` 一致（那里也是 `O_APPEND`）。
 *
 * @param {string} path 文件路径
 * @param {object} record 已归一化的记录
 * @param {object} [options]
 * @param {number} [options.max] 保留上限
 * @returns {object[]} 落盘后的记录（旧在前）
 */
export function appendDiscussion(path, record, options = {}) {
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : MAX_DISCUSSIONS
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    text = ''
  }
  const all = [...parseDiscussions(text), record]

  if (all.length <= max) {
    const body = `${JSON.stringify(record)}\n`
    // 万一文件末尾缺换行（手改过、或被别的工具写过），先补一个再追加，
    // 否则会把两行粘成一行，那一行就成了坏行。
    appendFileSync(path, text !== '' && !text.endsWith('\n') ? `\n${body}` : body, 'utf8')
    return all
  }

  // 只保留最近 max 条；旧的直接丢——它们的信息已经沉淀进 background.md 了。
  const kept = all.slice(all.length - max)
  atomicWriteText(path, `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`)
  return kept
}

/**
 * 取最近若干条，**新在前**（注入 prompt 与面板展示都是这个顺序）。
 *
 * @param {object[]} records 记录（旧在前）
 * @param {number} [limit] 条数
 * @returns {object[]}
 */
export function recentDiscussions(records, limit = 8) {
  const list = Array.isArray(records) ? records : []
  return list.slice(Math.max(0, list.length - limit)).reverse()
}

/**
 * 最近一次讨论的时间，用于时间感知。
 *
 * @param {object[]} records 记录（旧在前）
 * @returns {string|null} ISO 时间
 */
export function lastDiscussionAt(records) {
  const list = Array.isArray(records) ? records : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (typeof list[i]?.at === 'string') return list[i].at
  }
  return null
}
