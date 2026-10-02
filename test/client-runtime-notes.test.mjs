/**
 * 笔记页那半边（`NotesView` / `NoteList` / `ReaderPanel` 的笔记接线）的**运行时行为**断言。
 *
 * ## 这个文件存在的理由
 *
 * `client-runtime.test.mjs` 把"react 替身只取初值、不跑 effect，所以只能静态断言"那句
 * 免责声明变成了不成立；这个文件接着把**笔记页剩下的 6 条源码文本钉子**逐条换成
 * 行为断言。它们原来都挤在 `client.test.mjs` 里，钉的是
 * `source.includes("'接着写'")` / `source.includes('discardTarget')` /
 * `source.includes('const fillRequest = callApi(')` 这类**代码形态**：
 * 改注释、换行、重命名局部变量都可能让它红，而真正接错线时它又未必红。
 *
 * 换成行为之后，同样的失效模式变成**看得见的**：
 *   · 回调没接上   ⇒ 点了之后没有那个请求 / 树里没有那句话；
 *   · 状态没接住   ⇒ 点开 tab 之后清单还是空的；
 *   · 画错了位置   ⇒ 先序文字的顺序不对。
 *
 * ## 一条取代一条（谁取代谁写在每条用例的第一段注释里）
 *
 * ⚠️ 与 `client-runtime.test.mjs` 同一条规矩：被完整覆盖的源码文本钉子要在
 * `client.test.mjs` 里**删掉**（`design.md` 的删除铁律）。两边都留 = 守卫只增不减。
 *
 * ⚠️ **没转的**也写在原地（用例注释里那段"⚠️ 没能转"）：样式 / 模板 / 为了别的
 * **静态**用例能认出路径而刻意保持的字面量形态，运行时替身既没有 DOM 也没有
 * "源码文本"，硬凑一条只会得到一条**不会红的假守卫**（这个仓库的教训：假红比不测更坏）。
 *
 * ## 可证伪性
 *
 * 每条用例的注释里都有一句"改坏什么它会红" —— 这是本仓库测试的既有风格，
 * 也是这次转换的验收标准：写出来的断言必须**真的能红**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule } from './helpers/client-loader.mjs'
import { createHooks, findNode, makeFetch, treeText } from './helpers/hooks-runtime.mjs'

/** 造一个"能真跑"的客户端模块 + 渲染器。 */
async function runtime() {
  const hooks = createHooks()
  const mod = await loadClientModule(hooks.react)
  return { ...hooks, internals: mod.__internals }
}

/**
 * 同上，但**记录每一次 `h()` 造出来的元素**。
 *
 * 为什么需要它：`key` 只存在于"父组件造出来的那个元素"上，而渲染器会把元素
 * 就地换成它的输出 —— 渲染树里再也看不到它。要断言"`NotesView` 的 key 是什么"，
 * 只能在 `createElement` 那一刻看。
 *
 * ⚠️ 这**不是**在断言源码文本：元素是**组件真的算出来的**产物，而下面的用例会
 * 比较"保存前后"与"换编辑目标前后"的 key —— 源码文本钉子根本做不到这件事。
 */
async function runtimeWithElements() {
  const hooks = createHooks()
  const elements = []
  const inner = hooks.react.createElement
  hooks.react.createElement = (type, props, ...children) => {
    const element = inner(type, props, ...children)
    elements.push(element)
    return element
  }
  const mod = await loadClientModule(hooks.react)
  return { ...hooks, internals: mod.__internals, elements }
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

/** 造一个 200 JSON 响应（路由处理函数直接返回它）。 */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 节点**自己那一层**的文字（不含后代）。
 *
 * 为什么要"自己那一层"：`treeText` 会连后代一起拼，于是任何祖先都会命中
 * "这棵树里有「接着写」" —— 那样"点的是哪一颗按钮"就无从谈起。
 */
function ownTexts(node) {
  const props = node.props ?? {}
  const texts = [props.children, props.title, props.label, props.value]
    .filter((value) => typeof value === 'string')
  for (const child of node.children ?? []) {
    if (typeof child === 'string') texts.push(child)
  }
  return texts
}

/** 树上那一颗**文案正好是** `text` 的按钮（`h('button', …, '文案')`）。 */
function button(tree, text) {
  const hit = findNode(tree, (node) => node.type === 'button' && ownTexts(node).includes(text))
  assert.ok(hit !== null, `树上找不到「${text}」这颗按钮：${treeText(tree).slice(0, 400)}`)
  return hit
}

/** 数一数树上满足条件的节点有几个（"标记只该出现在那一条上"靠它）。 */
function countNodes(tree, predicate) {
  let count = 0
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (predicate(node)) count += 1
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return count
}

/** 二级确认条（`confirmBar` 的根）。找不到就是"该确认的没确认"。 */
function confirmBarOf(tree) {
  const bar = findNode(tree, (node) => node.props?.className === 'drc-confirm')
  assert.ok(bar !== null, `确认条没出现（该确认的动作被一键执行了？）：${treeText(tree).slice(0, 300)}`)
  return bar
}

/** 树上"含某段文字的那一行"（草稿 `li` / 笔记 `div` 共用 `drc-note-item`）。 */
function rowWith(tree, text) {
  const hit = findNode(tree, (node) => node.props?.className === 'drc-note-item' && treeText(node).includes(text))
  assert.ok(hit !== null, `找不到「${text}」那一行：${treeText(tree).slice(0, 400)}`)
  return hit
}

/**
 * 按**先序**把树里的文字收集成数组。
 *
 * 用来断言"谁画在上面"：原来那条"三个 tab 常驻在列表区之前"的钉子比的是源码里两个
 * `indexOf` 的先后（"代码里谁先写"），这里比的是**渲染顺序**（"界面上谁先画"）。
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

const BOOK = { bookId: '0123456789abcdef', title: '夜行', strategy: 'heading-regex', chapterCount: 2 }
const LOCATION = { ok: true, location: { dir: 'D:\\陪读_夜行', scope: 'workspace', migrated: [] } }

/** 笔记页首屏那三样（草稿 / 笔记首屏 / 落点）—— 每一条用例都要它们，否则挂载那一趟就报错。 */
function firstScreen({ drafts = [], notes = null } = {}) {
  return [
    ['/drafts', () => json({ ok: true, drafts })],
    ['/notes?limit=', () => json(notes ?? { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null })],
    ['/location', () => json(LOCATION)],
  ]
}

/** 笔记页挂载（`activeDraft` 决定编辑区初值）。 */
function mountNotes(react, internals, activeDraft = null) {
  return react.createElement(internals.NotesView, {
    book: BOOK,
    sessionId: 'session-abc',
    activeDraft,
    onBack: () => {},
  })
}

//#region ① 笔记页按钮：主按钮 / 暂存出口
// 取代 client.test.mjs「笔记页按钮：落盘是唯一主按钮，「保存草稿」是暂存出口」。
//#endregion

test('笔记页按钮（运行时）：落盘那颗是主按钮，「保存草稿」是暂存出口且真的只存草稿', async () => {
  // 取代上面那条。它钉的是四条源码文本：`保存草稿` 这个词在、旧文案
  // `'先记着，以后再写'` 不在、title 里有 `不动你的笔记文件`、以及一条**正则**
  // 匹配主按钮那几行。这里换成：真的渲染出来、找到那两颗按钮、**点一下保存**。
  //
  // 比原来强的地方：「暂存出口」这四个字原来只靠 title 里有一句话来表达；现在
  // 点下去会**真的发一条 POST /drafts、且不发 commit** —— "它只存草稿、不落盘"
  // 是被观察到的，不是被读到的。
  //
  // ⚠️ 旧守卫里还有一条 `!source.includes("onClick: save }, '保存草稿'")` —— 那是**排版**
  //    断言（同一颗按钮写成多行它就"通过"，写成一行就"失败"），行为上没有任何对应物，
  //    刻意不搬。它想保的东西（保存草稿挂的是 `save`）已由"点它 → POST /drafts、
  //    不发 commit"完整覆盖。
  //
  // 可证伪：① 把 `写入笔记` 那颗按钮的 `className` 里的 `drc-btn-primary` 删掉 ⇒
  // 第一条红；② 把「保存草稿」也改成 `drc-btn-primary` ⇒ 第二条红；③ 把 title 里
  // 的「不动你的笔记文件」删掉 ⇒ 第三条红；④ 把「保存草稿」的 `onClick` 从 `save`
  // 改成 `commit` ⇒ "没有 commit 请求"那条红。
  const { react, render, act, internals } = await runtime()
  const draftsPosted = []
  const { fetch, calls } = makeFetch([
    ['/drafts', (url, options) => {
      if (options.method === 'POST') {
        draftsPosted.push(JSON.parse(options.body))
        return json({
          ok: true,
          draft: { draftId: 'd1', excerpt: '一段摘抄', thought: '', reply: null, tags: [], chapterIndex: null },
          suggestedTags: [],
        })
      }
      return json({ ok: true, drafts: [] })
    }],
    ...firstScreen(),
  ])

  await withFetch(fetch, async () => {
    render(mountNotes(react, internals))
    const tree = await settle({ act })

    const commit = button(tree, '写入笔记')
    const save = button(tree, '保存草稿')

    assert.match(
      String(commit.props.className),
      /drc-btn-primary/,
      '「写入笔记」必须落盘那颗主按钮 —— 它是唯一的"完成"动作',
    )
    assert.match(String(commit.props.title), /写进笔记/, '悬停要说清它写进哪儿')
    assert.ok(
      !String(save.props.className).includes('drc-btn-primary'),
      '「保存草稿」是暂存出口，不该与落盘那颗抢主色',
    )
    assert.ok(
      String(save.props.title).includes('不动你的笔记文件'),
      `草稿按钮的 title 要写明它不碰笔记文件（读者问的正是这件事）：${save.props.title}`,
    )
    assert.ok(!treeText(tree).includes('先记着，以后再写'), '旧按钮文案不该再出现')

    // "暂存出口"的行为定义：点它只写草稿库，一个字都不落进 notes.md。
    const before = calls.length
    act(() => save.props.onClick())
    const after = await settle({ act })
    assert.equal(draftsPosted.length, 1, '「保存草稿」要真的 POST 一条草稿')
    assert.equal(draftsPosted[0].draftId, undefined, '还没保存过的起稿没有 id，POST 不带 draftId（让宿主新建）')
    assert.ok(
      !calls.slice(before).some((call) => call.url.includes('/commit')),
      `保存草稿不该顺手落盘：${calls.slice(before).map((c) => c.url).join(' | ')}`,
    )
    assert.ok(treeText(after).includes('草稿已保存。'), '存住了要说出来')
  })
})

//#region ①b 保存草稿的响应里缺 `draft`：不许白屏
//#endregion

test('保存草稿（运行时）：宿主响应里没有 draft 时不许白屏 —— active 要归一成 null，不是 undefined', async () => {
  // 这条钉的是一类**只在异常形状下才炸**的接线：`applyActive(data.draft)` 把响应里那个
  // 字段**原样**塞进 state。宿主今天总会回 `draft`，但"今天总会"不是契约 —— 一旦它不回
  // （旧宿主 / 出错分支 / 字段改名），`active` 就变成 **`undefined`**，而下游那些守卫
  // 只写了 `active === null`：
  //   · `dirty` 是 `active === null ? … : (excerpt !== (active.excerpt ?? '') …)`
  //     ⇒ `undefined` 走 **else 分支**，读 `undefined.excerpt` 直接抛；
  //   · `active === null ? null : active.chapterIndex`（三处）同理。
  // ⇒ 组件抛错 = **白屏**，而且是"保存成功了反而白屏"这种最难查的形状。
  //
  // 可证伪：把 `applyActive` 里的 `?? null` 删掉 ⇒ 这条立刻红（TypeError 从 `settle` 冒出来）。
  const { react, render, act, internals } = await runtime()
  const { fetch } = makeFetch([
    // ⚠️ 关键：POST **不回 `draft`**（只有 ok + suggestedTags）。
    ['/drafts', (url, options) => (options.method === 'POST'
      ? json({ ok: true, suggestedTags: [] })
      : json({ ok: true, drafts: [] }))],
    ...firstScreen(),
  ])

  await withFetch(fetch, async () => {
    render(mountNotes(react, internals))
    const tree = await settle({ act })
    act(() => button(tree, '保存草稿').props.onClick())
    const after = await settle({ act })
    // 没抛错本身就是"没白屏"的判据（抛了就根本走不到这一行）；
    // 再钉一句该说的话 —— 它同时证明这条 Promise 链是**跑完**了，而不是半路断掉。
    assert.ok(treeText(after).includes('草稿已保存。'), '存住了要说出来（白屏时这句根本到不了）')
  })
})

test('笔记页挂载（运行时）：activeDraft 传成 undefined 时不许在首屏就白屏', async () => {
  // 与上一条**同一类不变量**的另一个入口：`useState(activeDraft ?? null)`。
  // 调用方转发一个可能缺失的字段（`activeDraft={panel.activeDraft}` 这种形状很常见）时，
  // `undefined` 会一路进 state，而 `dirty` / `chapterIndex` 那几处 `active === null` 守卫
  // 在**首屏**就炸 —— 比上一条更早（上一条要等一次保存往返）。
  // ⚠️ 刻意**不用** `mountNotes()`：它的形参默认值 `= null` 会把 `undefined` 吃掉，
  //    于是"传 undefined"这件事根本到不了组件 —— 那就成了一条**恒真的假守卫**。
  //
  // 可证伪：把 `useState(activeDraft ?? null)` 里的 `?? null` 删掉 ⇒ 这条红。
  const { react, render, act, internals } = await runtime()
  const { fetch } = makeFetch(firstScreen())

  await withFetch(fetch, async () => {
    render(react.createElement(internals.NotesView, {
      book: BOOK,
      sessionId: 'session-abc',
      activeDraft: undefined,
      onBack: () => {},
    }))
    const tree = await settle({ act })
    // `button()` 找不到那颗按钮会**自己断言失败** ⇒ 这一句同时是"首屏真的画出来了"的判据
    // （抛错时根本走不到这里）。刻意不写 `assert.ok(true)` —— 那是恒真的装饰。
    button(tree, '保存草稿')
  })
})

//#region ② 草稿待落盘清单 / 未选定原文标记 / 丢弃确认
// 取代 client.test.mjs「接线守卫：草稿待落盘清单、未选定原文标记、丢弃确认（v1.54）」。
//#endregion

const DRAFT_ONE = {
  draftId: 'd1', chapterIndex: 0, excerpt: '第一条草稿', thought: '', reply: null, tags: [],
  updatedAt: '2026-10-02T10:00:00',
}
const DRAFT_TWO = {
  draftId: 'd2', chapterIndex: null, excerpt: '第二条草稿', thought: '', reply: null, tags: [],
  updatedAt: '2026-10-01T09:30:00',
}

test('草稿清单（运行时）：未落盘的清单、未选定原文标记、丢弃必须先确认那一条', async () => {
  // 取代上面那条。它钉了七处源码文本（空态引导、`formatWhen(draft.updatedAt)`、
  // `'接着写'`、`'未选定章'`、`未选定原文`、`discardTarget`、以及"确认后丢的是
  // 确认条点名的那一条"那条正则）。这里全部换成"点开草稿 tab 看到什么 / 点了之后
  // 发出什么请求"。
  //
  // ⚠️ 比原来强的一处：`!source.includes('onClick: discard }')`（"丢弃不该再是一键
  // 执行"）现在被**观察**到了 —— 点「丢弃草稿」之后 DELETE 请求数必须是 0。
  //
  // 可证伪：① 把 `NoteList` 里 `未选定原文` 那个 badge 删掉 ⇒ 第一条红；② 把草稿行里的
  // `formatWhen(draft.updatedAt)` 换成固定文字 ⇒ 时间那条红；③ 把 `'未选定章'` 删掉 ⇒
  // 红；④ 把「丢弃草稿」的 `onClick` 从 `setDiscardTarget(draft)` 改成直接
  // `discardDraft(draft)` ⇒ "不该一键执行"那条红；⑤ 把确认条的
  // `discardDraft(discardTarget)` 改成 `discardDraft(active)` ⇒ 删错那一条，红。
  const { react, render, act, internals } = await runtime()
  const deleted = []
  const { fetch } = makeFetch([
    ['/drafts', (url, options) => {
      if (options.method === 'DELETE') {
        deleted.push(url)
        return json({ ok: true })
      }
      return json({ ok: true, drafts: [DRAFT_ONE, DRAFT_TWO] })
    }],
    ...firstScreen({
      notes: {
        ok: true,
        notes: [
          { id: 'n1', heading: '第 1 章 雪', chapterIndex: 0, charOffset: 0, excerpt: '某段原文', thought: '针对这一段的感想', reply: '', tags: [], hasReply: false },
          { id: 'n2', heading: '读书笔记', chapterIndex: null, charOffset: null, excerpt: '', thought: '对整本书的感想', reply: '', tags: [], hasReply: false },
        ],
        total: 2,
        hasMore: false,
        nextCursor: null,
      },
    }),
  ])

  await withFetch(fetch, async () => {
    render(mountNotes(react, internals))
    let tree = await settle({ act })

    // ---- 未选定原文：没章号、也没摘抄的那条必须自己说明白 ----
    assert.equal(
      countNodes(tree, (node) => ownTexts(node).includes('未选定原文')),
      1,
      `只有"对整本书的感想"那条该带这个标记（否则它和"针对某一段"的混在一起）：${treeText(tree).slice(0, 400)}`,
    )

    // ---- 草稿 tab ----
    tree = act(() => button(tree, '草稿').props.onClick())
    tree = await settle({ act })
    const text = treeText(tree)
    assert.ok(text.includes('未选定章'), `没选章的草稿要说清它挂在哪儿：${text.slice(0, 400)}`)
    assert.ok(
      text.includes('2026-10-02 10:00'),
      `草稿清单要显示最后改动时间（字段真实存在：upsertDraft 写 updatedAt）：${text.slice(0, 400)}`,
    )
    assert.equal(countNodes(tree, (node) => ownTexts(node).includes('接着写')), 2, '每条草稿都要能载回编辑区')
    assert.equal(countNodes(tree, (node) => ownTexts(node).includes('丢弃草稿')), 2, '每条草稿都要有丢弃入口（v1.61）')

    // ---- 丢弃：先要求确认，且确认条必须知道自己在确认哪一行 ----
    const second = rowWith(tree, '第二条草稿')
    tree = act(() => button(second, '丢弃草稿').props.onClick())
    assert.deepEqual(deleted, [], '点「丢弃草稿」不该一键执行 —— 丢弃不可逆，必须先问一句')

    const bar = confirmBarOf(tree)
    assert.ok(treeText(bar).includes('第二条草稿'), '确认条要点名是哪一条（列表里每条都能丢）')
    assert.equal(countNodes(bar, (node) => ownTexts(node).includes('取消')), 1, '确认条要给两个出口')

    tree = act(() => button(bar, '确认丢弃').props.onClick())
    tree = await settle({ act })
    assert.equal(deleted.length, 1, '确认之后才真的删')
    assert.ok(
      deleted[0].endsWith(`/books/${BOOK.bookId}/drafts/d2`),
      `确认后要丢弃**确认条点名的那一条**（d2），不是编辑区那条（d1）：${deleted[0]}`,
    )
    assert.ok(treeText(tree).includes('草稿已丢弃。'))
  })

  // ---- 空态引导：草稿栏空的时候，"以后还能存"这件事要自己说出来 ----
  // 单独一个 runtime：草稿栏是空的场景（上面那个 runtime 的 state 已经跟着用例走过一遍了）。
  const empty = await runtime()
  const emptyFetch = makeFetch(firstScreen({ drafts: [] }))
  await withFetch(emptyFetch.fetch, async () => {
    empty.render(mountNotes(empty.react, empty.internals))
    let tree = await settle({ act: empty.act })
    tree = empty.act(() => button(tree, '草稿').props.onClick())
    assert.ok(
      treeText(tree).includes('想先存着、以后再写'),
      `草稿 tab 的空态要指路（tab 上已有计数，所以它只说"怎么存"）：${treeText(tree).slice(0, 300)}`,
    )
  })
})

//#region ③ 三个选项卡 + 删除/恢复/彻底删除
// 取代 client.test.mjs「接线守卫：三个选项卡 + 删除/恢复/彻底删除（v1.57）」。
//#endregion

test('三个选项卡（运行时）：计数用宿主回的 total，删除/恢复/彻底删除各自接对了线', async () => {
  // 取代上面那条。它钉了十几处源码文本（三颗 tab 的调用点、`!trashNotes.length`、
  // 四个按钮文案、两条字面量路由、`purgeTarget`、`runPurge(...'all'...)`、
  // `!trashNotes.map(...)`、`mode: 'trash'`、`onTrash: trashOne`）。
  //
  // ⚠️ 其中**最值钱**的一处（审计 §四②：计数必须用宿主的 `total`，不是取回来的条数）
  // 在这里被真正钉住：列表只给 1 条、而宿主报 `total: 7` ⇒ tab 上必须是「（7）」。
  // 源码钉子只能证明"没写成 `${trashNotes.length}）`"，证明不了"用的是 total"。
  //
  // 可证伪：① 把 `tabButton('回收站', trashTotal, 'trash')` 改成 `trashNotes.length` ⇒
  // tab 上出现（1），第一条红；② 把 `tabButton('笔记', notesTotal, …)` 改成
  // `notes.length` ⇒ （30）变（1），红；③ 把清空的 `runPurge('all')` 改成
  // `runPurge(trashNotes.map((n) => n.id))` ⇒ 请求体里出现 ids 而不是 all，红；
  // ④ 把 `onTrash: trashOne` 删掉 ⇒ 点「删除本条」没有请求，红；⑤ 让回收站也渲染
  // 翻页行（删掉 `mode === 'trash' ? null`）⇒ "回收站不分页"那条红。
  const { react, render, act, internals } = await runtime()
  const purgeBodies = []
  const posts = []
  const N1 = {
    id: 'n1', heading: '第 1 章 雪', chapterIndex: 0, charOffset: 0, excerpt: '某段原文',
    thought: '感想', reply: '', tags: [], hasReply: false,
  }
  const T1 = {
    id: 't1', heading: '第 1 章 雪', chapterIndex: 0, charOffset: 0, excerpt: '回收站里的笔记',
    thought: '', reply: '', tags: [], hasReply: false, trashed: true,
  }
  const { fetch, calls } = makeFetch([
    ['/drafts', () => json({ ok: true, drafts: [DRAFT_ONE, DRAFT_TWO] })],
    ['/notes/purge', (url, options) => {
      purgeBodies.push(JSON.parse(options.body))
      return json({ ok: true, purged: { removed: 1, backupPath: 'D:\\备份' } })
    }],
    ['/notes/n1/trash', (url, options) => { posts.push(['trash', url, options.method]); return json({ ok: true }) }],
    ['/notes/t1/restore', (url, options) => { posts.push(['restore', url, options.method]); return json({ ok: true }) }],
    ['/notes?trashed=1&limit=200', () => json({ ok: true, notes: [T1], total: 7 })],
    ['/notes?limit=', () => json({ ok: true, notes: [N1], total: 30, hasMore: true, nextCursor: 'n1' })],
    ['/location', () => json(LOCATION)],
  ])

  await withFetch(fetch, async () => {
    render(mountNotes(react, internals))
    let tree = await settle({ act })

    // ---- 三颗 tab 的计数 ----
    let text = treeText(tree)
    assert.ok(text.includes('（30）'), `「笔记」tab 的计数要用宿主回的 total（列表里只有 1 条）：${text.slice(0, 300)}`)
    assert.ok(text.includes('（2）'), '「草稿」tab 的计数是草稿条数')
    assert.ok(text.includes('（0）'), '回收站还没取过，计数是 0（点开才取）')

    // ---- v1.58 的布局：tab 常驻在列表区**之前**，且不再另挂一行计数描述 ----
    // ⚠️ 这一条必须在**离开笔记 tab 之前**断言：这套替身的 `memo` 命中时返回 `null`
    //    （真实的 React 是"复用上一轮的输出"），所以"切走再切回来、而 props 一个字
    //    都没变"会让整张列表**消失**。`hooks-runtime.mjs` 的「已知限制」里记着这条，
    //    并建议"判据别选 `memo` 子树里的内容"；这里两样都做：tab 计数这类判据本来就
    //    在 `NotesView` 自己渲染的外层，而确实要看列表内容的几条，则顺着这条限制
    //    安排顺序（离开某个 tab 之前把该断言的事断言完）。
    const lines = textOrder(tree)
    const tabAt = lines.findIndex((line) => line === '笔记')
    const listAt = lines.findIndex((line) => line.includes('某段原文'))
    assert.ok(tabAt !== -1 && listAt !== -1, `先序文字里该同时有 tab 与列表：${lines.slice(0, 30).join(' | ')}`)
    assert.ok(tabAt < listAt, `三颗 tab 要画在列表区之前（tab 管的就是这张列表）：tab=${tabAt} 列表=${listAt}`)
    assert.ok(
      !treeText(tree).includes('已落盘的笔记'),
      '那行「已落盘的笔记（N）」要去掉 —— 计数已经写在 tab 上了，重复',
    )

    // ---- 笔记 tab：「删除本条」进回收站（一键、可逆） ----
    const n1Row = rowWith(tree, '某段原文')
    tree = act(() => button(n1Row, '删除本条').props.onClick())
    tree = await settle({ act })
    assert.deepEqual(
      posts.filter((item) => item[0] === 'trash').map((item) => [item[1].slice(item[1].indexOf('/books')), item[2]]),
      [[`/books/${BOOK.bookId}/notes/n1/trash`, 'POST']],
      '「删除本条」要接上 onTrash（进回收站，可逆、不确认）',
    )
    assert.ok(treeText(tree).includes('已移入回收站'))

    // ---- 回收站 tab：点开才取，计数用 total ----
    tree = act(() => button(tree, '回收站').props.onClick())
    tree = await settle({ act })
    text = treeText(tree)
    assert.ok(
      calls.some((call) => call.url.includes('trashed=1')),
      `回收站是"点开才取"的（它不在首屏那三样里）：${calls.map((c) => c.url).join(' | ')}`,
    )
    assert.ok(text.includes('（7）'), `回收站计数必须是宿主的 total（7），不是取回来的条数（1）：${text.slice(0, 400)}`)
    assert.ok(!text.includes('（1）'), '不许用取回来的条数当计数（列表带 limit，超过它的那部分取不回来）')
    assert.equal(countNodes(tree, (node) => ownTexts(node).includes('恢复')), 1, '回收站里每条要能恢复')
    assert.equal(countNodes(tree, (node) => ownTexts(node).includes('确认删除')), 1, '回收站里每条要能彻底删除')
    assert.equal(countNodes(tree, (node) => ownTexts(node).includes('删除本条')), 0, '回收站里不该有「删除本条」')
    assert.ok(!text.includes('每页'), '回收站不分页 —— 那行只会显示两颗禁用按钮和一句与实际不符的话（v1.62）')

    // ---- 恢复：一键、不确认 ----
    const t1Row = rowWith(tree, '回收站里的笔记')
    tree = act(() => button(t1Row, '恢复').props.onClick())
    tree = await settle({ act })
    assert.deepEqual(
      posts.filter((item) => item[0] === 'restore')
        .map((item) => [item[0], item[1].slice(item[1].indexOf('/books')), item[2]]),
      [['restore', `/books/${BOOK.bookId}/notes/t1/restore`, 'POST']],
      '恢复要 POST 到那一条的 restore 路由',
    )
    assert.ok(treeText(tree).includes('已从回收站恢复。'))

    // ---- 彻底删除：先要求确认，确认条说清后果，确认后按 id 删 ----
    tree = act(() => button(t1Row, '确认删除').props.onClick())
    assert.deepEqual(purgeBodies, [], '点「确认删除」不该一键执行 —— 彻底删除不可逆')
    const purgeBar = confirmBarOf(tree)
    assert.ok(treeText(purgeBar).includes('彻底删除这一条'), '确认条要说清删的是哪一条')
    assert.ok(treeText(purgeBar).includes('不可逆'), '不可逆这件事必须说出来')
    tree = act(() => button(purgeBar, '确认删除').props.onClick())
    tree = await settle({ act })
    assert.deepEqual(purgeBodies, [{ ids: ['t1'] }], '确认后删的是那一条（按 id），不是"当前编辑的那条"')

    // ---- 清空：必须传 all，不是"看得见的那几条的 id" ----
    tree = act(() => button(tree, '清空回收站').props.onClick())
    const clearBar = confirmBarOf(tree)
    assert.ok(
      treeText(clearBar).includes('把里面 7 条'),
      `清空的文案用的是宿主报的 total —— 说的和做的必须是一个数：${treeText(clearBar).slice(0, 200)}`,
    )
    tree = act(() => button(clearBar, '确认清空').props.onClick())
    tree = await settle({ act })
    assert.deepEqual(
      purgeBodies[1],
      { all: true },
      '清空必须传 all —— 传列表 id 只清得掉取回来的那一页（列表上限 200 条）',
    )

    // ---- 草稿 tab：每条草稿都能丢弃（v1.58：与「删除本条」同一逻辑，放在列表里） ----
    tree = act(() => button(tree, '草稿').props.onClick())
    tree = await settle({ act })
    assert.equal(
      countNodes(tree, (node) => ownTexts(node).includes('丢弃草稿')),
      2,
      '「丢弃草稿」在「草稿」tab 里，每条草稿一个（不在编辑区那一行）',
    )

    // ⚠️ **没能转**：旧守卫里那两条"路径必须写成字面量、不许拼 `${kind}`"与
    //    `assert.ok(source.includes("drc-label' }, '回收站')"))`，运行时**观察不到**：
    //    · 前者是**给另一条静态契约用例看的**（契约用例把客户端路径与宿主路由表逐条对，
    //      拼出来的它认不出）—— 它是"代码形态"的要求，不是行为；`/${kind}` 在
    //      kind='restore' 时**发出的 URL 一模一样**，行为断言在这里必然是假绿。
    //    · 后者连它想钉什么都说不清（消息说"要去掉"，代码却是 `assert.ok` 断言"在"）。
    //    这两条要留在 `client.test.mjs` 里，或由主理人改成契约用例。
  })
})

//#region ④ 编辑区脏了要先问一句 / 删除后不许弹回第一页
// 取代 client.test.mjs「接线守卫：编辑区脏了要先问一句、删除后不许弹回第一页（v1.62）」。
//#endregion

test('编辑区脏了要先问一句；删除/恢复/彻底删除都不许把读者弹回第一页（运行时）', async () => {
  // 取代上面那条。它钉的是 `loadDraft` 而不是 `applyActive`、`switchTarget` 状态、
  // 「丢弃并切换」这个词、`const dirty = active === null` 那句形状、以及
  // "`setTrashed`→`loadPage` 那一段里没有 `refresh()`"（还得先剥掉注释才敢断言）。
  //
  // 这里换成两件**真的会发生**的事：
  //   ① 编辑区里改过一个字之后点「接着写」⇒ 编辑框里的字还在，且弹出一条确认；
  //   ② 翻到第 2 页再删除 / 恢复 / 彻底删除 ⇒ 随后的重取**带着第 2 页的游标**
  //      （`refresh()` 那条路会发一个不带 `before=` 的首屏请求 = 把读者弹回顶部）。
  //
  // 可证伪：① 把「接着写」的 `onClick` 从 `loadDraft(draft)` 改成 `applyActive(draft)`
  // ⇒ 编辑框里的"感想二改了"被替换、也没有确认条，红；② 把 `dirty` 写成只认
  // `unsaved`（`active === null && …`）⇒ 改过已有草稿时不再弹确认，红；③ 把
  // `setTrashed` / `runPurge` 里的 `reloadNotesPage()` 换成 `refresh()` ⇒ 重取
  // 请求不带 `before=`、页号回到第 1 页，红。
  //
  // ⚠️ 拆成两个 runtime 是**顺着替身的边界**安排的（不是巧合）：这套运行时的 `memo`
  //    命中时返回 `null`，而真实的 React 是"复用上一轮的输出"。所以"离开笔记 tab、
  //    再切回来"（props 一个字都没变）会让整张列表消失，`更旧的一页` 也就找不到了。
  //    于是 ① 在草稿 tab 上跑完就结束，② 从笔记 tab 起步、只往前走不回头。
  const D1 = { ...DRAFT_ONE, excerpt: '原文一', thought: '感想一' }
  const D2 = { ...DRAFT_TWO, chapterIndex: 0, excerpt: '原文二', thought: '感想二' }
  const N2 = {
    id: 'n2', heading: '第 1 章 雪', chapterIndex: 0, charOffset: 0, excerpt: '第二页的笔记',
    thought: '感想', reply: '', tags: [], hasReply: false,
  }
  const T1 = {
    id: 't1', heading: '第 1 章 雪', chapterIndex: 0, charOffset: 0, excerpt: '回收站里的笔记',
    thought: '', reply: '', tags: [], hasReply: false, trashed: true,
  }
  const thoughtOf = (tree) => findNode(tree, (node) => node.props?.id === 'drc-note-thought').props.value

  // ---- ① 编辑区脏了要先问一句 ----
  const editor = await runtime()
  const editorFetch = makeFetch([
    ['/drafts', () => json({ ok: true, drafts: [D1, D2] })],
    ...firstScreen(),
  ])
  await withFetch(editorFetch.fetch, async () => {
    editor.render(mountNotes(editor.react, editor.internals, D1))
    let tree = await settle({ act: editor.act })
    assert.equal(thoughtOf(tree), '感想一', '编辑区初值来自 `activeDraft`')

    // ---- ①-a：编辑区**干净**时，「接着写」直接换（不该多问一句） ----
    tree = editor.act(() => button(tree, '草稿').props.onClick())
    tree = await settle({ act: editor.act })
    tree = editor.act(() => button(rowWith(tree, '原文二'), '接着写').props.onClick())
    assert.equal(thoughtOf(tree), '感想二', '干净的时候点「接着写」就该换过来')
    assert.equal(
      findNode(tree, (node) => node.props?.className === 'drc-confirm'),
      null,
      '编辑区没有没保存的字时，不该平白弹一条确认',
    )

    // ---- ①-b：改一个字之后再换 ⇒ 先问一句，而且不许把字丢掉 ----
    tree = editor.act(() => findNode(tree, (node) => node.props?.id === 'drc-note-thought')
      .props.onChange({ target: { value: '感想二改了' } }))
    assert.equal(thoughtOf(tree), '感想二改了', '夹具本身要站得住（onChange 真的改了状态）')

    tree = editor.act(() => button(rowWith(tree, '原文一'), '接着写').props.onClick())
    assert.equal(
      thoughtOf(tree),
      '感想二改了',
      '⚠️ 编辑区里有没保存的字时，「接着写」不许静默替换（那是丢字：服务端那条草稿还是旧内容）',
    )
    const bar = confirmBarOf(tree)
    assert.equal(countNodes(bar, (node) => ownTexts(node).includes('丢弃并切换')), 1, '确认条要有一个明确的出口')
    assert.equal(countNodes(bar, (node) => ownTexts(node).includes('取消')), 1, '另一个出口是「取消」（先去保存）')

    // 取消：什么都不换，字还在。
    tree = editor.act(() => button(bar, '取消').props.onClick())
    assert.equal(thoughtOf(tree), '感想二改了', '「取消」之后编辑区必须原样')
    assert.equal(findNode(tree, (node) => node.props?.className === 'drc-confirm'), null, '取消要把确认条收掉')

    // 丢弃并切换：这次才真的换成目标那一条。
    tree = editor.act(() => button(rowWith(tree, '原文一'), '接着写').props.onClick())
    tree = editor.act(() => button(confirmBarOf(tree), '丢弃并切换').props.onClick())
    assert.equal(thoughtOf(tree), '感想一', '确认之后要换成**目标那一条**的内容')
  })

  // ---- ② 翻到第 2 页之后，三个动作都不许把读者弹回第一页 ----
  const paging = await runtime()
  const { fetch, calls } = makeFetch([
    ['/drafts', () => json({ ok: true, drafts: [D1, D2] })],
    ['/notes/n2/trash', () => json({ ok: true })],
    ['/notes/t1/restore', () => json({ ok: true })],
    ['/notes/purge', () => json({ ok: true, purged: { removed: 1, backupPath: '' } })],
    ['/notes?trashed=1&limit=200', () => json({ ok: true, notes: [T1], total: 1 })],
    ['/notes?limit=', (url) => (url.includes('before=') ? json({
      ok: true, notes: [N2], total: 30, hasMore: true, nextCursor: 'n2',
    }) : json({
      ok: true,
      notes: [{ ...N2, id: 'n1', excerpt: '第一页的笔记' }],
      total: 30,
      hasMore: true,
      nextCursor: 'n1',
    }))],
    ['/location', () => json(LOCATION)],
  ])
  /** 某次动作之后，客户端重新取笔记的那几个请求（"弹回第一页"会在这里露出来）。 */
  const refetchNotes = (from) => calls.slice(from).filter((call) => call.url.includes('/notes?limit='))

  await withFetch(fetch, async () => {
    paging.render(mountNotes(paging.react, paging.internals, D1))
    let tree = await settle({ act: paging.act })
    tree = paging.act(() => findNode(tree, (node) => node.props?.title === '更旧的一页').props.onClick())
    tree = await settle({ act: paging.act })
    assert.match(treeText(tree), /第 2 \/ \d+ 页/, `先翻到第 2 页：${treeText(tree).slice(0, 200)}`)

    // 删除本条
    let mark = calls.length
    tree = paging.act(() => button(rowWith(tree, '第二页的笔记'), '删除本条').props.onClick())
    tree = await settle({ act: paging.act })
    let refetched = refetchNotes(mark)
    assert.equal(refetched.length, 1, `删除后只该重取一次笔记：${refetched.map((c) => c.url).join(' | ')}`)
    assert.ok(refetched[0].url.includes('before='), `重取必须带上第 2 页的游标（否则就是弹回第一页）：${refetched[0].url}`)
    assert.match(treeText(tree), /第 2 \/ \d+ 页/, '删除之后页号不许变')

    // 恢复（回收站 tab）
    tree = paging.act(() => button(tree, '回收站').props.onClick())
    tree = await settle({ act: paging.act })
    mark = calls.length
    tree = paging.act(() => button(rowWith(tree, '回收站里的笔记'), '恢复').props.onClick())
    tree = await settle({ act: paging.act })
    refetched = refetchNotes(mark)
    assert.equal(refetched.length, 1, `恢复后只该重取一次笔记：${refetched.map((c) => c.url).join(' | ')}`)
    assert.ok(refetched[0].url.includes('before='), `恢复也不许把读者弹回第一页：${refetched[0].url}`)

    // 彻底删除 / 清空（回收站 tab）
    mark = calls.length
    tree = paging.act(() => button(tree, '清空回收站').props.onClick())
    tree = paging.act(() => button(confirmBarOf(tree), '确认清空').props.onClick())
    tree = await settle({ act: paging.act })
    refetched = refetchNotes(mark)
    assert.equal(refetched.length, 1, `清空后只该重取一次笔记：${refetched.map((c) => c.url).join(' | ')}`)
    assert.ok(refetched[0].url.includes('before='), `清空也不许把读者弹回第一页：${refetched[0].url}`)
  })
})

//#region ⑤ NotesView 的 key：换编辑目标时变、保存时不变
// 取代 client.test.mjs「记笔记：NotesView 要有会变的 key，而且**保存时不能变**」。
//#endregion

test('记笔记（运行时）：NotesView 的 key 换编辑目标时会变、保存成功时不变', async () => {
  // 取代上面那条。它从源码里抠出 `return h(NotesView, {...})` 那段，断言里面有
  // `key: noteEpoch`、没有 `key: activeDraft`。
  //
  // 这里换成**观察父组件真的造出来的那个元素**（`createElement` 那一刻的 props.key）：
  //   · 保存成功那一趟（POST /drafts 回了真实 draftId、面板因此 setActiveDraft）
  //     key 必须**不变** —— 上一版写成 `key: activeDraft?.draftId`，正是这一趟会变，
  //     于是 `notice`（"草稿已保存。"）连同编辑框里还没回写的中间态一起被重挂吃掉；
  //   · 「返回 → 再进笔记页」（= 换编辑目标）key 必须**变** —— 不然摘抄框会停在
  //     上一份的内容上（`NotesView` 只把 props 读进 useState 初值，换内容只能靠重挂）。
  //
  // ⚠️ **这套替身的边界**（必须说清，否则这条会被误读成"重挂也被测到了"）：
  //    最小 hooks 运行时**不实现 key 语义**（实例按组件函数索引，不看 key），
  //    所以"key 变了 ⇒ 组件真的重挂"这一步观察不到。这条断言钉的是**父组件交给
  //    React 的那个 key 值**以及它的**变化时机** —— 也就是旧守卫钉的那件事，
  //    外加"保存时不变"这一半（旧守卫根本做不到）。
  //
  // 可证伪：① 把 `key: noteEpoch` 删掉 ⇒ key 是 undefined，第一条红；② 改回
  // `key: activeDraft?.draftId` ⇒ 起稿没有 id（undefined）、保存后变成 'd1'，
  // "保存时不变"那条红；③ 把 `onOpenNotes` 里的 `setNoteEpoch((e) => e + 1)` 删掉 ⇒
  // 换编辑目标时 key 不变，最后一条红。
  const { react, render, act, internals, elements } = await runtimeWithElements()
  // 未保存的起稿（**没有 draftId**）：这正是"保存会带回一个真实 id"的场景。
  internals.rememberSessionView(internals.sessionViews, 'session-abc', {
    view: 'notes',
    book: BOOK,
    draft: { excerpt: '正文里选的一段', chapterIndex: 0, chapterTitle: '第一章 雪', thought: '', reply: null, tags: [] },
    origin: 'toc',
  })
  const { fetch } = makeFetch([
    // ⚠️ 这里**不能**写宽泛的 `'/books/'`：`makeFetch` 是**按顺序**匹配 `url.includes` 的，
    //    而 `/books/<id>/drafts`、`/books/<id>/notes?limit=` 也都含 `'/books/'` ——
    //    宽泛的那条会先把它们接走，于是 `data.draft` 是 undefined，`applyActive(undefined)`
    //    会让下一次渲染直接炸在 `active.excerpt` 上（这个坑是本文件的第一版踩到的）。
    ['/chapters', () => json({ ok: true, chapters: [{ index: 0, title: '第一章 雪', length: 100, volume: null, kind: 'chapter' }] })],
    ['/progress', () => json({ ok: true, progress: { chapterIndex: 0, charOffset: 0 } })],
    ['/drafts', (url, options) => {
      if (options.method === 'POST') {
        return json({
          ok: true,
          draft: { draftId: 'd1', excerpt: '正文里选的一段', thought: '', reply: null, tags: [], chapterIndex: 0 },
          suggestedTags: [],
        })
      }
      return json({ ok: true, drafts: [] })
    }],
    ['/notes?limit=', () => json({ ok: true, notes: [], total: 0, hasMore: false, nextCursor: null })],
    ['/location', () => json(LOCATION)],
  ])

  await withFetch(fetch, async () => {
    render(react.createElement(internals.ReaderPanel, { sessionId: 'session-abc' }))
    let tree = await settle({ act })
    tree = await settle({ act }) // 笔记页挂载之后它自己还要取草稿/笔记/落点

    const noteElements = () => elements.filter((element) => element.type === internals.NotesView)
    assert.ok(noteElements().length > 0, `面板该渲染出 NotesView：${treeText(tree).slice(0, 300)}`)
    const keyOf = () => noteElements()[noteElements().length - 1].props.key
    const keyBefore = keyOf()
    assert.notEqual(keyBefore, undefined, 'NotesView 缺 key —— 换编辑目标时不会重挂，摘抄框会是空的')
    assert.notEqual(keyBefore, null, 'NotesView 缺 key')

    // ---- 保存：面板会因此拿到真实的 draftId，但 key 不许跟着变 ----
    tree = act(() => button(tree, '保存草稿').props.onClick())
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('草稿已保存。'), `保存成功了就要说出来：${treeText(tree).slice(0, 300)}`)
    assert.equal(
      keyOf(),
      keyBefore,
      '⚠️ 保存成功不该换 key —— 换了就把「草稿已保存。」和编辑框里还没回写的中间态一起重挂掉了',
    )

    // ---- 换编辑目标：返回目录、再进一次笔记页 ⇒ key 必须变 ----
    const back = findNode(tree, (node) => node.type === 'button' && node.props?.title === '返回')
    assert.ok(back !== null, '面板顶栏该有返回按钮')
    tree = act(() => back.props.onClick())
    const entry = findNode(tree, (node) => node.props?.title === '读书笔记')
    assert.ok(entry !== null, `目录页该有「笔记」入口：${treeText(tree).slice(0, 300)}`)
    tree = act(() => entry.props.onClick())
    assert.notEqual(
      keyOf(),
      keyBefore,
      '换编辑目标必须换 key —— 否则摘抄框会停在上一份的内容上（props 只读进 useState 初值）',
    )
  })
})

//#region ⑥ 发笔记那条路径不许无条件自称「记忆已更新」
// 取代 client.test.mjs「★ 补齐结果的接线：发笔记那条路径不再无条件自称「记忆已更新」」。
//#endregion

test('发笔记（运行时）：补齐结果三态真的接进了那句话，闸门拦下时不许说「已更新」', async () => {
  // 取代上面那条。它钉的是 `const fillRequest = callApi(`、没有 `.catch(() => null)`、
  // `memoryFillClause(fill)` 被调用、以及两个分支的模板串里都有 `${memoryClause}`。
  //
  // 这里真的点一次「① 发到会话去聊」，让 `/background/fill` 分别**回闸门**与**回成功**，
  // 看界面上那句话跟着变不变 —— 这正是它注释里说的"函数对而没接线照样是 bug"。
  //
  // 可证伪：① 把 `fillRequest` 改回 `.catch(() => null)`、或把两个分支的
  // `${memoryClause}` 换回硬编码的「前文记忆已更新」⇒ 闸门那一趟会说出"已更新"，红；
  // ② 把 `memoryFillClause(fill)` 换成常量 ⇒ 成功那一趟说不出"已更新到第 1–30 章"，红；
  // ③ 把 here 分支的 `${memoryClause}` 删掉（只留 handoff 分支）⇒ 同会话那一趟红。
  const GATE_BODY = {
    error: 'LARGE_GAP',
    gap: { from: 1, to: 149, chapters: 149 },
    gate: 50,
  }

  /** 跑一趟「发到会话」：点按钮 → 等补齐那条链跑完 → 返回树与输入框收到了什么。 */
  async function sendOnce({ fillHandler, bindingSessionId, withSessionJump }) {
    const { react, render, act, internals } = await runtime()
    const sent = []
    const opened = []
    const handed = []
    const { fetch, calls } = makeFetch([
      ['/background/fill', fillHandler],
      ['/progress', () => json({ ok: true, progress: { chapterIndex: 0, charOffset: 0 }, binding: { sessionId: bindingSessionId } })],
      ['/discussions', () => json({ ok: true })],
      ...firstScreen(),
    ])
    let tree = null
    await withFetch(fetch, async () => {
      render(react.createElement(internals.NotesView, {
        book: BOOK,
        sessionId: 'session-abc',
        activeDraft: null,
        onBack: () => {},
        inputActions: { setDraft: (text) => sent.push(text) },
        openSession: withSessionJump ? (id) => opened.push(id) : undefined,
        requestHandoff: withSessionJump ? (payload) => handed.push(payload) : undefined,
      }))
      tree = await settle({ act })
      tree = act(() => findNode(tree, (node) => node.props?.id === 'drc-note-excerpt')
        .props.onChange({ target: { value: '一段摘抄' } }))
      tree = act(() => findNode(tree, (node) => node.props?.id === 'drc-note-thought')
        .props.onChange({ target: { value: '我的感想' } }))
      tree = act(() => button(tree, '① 发到会话去聊').props.onClick())
      tree = await settle({ act })
    })
    return { tree, sent, opened, handed, calls }
  }

  // ---- 闸门拦下（宿主比客户端旧时才会走到）：必须点明"没有自动补、记忆没更新" ----
  const gated = await sendOnce({
    fillHandler: () => json(GATE_BODY, 409),
    bindingSessionId: 'session-abc',
    withSessionJump: false,
  })
  const gatedText = treeText(gated.tree)
  assert.ok(
    gated.calls.some((call) => call.url.includes('/background/fill')),
    `这一趟要真的去补齐过 —— 否则下面那些断言都是空转：${gated.calls.map((c) => c.url).join(' | ')}`,
  )
  assert.ok(
    gatedText.includes('没有**自动补**') || gatedText.includes('记忆没更新'),
    `闸门拦下时要说清"记忆没更新"，不许自称已更新：${gatedText.slice(0, 400)}`,
  )
  assert.ok(
    !gatedText.includes('前文记忆已更新'),
    `⚠️ 这正是这次要修的 bug：无条件说"记忆已更新"，而实际一个字都没补：${gatedText.slice(0, 400)}`,
  )
  assert.ok(
    gatedText.includes('第 1–149 章'),
    `那句话必须来自真实的补齐结果（缺口范围）：${gatedText.slice(0, 400)}`,
  )
  assert.equal(gated.sent.length, 1, '补齐失败**不拦**你聊天（本章与上一章是直接投喂的）')
  assert.ok(gated.sent[0].includes('一段摘抄'), '摘抄要真的放进会话输入框')

  // ---- 补齐成功 + 同会话（here 分支）----
  const here = await sendOnce({
    fillHandler: () => json({ ok: true, covered: { first: 1, last: 30 }, elapsedMs: 1000 }),
    bindingSessionId: 'session-abc',
    withSessionJump: false,
  })
  const hereText = treeText(here.tree)
  assert.ok(
    hereText.includes('前文记忆已更新到第 1–30 章。'),
    `成功那一趟必须说出真实结果（memoryFillClause 真的被调用）：${hereText.slice(0, 400)}`,
  )
  assert.ok(hereText.includes('摘抄与感想'), '同会话分支要把"放进输入框"说清楚')

  // ---- 补齐成功 + 绑的是另一个会话（handoff 分支）----
  const handed = await sendOnce({
    fillHandler: () => json({ ok: true, covered: { first: 1, last: 30 }, elapsedMs: 1000 }),
    bindingSessionId: 'session-xyz',
    withSessionJump: true,
  })
  const handedText = treeText(handed.tree)
  assert.ok(
    handedText.includes('前文记忆已更新到第 1–30 章。'),
    `handoff 分支同样要走 memoryFillClause：${handedText.slice(0, 400)}`,
  )
  assert.ok(handedText.includes('已切到这本书绑定的会话'), 'handoff 分支要把"跳到哪儿"说清楚')
  assert.deepEqual(handed.opened, ['session-xyz'], '要真的打开目标会话')
  assert.deepEqual(handed.handed.map((payload) => payload.sessionId), ['session-xyz'], '要真的把这段文字交接过去')
})
