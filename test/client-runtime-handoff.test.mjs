/**
 * 浏览器半边「起稿 / 跨会话交接」的**运行时行为断言**（2026-10-03，B 档续）。
 *
 * ## 这个文件取代了什么
 *
 * `client.test.mjs` 里那 9 条接线守卫钉的是源码文本：`source.includes('h(ImportNotes, { book })')`
 * 的同类写法 —— 改注释、换行、重命名局部变量都可能让它红，而真正接错线时它又未必红。
 * 这里用 `test/helpers/hooks-runtime.mjs` 的最小 hooks 运行时**真的渲染、真的跑 effect、
 * 真的点按钮**，把每一条都换成行为断言：
 *
 * | 旧守卫（`client.test.mjs`）                             | 本文件里的取代者 |
 * | ---                                                     | --- |
 * | 起稿：进笔记页不写服务端，草稿栏只装读者亲手存过的东西   | 同名 |
 * | 起稿：没有 draftId 时不许替读者建记录                    | 拆成两条：「抓取选中文字」不建记录 / 两次 POST 都带章节且提交用响应里的 id |
 * | 起稿：编辑内容要回报给面板，且面板那个回调必须是稳定引用 | 同名 |
 * | 交接：棒子装在模块级 Map 里，不能退回组件状态            | 同名（真的渲染两次、中间卸载） |
 * | 发到会话：交接带的是**原文**，不拼源会话输入框里的字      | 同名 |
 * | 发到会话：正文的「笔记」按钮必须真的接上                 | 同名 |
 * | 发到会话：交接必须一并交出 `book`                        | 同名 |
 * | 发到会话：跳得过去 + 有人接住，两个条件缺一不可          | 同名 |
 * | 发到会话：守卫只看摘抄与感想，不会被新加的章节行骗过      | 同名 |
 *
 * ⚠️ 一条**取代**一条：这些行为断言完整覆盖的旧钉子要在 `client.test.mjs` 里删掉。
 * 两边都留 = 守卫只增不减，正是要治的病。
 *
 * ## 每条用例都写了「证伪方式」
 *
 * 即：把 `lib/client.js` 的哪一行删掉/改错，这条就会红。没有这一句的断言不算守卫 ——
 * 它可能只是"恰好为真"。本仓库的教训是**假红比不测更坏**。
 *
 * ## 惯用法（与 `client-runtime.test.mjs` 一致）
 *
 *   · `runtime()` 造"能真跑"的客户端模块 + 渲染器（每次调用都是**全新的模块实例**，
 *     所以模块级的两张 Map 天然在用例之间隔离，不必手工 clear）；
 *   · `settle(rt)` 等 effect 里的 Promise 链跑完（微任务清空）再收敛一次渲染；
 *   · `makeFetch(routes)`：**没配过的请求会直接抛错** ⇒ "多打了一个请求"这条能自动红；
 *   · 点按钮 = 在树上找到那个节点、调 `act(() => node.props.onClick())`。
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
async function settle(rt) {
  await new Promise((resolve) => setImmediate(resolve))
  return rt.act()
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
 * 在调用期间装上 `window.getSelection()`。
 *
 * 正文的选区（`ReaderView.handleSelect`）与「抓取选中文字」（`NotesView.grabSelection`）
 * 都走标准的 `window.getSelection()`。替身里没有真 DOM，所以这两条路径要自己造一个
 * **够形状的**选区对象 —— 造不出来就只能退回源码文本断言，而那正是要治的病。
 */
async function withWindow(windowStub, fn) {
  const original = globalThis.window
  globalThis.window = windowStub
  try {
    return await fn()
  } finally {
    if (original === undefined) delete globalThis.window
    else globalThis.window = original
  }
}

/**
 * 造一个假选区。
 *
 * `anchorNode` 要是"有 `data-off` 的元素"：`handleSelect` 从选区起点**向上找**最近的
 * `[data-off]` 拿锚点偏移（与进度、与章节 charOffset 同一套口径）。
 */
function fakeSelection(text, offset = 0) {
  const anchor = {
    nodeType: 1,
    parentElement: null,
    getAttribute: (name) => (name === 'data-off' ? String(offset) : null),
  }
  return { toString: () => text, rangeCount: 1, isCollapsed: false, anchorNode: anchor }
}

/** 走一遍树，收集**所有**命中的节点（`findNode` 只给第一个）。 */
function collect(tree, predicate, out = []) {
  const walk = (item) => {
    if (item === null || item === undefined || typeof item === 'boolean') return
    if (Array.isArray(item)) {
      for (const child of item) walk(child)
      return
    }
    if (typeof item !== 'object') return
    if (predicate(item)) out.push(item)
    for (const child of item.children ?? []) walk(child)
  }
  walk(tree)
  return out
}

/** 树上按 `props.title` 找节点（按钮几乎都靠 title 认人）。 */
function byTitle(tree, title) {
  return findNode(tree, (node) => node.props?.title === title)
}

/** 树上按 `props.id` 找节点（四个编辑框有 `drc-note-*` 的 id）。 */
function byId(tree, id) {
  return findNode(tree, (node) => node.props?.id === id)
}

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
})

/** 把调用记录里的"往某条路径发的 POST"挑出来。 */
const posts = (calls, fragment) => calls.filter(
  (call) => call.options?.method === 'POST' && call.url.includes(fragment),
)

const BOOK = { bookId: '0123456789abcdef', title: '夜行', strategy: 'heading-regex', chapterCount: 2 }

/** 会话 id：`normalizeId` 会把 `session-` 前缀折掉，模块级两张表的键是折过的那一份。 */
const SOURCE_SESSION = 'session-source'
const TARGET_SESSION = 'session-target'
const SOURCE_KEY = 'source'
const TARGET_KEY = 'target'

/** 笔记页首屏要的三条路由（`NotesView` 挂载就 `refresh()` 一次）。 */
const NOTES_VIEW_ROUTES = [
  ['/drafts', { body: { ok: true, drafts: [] } }],
  ['/notes?limit=', { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } }],
  ['/location', { body: { ok: true, location: { dir: 'D:\\陪读导出\\夜行', scope: 'workspace' } } }],
]

/** 正文夹具：三段，偏移 0 / 8 / 16（`buildParagraphs` 按空行切）。 */
const READER_CHAPTER_TEXT = '第一段文字。\n\n第二段文字。\n\n第三段文字。'

/** 正文页要的路由（目录 + 正文 + 本章笔记 + 进度）。 */
const READER_ROUTES = [
  [/\/chapters$/, { body: { ok: true, chapters: [{ index: 0, title: '第一章 雪', length: 100, volume: null, kind: 'chapter' }] } }],
  ['/chapters/', { body: { ok: true, chapter: { index: 0, title: '第一章 雪', text: READER_CHAPTER_TEXT } } }],
  ['/notes/chapter/', { body: { ok: true, notes: [] } }],
  ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 } } }],
]

/**
 * 「发到会话去聊」那一条路要的全部路由。
 *
 * 绑定会话**故意**与当前会话不同 —— 那才会走交接（见 `planNoteSend`）。
 */
const SEND_ROUTES = [
  ...NOTES_VIEW_ROUTES,
  ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 }, binding: { sessionId: TARGET_SESSION } } }],
  ['/background/fill', { body: { ok: true } }],
  ['/discussions', { body: { ok: true } }],
]

/** 交接那一趟要用到的全部路由（源面板停在笔记页，目标面板可能落到任何一层）。 */
const HANDOFF_ROUTES = [
  [/\/chapters$/, { body: { ok: true, chapters: [{ index: 0, title: '第一章 雪', length: 100, volume: null, kind: 'chapter' }] } }],
  ['/chapters/', { body: { ok: true, chapter: { index: 0, title: '第一章 雪', text: '第一段文字。' } } }],
  ['/notes/chapter/', { body: { ok: true, notes: [] } }],
  ['/notes?limit=', { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } }],
  ['/drafts', { body: { ok: true, drafts: [] } }],
  ['/location', { body: { ok: true, location: { dir: 'D:\\陪读导出\\夜行', scope: 'workspace' } } }],
  ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 }, binding: { sessionId: TARGET_SESSION } } }],
  ['/background/fill', { body: { ok: true } }],
  ['/discussions', { body: { ok: true } }],
  // 目标面板**万一**退到书架也不会炸（那正是「交接必须交出 book」那条要抓的失效方向）。
  ['/library', { body: { ok: true, books: [] } }],
  ['/health', { body: { ok: true, quarantined: [] } }],
]

/** 源会话手上那份草稿（起稿与服务端草稿形状相同，区别只在有没有 draftId）。 */
const SOURCE_DRAFT = {
  draftId: 'd1',
  excerpt: '第一段文字。',
  thought: '一点感想',
  chapterIndex: 0,
  chapterTitle: '雪夜',
  charOffset: 0,
  reply: null,
  tags: [],
}

/** 交接带过去的正文（章节行 + 引用块 + 感想）。 */
const HANDOFF_TEXT = '**第 1 章 · 雪夜**\n\n> 第一段文字。\n\n一点感想'

/** 把 `ReaderPanel` 需要的那几样凑齐。 */
function panelProps(extra = {}) {
  return {
    sessionId: SOURCE_SESSION,
    inputActions: { setDraft: () => {} },
    ...extra,
  }
}

/** 把 `NotesView` 需要的那几样凑齐（直接渲染它时用）。 */
function notesProps(extra = {}) {
  return {
    book: BOOK,
    activeDraft: null,
    onBack: () => {},
    sessionId: SOURCE_SESSION,
    inputActions: { setDraft: () => {} },
    existingDraft: '',
    requestHandoff: undefined,
    openSession: null,
    onDraftChange: () => {},
    onJumpToChapter: () => {},
    ...extra,
  }
}

/**
 * 把「源会话发笔记 → 跳过去」这一趟真的跑一遍，**中间卸载源面板**。
 *
 * 这是"棒子装在模块级 Map 里"那条的判据：交接的存放处必须**跨组件实例存活** ——
 * 源面板（一个组件实例）放进去，目标面板（**另一个**实例，且源实例已经被卸载）
 * 取出来。组件状态做不到这件事。
 *
 * @returns {Promise<object>} 一路上的可断言物：调用记录、两边输入框的写入、
 *   卸载之后棒子还在不在、目标面板最终渲染出的树。
 */
async function crossSessionHandoff(targetProps = {}) {
  const rt = await runtime()
  const { internals, react, render, act, unmount } = rt
  // 源会话：面板停在笔记页，手上是那条摘抄与感想（真实里这就是上一次挂载写下的记忆）。
  internals.rememberSessionView(internals.sessionViews, SOURCE_SESSION, {
    view: 'notes',
    book: BOOK,
    draft: SOURCE_DRAFT,
  })

  const opened = []
  const sourceWrites = []
  const targetWrites = []
  const { fetch, calls } = makeFetch(HANDOFF_ROUTES)
  let handoffAtSend = null
  let survived = false
  let targetTree = null

  await withFetch(fetch, async () => {
    let sourceTree = render(react.createElement(internals.ReaderPanel, panelProps({
      inputActions: { setDraft: (text) => sourceWrites.push(text) },
      getOpenSession: () => (id) => { opened.push(id) },
    })))
    sourceTree = await settle(rt)

    const send = findText(sourceTree, '① 发到会话去聊')
    assert.ok(send !== null, `源面板没停在笔记页：${treeText(sourceTree).slice(0, 200)}`)
    act(() => send.props.onClick())
    sourceTree = await settle(rt)

    handoffAtSend = internals.draftHandoffs.get(TARGET_KEY) ?? null

    // ⚠️ 这一步就是"切会话"：右侧栏页签的 scope 是 session，切过去 = 本面板被卸载。
    unmount()
    survived = internals.draftHandoffs.has(TARGET_KEY)

    render(react.createElement(internals.ReaderPanel, panelProps({
      sessionId: TARGET_SESSION,
      inputActions: { setDraft: (text) => targetWrites.push(text) },
      ...targetProps,
    })))
    targetTree = await settle(rt)
  })

  return { rt, internals, calls, opened, sourceWrites, targetWrites, handoffAtSend, survived, targetTree }
}

//#region 起稿不落盘（取代 client.test.mjs 的同名源码文本钉子）

test('起稿：进笔记页不写服务端，草稿栏只装读者亲手存过的东西', async () => {
  // 取代「起稿：进笔记页不写服务端，草稿栏只装读者亲手存过的东西」（原来正则抠
  // `captureNote` 的函数体、断言里面没有 `callApi(`）。
  //
  // ⚠️ 证伪方式：给 `captureNote` 加回一条 `callApi('/books/…/drafts', { method:'POST' })`
  //    ⇒ 下面"进笔记页之后一个 POST 都没有"当场红；把 `setActiveDraft({…})` 删掉
  //    ⇒ 摘抄框是空的、「尚未保存」标记也不出现。
  //
  // 这一趟走的是**真路径**：面板 → 正文 → 选中一段 → 点「记笔记」→ 笔记页。
  const rt = await runtime()
  const { internals, react, render, act } = rt
  internals.rememberSessionView(internals.sessionViews, SOURCE_SESSION, { view: 'reader', book: BOOK })

  const chapterText = READER_CHAPTER_TEXT
  const paragraphs = internals.buildParagraphs(chapterText)
  assert.equal(paragraphs.length, 3, '夹具本身要站得住')

  const savedDrafts = []
  const { fetch, calls } = makeFetch([
    [/\/chapters$/, { body: { ok: true, chapters: [{ index: 0, title: '第一章 雪', length: 100, volume: null, kind: 'chapter' }] } }],
    ['/chapters/', { body: { ok: true, chapter: { index: 0, title: '第一章 雪', text: chapterText } } }],
    ['/notes/chapter/', { body: { ok: true, notes: [] } }],
    ...NOTES_VIEW_ROUTES.filter(([pattern]) => pattern !== '/drafts'),
    // ⚠️ 草稿那一条要**按方法分流**：GET 是"草稿栏里有什么"，POST 才是"读者亲手存了一条"。
    ['/drafts', (url, options) => {
      if (options.method === 'POST') {
        savedDrafts.push(JSON.parse(options.body))
        return jsonResponse({ ok: true, draft: { ...SOURCE_DRAFT, draftId: 'd9', excerpt: paragraphs[1].text }, suggestedTags: [] })
      }
      return jsonResponse({ ok: true, drafts: [] })
    }],
    ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 } } }],
  ])

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.ReaderPanel, panelProps({ inputActions: { setDraft: () => {} } })))
    tree = await settle(rt)

    const article = findNode(tree, (node) => node.props?.className === 'drc-article')
    assert.ok(article !== null, `面板没落到正文页：${treeText(tree).slice(0, 200)}`)

    // "读者用光标选了第二段" —— 选区是 `window.getSelection()` 给的。
    await withWindow({ getSelection: () => fakeSelection(paragraphs[1].text, paragraphs[1].offset) }, async () => {
      tree = act(() => article.props.onMouseUp())
    })

    const capture = findText(tree, '记笔记')
    assert.ok(capture !== null, `选中正文之后该浮出「记笔记」：${treeText(tree).slice(0, 300)}`)
    tree = act(() => capture.props.onClick())
    tree = await settle(rt)

    // ① 进笔记页这一趟**一个 POST 都没有**（草稿栏不该被浏览动作污染）。
    assert.deepEqual(
      posts(calls, '/drafts'),
      [],
      `进笔记页就往草稿栏里塞了一条：${calls.map((call) => `${call.options.method} ${call.url}`).join(' | ')}`,
    )
    assert.deepEqual(savedDrafts, [], '起稿不许落服务端')

    // ② 选区真的装进了编辑框，而且"写了但还没保存"看得见。
    const excerptBox = byId(tree, 'drc-note-excerpt')
    assert.ok(excerptBox !== null, `没进笔记页：${treeText(tree).slice(0, 300)}`)
    assert.equal(excerptBox.props.value, paragraphs[1].text, '起稿要把选区装进编辑框')
    assert.ok(
      treeText(tree).includes('尚未保存 · 点「保存草稿」才会进草稿栏'),
      '「写了但还没保存」没有露出来 —— 读者会以为草稿栏里的东西丢了',
    )

    // ③ 读者亲手点「保存草稿」之后**才有**服务端记录 —— 上面那条"没有 POST"因此不是"POST 坏了"。
    const save = findText(tree, '保存草稿')
    assert.ok(save !== null, '笔记页必须有「保存草稿」')
    tree = act(() => save.props.onClick())
    tree = await settle(rt)

    assert.equal(savedDrafts.length, 1, '「保存草稿」必须真的落一次盘')
    assert.equal(savedDrafts[0].excerpt, paragraphs[1].text, '存下去的正是读者选的那一段')
    assert.ok(treeText(tree).includes('草稿已保存。'), `保存之后要有回音：${treeText(tree).slice(0, 200)}`)
  })
})

test('起稿：没有 draftId 时「抓取选中文字」不许替读者建记录', async () => {
  // 取代「起稿：没有 draftId 时不许替读者建记录」的前半（原来正则钉
  // `if (draftId === undefined || draftId === null) return Promise.resolve(null)`）。
  //
  // ⚠️ 证伪方式：把 `persist` 里那句短路删掉（或改成"顺手新建一条"）
  //    ⇒ 未保存的起稿点「抓取选中文字」会多出一次 POST ⇒ 红。
  const grab = async (activeDraft) => {
    const rt = await runtime()
    const { react, render, act } = rt
    const writes = []
    const { fetch, calls } = makeFetch([
      ...NOTES_VIEW_ROUTES.filter(([pattern]) => pattern !== '/drafts'),
      ['/drafts', (url, options) => (options.method === 'POST'
        ? jsonResponse({ ok: true, draft: { ...activeDraft, reply: 'AI 的回应文字' } })
        : jsonResponse({ ok: true, drafts: [] }))],
    ])
    let tree = null
    await withFetch(fetch, async () => {
      tree = render(react.createElement(rt.internals.NotesView, notesProps({
        activeDraft,
        inputActions: { setDraft: (text) => writes.push(text) },
      })))
      tree = await settle(rt)

      const grabButton = byTitle(tree, '把当前页面上选中的文字填进「AI 回应」')
      assert.ok(grabButton !== null, `找不到「抓取选中文字」：${treeText(tree).slice(0, 200)}`)
      await withWindow({ getSelection: () => fakeSelection('AI 的回应文字') }, async () => {
        tree = act(() => grabButton.props.onClick())
      })
      tree = await settle(rt)
    })
    return { tree, calls, writes }
  }

  // ① 未保存的起稿（没有 draftId）：**一个请求都不许多打**，而且要把"还没保存过"说清楚。
  const unsaved = await grab({ excerpt: '一段原文', thought: '', chapterIndex: 0, chapterTitle: '雪夜' })
  assert.deepEqual(
    posts(unsaved.calls, '/drafts'),
    [],
    `未保存的起稿被自动建了一条记录：${unsaved.calls.map((call) => `${call.options.method} ${call.url}`).join(' | ')}`,
  )
  const unsavedText = treeText(unsaved.tree)
  assert.ok(unsavedText.includes('这条还没保存过'), `必须说清它还没落盘：${unsavedText.slice(0, 300)}`)
  assert.ok(unsavedText.includes('点「保存草稿」才会落盘'), '要指路，否则读者以为它丢了')

  // ② 已有 draftId 的草稿：照常自动存一次（证明 ① 不是"自动保存整条坏了"）。
  const saved = await grab({ draftId: 'd1', excerpt: '一段原文', thought: '', chapterIndex: 0, chapterTitle: '雪夜' })
  const savedPosts = posts(saved.calls, '/drafts')
  assert.equal(savedPosts.length, 1, `有 id 时必须自动存一次：${saved.calls.map((call) => `${call.options.method} ${call.url}`).join(' | ')}`)
  const body = JSON.parse(savedPosts[0].options.body)
  assert.equal(body.draftId, 'd1', '更新要认着原来那条')
  assert.equal(body.reply, 'AI 的回应文字', '抓到的回应要一起存')
})

test('起稿：第一次落盘的两次 POST 都带上章节，提交用的是响应里的 id', async () => {
  // 取代「起稿：没有 draftId 时不许替读者建记录」的后半（原来逐个函数抠 `save` / `commit`
  // 的函数体，断言里面有 `chapterIndex: Number.isInteger(active?.chapterIndex) …`，
  // 并正则钉 `const draftId = data?.draft?.draftId`）。
  //
  // ⚠️ 两半**必须各自从一条未保存的起稿开始**：先点过「保存草稿」的话，本地
  //    `active.draftId` 已经被响应填上了，"提交用的是响应里的 id"这件事就再也
  //    分辨不出来（实测踩到过：这样写出来的用例在 M10 变异下照样绿）。
  //
  // ⚠️ 证伪方式：
  //   · 从 `save` 或 `commit` 的请求体里删掉那行 `chapterIndex` ⇒ body.chapterIndex 变 null ⇒ 红；
  //   · 把 `commit` 里的 `const draftId = data?.draft?.draftId` 改回 `active.draftId`
  //     ⇒ 提交打的是 `/drafts/undefined/commit` ⇒ 红（②里那条 `endsWith('/drafts/d9/commit')`）。
  const withFreshDraft = async (fn) => {
    const rt = await runtime()
    const bodies = []
    const { fetch, calls } = makeFetch([
      // ⚠️ 提交那条**必须排在 `/drafts` 前面**：路由是"先匹配先赢"，`/drafts` 会把
      //    `/drafts/d9/commit` 也吃掉，那样"提交打的是不是 undefined"就抓不住了。
      [/\/drafts\/[^/]+\/commit/, { body: { ok: true } }],
      ['/drafts', (url, options) => {
        if (options.method === 'POST') {
          bodies.push(JSON.parse(options.body))
          return jsonResponse({
            ok: true,
            draft: { ...SOURCE_DRAFT, draftId: 'd9', excerpt: '一段原文', thought: '', chapterIndex: 5, chapterTitle: '雪夜' },
            suggestedTags: [],
          })
        }
        return jsonResponse({ ok: true, drafts: [] })
      }],
      ...NOTES_VIEW_ROUTES.filter(([pattern]) => pattern !== '/drafts'),
    ])

    await withFetch(fetch, async () => {
      // 一条**未保存的起稿**（没有 draftId），但读者是跳到第 6 章（index 5）记的。
      let tree = rt.render(rt.react.createElement(rt.internals.NotesView, notesProps({
        activeDraft: { excerpt: '一段原文', thought: '', chapterIndex: 5, chapterTitle: '雪夜' },
        inputActions: { setDraft: () => {} },
      })))
      tree = await settle(rt)
      await fn({ rt, tree, bodies, calls })
    })
    return { bodies, calls }
  }

  // ① 「保存草稿」：新建那条 POST 必须带章节。
  const saved = await withFreshDraft(async ({ rt, tree, bodies }) => {
    const save = findText(tree, '保存草稿')
    assert.ok(save !== null, `找不到「保存草稿」：${treeText(tree).slice(0, 200)}`)
    rt.act(() => save.props.onClick())
    await settle(rt)
    assert.equal(bodies.length, 1, '「保存草稿」要落一条记录')
  })
  assert.equal(saved.bodies[0].chapterIndex, 5, '第一次 POST 没带章节 —— 草稿会挂到没有出处的位置上')
  assert.equal(saved.bodies[0].draftId, undefined, '未保存的起稿本来就没有 id，这一趟是"新建"')

  // ② 「写入笔记」：先存一次最新内容，再拿**响应里**的 id 去提交。
  const committed = await withFreshDraft(async ({ rt, tree, bodies }) => {
    const commit = findText(tree, '写入笔记')
    assert.ok(commit !== null, `找不到「写入笔记」：${treeText(tree).slice(0, 200)}`)
    rt.act(() => commit.props.onClick())
    await settle(rt)
    assert.equal(bodies.length, 1, '「写入笔记」要先把编辑框里的最新内容存一次（然后才提交）')
  })
  assert.equal(committed.bodies[0].chapterIndex, 5, '提交前那次 POST 也要带章节')
  assert.ok(
    committed.calls.some((call) => call.url.endsWith('/drafts/d9/commit')),
    `提交必须用**响应里**的 id（未保存的起稿本地没有 id）：${committed.calls.map((call) => call.url).join(' | ')}`,
  )
})

test('起稿：编辑内容要回报给面板，且面板那个回调必须是稳定引用', async () => {
  // 取代「起稿：编辑内容要回报给面板，且面板那个回调必须是稳定引用」。
  //
  // 原钉子断言 `handleDraftChange` 是空依赖 `useCallback`、`onDraftChange` 接上了、
  // 上报的 `draftId` 归一成字符串或 null。这里三样都用**行为**盖住：
  //   · 归一化：种子里的草稿**没有** `draftId` 这个键；只有上报线真的跑了、
  //     且上报的是归一化后的对象，会话记忆里才会出现 `draftId: null`；
  //   · 上报线活着：改一下感想框，模块级记忆立刻跟着变；
  //   · 稳定引用：回调若每次渲染换一个新函数，上报 effect 就会
  //     "上报 → setState → 重渲染 → 再上报"地转圈 —— 那在这套运行时里
  //     **会抛「渲染没有收敛」**，而不是安静地慢。
  //
  // ⚠️ 证伪方式：
  //   · 删掉 `onDraftChange: handleDraftChange` ⇒ 记忆里那条还是种子（没有 draftId 键）⇒ 红；
  //   · 把 `handleDraftChange` 从 `useCallback(…, [])` 改成内联箭头（或补一个每次都变的依赖）
  //     ⇒ 渲染转圈 ⇒ 抛「渲染没有收敛」⇒ 红；
  //   · 删掉上报里的 `draftId` 归一化 ⇒ 记忆里是 `undefined` ⇒ 红。
  const rt = await runtime()
  const { internals, react, render, act } = rt
  const sessionId = SOURCE_SESSION
  // ⚠️ 种子**刻意不带 `draftId` 键** —— 归一化有没有发生，就靠这一点看。
  internals.rememberSessionView(internals.sessionViews, sessionId, {
    view: 'notes',
    book: BOOK,
    draft: { excerpt: '一段原文', thought: '', chapterIndex: 0, chapterTitle: '雪夜' },
  })

  const { fetch } = makeFetch(NOTES_VIEW_ROUTES)

  await withFetch(fetch, async () => {
    let tree = null
    assert.doesNotThrow(
      () => { tree = render(react.createElement(internals.ReaderPanel, panelProps({ sessionId }))) },
      '面板那个回调不是稳定引用 —— 上报 effect 每次渲染都重跑，渲染不会收敛',
    )
    tree = await settle(rt)
    assert.doesNotThrow(() => act(), '再收敛一次也必须收敛（回调引用跨渲染稳定）')

    const remembered = internals.sessionViews.get(SOURCE_KEY)
    assert.ok(remembered !== null && remembered !== undefined, '面板必须把状态写进模块级会话记忆')
    assert.equal(remembered.view, 'notes')
    assert.equal(remembered.draft?.draftId, null, '上报的 draftId 要归一成 null —— undefined 漏进记忆会让"未保存"判不出来')
    assert.equal(remembered.draft?.excerpt, '一段原文', '上报的内容要真的是编辑框里那一份')

    // 上报线必须**活着**：改一下感想框，记忆要立刻跟着变。
    const thoughtBox = byId(tree, 'drc-note-thought')
    assert.ok(thoughtBox !== null, `找不到感想框：${treeText(tree).slice(0, 200)}`)
    act(() => thoughtBox.props.onChange({ target: { value: '刚写下的感想' } }))
    assert.equal(
      internals.sessionViews.get(SOURCE_KEY)?.draft?.thought,
      '刚写下的感想',
      '编辑内容没有回报给面板 —— 切个页签回来摘抄与感想就没了',
    )
  })

  // 还有一件：上报端要**容忍面板没给回调**（原钉子那句
  // `if (typeof onDraftChange !== 'function') return`）。少了它，上报 effect 会拿
  // `undefined` 当函数调 —— 笔记页整页崩，而不是少写一次记忆。
  //
  // ⚠️ 证伪方式：删掉上报 effect 里那句存在性检查 ⇒ 这里 render 当场抛 TypeError ⇒ 红。
  const bare = await runtime()
  const bareFetch = makeFetch(NOTES_VIEW_ROUTES)
  await withFetch(bareFetch.fetch, async () => {
    assert.doesNotThrow(
      () => {
        bare.render(bare.react.createElement(bare.internals.NotesView, notesProps({
          activeDraft: { excerpt: '一段原文', thought: '', chapterIndex: 0, chapterTitle: '雪夜' },
          inputActions: { setDraft: () => {} },
          onDraftChange: undefined,
        })))
      },
      '面板没给上报回调时笔记页必须照常渲染（上报端要自己做存在性检查）',
    )
    const bareTree = await settle(bare)
    assert.ok(byId(bareTree, 'drc-note-excerpt') !== null, '没给上报回调也要能正常进笔记页')
  })
})

//#endregion

//#region 跨会话交接（取代 client.test.mjs 的同名源码文本钉子）

test('交接：棒子装在模块级 Map 里 —— 卸载重挂之后仍然送达', async () => {
  // 取代「交接：棒子装在模块级 Map 里，不能退回组件状态」。
  //
  // 这是本轮修复的**根因**：右侧栏页签的 scope 是 session，切会话会卸载本面板。
  // 交接棒一旦放在 `useState` 里，跳转这个动作本身就会把它带走 —— 读者看到的
  // 正是"跳过去了，但输入框是空的"。
  //
  // ⚠️ 判据是**跨组件实例存活**，不是"代码里写着 new Map()"：这里真的渲染两次，
  //    中间 `unmount()` 把源面板整个卸掉，再由**另一个**面板实例取出来。
  //
  // ⚠️ 证伪方式：
  //   · 把 `draftHandoffs` 挪进 `useState`（或让 `takeDraftHandoff` 从组件状态取）
  //     ⇒ 源面板卸载后棒子没了，目标面板收到空 ⇒ 红；
  //   · 把 `depositDraftHandoff(draftHandoffs, …)` 删掉 ⇒ 目标面板收不到 ⇒ 红；
  //   · 把兑现后的 `commitDraftHandoff` 删掉 ⇒ 棒子留着 ⇒ 最后一条"兑现后要清"红。
  const flow = await crossSessionHandoff()

  assert.ok(flow.handoffAtSend !== null, '发出去之后接力区里应当有一根**按目标会话索引**的棒子')
  assert.equal(flow.handoffAtSend.text, HANDOFF_TEXT, '接力区里装的必须是那段原文')
  assert.deepEqual(flow.opened, [TARGET_SESSION], '必须真的请宿主跳过去')
  assert.deepEqual(flow.sourceWrites, [], '交接这条路不该往**源会话**的输入框里写东西')
  assert.equal(flow.survived, true, '源面板卸载之后棒子必须还在 —— 它在模块级 Map 里，不在组件状态里')
  assert.deepEqual(flow.targetWrites, [HANDOFF_TEXT], '目标会话重挂之后必须收到那段原文')
  assert.equal(flow.internals.draftHandoffs.has(TARGET_KEY), false, '兑现之后必须清掉，否则会重复往输入框里塞')
})

test('发到会话：交接带的是原文，不拼源会话输入框里的字', async () => {
  // 取代「发到会话：交接带的是**原文**，不拼源会话输入框里的字」。
  //
  // 原钉子断言 `requestHandoff({ sessionId: plan.targetSessionId, text, book, draft: active })`
  // 且**不是** `draft: activeDraft`。这里直接看交出去的那个 payload：
  //   · `text` 必须逐字等于原文（源会话输入框里那半句话**不许**出现在里面）；
  //   · `draft` 必须取自 NotesView 自己的 state（`active`），不是面板传下来的旧 prop。
  //
  // ⚠️ 证伪方式：
  //   · 在 `requestHandoff({… text: … })` 那里拼上 `existingDraft`
  //     ⇒ `payload.text` 里出现"源会话里打了一半的话" ⇒ 红；
  //   · 把 `draft: active` 改成 `draft: activeDraft` ⇒ 交出去的草稿里 `reply` 还是旧值
  //     （prop 在 NotesView 挂载之后就不再被听了）⇒ 红。
  const rt = await runtime()
  const { internals, react, render, act } = rt
  const handoffs = []
  const writes = []
  const frozen = { ...SOURCE_DRAFT, excerpt: '甲摘抄', thought: '乙感想', reply: null }
  const { fetch } = makeFetch([
    ...NOTES_VIEW_ROUTES.filter(([pattern]) => pattern !== '/drafts'),
    // 「抓取选中文字」会 persist 一次，回来的草稿带着刚抓到的回应 ——
    // `applyActive` 于是把 NotesView 自己的 `active` 更新成**这一份新对象**。
    ['/drafts', (url, options) => (options.method === 'POST'
      ? jsonResponse({ ok: true, draft: { ...frozen, reply: 'AI 的回应文字' } })
      : jsonResponse({ ok: true, drafts: [] }))],
    ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 }, binding: { sessionId: TARGET_SESSION } } }],
    ['/background/fill', { body: { ok: true } }],
    ['/discussions', { body: { ok: true } }],
  ])

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.NotesView, notesProps({
      activeDraft: frozen,
      inputActions: { setDraft: (text) => writes.push(text) },
      existingDraft: '源会话里打了一半的话',
      requestHandoff: (payload) => handoffs.push(payload),
      openSession: () => {},
    })))
    tree = await settle(rt)

    const grabButton = byTitle(tree, '把当前页面上选中的文字填进「AI 回应」')
    await withWindow({ getSelection: () => fakeSelection('AI 的回应文字') }, async () => {
      act(() => grabButton.props.onClick())
    })
    tree = await settle(rt)

    const send = findText(tree, '① 发到会话去聊')
    assert.ok(send !== null, `找不到「发到会话去聊」：${treeText(tree).slice(0, 200)}`)
    act(() => send.props.onClick())
    tree = await settle(rt)
  })

  assert.equal(handoffs.length, 1, '这一趟必须交接出去')
  const payload = handoffs[0]
  assert.equal(payload.sessionId, TARGET_SESSION, '交接要按**目标会话**索引')
  assert.equal(payload.book, BOOK, '书要一起交出去')
  assert.equal(payload.text, '**第 1 章 · 雪夜**\n\n> 甲摘抄\n\n乙感想', '交出去的必须是原文')
  assert.ok(
    !payload.text.includes('源会话里打了一半的话'),
    '把源会话输入框里的字拼进去了 —— 那是读者没打算发出去的东西',
  )
  assert.notEqual(payload.draft, frozen, '交出去的草稿要取本地 state，不是面板传下来的那份 prop')
  assert.equal(payload.draft.reply, 'AI 的回应文字', '读者刚抓回来的回应必须跟着过去')
  assert.deepEqual(writes, [], '走交接时不该往源会话的输入框里写')

  // 另一半：合并「输入框里已有的字」**没有**被丢掉，只是推迟到了兑现那一刻 ——
  // 那边读到的 `existingDraft` 才是**目标会话**自己的。
  //
  // ⚠️ 证伪方式：把 ReaderPanel 兑现那里的 `existing === '' ? decision.text : …` 改成
  //    直接 `setDraft(decision.text)` ⇒ 目标会话正在打的字被冲掉 ⇒ 红。
  const rt2 = await runtime()
  rt2.internals.depositDraftHandoff(rt2.internals.draftHandoffs, TARGET_SESSION, HANDOFF_TEXT, Date.now())
  rt2.internals.rememberSessionView(rt2.internals.sessionViews, TARGET_SESSION, {
    view: 'notes', book: BOOK, draft: SOURCE_DRAFT,
  })
  const delivered = []
  const second = makeFetch(HANDOFF_ROUTES)
  await withFetch(second.fetch, async () => {
    rt2.render(rt2.react.createElement(rt2.internals.ReaderPanel, panelProps({
      sessionId: TARGET_SESSION,
      inputActions: { setDraft: (text) => delivered.push(text) },
      useInput: () => ({ text: '目标会话已有的字' }),
    })))
    await settle(rt2)
  })
  assert.deepEqual(
    delivered,
    [`目标会话已有的字\n\n${HANDOFF_TEXT}`],
    '兑现时必须拼上**目标会话**输入框里已有的字（拼在源会话那一侧就是把话搬错了地方）',
  )
})

test('发到会话：正文的「笔记」按钮真的接上 —— 漏传 prop 会静默失效', async () => {
  // 取代「发到会话：正文的「笔记」按钮必须真的接上 —— 漏传 prop 会静默失效」。
  //
  // `ReaderView` 顶部那颗「笔记」按钮一直在调 `onOpenNotes`，而 `ReaderPanel`
  // 曾经**忘了把这个 prop 传下去**：按钮点了毫无反应。这一类洞渲染层查不出来 ——
  // 组件少收一个 prop 只是**安静地什么都不做**。原钉子靠正则比对"ReaderView 解构
  // 出来的每个 prop 在 ReaderPanel 里都传了"；这里换成两条行为断言：
  //   · **通则**：正文页上每一颗 button 都必须真的接上了 handler（点了没反应的按钮 = 死按钮）；
  //   · **具体**：点「笔记」必须真的进笔记页，而且返回要回正文（来源记成 reader）。
  //
  // ⚠️ 证伪方式：
  //   · 删掉 ReaderPanel 渲染 `ReaderView` 时的 `onOpenNotes: …` ⇒ 那颗按钮的
  //     `props.onClick` 变 undefined ⇒ 通则那条红，点它也不会进笔记页 ⇒ 红；
  //   · 把 `noteOriginRef.current = 'reader'` 删掉 ⇒ 返回落到目录而不是正文 ⇒ 红；
  //   · 删掉 `onOffsetChange: …` ⇒ 进度只落服务端、面板里的进度条永远不动 ⇒ ④ 红。
  const rt = await runtime()
  const { internals, react, render, act, hostProto } = rt
  // 替身里没有真布局：段落与滚动容器的布局值只能自己造（accessor 装在共享原型上，
  // 对**每一轮**渲染出来的节点都生效）。
  let scrollTop = 0
  Object.defineProperty(hostProto, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => { scrollTop = value },
  })
  Object.defineProperty(hostProto, 'offsetTop', { configurable: true, get: () => 0 })

  internals.rememberSessionView(internals.sessionViews, SOURCE_SESSION, { view: 'reader', book: BOOK })
  const { fetch, calls } = makeFetch([...READER_ROUTES, ...NOTES_VIEW_ROUTES])

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.ReaderPanel, panelProps()))
    tree = await settle(rt)

    assert.ok(
      findNode(tree, (node) => node.props?.className === 'drc-article') !== null,
      `面板没落到正文页：${treeText(tree).slice(0, 200)}`,
    )

    // ① 通则：正文页上的每一颗按钮都得有 handler。
    const buttons = collect(tree, (node) => node.type === 'button')
    assert.ok(buttons.length >= 5, `正文页上的按钮太少了（${buttons.length} 颗）—— 锚点已经失效`)
    const dead = buttons.filter((node) => typeof node.props?.onClick !== 'function')
    assert.deepEqual(
      dead.map((node) => node.props?.title ?? node.props?.children),
      [],
      '这些按钮点了没有任何反应（漏传 prop 是**静默**失效）',
    )

    // ② 具体那颗「笔记」。
    const notesButton = byTitle(tree, '读书笔记')
    assert.ok(notesButton !== null, `正文页顶部必须有「笔记」入口：${treeText(tree).slice(0, 300)}`)
    tree = act(() => notesButton.props.onClick())
    tree = await settle(rt)
    assert.ok(
      treeText(tree).includes(`笔记 · ${BOOK.title}`),
      `点了「笔记」必须进笔记页：${treeText(tree).slice(0, 300)}`,
    )

    // ③ 从正文进的笔记页，「返回」要回**正文**（来源没记成 reader 就会掉到目录）。
    const back = byTitle(tree, '返回')
    assert.ok(back !== null, '笔记页必须有「返回」')
    tree = act(() => back.props.onClick())
    tree = await settle(rt)
    assert.ok(
      findNode(tree, (node) => node.props?.className === 'drc-article') !== null,
      `从正文进笔记页，返回必须回正文：${treeText(tree).slice(0, 300)}`,
    )

    // ④ 通则里唯一**不是按钮**的那一项：`onOffsetChange`。漏传它同样是静默失效 ——
    //    进度照样落服务端，但面板里的进度条永远不动（读者得刷新才看得到自己读到哪）。
    const paragraphs = internals.buildParagraphs(READER_CHAPTER_TEXT)
    assert.equal(paragraphs.length, 3, '夹具本身要站得住')
    const barWidth = () => findNode(tree, (node) => node.props?.className === 'drc-progress').props.style.width
    assert.equal(barWidth(), '0%', '夹具前提：进度条从 0% 开始')

    const scroller = findNode(tree, (node) => node.props?.className === 'drc-body drc-body-reader')
    assert.ok(scroller !== null, '找不到滚动容器')
    tree = act(() => scroller.props.onScroll())
    // 进度回写是**防抖**的（`PROGRESS_IDLE_MS`）：等它真的到点。
    await new Promise((resolve) => setTimeout(resolve, 1300))
    tree = await settle(rt)

    const puts = calls.filter((call) => call.options?.method === 'PUT' && call.url.includes('/progress'))
    assert.equal(puts.length, 1, `滚动之后进度要回写一次：${calls.map((c) => `${c.options.method} ${c.url}`).join(' | ')}`)
    assert.equal(
      JSON.parse(puts[0].options.body).charOffset,
      paragraphs[2].offset,
      '回写的是**视口顶部那一段**的偏移（读到哪儿为止）',
    )
    const expected = `${internals.percentOf({ chapterIndex: 0, charOffset: paragraphs[2].offset }, [{ length: 100 }])}%`
    assert.notEqual(expected, '0%', '夹具本身要站得住')
    assert.equal(barWidth(), expected, '进度必须回写到面板 —— 漏传 onOffsetChange 时进度条永远停在原处')
  })
})

test('发到会话：交接必须一并交出 `book`，否则跳过去只会看到书架', async () => {
  // 取代「发到会话：交接必须一并交出 `book`，否则跳过去只会看到书架」。
  //
  // 目标会话的面板可能是**本页面里第一次**打开，它的视图记忆是空的。不把书一起
  // 交出去，读者跳过去看到的是书架，还得再点一次那本书。
  //
  // ⚠️ 证伪方式：把 `requestHandoff` 里的 `book: payload?.book ?? book` 改成
  //    `book: null`（或整段删掉）⇒ 目标会话的面板拿到 `book === null` ⇒ 它退回
  //    书架并去问 `/library` ⇒ 下面两条同时红。
  const flow = await crossSessionHandoff()

  assert.deepEqual(flow.targetWrites, [HANDOFF_TEXT], '先决条件：目标会话真的接住了那段原文')
  assert.equal(
    flow.internals.sessionViews.get(TARGET_KEY)?.book?.bookId,
    BOOK.bookId,
    '交接时给目标会话播下的种子里必须有这本书',
  )
  assert.ok(
    treeText(flow.targetTree).includes(`笔记 · ${BOOK.title}`),
    `目标会话要直接落在**这本书的笔记页**上：${treeText(flow.targetTree).slice(0, 300)}`,
  )
  assert.ok(
    !flow.calls.some((call) => call.url.includes('/library')),
    `跳过去不该退到书架（那说明种子里的书丢了）：${flow.calls.map((call) => call.url).join(' | ')}`,
  )
})

test('发到会话：跳得过去 + 有人接住，两个条件缺一不可', async () => {
  // 取代「发到会话：跳得过去 + 有人接住，两个条件缺一不可」。
  //
  // 只判断"跳得过去"是不够的：若交接通道缺失，`requestHandoff(...)` 会抛
  // TypeError，被同一段 try/catch 吞成一句"放入输入框失败"——而文字已经没了。
  // 那时候读者看到的是"失败"，实际上更糟：跳也跳了、字也没了。
  //
  // ⚠️ 证伪方式：把 `canOpenSession` 改回 `typeof openSession === 'function'`
  //    ⇒ ① 里 `requestHandoff` 是 undefined、会抛 TypeError ⇒ 文字没进任何输入框、
  //    提示变成"放入输入框失败" ⇒ 红；② 里交接 spy 被调用 ⇒ 红。
  const attempt = async ({ openSession, requestHandoff }) => {
    const rt = await runtime()
    const { react, render, act } = rt
    const writes = []
    const handoffs = []
    const { fetch } = makeFetch(SEND_ROUTES)
    let tree = null
    await withFetch(fetch, async () => {
      tree = render(react.createElement(rt.internals.NotesView, notesProps({
        activeDraft: SOURCE_DRAFT,
        inputActions: { setDraft: (text) => writes.push(text) },
        openSession,
        requestHandoff: typeof requestHandoff === 'function'
          ? (payload) => handoffs.push(payload)
          : undefined,
      })))
      tree = await settle(rt)
      const send = findText(tree, '① 发到会话去聊')
      assert.ok(send !== null, `找不到「发到会话去聊」：${treeText(tree).slice(0, 200)}`)
      act(() => send.props.onClick())
      tree = await settle(rt)
    })
    return { writes, handoffs, text: treeText(tree) }
  }

  // ① 跳得过去（宿主给了 `openSession`），但**没人接住**（没有交接通道）。
  const noCatcher = await attempt({
    openSession: () => {},
    requestHandoff: undefined,
  })
  assert.deepEqual(
    noCatcher.writes,
    [HANDOFF_TEXT],
    `没人接住时文字必须留在**当前**输入框（否则它就没了）：${noCatcher.text.slice(0, 300)}`,
  )
  assert.ok(noCatcher.text.includes('放进了**当前**会话的输入框'), '要如实说清它去错了地方')
  assert.ok(noCatcher.text.includes('请手动切过去'), '要指路')
  assert.ok(!noCatcher.text.includes('放入输入框失败'), '不许把它变成一次静默的失败')

  // ② 有人接住（给了 `requestHandoff`），但**跳不过去**（宿主没有 sessions 服务）。
  const noJump = await attempt({
    openSession: null,
    requestHandoff: () => {},
  })
  assert.deepEqual(noJump.handoffs, [], '跳不过去就不该交接 —— 棒子会留在接力区里过期')
  assert.deepEqual(noJump.writes, [HANDOFF_TEXT], '退回当前输入框，并且要说清')
  assert.ok(noJump.text.includes('放进了**当前**会话的输入框'))
})

test('发到会话：守卫只看摘抄与感想，不会被新加的章节行骗过', async () => {
  // 取代「发到会话：守卫只看摘抄与感想，不会被新加的章节行骗过」。
  //
  // 原钉子断言守卫的形态是 `if (excerpt.trim() === '' && thought.trim() === '')`：
  // 在开头加上章节行之后，写成 `text === ''` 的那个判断会让"只有章节、没有摘抄感想"
  // 的输入**通过**（章节行本身就是非空文本）。
  //
  // ⚠️ 证伪方式：
  //   · 把守卫改成 `if (text.trim() === '')` ⇒ ① 里章节行让 text 非空 ⇒ 流程往下走、
  //     真的去补前文记忆（多出 `/background/fill` 请求）⇒ 红；
  //   · 删掉 `lines.push(\`**${heading}**\`)` ⇒ ② 里交出去的正文没有章节行 ⇒ 红。
  const send = async (activeDraft, excerpt, thought) => {
    const rt = await runtime()
    const { react, render, act } = rt
    const writes = []
    const { fetch, calls } = makeFetch(SEND_ROUTES)
    let tree = null
    await withFetch(fetch, async () => {
      tree = render(react.createElement(rt.internals.NotesView, notesProps({
        activeDraft,
        inputActions: { setDraft: (text) => writes.push(text) },
      })))
      tree = await settle(rt)
      if (excerpt !== '') tree = act(() => byId(tree, 'drc-note-excerpt').props.onChange({ target: { value: excerpt } }))
      if (thought !== '') tree = act(() => byId(tree, 'drc-note-thought').props.onChange({ target: { value: thought } }))
      const button = findText(tree, '① 发到会话去聊')
      act(() => button.props.onClick())
      tree = await settle(rt)
    })
    return { writes, calls, text: treeText(tree) }
  }

  // ① 只有章节、没有摘抄与感想：必须拦住，而且**一个请求都不许多打**。
  const empty = await send(
    { chapterIndex: 0, chapterTitle: '雪夜', excerpt: '', thought: '' },
    '', '',
  )
  assert.ok(empty.text.includes('先写点摘抄或感想再发。'), `空内容必须被拦住：${empty.text.slice(0, 300)}`)
  assert.deepEqual(empty.writes, [], '空内容不许进任何输入框')
  assert.deepEqual(
    empty.calls.filter((call) => call.url.includes('/background/fill')),
    [],
    '守卫失效了：只有章节行的输入也往下走了（真去补了前文记忆）',
  )

  // ② 有摘抄与感想：正文开头必须写明章节，摘抄要引用块，感想原样。
  const filled = await send(
    { chapterIndex: 0, chapterTitle: '雪夜', excerpt: '甲摘抄', thought: '乙感想' },
    '甲摘抄\n乙摘抄第二行', '这是我的感想',
  )
  assert.deepEqual(
    filled.writes,
    ['**第 1 章 · 雪夜**\n\n> 甲摘抄\n> 乙摘抄第二行\n\n这是我的感想'],
    '发到会话的正文：章节行 + 引用块 + 感想，一样都不能少',
  )
})

//#endregion
