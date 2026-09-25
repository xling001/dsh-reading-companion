/**
 * 一次性清理：把历史遗留的"顶部注释续行垃圾"从 `background.md` 里去掉，
 * 并把旧的 4 行顶部注释换成新的单行常量。
 *
 * ## 它治的是什么
 *
 * `parseBackground` 旧实现只挡 `<!--` 开头那一行、**挡不住多行注释的续行**，
 * 于是顶部说明的 3 个续行漏进 `unknown`，又被 `renderBackground` 回写到
 * `## 你手写的内容` 下 —— **每写一次盘就长三行**（3 行/次，不封顶）。
 * 解析器已修（见 `lib/host/background.js` 的 `parseBackground`），但**修复只阻止
 * 它继续长，不会清掉已经长出来的**：那些行现在已经是那个小节的普通内容了。
 * 所以需要这一个显式的清理动作。
 *
 * ## 安全约定
 *
 * 1. **默认干跑**，只打印将要改动什么；`--apply` 才写盘。
 * 2. 写盘前把原件**整份备份**到插件数据目录
 *    （`$DSH_HOME/dsh-reading-companion/books/<bookId>/background.md.before-cleanup-<时间戳>.md`），
 *    而不是留在工作区里 —— 免得在用户的笔记库里多出一个文件。
 * 3. **只删"与插件自己那段注释的续行逐字相同"的行**，且只在 `## 你手写的内容`
 *    小节内。用户写的任何字都不碰。
 * 4. 清完之后拿"解析→渲染"复算一遍，**结果必须与清理后的文件逐字相同** ——
 *    即"清理出来的文件正好等于插件下次会写的那份"。不成立就拒绝写盘。
 *
 * 用法：
 *   node scripts/clean-background-note.mjs                 # 干跑（默认那本书）
 *   node scripts/clean-background-note.mjs --apply
 *   node scripts/clean-background-note.mjs --all           # 扫所有工作区里的 陪读_*
 *   node scripts/clean-background-note.mjs --file <路径> --apply
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BACKGROUND_NOTE, parseBackground, renderBackground } from '../lib/host/background.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 旧版顶部注释的续行（去缩进后逐字比对）。它们正是要删掉的东西。 */
const LEGACY_NOTE_LINES = new Set([
  '条目只增不减；每条都带章节归属，方便你回头核对。',
  '被推翻的旧条目会搬到文件末尾的「已取代」里，不会删掉，也不会再喂给 AI。',
  '你可以直接编辑它——下次补充时会尊重你写的内容。 -->',
])

/** 旧版注释的首行前缀。 */
const LEGACY_NOTE_HEAD = '<!-- 这份文件是陪读 AI 对本书的理解'

/**
 * 算出清理后的文本。
 *
 * @param {string} original 原文
 * @returns {{ text: string, dropped: number, noteRewritten: boolean }}
 */
function clean(original) {
  const lines = original.replace(/\n+$/, '').split('\n')
  const out = []
  let inHandSection = false
  let inLegacyNote = false
  let dropped = 0
  let noteRewritten = false

  for (const line of lines) {
    // ① 旧的 4 行顶部注释 → 换成新的单行常量（等价于插件下次写盘会做的事）
    if (inLegacyNote) {
      if (line.includes('-->')) {
        inLegacyNote = false
        noteRewritten = true
        out.push(BACKGROUND_NOTE)
      }
      continue
    }
    if (line.startsWith(LEGACY_NOTE_HEAD)) {
      if (line.includes('-->')) {
        noteRewritten = true
        out.push(BACKGROUND_NOTE)
      } else {
        inLegacyNote = true
      }
      continue
    }

    // ② `## 你手写的内容` 小节里的垃圾续行
    if (/^##\s+你手写的内容\s*$/.test(line)) {
      inHandSection = true
      out.push(line)
      continue
    }
    if (inHandSection && /^##\s/.test(line)) inHandSection = false
    if (inHandSection && LEGACY_NOTE_LINES.has(line.trim())) {
      dropped += 1
      continue
    }
    out.push(line)
  }

  let text = out.join('\n')
  // 小节被清空时，把标题连它后面的空行一起收掉
  text = text.replace(/\n*##\s+你手写的内容\s*\n+$/, '\n')
  text = `${text.replace(/\n+$/, '')}\n`
  return { text, dropped, noteRewritten }
}

/**
 * 检查"清理结果"是否正好是插件下次会写的字节。
 *
 * @param {string} text 清理后的文本
 * @param {string} title 书名
 * @returns {boolean}
 */
function isFixedPoint(text, title) {
  const title2 = /# 《(.+?)》· 背景认识/.exec(text)?.[1] ?? title
  const rendered = renderBackground(parseBackground(text), title2)
  return rendered === text || `${rendered}\n` === text
}

/**
 * 找到所有陪读文件夹里的 `background.md`。
 *
 * ⚠️ 注意别在这里写出 `星号-斜杠` 这种序列（例如把通配写法原样放进注释）——
 * 它会**提前闭合这段块注释**，后面的中文就变成代码了。第一次写就踩了这个坑。
 *
 * @returns {string[]}
 */
function findAll() {
  const found = []
  // ⚠️ 从前这里写死**作者本机的两个工作区根目录** —— 发布版必须与个人环境无关。
  // 现在默认只扫**当前目录**；要扫别处就 `--roots a,b`（或 `DSH_CLEAN_ROOTS`）。
  const args = process.argv.slice(2)
  const rootsIndex = args.indexOf('--roots')
  const fromArgv = rootsIndex >= 0 ? String(args[rootsIndex + 1] ?? '') : ''
  const fromEnv = process.env.DSH_CLEAN_ROOTS ?? ''
  const roots = (fromArgv !== '' ? fromArgv : fromEnv)
    .split(',').map((item) => item.trim()).filter((item) => item !== '')
  const scanRoots = roots.length > 0 ? roots : [process.cwd()]
  for (const root of scanRoots) {
    if (!existsSync(root)) continue
    let workspaces = []
    try {
      workspaces = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      continue
    }
    for (const ws of workspaces) {
      const wsPath = join(root, ws.name)
      let entries = []
      try {
        entries = readdirSync(wsPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('陪读_')) continue
        const bg = join(wsPath, entry.name, 'background.md')
        if (existsSync(bg)) found.push(bg)
      }
    }
  }
  return found
}

/**
 * 读出陪读文件夹的认领标记，拿 bookId（备份路径要用它）。
 *
 * @param {string} file background.md 的路径
 * @returns {string|null}
 */
function bookIdOf(file) {
  const marker = join(dirname(file), '.dsh-reading-companion.json')
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8'))
    return typeof parsed?.bookId === 'string' ? parsed.bookId : null
  } catch {
    return null
  }
}

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const all = argv.includes('--all')
const fileArgIndex = argv.indexOf('--file')
// ⚠️ 从前这里**默认指向作者本机的某一本书**（一条写死的 `…\<工作区>\陪读_<书名>\background.md`）
// —— 那种默认值在发布版里既泄漏个人环境、又会让人一跑就动到别人的文件。
// 现在必须显式给 `--file <路径>`，或者 `--all`。
if (fileArgIndex < 0 && !all) {
  console.error('用法：')
  console.error('  node scripts/clean-background-note.mjs --file <background.md 的路径> [--apply]')
  console.error('  node scripts/clean-background-note.mjs --all [--roots <目录1,目录2>] [--apply]')
  console.error('（不带 --apply 时只预览，不写盘；写盘前会自动备份）')
  process.exit(2)
}
const targets = fileArgIndex >= 0 ? [argv[fileArgIndex + 1]] : findAll()

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
let touched = 0

for (const file of targets) {
  if (!existsSync(file)) {
    console.log(`跳过（不存在）: ${file}`)
    continue
  }
  const original = readFileSync(file, 'utf8')
  const title = /# 《(.+?)》· 背景认识/.exec(original)?.[1] ?? '未命名'
  const { text, dropped, noteRewritten } = clean(original)

  const before = original.replace(/\n+$/, '').split('\n').length
  const after = text.replace(/\n+$/, '').split('\n').length
  console.log(`\n== ${file}`)
  console.log(`   行数 ${before} → ${after}；删除垃圾行 ${dropped} 行；顶部注释换成单行: ${noteRewritten ? '是' : '（已经是单行）'}`)

  if (text === original) {
    console.log('   无需改动。')
    continue
  }
  if (!isFixedPoint(text, title)) {
    console.log('   ❌ 清理结果不是"解析→渲染"的不动点，拒绝写盘（请把它报给插件作者）。')
    continue
  }
  console.log('   ✅ 清理结果 = 插件下次写盘会写的字节（不动点校验通过）')

  if (!apply) {
    console.log('   （干跑，未写盘；加 --apply 才写）')
    continue
  }

  const bookId = bookIdOf(file)
  // ⚠️ 时间戳必须**不带小数点**：`toISOString()` 是 `2026-09-25T06:16:07.123Z`，
  // 旧写法 `.replace(/[-:T]/g,'').slice(0,15)` 正好切在 `.` 上 → 文件名以点结尾
  //（`…before-cleanup-20260925061607.`），而 **Windows 的正常路径 API 打不开以点结尾
  // 的文件** —— 备份写着"已备份"，真出事却读不回来（读者机器上真踩到过，我是用
  // `\\?\` 前缀才把那份 3,991 字的备份读出来的）。先截到秒、再删分隔符。
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
  if (bookId !== null) {
    const backupDir = join(dshHome, 'dsh-reading-companion', 'books', bookId)
    mkdirSync(backupDir, { recursive: true })
    const backup = join(backupDir, `background.md.before-cleanup-${stamp}.md`)
    copyFileSync(file, backup)
    console.log(`   已备份 -> ${backup}`)
  } else {
    console.log('   ⚠️ 没读到 .dsh-reading-companion.json 里的 bookId，跳过备份 —— 因此也拒绝写盘。')
    continue
  }

  writeFileSync(file, text)
  touched += 1
  console.log('   已写盘。')
}

console.log(`\n完成。写盘 ${touched} 个文件。`)
if (!apply) console.log('（本次是干跑）')
