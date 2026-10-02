/**
 * **背景认识的历代备份：增量（delta）+ 并集**。
 *
 * ## 读者提的三条要求（2026-10-02）
 * 1. "覆盖当前状态之前要有备份" ⇒ 允许覆盖的**前提**；
 * 2. "**备份不要互相重复**" ⇒ 不做整份快照，只写**这一笔变动**；
 * 3. "命名要有规律有顺序，好让我**取并集**得到最详细的全文分析" ⇒ 见 {@link historyFileName}
 *    与 {@link unionHistory}：按序号排、按正文去重、直接产出可以读的全文合集。
 *
 * ## 与 `已取代` / `冷档案` 的关系
 * 那两节是**文件里**的归档（读者看得见、可手改）；这里的 delta 是**文件外**的历史，
 * 记录"每一次搬运 / 覆盖拿走了什么"，所以**必然不重复**：一条事实只在
 * "它第一次出现"（写入时）与"它被搬走/覆盖"（这一次）各出现一次。
 *
 * ⚠️ **并集的去重键** = 去掉章号与标点后的正文（与 `background.js` 的合并去重同一条口径），
 * 所以 delta 里必须存**原文**，不许改写。
 */

/** 历史目录名（与 `background.md` 同级）。 */
export const HISTORY_DIR = 'background.history'

// ⚠️ 章号锚与 `background.js` 的判读侧**同一个源**（见 `anchor.js` 的说明：曾经两套口径
//    不咬合，漏打反引号的条目会被切开却判成"没章号"）。这里剥的是**去重键**，不是正文。
import { anchorRegex } from './anchor.js'

/**
 * 历史文件名：**四位序号 + 本地时间 + 操作名** ⇒ 字典序 = 时间序，方便按顺序取并集。
 *
 * @param {number} seq 从 1 起的序号
 * @param {Date} at 时间
 * @param {string} op 操作名（`归档` / `覆盖` / `压缩` / `写入`）
 * @returns {string} 例如 `0007-20261002-031500-归档.md`
 */
export function historyFileName(seq, at, op) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
    + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  const safeOp = String(op ?? '变更').replace(/[\\/:*?"<>|\s]/g, '')
  return `${p(seq, 4)}-${stamp}-${safeOp}.md`
}

/**
 * 从一个目录里已有的文件名算出**下一个序号**（不用读内容）。
 *
 * @param {string[]} names 目录里的文件名
 * @returns {number} 下一个序号（至少 1）
 */
export function nextHistorySeq(names) {
  let max = 0
  for (const name of Array.isArray(names) ? names : []) {
    const m = /^(\d{4})-/.exec(String(name))
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/**
 * 造一份**冷归档的 delta**：只记"这一笔被搬走了什么"。
 *
 * @param {object} input
 * @param {number} input.keepFromChapter 活跃窗口起点（1 起）
 * @param {Date} [input.at] 时间
 * @param {string} [input.bookTitle] 书名
 * @param {Array<{ section: string, entity: string|null, entries: string[] }>} input.items 搬走的条目
 * @returns {string} Markdown（每一节保留来源与主体标题，条目**原文**）
 */
export function buildArchiveDelta(input) {
  const items = Array.isArray(input?.items) ? input.items : []
  const at = input?.at instanceof Date ? input.at : new Date()
  const lines = [
    `<!-- drc-history: op=归档 at=${at.toISOString()} keepFromChapter=${input?.keepFromChapter ?? '?'} -->`,
    `# 历代备份 · 归档（活跃窗口从第 ${input?.keepFromChapter ?? '?'} 章起）`,
    '',
    `> 这一笔把 ${items.reduce((sum, item) => sum + item.entries.length, 0)} 条**搬进**了「冷档案」。`,
    '> 它们不再进提示词，但**原文一字未改** —— 取并集时按正文去重即可。',
    '',
  ]
  for (const item of items) {
    const key = item.entity === null ? item.section : `${item.section}·${item.entity}`
    lines.push(`## ${item.section}`)
    lines.push(`### ${key}`)
    for (const entry of item.entries) lines.push(`- ${entry}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 并集用的去重键：去掉章号与标点后的正文（与合并去重同一条口径）。 */
export function unionKey(entry) {
  return String(entry ?? '')
    .replace(anchorRegex(), '')
    .replace(/[\s`*。，、；：！？()（）「」【】·—…→/]/g, '')
}

/**
 * **取并集**：把历代 delta 与当前文件里的条目合成一份"最详细的全文分析"。
 *
 * @param {string[]} texts 各份 Markdown（顺序无关，只用于去重）
 * @param {object} [options]
 * @param {string} [options.title] 输出标题
 * @returns {{ markdown: string, entries: number, duplicates: number, groups: number }}
 */
export function unionHistory(texts, options = {}) {
  const groups = new Map()
  const seen = new Set()
  let entries = 0
  let duplicates = 0

  for (const text of Array.isArray(texts) ? texts : []) {
    let section = ''
    let entity = null
    for (const raw of String(text ?? '').split('\n')) {
      const line = raw.trimEnd()
      const h2 = /^##\s+(.+)$/.exec(line)
      if (h2 !== null) {
        section = h2[1].trim()
        entity = null
        continue
      }
      const h3 = /^###\s+(.+)$/.exec(line)
      if (h3 !== null) {
        entity = h3[1].trim()
        // `人物·甲` 这种带来源前缀的主体名，进合集时按原名归位
        const dot = entity.indexOf('·')
        if (dot > 0 && section !== '') entity = entity.slice(dot + 1)
        continue
      }
      if (!line.startsWith('- ')) continue
      const entry = line.slice(2).trim()
      if (entry === '') continue
      const key = unionKey(entry)
      if (key === '') continue
      entries += 1
      if (seen.has(key)) {
        duplicates += 1
        continue
      }
      seen.add(key)
      const name = entity === null ? (section === '' ? '（未归类）' : section) : entity
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name).push(entry)
    }
  }

  const lines = [options.title ?? '# 背景认识 · 历代并集', '']
  lines.push(`> 合并了 ${Array.isArray(texts) ? texts.length : 0} 份记录：`
    + `**${seen.size} 条不重复**（另有 ${duplicates} 条重复已并掉）。`, '')
  for (const [name, list] of groups) {
    lines.push(`## ${name}`, '')
    for (const entry of list) lines.push(`- ${entry}`)
    lines.push('')
  }

  return { markdown: lines.join('\n'), entries, duplicates, groups: groups.size }
}
