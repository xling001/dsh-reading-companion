/**
 * **守卫分类的判据** —— 单一来源。
 *
 * ## 为什么单独一个文件
 *
 * 这些谓词原先长在 `scripts/guard-census.mjs` 里。2026-10-03 加了一个**元守卫**
 * （`test/guard-discipline.test.mjs`：它要求"`test/client.test.mjs` 里凡是**读生产源码
 * 再断言**的用例，必须**要么**是样式 / 模板类、**要么**真的只是为了把源码跑起来"），
 * 而那个元守卫**需要同一套判据**。
 *
 * 在测试里复制一份就是本仓库反复栽的"**同一概念多份定义**" —— 最贵的一次是
 * `isGroupedSection`：分组判定散在 6 处，加读者族时漏了一处，`### 主线` 在**每一次
 * 写盘**被静默丢掉，而 627 条守卫全绿放行。所以判据收到这里：**普查与元守卫都 import
 * 它**，改一处两边同时变。
 *
 * ⚠️ 改这里的判据 = 改普查的口径 = 改元守卫的红线。改完**先跑 `npm run guard:census`**
 *    看看分类有没有意外跳变（它是只读的）。
 *
 * @module scripts/guard-classify
 */

/**
 * 读的是"源码 / 文档 / 配置"而不是临时数据。
 *
 * ⚠️ 刻意**只认生产源码与文档**：它不匹配 `test/` 下的文件，所以
 * `test/guard-discipline.test.mjs` 这种"读测试文件"的元守卫**不会**被自己算成接线守卫。
 * 这不是巧合，是设计（见 {@link STYLE_PREFIX} 的说明）。
 *
 * @type {RegExp}
 */
export const SOURCE_PATH_RE = /(lib\/|lib'|'\.\.\/lib|'\.\.\/test\/helpers|docs\/|cordis|package\.json|README|CONTRIBUTING|\.yml)/

/**
 * **样式与模板文本**这类守卫的**名字前缀**（2026-10-03 起）。
 *
 * 它们也"读源码再断言"，但钉的**就是那段文本本身**（CSS 长什么样、模板字符串里不许
 * 出现反引号、字号不许写死 px）—— 运行时替身没有 DOM，搬过去只会把断言**变弱**。
 * 所以它们不是"用字符串匹配代替运行"的代偿，而是**这一类唯一可行的测法**。
 *
 * ⚠️ 判据用**前缀**而不是脚本里的白名单：加一条新守卫时，**改名字这件事会在 diff 里
 *    被看见**；白名单藏在脚本里，加进去没人注意。
 *
 * @type {string}
 */
export const STYLE_PREFIX = '样式与模板：'

/**
 * **文本契约**这类守卫的**名字前缀**（2026-10-03 起）。
 *
 * 与 {@link STYLE_PREFIX} 同属"钉的就是文本本身"，但钉的不是样式，而是**看不见的契约**：
 *
 * · **理由注释**：如"卷的开合是**过程状态**（不持久化）、分类/卡片的收起是**偏好**（持久化）"
 *   —— 它挡的是下一轮有人"顺手统一掉"。行为上转不了（钉的就是那句理由）。
 * · **宿主路由表**：如"面板那一块预览已摘掉，但 `lib/index.js` 的 `/books/:bookId/context`
 *   **路由保留**"—— 查的是宿主路由表，不是面板行为，渲染不出来。
 *
 * ⚠️ 它与 {@link STYLE_PREFIX} 一样是**可见的逃逸口**：新加一条必须**改名字**，
 *    于是会在 diff 里被看见。**别把它当垃圾桶** —— 能渲染的一律转行为断言。
 *
 * @type {string}
 */
export const TEXT_CONTRACT_PREFIX = '文本契约：'

/** 两类"钉文本本身"的前缀 —— 元守卫与普查**共用**这一份，别在别处再列一遍。 */
export const TEXT_PIN_PREFIXES = Object.freeze([STYLE_PREFIX, TEXT_CONTRACT_PREFIX])

/** 把文件切成 `test(` 块（每个块 = 一条用例）。 */
export function testBlocks(text) {
  return text.split(/\n(?=test\()/).filter((block) => /^test\(/.test(block.trim()))
}

/** 一条用例的名字。 */
export function testName(block) {
  return (/^test\('([^']+)'/.exec(block.trim()) ?? [])[1] ?? '(无名)'
}

/** 一个块是不是"读源码再断言"的接线守卫。 */
export function isWiringGuard(block) {
  const reads = block.match(/readFileSync\([^)]*\)/g) ?? []
  if (!reads.some((call) => SOURCE_PATH_RE.test(call))) return false
  return /\bassert\./.test(block)
}

/**
 * 接线守卫里的"字符串比对"（脆）还是"为了执行"（健康）。
 *
 * 前者是 `assert.match(源码文本, /…/)` 这类；后者一般是把源码 `import` 进来跑迷你
 * 渲染器，或断言模块导出形状。判据粗糙但**方向**明确：源码里的注释与换行一改就红
 * 的，是前者。
 */
export function isStringCompare(block) {
  if (/assert\.match\(/.test(block)) return true
  if (/assert\.(ok|equal)\([^\n]*(source|code|raw|markdown|body|csv|text)[^\n]*\)/.test(block)) return true
  // ⚠️ **位置 / 计数钉子也是字符串比对**（2026-10-03 补上，原先漏判）。
  //    形状是 `const at = source.indexOf('…')` 再 `assert.ok(at > 0)` / `assert.ok(a > b)`
  //    —— 不是 `assert.match`，所以它**原先落进了"为了执行"那一类**，于是普查把脆钉子
  //    **数少了**（实测漏了 3 条：`交接：清空是显式的…`、`交接：\`wait\` 必须在清空之前
  //    返回…`、`竞态守卫：每个按书加载的资源各自装了守卫`）。
  //    脆度与 `assert.match` 一模一样：改注释、换行、重排代码都可能让它红，而真正接错线
  //    时未必红。**判据宁可宽**：读源码取位置/切片来断言，就是在钉文本。
  return /\b(source|code|raw)\s*\.\s*(indexOf|split|match|replace|slice)\s*\(/.test(block)
}

/**
 * ⚠️ {@link isStringCompare} 的**已知盲区**（2026-10-03 实测）—— 别以为"过了元守卫就不是文本钉子"：
 *
 * 判据认的是 `source.split(...)` 这种**直呼其名**的形态。而有些块把源码先取出一段再切，例如
 * 「正文页每个 prop 都得传下去」那条：
 *
 * ```js
 * const decl = /function ReaderView\(props\)…/.exec(source)
 * const missing = decl[1].split(',').filter((name) => !new RegExp(…).test(call[1]))
 * assert.deepEqual(missing, [])
 * ```
 *
 * 它**就是在比对源码文本**，但变量叫 `decl` / `call`，于是被判成"接线守卫（为了执行）"——
 * **普查会少算一条**。判据要收紧到"凡是从源码里切出字符串再断言"几乎等于要重写整个解析，
 * 收益不成比例；所以这里选择**接受这个盲区并写下来**，靠 {@link TEXT_CONTRACT_PREFIX}
 * 前缀让它**可见**（改名会出现在 diff 里）。
 *
 * ⇒ 判断一条守卫是不是文本钉子，**以它钉的东西为准，不以判据的输出为准**。
 */

/**
 * 一条用例是不是"**钉文本本身**"（样式 / 模板 / 文本契约）。
 *
 * @param {string} block 一个 `test(` 块
 */
export function isTextPin(block) {
  const name = testName(block)
  return TEXT_PIN_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * 一个块属于哪一类 —— 普查与元守卫**共用**这一个函数，别在调用方再写一遍 if。
 *
 * @param {string} block 一个 `test(` 块
 * @returns {'行为'|'文本钉子'|'接线守卫'|'接线守卫（为了执行）'}
 */
export function classifyBlock(block) {
  if (!isWiringGuard(block)) return '行为'
  if (isTextPin(block)) return '文本钉子'
  return isStringCompare(block) ? '接线守卫' : '接线守卫（为了执行）'
}
