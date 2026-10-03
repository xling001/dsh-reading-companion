/**
 * 前后端路由契约测试。
 *
 * 浏览器半边与宿主半边是**分别手写的两套字符串**：宿主声明
 * `pattern: '/books/:bookId/context'`，客户端拼 `` `/books/${bookId}/context` ``。
 * 中间没有任何类型系统或生成器把它们绑在一起，所以一次改名、一个字母打错，
 * 都不会在构建期报错——只会变成运行时一个 HTTP 404，而且往往要等用户点到
 * 那个按钮才暴露。
 *
 * 这个测试直接从两份源码里把路径抠出来做匹配，把"沉默的 404"变成构建期红灯。
 * 第二条测试专门验证**提取逻辑本身有效**：否则正则一旦写歪，第一条会退化成
 * 空转并通过，那比没有测试更危险。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NOTES_PAGE_DEFAULT, NOTES_PAGE_MAX } from '../lib/host/notes.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const hostSource = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

/** 宿主声明的全部路由 pattern。 */
const HOST_PATTERNS = [...hostSource.matchAll(/pattern:\s*'([^']+)'/g)].map((match) => match[1])

/**
 * 客户端调用的全部路径。
 *
 * 只匹配 `callApi('...')` / `` callApi(`...`) `` 形态；函数定义那一行参数不含
 * 引号，因此不会被误收。
 */
const CLIENT_PATHS = [...clientSource.matchAll(/callApi\(\s*[`']([^`']+)[`']/g)].map((match) => match[1])

/**
 * 把宿主 pattern 编译成正则：`:name` 段匹配任何非空路径段。
 *
 * @param {string} pattern 宿主路由 pattern
 * @returns {RegExp}
 */
function patternToRegExp(pattern) {
  const segments = pattern.split('/').map((segment) => (
    segment.startsWith(':')
      ? '[^/]+'
      : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ))
  return new RegExp(`^${segments.join('/')}$`)
}

const ROUTE_RES = HOST_PATTERNS.map(patternToRegExp)

test('契约：提取逻辑本身有效（防止正则写歪后第一条测试空转）', () => {
  assert.ok(HOST_PATTERNS.length >= 10, `只提到 ${HOST_PATTERNS.length} 条宿主路由，提取逻辑可疑`)
  assert.ok(CLIENT_PATHS.length >= 8, `只提到 ${CLIENT_PATHS.length} 条客户端路径，提取逻辑可疑`)

  // 正例与反例都要对，才能证明匹配不是在"什么都通过"。
  assert.ok(ROUTE_RES.some((re) => re.test('/books/abc/chapters/3')), '动态段应当能匹配')
  assert.ok(ROUTE_RES.some((re) => re.test('/library')), '静态路径应当能匹配')
  assert.ok(!ROUTE_RES.some((re) => re.test('/books/abc/nope')), '不存在的子路径不该匹配')
  assert.ok(!ROUTE_RES.some((re) => re.test('/books')), '少一段不该匹配')
})

test('契约：client 调用的每条路径都能被宿主路由接住', () => {
  for (const raw of CLIENT_PATHS) {
    // 模板变量在这里总是占满一整段路径，换成一个具体段名即可参与匹配；
    // 查询串不属于 pathname，先剥掉。
    const concrete = raw.replace(/\$\{[^}]*\}/g, 'x').split('?')[0]
    assert.ok(
      ROUTE_RES.some((re) => re.test(concrete)),
      `客户端调用 ${raw} 在宿主路由表里找不到对应项 —— 多半是路径改名或拼错了`,
    )
  }
})

test('契约：反过来的漏网检查 —— 关键路由必须真的被客户端用到', () => {
  // 这些是各阶段对用户可见的入口；如果客户端不再调用它们，说明功能被
  // 悄悄摘掉了，而单看"路径有对应路由"是发现不了的（没有调用就没有路径）。
  const joined = CLIENT_PATHS.join('\n')
  assert.match(joined, /\/binding/, 'P2：客户端必须能绑定/解绑会话')
  // ⚠️ `/context`（「AI 视角预览」）**2026-09-27 被读者决定从面板摘掉**（它是只读视图，
  //    需要时可以从别处看），所以这条断言**有意删掉** —— 它不是"漏网"，是决定。
  //    宿主侧那条路由仍然在（本文件上面那条测试照样管着它），这样能力没丢、只有入口没了。
  assert.match(joined, /\/notes/, 'P3：客户端必须能读笔记')
  assert.match(joined, /\/drafts/, 'P3：客户端必须能读写草稿')
  assert.match(joined, /\/commit/, 'P3：客户端必须能把草稿提交成笔记')
  assert.match(joined, /\/background/, 'P4：客户端必须能读/补齐背景认识')
  assert.match(joined, /\/background\/fill/, 'P4：客户端必须能触发一次补齐')
})

/**
 * 从客户端源码里抠出一个数字常量。
 *
 * 和本文件其余部分同一个思路：客户端半边要靠 `window.__ModuleLoader__` 才能
 * 物化，为一个常量把整套浏览器替身搬过来不划算；而"两边手写的数字必须相等"
 * 恰恰是文本比对最擅长的事。
 *
 * @param {string} name 常量名
 * @returns {number}
 */
function clientNumber(name) {
  const matched = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(clientSource)
  assert.ok(matched !== null, `客户端源码里找不到数字常量 ${name}`)
  return Number(matched[1])
}

test('契约：笔记分页的页大小，客户端请求的与宿主默认的必须一致', () => {
  const clientPageSize = clientNumber('NOTES_PAGE_SIZE')
  assert.equal(
    clientPageSize,
    NOTES_PAGE_DEFAULT,
    '客户端传的 limit 与宿主默认页大小不一致 —— 客户端传的值会赢，宿主的"默认"就成了摆设',
  )
  assert.ok(
    clientPageSize > 0 && clientPageSize <= NOTES_PAGE_MAX,
    `客户端页大小 ${clientPageSize} 落在宿主接受区间之外，每次请求都会被夹取`,
  )
})

test('契约：联网档位的三档在宿主与客户端逐字一致、顺序也一致', () => {
  // 客户端的 `WEB_GATE_CHOICES` 是宿主 `WEB_GATE_MODES` 的**镜像**：bundle 不能
  // import 宿主模块，所以只能各写一份。两处不一致的后果都很隐蔽：
  //   - 客户端少一档 → 那个档位在界面上根本无法选中，而 API 完全支持它；
  //   - 顺序不一致 → 分段控件的高亮与守则措辞看起来对不上。
  const spoilerSource = readFileSync(join(ROOT, 'lib', 'host', 'spoiler.js'), 'utf8')

  const hostBlock = /WEB_GATE_MODES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(spoilerSource)
  assert.ok(hostBlock !== null, '没能从 spoiler.js 里提取 WEB_GATE_MODES —— 提取逻辑可疑')
  const hostModes = [...hostBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1])

  const clientBlock = /WEB_GATE_CHOICES\s*=\s*Object\.freeze\(\[([\s\S]*?)\n\s*\]\)/.exec(clientSource)
  assert.ok(clientBlock !== null, '没能从 client.js 里提取 WEB_GATE_CHOICES —— 提取逻辑可疑')
  const clientModes = [...clientBlock[1].matchAll(/value:\s*'([^']+)'/g)].map((match) => match[1])

  // 两侧都要真的提到东西，否则下面可能拿两个空数组"通过"。
  assert.equal(hostModes.length, 3, `宿主应当正好三档，实际 ${hostModes.length}`)
  assert.deepEqual(clientModes, hostModes, '客户端的分段控件必须与宿主的三档逐字同序')
})

/**
 * **接线守卫：判"这一节是不是分组的"只能有一处定义。**
 *
 * 2026-10-01 的 P0 就是这个形状：这个判定当时散在 6 处
 * `BACKGROUND_GROUPED_SECTIONS.includes(...)`（解析 / 归组 / 渲染 / 合并 / 取代 /
 * 拆单元）。给读者族加「时间与分线」时，`BACKGROUND_SECTIONS` 接对了、**分组判定
 * 漏了一族** ⇒ `### 主线` 与 `### 【支线】… · 第N-M章` 在**每一次写盘**时被静默
 * 丢掉（连带标题里的章号区间），而 627 条行为断言全绿放行——因为它们只断到
 * `## 时间与分线` 这一层。
 *
 * 所以这里钉的不是行为，是**接线形状**（`docs/design.md`「测试」小节里的第三类守卫
 * —— 那句原文写的是"第三类"，这里从前写成了"design.md 的第三类守卫"，而设计稿里
 * 从没有过这个小节名；2026-10-02 批 5 把指路改成可核对的那一节）：想知道某节是不是
 * 分组的，一律走 `isGroupedSection()`。行为那一半由 `background.test.mjs` 的
 * 读者族往返断言看着。
 */
test('接线：分组判定只有一处定义（host 侧不许再写裸的 BACKGROUND_GROUPED_SECTIONS.includes）', () => {
  const hostDir = join(ROOT, 'lib', 'host')
  const files = readdirSync(hostDir).filter((name) => name.endsWith('.js')).sort()
  assert.ok(files.length >= 10, `只扫到 ${files.length} 个 host 文件，扫描逻辑可疑`)

  const NEEDLE = 'BACKGROUND_GROUPED_SECTIONS.includes'
  const offenders = []
  let predicateHits = 0
  let predicateWhere = ''
  for (const name of files) {
    const source = readFileSync(join(hostDir, name), 'utf8')
    source.split('\n').forEach((line, index) => {
      const code = line.trim()
      if (line.includes(NEEDLE)) {
        // 注释里提到这个写法是**解释**（本守卫自己也提到），不算接线。
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
        offenders.push(`${name}:${index + 1}: ${code}`)
      }
      // 2026-10-03：分区定义搬进了 `host/sections.js` 的注册表，`isGroupedSection` 的判据
      // 也随之从 `.includes(...)` 变成"读注册表那一行的 `grouped` 字段"。
      // ⚠️ 这里钉的是**数量**（正好一处实现），**不是位置** —— 位置再搬一次不该红
      //    （旧写法把文件硬编码成 `background.js`，实现一搬家它就误报）。
      if (code.startsWith('export function isGroupedSection')) {
        predicateHits += 1
        predicateWhere = name
      }
    })
  }

  assert.equal(
    predicateHits,
    1,
    `isGroupedSection 应当正好有一处实现 —— 现在 ${predicateHits} 处（${predicateWhere || '找不到'}），`
      + `找不到说明提取逻辑可疑`,
  )
  assert.deepEqual(
    offenders,
    [],
    `分组判定必须只走 isGroupedSection()，这些地方又写回了裸常量（漏一族 = 读者族的 `
      + `\`###\` 每次写盘被静默丢掉）：\n${offenders.join('\n')}`,
  )
})

test('接线：分区常量只在 host/sections.js 里定义（一个概念一个定义点）', () => {
  // 2026-10-03 的注册表重构之前，"一节"的各个侧面是 **19 张平行常量表**，全在
  // `background.js` 里，靠"顺序必须与权重同序""定义必须排在读者族之前（const 不提升）"
  // 这类纪律维持 —— 而 2026-10-01 那次（`### 主线` 每次写盘被丢、627 条行为断言全绿放行）
  // 的根因正是**一个概念有多个定义点**。
  //
  // 现在这些名字全部从 `sections.js` 的 `BACKGROUND_SECTIONS_TABLE` **派生**，
  // `background.js` 只 import + re-export。这条守卫钉住"派生"这件事不被改回去：
  // 任何一个分区常量**只能在 sections.js 里被声明**（`export { … } from` 那种再导出不算声明）。
  const hostDir = join(ROOT, 'lib', 'host')
  const files = readdirSync(hostDir).filter((name) => name.endsWith('.js')).sort()
  assert.ok(files.length >= 10, `只扫到 ${files.length} 个 host 文件，扫描逻辑可疑`)

  const DERIVED = [
    'BACKGROUND_ARCHIVE_EXEMPT_SECTIONS',
    'BACKGROUND_ARCHIVE_SECTION',
    'BACKGROUND_BACKBONE_UNITS',
    'BACKGROUND_FULL_SECTIONS',
    'BACKGROUND_GROUPED_SECTIONS',
    'BACKGROUND_INJECTED_SECTIONS',
    'BACKGROUND_LEGACY_SECTIONS',
    'BACKGROUND_READER_GROUPED_SECTIONS',
    'BACKGROUND_READER_SECTIONS',
    'BACKGROUND_RETIRED_SECTION',
    'BACKGROUND_SECTION_WEIGHTS',
    'BACKGROUND_SECTIONS',
    'BACKGROUND_SECTIONS_TABLE',
    'BACKGROUND_STATE_SECTION',
    'BACKGROUND_TYPE_SECTION',
    'BACKGROUND_WRITE_ONCE_SECTIONS',
    'COMPRESSIBLE_SECTIONS',
    'FILL_INCREMENTAL_SECTIONS',
    'SECTION_UNIT_NOUN',
  ]
  const HOME = 'sections.js'
  const misplaced = []
  for (const name of DERIVED) {
    // 声明形状：`export const X =` / `const X =` / `export function X(`（再导出不匹配）。
    const DECL = new RegExp(`^(export )?(const|function) ${name}\\b`)
    const declaring = files.filter((file) => {
      const source = readFileSync(join(hostDir, file), 'utf8')
      return source.split('\n').some((line) => DECL.test(line.trim()))
    })
    if (declaring.length !== 1 || declaring[0] !== HOME) {
      misplaced.push(`${name}: 声明在 [${declaring.join(', ') || '无'}]，应当只在 ${HOME}`)
    }
  }
  assert.deepEqual(
    misplaced,
    [],
    `分区常量必须在 ${HOME} 的注册表里派生，别在别处再写一张表（一个概念多个定义点 = `
      + `2026-10-01 那次事故的根因）：\n${misplaced.join('\n')}`,
  )
})

test('接线：共享缺省值只在 host/defaults.js 里写字面量（两边同源于唯一常量）', () => {
  // 这些数各有**两个落点**：`lib/index.js` 的 `DEFAULTS`（配置缺省）与
  // `lib/host/library.js` 里的 `options.xxx ?? <同一个数>`（直接调 `createLibrary` 的兜底）。
  // 从前靠**纪律**维持同值 —— 而 `library.js` 里那句"必须与 DEFAULTS 同值，有测试钉住不许
  // 分叉"本身就是证据：`backgroundBudgetChars` **分叉过一次**。
  //
  // 2026-10-03 起改成**由 import 保证**（`host/defaults.js` 的 `HOST_DEFAULTS`）。
  // 这条守卫钉的就是这件事：**字面量只许出现在 defaults.js**，另外两个文件只许引用它。
  // 先例：`long-chapter-split.test.mjs`「createLibrary 的兜底与 CONFIG_DEFAULTS 同源于
  // 唯一常量（不是两个字面量碰巧同值）」—— 同一个做法，这里是推广后的那几对。
  const KEYS = [
    'backgroundBudgetChars',
    'fallbackBlockChars',
    'headAllowanceChars',
    'minPerChapter',
    'maxPerChapter',
    'discussionLimit',
  ]
  const HOME = join(ROOT, 'lib', 'host', 'defaults.js')
  const indexSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const libSrc = readFileSync(join(ROOT, 'lib', 'host', 'library.js'), 'utf8')
  const homeSrc = readFileSync(HOME, 'utf8')

  const problems = []
  for (const key of KEYS) {
    // defaults.js：`key: <数字>` 恰好一处（这就是那个"唯一字面量"）
    const literals = homeSrc.split('\n').filter((line) => new RegExp(`^\\s*${key}:\\s*-?\\d`).test(line))
    if (literals.length !== 1) {
      problems.push(`${key}: defaults.js 里的字面量有 ${literals.length} 处，应当正好 1 处`)
    }
    // 另外两处：只许引用 HOST_DEFAULTS.<key>
    const ref = `HOST_DEFAULTS.${key}`
    if (!indexSrc.includes(ref)) problems.push(`${key}: lib/index.js 没有引用 ${ref}`)
    if (!libSrc.includes(ref)) problems.push(`${key}: lib/host/library.js 没有引用 ${ref}`)
    // 反向：index.js 里不许再有 `key: <数字>`（配置缺省又写回字面量）
    const backslide = indexSrc.split('\n').filter((line) => new RegExp(`^\\s*${key}:\\s*-?\\d`).test(line))
    if (backslide.length > 0) {
      problems.push(`${key}: lib/index.js 又写回了字面量 —— ${backslide[0].trim()}`)
    }
  }
  assert.deepEqual(
    problems,
    [],
    `共享缺省值必须同源于 host/defaults.js 的 HOST_DEFAULTS（分叉过一次的东西别再靠纪律）：\n`
      + problems.join('\n'),
  )
})

test('接线：封存件的条目号必须带文件名（裸 §N 等于没指路）', () => {
  // `docs/design-v1-archive.md` 里的条目号（比如那里的 §204、§105）就是这种编号。
  // 不写文件名，读者拿这个号去 `design.md` 里找是找不到的 —— 而 2026-10-02 之前
  // `lib/` 里有 29 处这样的裸引用（代码健康度评审 #26 的一半：补文件名）。
  //
  // 这条守卫扫源码（本文件同一族），不看行为：它是**注释里的可发现性**，
  // 行为断言看不见。带小节的 `§5.4` 不算（那是另一套编号），已经指过路的也不管。
  const targets = []
  const collect = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.tmp') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) collect(full)
      else if (/\.(js|mjs)$/.test(name)) targets.push(full)
    }
  }
  collect(join(ROOT, 'lib'))
  collect(join(ROOT, 'test'))
  assert.ok(targets.length >= 40, `只扫到 ${targets.length} 个源文件，扫描逻辑可疑`)

  const offenders = []
  for (const file of targets) {
    const source = readFileSync(file, 'utf8')
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    const re = /§(\d+)(?![\d.])/g
    let match
    while ((match = re.exec(source)) !== null) {
      const before = source.slice(Math.max(0, match.index - 60), match.index)
      if (/archive|design-history|design\.md/.test(before)) continue
      offenders.push(`${rel}:${source.slice(0, match.index).split('\n').length}: §${match[1]}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `这些引用没写文件名，读者按号找不到（应写成 \`docs/design-v1-archive.md §N\`）：\n${offenders.join('\n')}`,
  )
})

test('接线：fill 结果整包进响应体，且 `fillMemoryGap` 三个成功出口键集一致', () => {
  // 治的是「跨四层少一层就静默失效」这个 bug 类 —— **已踩三次**，最狠的一次是
  // `truncatedSuspected`：fill 结果里有这个旗子、客户端也在读它，但路由的逐字段
  // 转发**从来没带上它**，于是"输出像是被截断了"那句提示在真机上**一直是哑的**。
  //
  // 契约有两条，缺一条这个坑就会回来：
  //   ① 路由**整包转发**（`...result`），新增字段不必再去路由里手抄一遍；
  //   ② `fillMemoryGap` 的**每个成功出口都给出同一套键** —— 因为路由不再替它兜
  //      默认值了，少一个键客户端拿到的就是 `undefined`（`compact.test.mjs` 的 T4
  //      就是这么红的：它断言 `skipped === false`，而那条路当时干脆没有这个键）。
  const lines = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8').split('\n')
  // ① 路由整包转发
  const routeAt = lines.findIndex((line) => line.includes("pattern: '/books/:bookId/background/fill'"))
  assert.ok(routeAt > 0, '找不到 fill 路由 —— 它被改名或搬走了，这条守卫要跟着更新')
  // ⚠️ 只看**成功分支**那几行：失败分支里 `result.compact ?? null` 之类的兜底是合法的
  //    （它在拼错误体，不是在转发成功结果）。
  const okAt = lines.findIndex(
    (line, i) => i > routeAt && i < routeAt + 120 && /return ok\(\{/.test(line),
  )
  assert.ok(okAt > 0, '找不到 fill 路由成功分支的 `return ok({`')
  const okBody = lines.slice(okAt, okAt + 8).join('\n')
  assert.ok(
    /\.\.\.result,/.test(okBody),
    'fill 路由必须**整包转发**结果对象（`return ok({ ...result, … })`）—— '
      + '改回逐字段手抄，下一个新字段就会静默丢掉',
  )
  assert.ok(
    !/result\.\w+\s*(===|\?\?)/.test(okBody),
    'fill 路由的成功分支里不该再有逐字段的 `result.xxx === …` / `result.xxx ?? …` —— '
      + '那些默认值现在归产生侧（`fillMemoryGap` 的出口）负责',
  )

  // ② 三个成功出口键集一致（扫 `fillMemoryGap` 内部，按花括号深度取每个 `return {` 的顶层键）
  // ⚠️ **不钉文件位置**：它 2026-10-03 从 `lib/index.js` 搬到了 `lib/host/memory-pipeline.js`
  //    （甲-4a），而"实现搬家 ⇒ 守卫误报"这个坑本仓库刚踩过一次（见甲-1 的
  //    「分组判定只有一处定义」）。所以这里在 `lib/` 里**找**它，不写死路径。
  const pipelineSrc = findLibFileDeclaring('fillMemoryGap')
  assert.ok(pipelineSrc !== null, '在 lib/ 里找不到 fillMemoryGap 的声明 —— 它被改名或删了？')
  const fnLines = readFileSync(pipelineSrc, 'utf8').split('\n')
  const fnAt = fnLines.findIndex((line) => /^(export )?(async )?function fillMemoryGap\b/.test(line))
  assert.ok(fnAt > 0, '找不到 fillMemoryGap')
  const fnEnd = fnLines.findIndex((line, i) => i > fnAt && line === '}')
  assert.ok(fnEnd > fnAt, '找不到 fillMemoryGap 的结尾')

  const successKeySets = []
  for (let i = fnAt; i < fnEnd; i += 1) {
    if (!/^\s*return \{$/.test(fnLines[i])) continue
    const keys = []
    let depth = 0
    for (let j = i; j < fnEnd; j += 1) {
      const line = fnLines[j]
      // ⚠️ 必须同时认**简写键**（`compact,` / `archived,`）—— 只认 `name:` 会漏掉它们，
      //    然后报出一堆假差异（第一版就是这么错的）。
      const topKey = depth === 1 ? line.match(/^\s{2,}(\w+)\s*[:,]/) : null
      if (topKey !== null) keys.push(topKey[1])
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      if (depth <= 0 && j > i) break
    }
    if (keys.includes('ok')) successKeySets.push({ at: i + 1, keys: keys.filter((k) => k !== 'ok') })
  }

  assert.ok(
    successKeySets.length >= 3,
    `fillMemoryGap 里只找到 ${successKeySets.length} 个带 ok 的出口，预期至少 3 个`,
  )
  const [first, ...rest] = successKeySets
  const problems = []
  for (const other of rest) {
    const missing = first.keys.filter((k) => !other.keys.includes(k))
    const extra = other.keys.filter((k) => !first.keys.includes(k))
    if (missing.length > 0) problems.push(`L${other.at} 少了 ${missing.join(', ')}（L${first.at} 有）`)
    if (extra.length > 0) problems.push(`L${other.at} 多了 ${extra.join(', ')}（L${first.at} 没有）`)
  }
  assert.deepEqual(
    problems,
    [],
    '`fillMemoryGap` 的成功出口必须给出**同一套键** —— 路由整包转发后不再替它兜默认值，'
      + `少一个键客户端就是 undefined：\n${problems.join('\n')}\n`
      + `（L${first.at} 的键：${first.keys.join(', ')}）`,
  )
})

/**
 * 在 `lib/` 里找**声明**了某个模块级名字的文件，返回绝对路径（找不到回 null）。
 *
 * ⚠️ 存在的理由：实现会**搬家**（`fillMemoryGap` 2026-10-03 从 `index.js` 搬到
 * `host/memory-pipeline.js`），而把路径写死在守卫里 ⇒ 一搬家就误报。
 * 本仓库刚踩过一次（甲-1 的「分组判定只有一处定义」），所以新守卫一律**找**，不写死。
 *
 * @param {string} name
 * @returns {string|null}
 */
function findLibFileDeclaring(name) {
  // ⚠️ 必须带 `m`：不带的话 `^` 只匹配**整个文件的开头**，于是永远找不到（我第一版
  //    就是这么错的，而这条教训上一轮刚记过 —— `new RegExp(x, 'g')` 会整体替换 flags）。
  const pattern = new RegExp(`^(export )?(async )?(function|const|let|class) ${name}\\b`, 'm')
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        const hit = walk(full)
        if (hit !== null) return hit
      } else if (entry.endsWith('.js') && pattern.test(readFileSync(full, 'utf8'))) {
        return full
      }
    }
    return null
  }
  return walk(join(ROOT, 'lib'))
}
