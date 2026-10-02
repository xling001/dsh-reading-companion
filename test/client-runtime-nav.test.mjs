/**
 * 浏览器半边**导航接线**的运行时行为断言（B 档第二轮，2026-10-03）。
 *
 * ## 这个文件存在的理由
 *
 * `client-runtime.test.mjs` 已经证明"hooks 替身只取初值、不执行 effect，所以只能
 * 静态断言"这句话**不再成立**。这一轮把剩下四条同类守卫接着换掉：
 *
 *   1. `视图记忆：每个进笔记页的入口都要记下来源`
 *   2. `视图记忆：还原那一帧的接线（组件内逻辑，渲染不出来）`
 *   3. `跳读闸的界面接线：两个选项真的带上 mode，且主按钮不把点击事件当 mode`
 *   4. `跳读闸：边界跟着"读者正在看的那一章"走，而它只在两个主动动作里落盘`
 *
 * 这四条原来钉的都是**源码文本**（`source.includes(...)` / `assert.match(source, …)`），
 * 而它们描述的其实全是**运行时行为**：谁记下了来源、返回时落到哪一层、点了按钮发出
 * 什么请求体。这里把它们逐条换成"真的渲染、真的跑 effect、真的点按钮"。
 *
 * ## 一条**取代**一条
 *
 * 本文件里的每条用例都在注释里写明了它取代旧守卫的哪一半，以及**证伪方式**
 * （改坏哪一行它会红）。凡是被这里完整覆盖的源码文本钉子，都要在
 * `client.test.mjs` 里删掉（`design.md` 的删除铁律）。
 *
 * ## ⚠️ 三处**没能**转换的（理由写在各自的用例注释里）
 *
 *   · 「进笔记页必须换一次编辑世代（`setNoteEpoch` / `NotesView` 的 `key`）」：
 *     `hooks-runtime.mjs` **不实现 `key`** —— 实例按组件函数建键、跨视图切换一直
 *     留着，所以"key 变了 ⇒ 重挂 ⇒ 重读初值"这件事在这个运行时里**观察不到**。
 *     写一条"看编辑框里有没有新草稿"的断言只会得到一条**必红**的假守卫。
 *     （同理，"入口数 == 记账处数 == 世代处数"那条**计数**不变式也只能静态钉：
 *     它防的是**将来**多出一个入口却忘了记账，而用例只能把已知的三个入口各走一遍。）
 *   · 「主按钮不能写成 `onClick: fillBackground`（否则点击事件被当成 `mode`）」：
 *     `fillBackground` 自己会把非字面量归一化掉（`asked` 只认 `'all'` / `'recent'`），
 *     所以**只改这一行不会红**（事件对象传进去与不传行为完全一样）。实测：两处
 *     一起改（同时拿掉那层归一化）⇒ 两条用例都红；只改一行 ⇒ 只有"补齐中让位给
 *     停止"那条红。也就是说这条静态断言想防的失效模式**已经被生产代码自己的
 *     归一化防住了**，它剩下的可观察价值只有「补齐中让位给停止」那一半。
 *   · 「初始落点 `useState(() => resolveRestoreView(boot?.view, boot?.draft))` 要连着
 *     草稿一起算」：**单独**改坏这一处看不出来 —— `restoreRef` 算的是同一个表达式，
 *     而落点 effect 会在同一次提交里把视图纠正回去。它只影响"第一帧闪一下"，而本
 *     运行时**不暴露中间帧**。能证伪的是同一个表达式的另一处（`restoreRef`），
 *     由「记忆里是『笔记页但没有草稿』」那条用例负责。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule } from './helpers/client-loader.mjs'
import { createHooks, findNode, makeFetch, treeText } from './helpers/hooks-runtime.mjs'

//#region 装置（与 client-runtime.test.mjs 同一套惯用法）

/** 造一个"能真跑"的客户端模块 + 渲染器。 */
async function runtime() {
  const hooks = createHooks()
  const mod = await loadClientModule(hooks.react)
  return { ...hooks, internals: mod.__internals }
}

/**
 * 等 effect 里的 Promise 链跑完（微任务清空）**并收敛渲染**，反复几轮。
 *
 * ⚠️ 与 `client-runtime.test.mjs` 里那份的区别：这里是**等一轮、渲染一轮**交替着来。
 *
 * 为什么不能"先等几轮、最后渲染一次"：这一批用例的流程里，**新的请求是在渲染那一趟
 * 才发出去的**（面板要等 `/progress` 回来才知道读者在第 430 章，那时才去取第 430 章的
 * 正文）。先等再渲染的写法会在"请求刚发出去"的那一刻就收工，于是断言看到的是一棵
 * 永远停在「正在读取正文…」的树。
 */
async function settle(hooks, rounds = 3) {
  let tree = null
  for (let at = 0; at < rounds; at += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    tree = hooks.act()
  }
  return tree
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

/** 按**按钮自己那层文字**找节点（`h('button', {...}, '这些我都读过')` 是这种）。 */
function buttonByText(tree, text) {
  const hit = findNode(tree, (node) => typeof node.props?.onClick === 'function'
    && [...(node.children ?? []), node.props?.children]
      .some((item) => typeof item === 'string' && item === text))
  assert.ok(hit !== null, `树上找不到「${text}」按钮：${treeText(tree).slice(0, 400)}`)
  return hit
}

/** 造一个 JSON 响应（与 `makeFetch` 内部同形，但允许自定义状态码）。 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

//#endregion

//#region 夹具

const BOOK = {
  bookId: '0123456789abcdef',
  title: '夜行',
  strategy: 'heading-regex',
  chapterCount: 2,
  progress: null,
  finished: false,
}

const CHAPTER_TEXT = '第一段文字。\n\n第二段文字。\n\n第三段文字。'

/** 书架上的第二本书（"读者自己换了另一本"那条路径要它）。 */
const OTHER_BOOK = {
  bookId: 'fedcba9876543210',
  title: '白昼',
  strategy: 'heading-regex',
  chapterCount: 3,
  byteLength: 4096,
  encoding: 'utf-8',
  progress: null,
  finished: false,
}

/** 造 N 章目录（正文页的 `chapters[chapterIndex]` 要真的存在）。 */
function chaptersOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    index, title: `第 ${index + 1} 章`, length: 100, volume: null, kind: 'chapter',
  }))
}

/**
 * 目录页 / 正文页 / 笔记页要的那些路由。
 *
 * ⚠️ `/chapters/` 必须排在 `/chapters` **前面**：`makeFetch` 取第一条命中的规则，
 * 而 `/books/x/chapters/0` 同时包含这两个串。
 */
function bookRoutes({
  book = BOOK,
  chapters = chaptersOf(2),
  chapterText = CHAPTER_TEXT,
  progress = { chapterIndex: 0, charOffset: 0 },
  binding = null,
} = {}) {
  const at = `/books/${book.bookId}`
  return [
    [`${at}/chapters/`, { body: { ok: true, chapter: { index: 0, title: chapters[0]?.title ?? '第一章', text: chapterText } } }],
    [`${at}/chapters`, { body: { ok: true, chapters } }],
    [`${at}/progress`, { body: { ok: true, progress, binding: binding === null ? null : { sessionId: binding } } }],
    [`${at}/notes/chapter/`, { body: { ok: true, notes: [] } }],
    [`${at}/notes?limit=`, { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } }],
    [`${at}/drafts`, { body: { ok: true, drafts: [] } }],
    [`${at}/location`, { body: { ok: true, location: null } }],
  ]
}

/** 陪读面板（`CompanionView`）要的那些路由。 */
function companionRoutes() {
  const book = `/books/${BOOK.bookId}`
  return [
    [`${book}/persona`, { body: { ok: true, text: '' } }],
    [`${book}/discussions?limit=`, { body: { ok: true, discussions: [], total: 0 } }],
    ['/settings', { body: { ok: true, config: {} } }],
    [`${book}/background?`, { body: BACKGROUND }],
  ]
}

/** 跳读闸拦下时服务端给的那一份（`gatePromptOf` 认的形状）。 */
const GAP = { from: 3, to: 429, chapters: 427 }
const GATE_BODY = {
  error: 'LARGE_GAP',
  gap: GAP,
  gate: 50,
  recentWindow: 200,
  estimate: {
    all: { batches: 15, perChapter: 1200 },
    recent: { window: 200, batches: 7, perChapter: 1200 },
  },
}

/** 背景认识（`/background` 的答复；`gap` 非空 = 补齐按钮可点）。 */
const BACKGROUND = {
  ok: true,
  exists: true,
  markdown: '',
  covered: { first: 1, last: 2 },
  gap: GAP,
  characters: [],
  beyondProgress: null,
  finished: false,
  webGate: 'off',
}

function companionProps(extra = {}) {
  return {
    book: BOOK,
    sessionId: 'session-abc',
    currentChapter: 430,
    onBack: () => {},
    ...extra,
  }
}

/** 往模块级会话记忆里播一条种子（面板重挂时从这里起步）。 */
function seedSessionView(internals, sessionId, entry) {
  internals.sessionViews.clear()
  internals.sessionViews.set(sessionId, { origin: null, draft: null, ...entry })
}

//#endregion

//#region 视图记忆：进笔记页的每个入口（取代「每个进笔记页的入口都要记下来源」）

test('视图记忆：从目录进笔记页，「返回」回到目录、交接交出去的来源也是目录', async () => {
  // 取代「视图记忆：每个进笔记页的入口都要记下来源」里的：
  //   · `noteOriginRef.current = 'toc'`（来源真的写下来了）
  //   · `onBack: () => setView(noteOriginRef.current ?? 'toc')`（返回真的用它）
  //   · `origin: payload?.origin ?? noteOriginRef.current ?? 'reader'`（来源单独交出去）
  //   · 入口数 == 记账处数（这一条只能靠**逐个入口走一遍**来表达，见下两条用例）
  //
  // ⚠️ 种子里的来源刻意记成 `'reader'`（"上一次是从正文进的笔记页"），因为这条用例要
  // 同时钉住两处的**兜底**都盖不住它：
  //   · `onBack` 的兜底是 `'toc'` ⇒ 来源为空时返回仍然回目录；
  //   · 交接种子的兜底是 `'reader'` ⇒ 忘了记来源时交出去的也是 `'reader'`。
  // 只有先把它设成别的值，这两处"忘了记来源"才会在界面上显形。
  //
  // 证伪：把 `TocView.onOpenNotes` 里的 `noteOriginRef.current = 'toc'` 删掉（来源保持
  //      `'reader'`）⇒ 「返回」掉进正文、交出去的 origin 变成 `'reader'`；
  //      把 `origin: … ?? noteOriginRef.current ?? 'reader'` 里的 `noteOriginRef.current`
  //      删掉 ⇒ 交出去的 origin 变成兜底的 `'reader'`（这一处**只有这条用例**能证伪：
  //      别的用例的来源恰好就是 `'reader'`，与兜底同值）；
  //      或把 `onBack` 写成 `() => setView('reader')` 这样的固定层 ⇒ 同样红。
  const { react, render, act, internals } = await runtime()
  seedSessionView(internals, 'alpha', { view: 'toc', book: BOOK, origin: 'reader' })
  const fillBodies = []
  const { fetch } = makeFetch([
    [`/books/${BOOK.bookId}/background/fill`, (url, options) => {
      fillBodies.push(JSON.parse(options.body))
      return jsonResponse({ ok: true, skipped: true })
    }],
    [`/books/${BOOK.bookId}/discussions`, () => jsonResponse({ ok: true })],
    ...bookRoutes({ binding: 'beta' }),
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderPanel, {
      sessionId: 'alpha',
      inputActions: { setDraft: () => {} },
      openSession: () => {},
    }))
    let tree = await settle({ act })
    assert.ok(treeText(tree).includes('读至 '), `起步该在目录页：${treeText(tree).slice(0, 200)}`)

    // 「笔记」这颗按钮的 `title` 是 `读书笔记`（目录页与正文页同一颗）。
    const notesEntry = findNode(tree, (node) => node.props?.title === '读书笔记')
    assert.ok(notesEntry !== null, '目录页要有「笔记」入口')
    tree = act(() => notesEntry.props.onClick())
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('① 发到会话去聊'), `点「笔记」要真的进笔记页：${treeText(tree).slice(0, 300)}`)

    // 从目录进的笔记页是"空着手写一条"：读者自己敲一段，然后发到会话。
    const excerpt = findNode(tree, (node) => node.props?.id === 'drc-note-excerpt')
    assert.ok(excerpt !== null, '笔记页要有原文摘抄那一格')
    tree = act(() => excerpt.props.onChange({ target: { value: '手打的一段' } }))
    tree = await settle({ act })
    tree = act(() => buttonByText(tree, '① 发到会话去聊').props.onClick())
    tree = await settle({ act })
    assert.equal(fillBodies.length, 1, '发笔记要顺带补一次前文记忆')
    const seed = internals.sessionViews.get('beta')
    assert.ok(seed !== undefined, `目标会话必须拿到整层种子：${[...internals.sessionViews.keys()].join(' | ')}`)
    assert.equal(seed.origin, 'toc', '从目录进的笔记页，交出去的来源必须是目录（不是兜底的正文）')

    const back = findNode(tree, (node) => node.props?.title === '返回')
    assert.ok(back !== null, '笔记页要有「返回」')
    tree = act(() => back.props.onClick())
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('读至 '), `「返回」要回到进来的那一层（目录）：${treeText(tree).slice(0, 300)}`)
    assert.ok(!treeText(tree).includes('第一段文字。'), '不该掉进正文 —— 那不是这个入口的来源')
  })
})

test('视图记忆：从正文的「笔记」按钮进笔记页，「返回」回到正文', async () => {
  // 同一个入口计数里的第二个入口：`ReaderView.onOpenNotes` 那一条
  // （`noteOriginRef.current = 'reader'`）。两个入口记的是**不同的**来源，
  // 所以只钉住"有一处记了来源"是不够的 —— 这条用例要求它记成正文。
  //
  // 证伪：把 ReaderPanel 里 `ReaderView` 的 `onOpenNotes` 中的
  //      `noteOriginRef.current = 'reader'` 删掉（或改成 `'toc'`），这条就红。
  const { react, render, act, internals } = await runtime()
  seedSessionView(internals, 'alpha', { view: 'reader', book: BOOK })
  const { fetch } = makeFetch(bookRoutes())

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderPanel, { sessionId: 'alpha' }))
    let tree = await settle({ act })
    assert.ok(treeText(tree).includes('第一段文字。'), `起步该在正文页：${treeText(tree).slice(0, 200)}`)

    const notesEntry = findNode(tree, (node) => node.props?.title === '读书笔记')
    assert.ok(notesEntry !== null, '正文页要有「笔记」入口')
    tree = act(() => notesEntry.props.onClick())
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('① 发到会话去聊'), '点「笔记」要真的进笔记页')

    const back = findNode(tree, (node) => node.props?.title === '返回')
    tree = act(() => back.props.onClick())
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('第一段文字。'), `「返回」要回到正文：${treeText(tree).slice(0, 300)}`)
    assert.ok(!treeText(tree).includes('读至 '), '不该掉到目录 —— 那正是读者反馈过的那条（记完笔记回不到原文）')
  })
})

test('视图记忆：从正文选区起稿也算一个入口 —— 来源记成正文，且交接交出去的是「笔记页 + 来源 + 草稿」', async () => {
  // 取代「视图记忆：每个进笔记页的入口都要记下来源」里的：
  //   · `noteOriginRef.current = 'reader'`（`captureNote` 那一处）
  //   · `view: payload?.view ?? 'notes'`（**发送保留此刻这一层**）
  //   · `assert.doesNotMatch(source, /view: payload\?\.view \?\? noteOriginRef\.current/)`
  //     （把来源当成交接落点 ⇒ 读者在笔记页点发送会被弹回正文）
  //   · `origin: payload?.origin ?? noteOriginRef.current ?? 'reader'`（来源单独交出去）
  //   · `draft: payload?.draft ?? activeDraft`（草稿一起交出去）
  //   · 顺带覆盖守卫 4 的第 ① 半：发笔记要把**这条笔记所属的章**带进补齐请求体。
  //
  // 证伪：① 删掉 `captureNote` 里的 `noteOriginRef.current = 'reader'` ⇒ 发送之后
  //         点「返回」会掉到目录（`?? 'toc'` 兜底）—— 注意**种子里的 origin 抓不到它**，
  //         因为 `origin: … ?? noteOriginRef.current ?? 'reader'` 的最后一层兜底恰好也是
  //         `'reader'`，所以这一条必须靠「返回」来证伪（见本用例最后一步）；
  //      ② 把 `view: payload?.view ?? 'notes'` 改回 `?? noteOriginRef.current` ⇒ 种子落点变 reader；
  //      ③ 删掉 `draft: payload?.draft ?? activeDraft` ⇒ 目标会话的笔记页是空编辑框；
  //      ④ 把 `Number.isInteger(active?.chapterIndex)` 改成 `false` ⇒ 补齐请求体里没有 atChapter。
  const { react, render, act, internals } = await runtime()
  seedSessionView(internals, 'alpha', { view: 'reader', book: BOOK })

  const fillCalls = []
  const { fetch, calls } = makeFetch([
    [`/books/${BOOK.bookId}/background/fill`, (url, options) => {
      fillCalls.push({ url, options, body: JSON.parse(options.body) })
      return jsonResponse({ ok: true, skipped: true })
    }],
    [`/books/${BOOK.bookId}/discussions`, () => jsonResponse({ ok: true })],
    ...bookRoutes({ chapters: chaptersOf(431), progress: { chapterIndex: 430, charOffset: 0 }, binding: 'beta' }),
  ])

  // 读者在正文里拖选了一段。真浏览器里这是 `window.getSelection()` 给的；
  // 这里给一个形状相同的替身（`handleSelect` 只读 rangeCount / isCollapsed /
  // toString / anchorNode.getAttribute('data-off')）。
  const originalWindow = globalThis.window
  globalThis.window = {
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: false,
      toString: () => '第一段文字。',
      anchorNode: {
        nodeType: 1,
        getAttribute: (name) => (name === 'data-off' ? '120' : null),
        parentElement: null,
      },
    }),
  }

  try {
    await withFetch(fetch, async () => {
      render(react.createElement(internals.ReaderPanel, {
        sessionId: 'alpha',
        inputActions: { setDraft: () => {} },
        openSession: () => {},
        getSidebarRight: () => null,
      }))
      let tree = await settle({ act })
      assert.ok(treeText(tree).includes('第一段文字。'), `起步该在第 431 章的正文页：${treeText(tree).slice(0, 400)}`)

      // 模拟"读者选中了一段"：正文容器的 onMouseUp 就是那条路径。
      const article = findNode(tree, (node) => typeof node.props?.onMouseUp === 'function')
      assert.ok(article !== null, '正文容器要挂着选区处理')
      tree = act(() => article.props.onMouseUp())
      tree = await settle({ act })

      const capture = buttonByText(tree, '记笔记')
      tree = act(() => capture.props.onClick())
      tree = await settle({ act })
      assert.ok(treeText(tree).includes('① 发到会话去聊'), `「记笔记」要进笔记页：${treeText(tree).slice(0, 300)}`)

      const send = buttonByText(tree, '① 发到会话去聊')
      tree = act(() => send.props.onClick())
      tree = await settle({ act })

      // ① 发出去的那一刻，读者还在笔记页上（发送**保留**此刻这一层）。
      assert.ok(treeText(tree).includes('① 发到会话去聊'), '发送不该把读者从笔记页弹走')

      // ② 补齐请求带上了这条笔记所属的章。
      assert.equal(fillCalls.length, 1, `发笔记要补一次前文记忆：${calls.map((call) => call.url).join(' | ')}`)
      assert.deepEqual(
        fillCalls[0].body,
        { sessionId: 'alpha', atChapter: 430 },
        '补齐请求体必须带上这条笔记所属的那一章（读者在第 430 章发笔记，界面不能一声不响）',
      )

      // ③ 交接给目标会话的那份种子：落点是**笔记页**、来源是**正文**、草稿一起走。
      const seed = internals.sessionViews.get('beta')
      assert.ok(seed !== undefined, `目标会话必须拿到整层种子：${[...internals.sessionViews.keys()].join(' | ')}`)
      assert.equal(seed.view, 'notes', '发送保留的是此刻这一层（笔记页），不是进笔记页时的来源')
      assert.equal(seed.origin, 'reader', '来源要单独交出去 —— 那边的「返回」只能靠它')
      assert.equal(seed.book?.bookId, BOOK.bookId, '种子要带上书，否则目标会话落回书架')
      assert.equal(seed.draft?.excerpt, '第一段文字。', '草稿要一起交出去，否则那边的笔记页是个空编辑框')

      // ① 记下来还不够，「返回」必须真的用它 —— 而且**不能**靠交接种子里那层兜底
      //    （`?? 'reader'`）蒙对：`captureNote` 没写下来源的话，这里会掉到目录。
      tree = act(() => findNode(tree, (node) => node.props?.title === '返回').props.onClick())
      tree = await settle({ act })
      assert.ok(
        treeText(tree).includes('第一段文字。'),
        `从正文选区起稿的笔记页，「返回」要回到正文：${treeText(tree).slice(0, 300)}`,
      )
      assert.ok(!treeText(tree).includes('读至 '), '不该掉到目录 —— 摘抄是从正文里选的，返回却回不到正文')
    })
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})

//#endregion

//#region 视图记忆：还原那一帧（取代「还原那一帧的接线（组件内逻辑，渲染不出来）」）

test('视图记忆：还原那一帧把「书 + 笔记页 + 草稿 + 来源」一次摆好', async () => {
  // ⚠️ 旧用例的名字里写着"渲染不出来" —— 那是**旧的静态替身**下的结论
  // （`useState` 不调用初值函数、`useEffect` 不跑）。新的 hooks 运行时真的跑，
  // 所以这条现在**渲染得出来**，而且比原来强：原来只断言五行源码里出现了那几个
  // 表达式，现在断言的是"读者真的看到了摘抄与感想"。
  //
  // 取代旧用例里的五条 `assert.match(source, …)`：
  //   · `useState(() => recallSessionView(sessionViews, sessionId)…)` ⇒ 起步于模块记忆
  //   · `useState(() => resolveRestoreView(boot?.view, boot?.draft))` ⇒ 落点连着草稿算
  //     ⚠️ **这一处单独改坏是看不出来的**：`restoreRef` 算的是同一个表达式，而落点
  //     effect 会在同一次提交里把视图纠正回去 —— 它只影响"第一帧闪一下"，而本运行时
  //     不暴露中间帧。真正能证伪它的是下一条用例（草稿为空时 `restoreRef` 说"该去
  //     笔记页"⇒ 落进空编辑框）。写在这里，免得下一个人以为它被覆盖了。
  //   · `useState(() => boot?.draft ?? null)` ⇒ 草稿装回编辑框
  //   · `restoreRef = useRef({ bookId, view: resolveRestoreView(boot?.view, boot?.draft) })`
  //     ⇒ 待落点项也连着草稿算（差异见下一条用例）
  //   · `draft: view === 'notes' ? activeDraft : null` ⇒ 只有笔记页把草稿记进记忆
  //
  // 证伪：① `recallSessionView(sessionViews, sessionId)` 换成 `null` ⇒ 起步是书架；
  //      ② `resolveRestoreView(…)` 里的 `boot?.draft` **两处都**删掉 ⇒ 下一条用例红；
  //      ③ `useState(() => boot?.draft ?? null)` 换成 `null` ⇒ 编辑框是空的；
  //      ④ `noteOriginRef = useRef(boot?.origin…)` 换成 `useRef(null)` ⇒ 「返回」掉到目录；
  //      ⑤ `draft: view === 'notes' ? activeDraft : null` 换成 `activeDraft` ⇒ 返回之后
  //         记忆里仍留着草稿。
  const { react, render, act, internals } = await runtime()
  const draft = {
    draftId: null,
    bookId: BOOK.bookId,
    chapterIndex: 0,
    chapterTitle: '第 1 章',
    charOffset: 120,
    excerpt: '摘抄原文',
    thought: '我的感想',
    reply: null,
    tags: ['雪'],
  }
  seedSessionView(internals, 'alpha', { view: 'notes', book: BOOK, draft, origin: 'reader' })
  const { fetch } = makeFetch(bookRoutes({ progress: { chapterIndex: 0, charOffset: 120 } }))

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderPanel, { sessionId: 'alpha' }))
    let tree = await settle({ act })

    // 第一帧就落在笔记页上（不是目录，也不是空编辑框）。
    assert.ok(treeText(tree).includes('① 发到会话去聊'), `记忆里是笔记页，第一帧就该是笔记页：${treeText(tree).slice(0, 300)}`)
    assert.ok(!treeText(tree).includes('读至 '), '不该先闪一下目录')
    assert.ok(treeText(tree).includes('摘抄原文'), '草稿要从记忆里装回编辑框（原文摘抄那一格）')
    assert.ok(treeText(tree).includes('我的感想'), '感想那一格也要装回来')

    // 草稿确实被记进了模块记忆（下一次重挂才有的还原）。
    assert.equal(internals.sessionViews.get('alpha')?.draft?.excerpt, '摘抄原文', '笔记页要把草稿记进会话记忆')

    // 「返回」回到**来源**（正文），而不是固定的目录。
    const back = findNode(tree, (node) => node.props?.title === '返回')
    assert.ok(back !== null, '笔记页要有「返回」')
    tree = act(() => back.props.onClick())
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('第一段文字。'), `「返回」要回到来源（正文）：${treeText(tree).slice(0, 300)}`)

    // 离开笔记页之后，记忆里不该再留着草稿（`view === 'notes'` 那个条件）。
    const after = internals.sessionViews.get('alpha')
    assert.equal(after?.view, 'reader', '离开笔记页之后记下的应该是正文这一层')
    assert.equal(after?.draft, null, '只有笔记页才把草稿记进记忆 —— 别的层记它只会让下一次还原落错页')
  })
})

test('视图记忆：记忆里是「笔记页但没有草稿」时不许还原成空编辑框，要退回目录', async () => {
  // ⚠️ 这一条钉的是 `resolveRestoreView` 的**两处调用点**都必须连着草稿一起算：
  //    · `useState(() => resolveRestoreView(boot?.view, boot?.draft))`（初始落点）
  //    · `restoreRef = useRef({ …, view: resolveRestoreView(boot?.view, boot?.draft) })`（待落点）
  // 只算 `boot?.view` 的那一版在这里的表现是：初始落点是目录 ✓，但待落点项说"该去
  // 笔记页" ⇒ 目录一到就把读者搬进一个**空编辑框**（比回目录更糟 —— 他会以为摘抄丢了）。
  //
  // 证伪：把 `restoreRef` 的 `view: resolveRestoreView(boot?.view, boot?.draft)` 改成
  //      `view: boot?.view`，这条就红（落点变成笔记页）。
  const { react, render, act, internals } = await runtime()
  seedSessionView(internals, 'alpha', { view: 'notes', book: BOOK, draft: null, origin: 'reader' })
  const { fetch } = makeFetch(bookRoutes())

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderPanel, { sessionId: 'alpha' }))
    const tree = await settle({ act })
    assert.ok(treeText(tree).includes('读至 '), `没有草稿就该退回目录：${treeText(tree).slice(0, 300)}`)
    assert.ok(!treeText(tree).includes('① 发到会话去聊'), '不许还原成空编辑框的笔记页')
  })
})

test('视图记忆：读者没等目录就换了书，旧书的待落点项必须作废', async () => {
  // 取代「视图记忆：每个进笔记页的入口都要记下来源」末尾那条源码断言：
  //   `assert.match(source, /if \(step === 'drop'\)/, '读者换了书要清掉待办')`
  //
  // ⚠️ 为什么这条用例这么绕 —— `drop` 只在**目录还在路上**的时候才够得着：
  //    · 待落点项只有 `pending.view === 'reader'` 才需要等目录。目录页 / 笔记页
  //      一挂载就是 `apply`，待办项当场被消费，之后再换书也走不到 `drop`；
  //    · 所以要先把**旧书的目录挂住不返回**，趁它"在路上"退回书架、点开另一本书。
  // 判据也只能落在"回到原来那本书之后"：换到新书那一刻，`drop` 与"什么都不做"
  // 长得一模一样（`drop` 本来也不是 `apply`，effect 照样 return）。
  //
  // 证伪：把还原 effect 里 `if (step === 'drop')` 改成 `if (false)` ⇒ 待办项活了下来，
  //      等旧书目录终于到位时它重新生效，把读者从目录页拽进正文页，这条红。
  const { react, render, act, internals } = await runtime()
  // 旧书的目录：由这条用例自己决定什么时候放行。
  let releaseChapters = null
  const chaptersGate = new Promise((resolve) => { releaseChapters = resolve })

  seedSessionView(internals, 'alpha', { view: 'reader', book: BOOK })
  const { fetch } = makeFetch([
    // 旧书的**正文文本**照常返回（挂载那一趟 `ReaderView` 会去取它）。
    [`/books/${BOOK.bookId}/chapters/`, { body: { ok: true, chapter: { index: 0, title: '第 1 章', text: CHAPTER_TEXT } } }],
    // 旧书的**目录**挂住不返回。必须排在 `bookRoutes()` 前面（`makeFetch` 取第一条命中）。
    [`/books/${BOOK.bookId}/chapters`, () => chaptersGate.then(() => jsonResponse({ ok: true, chapters: chaptersOf(2) }))],
    ['/library', { body: { ok: true, books: [BOOK, OTHER_BOOK] } }],
    ['/health', { body: { ok: true, quarantined: [] } }],
    ...bookRoutes(),
    ...bookRoutes({ book: OTHER_BOOK, chapters: chaptersOf(3) }),
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderPanel, { sessionId: 'alpha' }))
    let tree = await settle({ act })
    // ⚠️ 这里不能断言「读至 」：`openBook` 是 `Promise.all([目录, 进度])`，目录挂着，
    //    进度也一起没落地。目录页的"正在解析目录…"才是这一趟的正信号。
    assert.ok(treeText(tree).includes('正在解析目录'), `起步该在旧书的目录页：${treeText(tree).slice(0, 300)}`)
    assert.ok(!treeText(tree).includes('第一段文字。'), '目录没到就不许落进正文页')

    const back = () => findNode(tree, (node) => node.props?.title === '返回')
    const rowOf = (book) => findNode(
      tree,
      (node) => node.props?.className === 'drc-item' && treeText(node).includes(book.title),
    )

    // 目录还在路上 —— 读者已经退回书架，点开了另一本书。
    tree = act(() => back().props.onClick())
    tree = await settle({ act })
    const other = rowOf(OTHER_BOOK)
    assert.ok(other !== null, `书架上要能看到另一本书：${treeText(tree).slice(0, 300)}`)
    tree = act(() => other.props.onClick())
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('读至 '), `开新书该落在新书的目录页：${treeText(tree).slice(0, 400)}`)
    assert.ok(!treeText(tree).includes('第一段文字。'), '新书的目录还没点开，不该在正文页')

    // 再退回书架，重新打开**原来那本**（它的目录仍然挂着）。
    tree = act(() => back().props.onClick())
    tree = await settle({ act })
    const first = rowOf(BOOK)
    assert.ok(first !== null, '书架上要能看到原来那本书')
    tree = act(() => first.props.onClick())
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('正在解析目录'), `重新打开旧书该停在目录页：${treeText(tree).slice(0, 400)}`)
    assert.ok(!treeText(tree).includes('第一段文字。'), '目录没到就不许落进正文页')

    // 现在放行旧书的目录：待办项如果没在换书那一刻作废，它就在这里重新生效。
    releaseChapters()
    tree = await settle({ act })
    assert.ok(
      treeText(tree).includes('读至 '),
      `旧书目录到位后该停在目录页：${treeText(tree).slice(0, 400)}`,
    )
    assert.ok(!treeText(tree).includes('第一段文字。'), '旧书的待落点项已经作废 —— 不许把读者拽进正文页')
  })
})

//#endregion

//#region 跳读闸的界面接线（取代「两个选项真的带上 mode，且主按钮不把点击事件当 mode」）

test('跳读闸的界面接线：两个选项真的把 mode 与所选窗口发出去，主按钮发的是「手动补」', async () => {
  // 取代「跳读闸的界面接线」里的三条：
  //   · `assert.match(source, /fillBackground\('all'\)/)`
  //   · `assert.match(source, /fillBackground\('recent', gateWindow\)/)`（连窗口一起）
  //   · `assert.match(source, /onClick: \(\) => \{ if \(filling\) cancelFill\(\); else fillBackground\(\) \}/)`
  //     —— 这一条的**可观察后果**是"主按钮的请求体是手动补的形状（`ask: true`、没有 `mode`）"，
  //     加上下一条用例里的「补齐中让位给停止」。
  //
  // ⚠️ 旧断言里那半句「不把点击事件当 mode」**单改那一行不会红**：`fillBackground`
  //    自己会把非字面量归一化掉（`asked` 只认 `'all'` / `'recent'`），所以把事件对象传
  //    进去与不传行为完全一样。这里仍然**按 React 的形状把事件对象传进去**，于是
  //    "归一化 + 箭头函数"两处**同时**被拿掉时这条会红（实测过）；只拿掉一处则由
  //    下一条用例（补齐中让位给停止）负责。
  //
  // 证伪：① `fillBackground('all')` 改成 `fillBackground()` ⇒ 第一个选项的请求体变成 ask；
  //      ② `fillBackground('recent', gateWindow)` 改成 `fillBackground('recent')` ⇒
  //         少了 `recentWindow`（读者在弹窗里选的 50/200/300 白选了）；
  //      ③ 窗口那三个按钮的 `onClick: () => setGateWindow(size)` 改成空函数 ⇒
  //         选 300 之后发出去的还是 200；
  //      ④ 主按钮的 `onClick` 改成 `() => fillBackground('all')` ⇒ 它带上了 mode；
  //      ⑤ 主按钮改成 `onClick: fillBackground` **并且**把 `const asked = … : undefined`
  //         改成 `const asked = mode` ⇒ 事件对象被序列化进请求体，这条红。
  const { react, render, act, internals } = await runtime()
  const fillBodies = []
  // ⚠️ 点主按钮时**按 React 的形状把事件对象传进去**（`onClick: fillBackground` 那种写法
  //    收到的正是它）。这样这条用例真的走了一遍"事件对象被当 mode"的那条路。
  const clickEvent = { type: 'click', target: {}, preventDefault: () => {} }
  const { fetch } = makeFetch([
    [`/books/${BOOK.bookId}/background/fill`, (url, options) => {
      const body = JSON.parse(options.body)
      fillBodies.push(body)
      // 手动补（没表态）一律被闸拦下；表过态的两次放行。
      return body.mode === undefined ? jsonResponse(GATE_BODY, 409) : jsonResponse({ ok: true, partial: false, covered: { first: 3, last: 429 }, gap: { chapters: 0 } })
    }],
    ...bookRoutes(),
    ...companionRoutes(),
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.CompanionView, companionProps()))
    let tree = await settle({ act })

    // ① 点「补齐前文记忆」⇒ 服务端回 409 ⇒ 闸门渲染成可点的选择。
    let main = buttonByText(tree, '补齐前文记忆')
    assert.equal(main.props.disabled, false, '有缺口时主按钮必须能点')
    tree = act(() => main.props.onClick(clickEvent))
    tree = await settle({ act })
    assert.equal(fillBodies.length, 1, '主按钮要真的发一次补齐请求')
    assert.deepEqual(
      fillBodies[0],
      { sessionId: 'session-abc', ask: true, atChapter: 430 },
      '主按钮 = 「我是主动来补的」：带 ask，不带 mode',
    )
    assert.ok(treeText(tree).includes('这不是报错'), `跳读闸要渲染成可点的选择，不是一行红字：${treeText(tree).slice(0, 400)}`)

    // ② 「这些我都读过」⇒ mode=all（且带上正在看的那一章）。
    tree = act(() => buttonByText(tree, '这些我都读过').props.onClick())
    tree = await settle({ act })
    assert.equal(fillBodies.length, 2, '点了选项就要真的再补一次')
    assert.deepEqual(fillBodies[1], { sessionId: 'session-abc', mode: 'all', atChapter: 430 })

    // ③ 再被拦一次，然后在弹窗里把窗口改成 300，再选「只记最近」。
    main = buttonByText(tree, '补齐前文记忆')
    tree = act(() => main.props.onClick(clickEvent))
    tree = await settle({ act })
    assert.equal(fillBodies.length, 3, '第二次手动补也要真的发出去')

    tree = act(() => buttonByText(tree, '300 章').props.onClick())
    tree = await settle({ act })
    const recent = buttonByText(tree, '只记最近 300 章')
    tree = act(() => recent.props.onClick())
    tree = await settle({ act })
    assert.equal(fillBodies.length, 4)
    assert.deepEqual(
      fillBodies[3],
      { sessionId: 'session-abc', mode: 'recent', recentWindow: 300, atChapter: 430 },
      '「只记最近 N 章」要把 mode 与**读者选的那个**窗口一起发出去',
    )
  })
})

test('跳读闸的界面接线：补齐中主按钮让位给「停止」，第二次点不会又发一个补齐请求', async () => {
  // 取代上面那条守卫里的 `onClick: () => { if (filling) cancelFill(); else fillBackground() }`。
  // 这是那半句源码真正能观察到的**唯一**后果：补齐循环可能跑十几分钟，
  // 主按钮不许被禁掉（读者没有任何出口），也不许再点出一个新的补齐。
  //
  // 证伪：把主按钮的 `onClick` 改成 `() => fillBackground()`（或直接写成
  //      `onClick: fillBackground`）⇒ 第二次点又发一个补齐请求（`fillBodies.length`
  //      变成 2）；把它的 `disabled` 改成 `true` ⇒ 「停止补齐」点不动。
  const { react, render, act, internals } = await runtime()
  const fillBodies = []
  const clickEvent = { type: 'click', target: {}, preventDefault: () => {} }
  const { fetch } = makeFetch([
    [`/books/${BOOK.bookId}/background/fill`, (url, options) => {
      fillBodies.push(JSON.parse(options.body))
      // 永不落定 = 「补齐中」：读者按下去之后循环还在跑。
      return new Promise(() => {})
    }],
    ...bookRoutes(),
    ...companionRoutes(),
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.CompanionView, companionProps()))
    let tree = await settle({ act })

    tree = act(() => buttonByText(tree, '补齐前文记忆').props.onClick(clickEvent))
    tree = await settle({ act })
    assert.equal(fillBodies.length, 1)

    const stop = buttonByText(tree, '停止补齐')
    assert.ok(String(stop.props.title).includes('停下补齐循环'), '补齐中要说清这一下是「停」，不是「再补一次」')
    assert.equal(stop.props.disabled, false, '补齐中不能把唯一的出口禁掉')

    tree = act(() => stop.props.onClick(clickEvent))
    tree = await settle({ act })
    assert.equal(fillBodies.length, 1, '第二次点是「停止」，不许再发一个补齐请求')
    assert.ok(treeText(tree).includes('已停止补齐'), `停止要留下回音：${treeText(tree).slice(0, 400)}`)
    assert.ok(treeText(tree).includes('补齐前文记忆'), '停止之后按钮要回到「补齐」')
  })
})

//#endregion

//#region 跳读闸的边界（取代「边界跟着"读者正在看的那一章"走，而它只在两个主动动作里落盘」）

test('跳读闸：面板拿到的章号跟着「读者正在看的那一章」走，不是滞后的落盘进度', async () => {
  // 取代「跳读闸：边界跟着…」里的 ③ 与 ④：
  //   · `currentChapter: progress?.chapterIndex ?? null`（面板必须拿到**本地**那一章）
  //   · `/background?atChapter=${at}`（读背景认识时也要带上它）
  //
  // 这一条刻意让两者**不一样**：落盘的进度是第 0 章，而读者刚在目录里点开了第 1 章。
  // 旧代码（用滞后的落盘进度）在这里会请求 `atChapter=0` —— 那正是读者实测的那一幕
  // （在第 430 章发笔记，界面一声不响）。
  //
  // 证伪：把 `currentChapter: progress?.chapterIndex ?? null` 改成 `currentChapter: null`
  //      ⇒ 路径变成 `atChapter=`（空）；改成用服务端那一份 ⇒ 变成 `atChapter=0`。
  const { react, render, act, internals } = await runtime()
  seedSessionView(internals, 'alpha', { view: 'toc', book: BOOK })
  const { fetch, calls } = makeFetch([
    ...bookRoutes({ progress: { chapterIndex: 0, charOffset: 0 }, binding: 'session-abc' }),
    ...companionRoutes(),
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderPanel, { sessionId: 'alpha' }))
    let tree = await settle({ act })

    // 读者在目录里点开第 2 章（落盘进度还停在第 1 章）。
    const secondChapter = findNode(tree, (node) => node.props?.role === 'button'
      && typeof node.props?.onClick === 'function'
      && (node.children ?? []).some((child) => (child?.children ?? []).includes('002')))
    assert.ok(secondChapter !== null, `目录里要有第 2 章那一行：${treeText(tree).slice(0, 300)}`)
    tree = act(() => secondChapter.props.onClick())
    tree = await settle({ act })

    // 进「设置」页（陪读面板）。
    const settings = findNode(tree, (node) => typeof node.props?.onClick === 'function'
      && String(node.props?.title ?? '').startsWith('陪读设置'))
    assert.ok(settings !== null, '正文页要有「设置」入口')
    tree = act(() => settings.props.onClick())
    tree = await settle({ act })

    const backgroundUrls = calls.filter((call) => call.url.includes('/background?')).map((call) => call.url)
    assert.ok(backgroundUrls.length > 0, `面板要读一次背景认识：${calls.map((call) => call.url).join(' | ')}`)
    assert.ok(
      backgroundUrls.some((url) => url.endsWith('/background?atChapter=1')),
      `读背景认识要带上读者正在看的那一章（第 1 章，不是落盘的 0）：${backgroundUrls.join(' | ')}`,
    )
    assert.ok(
      !backgroundUrls.some((url) => url.endsWith('/background?atChapter=0')),
      '不许用滞后的落盘进度算缺口 —— 那会让按钮明明该亮却是灰的',
    )
  })
})

test('跳读闸：补齐循环里只有第一次请求带 atChapter，章号不是整数时一个字都不带', async () => {
  // 取代「跳读闸：边界跟着…」里的 ②：
  //   · `const at = Number.isInteger(currentChapter) ? { atChapter: currentChapter } : {}`
  //   · `let firstCall = true` / `const carried = firstCall ? at : {}`
  //   · `body: bodyFor()`（请求体**每次现算**，不是一次算好反复用）
  //
  // 为什么非这样不可：补齐循环会连着发十几批、可能跑十几分钟，而 `atChapter` 的作用是
  // "把边界推到我正在看的这一章"。每一批都重发的话，读者在补齐期间翻章，他的阅读位置
  // 会被一批批**数回去**（与他自己滚动的回写打架）。
  //
  // 证伪：① `const carried = firstCall ? at : {}` 改成 `{ ...at }` ⇒ 第二批也带上 atChapter；
  //      ② `body: bodyFor()` 改成先算一次的常量 ⇒ 两批的请求体一模一样；
  //      ③ `Number.isInteger(currentChapter) ? … : {}` 改成无条件 `{ atChapter: currentChapter }`
  //         ⇒ 章号为 null 时请求体里出现 `atChapter: null`。
  const { react, render, act, unmount, internals } = await runtime()
  const fillBodies = []
  let fillCall = 0
  const { fetch } = makeFetch([
    [`/books/${BOOK.bookId}/background/fill`, (url, options) => {
      fillBodies.push(JSON.parse(options.body))
      fillCall += 1
      // 第一批是"只补了一段"，第二批补完 —— 于是循环真的发了两次。
      return jsonResponse(fillCall === 1
        ? { ok: true, partial: true, covered: { first: 1, last: 10 }, gap: { chapters: 50 } }
        : { ok: true, partial: false, covered: { first: 1, last: 60 }, gap: { chapters: 0 } })
    }],
    ...bookRoutes(),
    ...companionRoutes(),
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.CompanionView, companionProps()))
    let tree = await settle({ act })
    tree = act(() => buttonByText(tree, '补齐前文记忆').props.onClick())
    tree = await settle({ act })

    assert.equal(fillBodies.length, 2, `缺口大时要连着补几批：${JSON.stringify(fillBodies)}`)
    assert.deepEqual(fillBodies[0], { sessionId: 'session-abc', ask: true, atChapter: 430 }, '第一批要推边界')
    assert.deepEqual(fillBodies[1], { sessionId: 'session-abc', ask: true }, '⚠️ 只有第一批带 atChapter，否则会把读者的位置一批批数回去')

    // 章号不是整数时，`atChapter` 一个字都不该出现（服务端 `parseInt` 拿到 null 会当成 0）。
    unmount()
    render(react.createElement(internals.CompanionView, companionProps({ currentChapter: null })))
    tree = await settle({ act })
    tree = act(() => buttonByText(tree, '补齐前文记忆').props.onClick())
    tree = await settle({ act })
    assert.equal(fillBodies.length, 3)
    assert.deepEqual(fillBodies[2], { sessionId: 'session-abc', ask: true }, '拿不到章号时不许硬塞一个 atChapter')
  })
})

//#endregion
