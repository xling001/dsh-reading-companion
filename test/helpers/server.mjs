/**
 * 测试用的 HTTP 骨架。
 *
 * 刻意**不用 mock 的 req/res**：把真实的路由 handler 挂到 `node:http` 上，
 * 再真的 `fetch` 过去。这样才能覆盖 mock 覆盖不到的东西——URL 解析、请求体
 * 流式读取、状态码与 Content-Type、以及真实的 EventEmitter 时序。
 *
 * 抽成共享文件是因为 `routes.test.mjs`、`discussions.test.mjs`、
 * `compact.test.mjs` 都需要同一套东西；各写一份的话，将来某一处修了 bug
 * 另外两处不会跟着好。
 *
 * ⚠️ 这里测的是**插件自己的 handler**，不是 DSH Desktop 那层
 * `decideDesktopBrowserAccess`。那一层只放行带 Electron 渲染器令牌的请求，
 * 是宿主的策略，不在本插件的责任范围内。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TMP = join(ROOT, 'test', '.tmp')
export const API_ROOT = '/dsh-reading-companion/api'

let importSeq = 0
/** 每次带不同 query，绕开 ESM 模块缓存。 */
const freshUrl = (rel) => `${pathToFileURL(join(ROOT, rel)).href}?t=${importSeq++}`

/**
 * `fetch`（undici）按 Fetch 规范**在客户端直接拒绝**的端口。
 *
 * 关键在于：这批端口**即使服务端监听成功，请求也发不出去**，错误是
 * `TypeError: fetch failed` + cause `Error: bad port`。`6665–6669` 是**五个连续**
 * 端口，所以踩中时不是红一条，而是连红一片。
 *
 * 本仓库为什么踩得到：Windows 的临时端口区间**可以被配置成从 1024 起**
 * （`netsh int ipv4 show dynamicport tcp` → `Start Port: 1024 / Number: 58977`），
 * 于是区间里出现了 6000、6566、6665–6669、6679、6697、10080 等禁用端口；
 * 而 Windows 是**顺序分配**临时端口的（连起 40 个 server 会看到端口逐个 +1）。
 * 指针每跑一次全量就往上走几十个：扫过那一段就红一片，走过去就连续全绿。
 *
 * 默认区间（49152–65535）几乎踩不到，所以这条在别人机器上很难复现。
 *
 * @see test/harness-ports.test.mjs —— 现象、护栏与"红了该怎么办"都在那里
 */
export const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 153, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
])

/**
 * 起监听，直到拿到一个**不是 fetch 禁用端口**的临时端口。
 *
 * 为什么不改成"挑一个固定端口"：那会引入新的冲突面（EADDRINUSE）和一套重试策略，
 * 而 `listen(0)` 本来就是让内核挑，我们只需要**否决掉它挑到的那几个坏值**。
 * 一次否决最多多花一次 listen/close，代价可以忽略。
 *
 * @param {import('node:http').Server} server 还没 listen 的 server
 * @returns {Promise<number>} 可被 `fetch` 访问的端口
 */
export async function listenOnSafePort(server) {
  for (;;) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    if (!FETCH_BLOCKED_PORTS.has(port)) return port
    // 内核把我们送到了一个 fetch 发不出去的端口上：关掉，重挑一个。
    await new Promise((resolve) => server.close(resolve))
  }
}

/**
 * 一章正文。
 *
 * ⚠️ 标记在**首尾各出现一次**是刻意的。上一章默认只投喂尾部（见
 * `collectReadWindow` 的 `previousChapterMode`），如果标记只在章首，"上一章的
 * 正文到底进没进 prompt"就没法用标记断言了——而那正是这个夹具存在的主要用途
 * 之一。首尾都给一次，标记既能证明"进去了"，也能证明"进的是尾部"。
 */
const prose = (seed) =>
  `${seed}，他记得那天的雪落得很慢，像有人在半空里把时间掰开了一点点，然后一片一片地放下。他终于想起，自己叫${seed}。`

/** 一本三章的小书，每章都够长，能过章节解析的最低门槛。 */
export const BOOK = ['第一章 雪', prose('甲'), '', '第二章 夜', prose('乙'), '', '第三章 归', prose('丙')].join('\n')

/**
 * 启一个真服务器，把插件的 handler 挂上去。
 *
 * @param {string} dir 书库目录
 * @param {object} [options]
 * @param {object} [options.workspaceRegistry] 假的 workspaceRegistry
 * @param {object} [options.config] 传给 apply 的额外配置
 * @returns {Promise<{ base: string, services: object, close: Function }>}
 */
export async function startServer(dir, options = {}) {
  const host = await import(freshUrl('lib/index.js'))
  const registered = []
  const services = {}
  /**
   * 被注册的 system 段落回调与工具守卫。
   *
   * ⚠️ 这两个必须**捕获下来**，不能像早期那样写成 `() => () => {}` 丢掉。
   * 丢掉的话测试只能打到 `GET /context` 那条路由，而**真正的注入路径是这两个
   * 回调**——两者是不同的代码路径，路由绿了不代表注入绿了。这个空白是被一次
   * 变异验证抓出来的：把 `companionSection` 里的 `discussions` 改成空数组，
   * 所有测试依然全绿。
   */
  const hooks = { section: null, guard: null, emit: null }
  /**
   * `ctx.on` 注册的监听器。
   *
   * ⚠️ 与上面的 section / guard 同一个理由：背景更新那条路径的**唯一入口**就是
   * `session/event` 订阅。若把它写成 `() => () => {}` 丢掉，测试就只能打到纯函数，
   * 而"函数写对了但没接线"正是本仓库栽过三次的坑
   * （§198 ③ → §203 ② → §215 的 M4）。
   */
  const listeners = new Map()
  const ctx = {
    get: (name) => {
      if (name === 'dshHomePath') return (...parts) => join(TMP, ...parts)
      // 宿主侧解析工作区的唯一来源。真实实现是 dsh-workspace 的
      // `workspaceRegistry`（`list()` 同步返回带 `sessionIds` 的实体）。
      if (name === 'workspaceRegistry') return options.workspaceRegistry
      // 子代理相关：测试里默认没有，由各用例按需注入。
      if (name === 'subagents') return options.subagents
      if (name === 'agents') return options.agents
      return undefined
    },
    effect: (fn) => fn(),
    /**
     * 宿主事件订阅（`session/event` 走这条）。
     *
     * 返回 disposer，与 cordis 的 `ctx.on` 一致——`index.js` 把它交给 `ctx.effect`
     * 托管，所以这里必须回一个函数，否则"注册即可被回收"这条约定在测试里失真。
     */
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => {
        listeners.get(event)?.delete(listener)
      }
    },
    provide: (name, value) => {
      services[name] = value
      return () => {}
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
    // P2 起 host 半边把这两者列为硬依赖：少一个 apply 就会抛错。
    systemPrompt: {
      section: (spec) => {
        hooks.section = spec
        return () => {}
      },
    },
    tools: {
      guard: (fn) => {
        hooks.guard = fn
        return () => {}
      },
    },
    logger: {},
  }

  host.apply(ctx, { storageDir: dir, ...(options.config ?? {}) })
  assert.equal(registered.length, 1, '只应注册一条 prefix 路由')
  assert.ok(hooks.section !== null, 'system 段落回调必须被注册——那是正向投喂的唯一入口')
  assert.ok(
    (listeners.get('session/event')?.size ?? 0) > 0,
    'session/event 订阅必须被注册——那是背景更新（T1-②）的唯一入口',
  )
  /**
   * 触发一条宿主事件。
   *
   * 测试靠它走**真实的那条路**：事件 → 观察者 → 落盘，而不是直接调纯函数。
   */
  hooks.emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }

  const server = createServer(registered[0].handler)
  // ⚠️ 不要写回 `server.listen(0, ...)` + `server.address().port`：内核会分到
  // fetch 拒绝的端口（`bad port`），踩中时整个文件一起红。护栏见 listenOnSafePort。
  const port = await listenOnSafePort(server)

  return {
    base: `http://127.0.0.1:${port}${API_ROOT}`,
    services,
    hooks,
    listeners,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

let dirSeq = 0
/**
 * 建一个干净的测试书库目录。
 *
 * ⚠️ **目录名里的 `Date.now()` 不是装饰，是防"两次运行撞同一个路径"。**
 * 原先只有 `${tag}-${进程号}-${序号}`，而 **Windows 会重用进程号**、序号在同一处
 * 又是确定的 —— 两次不同的运行会算出**完全相同的路径**；用例大多不清理自己，
 * 于是**读到了上一轮的残留**（实测到一条只写 2 条记录的用例读到 4 条，表现是
 * 一堆与本轮改动毫无关系的红）。详见 CONTRIBUTING 的「与改动无关的红」一节。
 *
 * @param {string} [tag] 目录名前缀，便于在 .tmp 里分辨是哪个文件建的
 * @returns {string} 绝对路径
 */
export function makeDir(tag = 'http') {
  dirSeq += 1
  const dir = join(TMP, `${tag}-${process.pid}-${Date.now()}-${dirSeq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 发一个请求并解析 JSON。
 *
 * @param {string} url 完整 URL
 * @param {object} [options] { method, body }
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function call(url, options = {}) {
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}

/**
 * 导入一本书并返回它的 bookId。
 *
 * @param {string} base 服务器 base URL
 * @param {string} dir 用于写源文件的目录
 * @param {string} [title] 书名
 * @returns {Promise<string>}
 */
export async function importBook(base, dir, title = '测试书') {
  const absPath = join(dir, `src-${dirSeq}-${title}.txt`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(absPath, BOOK, 'utf8')
  const res = await call(`${base}/library/import`, { method: 'POST', body: { absPath, title } })
  assert.equal(res.status, 200, `导入失败：${JSON.stringify(res.body)}`)
  return res.body.book.bookId
}
