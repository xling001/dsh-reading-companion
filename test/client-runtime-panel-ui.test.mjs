/**
 * 面板 UI 的**运行时行为**（2026-10-03，B 档续）。
 *
 * ## 这个文件存在的理由
 *
 * `client-runtime.test.mjs` 把浏览器半边的"取数 / 点按钮 / 位置恢复"搬到了运行时上。
 * 这个文件接着搬剩下那一批**名字像样式、其实有一半是行为**的守卫 —— 它们的共同形状是：
 * 一条 `test()` 里混着两半，
 *   · **纯 CSS / 模板**那一半（`className: 'drc-label drc-cat-toggle'` 长什么样）；
 *   · **行为**那一半（点一下会收起、收起名单跨会话记住、谁画在谁上面、短书没有筛选条）。
 * 只有后半截搬得动，而且只有真的渲染、真的点、真的读回 localStorage 才钉得住。
 *
 * ⚠️ 一条取代一条：被这里**完整覆盖**的源码文本钉子，要在 `client.test.mjs` 里删掉
 * （`design.md` 的删除铁律）。**纯 CSS 那一半不搬** —— 运行时替身没有 DOM，
 * 搬过来只是把断言变弱（见每个用例开头的"只取代了哪一半"）。
 *
 * ⚠️ 这里的 `localStorage` 用**公共夹具** `makeStorage()`
 * （`test/helpers/client-loader.mjs`，别在测试文件里另写一份）：`seed` 预置"上一会话
 * 存过什么"，`peek` / `snapshot` 读回这一会话写了什么，`writes` 回答**"到底写没写"**。
 * 它必须**显式装上** —— `makeFakeDocument()` 只替 style 注入、**没有** localStorage，
 * 而 `lib/client.js` 里那些 `globalThis.localStorage?.…` 缺了它会静默走空分支
 * （于是"跨会话记住"这类断言看起来在跑、其实永远为真）。
 *
 * ⚠️ 每条用例都做过**变异验证**（把 `lib/client.js` 读进内存、改一处、用 `data:` URL
 * 载入，观察同一条断言是否翻面）：下面每个用例注释里"证伪：…"那句话都实测成立。
 * 这不是形式主义 —— 这个仓库的教训是"**假红比不测更坏**"，一条永远不会红的守卫
 * 会让人以为那块地方有人看着。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule, makeStorage } from './helpers/client-loader.mjs'
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

/**
 * 按**先序**把树里的文字收集成数组（与 `client-runtime.test.mjs` 里那份同源）。
 *
 * 用来断言"谁画在上面" —— 原来那条源码钉子比较的是 `source.indexOf` 的先后
 * （"代码里谁先写"），这里比的是**渲染顺序**（"界面上谁先画"）。
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

// 假 `localStorage` 用**公共夹具** `makeStorage()`（`test/helpers/client-loader.mjs`）——
// 原先这里自己写了一份，2026-10-03 收成一个定义：`read()` 已并进公共夹具并改名 `peek()`，
// `broken` 也搬了过去。**别再在测试文件里另写一份存储替身**（两个定义分家正是本仓库栽过的坑）。

/** 在调用期间装上假存储（组件在**渲染期**就读它，所以必须包住 render）。 */
async function withStorage(storage, fn) {
  const original = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    return await fn()
  } finally {
    globalThis.localStorage = original
  }
}

/** 读一个名字集合（`saveNameSet` 写的是 JSON 数组）。 */
const savedNames = (storage, key) => {
  const raw = storage.peek(key)
  return raw === null ? null : JSON.parse(raw)
}

const BOOK = { bookId: '0123456789abcdef', title: '夜行', strategy: 'heading-regex', chapterCount: 2 }

const SHELF_BOOK = {
  bookId: 'b1',
  title: '夜行',
  category: '专业书',
  chapterCount: 2,
  byteLength: 2048,
  encoding: 'utf-8',
  progress: null,
}

/** 书架只要这两条：`reload()` 就是 `Promise.all([/library, /health])`。 */
const SHELF_ROUTES = [
  ['/library', { body: { ok: true, books: [SHELF_BOOK] } }],
  ['/health', { body: { ok: true, quarantined: [] } }],
]

/**
 * 陪读面板要的那几条路由。
 *
 * `cards` 的形状取自宿主（`entityCardsFor`）：`{ name, section, entries, latest }`。
 */
function companionRoutes({ cards = [], compaction = null } = {}) {
  return [
    ['/progress', { body: { ok: true, binding: { sessionId: 'session-abc' } } }],
    ['/background', {
      body: {
        ok: true,
        covered: { first: 1, last: 3 },
        gap: null,
        characters: ['竹纤'],
        cards,
        compaction,
        markdown: '',
        exists: true,
      },
    }],
    ['/persona', { body: { ok: true, text: '你是一位安静的书友' } }],
    ['/discussions', { body: { ok: true, discussions: [], total: 0 } }],
    ['/settings', { body: { ok: true, exportDir: '' } }],
  ]
}

const companionProps = () => ({ book: BOOK, sessionId: 'session-abc', onBack: () => {} })

/** 两张**同名、不同分区**的卡 —— 这正是"键必须是 `分区/名字`"要防的那件事。 */
const CARD_A = {
  name: '竹纤',
  section: '人物',
  entries: ['第 1 章：初见', '第 2 章：并肩', '第 3 章：远行'],
  latest: 3,
  earliest: 1,
}
const CARD_B = { name: '竹纤', section: '通用概念', entries: ['廿年之约'], latest: 2, earliest: 1 }

/**
 * 人物卡的开关按钮：它**自己那一层**的文字里带着「N 条」。
 *
 * 只认"自带 `onClick` 且自带 `N 条`"的节点，所以拿到的一定是界面上那个真按钮 ——
 * 点它就是 `onClick`，与真人操作同一条路径。
 */
function cardToggle(tree, count) {
  const hit = findNode(tree, (node) =>
    typeof node.props?.onClick === 'function'
    && (node.children ?? []).some((child) => typeof child === 'string' && child.includes(`${count} 条`)))
  assert.ok(hit !== null, `树上找不到「${count} 条」那张卡的开关`)
  return hit
}

//#region 取代「接线守卫：书架分类与人物卡都是可折叠开关（收起状态跨会话记住）」

test('书架分类：点一下就收起/展开，收起名单写进 localStorage 并在**新会话**里生效', async () => {
  // 只取代旧守卫的**书架分类那一半**。留在 `client.test.mjs` 的是纯样式那一半：
  // `className: 'drc-label drc-cat-toggle'` 与那段共用外观的 CSS（替身没有 DOM，
  // 搬过来只会把断言变弱）。
  //
  // 证伪：把 `saveNameSet(SHELF_COLLAPSED_KEY, next)` 删掉 ⇒ 第二个会话的书又出现了；
  // 把 `useState(() => loadNameSet(SHELF_COLLAPSED_KEY))` 改成 `useState([])` ⇒ 同上；
  // 把 `collapsedCategories.includes(...) ? null : …` 那一支删掉 ⇒ 收起后书还在树上。
  const storage = makeStorage()
  await withStorage(storage, async () => {
    const first = await runtime()
    const firstRoutes = makeFetch(SHELF_ROUTES)
    await withFetch(firstRoutes.fetch, async () => {
      first.render(first.react.createElement(first.internals.ShelfView, { onOpen: () => {} }))
      let tree = await settle(first)

      assert.ok(treeText(tree).includes('夜行'), '夹具本身要站得住：书得先画出来')
      let toggle = findText(tree, '专业书（1）')
      assert.ok(toggle !== null, `分类标题要是可切换的控件：${treeText(tree).slice(0, 300)}`)
      assert.equal(typeof toggle.props.onClick, 'function', '标题必须是**按钮**，不是一个只能看的 div')
      assert.equal(toggle.props['aria-expanded'], 'true', '默认全展开（新导入的书落在「未分类」，一进来就找不到是最糟的默认值）')

      // ---- 点一下：收起 ----
      tree = first.act(() => toggle.props.onClick())
      const collapsed = treeText(tree)
      assert.ok(!collapsed.includes('夜行'), `收起后不该再画书列表：${collapsed.slice(0, 300)}`)
      assert.ok(collapsed.includes('专业书（1）'), '收起只收列表：标题行连同书目数要留着')
      toggle = findText(tree, '专业书（1）')
      assert.equal(toggle.props['aria-expanded'], 'false', '收起后 aria-expanded 要跟着变（读屏用户拿到的必须是同一个控件）')
      assert.deepEqual(savedNames(storage, 'drc:collapsed-categories'), ['专业书'], '收起要立刻落盘')

      // ---- 再点一下：展开 ----
      tree = first.act(() => toggle.props.onClick())
      assert.ok(treeText(tree).includes('夜行'), '再点一下要展开回来')
      assert.deepEqual(savedNames(storage, 'drc:collapsed-categories'), [], '展开要把它从名单里拿掉')
      assert.equal(findText(tree, '专业书（1）').props['aria-expanded'], 'true')

      // 收起，留给"下一个会话"。
      first.act(() => toggle.props.onClick())
      assert.deepEqual(savedNames(storage, 'drc:collapsed-categories'), ['专业书'])
    })

    // ---- 新会话：新的 hooks 运行时 = 新的组件实例，只有存储是共享的 ----
    const second = await runtime()
    const secondRoutes = makeFetch(SHELF_ROUTES)
    await withFetch(secondRoutes.fetch, async () => {
      second.render(second.react.createElement(second.internals.ShelfView, { onOpen: () => {} }))
      const tree = await settle(second)
      const text = treeText(tree)
      assert.ok(text.includes('专业书（1）'), '新会话仍要画出分类标题')
      assert.ok(!text.includes('夜行'), `⚠️ 上一会话收起过的分类，新会话必须还是收起的：${text.slice(0, 300)}`)
      assert.equal(findText(tree, '专业书（1）').props['aria-expanded'], 'false')
    })

    // ---- 存储不可用（隐私模式 / 配额）：不许白屏，本次会话内仍要生效 ----
    await withStorage(makeStorage({}, { broken: true }), async () => {
      const third = await runtime()
      const { fetch } = makeFetch(SHELF_ROUTES)
      await withFetch(fetch, async () => {
        third.render(third.react.createElement(third.internals.ShelfView, { onOpen: () => {} }))
        let tree = await settle(third)
        assert.ok(treeText(tree).includes('夜行'), '⚠️ 读不了存储时书架仍要画出来（不能白屏）')
        tree = third.act(() => findText(tree, '专业书（1）').props.onClick())
        assert.ok(!treeText(tree).includes('夜行'), '写不进存储也要在**本次会话内**生效')
      })
    })
  })
})

test('人物卡：默认全折叠、点开只展开那一张（键含分区），展开名单跨会话记住', async () => {
  // 只取代旧守卫的**人物卡那一半**。留在 `client.test.mjs` 的是纯样式那一半：
  // `className: 'drc-item-sub drc-card-toggle'`（与书架分类共用同一套外观）。
  //
  // 证伪：把 `const folded = !expandedCards.includes(cardKey)` 改成 `false` ⇒ 默认就展开了；
  // 把 `folded ? null : card.entries.slice(-2)` 改成 `card.entries` ⇒ 最早那条也出现了；
  // 把 `cardKey` 从 `${card.section}/${card.name}` 改成 `card.name` ⇒ 点开一张，两张同名卡一起开；
  // 把 `saveNameSet(CARDS_EXPANDED_KEY, next)` 删掉 ⇒ 新会话又全折回去了。
  const storage = makeStorage()
  await withStorage(storage, async () => {
    const first = await runtime()
    const firstRoutes = makeFetch(companionRoutes({ cards: [CARD_A, CARD_B] }))
    await withFetch(firstRoutes.fetch, async () => {
      first.render(first.react.createElement(first.internals.CompanionView, companionProps()))
      let tree = await settle(first)
      let text = treeText(tree)

      assert.ok(text.includes('竹纤'), '夹具本身要站得住：卡片标题得画出来')
      assert.ok(!text.includes('并肩'), `⚠️ 人物卡默认必须**折叠**（读者定的默认值）：${text.slice(0, 400)}`)
      assert.ok(!text.includes('廿年之约'), '另一张卡当然也是折的')
      assert.ok(text.includes('3 条') && text.includes('1 条'), '折叠时条数与最新章号仍看得见（只收条目）')
      assert.equal(cardToggle(tree, 3).props['aria-expanded'], 'false')

      // ---- 点开「人物/竹纤」那一张 ----
      tree = first.act(() => cardToggle(tree, 3).props.onClick())
      text = treeText(tree)
      assert.ok(text.includes('并肩') && text.includes('远行'), `点开后要画出条目：${text.slice(0, 400)}`)
      assert.ok(!text.includes('初见'), '展开也只给**最后两条**（这里是最早那条，不该出现）')
      assert.ok(!text.includes('廿年之约'), '⚠️ 键是 `分区/名字`：同名主体的另一张卡不许被一起展开')
      assert.equal(cardToggle(tree, 3).props['aria-expanded'], 'true')
      assert.deepEqual(savedNames(storage, 'drc:expanded-cards'), ['人物/竹纤'], '展开要立刻落盘（存的是**展开**名单：空集合 = 全折叠）')
      assert.equal(storage.peek('drc:collapsed-categories'), null, '两处各存一份键，不许互相写')
    })

    // ---- 新会话 ----
    const second = await runtime()
    const secondRoutes = makeFetch(companionRoutes({ cards: [CARD_A, CARD_B] }))
    await withFetch(secondRoutes.fetch, async () => {
      second.render(second.react.createElement(second.internals.CompanionView, companionProps()))
      const tree = await settle(second)
      const text = treeText(tree)
      assert.ok(text.includes('并肩'), `⚠️ 上一会话展开过的卡，新会话仍是展开的：${text.slice(0, 400)}`)
      assert.ok(!text.includes('廿年之约'), '另一张卡不该跟着展开')
      assert.equal(cardToggle(tree, 3).props['aria-expanded'], 'true')
    })
  })
})

//#endregion

//#region 取代「接线守卫：人物卡是独立小节，且紧挨在「讨论历史」之前」

test('面板：人物卡是独立小节，画在「背景认识（记忆）」「导出到笔记库」之后、「讨论历史」之前', async () => {
  // 只取代旧守卫的**顺序那一半**（含空状态那句）。旧版比的是源码里 `indexOf` 的先后
  // ——那是"代码里谁先写"；这里比的是**渲染树的先序文字**，也就是"界面上谁先画"。
  //
  // 证伪：把人物卡那一节整体挪到「讨论历史」之后 ⇒ 第三条断言红；
  // 挪回「背景认识（记忆）」里面 ⇒ 第一条红；挪到导出之前 ⇒ 第二条红；
  // 把空状态那句 `还没有人物卡 —— …` 删掉 ⇒ 第二个渲染红。
  const storage = makeStorage()
  await withStorage(storage, async () => {
    const { react, render, act, internals } = await runtime()
    const first = makeFetch(companionRoutes({ cards: [CARD_A] }))
    await withFetch(first.fetch, async () => {
      render(react.createElement(internals.CompanionView, companionProps()))
      const lines = textOrder(await settle({ act }))
      const at = (needle) => lines.findIndex((line) => line.includes(needle))
      const cards = at('人物卡')
      const background = at('背景认识（记忆）')
      const exportAt = at('导出到笔记库')
      const talk = at('讨论历史')

      assert.ok(cards !== -1, `渲染树上没有「人物卡」小节：${lines.slice(0, 40).join(' | ')}`)
      assert.ok(talk !== -1, '渲染树上没有「讨论历史」（没有它，这条比较就没有意义）')
      assert.ok(background !== -1 && exportAt !== -1, '两个参照小节都要在树上')
      assert.ok(cards > background, `它已经不在「背景认识（记忆）」里面了（背景 ${background} / 人物卡 ${cards}）`)
      assert.ok(cards > exportAt, `读者要的是"往下挪"：它在导出之后（导出 ${exportAt} / 人物卡 ${cards}）`)
      assert.ok(cards < talk, `人物卡要排在「讨论历史」之前（人物卡 ${cards} / 讨论历史 ${talk}）`)
    })

    // 空状态要有话说：这一节**总是**出现，没有卡片时不能是一片空白。
    const empty = await runtime()
    const emptyRoutes = makeFetch(companionRoutes({ cards: [] }))
    await withFetch(emptyRoutes.fetch, async () => {
      empty.render(empty.react.createElement(empty.internals.CompanionView, companionProps()))
      const text = treeText(await settle(empty))
      assert.ok(text.includes('人物卡'), '没有卡片时这一节也要在（它总是出现）')
      assert.ok(text.includes('还没有人物卡'), `没有卡片时要有话说：${text.slice(0, 400)}`)
    })
  })
})

//#endregion

//#region 取代「接线守卫：那一块预览已经从面板摘掉（但宿主路由保留）」

const PREVIEW_TEXT = '防剧透层真正会交给模型的全部内容'

test('面板：那一块预览不在渲染树上，也不再调 `/context`', async () => {
  // 只取代旧守卫里**否定**的那一半（两条 `source.includes(...) === false` 与
  // `doesNotMatch(source, /callApi\([^)]*\/context/)`）。
  // ⚠️ "宿主路由保留"那一半查的是 `lib/index.js` 的路由表 —— **不属于这条**，留在 `client.test.mjs`。
  //
  // 证伪：把「AI 视角预览」那一节（连同它那次 `callApi(.../context)`）加回面板 ⇒
  // 下面三条会一起红：文字回到树上、标题回到树上、`calls` 里出现 `/context`。
  // ⚠️ 刻意把 `/context` **配上**：否则"没调过"与"调了但没配路由、被 catch 吞掉"分不开。
  const storage = makeStorage()
  await withStorage(storage, async () => {
    const { react, render, act, internals } = await runtime()
    const { fetch, calls } = makeFetch([
      ...companionRoutes({ cards: [CARD_A] }),
      ['/context', { body: { ok: true, text: `${PREVIEW_TEXT}（宿主仍然算得出来）` } }],
    ])
    await withFetch(fetch, async () => {
      render(react.createElement(internals.CompanionView, companionProps()))
      const text = treeText(await settle({ act }))

      // 正面控制：面板真的画出来了 —— 否则下面两条否定断言是空的。
      assert.ok(
        text.includes('讨论历史') && text.includes('书友设定（你写给 AI 的）'),
        `面板没渲染出来，否定断言等于没测：${text.slice(0, 300)}`,
      )
      assert.ok(!text.includes('AI 视角预览'), '「AI 视角预览」不该再是一个小节标题')
      assert.ok(!text.includes(PREVIEW_TEXT), '面板里不该再有那一块预览')
      assert.deepEqual(
        calls.filter((call) => call.url.includes('/context')).map((call) => call.url),
        [],
        '客户端不该再调用 /context（摘掉的是面板入口，不是宿主那个能力）',
      )
    })
  })
})

test('面板：背景偏胖的提醒真的读宿主回的 `compaction` 信号（不接 = 读者看不到该压缩）', async () => {
  // 取代旧守卫末尾那两条：`assert.match(source, /compaction\?\.over === true/)` 与
  // `source.includes('这份背景认识已经偏胖')`。
  // 它钉的是一段**真实后果**：`/context` 被摘掉后"该压缩了"的信号无声消失，压缩变成
  // 纯手动、没人提醒（读者某本书的背景认识涨到 47 KB）。所以这条必须有，且必须两侧都测。
  //
  // 证伪：把 `background?.compaction?.over === true` 改成 `false`（或干脆删掉那一支）
  // ⇒ 第一个渲染红；把 `over === true` 放宽成"有 compaction 就显示" ⇒ 第二个渲染红。
  const storage = makeStorage()
  await withStorage(storage, async () => {
    const fat = await runtime()
    const fatRoutes = makeFetch(companionRoutes({
      cards: [CARD_A],
      compaction: { over: true, fullChars: 47000, threshold: 40000 },
    }))
    await withFetch(fatRoutes.fetch, async () => {
      fat.render(fat.react.createElement(fat.internals.CompanionView, companionProps()))
      const text = treeText(await settle(fat))
      assert.ok(text.includes('这份背景认识已经偏胖'), `该压缩时必须给读者一句人话：${text.slice(0, 400)}`)
      assert.ok(text.includes('47000') && text.includes('40000'), '要把"胖到什么程度"如实说出来，读者才能判断要不要现在压')
    })

    const thin = await runtime()
    const thinRoutes = makeFetch(companionRoutes({
      cards: [CARD_A],
      compaction: { over: false, fullChars: 1000, threshold: 40000 },
    }))
    await withFetch(thinRoutes.fetch, async () => {
      thin.render(thin.react.createElement(thin.internals.CompanionView, companionProps()))
      const text = treeText(await settle(thin))
      assert.ok(!text.includes('这份背景认识已经偏胖'), '没超阈值就不该吓读者')
      assert.ok(text.includes('背景认识（记忆）'), '那一节本身当然还要在（否则上面那条是空断言）')
    })
  })
})

//#endregion

//#region 取代「目录筛选：短书不显示筛选条（阈值存在且合理）」

/** 目录页要的那些 props —— 它自己不取数：一切来自 props（零新增请求）。 */
function tocProps(chapters, progress = null) {
  return {
    book: BOOK,
    chapters,
    progress,
    loading: false,
    error: null,
    onBack: () => {},
    onPick: () => {},
    onOpenCompanion: () => {},
    onOpenNotes: () => {},
  }
}

test('目录筛选：短书渲染出来没有筛选条，长书有；阈值是纯函数且合理', async () => {
  // 只取代旧守卫里**渲染**的那一半：`assert.match(source, /chapters\.length < TOC_FILTER_MIN/)`
  // 问的是"那段代码里有没有这个比较"；这里真的渲染一本短书、一本长书，问的是
  // "**界面上**有没有那个输入框"。阈值本身的合理性（`Number.isInteger` + 区间）是纯函数
  // 断言，照旧直接调 —— 不必读源码。
  //
  // 证伪：把 `chapters.length < TOC_FILTER_MIN ? null : …` 改成 `false ? …`
  // ⇒ 短书那条红；把整个筛选块删掉 ⇒ 长书那条（正面控制）红；
  // 把 `TOC_FILTER_MIN` 改成 5 ⇒ 区间断言红。
  const { react, render, act, internals } = await runtime()
  const { TOC_FILTER_MIN } = internals

  assert.equal(Number.isInteger(TOC_FILTER_MIN), true, `阈值必须是整数：${TOC_FILTER_MIN}`)
  assert.ok(TOC_FILTER_MIN >= 20 && TOC_FILTER_MIN <= 200, `阈值不合理：${TOC_FILTER_MIN}`)

  const chaptersOf = (count) => Array.from({ length: count }, (unused, index) => ({
    index,
    title: `第 ${index + 1} 章 雪`,
    volume: null,
  }))
  /** 筛选条 = 那个自带 `onChange` 的输入框（目录页里只有它有）。 */
  const filterInput = (tree) => findNode(tree, (node) =>
    node.type === 'input' && typeof node.props?.onChange === 'function')

  const shortTree = render(react.createElement(internals.TocView, tocProps(chaptersOf(TOC_FILTER_MIN - 1))))
  assert.equal(filterInput(shortTree), null, `⚠️ 短书不该有筛选条（筛选条比目录还占地方）：${treeText(shortTree).slice(0, 300)}`)
  assert.ok(treeText(shortTree).includes('第 1 章 雪'), '短书的目录本身当然要画出来（否则上面那条是空断言）')

  const longTree = render(react.createElement(internals.TocView, tocProps(chaptersOf(TOC_FILTER_MIN))))
  const input = filterInput(longTree)
  assert.ok(input !== null, '长书必须有筛选条（正面控制：它证明"找不到输入框"不是因为这个页面根本没渲染）')
  assert.equal(input.props.value, '', '筛选词初值是空串')
  assert.ok(
    String(input.props.placeholder).includes(String(TOC_FILTER_MIN)),
    `占位文案要说清有多少章可筛：${input.props.placeholder}`,
  )
})

//#endregion

//#region 取代「卷的展开状态不持久化」那条理由注释钉子

/** 三卷、进度停在卷三 ⇒ 卷一/卷二都不是"当前卷"（否则测不出"默认只开当前卷"）。 */
const VOLUME_CHAPTERS = [
  { index: 0, title: '第 1 章 卷一之一', volume: '卷一', length: 10, kind: 'chapter' },
  { index: 1, title: '第 2 章 卷一之二', volume: '卷一', length: 10, kind: 'chapter' },
  { index: 2, title: '第 3 章 卷二之一', volume: '卷二', length: 10, kind: 'chapter' },
  { index: 3, title: '第 4 章 卷三之一', volume: '卷三', length: 10, kind: 'chapter' },
]
const VOLUME_PROGRESS = { chapterIndex: 3 }

/**
 * 目录里某一卷的开关。
 *
 * ⚠️ 它与书架分类 / 人物卡**刻意不同**，两处都别照抄对方的断言：
 *   · 它是一个 `role: 'button'` 的 `div`（不是 `<button>` —— 见 `.drc-volume-btn` 的说明）；
 *   · `aria-expanded` 是**布尔**（分类那边是字符串 `'true'` / `'false'`）。
 * 卷名在**子节点**的字符串里（`h('span', null, '▸ 卷二')`），所以要靠 `treeText` 找。
 */
function volumeToggle(tree, name) {
  const hit = findNode(tree, (node) =>
    node.props?.role === 'button'
    && typeof node.props?.onClick === 'function'
    && String(node.props?.title ?? '').includes('这一卷')
    && treeText(node).includes(name))
  assert.ok(hit !== null, `树上找不到「${name}」这一卷的开关`)
  return hit
}

test('目录卷：展开某一卷只留在本次会话，一个键都不写持久层', async () => {
  // 取代「接线守卫：书架分类与人物卡都是可折叠开关（收起状态跨会话记住）」末尾那两条
  // **理由注释**钉子里的**卷那一半**（`那是"我正在翻这本书的目录"的过程状态`）；
  // 另一半（`…的**偏好**`）已由上面两条用例用**行为**钉住。
  //
  // 它想挡的失效只有一种：有人把「卷」和「分类 / 人物卡」**统一掉** —— 给卷的展开状态也加持久化。
  // 所以这里用行为钉两件事：
  //   ④ **一次都没写**（`writes` 台账为空）；
  //   ⑤ **新会话的第一帧与第一会话的第一帧逐字相同**。
  // ⑤ 刻意**不猜**"将来那个人会把卷存到哪个键"：只要"存了又读回来"，新会话的第一帧必然不同。
  //
  // 证伪（两步都真的跑过，见文件头"变异验证"那一段）：
  //   ① 在 `setOpenVolume(groupKey)` 后面顺带 `saveNameSet('drc:open-volume', [groupKey])`
  //      ⇒ **④ 红**（`writes` 里多了一条 `set`）；此时 ⑤ 仍绿 —— 只写不读没有任何可观察后果，
  //      这正是"写"与"读"要分开钉的理由。
  //   ② 在①的基础上把 `useState(null)` 改成
  //      `useState(() => loadNameSet('drc:open-volume')[0] ?? null)`
  //      ⇒ **⑤ 红**（新会话第一帧就展开了卷二，与第一会话的第一帧不同）。
  const storage = makeStorage()
  await withStorage(storage, async () => {
    /** 哪几章的标题真的画在树上（按章节序号）。 */
    const shownChapters = (tree) => VOLUME_CHAPTERS
      .filter((chapter) => treeText(tree).includes(chapter.title))
      .map((chapter) => chapter.index)

    /** 跑一个会话（**换 hooks 运行时 = 换会话**，存储不换），返回它的**第一帧**。 */
    const session = async () => {
      const hooks = await runtime()
      const tree = hooks.render(hooks.react.createElement(
        hooks.internals.TocView,
        tocProps(VOLUME_CHAPTERS, VOLUME_PROGRESS),
      ))
      return { hooks, tree, text: treeText(tree), chapters: shownChapters(tree) }
    }

    // ---- 第一会话的第一帧：进度在卷三 ⇒ 只有卷三（当前卷）是开的 ----
    const firstSession = await session()
    assert.deepEqual(firstSession.chapters, [3], `默认只开当前卷：${firstSession.text.slice(0, 400)}`)
    assert.equal(volumeToggle(firstSession.tree, '卷二').props['aria-expanded'], false, '非当前卷默认收起')
    assert.deepEqual(storage.writes, [], '渲染一份目录本身不该碰任何持久层')

    // ---- 读者展开卷二（它不是"当前卷"）----
    const afterClick = firstSession.hooks.act(() => volumeToggle(firstSession.tree, '卷二').props.onClick())
    assert.deepEqual(shownChapters(afterClick), [2, 3], `点开后卷二的章节要画出来：${treeText(afterClick).slice(0, 400)}`)
    assert.equal(volumeToggle(afterClick, '卷二').props['aria-expanded'], true)
    assert.equal(volumeToggle(afterClick, '卷一').props['aria-expanded'], false, '一次只留一卷手动开的')

    // ---- ④ 卷的展开状态是**过程状态**：开关一次不该写进任何持久层 ----
    assert.deepEqual(
      storage.writes,
      [],
      '⚠️ 卷的展开状态被写进持久层了 —— 那就是把「卷」和「分类 / 人物卡的偏好」统一掉了'
      + '（两处理由见 loadNameSet 的说明：卷是过程状态，分类/卡片是跨书跨会话的偏好）',
    )

    // ---- ⑤ 新会话的第一帧必须与第一会话的第一帧**逐字相同**（= 没有读回任何卷状态）----
    const secondSession = await session()
    assert.deepEqual(secondSession.chapters, firstSession.chapters, '新会话不该记得上一会话展开过哪一卷')
    assert.equal(secondSession.text, firstSession.text, '新会话的第一帧必须与第一会话的第一帧逐字相同')
    assert.deepEqual(storage.writes, [], '两个会话加起来一个键都不该写')
  })
})

//#endregion
