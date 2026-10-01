#!/usr/bin/env node
/**
 * 扫 `books/<bookId>/meta.json` **重建书架索引**（`library.json`）。
 *
 * ⚠️ 注释里别写"books/ 加星号"的 glob —— 那串字符里的星号加斜杠会提前闭合块注释。
 *
 * 为什么需要这个脚本：`library.json` 一坏，`readLibrary` 就如实回一个空书架
 * （那是对的——一个坏文件不该让插件挂不上），于是书架看起来"书全没了"。
 * 而**每本书的目录、正文、笔记、背景认识都还在盘上**，只是索引里再也找不到
 * 它们。在 2026-10-01 之前，代码里**没有任何重建入口**（`reindex-books.mjs`
 * 只重切章节，而它的书单也来自这份坏索引）—— 这个脚本补上那个入口。
 *
 * ⚠️ 两条纪律：
 *   1. **只补不丢**：`meta.json` 读不出来的书，保留索引里的原条目（"读不出 meta"
 *      不等于"这本书不存在"）；
 *   2. **写之前先整份备份**到 `<storage>/backups/library-<时间戳>.json`。
 *
 * 它做的事全部落在 `library.rebuildIndex()` 里，这里只是把它搬到命令行上：
 *
 *   node scripts/rebuild-library-index.mjs                 # 预演：只报告会改什么
 *   node scripts/rebuild-library-index.mjs --apply         # 真的落盘（先备份）
 *   node scripts/rebuild-library-index.mjs --storage <dir> # 指定书库目录
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { createLibrary } from '../lib/host/library.js'

/** 极简 argv 解析：只认长选项（与 reindex-books.mjs 同一套写法）。 */
function parseArgs(argv) {
  const options = { storage: '', apply: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--storage') options.storage = argv[++i] ?? ''
    else if (arg === '--apply') options.apply = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

const USAGE = `
用法: node scripts/rebuild-library-index.mjs [选项]

  --storage <dir>   书库目录（默认 $DSH_HOME/dsh-reading-companion）
  --apply           真的写盘；省略时只做预演（默认）
  -h, --help        显示本帮助

预演不改任何文件。--apply 会先把 library.json 复制到
<storage>/backups/library-<时间戳>.json 再写。
`.trim()

/** 解析书库目录：显式参数 > $DSH_HOME > ~/.dsh。 */
function resolveStorageDir(options) {
  if (options.storage !== '') return resolve(options.storage)
  const fromEnv = process.env.DSH_HOME
  const home = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? resolve(fromEnv.trim()) : join(homedir(), '.dsh')
  return join(home, 'dsh-reading-companion')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }

  const storageDir = resolveStorageDir(options)
  console.log(`${options.apply ? '执行' : '预演'}：${storageDir}\n`)

  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: console })
  const report = library.rebuildIndex({ apply: options.apply })

  if (report.indexRecovered) {
    console.log('⚠️ 索引当前是**损坏**状态（读回来是空书架）—— 这正是这个脚本要修的情形。')
  }
  console.log(`索引里 ${report.indexed} 本 / 磁盘上 ${report.found} 本`)

  if (report.missing.length > 0) {
    console.log(`\n可以找回 ${report.missing.length} 本：`)
    for (const book of report.missing) console.log(`  · 《${book.title}》 ${book.bookId}`)
  }
  if (report.dangling.length > 0) {
    console.log(`\n索引里的悬垂条目 ${report.dangling.length} 条（目录已经不在，会被移除）：`)
    for (const book of report.dangling) console.log(`  · 《${book.title}》 ${book.bookId}`)
  }
  if (report.unreadable.length > 0) {
    console.log(`\n读不出 meta.json 的目录 ${report.unreadable.length} 个（它们的索引条目会被**保留**）：`)
    for (const item of report.unreadable) console.log(`  · ${item}`)
  }

  if (report.applied) {
    console.log(`\n已落盘，备份：${report.backupPath ?? '（没有原文件，未备份）'}`)
  } else if (report.missing.length === 0 && report.dangling.length === 0 && !report.indexRecovered) {
    console.log('\n索引与磁盘一致，无需改动。')
  } else {
    console.log('\n未落盘（预演）。加 --apply 执行')
  }
}

main()
