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
import { readFileSync } from 'node:fs'
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
  assert.match(joined, /\/context/, 'P2：客户端必须能做 AI 视角预览')
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
