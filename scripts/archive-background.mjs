#!/usr/bin/env node
/**
 * **冷归档**：把超出活跃窗口的旧条目从活分区**搬**进「冷档案」。
 *
 * 为什么需要它：现状是"背景膨胀 ⇒ 让**模型**把整份文件重写一遍（压缩）⇒ 压缩后的内容继续进
 * 上下文"。而"整份重写"有硬上限（模型单次输出 32768 tokens ≈ 2.6 tokens/字 ⇒ 文件到
 * 1.2–1.5 万字就压不出完整输出，实测撞过、还有过"响应 0 字"的白跑）。
 * 这个脚本把那一步**从模型手里拿回来**：纯代码、零模型调用、不丢一个字。
 *
 * ⚠️ 三条纪律：
 *   1. **原文一字不改**（只搬运）—— 读者日后取并集时，去重键才对得上；
 *   2. **写之前先整份备份**（`background.bak.<时间戳>.md`）**并写一份增量记录**
 *      （`background.history/NNNN-…-归档.md`，只记这一笔搬走了什么，**不与别的备份重复**）；
 *   3. 默认**只预演**，加 `--apply` 才落盘。
 *
 *   node scripts/archive-background.mjs --file <background.md> --progress 300            # 预演
 *   node scripts/archive-background.mjs --file <background.md> --progress 300 --apply    # 落盘
 *   node scripts/archive-background.mjs --file <background.md> --from-chapter 180 --apply # 直接指定窗口起点
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { applyArchive, parseBackground, planArchive, renderBackground } from '../lib/host/background.js'
import { HISTORY_DIR, buildArchiveDelta, historyFileName, nextHistorySeq } from '../lib/host/background-history.js'

/** 极简 argv 解析：只认长选项（与 reindex-books.mjs 同一套写法）。 */
function parseArgs(argv) {
  const options = { file: '', progress: 0, from: 0, window: 120, apply: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--file') options.file = argv[++i] ?? ''
    else if (arg === '--progress') options.progress = Number(argv[++i] ?? 0)
    else if (arg === '--from-chapter') options.from = Number(argv[++i] ?? 0)
    else if (arg === '--window') options.window = Number(argv[++i] ?? 120)
    else if (arg === '--apply') options.apply = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

const USAGE = `
用法: node scripts/archive-background.mjs --file <background.md> [选项]

  --file <路径>        要归档的 background.md（必填）
  --progress <章号>    读者读到第几章（用它减去窗口得到起点）
  --from-chapter <章>  直接指定"活跃窗口起点"：章号全部早于它的条目会被归档
  --window <章数>      活跃窗口大小（默认 120；配合 --progress 用）
  --apply              真的落盘（先整份备份 + 写一份增量记录）
`

const options = parseArgs(process.argv.slice(2))
if (options.help || options.file === '') {
  console.log(USAGE.trim())
  process.exit(options.file === '' && options.help !== true ? 1 : 0)
}

const file = resolve(options.file)
if (!existsSync(file)) {
  console.error(`找不到文件：${file}`)
  process.exit(1)
}

const md = readFileSync(file, 'utf8')
const doc = parseBackground(md)
const keepFrom = options.from > 1
  ? options.from
  : (options.progress > 1 ? Math.max(2, options.progress - options.window + 1) : 0)

if (keepFrom <= 1) {
  console.error('需要 --progress（配 --window）或 --from-chapter 才能算活跃窗口起点')
  process.exit(1)
}

const plan = planArchive(doc, keepFrom)
console.log(`活跃窗口起点：第 ${keepFrom} 章`)
if (plan.total === 0) {
  console.log('没有可归档的条目（活分区里的章号都不早于窗口起点）✓')
  process.exit(0)
}

console.log(`将归档 ${plan.total} 条：`)
for (const item of plan.items) {
  const key = item.entity === null ? item.section : `${item.section}·${item.entity}`
  console.log(`  ${key}：${item.entries.length} 条`)
}

if (options.apply !== true) {
  console.log('\n（预演。加 --apply 才落盘：会先整份备份，再写一份增量记录。）')
  process.exit(0)
}

const at = new Date()
const stamp = historyFileName(0, at, '').replace(/^0000-/, '').replace(/-\.md$/, '')
const dir = dirname(file)

// ① 整份备份（可回退）
copyFileSync(file, join(dir, `background.bak.${stamp}.md`))

// ② 增量记录（只记这一笔搬走了什么 —— 备份之间不重复）
const histDir = join(dir, HISTORY_DIR)
mkdirSync(histDir, { recursive: true })
const seq = nextHistorySeq(readdirSync(histDir))
const deltaName = historyFileName(seq, at, '归档')
writeFileSync(
  join(histDir, deltaName),
  buildArchiveDelta({ keepFromChapter: keepFrom, at, items: plan.items }),
  'utf8',
)

// ③ 写回文件（原文只搬运、不改写）
const { doc: next, moved } = applyArchive(doc, keepFrom)
const titleMatch = /^#\s+《(.+?)》/.exec(md)
writeFileSync(file, renderBackground(next, titleMatch === null ? '背景认识' : titleMatch[1]), 'utf8')

console.log(`\n✓ 归档 ${moved} 条`)
console.log(`  备份：background.bak.${stamp}.md`)
console.log(`  增量：${HISTORY_DIR}/${deltaName}`)
