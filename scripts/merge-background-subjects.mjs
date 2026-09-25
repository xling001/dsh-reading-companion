#!/usr/bin/env node
/**
 * 把「同一个人（或同一个主体）被写成多个 `###` 」合并成一个 —— 背景认识的**手工修复**工具。
 *
 * ## 为什么不交给压缩去合并
 *
 * 压缩有四条硬校验，其中「**保主体**」要求：输入里出现的每一个 `### 主体`，在输出里
 * **都必须还在**（见 `lib/host/compact.js` 的 `validateCompaction`，`COMPACT_LOST_ENTITIES`）。
 * 合并必然让一个主体名消失 —— 会被它整批判为非法。**那条校验是记忆的安全底线**
 * （"丢了谁就是丢了记忆"），不该为了一个重复去松它。
 *
 * 所以「跨主体的手工归并」放在这里：**由人来指定谁并进谁**，工具只负责机械地做、
 * 并核对没有丢任何东西。
 *
 * ## 用法
 *
 * ```bash
 * # 先预览（默认不写）
 * node scripts/merge-background-subjects.mjs --file <background.md> \
 *   --merge '竹纤（原称"小三儿"）=竹纤'
 *
 * # 确认无误再落盘（写前自动备份到 <文件同目录>/<文件名>.manual-bak.<时间戳>.md）
 * node scripts/merge-background-subjects.mjs --file <...> --merge '…=…' --apply
 * ```
 *
 * `--merge` 可重复。左边是**要被并掉的**那个主体名，右边是**留下来的**那一个（两者都要**逐字**等于
 * `### ` 后面的原文）。留下的那个若不存在，工具会拒绝执行（不做"顺手新建"这种猜测）。
 * 合并后的块**停在两块里靠前的那个位置**（主体次序＝注入裁剪的优先级，不能因为合并而变）。
 *
 * ## 安全约束
 *
 * - 默认**干跑**，`--apply` 才写；写前自动备份；
 * - **合并前后条目总数必须只少掉"被并掉的那几个标题行"** —— 一条条目都不许丢；
 * - 目标主体的分组必须**已经存在**；
 * - 只碰被点名的分区里的 `### ` 行与它们的条目，其它内容**逐字不动**。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

/** 与 `background.js` 的 `BACKGROUND_SECTIONS` 一致 —— 只在这些分区里找主体。 */
const GROUPED_SECTIONS = ['人物关系', '人物', '世界观', '通用概念']

/**
 * 把 markdown 切成「行 + 每行属于哪个 `## 分区` / `### 主体`」。
 *
 * @param {string} text
 * @returns {{ lines: string[], section: (string|null)[], subject: (string|null)[] }}
 */
function annotate(text) {
  const lines = text.split('\n')
  const section = []
  const subject = []
  let currentSection = null
  let currentSubject = null
  for (const line of lines) {
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line)
    const subjectMatch = /^###\s+(.+?)\s*$/.exec(line)
    if (sectionMatch !== null) {
      currentSection = sectionMatch[1]
      currentSubject = null
    } else if (subjectMatch !== null) {
      currentSubject = subjectMatch[1]
    }
    section.push(currentSection)
    subject.push(currentSubject)
  }
  return { lines, section, subject }
}

/** 数一遍非标题、非空的条目行（用来核对"一条都没丢"）。 */
function countEntries(lines) {
  return lines.filter((line) => /^\s*-\s+/.test(line)).length
}

function main() {
  const argv = process.argv.slice(2)
  const fileIndex = argv.indexOf('--file')
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : null
  const apply = argv.includes('--apply')
  const pairs = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--merge') continue
    const raw = argv[i + 1] ?? ''
    const at = raw.indexOf('=')
    if (at <= 0 || at === raw.length - 1) {
      console.error(`--merge 的格式应当是「被并掉的主体=留下的主体」，收到：${raw}`)
      process.exit(2)
    }
    pairs.push({ from: raw.slice(0, at), to: raw.slice(at + 1) })
  }

  if (file === null || !existsSync(file)) {
    console.error('用法：node scripts/merge-background-subjects.mjs --file <background.md> --merge \'旧主体=新主体\' [--apply]')
    process.exit(2)
  }
  if (pairs.length === 0) {
    console.error('至少要给一个 --merge。')
    process.exit(2)
  }

  const before = readFileSync(file, 'utf8')
  const beforeLines = before.split('\n')
  const beforeEntries = countEntries(beforeLines)

  const { lines, section, subject } = annotate(before)

  // 每个主体的块范围：[标题行, 结束行)
  const blocks = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    if (subject[i] === null) continue
    if (/^###\s+/.test(lines[i]) !== true) continue
    if (GROUPED_SECTIONS.includes(section[i]) !== true) continue
    const key = `${section[i]}\u0000${subject[i]}`
    if (!blocks.has(key)) blocks.set(key, { titleIndex: i, end: i + 1, section: section[i], name: subject[i] })
  }
  for (const block of blocks.values()) {
    let end = block.titleIndex + 1
    while (end < lines.length && subject[end] === block.name && section[end] === block.section) end += 1
    // 不吃掉尾部的空行 —— 那是分区之间的分隔，要留着。
    let bodyEnd = end
    while (bodyEnd > block.titleIndex + 1 && lines[bodyEnd - 1].trim() === '') bodyEnd -= 1
    block.end = end
    block.bodyEnd = bodyEnd
  }

  const drop = new Set()
  const moves = []
  for (const pair of pairs) {
    const candidates = [...blocks.values()].filter((block) => block.name === pair.from)
    // ⚠️ 目标主体可能在**多个分区里同名**（实测：《魔女霓裳》的 `## 人物` 与 `## 通用概念`
    // 各有一个 `### 竹纤`）。这里取**与被并者同分区**的那一个 —— 跨分区合并本来就不做，
    // 所以这样不会引入歧义。
    const targetSection = candidates[0]?.section
    const targets = [...blocks.values()].filter(
      (block) => block.name === pair.to && block.section === targetSection,
    )
    if (candidates.length !== 1) {
      console.error(`找不到唯一一个名为「${pair.from}」的 ### 主体（找到 ${candidates.length} 个）。请照原文逐字给。`)
      process.exit(3)
    }
    if (targets.length !== 1) {
      console.error(`找不到唯一一个名为「${pair.to}」的 ### 主体（找到 ${targets.length} 个）。本工具**不会**顺手新建主体。`)
      process.exit(3)
    }
    const from = candidates[0]
    const to = targets[0]
    if (from.section !== to.section) {
      console.error(`「${pair.from}」在 ## ${from.section}、「${pair.to}」在 ## ${to.section} —— 跨分区合并不做（那要判断"是不是同一个主体"，由你手工决定）。`)
      process.exit(3)
    }
    const entries = lines.slice(from.titleIndex + 1, from.bodyEnd)
    console.log(`  ${from.section}：### ${pair.from} → 并入 ### ${pair.to}`)
    console.log(`     将被搬走的条目 ${entries.filter((line) => /^\s*-\s+/.test(line)).length} 条：`)
    for (const line of entries) {
      if (/^\s*-\s+/.test(line)) console.log(`       ${line.trim().slice(0, 60)}${line.trim().length > 60 ? '…' : ''}`)
    }
    // ⚠️ 合并后的块**停在靠前的那一个的位置**：主体次序是有意义的 —— 注入超预算时
    // 是**从后往前丢**，靠前的主体优先级更高。若总是并进 `to` 的位置，会把一个原本
    // 靠前的人物挤到最后，等于让它优先被裁掉。
    const anchor = from.titleIndex < to.titleIndex ? from : to
    const other = anchor === from ? to : from
    const moved = lines.slice(other.titleIndex + 1, other.bodyEnd)
    moves.push({ anchor, other, to, entries: moved })
    // ⚠️ **整块**都要从原处去掉（标题 + 它的条目）。只去掉标题会让条目既留在原地、
    // 又被搬到锚点 —— 那正是第一次干跑被"条目数核对"抓到的 bug（55 → 62）。
    for (let i = other.titleIndex; i < other.bodyEnd; i += 1) drop.add(i)
  }

  const afterLines = []
  // 需要改名的标题行：锚点若是"被并者"，把它的名字换成留下的那一个（位置不动）。
  const renameAt = new Map()
  for (const move of moves) {
    if (move.anchor.name !== move.to.name) renameAt.set(move.anchor.titleIndex, `### ${move.to.name}`)
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (drop.has(i)) continue
    if (renameAt.has(i)) {
      afterLines.push(renameAt.get(i))
      continue
    }
    afterLines.push(lines[i])
    for (const move of moves) {
      if (i === move.anchor.bodyEnd - 1) {
        // 锚点块的末尾：把另一块的条目接在这里（它们现在属于同一个 `###`）。
        for (const line of move.entries) afterLines.push(line)
      }
    }
  }
  const after = afterLines.join('\n')

  // ---- 核对：只许少掉"被并掉的标题行"，条目一条都不许丢 ----
  const afterEntries = countEntries(afterLines)
  // ⚠️ 预期只少掉**标题行**：条目是**搬走**的，不是删掉的 —— 一次 merge 少一行。
  const expectedDrop = moves.length
  if (afterEntries !== beforeEntries) {
    console.error(`✗ 条目数变了：${beforeEntries} → ${afterEntries}。已中止，文件未改。`)
    process.exit(4)
  }
  if (beforeLines.length - afterLines.length !== expectedDrop) {
    console.error(`✗ 行数变化与预期不符：少了 ${beforeLines.length - afterLines.length} 行，预期少 ${expectedDrop} 行（每个被并掉的主体只少一行标题）。已中止。`)
    process.exit(4)
  }

  console.log(`\n核对通过：条目 ${afterEntries} 条一条不少；行数少 ${expectedDrop} 行（正好是被并掉的那几个标题）。`)

  if (!apply) {
    console.log('（这是预览。确认无误后加 --apply 才写盘，写前会自动备份。）')
    return
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = join(dirname(file), `${basename(file)}.manual-bak.${stamp}.md`)
  copyFileSync(file, backup)
  writeFileSync(file, after, 'utf8')
  console.log(`已写入：${file}`)
  console.log(`备份：${backup}`)
}

main()
