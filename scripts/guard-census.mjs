/**
 * 守卫语料普查（**只读**）：每次发版跑一次，让三个数**可见**。
 *
 * ## 为什么需要它
 *
 * 读者的原问题（2026-10-02）："为什么不管是否废弃了功能或者换了方法，每次改动
 * 守卫只会增加？" 实测答案是三条机制，其中最容易治的一条是：**没有任何审计面朝
 * `test/`**。`lib/` 有死代码扫描、`docs/` 有考古，而测试目录从来只被"跑绿"，
 * 不被"看数" —— 于是它只会单调长大（全历史 `test/` 删除占比 4.8%，`lib/` 10.8%）。
 *
 * 这份脚本不评判好坏，只把三件事摆出来：
 *   ① **用例总数**，以及其中"读源码再断言"的**接线守卫**有多少（它们每次重构都可能
 *      要跟着改，是"只增"的主要来源）；
 *   ② **数值钉子**有多少（断言容器长度等于一个写死的数字）；
 *   ③ `test/` 与 `lib/` 的体量与注释占比（41% 的注释是 E 档要处理的）；
 *   ④ `lib/` 里**注释块与它注释的函数分家**了多少处（E 档真正的靶子，见下）。
 *
 * ⚠️ ④ 的判据刻意**不是"注释有多长"** —— 长不等于该删：本仓库的注释绝大多数是
 * "为什么不这么写"，删了就会有人再踩一次。能自动判定的只有一件事：**两个 JSDoc
 * 块紧挨着**（中间只有空行），此时前一块的归属多半是更后面那个函数 —— 它被后插进来
 * 的函数挤开了，读者会把它当成后一个函数的文档。文件头（第 1 行）后面紧跟第一个
 * 函数的 JSDoc 是**正常**写法，单独排除。
 *
 * ## 用与不用
 *
 * 用法：`npm run guard:census`。**不改任何文件**，只打印。
 *
 * ⚠️ 刻意**不**在脚本里跑 `git`：本仓库的沙箱下 Node 用管道捕获子进程输出会
 * `EPERM`，而一份"发版时才跑"的审计脚本不该依赖能不能 spawn。要看
 * **历史增删账本**（"只增不减"的硬证据）请自己跑这一条：
 *
 *     git log --numstat --pretty=format: -- test | ...（见 docs/design.md 的删除铁律）
 *
 * 判据口径说明（与 2026-10-02 那次实测一致，别自己另发明一套）：
 *   · **接线守卫** = 一个 `test(` 块里既 `readFileSync` 了**源码/文档/配置**、又有断言。
 *     读临时数据（`test/.tmp` 里造的书）不算。
 *   · **为了执行 vs 字符串比对**：读源码是为了把它**跑起来**（迷你渲染器、模块契约）
 *     是健康的；读源码是为了**对文本做断言**才是脆钉子。这个区分只在 `client.test.mjs`
 *     上有意义 —— 那 40 多条几乎全在那里。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 分类判据是**单一来源**（`scripts/guard-classify.mjs`），因为元守卫
//    `test/guard-discipline.test.mjs` 要用**同一套**谓词。别在这里再写一份。
import { TEXT_PIN_PREFIXES, classifyBlock, testBlocks } from './guard-classify.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TEST_DIR = join(ROOT, 'test')
const LIB_DIR = join(ROOT, 'lib')

const files = readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.mjs')).sort()
// ⚠️ `npm test` 打印的用例数比这里**多 1**，不是哪个统计错了：Node 的 runner 会把
//    `test/` 目录下的**所有** .mjs 都当测试文件加载，而 `test/helpers/server.mjs`
//    只是夹具、不注册任何用例 —— runner 给它记一个"文件级条目"。自己算一遍是为了
//    下次有人对不上数时不用再查一轮。
const helperFiles = readdirSync(TEST_DIR, { recursive: true })
  .map(String)
  .filter((rel) => rel.endsWith('.mjs') && !rel.endsWith('.test.mjs') && !rel.startsWith('.tmp'))
const rows = []
const wiringByFile = []
let total = { tests: 0, wiring: 0, brittle: 0, healthy: 0, textPins: 0, numeric: 0, lines: 0, asserts: 0 }

for (const name of files) {
  const text = readFileSync(join(TEST_DIR, name), 'utf8')
  const lines = text.split('\n').length
  const blocks = testBlocks(text)
  let wiring = 0
  let brittle = 0
  let healthy = 0
  let stringPins = 0
  let textPins = 0
  for (const block of blocks) {
    // ⚠️ 分类走**共用的那一个函数**（`scripts/guard-classify.mjs`），别在这里再写 if：
    //    元守卫用的是同一个，两边分家就会像 `isGroupedSection` 那次一样静默失效。
    const kind = classifyBlock(block)
    if (kind === '文本钉子') {
      textPins += 1
      continue
    }
    if (kind === '行为') continue
    wiring += 1
    // ⚠️ 这两类**必须分开数**（2026-10-03 修）：`接线守卫` 是"用字符串匹配代替运行"（脆），
    //    `接线守卫（为了执行）` 是"读源码是为了把它跑起来"（健康）—— 混在一起报，读者会
    //    把健康的那几条也算成"只增的主要来源"（当时 14 里其实有 3 条是健康的）。
    if (kind === '接线守卫') {
      brittle += 1
      stringPins += 1
    } else {
      healthy += 1
    }
  }
  // 数值钉子：断言某个容器的长度等于一个写死的数字。
  const numeric = (text.match(/assert\.[a-zA-Z]+\([^\n]*\.length,\s*\d+/g) ?? []).length
  const asserts = (text.match(/\bassert\./g) ?? []).length

  rows.push({ name, lines, tests: blocks.length, wiring, stringPins, textPins, numeric, asserts })
  if (wiring > 0) wiringByFile.push({ name, wiring, stringPins, tests: blocks.length })

  total.tests += blocks.length
  total.wiring += wiring
  total.brittle += brittle
  total.healthy += healthy
  total.textPins += textPins
  total.numeric += numeric
  total.lines += lines
  total.asserts += asserts
}

// 生产代码规模（注释占比是 E 档的靶子）
let libLines = 0
let libCommentLines = 0
const libFiles = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (!entry.endsWith('.js')) continue
    const lines = readFileSync(full, 'utf8').split('\n')
    libFiles.push({ path: full, lines })
    libLines += lines.length
    libCommentLines += lines.filter((line) => /^\s*(\/\/|\*|\/\*)/.test(line)).length
  }
}
walk(LIB_DIR)

/**
 * `/**` 注释块的起止行（0 起）。
 *
 * @param {string[]} lines 文件按行切开
 * @returns {Array<{start: number, end: number}>}
 */
function jsdocBlocks(lines) {
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\/\*\*/.test(lines[i])) continue
    let j = i
    while (j < lines.length && !/\*\//.test(lines[j])) j += 1
    blocks.push({ start: i, end: j })
    i = j
  }
  return blocks
}

/**
 * E 档靶子：两个 JSDoc 块紧挨着（前一块的归属函数在更后面）。
 *
 * ⚠️ **判据是"两块中间有没有非空内容"，所以插空行没用**（2026-10-03 实测踩过）：
 *    下一行的 `filter((line) => line.trim() !== '')` 会把空行滤掉，于是"只隔一个空行"
 *    的 `between.length === 0`、照样判成紧挨着。
 *    想让告警消失只有两条路：**把两块合并成一块**，或**把块搬去紧贴它注释的那个函数**。
 *    别去试"要插几行空行" —— 那不会有任何变化。
 */
let adjPairs = 0
let adjFileHeaders = 0

const orphans = []
for (const { path, lines } of libFiles) {
  const blocks = jsdocBlocks(lines)
  for (let k = 0; k + 1 < blocks.length; k += 1) {
    const between = lines.slice(blocks[k].end + 1, blocks[k + 1].start).filter((line) => line.trim() !== '')
    if (between.length > 0) continue
    adjPairs += 1
    // 文件头 + 第一个函数的 JSDoc 是正常写法
    if (blocks[k].start === 0) {
      adjFileHeaders += 1
      continue
    }
    orphans.push({
      file: path.slice(ROOT.length + 1).split('\\').join('/'),
      at: blocks[k].start + 1,
      size: blocks[k].end - blocks[k].start + 1,
    })
  }
}
const orphanLines = orphans.reduce((sum, row) => sum + row.size, 0)

const pct = (part, whole) => (whole === 0 ? '0%' : `${(part / whole * 100).toFixed(0)}%`)

console.log('守卫语料普查（只读，不改任何文件）')
console.log('='.repeat(72))
console.log(`用例总数                ${String(total.tests).padStart(6)}   （${files.length} 个测试文件，${total.lines} 行，${total.asserts} 条断言）`)
if (helperFiles.length > 0) {
  console.log(`  ⚠️ npm test 会打印 ${total.tests + helperFiles.length}：runner 把 test/ 下的非测试 .mjs 也当测试文件加载，`
    + `每个记一个文件级条目（${helperFiles.map((f) => 'test/' + f.split('\\').join('/')).join('、')}）`)
}
console.log(`  · 行为 / 其它          ${String(total.tests - total.wiring - total.textPins).padStart(6)}   ${pct(total.tests - total.wiring - total.textPins, total.tests)}`)
console.log(`  · 接线守卫（读源码再断言，**脆**）${String(total.brittle).padStart(4)}   ${pct(total.brittle, total.tests)}  ← "只增"的主要来源（用字符串匹配代替运行）`)
console.log(`  · 接线守卫（读源码是为了**执行**，健康）${String(total.healthy).padStart(2)}   ${pct(total.healthy, total.tests)}  ← 迷你渲染器 / 模块契约这类，读源码是手段不是代偿`)
console.log(`  · 文本钉子（样式/模板/契约，该留）${String(total.textPins).padStart(4)}   ${pct(total.textPins, total.tests)}  ← 钉的就是文本本身，不是代偿（名字以「${TEXT_PIN_PREFIXES.join('」或「')}」开头）`)
console.log(`数值钉子（.length = N）  ${String(total.numeric).padStart(6)}   ${pct(total.numeric, total.asserts)} 的断言`)
console.log('')
console.log('接线守卫分布（按条数，`接线总数` = 脆 + 健康）：')
console.log('  ' + 'file'.padEnd(34) + '接线总数'.padStart(8) + '其中脆'.padStart(8) + '该文件用例'.padStart(11))
for (const r of wiringByFile.sort((a, b) => b.wiring - a.wiring)) {
  console.log('  ' + r.name.padEnd(34) + String(r.wiring).padStart(8) + String(r.stringPins).padStart(8) + String(r.tests).padStart(11))
}
console.log('')
console.log(`lib/ 代码 ${libLines} 行（注释行 ${libCommentLines}，占 ${pct(libCommentLines, libLines)}）`)
console.log(`test/ 代码 ${total.lines} 行 ⇒ 测试 / 被测 = ${(total.lines / libLines).toFixed(2)} 倍`)
console.log('')
console.log(`lib/ 注释块与它的函数**分家**的：${orphans.length} 处 / ${orphanLines} 行`
  + `（E 档剩下的靶子；另 ${adjFileHeaders} 处是"文件头 + 第一个函数的 JSDoc"，正常）`)
for (const row of orphans.sort((a, b) => b.size - a.size).slice(0, 8)) {
  console.log(`    ${String(row.size).padStart(4)} 行  ${row.file}:${row.at}`)
}
if (orphans.length > 8) console.log(`    …其余 ${orphans.length - 8} 处`)
console.log('  ⚠️ 判据是"前一块的归属函数在更后面"，不是"注释太长" —— 长注释大多该留；')
console.log('     做法：压到"反直觉 + 会复发"的几条 + 指回 docs，@param 原样搬，别机械压缩。')
console.log('')
console.log('历史增删账本（"只增不减"的硬证据，需要 git，脚本刻意不代跑）：')
console.log('  git log --numstat --pretty=format: -- test | awk \'{a+=$1; d+=$2} END {print "测试 +"a" / -"d}\'')
console.log('  git log --numstat --pretty=format: -- lib  | awk \'{a+=$1; d+=$2} END {print "源码 +"a" / -"d}\'')
