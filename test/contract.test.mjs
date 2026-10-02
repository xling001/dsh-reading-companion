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
  for (const name of files) {
    const source = readFileSync(join(hostDir, name), 'utf8')
    source.split('\n').forEach((line, index) => {
      if (!line.includes(NEEDLE)) return
      const code = line.trim()
      // 注释里提到这个写法是**解释**（本守卫自己也提到），不算接线。
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
      // 谓词自己那一行是唯一的合法处。
      if (name === 'background.js' && code.startsWith(`return ${NEEDLE}`)) {
        predicateHits += 1
        return
      }
      offenders.push(`${name}:${index + 1}: ${code}`)
    })
  }

  assert.equal(predicateHits, 1, 'isGroupedSection 应当正好有一处实现 —— 找不到说明提取逻辑可疑')
  assert.deepEqual(
    offenders,
    [],
    `分组判定必须只走 isGroupedSection()，这些地方又写回了裸常量（漏一族 = 读者族的 `
      + `\`###\` 每次写盘被静默丢掉）：\n${offenders.join('\n')}`,
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
