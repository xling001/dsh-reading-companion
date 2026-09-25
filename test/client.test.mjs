/**
 * 浏览器半边的结构性契约 + 纯函数边界 + 组件冒烟渲染。
 *
 * 这里刻意**不用真 react-dom**——那需要一整套渲染栈与宿主壳，装出来也只是
 * 在测替身。真正容易出错、也真正值得钉死的是三件事：
 *   1. 模块格式契约（惰性 CJS 信封、副作用留在 factory 内、可干净卸载）；
 *   2. 进度锚点相关的纯函数——偏移算错，用户的阅读位置就会漂；
 *   3. 每个视图**真的能执行一遍**（用迷你渲染器逐层调用函数组件），
 *      否则组件体里的拼写错误只会在用户点开面板时变成白屏。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ⚠️ 唯一一处从浏览器半边的测试里 import 宿主模块。原因见文末那条「两边逐字
//    相同」的契约测试：`chapterHeading` 是宿主 `chapterLabel` 的**镜像**，
//    而镜像只有在被摆在一起比对时才算数。
import { chapterLabel } from '../lib/host/spoiler.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-reading-companion'
const TAB_ID = 'dsh-reading-companion:reader'

let loadSeq = 0
function freshUrl(rel) {
  loadSeq += 1
  return `${pathToFileURL(join(ROOT, rel)).href}?t=${loadSeq}`
}

/**
 * document 替身：真的维护「当前挂在 head 上的 style」这份状态。
 *
 * 这一点是刻意的——如果 `querySelector` 恒返回 null，「幂等注入」就永远为真，
 * 测试等于没测。所以这里把 appended 当作真实 DOM 来维护。
 */
function makeFakeDocument() {
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

/** 浅比较：与 React.memo 的默认比较语义一致（逐 key 用 Object.is）。 */
function shallowEqualProps(a, b) {
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
const reactStub = {
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
async function loadClientFactory() {
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

/** 物化 factory，拿到模块。 */
async function loadClientModule() {
  const { captured } = await loadClientFactory()
  return captured.factory((spec) => {
    if (spec === 'react') return reactStub
    throw new Error(`未预期的 require: ${spec}`)
  })
}

/** 记录注册行为的宿主替身。effect 立即求值并保留 disposer。 */
function makeFakeClientContext(options = {}) {
  const effects = []
  const tabTypes = []
  const slotRegistrations = []
  const slotInjections = []
  const services = { ...(options.services ?? {}) }
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    /**
     * 可选的 Cordis 服务读取。
     *
     * 替身**必须**提供 `get`：插件用它读可选的 `sessions`（会话导航）。少了它
     * 五个测试会一起变成 `ctx.get is not a function` —— 那测的是替身，不是插件。
     */
    get(name) {
      return services[name]
    },
    slots: {
      inject(name, setup) {
        const dispose = setup()
        slotInjections.push({ name, dispose })
        return () => dispose?.()
      },
      register(options, Component) {
        slotRegistrations.push({ options, Component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, effects, tabTypes, slotRegistrations, slotInjections, services }
}

//#region 模块契约

test('浏览器半边：文件顶层只注册 factory，不产生副作用', async () => {
  const { captured, loadCount } = await loadClientFactory()
  assert.equal(loadCount, 1, '只允许注册一个 factory')
  assert.equal(captured.id, PLUGIN_NAME)
  assert.equal(typeof captured.factory, 'function')
})

test('浏览器半边：factory 物化后给出 apply / inject', async () => {
  const mod = await loadClientModule()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['sidebarRightTabs', 'slots'])
})

test('浏览器半边：注册页签类型、本体与标题，且全部挂在 effect 上', async () => {
  const mod = await loadClientModule()
  const { ctx, effects, tabTypes, slotRegistrations, slotInjections } = makeFakeClientContext()
  globalThis.document = makeFakeDocument()
  try {
    mod.apply(ctx)
  } finally {
    delete globalThis.document
  }

  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].id, TAB_ID)
  assert.equal(tabTypes[0].priority, 'extension', '不得占用 builtin/fallback 位')
  assert.equal(tabTypes[0].title(), '陪读模式')

  assert.deepEqual(
    slotInjections.map((entry) => entry.name).sort(),
    ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
  )

  const byName = new Map(slotRegistrations.map((entry) => [entry.options.name, entry]))
  const body = byName.get('sidebar.right.pane.tab')
  const title = byName.get('sidebar.right.pane.tab.title')
  assert.ok(body, '必须注册 pane body')
  assert.ok(title, '必须注册 pane title')
  assert.equal(body.options.key, TAB_ID)
  assert.equal(title.options.key, TAB_ID)
  assert.equal(typeof body.Component, 'function')

  // body 的 inject 必须把 sessionId 交给面板——「一本书一个会话」的锚点。
  assert.deepEqual(
    body.options.inject('sess-1'),
    { sessionId: 'sess-1', openSession: null, sidebarRight: undefined },
    '没有 sessions 服务时 openSession 必须是 null，而不是让 apply 抛错',
  )

  assert.equal(effects.length, 4, '四个 effect：样式、类型、body、title')
  for (const entry of effects) {
    assert.equal(typeof entry.dispose, 'function', `effect「${entry.label}」必须可卸载`)
  }
})

test('浏览器半边：有 sessions 服务时，面板拿到能用的 openSession', async () => {
  const mod = await loadClientModule()
  const opened = []
  const { ctx, slotRegistrations } = makeFakeClientContext({
    services: { sessions: { open: (id) => opened.push(id) } },
  })
  globalThis.document = makeFakeDocument()
  try {
    mod.apply(ctx)
  } finally {
    delete globalThis.document
  }

  const body = slotRegistrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const props = body.options.inject('sess-1')
  assert.equal(typeof props.openSession, 'function')
  props.openSession('bound-session')
  assert.deepEqual(opened, ['bound-session'])
})

test('浏览器半边：sessions 缺席只是少一个按钮，绝不阻止插件挂载', async () => {
  // 这是刻意用 ctx.get 而不是写进 inject 数组的原因：硬依赖一旦缺席，
  // **整个插件都不挂载**——书架、正文、笔记会一起消失。为一个便利按钮
  // 赌上整个插件不划算。这条测试把那个取舍钉住。
  const mod = await loadClientModule()
  const { ctx, tabTypes, slotRegistrations } = makeFakeClientContext()
  globalThis.document = makeFakeDocument()
  try {
    mod.apply(ctx)
  } finally {
    delete globalThis.document
  }
  assert.equal(tabTypes.length, 1, '没有 sessions 也照样注册页签类型')
  assert.equal(slotRegistrations.length, 2, '没有 sessions 也照样注册页签本体与标题')
})

test('浏览器半边：tab 类型必须带 guide —— 右侧栏「+」选择器完全由它构建', async () => {
  // 这条是血泪教训：右侧栏那个选择器**只**由 definition.guide 构建
  //   // @deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js
  //   refresh() {
  //     this.guideEntries = this.cached.flatMap((d) => (d.guide ?? []).map((e) => ({
  //       ...e, kind: d.kind,
  //     })))
  //   }
  // 所以没有 guide 的类型注册得再正确也不会出现在菜单里，而且**不报任何错**
  // —— 表现就是"没看到入口"。这个测试把那条契约钉死在这里。
  const mod = await loadClientModule()
  const { ctx, tabTypes } = makeFakeClientContext()
  globalThis.document = makeFakeDocument()
  try {
    mod.apply(ctx)
  } finally {
    delete globalThis.document
  }

  const definition = tabTypes[0]
  assert.ok(Array.isArray(definition.guide), 'tab 类型必须带 guide 数组，否则用户看不到入口')
  assert.ok(definition.guide.length > 0, 'guide 不能是空数组')

  for (const entry of definition.guide) {
    assert.ok(Number.isFinite(entry.order), 'guide 条目必须有可排序的 order')
    assert.equal(typeof entry.title, 'function', 'guide 条目的 title 必须是函数')
    assert.ok(String(entry.title()).length > 0, 'guide 条目的 title() 不能为空')
    if (entry.description !== undefined) {
      assert.equal(typeof entry.description, 'function', 'description 必须是函数')
      assert.ok(String(entry.description()).length > 0)
    }
    // 宿主会 `jsx(Icon, { size, className })`，所以 icon 必须是个组件。
    if (entry.icon !== undefined) assert.equal(typeof entry.icon, 'function', 'icon 必须是组件')
  }

  // 按真宿主的推导规则算一遍，必须至少产出一条指向我们这个 kind 的入口。
  const derived = tabTypes.flatMap((d) => (d.guide ?? []).map((entry) => ({ ...entry, kind: d.kind })))
  const mine = derived.filter((entry) => entry.kind === mod.__internals.TAB_KIND)
  assert.equal(mine.length, 1, '按宿主规则推导后必须正好有一条属于本插件的入口')
  assert.equal(mine[0].title(), '陪读模式')
})

test('浏览器半边：guide 的 icon 必须容忍宿主传入的 size / className', async () => {
  const mod = await loadClientModule()
  const { ctx, tabTypes } = makeFakeClientContext()
  globalThis.document = makeFakeDocument()
  try {
    mod.apply(ctx)
  } finally {
    delete globalThis.document
  }

  const icon = tabTypes[0].guide[0].icon
  // 宿主会传这两个 props；组件必须能吃下，不能当成普通 <img> 用。
  const rendered = icon({ size: 26, className: 'x' })
  assert.equal(rendered.type, 'svg')
  assert.equal(rendered.props.width, 26)
  assert.equal(rendered.props.height, 26)
  assert.equal(rendered.props.className, 'x')
  // 不传 props 时也要能渲染（宿主某些路径不带参数）。
  assert.equal(icon().props.width, 22)
})

test('浏览器半边：重复 apply 不累积样式（幂等）', async () => {
  const mod = await loadClientModule()
  const doc = makeFakeDocument()
  globalThis.document = doc
  try {
    mod.apply(makeFakeClientContext().ctx)
    mod.apply(makeFakeClientContext().ctx)
    assert.equal(doc.liveStyles.length, 1, '同时挂载的样式只允许一个')
    assert.equal(doc.created.length, 1, '第二次 apply 应复用已有样式')
  } finally {
    delete globalThis.document
  }
})

test('浏览器半边：停用后重挂必须重新挂上（stop→start 回归）', async () => {
  const mod = await loadClientModule()
  const doc = makeFakeDocument()
  globalThis.document = doc
  try {
    const first = makeFakeClientContext()
    mod.apply(first.ctx)
    assert.equal(doc.liveStyles.length, 1)

    for (const entry of first.effects) entry.dispose()
    assert.equal(doc.liveStyles.length, 0, '卸载必须摘掉样式')

    const second = makeFakeClientContext()
    mod.apply(second.ctx)

    // 这正是 dsh-reader 栽倒的地方：它的幂等旗标只置真不重置，
    // 于是插件更新/重启后再也挂不上，必须先重启整个 dsh web。
    assert.equal(doc.liveStyles.length, 1, '重挂必须重新注入样式')
    assert.equal(second.tabTypes.length, 1, '重挂必须重新登记页签类型')
    assert.equal(second.slotRegistrations.length, 2, '重挂必须重新登记 body 与 title')
  } finally {
    delete globalThis.document
  }
})

//#endregion

//#region 纯函数

/** 取内部句柄。 */
async function internals() {
  const mod = await loadClientModule()
  return mod.__internals
}

test('段落切分：偏移相对章正文起点，与 charOffset 口径一致', async () => {
  const { buildParagraphs } = await internals()
  const text = 'aaa\n\nbbb\nccc'
  const paragraphs = buildParagraphs(text)

  assert.deepEqual(paragraphs.map((p) => p.text), ['aaa', 'bbb', 'ccc'])
  // 'aaa\n\nbbb\nccc'：b 在第 5 个字符，c 在第 9 个字符。
  assert.deepEqual(paragraphs.map((p) => p.offset), [0, 5, 9])
  // 偏移必须真的能切回原文，否则锚点是错的。
  assert.equal(text.slice(paragraphs[1].offset, paragraphs[1].offset + 3), 'bbb')
})

test('段落切分：空输入与纯空白不产出段落', async () => {
  const { buildParagraphs } = await internals()
  assert.deepEqual(buildParagraphs(''), [])
  assert.deepEqual(buildParagraphs('   \n\n  \n'), [])
  assert.deepEqual(buildParagraphs(null), [])
})

test('段落定位：二分查找在边界上都对', async () => {
  const { buildParagraphs, findParagraphIndex } = await internals()
  const paragraphs = buildParagraphs('aaa\nbbb\nccc')
  // offsets: 0, 4, 8

  assert.equal(findParagraphIndex(paragraphs, 0), 0, '正好在首段起点')
  assert.equal(findParagraphIndex(paragraphs, 3), 0, '首段之内')
  assert.equal(findParagraphIndex(paragraphs, 4), 1, '正好在次段起点')
  assert.equal(findParagraphIndex(paragraphs, 7), 1, '次段之内')
  assert.equal(findParagraphIndex(paragraphs, 8), 2, '正好在末段起点')
  assert.equal(findParagraphIndex(paragraphs, 9999), 2, '超出末尾应落在最后一段')
  assert.equal(findParagraphIndex([], 5), 0, '空列表不得抛错')
})

test('目录分组：按卷归并，无卷时退化为单组', async () => {
  const { groupByVolume } = await internals()

  const grouped = groupByVolume([
    { index: 0, volume: '第一卷', title: '一' },
    { index: 1, volume: '第一卷', title: '二' },
    { index: 2, volume: '第二卷', title: '三' },
  ])
  assert.equal(grouped.length, 2)
  assert.deepEqual(grouped.map((g) => g.volume), ['第一卷', '第二卷'])
  assert.deepEqual(grouped[0].chapters.map((c) => c.title), ['一', '二'])

  const flat = groupByVolume([{ index: 0, volume: null, title: '一' }, { index: 1, title: '二' }])
  assert.equal(flat.length, 1)
  assert.equal(flat[0].volume, null)
  assert.equal(flat[0].chapters.length, 2)

  assert.deepEqual(groupByVolume(undefined), [])
})

test('目录折叠：无卷常开、筛选全开、当前卷默认展开但可显式收起，其余只开手动点的那一卷', async () => {
  const { isVolumeOpen } = await internals()
  assert.equal(typeof isVolumeOpen, 'function', 'isVolumeOpen 应当是个纯函数')

  // 无卷的书只有一个组、**没有可点的标题** → 必须始终展开。
  // 否则"还没开始读"时 current = -1、isCurrent 为假，整份目录会一片空白。
  assert.equal(isVolumeOpen({ key: '', isCurrent: false, openVolume: null, filtering: false }), true)
  // 筛选时一律全开：否则命中的章藏在折叠卷里，表现就是"搜不到那一章"。
  assert.equal(isVolumeOpen({ key: '第二卷', isCurrent: false, openVolume: null, filtering: true }), true)
  // 当前卷常开：打开目录第一眼就该看到自己读到哪。
  assert.equal(isVolumeOpen({ key: '第三卷', isCurrent: true, openVolume: null, filtering: false }), true)
  // 其余卷默认收起（这就是折叠省下来的渲染量）。
  assert.equal(isVolumeOpen({ key: '第四卷', isCurrent: false, openVolume: null, filtering: false }), false)
  // 一次只留一卷手动开的：点开另一卷时前一卷收起。
  assert.equal(isVolumeOpen({ key: '第四卷', isCurrent: false, openVolume: '第四卷', filtering: false }), true)
  assert.equal(isVolumeOpen({ key: '第五卷', isCurrent: false, openVolume: '第四卷', filtering: false }), false)

  // ⚠️ v1.46：**显式收起优先于"当前卷常开"** —— 读者的真机反馈是"已读到的那卷
  // 默认展开并且无法点击收起"。点过收起的卷（哪怕它就是当前卷）照他的意思来。
  assert.equal(
    isVolumeOpen({ key: '第三卷', isCurrent: true, closedKeys: ['第三卷'], filtering: false }),
    false,
    '当前卷也能被显式收起',
  )
  // 但**筛选优先于**显式收起：否则搜到的东西藏在折叠卷里 = "搜不到那一章"。
  assert.equal(
    isVolumeOpen({ key: '第三卷', isCurrent: true, closedKeys: ['第三卷'], filtering: true }),
    true,
  )
  // 没被收起的当前卷照旧展开（默认行为一字不变）。
  assert.equal(isVolumeOpen({ key: '第三卷', isCurrent: true, closedKeys: [], filtering: false }), true)
})

test('正文页角标摘要：优先感想、没写退到摘抄、截断 30 字且不切半个字', async () => {
  const { noteSummary, NOTE_SUMMARY_CHARS } = await internals()
  assert.equal(NOTE_SUMMARY_CHARS, 30, '摘要是读者定的 30 字，动它要有理由')

  // 有感想就用感想 —— 绝不能把感想和摘抄接在一起（那是"摘要串行"）。
  assert.equal(noteSummary({ excerpt: '原文一大段', thought: '我的一点想法' }), '我的一点想法')
  // 没写感想就退到摘抄。
  assert.equal(noteSummary({ excerpt: '原文一大段', thought: '' }), '原文一大段')
  // 都没有也不能是空字符串：空行在界面上与"没记过"长得一样。
  assert.equal(noteSummary({ excerpt: '', thought: '' }), '（这条没有正文）')
  // 换行与多余空白压成一行 —— 摘要是一行索引，不是正文。
  assert.equal(noteSummary({ thought: '第一行\n\n  第二行' }), '第一行 第二行')
  // 截断按**码点**：`slice` 会把 emoji 切成半个字（界面上就是个乱码方块）。
  assert.equal(Array.from(noteSummary({ thought: '甲'.repeat(40) })).length, 31, '30 个字 + 一个省略号')
  assert.equal(noteSummary({ thought: '🙂'.repeat(40) }).endsWith('🙂…'), true)
})

test('笔记页折叠：短文原样、长文截断并标记 clamped', async () => {
  const { clampNoteText, NOTE_CLAMP_CHARS } = await internals()
  assert.equal(NOTE_CLAMP_CHARS, 160)

  const short = clampNoteText('短短一句')
  assert.equal(short.clamped, false)
  assert.equal(short.text, '短短一句')

  const long = clampNoteText('字'.repeat(200))
  assert.equal(long.clamped, true)
  assert.equal(Array.from(long.text).length, 161, '160 字 + 省略号')

  // 边界：恰好等于阈值**不**折叠 —— 否则"刚好一屏"的笔记会白长一个按钮。
  assert.equal(clampNoteText('字'.repeat(160)).clamped, false)
  // 非字符串不抛错（外部编辑器改坏了笔记，不该让整个列表白屏）。
  assert.equal(clampNoteText(undefined).clamped, false)
})

test('接线守卫：正文页角标只给摘要（不再把笔记全文铺进正文流）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 角标那段（用渲染里独有的文案定位，**不能**用「本章你记过」—— 那串在
  // state 的注释里也出现过，切片会落在注释上）。
  const marker = source.indexOf('收起本章的')
  assert.ok(marker > 0, '找不到正文页角标')
  const block = source.slice(marker - 900, marker + 1500)
  assert.ok(block.includes('noteSummary(note)'), '角标要用一行摘要')
  assert.ok(!block.includes('note.thought'), '角标里不该再渲染感想全文（读者裁定：正文页不承载长文）')
  assert.ok(!block.includes('note.excerpt'), '角标里不该再渲染摘抄全文')

  // 跳转必须走一次性请求：同章内跳转会被位置账本（positionKey）吞掉。
  assert.ok(source.includes('jumpToNote'), '角标点击要经过 jumpToNote')
  assert.ok(source.includes('setJumpRequest('), '跳转要落成一次性请求')
  assert.ok(
    source.includes('setJumpRequest(null)'),
    '换章必须清掉跳转请求，否则旧偏移会去滚新章',
  )
})

test('接线守卫：已读完解锁在两处都常驻可见（漏传 prop 是不报错的洞）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // ⚠️ 这条守卫的存在理由与 `onOpenNotes` 那次真机反馈同源：渲染层不认识"哪个 prop
  // 忘了传"，漏了只是**安静地不显示** —— 而"静默解锁"恰恰是这件事最不能接受的形态。
  assert.ok(
    source.includes('finished: book?.finished === true'),
    'ReaderPanel 必须把 finished 传给正文页（从 book 上取 —— background 在它的作用域里不存在）',
  )
  assert.ok(source.includes('已解锁全书'), '正文页要有常驻标记')
  assert.ok(
    source.includes('已解锁：这本书的全文对陪读 AI 可见'),
    '面板要有常驻横幅（不能只体现在按钮文案上）',
  )
  assert.ok(source.includes('window.confirm('), '解锁要二次确认')
  assert.ok(source.includes('saveFinished(background?.finished !== true)'), '一个按钮兼解锁与收回')
  assert.ok(source.includes('/finished`'), '要落到宿主的标记路由上')
})

test('进度百分比：起止与中段都符合预期', async () => {
  const { percentOf } = await internals()
  const chapters = [
    { index: 0, length: 1000 },
    { index: 1, length: 1000 },
    { index: 2, length: 1000 },
    { index: 3, length: 1000 },
  ]

  assert.equal(percentOf(null, chapters), 0, '没有进度就是 0')
  assert.equal(percentOf({ chapterIndex: 0, charOffset: 0 }, chapters), 0)
  assert.equal(percentOf({ chapterIndex: 0, charOffset: 500 }, chapters), 13, '半章 = 12.5% → 13')
  assert.equal(percentOf({ chapterIndex: 2, charOffset: 0 }, chapters), 50)
  assert.equal(percentOf({ chapterIndex: 3, charOffset: 1000 }, chapters), 100, '读完最后一章')
  assert.equal(
    percentOf({ chapterIndex: 99, charOffset: 0 }, chapters),
    75,
    '越界章号夹到最后一章的**章首**，而不是直接算作读完',
  )
  assert.equal(percentOf({ chapterIndex: 0, charOffset: 99999 }, chapters), 25, '越界偏移被夹住')
  assert.equal(percentOf({ chapterIndex: 0, charOffset: 0 }, []), 0, '空目录不得抛错')
})

test('进度百分比：章长为零时不除零', async () => {
  const { percentOf } = await internals()
  const chapters = [{ index: 0, length: 0 }, { index: 1, length: 0 }]
  const value = percentOf({ chapterIndex: 0, charOffset: 0 }, chapters)
  assert.ok(Number.isFinite(value), '必须回落到按章号估算，而不是 NaN')
  assert.ok(value >= 0 && value <= 100)
})

test('进度文案：包含章名、章号与百分比', async () => {
  const { progressLabel } = await internals()
  const chapters = [{ index: 0, title: '第一章 雪', length: 100 }, { index: 1, title: '第二章 夜', length: 100 }]

  assert.equal(progressLabel(null, chapters), '尚未开始')
  const label = progressLabel({ chapterIndex: 1, charOffset: 50 }, chapters)
  assert.match(label, /第二章 夜/)
  assert.match(label, /2\/2 章/)
  assert.match(label, /75%/)

  // 超长标题要截断，否则窄面板里会把整行撑破。
  const long = progressLabel({ chapterIndex: 0, charOffset: 0 }, [{ index: 0, title: '第'.repeat(40), length: 10 }])
  assert.ok(long.includes('…'))
})

test('字节格式化', async () => {
  const { formatBytes } = await internals()
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(Number.NaN), '—')
})

test('会话 id 归一化：与宿主侧同口径（容忍 session- 前缀）', async () => {
  const { normalizeId } = await internals()
  assert.equal(normalizeId('session-abc'), 'abc')
  assert.equal(normalizeId('abc'), 'abc')
  assert.equal(normalizeId('  abc  '), 'abc')
  assert.equal(normalizeId(''), '')
  assert.equal(normalizeId(null), '')
  assert.equal(normalizeId(42), '')
})

test('client 与 host 的 API 前缀必须一致', async () => {
  const { API_ROOT } = await internals()
  const host = await import(freshUrl('lib/index.js'))
  assert.equal(API_ROOT, host.API_ROOT, '两边前缀漂移会让面板彻底连不上宿主')
})

test('callApi：非 2xx 时把结构化信息挂在 Error 上（跳读闸要靠它渲染选择）', async () => {
  // 只把文案抛出去是不够的：跳读闸的 409 里带着缺口区间与阈值，界面要拿它们
  // 才能渲染出「全部纳入 / 只记最近 N 章」两个选项。这条钉的是那个契约。
  const { callApi } = await internals()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: false,
      error: 'LARGE_GAP',
      message: '缺口太大',
      gap: { from: 1, to: 149, chapters: 149 },
      gate: 50,
    }), { status: 409, headers: { 'content-type': 'application/json' } })

    const error = await callApi('/books/x/background/fill', { method: 'POST', body: {} })
      .then(() => null, (thrown) => thrown)

    assert.ok(error instanceof Error, '非 2xx 必须抛错')
    assert.equal(error.status, 409)
    assert.equal(error.message, '缺口太大', '文案仍然取 message —— 界面上的显示不变')
    assert.equal(error.body.error, 'LARGE_GAP')
    assert.deepEqual(error.body.gap, { from: 1, to: 149, chapters: 149 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('跳读闸：只有缺口区间齐全时才渲染成选择，否则退回普通错误', async () => {
  const { gatePromptOf } = await internals()

  // 正常形态：认得出来，并把阈值一起交出去（弹窗里要用它说"超过跳读闸（50 章）"）。
  // ⚠️ 窗口与两个预估也一并交出去 —— 客户端**不自己算预算**，同一套算术只该有一处实现。
  assert.deepEqual(
    gatePromptOf({ body: { error: 'LARGE_GAP', gap: { from: 1, to: 149, chapters: 149 }, gate: 50 } }),
    { gap: { from: 1, to: 149, chapters: 149 }, gate: 50, recentWindow: null, estimate: null },
  )

  // 阈值缺失（老宿主、或配置被改坏）→ 仍然认得出来，只是按钮写「最近一段」。
  assert.deepEqual(
    gatePromptOf({ body: { error: 'LARGE_GAP', gap: { from: 1, to: 9, chapters: 9 } } }),
    { gap: { from: 1, to: 9, chapters: 9 }, gate: null, recentWindow: null, estimate: null },
  )

  // 新宿主会把窗口默认值与两个预估一起带回来，客户端原样交给弹窗（不重算）。
  const withExtras = gatePromptOf({
    body: {
      error: 'LARGE_GAP',
      gap: { from: 1, to: 149, chapters: 149 },
      gate: 50,
      recentWindow: 200,
      estimate: { all: { batches: 2, perChapter: 150 }, recent: { window: 149, batches: 2, perChapter: 300 } },
    },
  })
  assert.equal(withExtras.recentWindow, 200)
  assert.deepEqual(withExtras.estimate, {
    all: { batches: 2, perChapter: 150 },
    recent: { window: 149, batches: 2, perChapter: 300 },
  })

  // ★ 没有缺口区间就不认：那时两个按钮点下去都没有意义，宁可给一行错误。
  assert.equal(gatePromptOf({ body: { error: 'LARGE_GAP' } }), null)
  assert.equal(gatePromptOf({ body: { error: 'LARGE_GAP', gap: null } }), null)

  // 别的失败一律不认 —— 别把普通错误渲染成选择。
  assert.equal(gatePromptOf({ body: { error: 'NO_SESSION' } }), null)
  assert.equal(gatePromptOf(new Error('网络炸了')), null)
  assert.equal(gatePromptOf(null), null)
  assert.equal(gatePromptOf(undefined), null)
})

test('补齐结果转文案：三态各自成句，且**没有成功就不能说"已更新"**', async () => {
  const { memoryFillClause } = await internals()

  // 成功，且服务端给了区间 —— 说到哪一章是读者唯一能核对的信息。
  assert.equal(
    memoryFillClause({ kind: 'ok', data: { covered: { first: 1, last: 149 }, elapsedMs: 1000 } }),
    '前文记忆已更新到第 1–149 章。',
  )

  // `skipped` 是服务端的正式回答（没有缺口），不是失败 —— 不能说成"更新了"。
  assert.equal(
    memoryFillClause({ kind: 'ok', data: { skipped: true, covered: { first: 1, last: 9 } } }),
    '前文记忆本来就是最新的，没有缺口。',
  )

  // 成功但没带区间（老宿主）：仍然说成功，但别编造章号。
  assert.equal(memoryFillClause({ kind: 'ok', data: {} }), '前文记忆已更新。')

  // ★ 闸门拦下：必须点明"没有补"，并把该说的两个选项说全。
  const gated = memoryFillClause({
    kind: 'error',
    error: new Error('409'),
    gate: { gap: { from: 1, to: 149, chapters: 149 }, gate: 50 },
  })
  assert.ok(gated.includes('第 1–149 章'), gated)
  assert.ok(gated.includes('共 149 章'), gated)
  assert.ok(gated.includes('50 章'), gated)
  assert.ok(gated.includes('**没有**自动补'), gated)
  assert.ok(gated.includes('记忆没更新'), gated)
  assert.ok(gated.includes('全部纳入') && gated.includes('只记最近这一段'), gated)

  // ★ 阈值缺失（老宿主）也要成句，不能出现「跳读闸 null 章」这种东西。
  const gatedNoLimit = memoryFillClause({
    kind: 'error', error: new Error('409'), gate: { gap: { from: 1, to: 9, chapters: 9 }, gate: null },
  })
  assert.ok(gatedNoLimit.includes('超过跳读闸，'), gatedNoLimit)
  assert.ok(!gatedNoLimit.includes('null'), gatedNoLimit)

  // 普通失败：说清是失败并带上原因，不能借"警告"的口吻把它说成成功。
  const failed = memoryFillClause({ kind: 'error', error: new Error('网络炸了'), gate: null })
  assert.ok(failed.startsWith('前文记忆这次没补上：'), failed)
  assert.ok(failed.includes('网络炸了'), failed)

  assert.equal(memoryFillClause(null), '前文记忆这次没有检查。')
  assert.equal(memoryFillClause(undefined), '前文记忆这次没有检查。')

  // ★★ 这一次修改的**实质**就这一条：凡是没成功的输入，输出里都不准出现"已更新"。
  // 用一个循环把"闸门 / 普通失败 / 未检查"全过一遍，防止将来有人加了一个
  // 新的失败分支、顺手把成功文案抄过去。
  for (const bad of [
    { kind: 'error', error: new Error('x'), gate: { gap: { from: 1, to: 9, chapters: 9 }, gate: 50 } },
    { kind: 'error', error: new Error('x'), gate: null },
    null,
    undefined,
  ]) {
    assert.ok(!memoryFillClause(bad).includes('已更新'), `不该说已更新：${memoryFillClause(bad)}`)
  }
})

test('★ 补齐结果的接线：发笔记那条路径不再无条件自称「记忆已更新」', () => {
  // 为什么非要有静态断言：`memoryFillClause` 是纯函数，上面那条测试证明它**会**分三态。
  // 但把调用处换回硬编码句子，纯函数测试**仍然全绿**——§203 记过这个教训
  // （函数对而没接线照样是 bug）。这里钉的是**接线**本身。
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

  // 补齐结果必须被留住。原来是一个 `.catch(() => null)` 把结果整个丢掉，
  // 那正是"无条件声称已更新"的根源。
  assert.ok(source.includes('const fillRequest = callApi('), '补齐结果没有被留住')
  assert.ok(
    !/\.catch\(\(\) => null\),\s*\n\s*boundRequest,/.test(source),
    '旧的「丢弃补齐结果」写法还在',
  )
  assert.ok(source.includes('const memoryClause = memoryFillClause(fill)'), 'memoryFillClause 没有被调用')

  // 两个分支都必须走它。
  assert.ok(source.includes('${memoryClause}已切到这本书绑定的会话'), 'handoff 分支没有走 memoryClause')
  assert.ok(source.includes('${memoryClause}摘抄与感想'), 'here-only / 同会话分支没有走 memoryClause')

  // ★ 旧的无条件断言必须彻底消失 —— 它正是这次要修的 bug。
  assert.ok(!source.includes("'前文记忆已更新。已切到"), '无条件的"记忆已更新"又回来了')
  assert.ok(!source.includes("'前文记忆已更新，摘抄与感想"), '无条件断言又回来了')
})

//#endregion

//#region 跳读闸的界面接线（静态断言）

test('跳读闸的界面接线：两个选项真的带上 mode，且主按钮不把点击事件当 mode', () => {
  // ⚠️ 为什么只能静态断言：组件冒烟渲染用的是"只取初始值、不执行 effect"的 hook
  // 替身，所以 `gate` 恒为 `null` —— 那一段 JSX **在测试里根本不会被构造**。
  // 而它恰好是读者**唯一**能回答闸门的地方，接错线就等于这个功能不存在：
  //   - 两个选项必须把 `'all'` / `'recent'` 传下去，否则"选了等于没选"；
  //   - 主按钮必须写成箭头函数，且补齐中要变成「停止」（见 `cancelFill`）。
  //     写成 `onClick: fillBackground` 会把**点击事件对象**当成 `mode` 传进去
  //     （这是很容易顺手写错的一处）。
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

  assert.match(source, /fillBackground\('all'\)/, '「这些我都读过」必须传 mode=all')
  // ⚠️ 断言里连**窗口**一起钉住：只传 mode 而忘了窗口，读者在弹窗里选的那个 50/200/300
  // 就白选了（服务端会回落配置默认），而界面上完全看不出来。
  assert.match(source, /fillBackground\('recent', gateWindow\)/, '「只记最近 N 章」必须传 mode=recent 与所选窗口')
  assert.match(
    source,
    /onClick: \(\) => \{ if \(filling\) cancelFill\(\); else fillBackground\(\) \}/,
    '主按钮必须包一层箭头函数，并在补齐中让位给「停止」',
  )
  assert.doesNotMatch(
    source,
    /onClick: fillBackground[,}\n]/,
    '直接挂 fillBackground 会把点击事件当成 mode 传给服务端',
  )
})

test('跳读闸：边界跟着"读者正在看的那一章"走，而它只在两个主动动作里落盘', () => {
  // 与上面那条同因：这类接线在组件冒烟渲染里跑不到（effect 与状态更新都不执行），
  // 只能静态钉住。而它一旦漏了，表现就是读者实测的那一幕 —— 在第 430 章发笔记、
  // 界面一声不响（进度还停在第 3 章，缺口被算成 null）。
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

  // ① 发笔记：把这条笔记**所属的章**带给服务端。
  assert.match(source, /Number\.isInteger\(active\?\.chapterIndex\)/, '发笔记必须认笔记所属的章')
  assert.match(source, /body: atChapter === undefined \? \{ sessionId \} : \{ sessionId, atChapter \}/, '发笔记必须把它带进请求体')
  // ② 面板补齐：从 props 捕获"正在看的章"，并**真的带进请求体**。
  // ⚠️ 这里必须断言"被用上"，不能只断言那个声明在 —— 第一版就是只断言了声明，于是
  // `...at` 漏写都没被发现（面板手动补完全不推边界，而用例照样是绿的）。
  assert.match(
    source,
    /const at = Number\.isInteger\(currentChapter\) \? \{ atChapter: currentChapter \} : \{\}/,
    '补齐要从 props 捕获"正在看的章"',
  )
  assert.match(source, /sessionId, ask: true, \.\.\.carried/, '手动补要同时带 ask 与（首次的）atChapter')
  assert.match(source, /recentWindow: askedWindow \}\), \.\.\.carried/, '带 mode 的那两次也要带 atChapter')
  // ⚠️ **请求体必须每次现算**：补齐循环会连着发十几批，而 `atChapter` 的作用是"把边界推到
  // 我正在看的这一章"。一次算好反复用的话，读者在补齐期间翻章，他的阅读位置会被一批批
  // **数回去**（与他自己滚动的回写打架）。下面三条一起钉住"只有第一次带它"。
  assert.match(source, /let firstCall = true/, '请求体要每次现算')
  assert.match(source, /const carried = firstCall \? at : \{\}/, '只有第一次调用带 atChapter')
  assert.match(source, /body: bodyFor\(\)/, 'fill 每次调用都要现算请求体')
  // ③ 面板必须真的拿到那个章号（否则 ② 永远捕到 null）。
  assert.match(
    source,
    /currentChapter: progress\?\.chapterIndex \?\? null/,
    'CompanionView 必须拿到读者正在看的那一章',
  )
  // ④ 只读的那条路也不该按滞后进度算缺口，否则按钮明明该亮却是灰的。
  assert.match(
    source,
    /background\?atChapter=\$\{at\}/,
    '读背景认识时要带上 atChapter',
  )
})

test('补齐文案：自动打底（大缺口只补了开头）必须说清"还要去面板手动补"', async () => {
  // 这一句是读者能不能看懂"发生了什么"的唯一地方：他点了发送，收到的是一句话。
  // 说少了（"已更新"）他会以为前文都补上了；说多了（每次补完都喊"去手动补"）会变成噪音。
  const { memoryFillClause } = await internals()

  const filled = memoryFillClause({ kind: 'ok', data: { covered: { first: 1, last: 30 }, autoFoundation: true } })
  assert.match(filled, /已更新到第 1–30 章/)
  assert.match(filled, /只自动补了开头/)
  assert.match(filled, /面板/, '必须指路，否则读者不知道剩下的缺口去哪儿补')

  const plain = memoryFillClause({ kind: 'ok', data: { covered: { first: 1, last: 30 } } })
  assert.ok(!plain.includes('只自动补了开头'), '普通补齐不该出现这句')

  // 自动打底碰上"开头早就纳入过"→ 空缺口也要指路（而不是说"没有缺口"）。
  const skipped = memoryFillClause({ kind: 'ok', data: { skipped: true, autoFoundation: true } })
  assert.match(skipped, /面板/)
  // 真正的"没有缺口"照旧。
  const none = memoryFillClause({ kind: 'ok', data: { skipped: true } })
  assert.ok(!none.includes('面板'), '没有缺口时不该往面板指')
})

//#endregion

//#region 组件冒烟渲染

/**
 * 迷你渲染器：把 `createElement` 产生的树逐层展开，**真的执行**每个函数组件。
 *
 * 为什么值得写：组件体里的拼写错误、对 undefined 属性的访问、传错形状的
 * 值给 hook，都不会被 `node --check`（只查语法）或纯函数单测发现——
 * 它们只会在用户点开面板的那一刻白屏。
 *
 * hook 替身返回初始值且不执行 effect，所以状态相关分支只会走初始那一支；
 * 但这已经覆盖了「组件体本身能不能跑通」。
 *
 * @param {unknown} node 渲染树节点
 * @param {number} [depth] 当前深度（防自引用无限递归）
 * @param {Set<Function>|null} [seen] 收集执行过的函数组件
 * @returns {number} 执行过的函数组件数量
 */
function renderTree(node, depth = 0, seen = null) {
  if (depth > 24 || node === null || node === undefined) return 0
  if (Array.isArray(node)) {
    let count = 0
    for (const child of node) count += renderTree(child, depth + 1, seen)
    return count
  }
  if (typeof node !== 'object') return 0

  let count = 0
  if (typeof node.type === 'function') {
    count += 1
    if (seen !== null) seen.add(node.type)
    // 真实 React 会把 children 放进 props，这里补齐，让组件的 props.children 可用。
    count += renderTree(node.type({ ...(node.props ?? {}), children: node.children }), depth + 1, seen)
    return count
  }
  for (const child of node.children ?? []) count += renderTree(child, depth + 1, seen)
  return count
}

/**
 * 把组件包成一个"根节点"再交给渲染器。
 *
 * 不能直接 `Component(props)`：那样根组件是在渲染器**外面**被调用的，
 * 计数与"见过哪些组件"都会漏掉它自己（第一版冒烟测试就是这么误报的）。
 */
const rootNode = (Component, props) => ({ type: Component, props: props ?? null, children: [] })

/** 每个组件一套「最小可用」的 props。 */
function componentCases(internalsApi) {
  const bookId = '0123456789abcdef'
  const book = { bookId, title: '夜行', strategy: 'heading-regex', chapterCount: 3 }
  const chapters = [
    { index: 0, title: '第一章 雪', length: 100, volume: null, kind: 'chapter' },
    { index: 1, title: '第二章 夜', length: 100, volume: null, kind: 'chapter' },
  ]
  const noop = () => {}
  return [
    ['TopBar', internalsApi.TopBar, { title: '标题', onBack: noop, actions: [] }],
    ['TopBar（无返回）', internalsApi.TopBar, { title: '标题' }],
    ['ShelfView', internalsApi.ShelfView, { onOpen: noop }],
    ['TocView（加载中）', internalsApi.TocView, { book, chapters: [], progress: null, loading: true, error: null, onBack: noop, onPick: noop, onOpenCompanion: noop, onOpenNotes: noop }],
    ['TocView（有目录）', internalsApi.TocView, { book, chapters, progress: { chapterIndex: 1, charOffset: 5 }, loading: false, error: null, onBack: noop, onPick: noop, onOpenCompanion: noop, onOpenNotes: noop }],
    ['TocView（定长分段告警）', internalsApi.TocView, { book: { ...book, strategy: 'fixed-blocks' }, chapters, progress: null, loading: false, error: null, onBack: noop, onPick: noop, onOpenCompanion: noop, onOpenNotes: noop }],
    ['TocView（错误）', internalsApi.TocView, { book, chapters: [], progress: null, loading: false, error: '炸了', onBack: noop, onPick: noop, onOpenCompanion: noop, onOpenNotes: noop }],
    ['ReaderView', internalsApi.ReaderView, { book, chapters, chapterIndex: 0, initialOffset: 0, onBack: noop, onNavigate: noop, onOpenCompanion: noop, onOpenNotes: noop, onCaptureNote: noop }],
    ['CompanionView', internalsApi.CompanionView, { book, sessionId: 'session-abc', onBack: noop }],
    ['CompanionView（无 session）', internalsApi.CompanionView, { book, onBack: noop }],
    ['NotesView（无草稿）', internalsApi.NotesView, { book, sessionId: 'session-abc', activeDraft: null, onBack: noop }],
    ['NotesView（带草稿）', internalsApi.NotesView, { book, sessionId: 'session-abc', activeDraft: { draftId: 'd1', excerpt: '摘抄', thought: '感想', reply: '回应', tags: ['文笔'] }, onBack: noop }],
    ['NotesView（有输入框接口）', internalsApi.NotesView, { book, sessionId: 'session-abc', activeDraft: { draftId: 'd1', excerpt: 'x', thought: 'y', reply: '', tags: [] }, inputActions: { setDraft() {} }, existingDraft: '已有的字', onBack: noop }],
    // 列表抽成 memo 组件之后单独冒烟：它拿到的数组**已经**是"新的在前"
    // （次序由宿主侧的 paginateNotes 定好），所以组件里不做任何排序。
    ['NoteList（空）', internalsApi.NoteList, { notes: [], total: 0, loading: false, page: 0, pageCount: 1, hasPrev: false, hasNext: false, onPrev: noop, onNext: noop }],
    ['NoteList（读取中）', internalsApi.NoteList, { notes: [], total: 0, loading: true, page: 0, pageCount: 1, hasPrev: false, hasNext: false, onPrev: noop, onNext: noop }],
    ['NoteList（有笔记、能往后翻）', internalsApi.NoteList, {
      notes: [
        { id: 'n2', createdAt: 'c2', heading: '第 2 章 · 夜', tags: ['文笔'], excerpt: '摘抄', thought: '感想', reply: '回应', hasReply: true },
        { id: 'n1', createdAt: 'c1', heading: '第 1 章 · 雪', tags: [], excerpt: '摘抄', thought: '', reply: '', hasReply: false },
      ],
      total: 37,
      loading: false,
      page: 0,
      pageCount: 4,
      hasPrev: false,
      hasNext: true,
      onPrev: noop,
      onNext: noop,
    }],
    ['NoteList（翻在中间一页）', internalsApi.NoteList, { notes: [], total: 400, loading: false, page: 1, pageCount: 40, hasPrev: true, hasNext: true, onPrev: noop, onNext: noop }],
    ['ReaderPanel（书架）', internalsApi.ReaderPanel, { sessionId: 'session-abc' }],
    ['ReaderPanel（无 session）', internalsApi.ReaderPanel, {}],
  ]
}

test('组件冒烟：每个视图都能真的执行一遍，不抛错', async () => {
  const internalsApi = await internals()
  for (const [name, Component, props] of componentCases(internalsApi)) {
    assert.equal(typeof Component, 'function', `${name} 应当是可执行的组件`)
    let executed = 0
    assert.doesNotThrow(() => {
      executed = renderTree(rootNode(Component, props))
    }, `${name} 渲染时抛错了`)
    // 根组件 + 它下钻到的子组件，至少得有一个真的跑过。
    assert.ok(executed >= 1, `${name} 没有执行任何组件`)
  }
})

test('组件冒烟：每个组件都真的被覆盖到（防止上面那条用例被悄悄跳过）', async () => {
  const internalsApi = await internals()
  const seen = new Set()
  for (const [, Component, props] of componentCases(internalsApi)) {
    renderTree(rootNode(Component, props), 0, seen)
  }
  // 逐个点名：每个视图都必须**真的在这次冒烟里被执行过**，
  // 而不只是出现在用例表里。嵌套执行（比如 ReaderPanel → ShelfView）也算数。
  for (const key of ['ReaderPanel', 'ShelfView', 'TocView', 'ReaderView', 'CompanionView', 'NotesView', 'NoteList', 'TopBar']) {
    assert.ok(seen.has(internalsApi[key]), `${key} 没有被冒烟用例执行到`)
  }
})

//#endregion

//#region 笔记列表的 memo 契约
//
// 笔记变多之后，"打字卡顿"的根因是：列表和编辑框在**同一个组件**里，而编辑框
// 的每个字符都是那个组件的 state——于是每敲一个字，整张列表都要重新协调一遍，
// 而列表会把每条笔记的摘抄/感想/回应全文都渲染出来。
//
// 修法是"把列表抽成 memo 组件 + 保证传进去的 props 是稳定引用"。这两条都是
// **不会报错、只会变慢**的失效模式，所以必须由测试钉住，而不是靠注释提醒。

test('笔记列表：真的被 memo 包住了（抽成独立组件但不包 memo 等于没抽）', async () => {
  const internalsApi = await internals()
  const NoteList = internalsApi.NoteList
  assert.equal(typeof NoteList, 'function', 'NoteList 应当是可执行的组件')
  assert.equal(
    NoteList.__memo,
    true,
    'NoteList 丢失了 memo —— 父组件每次按键重渲染时它还会跟着重渲染',
  )
})

test('笔记列表：同一份 props 不会重复渲染（memo 真的在起作用）', async () => {
  const internalsApi = await internals()
  const NoteList = internalsApi.NoteList
  const props = {
    notes: [{ id: 'n1', createdAt: 'c1', heading: '第 1 章', tags: [], excerpt: '摘抄', thought: '感想', reply: '', hasReply: false }],
    total: 1,
    loading: false,
    page: 0,
    pageCount: 1,
    hasPrev: false,
    hasNext: false,
    onPrev: () => {},
    onNext: () => {},
  }

  // 预热：先塞一份内容不同的 props，确保 memo 里有历史可比。
  NoteList({ ...props, total: -1 })
  NoteList.renders = 0
  NoteList.bailouts = 0

  NoteList(props)
  NoteList(props)

  assert.equal(NoteList.renders, 1, '相同 props 渲染了两次，memo 没命中')
  assert.equal(NoteList.bailouts, 1, '第二次应当被 memo 跳过')
})

test('笔记列表：props 真的变了就必须重渲染（memo 不能把新数据挡掉）', async () => {
  const internalsApi = await internals()
  const NoteList = internalsApi.NoteList
  const base = { notes: [], total: 0, loading: false, page: 0, pageCount: 1, hasPrev: false, hasNext: false, onPrev: () => {}, onNext: () => {} }

  NoteList({ ...base, total: -1 })
  NoteList.renders = 0
  NoteList.bailouts = 0

  // 翻页之后：notes 换了、total 不变、可翻的方向可能翻转。
  NoteList(base)
  NoteList({ ...base, notes: [{ id: 'x', createdAt: 'c', heading: '', tags: [], excerpt: '', thought: '', reply: '', hasReply: false }] })
  NoteList({ ...base, page: 1, hasPrev: true, hasNext: true })

  assert.equal(NoteList.renders, 3, '任何一项 prop 变化都必须穿透 memo')
  assert.equal(NoteList.bailouts, 0)
})

test('笔记列表：NotesView 渲染时列表**真的经过** NoteList 组件（没有被内联回去）', async () => {
  const internalsApi = await internals()
  const seen = new Set()
  const props = {
    book: { bookId: '0123456789abcdef', title: '夜行', strategy: 'heading-regex', chapterCount: 3 },
    sessionId: 'session-abc',
    activeDraft: null,
    onBack: () => {},
  }
  renderTree(rootNode(internalsApi.NotesView, props), 0, seen)
  assert.ok(
    seen.has(internalsApi.NoteList),
    'NotesView 没有把列表交给 NoteList —— 列表被内联回去了，打字会重新变卡',
  )
})

test('笔记翻页：上一页/下一页真的接上了（静态接线）', () => {
  // 读者要的是**真翻页**：一次只显示一页（10 条），能往回翻；不是"一路点加载、
  // 把列表摊成一长条"。这条链路（点下一页 → 压栈 → 重取一页 → 替换列表）在组件
  // 冒烟渲染里执行不到（react 替身不跑状态机与 effect），所以只能静态钉住。
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

  assert.match(source, /const \[cursors, setCursors\] = useState\(\[null\]\)/, '游标要存成栈')
  assert.match(source, /const next = \[\.\.\.cursors, pageNext\]/, '下一页 = 压栈')
  assert.match(source, /const next = cursors\.slice\(0, -1\)/, '上一页 = 弹栈')
  assert.match(source, /onPrev: goPrevPage/, '两个回调要接进 NoteList')
  assert.match(source, /onNext: goNextPage/, '两个回调要接进 NoteList')
  // 反向守卫：追加式分页已经被换掉了，这两样不该再回来。
  assert.ok(!source.includes('mergeNotesPage'), '追加式分页的合并函数应当已经删除')
  assert.ok(!source.includes('onLoadMore'), '「加载更旧」的回调不该再出现')
  assert.ok(!source.includes('loadingMore'), '追加式的忙标志不该再出现')
})

//#endregion

//#region 正文字体偏好

test('字体偏好：任何垃圾输入都夹到合法区间，且永不抛错', async () => {
  const { clampFontPrefs, DEFAULT_FONT_PREFS } = await internals()

  // 完全不是对象。
  for (const garbage of [null, undefined, 42, 'x', [], true]) {
    assert.deepEqual(clampFontPrefs(garbage), DEFAULT_FONT_PREFS)
  }
  // 缺字段：缺哪个补哪个，有的保留。
  assert.equal(clampFontPrefs({ size: 20 }).size, 20)
  assert.equal(clampFontPrefs({ size: 20 }).lineHeight, DEFAULT_FONT_PREFS.lineHeight)

  // 越界夹住，而不是拒绝——用户连点 A+ 到顶不该报错。
  assert.equal(clampFontPrefs({ size: 999 }).size, 30)
  assert.equal(clampFontPrefs({ size: -5 }).size, 13)
  assert.equal(clampFontPrefs({ lineHeight: 99 }).lineHeight, 2.6)
  assert.equal(clampFontPrefs({ lineHeight: 0 }).lineHeight, 1.2)

  // 非法数值回默认。
  assert.equal(clampFontPrefs({ size: Number.NaN }).size, DEFAULT_FONT_PREFS.size)
  assert.equal(clampFontPrefs({ size: Number.POSITIVE_INFINITY }).size, DEFAULT_FONT_PREFS.size)
  assert.equal(clampFontPrefs({ size: 'abc' }).size, DEFAULT_FONT_PREFS.size)

  // 字号取整、行高留一位小数（免得连点产生 1.9000000000000001）。
  assert.equal(clampFontPrefs({ size: 17.6 }).size, 18)
  assert.equal(clampFontPrefs({ lineHeight: 1.83 }).lineHeight, 1.8)
})

test('字体偏好：未知字体族回落到默认，而不是渲染出空字体栈', async () => {
  const { clampFontPrefs, FONT_FAMILIES, DEFAULT_FONT_PREFS } = await internals()
  assert.equal(clampFontPrefs({ family: '不存在' }).family, DEFAULT_FONT_PREFS.family)
  assert.equal(clampFontPrefs({ family: null }).family, DEFAULT_FONT_PREFS.family)
  for (const entry of FONT_FAMILIES) {
    assert.equal(clampFontPrefs({ family: entry.id }).family, entry.id)
    assert.ok(entry.stack.length > 0, `${entry.id} 的字体栈不能为空`)
  }
})

test('字体偏好：转成内联样式时单位与格式正确', async () => {
  const { fontStyleOf, fontStackOf } = await internals()
  const style = fontStyleOf({ size: 20, lineHeight: 2, family: 'sans' })
  assert.equal(style.fontSize, '20px')
  assert.equal(style.lineHeight, '2')
  assert.equal(style.fontFamily, fontStackOf('sans'))
  // 未知字体族也不能炸。
  assert.equal(typeof fontStyleOf({ family: 'nope' }).fontFamily, 'string')
  assert.ok(fontStyleOf({ family: 'nope' }).fontFamily.length > 0)
})

test('字体偏好：localStorage 往返，坏了也能自愈', async () => {
  const { loadFontPrefs, saveFontPrefs, FONT_PREFS_KEY, DEFAULT_FONT_PREFS } = await internals()
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  }
  try {
    // 空存储 → 默认。
    assert.deepEqual(loadFontPrefs(), DEFAULT_FONT_PREFS)

    // 往返。
    saveFontPrefs({ size: 22, lineHeight: 2.2, family: 'kai' })
    assert.deepEqual(loadFontPrefs(), { size: 22, lineHeight: 2.2, family: 'kai' })
    assert.ok(store.has(FONT_PREFS_KEY))

    // 存里是坏 JSON → 回默认，而不是把阅读界面打崩。
    store.set(FONT_PREFS_KEY, '{ 这不是 JSON')
    assert.deepEqual(loadFontPrefs(), DEFAULT_FONT_PREFS)

    // 存里是合法 JSON 但字段离谱 → 夹住。
    store.set(FONT_PREFS_KEY, JSON.stringify({ size: 999, lineHeight: -1, family: 'zzz' }))
    assert.deepEqual(loadFontPrefs(), { size: 30, lineHeight: 1.2, family: DEFAULT_FONT_PREFS.family })
  } finally {
    delete globalThis.localStorage
  }
})

test('字体偏好：localStorage 不可用（隐私模式/取值抛错）也不影响阅读', async () => {
  const { loadFontPrefs, saveFontPrefs, DEFAULT_FONT_PREFS } = await internals()

  // 根本没有 localStorage。
  assert.deepEqual(loadFontPrefs(), DEFAULT_FONT_PREFS)
  assert.doesNotThrow(() => saveFontPrefs({ size: 20 }))

  // 有，但每次调用都抛（配额满、隐私模式）。
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('quota') },
  }
  try {
    assert.deepEqual(loadFontPrefs(), DEFAULT_FONT_PREFS)
    assert.doesNotThrow(() => saveFontPrefs({ size: 20 }))
  } finally {
    delete globalThis.localStorage
  }
})

//#endregion

//#region 讨论时间线与书友设定（面板侧）

test('讨论来源：三种来源要给三种说法——只写"讨论"会让人分不清走到哪一步', async () => {
  const { describeKind } = await internals()
  assert.equal(describeKind('note'), '写了笔记')
  assert.equal(describeKind('sent'), '发去聊')
  assert.equal(describeKind('reply'), '抓回回应')
  // 未知来源不该渲染成 undefined。
  assert.equal(describeKind('nonsense'), '记录')
  assert.equal(describeKind(undefined), '记录')
})

test('讨论时间：面板用**绝对**时间（要能对上日程），坏输入回空串', async () => {
  const { formatWhen } = await internals()
  const out = formatWhen('2026-03-05T09:30:00.000Z')
  assert.match(out, /^2026-03-0[56] \d{2}:\d{2}$/, `本地时区不该影响格式，实际：${out}`)
  // 格式化必须永不抛错：它在列表渲染里被逐条调用，抛一次就整块白屏。
  assert.equal(formatWhen(''), '')
  assert.equal(formatWhen(null), '')
  assert.equal(formatWhen('不是时间'), '')
  assert.equal(formatWhen(12345), '')
})

test('联网档位：三种档位都要有人话，未知档位按最严的说', async () => {
  const { webGateLabel } = await internals()
  assert.match(webGateLabel('block-all'), /完全/)
  assert.match(webGateLabel('block-book'), /本书/)
  assert.match(webGateLabel('off'), /关闭/)
  // 关键：档位未知时不能说"关闭"——那会把最严的闸描述成没有闸。
  assert.match(webGateLabel('nonsense'), /完全/)
  assert.match(webGateLabel(undefined), /完全/)
})

test('讨论时间线：面板记录走的是 POST /discussions，且带 bookId', async () => {
  const { recordDiscussion } = await internals()
  const calls = []
  // ⚠️ 必须**保存再恢复**，不能 `delete globalThis.fetch`：
  // `node --test --test-isolation=none` 让所有测试文件跑在同一个进程里，
  // 删掉全局 fetch 会把后面所有用它的测试一起弄挂（这个 bug 真的发生过）。
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return { ok: true, status: 200, text: async () => '{"ok":true}' }
  }
  try {
    await recordDiscussion('abc123', { kind: 'sent', chapterIndex: 2, thought: '一句' })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/books\/abc123\/discussions$/)
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].options.body), { kind: 'sent', chapterIndex: 2, thought: '一句' })
})

test('面板：书友设定与讨论历史都在 CompanionView 里真的渲染出来', async () => {
  // 纯静态检查——但拦的是真实的失效模式：区块写了却忘了放进返回的树里，
  // 组件冒烟测试也发现不了（它只保证"能跑通"，不保证"有这一块"）。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  for (const label of ['书友设定（你写给 AI 的）', '讨论历史', '压缩背景认识', '可缓存前缀']) {
    assert.ok(source.includes(label), `面板里缺少「${label}」`)
  }
  // 设定必须能存能读，走的是 /persona 这条路由。
  assert.match(source, /\/books\/\$\{book\.bookId\}\/persona/)
})

//#endregion

//#region 书架：分类分组、绑定状态、章节标题
//
// 这三块都用**纯函数**测，而不是渲染 ShelfView：测试里的 React 替身不做状态
// 更新（`useState` 返回 `[初始值, () => {}]`），所以书架永远停在「正在读取书架…」
// 那一屏，`state.books` 之后的分支根本渲染不出来。分支逻辑留在组件里等于没护栏，
// 于是把它们提成纯函数单独测——这也是它们被提出来的一半原因。

test('分组：「未分类」永远排第一，其余按中文排序', async () => {
  const { groupBooksByCategory } = await internals()
  const groups = groupBooksByCategory([
    { bookId: 'a', title: 'A', category: '武侠' },
    { bookId: 'b', title: 'B', category: null },
    { bookId: 'c', title: 'C', category: '科幻' },
    { bookId: 'd', title: 'D' },
  ])
  assert.deepEqual(groups.map((g) => g.category), ['未分类', '科幻', '武侠'])
  assert.deepEqual(
    groups[0].books.map((b) => b.bookId),
    ['b', 'd'],
    '`null` 与整个字段缺席都是同一个桶（未分类）',
  )
})

test('分组：没有书也保留「未分类」那一组', async () => {
  const { groupBooksByCategory } = await internals()
  assert.deepEqual(groupBooksByCategory([]), [{ category: '未分类', books: [] }])
  assert.deepEqual(groupBooksByCategory(null), [{ category: '未分类', books: [] }])
})

test('分组：只有空白的分类名按未分类处理', async () => {
  const { groupBooksByCategory } = await internals()
  const groups = groupBooksByCategory([{ bookId: 'a', category: '   ' }])
  assert.deepEqual(groups.map((g) => g.category), ['未分类'])
  assert.equal(groups[0].books.length, 1, '空白分类名不该单独变成一个分组')
})

test('绑定状态：未绑定是灰标且不可跳', async () => {
  const { shelfBindingState, UNCATEGORIZED } = await internals()
  assert.equal(UNCATEGORIZED, '未分类')
  for (const sessionId of [null, undefined, '']) {
    const state = shelfBindingState({ sessionId }, () => {})
    assert.equal(state.bound, false, `sessionId=${JSON.stringify(sessionId)} 应当算未绑定`)
    assert.equal(state.canJump, false)
    assert.equal(state.label, '未绑定')
  }
})

test('绑定状态：已绑定且宿主有 sessions 才做成按钮', async () => {
  const { shelfBindingState } = await internals()
  assert.deepEqual(
    shelfBindingState({ sessionId: 's-1' }, () => {}),
    { bound: true, canJump: true, label: '已绑定 · 跳过去', sessionId: 's-1' },
  )
  // 宿主没有 sessions 服务（openSession 为 null）时必须**退回静态标**，
  // 而不是渲染一个点了没反应的按钮。
  assert.deepEqual(
    shelfBindingState({ sessionId: 's-1' }, null),
    { bound: true, canJump: false, label: '已绑定会话', sessionId: 's-1' },
  )
})

test('发到会话：绑定的是别的会话时，必须交接并跳过去', async () => {
  const { planNoteSend } = await internals()
  // 绑的就是本会话 → 照旧放进当前输入框。
  assert.deepEqual(
    planNoteSend({ boundSessionId: 'session-abc', currentSessionId: 'session-abc', canOpenSession: true }),
    { mode: 'here', targetSessionId: null },
  )
  // 绑的是**别的**会话 → 交接，并跳过去。
  assert.deepEqual(
    planNoteSend({ boundSessionId: 'session-abc', currentSessionId: 'session-xyz', canOpenSession: true }),
    { mode: 'handoff', targetSessionId: 'session-abc' },
  )
  // 没绑定 → 当前会话就是陪读会话，照旧。
  for (const boundSessionId of [null, undefined, '', '   ']) {
    assert.deepEqual(
      planNoteSend({ boundSessionId, currentSessionId: 'session-xyz', canOpenSession: true }),
      { mode: 'here', targetSessionId: null },
      `boundSessionId=${JSON.stringify(boundSessionId)} 应当算未绑定`,
    )
  }
})

test('发到会话：前缀不一致不能把"本会话"误判成"别的会话"', async () => {
  const { planNoteSend } = await internals()
  // 绑定记录里存的是带 `session-` 前缀的形式，而槽注入的 `sessionId` 不一定带。
  // 直接比字符串会把读者在**自己**会话里发笔记弹出到"另一个会话"去。
  for (const [bound, current] of [
    ['session-abc', 'abc'],
    ['abc', 'session-abc'],
    ['session-abc', 'session-abc'],
    ['  session-abc  ', 'abc'],
  ]) {
    assert.deepEqual(
      planNoteSend({ boundSessionId: bound, currentSessionId: current, canOpenSession: true }),
      { mode: 'here', targetSessionId: null },
      `bound=${JSON.stringify(bound)} current=${JSON.stringify(current)}`,
    )
  }
})

test('发到会话：宿主不能跳转时如实降级，不假装发过去了', async () => {
  const { planNoteSend } = await internals()
  // 退化方向必须是"留在当前输入框 + 说清楚"，而不是"以为跳过去了其实没跳"。
  assert.deepEqual(
    planNoteSend({ boundSessionId: 'session-abc', currentSessionId: 'session-xyz', canOpenSession: false }),
    { mode: 'here-only', targetSessionId: 'session-abc' },
  )
})

test('交接：不是发往这个会话时留着，等跳过去', async () => {
  const { depositDraftHandoff, takeDraftHandoff, draftHandoffs } = await internals()
  depositDraftHandoff(draftHandoffs, 'session-abc', '摘抄', 1000)
  assert.deepEqual(takeDraftHandoff(draftHandoffs, 'session-xyz', 1000), { action: 'wait' })
  assert.deepEqual(takeDraftHandoff(draftHandoffs, 'session-abc', 1000), { action: 'deliver', text: '摘抄' })
  // 前缀形式同样算同一个会话（注入的 sessionId 不一定带 `session-`）。
  assert.deepEqual(takeDraftHandoff(draftHandoffs, 'abc', 1000), { action: 'deliver', text: '摘抄' })
})

test('交接：按目标会话索引——两本书各绑一个会话时不许互相顶掉', async () => {
  // 一个格子（旧设计是单个对象）的话，后发的会把先发的顶掉：读者在 A 书里
  // 发的摘抄会凭空消失，而界面上两边都说"已发送"。
  const { depositDraftHandoff, takeDraftHandoff, draftHandoffs } = await internals()
  depositDraftHandoff(draftHandoffs, 'session-aaa', '甲', 1000)
  depositDraftHandoff(draftHandoffs, 'session-bbb', '乙', 1000)
  assert.deepEqual(takeDraftHandoff(draftHandoffs, 'session-aaa', 1000), { action: 'deliver', text: '甲' })
  assert.deepEqual(takeDraftHandoff(draftHandoffs, 'session-bbb', 1000), { action: 'deliver', text: '乙' })
})

test('交接：过期必须丢掉，否则会在很久以后突然塞进输入框', async () => {
  const { depositDraftHandoff, takeDraftHandoff, draftHandoffs, DRAFT_HANDOFF_TTL_MS } = await internals()
  assert.ok(Number.isFinite(DRAFT_HANDOFF_TTL_MS) && DRAFT_HANDOFF_TTL_MS > 0)
  depositDraftHandoff(draftHandoffs, 'session-abc', '摘抄', 1000)
  assert.deepEqual(
    takeDraftHandoff(draftHandoffs, 'session-abc', 1000 + DRAFT_HANDOFF_TTL_MS),
    { action: 'deliver', text: '摘抄' },
    '正好到期还不算过期',
  )
  assert.deepEqual(
    takeDraftHandoff(draftHandoffs, 'session-abc', 1000 + DRAFT_HANDOFF_TTL_MS + 1),
    { action: 'drop' },
  )
})

test('交接：空内容与非对象一律不收，不会塞一条空消息', async () => {
  const { depositDraftHandoff, takeDraftHandoff, draftHandoffs } = await internals()
  for (const text of [null, undefined, '', 42, {}, []]) {
    depositDraftHandoff(draftHandoffs, 'session-abc', text, 1000)
  }
  assert.deepEqual(
    takeDraftHandoff(draftHandoffs, 'session-abc', 1000),
    { action: 'wait' },
    '这些都不该被收进接力区',
  )
  // 接力区本身缺失/形状不对时也绝不能抛——它跑在渲染里，抛了就是白屏。
  for (const broken of [null, undefined, 'x', 42, {}]) {
    assert.deepEqual(takeDraftHandoff(broken, 'session-abc', 1000), { action: 'wait' })
  }
})

test('交接：清空是显式的，而且必须在写进输入框**之后**', async () => {
  // 顺序反了的话，`setDraft` 一旦抛错（宿主接口换形状），文字就从接力区消失了、
  // 而输入框里也没有 —— 两头空，读者看到的是"失败"但实际是"弄丢了"。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const setDraftAt = source.indexOf("inputActions.setDraft(existing === '' ? decision.text")
  // ⚠️ 必须从 `setDraftAt` 往后找：前面 `drop` 分支里还有一次清空（那次是对的，
  //    因为它清的是"过期作废"的棒子，跟这里"兑现后清"是两件事）。
  const commitAt = source.indexOf('commitDraftHandoff(draftHandoffs, sessionId)', setDraftAt)
  assert.ok(setDraftAt > 0, '必须把文字写进输入框')
  assert.ok(commitAt > setDraftAt, '兑现后的清空必须出现在写进输入框之后')
})

test('交接：棒子装在模块级 Map 里，不能退回组件状态', async () => {
  // 这是本轮修复的**根因**：右侧栏页签的 scope 是 session，切会话会卸载本面板。
  // 交接棒一旦放在 `useState` 里，跳转这个动作本身就会把它带走 ——
  // 读者看到的正是"跳过去了，但输入框是空的"。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(source, /^ {4}const draftHandoffs = new Map\(\)/m, '接力区必须是模块级 Map')
  assert.match(source, /^ {4}const sessionViews = new Map\(\)/m, '视图记忆必须是模块级 Map')
  assert.match(
    source,
    /takeDraftHandoff\(draftHandoffs, sessionId, Date\.now\(\)\)/,
    '面板必须从模块级接力区取，而不是从自己的状态取',
  )
  assert.doesNotMatch(source, /const \[draftHandoff, setDraftHandoff\] = useState/, '交接棒不许放回组件状态')
  assert.doesNotMatch(source, /setDraftHandoff\(/, 'setDraftHandoff 应当已被彻底移除')
})

test('视图记忆：跳过去之后要能回到原来那本书，而不是又看到书架', async () => {
  const { rememberSessionView, recallSessionView, sessionViews, resolveRestoreView } = await internals()
  sessionViews.clear()
  const book = { bookId: 'abcdef0123456789', title: '夜行' }
  // 目标会话的面板可能从没打开过 —— 所以交接时要给它播下种子。
  rememberSessionView(sessionViews, 'session-abc', { view: 'reader', book })
  // 记的是**整层的样子**：落点 + 书 + 笔记页的草稿 + 「返回」该回哪一层。
  // 缺了后两项，还原出来的笔记页会是个空编辑框、「返回」也只能靠猜。
  assert.deepEqual(recallSessionView(sessionViews, 'abc'), {
    view: 'reader', book, draft: null, origin: null,
  })
  assert.equal(resolveRestoreView('reader'), 'reader')
  // 前缀形式算同一个会话，否则"本会话"会读不到自己刚存的记忆。
  assert.deepEqual(recallSessionView(sessionViews, 'session-abc')?.book, book)
})

test('视图记忆：笔记页跟着草稿一起还原，没草稿才退回目录', async () => {
  const { resolveRestoreView } = await internals()
  const draft = { draftId: 'd1', excerpt: '一段原文' }
  // **有草稿**就还原笔记页：读者在笔记页点「发送到会话」，跳过去之后应该接着写
  // 那条笔记，而不是被弹回正文或目录。草稿由跨会话交接一起交过来。
  assert.equal(resolveRestoreView('notes', draft), 'notes')
  // **没草稿**就不能还原：那会是一个空编辑框，读者会以为自己的摘抄丢了。
  // 切页签、刷新页面、同一个会话自己重挂，走的都是这一条。
  assert.equal(resolveRestoreView('notes'), 'toc')
  assert.equal(resolveRestoreView('notes', null), 'toc')
  assert.equal(resolveRestoreView('toc'), 'toc')
  assert.equal(resolveRestoreView('companion'), 'companion')
  // 认不出来的视图一律退回书架，而不是猜一个。
  assert.equal(resolveRestoreView('不知道'), 'shelf')
  assert.equal(resolveRestoreView(undefined), 'shelf')
})

test('视图记忆：目录没到之前不许消费待还原项', async () => {
  const { resolveRestoreStep } = await internals()
  const book = { bookId: 'abcdef0123456789' }
  const pending = { bookId: 'abcdef0123456789', view: 'reader' }

  // ⚠️ 这是踩过的坑，也是本测试存在的唯一理由：挂载那一趟 `catalog` 是初始值
  // `{ chapters: [], loading: false }` —— 看起来"已经加载完、并且章节为空"。
  // 老代码在这一趟就把待还原项清掉了，等目录真到位时已经没得还原，于是从笔记页
  // 跳过去只会停在**目录页**，而不是读者刚才在读的正文。
  assert.equal(
    resolveRestoreStep(pending, book, { loading: false, chapters: [] }),
    'stay',
    '挂载那一趟的初始 catalog 是个假象，不能在这里把待还原项吃掉',
  )
  // 正在加载也不能消费。
  assert.equal(resolveRestoreStep(pending, book, { loading: true, chapters: [] }), 'stay')
  // 但"必须等目录"**只对正文成立**：只有 `ReaderView` 要 `chapters[chapterIndex]`。
  // 目录页 / 笔记页 / 陪读页都不读目录，让它们一起等，代价是读者看得见的一次多余
  // 跳转（笔记页尤其明显：先闪一眼目录，再跳回笔记页）。
  for (const view of ['toc', 'notes', 'companion']) {
    assert.equal(
      resolveRestoreStep({ bookId: book.bookId, view }, book, { loading: true, chapters: [] }),
      'apply',
      `${view} 不读目录，不该等它`,
    )
  }
  // 目录真到位了才落点。
  assert.equal(
    resolveRestoreStep(pending, book, { loading: false, chapters: [{ index: 0 }] }),
    'apply',
  )
  // 目录拉失败（章节为空）时留在目录页看错误 —— 但待还原项必须**留着**，
  // 不能像老代码那样先清掉再 return。
  assert.equal(
    resolveRestoreStep(pending, book, { loading: false, chapters: [], error: '炸了' }),
    'stay',
  )

  // 读者自己换了书就不再还原：那是他主动选的另一本，不该被塞进阅读页。
  assert.equal(
    resolveRestoreStep(pending, { bookId: 'ffffffffffffffff' }, { loading: false, chapters: [1] }),
    'drop',
  )

  // 没有待还原项 / 还没有书 / 目录缺失，都不能抛。
  assert.equal(resolveRestoreStep(null, book, { chapters: [1] }), 'stay')
  assert.equal(resolveRestoreStep(undefined, book, { chapters: [1] }), 'stay')
  assert.equal(resolveRestoreStep(pending, null, { chapters: [1] }), 'stay')
  assert.equal(resolveRestoreStep(pending, book, null), 'stay')
})

test('视图记忆：每个进笔记页的入口都要记下来源', () => {
  // 发送到会话发生在笔记页上，那一刻 `view` 恒为 `'notes'`，而它被
  // `resolveRestoreView` 刻意映射到目录。来源只能在**进入笔记页那一刻**记下来，
  // 所以每个真正的入口旁边都必须有一次来源赋值。
  //
  // 这里数"入口数 == 记账处数"，而不是"恰好有 N 处"：将来多一个入口却忘了记账，
  // 行为会静默退化成"跳过去看到目录"，而测试照样是绿的 —— 那正是本轮真机反馈
  // 的形状。`^\s*` 是为了不把注释里提到的同名调用算成入口。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const entries = (source.match(/^\s*setView\('notes'\)/gm) ?? []).length
  const origins = (source.match(/noteOriginRef\.current = '(?:reader|toc)'/g) ?? []).length
  assert.ok(entries > 0, '找不到进笔记页的入口 —— 断言的锚点已经失效了')
  assert.equal(
    origins,
    entries,
    `进笔记页的入口有 ${entries} 个，但只有 ${origins} 处记了来源：跳过去会落错页`,
  )

  // 同一个入口还必须换一次**编辑世代**（`NotesView` 的 `key`）。`NotesView` 只把
  // props 读进 `useState` 的初值，所以"换一份编辑内容"只能靠重挂表达；漏掉这一处，
  // 新起稿可能落到已经挂载的那个编辑框上，而它不会重读初值。
  const epochs = (source.match(/setNoteEpoch\(\(epoch\) => epoch \+ 1\)/g) ?? []).length
  assert.equal(
    epochs,
    entries,
    `进笔记页的入口有 ${entries} 个，但只有 ${epochs} 处换了编辑世代（NotesView 的 key 不会变）`,
  )
  assert.match(source, /noteOriginRef\.current = 'reader'/, '从正文选区起稿时来源要记成正文')
  assert.match(source, /noteOriginRef\.current = 'toc'/, '从目录进笔记页时来源要记成目录')

  // 记下来还不够，交接时必须**真的用它** —— 但用的方式不是把它当落点。
  //
  // ⚠️ 这里曾经把「来源」同时当作交接的落点，结果是读者在笔记页点发送、跳过去
  // 却直接被弹回正文：正在写的那条笔记从眼前消失了，还得重新进来一次（真机反馈）。
  // 「发送」保留**此刻这一层**，「返回」才回到**来源**，两者必须分开。
  assert.match(
    source,
    /view: payload\?\.view \?\? 'notes'/,
    '交接保留的必须是此刻这一层（笔记页），而不是进笔记页时的来源',
  )
  assert.doesNotMatch(
    source,
    /view: payload\?\.view \?\? noteOriginRef\.current/,
    '把来源当成交接落点，就会在发送时把读者弹回正文',
  )
  assert.match(
    source,
    /origin: payload\?\.origin \?\? noteOriginRef\.current \?\? 'reader'/,
    '来源要单独交出去：目标会话自己没进过笔记页，它的「返回」只能靠这份种子',
  )
  assert.match(
    source,
    /draft: payload\?\.draft \?\? activeDraft/,
    '草稿要一起交出去，否则目标会话的笔记页是个空编辑框',
  )

  // 返回按钮用的才是来源。写死 `'toc'` 的话，从正文选区起的草稿在记完笔记点返回时
  // 会掉到目录（真机反馈）—— 摘抄是从正文里选的，返回却回不到正文。
  assert.match(
    source,
    /onBack: \(\) => setView\(noteOriginRef\.current \?\? 'toc'\)/,
    '笔记页的返回按钮必须回到进入笔记页时的来源，而不是固定回目录',
  )
  // 交接过来的面板也要装上来源，否则那边的「返回」只能猜。
  assert.match(
    source,
    /const noteOriginRef = useRef\(typeof boot\?\.origin === 'string'/,
    '从记忆里还原过来的面板要把来源装进 noteOriginRef',
  )

  // 接线：三态要**分开处理**。还原 effect 是组件内逻辑，替身渲染不到，所以这里
  // 静态钉住它确实按 `resolveRestoreStep` 的结果分派 —— `stay` 必须原样返回
  // （留着待办），只有 `apply` 才消费。少了这一条，把 `stay` 当 `apply` 处理
  // 就会在目录到位之前落点，而那正是本轮修掉的那个 bug。
  assert.match(
    source,
    /const step = resolveRestoreStep\(restoreRef\.current, book, catalog\)/,
    '还原 effect 必须走 resolveRestoreStep',
  )
  assert.match(source, /if \(step === 'drop'\)/, '读者换了书要清掉待办')
  assert.match(source, /if \(step !== 'apply'\) return/, '非 apply 必须原样返回，不许消费待办')
})

test('视图记忆：还原那一帧的接线（组件内逻辑，渲染不出来）', () => {
  // 跨会话交接之后，目标会话面板的**第一帧**长这样：记忆里有"书 + 笔记页 + 草稿 +
  // 来源"，面板要照着它把四个状态一次摆好。少摆一个，读者看到的就是白屏、空编辑框
  // 或者被弹回正文。
  //
  // ⚠️ 这一段在单测里**跑不出来**：本文件顶部的 reactStub 把 `useState` 写成
  // `(initial) => [initial, () => {}]` —— **不调用**初始值函数。所以上面那几条纯函数
  // 用例保证的是"规则对"，这一条保证的是"接线对"，两者缺一不可。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const wiring = [
    [
      /const \[boot\] = useState\(\(\) => recallSessionView\(sessionViews, sessionId\)/,
      '面板要从模块级记忆起步',
    ],
    [
      /useState\(\(\) => resolveRestoreView\(boot\?\.view, boot\?\.draft\)\)/,
      '初始落点要连着草稿一起算，否则笔记页还原不出来',
    ],
    [/useState\(\(\) => boot\?\.draft \?\? null\)/, '笔记页的草稿要从记忆里装回来'],
    [
      /bookId: book\.bookId, view: resolveRestoreView\(boot\?\.view, boot\?\.draft\)/,
      '待落点项也要连着草稿一起算',
    ],
    [/draft: view === 'notes' \? activeDraft : null/, '只有笔记页才把草稿记进记忆'],
  ]
  for (const [pattern, why] of wiring) assert.match(source, pattern, why)
})

test('视图记忆：没有 `bookId` 的垃圾不进记忆', async () => {
  const { rememberSessionView, recallSessionView, sessionViews } = await internals()
  sessionViews.clear()
  rememberSessionView(sessionViews, 'session-abc', { view: 'reader', book: { title: '没有 id' } })
  assert.equal(recallSessionView(sessionViews, 'session-abc'), undefined)
  // 会话 id 缺失时也不该写进一个空键。
  rememberSessionView(sessionViews, '', { view: 'reader', book: { bookId: 'x' } })
  assert.equal(sessionViews.size, 0)
})

test('自动开页签：拿不到服务就静默降级，绝不抛', async () => {
  const { revealReaderTab } = await internals()
  // 这一条跑在"发送到会话"的成功路径上，抛了会让读者看到"放入输入框失败"，
  // 而实际上文字已经交接成功 —— 那是纯粹的误报。
  for (const service of [null, undefined, {}, { openTab: 42 }, 'x', 0]) {
    assert.equal(revealReaderTab(service, 'session-abc', () => {}), false, `service=${JSON.stringify(service)}`)
  }
})

test('自动开页签：要重试，因为目标会话的侧边栏是稍后才挂上的', async () => {
  const { revealReaderTab, REVEAL_RETRY_DELAYS } = await internals()
  const calls = []
  const ok = revealReaderTab(
    { openTab: (kind, options) => calls.push({ kind, options }) },
    'session-abc',
    (fn, delay) => calls.push({ scheduled: delay, fn }),
  )
  assert.equal(ok, true)
  assert.ok(REVEAL_RETRY_DELAYS.length >= 2, '只打一次几乎必然太早：binding 要等一次提交才挂上')
  assert.equal(calls.filter((c) => typeof c.fn === 'function').length, REVEAL_RETRY_DELAYS.length)
  // 重试是幂等的（`revealIfOpened`），所以每次都打是安全的。
  for (const call of calls) if (typeof call.fn === 'function') call.fn()
  assert.equal(calls.filter((c) => c.kind !== undefined).length, REVEAL_RETRY_DELAYS.length)
  assert.equal(calls.find((c) => c.kind !== undefined).kind, 'dsh-reading-companion')
  assert.equal(calls.find((c) => c.kind !== undefined).options.revealIfOpened, true)
})

test('自动开页签：宿主没挂载侧边栏时抛错必须被吞掉，不能连累别的功能', async () => {
  const { revealReaderTab } = await internals()
  // 宿主的 `require()` 在没有挂载面时**直接抛** `no session surface is mounted`。
  const attempts = []
  const ok = revealReaderTab(
    { openTab: () => { attempts.push(1); throw new Error('sidebarRight: no session surface is mounted') } },
    'session-abc',
    (fn) => fn(),
  )
  assert.equal(ok, true)
  assert.equal(attempts.length, 5, '每次重试都要真的试一次（前几次本来就预期会抛）')
})

test('发到会话：交接带的是**原文**，不拼源会话输入框里的字', async () => {
  // 合并「输入框里已有的字」必须发生在**兑现那一刻**——那边读到的
  // `existingDraft` 才是目标会话自己的。在这里拼，等于把源会话里打了一半的
  // 话搬到目标会话去，而那是读者没打算发出去的东西。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(
    source,
    /requestHandoff\(\{ sessionId: plan\.targetSessionId, text, book, draft: active \}\)/,
    '交接必须带原始 text；拼上 existingDraft 会把源会话的草稿搬进目标会话',
  )
  // 草稿要带本地的 `active`（回应框的改动只活在它里面），不是面板传下来的
  // `activeDraft` —— 后者在读者改过回应框之后就是旧的了。
  assert.doesNotMatch(
    source,
    /requestHandoff\(\{ sessionId: plan\.targetSessionId, text, book, draft: activeDraft \}\)/,
    '交接的草稿要取本地 state，否则读者刚改的回应不会跟过去',
  )
})

test('发到会话：正文的「笔记」按钮必须真的接上 —— 漏传 prop 会静默失效', () => {
  // `ReaderView` 顶部那颗「笔记」按钮一直在调 `onOpenNotes`，而 `ReaderPanel`
  // 曾经**忘了把这个 prop 传下去**：按钮点了毫无反应，读者不先在正文里选中一段
  // 就进不了笔记页（真机反馈）。
  //
  // 这一类洞渲染层查不出来 —— 组件少收一个 prop 只是**安静地什么都不做**。
  // 所以这里不止钉那一个名字，而是把整条规律钉住：`ReaderView` 解构出来的每一个
  // prop，`ReaderPanel` 渲染它时都必须给。将来再加 prop 忘了传，会在这里报红。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const decl = /function ReaderView\(props\) \{\s*\n\s*const \{ ([^}]+) \} = props/.exec(source)
  assert.ok(decl !== null, '找不到 ReaderView 的解构 —— 断言的锚点已经失效了')
  const call = /return h\(ReaderView, \{([\s\S]*?)\n {6}\}\)/ .exec(source)
  assert.ok(call !== null, '找不到 ReaderPanel 里对 ReaderView 的渲染 —— 锚点已经失效了')
  const missing = decl[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
    // 两种传递写法都算数：`name: value` 与简写 `name`。只认前者的话，`book,`
    // 这种简写会被误报成"漏传"。
    .filter((name) => !new RegExp(`[\\s,{]${name}\\s*(?=[,:}])`).test(call[1]))
  assert.deepEqual(
    missing,
    [],
    `ReaderView 需要这些 prop，但 ReaderPanel 没传：${missing.join('、')}（漏传是静默失效）`,
  )
  // 顺带钉住"从正文进笔记页"这一条路径本身：来源要记成正文。
  assert.match(
    source,
    /onOpenNotes: \(\) => \{\s*\n\s*noteOriginRef\.current = 'reader'/,
    '正文的「笔记」按钮要把来源记成正文，否则返回与发送的落点都会错',
  )
})

test('发到会话：交接必须一并交出 `book`，否则跳过去只会看到书架', async () => {
  // 目标会话的面板可能是**本页面里第一次**打开，它的视图记忆是空的。
  // 不把书一起交出去，读者跳过去看到的是书架，还得再点一次那本书 ——
  // 那正是他反馈的问题。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(source, /rememberSessionView\(sessionViews, payload\?\.sessionId, \{/, '交接时要给目标会话播下视图种子')
  assert.match(source, /book: payload\?\.book \?\? book/, '种子里的书来自当前面板')
})

test('发到会话：跳得过去 + 有人接住，两个条件缺一不可', async () => {
  // 只判断"跳得过去"是不够的：若交接通道缺失，`requestHandoff(...)` 会抛
  // TypeError，被同一段 try/catch 吞成一句"放入输入框失败"——而文字已经没了。
  // 那时候读者看到的是"失败"，实际上更糟：跳也跳了、字也没了。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(
    source,
    /canOpenSession: typeof openSession === 'function' && typeof requestHandoff === 'function'/,
    '两个条件都要：跳得过去，且跳过去之后有人接住这段文字',
  )
})

test('交接：`wait` 必须在清空之前返回，否则文字永久丢失', async () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const waitAt = source.indexOf("if (decision.action === 'wait') return")
  const commitAt = source.indexOf('commitDraftHandoff(draftHandoffs, sessionId)')
  assert.ok(waitAt > 0, '必须留 `wait` 的提前返回')
  assert.ok(commitAt > 0, '必须清空已处理的交接')
  assert.ok(
    waitAt < commitAt,
    '清空必须在 wait 判断之后——顺序反了就会把"还没跳过去"的交接当成处理完而丢掉',
  )
})


test('章节标题：客户端与宿主的规则在整数章号上必须逐字相同', async () => {
  const { chapterHeading } = await internals()
  const titles = ['第16章 带子', '卷二 风起', '雪夜', '', undefined, '第十三回 见故人', '尾声']
  for (let index = 0; index < 20; index += 1) {
    for (const title of titles) {
      assert.equal(
        chapterHeading(index, title),
        chapterLabel(index, title),
        `index=${index} title=${JSON.stringify(title)} 时两边不一致 —— 同一条笔记在会话里和 md 里会出现两个章号`,
      )
    }
  }
  // `{{` 是唯一的**刻意**差异：宿主那侧还要过 prompt 插值转义（见 spoiler.js 的
  // escapePromptText，`{{` 会让整次 systemPrompt 装配抛错），而客户端这段文字
  // 进的是聊天输入框、是用户消息的字面文本，不该被转义。
  assert.equal(chapterLabel(0, '奇书 {{title}}'), '第 1 章 · 奇书 { {title}}')
  assert.equal(chapterHeading(0, '奇书 {{title}}'), '第 1 章 · 奇书 {{title}}')
})

test('章节标题：没有章序号时原样回标题', async () => {
  const { chapterHeading } = await internals()
  assert.equal(chapterHeading(null, '卷一'), '卷一')
  assert.equal(chapterHeading(null, undefined), '')
})

test('发到会话：守卫只看摘抄与感想，不会被新加的章节行骗过', async () => {
  // `sendToSession` 是组件内的回调，替身测不到它的分支。这里静态钉住那条守卫
  // 的形态——它原本是 `text === ''`，而在开头加上章节行之后，那个判断会让
  // "只有章节、没有摘抄感想"的输入**通过**（因为章节行本身就是非空文本）。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(
    source,
    /if \(excerpt\.trim\(\) === '' && thought\.trim\(\) === ''\)/,
    '守卫必须只看摘抄与感想，否则加了章节行之后它会静默失效',
  )
  assert.ok(
    source.includes('lines.push(`**${heading}**`)'),
    '发到会话时开头必须写明章节',
  )
})

//#region 竞态守卫

test('竞态守卫：只有最新一次请求算数', async () => {
  const { createLatestGuard } = await internals()
  const guard = createLatestGuard()
  const first = guard.issue()
  assert.equal(guard.isCurrent(first), true, '刚发出的那次必须有效')

  const second = guard.issue()
  assert.equal(guard.isCurrent(first), false, '更早的那次必须被判过期')
  assert.equal(guard.isCurrent(second), true, '最新那次必须有效')
})

test('竞态守卫：迟到的旧响应必须被丢弃，而不是覆盖新状态', async () => {
  // 这是「快速切书」的真实形状：书 A 的请求**先发**，用户随后切到书 B，
  // B 的响应先回来，A 的后回来。不做守卫的话，A 的数据会盖在 B 的界面上。
  const { createLatestGuard } = await internals()
  const guard = createLatestGuard()
  const applied = []
  const apply = (ticket, value) => {
    if (guard.isCurrent(ticket)) applied.push(value)
  }

  const ticketA = guard.issue() // 书 A 发出
  const ticketB = guard.issue() // 用户已经切到书 B
  apply(ticketB, 'B 的数据') // B 先回来
  apply(ticketA, 'A 的数据') // A 后回来 —— 必须被丢掉

  assert.deepEqual(applied, ['B 的数据'], 'A 的迟到响应覆盖了 B 的状态')
})

test('竞态守卫：每个资源各用各的，互不作废', async () => {
  // 共用一个守卫的话，「重新生成预览」触发的背景认识重载会把还在飞的
  // 讨论历史判成过期——一个资源的刷新会静默取消另一个资源的结果。
  const { createLatestGuard } = await internals()
  const background = createLatestGuard()
  const discussions = createLatestGuard()
  const inflight = discussions.issue()
  background.issue() // 另一个资源发了新请求
  assert.equal(discussions.isCurrent(inflight), true, '另一个资源的请求不该作废这一个')
})

test('竞态守卫：每个按书加载的资源各自装了守卫', () => {
  // 守卫是组件内的 hook，替身测不到"切书时真的丢弃了响应"。这里静态钉住
  // **接线**：每个加载器都必须先取票、回来先验票。少接一个，那条路径就又
  // 回到"谁后回来谁说了算"。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  /**
   * 每个受守卫的资源 → 它必须有几处**真正的提前返回**。
   *
   * ⚠️ 这里刻意**按守卫逐个计数**，而不是数全文件的总数。上一版数的是总数
   * （5×2 = 10），结果这一轮新增两个受守卫的资源就把它撞红了。断言本身没有
   * 写错，是它**问错了问题**：要钉住的性质是"每个加载器都验了票"，而不是
   * "全文件恰好有 10 处验票"。总数会随无关改动漂移，逐个计数才是不变量。
   *
   * 也不数 `.isCurrent(ticket)` 出现过几次：那样会被 `if (false && ...)` 这种
   * 阉割骗过去——实测踩到过，断言绿着而那一处守卫已经完全不生效。数"真正的
   * 提前返回"才作数。
   */
  const guards = [
    // 五个按书加载的资源：then 与 catch 都要验票，否则失败会被记到另一本书的界面上。
    ['bindingGuard', 2],
    ['backgroundGuard', 2],
    ['personaGuard', 2],
    ['discussionsGuard', 2],
    ['previewGuard', 2],
    // 打开书：目录与进度一起拉的 Promise.all，成功与失败两条路径。
    ['openGuard', 2],
    // ⚠️ `captureGuard` 已经**删掉**了，别再加回来：起稿现在是同步的（`captureNote`
    //    不落服务端，见「起稿：进笔记页不写服务端」那条用例），没有响应会晚到。
  ]

  for (const [guard, expected] of guards) {
    assert.ok(
      new RegExp(`const ${guard} = useLatestGuard\\(\\)`).test(source),
      `${guard} 没有声明 —— 那个资源又会被迟到响应覆盖`,
    )
    const returns = (source.match(new RegExp(`if \\(!${guard}\\.isCurrent\\(ticket\\)\\) return`, 'g')) ?? []).length
    assert.equal(returns, expected, `${guard} 的提前返回数目不对（期望 ${expected}）`)
  }

  // 反向断言：源码里声明了几个守卫，就必须都登记在上面这张表里。
  // 这一条挡住"新加了一个受守卫的资源、却忘了登记"—— 否则新资源的守卫
  // 永远不受这个测试保护，而测试看起来还是绿的。
  const declared = (source.match(/const \w+Guard = useLatestGuard\(\)/g) ?? []).length
  assert.equal(declared, guards.length, '有守卫没有被登记进 guards 表')
})

test('阅读排版：章节标题必须跟着正文字号缩放，不能写死 px', () => {
  // 正文字号是**用户可调**的（13–30px，见 DEFAULT_FONT_PREFS）。标题写死 15px
  // 的话：默认 16px 时标题就已经比正文小，把字号调到 20px 之后标题会明显
  // "塌"进正文里，章节与段落的层级彻底消失。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const rule = /\.drc-article h2 \{([^}]*)\}/.exec(source)
  assert.ok(rule !== null, '找不到 .drc-article h2 规则')
  const fontSize = /font-size:\s*([^;]+);/.exec(rule[1])
  assert.ok(fontSize !== null, '章节标题必须有显式字号')
  assert.match(fontSize[1].trim(), /em$/, `章节标题字号必须是 em（跟随正文），实际是 ${fontSize[1].trim()}`)
  assert.doesNotMatch(fontSize[1], /px/, '章节标题不能用 px —— 正文字号可调，标题会被反超')
})

test('位置恢复：空正文绝不能记账（否则整条进度链路失效）', async () => {
  // ⚠️ 这是本轮修掉的那个 bug 的**全部**。
  //
  // `ReaderView` 挂载那一刻 `chapter` 还是 null、`paragraphs` 是空数组，而恢复
  // 位置的 effect 照样会跑一趟。旧的布尔旗标会在这里被**提前消耗**：等正文真的
  // 到达、依赖变化让 effect 重跑时，旗标已经是 true → 直接 return，于是**再也
  // 没有人滚动过视口**。表现是"每次打开书都停在章首"，而进度在服务端存得好好的
  // ——从界面上看不出它是坏的，只觉得"它怎么不记得我读到哪"。
  const { shouldRestorePosition, positionKey } = await internals()

  const key = positionKey('75075244735918ec', 5)
  assert.equal(key, '75075244735918ec:5', '账本键必须按书+章区分')

  assert.equal(
    shouldRestorePosition(null, key, false),
    false,
    '正文还没到就记账了 —— 数据到达后的那一趟会直接 return，位置永远不恢复',
  )
  assert.equal(shouldRestorePosition(null, key, true), true, '正文到了就该恢复')
  assert.equal(
    shouldRestorePosition(key, key, true),
    false,
    '同一章只恢复一次 —— 否则自动进度回写（initialOffset 变化）会把视口反复往回带',
  )
  assert.equal(shouldRestorePosition('另一本:1', key, true), true, '换书换章要重新恢复')
})

test('位置恢复：effect 必须依赖 paragraphs，且不许退回一次性旗标', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const effect = /\/\/ --- 落回上次的位置 ---([\s\S]*?)\}, \[([^\]]*)\]\)/.exec(source)
  assert.ok(effect !== null, '找不到恢复位置的 effect')

  assert.match(effect[2], /paragraphs/, '依赖里没有 paragraphs —— 正文到达时 effect 不重跑，位置永不恢复')
  assert.match(effect[2], /initialOffset/, '依赖里没有 initialOffset —— 换章落回原处就失效了')
  assert.doesNotMatch(
    effect[1],
    /if \(chapter === null \|\| restoredRef\.current\)/,
    '又用回了"一次性布尔旗标"的写法',
  )
})

test('目录筛选：章号按**1 起**匹配，与界面上显示的一致', async () => {
  // 界面上显示的是 `String(chapter.index + 1).padStart(3, '0')`。筛选如果按
  // `index`（0 起）匹配，用户打「1」就搜不到第一段 —— 而那种失效在界面上
  // 表现为"这本书没有这一章"，不会报错。
  const { filterChapters } = await internals()
  const chapters = [
    { index: 0, title: '卷首', volume: null },
    { index: 1, title: '第1章 奇书', volume: '卷一' },
    { index: 811, title: '第812章 归来', volume: '卷七' },
    { index: 812, title: '第813章 尾声', volume: '卷七' },
  ]

  assert.deepEqual(filterChapters(chapters, ''), chapters, '空筛选必须原样返回（含引用）')
  assert.deepEqual(filterChapters(chapters, '   '), chapters, '纯空白也算没筛')

  const one = filterChapters(chapters, '1')
  assert.ok(one.some((c) => c.index === 0), '打「1」必须能找到第一段（章号 1 起）')

  const byNumber = filterChapters(chapters, '812')
  assert.deepEqual(byNumber.map((c) => c.index), [811], '「812」应当只命中章号 812 那一条')

  const byTitle = filterChapters(chapters, '尾声')
  assert.deepEqual(byTitle.map((c) => c.index), [812])

  const byVolume = filterChapters(chapters, '卷七')
  assert.deepEqual(byVolume.map((c) => c.index), [811, 812])

  assert.deepEqual(filterChapters(chapters, '不存在的东西'), [], '筛不到就是空数组')
  assert.deepEqual(filterChapters(null, 'x'), [], '非数组不得抛错')
  assert.deepEqual(filterChapters([null, 'x', 3], 'x'), [], '坏条目要被跳过')
})

test('目录筛选：短书不显示筛选条（阈值存在且合理）', async () => {
  const { TOC_FILTER_MIN } = await internals()
  assert.equal(Number.isInteger(TOC_FILTER_MIN), true)
  assert.ok(TOC_FILTER_MIN >= 20 && TOC_FILTER_MIN <= 200, `阈值不合理：${TOC_FILTER_MIN}`)
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(
    source,
    /chapters\.length < TOC_FILTER_MIN/,
    '筛选条没按阈值隐藏 —— 短书会平白多出一条输入框',
  )
})

test('记笔记：NotesView 要有会变的 key，而且**保存时不能变**', () => {
  // ⚠️ 这条来自一个两份外部审查报告都没抓到的 bug，测试替身也渲染不出来（它的
  // useState 不做状态更新）—— 它是**靠读时序发现的**：`NotesView` 把 props 只读进
  // `useState` 的初值，而它恰好是在内容还没到位的那一刻挂载的，于是摘抄框是空的。
  //
  // 修法是给它一个会变的 key。但 key **用哪个量**很讲究：上一版用的是
  // `activeDraft?.draftId`，那在"起稿是一发 POST、id 由响应带回"的前提下成立。
  // 起稿同步化之后它反而有害 —— 面板会在**保存成功**时从 `onDraftChange` 拿到真实
  // 的 draftId，那一换 key 就把 `NotesView` 重挂掉，"草稿已保存。"连同编辑框里还
  // 没回写的中间态一起消失。所以改成只在"换编辑目标"时 +1 的世代号。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const render = /return h\(NotesView, \{([\s\S]*?)\}\)/.exec(source)
  assert.ok(render !== null, '找不到 NotesView 的渲染点')
  assert.match(render[1], /key: noteEpoch/, 'NotesView 缺 key —— 换编辑目标时不会重挂，摘抄框会是空的')
  assert.doesNotMatch(
    render[1],
    /key: activeDraft/,
    'key 又挂在 activeDraft 上了 —— 保存成功会让它变，通知与编辑框中间态会被重挂吃掉',
  )
})

//#region 起稿不落盘（v0.14.4）

test('起稿：进笔记页不写服务端，草稿栏只装读者亲手存过的东西', () => {
  // ⚠️ 钉的是一个**行为方向**，不是实现细节。
  //
  // 从前 `captureNote` 会立刻 POST 一条草稿，于是"我只是用光标选了一段、点进来
  // 看一眼"也会在「未落盘的草稿」里留下一条 —— 而草稿栏是"我存过哪些"的清单，
  // 不该被浏览动作污染（真机反馈）。现在的规则和正文顶部那颗「笔记」按钮一致：
  // 进笔记页只把选区装进编辑框，服务端的记录等「保存草稿」才产生。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const body = /const captureNote = useCallback\(\(payload\) => \{([\s\S]*?)\n      \}, \[/.exec(source)
  assert.ok(body !== null, '找不到 captureNote 的函数体 —— 断言的锚点已经失效了')
  assert.doesNotMatch(body[1], /callApi\(/, '起稿落服务端了：光进一趟笔记页就会在草稿栏里多出一条')
  assert.match(body[1], /setActiveDraft\(\{/, '起稿要把选区装进编辑框')
  assert.doesNotMatch(body[1], /draftId\s*:/, '起稿不该带 draftId —— 带了就等于宣称它已经落盘')

  // "写了，但还没保存"必须让读者看得见：起稿不再自动落盘之后，这句话是唯一的
  // 解释，没有它，"我明明写了"与"草稿栏里没有"就只剩下困惑。
  assert.match(
    source,
    /尚未保存 · 点「保存草稿」才会进草稿栏/,
    '「写了但还没保存」这个状态没有露出来 —— 读者会以为草稿栏里的东西丢了',
  )
})

test('起稿：没有 draftId 时不许替读者建记录', () => {
  // `persist` 是"回应框改动后自动存一次"。它从前总有个 draftId 可用；现在若在
  // 没有 id 时"顺手新建"，就等于**绕过「保存草稿」**把东西塞进草稿栏 —— 而那正是
  // 这一版要修掉的行为。它是组件内逻辑、替身渲染不到，所以静态钉住这个短路。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(
    source,
    /if \(draftId === undefined \|\| draftId === null\) return Promise\.resolve\(null\)/,
    'persist 在没有 draftId 时没有短路 —— 它会替读者建一条草稿',
  )
  assert.doesNotMatch(
    source,
    /drafts\/\$\{active\.draftId\}\/commit/,
    '写入笔记又拿 active.draftId 去提交了 —— 未保存的起稿没有 id，会提交 undefined',
  )
  assert.match(
    source,
    /const draftId = data\?\.draft\?\.draftId/,
    '写入笔记必须用 POST 响应里的 id（未保存的起稿要靠那一次 POST 才有 id）',
  )

  // 章节要跟着**第一次** POST 一起送：从前它由"在正文里起稿"那一次带上去，现在
  // 第一次 POST 发生在「保存草稿」与「写入笔记」，不带就等于把草稿挂到**没有出处**
  // 的位置上。
  //
  // ⚠️ 这里**逐个函数**取 body 来断言，不数全文件的总数：上报给面板的那份 payload
  // 里也有同一个表达式，数总数会把"上报带了"误当成"两个 POST 都带了"（实测踩到过：
  // 总数是 3，而这条断言当时写的是 2）。
  for (const name of ['save', 'commit']) {
    const fn = new RegExp(`const ${name} = useCallback\\([\\s\\S]*?\\n      \\}, \\[`).exec(source)
    assert.ok(fn !== null, `找不到 ${name} 的函数体 —— 断言的锚点已经失效了`)
    assert.match(
      fn[0],
      /chapterIndex: Number\.isInteger\(active\?\.chapterIndex\) \? active\.chapterIndex : null/,
      `${name} 写草稿时没带章节 —— 草稿会挂到没有出处的位置上`,
    )
  }
})

test('会话记忆：未保存的起稿也要能记（它没有 draftId）', async () => {
  // 记忆层从前按"`draftId` 必须是字符串"来卡。起稿同步化之后，"服务端还没有这条
  // 记录"是常态，那样一刀切会把**整条会话记忆**丢掉 —— 表现是切个页签回来摘抄与
  // 感想没了，而界面上看不出任何错误（`resolveRestoreView` 只会安静地退到目录）。
  const { rememberSessionView, recallSessionView, sessionViews } = await internals()
  sessionViews.clear()
  const seed = { draftId: null, excerpt: '一段原文', thought: '一点感想' }
  rememberSessionView(sessionViews, 'session-abc', { view: 'notes', book: { bookId: 'b1' }, draft: seed })
  const remembered = recallSessionView(sessionViews, 'session-abc')
  assert.equal(remembered?.view, 'notes', '未保存的起稿把整条记忆一起带掉了')
  assert.deepEqual(remembered?.draft, seed)

  // 但"不是对象"的垃圾仍然要挡住 —— 放进去会让笔记页拿着一个字符串去读字段。
  sessionViews.clear()
  rememberSessionView(sessionViews, 'session-abc', { view: 'notes', book: { bookId: 'b1' }, draft: '不是草稿' })
  assert.equal(recallSessionView(sessionViews, 'session-abc'), undefined)
})

test('起稿：编辑内容要回报给面板，且面板那个回调必须是稳定引用', () => {
  // 未保存的内容只活在内存里（`captureNote` 不落盘），所以"切页签/切会话不丢"
  // 全靠这条上报线。⚠️ 面板那个回调若是内联箭头函数，每次渲染换一个新引用，
  // `NotesView` 的上报 effect 就会"上报 → setState → 重渲染 → 再上报"地死循环。
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(
    source,
    /const handleDraftChange = useCallback\(\(draft\) => \{\n\s*setActiveDraft\(draft\)\n\s*\}, \[\]\)/,
    'handleDraftChange 必须是空依赖的 useCallback —— 内联箭头会让上报 effect 死循环',
  )
  assert.match(source, /onDraftChange: handleDraftChange,/, 'NotesView 没有拿到上报回调')
  assert.match(source, /if \(typeof onDraftChange !== 'function'\) return/, '上报端没有对回调做存在性检查')
  // draftId 一律归一成"字符串或 null"：下游全靠它分派，`undefined` 漏进会话记忆
  // 会让"未保存"这个状态在某些路径上判不出来。
  assert.match(
    source,
    /draftId: typeof active\?\.draftId === 'string' \? active\.draftId : null/,
    '上报的 draftId 没有归一化 —— undefined 会漏到会话记忆里',
  )
})

//#endregion

//#endregion
