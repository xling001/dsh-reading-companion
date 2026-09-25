# 前端结构与性能审查（v0.10.0）

> ⚠️ **这是当时的快照**（v0.10.0 时点的审查报告：行号、文件大小、测试数都只对那一刻成立）。
> **当前实现以代码与 `design-v1.md` 的修订块为准** —— 例如笔记列表后来已从「加载更旧」
> 改成**翻页**（每页 10 条，可往回翻；见 design-v1 的 v1.38 / v1.39），那一节描述的是旧形态。

审查对象：`lib/client.js`（**138,788 字节 / 117,003 字符 / 3,270 行**，LF、无 BOM）。
基线：`npm run test:no-isolation` → **360 pass / 0 fail**（本次已实测复现）。

先读代码再下结论；下面每条都带 `文件:行号` 证据。所有改法都满足硬约束：**不引入构建工具、不迁移框架、不重写**，
且每条都注明回归面。

---

## 0. 先纠正一个前提，它改变了第 1 节的结论

> 线索说「不能用 import/export（客户端代码原样执行）」。**方向是对的，但机制不是"原样执行"**。

实际机制（读宿主源码确认，非推测）：

- `package.json` 声明 `dsh.client.platform = "web"` 与 `exports["./client"] = "./lib/client.js"`。
- 宿主 `@deepseek-ai/dsh-client-modules` 的 `resolveMeta()` 只解析 **`exports["./client"]` 这一个文件**：
  `clientExportOf()` → `join(dirname(pkgPath), clientRel)`。
- 该文件被 `readFileSync()` 读成**字符串**，与其它插件的 bundle 用 `;` + 换行**拼接**成一个 combo 脚本
  （`buildCombo()`），再从 head 以 `<script src="/plugins/??<id>/client.js&rev=…">` 注入。
- 所以 `lib/client.js` **不是 ESM 模块，而是一段普通脚本**：顶层 `window.__ModuleLoader__.load({id, factory})`
  只登记工厂（惰性 CJS 表）；所有副作用（含 `installStyles`）必须留在 factory 闭包内，在 materialize 时才发生
  —— 这正是 `lib/client.js:22-35` 顶部注释所写的内容，注释是准确的。
- 客户端侧 `require(spec)` 的解析顺序是：**seed 词（`react` 由壳提供）→ 已物化记录 → 已登记的工厂**，
  否则**大声抛错**。`import()` 多一条「boot graph 行」分支。
- 安装方式是 **junction 目录联接**（`scripts/link-into-profile.mjs:13-18`），指向本地开发目录，
  **没有构建步骤**——源码改了立即生效。

结论：客户端侧确实没有模块系统可用，而且**磁盘上只有 `client.js` 一个文件会被读取**。

---

## 1. 拆文件：结论是「不该拆成多文件」，但要拆「节」

### 1.1 三条真正可行的机制，及其为何都不该用

| 机制 | 宿主是否支持 | 为什么不该用 |
|---|---|---|
| **A. 多文件拼接进同一个 factory** | 宿主只读 `clientPath` 一个文件，**不读别的** | 需要自己在 `client.js` 里塞一个「把若干源文件拼成字符串再 `new Function`/`eval`」的加载器。用 `eval` 换可维护性，收益为负 |
| **B. 拆成多个包，用 `dsh.client.external` 串成模块图** | **支持**，但见下方约束 | 需要把 1 个 cordis 行变成 3~4 个行（`cordis.patch.yml` 是单行 insert 的「纯加法开关」），且必须为每个包建目录 + `package.json` + junction。`orderByModuleGraph()` 明确禁止一行声明自己的包名，行间**不得成环**（`factory-form CJS cannot deliver partial exports`） |
| **C. 装一个拼接器 / 用 tsdown 打包** | 可行 | 就是构建步骤，硬约束排除。更关键：它会**毁掉现在的开发回路**——junction 直连源码，改完即生效；加了构建产物就变成「改了源文件但跑的是旧 bundle」，调试时最容易骗自己 |

机制 B 是唯一「真正可行」且不违反字面约束的路，但它把「一个纯加法开关」变成「四个必须同时正确的行」，
**风险远大于收益**——尤其在一个「已上线、用户满意」的插件上。**结论：不拆。**

### 1.2 替代方案：保持单文件，但按节拆分（零回归风险）

单文件本身的成本是**导航成本**，不是运行时成本。好消息是：factory 已经是一个真正的闭包，
**内部的「节」就是模块边界**——不需要任何运行时机制就能获得拆分的收益。

现状（实测字符预算，按 `//#region` 边界统计）：

| 节 | 行区间 | 字符 | 占比 |
|---|---|---|---|
| 依赖 + 常量 | 29–63 | 974 | 0.8% |
| 样式 `CSS_TEXT` | 72–263 | 6,604 | 5.6% |
| `installStyles` | 264–284 | 664 | 0.6% |
| 数据访问 `callApi` + 格式化 | 287–441 | 4,713 | 4.0% |
| 正文字体偏好 | 443–536 | 3,105 | 2.7% |
| 纯函数 | 538–752 | 7,383 | 6.3% |
| 展示组件 `TopBar`/`ShelfView`/`TocView`/`ReaderView` | 754–1572 | **30,666** | **26.2%** |
| `mergeNotesPage` + `NoteList` | 1574–1692 | 4,226 | 3.6% |
| `NotesView` | 1694–2318 | **23,264** | **19.9%** |
| `CompanionView` | 2320–2907 | **23,348** | **20.0%** |
| `ReaderPanel` + `ReaderTitle` + `ReaderGlyph` | 2909–3121 | 6,814 | 5.8% |
| 插件体 `apply` | 3123–3270 | 4,129 | 3.5% |

真正的大头只有三个：**展示组件 30.7k、NotesView 23.3k、CompanionView 23.3k**（合计 66%）。

**具体改法（按收益排序，纯文本操作，不动一行逻辑）**：

1. **把 `ReaderView` 拆成它自己的一节，并把段落列表抽成 `memo` 组件 `Paragraphs`**（见第 2 节 R3）
   ——同时解决体积（最大的一节）和性能（最贵的一处），一举两得。
2. **把 `CompanionView` 按 5 个子区块提成节内函数**（`CompanionBinding` / `BackgroundSection` /
   `PersonaSection` / `DiscussionTimeline` / `WebGateSection`），每个约 100–200 行。
   这些区块 props 少、无共享状态，是最干净的切法。
3. **纯函数节已有 7.4k 且已 `export __internals`**（`lib/client.js:3222-3267`），
   **不要再给它加东西**——新增的纯函数请优先放在靠近使用处的节内，避免这个「测试门面」继续膨胀。
4. 保留 `//#region` 标记，但把 `//#region` 的名字写成**与 `__internals` 分组一致的名字**，
   这样「测试里看到一个函数 → 在文件里能直接跳到对应节」。

**风险/回归面**：纯声明重排 + 组件提取。回归面 = 组件身份变化（见 R3 的 `memo` 说明）。
360 项测试与 `__internals` 导出面（`lib/client.js:3222-3267`）**必须保持逐名不变**——
`test/client.test.mjs:398-400` 直接读 `mod.__internals`，任何重命名都会立刻红。

---

## 2. 渲染性能：会随数据量线性变差的地方

先说明：**全文搜索不存在**。`grep search|搜索|全文` 在 `lib/client.js` 只命中两处注释
（`:1603`、`:2301`）。所以「搜索结果渲染」这条不适用——**不要为它做优化**。
真正线性变差的有三处，外加两处「每次按键/滚动都全量重算」。

### R1 · 书架：分类下拉对**每一本书**重算一次全量分组 → O(N²)

**收益：中（书架到几百本时明显）**

**现状 + 证据**：`renderCategoryPicker(book)` 每渲染一本书就调用一次 `groupBooksByCategory(state.books)`
——`lib/client.js:915-917`（函数体）、`:1114`（在 `group.books.map` 内对每本书调用）。
`groupBooksByCategory` 内部建 Map + `localeCompare(right, 'zh-Hans-CN')` 排序：`lib/client.js:699-712`。
于是 N 本书 → **N 次 O(N log N) 排序 + N 个 Map**。

而 `manualPath` 是 `ShelfView` 自己的 state（`:783`、输入框 `:988-993`），
**每敲一个字符都让整个书架重渲染一次**——包括这 N 次分组。

**具体改法**（把「每本书算一次」降成「每个 render 算一次」）：

```js
// ShelfView 内，紧随其他 hook（放 :788 之后）
//
// 分类下拉的选项只取决于「现在真的有书在里面」的分类名，与具体是哪本书无关。
// 之前它被写在 renderCategoryPicker 里，于是每渲染一本书就重算一次全量分组。
const categoryNames = useMemo(
  () => groupBooksByCategory(state.books)
    .map((group) => group.category)
    .filter((name) => name !== UNCATEGORIZED),
  [state.books],
)
```

然后 `renderCategoryPicker` 里把 `:915-917` 那三行换成直接用 `categoryNames`。
注意函数签名不变（仍收 `book`），**只删掉它内部的重算**。

**风险/回归面**：极低。`state.books` 只在 `reload()` 里整块替换（`:794`），引用稳定，
`useMemo` 命中率很高；即便不命中，也只是退化成现在的行为。
`test/client.test.mjs:927-954` 是纯函数测试，不受影响。

### R2 · 目录：上千章一次性全渲染，无窗口化

**收益：中高（「上千章」是本项目的核心场景）**

**现状 + 证据**：`TocView` 把 `groups` 全部铺开，`group.chapters.map(...)` 每章产出
`li > span + div > div + span` 共 4 个元素：`lib/client.js:1191-1218`。
1000 章 ≈ **4,000 个元素**一次性挂载；而且每次 `progress` 变化（进度回写）都会让
`TocView` 重新渲染（`:1150` 的 `current` 随之变化）。

**具体改法**（与 `NoteList` 完全同一个模式，一致性最好）：

做法是**在渲染前先算出「每组露出多少章」**，用派生数据（不是渲染期改可变变量）：

```js
// TocView 内，紧随 groups 的 useMemo（:1149）之后
//
// 上千章的目录一次性挂载约 4 个元素/章（li + 两个 span + 一个 div），
// 1000 章 ≈ 4000 个元素。短书保持原样，不引入新交互。
const PAGE_STEP = 240
const TOC_LAZY_THRESHOLD = 300
const [shown, setShown] = useState(PAGE_STEP)
const lazy = chapters.length > TOC_LAZY_THRESHOLD

// 跨组共享一个 N 章的配额，逐组分配。派生而不是在 render 里改可变变量。
const visibleGroups = useMemo(() => {
  if (!lazy) return groups.map((group) => ({ group, take: group.chapters.length }))
  let budget = shown
  return groups.map((group) => {
    const take = Math.max(0, Math.min(group.chapters.length, budget))
    budget -= take
    return { group, take }
  })
}, [groups, lazy, shown])
```

渲染处（`:1191-1218`）把 `...groups.map((group, groupIndex) =>` 换成
`...visibleGroups.map(({ group, take }, groupIndex) =>`，并把
`...group.chapters.map(...)` 换成 `...group.chapters.slice(0, take).map(...)`。
**其余一字不动**——`key`、`className`、`onClick` 全部保持原样。

`take` 的和恰好等于 `min(shown, chapters.length)`，所以底部的按钮判断可以直接用 `shown`：

```js
lazy && shown < chapters.length
  ? h('div', { className: 'drc-row' },
      h('button', {
        type: 'button',
        className: 'drc-btn',
        onClick: () => setShown((n) => n + PAGE_STEP),
      }, `显示更多章节（还有 ${chapters.length - shown} 章）`))
  : null
```

`shown` 是 `TocView` 自己的 state，**完全不影响 `props` 契约**。

> ⚠️ 不要改成虚拟滚动：那需要测量高度并处理滚动锚点，而目录项的 `onClick` 是主要导航手段，
> 风险与收益不成比例。**分页 + `mergeNotesPage` 那套已经证明了这个模式在本项目里可行。**

**风险/回归面**：低。「显示更多」是新交互，需要点两下才能看到第 500 章。
可加一条兜底：若 `chapters.length <= 300` 则不分页（短书零变化）。

### R3 · 正文：段落列表每次父组件重渲染都全量重建，且 `ref` 回调身份每次都变

**收益：中高**

**现状 + 证据**：`ReaderView` 在返回值里内联 `paragraphs.map(...)`：`lib/client.js:1555-1567`。
两处代价：

1. **`.map` 每次都产出全新的元素对象**（`:1556`），整章段落全部重新 diff。一章可能上千段。
2. **`ref` 是内联箭头函数**（`:1561-1563`），每次渲染都是新函数 → React 会
   **对每个段落执行 `ref(null)` 再 `ref(el)`**，即一次完整的 detach/attach 往返 × 段落数。

而 `ReaderView` 会被这些 state 触发重渲染：`selection`（`:1243`，划选文字）、
`showFontBar`（`:1246`，点 Aa）、`fontPrefs`（`:1245`，调字号/行距）、
以及 `loading`/`error`（`:1240-1241`）。调一次行距 = 上千段落的 ref 往返 + diff。

**具体改法**（抽成 `memo` 组件，`ref` 保持内联但由 `memo` 挡住无关重渲染）：

```js
/**
 * 段落列表。
 *
 * 抽成 memo 组件有两个理由，缺一不可：
 *   1. 段落元素本身很贵（一章可达上千个），而父组件会因为划选、字体条、
 *      字号调整等**与正文无关**的 state 重渲染；
 *   2. `ref` 是内联箭头函数，每次渲染身份都变 —— React 会对每个段落执行
 *      `ref(null)` → `ref(el)` 的完整往返。memo 命中时这条路径整个不发生。
 *
 * ⚠️ props 必须是稳定引用：`paragraphs` 来自 useMemo([chapter])，`paraRefs`
 *    来自 useRef，两者都稳定。
 */
const Paragraphs = memo(function Paragraphs(props) {
  const { paragraphs, paraRefs } = props
  return paragraphs.map((paragraph, index) => h(
    'p',
    {
      key: paragraph.offset,
      'data-off': paragraph.offset,
      ref: (el) => { paraRefs.current[index] = el },
    },
    paragraph.text,
  ))
})
```

调用处：`h(Paragraphs, { paragraphs, paraRefs })`。

**风险/回归面**：`paraRefs.current` 的写入时机不变（仍然是 render 阶段的 ref 回调），
`handleScroll`（`:1328-1356`）和落回位置的 effect（`:1292-1301`）读它，行为一致。
`memo` 的浅比较只看 `paragraphs` 与 `paraRefs` 两个引用，两者都稳定 —— **命中率很高**。
`test/client.test.mjs:592` 的 `ReaderView` 冒烟用例不受影响（`paragraphs` 初始为空）。

### R4 · 滚动：每次滚动都对 DOM 做二分查找读 `offsetTop`

**收益：中（长章节、慢机器）**

**现状 + 证据**：`handleScroll` 在每帧滚动回调里对 `paraRefs.current` 做二分，
循环体内读 `el.offsetTop`：`lib/client.js:1328-1356`（读在 `:1342`）。
一次滚动事件约 10 次布局属性读取，而**这些值在一次渲染内是常量**。

**具体改法**（缓存一次，之后只在缓存上二分）：

```js
/** 段落 offsetTop 缓存：一次渲染内不变，滚动时反复读 DOM 是纯浪费。 */
const offsetsRef = useRef([])
// 在落回位置的 effect 之后（正文已挂载）填一次
useEffect(() => {
  offsetsRef.current = paraRefs.current.map((el) => (el === null || el === undefined ? 0 : el.offsetTop))
}, [paragraphs])
```

然后 `handleScroll` 里把 `const el = els[mid]` + `el.offsetTop <= top`
换成对 `offsetsRef.current` 的二值比较（没有元素时回落成现有逻辑）。

**风险/回归面**：**中等，要小心**。`offsetTop` 会在以下时刻失效：字体偏好变化
（`fontStyleOf(fontPrefs)`，`:1548`）改变行高、窗口尺寸变化、`fontbar`/`selection` 条出现改变容器宽度。
所以缓存的 effect 依赖数组必须包含 `fontPrefs` 与 `showFontBar`、`selection`：
`[paragraphs, fontPrefs, showFontBar, selection]`。

> 若不想承担这个风险，**只做 R3 也能拿到大部分收益**——R3 减少的是 React 侧的工作，
> R4 减少的是布局侧的读取。建议 **R3 先做，R4 看实测**。

### R5 · 依赖数组：两处「漏了」的，其中一处是真的行为 bug

**收益：低（R5a 是正确性）/ 低（R5b 是精确性）**

**R5a · 落回位置的 effect 多了一个 `initialOffset` 依赖（真 bug，会让滚动位置回弹）**

- **证据**：`lib/client.js:1292-1301`，依赖数组在 `:1301` 是 `[chapter, paragraphs, initialOffset]`。
- **为什么是 bug**：`initialOffset` 来自 `progress.charOffset`。进度回写成功后
  `onOffsetChange`（`:3071-3073`）会 `setProgress(...)` → `ReaderPanel` 重渲染 →
  `initialOffset` 变化 → 这个 effect 重跑 → `scroller.scrollTop = el.offsetTop`。
  而 `handleScroll` 记录的是 `scroller.scrollTop + 12`（`:1333`）对应的段落偏移，
  于是**每次进度回写都会把视口往回带 12px**；划选文字（`selection` 变化 → 重渲染）
  或调整字号时会再次触发一次「跳到该段段首」。
- **具体改法**：把 `initialOffset` 从依赖数组移除。`restoredRef`（`:1262`、`:1293-1294`）
  已经在 `chapter` 变化时重置为 `false`（`:1275`），所以「换章必须落回位置」的语义**不依赖它**。

```js
// 依赖里刻意**不含** initialOffset：它的变化来自进度回写，
// 而回写又是由本次滚动触发的 —— 把它列进来会让每次回写都把视口往回带 12px。
// 换章的语义由 chapter 变化 + restoredRef 重置保证。
}, [chapter, paragraphs])   // eslint-disable-line react-hooks/exhaustive-deps
```

- **风险/回归面**：低。「换章落回上次位置」不变（`chapter` 变化仍触发）。
  变化的是「同章内进度回写不再重新吸附」——这正是修复目标。
  ⚠️ 需要人工验证一次：打开一本书 → 滚到中段 → 等 1.2s → 视口不应有跳动。

**R5b · 书目/目录的依赖数组是正确的，别动**

`ReaderView` 的取正文 effect 依赖 `[book.bookId, chapterIndex]`（`:1289`）并配 `cancelled` 标志
（`:1271`、`:1278`、`:1286-1288`）——**这是正确的竞态防护，不要改成别的写法**。
`TocView` 的 `useMemo(() => groupByVolume(chapters), [chapters])`（`:1149`）也正确。

**R5c · `onOffsetChange` 是内联箭头（低收益，顺手改）**

`:3062-3074` 的 `h(ReaderView, { ..., onOffsetChange: (charOffset) => {...} })` 每次渲染新建函数。
它进入 `flush` 的依赖（`:1315`），于是 `flush` 每次都变 → 卸载 effect（`:1317-1326`）每次都重跑
→ 每次进度回写都多一次**空转的 `flush()`**（`pendingOffset` 已被置 `null`，`:1307`），无害但没必要。

改法：提成 `useCallback`，用函数式 `setProgress` 以免依赖 `progress`：

```js
const handleOffsetChange = useCallback((charOffset) => {
  setProgress((prev) => ({ chapterIndex: prev?.chapterIndex ?? 0, charOffset }))
}, [])
```

### R6（已做得对，不要回退）

- `NoteList` 确实被 `memo` 包住（`:1622`），且 `:2308-2315` 传的 props 引用稳定
  （`notes` 直接传状态数组、`onLoadMore` 是 `useCallback`）——注释（`:1598-1617`）写的三条纪律都落实了。
- `buildParagraphs` 有 `useMemo` 且依赖 `[chapter]`（`:1266`），不是每渲染重切分。
- `progressLabel` → `percentOf` 每次渲染 O(章数)（`:1149` 附近与 `:1396-1399`），
  1000 章约 1,000 次加法，**收益低，不值得动**。

---

## 3. 测试替身的盲区：具体测不出的 bug，以及怎么补

**根因（两行代码）**：

```js
useEffect: () => {},                              // test/client.test.mjs:92
useState: (initial) => [initial, () => {}],       // test/client.test.mjs:95
```

`useState` 的 setter 是空函数 → **状态永远停在初始值**；
`useEffect` 是空函数 → **`refresh()` / `reload()` 永远不会被调用**。

后果：**任何「靠 state 或 effect 才会出现的分支」都没有护栏**。具体清单（按风险排序）：

| # | 测不到的真实分支 | 位置 | 为什么危险 |
|---|---|---|---|
| 1 | **`loadMore` 的分页推进** | `:1806-1818` | `mergeNotesPage` 被单测了（`:1587-1593`），但**「点了按钮之后游标/总数/列表到底怎么变」完全没测**。游标不前进 = 无限拉同一页；`reset: true` 处理错 = 笔记重复出现 |
| 2 | **`pickChapter` 的「同章保偏移」** | `:2957-2966` | `prev.chapterIndex === chapter.index` 时保留 `charOffset`，否则归零。判断反了 → 从笔记页回来会跳回章首 |
| 3 | **`discard` 的 `active === null` 分支** | `:1967-1971` | 没有 active 时不该发 DELETE 请求，只清编辑框 |
| 4 | **`loadPersona` 的 `seedDraft` 守卫** | `:2385-2393` | `:2381-2383` 的注释说这是「最容易出的事故」：`seedDraft !== true` 时**绝不能覆盖编辑框**。目前**零护栏** |
| 5 | **`addTag` 的去重** | `:1984-1990` | 已在框里的 tag 应原样返回 `prev`（不产生新数组，避免无谓重渲染） |
| 6 | **`commit` 的 `attachReply` 分支** | `:1764` | 决定按钮文案（`:2292`）与提示（`:1956-1958`），empty 判断错会让「AI 回应」凭空出现或消失 |
| 7 | **`webGateShort` 的回落** | `:421-424` | 认不出的档位应显示「未知」 |
| 8 | **`ShelfView` / `TocView` / `NotesView` / `CompanionView` 的全部错误分支** | 各自 `.catch` | 宿主挂了时用户看到的是「读取中…」还是「读取失败：原因」，现在测不出来 |
| 9 | **`ReaderView` 的段落渲染** | `:1555-1567` | 第 2 节的 R3/R4 都在这一段，而它**在测试里从未被执行过**（`paragraphs` 恒为空 → 走 `:1553-1554` 的「这一章没有正文」） |

### 补法：沿用项目已有的先例（提成纯函数），不要引 react-dom

项目里已有四个成功先例：`groupBooksByCategory`、`shelfBindingState`、`mergeNotesPage`、
以及 `test/client.test.mjs:920-925` 那句注释明确写下的理由。
**继续沿这条缝往下切**，每个新纯函数都挂到 `__internals`（`:3222-3267`）：

```js
// 1) 对应盲区 #2 —— pickChapter 的进度决策
function nextProgressOnPick(prev, chapter) {
  if (prev !== null && prev.chapterIndex === chapter.index) return prev
  return { chapterIndex: chapter.index, charOffset: 0 }
}

// 2) 对应盲区 #5 —— tag 输入框的归一去重
//    返回 null 表示「没变化」，调用方据此跳过 setState（避免无谓重渲染）
function mergeTagInput(previous, tag) {
  const parts = String(previous).split(/[\s,，]+/).filter((item) => item !== '')
  if (parts.includes(tag)) return null
  return [...parts, tag].join(' ')
}

// 3) 对应盲区 #4 —— persona 编辑框是否该被服务端内容覆盖
function shouldSeedPersonaDraft(seedDraft) {
  return seedDraft === true
}

// 4) 对应盲区 #6 —— 是否带上「AI 回应」一节
function shouldAttachReply(reply) {
  return typeof reply === 'string' && reply.trim() !== ''
}
```

然后组件里改成一行调用（**行为完全不变**，只是把分支挪出组件）：

```js
const pickChapter = useCallback((chapter) => {
  setProgress((prev) => nextProgressOnPick(prev, chapter))
  setView('reader')
}, [])
```

**对应盲区 #1（最重要的那个）**：`loadMore` 的状态推进可以整体提成一个纯函数，
输入是「当前分页状态 + 一页响应」，输出是「下一个分页状态」：

```js
/**
 * 把一页「更旧的笔记」响应并进分页状态。
 *
 * 抽出来的理由和 mergeNotesPage 完全一样：分页状态由 useState 持有，
 * 而测试替身的 setState 是空函数 —— 「点了加载更多之后 state 变成什么」
 * 在组件测试里验证不到。游标不前进会无限拉同一页，这是必须钉死的地方。
 */
function advanceNotesPage(state, data) {
  return {
    notes: mergeNotesPage(state.notes, data),
    total: data?.total ?? state.total,
    hasMore: data?.hasMore === true,
    cursor: data?.nextCursor ?? null,
    loadingMore: false,
  }
}
```

在 `loadMore` 里 `setPagingState((prev) => advanceNotesPage(prev, data))`，
再补 3 条测试：**游标必须变化**、`reset: true` 必须**替换**而非追加、
`hasMore: false` 时 `cursor` 必须是 `null`。

**不要做的**：不要为了这 9 条盲区去引 `react-dom` + `jsdom`。
`test/client.test.mjs:1-10` 的取舍理由（"装出来也只是在测替身"）是对的，
而**提纯函数能覆盖其中 7 条**，成本低一个数量级。

---

## 4. 与宿主通信：`callApi` 的封装质量

### 4.1 现状评价：主体是好的

`callApi`（`:296-315`）做对了这些，**不要改**：

- 先 `res.text()` 再 `JSON.parse`，非 JSON 响应给出**可读**错误而不是 `SyntaxError`（`:304-310`）；
- 非 2xx 时优先取 `parsed.reason ?? parsed.message ?? parsed.error`（`:312`）
  ——与宿主 `sendJson` 的 `{ ok:false, error, message }` 形状对得上（`lib/index.js:1082-1086`）；
- 空响应体归一成 `null`（`:307`），不是 `undefined`。

### 4.2 C1 · 没有超时，也没有并发上限（收益：中高）

**证据**：`callApi` 只透传 `signal`（`:297`、`:300`），而**全文件没有任何调用点传 `signal`**
（`grep AbortController` 在 `lib/client.js` 零命中）。宿主侧也没有超时：
`createApiHandler`（`lib/index.js:1049-1097`）直接 `await route.handler(...)`。

**后果**：请求挂住 → Promise 永不 settle → `.finally(() => setBusy(false))` 永不执行
→ `busy` 恒为 `true` → 该视图的按钮**永久禁用**。最危险的是
`sendToSession`（`:2031-2056`）：它先阻塞式调 `/background/fill`（宿主默认
`memoryTimeoutMs: 120000`，即 **2 分钟**），期间按钮全是灰的；若这一趟真的挂住，
笔记面板就废了，而用户只看到「正在检查前文记忆…」。

并发方面：`openBook` 用 `Promise.all` 并发两个请求（`:2945-2948`），
`refresh` 并发三个（`:1781-1785`），`reload` 并发两个（`:792`）。**没有上限**，但都在 2–3 个，
本机 HTTP 下不是问题——**不要为此加池化**。

**具体改法**（只加超时，保持 `signal` 透传语义不变）：

```js
/** GET 的默认超时。本机 HTTP，正常都在毫秒级；超过这个数就是真出了问题。 */
const API_TIMEOUT_MS = 15000
/** 会触发模型调用的路由（补齐前文记忆）可长达 2 分钟，单独给一个宽限。 */
const API_TIMEOUT_SLOW_MS = 150000
const SLOW_PATHS = ['/background/fill', '/background/compact']

async function callApi(path, options = {}) {
  const { method = 'GET', body, signal } = options
  // 挂住的请求不该把按钮永久锁死：busy 只在 .finally 里复位，
  // 而 Promise 永不 settle 就意味着 .finally 永不执行。
  const budget = SLOW_PATHS.some((p) => path.startsWith(p)) ? API_TIMEOUT_SLOW_MS : API_TIMEOUT_MS
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), budget)
  try {
    const res = await fetch(`${API_ROOT}${path}`, {
      method,
      // 调用方传了 signal 就尊重它（目前无人传，但保留这个接缝）。
      signal: signal ?? controller?.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    /* …以下与现状逐字相同（:304-314）… */
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`宿主超时未响应（${Math.round(budget / 1000)} 秒）`)
    }
    throw error
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
```

**风险/回归面**：低。`AbortController` 在现代 Chromium（Electron 宿主）与 Node 22+ 都有。
唯一行为变化：超时后 `fetch` 抛 `AbortError`，被转成一句人话——而**现有调用点的 `.catch` 全部
已经在把 `describeError(error)` 显示成提示**（例如 `:797`、`:1816`），所以错误路径**本来就有 UI**，
只是从「永远不出现」变成「15 秒后出现」。`test/client.test.mjs` 里对 `callApi` 的测试
（`:522` 附近）需要确认没有断言「不传 signal」——实测那几条只断言 URL 与 options，**应当不受影响**。

### 4.3 C2 · 切书/切章的竞态：只有一处做对了

逐处核对（`cancelled` 标志等价于 AbortController 的效果，无需改）：

| 调用点 | 位置 | 竞态防护 | 判断 |
|---|---|---|---|
| 取正文 | `:1270-1289` | `cancelled` 标志 + cleanup | ✅ **正确，别动** |
| `openBook` 目录+进度 | `:2940-2954` | 无 | ⚠️ 见下 |
| `openBook` 里 `setCatalog` 与 `setBook` | `:2941-2950` | 无 | ⚠️ 见下 |
| `NotesView.refresh` / `loadMore` | `:1781-1818` | 无 | ⚠️ 见下 |
| `CompanionView` 的 5 个 loader | `:2357-2402` | 无 | 低风险（同一本书内） |

**`openBook` 的具体风险**：连续打开 A、B 两本（书架 → 返回 → 开另一本，或快速双击两本），
A 的响应后到就会把 `catalog.chapters` 覆盖成 A 的目录、`progress` 覆盖成 A 的进度，
而 `book` 已经是 B。UI 表现为**标题是 B、目录是 A**。

**具体改法**（一次只认最后一本，与 `ReaderView` 用同一个模式，保持一致性）：

```js
/** 打开请求的代际号：只有最后一个 openBook 的响应算数。 */
const openSeq = useRef(0)

const openBook = useCallback((nextBook) => {
  const seq = openSeq.current + 1
  openSeq.current = seq
  setBook(nextBook); setView('toc')
  setCatalog({ chapters: [], loading: true, error: null })
  setProgress(nextBook.progress ?? null)
  Promise.all([
    callApi(`/books/${nextBook.bookId}/chapters`),
    callApi(`/books/${nextBook.bookId}/progress`),
  ])
    .then(([toc, prog]) => {
      if (openSeq.current !== seq) return          // 已经开了另一本，丢弃
      setCatalog({ chapters: toc.chapters ?? [], loading: false, error: null })
      setProgress(prog.progress ?? null)
    })
    .catch((error) => {
      if (openSeq.current !== seq) return
      setCatalog({ chapters: [], loading: false, error: describeError(error) })
    })
}, [])
```

`NotesView` 同理（它按 `book.bookId` 依赖重建（`:1760-1766`、`:1773`），
但**在组件被复用、只有 bookId 变的瞬间**窗口存在）。若不想逐处加代际号，
一个更省的通用做法是给 `callApi` 加一个可选的 `signal`，由调用方在 cleanup 里 abort——
但**那要改 4 处调用点，而 `cancelled` 标志的写法已经在项目里成立**，
建议只修 `openBook`（影响面最大、错误最显眼：目录与书名不一致）。

**风险/回归面**：低。只增加「丢弃过期响应」的判断；正常情况下序列号必然匹配。
`ReaderView` 已有的同构写法（`:1270-1289`）证明这个模式在本项目里跑得通。

---

## 5. 兼容性：实测结论

### 5.1 危险 API：**基本没有，一处需要注意**

- **`innerHTML` / `dangerouslySetInnerHTML` / `insertAdjacentHTML`：全文件零命中。**
  唯一的 DOM 写入是 `el.textContent = CSS_TEXT`（`:281`）——用 `textContent` 而不是 `innerHTML`
  是正确选择。所有正文、笔记、全书文本都作为 **React 子节点**传入（例如 `:1565`、`:1647-1663`），
  React 会转义，**没有 XSS 面**。这一条做得很好，**不要为了方便改成 `innerHTML`**。
- **`document.querySelector` 的注入面**：`:274` 用的是固定模板串
  `` `style[data-plugin-css="${CSS_ID}"]` ``，而 `CSS_ID` 是常量 `'dsh-reading-companion'`（`:51`）。
  **不是用户输入**，所以不需要 `CSS.escape`。若将来 `CSS_ID` 变成动态值，**必须**加 `CSS.escape`。
- **`Array.prototype.at`：全文件零命中**（`grep '\.at\('` 只命中 `:3148` 的注释）。
  项目刻意避开了它，保持这个习惯。
- **`structuredClone` / `replaceAll` / `Object.fromEntries` / `findLast` / `toSorted` / `Array.prototype.group`：全文件零命中。**
- **可选链 `?.` / 空值合并 `??` / 逻辑赋值**：用得很多，但**全部在表达式位置**
  （如 `chapter?.text ?? ''`、`parsed?.reason ?? parsed?.message`、`background?.gap === null`）。
  **没有一处用在赋值目标或 `new` 的目标上** —— 那种位置在旧环境才会炸。现代 Chromium 全部支持。
- **`.finally()`**：用了 22 处（`:810`…`:2544`）。这是 Promise 标准方法，Electron/Node 22 均有。
- **正则里的中文**：`TITLE_HAS_ORDINAL`（`:646`）用 `[章回节卷篇]` 与中文数字类，属标识符外的普通字符类，安全。

### 5.2 一处**值得知道**的机制耦合（不是 bug）

`installStyles` 给 `<style>` 打的是 `data-plugin-css`（`:280`），而模块系统在物化后会执行
`claimStyles(id)`：把**所有没有 `data-plugin` 属性的 `<style>`** 打上 `data-plugin=<id>`
（`@deepseek-ai/dsh-client-modules/lib/client.js:170-174`），用于 HMR/卸载时清理。

也就是说：**模块系统会来认领这个 `<style>` 并补上 `data-plugin`**。这是预期内的协作，
`installStyles` 的幂等逻辑（`:274-278` 复用已存在的元素并在卸载时移除）与它不冲突。
**但**要知道：如果你把 `data-plugin-css` 改成 `data-plugin`，就会**抢在模块系统之前**
把这个元素标记成"已认领"，卸载时的清理归属会变。**保持现状。**

### 5.3 服务端拼接的前提（与第 1 节互锁）

combo 脚本是**逐文件拼接 + `;\n` 分隔**（`buildCombo()`）。所以：
- 每个文件必须以完整语句结束（`lib/client.js:3270` 是 `})`，✅）；
- **不能**在文件顶层留未闭合的块注释或行注释尾（否则会吃掉下一个 bundle）。
  本文件是**单个 `window.__ModuleLoader__.load({...})` 调用**，✅。
- `test/client.test.mjs:200-205` 明确断言「**只允许注册一个 factory**」——
  这是把「一个包一个 bundle」的契约钉死在测试里。**任何拆包方案都会先撞上这条测试。**

---

## 6. 建议实施顺序（每步独立可验证、可回滚）

| 步 | 项目 | 收益 | 风险 | 验证方式 |
|---|---|---|---|---|
| 1 | **R3** 段落抽 `memo` 组件 | 中高 | 极低 | 360 测试 + 手动：划选/调字号不卡 |
| 2 | **R1** 书架分类选项 `useMemo` | 中 | 极低 | 360 测试 + 手动：输入路径时不卡 |
| 3 | **C1** `callApi` 加超时 | 中高 | 低 | 360 测试；手动：断网后 15s 出提示而非永久禁用 |
| 4 | **R5a** 移除 `initialOffset` 依赖 | 低（正确性） | 低 | 手动：滚动后等 1.2s，视口不跳 |
| 5 | **§3** 提 4~5 个纯函数 + 补测试（含 `advanceNotesPage`） | 中（长期） | 极低 | 测试数从 360 增加；全绿 |
| 6 | **C2** `openBook` 加代际号 | 低 | 低 | 手动：快速连开两本书，标题与目录必须一致 |
| 7 | **R2** 目录分页（短书不分页） | 中高 | 低 | 360 测试 + 手动：1000 章书的目录秒开 |
| 8 | **§1.2** `CompanionView` 按子区块提成节内函数 | 低（可维护） | 极低 | 360 测试（`:907-916` 的静态检查会盯着文案） |
| 9 | **R4** 滚动 offsetTop 缓存 | 中 | **中** | 需覆盖字号/行距/窗口变化 → 建议最后做或不做 |

**不要做**（列出来是为了防止有人"顺手优化"）：
- ❌ 不给 `NoteList` / `TocView` 换虚拟滚动（`NoteList` 的分页已经够用）；
- ❌ 不改 `ReaderView` 取正文 effect 的 `cancelled` 写法（它是对的）；
- ❌ 不把 `__internals`（`:3222-3267`）瘦身（测试直接依赖它）；
- ❌ 不动 `data-plugin-css` 这个属性名（见 §5.2）；
- ❌ 不为「全文搜索」做优化（**该功能不存在**）。

---

## 附：本报告的证据来源（可复核）

- 客户端：`lib/client.js`（3,270 行），逐节通读第 1–3270 行。
- 宿主：`lib/index.js`（路由与 `createApiHandler`）、`lib/host/notes.js`（`paginateNotes` / `NOTES_PAGE_DEFAULT`）。
- DSH 模块系统（只读，未修改）：`@deepseek-ai/dsh-client-modules` 的 `lib/index.js`
  （`resolveMeta`/`clientExportOf`/`buildCombo`/`comboUrl`/`parseDshClient`/`orderByModuleGraph`）
  与 `lib/client.js`（`register`/`arrive`/`materialize`/`require`/`claimStyles`）。
- 测试替身与契约：`test/client.test.mjs`（尤其 `:88-122` 的替身、`:198-211` 模块契约、`:920-925` 的盲区说明）。
- 基线实测：`npm run test:no-isolation` → `tests 360 / pass 360 / fail 0`。
