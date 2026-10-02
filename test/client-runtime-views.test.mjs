/**
 * 浏览器半边的**运行时行为**（第二批，2026-10-03，B 档）。
 *
 * ## 这个文件取代了什么
 *
 * `client.test.mjs` 里那 43 条"接线守卫"钉的是 `source.includes('...')` —— 读源码
 * 文本再断言某一行还在。它们脆在两头：
 *   · **假红**：改注释、换行、重命名局部变量都可能让它红；
 *   · **假绿**：真正接错线（数据没接住、回调没接上、挂错位置）时它未必红。
 *
 * 这个文件把其中 4 条**逐条换成行为断言**：用 `test/helpers/hooks-runtime.mjs`
 * 真的渲染、真的跑 effect、真的点按钮。范式与 `test/client-runtime.test.mjs` 一致
 * （那个文件是模板，装置说明见它开头）。
 *
 * ## 每条用例都写清了"改坏什么它会红"
 *
 * 这是本仓库的教训：**假红比不测更坏**。所以每条用例的注释里都有一段
 * 「证伪」，指名道姓说删掉/改错哪一行它就红。
 *
 * ## 刻意**没**搬的东西
 *
 * 样式与模板类的文本断言（`.drc-confirm { … }` 这条 CSS 规则、`.drc-import-actions`
 * 是不是 `flex-direction: row`）**不搬**：这套替身刻意没有 DOM / CSSOM / 布局引擎，
 * 搬过来只能把断言变弱（见文件末尾的「没转过来的部分」）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule } from './helpers/client-loader.mjs'
import { createHooks, findNode, findText, makeFetch, treeText } from './helpers/hooks-runtime.mjs'

/** 造一个"能真跑"的客户端模块 + 渲染器。 */
async function runtime() {
  const hooks = createHooks()
  const mod = await loadClientModule(hooks.react)
  return { ...hooks, internals: mod.__internals }
}

/** 等 effect 里的 Promise 链跑完（微任务清空），再收敛一次渲染。 */
async function settle(hooks) {
  await new Promise((resolve) => setImmediate(resolve))
  return hooks.act()
}

/** 在调用期间替换 `globalThis.fetch`（客户端只走全局 fetch）。 */
async function withFetch(fetchStub, fn) {
  const original = globalThis.fetch
  globalThis.fetch = fetchStub
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * 在调用期间装一个**会抛错**的假 `window.confirm`。
 *
 * 这是"不许再用浏览器原生确认框"这条**反向守卫**的行为形态：只要被测代码在任何
 * 一步退回 `window.confirm(...)`，用例当场炸，而不是等读者在真机上被弹框。
 *
 * ⚠️ 必须在 `runtime()` **之后**装：载入器自己要用 `globalThis.window.__ModuleLoader__`
 *    注册 factory，装完会把它删掉。
 */
async function withThrowingConfirm(fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      confirm() {
        throw new Error('调用了浏览器原生确认框（window.confirm）—— 二级确认必须走站内 confirmBar')
      },
    },
  })
  try {
    return await fn()
  } finally {
    if (original === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', original)
  }
}

/** 在调用期间装一份假剪贴板（`copyText` 只走 `navigator.clipboard`）。 */
async function withClipboard(clipboard, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard } })
  try {
    return await fn()
  } finally {
    if (original === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', original)
  }
}

const BOOK = { bookId: '0123456789abcdef', title: '夜行', strategy: 'heading-regex', chapterCount: 2 }

/** 正文页要的那些路由。`chapterText` 决定段落切出来是什么。 */
function readerRoutes({ chapterText, chapterNotes = [] }) {
  return [
    ['/chapters/', { body: { ok: true, chapter: { index: 0, title: '第一章 雪', text: chapterText } } }],
    ['/notes/chapter/', { body: { ok: true, notes: chapterNotes } }],
    ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 } } }],
  ]
}

function readerProps(extra = {}) {
  return {
    book: BOOK,
    chapters: [
      { index: 0, title: '第一章 雪', length: 100, volume: null, kind: 'chapter' },
      { index: 1, title: '第二章 雨', length: 100, volume: null, kind: 'chapter' },
    ],
    chapterIndex: 0,
    initialOffset: 0,
    onBack: () => {},
    onNavigate: () => {},
    onOpenCompanion: () => {},
    onOpenNotes: () => {},
    onCaptureNote: () => {},
    ...extra,
  }
}

/**
 * 陪读面板（`CompanionView`）要的那些路由。
 *
 * ⚠️ `/finished` 的答复**回显请求里的值** —— 宿主本来就是这样（返回真正生效的那个
 * 状态）。写死 `finished: false` 的话，"解锁"那一趟会被服务端答复打回未解锁，
 * 用例就成了在测夹具而不是在测代码。
 */
function companionRoutes({ finished }) {
  return [
    ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 }, binding: { sessionId: 'session-abc' } } }],
    ['/background', {
      body: {
        ok: true, covered: { first: 1, last: 2 }, gap: null, characters: [], markdown: '',
        exists: true, finished, webGate: 'block-all',
      },
    }],
    ['/persona', { body: { ok: true, text: '' } }],
    ['/discussions', { body: { ok: true, discussions: [] } }],
    ['/settings', { body: { ok: true, config: {} } }],
    ['/finished', (url, options) => new Response(
      JSON.stringify({ ok: true, finished: JSON.parse(options.body).finished }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )],
  ]
}

/** 笔记页（`NotesView`）要的那些路由：首屏三样 + 回收站 + 清空。 */
function notesRoutes() {
  const trashed = {
    id: 't1', chapterIndex: 0, heading: '第 1 章 雪', excerpt: '删掉的那条', thought: '',
    reply: '', tags: [], hasReply: false, trashed: true,
  }
  return [
    ['/drafts', { body: { ok: true, drafts: [] } }],
    ['/location', { body: { ok: true, location: null } }],
    ['/notes?trashed=1', { body: { ok: true, notes: [trashed], total: 1 } }],
    ['/notes/purge', { body: { ok: true, purged: { removed: 1, backupPath: '' } } }],
    ['/notes?limit=', { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } }],
  ]
}

/** 树里有没有那条站内确认条（`.drc-confirm`）。 */
const confirmBars = (tree) => {
  const found = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node.props?.className === 'drc-confirm') found.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return found
}

//#region 取代「接线守卫：正文页角标点一下就跳（同章内跳转必须走一次性请求）」

test('正文页角标：点一下就滚到那一段，连点同一条也再滚一趟（同章内跳转走一次性请求，不被位置账本吞掉）', async () => {
  // 取代 `client.test.mjs` 的「接线守卫：正文页角标点一下就跳（同章内跳转必须走一次性
  // 请求）」。原来那三条断言是 `source.includes('jumpToNote')` /
  // `source.includes('setJumpRequest(')` / `source.includes('setJumpRequest(null)')` ——
  // 它们问的是"这几句代码还在不在"，而这里问的是"**点了之后视口真的动了吗**"。
  //
  // ## 为什么"一次性请求"这条性质必须用行为钉
  //
  // 同章内的位置恢复被账本键挡着（`positionKey` / `shouldRestorePosition` 刻意让
  // 同一章只滚一次）。角标列的**永远是当前这一章**的笔记 ⇒ 跳转不能走那条路，
  // 只能落成"一次性请求"（每次点击都是新对象）。这条性质的可观测形态就是：
  // **同一条连点两次，视口要滚两次**。退化成走位置账本的话，第二次会被吞掉。
  //
  // ## 证伪
  //   · 把 `onClick: () => jumpToNote(note)`（`lib/client.js` 角标那一行的 `li`）删掉
  //     ⇒ 点了没反应 ⇒ "必须滚到那一段"那条红；
  //   · 把 `jumpToNote` 里的 `setJumpRequest({ offset })` 换成"走位置账本"的写法
  //     （例如只 `setProgress`/`setInitialOffset`）⇒ 第二次点击被账本吞掉
  //     ⇒ "连点同一条也要再滚一趟"那条红；
  //   · 把取正文 effect 里的 `setJumpRequest(null)` 删掉 ⇒ 换章那一趟会拿**旧偏移**
  //     去滚新章 ⇒ "换章不许再拿旧偏移去滚"那条红。
  const { react, render, act, internals, hostProto } = await runtime()
  const chapterText = '第一段文字。\n\n第二段文字。\n\n第三段文字。'
  const paragraphs = internals.buildParagraphs(chapterText)
  assert.equal(paragraphs.length, 3, '夹具本身要站得住')
  assert.ok(paragraphs[1].offset > 0, '夹具：第 2 段的偏移要为正，否则"跳到这一段"会退化成"整章"')

  // 观察"组件往滚动容器上写了什么"。宿主节点共享一个原型，所以 accessor 对
  // **每一轮**渲染出来的节点都生效（见 hooks-runtime 里 hostProto 的说明）。
  const writes = []
  let scrollTop = -1
  Object.defineProperty(hostProto, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => { scrollTop = value; writes.push(value) },
  })
  // 段落节点的 `offsetTop` 是真实布局给的 —— 替身里让"那一段自己的章内偏移"当它的
  // 位置，于是"到底滚到了哪一段"变成可断言的事（而不是只能断言"滚过"）。
  Object.defineProperty(hostProto, 'offsetTop', {
    configurable: true,
    get() { return Number(this.props?.['data-off'] ?? 0) },
  })

  const note = {
    id: 'n1', chapterIndex: 0, heading: '第一章 雪', excerpt: '第二段文字。',
    charOffset: paragraphs[1].offset, thought: '', tags: [], hasReply: false,
  }
  const { fetch } = makeFetch(readerRoutes({ chapterText, chapterNotes: [note] }))

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.ReaderView, readerProps()))
    tree = await settle({ act })
    assert.deepEqual(writes, [0], `夹具：初始位置在第 1 段 ⇒ 先落位到 0：${JSON.stringify(writes)}`)

    const toggle = findText(tree, '本章你记过 1 条')
    assert.ok(toggle !== null, `正文页该有「本章你记过」的入口：${treeText(tree).slice(0, 300)}`)
    tree = act(() => toggle.props.onClick())

    const item = findNode(tree, (node) => node.props?.title === '跳到这一段')
    assert.ok(item !== null, `展开后每条笔记都要有「跳到这一段」：${treeText(tree).slice(0, 300)}`)
    assert.equal(typeof item.props.onClick, 'function', '角标每一条必须可点 —— 点了才跳')

    act(() => item.props.onClick())
    assert.equal(
      writes[writes.length - 1],
      paragraphs[1].offset,
      `点一下必须滚到那一条记的那一段上：${JSON.stringify(writes)}`,
    )

    // ⚠️ 这条是"一次性请求"的全部：同一条**连点两次**，视口要再滚一趟。
    const before = writes.length
    act(() => item.props.onClick())
    assert.equal(
      writes.length,
      before + 1,
      '连点同一条也要再滚一趟（一次性请求每次都是新对象；被位置账本吞掉就会少一次）',
    )

    // ⚠️ 换章必须清掉跳转请求：否则它会拿**旧偏移**去滚新章（表现是"翻到下一章
    //    就自己跳到半空"）。清掉之后，换章那一趟只该有"落回章首"这一次写入。
    const mark = writes.length
    render(react.createElement(internals.ReaderView, readerProps({ chapterIndex: 1, initialOffset: 0 })))
    await settle({ act })
    const afterChapterChange = writes.slice(mark)
    assert.ok(
      !afterChapterChange.includes(paragraphs[1].offset),
      `换章后不许再拿旧偏移去滚：${JSON.stringify(afterChapterChange)}`,
    )
    assert.deepEqual(afterChapterChange, [0], `换章只该落回章首一次：${JSON.stringify(afterChapterChange)}`)
  })
})

//#endregion

//#region 取代「接线守卫：解锁在**面板**侧常驻可见、收回一键即时，以及正文页那个 prop 的来源」

test('面板侧解锁：常驻横幅、收回一键即时，以及正文页那个 finished 确实来自 book', async () => {
  // 取代 `client.test.mjs` 的「接线守卫：解锁在**面板**侧常驻可见、收回一键即时，
  // 以及正文页那个 prop 的来源」。那条守卫的存在理由本身就是"渲染层不认识哪个
  // prop 忘了传，漏了只是**安静地不显示**"—— 所以它最该用行为钉，而不是读源码。
  //
  // 两半：
  //   ① `finished: book?.finished === true` —— 面板必须把**书**上的解锁状态传给正文页；
  //   ② `background?.finished === true` —— 面板自己的常驻横幅 + 收回一键即时。
  //
  // ## 证伪
  //   · 把 `finished: book?.finished === true` 改成从 `background` 取 ⇒ ReaderPanel
  //     作用域里没有 `background`，当场 ReferenceError ⇒ 红；
  //   · 把那一行整行删掉 ⇒ 正文页收不到 `finished` ⇒ 徽章不出现 ⇒ 红；
  //   · 把 `background?.finished === true` 的横幅条件写反 / 删掉横幅那个 `drc-label`
  //     ⇒ "常驻可见"那条红；
  //   · 把「收回解锁」按钮的 `onClick: () => saveFinished(false)` 改成先
  //     `setFinishConfirm(true)` ⇒ "一键即时"那条红（点了之后没有立刻落盘）。

  // ---- ① 正文页那个 prop 的来源：真的把面板跑起来，从**书**上取 ----
  const readerSide = await runtime()
  const finishedBook = { ...BOOK, finished: true, progress: null }
  // 会话视图记忆是**模块级**的（切会话会卸载面板，"上次在读什么"只能从这里取回来）。
  // 播下种子 ⇒ 面板重挂时直接落在正文页，而不是书架。
  readerSide.internals.rememberSessionView(readerSide.internals.sessionViews, 'session-abc', {
    view: 'reader',
    book: finishedBook,
  })
  {
    const { fetch } = makeFetch([
      ['/chapters/', { body: { ok: true, chapter: { index: 0, title: '第一章 雪', text: '第一段文字。\n\n第二段文字。' } } }],
      ['/chapters', { body: { ok: true, chapters: [{ index: 0, title: '第一章 雪', length: 100, volume: null, kind: 'chapter' }] } }],
      ['/notes/chapter/', { body: { ok: true, notes: [] } }],
      ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 } } }],
    ])
    await withFetch(fetch, async () => {
      readerSide.render(readerSide.react.createElement(readerSide.internals.ReaderPanel, { sessionId: 'session-abc' }))
      const tree = await settle(readerSide)
      assert.ok(
        findText(tree, '⚠️ 已解锁全书') !== null,
        `ReaderPanel 必须把 book.finished 传给正文页（从 book 上取）：${treeText(tree).slice(0, 400)}`,
      )
    })
  }

  // ---- ② 面板侧：常驻横幅 + 收回一键即时 ----
  const panelSide = await runtime()
  const { fetch, calls } = makeFetch(companionRoutes({ finished: true }))
  const finishedCalls = () => calls.filter((call) => call.url.includes('/finished'))

  await withFetch(fetch, async () => {
    let tree = panelSide.render(panelSide.react.createElement(panelSide.internals.CompanionView, {
      book: BOOK, sessionId: 'session-abc', onBack: () => {},
    }))
    tree = await settle(panelSide)

    assert.ok(
      treeText(tree).includes('⚠️ 已解锁：这本书的全文对陪读 AI 可见'),
      `解锁状态必须**常驻**在面板上（不能只体现在按钮文案里）：${treeText(tree).slice(0, 400)}`,
    )
    assert.equal(finishedCalls().length, 0, '夹具：还没点任何东西')

    const withdraw = findText(tree, '收回解锁')
    assert.ok(withdraw !== null, `解锁之后面板上要有「收回解锁」：${treeText(tree).slice(0, 400)}`)
    tree = panelSide.act(() => withdraw.props.onClick())

    // ⚠️ 不对称原则：**收紧安全不需要摩擦** ⇒ 收回必须一键即时落盘。
    assert.equal(finishedCalls().length, 1, '⚠️ 收回必须**一键即时**落盘（不许再插一道确认）')
    assert.equal(JSON.parse(finishedCalls()[0].options.body).finished, false, '收回落盘的必须是 false')
    assert.deepEqual(confirmBars(tree), [], '收回不许弹确认条')

    tree = await settle(panelSide)
    assert.ok(!treeText(tree).includes('⚠️ 已解锁：'), '收回之后横幅要立刻消失（界面是读者判断状态的唯一依据）')
  })
})

//#endregion

//#region 取代「接线守卫：二级确认统一走 confirmBar（不许再出现浏览器原生确认框）」

test('二级确认统一走 confirmBar：解锁与清空回收站都走站内确认条，全程不碰浏览器原生确认框', async () => {
  // 取代 `client.test.mjs` 的「接线守卫：二级确认统一走 confirmBar（不许再出现浏览器
  // 原生确认框）」。原来那五条里，四条是读源码：
  //   `!/window\.confirm\(/`（全文件不许出现原生确认框）、
  //   `source.includes('function confirmBar(')`、`source.includes("className: 'drc-confirm'")`、
  //   `assert.match(source, /confirmBar\(\{/)`。
  //
  // 这里装一个**会抛错**的假 `window.confirm`，然后把两处确认**真的点一遍**：
  // 任何一步退回原生确认框，用例当场炸。这比"源码里搜不到那个词"强的地方在于 ——
  // 它同时证明**确认条真的出现在界面上、真的拦在落盘之前**。
  //
  // ## 证伪
  //   · 把解锁那支从 `confirmBar({...})` 改回 `window.confirm(...)` ⇒ 假 confirm 抛错 ⇒ 红；
  //   · 把 `h('div', { className: 'drc-confirm' }, ...)` 的类名改掉（或自己拼一个类）
  //     ⇒ "确认条要用 .drc-confirm 这个类"那条红；
  //   · 把「标记为已读完」的 `onClick` 直接接到 `saveFinished(true)`（跳过确认条）
  //     ⇒ "还没确认就不许落盘"那条红；
  //   · 把清空回收站的 `onClick: () => setPurgeTarget('all')` 直接接到 `runPurge('all')`
  //     ⇒ "还没确认就不许动笔记文件"那条红。

  // ---- ① 解锁「已读完」：先出确认条，确认之后才落盘 ----
  const unlock = await runtime()
  {
    const { fetch, calls } = makeFetch(companionRoutes({ finished: false }))
    const finishedCalls = () => calls.filter((call) => call.url.includes('/finished'))
    await withFetch(fetch, () => withThrowingConfirm(async () => {
      let tree = unlock.render(unlock.react.createElement(unlock.internals.CompanionView, {
        book: BOOK, sessionId: 'session-abc', onBack: () => {},
      }))
      tree = await settle(unlock)
      assert.ok(treeText(tree).includes('这本书读完了吗'), `夹具：这本书还没解锁：${treeText(tree).slice(0, 300)}`)

      const mark = findText(tree, '标记为已读完')
      assert.ok(mark !== null, `面板要有「标记为已读完」：${treeText(tree).slice(0, 300)}`)
      tree = unlock.act(() => mark.props.onClick())

      // ⚠️ 解锁是**放宽**约束（全插件唯一会放松那条硬规则的地方）⇒ 必须二次确认。
      const bars = confirmBars(tree)
      assert.equal(bars.length, 1, `解锁必须先出**一条**站内确认条（.drc-confirm）：${treeText(tree).slice(0, 400)}`)
      assert.ok(treeText(bars[0]).includes('确认这本书我已读完'), '确认条要说清点了会发生什么（按钮写动词）')
      assert.equal(finishedCalls().length, 0, '⚠️ 还没确认就不许落盘（确认条必须真的拦在前面）')

      const primary = findText(bars[0], '确认这本书我已读完')
      assert.ok(primary !== null, '确认条要有主按钮')
      unlock.act(() => primary.props.onClick())
      tree = await settle(unlock)

      assert.equal(finishedCalls().length, 1, '确认之后才落盘，而且只落一次')
      assert.equal(JSON.parse(finishedCalls()[0].options.body).finished, true, '落盘的必须是 true')
      assert.ok(
        treeText(tree).includes('⚠️ 已解锁：这本书的全文对陪读 AI 可见'),
        `解锁成功之后横幅要常驻：${treeText(tree).slice(0, 400)}`,
      )
    }))
  }

  // ---- ② 清空回收站：同一套形态（全插件唯一改笔记文件的一步）----
  const trash = await runtime()
  {
    const { fetch, calls } = makeFetch(notesRoutes())
    const purgeCalls = () => calls.filter((call) => call.url.includes('/notes/purge'))
    await withFetch(fetch, () => withThrowingConfirm(async () => {
      let tree = trash.render(trash.react.createElement(trash.internals.NotesView, {
        book: BOOK, sessionId: 'session-abc', activeDraft: null, onBack: () => {},
      }))
      tree = await settle(trash)

      const trashTab = findText(tree, '回收站')
      assert.ok(trashTab !== null, `笔记页要有「回收站」这个选项卡：${treeText(tree).slice(0, 400)}`)
      trash.act(() => trashTab.props.onClick())
      tree = await settle(trash)

      const clear = findText(tree, '清空回收站')
      assert.ok(clear !== null, `回收站非空时要能清空：${treeText(tree).slice(0, 400)}`)
      tree = trash.act(() => clear.props.onClick())

      const bars = confirmBars(tree)
      assert.equal(bars.length, 1, `清空回收站必须走**同一条**站内确认条：${treeText(tree).slice(0, 400)}`)
      assert.ok(treeText(bars[0]).includes('不可逆'), '要把后果说清（不可逆、会先备份）')
      assert.equal(purgeCalls().length, 0, '⚠️ 还没确认就不许动读者的笔记文件')

      const primary = findText(bars[0], '确认清空')
      assert.ok(primary !== null, '确认条要有主按钮')
      trash.act(() => primary.props.onClick())
      tree = await settle(trash)

      assert.equal(purgeCalls().length, 1, '确认之后才落盘')
      // ⚠️ 清空要传 `{ all: true }`：传"列表里看到的那几条的 id"只清得掉前 200 条。
      assert.deepEqual(JSON.parse(purgeCalls()[0].options.body), { all: true }, '清空必须传 all，而不是当前这一页的 id')
      assert.ok(treeText(tree).includes('已彻底删除'), `要如实回音：${treeText(tree).slice(0, 300)}`)
    }))
  }
})

//#endregion

//#region 取代「接线守卫：收件箱的两个新入口在，且路径不再自己拼」

test('收件箱：路径以宿主的答复为唯一权威（不自己拼），复制与打开目录两个入口真的能用', async () => {
  // 取代 `client.test.mjs` 的「接线守卫：收件箱的两个新入口在，且路径不再自己拼」。
  // 那条钉的是一个**真出过的形状**：面板从前写死 `${health.storageDir}\inbox`。
  // 它当时"碰巧对"，但只要有人让宿主认自己的 `inboxDir` 配置，面板立刻指向另一个
  // 目录 —— 读者照面板提示放书、然后「扫描」什么也没有。
  //
  // 所以这里让宿主回的 `inboxDir` 与 `storageDir\inbox` **是两个不同的目录**：
  // 界面显示哪个、复制走哪个、打开的是哪个，三个都直接可断言。
  //
  // ## 证伪
  //   · 把 `resolveInboxPath` 里的 `health.inboxDir` 那一支删掉（退回自己拼）
  //     ⇒ 界面上出现的是 `storageDir\inbox` ⇒ "不许自己拼"那条红；
  //   · 把「复制路径」按钮的 `onClick: () => doCopyInbox(inbox)` 删掉 ⇒ 点了没写剪贴板 ⇒ 红；
  //   · 把 `OPEN_IN_APP_OPEN_ROUTE` 的值改错一个字母 ⇒ 打开目录那一趟打不到
  //     `/open-in-app/open` ⇒ 红（所以那条断言用**精确 URL**，不用 `includes`）；
  //   · 把 `.imported/` 那句的 `className: 'drc-import-hint'` 改成 `drc-item-sub`
  //     ⇒ 那句会被单行省略号截掉 ⇒ "归档要说在可换行的样式里"那条红。
  const { react, render, act, internals } = await runtime()
  const storageDir = 'C:\\drc-data'
  const hostInbox = 'D:\\我的书\\收件箱'
  const { fetch, calls } = makeFetch([
    ['/library', { body: { ok: true, books: [] } }],
    ['/health', { body: { ok: true, storageDir, inboxDir: hostInbox, config: {}, quarantined: [] } }],
    ['/open-in-app/apps', { body: { ok: true, apps: ['explorer'] } }],
    ['/open-in-app/open', { body: { ok: true } }],
  ])

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.ShelfView, { onOpen: () => {} }))
    tree = await settle({ act })

    const text = treeText(tree)
    assert.ok(text.includes(hostInbox), `面板要显示宿主**真正在扫**的那个目录：${text.slice(0, 400)}`)
    assert.ok(
      !text.includes(storageDir),
      `不许自己拼收件箱路径（宿主的答复才是唯一权威）：${text.slice(0, 400)}`,
    )
    assert.ok(text.includes('.imported/'), '归档到哪了必须**事先**交代（否则读者以为文件被弄丢了）')

    // --- 两个新入口：三颗动作在同一个容器里（"排成一行"的 JS 那一半）---
    const actions = findNode(tree, (node) => node.props?.className === 'drc-import-actions')
    assert.ok(actions !== null, `找不到收件箱动作容器：${text.slice(0, 300)}`)
    const labels = actions.children.map((child) => treeText(child).trim())
    for (const label of ['复制路径', '打开导入目录', '扫描导入目录']) {
      assert.ok(labels.includes(label), `「${label}」要和另外两颗在同一个容器里：${labels.join(' | ')}`)
    }

    // --- 复制路径：真的把**宿主给的那个路径**写进剪贴板 ---
    const copied = []
    await withClipboard({ writeText: async (value) => { copied.push(value) } }, async () => {
      const copyButton = findText(tree, '复制路径')
      assert.ok(copyButton !== null, '要有「复制路径」按钮')
      tree = act(() => copyButton.props.onClick())
      // ⚠️ 复制结果是**异步回音**（`copyText(...).then(setNotice)`），所以要把
      //    `settle` 之后的那棵树接回来 —— 否则断言看的是"还没回音"的旧树。
      tree = await settle({ act })
    })
    assert.deepEqual(copied, [hostInbox], '复制的必须是宿主给的那个目录（不是自己拼的那个）')
    assert.ok(treeText(tree).includes('已复制收件箱路径'), `复制成功要如实回音：${treeText(tree).slice(0, 300)}`)

    // --- 打开导入目录：走宿主的 open-in-app 契约，而不是自己拼平台命令 ---
    const openButton = findText(tree, '打开导入目录')
    assert.ok(openButton !== null, '要有「打开导入目录」按钮')
    act(() => openButton.props.onClick())
    await settle({ act })
    // ⚠️ 这里刻意用**精确 URL**而不是 `includes`：路由常量写错一个字母
    //    （`/open-in-app/open-typo`）时 `includes('/open-in-app/open')` 仍然为真 ——
    //    实测过，那样这条断言就是假的。宿主契约就是这两条绝对路径（见
    //    `dsh-host-open-in-app` 的 `GET /open-in-app/apps` / `POST /open-in-app/open`）。
    assert.ok(
      calls.some((call) => call.url === '/open-in-app/apps'),
      `要先问宿主探到了哪些应用：${calls.map((call) => call.url).join(' | ')}`,
    )
    const opened = calls.filter((call) => call.url === '/open-in-app/open')
    assert.equal(opened.length, 1, `要真的去开目录：${calls.map((call) => call.url).join(' | ')}`)
    assert.equal(opened[0].options.method, 'POST', '开目录要 POST 给宿主')
    assert.deepEqual(
      JSON.parse(opened[0].options.body),
      { app: 'explorer', path: hostInbox },
      '开目录要带宿主探到的应用与**宿主给的那个路径**',
    )

    // --- 手动导入那条旁路：框与按钮都要在，而且说清自己是干什么的 ---
    const manual = findNode(
      tree,
      (node) => typeof node.props?.placeholder === 'string' && node.props.placeholder.includes('手动导入书籍路径：'),
    )
    assert.ok(manual !== null, '手动导入的输入框要写清这是什么（不能只给一个孤零零的路径样例）')
    assert.ok(findText(tree, '手动导入') !== null, '那颗按钮叫「手动导入」')

    // ⚠️ 归档那句必须挂在**可换行**的样式上：`.drc-item-sub` 是单行省略号，
    //    用它就会把"文件搬去哪"那半句截掉（真机截图里就是「…导入…」）。
    const hint = findNode(
      tree,
      (node) => node.props?.className === 'drc-import-hint' && treeText(node).includes('.imported/'),
    )
    assert.ok(
      hint !== null,
      '归档那句要挂在 .drc-import-hint 上（.drc-item-sub 是单行省略号，会把它截掉）',
    )
  })
})

//#endregion

/**
 * ## 没转过来的部分（刻意不转，理由在这里）
 *
 * 1. **`.drc-confirm { … }` 这条 CSS 规则**（原守卫第 5 条断言）。
 *    这套运行时刻意没有 DOM / CSSOM / 布局引擎（见 `hooks-runtime.mjs` 的「刻意
 *    不做的」），所以"这条样式规则长什么样"在运行时**看不见**。硬凑一条（例如把
 *    CSS 字符串从源码里抠出来正则匹配）只会把断言换成另一种源码文本钉子 ——
 *    正是这个文件要治的病。⇒ **留给源码/样式类断言**，不搬。
 *
 * 2. **`.drc-import-actions` 不许 `flex-direction: column`**（原守卫第 1299–1302 行）。
 *    同上：那是一条**布局**声明，"三颗按钮排成一行"在替身里没有排版可言。
 *    可以转的那一半（三颗在**同一个容器**里）已经在上面用渲染树钉住了；"这个容器
 *    是 row 不是 column"必须由样式断言负责。
 *
 * 3. **`!window\.confirm\(` 这条"全文件都不许出现"的反向守卫**，行为上只能覆盖
 *    **跑到过的路径**。上面已经真的跑过两处确认（解锁「已读完」、清空回收站），
 *    并装了会抛错的假 `confirm`。剩下的确认处 —— 丢弃草稿（`discardTarget`）、
 *    彻底删除单条（`purgeTarget`）、切换草稿（`switchTarget`）与跳读闸 ——
 *    **没有跑**：若有人只把 `window.confirm` 塞回那几处，这个文件不会红。
 *    完全覆盖需要把四处确认 + 跳读闸都驱动一遍，成本与收益不匹配；
 *    这里如实记下这个残留缺口，而不是假装已经覆盖。
 */
