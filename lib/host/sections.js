/**
 * 背景认识的**分区注册表** —— "一节是什么"的**唯一一处定义**。
 *
 * ## 为什么要有这个文件（2026-10-03）
 *
 * 在这之前，"一节"的各个侧面散成 **19 张平行常量表**（全都在 `background.js` 里）：
 * 文件节序、注入族、整条注入族、读者族、已并入的旧节、分组与否（**还分注入族/读者族两张**）、
 * 只写一次、补齐增量、权重、可压缩、归档豁免、量词、别名、单名常量……
 *
 * 每张表单独看都合理，但它们描述的是**同一组节的不同侧面**，于是长出一张约束网：
 * "顺序必须与权重同序""定义必须排在读者族常量之前（`const` 不提升）""加新节之前先读那段"。
 *
 * ⚠️ **这张网真的出过事。** 2026-10-01 给读者族加「时间与分线」时，`BACKGROUND_SECTIONS`
 * 接对了，**分组判定漏了一族** —— 于是 `### 主线` 与 `### 【支线】… · 第45-72章`
 * 在**每一次写盘**时被当成噪声整行丢掉，而当时 **627 条测试全绿放行**。
 * 根因不是手误，是**一个概念有多个定义点**。
 *
 * ## 现在的形状
 *
 * **一行 = 一节**，所有侧面都是它身上的字段。下面那些导出常量全部**派生**出来，
 * 名字与形状一个都没变 ⇒ **消费者零改动**（`background-update.js` / `compact.js` /
 * `memory.js` 照旧从 `background.js` 取）。而两类陷阱从根上消失：
 *
 *   · **顺序**：数组里元素的顺序**就是**文件节序，不再靠"四段拼接恰好同序"；
 *   · **TDZ**：不再有"某个 `const` 必须定义在另一个之前"，对象字面量没有这回事。
 *
 * ## 加一个新节要做什么
 *
 * 在下面数组里**加一行**，照它的语义填字段。**不需要**再去别处同步任何表。
 * 唯一例外是 `compact.js` 的 `SECTION_COMPACT_RULES` —— 那是给模型看的散文
 * （"这一节该怎么压"），属于措辞不属于结构。
 *
 * ## 字段
 *
 * - `family`：**决定给不给模型看**，四族之一（见下面的常量注释）。
 * - `grouped`：条目是否按 `### 主体` 归拢（"是不是分组"**一律**走 {@link isGroupedSection}，
 *   别再写 `BACKGROUND_GROUPED_SECTIONS.includes(name)` —— 那个函数就是为 2026-10-01 那次事故建的）。
 * - `weight`：注入时的预算占比（只有 `inject` 族有；分母见 `BACKGROUND_SECTION_WEIGHTS`）。
 * - `writeOnce`：已有内容 ⇒ 合并时**丢弃一切新条目**（见 `BACKGROUND_WRITE_ONCE_SECTIONS`）。
 * - `fillIncremental`：后续批次的**补齐子代理**要看到它（见 `FILL_INCREMENTAL_SECTIONS`）。
 * - `compressible`：允许送进模型做分节压缩（见 `compact.js`）。
 * - `archiveExempt`：**不参与冷归档**（见 `BACKGROUND_ARCHIVE_EXEMPT_SECTIONS`）。
 * - `backboneUnits`：本节里**永不归档**的单元名（逐字匹配）。
 * - `noun`：省略提示里用的量词（见 `SECTION_UNIT_NOUN`）。
 */

/**
 * **四族** —— 一节只属于一族，族决定"给不给模型看"。
 *
 * - `full`：**永远整条注入**，不参与权重与保底。这两节"一小段就值一整节"：
 *   元判断（文本类型）是写法的指南针；人物状态是"在场的人"的清单。按权重分的话
 *   它们会被当成普通小节、先拿保底再被裁，**恰好把最关键那句裁掉** ✗。
 * - `inject`：按权重注入 —— 认识的正文。
 * - `reader`：**给读者的分区**：照常存盘、导出、面板可见，但**永不注入**（AI 读不到）。
 *   判据是那句 **"这句话会不会让模型顺着说？"** —— 会，就进这一族。
 *   ⚠️ 两条代价（别忘）：① 这一族 AI 永远读不到 ⇒ 里面的错 / 重复**不会被 AI 自然纠正**，
 *   更依赖读者自己维护；② 它**不参与注入预算**（不进权重表、不占保底），所以可以写完整。
 * - `legacy`：**已并入别处的旧分区**。它**必须仍留在文件节序里**：旧文件里的内容在
 *   解析 / 合并 / **渲染（写盘）** / 导出 / 压缩的重组里都要**原样带着** —— 不这样做，
 *   下一次写盘就会把它静默抹掉（"只增不减"在旧内容上也成立）。它不再注入、不再被补齐书写、
 *   也不参与分节压缩。
 */
export const SECTION_FAMILIES = Object.freeze(['full', 'inject', 'reader', 'legacy'])

/**
 * **文件里真实存在的全部分区** —— 顺序**就是**文件节序（`BACKGROUND_SECTIONS` 直接取它）。
 *
 * ⚠️ 加新节时**只能往这里加**；别在别处再写一张表。
 */
export const BACKGROUND_SECTIONS_TABLE = Object.freeze([
  {
    // ---- 元判断族：永远整条注入 ----
    name: '文本类型',
    family: 'full',
    grouped: false,
    // 第一批补齐时由子代理判断"这本书属于什么类型 + 主视角是谁"（2026-10-03 读者收窄：
    // **只判这两件事**），之后每一批都带着它 ⇒ "这本书是什么形态"有一份稳定的依据。
    //
    // ⚠️ 2026-10-03 曾摘出去半天（改成"可重判"，新判断顶掉旧的），**当天又收回**（读者拍板）：
    //    它是每批都注入的形态依据，**一改，后面所有批次的写法方向跟着变**；
    //    而"改"这个动作本身（哪怕改对了）也会让已写下的条目与新方向不一致。
    //    ⇒ 误判风险**由收窄判据承担**（`memory.js` 第 16 条 + 格式块：**读不出来的一律不判**），
    //    不靠纠错口。实测的反面教材：老格式块问"有没有 cp？"，模型照问作答，
    //    在一本女主很晚才出现的书上写下"有 cp（孟奇 ↔ 江芷微等同伴）"。
    //
    // ⚠️ **"各节该往哪个方向用力"已经搬走**（2026-10-03 读者拍板）：那个消费者只有
    //    **补齐子代理**，而这一节是 `family: 'full'`（**每个聊天轮次都整条注入**）⇒
    //    放这里等于让聊天为一份用不上的指令**永久付费**。它现在住在 `memory.js` 的
    //    **固定块第 20 条**（通用写法、每批重说、**就在原则旁边** ⇒ 从属关系由位置保证）。
    writeOnce: true,
    fillIncremental: true,
    compressible: false,
    noun: '条类型判断',
  },
  {
    name: '人物状态',
    family: 'full',
    grouped: true, // 一人一行 ⇒ 一个主体一条
    // **一人一行的"现在进行时"**：**此刻在哪 + 站在哪边**。
    // 冷归档 + 活跃窗口之后，AI 眼里的"每个人"会随他沉入冷档案而只剩一条**身份锚**
    //（最后一条旧条目）——它说得出"他最后在干嘛"，说不出"他**现在**站在哪边"。
    //
    // ⚠️ 2026-10-03 读者收窄：从"当前处境 / 立场 / 目标 / 在哪条线上"砍到**上面两项** ——
    //    "要干什么"是**动机**、归「人物」（第 18 条明写）；"在哪条线上"指的是**分线**，
    //    而分线是**读者族、AI 根本看不到** ⇒ 对 AI 无意义。两条都是**白付注入预算**。
    //
    // 三条性质，缺一个都会出问题：
    // 1. **可覆盖 —— 全文件唯一的替换例外**：每批**更新**它（同一主体永远只有一行），
    //    旧的自动搬进 `## 已取代`。所以它结构性不存在重复；"现在进行时"不该被历史拖住。
    // 2. **只给活跃的人**：准入是**窗口内仍有条目**；出窗口的人状态行跟人一起归档 ——
    //    老角色回来时 AI 知道"他是谁"（身份锚），但不会拿一句过期状态说错事。
    // 3. **整节注入、不进权重表**：量级 = 活跃人数 × ≤30 字，**随窗口收敛、不随全书章数长**。
    //    ⚠️ 外加一道**硬上限**：注入时只带最近的 `HOST_DEFAULTS.backgroundStateMaxSubjects`
    //    个主体（`background.js` 按状态行章号降序取）。这是**有意的覆盖面牺牲**，
    //    理由见那个常量。
    writeOnce: false,
    fillIncremental: true,
    compressible: false, // 每批整体替换，送进压缩反而制造假状态
    noun: undefined,
  },
  {
    // ---- 注入族：按权重给模型 ----
    name: '人物关系',
    family: 'inject',
    grouped: true, // 主体是**关系双方**（`### 甲 ↔ 乙`）
    // 条目常常不写清"是谁和谁"，既让人读不明白，也让"这条关系属谁"无从追溯。
    // 有了 `###` 分组，每条条目都有一个**可寻址的主体** —— 这正是「取代」能指哪打哪的前提。
    weight: 15 / 48,
    writeOnce: false,
    fillIncremental: true,
    compressible: true,
    noun: '条关系',
  },
  {
    name: '人物',
    family: 'inject',
    grouped: true,
    weight: 13 / 48,
    writeOnce: false,
    fillIncremental: true,
    compressible: true,
    noun: '位人物',
  },
  {
    name: '世界观',
    family: 'inject',
    grouped: true, // 主体是地名 / 势力名 / 设定名
    weight: 9 / 48,
    writeOnce: false,
    fillIncremental: true,
    compressible: true,
    noun: '条设定',
  },
  {
    name: '文风（只写一次）',
    family: 'inject',
    grouped: false, // 它的主体是**整本书**，强行分组只会造出一堆只有一个成员的分区
    // 稳定特征清单，从最早的几章长出来，重复书写不是新信息 —— 真机实测：第二批又写了
    // 一遍（措辞略不同），按普通条目追加后变成了两份并存的日志 ✗。
    //
    // ⚠️ **旧名 `## 文风` 必须继续认**（已有文件里全是它，不认就整节落进"认不出的 `## 标题`"）
    //    —— 见下面的 `SECTION_ALIASES`。
    // ⚠️ 它**不参与冷归档**：稳定特征，永远在场有用。
    weight: 6 / 48,
    writeOnce: true,
    fillIncremental: false, // 后续批次不需要重读它（省 token）
    compressible: true,
    archiveExempt: true,
    noun: '条风格特征',
  },
  {
    name: '通用概念',
    family: 'inject',
    grouped: true, // 非虚构书的核心概念往往正是要逐条寻址、逐条修正的东西
    // **兜底分区**：对一本小说它通常是空的，而 `renderBackgroundForPrompt` 会**跳过没有
    // 内容的分区** ⇒ 它对小说的预算分配**一点影响都没有**（这是加法，不是改动）。
    weight: 5 / 48,
    writeOnce: false,
    fillIncremental: false, // 按"非空才给"单独处理
    compressible: true,
    noun: '个概念',
  },
  {
    // ---- 读者族：永不注入 ----
    name: '时间与分线',
    family: 'reader',
    grouped: true, // 按**单元**分组：`### 主线` / `### 【支线】名字 · 第45-72章`
    // 读者要学小说作者的**伏笔**与**分线结构**：对陪读对话没用，却很长（分线时间轴是全文件
    // 最占地方的），塞进 prompt 只会把「人物关系」挤薄；而「伏笔」一旦注入就是**元剧透通道**
    // —— 一份"这里可能是伏笔"的清单每轮摆在模型眼前，它会顺着暗示（"以后你会知道"），
    // 而那正是守则第 1 条禁掉的。
    weight: undefined,
    writeOnce: false,
    fillIncremental: false, // 只给单元名（不整节给）
    compressible: false, // 改了删了没有任何人能替你重建
    backboneUnits: ['主线'], // 「主线」是这一节存在的理由，搬走等于把读者看这一节的目的搬走
    noun: undefined,
  },
  {
    name: '冷档案',
    family: 'reader',
    grouped: true, // 分组保留 ⇒ `### 人物·甲` 这种主体标题与条目原文都完整保留
    // **代码侧的冷归档区**（2026-10-02 建，读者选的方案 1）。
    //
    // 现状是"背景膨胀 ⇒ 让**模型**把整份文件重写一遍（压缩）"，那条路有三个乘法项：
    // ① 只增不减 ⇒ 文件线性增长；② 压缩 = **整份重写**（输出 ≈ 2.6 tokens/字）⇒ 文件到
    // 1.2–1.5 万字就撞模型 **32768** 输出上限（实测撞过、且有过"响应 0 字"的白跑）；
    // ③ 每轮注入都要塞满预算 ⇒ 缓存前缀一直在变。
    //
    // 冷归档把那一步**从模型手里拿回来**：按章号把**超出活跃窗口**的旧条目**搬**到这里
    // —— **纯代码、零模型调用、不丢一个字**。于是注入量由"活跃窗口"决定，不再由"全书条数"
    // 决定；压缩从"必需品"降级成"可选的整理"。
    //
    // ⚠️ 重点性质：**不进注入**（在读者族里 ⇒ 渲染走不到它）—— 归档的意义就是
    //    "**从上下文里移出**，但**留在文件里**"。
    weight: undefined,
    writeOnce: false,
    fillIncremental: false,
    compressible: false,
    isArchiveTarget: true,
    noun: undefined,
  },
  {
    // ---- 已并入的旧节 ----
    name: '前文脉络',
    family: 'legacy', // 3.0 起并进「时间与分线」的主线名下
    grouped: false, // 它的主体是**时间轴**，强行分组只会造出一堆只有一个成员的分区
    weight: undefined,
    writeOnce: false,
    fillIncremental: false,
    compressible: false,
    noun: '条脉络',
  },
])

/** 取一节的字段（找不到时 `undefined`）。**别在别处再写一遍这些过滤条件。** */
function field(name, key) {
  const row = BACKGROUND_SECTIONS_TABLE.find((item) => item.name === name)
  return row === undefined ? undefined : row[key]
}

/** 按族取节名（保持表内顺序）。 */
function namesOfFamily(family) {
  return BACKGROUND_SECTIONS_TABLE.filter((row) => row.family === family).map((row) => row.name)
}

/**
 * **文件里真实存在的全部分区**（现在是 10 个）= 表内顺序。
 *
 * ⚠️ **这件事故意反过来了**（2026-10-01）：这个名字以前指"注入的那六个"，现在是
 * **文件的全部** —— 因为绝大多数调用点（解析 / 合并 / 取代 / 重写文件 / 建空档）
 * 问的都是"**文件里有哪些分区**"，只有**注入**问的是"给模型哪些"。
 *   · 文件级操作 → 用 **这个**（否则读者族的节会在重写时丢掉 ✗）；
 *   · 注入 / 读者纠正白名单 → 用 {@link BACKGROUND_INJECTED_SECTIONS}。
 *
 * @type {readonly string[]}
 */
export const BACKGROUND_SECTIONS = Object.freeze(BACKGROUND_SECTIONS_TABLE.map((row) => row.name))

/** **永远整条注入**的节（不参与权重与保底）：元判断 + 人物状态。 @type {readonly string[]} */
export const BACKGROUND_FULL_SECTIONS = Object.freeze(namesOfFamily('full'))

/** **按权重注入**的节。 @type {readonly string[]} */
export const BACKGROUND_INJECTED_SECTIONS = Object.freeze(namesOfFamily('inject'))

/** **给读者的分区**（照常存盘/导出/可见，**永不注入**）。 @type {readonly string[]} */
export const BACKGROUND_READER_SECTIONS = Object.freeze(namesOfFamily('reader'))

/** **已并入别处、但仍要原样带着**的旧分区。 @type {readonly string[]} */
export const BACKGROUND_LEGACY_SECTIONS = Object.freeze(namesOfFamily('legacy'))

/** 「文本类型」——元判断节。 @type {string} */
export const BACKGROUND_TYPE_SECTION = '文本类型'

/** 「人物状态」——一人一行的"现在进行时"。 @type {string} */
export const BACKGROUND_STATE_SECTION = '人物状态'

/** 「冷档案」——代码侧的冷归档区。 @type {string} */
export const BACKGROUND_ARCHIVE_SECTION = '冷档案'

/**
 * **已取代**：被新条目取代掉的旧条目的归档区。**它不是 {@link BACKGROUND_SECTIONS} 的成员**
 * ——所以 `renderBackgroundForPrompt` 根本走不到它（永不注入）。
 *
 * 三条性质，缺一不可：
 * 1. **不删除。** 取代是「搬进归档」，不是「抹掉」—— 设计约束「条目只增不减」在取代这件事上
 *    依然成立，读者随时能把一行搬回去撤销取代。
 * 2. **永不进展。**
 * 3. **不参与压缩。** 它是历史日志，不是活记忆 —— 送给压缩模型既浪费 token，又给了它把
 *    已被推翻的旧说法"重新总结"回正文的机会。
 *
 * @type {string}
 */
export const BACKGROUND_RETIRED_SECTION = '已取代'

/**
 * **哪些分区按 `### 主体` 分组** —— 这个概念的**唯一一处定义**（见文件头的 2026-10-01 那次事故）。
 *
 * ⚠️ **不要再在别处写 `BACKGROUND_GROUPED_SECTIONS.includes(name)`。**
 *
 * @param {string} name 分区名
 * @returns {boolean}
 */
export function isGroupedSection(name) {
  return field(name, 'grouped') === true
}

/**
 * **非读者族**里按主体分组的有哪几节。
 *
 * ⚠️ 名字里的 GROUPED 只回答"这几节分组"；**判分组一律走 {@link isGroupedSection}**。
 * 保留它是为了让"注入族形状"能被断言（测试用）。
 *
 * @type {readonly string[]}
 */
export const BACKGROUND_GROUPED_SECTIONS = Object.freeze(
  BACKGROUND_SECTIONS_TABLE.filter((row) => row.grouped === true && row.family !== 'reader').map((row) => row.name),
)

/** **读者族**里按主体分组的分区。 @type {readonly string[]} */
export const BACKGROUND_READER_GROUPED_SECTIONS = Object.freeze(
  BACKGROUND_SECTIONS_TABLE.filter((row) => row.grouped === true && row.family === 'reader').map((row) => row.name),
)

/**
 * **「只写一次」的节**：已有内容 ⇒ 合并时**丢弃一切新条目**。
 *
 * 读者仍然可以直接改文件（他的编辑是权威），`#drc-update` 的取代也照常可用。
 *
 * @type {readonly string[]}
 */
export const BACKGROUND_WRITE_ONCE_SECTIONS = Object.freeze(
  BACKGROUND_SECTIONS_TABLE.filter((row) => row.writeOnce === true).map((row) => row.name),
)

/**
 * **补齐子代理**（后续批次）要看到的几节 —— 见 `renderExistingForFill`。
 *
 * 顺序与文件一致；**「文本类型」排第一**（它是后面每一节的写法依据）；
 * **文风刻意不在里面**（稳定特征，后续批次不需要重读）、**通用概念**按"非空才给"单独处理、
 * **时间与分线**只给单元名。
 *
 * @type {readonly string[]}
 */
export const FILL_INCREMENTAL_SECTIONS = Object.freeze(
  BACKGROUND_SECTIONS_TABLE.filter((row) => row.fillIncremental === true).map((row) => row.name),
)

/**
 * 每节注入时的**预算占比**（分母 **48**）。
 *
 * ⚠️ 比例 `15:13:9:6:5` 是**受保护的**（`background.test.mjs` 有专测钉着）。3.0 起
 * 「前文脉络」并入「时间与分线」（读者 2026-10-02 拍板）：**整个 7 的份额从注入里退出**
 * ⇒ 原比例对其余五节原样保持（分母重基线 55 → 48，等价于"其余分配不动"）。
 * ⚠️ 2026-10-02：**顺序按读者要求把「文风（只写一次）」挪到「通用概念」前面**。
 *
 * @type {Readonly<Record<string, number>>}
 */
export const BACKGROUND_SECTION_WEIGHTS = Object.freeze(
  Object.fromEntries(
    BACKGROUND_SECTIONS_TABLE
      .filter((row) => typeof row.weight === 'number')
      .map((row) => [row.name, row.weight]),
  ),
)

/** 「文风（只写一次）」**不参与冷归档** —— 它是稳定特征，永远在场有用。 @type {readonly string[]} */
export const BACKGROUND_ARCHIVE_EXEMPT_SECTIONS = Object.freeze(
  BACKGROUND_SECTIONS_TABLE.filter((row) => row.archiveExempt === true).map((row) => row.name),
)

/**
 * **允许送进模型做分节压缩**的节 —— 其余节**永不过模型**（代码原样搬运）。
 *
 * 不过模型的那几节，各有各的理由：
 * `文本类型`（写法指南针）/ `人物状态`（每批整体替换，改它反而制造假状态）/
 * `时间与分线`、`冷档案`（读者族 —— 改了删了没有任何人能替你重建）。
 *
 * ⚠️ **它与 {@link BACKGROUND_INJECTED_SECTIONS} 当前同值，但不是同一个概念** ——
 * 前者是"**给**模型看"，这里是"**让**模型改"。今天恰好重合，明天加一节
 * "注入但不许压缩"（或反过来）就会分开 ⇒ 所以是注册表里的**两个字段**，别合并。
 *
 * @type {readonly string[]}
 */
export const COMPRESSIBLE_SECTIONS = Object.freeze(
  BACKGROUND_SECTIONS_TABLE.filter((row) => row.compressible === true).map((row) => row.name),
)

/**
 * 「时间与分线」里**永不归档**的单元 —— 骨架（⚠️ 判据是**单元名逐字**，见该节的
 * `backboneUnits` 字段；别改成前缀匹配）。
 *
 * @type {readonly string[]}
 */
export const BACKGROUND_BACKBONE_UNITS = Object.freeze(
  BACKGROUND_SECTIONS_TABLE.flatMap((row) => row.backboneUnits ?? []),
)

/** 分区单元的量词，用于省略提示的措辞。 */
export const SECTION_UNIT_NOUN = Object.freeze(
  Object.fromEntries(
    BACKGROUND_SECTIONS_TABLE
      .filter((row) => typeof row.noun === 'string')
      .map((row) => [row.name, row.noun]),
  ),
)

/**
 * 分区的**异名**（模型换个说法时的归一）。
 *
 * 分区的识别是**精确匹配**（`## 通用概念`），而节名是提示词里现写的，模型换个说法
 * （`## 通用概念（兜底）`）就会让整节内容落进"认不出的 `## 标题`"分支 —— 那里的条目会被
 * 当成人手写的内容，**不再作为认识渲染，也不再进压缩**。静默丢失比报错难查得多，
 * 所以这里把最可能的几种写法归一。
 *
 * ⚠️ **只给新增的兜底分区留异名。** 既有五节的名字不动：它们已经在读者手上的文件里
 * 出现了几千次，改变它们的匹配规则风险更大。
 *
 * ⚠️ **旧名必须继续认**（`## 文风`、`## 伏笔`）：不认，整节会落进"认不出的 `## 标题`"。
 *
 * @type {Readonly<Record<string, string>>}
 */
const SECTION_ALIASES = Object.freeze({
  通用概念: '通用概念',
  '通用概念（兜底）': '通用概念',
  '通用概念(兜底)': '通用概念',
  通用文本概念: '通用概念',
  通用文本概念兜底: '通用概念',
  其他概念: '通用概念',
  // ---- 2026-10-02：「文本类型」（元判断节）的各种叫法 ----
  文本类型: '文本类型',
  文本类别: '文本类型',
  书籍类型: '文本类型',
  作品类型: '文本类型',
  类型判断: '文本类型',
  图书类型: '文本类型',
  // ---- 2026-10-01：注入族里的「文风」改名成「文风（只写一次）」（读者提的）----
  // 为什么改名：**后续批次不再把这一节注入给子代理**（省 token）⇒ 它实际上只在
  // **第一次补齐**时写一次。名字必须说出这件事，否则读者会一直等它长。
  // 读者随口提过的那个带数字的名字也一并收（他手写时不该被当成新分区）。
  文风: '文风（只写一次）',
  '文风（只写一次）': '文风（只写一次）',
  '文风（前30章）': '文风（只写一次）',
  '文风（前 30 章）': '文风（只写一次）',
  '文风（开篇）': '文风（只写一次）',
  '文风（早期）': '文风（只写一次）',
  // ---- 读者族（2026-10-01）：模型可能换的说法都收进来 ----
  // ⚠️ 「伏笔」**不再单独成节**（读者 2026-10-01："伏笔写在时间与分线下面标出来就行"）。
  //    这几个别名**故意指向时间与分线** —— 万一模型或读者还写 `## 伏笔`，并进去（而不是丢掉 ✗）。
  伏笔: '时间与分线',
  伏笔与悬念: '时间与分线',
  伏笔与线索: '时间与分线',
  未解之谜: '时间与分线',
  时间线: '时间与分线',
  分线: '时间与分线',
  时间与线索: '时间与分线',
  时间轴与分线: '时间与分线',
  故事线与时间: '时间与分线',
})

/**
 * 把模型可能写出的分区名归一到 {@link BACKGROUND_SECTIONS} 里的那一个。
 *
 * 认不出时**原样返回** —— `parseBackground` 依赖"认不出就重置分区"这条行为。
 *
 * @param {string} name 标题原文（已 trim）
 * @returns {string} 归一后的分区名
 */
export function normalizeSectionName(name) {
  if (typeof name !== 'string') return ''
  const trimmed = name.trim()
  return SECTION_ALIASES[trimmed] ?? trimmed
}
