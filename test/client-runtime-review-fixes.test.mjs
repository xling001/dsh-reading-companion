/**
 * 浏览器半边：第三方评审「界面修复」那几批的**运行时行为**断言（2026-10-03，C 档）。
 *
 * ## 这个文件存在的理由
 *
 * `test/client-runtime.test.mjs`（B 档）建起了最小 hooks 运行时之后，剩下几条
 * "读源码文本再断言"的钉子还在 `client.test.mjs` 里。它们大多是**一条用例捆了
 * 好几件事**，其中真正值得测的是**行为**：
 *
 *   · `接线守卫：第三方评审第四批的界面修复（2026-10-02）`（约 L696）捆了六件，
 *     四件能渲染（P2-10 / P2-11 / P2-12 / P3-2）；
 *   · `接线守卫：对齐与回收站呈现（v1.62）`（约 L744）六件里五件是 CSS（**留在原处**），
 *     只有 ③「回收站没有分页」是可渲染的；
 *   · `交接：清空是显式的，而且必须在写进输入框**之后**`（约 L2259）与
 *     `交接：wait 必须在清空之前返回`（约 L2605）用 `source.indexOf` 比位置 ——
 *     这也是字符串钉子，只是形状不是 `assert.match`（普查原先漏判了它们）；
 *   · `竞态守卫：每个按书加载的资源各自装了守卫`（约 L2701）数"每个守卫有几处
 *     提前返回"。这里用**受控 Promise 制造乱序**，真的让"先发的请求后回来"。
 *
 * ⚠️ 一条**取代**一条：凡是被这里完整覆盖的旧断言，都要在 `client.test.mjs` 里
 * 删掉（`design.md` 的删除铁律）。**没有**被取代的那些件（P3-3 / P3-5、v1.62 的
 * 五件 CSS、竞态守卫的"逐个计数"）在本文件里**故意没有**对应用例 —— 理由写在各条
 * 用例的注释与交付说明里，别顺手一起删。
 *
 * ⚠️ 每条用例的注释里都写清**证伪方式**：把哪一行删掉 / 改错，这条就会红。
 * 这是本仓库的硬规矩 —— **假红比不测更坏**，写不出证伪方式的断言不许进这个文件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadClientModule, ROOT } from './helpers/client-loader.mjs'
import { createHooks, findNode, findText, makeFetch, treeText } from './helpers/hooks-runtime.mjs'

//#region 装置（与 client-runtime.test.mjs 同款，刻意重复一点点以便这个文件能单独跑）

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

/** 造一个 JSON `Response`（宿主接口的形状）。 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 一个**受控的 Promise**：`makeFetch` 的路由处理函数可以返回它 —— 于是
 * "先发的请求挂住、后发的先回来"这件事在测试里可编程（竞态那两条用例靠它）。
 */
function gate() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

/** 键盘事件替身：`onKeyDown` 里会调 `preventDefault()`，所以它必须存在。 */
function keyEvent(key) {
  return { key, preventDefault() {} }
}

//#endregion

//#region 笔记页的公共夹具

const NOTES_BOOK = { bookId: 'b1', title: '夜行', chapterCount: 2 }

/** 一条笔记的形状（`NoteList` 会读 `tags.length` / `hasReply` / `chapterIndex`）。 */
function noteFixture(id, excerpt) {
  return {
    id,
    heading: '第 1 章 雪',
    chapterIndex: 0,
    charOffset: 0,
    tags: [],
    excerpt,
    thought: '',
    reply: '',
    hasReply: false,
    trashed: false,
  }
}

/** 笔记页首屏那三个请求（草稿 / 落点 / 第一页笔记）。 */
function notesBaseRoutes() {
  return [
    ['/drafts', { body: { ok: true, drafts: [] } }],
    ['/location', { body: { ok: true, location: null } }],
    ['/notes?limit=', { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } }],
  ]
}

function notesProps(extra = {}) {
  return {
    book: NOTES_BOOK,
    activeDraft: null,
    sessionId: 'session-abc',
    onBack: () => {},
    ...extra,
  }
}

/** 笔记页那三个选项卡里的一颗（`aria-pressed` 是它独有的 prop，用它定位最稳）。 */
function tabNode(tree, label) {
  const hit = findNode(tree, (node) => Object.hasOwn(node.props ?? {}, 'aria-pressed')
    && (node.children ?? []).includes(label))
  assert.ok(hit !== null, `找不到「${label}」这个选项卡：${treeText(tree).slice(0, 200)}`)
  return hit
}

//#endregion

//#region P2-10：回收站"取不到 ≠ 空的"

test('回收站：读取失败要说「没读到」，成功拿到空列表才说「空的」', async () => {
  // 取代 L696「接线守卫：第三方评审第四批的界面修复（2026-10-02）」里的 **P2-10** 那一件
  // （旧断言是四条源码文本：`trashError` 的 state、置起、清掉、`没读到` 的正则，外加
  // 一条反向正则"catch 里不许 setTrashTotal(0)"）。
  //
  // 旧断言问的是"那几行代码还在不在"；这里问的是**读者看到的是哪一句话** ——
  // 而这一屏正是读者找回误删内容的地方，"取不到"被说成"你没删过东西"代价最大。
  //
  // 证伪方式：
  //   · 删掉 `trashError !== null ? … :` 那一支（或删掉 catch 里的 `setTrashError(...)`，
  //     退回"取不到就当空"）⇒ 第一段找不到「没读到」⇒ 红；
  //   · 把 `trashError !== null` 这个判断改成恒真（或把成功路径的 `setTrashError(null)`
  //     删掉）⇒ 第二段（成功空列表）会说出「没读到」而说不出「回收站是空的。」⇒ 红。
  const failRuntime = await runtime()
  const failFetch = makeFetch([
    ...notesBaseRoutes(),
    ['/notes?trashed=1', { status: 500, body: { reason: '宿主说回收站读不出来' } }],
  ])

  await withFetch(failFetch.fetch, async () => {
    failRuntime.render(failRuntime.react.createElement(failRuntime.internals.NotesView, notesProps()))
    let tree = await settle(failRuntime)

    // 切到回收站 tab：这一步会现取一次（`tabButton` 的 onClick 里调 loadTrash）。
    tree = failRuntime.act(() => tabNode(tree, '回收站').props.onClick())
    tree = await settle(failRuntime)

    const text = treeText(tree)
    assert.ok(
      text.includes('回收站这次没读到'),
      `读取失败必须说「没读到」，而不是装作没有东西：${text.slice(0, 400)}`,
    )
    assert.ok(text.includes('宿主说回收站读不出来'), '要把宿主给的原因如实带出来')
    assert.ok(
      !text.includes('回收站是空的'),
      '⚠️ 一次读取失败绝不能说成"你没删过东西" —— 那是把可恢复的数据藏起来',
    )
    assert.ok(findText(tree, '重试') !== null, '失败时要有出口（重试），不能只留一句红字')
  })

  // 反向：**成功**拿到空列表时，必须说「空的」—— 否则上面那句"没读到"就成了永远为真的假话。
  const emptyRuntime = await runtime()
  const emptyFetch = makeFetch([
    ...notesBaseRoutes(),
    ['/notes?trashed=1', { body: { ok: true, notes: [], total: 0 } }],
  ])

  await withFetch(emptyFetch.fetch, async () => {
    emptyRuntime.render(emptyRuntime.react.createElement(emptyRuntime.internals.NotesView, notesProps()))
    let tree = await settle(emptyRuntime)
    tree = emptyRuntime.act(() => tabNode(tree, '回收站').props.onClick())
    tree = await settle(emptyRuntime)

    const text = treeText(tree)
    assert.ok(text.includes('回收站是空的。'), `真的一條都没有时要说「空的」：${text.slice(0, 400)}`)
    assert.ok(!text.includes('没读到'), '取到了就不许说"没读到"')
  })
})

//#endregion

//#region P2-11：目录的卷与章节键盘可达

/** 目录夹具：两卷各两章，进度停在第 1 章（所以卷一默认展开、卷二默认收起）。 */
const TOC_CHAPTERS = [
  { index: 0, title: '第一章 雪', length: 100, volume: '卷一', kind: 'chapter' },
  { index: 1, title: '第二章 风', length: 100, volume: '卷一', kind: 'chapter' },
  { index: 2, title: '第三章 雷', length: 100, volume: '卷二', kind: 'chapter' },
  { index: 3, title: '第四章 电', length: 100, volume: '卷二', kind: 'chapter' },
]

function tocProps(extra = {}) {
  return {
    book: { bookId: 'b1', title: '夜行', strategy: 'heading-regex', chapterCount: 4 },
    chapters: TOC_CHAPTERS,
    progress: { chapterIndex: 0, charOffset: 0 },
    loading: false,
    error: null,
    onBack: () => {},
    onPick: () => {},
    onOpenCompanion: () => {},
    onOpenNotes: () => {},
    ...extra,
  }
}

/** 卷标题那一行（`.drc-volume-btn` 是它独有的 className）。 */
function volumeNode(tree, name) {
  const hit = findNode(tree, (node) => node.props?.className === 'drc-volume drc-volume-btn'
    && treeText(node).includes(name))
  assert.ok(hit !== null, `找不到「${name}」这一卷的标题：${treeText(tree).slice(0, 300)}`)
  return hit
}

/** 章节那一行（`drc-item` / `drc-item drc-item-cur` 是它独有的 className，卷标题没有）。 */
function chapterNode(tree, title) {
  const hit = findNode(tree, (node) => ['drc-item', 'drc-item drc-item-cur'].includes(node.props?.className)
    && treeText(node).includes(title))
  assert.ok(hit !== null, `找不到「${title}」这一章：${treeText(tree).slice(0, 300)}`)
  return hit
}

test('目录：卷标题与章节真的键盘可达（Enter / 空格都能展开卷，Enter 能进章节）', async () => {
  // 取代 L696 的 **P2-11** 那一件（旧断言是四条源码文本：`role/tabIndex/aria-expanded`
  // 连在一起的那三行、`aria-current` 那行、`if (event.key !== 'Enter' && …)` 出现两次、
  // 以及 `const toggleVolume = () => {`）。
  //
  // ⚠️ 生产代码里键盘处理挂在 **`onKeyDown`** 上（不是 `onKeyPress`）—— 先读了
  //    `lib/client.js` 的 TocView 才这么写。旧断言只证明"那串字符还在源码里"，
  //    这里证明**按键真的改变了界面**。
  //
  // 证伪方式：
  //   · 删掉卷标题上的 `role: 'button'` / `tabIndex: 0` ⇒ 前两条断言红；
  //   · 删掉卷标题的 `onKeyDown`（或把 `event.key !== 'Enter' && event.key !== ' '`
  //     改成只看 Enter）⇒ "空格收起"那一步红；
  //   · 删掉章节上的 `'aria-current': …` ⇒ 当前章那条断言红；
  //   · 把 `onKeyDown` 里的 `onPick(chapter)` 删掉（只留 onClick）⇒ "键盘进章节"红。
  const { react, render, act, internals } = await runtime()
  const picked = []
  const props = tocProps({ onPick: (chapter) => picked.push(chapter.index) })

  let tree = render(react.createElement(internals.TocView, props))

  // ① 卷标题：能聚焦、能播报展开状态。
  const vol1 = volumeNode(tree, '卷一')
  assert.equal(vol1.props.role, 'button', '卷标题要能被读屏当成按钮')
  assert.equal(vol1.props.tabIndex, 0, '卷标题要能 Tab 聚焦（从前是个只能点的 div）')
  assert.equal(vol1.props['aria-expanded'], true, '当前卷默认展开，且要播报出来')
  const vol2 = volumeNode(tree, '卷二')
  assert.equal(vol2.props['aria-expanded'], false, '不是当前的那一卷默认收起')

  // ② 章节：能播报"你现在在这一章"。
  const cur = chapterNode(tree, '第一章 雪')
  assert.equal(cur.props.role, 'button', '章节要能被读屏当成按钮')
  assert.equal(cur.props.tabIndex, 0, '章节要能 Tab 聚焦')
  assert.equal(cur.props['aria-current'], 'true', '当前章要播报 aria-current')
  assert.equal(chapterNode(tree, '第二章 风').props['aria-current'], undefined, '不是当前章就不许播报')

  // ③ 键盘展开卷二（Enter），再键盘收起（空格）—— 鼠标与键盘共用同一条路径。
  assert.ok(!treeText(tree).includes('第三章 雷'), '收起状态下卷二的章节不该在树上')
  tree = act(() => volumeNode(tree, '卷二').props.onKeyDown(keyEvent('Enter')))
  assert.ok(treeText(tree).includes('第三章 雷'), `Enter 必须能展开卷：${treeText(tree).slice(0, 300)}`)
  assert.equal(volumeNode(tree, '卷二').props['aria-expanded'], true, '展开后要播报出去')

  tree = act(() => volumeNode(tree, '卷二').props.onKeyDown(keyEvent(' ')))
  assert.ok(!treeText(tree).includes('第三章 雷'), '空格必须能收起卷（只处理 Enter 的实现会在这里红）')
  assert.equal(volumeNode(tree, '卷二').props['aria-expanded'], false, '收起后也要播报')

  // ④ 别的键什么都不做 —— 否则"任意键都触发"这种过度处理测不出来。
  tree = act(() => volumeNode(tree, '卷二').props.onKeyDown(keyEvent('a')))
  assert.ok(!treeText(tree).includes('第三章 雷'), '不是 Enter / 空格就不该展开')

  // ⑤ 键盘进章节：Enter 落在章节行上要真的选中它。
  assert.deepEqual(picked, [], '还没按键，不该选中任何章')
  act(() => chapterNode(tree, '第二章 风').props.onKeyDown(keyEvent('Enter')))
  assert.deepEqual(picked, [1], 'Enter 落在章节行上要真的进那一章（只留 onClick 的实现会红）')
})

//#endregion

//#region P2-12：笔记表单的 label 真的绑到控件

test('笔记表单：每个 label 的 htmlFor 都能在树上找到同 id 的**控件**', async () => {
  // 取代 L696 的 **P2-12** 那一件（旧断言是八条源码文本：四个 `htmlFor: 'drc-note-x'`
  // 与四个 `id: 'drc-note-x'` 各自 `source.includes`）。
  //
  // 旧断言钉的是**两个字符串各自出现过** —— 把 label 的 `htmlFor` 写成别的 id、
  // 或者把两个 label 指向同一个控件，它都是绿的。这里钉的是**真的配成对**：
  // 每个 label 指向的那个 id 必须在树上存在，而且那个节点是表单控件。
  //
  // 证伪方式：
  //   · 把任一个 `htmlFor` 的值改一个字母 ⇒ 那条 label 找不到同 id 的控件 ⇒ 红；
  //   · 删掉任一个 `htmlFor` ⇒ 那颗 label 不在配对表里 ⇒ 红；
  //   · 把两个 label 指向同一个 id ⇒ "四个互不相同"那条红；
  //   · 把某个 `id` 挂到 `div` 而不是 `textarea`/`input` ⇒ "控件"那条红。
  const { react, render, act, internals } = await runtime()
  const fetchStub = makeFetch(notesBaseRoutes())

  await withFetch(fetchStub.fetch, async () => {
    render(react.createElement(internals.NotesView, notesProps()))
    const tree = await settle({ act })

    const labels = []
    const controls = new Map()
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      const props = node.props ?? {}
      if (typeof props.htmlFor === 'string') labels.push({ htmlFor: props.htmlFor, text: treeText(node) })
      if (typeof props.id === 'string' && typeof node.type === 'string') {
        controls.set(props.id, node.type)
      }
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)

    const wanted = ['原文摘抄', '我的感想', 'tag（空格分隔，可自己加）', 'AI 回应（可选，不填就不落盘）']
    const pairs = []
    for (const text of wanted) {
      const label = labels.find((item) => item.text.includes(text))
      assert.ok(label !== undefined, `找不到「${text}」这颗 label：${labels.map((l) => l.text).join(' | ')}`)
      assert.ok(
        controls.has(label.htmlFor),
        `「${text}」的 label 指向 ${label.htmlFor}，但树上没有这个 id 的控件 —— 读屏软件拿不到可访问名`,
      )
      const kind = controls.get(label.htmlFor)
      assert.ok(
        kind === 'textarea' || kind === 'input',
        `「${text}」绑到的 ${label.htmlFor} 是 <${kind}>，不是输入控件`,
      )
      pairs.push(label.htmlFor)
    }
    assert.equal(
      new Set(pairs).size,
      wanted.length,
      `四个 label 必须各绑一个控件（现在指向：${pairs.join(' / ')}）—— 指向同一个等于三个没绑`,
    )
  })
})

//#endregion

//#region P3-2：刷新失败必须有人接

test('刷新失败必须有人接：删除之后列表刷新失败要如实说一句，而不是静默停在旧列表', async () => {
  // 取代 L696 的 **P3-2** 那一件（旧断言取 `reloadNotesPage` 往后 1200 字符的切片，
  // 断言切片里有 `.catch((error)` 和 `不是最新的`）。
  //
  // 那条钉的是"catch 写没写"；这里**真的让刷新失败一次**，看界面上有没有那句话。
  // 失效模式（旧注释里写得很清楚）：`reloadNotesPage` 被三条路**不 await 地**调用，
  // 没有 catch 时界面停在**旧列表**、却显示"已移入回收站" —— 读者看到的成功与列表不符。
  //
  // 证伪方式：
  //   · 删掉 `reloadNotesPage` 的 `.catch(...)` ⇒ 界面上没有那句话 ⇒ 红；
  //     （顺带：那条拒绝会变成未处理的拒绝，node:test 也会把它报出来）
  //   · 把 catch 里 `setNotice` 删掉（只吞不报）⇒ 同样红。
  const { react, render, act, internals } = await runtime()
  let listCalls = 0
  const fetchStub = makeFetch([
    ['/drafts', { body: { ok: true, drafts: [] } }],
    ['/location', { body: { ok: true, location: null } }],
    ['/notes/n1/trash', { body: { ok: true } }],
    ['/notes?trashed=1', { body: { ok: true, notes: [], total: 0 } }],
    // ⚠️ 这条必须**排在**通用那条 `/notes?limit=` 之前：`makeFetch` 是"第一条命中就赢"。
    // 第一次（首屏）成功，第二次（删除之后的刷新）失败。
    ['/notes?limit=', () => {
      listCalls += 1
      return listCalls === 1
        ? jsonResponse({ ok: true, notes: [noteFixture('n1', 'n1 的摘抄')], total: 1, hasMore: false, nextCursor: null })
        : jsonResponse({ reason: '宿主读笔记时炸了' }, 500)
    }],
  ])

  await withFetch(fetchStub.fetch, async () => {
    let tree = render(react.createElement(internals.NotesView, notesProps()))
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('n1 的摘抄'), '首屏要先成功取到那条笔记（否则这条用例的前提没了）')

    const trashButton = findNode(tree, (node) => (node.children ?? []).includes('删除本条'))
    assert.ok(trashButton !== null, '每条笔记都要有「删除本条」')

    tree = act(() => trashButton.props.onClick())
    tree = await settle({ act })

    const text = treeText(tree)
    assert.equal(listCalls, 2, `删除之后必须重取一次当前页：${listCalls}`)
    assert.ok(
      text.includes('笔记列表刷新失败'),
      `刷新失败必须有人接（从前是未处理的拒绝 + 界面停在旧列表）：${text.slice(0, 500)}`,
    )
    assert.ok(text.includes('不是最新的'), '要如实说"列表可能不是最新的"，否则读者以为它已经更新了')
    assert.ok(text.includes('宿主读笔记时炸了'), '要把宿主给的原因带出来，读者才知道重试有没有意义')
  })

  // 反向：刷新**成功**时不许报这句话 —— 否则上面那三条断言就是"永远为真"的假话。
  const okRuntime = await runtime()
  const okFetch = makeFetch([
    ['/drafts', { body: { ok: true, drafts: [] } }],
    ['/location', { body: { ok: true, location: null } }],
    ['/notes/n1/trash', { body: { ok: true } }],
    ['/notes?trashed=1', { body: { ok: true, notes: [], total: 0 } }],
    ['/notes?limit=', { body: { ok: true, notes: [noteFixture('n1', 'n1 的摘抄')], total: 1, hasMore: false, nextCursor: null } }],
  ])

  await withFetch(okFetch.fetch, async () => {
    let tree = okRuntime.render(okRuntime.react.createElement(okRuntime.internals.NotesView, notesProps()))
    tree = await settle(okRuntime)
    tree = okRuntime.act(() => findNode(tree, (node) => (node.children ?? []).includes('删除本条')).props.onClick())
    tree = await settle(okRuntime)

    assert.ok(
      !treeText(tree).includes('笔记列表刷新失败'),
      `刷新成功时不许报"刷新失败"：${treeText(tree).slice(0, 400)}`,
    )
    assert.ok(treeText(tree).includes('已移入回收站'), '成功那条提示本身要照常出现（否则这条反向断言是空的）')
  })
})

//#endregion

//#region v1.62 ③：回收站没有分页

test('回收站列表不渲染翻页行（笔记列表仍然渲染它）', async () => {
  // 取代 L744「接线守卫：对齐与回收站呈现（v1.62）」里的 **③** 那一件
  // （旧断言是 `assert.match(source, /mode === 'trash'\s*\n\s*\? null/)`）。
  //
  // ⚠️ 那一条的**其余五件**（① tab 行内边距 / ② 选中态不加粗 / ④ 三路列表不再套
  //    `.drc-section` / ⑤ 计数为 0 淡一点 + 等宽数字 / ⑥ tab 的 aria-pressed）钉的是
  //    **CSS 与模板文本**，运行时替身没有 DOM，搬过来只会把断言变弱 —— **留在原处**。
  //
  // 证伪方式：
  //   · 删掉 `mode === 'trash' ? null :`（让翻页行无条件渲染）⇒ 第一段红；
  //   · 反过来，把翻页行整个删掉 ⇒ 第二段（笔记模式的对照）红。
  //     ⚠️ 对照那一半是必须的：没有它，"NoteList 从来不画翻页行"也会让第一段绿。
  const { react, render, internals } = await runtime()
  const notes = [noteFixture('n1', 'n1 的摘抄')]
  const shared = {
    notes,
    total: 30,
    loading: false,
    page: 0,
    pageCount: 3,
    hasPrev: false,
    hasNext: true,
    onRestore: () => {},
    onPurge: () => {},
    onTrash: () => {},
    onJumpToChapter: () => {},
  }

  const trashTree = render(react.createElement(internals.NoteList, { ...shared, mode: 'trash' }))
  assert.equal(
    findNode(trashTree, (node) => node.props?.title === '更旧的一页'),
    null,
    '回收站是一次取一批、根本没有分页 —— 不许渲染那颗"更旧"按钮',
  )
  assert.equal(
    findNode(trashTree, (node) => node.props?.title === '更新的一页'),
    null,
    '同上，"更新"那颗也不许出现',
  )
  assert.ok(
    !treeText(trashTree).includes('每页'),
    `那句「每页 10 条」对回收站来说是假话（它一次取 200 条）：${treeText(trashTree).slice(0, 300)}`,
  )

  const notesTree = render(react.createElement(internals.NoteList, { ...shared, mode: 'notes' }))
  const nextButton = findNode(notesTree, (node) => node.props?.title === '更旧的一页')
  assert.ok(nextButton !== null, '笔记模式必须仍然有翻页行（否则上面那三条断言是空的）')
  assert.equal(nextButton.props.disabled, false, '`hasNext: true` 时「更旧」要能点')
  assert.ok(treeText(notesTree).includes('每页 10 条'), '笔记模式那句「每页 10 条」是对的，要留着')
})

//#endregion

//#region v1.62 ⑥：aria-pressed 要真的表达"当前选中"（它**能**转，所以从残半块里搬过来）
//
// 旧断言只有一句 `source.includes("'aria-pressed': tab === value")` —— 它钉的是**源码里
// 那一行的写法**，而这件事在渲染树上是**看得见**的（`aria-pressed` 就是节点上的 prop，
// 本文件的 `tabNode` 正是靠它定位 tab 的）。既然看得见，就没有理由留在文本钉子里。
//
// 生产代码里它是**按当前 tab 算**的（`'aria-pressed': tab === value`），所以真正要钉的
// 性质有三条，缺一条都会让读屏听不出"我在哪一栏"：
//   · 恰好一颗为真（默认是「笔记」）；
//   · 另外两颗明确为假（不是 `undefined`：`undefined` 会让读屏当"没有这个属性"）；
//   · 点另一颗之后，选中态**跟着走**。
//
// 证伪方式：
//   · 把 `'aria-pressed': tab === value` 改成常量 `true` ⇒ 第一段"恰好一颗为真"红；
//   · 改成常量 `false` ⇒ 第一段红（没有任何一颗为真）；
//   · 改成 `tab === 'notes'`（写死第一颗）⇒ 第三段"点回收站之后它才是按下态"红；
//   · 把 `onClick` 里的 `setTab(value)` 删掉 ⇒ 第三段红（点了不翻）。
const TAB_LABELS = ['笔记', '草稿', '回收站']

test('笔记页：当前选中的 tab 才带 aria-pressed（点一下要跟着翻）', async () => {
  const { react, render, act, internals } = await runtime()
  const { fetch } = makeFetch([
    ...notesBaseRoutes(),
    ['/notes?trashed=1', { body: { ok: true, notes: [], total: 0 } }],
  ])

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.NotesView, notesProps()))
    tree = await settle({ act })

    /** 现在处于"按下态"的那几颗 tab（按 `TAB_LABELS` 的顺序）。 */
    const pressed = () => TAB_LABELS.filter((label) => tabNode(tree, label).props['aria-pressed'] === true)
    /** 明确为 `false`（而不是缺属性）的那几颗。 */
    const released = () => TAB_LABELS.filter((label) => tabNode(tree, label).props['aria-pressed'] === false)

    assert.deepEqual(pressed(), ['笔记'], `默认该只有「笔记」是按下态：${JSON.stringify(pressed())}`)
    assert.deepEqual(
      released(),
      ['草稿', '回收站'],
      '另外两颗要**明确为 false**（`undefined` 会让读屏当成"没有这个属性"，等于没写）',
    )

    // 点「回收站」⇒ 选中态必须跟着走。颜色表达不了这件事，读屏只能读这个属性。
    tree = act(() => tabNode(tree, '回收站').props.onClick())
    tree = await settle({ act })

    assert.deepEqual(pressed(), ['回收站'], `点了回收站之后，按下态必须翻过去：${JSON.stringify(pressed())}`)
    assert.deepEqual(released(), ['笔记', '草稿'], '翻过去之后，「笔记」要明确松开')
  })
})

//#endregion

//#region 交接棒：清空与写入的先后（取代两条 indexOf 位置钉子）

/** 交接那两条用例的装置：一个"书架为空"的面板（`/library` + `/health` 都配好）。 */
async function panelRuntime() {
  const hooks = await runtime()
  const stub = makeFetch([
    ['/library', { body: { ok: true, books: [] } }],
    ['/health', { body: { ok: true, quarantined: [] } }],
  ])
  return { ...hooks, fetchStub: stub.fetch }
}

test('交接：写进输入框抛错时，棒子必须还在（清空在写入**之后**）', async () => {
  // 取代 L2259「交接：清空是显式的，而且必须在写进输入框**之后**」。旧断言用
  // `source.indexOf('inputActions.setDraft(...)')` 与 `indexOf('commitDraftHandoff(...)')`
  // 比位置 —— 那同样是字符串钉子（普查原先漏判了它，因为形状不是 `assert.match`）。
  //
  // 它要钉的性质是那条注释里写的失效模式：**两头空** —— 顺序反了的话，`setDraft`
  // 一旦抛错（宿主接口换了形状），文字从接力区消失、输入框里也没有。
  //
  // 证伪方式：
  //   · 把 `commitDraftHandoff(draftHandoffs, sessionId)` 挪到 `inputActions.setDraft(...)`
  //     **之前** ⇒ 抛错时棒子已经被清掉 ⇒ `takeDraftHandoff` 返回 `wait` ⇒ 第一段红；
  //   · 把 `commitDraftHandoff` 整个删掉 ⇒ 第二段（兑现之后必须清）红。
  const failing = await panelRuntime()
  await withFetch(failing.fetchStub, async () => {
    const { depositDraftHandoff, takeDraftHandoff, draftHandoffs, ReaderPanel } = failing.internals
    depositDraftHandoff(draftHandoffs, 'session-abc', '一段摘抄', Date.now())

    assert.throws(
      () => failing.render(failing.react.createElement(ReaderPanel, {
        sessionId: 'session-abc',
        inputActions: { setDraft() { throw new Error('宿主接口炸了') } },
      })),
      /宿主接口炸了/,
      '这条用例的前提：写进输入框那一步真的抛错',
    )

    const after = takeDraftHandoff(draftHandoffs, 'session-abc', Date.now())
    assert.equal(
      after.action,
      'deliver',
      '⚠️ 写入失败之后棒子必须还在 —— 否则文字从接力区消失了、输入框里也没有（两头空）',
    )
    assert.equal(after.text, '一段摘抄', '留下的必须是原文，不能是半截')
  })

  // 另一半：**清空是显式的** —— 真的写进去了，才把棒子收走（否则下次重挂会再送一遍）。
  const ok = await panelRuntime()
  await withFetch(ok.fetchStub, async () => {
    const { depositDraftHandoff, takeDraftHandoff, draftHandoffs, ReaderPanel } = ok.internals
    depositDraftHandoff(draftHandoffs, 'session-abc', '一段摘抄', Date.now())
    const written = []
    ok.render(ok.react.createElement(ReaderPanel, {
      sessionId: 'session-abc',
      inputActions: { setDraft: (text) => written.push(text) },
    }))

    assert.deepEqual(written, ['一段摘抄'], '输入框里已有的字为空时，直接写入原文')
    assert.equal(
      takeDraftHandoff(draftHandoffs, 'session-abc', Date.now()).action,
      'wait',
      '兑现之后必须清掉 —— 否则重挂一次会把同一段文字再送一遍',
    )
  })
})

test('交接：还没轮到我们 / 输入框接口还没到，都不许清空棒子', async () => {
  // 取代 L2605「交接：`wait` 必须在清空之前返回，否则文字永久丢失」。旧断言比较
  // `indexOf("if (decision.action === 'wait') return")` 与 `indexOf('commitDraftHandoff(...)')`
  // 的先后。
  //
  // ⚠️ 为什么必须用**两段**来钉：`commitDraftHandoff(map, sessionId)` 只删**当前会话**
  //    那一格，所以"把清空挪到 wait 判断之前"对"棒子属于别的会话"那种情形**观察不到**
  //    （它删的是另一格）。真正会被顺序反了打中的，是**输入框接口还没到**那条提前返回 ——
  //    那才是"文字永久丢失"的真身（见 lib/client.js 里那一句的说明）。两段一起才完整。
  //
  // 证伪方式：
  //   · 把 `if (decision.action === 'wait') return` 删掉 ⇒ 第一段里 `written` 会收到
  //     一个 `undefined`（拿 wait 分支往下走），并且/或者别人的棒子被吞 ⇒ 红；
  //   · 把 `commitDraftHandoff` 挪到 `inputActions === undefined` 那条提前返回**之前**
  //     ⇒ 第二段第一次渲染就把棒子清了，第二次渲染兑现不出任何东西 ⇒ 红。
  const waitCase = await panelRuntime()
  await withFetch(waitCase.fetchStub, async () => {
    const { depositDraftHandoff, takeDraftHandoff, draftHandoffs, ReaderPanel } = waitCase.internals
    // 棒子是给 session-B 的，而现在挂的是 session-A 的面板。
    depositDraftHandoff(draftHandoffs, 'session-B', 'B 的摘抄', Date.now())
    const written = []
    waitCase.render(waitCase.react.createElement(ReaderPanel, {
      sessionId: 'session-A',
      inputActions: { setDraft: (text) => written.push(text) },
    }))

    assert.deepEqual(written, [], '还没轮到我们，一个字都不该往输入框里写')
    assert.equal(
      takeDraftHandoff(draftHandoffs, 'session-B', Date.now()).action,
      'deliver',
      'B 的棒子必须原样留着 —— 它还没被兑现',
    )
  })

  const lateCase = await panelRuntime()
  await withFetch(lateCase.fetchStub, async () => {
    const { depositDraftHandoff, takeDraftHandoff, draftHandoffs, ReaderPanel } = lateCase.internals
    depositDraftHandoff(draftHandoffs, 'session-abc', '一段摘抄', Date.now())

    // 第一次挂载：输入框接口**还没注入**（宿主晚一步）。
    lateCase.render(lateCase.react.createElement(ReaderPanel, { sessionId: 'session-abc' }))
    assert.equal(
      takeDraftHandoff(draftHandoffs, 'session-abc', Date.now()).action,
      'deliver',
      '⚠️ 接口还没到时必须留着棒子 —— 先清后写就是"文字永久丢失"',
    )

    // 接口到了：依赖变化让 effect 再跑一次，这时候才兑现。
    const written = []
    lateCase.render(lateCase.react.createElement(ReaderPanel, {
      sessionId: 'session-abc',
      inputActions: { setDraft: (text) => written.push(text) },
    }))
    assert.deepEqual(written, ['一段摘抄'], '接口到了要真的兑现（这一句证明上一句的"留着"是有用的）')
  })
})

//#endregion

//#region 竞态：先发的请求后回来，不许覆盖后开的那本书

test('竞态：切书时先发的目录/进度响应不许覆盖后开的那本书（openGuard）', async () => {
  // 取代 L2701「竞态守卫：每个按书加载的资源各自装了守卫」里 **openGuard 那一行**
  // （旧断言数 `if (!openGuard.isCurrent(ticket)) return` 在源码里出现了两次）。
  //
  // ⚠️ 旧用例整体**没有**被这里完整取代 —— 它逐个数 9 个守卫各有几处提前返回，
  //    这里只真的跑了其中 2 个（本条的 openGuard 与下一条的 notesGuard）。
  //    其余 7 个（binding / background / persona / discussions / drafts / trash，
  //    以及"有守卫没登记进表"那条反向断言）**要转它还需要**：每个资源各写一条
  //    "挂住旧书的请求 → 换书 → 放行 → 断言界面还是新书的"场景，那需要先给
  //    CompanionView 的四个加载器各配一套路由与"哪一段文字代表这本书的数据"的判据。
  //
  // 怎么制造乱序：`makeFetch` 的路由处理函数可以返回一个**受控 Promise**，
  // 于是"先发的挂住、后发的先回来"这件事完全可编程。
  //
  // 证伪方式：删掉 `openBook` 里 `then` 的 `if (!openGuard.isCurrent(ticket)) return`
  // ⇒ A 的迟到目录会写进已经翻篇的界面 ⇒ 末尾两条断言红。
  const { react, render, act, internals } = await runtime()
  const aToc = gate()
  const aProgress = gate()
  const bookA = { bookId: 'aaaaaaaaaaaaaaaa', title: '书A', chapterCount: 1, byteLength: 1024, encoding: 'utf-8', progress: null }
  const bookB = { bookId: 'bbbbbbbbbbbbbbbb', title: '书B', chapterCount: 1, byteLength: 1024, encoding: 'utf-8', progress: null }
  const { fetch, calls } = makeFetch([
    ['/library', { body: { ok: true, books: [bookA, bookB] } }],
    ['/health', { body: { ok: true, quarantined: [] } }],
    ['/books/aaaaaaaaaaaaaaaa/chapters', () => aToc.promise],
    ['/books/aaaaaaaaaaaaaaaa/progress', () => aProgress.promise],
    ['/books/bbbbbbbbbbbbbbbb/chapters', {
      body: { ok: true, chapters: [{ index: 0, title: 'B 的第一章', length: 100, volume: null, kind: 'chapter' }] },
    }],
    ['/books/bbbbbbbbbbbbbbbb/progress', { body: { ok: true, progress: { chapterIndex: 0, charOffset: 0 } } }],
  ])

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.ReaderPanel, { sessionId: 'session-abc' }))
    tree = await settle({ act })

    const rowFor = (title) => findNode(tree, (node) => node.props?.className === 'drc-item'
      && treeText(node).includes(title))
    const rowA = rowFor('书A')
    assert.ok(rowA !== null, `书架上要先能看见书A：${treeText(tree).slice(0, 300)}`)

    // ① 点开 A：它的目录 / 进度请求被挂住。
    tree = act(() => rowA.props.onClick())
    assert.ok(treeText(tree).includes('正在解析目录…'), 'A 的目录还没回来')
    const backToShelf = findNode(tree, (node) => node.props?.title === '返回')
    assert.ok(backToShelf !== null, '目录页要有返回按钮')

    // ② 回书架、点开 B：B 的请求立刻回来。
    tree = act(() => backToShelf.props.onClick())
    const rowB = rowFor('书B')
    assert.ok(rowB !== null, `回书架后还要能看见书B：${treeText(tree).slice(0, 300)}`)
    tree = act(() => rowB.props.onClick())
    tree = await settle({ act })

    const opened = treeText(tree)
    assert.ok(opened.includes('B 的第一章'), `界面上应该是 B 的目录：${opened.slice(0, 300)}`)
    assert.ok(opened.includes('书B'), '标题也要是 B')
    assert.ok(!opened.includes('A 的第一章'), 'A 的目录还没放行，此刻不该出现')

    // ③ 放行 A —— 先发的请求**后**回来。
    const issued = calls.map((call) => call.url)
    assert.ok(
      issued.findIndex((url) => url.includes('aaaaaaaaaaaaaaaa')) < issued.findIndex((url) => url.includes('bbbbbbbbbbbbbbbb')),
      `A 的请求必须**先**发出（否则这条用例测的不是"先发的后回来"）：${issued.join(' | ')}`,
    )
    aToc.release(jsonResponse({
      ok: true,
      chapters: [{ index: 0, title: 'A 的第一章', length: 100, volume: null, kind: 'chapter' }],
    }))
    aProgress.release(jsonResponse({ ok: true, progress: { chapterIndex: 0, charOffset: 0 } }))
    tree = await settle({ act })

    const after = treeText(tree)
    assert.ok(after.includes('B 的第一章'), `⚠️ A 的迟到响应不许覆盖 B 的目录：${after.slice(0, 300)}`)
    assert.ok(!after.includes('A 的第一章'), 'A 的目录一个字都不许写进已经翻篇的界面')
    assert.ok(after.includes('书B'), '书也还是 B')
  })
})

test('竞态：切书时先发的笔记列表响应不许写进后开的那本书（notesGuard）', async () => {
  // 取代 L2701 里 **notesGuard 那一行**（旧断言数它有 5 处提前返回）。
  // 旧注释说得很清楚：`NotesView` 那几条加载器**从前一个守卫都没有**（2026-10-01
  // 三方评审查出），切书 / 翻页 / 连点两次删除时先发的请求可能后回来。这里真的切一次书。
  //
  // 证伪方式：删掉 `loadPage` / `refreshNotes` 里 `if (!notesGuard.isCurrent(ticket)) return`
  // ⇒ A 的迟到笔记列表会替换掉 B 的那一页 ⇒ 末尾两条断言红。
  const { react, render, act, internals } = await runtime()
  const aNotes = gate()
  const bookA = { bookId: 'aaaaaaaaaaaaaaaa', title: '书A' }
  const bookB = { bookId: 'bbbbbbbbbbbbbbbb', title: '书B' }
  const { fetch, calls } = makeFetch([
    ['/books/aaaaaaaaaaaaaaaa/drafts', { body: { ok: true, drafts: [] } }],
    ['/books/aaaaaaaaaaaaaaaa/location', { body: { ok: true, location: null } }],
    ['/books/aaaaaaaaaaaaaaaa/notes?limit=', () => aNotes.promise],
    ['/books/bbbbbbbbbbbbbbbb/drafts', { body: { ok: true, drafts: [] } }],
    ['/books/bbbbbbbbbbbbbbbb/location', { body: { ok: true, location: null } }],
    ['/books/bbbbbbbbbbbbbbbb/notes?limit=', {
      body: { ok: true, notes: [noteFixture('nb', 'B 的摘抄')], total: 1, hasMore: false, nextCursor: null },
    }],
  ])

  await withFetch(fetch, async () => {
    const props = (book) => ({ book, activeDraft: null, sessionId: 'session-abc', onBack: () => {} })
    render(react.createElement(internals.NotesView, props(bookA)))
    await settle({ act })

    // 换书：同一个组件实例拿到新的 book ⇒ 那几个加载器各自重发。
    let tree = render(react.createElement(internals.NotesView, props(bookB)))
    tree = await settle({ act })
    assert.ok(treeText(tree).includes('B 的摘抄'), `B 的笔记要先画出来：${treeText(tree).slice(0, 300)}`)

    const issued = calls.map((call) => call.url)
    assert.ok(
      issued.findIndex((url) => url.includes('aaaaaaaaaaaaaaaa/notes')) < issued.findIndex((url) => url.includes('bbbbbbbbbbbbbbbb/notes')),
      `A 的笔记请求必须先发出：${issued.join(' | ')}`,
    )

    aNotes.release(jsonResponse({
      ok: true, notes: [noteFixture('na', 'A 的摘抄')], total: 7, hasMore: true, nextCursor: 'na',
    }))
    tree = await settle({ act })

    // ⚠️ 这里**看的是 tab 上的计数**，不是列表里的那条摘抄。原因是一个替身限制：
    //    `NoteList` 是 `memo` 组件，而守卫**挡住了**迟到响应 ⇒ 状态没变 ⇒ props 没变
    //    ⇒ 替身的 `memo` 命中并 `return null`（真 React 会复用上一棵子树，这里没有）。
    //    所以"守卫生效"这条路上，列表子树会从树上消失 —— 拿它当判据会假红。
    //    而 `（N）` 这个计数由 `NotesView` 直接渲染（不在 memo 里），既活得下来，
    //    又正是 `applyPage` 写的那几个状态之一（`notes` / `notesTotal` / `hasMore` /
    //    `nextCursor` 是同一次写入）。A 的 total 故意给成 7 以便区分。
    assert.ok(
      treeText(tabNode(tree, '笔记')).includes('（1）'),
      `⚠️ A 的迟到响应不许写进已经翻篇的界面（笔记总数必须还是 B 的 1）：${treeText(tabNode(tree, '笔记'))}`,
    )
    assert.ok(!treeText(tree).includes('（7）'), 'A 报的 7 条不许出现在界面上')
  })
})

//#endregion

//#region 竞态（表格驱动）：L2701 剩下的受守卫资源
//
// ⚠️ 这一组取代的是 `竞态守卫：每个按书加载的资源各自装了守卫`（约 L2701）里
// **逐个资源数"提前返回有几处"** 的那些行。旧断言问的是"源码里那个 `if` 写了几次"；
// 这里对每个资源真的制造一次「先发的请求后回来」，问「界面上是谁的数据」。
//
// 手法与上面 openGuard / notesGuard 两条同款：`makeFetch` 的路由处理函数返回一个
// **受控 Promise** ⇒ 旧书的那个请求挂住、新书的立刻回来，最后才放行旧书那一个。
//
// ⚠️ 判据一律取**不在 `memo` 子树里**的东西：`NoteList` 是全文件唯一的 `memo` 组件，
//    而替身的 `memo` 命中时会 `return null`（真 React 会复用上一棵子树）—— 拿它里面的
//    文字当判据，会在"守卫生效"那条路上**假红**（这个坑已经踩过一次，见 notesGuard 那条）。
//    所以：陪读页取它**直接渲染**的那几行文字，笔记页取**选项卡上的计数**。

/** 陪读页四个加载器的默认答复（只有受测那一个会被换成 A / B 两份）。 */
const COMPANION_DEFAULTS = {
  'progress': { ok: true, binding: { sessionId: null } },
  'background?atChapter=': { ok: true, covered: { first: 1, last: 3 }, gap: null, characters: [], markdown: '', exists: true },
  'persona': { ok: true, text: '', path: '' },
  'discussions?limit=5': { ok: true, discussions: [], total: 0 },
}

/**
 * 陪读页四个受守卫资源。
 *
 * `expectB` / `forbidA` 是**能区分"这份数据属于哪本书"**的判据 —— 刻意不复用任何
 * 两本书都会出现的文案（比如 `personaGuard` 用的是编辑框里的**人设原文**，不是"读取中…"
 * 或"已保存"那类两边都有的字）。
 */
const COMPANION_RACE_CASES = [
  {
    guard: 'bindingGuard',
    route: 'progress',
    what: '陪读会话的绑定',
    a: { ok: true, binding: { sessionId: 'aaaaaaaa-1111' } },
    b: { ok: true, binding: { sessionId: 'bbbbbbbb-2222' } },
    expectB: '已绑定：bbbbbbbb-2222',
    forbidA: 'aaaaaaaa-1111',
    falsify: '删掉 `reload` 里 `.then` 的 `if (!bindingGuard.isCurrent(ticket)) return`',
  },
  {
    guard: 'backgroundGuard',
    route: 'background?atChapter=',
    what: '背景认识的水位线',
    a: { ok: true, covered: { first: 1, last: 81 }, gap: null, characters: [], markdown: '', exists: true },
    b: { ok: true, covered: { first: 1, last: 82 }, gap: null, characters: [], markdown: '', exists: true },
    expectB: '记忆到第 82 章',
    forbidA: '记忆到第 81 章',
    falsify: '删掉 `loadBackground` 里 `.then` 的 `if (!backgroundGuard.isCurrent(ticket)) return`',
  },
  {
    guard: 'personaGuard',
    route: 'persona',
    what: '书友设定（**会回填编辑框**，放过去就不是显示错乱，是写错书）',
    a: { ok: true, text: 'A 的人设：安静的书友', path: '/a/persona.md' },
    b: { ok: true, text: 'B 的人设：爱较真的书友', path: '/b/persona.md' },
    expectB: 'B 的人设：爱较真的书友',
    forbidA: 'A 的人设：安静的书友',
    falsify: '删掉 `loadPersona` 里 `if (!personaGuard.isCurrent(ticket)) return undefined`',
  },
  {
    guard: 'discussionsGuard',
    route: 'discussions?limit=5',
    what: '讨论历史的条数',
    a: {
      ok: true, total: 71,
      discussions: [{ kind: 'note', at: '2026-10-01T10:00:00.000Z', chapterIndex: 0, thought: 'A 的讨论', excerpt: '', reply: '' }],
    },
    b: {
      ok: true, total: 82,
      discussions: [{ kind: 'note', at: '2026-10-02T10:00:00.000Z', chapterIndex: 0, thought: 'B 的讨论', excerpt: '', reply: '' }],
    },
    expectB: '共 82 条',
    forbidA: '共 71 条',
    falsify: '删掉 `loadDiscussions` 里 `.then` 的 `if (!discussionsGuard.isCurrent(ticket)) return`',
  },
]

/**
 * 每个受测资源跑**两遍**：旧书那份**成功**回来、以及旧书那份**失败**回来。
 *
 * ⚠️ 两个方向都要：`.then` 的验票挡住"旧数据写进新界面"，`.catch` 的验票挡住
 *    "**旧书的失败**记到新书头上"（`setBinding({error})` / `setBackground(null)` /
 *    `setPersona(null)` / `setDiscussions([]) + setDiscussionTotal(0)`）。
 *    判据是同一个 —— 放行旧书那一个之后，B 的数据必须还在。
 */
const COMPANION_SCENARIOS = []
for (const item of COMPANION_RACE_CASES) {
  COMPANION_SCENARIOS.push({
    item,
    site: `${item.guard}.then`,
    release: item.a,
    kind: '迟到成功',
    falsify: item.falsify,
  })
  COMPANION_SCENARIOS.push({
    item,
    site: `${item.guard}.catch`,
    release: { status: 500, body: { reason: '宿主读这一路时炸了' } },
    kind: '迟到失败',
    falsify: `删掉 \`${item.guard}\` 的 \`.catch\` 里那一处 \`if (!${item.guard}.isCurrent(ticket)) return\``,
  })
}

for (const { item, site, release, kind, falsify } of COMPANION_SCENARIOS) {
  test(`竞态：陪读页切书时 ${site} 的${kind}不许写进新书的界面（${item.what}）`, async () => {
    // 证伪方式：${falsify} ⇒ 旧书那一路会写进已经翻篇的界面 ⇒ 末尾两条断言红。
    const { react, render, act, internals } = await runtime()
    const held = gate()
    const bookA = { bookId: 'aaaaaaaaaaaaaaaa', title: '书A' }
    const bookB = { bookId: 'bbbbbbbbbbbbbbbb', title: '书B' }
    /** 一本书的四条路由；受测那一条由 `hungSuffix` 决定挂不挂住。 */
    const routesFor = (bookId, overrides, hungSuffix) => Object
      .entries({ ...COMPANION_DEFAULTS, ...overrides })
      .map(([suffix, body]) => [
        `/books/${bookId}/${suffix}`,
        suffix === hungSuffix ? () => held.promise : { body },
      ])
    const { fetch, calls } = makeFetch([
      ['/settings', { body: { ok: true, exportDir: '' } }],
      ...routesFor('aaaaaaaaaaaaaaaa', { [item.route]: item.a }, item.route),
      ...routesFor('bbbbbbbbbbbbbbbb', { [item.route]: item.b }, null),
    ])

    await withFetch(fetch, async () => {
      const view = (book) => ({ book, sessionId: 'session-abc', onBack: () => {} })
      render(react.createElement(internals.CompanionView, view(bookA)))
      await settle({ act })

      // 换书：同一个实例拿到新的 `book` ⇒ 四个加载器的 `useCallback` 都换了身份，
      // 四个 effect 各自重跑一次。
      let tree = render(react.createElement(internals.CompanionView, view(bookB)))
      tree = await settle({ act })

      const shown = treeText(tree)
      assert.ok(shown.includes(item.expectB), `B 的数据要先画出来（否则这条用例的前提没了）：${shown.slice(0, 400)}`)
      assert.ok(!shown.includes(item.forbidA), 'A 的数据还没放行，此刻不该出现')

      const issued = calls.map((call) => call.url)
      const at = (bookId) => issued.findIndex((url) => url.includes(`/books/${bookId}/${item.route}`))
      assert.ok(
        at('aaaaaaaaaaaaaaaa') !== -1 && at('aaaaaaaaaaaaaaaa') < at('bbbbbbbbbbbbbbbb'),
        `A 的请求必须**先**发出（否则这条用例测的不是"先发的后回来"）：${issued.join(' | ')}`,
      )

      // 放行旧书那一个 —— 它现在才回来（成功或失败，见 `release`）。
      held.release(release.status === undefined ? jsonResponse(release) : jsonResponse(release.body, release.status))
      tree = await settle({ act })

      const after = treeText(tree)
      assert.ok(after.includes(item.expectB), `⚠️ A 的${kind}不许覆盖 B 的界面：${after.slice(0, 400)}`)
      assert.ok(!after.includes(item.forbidA), 'A 的数据一个字都不许写进已经翻篇的界面')
    })
  })
}

/** 一条草稿的形状（草稿列表会读 `draftId` / `updatedAt` / `excerpt`）。 */
const draftFixture = (draftId, excerpt) => ({
  draftId, excerpt, thought: '', chapterIndex: 0, updatedAt: '2026-10-02T10:00:00.000Z', tags: [],
})

/**
 * 笔记页那两个受守卫资源。
 *
 * 判据是**选项卡上的计数**（`笔记 （N）` / `草稿 （N）` / `回收站 （N）`）—— 由
 * `NotesView` 直接渲染，不在 `NoteList` 那个 memo 子树里；而它正是 `refreshDrafts` /
 * `loadTrash` 写的那份状态。
 *
 * ⚠️ 回收站那两条还多钉一件事：`loadTrash` 的 **catch 分支会清零**（`setTrashTotal(0)`
 *    + `setTrashError(...)`），所以"旧书的**失败**响应不许把新书的计数清成 0"是最好的判据
 *    —— 旧注释里那句"不验票就等于把另一本书的计数清成 0"说的正是它。
 */
const NOTES_RACE_CASES = [
  {
    guard: 'draftsGuard',
    route: 'drafts',
    what: '草稿栏的条数',
    a: { ok: true, drafts: [draftFixture('da1', 'A 的草稿一'), draftFixture('da2', 'A 的草稿二')] },
    b: { ok: true, drafts: [draftFixture('db1', 'B 的草稿')] },
    countTab: '草稿',
    expectCount: '（1）',
    forbidCount: '（2）',
    click: false,
    falsify: '删掉 `refreshDrafts` 里 `.then` 的 `if (!draftsGuard.isCurrent(ticket)) return`',
  },
  {
    guard: 'trashGuard',
    route: 'notes?trashed=1',
    what: '回收站的条数（成功路径）',
    a: { ok: true, notes: [noteFixture('ta1', 'A 的回收站一'), noteFixture('ta2', 'A 的回收站二')], total: 5 },
    b: { ok: true, notes: [noteFixture('tb1', 'B 的回收站')], total: 1 },
    countTab: '回收站',
    expectCount: '（1）',
    forbidCount: '（5）',
    click: true,
    falsify: '删掉 `loadTrash` 里 `.then` 的 `if (!trashGuard.isCurrent(ticket)) return`',
  },
  {
    guard: 'trashGuard',
    route: 'notes?trashed=1',
    what: '旧书的**失败**响应不许把新书的计数清成 0',
    a: { status: 500, body: { reason: '宿主读回收站时炸了' } },
    b: { ok: true, notes: [noteFixture('tb1', 'B 的回收站')], total: 1 },
    countTab: '回收站',
    expectCount: '（1）',
    forbidCount: '（0）',
    click: true,
    // 失败分支除了清零，还会把错误文案写进界面 —— 一并禁掉。
    forbidText: '回收站这次没读到',
    falsify: '删掉 `loadTrash` 里 `.catch` 的 `if (!trashGuard.isCurrent(ticket)) return`',
  },
]

for (const item of NOTES_RACE_CASES) {
  test(`竞态：笔记页切书时 ${item.guard} 的迟到响应不许覆盖新书（${item.what}）`, async () => {
    // 证伪方式：${item.falsify} ⇒ 旧书那份数据会写进已经翻篇的界面 ⇒ 末尾两条断言红。
    const { react, render, act, internals } = await runtime()
    const held = gate()
    const bookA = { bookId: 'aaaaaaaaaaaaaaaa', title: '书A' }
    const bookB = { bookId: 'bbbbbbbbbbbbbbbb', title: '书B' }
    /** 笔记页首屏三条 + 受测那一条（受测那条按 `hung` 决定挂不挂住）。 */
    const routesFor = (bookId, payload, hung) => {
      const spec = payload.status === undefined ? { body: payload } : payload
      const merged = {
        'drafts': { body: { ok: true, drafts: [] } },
        'location': { body: { ok: true, location: null } },
        'notes?limit=': { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } },
        [item.route]: hung ? { hang: true } : spec,
      }
      return Object.entries(merged).map(([suffix, value]) => [
        `/books/${bookId}/${suffix}`,
        value.hang === true ? () => held.promise : value,
      ])
    }
    const { fetch, calls } = makeFetch([
      ...routesFor('aaaaaaaaaaaaaaaa', item.a, true),
      ...routesFor('bbbbbbbbbbbbbbbb', item.b, false),
    ])

    await withFetch(fetch, async () => {
      const view = (book) => ({ book, activeDraft: null, sessionId: 'session-abc', onBack: () => {} })
      // 计数判据只取**那个选项卡自己**的文字（`草稿 （1）`）—— `treeText` 在节点之间
      // 会插空格，拿整棵树的文本去 `includes('草稿 （1）')` 会因为它多插一个空格而假红。
      const countText = (tree) => treeText(tabNode(tree, item.countTab))

      render(react.createElement(internals.NotesView, view(bookA)))
      let tree = await settle({ act })
      if (item.click === true) {
        tree = act(() => tabNode(tree, item.countTab).props.onClick())
        tree = await settle({ act })
      }

      // 换书。
      tree = render(react.createElement(internals.NotesView, view(bookB)))
      tree = await settle({ act })
      if (item.click === true) {
        // ⚠️ `loadTrash` **不是** effect 驱动的（只有"点回收站 tab / 删除之后"才取），
        //    所以换书之后要再点一次才会为新书重取 —— 这不是凑测试，正是它的接线形状。
        tree = act(() => tabNode(tree, item.countTab).props.onClick())
        tree = await settle({ act })
      }

      const shown = countText(tree)
      assert.ok(shown.includes(item.expectCount), `B 的计数要先画出来（否则这条用例的前提没了）：「${shown}」`)
      assert.ok(!shown.includes(item.forbidCount), `A 的计数此刻还不该出现：「${shown}」`)

      const issued = calls.map((call) => call.url)
      const at = (bookId) => issued.findIndex((url) => url.includes(`/books/${bookId}/${item.route}`))
      assert.ok(
        at('aaaaaaaaaaaaaaaa') !== -1 && at('aaaaaaaaaaaaaaaa') < at('bbbbbbbbbbbbbbbb'),
        `A 的请求必须**先**发出（否则这条用例测的不是"先发的后回来"）：${issued.join(' | ')}`,
      )

      held.release(item.a.status === undefined ? jsonResponse(item.a) : jsonResponse(item.a.body, item.a.status))
      tree = await settle({ act })

      const after = countText(tree)
      const afterAll = treeText(tree)
      assert.ok(after.includes(item.expectCount), `⚠️ A 的迟到响应不许覆盖 B 的计数：「${after}」`)
      assert.ok(!after.includes(item.forbidCount), 'A 的计数一个字都不许写进已经翻篇的界面')
      if (item.forbidText !== undefined) {
        assert.ok(!afterAll.includes(item.forbidText), `⚠️ A 的**失败**响应也不许把错误写进 B 的界面：${afterAll.slice(0, 400)}`)
      }
    })
  })
}

/**
 * 落点竞态的两条出口（成功 / 失败）。表驱动，形状与 `NOTES_RACE_CASES` 一致。
 *
 * ⚠️ 这里守的是**第四个按书加载的资源**：`refreshDrafts` / `refreshNotes` 各自在
 *    自己内部验票，而 `refresh()` 的 `Promise.all` 里还挂着一条 `/location` ——
 *    从前谁都没管它（2026-10-03 补上）。
 *
 * 后果不是"少显示一个字段"：落点下面就是「重新检测位置 / 手填绝对目录 / 改到此处」
 * 三颗按钮，它们都作用在**当前**这本书上 ⇒ 读者会照着**旧书**的落点去操作新书。
 * 失败分支另有一害：旧书的错误文案也会写进已经翻篇的界面。
 *
 * 它同时也是**普查的盲区**：那个反向断言只查"声明了却没登记"，对"新加了一个按书
 * 加载的资源、一个守卫都没装"完全无感。`locationGuard` 就是补这个洞。
 */
const LOCATION_RACE_CASES = [
  {
    what: '旧书的落点不许覆盖新书的',
    a: { ok: true, location: { dir: 'A 的落点' } },
    forbid: 'A 的落点',
    falsify: '删掉 `refresh` 里 `.then` 的 `if (!locationGuard.isCurrent(ticket)) return`',
  },
  {
    what: '旧书的**失败**响应不许把错误写进新书的界面',
    a: { status: 500, body: { reason: '宿主读落点时炸了' } },
    forbid: '宿主读落点时炸了',
    falsify: '删掉 `refresh` 里 `.catch` 的 `if (!locationGuard.isCurrent(ticket)) return`',
  },
]

for (const item of LOCATION_RACE_CASES) {
  test(`竞态：切书时旧书的 /location 迟到响应不许覆盖新书（${item.what}）`, async () => {
    // 证伪方式：${item.falsify} ⇒ 旧书那份响应会写进已经翻篇的界面 ⇒ 末尾两条断言红。
    const { react, render, act, internals } = await runtime()
    const held = gate()
    const bookA = { bookId: 'aaaaaaaaaaaaaaaa', title: '书A' }
    const bookB = { bookId: 'bbbbbbbbbbbbbbbb', title: '书B' }

    /** 三条按书加载的资源各一条路由；A 的落点按 `hung` 挂住，B 的正常返回。 */
    const routesFor = (bookId, dir, hung) => {
      const merged = {
        'drafts': { body: { ok: true, drafts: [] } },
        'notes?limit=': { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } },
        'location': hung ? { hang: true } : { body: { ok: true, location: { dir } } },
      }
      return Object.entries(merged).map(([suffix, value]) => [
        `/books/${bookId}/${suffix}`,
        value.hang === true ? () => held.promise : value,
      ])
    }
    const { fetch, calls } = makeFetch([
      ...routesFor('aaaaaaaaaaaaaaaa', 'A 的落点', true),
      ...routesFor('bbbbbbbbbbbbbbbb', 'B 的落点', false),
    ])

    await withFetch(fetch, async () => {
      const view = (book) => ({ book, activeDraft: null, sessionId: 'session-abc', onBack: () => {} })
      render(react.createElement(internals.NotesView, view(bookA)))
      await settle({ act })

      // 换书：B 的落点先画出来，这条用例的前提才成立。
      let tree = render(react.createElement(internals.NotesView, view(bookB)))
      tree = await settle({ act })
      assert.ok(
        treeText(tree).includes('B 的落点'),
        `B 的落点要先画出来（否则测的不是"旧覆盖新"）：${treeText(tree).slice(0, 300)}`,
      )

      // A 的请求必须**先**发出，否则测的不是"先发的后回来"。
      const issued = calls.map((call) => call.url)
      const at = (bookId) => issued.findIndex((url) => url.includes(`/books/${bookId}/location`))
      assert.ok(
        at('aaaaaaaaaaaaaaaa') !== -1 && at('aaaaaaaaaaaaaaaa') < at('bbbbbbbbbbbbbbbb'),
        `A 的 /location 必须先发出：${issued.join(' | ')}`,
      )

      // 旧书那份迟到响应现在才回来。
      held.release(item.a.status === undefined ? jsonResponse(item.a) : jsonResponse(item.a.body, item.a.status))
      tree = await settle({ act })

      const shown = treeText(tree)
      assert.ok(!shown.includes(item.forbid), `⚠️ 旧书的响应不许写进已经翻篇的界面：${shown.slice(0, 400)}`)
      assert.ok(shown.includes('B 的落点'), `新书的落点必须还在：${shown.slice(0, 400)}`)
    })
  })
}

//#endregion

//#region L696 剩下的两件：P3-3 自动保存留痕 / P3-5 归档增量没写成

/** 自动保存是 `setTimeout(800ms)` 的防抖，等待要比它长。 */
const AUTOSAVE_WAIT_MS = 950
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('自动保存失败要留下常驻标记，存成功之后再撤掉它', async () => {
  // 取代 L696 的 **P3-3** 那一件（旧断言是三条源码文本：`autosaveFailed` 的 state 声明、
  // `setAutosaveFailed(true)`、`setAutosaveFailed(false)`，外加一条"标记要渲染出来"的正则）。
  //
  // 失效模式（旧注释里写的）：一条**静默失败**的自动保存，配上"切页签 / 刷新会回到服务端
  // 那一份"的既有语义 ⇒ 读者以为回应存住了，而磁盘上还是旧的。所以标记必须**常驻可见**
  // （不是 toast：它在读者解决它之前一直成立），并且在存成功之后**撤掉**。
  //
  // ⚠️ 自动保存挂在 `reply` 变化的 effect 上，所以这条用例要真的等两次防抖。
  //
  // 证伪方式：
  //   · 把 effect 里 `.catch(() => { setAutosaveFailed(true) })` 的 `setAutosaveFailed(true)`
  //     删掉（退回那个空的 catch）⇒ 第一段找不到标记 ⇒ 红；
  //   · 把 `persist` 成功分支里的 `setAutosaveFailed(false)` 删掉 ⇒ 第二段标记不消失 ⇒ 红；
  //   · 把 `autosaveFailed ? h(...) : null` 那一支删掉 ⇒ 第一段红。
  const { react, render, act, internals } = await runtime()
  let posts = 0
  const draft = { draftId: 'd1', excerpt: '摘抄', thought: '感想', tags: [] }
  /** 这条用例自己发出的 POST（按请求体认领，理由见下面替身里的 ⚠️）。 */
  const isOurs = (options) => {
    try {
      const body = JSON.parse(options.body ?? '{}')
      return body.draftId === 'd1' && body.excerpt === '摘抄'
    } catch {
      return false
    }
  }
  const { fetch } = makeFetch([
    ['/location', { body: { ok: true, location: null } }],
    ['/notes?limit=', { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } }],
    ['/drafts', (target, options) => {
      if (options.method !== 'POST') return jsonResponse({ ok: true, drafts: [] })
      // ⚠️ **只认领自己那一次**：`--test-isolation=none` 让整个测试套跑在**同一个进程**里，
      //    别的用例渲染 `NotesView` 时挂下的 800ms 防抖定时器若没被卸载清掉，会晚一步打到
      //    这个替身上来 —— 实测这一条在**全量**里 `posts=6`（单独跑恒为 1）。
      //    后果不是"多打几次请求"，而是**假红**：替身按全局计数只让第 1 次失败，于是那次
      //    失败被别人用掉、我们这一次变成成功 ⇒ `setAutosaveFailed(false)` 把标记撤了。
      //    按请求体（`draftId` + `excerpt`）认领，这条用例就与进程里的其他人无关了。
      if (!isOurs(options)) return jsonResponse({ ok: true, draft: { ...draft, reply: '一段回应' } })
      posts += 1
      // 第一次自动保存失败（盘满了），之后的都成功。成功那一份的 `reply` 与框里一致，
      // 免得 `applyActive` 回写又把 effect 触发一轮（那会留下一个跑出用例的定时器）。
      return posts === 1
        ? jsonResponse({ reason: '磁盘满了' }, 500)
        : jsonResponse({ ok: true, draft: { ...draft, reply: '一段回应' } })
    }],
  ])

  await withFetch(fetch, async () => {
    let tree = render(react.createElement(internals.NotesView, notesProps({ activeDraft: draft })))
    tree = await settle({ act })
    await wait(AUTOSAVE_WAIT_MS)
    tree = await settle({ act })

    assert.ok(posts >= 1, '挂载那一趟就该自动存一次（否则这条用例的前提没了）')
    assert.ok(
      treeText(tree).includes('刚才那次**自动保存**没成功'),
      `自动保存失败必须留下常驻标记（不是会消失的 toast）：posts=${posts}；${treeText(tree).slice(0, 500)}`,
    )

    // 再改一次回应框：这一次 POST 成功 ⇒ 标记要撤掉。
    const replyBox = findNode(tree, (node) => node.props?.id === 'drc-note-reply')
    assert.ok(replyBox !== null, '回应框要在（P2-12 那条也靠它）')
    act(() => replyBox.props.onChange({ target: { value: '一段回应' } }))
    await wait(AUTOSAVE_WAIT_MS)
    tree = await settle({ act })

    assert.ok(posts >= 2, `改了回应框就该再自动存一次：${posts}`)
    assert.ok(
      !treeText(tree).includes('刚才那次**自动保存**没成功'),
      '存成功之后必须把标记撤掉 —— 留着它等于一直对读者喊狼来了',
    )
  })
})

test('归档的「历代增量记录」没写成时要明说（发到会话那一趟）', async () => {
  // 取代 L696 的 **P3-5** 那一件（旧断言 `source.includes('data.archived?.historyWritten === false')`）。
  //
  // ⚠️ 这一件**不属于**"CSS / 模板文本"那一类，所以它不该留在文本钉子里：那句话是
  //    `memoryFillClause` 产出的、**关于"已经发生了什么"的陈述**。那条 delta 记的是
  //    "这一笔搬走了什么"的**原文**，写失败时文件照旧被搬走 —— 不说的话，读者会以为
  //    "历代备份三件套"齐全，而它少了不可逆的一件。说错了就是一句谎话。
  //
  // 证伪方式：
  //   · 把 `data.archived?.historyWritten === false` 改成 `=== true`（或把 `historyNote`
  //     那一支删掉）⇒ 第一段找不到那句话 ⇒ 红；
  //   · 把 `data.archived?.moved > 0` 这个前提去掉（或把 `archivedNote` 删掉）⇒
  //     反向段（`historyWritten: true` 时"已归档"也要说）红。
  const runSend = async (archived) => {
    const { react, render, act, internals } = await runtime()
    const draft = { draftId: 'd1', excerpt: '一段摘抄', thought: '一段感想', tags: [] }
    const { fetch, calls } = makeFetch([
      ['/drafts', { body: { ok: true, drafts: [] } }],
      ['/location', { body: { ok: true, location: null } }],
      ['/notes?limit=', { body: { ok: true, notes: [], total: 0, hasMore: false, nextCursor: null } }],
      ['/progress', { body: { ok: true, progress: null, binding: { sessionId: null } } }],
      ['/background/fill', { body: { ok: true, covered: { first: 1, last: 3 }, gap: null, archived } }],
      ['/discussions', { body: { ok: true } }],
    ])
    let text = ''
    await withFetch(fetch, async () => {
      let tree = render(react.createElement(internals.NotesView, notesProps({
        activeDraft: draft,
        inputActions: { setDraft: () => {} },
      })))
      tree = await settle({ act })

      const send = findNode(tree, (node) => node.props?.title === '把摘抄与感想放进会话输入框')
      assert.ok(send !== null, `笔记页要有「① 发到会话去聊」：${treeText(tree).slice(0, 300)}`)
      tree = act(() => send.props.onClick())
      tree = await settle({ act })
      text = treeText(tree)
      assert.ok(calls.some((call) => call.url.includes('/background/fill')), '发之前得真的去补过一次前文记忆')
      assert.ok(text.includes('前文记忆已更新到第 1–3 章'), `补齐结果要照常说出来：${text.slice(0, 400)}`)
    })
    return text
  }

  const warned = await runSend({ moved: 5, historyWritten: false })
  assert.ok(
    warned.includes('历代增量记录没写成功'),
    `归档的增量记录没写成时必须明说（少一件是不可逆的）：${warned.slice(0, 600)}`,
  )
  assert.ok(warned.includes('冷档案'), '要说清「冷档案」本身没问题，否则读者会以为记忆被删了')

  const fine = await runSend({ moved: 5, historyWritten: true })
  assert.ok(!fine.includes('没写成功'), '写成了就不许报警（否则那句话是永远为真的假话）')
  assert.ok(fine.includes('已**归档**'), '归档这件事本身照常要说（否则上面那条反向断言是空的）')
})

//#endregion

//#region 唯一一条源码普查（**不是**行为断言）：L2356 里行为化不了的那两件性质
//
// ⚠️ 这是本文件里**唯一**一条读生产源码的断言，理由必须写清楚，否则它就是又一颗文本钉子。
//
// L2356（`竞态守卫：每个按书加载的资源各自装了守卫`）问两件事，其中两件行为断言
// **原则上覆盖不到**：
//
//   ① **反向普查**：`const XGuard = useLatestGuard()` 声明了几个，就必须有几个登记在表里。
//      它管的是**将来**新加的资源 —— 新资源在行为上还没有任何用例（这个文件里一条都没有），
//      于是"它忘了装守卫"在行为层**不可观测**。
//   ② **逐守卫的验票处数**：一个加载器有 1~5 处写状态的出口（`notesGuard` 就有 5 处：
//      `reloadNotesPage` 的成功 + 失败、`refreshNotes`、`loadPage` 的两处）。行为断言只能
//      覆盖我**真的构造出来**的那些出口 —— 没构造出来的那些少了验票，行为层看不见。
//      本次已行为化的出口清单见文件末尾的"已行为化 / 未行为化"注释。
//
// 它**脆弱在哪**（依赖它的人要知道自己在依赖什么）：
//   · 它钉的是**源码形状**而不是行为：把 `useLatestGuard()` 换名字、把验票换成
//     `guard.stale(ticket)` 这种 API、或者把"取票—验票"抽成一个包装函数
//     （`guarded(guard, ticket, fn)`），它都会**假红** —— 而那时行为是对的。
//   · 它**骗得过去**：`if (!g.isCurrent(ticket)) { /* 什么都不做 */ } return` 照样计数。
//     所以它只是补充，真正的保证在那些行为用例里。
//   · 它认不出**不可达**的验票（写在死代码里也算数）。
//
// 结论：L2356 **可以整体删掉**，前提是这一条跟着留下 —— 它就是那条断言的替代。
// 它也是"把已删的 `previewGuard` / `captureGuard` 加回来"的拦网：加回来会让
// 声明数 > 表长。
const GUARD_CENSUS = [
  ['bindingGuard', 2],
  ['backgroundGuard', 2],
  ['personaGuard', 2],
  ['discussionsGuard', 2],
  ['openGuard', 2],
  ['notesGuard', 6],
  ['draftsGuard', 1],
  ['trashGuard', 2],
  ['locationGuard', 2],
]

test('守卫普查（源码扫描，本文件唯一一条非行为断言）：声明数 == 登记数，且逐守卫的验票处数不变', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  for (const [guard, expected] of GUARD_CENSUS) {
    assert.ok(
      new RegExp(`const ${guard} = useLatestGuard\\(\\)`).test(source),
      `${guard} 没有声明 —— 那个资源又会被迟到响应覆盖`,
    )
    const returns = (source.match(new RegExp(`if \\(!${guard}\\.isCurrent\\(ticket\\)\\) return`, 'g')) ?? []).length
    assert.equal(
      returns,
      expected,
      `${guard} 的验票处数变了（期望 ${expected}）—— 少一处，那条路径就回到"谁后回来谁说了算"`,
    )
  }
  const declared = (source.match(/const \w+Guard = useLatestGuard\(\)/g) ?? []).length
  assert.equal(
    declared,
    GUARD_CENSUS.length,
    '有守卫没登记进普查表（新加了一个受守卫的资源，或把已删的 previewGuard / captureGuard 加了回来）',
  )
})

//#endregion

//#region 覆盖清单（给"能不能整块删掉旧用例"这个问题看的账）
//
// ── L582 `接线守卫：第三方评审第四批的界面修复（2026-10-02）`（25 条断言）──────
//   P2-10 回收站"取不到 ≠ 空的"     → 行为：回收站：读取失败要说「没读到」，成功拿到空列表才说「空的」
//   P2-11 目录卷/章节键盘可达        → 行为：目录：卷标题与章节真的键盘可达
//   P2-12 表单 label ↔ 控件          → 行为：笔记表单：每个 label 的 htmlFor 都能在树上找到同 id 的控件
//   P3-2  刷新失败必须有人接         → 行为：刷新失败必须有人接
//   P3-3  自动保存失败要留常驻标记   → 行为：自动保存失败要留下常驻标记，存成功之后再撤掉它
//   P3-5  归档增量没写成时要明说     → 行为：归档的「历代增量记录」没写成时要明说
//   ⇒ 六件全有行为替代 ⇒ **L582 可以整体删掉**（P3-5 不是"CSS/模板"那一类，见那条用例的注释）。
//
// ── L2356 `竞态守卫：每个按书加载的资源各自装了守卫` ──────────────────────────
//   已行为化的出口（每条都做过"删掉验票 ⇒ 红"的实证，见最终报告）：
//     bindingGuard.then / .catch、backgroundGuard.then / .catch、
//     personaGuard.then / .catch、discussionsGuard.then / .catch、
//     draftsGuard.then、trashGuard.then / .catch、
//     openGuard.then、notesGuard 的 `refreshNotes` 成功/失败两处（失败那处是 2026-10-04 补的，
//       它同时把普查里 notesGuard 的验票处数从 5 推到 6 —— 补的是真守卫，不是把计数凑上）。
//   **未行为化**（行为层看不见，只剩普查兜着）：
//     · openGuard.catch —— `openBook` 的 `Promise.all` 失败分支；
//     · notesGuard 另外 4 处 —— `reloadNotesPage` 的成功/失败、`loadPage` 的成功/失败；
//     · "声明数 == 登记数"这条**反向普查**本身（它管的是将来新加的资源）。
//   ⇒ 这 3 项让 L2356 **不能**整块删掉；留下上面那条普查之后**可以**整块删掉。
//
// ── L630 `接线守卫：对齐与回收站呈现（v1.62）`（9 条断言）────────────────────
//   已行为化的两件：
//     ③ 回收站不渲染翻页行 → 行为：回收站列表不渲染翻页行（笔记列表仍然渲染它）
//     ⑥ `aria-pressed`     → 行为：笔记页：当前选中的 tab 才带 aria-pressed（点一下要跟着翻）
//   **留在原地**的四件（7 条断言，转不了 —— 理由写在那个用例自己的注释里）：
//     ① tab 行内边距 / ② `.drc-btn-on` 不加粗 / ⑤ `drc-tab-num-zero` + `tabular-nums`
//        —— CSS 规则文本；替身没有排版引擎，算不出 computed style。
//     ④ 三路列表不再套 `.drc-section` —— 模板形状；行为化的写法只能是数节点，更脆。
//   ⇒ 那半块要改名为 `样式与模板：…`（`test/guard-discipline.test.mjs` 的元守卫要求），
//     并去掉 ③ ⑥ 两段。
//#endregion
