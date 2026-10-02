/**
 * 浏览器半边的**公共加载器**：doc 替身 + react 替身 + factory 物化。
 *
 * 从 `client.test.mjs` 里抽出来的（2026-10-03，B 档）：新的 hooks 运行时
 * （`test/helpers/hooks-runtime.mjs`）也要走同一套"载入 `lib/client.js`、抓 factory、
 * 物化模块"的流程 —— 各写一份的话，将来某一处修了（比如加载序列、doc 替身的形状），
 * 另一处不会跟着好。这正是本仓库被评审点过的病："同一件事写 3~6 份"。
 *
 * ⚠️ `reactStub` 是**只取初值**的静态替身（`useState` 返回 `[初值, 空函数]`、
 * `useEffect` 是空函数）——既有 123 条结构性/冒烟用例靠它。要**真的跑**状态与
 * effect，用 `hooks-runtime.mjs` 的 `createHooks()` 造一份 react 传进来
 * （`loadClientModule(react)`）。
 */

import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let loadSeq = 0
/** 每次带不同 query，绕开 ESM 模块缓存。 */
export function freshUrl(rel) {
  loadSeq += 1
  return `${pathToFileURL(join(ROOT, rel)).href}?t=${loadSeq}`
}

/**
 * document 替身：真的维护「当前挂在 head 上的 style」这份状态。
 *
 * 这一点是刻意的——如果 `querySelector` 恒返回 null，「幂等注入」就永远为真，
 * 测试等于没测。所以这里把 appended 当作真实 DOM 来维护。
 */
export function makeFakeDocument() {
  const created = []
  const appended = []
  return {
    created,
    get liveStyles() {
      return appended
    },
    querySelector(selector) {
      const matched = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
      if (matched === null) return null
      return appended.find((el) => el.attrs['data-plugin-css'] === matched[1]) ?? null
    },
    createElement() {
      const el = {
        tagName: 'style',
        attrs: {},
        textContent: '',
        setAttribute(key, value) {
          this.attrs[key] = value
        },
        remove() {
          const at = appended.indexOf(el)
          if (at !== -1) appended.splice(at, 1)
        },
      }
      created.push(el)
      return el
    },
    head: {
      appendChild(el) {
        appended.push(el)
      },
    },
  }
}

/**
 * 假的 `localStorage`。
 *
 * ⚠️ **这个夹具是 2026-10-03 补的，别以为它一直在这儿**：在那之前 `makeFakeDocument()`
 * **不含** localStorage，而 `lib/client.js` 里所有"记住偏好"的路径都写成
 * `globalThis.localStorage?.getItem(…)` —— 缺了它，代码会**静默走空分支**（`?.` 短路），
 * 于是"跨会话记住"这类断言看起来在跑、其实**永远为真**。
 *
 * 用法（"跨会话"就是**换一台运行时**、存储不换）：
 * ```js
 * globalThis.localStorage = makeStorage({ 'drc:collapsed-categories': '["GL小说"]' })
 * const a = await runtime()
 * assert.deepEqual(a.internals.ShelfView(...), …)   // 第一会话：带着上次的偏好
 * const b = await runtime()                          // 第二会话：读的是同一份存储
 * ```
 * 断言"这件事**不**该碰持久层"时用 `writes`：`assert.deepEqual(storage.writes, [])`
 * （见下面 `writes` 的说明；`snapshot()` 看不出"写过又删掉 / 写了个空值"）。
 * 用完记得在 `finally` 里 `delete globalThis.localStorage`（别漏给下一个用例）。
 *
 * @param {Record<string, string>} [seed] 预置内容（模拟"上一个会话写过什么"）
 * @param {{ broken?: boolean }} [options] `broken: true` 模拟**隐私模式 / 配额用尽**
 *   （读写都抛错）—— 那是 `loadNameSet` / `saveNameSet` 里 try/catch 存在的理由，必须能真的复现。
 * @returns {{writes: Array<{op: string, key?: string, value?: string}>,
 *   getItem: (key: string) => string | null, setItem: (key: string, value: string) => void,
 *   removeItem: (key: string) => void, clear: () => void, peek: (key: string) => string | null,
 *   snapshot: () => Record<string, string>}}
 */
export function makeStorage(seed = {}, { broken = false } = {}) {
  const store = new Map(Object.entries(seed))
  /**
   * **成功**改动过持久层的每一次操作（`{ op, key, value }`）。
   *
   * 与 `snapshot()` 分工不同，两个都要有：
   *   · `snapshot()` 回答"最后剩下什么"；
   *   · `writes` 回答**"到底写没写、写了几次"**。
   * 断言"这件事**不**该碰持久层"时必须用 `writes` —— 例如目录里「卷」的展开状态是
   * **过程状态**（见 `isVolumeOpen` 的说明：开关一次不该写进任何持久层），
   * 而 `snapshot()` 在"写过又删掉""写了个空值"这两种情况下看不出来，`writes` 一眼可见。
   * ⚠️ 只记**成功**的那一次：`broken: true` 时抛错、什么都没写进去，就不该记账
   *    （否则"写失败"会被读成"写了"）。
   */
  const writes = []
  const boom = () => {
    throw new Error('localStorage 不可用（隐私模式 / 配额用尽）')
  }
  return {
    writes,
    getItem(key) {
      if (broken) boom()
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      if (broken) boom()
      store.set(key, String(value))
      writes.push({ op: 'set', key, value: String(value) })
    },
    removeItem(key) {
      if (broken) boom()
      store.delete(key)
      writes.push({ op: 'remove', key })
    },
    clear() {
      if (broken) boom()
      store.clear()
      writes.push({ op: 'clear' })
    },
    /** **绕过 `broken`** 偷看 —— 断言"抛错的那一次到底写没写进去"时必须用它。 */
    peek(key) {
      return store.has(key) ? store.get(key) : null
    },
    /** 当前全部内容 —— 断言"到底写没写进去"用（比逐个 getItem 更能发现多写）。 */
    snapshot() {
      return Object.fromEntries(store)
    },
  }
}

/** 浅比较：与 React.memo 的默认比较语义一致（逐 key 用 Object.is）。 */
export function shallowEqualProps(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !Object.is(a[key], b[key])) return false
  }
  return true
}

/** react 替身：工厂期只定义组件，不会调用这些 hook。 */
export const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [initial, () => {}],
  /**
   * `memo` 替身：真的做浅比较、命中时真的跳过渲染，并记账。
   *
   * 为什么不写成 `memo: (fn) => fn`：笔记列表的性能**全靠** memo，而
   * "抽成独立组件但忘了包 memo"、或者"给子组件传了每次新建的数组/函数"，
   * 都是**不会报错、只会变慢**的失效模式。只有让替身真的比较，测试才钉得住。
   */
  memo: (fn) => {
    let lastProps = null
    let rendered = false
    const wrapper = (props) => {
      if (rendered && shallowEqualProps(lastProps, props)) {
        wrapper.bailouts += 1
        return null
      }
      lastProps = props
      rendered = true
      wrapper.renders += 1
      return fn(props)
    }
    wrapper.__memo = true
    wrapper.__inner = fn
    wrapper.renders = 0
    wrapper.bailouts = 0
    return wrapper
  },
}

/** 载入浏览器半边并捕获它注册的 factory。 */
export async function loadClientFactory() {
  let captured = null
  let loadCount = 0
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loadCount += 1
        captured = definition
      },
    },
  }
  globalThis.document = makeFakeDocument()
  try {
    await import(freshUrl('lib/client.js'))
  } finally {
    delete globalThis.window
    delete globalThis.document
  }
  return { captured, loadCount }
}

/**
 * 物化 factory，拿到模块。
 *
 * @param {object} [react] react 替身；不给就是只取初值的 `reactStub`
 *   （要真的跑状态与 effect，传 `createHooks().react`）。
 */
export async function loadClientModule(react = reactStub) {
  const { captured } = await loadClientFactory()
  return captured.factory((spec) => {
    if (spec === 'react') return react
    throw new Error(`未预期的 require: ${spec}`)
  })
}
