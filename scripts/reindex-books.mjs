#!/usr/bin/env node
/**
 * 重新切分书架里已有书籍的章节索引。
 *
 * 为什么需要这个脚本：`chapters.js` 的切分规则会变，而**已经在书架里的书不会
 * 自己更新**——`importBook` 是幂等的（同一份 sha 直接返回旧记录），所以修好
 * 解析器只对"以后导入的书"生效。老书要么删了重导（丢笔记、丢进度），要么
 * 用这个脚本就地重切。
 *
 * 它做的事全部落在 `library.reindex()` 里（章节区间、进度、草稿、备份的
 * 三条不变量都在那儿），这里只是把它搬到命令行上：
 *
 *   node scripts/reindex-books.mjs                 # 预演：只报告会改什么
 *   node scripts/reindex-books.mjs --apply         # 真的落盘（先备份）
 *   node scripts/reindex-books.mjs --book <id>     # 只处理一本书
 *   node scripts/reindex-books.mjs --storage <dir> # 指定书库目录
 *
 * ⚠️ 落盘前会检查 `notes.md` / `background.md` / `discussions.jsonl` 里按章号
 * 记下的内容：只要它们会因为重切而漂，脚本就**拒绝落盘**并告诉你原因。那些
 * 文件是人写的，重映射它们不是这个脚本该擅自做的事。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { createLibrary } from '../lib/host/library.js'

/** 极简 argv 解析：只认长选项，够用且无依赖。 */
function parseArgs(argv) {
  const options = { storage: '', book: '', apply: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--storage') options.storage = argv[++i] ?? ''
    else if (arg === '--book') options.book = argv[++i] ?? ''
    else if (arg === '--apply') options.apply = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

const USAGE = `
用法: node scripts/reindex-books.mjs [选项]

  --storage <dir>   书库目录（默认 $DSH_HOME/dsh-reading-companion）
  --book <bookId>   只重新切分这一本书
  --apply           真的写盘；省略时只做预演（默认）
  -h, --help        显示本帮助

预演不改任何文件。--apply 会先把要改的文件复制到
<storage>/backups/reindex-<bookId>-<时间戳>/ 再写。
`.trim()

/** 解析书库目录：显式参数 > $DSH_HOME > ~/.dsh。 */
function resolveStorageDir(options) {
  if (options.storage !== '') return resolve(options.storage)
  const fromEnv = process.env.DSH_HOME
  const home = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? resolve(fromEnv.trim()) : join(homedir(), '.dsh')
  return join(home, 'dsh-reading-companion')
}

function formatReport(report) {
  const lines = []
  const head = `《${report.title}》 ${report.bookId}`
  if (!report.changed) {
    lines.push(`${head}：无需重新切分（${report.after} 章）`)
    return lines
  }

  lines.push(`${head}：${report.before} 章 → ${report.after} 章`)
  lines.push(`  合并的重复目录行：${report.droppedTitles.length} 条`)
  for (const title of report.droppedTitles.slice(0, 3)) lines.push(`    · ${title}`)
  if (report.droppedTitles.length > 3) lines.push(`    · …还有 ${report.droppedTitles.length - 3} 条`)

  if (report.remap.shifted) {
    lines.push(`  章号整体前移：进度${report.remap.progress ? '已' : '无需'}重映射，草稿重映射 ${report.remap.drafts} 条`)
  }
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`)
  for (const item of report.drift) lines.push(`  ⚠️ 需要人工处理：${item}`)

  if (report.applied) lines.push(`  已落盘，备份：${report.backupDir}`)
  else if (report.drift.length > 0) lines.push('  未落盘（先解决上面的漂移项，或手工处理后再跑）')
  else lines.push('  未落盘（预演）。加 --apply 执行')

  return lines
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }

  const storageDir = resolveStorageDir(options)
  console.log(`${options.apply ? '执行' : '预演'}：${storageDir}\n`)

  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()

  const { books } = library.list()
  const targets = options.book === '' ? books : books.filter((book) => book.bookId === options.book)
  if (targets.length === 0) {
    console.log(options.book === '' ? '书架是空的。' : `书架里没有 ${options.book}。`)
    process.exitCode = 1
    return
  }

  let failed = 0
  for (const book of targets) {
    try {
      const report = library.reindex(book.bookId, { apply: options.apply })
      for (const line of formatReport(report)) console.log(line)
    } catch (error) {
      failed += 1
      console.log(`《${book.title}》 ${book.bookId}：失败 —— ${error.message}`)
    }
    console.log('')
  }

  if (failed > 0) process.exitCode = 1
}

main()
