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
import { fileURLToPath } from 'node:url'

// ⚠️ 唯一一处从浏览器半边的测试里 import 宿主模块。原因见文末那条「两边逐字
//    相同」的契约测试：`chapterHeading` 是宿主 `chapterLabel` 的**镜像**，
//    而镜像只有在被摆在一起比对时才算数。
import { chapterLabel } from '../lib/host/spoiler.js'

// 浏览器半边的公共加载器（doc 替身 / react 替身 / factory 物化）。
// 抽出去的理由见那个文件的开头：新的 hooks 运行时也走同一套流程，
// 各写一份的话一处修了另一处不会跟着好。
import { ROOT, freshUrl, makeFakeDocument, reactStub, loadClientFactory, loadClientModule } from './helpers/client-loader.mjs'

// ROOT 由公共加载器提供（test/helpers/client-loader.mjs）
const PLUGIN_NAME = 'dsh-reading-companion'
const TAB_ID = 'dsh-reading-companion:reader'

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
  assert.equal(tabTypes[0].title(), '本地书架')

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
  // ⚠️ v2.1.3：两个服务都是**取用函数**（`getOpenSession` / `getSidebarRight`），
  // 不是取好的值 —— 见下面那条"服务晚到"的回归守卫。
  const injected = body.options.inject('sess-1')
  assert.equal(injected.sessionId, 'sess-1')
  assert.equal(typeof injected.getOpenSession, 'function', '要交出取用函数，而不是取好的值')
  assert.equal(injected.getOpenSession(), null, '没有 sessions 服务时现取必须是 null，而不是让 apply 抛错')
  assert.equal(injected.getSidebarRight(), undefined, '没有 sidebarRight 就是 undefined')

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
  // ⚠️ v2.1.3：注入的是**取用函数**（`getOpenSession`），不是取好的值 ——
  // 服务可能在我们 apply 之后才注册，取一次就会永久拿不到（见下一条回归用例）。
  const openSession = props.getOpenSession()
  assert.equal(typeof openSession, 'function')
  openSession('bound-session')
  assert.deepEqual(opened, ['bound-session'])
})

test('浏览器半边：★服务**晚到**也能拿到 openSession（v2.1.3 真机事故的回归守卫）', async () => {
  // 真机表现：读者装了另一个客户端插件（改了加载顺序）之后，书架那一行的
  // 「已绑定 · 跳过去」整个退化成不可点的静态标「已绑定会话」。
  // 根因是在 apply 里取一次 `ctx.get('sessions')`、把结果当 prop 传下去 ——
  // 那一刻服务还没注册，于是**永久**是 null。现在改成每次渲染现取。
  const mod = await loadClientModule()
  const opened = []
  const { ctx, slotRegistrations, services } = makeFakeClientContext() // ① apply 时**没有** sessions
  globalThis.document = makeFakeDocument()
  try {
    mod.apply(ctx)
  } finally {
    delete globalThis.document
  }

  const body = slotRegistrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  const props = body.options.inject('sess-1')
  assert.equal(props.getOpenSession(), null, '这一刻确实还没有服务 —— 不该硬要一个函数出来')

  // ② 服务在 apply 之后才注册（替身的 services 是同一个对象，改了就生效）
  services.sessions = { open: (id) => opened.push(id) }
  const later = props.getOpenSession()
  assert.equal(typeof later, 'function', '服务晚到之后必须能现取到，否则那个入口永久消失')
  later('bound-session')
  assert.deepEqual(opened, ['bound-session'])

  // ③ 同一个坑的另一半：`sidebarRight`（跳过去之后自动开页签）同样是惰性取用。
  assert.equal(props.getSidebarRight(), undefined, '没注册就是 undefined')
  services.sidebarRight = { openTab: () => {} }
  assert.equal(typeof props.getSidebarRight()?.openTab, 'function', 'sidebarRight 同样要能晚到')
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
  assert.equal(mine[0].title(), '本地书架')
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

test('样式与模板：正文页角标块用自己的样式类（换回界面字体）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 转不了：运行时替身刻意没有 DOM / CSSOM / 布局引擎 —— "挂的是哪个类、那条 CSS 里
  // 写了什么字体栈"在渲染树上看不见，硬凑只会变成另一种源码文本钉子。
  //
  // 角标块必须**换回界面字体**：它长在阅读区里，而阅读区整块套着读者的字体偏好 ——
  // 不换的话笔记摘要与小说正文长得一模一样（真机反馈：分不清哪是「我写的」）。
  assert.ok(source.includes("className: 'drc-chapter-notes'"), '角标块要用自己的样式类')
  assert.ok(/\.drc-chapter-notes \{/.test(source), 'CSS 里要有 .drc-chapter-notes（含界面字体栈）')
})
test('文本契约：不许再出现浏览器原生确认框', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 留着的理由：行为版（`client-runtime-views.test.mjs` 装了会抛错的假 `window.confirm`）
  // 只能覆盖**跑到过的**确认处 —— 我跑了「解锁已读完」与「清空回收站」两处；
  // 丢弃草稿 / 彻底删除单条 / 切换草稿 / 跳读闸 这四处没跑，若有人只把
  // `window.confirm` 塞回那几处，行为用例不会红。这条字面反向守卫补的正是那个缺口。
  // ⚠️ 反向守卫：注释里提到 `window.confirm` 没关系（那是解释为什么不用它），
  // 但**调用**不许再出现 —— 三处确认必须是同一套形态。
  assert.ok(!/window\.confirm\(/.test(source), '不许再用浏览器原生确认框')
})

test('样式与模板：确认条的样式规则', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 转不了：替身没有 CSSOM —— "这条规则在不在、长什么样"运行时看不见。
  assert.match(source, /\.drc-confirm \{/, 'CSS 里要有 .drc-confirm')
})
test('确认条：**真执行**一次 —— busy 必须同时禁用两个按钮，两个回调也不许串台', async () => {
  // ⚠️ 这条是 2026-10-01 三方评审点名的两处"假覆盖"之一：上面那条**接线守卫**只做
  //    源码子串匹配（`source.includes('function confirmBar(')`），它钉的是"这段文本
  //    还在"，**不是**"行为发生"。函数体里任何真实缺陷（漏传 disabled、回调接错、
  //    文案兜底写反）都照不到，而报告里那两行看起来"已覆盖"。
  //    所以这里**不改**上面那条（它防的是"这个函数被删掉"，仍然有用），
  //    而是补一条真执行 —— 一个钉存在，一个钉行为。
  const { confirmBar } = await internals()
  const calls = []
  const tree = confirmBar({
    text: '会清空回收站，且不可撤销',
    primary: { label: '清空', onClick: () => calls.push('primary') },
    secondary: { label: '取消', onClick: () => calls.push('secondary') },
  })

  assert.equal(tree.props.className, 'drc-confirm', '必须用统一那个类，不是自己拼一个')
  assert.equal(tree.children[0].children[0], '会清空回收站，且不可撤销', '后果说明要原样渲染出来')

  const [primary, secondary] = tree.children[1].children
  assert.equal(primary.children[0], '清空')
  assert.equal(secondary.children[0], '取消')
  assert.equal(primary.props.disabled, false, '不在进行中时不该禁用')

  primary.props.onClick()
  assert.deepEqual(calls, ['primary'], '点主按钮只能触发它自己的回调（串台 = 点"取消"却执行了删除）')
  secondary.props.onClick()
  assert.deepEqual(calls, ['primary', 'secondary'])

  // busy：**两个都要禁用**。少禁一个，就等于"正在进行中"时还能把不可逆动作点第二次。
  const busyTree = confirmBar({
    text: 'x',
    primary: { label: 'A', onClick: () => {} },
    secondary: { label: 'B', onClick: () => {} },
    busy: true,
  })
  const [busyPrimary, busySecondary] = busyTree.children[1].children
  assert.equal(busyPrimary.props.disabled, true, 'busy 时主按钮必须禁用')
  assert.equal(busySecondary.props.disabled, true, 'busy 时次按钮也必须禁用')

  // 兜底文案：没给 label 时的默认字（这两个字是"读者看到的最后一道防线"）。
  const bare = confirmBar({ text: 'y' })
  const [barePrimary, bareSecondary] = bare.children[1].children
  assert.equal(barePrimary.children[0], '确定')
  assert.equal(bareSecondary.children[0], '取消')
})

test('导出：**真执行**一次 —— 新建/更新/未变要数准，失败要走 error 那一支', async () => {
  // ⚠️ 另一处被点名的"假覆盖"（见 `client.test.mjs` 里那条"导出结果"的源码守卫）：
  //    它只匹配源码子串，钉的是"这段文本还在"。这里补一条**真执行** ——
  //    "新建/更新/未变"的计数、追加条数、警告拼接、目录去空白、
  //    以及失败时返回可渲染的 error（两个入口都靠它填 notice），
  //    这些全是子串匹配照不到、而读者会直接看到的东西。
  const { exportBookFiles } = await internals()
  const originalFetch = globalThis.fetch
  const posts = []
  try {
    globalThis.fetch = async (url, options) => {
      posts.push({ url: String(url), body: options?.body })
      return new Response(JSON.stringify({
        ok: true,
        dir: 'D:\\笔记库',
        files: [{ action: 'create' }, { action: 'update' }, { action: 'append' }, { action: 'same' }],
        notes: { appended: 2 },
        warnings: ['有一个文件被占用，已跳过'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const result = await exportBookFiles('abc123', '  D:\\笔记库  ')
    assert.equal(result.kind, 'ok')
    assert.match(result.text, /已导出 4 个文件到 D:\\笔记库/)
    assert.match(result.text, /新建 1 · 更新 2 · 未变 1/, '三种 action 的分类计数不能串')
    assert.match(result.text, /本次追加了 2 条新笔记/)
    assert.match(result.text, /有一个文件被占用/, '警告必须如实带出来')

    assert.equal(posts.length, 1, '一次导出只该发一个请求')
    assert.match(posts[0].url, /\/books\/abc123\/export$/)
    const sent = typeof posts[0].body === 'string' ? JSON.parse(posts[0].body) : posts[0].body
    assert.equal(sent.dir, 'D:\\笔记库', '目录两端的空白要去掉再发')
  } finally {
    globalThis.fetch = originalFetch
  }

  // 失败分支：`callApi` 对非 2xx 会抛，函数必须**接住**并回一个能渲染的 error
  // （抛出去的话，两个入口的 notice 都会变成一句没有信息量的报错）。
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: false, error: 'EXPORT_REJECTED', reason: 'DIR_TAKEN' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )
    const failed = await exportBookFiles('abc123', '')
    assert.equal(failed.kind, 'error')
    assert.ok(typeof failed.text === 'string' && failed.text !== '', '错误也要有一句人话')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('文本契约：客户端路径必须写成字面量（静态契约用例要按字面逐条对宿主路由表）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // ⚠️ 这三条是**给另一条静态契约用例看的代码形态要求**，不是行为：契约用例把客户端路径
  //    与宿主路由表**逐条对**，拼出来的它认不出 ⇒ 一旦拼成 `/notes/${note.id}/${kind}`，
  //    trash / restore 两条路由就**静默失去覆盖**（没人会发现）。
  //    而行为上拼不拼发出的 URL **一模一样**（`${kind}` = 'restore'），所以硬写一条行为
  //    断言必然是**永远绿的假守卫** —— 这就是它留在文本钉子这一类的理由（2026-10-03 B 档裁定）。
  assert.ok(source.includes('notes/${note.id}/trash`'), 'trash 路由要写成字面量')
  assert.ok(source.includes('notes/${note.id}/restore`'), 'restore 路由要写成字面量')
  // ⚠️ 断言要收窄到**完整路径**：注释里那句"不拼 kind"的说明本身也包含 `${kind}`，
  //    写成 `!includes('${kind}')` 会被自己的文档绊倒（踩过一次）。
  assert.ok(!source.includes('/notes/${note.id}/${kind}'), '路径不许拼 kind')
})
test('样式与模板：对齐与回收站呈现（v1.62）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 为什么剩下的这一半转不了（③ 与 ⑥ 已经搬走，见下）：
  //   · ① ② ⑤ 钉的是 **CSS 规则的文本内容** —— `.drc-tabs` 的 padding、`.drc-note-item`
  //     的 `padding: 8px 0`、`.drc-btn-on` 不带 `font-weight`、`.drc-tab-num` 的
  //     `tabular-nums`。这套替身**没有排版引擎**：`document` 是假的、样式表只是被
  //     `appendChild` 记下来的一段字符串，既算不出 computed style，也量不出"左基线差
  //     6px"。行为化它们要先有真浏览器（Playwright / jsdom + getComputedStyle），而本
  //     仓库零依赖、只有 node:test —— 这一档做不到。
  //     （其中"tab 行挂的类名是 `.drc-tabs`"**是**看得见的：类名就在 props 上。但只钉
  //      类名、不钉 padding，等于没钉住"对齐"这件事，所以这一条留在原地。）
  //   · ④ 钉的是**模板形状**（"三路列表不再各自套一层 `.drc-section`"）。它原则上可见
  //     （类名在 props 上），但行为化的写法只能是"数一数列表区里有几个 section 节点"
  //     —— 那是另一种更脆的计数钉子（而且 `NoteList` 是 `memo`，命中时会 return null），
  //     换不来更真的保证，所以不搬。
  //   · ③（回收站不渲染翻页行）已搬到 client-runtime-review-fixes.test.mjs：真渲染
  //     `NoteList`，trash / notes 两种模式对比。**这里不要留**。
  //   · ⑥（`aria-pressed`）也搬走了：它是渲染树上的 prop，生产代码按当前 tab 算
  //     （`'aria-pressed': tab === value`），所以**能**行为化 —— 见
  //     client-runtime-review-fixes.test.mjs 的「笔记页：当前选中的 tab 才带
  //     aria-pressed（点一下要跟着翻）」。**这里不要留 ⑥**，否则同一件事又有了第二份钉子。

  // ① tab 行自带内边距。
  // ⚠️ 这条防的是一个**看不见的**回归：`.drc-body` 没有内边距（那一层一向由
  // `.drc-section` 提供），所以 tab 行一旦退回裸 `.drc-row`，它就会比同页的表单
  // 元素左 6px、比列表文字左 21px —— 正是读者截图里指的那处"没对齐"。
  assert.ok(source.includes("className: 'drc-tabs'"), 'tab 行要用自带内边距的 .drc-tabs')
  assert.match(source, /\.drc-tabs \{[^}]*padding: 8px 10px 0;/, '.drc-tabs 必须有左右内边距')
  // ⚠️ v1.67：**整页只剩一条左基线** —— 列表项自己不再带水平内边距（那 10px 会把笔记标题
  // 推到 tab / 表单元素的右边去，就是读者当初说的"没对齐"）。三处列表（笔记 / 草稿 /
  // 讨论历史）都靠各自的 `.drc-section` 或外层 `ul` 提供那条 10px 内缩。
  assert.match(
    source,
    /\.drc-note-item \{[^}]*padding: 8px 0;/,
    '列表项不许再自带水平内边距（会在同一页多出一条左基线）',
  )
  // ② 选中态**不许**加粗：加粗会让被选中的那颗变宽，切换时整行左右抖。
  assert.doesNotMatch(source, /\.drc-btn-on \{[^}]*font-weight/, '.drc-btn-on 不许加粗（会让整行抖）')
  // ④ 三路列表**不再各自套一层** `.drc-section`：`NoteList` 的根自己就是 section，
  //    套两层 = 回收站的内容比另外两个 tab 多缩进 10px（切过去整张列表往右跳）。
  const branches = source.slice(source.indexOf('三路列表：回收站 / 草稿 / 笔记'), source.indexOf('三路列表：回收站 / 草稿 / 笔记') + 1200)
  assert.ok(!branches.includes("className: 'drc-section'"), '三路列表不许再套 .drc-section（会多缩进一层）')
  // ⑤ 计数为 0 时淡一点，且数字用等宽字形（1 与 8 的宽度差会让这行抖）。
  assert.ok(source.includes('drc-tab-num-zero'), '计数为 0 的 tab 要淡一点')
  assert.match(source, /\.drc-tab-num \{[^}]*tabular-nums/, '计数要用等宽数字')
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

test('导入说明：有问题才说，没问题闭嘴', async () => {
  const { importNotes } = await internals()

  // ① 干净的导入：按 BOM / 严格 UTF-8 判定 + 没有任何 warning → 一个字都不说。
  //    这条守卫的是"不啰嗦"：一本每本书都挂着的说明会变成噪音，读者第二次就
  //    学会无视它 —— 那时真出事的那本也一起被无视。
  assert.deepEqual(importNotes({ encoding: 'utf-8', encodingConfidence: 'bom', warnings: [] }), [])
  assert.deepEqual(importNotes({ encoding: 'utf-8', encodingConfidence: 'strict-utf8' }), [])

  // ② 猜出来的编码必须说 —— 它是"你现在读到的可能是乱码"的唯一凭据。
  const guessed = importNotes({
    sourceName: '夜行.txt',
    encoding: 'gb18030',
    encodingConfidence: 'fallback',
    warnings: ['GB18030 解码出现 3.1% 替换字符，可能仍是乱码'],
  })
  assert.equal(guessed.length, 3, '来源文件 + 编码 + 那一条 warning')
  assert.equal(guessed[0], '来源文件：夜行.txt')
  assert.equal(guessed[1], '编码：gb18030（不是合法 UTF-8，回退判定）')
  assert.equal(guessed[2], 'GB18030 解码出现 3.1% 替换字符，可能仍是乱码')

  // ③ heuristic（按字节分布猜）与 fallback（严格 UTF-8 失败后回落）是两种说法，
  //    不能混成一句 —— 读者据此判断的"可疑程度"本来就不一样。
  assert.match(importNotes({ encoding: 'utf-16le', encodingConfidence: 'heuristic' })[0], /按字节分布猜的/)

  // ④ 「定长分段」不许在这里再说一遍：目录页顶部已经单独说过（`strategy ===
  //    'fixed-blocks'` 的分支）。同一件事说两遍，读者会以为是两件事。
  const lines = importNotes({
    sourceName: 'x.txt',
    encoding: 'utf-8',
    encodingConfidence: 'bom',
    warnings: ['未检测到章节结构'],
    strategy: 'fixed-blocks',
  })
  assert.deepEqual(lines, ['来源文件：x.txt', '未检测到章节结构'])
  assert.ok(!lines.some((line) => line.includes('定长')), '定长分段那句归目录页顶部，不许重复')

  // ⑤ 脏数据不许让目录页白屏（外部工具改坏了 library.json 是很现实的一种）。
  assert.deepEqual(importNotes(null), [])
  assert.deepEqual(importNotes(undefined), [])
  assert.deepEqual(importNotes('不是对象'), [])
  assert.deepEqual(importNotes({ warnings: '不是数组' }), [])
  assert.deepEqual(importNotes({ warnings: ['', '   ', 42] }), [])
})

// ⚠️ 原来这里有一条「接线守卫：目录页真的渲染了「导入说明」」的**源码文本**钉子
//    （`source.includes('h(ImportNotes, { book })')`），2026-10-03 删掉了 ——
//    它钉的事已经由 `client-runtime.test.mjs` 的**行为**断言覆盖（真的渲染目录页、
//    真的点开导入说明、并断言零新增请求）。留着两条就是守卫只增不减。
//    理由见 `docs/design-history.md` 的 v3.9。

test('状态文件损坏的提示：说清"哪一份、影响什么、坏文件没删"（P2-2 的读者侧那半）', async () => {
  // 宿主把 `/health.quarantined` 报上来（`listQuarantined` 直接读磁盘 ⇒ 重启后仍然说得出事），
  // 客户端这一侧只负责把它说成人话。**说人话**是这条的全部要点：只说"有文件损坏"
  // 等于没说 —— 读者要知道的是"我那本书的进度为什么显示成没读过"。
  const { quarantineNoticeText } = await internals()

  assert.equal(quarantineNoticeText([]), null, '没事就别出提示')
  assert.equal(quarantineNoticeText(null), null, '拿不到数据时也别出提示')
  assert.equal(quarantineNoticeText(undefined), null)

  const text = quarantineNoticeText([{ base: 'bindings.json', file: 'bindings.json.corrupt-2026-10-02T10-00-00-000Z' }])
  assert.ok(typeof text === 'string' && text.length > 0, '有损坏必须给一句话')
  assert.ok(text.includes('bindings.json.corrupt-2026-10-02T10-00-00-000Z'), '要说清是哪一份（读者得能找到它）')
  assert.ok(text.includes('绑定与阅读进度'), '要说清影响的是什么 —— "进度没了"才是读者真正在问的事')
  assert.ok(text.includes('没删'), '坏文件是挪开不是删掉，这句必须说（否则读者以为丢了）')

  // 分类 / 设置这两份也要各自说得出人话；认不出来的文件名不能把提示整条拖没。
  assert.ok(quarantineNoticeText([{ base: 'categories.json', file: 'categories.json.corrupt-x' }]).includes('书架分类'))
  assert.ok(quarantineNoticeText([{ base: 'settings.json', file: 'settings.json.corrupt-x' }]).includes('插件设置'))
  assert.ok(quarantineNoticeText([{ base: '未知的东西.json', file: '未知的东西.json.corrupt-x' }]).includes('未知'))

  // ⚠️ **举例不许说假话**（2026-10-02 批 3：把提示原文打印出来才看见的假声明）：
  //    只坏了分类那份时，提示仍然说"绑定与阅读进度会显示成没读过"—— 读者会去查错的东西。
  const onlyCategory = quarantineNoticeText([{ base: 'categories.json', file: 'categories.json.corrupt-x' }])
  assert.doesNotMatch(
    onlyCategory,
    /阅读进度/,
    '⚠️ 没坏 bindings 就不许说"阅读进度会显示成没读过"（假声明比不说更坏）',
  )
  assert.ok(onlyCategory.includes('不会自己恢复'), '不给例子也要如实说"重置过、不会自己恢复"')

  const both = quarantineNoticeText([
    { base: 'bindings.json', file: 'bindings.json.corrupt-a' },
    { base: 'categories.json', file: 'categories.json.corrupt-b' },
  ])
  assert.ok(both.includes('bindings.json.corrupt-a') && both.includes('categories.json.corrupt-b'), '多份要都列出来')
})

// ⚠️ 原来这里有一条「接线守卫：书架真的把 `/health.quarantined` 显示出来了」的
//    **源码文本**钉子（比 `source.indexOf` 的两个位置），2026-10-03 删掉了 ——
//    它钉的事已由 `client-runtime.test.mjs` 覆盖：真的渲染书架、真的让 effect 取
//    `/health`、断言坏文件名出现在**渲染树**里，且排在书列表**之前**。
//    理由见 `docs/design-history.md` 的 v3.9。

test('收件箱路径：以宿主答复为唯一权威，配置改了要跟着变', async () => {
  const { resolveInboxPath } = await internals()

  // ① 宿主解析好的那个是唯一权威（`/health` 的 inboxDir）。
  assert.equal(resolveInboxPath({ storageDir: 'C:\\x', inboxDir: 'D:\\收件箱' }), 'D:\\收件箱')
  // ② 老宿主（没有 inboxDir）时回落，但**至少跟着 config 走**，不再永远写死 'inbox'。
  assert.equal(
    resolveInboxPath({ storageDir: 'C:\\x', config: { inboxDir: 'books-in' } }),
    'C:\\x\\books-in',
  )
  // ③ 分隔符跟着 storageDir 走（POSIX 上写死反斜杠，显示就是错的）。
  assert.equal(resolveInboxPath({ storageDir: '/home/x/.dsh/rc' }), '/home/x/.dsh/rc/inbox')
  // ④ 什么都拿不到 → null。界面据此不显示这一块，而不是显示一个假路径。
  assert.equal(resolveInboxPath(null), null)
  assert.equal(resolveInboxPath({}), null)
})

test('打开文件夹：靠清单挑应用，不靠平台判断', async () => {
  const { pickFileManagerApp, FILE_MANAGER_APP_IDS } = await internals()

  assert.deepEqual([...FILE_MANAGER_APP_IDS], ['explorer', 'finder', 'filemanager'])
  assert.equal(pickFileManagerApp(['vscode', 'explorer', 'finder']), 'explorer', '优先 explorer')
  assert.equal(pickFileManagerApp(['finder']), 'finder')
  assert.equal(pickFileManagerApp(['filemanager', 'code']), 'filemanager')
  // 候选一个都没有 / 形状不对 → null：调用方据此**明说**，而不是让按钮点下去没反应。
  assert.equal(pickFileManagerApp(['vscode', 'terminal']), null)
  assert.equal(pickFileManagerApp(null), null)
  assert.equal(pickFileManagerApp('explorer'), null)
})

test('导入结果文案：归档了要说，没归档不许说', async () => {
  const { importOutcomeText } = await internals()
  const book = { title: '夜行', chapterCount: 3 }

  assert.equal(importOutcomeText({ book }), '已导入《夜行》· 3 章')
  assert.equal(
    importOutcomeText({ book, inboxMovedTo: 'C:\\x\\.imported\\夜行.txt' }),
    '已导入《夜行》· 3 章；收件箱里那份已移到 .imported/（没有删除）',
  )
  // 从别处导入（`inboxMovedTo` 是 null）时**不许**出现归档那句话 ——
  // 那是"声称一件没发生的事"。
  assert.ok(!importOutcomeText({ book, inboxMovedTo: null }).includes('.imported'))
  assert.equal(importOutcomeText({ book, deduped: true }), '《夜行》已在书架里（同一份文件）')
  // 响应缺字段也不许抛（界面不该因为一句话而白屏）。
  assert.equal(importOutcomeText({}), '已导入《这本书》· 0 章')
})

test('样式与模板：收件箱三颗动作排成一行（容器不许是 column）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 转不了：替身没有布局引擎 —— "这个容器是 row 还是 column"在渲染树上看不出来。
  // （"三颗属于**同一个容器**"那一半已由 `client-runtime-views.test.mjs` 用渲染树钉住。）
  //
  // ⚠️ 这条一度被我写成"竖排一列"（读者 2026-09-27 更正：他最初的意思只是把
  //    「扫描导入目录」提到另外两颗所在的那一行）。竖排会让整块**太占空间**。
  const cssAt = source.indexOf('.drc-import-actions {')
  assert.ok(cssAt > 0, '找不到 .drc-import-actions 的样式规则')
  const cssRule = source.slice(cssAt, source.indexOf('}', cssAt))
  assert.ok(!cssRule.includes('column'), '三颗按钮要在一行，不许竖排（读者明确否掉了竖排）')
})
test('样式与模板：选中高亮只改背景；阅读区补偿滚动条占位', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // ① 选中高亮**只设 background、不许设 color**：浏览器默认会给一层"反色"，我们再叠
  //    一层就等于两层颜色互相打架，在深浅主题切换时最容易失控（文字色交给主题）。
  const selAt = source.indexOf('.drc-root ::selection')
  assert.ok(selAt > 0, '找不到选中高亮的规则')
  const selRule = source.slice(selAt, source.indexOf('}', selAt))
  assert.ok(selRule.includes('background:'), '选中高亮要有背景色')
  assert.ok(!/(^|[^-])color:/.test(selRule), '选中高亮不许动文字颜色')

  // ② 阅读区：滚动那个 div 必须带上补偿类。`max-width: 36em; margin: 0 auto` 的居中
  //    是在**扣掉竖直滚动条之后**的宽度里做的，而滚动条只占右侧 —— 不补偿就会整体偏左
  //    （读者截图圈住左右两边，说的正是这个）。
  assert.ok(source.includes('scrollbar-gutter: stable both-edges'), '要有滚动条占位补偿')
  assert.ok(source.includes("'drc-body drc-body-reader'"), '阅读区的滚动容器要挂上补偿类')
  // 反过来也要钉：**只有**阅读区挂它。书架/目录/笔记是左对齐的，加左侧空槽会凭空多一块空白。
  assert.equal(
    (source.match(/drc-body drc-body-reader/g) ?? []).length,
    1,
    '只该有一处（阅读区）用这个类',
  )
})

test('样式与模板：按钮的面保持透明（宿主的 button-*-fill 是"浮起式白按钮"，不是我们这种描边小按钮）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 由来：v2.1.11 我把按钮的面接上了宿主的 `button-elevated-fill` —— 那一档在**浅色**下
  // 就是 `#fff`（它是给"浮起的白色按钮"用的另一个按钮物种），于是面板里那些描边式小按钮
  // 全成了白块，读者真机否掉："按钮的颜色变白了，这一部分不用改。"
  // 所以这条钉住的是**决定**，不是实现细节：要改它，得先想起这段理由。
  assert.ok(source.includes('--drc-raise: transparent'), '按钮的面要保持透明（读者否掉了白色按钮面）')
  assert.ok(
    !/--drc-raise:\s*var\(--dsw-alias-button-[a-z-]*fill/.test(source),
    '不许把按钮的面接回宿主的 button-*-fill（那是白色浮起按钮的面）',
  )
})

test('折叠：名字集合的规整函数对任何垃圾都不抛错，且默认是空集合', async () => {
  const mod = await loadClientModule()
  const { normalizeNameSet, toggleNameInSet, SHELF_COLLAPSED_KEY, CARDS_EXPANDED_KEY } = mod.__internals

  // ⚠️ 这个值会被用户手改、也可能被旧版本写成别的形状。读坏了必须回落成空集合，
  //    而不是让整个界面白屏 —— 所以下面每一种垃圾都断言同一个结果。
  for (const junk of [null, undefined, 0, '', {}, 'gl小说', [1, 2], [null], [[]], [{ a: 1 }]]) {
    assert.deepEqual(
      normalizeNameSet(junk),
      [],
      `${JSON.stringify(junk)} 应当被当作空集合`,
    )
  }
  // 正常值：去空白、去空串、去重，且保序。
  assert.deepEqual(
    normalizeNameSet(['  gl小说  ', '专业书', 'gl小说', '', '   ', 42]),
    ['gl小说', '专业书'],
  )

  // 切换：不在集合里 → 加进去；在集合里 → 拿出来。都要返回**新数组**（React 要新引用）。
  const base = ['专业书']
  const added = toggleNameInSet(base, 'gl小说')
  assert.deepEqual(added, ['专业书', 'gl小说'])
  assert.deepEqual(base, ['专业书'], '不许改原数组')
  assert.deepEqual(toggleNameInSet(added, '专业书'), ['gl小说'])
  // 传进来的集合本身是垃圾时，切换也该正常工作（等价于"从空集合开始"）。
  assert.deepEqual(toggleNameInSet(null, '专业书'), ['专业书'])
  // 人物卡的键形如 `分区/名字`：斜杠不能被规整弄丢，它就是靠这个区分同名主体。
  assert.deepEqual(toggleNameInSet([], '人物/竹纤'), ['人物/竹纤'])

  // ⚠️ **两个键都是契约**：改字符串 = 读者已经收起/展开的东西会自己翻回去。
  assert.equal(SHELF_COLLAPSED_KEY, 'drc:collapsed-categories')
  assert.equal(CARDS_EXPANDED_KEY, 'drc:expanded-cards')
  assert.notEqual(SHELF_COLLAPSED_KEY, CARDS_EXPANDED_KEY, '两处各存一份，否则会互相覆盖')
})

test('样式与模板：书架分类与人物卡的折叠标题仍带着 CSS 认得的类名', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 这两个类名唯一的作用是匹配 CSS 里那两条共用外观规则
  // （`.drc-cat-toggle, .drc-card-toggle { … }` / `…:hover { … }`，见 lib/client.js 的样式块）。
  // 运行时替身没有 DOM、也没有样式表 —— 搬过去只能断言"某个 prop 的值是这串字符"，
  // 反而比源码文本更弱，所以这一半留在原地。
  //
  // ⚠️ 这条守卫的**行为那一半**（点一下就收起/展开、名单写进 localStorage、跨会话记住、
  //    存储读写都抛错时不白屏）已由 `client-runtime-panel-ui.test.mjs` 覆盖；
  //    「卷的展开状态**不**持久化」也已在那里转成行为断言（展开一卷 ⇒ 持久层一个键都没写，
  //    且新会话的初始态与第一次逐项相同）。所以这里不再留任何理由注释钉子。
  assert.match(source, /className: 'drc-label drc-cat-toggle'/)
  assert.match(source, /className: 'drc-item-sub drc-card-toggle'/)
})
test('文本契约：宿主保留 /context 路由（摘掉的是面板入口，不是这个能力）', () => {
  const here = dirname(fileURLToPath(import.meta.url))

  // 能力仍在宿主侧：路由保留（测试与"需要时自己看"都用它）。
  // ⚠️ 这一条查的是 `lib/index.js` 的**路由表**，不是面板行为 —— 运行时渲染测试够不着它，
  //    所以必须留在源码文本上（"预览没画出来"与"面板不再调 /context"两半已由
  //    `client-runtime-panel-ui.test.mjs` 覆盖）。
  //
  // ⚠️ 这里**不**再钉"源码里不许出现预览块"（旧守卫那两条 `source.includes(...) === false`）：
  //    运行时断言钉的是"**没画出来**"，源码断言钉的是"**代码里根本没有**"——后者多出来的
  //    那一小块盲区（加回来但挂在某个新 state 后面、渲染不到）属于**死代码**，`lib/` 另有
  //    死代码扫描兜着；而为它留一条文本钉子正是这轮要治的东西。
  const server = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  assert.ok(
    server.includes("pattern: '/books/:bookId/context'"),
    '宿主路由必须保留 —— 摘掉的是面板入口，不是这个能力',
  )
})
test('样式与模板：提示条是浮动 toast（观感对标 lumina，长文不自动消失）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 观感规格取自 MilkFeng/lumina 的 ToastBubble / ToastService（MIT）：胶囊 + 毛玻璃 + 3 秒 + 点击即消。
  assert.match(source, /const TOAST_DWELL_MS = 3000/, '停留时长应当是 3 秒')
  assert.match(source, /border-radius: 999px/, '胶囊形状')
  assert.match(source, /backdrop-filter: blur\(16px\)/, '毛玻璃')
  // ⚠️ 长文不自动消失：`importOutcomeText()` 那类结果要留给人读，3 秒后消失等于丢信息。
  assert.match(source, /text\.length > TOAST_LONG_CHARS\) return undefined/, '长文不该被计时器收走')
  // 三处提示（书架 / 笔记 / 设置）共用同一个组件 —— 观感只有一份定义，旧的写死内联渲染一个都不剩。
  assert.equal(
    (source.match(/h\(Notice, \{ notice, onDismiss/g) ?? []).length,
    3,
    '三处提示都要走 Notice',
  )
  // 颜色走别名层（宿主墨色/底色互相顶替），不写死；面层也不靠阴影分层。
  assert.match(source, /--drc-toast-bg: var\(--dsw-alias-label-primary\)/)
  assert.match(source, /--drc-toast-fg: var\(--dsw-alias-bg-base\)/)
  assert.match(source, /\.drc-toast \{ box-shadow: none; \}/)
  // 减少动态偏好下不播进出场动画。
  assert.match(source, /prefers-reduced-motion: reduce[\s\S]{0,60}\.drc-toast \{ animation: none; \}/)

  // ⚠️ **导出结果不许走提示条**（读者 2026-10-01）：它好几行，而长文提示**不自动消失**
  //    ⇒ 读者实测把它当成"弹窗不会消失"的 bug ✗。它改在「导出到笔记库」那节**常驻**显示，
  //    成功绿、失败红，并记住**上次导出的时间**。
  assert.doesNotMatch(
    source,
    /\.then\(\(result\) => setNotice\(result\)\)/,
    '导出结果不该再塞进 notice',
  )
  assert.match(source, /drc-export-ok/, '成功要用绿色那一类')
  assert.match(source, /drc-export-fail/, '失败要用红色那一类')
  assert.match(source, /上次导出：/, '要说清"上次导出"是什么时候')
  assert.match(source, /--drc-ok: var\(--dsw-alias-state-success-primary/, '成功色要从宿主取，别写死')
})

test('样式与模板：界面文字默认不可选中（正文等例外）、边框粗细只有两种用途', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // ① 选中高亮的浓度是读者定下的：22% 他实测"偏淡/看不出"，现按 read-aware 的 34% 对齐。
  //    改这个数字之前先想起那次反馈（它是配色系列里唯一由读者亲自调过的浓度）。
  assert.ok(
    source.includes('var(--drc-select-seed) 34%, transparent'),
    '选中高亮的浓度应当是 34%（读者实测 22% 偏淡）',
  )

  // ② chrome 的文字不可选中（像原生应用那样），而**正文必须留在例外里** ——
  //    选不中正文，「记笔记」的摘抄那条路就整条废掉（这是本仓库的核心流程）。
  const rootAt = source.indexOf('.drc-root {\n  display: flex')
  assert.ok(rootAt > 0, '找不到 .drc-root 的布局规则')
  const rootRule = source.slice(rootAt, source.indexOf('}', rootAt))
  assert.ok(rootRule.includes('user-select: none'), '界面文字默认应当不可选中')
  const exemptAt = source.indexOf('.drc-root input,')
  assert.ok(exemptAt > 0, '找不到"可选中文字"的例外清单')
  const exempt = source.slice(exemptAt, source.indexOf('user-select: text;', exemptAt))
  for (const selector of ['.drc-article', '.drc-quote', '.drc-thought', '.drc-reply', '.drc-pre']) {
    assert.ok(exempt.includes(selector), `${selector} 必须留在"可选中"里（它的内容是读者要拿去用的）`)
  }

  // ③ 边框只有两种用途：**盒子一律 `1px solid`**；`2px`/`3px` 只许出现在**强调竖条**
  //    （`border-left`）上 —— 那是另一种器件（摘抄引用、提示条、确认条），不是"更重的盒子边"。
  //    read-aware 全站只有一种 hairline；我们保留四档**深浅**，但**粗细**必须统一。
  const offenders = []
  for (const line of source.split('\n')) {
    if (line.includes('border-radius')) continue
    const declaration = /border(-[a-z]+)?:\s*([^;]+)/.exec(line)
    if (declaration === null || !declaration[2].includes('solid')) continue
    const width = /(\d+(?:\.\d+)?)px/.exec(declaration[2])
    if (width === null) continue
    const property = `border${declaration[1] ?? ''}`
    if (width[1] !== '1' && property !== 'border-left') {
      offenders.push(`${property}: ${width[1]}px — ${line.trim().slice(0, 60)}`)
    }
  }
  assert.deepEqual(offenders, [], '盒子边框只许 1px；2px/3px 只留给 border-left 强调竖条')
})

test('样式与模板：注释里不许出现反引号（它会把 CSS 的模板字符串提前结束）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // 这条守卫的由来（本仓库**第四次**同类事故）：CSS 住在一个模板字符串里，而注释里
  // 只要出现一个反引号，字面量就在那里**提前结束** —— 后半截样式变成 JS 表达式，
  // 报出来的是一个跟样式毫不相干的 `ReferenceError: xxx is not defined`（下一次是
  // 91 条用例一起红）。
  // ⚠️ `node --check` **挡不住它**：那种写法语法上完全合法，只有真的加载模块才会炸。
  // 所以这里用一个结构性断言来探测，而不是靠"下次小心点"。
  const OPEN = 'const CSS_TEXT = `'
  const open = source.indexOf(OPEN)
  assert.ok(open > 0, '找不到样式模板字符串')
  const close = source.indexOf('`', open + OPEN.length)
  assert.ok(close > 0, '样式模板字符串没有结束的反引号')
  const body = source.slice(open, close)

  // ① 结束的那个反引号必须**单独占一行**。插在注释里的反引号落在行中间，于是它会被
  //    当成结束符 —— 这条断言就是那个错误的探测器。
  assert.equal(source[close - 1], '\n', '样式字符串的结束反引号要单独占一行（注释里混进反引号了？）')
  // ② 抽出来的正文必须以一条规则的 `}` 收尾，否则说明它被提前截断了。
  assert.ok(body.trimEnd().endsWith('}'), `样式字符串似乎被截断了（只有 ${body.length} 字符）`)
})

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
    // 导入说明：一本"编码是猜的 + 有 warning"的书（折条会真的画出来），
    // 以及一本干净的（组件必须返回 null —— 不留空壳，这条也有专测）。
    ['ImportNotes（有说明）', internalsApi.ImportNotes, { book: { ...book, sourceName: '夜行.txt', encoding: 'gb18030', encodingConfidence: 'fallback', warnings: ['GB18030 解码出现 3.1% 替换字符，可能仍是乱码'] } }],
    ['ImportNotes（无事可交代）', internalsApi.ImportNotes, { book }],
    ['ImportNotes（没有书）', internalsApi.ImportNotes, {}],
    ['TocView（带导入说明）', internalsApi.TocView, { book: { ...book, sourceName: '夜行.txt', encoding: 'gb18030', encodingConfidence: 'heuristic' }, chapters, progress: null, loading: false, error: null, onBack: noop, onPick: noop, onOpenCompanion: noop, onOpenNotes: noop }],
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
  for (const key of ['ReaderPanel', 'ShelfView', 'TocView', 'ImportNotes', 'ReaderView', 'CompanionView', 'NotesView', 'NoteList', 'TopBar']) {
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

/**
 * 把渲染树**摊平成一条节点流**（真的执行函数组件），便于按 `className` / 文本找东西。
 *
 * 与 `renderTree` 的分工：那个只关心"跑通没有、覆盖到哪些组件"；这个要**看结果** ——
 * 例如"回收站那一支到底渲不渲染翻页行"。字符串守卫盯的是源码，这里盯的是渲染产物。
 *
 * @param {unknown} node 渲染树节点
 * @param {object[]} [out] 收集到的元素节点
 * @param {number} [depth] 防自引用
 * @returns {object[]} 元素节点流
 */
function flattenTree(node, out = [], depth = 0) {
  if (depth > 24 || node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) flattenTree(child, out, depth + 1)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    return flattenTree(node.type({ ...(node.props ?? {}), children: node.children }), out, depth + 1)
  }
  out.push(node)
  for (const child of node.children ?? []) flattenTree(child, out, depth + 1)
  return out
}

/** 把一条节点流里的文字全拼起来（用于"界面上到底写没写这句话"）。 */
function treeText(nodes) {
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return ''
    if (Array.isArray(node)) return node.map(walk).join('')
    if (typeof node !== 'object') return String(node)
    return (node.children ?? []).map(walk).join('')
  }
  return nodes.map((node) => (node.children ?? []).map(walk).join('')).join(' ')
}

const TRASH_NOTE_FIXTURE = {
  id: 'n1',
  heading: '第 31 章 一念',
  chapterIndex: 30,
  tags: [],
  excerpt: '念头转到这里',
  thought: '情动心热',
  reply: '',
  hasReply: false,
  trashed: true,
}

test('回收站列表：**不渲染**翻页行，笔记那边照旧（v1.62）', async () => {
  const { NoteList } = await internals()
  const base = {
    notes: [TRASH_NOTE_FIXTURE],
    total: 1,
    loading: false,
    page: 0,
    pageCount: 1,
    hasPrev: false,
    hasNext: false,
  }

  const trashNodes = flattenTree(NoteList({ ...base, mode: 'trash', onRestore() {}, onPurge() {} }))
  const trashText = treeText(trashNodes)
  // 回收站是一次取一批（`limit` 200）、根本没有分页，那行只会显示两颗禁用按钮，
  // 而「每页 10 条」与实际取回的条数矛盾 —— 数字说谎比没有更糟。
  assert.ok(!trashText.includes('每页'), '回收站里不该出现「每页 N 条」')
  assert.ok(!trashText.includes('更旧'), '回收站里不该有「更旧 →」')
  assert.ok(trashText.includes('恢复'), '该有的还得有：回收站里要能恢复')

  // 反向确认：不是把翻页行整个删了 —— 笔记那一支必须还在（否则是修错了对象）。
  const notesText = treeText(flattenTree(NoteList({ ...base, onPrev() {}, onNext() {} })))
  assert.ok(notesText.includes('每页'), '笔记那边必须仍然有翻页行')
})

test('分页选项卡：容器是 .drc-tabs、选中项带 aria-pressed、计数为 0 时淡一点（v1.62）', async () => {
  const { NotesView } = await internals()
  const nodes = flattenTree(rootNode(NotesView, {
    book: { bookId: '0123456789abcdef', title: '夜行', strategy: 'heading-regex', chapterCount: 3 },
    sessionId: 'session-abc',
    activeDraft: null,
    onBack: () => {},
  }))

  const tabs = nodes.filter((node) => node.props?.className === 'drc-tabs')
  assert.equal(tabs.length, 1, 'tab 行要用 `.drc-tabs`（它自带左右内边距，裸 `.drc-row` 会左 6px）')

  const tabButtons = nodes.filter((node) => node.type === 'button'
    && Object.prototype.hasOwnProperty.call(node.props ?? {}, 'aria-pressed'))
  assert.equal(tabButtons.length, 3, '三颗 tab 都要带 aria-pressed（选中态刻意不加粗，光靠颜色不够）')
  assert.equal(
    tabButtons.filter((button) => button.props['aria-pressed'] === true).length,
    1,
    '同一时刻只该有一个 tab 是"当前选中"',
  )
  // 计数为 0 的那几颗要淡一点（初始状态下草稿与回收站都是 0）。
  const numbers = nodes.filter((node) => String(node.props?.className ?? '').includes('drc-tab-num-zero'))
  assert.ok(numbers.length >= 1, '计数为 0 的 tab 要带 drc-tab-num-zero')
})

// ⚠️ 原来这里有一条「笔记翻页：上一页/下一页真的接上了（静态接线）」的**源码文本**
//    钉子（钉 `const [cursors, setCursors] = useState([null])`、`[...cursors, pageNext]`、
//    `onNext: goNextPage` 这几句），2026-10-03 删掉了 —— 它钉的事已由
//    `client-runtime.test.mjs` 覆盖：真的进笔记页、真的点底部那颗「更旧 →」按钮，
//    断言第二次 `/notes` 请求带上了宿主给的 `nextCursor`，且列表是**替换**不是追加。
//    ⚠️ 那三条"追加式分页不许回来"的反向断言也随之删除；它们的**行为**内核
//    （翻页 = 替换）由新用例的"不该还看得见上一页那条"承担。
//    理由见 `docs/design-history.md` 的 v3.9。

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

  // 纸感：0–30 的整数，越界夹住，非数值回 0（"一个字节都不加"）。
  const { PAPER_MAX } = await internals()
  assert.equal(PAPER_MAX, 30)
  assert.equal(clampFontPrefs({}).paper, 0)
  assert.equal(clampFontPrefs({ paper: 999 }).paper, 30)
  assert.equal(clampFontPrefs({ paper: -5 }).paper, 0)
  assert.equal(clampFontPrefs({ paper: 'abc' }).paper, 0)
  assert.equal(clampFontPrefs({ paper: Number.NaN }).paper, 0)
  assert.equal(clampFontPrefs({ paper: 12.6 }).paper, 13)
})

test('纸感：0 时**一个字节都不加**（空样式对象），非 0 时才由宿主现值现算', async () => {
  const { paperStyleOf } = await internals()

  // ⚠️ 这条是"不打架"的可证伪定义：关掉它时，内联样式与"没有这个功能"**逐元素相同**。
  //    所以 0 必须返回**空对象**，而不是返回一个 background: 之类的等价值。
  assert.deepEqual(paperStyleOf({ paper: 0 }), {})
  assert.deepEqual(paperStyleOf({}), {})
  assert.deepEqual(paperStyleOf({ paper: -5 }), {})
  assert.deepEqual(paperStyleOf(null), {})

  // 打开时：掺进去的是宿主 bg-base 的**现值**（经我们自己的别名），只贡献比例；
  // 暖色那一半来自 --drc-paper（浅色奶油 / 深色暖炭，由 CSS 分极性）——
  // 所以这里**不许**出现任何写死的颜色，也不许直接引用宿主 token（别名层才声明借用）。
  const style = paperStyleOf({ paper: 20 })
  assert.equal(style.background, 'color-mix(in oklab, var(--drc-paper-base) 80%, var(--drc-paper))')
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(style.background), '纸感里不许写死颜色')
  assert.ok(!/--dsw-/.test(style.background), '纸感只许引用我们自己的别名（借用清单在别名层）')

  // 上限与边界：30% 就是最浓。
  assert.equal(paperStyleOf({ paper: 30 }).background.includes(' 70%,'), true)
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
    assert.deepEqual(loadFontPrefs(), { size: 22, lineHeight: 2.2, family: 'kai', paper: 0 })
    assert.ok(store.has(FONT_PREFS_KEY))

    // 存里是坏 JSON → 回默认，而不是把阅读界面打崩。
    store.set(FONT_PREFS_KEY, '{ 这不是 JSON')
    assert.deepEqual(loadFontPrefs(), DEFAULT_FONT_PREFS)

    // 存里是合法 JSON 但字段离谱 → 夹住。
    store.set(FONT_PREFS_KEY, JSON.stringify({ size: 999, lineHeight: -1, family: 'zzz' }))
    assert.deepEqual(loadFontPrefs(), { size: 30, lineHeight: 1.2, family: DEFAULT_FONT_PREFS.family, paper: 0 })
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

// ⚠️ 原来这里有一条「面板：书友设定与讨论历史都在 CompanionView 里真的渲染出来」的
//    **源码文本**钉子（`source.includes('讨论历史')` 等四个词 + 一条 persona 路由正则），
//    2026-10-03 删掉了 —— 它钉的事已由 `client-runtime.test.mjs` 覆盖：真的渲染面板、
//    断言四个区块都出现在**渲染树**里，且设定真的从 `/books/<id>/persona` 取回来。
//    理由见 `docs/design-history.md` 的 v3.9。

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

test('文本契约：视图记忆：进笔记页的入口数必须等于记账处数', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  // 为什么这部分转不了：这是一条**计数不变式**，防的是"将来多出一个进笔记页的入口
  // 却忘了记账"——运行时用例只能把**已知的三个**入口各走一遍
  // （见 test/client-runtime-nav.test.mjs 的前三条），拦不住第四个入口。
  // `epochs == entries` 那半同理；而且 test/helpers/hooks-runtime.mjs 不实现 `key`，
  // "换编辑世代 ⇒ 重挂 ⇒ 重读初值"在这个运行时里根本观察不到。
  const entries = (source.match(/^\s*setView\('notes'\)/gm) ?? []).length
  const origins = (source.match(/noteOriginRef\.current = '(?:reader|toc)'/g) ?? []).length
  assert.ok(entries > 0, '找不到进笔记页的入口 —— 断言的锚点已经失效了')
  assert.equal(
    origins,
    entries,
    `进笔记页的入口有 ${entries} 个，但只有 ${origins} 处记了来源：跳过去会落错页`,
  )
  const epochs = (source.match(/setNoteEpoch\(\(epoch\) => epoch \+ 1\)/g) ?? []).length
  assert.equal(
    epochs,
    entries,
    `进笔记页的入口有 ${entries} 个，但只有 ${epochs} 处换了编辑世代（NotesView 的 key 不会变）`,
  )
})
test('文本契约：视图记忆：还原那一帧的接线（组件内逻辑，渲染不出来）', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  // 为什么这一条转不了：`restoreRef` 算的是**同一个表达式**，而落点 effect 会在同一次
  // 提交里把视图纠正回去 —— 这一处只决定"第一帧闪一下"，hooks 运行时**不暴露中间帧**。
  // 可观察的那一处（`restoreRef` 里的同一个表达式）已由 test/client-runtime-nav.test.mjs
  // 的「记忆里是『笔记页但没有草稿』」覆盖：去掉 `boot?.draft` ⇒ 那条用例红。
  assert.match(
    source,
    /useState\(\(\) => resolveRestoreView\(boot\?\.view, boot\?\.draft\)\)/,
    '初始落点要连着草稿一起算，否则笔记页还原不出来',
  )
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

test('文本契约：正文页的每个 prop 都得从面板传下去（漏传是静默失效）', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  // 行为用例只钉得住"今天枚举出来的那几条路"（点击 / 选中 / 滚动）。这条静态比对的价值
  // 在**将来新增的 prop** 上 —— 加进 ReaderView 的解构却忘了从 ReaderPanel 传，
  // 渲染层不会报错，只会安静地什么都不做（真机反馈过的那颗「笔记」按钮就是它）。
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

test('样式与模板：章节标题必须跟着正文字号缩放，不能写死 px', () => {
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

// ⚠️ 原来这里有一条「位置恢复：effect 必须依赖 paragraphs，且不许退回一次性旗标」的
//    源码正则钉子（正则抠出依赖数组再查 `paragraphs` / `initialOffset`），2026-10-03
//    删掉了 —— 它钉的事已由 `client-runtime.test.mjs` **直接观察**：正文没到时不许落位、
//    正文到达那一趟必须落位一次、依赖没变不重复落位、换章要重新落位。
//    （退回一次性布尔旗标就会卡在第一步：挂载时置旗，数据到达时被挡 ⇒ 永不恢复。）
//    理由见 `docs/design-history.md` 的 v3.9。

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
