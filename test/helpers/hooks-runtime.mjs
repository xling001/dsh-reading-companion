/**
 * 最小 hooks 运行时（2026-10-03，B 档）—— 让浏览器半边的组件**真的能跑起来**。
 *
 * ## 为什么需要它
 *
 * `client.test.mjs` 原来的 react 替身是"只取初值"的：`useState` 返回
 * `[初值, 空函数]`、`useEffect` 是空函数。于是组件**只渲染初始那一帧**，而
 * 浏览器半边真正的行为都在那一帧之后 —— 取数（effect）、点按钮（setState →
 * 重渲染）、视图记忆、位置恢复，**一条都测不到**。
 *
 * 测不到就会长出另一种东西：**读源码文本、断言某一行还在**（"接线守卫"）。
 * 实测：`test/` 里 56 条接线守卫有 **43 条挤在 `client.test.mjs`**，因为
 * `useEffect` 跑不起来，就只能断言 `source.includes('const fillRequest = callApi(')`。
 * 代价是**改注释、换行、重命名局部变量都可能让它红**，而真正接错线时它又未必红。
 *
 * 这个文件实现**够用的那部分 React**：状态真的更新并重渲染、effect 真的跑
 * （带依赖比较与清理）、`memo` 真的浅比较并跳过、`useCallback`/`useMemo` 真的缓存。
 * 专供**新写的**行为断言使用（opt-in）——`client.test.mjs` 里那 123 条既有用例
 * 一行都不动，它们用的是自己那份静态替身。
 *
 * ## 刻意不做的
 *
 * 并发与调度优先级、Context、Suspense、真实 DOM diff、事件系统、错误边界。
 * 这套运行时只回答一个问题：**"这个组件的状态变化之后，它算出来的树长什么样、
 * 它调了哪些 API"**。做了不需要的部分只会让这个文件更难懂。
 *
 * ## 已知限制（写断言前先看）
 *
 *   · **一个组件函数一份实例**：同一个组件在树里出现两次会共用状态。单棵树、
 *     单个受测组件足够用；真需要多实例时再按 (组件, 位置) 建键。
 *   · **没有 DOM**：`react` 产出的节点是普通对象（`{ type, props, children }`），
 *     断言看的是这棵树，不是真实渲染结果。
 *   · **事件要自己触发**：拿到节点后直接调 `node.props.onClick?.(...)`——
 *     等价于"读者点了这个按钮"，这正是原来那些字符串钉子够不着的地方。
 *   · ⚠️ **`memo` 命中时子树会从树上消失**（2026-10-03 实测踩到，别重复这个坑）：真 React
 *     会**复用上一棵子树**，而这个运行时在命中时直接 `return null`。于是"状态没变的那次
 *     重渲染"会让被 `memo` 包住的子树**整块不见**，拿它里面的文字当判据会得到**假红**
 *     （守卫明明生效，断言却说"没渲染出来"）。**判据别选 `memo` 子树里的内容** ——
 *     改用外层直接渲染的东西（例如 `NotesView` 自己渲染的 tab 计数）。
 *
 * ⚠️ 上面"56 条 / 43 条"是 2026-10-03 早先那次**独立审计脚本**（`drc-guard-audit/`）的口径；
 *    `npm run guard:census` 的判据更窄（只认读**生产源码与文档**），同一时刻给的是 51 / 38。
 *    两个数**都对**，只是问的问题不同 —— 引用时请写清是哪一个。
 */

/** 与 `React.memo` 默认比较同语义：逐 key 用 `Object.is`。 */
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

/** 依赖数组比较：`undefined`（没给 deps）永远算"变了"——与 React 一致。 */
function sameDeps(a, b) {
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (a.length !== b.length) return false
  return a.every((value, i) => Object.is(value, b[i]))
}

/** 渲染轮数上限：effect 里无条件 setState 会让渲染永不收敛，这里要**报错**而不是挂死。 */
const MAX_PASSES = 32

/**
 * 造一套 hooks 运行时。
 *
 * @returns {{react: object, render: Function, act: Function, unmount: Function, instances: Map}}
 *   `react` 直接当模块替身喂给客户端 factory；`render(element)` 渲染并跑 effect；
 *   `act(fn)` = "读者做了一件事"（回调里 setState）之后把更新收敛掉。
 */
export function createHooks() {
  /** 组件函数 → 实例（hook 槽按调用顺序存）。 */
  const instances = new Map()
  /** 正在渲染的实例；hook 只能取到它。 */
  let current = null
  /** 本次渲染之后要跑的 effect。 */
  let pendingEffects = []
  /** 有 setState 把状态改了 ⇒ 需要再渲染一轮。 */
  let dirty = false
  /** 最近一次渲染的根节点（`act` 靠它重渲染）。 */
  let lastRoot = null

  const instanceFor = (fn) => {
    let inst = instances.get(fn)
    if (inst === undefined) {
      inst = { fn, slots: [], cursor: 0, props: null, lastMemoProps: null, rendered: false }
      instances.set(fn, inst)
    }
    return inst
  }

  /** 取当前实例的第 N 个 hook 槽（hook 调用顺序必须稳定，与 React 同一条规矩）。 */
  const slot = () => {
    if (current === null) throw new Error('hook 在组件函数之外被调用了')
    const at = current.cursor
    current.cursor += 1
    return { inst: current, at }
  }

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? null, children }),

    /**
     * `memo`：真的浅比较、命中时真的跳过、并记账（`renders` / `bailouts`）。
     *
     * 笔记列表的性能**全靠** memo。"抽成独立组件但忘了包 memo"、"给子组件传了
     * 每次新建的数组/函数"都是**不报错、只变慢**的失效模式 —— 只有替身真的比较，
     * 断言才钉得住。
     */
    memo(fn, compare = shallowEqualProps) {
      const wrapper = (props) => {
        const inst = instanceFor(wrapper)
        if (inst.rendered && compare(inst.props, props)) {
          wrapper.bailouts += 1
          return null
        }
        inst.props = props
        inst.rendered = true
        wrapper.renders += 1
        return fn(props)
      }
      wrapper.__memo = true
      wrapper.__inner = fn
      wrapper.renders = 0
      wrapper.bailouts = 0
      return wrapper
    },

    useState(initial) {
      const { inst, at } = slot()
      if (inst.slots[at] === undefined) {
        inst.slots[at] = {
          kind: 'state',
          value: typeof initial === 'function' ? initial() : initial,
          set: null,
        }
      }
      const entry = inst.slots[at]
      // setter 的引用必须**跨渲染稳定**（React 就是这样）：否则每次渲染都换函数，
      // 下游 memo 的浅比较必然失败，"跳过重渲染"这件事就永远测不出来。
      if (entry.set === null) {
        entry.set = (next) => {
          const value = typeof next === 'function' ? next(entry.value) : next
          if (Object.is(value, entry.value)) return
          entry.value = value
          dirty = true
        }
      }
      return [entry.value, entry.set]
    },

    useRef(initial) {
      const { inst, at } = slot()
      if (inst.slots[at] === undefined) inst.slots[at] = { kind: 'ref', value: { current: initial } }
      return inst.slots[at].value
    },

    useMemo(fn, deps) {
      const { inst, at } = slot()
      const entry = inst.slots[at]
      if (entry !== undefined && entry.kind === 'memo' && sameDeps(entry.deps, deps)) return entry.value
      const value = fn()
      inst.slots[at] = { kind: 'memo', value, deps }
      return value
    },

    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps)
    },

    useEffect(fn, deps) {
      const { inst, at } = slot()
      const entry = inst.slots[at]
      if (entry !== undefined && entry.kind === 'effect' && sameDeps(entry.deps, deps)) return
      inst.slots[at] = { kind: 'effect', deps, cleanup: entry?.cleanup }
      pendingEffects.push({ inst, at, fn, previousCleanup: entry?.cleanup })
    },
  }

  /**
   * 所有宿主节点（`div` / `p` / `button` …）共享的原型。
   *
   * 为什么要有它：真实的 React 会**复用同一个 DOM 节点**、只改 props，而这套运行时
   * 每次渲染都造新对象。于是"组件往 DOM 上写了什么"（`scroller.scrollTop = …`）
   * 就抓不住了 —— 上一轮抓到的那个对象早被丢掉。
   *
   * 共享原型解决这件事：**测试**可以往上装 accessor（`Object.defineProperty`），
   * 那个 setter 对**每一轮**渲染出来的节点都生效。位置恢复那条用例靠它观察
   * "正文到达那一趟真的落位了"。
   */
  const hostProto = {}

  /** 走一遍树：函数组件真的被调用，产出的节点再递归。 */
  const renderNode = (node, depth = 0) => {
    if (depth > 32 || node === null || node === undefined || typeof node === 'boolean') return node
    if (Array.isArray(node)) return node.map((child) => renderNode(child, depth + 1))
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      // ⚠️ `children` 只在**真的有**的时候才放进 props —— 与 React 一致。
      //    曾经无条件写成 `children: node.children`，于是每次渲染都是一个新的
      //    空数组，`memo` 的浅比较必然失败（自测当场抓到）：
      //    "跳过重渲染"这件事就永远测不出来，而笔记列表的性能全靠它。
      const props = { ...(node.props ?? {}) }
      if (node.children.length === 1) props.children = node.children[0]
      else if (node.children.length > 1) props.children = node.children
      const inst = instanceFor(node.type)
      inst.cursor = 0
      const outer = current
      current = inst
      let out
      try {
        out = node.type(props)
      } finally {
        current = outer
      }
      return renderNode(out, depth + 1)
    }
    const rendered = Object.assign(Object.create(hostProto), node, {
      children: (node.children ?? []).map((child) => renderNode(child, depth + 1)),
    })
    // 真的把 ref 挂上去（对象 ref 与回调 ref 都支持）。
    // 没有这一步，"组件在 effect 里对 DOM 做的动作"整类都测不到：
    // 组件里的 `scrollerRef.current` 恒为 null，effect 一律早退。
    const ref = node.props?.ref
    if (typeof ref === 'function') ref(rendered)
    else if (ref !== null && typeof ref === 'object' && 'current' in ref) ref.current = rendered
    return rendered
  }

  /** 跑一遍本轮收集到的 effect：先清理上一轮，再跑新的，并留住新的清理函数。 */
  const runEffects = () => {
    const list = pendingEffects
    pendingEffects = []
    for (const item of list) {
      item.previousCleanup?.()
      const cleanup = item.fn()
      const entry = item.inst.slots[item.at]
      if (entry !== undefined) entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  /**
   * 渲染（并按需多跑几轮）。
   *
   * 多轮是必须的：effect 里 setState 是常见写法（"取完数就 setData"），
   * 一轮渲染 + 跑 effect 之后状态已经变了，必须再渲染一次才算稳定。
   */
  const render = (element) => {
    lastRoot = element
    let tree
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      dirty = false
      pendingEffects = []
      tree = renderNode(element)
      runEffects()
      if (!dirty) return tree
    }
    throw new Error(`渲染没有收敛（${MAX_PASSES} 轮之后状态还在变）—— 多半是 effect 里无条件 setState`)
  }

  /** "读者做了一件事"：跑回调（里面的 setState 会记脏），然后收敛。 */
  const act = (fn) => {
    fn?.()
    if (lastRoot === null) throw new Error('act() 之前要先 render()')
    return render(lastRoot)
  }

  /** 卸载：把每个 effect 的清理函数跑一遍（与 React 卸载同语义）。 */
  const unmount = () => {
    for (const inst of instances.values()) {
      for (const entry of inst.slots) {
        if (entry !== undefined && typeof entry.cleanup === 'function') entry.cleanup()
      }
    }
    instances.clear()
    lastRoot = null
  }

  return { react, render, act, unmount, instances, hostProto }
}

/**
 * 在渲染树上找节点。
 *
 * @param {unknown} tree `render()` 的返回值
 * @param {(node: object) => boolean} predicate 判定
 * @returns {object|null} 第一个命中的节点
 */
export function findNode(tree, predicate) {
  let hit = null
  const walk = (node, depth) => {
    if (hit !== null || depth > 32 || node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    if (predicate(node)) {
      hit = node
      return
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  walk(tree, 0)
  return hit
}

/**
 * 在渲染树上找**自己的文字**等于/包含某个串的节点。
 *
 * ⚠️ 只看节点**自己**那一层的文字（`props.title/label/value/children` 与
 * `node.children` 里的字符串），不看后代 —— 否则任何祖先都会命中。
 * ⚠️ `createElement(type, props, ...children)` 把子节点放在 `node.children` 里，
 * 所以**两个地方都要看**：只查 `props.children` 会漏掉所有宿主元素
 * （`h('button', {...}, '本章你记过 1 条')` 就是这种）。
 *
 * @param {unknown} tree `render()` 的返回值
 * @param {string|RegExp} needle 要找的文字
 * @returns {object|null}
 */
export function findText(tree, needle) {
  const matches = (text) => (needle instanceof RegExp ? needle.test(text) : text.includes(needle))
  return findNode(tree, (node) => {
    const props = node.props ?? {}
    const texts = [props.children, props.title, props.label, props.value]
      .filter((value) => typeof value === 'string')
    if (texts.some(matches)) return true
    return (node.children ?? []).some((child) => typeof child === 'string' && matches(child))
  })
}

/** 把一条节点流里的文字全拼起来（"界面上到底写没写这句话"）。 */
export function treeText(node) {
  const walk = (item) => {
    if (item === null || item === undefined || item === false || item === true) return ''
    if (Array.isArray(item)) return item.map(walk).join('')
    if (typeof item !== 'object') return String(item)
    const props = item.props ?? {}
    const own = [props.children, props.title, props.label, props.value]
      .filter((value) => typeof value === 'string')
      .join(' ')
    return [own, ...(item.children ?? []).map(walk)].join(' ')
  }
  return walk(node)
}

/**
 * 造一个记录调用的 `fetch` 替身（客户端只走 global `fetch`）。
 *
 * 路由用 `[匹配规则, 响应]` 的数组给：规则可以是字符串（`url.includes`）或正则；
 * 响应可以是 `{ body }`（自动包成 200 JSON）、也可以是 `{ status, body }`，
 * 或一个直接返回 `Response` 的函数。命中不了的路由**抛错**——静默返回 404 会让
 * "本该取数却没取"的缺陷看起来像正常。
 *
 * @param {Array<[string|RegExp, object|Function]>} routes 路由表
 * @returns {{fetch: Function, calls: Array<{url: string, options: object}>}}
 */
export function makeFetch(routes) {
  const calls = []
  const fetchStub = async (url, options = {}) => {
    const target = String(url)
    calls.push({ url: target, options })
    for (const [pattern, handler] of routes) {
      const matched = typeof pattern === 'string' ? target.includes(pattern) : pattern.test(target)
      if (!matched) continue
      if (typeof handler === 'function') return handler(target, options)
      const status = handler.status ?? 200
      const payload = handler.body ?? {}
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`fetch 替身没有配这条路由：${options.method ?? 'GET'} ${target}`)
  }
  return { fetch: fetchStub, calls }
}
