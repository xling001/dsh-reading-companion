#!/usr/bin/env node
/**
 * **取并集**：把历代备份（`background.history/` 里的增量记录）与当前 `background.md`
 * 合成一份"**最详细的全文分析**"。
 *
 * 读者 2026-10-02 的目标原话："最后我可以把所有备份取并集来得到相对最详细的全文分析，
 * 命名应该有规律有顺序好让去并集更方便。" —— 命名见 `background-history.js`（四位序号 + 时间 + 操作），
 * 去重键 = **去掉章号与标点后的正文**（与合并去重同一条口径）。
 *
 *   node scripts/merge-background-history.mjs --dir <background.history 目录>          # 预演
 *   node scripts/merge-background-history.mjs --dir <…> --apply                        # 写 --out（默认 background-合集.md）
 *   node scripts/merge-background-history.mjs --dir <…> --include-current --file <background.md>
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { unionHistory } from '../lib/host/background-history.js'

/** 极简 argv 解析：只认长选项（与 reindex-books.mjs 同一套写法）。 */
function parseArgs(argv) {
  const options = { dir: '', file: '', out: '', includeCurrent: false, apply: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') options.dir = argv[++i] ?? ''
    else if (arg === '--file') options.file = argv[++i] ?? ''
    else if (arg === '--out') options.out = argv[++i] ?? ''
    else if (arg === '--include-current') options.includeCurrent = true
    else if (arg === '--apply') options.apply = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

const USAGE = `
用法: node scripts/merge-background-history.mjs --dir <background.history> [选项]

  --dir <目录>         历代增量记录所在目录（必填）
  --include-current    把当前 background.md 也并进来（配 --file）
  --file <路径>        当前的 background.md
  --out <路径>         输出文件（默认：与 background.md 同级的 background-合集.md）
  --apply              真的写文件（默认只预演）
`

const options = parseArgs(process.argv.slice(2))
if (options.help || options.dir === '') {
  console.log(USAGE.trim())
  process.exit(options.dir === '' && options.help !== true ? 1 : 0)
}

const histDir = resolve(options.dir)
if (!existsSync(histDir)) {
  console.error(`找不到目录：${histDir}`)
  process.exit(1)
}

// 序号即顺序 ⇒ 按文件名排序就是按时间排序
const names = readdirSync(histDir).filter((name) => name.endsWith('.md')).sort()
if (names.length === 0) {
  console.error(`${histDir} 里没有 .md 记录`)
  process.exit(1)
}

const texts = names.map((name) => readFileSync(join(histDir, name), 'utf8'))
console.log(`读入 ${names.length} 份增量记录：${names.join(' / ')}`)

if (options.includeCurrent === true && options.file !== '') {
  const current = resolve(options.file)
  if (existsSync(current)) {
    texts.push(readFileSync(current, 'utf8'))
    console.log(`并入了当前文件：${current}`)
  }
}

const merged = unionHistory(texts)
console.log(`\n并集：${merged.entries} 条（去重掉 ${merged.duplicates} 条）/ ${merged.groups} 个主体 / ${merged.markdown.length} 字`)

if (options.apply !== true) {
  console.log('\n（预演。加 --apply 才写文件。）')
  process.exit(0)
}

const out = options.out !== ''
  ? resolve(options.out)
  : join(options.file !== '' ? dirname(resolve(options.file)) : histDir, 'background-合集.md')
writeFileSync(out, merged.markdown, 'utf8')
console.log(`\n✓ 已写入：${out}`)
