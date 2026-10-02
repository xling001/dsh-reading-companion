/**
 * 浏览器半边的**运行时行为**（2026-10-03，B 档）。
 *
 * ## 这个文件存在的理由
 *
 * 守卫普查（`npm run guard:census`）实测：`test/` 里 56 条"接线守卫"有 **43 条
 * 挤在 `client.test.mjs`**，而它们几乎每一条的注释里都写着同一句免责声明 ——
 * **"react 替身只取初值、不执行 effect，所以只能静态断言"**。于是那 43 条钉的是
 * `source.includes('h(ImportNotes, { book })')` 这种源码文本：改注释、换行、
 * 重命名局部变量都可能让它红，而真正接错线时它又未必红。
 *
 * 这个文件把那句免责声明**变成不成立**：用 `test/helpers/hooks-runtime.mjs` 的
 * 最小 hooks 运行时真的渲染、真的跑 effect、真的点按钮。于是"组件写好了但没挂上"
 * 这类失效模式可以用**行为**钉住：
 *   · 数据没接住 ⇒ 树里没有那句话；
 *   · 回调没接上 ⇒ 点了之后没有第二个请求；
 *   · 挂错了位置 ⇒ 先序文字的顺序不对。
 *
 * ⚠️ 一条**取代**一条：凡是被这里的行为断言完整覆盖的源码文本钉子，都要在
 * `client.test.mjs` 里**删掉**（`design.md` 的删除铁律：删除 ⇒ 同一提交删掉它的
 * 守卫并跑一次 `guard:census`）。两边都留 = 守卫只增不减，正是要治的病。
 *
 * ⚠️ 反过来，**样式/模板类的文本断言不搬**：它们要钉的就是"那段 CSS 长什么样"，
 * 运行时替身没有 DOM，搬过来只是把断言变弱。
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

/** 在渲染树上找"某个回调 prop 是函数"的节点（按钮/列表都靠它拿到）。 */
function nodeWith(tree, prop) {
  const hit = findNode(tree, (node) => typeof node.props?.[prop] === 'function')
  assert.ok(hit !== null, `树上找不到带 ${prop} 的节点`)
  return hit
}

/**
 * 按**先序**把树里的文字收集成数组。
 *
 * 用来断言"谁画在上面" —— 例如坏文件提示必须排在书列表之前。这正是原来那条
 * 源码文本钉子（比较 `source.indexOf` 的两个位置）想表达的事，但那是"代码里谁先写"，
 * 这是"界面上谁先画"。
 */
function textOrder(tree, out = []) {
  const walk = (item) => {
    if (item === null || item === undefined || typeof item === 'boolean') return
    if (Array.isArray(item)) {
      for (const child of item) walk(child)
      return
    }
    if (typeof item !== 'object') {
      const text = String(item).trim()
      if (text !== '') out.push(text)
      return
    }
    const props = item.props ?? {}
    for (const key of ['title', 'label', 'value']) {
      if (typeof props[key] === 'string' && props[key].trim() !== '') out.push(props[key])
    }
    if (typeof props.children === 'string' && props.children.trim() !== '') out.push(props.children)
    for (const child of item.children ?? []) walk(child)
  }
  walk(tree)
  return out
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

const BOOK = { bookId: '0123456789abcdef', title: '夜行', strategy: 'heading-regex', chapterCount: 2 }

/** 书架那一行要显示的东西（章数 / 大小 / 编码 / 进度）——少一个字段组件就取不到值。 */
const SHELF_BOOK = {
  bookId: 'b1',
  title: '夜行',
  chapterCount: 2,
  byteLength: 2048,
  encoding: 'utf-8',
  progress: null,
}

//#region 运行时自测（这个装置本身也要有护栏）

test('运行时自测：状态真的更新并重渲染，且 setter 引用跨渲染稳定', () => {
  const { react, render, act } = createHooks()
  const setters = []
  const Counter = () => {
    const [n, setN] = react.useState(0)
    setters.push(setN)
    return react.createElement('div', { onClick: () => setN(n + 1) }, `n=${n}`)
  }

  const tree = render(react.createElement(Counter))
  assert.equal(treeText(tree).trim(), 'n=0')

  const after = act(() => nodeWith(tree, 'onClick').props.onClick())
  assert.equal(treeText(after).trim(), 'n=1', 'setState 之后必须重渲染出新的值')
  assert.equal(setters[0], setters[1], 'setter 必须是同一个引用 —— 否则 memo 的浅比较必然失败')
})

test('运行时自测：effect 在渲染后跑、依赖不变不重跑、卸载时清理', () => {
  const { react, render, act, unmount } = createHooks()
  const log = []
  const Comp = (props) => {
    react.useEffect(() => {
      log.push(`effect ${props.tag}`)
      return () => log.push(`cleanup ${props.tag}`)
    }, [props.tag])
    return react.createElement('div', null, 'x')
  }

  render(react.createElement(Comp, { tag: 'a' }))
  assert.deepEqual(log, ['effect a'], '渲染之后 effect 才跑')

  act()
  assert.deepEqual(log, ['effect a'], '依赖没变就不该重跑')

  render(react.createElement(Comp, { tag: 'b' }))
  assert.deepEqual(log, ['effect a', 'cleanup a', 'effect b'], '依赖变了：先清理、再跑新的')

  unmount()
  assert.deepEqual(log, ['effect a', 'cleanup a', 'effect b', 'cleanup b'], '卸载要跑清理')
})

test('运行时自测：memo 浅比较命中时真的跳过渲染', () => {
  const { react, render, act } = createHooks()
  const Inner = react.memo((props) => react.createElement('div', null, props.label))
  const Outer = () => {
    const [n, setN] = react.useState(0)
    return react.createElement(
      'div',
      { onClick: () => setN(n + 1) },
      react.createElement(Inner, { label: '固定' }),
    )
  }

  const tree = render(react.createElement(Outer))
  assert.equal(Inner.renders, 1)

  act(() => nodeWith(tree, 'onClick').props.onClick())
  assert.equal(Inner.renders, 1, 'props 没变就不该重渲染')
  assert.ok(Inner.bailouts >= 1, '跳过的次数要记得住')
})

test('运行时自测：effect 里无条件 setState 会**报错**，不是挂死', () => {
  const { react, render } = createHooks()
  const Bad = () => {
    const [n, setN] = react.useState(0)
    react.useEffect(() => { setN(n + 1) })
    return react.createElement('div', null, String(n))
  }
  assert.throws(() => render(react.createElement(Bad)), /渲染没有收敛/)
})

//#endregion

//#region 行为断言（取代 client.test.mjs 里同名的源码文本钉子）

test('书架：`/health` 报上来的坏文件真的画出来了（effect 跑通才算）', async () => {
  // ⚠️ 这正是原来那条"接线守卫：书架真的把 /health.quarantined 显示出来了"想钉的事，
  //    但它只能断言 `source.includes('quarantineNoticeText(health')` —— 数据接住了
  //    却没画、或者画在了书列表下面，它都发现不了。现在真的取数、真的渲染。
  const { react, render, act, internals } = await runtime()
  const corrupt = 'bindings.json.corrupt-2026-10-02T10-00-00-000Z'
  const { fetch, calls } = makeFetch([
    ['/library', { body: { ok: true, books: [SHELF_BOOK] } }],
    ['/health', { body: { ok: true, quarantined: [{ base: 'bindings.json', file: corrupt }] } }],
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ShelfView, { onOpen: () => {} }))
    const tree = await settle({ act })
    const text = treeText(tree)

    assert.ok(calls.some((call) => call.url.includes('/health')), '得真的去问过 /health')
    assert.ok(text.includes(corrupt), `坏文件名必须出现在书架上（读者得能找到它）：${text.slice(0, 300)}`)
    assert.ok(text.includes('没删'), '要说清坏文件是挪开不是删掉')
  })
})

test('书架：坏文件提示画在**书列表之上**（书架满的时候也看得到）', async () => {
  // 进度丢光的读者书架往往是满的 —— 提示只画在"空书架"那一支里等于看不见。
  // 原来那条钉子比较的是源码里两个 `indexOf` 的先后（"代码里谁先写"），
  // 这里比的是**渲染顺序**（"界面上谁先画"）。
  const { react, render, act, internals } = await runtime()
  const corrupt = 'bindings.json.corrupt-x'
  const { fetch } = makeFetch([
    ['/library', { body: { ok: true, books: [SHELF_BOOK] } }],
    ['/health', { body: { ok: true, quarantined: [{ base: 'bindings.json', file: corrupt }] } }],
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ShelfView, { onOpen: () => {} }))
    const tree = await settle({ act })
    const lines = textOrder(tree)
    const noticeAt = lines.findIndex((line) => line.includes(corrupt))
    const bookAt = lines.findIndex((line) => line.includes('夜行'))

    assert.ok(noticeAt !== -1, `提示不在树上：${lines.slice(0, 20).join(' | ')}`)
    assert.ok(bookAt !== -1, '书本身也要画出来（否则这条断言没有意义）')
    assert.ok(noticeAt < bookAt, `提示必须排在书列表之前（提示 ${noticeAt} / 书 ${bookAt}）`)
  })
})

test('目录页：导入说明真的挂在目录页上，点开能看到来源与编码（组件写好了但没挂上 = 等于没写）', async () => {
  // 取代"接线守卫：目录页真的渲染了「导入说明」（数据早在书架上，缺的只是这一处入口）"。
  // 那条断言的是源码里出现 `h(ImportNotes, { book })`；这里真的渲染目录页、真的点开它。
  // 比原来强的地方：入口存在**且能用**，展开后那几行确实来自这本书的数据。
  //
  // 原钉子还附带两条"零后端"的声明（`function importNotes` 是纯函数、不许新增
  // `/import-notes` 路由）。这里用**行为**覆盖它俩：路由表是**空的**，`makeFetch`
  // 碰到没配过的请求会直接抛错 ⇒ 目录页多打一个请求，这条用例就红。
  const { react, render, act, internals } = await runtime()
  const { fetch, calls } = makeFetch([])
  const book = {
    ...BOOK,
    sourceName: '夜行.txt',
    encoding: 'gb18030',
    encodingConfidence: 'fallback',
    warnings: ['GB18030 解码出现 3.1% 替换字符，可能仍是乱码'],
  }
  const props = {
    book,
    chapters: [],
    progress: null,
    loading: false,
    error: null,
    onBack: () => {},
    onPick: () => {},
    onOpenCompanion: () => {},
    onOpenNotes: () => {},
  }

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.TocView, props))
    const toggle = findNode(tree, (node) => node.props?.title === '导入这份正文时交代过的事')
    assert.ok(toggle !== null, `目录页上没有「导入说明」的入口：${treeText(tree).slice(0, 300)}`)
    assert.ok(treeText(toggle).includes('导入说明（3 条）'), '入口要说清有几条')
    assert.ok(!treeText(tree).includes('来源文件'), '折叠状态下不该铺开')

    // "读者点了这一条" —— 展开。
    tree = act(() => toggle.props.onClick())
    const text = treeText(tree)
    assert.ok(text.includes('来源文件：夜行.txt'), `要说清是哪个文件：${text.slice(0, 400)}`)
    assert.ok(text.includes('GB18030'), '要说清编码是怎么定的')
    assert.deepEqual(calls, [], '这些数据全来自 `/library` 的条目 —— 目录页不该为它多打任何请求')
  })
})

test('面板：书友设定与讨论历史真的渲染在树上（区块写了没放进树 = 等于没写）', async () => {
  // 取代"面板：书友设定与讨论历史都在 CompanionView 里真的渲染出来"。那条只查
  // 源码里有没有这四个词；这里断言它们**真的出现在渲染树上**，而且设定取回来要显示。
  const { react, render, act, internals } = await runtime()
  const { fetch, calls } = makeFetch([
    ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 } } }],
    // 背景认识的形状是**宿主答复本身**：`covered.first/last`、`characters`、`gap`，
    // 组件直接拿它渲染"记忆到第 N 章 · 已知人物 M 位"。
    ['/background', { body: { ok: true, covered: { first: 1, last: 2 }, gap: null, characters: [], markdown: '', exists: true } }],
    ['/persona', { body: { ok: true, text: '你是一位安静的书友' } }],
    ['/discussions', { body: { ok: true, discussions: [] } }],
    ['/settings', { body: { ok: true, config: {} } }],
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.CompanionView, { book: BOOK, sessionId: 'session-abc', onBack: () => {} }))
    const tree = await settle({ act })
    const text = treeText(tree)

    for (const label of ['书友设定（你写给 AI 的）', '讨论历史', '压缩背景认识', '人物卡']) {
      assert.ok(text.includes(label), `面板里缺少「${label}」：${text.slice(0, 400)}`)
    }
    // 原钉子还用正则钉过 `callApi(.../persona)` 这条路由。这里换成行为：
    // 设定真的从 `/books/<id>/persona` 取回来了（路由写错 ⇒ 这条就红）。
    assert.ok(
      calls.some((call) => call.url.includes(`/books/${BOOK.bookId}/persona`)),
      `设定必须走 persona 路由：${calls.map((call) => call.url).join(' | ')}`,
    )
  })
})

test('笔记翻页：点「下一页」真的压栈并带上新游标再取一页（状态机跑通才算）', async () => {
  // 取代"笔记翻页：上一页/下一页真的接上了（静态接线）"里那几条 `assert.match(source, …)`。
  // 原来钉的是"游标存成栈、下一页 = 压栈、回调接进 NoteList"这三句源码特征；
  // 现在直接**点一下**，看第二次请求有没有真的带上宿主给的游标。
  const { react, render, act, internals } = await runtime()
  const note = (id) => ({
    id, heading: '第 1 章 雪', chapterIndex: 0, tags: [], excerpt: `${id} 的摘抄`,
    thought: '', reply: '', hasReply: false, trashed: false,
  })
  const pageOne = { ok: true, notes: [note('n1')], total: 30, hasMore: true, nextCursor: 'n1' }
  const pageTwo = { ok: true, notes: [note('n2')], total: 30, hasMore: false, nextCursor: null }
  let notesCalls = 0
  const { fetch, calls } = makeFetch([
    ['/drafts', { body: { ok: true, drafts: [] } }],
    ['/location', { body: { ok: true, location: null } }],
    ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 } } }],
    ['/notes?limit=', () => {
      notesCalls += 1
      return new Response(JSON.stringify(notesCalls === 1 ? pageOne : pageTwo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }],
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.NotesView, { book: BOOK, sessionId: 'session-abc', activeDraft: null, onBack: () => {} }))
    let tree = await settle({ act })

    const notesUrls = () => calls.filter((call) => call.url.includes('/notes?limit='))
    assert.equal(notesUrls().length, 1, `进笔记页先取第一页：${notesUrls().map((c) => c.url).join(' | ')}`)
    assert.ok(!notesUrls()[0].url.includes('before='), '第一页不该带游标')

    // 翻页按钮的 `title` 是 `更旧的一页` / `更新的一页`（见 NoteList）——
    // 这里找到的是**界面上那个真按钮**，点它就是 `onClick`，与真人操作同一条路径。
    const nextButton = findNode(tree, (node) => node.props?.title === '更旧的一页')
    assert.ok(nextButton !== null, '笔记列表底部必须有「更旧 →」这个按钮')
    assert.equal(nextButton.props.disabled, false, '还有更旧的一页时按钮必须可以点')
    const prevButton = findNode(tree, (node) => node.props?.title === '更新的一页')
    assert.equal(prevButton.props.disabled, true, '第 1 页没有更新的一页，按钮要禁用')

    act(() => nextButton.props.onClick())
    tree = await settle({ act })

    assert.equal(notesUrls().length, 2, `点下一页要再取一页：${notesUrls().map((c) => c.url).join(' | ')}`)
    assert.ok(
      notesUrls()[1].url.includes(`before=${encodeURIComponent('n1')}`),
      `第二页必须带上宿主给的 nextCursor：${notesUrls()[1].url}`,
    )
    const text = treeText(tree)
    assert.ok(text.includes('n2'), `列表要换成第二页的内容：${text.slice(0, 200)}`)
    assert.ok(!text.includes('n1 的摘抄'), '翻页是**替换**，不是把两页摊成一长条')
  })
})

//#endregion

//#region 正文页：角标摘要、已读完常驻标记、位置恢复

/** 正文页要的那些路由。`chapterText` 决定段落切出来是什么。 */
function readerRoutes({ chapterText = '第一段文字。\n\n第二段文字。\n\n第三段文字。', chapterNotes = [] } = {}) {
  return [
    ['/chapters/', { body: { ok: true, chapter: { index: 0, title: '第一章 雪', text: chapterText } } }],
    ['/notes/chapter/', { body: { ok: true, notes: chapterNotes } }],
    ['/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 } } }],
  ]
}

function readerProps(extra = {}) {
  return {
    book: BOOK,
    chapters: [{ index: 0, title: '第一章 雪', length: 100, volume: null, kind: 'chapter' }],
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

test('正文页角标：只给一行摘要，不把笔记全文铺进正文流', async () => {
  // 取代"接线守卫：正文页角标只给摘要（不再把笔记全文铺进正文流）"里那三条源码切片
  // （`block.includes('noteSummary(note)')` / `!block.includes('note.thought')` …）。
  // 那三条问的是"那段代码里引用了哪个字段"；这里问的是**屏幕上出现了多少字**。
  // 读者实测笔记 522–1183 字/条，铺进正文流会把小说顶下去 —— 所以这是真问题。
  const { react, render, act, internals } = await runtime()
  const longThought = '这是一段很长的感想。'.repeat(40)
  const { fetch } = makeFetch(readerRoutes({
    chapterNotes: [{ id: 'n1', chapterIndex: 0, heading: '第一章 雪', excerpt: '第一段文字。', thought: longThought, tags: [], hasReply: false }],
  }))

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.ReaderView, readerProps()))
    tree = await settle({ act })

    const toggle = findText(tree, '本章你记过 1 条')
    assert.ok(toggle !== null, `正文页该有「本章你记过」的入口：${treeText(tree).slice(0, 300)}`)
    assert.ok(!treeText(tree).includes('这是一段很长的感想。'), '折叠时正文流里不该有感想')

    tree = act(() => toggle.props.onClick())
    const item = findText(tree, '收起本章的 1 条笔记')
    assert.ok(item !== null, '展开后按钮要改成「收起本章的」')
    const text = treeText(tree)
    assert.ok(!text.includes(longThought), '⚠️ 正文页不承载长文 —— 全文不许出现（读者裁定）')
    assert.ok(!text.includes(longThought.slice(0, 200)), '被截断的摘要也不该长到两百字')
    assert.ok(text.includes('…'), '要留一行摘要并标出它被截断了')
  })
})

test('正文页：`finished` 为真时「已解锁全书」常驻可见（漏传 prop 是不报错的洞）', async () => {
  // 取代"接线守卫：已读完解锁在两处都常驻可见"里 `source.includes('已解锁全书')` 那一半。
  // ⚠️ 这条的失效模式是**静默**的：渲染层不认识"哪个 prop 忘了传"，漏了只是不显示。
  const { react, render, act, internals } = await runtime()
  const { fetch } = makeFetch(readerRoutes())

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderView, readerProps()))
    const locked = await settle({ act })
    assert.ok(!treeText(locked).includes('已解锁全书'), '没读完就不该挂解锁标记')

    render(react.createElement(internals.ReaderView, readerProps({ finished: true })))
    const tree = await settle({ act })
    const badge = findText(tree, '⚠️ 已解锁全书')
    assert.ok(badge !== null, `解锁必须常驻可见：${treeText(tree).slice(0, 300)}`)
    assert.ok(
      String(badge.props.title).includes('全文对陪读 AI 可见'),
      '悬停要说清"解锁的是什么"（读者得能自己判断要不要收回）',
    )
  })
})

test('位置恢复：正文到达那一趟真的落位，正文没到时不落位', async () => {
  // 取代"位置恢复：effect 必须依赖 paragraphs，且不许退回一次性旗标"。
  // 原来读的是正则抠出来的**依赖数组文本**；这里直接观察组件对滚动容器的写入：
  // 依赖数组里漏掉 `paragraphs` ⇒ 正文到达那一趟不会重跑 ⇒ 永远落不回原处。
  const { react, render, act, internals, hostProto } = await runtime()
  const chapterText = '第一段文字。\n\n第二段文字。\n\n第三段文字。'
  const paragraphs = internals.buildParagraphs(chapterText)
  assert.equal(paragraphs.length, 3, '夹具本身要站得住')

  // 观察"组件往滚动容器上写了什么"。宿主节点共享一个原型，所以 accessor 对
  // **每一轮**渲染出来的节点都生效（见 hooks-runtime 里 hostProto 的说明）。
  const writes = []
  let scrollTop = -1
  Object.defineProperty(hostProto, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => { scrollTop = value; writes.push(value) },
  })
  // 段落节点的 `offsetTop` 是真实布局给的 —— 替身里用固定值代替，好让写入值可断言。
  Object.defineProperty(hostProto, 'offsetTop', { configurable: true, get: () => 480 })

  const { fetch } = makeFetch(readerRoutes({ chapterText }))
  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderView, readerProps({ initialOffset: paragraphs[1].offset })))
    assert.deepEqual(writes, [], '⚠️ 正文还没到（paragraphs 是空的）时不该落位')

    const tree = await settle({ act })
    assert.equal(writes.length, 1, `正文到达那一趟必须落位一次：${JSON.stringify(writes)}`)
    assert.equal(writes[0], 480, '要滚到目标那一段的位置上（第 2 段，不是章首）')

    // 再渲染一次（依赖没变）不该重复落位 —— 这正是"位置账本键"承担的事，
    // 也是"别退回一次性布尔旗标"那条反向断言真正想保的东西。
    act()
    assert.equal(writes.length, 1, '依赖没变不该再滚一次')
    assert.ok(treeText(tree).includes('第二段文字。'), '正文本身要画出来')

    // 换章：位置账本的键变了，必须**重新落位** —— 依赖数组里漏了 chapterIndex /
    // initialOffset 的话，读者翻到下一章就永远停在章首。
    render(react.createElement(internals.ReaderView, readerProps({ chapterIndex: 1, initialOffset: paragraphs[2].offset })))
    await settle({ act })
    assert.ok(writes.length >= 2, `换章必须重新落位：${JSON.stringify(writes)}`)
    assert.equal(writes[writes.length - 1], 480, '落位落到的仍是目标那一段')
  })
})

//#endregion
