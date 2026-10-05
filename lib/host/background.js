/**
 * 背景认识（`background.md`）—— 「记忆」的落点。
 *
 * ## 这是什么
 *
 * 陪读 AI 对这本书**世界观 / 人物 / 人物关系 / 文风**的理解，落成一份
 * 人可以读、可以改的 Markdown，放在书自己的目录里。非小说的文本另有「通用概念」
 * 一节兜底——见 {@link BACKGROUND_SECTIONS}。
 *
 * ⚠️ 旧文件里可能还有**已并入**的「前文脉络」（3.0 起并进「时间与分线」）：
 * 见 {@link BACKGROUND_LEGACY_SECTIONS} —— 它不再注入、不再被书写，但**写盘时原样带着**
 * （"只增不减"在旧内容上也成立）。所以别把它当成一个现行节来读（2026-10-03 更正：文件头
 * 原先把它列在"现行节"里）。
 *
 * ## 为什么是 .md 而不是 JSON
 *
 * 它是**理解**，不是**数据**。你应当能打开它、看懂它、亲手补一句、删掉一句
 * 错的。JSON 把这件事变成"改配置文件"，而且一旦 schema 变了就打不开。
 *
 * ## 三条设计约束
 *
 * 1. **条目只增不减。** 合并时只追加新条目、去重；**从不删除**已有条目。
 *    理由：每次让模型"重新总结一遍"，早期细节都会被反复压缩掉一点，
 *    几次之后就没了。只增不减保证了认识是**单调累积**的。
 *    （文件本身会重写——因为头部覆盖区间要更新——但那是「读→合并→原子写」，
 *    条目集合只增不减。）
 *
 * 2. **每条条目带章节归属。** `- \`第12章\` 与师姐的关系出现裂痕`。
 *    这样同一人物在不同阶段的描述可以并存，认识的演变可追溯；也让"这条是
 *    什么时候知道的"永远可回答。
 *
 * 3. **覆盖区间写在文件自己的头部注释里。** 不另建 `memoryUpToChapter` 字段。
 *    产物即真相：你删掉这个文件，覆盖区间跟着消失，不可能出现"状态说覆盖到
 *    50 章、但文件已经没了"的撒谎情形。
 *
 * ## 章号约定（重要）
 *
 * 文件里、以及本模块对外暴露的 `covered`，全部是 **1 起的章号**，与读者在
 * 目录里看到的序号一致（`covered=1..50` 就是「第 1 章到第 50 章」）。
 * 与 0 起的 `chapterIndex` 的换算只在本模块内部发生，边界处一律写明。
 */

import { anchorRegex } from './anchor.js'
import { atomicWriteText } from './atomic-json.js'
import { HOST_DEFAULTS } from './defaults.js'
import { escapePromptText } from './spoiler.js'
import { readFileSync } from 'node:fs'

/** 背景文件的 schema 版本。 */
export const BACKGROUND_SCHEMA_VERSION = 1

// ⚠️ 章号锚只有**一份**口径（`anchor.js` 的 `anchorRegex()`，反引号可选）：
//    切分、判读、比较键三处都从那里取。历史上这里是第二个常量
//    （`CHAPTER_TAG_RE`，要求反引号），而切分那套是宽松的 —— 两套不咬合，
//    "漏打反引号"的条目会切开却每片都判成没章号（2026-10-02 三方评审 P3-2）。

/** 头部覆盖区间注释。 */
const COVERED_RE = /<!--\s*drc-background:([^>]*?)-->/

/**
 * 分区定义 —— **唯一来源是 `host/sections.js`**。
 *
 * 这一节以前是 **19 张平行常量表**（文件节序 / 注入族 / 整条注入族 / 读者族 / 已并入的旧节 /
 * 分组与否**还分两张** / 只写一次 / 补齐增量 / 权重 / 可压缩 / 归档豁免 / 量词 / 别名…），
 * 每张表都描述**同一组节的不同侧面**，于是长出一张约束网："顺序必须与权重同序"
 * "定义必须排在读者族常量之前（`const` 不提升）"。
 *
 * ⚠️ **那张网出过事**：2026-10-01 给读者族加「时间与分线」时，`BACKGROUND_SECTIONS` 接对了、
 * **分组判定漏了一族** —— `### 主线` 与 `### 【支线】…` 在**每一次写盘**时被当噪声整行丢掉，
 * 而当时 **627 条测试全绿放行**。根因不是手误，是**一个概念有多个定义点**。
 *
 * 现在 **一行 = 一节**，全在 `sections.js` 的 `BACKGROUND_SECTIONS_TABLE` 里。这里只做两件事：
 * **import 进来自己用**、**re-export 出去让消费者零改动**（`background-update.js` / `compact.js` /
 * `memory.js` 照旧从本模块取，一个调用点都不用改）。
 *
 * ⚠️ **加新节请改 `sections.js`，不要在这里再写表。**
 */
import {
  BACKGROUND_ARCHIVE_EXEMPT_SECTIONS,
  BACKGROUND_ARCHIVE_SECTION,
  BACKGROUND_ARCHIVE_BY_UNIT_SECTIONS,
  BACKGROUND_BACKBONE_UNITS,
  BACKGROUND_FULL_SECTIONS,
  BACKGROUND_GROUPED_SECTIONS,
  BACKGROUND_INJECTED_SECTIONS,
  BACKGROUND_INJECT_UNITS,
  BACKGROUND_LEGACY_SECTIONS,
  BACKGROUND_PROMPT_SECTIONS,
  BACKGROUND_READER_GROUPED_SECTIONS,
  BACKGROUND_READER_SECTIONS,
  BACKGROUND_RETIRED_SECTION,
  BACKGROUND_SECTION_WEIGHTS,
  BACKGROUND_SECTIONS,
  BACKGROUND_STATE_SECTION,
  BACKGROUND_TYPE_SECTION,
  BACKGROUND_UNIT_ARCHIVE_SECTIONS,
  BACKGROUND_WRITE_ONCE_SECTIONS,
  FILL_INCREMENTAL_SECTIONS,
  hasTextSubject,
  isGroupedSection,
  isPairPrefixed,
  normalizeSectionName,
  SECTION_UNIT_NOUN,
  textSubjectOf,
} from './sections.js'

export {
  BACKGROUND_ARCHIVE_EXEMPT_SECTIONS,
  BACKGROUND_ARCHIVE_SECTION,
  BACKGROUND_ARCHIVE_BY_UNIT_SECTIONS,
  BACKGROUND_BACKBONE_UNITS,
  BACKGROUND_FULL_SECTIONS,
  BACKGROUND_GROUPED_SECTIONS,
  BACKGROUND_INJECTED_SECTIONS,
  BACKGROUND_INJECT_UNITS,
  BACKGROUND_LEGACY_SECTIONS,
  BACKGROUND_PROMPT_SECTIONS,
  BACKGROUND_READER_GROUPED_SECTIONS,
  BACKGROUND_READER_SECTIONS,
  BACKGROUND_RETIRED_SECTION,
  BACKGROUND_SECTION_WEIGHTS,
  BACKGROUND_SECTIONS,
  BACKGROUND_STATE_SECTION,
  BACKGROUND_TYPE_SECTION,
  BACKGROUND_UNIT_ARCHIVE_SECTIONS,
  BACKGROUND_WRITE_ONCE_SECTIONS,
  FILL_INCREMENTAL_SECTIONS,
  hasTextSubject,
  isGroupedSection,
  isPairPrefixed,
  normalizeSectionName,
  textSubjectOf,
}

/**
 * 文件顶部那段写给人看的说明。
 *
 * ⚠️ **必须是一行**，且两个渲染点（`emptyBackground` / `renderBackground`）共用
 * 这一个常量 —— 它以前是在两处各写四行、并且是"多行注释续行漏进 unknown"那个
 * bug 的源头。定义在这里的另一层意思是：**清理历史遗留的垃圾行时，要匹配的
 * 那条字符串只有一个出处**（见 `scripts/` 里的一次性清理脚本思路）。
 */
export const BACKGROUND_NOTE = '<!-- 这份文件是陪读 AI 对本书的理解，随你的阅读进度自动补充；'
  + '条目只增不减、每条都带章节归属，方便你回头核对。'
  + '被推翻的旧条目会搬到末尾「已取代」里，不会删掉、也不会再喂给 AI；'
  + '你可以直接编辑它——下次补充会尊重你写的内容。'
  // ⚠️ 2026-10-04：这段说明从前只承诺"**不会删掉**"，而**压缩是唯一会改写内容的一步**
  //    （把同一节的条目合并、可能丢低频细节）—— 文件里一个字都没提 ⇒ 读者会以为
  //    这份记录是**全保真**的。同时也没提**历代备份**（读者不知道被压缩掉的东西能找回来）。
  //    这两句补的就是这个缺口：把"如实记录"从**靠信任**变成**可查**。
  //    ⚠️ 它必须是 **HTML 注释**：普通文字行会被解析器当成"认不出的实心行"，下次写入时
  //    搬进「你手写的内容」✗；而注释解析器直接跳过，也**永不进注入** ✓。
  + '⚠️ 唯一会**改写**它的一步是**压缩**：书读长了会把同一节的条目合并、可能丢掉细节。'
  + '但**每次压缩前都留了一代完整备份**（同目录 `background.compactbak.<时间戳>.md`，一份不删）——'
  + '想找回被压缩掉的内容，把它复制成 `background.md` 即可。 -->'

/** 空文件的骨架。 */
export function emptyBackground(title) {
  return [
    `<!-- drc-background: schema=${BACKGROUND_SCHEMA_VERSION} covered= -->`,
    `# 《${title}》· 背景认识`,
    '',
    // ⚠️ **这段说明必须是单行。** 它以前是四行（缩进续行），而解析器当年只挡
    // `<!--` 开头那一行、挡不住续行 —— 续行漏进 `unknown`，被回写进
    // `## 你手写的内容`，**每写一次盘就长三行**。解析器已改成整块跳过注释（见
    // `parseBackground`），单行是第二道闸：没有续行，就没有"续行"这个类别可漏。
    BACKGROUND_NOTE,
    '',
    ...BACKGROUND_SECTIONS.flatMap((section) => [`## ${section}`, '']),
  ].join('\n')
}

/**
 * 解析覆盖区间属性。
 *
 * @param {string} attrs 属性串
 * @returns {{ first: number, last: number }|null} 1 起章号；无有效区间时 null
 */
function parseCovered(attrs) {
  const matched = /covered=(\d+)\.\.(\d+)/.exec(attrs ?? '')
  if (matched === null) return null
  const first = Number.parseInt(matched[1], 10)
  const last = Number.parseInt(matched[2], 10)
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) return null
  return { first, last }
}

/**
 * 读出头部注释里**声明**的 schema 版本。
 *
 * 返回 `null` = "这份文件没有声明"（老文件，或根本不是背景文件），与"声明了一个
 * 我们不认识的版本"是两件不同的事 —— 前者照常读写，后者见 {@link writeBackground}。
 *
 * @param {string} markdown 文件全文
 * @returns {number|null}
 */
export function declaredBackgroundSchema(markdown) {
  const attrs = COVERED_RE.exec(typeof markdown === 'string' ? markdown : '')?.[1] ?? ''
  const matched = /schema=(\d+)/.exec(attrs)
  return matched === null ? null : Number.parseInt(matched[1], 10)
}

/**
 * 解析背景文件。
 *
 * 刻意宽容：文件可能被人手改过（加了自己的段落、改了标题），所以
 * 认不出的行**原样保留在 `unknown` 里**，不会因为解析失败就丢掉。
 *
 * ## 三种条目落点
 *
 * - **分组分区的具名条目** → `groups[分区][主体]`（`### 主体` 之下）
 * - **行首没有 `###` 的条目** → `sections[分区]`（*loose*，散条目）。
 *   ⚠️ 这是一个**修过的数据丢失 bug**：旧实现在 `人物` 下遇到没有 `###` 的条目时
 *   把它塞进 `sections['人物']`，而 `renderBackground` 只渲染 `doc.characters`，
 *   于是那几行会在下一次写盘时**被静默丢掉**。现在散条目会被如实渲染。
 * - **`## 已取代` 之下的条目** → `retired`
 *
 * @param {string} markdown 文件全文
 * @returns {{ covered: object|null, updated: string|null, sections: Record<string, string[]>,
 *             groups: Record<string, Record<string, string[]>>,
 *             characters: Record<string, string[]>, retired: string[], unknown: string }}
 */
export function parseBackground(markdown) {
  const text = typeof markdown === 'string' ? markdown : ''
  const result = {
    covered: null,
    updated: null,
    sections: Object.fromEntries(BACKGROUND_SECTIONS.map((name) => [name, []])),
    groups: Object.fromEntries(
      BACKGROUND_SECTIONS.filter(isGroupedSection).map((name) => [name, {}]),
    ),
    characters: null,
    retired: [],
    unknown: '',
  }
  // 「人物」这一组同时以 `characters` 暴露：index.js / compact.js / memory.js 都按
  // 老形状读它。指向**同一个对象**，所以两边永远不会不同步。
  result.characters = result.groups['人物']

  const header = COVERED_RE.exec(text)
  if (header !== null) {
    result.covered = parseCovered(header[1])
    const updated = /updated=([^\s]+)/.exec(header[1])
    result.updated = updated === null ? null : updated[1]
  }

  let section = null
  let entity = null
  let retired = false
  /**
   * 是否正处在一段**未闭合的 HTML 注释**里。
   *
   * ⚠️ 只看"这一行是不是以 `<!--` 开头"是不够的 —— 见循环里那段说明。
   */
  let inComment = false
  const unknownLines = []

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()

    // ---- HTML 注释：整块跳过（只认首行会漏掉续行）----
    //
    // 这是本文件修过的一个**真 bug**：顶部那段说明以前写成四行（`<!--` + 三个
    // 缩进续行），而旧守卫只挡 `line.startsWith('<!--')` —— **三个续行没被挡住**，
    // 于是它们漏进 `unknown`，又被 `renderBackground` 回写到 `## 你手写的内容`
    // 下，**每写一次盘就长三行**（读者文件里实测攒了 4 组共 12 行，并被导出到
    // Obsidian 里看出来了）。
    //
    // 现在：遇到未闭合的 `<!--` 就进入注释态，直到含 `-->` 的那一行为止。
    // 顺带覆盖"用户自己在别处写多行注释"的同类风险。
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true
      continue
    }

    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line)
    if (sectionMatch !== null) {
      // 异名先归一（见 SECTION_ALIASES）：只有兜底分区有异名。
      const name = normalizeSectionName(sectionMatch[1])
      // ⚠️ **认不出的 `## 标题` 必须重置分区**，不能沿用上一个。旧实现只处理已知
      // 分区、其余原样 continue，于是 `## 你手写的内容`（renderBackground 自己写
      // 出来的那一段）之后的内容会被算进**上一个**已知分区：读者的手写条目被归给
      // 「前文脉络」当成 AI 的记忆渲染，散文则直接丢失。两个方向都是错的。
      if (name === BACKGROUND_RETIRED_SECTION) {
        section = null
        entity = null
        retired = true
      } else if (BACKGROUND_SECTIONS.includes(name)) {
        section = name
        entity = null
        retired = false
      } else {
        section = null
        entity = null
        retired = false
      }
      continue
    }

    const entityMatch = /^###\s+(.+?)\s*$/.exec(line)
    if (entityMatch !== null && !retired && section !== null && isGroupedSection(section)) {
      entity = entityMatch[1]
      if (result.groups[section][entity] === undefined) result.groups[section][entity] = []
      continue
    }
    // ⚠️ **平铺、但主体写在条目文本里**的节（「人物关系」）：`### X` 是**遗留形状**
    //    （3.1.11 及以前写的）。它在这里从前**被静默丢掉** —— 既不是主体（不是分组节），
    //    也不进 `unknown`（见下面那句 `!line.startsWith('#')`）⇒ 它名下的条目
    //    **永远失去"是谁和谁"**（2026-10-04 体检发现，已复现）。
    //    处置是**镜像**上面"散行归位"那一步、把方向反过来：把表头**内联**进它名下的条目
    //    （`X：…`）⇒ 文件在下一次写入时自动收敛成规范形状，对名不丢，
    //    而 `COMPACT_LOST_PAIRS` 与 `relationsOf` 对这批条目也重新生效。
    //    ⚠️ 只对 `hasTextSubject` 的节生效：别的平铺节（「文风」）没有这种形状。
    //    ⚠️ `entity` 复用同一个变量（它就是"当前主体"）⇒ 分区切换处的 `entity = null`
    //    照旧把它清掉，不需要第二套重置点。
    if (entityMatch !== null && !retired && section !== null && hasTextSubject(section)) {
      entity = entityMatch[1]
      continue
    }

    if (line.startsWith('- ') && (section !== null || retired)) {
      const entry = line.slice(2).trim()
      if (entry !== '') {
        if (retired) result.retired.push(entry)
        else if (entity !== null && isGroupedSection(section)) {
          result.groups[section][entity].push(entry)
        } else if (entity !== null && section !== null && hasTextSubject(section)
          && !isPairPrefixed(entry)) {
          // 表头内联。⚠️ **只在条目自己没带"双方"时补** —— 否则会拼出
          // `甲 ↔ 乙：甲 ↔ 乙：…`（判据见 `isPairPrefixed`：不是"有没有冒号"，
          // 因为正文里本来就会有冒号）。
          result.sections[section].push(`${entity}：${entry}`)
        } else result.sections[section].push(entry)
      }
      continue
    }

    // 认不出的实义行：**留着，别丢**。
    //
    // ⚠️ **在已知分区里的也要留**（2026-10-03 体检）：判据从前多一条 `section === null`
    //    ⇒ 读者在 `## 世界观` 底下**手写的一段话**（不是 `- ` 条目）在这一行被**丢掉**，
    //    而解析结果会被 `renderBackground` **整份写回** ⇒ 那段话**下一次写入就消失了**，
    //    不报错、也不进任何归档。这与"`## 你手写的内容`"那一节存在的理由是同一件事：
    //    读者的字**不能因为我们认不出就没了**。
    //    代价 = 位置会挪（它们统一落到 `## 你手写的内容`），换来的是**一个字都不丢**。
    // （注释行在上面循环开头就整块跳过了，这里不必再判 `<!--`。）
    if (line.trim() !== '' && !retired && !line.startsWith('#')) {
      unknownLines.push(line)
    }
  }

  // ⚠️ **分组节里的散行如果自己报了名字，就归到那个主体名下**（2026-10-04 修）。
  //
  //    背景：格式块 2026-10-03 从"平铺"改成"分组"（因为注册表 `grouped: true`），
  //    而那之前写下的散行**留在文件里、没有任何迁移路径**。散行与分组块落在**两个桶**里
  //    （`sections` vs `groups`），而这一节的「替换」语义**只在同一形状内生效**
  //    （见 `mergeBackground` 里那两条各自独立的分支）⇒ 同一个人的旧散行**永远顶不掉**，
  //    于是"此刻现状"里出现两条互相矛盾的记录 —— 实测《神雕侠侣》：
  //    杨过在第 30 章拜师（散行）**和**第 41 章在古墓（分组块），两条都作为"现在"被注入。
  //
  //    判据刻意**窄**：名字必须**已经是这一节的一个主体**（`###` 见过它）才搬 ——
  //    否则会误伤：实测 `- 第4章 武学：凌慕华融百家之长…` 会被当成主体「武学」。
  //    归一之后按主体替换立刻生效：旧那条会被**搬进「已取代」**（不是删掉），
  //    而文件在下一次写入时自动收敛成单一形状（`renderBackground` 只从 `groups` 渲染）。
  //
  //    ⚠️⚠️ **2026-10-05（3.1.19）更正：这句话只对"报了名字"的那一半成立。**
  //    上面那条窄判据意味着**没名字的散行永远搬不动**（`textSubjectOf` 回空串）——
  //    实测两本真机书都有这种行，它们既不会归位、也不会被替换（替换按主体找），
  //    只能读者手工改。所以"自动收敛"是**有条件的**，不是保证；判据与上报见
  //    `memory.js` 的 `orphanEntriesOf`（补齐落盘时按两档如实报）。
  //
  //    ⚠️ 条目原文**一个字不改**（连多余的"杨过："前缀也不动）—— 归档不是重写。
  for (const name of BACKGROUND_SECTIONS) {
    if (!isGroupedSection(name)) continue
    const flat = result.sections[name]
    if (!Array.isArray(flat) || flat.length === 0) continue
    const subjects = result.groups[name] ?? {}
    const keep = []
    for (const entry of flat) {
      const subject = textSubjectOf(entry)
      if (subject !== '' && subjects[subject] !== undefined) subjects[subject].push(entry)
      else keep.push(entry)
    }
    if (keep.length !== flat.length) result.sections[name] = keep
  }

  result.unknown = unknownLines.join('\n')
  return result
}

/**
 * 去掉条目里的章节标记与尾注，用于**跨区间去重**与**取代抑制比对**。
 *
 * `第12章 甲` 与 `第13章 甲` 视为同一条描述：同一件事被两个区间各总结一次
 * 时不该重复出现。但保留原样入库的那一条。
 *
 * ⚠️ 同时要剥掉 HTML 尾注。归档条目带 `<!-- 已于第 N 章被取代 -->`，如果比对键
 * 里留着这段注释，它跟"模型重新总结出来的同一句话"就永远对不上——**取代会失效、
 * 旧说法会复活**。这是本函数唯一一处不是为去重、而是为抑制服务的行为。
 *
 * @param {string} entry 条目
 * @returns {string} 归一化后的比较键
 */
/**
 * **一对人的键**（2026-10-05，读者："一对人一条" ⇒ **2026-10-05 晚修正：双向分开算两条**）。
 *
 * ⚠️ **与方向有关** ✓：`甲 ↔ 乙` 与 `乙 ↔ 甲` 是**两个视角**、算**两条** ✓
 *    （读者真机实测《魔女霓裳》后拍板：「如果是**双向**人物关系，还是**分开视角算两条**」✓
 *     —— 两个视角下**不算重复** ✓）。只有**同一对、同一方向**才并进 ✓。
 * ⚠️ 与 `compactRelationsForPrompt`（注入侧）**刻意不同**：那边是**渲染时**把两个视角并成
 *    一行（省上下文 ✓，两边的正文都在 ✓）；这边是**落盘**，必须按视角分开 ✓。
 *
 * 认不出双方的条目回**空串**（⇒ 调用方宁可不合并，也不把两条无关的关系拼在一起 ✓）。
 *
 * @param {string} entry 一条「人物关系」条目（不带 `- ` 前缀）
 * @returns {string} 键；认不出时为空串
 */
function pairKeyOf(entry) {
  const text = String(entry)
  const cut = text.indexOf('：')
  if (cut <= 0) return ''
  const head = text.slice(0, cut)
  const parties = head.split(/↔|×/).map((one) => one.trim()).filter((one) => one !== '')
  if (parties.length < 2) return ''
  // ⚠️ **不排序**：顺序 = 视角（`甲 ↔ 乙` 是甲的视角、`乙 ↔ 甲` 是乙的）⇒ 两个视角算两条 ✓
  return parties.join('↔')
}

function entryKey(entry) {
  if (typeof entry !== 'string') return ''
  return entry
    .replace(/<!--[\s\S]*?-->/g, '')
    // ⚠️ 比对照旧用宽松那一版（`anchorRegex()`，与判读同源）：**这里剥的是比较键**，
    //    不是正文，所以"把 `第3章` 与 `第13章` 视为同一条描述"正是它要的效果。
    .replace(anchorRegex(), '')
    .replace(/[\s，。,、；;：:]/g, '')
    .trim()
}

/**
 * 归档尾注 —— **全仓唯一的构造点**（三处归档点都走这里）。
 *
 * ## 为什么主体只能进尾注、不能进正文（2026-10-06 实测）
 *
 * 分组节的条目**结构上不自足**：主体住在 `### 甲` 表头里，条目正文里没有它
 * ⇒ 归档时若不带主体，那句"谁的状态"就**永久丢失**。实测：
 *   · 《一世之尊》的「已取代」4 条 —— **0 条**带主体名；
 *   · 《魔女霓裳》6 条 —— **3 条**带（`竹纤：…`），差别正好是"**平铺**形态自带主体
 *     vs **分组**形态主体住表头"。
 * 这与 3.1.16 给「人物关系」内联 `### 甲 ↔ 乙` 表头是**同一个病**（那次修了表头，
 * 这次修归档）。
 *
 * ⚠️⚠️ **绝不能把主体拼进条目正文**：{@link entryKey}（抑制名单的比对键）会剥掉
 * HTML 注释，却**不会**剥主体前缀 —— 而模型在分组形态下写出的正文里**本来就不含主体**
 * ⇒ 键对不上 ⇒ 被顶掉的旧状态**会复活成"此刻"**（那正是 3.1.19 刚堵上的洞）。
 * 写进注释则两头都保住：键不变（注释被剥掉）、原文一字不改。
 *
 * ⚠️ 主体**只由容器提供**（分组节的 `### 甲`）。平铺条目自带主体时**不重复加**
 * （重复一次读起来像另一个人）；取不到就省略这一截。
 *
 * @param {number} rangeLast 本批覆盖的最后一章（1 起）
 * @param {string} [subject] 主体名（来自容器）；空串 / 未给 = 不写这一截
 * @param {string} [entry] 被归档的那条原文（用来判"正文里是不是已经自报了主体"）
 * @returns {string} HTML 注释
 */
function retiredNote(rangeLast, subject = '', entry = '') {
  const who = typeof subject === 'string' ? subject.trim() : ''
  // 条目正文里已经自报**同一个**主体 ⇒ 不重复加（平铺形态就是这样）。
  // ⚠️ 判据用 `textSubjectOf`（唯一口径），不是"有没有冒号" —— 正文里的冒号到处都是。
  const duplicated = who !== '' && textSubjectOf(entry) === who
  return (who === '' || duplicated)
    ? `<!-- 已于第 ${rangeLast} 章被取代 -->`
    : `<!-- 已于第 ${rangeLast} 章被取代 · 主体：${who} -->`
}

/**
 * 合并新认识进已有认识。
 *
 * **只追加、去重、从不删除**——「取代」是搬进归档，不是抹掉。
 *
 * @param {object} current {@link parseBackground} 的结果
 * @param {object} incoming 新的解析结果（同形状，通常来自模型输出）
 * @param {{ first: number, last: number }} range 本批覆盖的章号（1 起）
 * @param {string} [updatedAt] 时间戳
 * @param {object} [options]
 * @param {string[]} [options.supersedes] 要**取代**掉的既有条目（原文或其比较键）。
 *   命中的条目从活分区搬进 `retired`（不删除）；没命中的记进 `lastMerge.unmatched`。
 * @param {boolean} [options.extendCoverage] 是否用本次 `range` 扩覆盖区间（默认 `true`）。
 *   `false` 时**原样保留** `base.covered`。
 *   ⚠️ 背景更新（`background-update.js`）必须传 `false`：那条路径写的是"读者/AI
 *   顺手带回的一条修正"，它**不代表这些章被补过**。若照常取并集，一条关于第 30 章
 *   的修正会让文件声称 `covered=1..30`——于是真正的第 1–29 章缺口被**静默抹掉**，
 *   往后补齐再也不碰它们。这是"用一个动作的副作用谎报另一个动作已完成"的又一例
 *   （同 docs/design-v1-archive.md §204 那条原则）。
 * @returns {object} 合并后的结果（含 `lastMerge` 诊断）
 */
export function mergeBackground(current, incoming, range, updatedAt = new Date().toISOString(), options = {}) {
  const base = current ?? parseBackground('')
  const add = incoming ?? parseBackground('')

  // 归档集合同时是一张**抑制名单**：模型下次重读第 5 章时还会总结出那条已经被
  // 推翻的旧说法，若只按"去重"处理，它会作为一条活条目复活，跟修正后的说法一起
  // 出现在提示词里——那正是「取代」要解决的问题本身。
  const suppressed = new Set((base.retired ?? []).map(entryKey).filter((key) => key !== ''))

  const sections = {}
  // ⚠️ `retired` / `superseded` / `unmatched` 在上面的「人物状态」分支就要用
  //    （状态行是替换：旧的一行进 `已取代`）⇒ 声明必须在最前面 —— `let` 有 TDZ，
  //    声明在下面会让第一次状态合并直接 ReferenceError。
  const retired = [...(base.retired ?? [])]
  const unmatched = []
  let superseded = 0
  for (const name of BACKGROUND_SECTIONS) {
    const existing = Array.isArray(base.sections?.[name]) ? [...base.sections[name]] : []
    // ⚠️ **「人物状态」的替换不在这里做**（2026-10-04 修：替换必须**按主体、跨形态**）。
    //    新状态可能写在**平铺**（`- \`第30章\` 竹纤：…` ⇒ `add.sections`，主体用
    //    `textSubjectOf` 从条目文本里取）或**分组**（`### 竹纤` ⇒ `add.groups`，
    //    桶名就是主体）里，而**旧**状态同样可能留在两个桶的**任一**处（格式块换过
    //    形状，切换的那一批文件两种形态并存）。这一支只看得到 `add.sections` ⇒
    //    新状态写成分组时它**看不见新内容** ⇒ 旧的平铺状态**永远不被 retire** ⇒
    //    同一个人名下并存两条互相矛盾的"此刻"（实测：第 30 章平铺一条 + 第 49 章
    //    分组一条，两条都作为"现在"被注入）。
    //    真正的替换**只在下面那个分组循环里做一处**（那里同时看得见两个桶）。
    //    这里只保证**别掉进本循环末尾的普通追加**（旧行与新行并存正是"越长越多"
    //    的来源），并留一个安全默认值 —— 「人物状态」是分组节（注册表 `grouped: true`），
    //    下面那一处必定会重写它。
    if (name === BACKGROUND_STATE_SECTION) {
      sections[name] = existing
      continue
    }
    // ⚠️ **「只写一次」的节**：已有内容 ⇒ 丢弃一切新条目（连"取代"日志都不留
    //    —— 重复书写不是新信息，也不是被推翻的说法）。真机实测：第二批给「文风」
    //    又写了一遍（措辞略不同），普通追加后成了两份并存的日志 ✗。
    if (BACKGROUND_WRITE_ONCE_SECTIONS.includes(name) && existing.length > 0) {
      // ⚠️ **唯一的例外：调用方显式点名取代**（`options.supersedes`，来自 `#drc-update`
      //    的 `取代:` 字段）。没有这个例外时，一条"把旧判断换掉"的更正会
      //    **先把新条目丢掉、再由下面的取代循环把旧的搬走** ⇒ 这一节被**清空**。
      //    2026-10-03 实测：`节: 文本类型` + `事实: <新判断>` + `取代: <旧判断>`
      //    ⇒ `sections['文本类型'] = []`，而它是**每批都注入**的方向指导 ——
      //    读者想纠正一次误判，代价是把指南针弄没（重判收回后这还是**唯一**的纠正渠道）。
      //
      //    ⚠️ 这与**已删除的"可重判"不是一回事**，别把它当成重判复活：
      //    · 可重判 = 模型**每批自己申请**重写 ⇒ 额外一次子代理调用、方向会漂；
      //    · 这个例外 = **只有调用方显式点名 `取代:`** 才生效 ⇒ 零额外调用，
      //      而且"模型自己写的重复内容一律丢弃"**一个字都没变**（`explicit` 为假时
      //      走下面那条 `fresh.length === 0` ⇒ 原样保留）。
      const incoming = add.sections?.[name] ?? []
      const supersedes = Array.isArray(options.supersedes) ? options.supersedes : []
      /** 这条取代目标指的**就是**本节的某一条已有条目吗（比 `entryKey` ⇒ 忽略章号锚点）。 */
      const targetsExisting = (target) => {
        const key = entryKey(target)
        return key !== '' && existing.some((old) => entryKey(old) === key)
      }
      const explicit = supersedes.some(targetsExisting)
      // 只在显式点名时才考虑新条目；**与旧条目同文的不算新**（写回来 = 零动作）。
      const fresh = explicit
        ? incoming.filter((entry) => {
          const key = entryKey(entry)
          return key !== '' && !suppressed.has(key) && !existing.some((old) => entryKey(old) === key)
        })
        : []
      if (fresh.length === 0) {
        sections[name] = existing
        // ⚠️ 点名取代了、却没有可用的新条目（把同一句话写回来 / 新条目被去重掉）⇒
        //    把目标**标记成已处理**。不标的话，下面的取代循环仍会把它搬走 ——
        //    那就成了"想改却没得改，结果连旧的也没了"，正是这次要修的洞。
        for (const target of supersedes) {
          if (targetsExisting(target)) suppressed.add(entryKey(target))
        }
        continue
      }
      // 换手：新的顶掉旧的，旧的**原文**搬进 `retired`（与「人物状态」替换分支**同一套**
      // 语义与**同一个**归档格式：归档不是删除，读者仍能在「已取代」里看见原判断）。
      for (const old of existing) {
        const oldKey = entryKey(old)
        if (oldKey === '' || suppressed.has(oldKey)) continue
        suppressed.add(oldKey)
        superseded += 1
        retired.push(`${old} ${retiredNote(range.last)}`)
      }
      // 一次写多条 ⇒ **最后一条**说了算（这一族的约定是"一句话 / 一份清单"）。
      sections[name] = [fresh[fresh.length - 1]]
      continue
    }
    // ⚠️ **这里曾经还有第二处覆盖例外（「文本类型」重判）**，2026-10-03 随读者把它改回
    //    "只写一次"而删除 —— 它现在由上面的 `BACKGROUND_WRITE_ONCE_SECTIONS` 分支接住。
    //    ⚠️ 别把上面那个"显式点名取代"的例外与它搞混：那个是**调用方**点名（零调用、
    //    不改方向），这个是**模型自己**每批申请 —— 被收回的是后者。
    const seen = new Set(existing.map(entryKey))
    for (const entry of add.sections?.[name] ?? []) {
      const key = entryKey(entry)
      if (key === '' || seen.has(key) || suppressed.has(key)) continue
      // ---- 同一对自动并进（2026-10-05，读者拍板："一对人一条"）----
      //
      // ⚠️ 实测《神雕侠侣》：48 条关系里 **8 对（22%）** 被拆成 2~4 条 ✗（`杨过 ↔ 赵志敬` ×4）——
      //    提示词第 17b 条要求"同一对只留一条"，但**合并层只会追加** ⇒ 违反只能靠模型自觉 ✗。
      //    这里做成**机制**：同一对已经有条目 ⇒ 把新内容**并进那一条** ✓（不另起一行 ✓）。
      //    ⚠️ 并进去的是**去掉对名前缀**的正文 —— 否则会拼出 `甲 ↔ 乙：…；甲 ↔ 乙：…` ✗
      //      （正是上面 `isPairPrefixed` 那段注释警告过的形状 ✓）。
      //    ⚠️ 条目自带章号锚 ⇒ 并进末尾之后**时间顺序自然保留** ✓。
      if (name === '人物关系') {
        const pair = pairKeyOf(entry)
        const at = pair === '' ? -1 : existing.findIndex((old) => pairKeyOf(old) === pair)
        if (at >= 0) {
          const cut = entry.indexOf('：')
          const body = cut >= 0 ? entry.slice(cut + 1) : entry
          // ⚠️⚠️ **按段去重**（2026-10-05 真机《魔女霓裳》当场抓到）：
          //    模型经常把**同一段关系史再写一遍**（换个批次又写一次 ✓），而 `entryKey` 比的是
          //    **整条** —— 并进之后整条变了 ⇒ 去重**失效** ✗ ⇒ 实测产出
          //    `第3章…；第4章…；第13章…；第3章…；第4章…；第13章…`（同一段两遍 ✗✗）。
          //    ⇒ 并进前先看**每一段**是不是已经在那条里了 ✓：都在 ⇒ 整条跳过（什么都不用做 ✓）。
          const pieces = body.split('；').map((one) => one.trim()).filter((one) => one !== '')
          const already = pieces.length > 0 && pieces.every((one) => existing[at].includes(one))
          if (already) continue
          // 只追加**还没出现过的**那些段（半重复时也不翻倍 ✓）
          const fresh = pieces.filter((one) => !existing[at].includes(one))
          const addBack = fresh.length > 0 ? fresh.join('；') : body
          existing[at] = `${existing[at].replace(/[。；;]\s*$/, '')}；${addBack}`
          seen.add(entryKey(existing[at]))
          continue
        }
      }
      seen.add(key)
      existing.push(entry)
    }
    sections[name] = existing
  }

  // 分组分区按**主体**归并：同一个主体在后续章节的新描述追加到它自己名下。
  const groups = {}
  for (const name of BACKGROUND_SECTIONS) {
    if (!isGroupedSection(name)) continue
    // ⚠️ **「人物状态」是替换、不是追加**（3.0 ②）—— 全文件唯一的覆盖例外。
    //    同一主体**永远只有一行**"现在进行时"，旧的搬进 `已取代`（"只增不减"在
    //    覆盖例外上依然以"搬进归档"的方式成立，与取代是同一套语义、同一个格式）。
    //    ⚠️ **2026-10-04 修：替换必须按主体、跨形态**，所以它在这里**一次做完**，
    //    而且**不受 `add.groups` 有没有内容影响**（从前它住在下面那个
    //    `Object.entries(add.groups…)` 循环里 ⇒ 只在"新状态恰好是分组形态"时才跑）：
    //      · 新状态**两处一起收**：平铺（`add.sections`，主体用 `textSubjectOf` 取）
    //        与分组（`add.groups`，桶名就是主体）；
    //      · **旧**状态也**两处一起找**：平铺与分组落在两个桶里（格式块换过形状，
    //        切换的那一批文件两种形态并存），只找一边就会漏。
    //    实测故障：第 30 章写成平铺、第 49 章写成分组 ⇒ 从前两支谁也看不见谁 ⇒
    //    旧的平铺状态**永远不被 retire**，同一个人名下并存两条互相矛盾的"此刻"。
    if (name === BACKGROUND_STATE_SECTION) {
      const flatOld = Array.isArray(base.sections?.[name]) ? base.sections[name] : []
      const groupedOld = base.groups?.[name] ?? {}
      /** 旧的**同主体**条目 —— 平铺桶与分组桶**一起找**（主体在平铺里靠 `textSubjectOf` 取）。 */
      const oldEntriesOf = (subject) => (subject === ''
        // ⚠️ 主体**取不到**（`textSubjectOf` 回空串：条目里没有冒号，旧文件这一节
        //    全是这种行）时按"**整个平铺桶**"算：判不了它属于谁就宁可少拦，而它的
        //    既有语义正是"这一节此刻的现状"（与 `parseBackground` 那段归位同一条判据）。
        ? [...flatOld]
        : [...flatOld.filter((entry) => textSubjectOf(entry) === subject), ...(groupedOld[subject] ?? [])])
      // 新条目：平铺的排在前面（文件里也是这个顺序），主体取不到的归到空串名下。
      const fresh = [
        ...(add.sections?.[name] ?? []).map((entry) => ({ subject: textSubjectOf(entry), entry, grouped: false })),
        ...Object.entries(add.groups?.[name] ?? {})
          .flatMap(([subject, entries]) => entries.map((entry) => ({ subject, entry, grouped: true }))),
      ]
      // 先算每个主体的换手结果、**再落账**：不先算的话，"状态没变"那条会被同主体
      // 后面那条连带 retire 掉 —— 而"没发生的事不留记录"正是这一节要守的。
      const outcomes = new Map()
      for (const item of fresh) {
        if (!outcomes.has(item.subject)) outcomes.set(item.subject, { olds: oldEntriesOf(item.subject), keep: null })
        const outcome = outcomes.get(item.subject)
        const key = entryKey(item.entry)
        if (key === '' || suppressed.has(key)) continue
        // 状态没变（同一个主体写回了同一句话）⇒ 零动作：不 retire、不产生取代日志。
        if (outcome.olds.some((old) => entryKey(old) === key)) continue
        outcome.keep = item // 一次写多条 ⇒ **最后一条**说了算（这一族的约定是"一句话"）
      }
      const handed = new Set()
      for (const [subject, outcome] of outcomes) {
        if (outcome.keep === null) continue
        handed.add(subject)
        for (const old of outcome.olds) {
          const oldKey = entryKey(old)
          if (oldKey === '' || suppressed.has(oldKey)) continue
          suppressed.add(oldKey)
          superseded += 1
          retired.push(`${old} ${retiredNote(range.last, subject, old)}`)
        }
      }
      // 放回两个桶：新条目按它**自己的形状**落（平铺进 `sections`、分组进 `groups`）；
      // 被换手掉的分组桶要**删掉**（留一个空数组会让渲染写出一个没有条目的 `### 主体` 表头）。
      const stateFlat = handed.has('')
        ? [] // 空串那一档的换手 = **整个平铺桶**都换掉了（口径见 `oldEntriesOf`）
        : flatOld.filter((entry) => !handed.has(textSubjectOf(entry)))
      const stateGroups = {}
      for (const [subject, entries] of Object.entries(groupedOld)) {
        if (handed.has(subject)) continue
        stateGroups[subject] = [...entries]
      }
      for (const [subject, outcome] of outcomes) {
        if (outcome.keep === null) continue
        if (outcome.keep.grouped) {
          if (stateGroups[subject] === undefined) stateGroups[subject] = []
          stateGroups[subject].push(outcome.keep.entry)
        } else stateFlat.push(outcome.keep.entry)
      }
      sections[name] = stateFlat
      groups[name] = stateGroups
      continue
    }
    const merged = {}
    for (const [entity, entries] of Object.entries(base.groups?.[name] ?? {})) merged[entity] = [...entries]
    for (const [entity, entries] of Object.entries(add.groups?.[name] ?? {})) {
      if (merged[entity] === undefined) merged[entity] = []
      const seen = new Set(merged[entity].map(entryKey))
      for (const entry of entries) {
        const key = entryKey(entry)
        if (key === '' || seen.has(key) || suppressed.has(key)) continue
        seen.add(key)
        merged[entity].push(entry)
      }
    }
    groups[name] = merged
  }

  // （`retired` / `unmatched` / `superseded` 已在函数开头声明 —— 人物状态的替换分支要用它们。）

  for (const target of Array.isArray(options.supersedes) ? options.supersedes : []) {
    const key = entryKey(target)
    // 幂等：同一条取代两次不该产生两条归档。
    if (key === '' || suppressed.has(key)) continue
    let removed = null
    // ⚠️ 主体**只由容器提供**（`### 甲`）—— 分组桶里找回来时顺手记下它，归档尾注要带上
    //    （否则读者在「已取代」里看见一句"谁的状态"却不知道是谁；见 `retiredNote`）。
    let removedSubject = ''
    for (const name of BACKGROUND_SECTIONS) {
      const index = sections[name].findIndex((entry) => entryKey(entry) === key)
      if (index >= 0) {
        removed = sections[name].splice(index, 1)[0]
        break
      }
    }
    if (removed === null) {
      findGrouped: for (const name of BACKGROUND_SECTIONS) {
        if (!isGroupedSection(name)) continue
        for (const [entity, entries] of Object.entries(groups[name] ?? {})) {
          const index = entries.findIndex((entry) => entryKey(entry) === key)
          if (index >= 0) {
            removed = entries.splice(index, 1)[0]
            removedSubject = entity
            break findGrouped
          }
        }
      }
    }
    if (removed === null) {
      unmatched.push(target)
      continue
    }
    suppressed.add(key)
    superseded += 1
    retired.push(`${removed} ${retiredNote(range.last, removedSubject, removed)}`)
  }

  // 覆盖区间取并集。我们总是**连续**地从缺口起点往后补，所以正常只会往后长；
  // 用 min/max 是为了容错（手工改过区间时也不会缩回去）。
  //
  // ⚠️ `extendCoverage === false` 是给"背景更新"那条路径用的：它写的是一条修正，
  // 不是一次覆盖（见 `options.extendCoverage` 的说明）。此时区间原样不动。
  const previous = base.covered
  const covered = options.extendCoverage === false
    ? previous
    : (previous === null
      ? { first: range.first, last: range.last }
      : { first: Math.min(previous.first, range.first), last: Math.max(previous.last, range.last) })

  return {
    covered,
    updated: updatedAt,
    sections,
    groups,
    characters: groups['人物'],
    retired,
    unknown: base.unknown ?? '',
    // 「想取代但没找到」必须能被调用方看见：静默什么都没做、而调用方以为修正
    // 已经生效，是这一节最不该出现的情形（与 docs/design-v1-archive.md §204 同一条原则）。
    lastMerge: { superseded, unmatched },
  }
}

/**
 * 把认识渲染回 Markdown 文件。
 *
 * @param {object} doc 合并后的结果
 * @param {string} title 书名
 * @param {object} [options]
 * @param {boolean} [options.includeRetired] 是否写出末尾的「已取代」归档区
 *   （默认 `true`）。压缩器传 `false`：归档是历史日志，送给压缩模型只会浪费
 *   token，还给了它把已被推翻的旧说法重新总结回正文的机会。
 * @returns {string}
 */
/**
 * 渲染**一节**的正文行（含 `## 节名` 之后那个空行），不含 `## 节名` 自己。
 *
 * ⚠️ **这是"一节长什么样"的唯一定义点**（2026-10-03 体检）。从前这里有两份实现：
 * 文件写入器 `renderBackground` 与压缩素材/成品渲染器 `renderOneSectionMarkdown`
 * （`compact.js`）各写一遍，而它们**漂了**——后者把分组排在散条目前面、且条目
 * **不带 `- `**。后果：`parseBackground` 只认 `- ` 行、且 `###` 之后的行归**那个主体**
 * ⇒ 素材形状是错的（模型照形状回时整条静默消失），且混合形状（旧散条目 + 新分组）
 * 重解析时散条目被**并进最后一个主体**（内容改归属）。
 *
 * 顺序是**契约**，不是风格：散条目必须排在所有 `###` **之前**，这样重解析时
 * 它们的 `entity` 仍是 `null` ⇒ 回到 `sections` 而不是某个主体名下。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {string} name 节名
 * @returns {string[]} 行
 */
function renderSectionBody(doc, name) {
  const lines = ['']
  const loose = Array.isArray(doc?.sections?.[name]) ? doc.sections[name] : []
  for (const entry of loose) lines.push(`- ${entry}`)

  const grouped = isGroupedSection(name)
  const entities = grouped ? Object.keys(doc?.groups?.[name] ?? {}) : []
  if (loose.length === 0 && entities.length === 0) lines.push('')
  for (const entity of entities) {
    lines.push(`### ${entity}`)
    for (const entry of doc.groups[name][entity]) lines.push(`- ${entry}`)
    lines.push('')
  }
  if (!grouped || entities.length === 0) lines.push('')
  return lines
}

export { renderSectionBody }

/**
 * 把整份背景认识渲染成 `background.md` 的文本。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {string} title 书名
 * @param {{ includeRetired?: boolean }} [options]
 * @returns {string}
 */
export function renderBackground(doc, title, options = {}) {
  const covered = doc?.covered === null || doc?.covered === undefined
    ? ''
    : `${doc.covered.first}..${doc.covered.last}`
  const updated = typeof doc?.updated === 'string' && doc.updated !== '' ? ` updated=${doc.updated}` : ''

  const lines = [
    `<!-- drc-background: schema=${BACKGROUND_SCHEMA_VERSION} covered=${covered}${updated} -->`,
    `# 《${title}》· 背景认识`,
    '',
    // 单行的理由见 `emptyBackground`。
    BACKGROUND_NOTE,
    '',
  ]

  for (const name of BACKGROUND_SECTIONS) {
    // 节内形状（散条目在前、`- ` 前缀、空行位置）由 `renderSectionBody` 一处定义 ——
    // 压缩那条路也用同一个函数，两处不许再各写一遍（2026-10-03 体检）。
    lines.push(`## ${name}`, ...renderSectionBody(doc, name))
  }

  if (typeof doc?.unknown === 'string' && doc.unknown !== '') {
    lines.push('## 你手写的内容', '', doc.unknown, '')
  }

  // 归档区放在**文件末尾**：它是历史日志，不是活记忆。永远不进展（见
  // BACKGROUND_RETIRED_SECTION），所以它在哪里都不影响模型看到什么。
  if (options.includeRetired !== false && Array.isArray(doc?.retired) && doc.retired.length > 0) {
    lines.push(`## ${BACKGROUND_RETIRED_SECTION}`, '')
    for (const entry of doc.retired) lines.push(`- ${entry}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 读背景文件。文件不存在时回空骨架。
 *
 * @param {string} path 绝对路径
 * @param {string} title 书名
 * @returns {{ markdown: string, doc: object, exists: boolean }}
 */
export function readBackground(path, title) {
  let markdown
  let exists = false
  try {
    markdown = readFileSync(path, 'utf8')
    exists = true
  } catch {
    markdown = emptyBackground(title)
  }
  return { markdown, doc: parseBackground(markdown), exists }
}

/**
 * 拒绝覆盖"比我们新"的背景文件。
 *
 * `schema=` 从前**只写不读**（2026-10-03 A3）：文件里明明声明着版本，解析器一眼
 * 都不看。真正会咬人的场景是**降级** —— 读者先用新版本插件（写下新格式），再回退
 * 到本版本；本版本的解析器把不认识的部分当 `unknown` 或直接忽略，然后照常写回，
 * **新格式的内容就被永久抹掉了**。文件是读者自己的理解，没有第二次机会。
 *
 * 三条边界，缺一条都不该拦：
 *   · 只拦"声明了**比我们新**的版本"；等于 / 更旧 / 没声明都是正常的升级路径；
 *   · 文件不存在（首次创建）不拦；
 *   · 读不出来的文件不拦 —— 那种情况另有"坏文件"处置（见 `library.js`），
 *     在这里再拦一次只会让提示互相盖掉。
 *
 * @param {string} path 绝对路径
 */
function assertBackgroundWritable(path) {
  let existing
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    return
  }
  const declared = declaredBackgroundSchema(existing)
  if (declared === null || declared <= BACKGROUND_SCHEMA_VERSION) return
  throw new Error(
    `BACKGROUND_SCHEMA_UNSUPPORTED: 这份背景认识声明的格式版本是 ${declared}，`
    + `本插件只认识到 ${BACKGROUND_SCHEMA_VERSION} —— 它由更新版本的插件写下，`
    + '已拒绝覆盖（文件原样未动，你的内容没有被改动）。',
  )
}

/**
 * 写背景文件（原子写）。
 *
 * @param {string} path 绝对路径
 * @param {object} doc 结果
 * @param {string} title 书名
 * @returns {string} 落盘后的 Markdown
 * @throws {Error} `BACKGROUND_SCHEMA_UNSUPPORTED`（文件声明了更新的格式）
 */
export function writeBackground(path, doc, title) {
  assertBackgroundWritable(path)
  const markdown = renderBackground(doc, title)
  atomicWriteText(path, markdown)
  return markdown
}

/**
 * 算出「认识缺口」。
 *
 * 缺口 = 读者已读的**前文**里，还没被纳入认识的连续区间。
 * 前文的上界是**当前章的前一章**——当前章由阅读窗口全文投喂，不需要梗概。
 *
 * @param {object|null} covered 已有覆盖区间（1 起章号），null 表示还没建过
 * @param {number} progressIndex 当前章（0 起 chapterIndex）
 * @returns {{ from: number, to: number, chapters: number }|null} 待补区间（1 起，闭区间）；无缺口回 null
 */
export function backgroundGap(covered, progressIndex) {
  if (!Number.isInteger(progressIndex) || progressIndex < 0) return null
  // 前文末日（1 起）：当前章是 chapterIndex+1，所以前一章就是 chapterIndex。
  const lastReadable = progressIndex
  if (lastReadable < 1) return null
  const from = covered === null || covered === undefined ? 1 : covered.last + 1
  if (from > lastReadable) return null
  // ⚠️ **`chapters` 必须在这里就给**（2026-10-03 体检**复现**）：这个对象有过**两个定义点** ——
  //    这里给 `{from,to}`，而 409 那条路（`memory-pipeline.js` 的 `largeGapResult`）给
  //    `{from,to,chapters}`。客户端在**两处**读 `.chapters`（面板"缺口 N 章"那句、
  //    补齐循环的 `remaining`）⇒ 走成功体那两条路时读到 `undefined`：
  //    面板印出**字面「缺口 undefined 章」**，而「还剩 N 章」**永不显示**。
  //    ⚠️ 两侧测试各固化了一半契约（`jump-gate.test.mjs` 把 2 键形状 `deepEqual` 钉死，
  //    而它的**上一行**注释写着"还剩多少由响应里的 gap 如实回报"；客户端替身则自己造了
  //    `{chapters:N}`）⇒ 全绿也抓不到。**同一件事只留一个定义点**：就这里。
  return { from, to: lastReadable, chapters: lastReadable - from + 1 }
}


/**
 * 每个分区在分配时的**保底比例**（相对总预算）。
 *
 * 这一条是专门治旧实现的一个真实缺陷：旧版按整节粒度丢弃，于是一旦
 * 「人物关系」自己就吃掉全部预算，其余三节会被**整节**丢掉，模型拿到的是
 * "未提供：人物、世界观、前文脉络"——等于告诉它这本书没有人物。
 * 保底保证每一节至少露个头。
 */
const SECTION_FLOOR_RATIO = 0.12

/** 回显瘦身时，**索引形态**的条目保留多少字的开头（见 `renderExistingForFill`）。 */
const ECHO_INDEX_HEAD_CHARS = 12

/**
 * **元剧透标记**：带这些字样的条目**一律不进注入**（2026-10-06，B1-B）。
 *
 * ## 为什么需要它
 *
 * 「时间与分线」从前整节不给 AI，理由写在 `sections.js`：它同时装着"**已经发生过什么**"
 * （安全、AI 有用）与"**埋了什么还没收**"（`【伏笔】`/`【未闭合】`）—— 而后者一旦注入就是
 * **元剧透通道**：一份"这里可能是伏笔"的清单每轮摆在模型眼前，它会顺着暗示（"以后你会知道"），
 * 那正是守则第 1 条禁掉的。
 *
 * B1-B 把这一节改成"只给主线"之后，**风险并没有消失**：实测四份真机文件里
 * **3 份的主线里就写着** `【伏笔】`/`【未闭合】` ⇒ 必须在**行级**挡一道。
 *
 * ⚠️ 判据是**带方括号的记号**（提示词里就是这么要求模型写的）—— 刻意**不做**"见到'伏笔'
 *    两个字就丢"那种模糊匹配：那会误伤正常叙述（"他伏笔已久"之类），而**误伤比漏挡更难发现**。
 *
 * @type {readonly string[]}
 */
/**
 * 「未展开」名单在注入里最多列几个名字（2026-10-05，读者点名要的上限）。
 *
 * ## 为什么它必须有上限
 *
 * 这一行是「**装不下的人**」的名单。角色一多，被挤出正文的人就多 ⇒ 名单会**越来越长** ✗，
 * 而它的长度取决于取舍结果、**事前无法计入额度** ⇒ 从前它会无声地把注入顶过预算
 * （实测《一世之尊》9,047 / 9,000）。加上限之后它的成本被**钉死在 ~160 字**以内 ✓，
 * 超出的只报个数（与「出窗」名录同一个口径 ✓）。
 *
 * ⚠️ 与 `rosterMaxNames`（120）**刻意不同**：那个是读者长期名册（出窗的人，一辈子只增不减），
 *    这个是**这一轮**装不下的人（下一轮可能又回到正文里）⇒ 列 40 个足够给 AI 一个「还有谁」的印象 ✓。
 */
const UNEXPANDED_MAX_NAMES = 40

const SPOILER_LINE_MARKS = Object.freeze(['【伏笔】', '【未闭合】', '【未解释】', '【悬念】'])

/** 一条条目是不是带**元剧透标记**（见 {@link SPOILER_LINE_MARKS}）。 */
function isSpoilerLine(line) {
  const text = String(line)
  return SPOILER_LINE_MARKS.some((mark) => text.includes(mark))
}

/**
 * 注入块顶部的**记号图例** —— 全仓唯一的"这些记号是什么意思"定义点。
 *
 * ⚠️ **必须逐字固定**：它在缓存最值钱的稳定前缀里，随内容变化就等于每轮重建前缀。
 *    所以它列的是**全部可能出现的记号**，不是"这一轮用到的"。
 *
 * ⚠️ 它替换掉从前**逐节**的长句说明（"（本节有 N 个主体只列出最近一条记载，更早的在此
 *    未展开；完整内容在 background.md 里。）"那一类）。那些句子有三个毛病：
 *      ① 每节重复一遍；② 它们是**在额度分配之后**追加的 ⇒ 注入必然超预算
 *      （实测《一世之尊》9,222 > 9,000，+2.5%）；③ 措辞每次随数字变化。
 *    现在：**一处说清 + 各节只留极短记号**，而图例的长度**计入 `used`**（在分配之前算）
 *    ⇒ 预算第一次真的是个上界。
 *
 * @type {string}
 *
 * ⚠️⚠️ **图例里会出现记号本身的字面**（`（+N）` / `（出窗 N）`）—— 任何在**整段注入文本**里
 *    搜记号的地方（尤其是测试）都必须**从节标题之后开始搜**，否则会先撞上图例。
 *    这个坑 2026-10-06 在 `background.test.mjs` 的在线折叠用例上真的踩过一次。
 */
const BACKGROUND_LEGEND = [
  '> 记号：`…` = 只给了开头；`（出窗 N）` = 很久没更新，只留名字；',
  '> `（+N）` = 本节有 N 处更早的记载没投喂；`（未展开 N：…）` = 装不下的人，只给名字；',
  '> `（一面之缘）` = 只见过一次的关系，内容在当事人条目里。',
  '> 完整原文都在 background.md 里（这一轮看不到）。',
].join('\n')

/**
 * 从条目文本里挖出它提到的**最大章号**（1 起）；没有则 0。
 *
 * 用于"超预算时先丢哪一条"的判据：越近期的越该留下。区间写法（`第12-15章`）取**终点**。
 *
 * ⚠️ 锚的口径在 `anchor.js`（**唯一**一份，反引号可选）：切分、判读、比较键三处共用，
 *    不许再各写一个 —— 2026-10-02 三方评审 P3-2 实测的漏正出在"两套口径不咬合"。
 * ⚠️ 每次都取**新**正则：带 `g` 的有 `lastIndex` 状态，共用同一个对象会互相打断。
 *
 * @param {string[]} entries 条目
 * @returns {number}
 */
function maxChapterIn(entries) {
  let max = 0
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (typeof entry !== 'string') continue
    const re = anchorRegex()
    let matched
    while ((matched = re.exec(entry)) !== null) {
      const value = Number.parseInt(matched[2] ?? matched[1], 10)
      if (Number.isInteger(value) && value > max) max = value
    }
  }
  return max
}

/**
 * 把背景认识整理成**按实体分组的卡片**，并按"读者读到第几章"过滤。
 *
 * ## 它解决什么
 *
 * `background.md` 里每条条目**已经带章号**、也已经按 `### 主体` 分好组，但读者能看到的
 * 只有**原始 markdown**（面板那个「查看 / 校对」）。于是"这个人到我现在读的地方都干了
 * 什么"要自己在几百行里翻。
 *
 * 这个函数只做两件事：**按章号过滤**（与注入侧同一条边界：条目里最早的章号都超过当前
 * 章的，丢掉；**没写章号的条目一律留** —— 那是通用设定）和**按实体归堆**。之所以要
 * 过滤，是因为这份认识里可能已经有读者还没读到的章（跳读补齐时写进去的）。
 *
 * ⚠️ **只读、不改文件、不进注入路径**：注入那份仍然是 `renderBackgroundForPrompt`，
 * 这里产出的东西只给界面看，所以不引入任何新的失败面。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {number|null} chapterIndex 当前章（0 起）；非整数 = 不过滤
 * @returns {Array<{ name: string, section: string, entries: string[],
 *                   latest: number, earliest: number }>} 按最新章号降序
 */
export function entityCardsFor(doc, chapterIndex) {
  // 转成 1 起章号（文件里、`covered` 里全是 1 起）。
  const limit = Number.isInteger(chapterIndex) && chapterIndex >= 0 ? chapterIndex + 1 : null
  const cards = []
  // ⚠️ **只取「人物」这一节。** 从前我把四个分组分区（人物关系 / 人物 / 世界观 /
  // 通用概念）全收进来，结果《魔女霓裳》里 `## 通用概念` 下的「廿年之约 / 缘 /
  // 情分 / 心魔 / 作者有话要说」、以及 `## 世界观` 下的「《白发魔女传》原著」都被
  // 当成了"人物卡" —— 读者一眼就看出判定太宽。
  //   · `## 人物关系` 的双方**写在条目开头**（`- 甲 ↔ 乙：…`），不是单个的人，另算；
  //   · `## 世界观` / `## 通用概念` 里是设定与概念，本来就不该叫人名卡。
  // 所以"哪些算人物"这件事**由分区的归属决定**，而那份归属是可以手改的（见 README）：
  // 把 `### 白狼` 挪出「人物」、或删掉它，卡片就会跟着变 —— 这比在代码里猜名字可靠。
  const CARD_SECTION = '人物'
  /**
   * 一个主体**牵扯了几条关系** —— 「主要人物」的判据（读者 2026-10-01：主要的排最前）。
   *
   * 为什么用它：
   *   · ❌ 只按**条数**排 ⇒ "话多的小配角"会顶上来（读者实测过：一堆次要角色建卡）；
   *   · ❌ 只按**最新章号**排（旧行为）⇒ 刚被提过一次的人也会顶上来；
   *   · ✅ **他在「人物关系」里出现几次** ⇒ 他"有没有自己的线"，与立卡门槛（memory.js 第 13 条）
   *     是**同一条判据** —— 有关系网的人才是主要人物。
   * ⚠️ 判据是"**名字出现在条目里**"，而它成立的前提是**双方都写在条目开头**
   *    （`- 甲 ↔ 乙：…`，格式块就是这么教的）。
   *    ⚠️ 这里从前还要数 `### 甲 ↔ 乙` 那种**分组名** —— 「人物关系」2026-10-04 改回
   *    平铺之后 `groups['人物关系']` **恒空**，那一半再也走不到，已随本次改动删掉。
   */
  const relationsOf = (name) => {
    if (typeof name !== 'string' || name === '') return 0
    const loose = Array.isArray(doc?.sections?.['人物关系']) ? doc.sections['人物关系'] : []
    let count = 0
    for (const entry of loose) {
      if (String(entry).includes(name)) count += 1
    }
    return count
  }
  for (const [name, entries] of Object.entries(doc?.groups?.[CARD_SECTION] ?? {})) {
    const kept = (Array.isArray(entries) ? entries : []).filter((entry) => {
      if (limit === null) return true
      const earliest = minChapterIn([entry])
      return earliest === 0 || earliest <= limit
    })
    if (kept.length === 0) continue
    cards.push({
      name,
      section: CARD_SECTION,
      entries: kept,
      latest: maxChapterIn(kept),
      earliest: minChapterIn(kept),
      relations: relationsOf(name),
    })
  }
  // 排序：**关系多的 → 最近说到的 → 条目多的 → 名字**（主要人物排最前；同级稳定，不抖动）。
  return cards.sort((left, right) => (right.relations - left.relations)
    || (right.latest - left.latest)
    || (right.entries.length - left.entries.length)
    || left.name.localeCompare(right.name))
}

/**
 * 从条目文本里挖出它提到的**最小章号**（1 起）；一条章号都没提到则回 0。
 *
 * 与 {@link maxChapterIn} 成对：那个回答"这条最晚说到第几章"，这个回答"这条
 * 最早从第几章说起"。后者是**倒退过滤**的判据——一条只说到第 900 章的条目，
 * 对读到第 50 章的读者是纯粹的剧透。
 *
 * 没有章号的条目回 0，于是 `earliest > maxChapter` 永远为假，**一律保留**：
 * 读者自己手写的、或模型写的通用设定（世界观、文风）不该被章号过滤误伤。
 *
 * @param {string[]} entries 条目
 * @returns {number}
 */
function minChapterIn(entries) {
  let min = 0
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (typeof entry !== 'string') continue
    const re = anchorRegex()
    let matched
    while ((matched = re.exec(entry)) !== null) {
      const value = Number.parseInt(matched[1], 10)
      if (!Number.isInteger(value)) continue
      if (min === 0 || value < min) min = value
    }
  }
  return min
}

/**
 * 一节里的**全部条目**（散条 + 分组主体名下的）—— 跨形状取条目时的**唯一来源**。
 *
 * ⚠️ 两个桶都要取：文件里同一节可能两种形状并存（历史原因，见 `parseBackground` 末尾
 *    那段散行归位），只看一个桶就会漏。别在别处再展开一遍这两个 `...`。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {string} name 分区名
 * @returns {string[]}
 */
export function sectionEntries(doc, name) {
  return [
    ...(Array.isArray(doc?.sections?.[name]) ? doc.sections[name] : []),
    ...Object.values(doc?.groups?.[name] ?? {}).flat(),
  ]
}

/**
 * 一节里**出现过的全部章号**（1 起，含区间两端）—— 压缩时"**定位锚不许丢**"的判据。
 *
 * ## 为什么要它（2026-10-04 评审）
 *
 * 章号是这个文件**唯一的定位手段**，三处机制都吃它：
 *   · **倒退过滤**：{@link minChapterIn} 按它逐条判"这条会不会剧透"；
 *   · **冷归档**：{@link maxChapterIn} 按它判"这条是否过老"；
 *   · **取代 / 去重**：`entryKey` 剥掉章号后比对（`第12章 甲` 与 `第13章 甲` 视为同一条）。
 * 压缩把章号并丢 ⇒ 那条记忆**再也无法被定位**，而**文件里看不出少了什么**（静默）。
 * 压缩提示词只在两节写了"章号别丢"，其余节没有，而代码从前**一条都不查**。
 *
 * ⚠️ 取的是**集合**，不是"每条都要有章号"：没有章号的条目本来就合法（读者手写的、
 *    或通用设定），这里只拦**丢掉已有的锚**。同一个章号出现几次也无所谓。
 * ⚠️ 区间**按它覆盖的每一章算**（`第12-15章` ⇒ {12,13,14,15}）—— 见下面那条 2026-10-04 的说明。
 * ⚠️ 正则**只从 {@link anchorRegex} 取**（见 `anchor.js`：全仓唯一一份口径）。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {string} name 分区名
 * @returns {Set<number>} 出现过的章号（升序插入，但不保证全局有序 —— 调用方要排序自己排）
 */
export function chapterSetIn(doc, name) {
  const entries = sectionEntries(doc, name)
  const found = new Set()
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const re = anchorRegex()
    let matched
    while ((matched = re.exec(entry)) !== null) {
      const start = Number.parseInt(matched[1], 10)
      if (!Number.isInteger(start) || start < 1) continue
      const rawEnd = matched[2] === undefined ? start : Number.parseInt(matched[2], 10)
      const end = Number.isInteger(rawEnd) && rawEnd >= start ? rawEnd : start
      // ⚠️ **区间要展开成它覆盖的每一章**（2026-10-04 体检发现，已复现）：压缩提示词
      //    明写"合并后章号写成区间（如 `第3-7章`）"，而只收两端会把"`第3章`+`第4章`+
      //    `第5章` 合并成 `第3-5章`"判成**丢了第 4 章** ⇒ 整批丢弃 ⇒ **那一节永远压不掉**
      //    （`needsCompaction` 仍 over ⇒ 反复白烧调用、读者收到 502）。
      //    区间是**真实锚**：`minChapterIn` / `maxChapterIn` / `entryKey` 三处对区间的行为
      //    与逐条写完全一致 ⇒ 它覆盖的章就是"还在"的章。
      //    ⚠️ 宽度设上限：防一条畸形的 `第1-999999章` 把集合撑爆（超出就只记两端）。
      if (end - start > 5000) {
        found.add(start)
        found.add(end)
        continue
      }
      for (let chapter = start; chapter <= end; chapter += 1) found.add(chapter)
    }
  }
  return found
}

/**
 * **面板用**：这份文件里有多少条记的是"进度之后"的章，最远到第几章。
 *
 * ## 为什么要它（2026-10-01 三方评审 P2）
 *
 * `/background` 回给面板的是**未裁剪的全文**，而投喂给模型的那一份会按
 * `maxChapter` 裁掉超前条目（见 {@link renderBackgroundForPrompt}）。于是同一份
 * 文件出现两种视图：**模型看不到的，读者在面板上看得见**。那**不是剧透泄漏**
 * （模型确实读不到），但读者会以为"面板上有 ⇒ AI 也知道"，校对时改错目标。
 *
 * 处置是**如实说出来**，而不是把读者的文件藏起来 —— 这份文件本来就是给他看、
 * 给他改的（「读者族」的全部价值就在这里）。
 *
 * ⚠️ 判据与投喂侧**同源**：都用条目行首的 `` `第N章` `` 锚（`minChapterIn` /
 * `maxChapterIn`）。两处各写一套解析正是本仓库反复踩过的坑。
 *
 * @param {object} doc 解析结果
 * @param {number} maxChapter 读者读到第几章（1 起；非整数 = 不判定）
 * @returns {{ entries: number, maxChapter: number|null }}
 */
export function countBeyondProgress(doc, maxChapter) {
  if (!Number.isInteger(maxChapter) || maxChapter < 0) return { entries: 0, maxChapter: null }
  let entries = 0
  let furthest = null
  const consider = (list) => {
    for (const entry of Array.isArray(list) ? list : []) {
      const earliest = minChapterIn([entry])
      // 0 = 这条没写章号。没章号就**不算超前** —— 宁可少报，也不要凭空指控。
      if (earliest === 0 || earliest <= maxChapter) continue
      entries += 1
      const latest = maxChapterIn([entry])
      if (latest > (furthest ?? 0)) furthest = latest
    }
  }
  for (const name of BACKGROUND_SECTIONS) {
    consider(doc?.sections?.[name])
    for (const list of Object.values(doc?.groups?.[name] ?? {})) consider(list)
  }
  return { entries, maxChapter: furthest }
}

/**
 * **后续批次**的「我之前整理过的认识」该给什么 —— **增量口径**（2026-10-01 读者定的）。
 *
 * ## 为什么要收窄（读者实测后提的）
 *
 * 从前每一次补齐都把**整份 `background.md`**（含文风、通用概念、时间与分线、已取代）
 * 原样塞进提示词。读者看完实际提示词后指出：**后续批次只提炼新剧情**，
 * 除了第一次，只需要给 **文本类型 / 人物状态 / 人物关系 / 人物 / 世界观** 这五项
 * （= `FILL_INCREMENTAL_SECTIONS` 的**逐字**内容，**逐字有测试钉住**）。
 *
 * 逐节的判断（写在这里，免得下一轮又被"顺手加回去"）：
 *   · **文本类型**：写一次，但**每批都要给** —— 它是"后面几节该怎么写"的依据（要求 16）；
 *   · **人物状态**：一人一行、**替换式**更新（新的一行顶掉旧的一行）⇒ 不给会重复建行；
 *   · **人物关系 / 人物 / 世界观**：新条目要**接在已有主体名下** ⇒ 必须给（要求 7 / 10 / 13）；
 *   · **前文脉络**：⚠️ **3.0 起已并入「时间与分线」**（`BACKGROUND_LEGACY_SECTIONS`）——
 *     它不再注入、不再被补齐书写 ⇒ **不给**。
 *     ⚠️ 2026-10-03 更正：这里原先写"要求 7 明写已经写过的章号范围不要再写一遍 ⇒ 必须给"，
 *     而函数体里**根本没有它的分支**（`FILL_INCREMENTAL_SECTIONS` 不含它）—— 注释在替一个
 *     拿不到的东西立规矩。旧文件里的脉络内容仍由解析 / 合并 / 渲染**原样带着**；它旧的职责
 *     （"同一段章号范围别重写"）现在落在「时间与分线」的**单元名**上（见下）。
 *   · **文风**：它是**稳定特征**，本来就从最早的几章长出来，后续批次不需要重读它，
 *     也不需要（不可能）"从后面的剧情里学文风" ⇒ **不给**，省下的字符还给剧情；
 *   · **通用概念**：小说的这一节通常是空的（空节不占字符），但**非小说书（史书 / 哲学 /
 *     技术书）它就是主体**，不给会让那些书每次都重复建概念 ⇒ **非空才给**；
 *   · **时间与分线**：它的条目不注入（那是读者的整理，不是模型的记忆），但
 *     **单元标题要带上** —— 否则模型每批都新建一批单元名，同一个副本被拆成好几个 `###`。
 *     所以只给"已有的单元名"，并明说不要重写内容。
 *   · **已取代**：**不给**。归档里的旧说法由 `mergeBackground` 的抑制名单兜着，
 *     塞进提示词只是给模型一个"把被推翻的说法再总结回来"的机会。
 *
 * ⚠️ 与 {@link renderBackgroundForPrompt}（给**陪读对话**的注入）不是一回事：
 * 那条是"每一轮都要投喂"的，按预算裁剪、按权重分配；这条只在**补齐**时用一次，
 * 不参与预算分配，所以它不做裁剪，只做**取舍**。
 *
 * @param {object} doc 解析结果
 * @returns {string} 给补齐子代理的"已有认识"文本（空串 = 还没有任何认识）
 */
export function renderExistingForFill(doc, options = {}) {
  // ---- 回显瘦身（2026-10-06）：**只给"这批要用的"全文，其余给索引** ----
  //
  // 病根：回显 = 把整份活文件贴进子代理的提示词。实测《一世之尊》**7,990 字 = 文件的 87%**，
  //   而一批输入 30,867 字里它占 26%，且**随活文件线性长**。
  //
  // 判据（读者 2026-10-05 提的"替代 A"）：`options.focusNames` = **这批样本正文里出现过的**
  //   已知主体名（由调用方 `subjectsInSamples` 算出来）。**在名单里 ⇒ 全文；不在 ⇒ 索引**
  //   （主体名 + 每条章号锚 + 开头 N 字）。
  //
  // ⚠️ 为什么按"样本里出现"而不是"出窗"：模型这批真正**会重新总结到**的就是样本里出现的人
  //   ⇒ 把他们的全文留着，"这条是不是已经记过"的**判断力**才不会掉。而判断力掉了会**漏写**
  //   —— 那比重复更糟（静默丢内容）。样本里没出现的人，这批本来就不会写到。
  // ⚠️ **默认不瘦身**（不给 `focusNames` ⇒ 与从前**逐字相同**）—— 既有调用点与守卫不受影响。
  // ⚠️ `### 主体` 那一行**永远原样**：它是"这一节长什么样"的定义点，模型会照抄形状；
  //   把计数塞进去会让它写出 `### 甲（共 26 条…）` 这种把说明当名字的表头。
  const focus = Array.isArray(options?.focusNames) ? new Set(options.focusNames) : null
  const lines = []
  let slimmedEntries = 0

  /**
   * 一条 `- 条目` 的**索引形态**：**锚之前的内容原样保留**（平铺节的 `甲 ↔ 乙：` 在那里，
   * 丢了它模型就认不出这条是谁的 ⇒ 会给同一对人再写一条）+ 章号锚 + 开头 N 字。
   *
   * ⚠️ 只保留**第一个**章号锚：一条里可能有多个（`第10章` … `第13章` …），
   *    后面的落在被截断的正文里，和"开头 N 字"一起省略 —— 那是刻意的（索引不是全文）。
   */
  const asIndex = (line) => {
    const text = String(line).replace(/^- /, '')
    const match = text.match(anchorRegex())
    if (match === null) {
      const head = text.length > ECHO_INDEX_HEAD_CHARS ? `${text.slice(0, ECHO_INDEX_HEAD_CHARS)}…` : text
      return `- ${head}`
    }
    const anchor = match[0]
    const at = text.indexOf(anchor)
    const prefix = text.slice(0, at)
    const rest = text.slice(at + anchor.length).trim()
    const head = rest.length > ECHO_INDEX_HEAD_CHARS ? `${rest.slice(0, ECHO_INDEX_HEAD_CHARS)}…` : rest
    return `- ${prefix}${anchor} ${head}`
  }

  /** 渲染一个单元：开了瘦身、且**不在关注名单里** ⇒ 索引形态。 */
  const emit = (name, unit) => {
    const full = unit.lines
    if (focus === null) {
      lines.push(...full)
      return
    }
    if (isGroupedSection(name)) {
      const entity = entityOfUnit(unit)
      if (entity !== '' && !focus.has(entity)) {
        slimmedEntries += full.length - 1
        lines.push(full[0])
        for (const line of full.slice(1)) lines.push(asIndex(line))
        return
      }
      lines.push(...full)
      return
    }
    // 平铺节（当前只有「人物关系」）：条目**开头自带双方** ⇒ 双方都不在名单里才瘦身。
    const head = textSubjectOf(String(full[0] ?? '').replace(/^- /, ''))
    const names = head.split(/↔|×/).map((one) => one.trim()).filter((one) => one !== '')
    if (names.length > 0 && names.every((one) => !focus.has(one))) {
      slimmedEntries += 1
      lines.push(asIndex(full[0]))
      return
    }
    lines.push(...full)
  }
  for (const name of FILL_INCREMENTAL_SECTIONS) {
    // ⚠️ 复用 `sectionUnits`（与注入渲染**同一份**"一节长什么样"的定义）：
    //    分组节 = `### 主体` + 名下条目，扁平节 = 一条一行。两处各写一遍布局
    //    正是这个仓库反复踩过的形状。
    const units = sectionUnits(doc, name)
    if (units.length === 0) continue
    lines.push(`## ${name}`, '')
    // ⚠️ **分组节的形状坏了要当场说**（2026-10-03）：文件里那一节的条目**没有 `###` 主体**
    //    （模型漏写 / 读者手改过）时，若照原样平铺回显，子代理看到的就是"这一节长这样"
    //    ⇒ 它会**接着写平铺** ⇒ **一次坏批次永久教坏后面所有批次**（实测《一世之尊》
    //    的 `## 人物` 就是这么塌成平铺流水账、人物卡全空的）。
    //    判据：这一节是分组节，却出现了**不带 `###` 的单元** —— `sectionUnits` 把平铺条目
    //    也当单元，只是首行不是标题（分组单元首行 = `### 主体`）。
    //    ⚠️ 只**提示**、不改写内容：那些散条目各属于谁，代码无从可靠判断（启发式归属
    //    比多花两行上下文糟得多）。
    //    ⚠️⚠️ **不许叫模型"把已有条目重发一遍"**（2026-10-03 实测）：背景认识**只增不减**，
    //    而合并**只在同一个桶里去重** —— 散行在 `sections`、分组在 `groups`，
    //    同一句话跨桶重发 ⇒ **两份都留下、渲染出两次**（探针 `_probe-dedup.mjs` 复现过）。
    //    所以只要求它**这一批照分组形状写**，并明说别重发；旧散行只能由读者自己改或清。
    if (isGroupedSection(name) && units.some((unit) => !String(unit.lines[0] ?? '').startsWith('### '))) {
      lines.push(
        '⚠️ 这一节在文件里**没有 `###` 主体**（旧形状）—— 下面这些条目是散着的。',
        '**这一批请照 `### 主体` 分组写**；⚠️ **别把上面已有的条目重发一遍**（背景只增不减，重发会变成两份）。',
        '',
      )
    }
    for (const unit of units) emit(name, unit)
    lines.push('')
  }

  // 通用概念：非小说书的主体，空节不给（对小说零成本）。
  if (Object.keys(doc?.groups?.['通用概念'] ?? {}).length > 0
    || (doc?.sections?.['通用概念']?.length ?? 0) > 0) {
    const units = sectionUnits(doc, '通用概念')
    lines.push('## 通用概念', '')
    for (const unit of units) emit('通用概念', unit)
    lines.push('')
  }

  const readerUnits = Object.keys(doc?.groups?.['时间与分线'] ?? {})
  if (readerUnits.length > 0) {
    lines.push(
      '## 时间与分线（**只列已有的单元名**）',
      '',
      '⚠️ 这里**只给单元名**，内容我没有贴出来（它太长，而且是我自己看的整理）。'
      + '你的任务是：**新剧情属于哪个已有单元，就接着往那个单元里补**；'
      + '真的是新开的线，才新起一个单元名。**不要**把已有单元的内容重写一遍。',
      '',
    )
    for (const unit of readerUnits) lines.push(`### ${unit}`)
    lines.push('')
  }

  // 冷档案（2026-10-02）：**内容不给**（它就是"从上下文里移出来的旧条目"），只报一句存在与规模。
  // ⚠️ 报它的理由：让子代理知道"更早的事我已经归档过了"，**别把旧条目重新写一遍**
  //   （否则归档省下的上下文会从"重复写一遍"里漏回来）。
  const archived = Object.values(doc?.groups?.[BACKGROUND_ARCHIVE_SECTION] ?? {})
    .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
    + (doc?.sections?.[BACKGROUND_ARCHIVE_SECTION]?.length ?? 0)
  if (archived > 0) {
    lines.push(
      `## ${BACKGROUND_ARCHIVE_SECTION}`,
      '',
      `⚠️ 更早的 ${archived} 条已经**归档**（不在我的视野里，也不用你重写）。'
      + '**只补这一批的新内容**。`,
      '',
    )
  }

  // 瘦身发生过就**如实说明**（跨四层惯例："少给了什么"必须可解释）。
  //
  // ⚠️ **不许在这里替模型做判断**（2026-10-06 读者实机反馈后删掉的那句"拿不准就写"）：
  //    第一版写着"讲的是同一件事就别再写一遍；**拿不准就写**（宁可多一条，也不要漏掉
  //    真信息）"—— 它是在**鼓励多写**，而"该不该写"本来就该由**合并层的抑制名单**
  //    兜（`entryKey` 比对 + `suppressed`），不该由模型在信息不全的情况下猜。
  //    现在只**陈述事实**（这些条目没出现在这一批的正文里 ⇒ 这一批大概不会写到它们）。
  if (slimmedEntries > 0) {
    lines.unshift(
      `下面有 ${slimmedEntries} 条**只给了开头**（以 \`…\` 收尾）—— 它们在这批正文里没有出现，`
      + '这一批大概不会写到它们；完整原文在 background.md 里（这一批看不到）。',
      '',
    )
  }

  return lines.join('\n').trim()
}

/**
 * **已知的主体名**：所有"条目挂在 `### 主体` 下"的节的主体，加上「人物关系」条目开头自报的双方。
 *
 * 用途：回显瘦身的关注名单（{@link subjectsInSamples}）。
 * ⚠️ 只扫**补齐子代理看得见的那些节**（`BACKGROUND_PROMPT_SECTIONS`）——
 *    读者族（`时间与分线` / `冷档案` / `已取代`）的主体不在回显里，列进来只是噪音。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @returns {string[]} 去重后的主体名（顺序 = 首次出现的顺序）
 */
export function knownSubjectNames(doc) {
  const names = new Set()
  for (const name of BACKGROUND_PROMPT_SECTIONS) {
    if (!isGroupedSection(name)) continue
    for (const entity of Object.keys(doc?.groups?.[name] ?? {})) {
      if (entity !== '') names.add(entity)
    }
  }
  for (const entry of doc?.sections?.['人物关系'] ?? []) {
    const head = textSubjectOf(entry)
    if (head === '') continue
    for (const one of head.split(/↔|×/)) {
      const trimmed = one.trim()
      if (trimmed !== '') names.add(trimmed)
    }
  }
  return [...names]
}

/**
 * 这一批的样本正文里**出现过的**已知主体名 —— 回显瘦身的**关注名单**。
 *
 * ⭐ 判据是**确定性的**（宿主自己扫样本正文，不让模型挑），所以：不需要工具、
 *    不多一次模型步进、不新增剧透面、能写守卫。它天然等于"只砍出窗部分"：
 *    样本里出现的几乎都是活跃主体，出窗的人不会出现在这批的正文里。
 *
 * ⚠️ 拿不到样本正文时回空数组 ⇒ `renderExistingForFill` 会把**空数组**当成"没人要全文"
 *    ⇒ 整份索引化。所以调用方**要么给对、要么不给**（`undefined` = 不瘦身）。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {{ text?: string }[]} chapters 这一批的样本（`library.sampleChapters` 的产出）
 * @returns {string[]} 关注名单
 */
export function subjectsInSamples(doc, chapters) {
  const text = (Array.isArray(chapters) ? chapters : [])
    .map((chapter) => (typeof chapter?.text === 'string' ? chapter.text : ''))
    .join('\n')
  if (text === '') return []
  return knownSubjectNames(doc).filter((name) => text.includes(name))
}

/**
 * 把一个分区拆成可独立取舍的**单元**。
 *
 * - 「人物」「世界观」这类分组分区的单元是**一个主体**（连同它名下
 *   的全部条目）——拆到条目粒度会产出"甲有三条、乙一条都没有"这种读起来像
 *   残缺的东西；读者族的「时间与分线」同理（一个单元就是 `### 主线` 或一条支线）；
 * - 散条目（行首没有 `###`）各自成一个单元：它们没有主体可以归拢
 *   —— ⚠️ 「人物关系」2026-10-04 改回平铺之后就走这一支：**一条 = 一个单元**，
 *   所以预算不够时它**逐条丢最旧的**，而不是整块主体被丢；
 * - 其余分区（文风、前文脉络）的单元就是**一条**。
 *
 * 每个单元带两个章号：`recency`（最晚）用于超预算时的"近期优先"取舍，
 * `earliest`（最早，0 = 没提章号）用于 {@link renderBackgroundForPrompt} 的
 * 倒退过滤。
 *
 * @param {object} doc 解析结果
 * @param {string} name 分区名
 * @returns {Array<{ lines: string[], cost: number, recency: number, earliest: number }>}
 */
function sectionUnits(doc, name, maxChapter = null) {
  const units = []

  // ⚠️ **逐片过滤是所有节、两个分支共用的前置步骤**（2026-10-02 三方评审 P1-3）。
  //    3.0.4 把它挂在「分组 + `name === '人物'`」这一条路上，于是同一份文件里其余形态
  //    **照旧整块放行**：扁平条目（模型漏写 `###`、或读者手改过）、平铺的「人物关系」、
  //    分组「世界观」—— 只要条目里**有一个**早于上界的锚，整条（含 `第50章` 那半句）
  //    都进注入。真实数据标定（只读计数）：读者 8 份背景文件里 25 条带括号章号，
  //    其中 **6 条**"括号章号 > 本条行首章号"。
  //
  //    判据：**能不能切开、该不该给，不该由"这条属于哪一节"决定。**
  //
  //    ⚠️ 只在**倒退过滤打开时**（调用方给了 `maxChapter`）才切：切分本身会改变渲染
  //    （一条变多条），而这一段是缓存里最值钱的稳定前缀 —— 正常阅读必须逐字节不变。
  const waterline = Number.isInteger(maxChapter) ? maxChapter : null
  const splitForWaterline = (entry) => {
    if (waterline === null) return { kept: [entry], blocked: 0 }
    const kept = []
    let blocked = 0
    for (const piece of splitParagraph(entry)) {
      // 没带章号的片（`earliest === 0`）照旧保留 —— 那是与进度无关的通用描述。
      const earliest = minChapterIn([piece])
      if (earliest === 0 || earliest <= waterline) kept.push(piece)
      else blocked += 1
    }
    return { kept, blocked }
  }

  for (const entry of doc?.sections?.[name] ?? []) {
    const { kept, blocked } = splitForWaterline(entry)
    // 一条**整条**都在水位线之后 ⇒ 整块丢掉（由单元数报出去），不留一个空单元。
    if (kept.length === 0) continue
    units.push({
      ...makeUnit(kept.map((piece) => `- ${piece}`), maxChapterIn(kept), minChapterIn(kept)),
      blockedPieces: blocked,
    })
  }

  if (!isGroupedSection(name)) return units

  for (const [entity, entries] of Object.entries(doc?.groups?.[name] ?? {})) {
    // 名下条目**全部被取代**的主体不进提示词：留一个光秃秃的 `### 沈某某` 只会
    // 让模型看到一个名字却没有任何关于他的信息，像"这个人被删了"。文件里保留
    // （读者要看见发生了什么），但投喂时跳过。
    if (entries.length === 0) continue

    // ⚠️ **超前的条目/片逐条丢掉，人留住**（2026-10-02 读者拍板的反转，见 gref「人物」）。
    //    旧语义（v1.25 起）是"一位人物只要有一条早于上界的条目，他**整张卡**都保留"，
    //    理由"他在第 5 章就已经是这个人了"—— 那条理由解释了"为什么要留这个人"，
    //    没有解释"为什么要把他的第 900 章也留下"（实测读者在第 20 章会看到
    //    "`第900章` 已经当上掌门"）。所以：**人留住**（他有已读条目 ⇒ 卡还在，
    //    "他是谁"不丢）；超前的片段丢掉，并把丢了几片报给面板（"截了就要说"）。
    //    ⚠️ 判据仍是 `earliest`（不是 `recency`）：第 5 章登场、第 900 章还有戏的人
    //    不会被整块丢掉 —— 被丢的只是第 900 章那一片。
    let blockedPieces = 0
    const kept = []
    for (const entry of entries) {
      const split = splitForWaterline(entry)
      kept.push(...split.kept)
      blockedPieces += split.blocked
    }
    // 一个人名下**一片都没剩下** ⇒ 他完全是"以后才出现的人"（读者还没见过他），
    // 整张卡丢掉是对的。
    if (kept.length === 0) continue

    units.push({
      ...makeUnit(
        [`### ${entity}`, ...kept.map((entry) => `- ${entry}`)],
        maxChapterIn(kept),
        minChapterIn(kept),
      ),
      blockedPieces,
    })
  }

  return units
}

/**
 * 括号对（只收有明确配对的；直引号 `"` 两侧同形、配不了对，刻意不收）。
 *
 * ⚠️ **这张表就是"清了哪些括号"的唯一口径**：`test/background.test.mjs` 的残肢用例
 *    直接从它派生。2026-10-02 三方评审 P3-3 的教训就在这：作者自己的分隔符用例表里
 *    有 `[`、实现表里没有 ⇒ `甲遇见同伴[\`第50章\` 其实是…` 切出来尾部留着一个
 *    没配对的 `[`。两份表各写一套的漏法，靠"用例从实现派生"结构性地堵掉。
 *
 * `[`/`]` 与 `〈`/`〉` 是 2026-10-02 补的：正文里方括号与单书名号同样常见，
 * 都是"切点落在一对括号中间"时会产生残肢的形状。
 */
export const BRACKET_PAIRS = Object.freeze({
  '（': '）', '(': ')', '[': ']', '「': '」', '『': '』', '【': '】', '〔': '〕', '〈': '〉', '《': '》', '“': '”', '‘': '’',
})

/**
 * 清掉一段的**括号残肢**：切点落在一对括号**中间**时，一边会剩下一个没配对的括号
 * （前一片以 `（` 收尾、后一片剩下 `…）`）—— 留着读起来是坏的。
 *
 * ## 为什么不是"看首尾字符"（两版都栽在这上面）
 *
 *   · 第一版只清了**尾部开括号** ⇒ `（\`第9章\` 才又提到）` 切出来还是
 *     `\`第9章\` 才又提到）`（残肢在**尾**，但残的是闭括号）；
 *   · 第二版改成"首尾都看"，仍然漏 —— 因为残肢后面可能**还跟着句号**：
 *     `\`第9章\` 才又提到）。` 的末位字符是 `。`，首尾扫描当场停住。
 *
 * 正确判据与位置无关：**这个括号在本片里有没有配对**。所以这里做一次配对扫描
 * （栈），把"没有对应开括号的闭括号"和"没有闭合的开括号"逐位置记下来删掉 ——
 * 它们**必然**是切分留下的残肢（原文里正常的括号一定是配对的）。
 *
 * 代价注意：原文本身括号写歪了（模型少打一个括号）时，也会被清掉一个 ——
 * 那是"读起来更顺"的方向，可以接受。
 *
 * @param {string} piece 一片
 * @returns {string} 去掉残肢后的片
 */
function trimDanglingBrackets(piece) {
  const closers = new Set(Object.values(BRACKET_PAIRS))
  const drop = new Set()
  const stack = []
  for (let i = 0; i < piece.length; i += 1) {
    const ch = piece[i]
    const closer = BRACKET_PAIRS[ch]
    if (closer !== undefined) {
      stack.push({ closer, index: i })
      continue
    }
    const top = stack[stack.length - 1]
    if (top !== undefined && top.closer === ch) {
      stack.pop()
      continue
    }
    // 是闭括号、但栈顶不是它对应的开括号 ⇒ 这是个没配对的残肢。
    if (closers.has(ch)) drop.add(i)
  }
  // 栈里剩下的是**没闭合**的开括号 —— 同样是残肢。
  for (const item of stack) drop.add(item.index)
  if (drop.size === 0) return piece
  let out = ''
  for (let i = 0; i < piece.length; i += 1) if (!drop.has(i)) out += piece[i]
  return out
}

/**
 * 把一条条目按**每一个章号锚**切开（每个锚起一片）。
 *
 * ## 为什么是"每一个锚"而不是"句读之后才切"（2026-10-02 读者拍板）
 *
 * 这条函数是"材料层不许漏后文"的执行者：读者跳回水位线之前时，只有锚 ≤ 上界的片
 * 能进提示词。而它前后被改过两次，形状值得记住：
 *   1. **最初**只在锚紧跟句读（。！？；"」）时切 ⇒ `，` / 空格 / `：` 分隔的写法
 *      **整条放行**（三方评审 P1 实测四种分隔全漏）；
 *   2. **第一次修**把判据放宽成"句读之后 **或** 不在**闭合**括号里" —— 于是
 *      `（\`第50章\` 其实是幕后黑手）` 这种"括号里写着后文事实"**照样漏**，
 *      而它当时是**明知**留下的残留（怕把句内交叉引用剁成残句）；
 *   3. **现在**（读者拍板方案 A）：**每个锚都切**，切出来的残肢由
 *      {@link trimDanglingBrackets} 清掉。理由：`（\`第9章\` 才又提到）` 这种
 *      "句内引用"本身**就是后文信息**（"他后面还会出现"），为它开一个豁免口子，
 *      换来的是一条真实的剧透通道 —— 不值。
 *
 * ⚠️ **它不改变"读得通"**：片与片仍按顺序渲染成相邻的条目；只是每条现在带**一个**
 * 章号，于是可以**逐条**判断该不该给。少于两个锚的条目原样返回（绝大多数都如此）。
 *
 * @param {string} entry 一条条目（不含行首的 `- `）
 * @returns {string[]} 片段（至少一项；拼起来等于原文，只去掉残肢与两端空白）
 */
function splitParagraph(entry) {
  const text = String(entry ?? '')
  // ⚠️ **与判读侧同一个源**（`anchor.js`）：这里过去是**另一套**正则（反引号可选），
  //    而判读那套要求反引号 —— 于是"漏打反引号"的条目切开却每片都判成没章号，
  //    后文那半句照旧进注入（2026-10-02 三方评审 P3-2）。
  const anchors = [...text.matchAll(anchorRegex())]
  if (anchors.length < 2) return [text]

  const pieces = []
  let start = 0
  for (let i = 1; i < anchors.length; i += 1) {
    const cut = anchors[i].index
    pieces.push(text.slice(start, cut))
    start = cut
  }
  pieces.push(text.slice(start))
  return pieces
    .map((piece) => trimDanglingBrackets(piece).trim())
    .filter((piece) => piece !== '')
}

/**
 * 造一个单元，并**连带算好它的粗粒度形态**。
 *
 * 粗粒度是 {@link selectUnits} 降级阶梯的第二级（见那里的说明）：额度不够时，
 * 一个主体与其被整块丢掉，不如只留"他是谁 + 最近一条记载"。既然取舍时要用它
 * 的价格，价格就必须和形态一起在这里算出来——两处各算一遍正是"写两遍只测一遍"
 * 的形状。
 *
 * @param {string[]} lines 完整形态的行
 * @param {number} recency 最晚章号（0 = 没提章号）
 * @param {number} earliest 最早章号（0 = 没提章号）
 * @returns {{ lines: string[], cost: number, coarseLines: string[], coarseCost: number,
 *             recency: number, earliest: number }}
 */
function makeUnit(lines, recency, earliest) {
  const coarse = coarseLinesOf(lines)
  return {
    lines,
    cost: lines.join('\n').length + 1,
    coarseLines: coarse,
    coarseCost: coarse.join('\n').length + 1,
    recency,
    earliest,
  }
}

/**
 * 一个分组单元的**主体名**（`### 甲` 那一行里的甲）；**平铺单元回空串**。
 *
 * ⚠️ 判据要求行首真的是 `### ` —— 平铺单元的首行是 `- 条目`，绝不能把它整行当主体名
 *    （那会让名录化的"锚态"判定与在线折叠的集合查找张冠李戴）。
 * ⚠️ 只有这一处定义：在线折叠、名录化都走它。
 *
 * @param {{ lines?: string[] }} unit 单元
 * @returns {string} 主体名；不是分组单元时回空串
 */
function entityOfUnit(unit) {
  const head = String(unit?.lines?.[0] ?? '')
  if (head.startsWith('### ')) return head.slice(4).trim()
  // ⚠️ **薄主体压一行之后的形态**（`- 主体：条目`，见 `flattenThinUnits`）也必须认得 ——
  //    否则名录化的"锚态"判定与在线折叠的集合查找会对这些主体张冠李戴。
  return textSubjectOf(head.replace(/^- /, ''))
}

/**
 * **薄主体压一行**（**只在注入侧**）：名下只有一条记载的主体，不再单独出一个 `### 主体`
 * 表头，渲染成 `- 主体：条目`。
 *
 * 理由（实测《一世之尊》重建后）：「世界观」57 个主体里 **52 个只有一条**（`### 铁布衫`、
 * `### 藏经阁`、`### 暴雨梨花针` …）⇒ **光表头就 52 × ~7 = 364 字**，而内容一个字没多。
 * 这类主体的"全形态"与"粗形态"本来就一样（只有一条可给）⇒ 压成一行**零内容损失**。
 *
 * ⚠️ 只在注入侧做：回显（`renderExistingForFill`）必须给**文件里的真形状** —— 它教模型
 *    "这一节长什么样"，压过的形状会教坏下一批（3.1.19 的教训）。
 *
 * @param {Array<object>} units 单元
 * @returns {Array<object>} 压过的单元（新对象；入参不动）
 */
function flattenThinUnits(units) {
  return units.map((unit) => {
    const entity = entityOfUnit(unit)
    if (entity === '' || unit.lines.length !== 2) return unit
    const only = String(unit.lines[1] ?? '').replace(/^- /, '')
    if (only === '') return unit
    return makeUnit([`- ${entity}：${only}`], unit.recency, unit.earliest)
  })
}

/**
 * 「人物关系」在**注入侧**的两种压缩（读者 2026-10-06 拍板）：
 *
 * ① **一对人一条**：同一对人（`甲 ↔ 乙`，**与方向无关**）的多条并成一条。实测四份真机文件
 *    里同一对出现多次的有 3~7 对，而**违反的恰好是最重要的那一对**（`竹纤 ↔ 练霓裳` **5 条**）
 *    —— 方向反了：越重要越被拆碎。读者口径："一对人物的关系最好只有一条或两条。"
 * ② **一面之缘**：并完之后**只有一个章号锚**的关系 ⇒ 不单独占一条，收进节末一行清单
 *    （只留对名与章号）。读者："小人物与主人公一次偶遇…本身已经记在主人公的条目下了，
 *    不需要因为一次的关系而占用一条。" 实测这类占关系条目的 **17%~57%**。
 *
 * ⚠️ 判据是**并完之后**的锚数 —— 同一对见过两次就不算"一面之缘"（先合并、再判）。
 * ⚠️ 认不出双方的条目**不参与合并**（宁可不合，也不能把两条无关的关系拼在一起）。
 * ⚠️ **只在注入侧做**：文件里那几条原文一个字不动（读者要读、要改、要能查）。
 *
 * @param {Array<object>} units 「人物关系」的单元（每单元一行）
 * @param {number} maxItems 「一面之缘」清单最多列几对（超出的只报个数）
 * @returns {{ units: Array<object>, aside: string }} 压缩后的单元 + 节末清单
 */
function compactRelationsForPrompt(units, maxItems) {
  const order = []
  const byPair = new Map()
  for (const unit of units) {
    const text = String(unit.lines[0] ?? '').replace(/^- /, '')
    const head = textSubjectOf(text)
    const parties = head.split(/↔|×/).map((one) => one.trim()).filter((one) => one !== '')
    const key = parties.length === 0 ? `\u0000${text}` : parties.slice().sort().join('↔')
    if (!byPair.has(key)) {
      byPair.set(key, { head, bodies: [], anchors: [], recency: unit.recency, earliest: unit.earliest })
      order.push(key)
    }
    const bucket = byPair.get(key)
    bucket.bodies.push(parties.length === 0 ? text : text.slice(head.length).replace(/^[：:]\s*/, ''))
    for (const match of text.matchAll(anchorRegex())) bucket.anchors.push(match[0])
    bucket.recency = Math.max(bucket.recency, unit.recency)
    bucket.earliest = Math.min(bucket.earliest, unit.earliest)
  }

  const kept = []
  const oneOff = []
  for (const key of order) {
    const bucket = byPair.get(key)
    if (bucket.anchors.length <= 1) {
      const anchor = bucket.anchors[0] === undefined ? '' : ` ${bucket.anchors[0]}`
      oneOff.push(`${bucket.head === '' ? bucket.bodies.join('；').slice(0, 24) : bucket.head}${anchor}`)
      continue
    }
    // ⚠️ 句末标点要归一：每条都自带结尾（多半是 `。`），直接 `；` 拼会产出 `。；` ✗。
    const body = bucket.bodies.map((one) => one.replace(/[。；;]\s*$/, '')).join('；')
    kept.push(makeUnit([`- ${bucket.head}：${body}。`], bucket.recency, bucket.earliest))
  }

  const shown = oneOff.slice(0, maxItems)
  const extra = oneOff.length - shown.length
  const aside = oneOff.length === 0
    ? ''
    : `\n（一面之缘 ${oneOff.length}：${shown.join(' / ')}${extra > 0 ? ` …另 ${extra}` : ''}）`
  return { units: kept, aside }
}

/**
 * 把"锚态"主体的名字渲染成**一行名录**（注入用）。
 *
 * ⚠️ 这行**不是** `### 主体` 块：它是一行说明性的列举，落在节末。理由是它必须**绕过
 *    `selectUnits`** —— 名录的 recency 是最旧的，当普通单元会被**第一个丢掉**，
 *    那正好把它的作用抵消掉（它是"让 AI 至少知道有这么个人"，不是可裁的细节）。
 *
 * @param {string[]} names 主体名（已按最近被提及降序）
 * @param {number} maxNames 最多列几个名字（超出的只报个数）
 * @returns {string} 行首带 `\n` 的独立段落；没有名字时回空串
 */
function renderRoster(names, maxNames) {
  const all = Array.isArray(names) ? names : []
  if (all.length === 0) return ''
  const shown = all.slice(0, maxNames)
  const extra = all.length - shown.length
  // ⚠️ 记号形态与 {@link BACKGROUND_LEGEND} 的 `（出窗 N）` **逐字对应** —— 两处一起改。
  return `\n（出窗 ${all.length}：${shown.join(' / ')}${extra > 0 ? ` …另 ${extra}` : ''}）`
}

/**
 * 一个单元的**粗粒度**形态：主体行 + 它名下**章号最晚的那一条**。
 *
 * - 分组单元（`### 主体` + `- 条目`）：留下头一行与最新的一条，中间那些更早的
 *   记载不展开。信息没有丢——它还在 `background.md` 里，只是这一轮不投喂。
 * - 散条目本来就只有一行（`lines.length === 1`），返回原样：它没有可压缩的余地，
 *   于是 `coarseCost === cost`，降级那一级自然跳过它，仍按"丢弃"处理。
 *
 * ⚠️ 平手时取**靠后**的那条（`>=`）。文件里的顺序是写入顺序，也就大致是时间顺序，
 * 所以平手取靠后的那条更接近"最近"。这是近似的说法，不是保证。
 *
 * @param {string[]} lines 完整形态的行
 * @returns {string[]} 粗粒度形态的行
 */
function coarseLinesOf(lines) {
  if (!Array.isArray(lines) || lines.length <= 1) return lines ?? []
  let best = 1
  let bestChapter = -1
  for (let index = 1; index < lines.length; index += 1) {
    const chapter = maxChapterIn([lines[index]])
    if (chapter >= bestChapter) {
      bestChapter = chapter
      best = index
    }
  }
  return [lines[0], lines[best]]
}


/**
 * 在给定预算内挑出要保留的单元。
 *
 * **保留判据是"近期优先"**（该单元提到过的最大章号），而不是文件顺序：读者
 * 此刻在读第 40 章，"第 38 章登场的那个配角"比"第 3 章的路人"有用得多。
 *
 * 代价要如实说：这会随进度改变保留集合，进而让这一段不再是逐字节稳定的前缀。
 * 所以本函数应当**很少被触发**——真正的解法是把文件本身压缩到预算以内
 * （见 `compact.js`），这里只是用户还没压缩时的安全网。
 *
 * ## 降级阶梯（v1.25 加了一级）
 *
 * 预算不够时按顺序降级，**每一步都比下一步轻**：
 *
 *   1. **粗粒度**（新增）：装不下的单元改为"主体 + 最近一条记载"，仍占位。
 *   2. **丢弃**：粗粒度也装不下，才整块不要（旧行为，附「另有 N 项未展示」）。
 *
 * 这一级是**纯加法**，这是它最重要的性质：`kept` 的算法一个字符都没改，粗粒度
 * 只在**本来会被丢掉**的单元里补位。于是
 *   - 预算充足时**输出逐字节不变**（没有单元被跳过，就没有单元被粗化）；
 *   - 预算紧张时，每个原本能显示的单元仍然原样显示，只是**多**了一批原本会消失的
 *     主体——他们现在至少露个头。信息论上严格更好。
 *
 * ⚠️ 第三级（3.0 ③c）：**置换** —— v1.25 曾拒绝（"别动已显示的内容"）；3.0 后锚有了
 * 语义（人物状态 / 在线折叠都拿它当认识的骨架），主体**整块消失**的代价比降级高 ⇒
 * 决策反转：降"最旧的完整单元"换"被丢主体的锚"，**只在交换严格更优（多救回主体）时
 * 执行**；`dropped` 由此清零（每个主体至少露一个锚）。
 *
 * @param {Array<{ cost: number, coarseCost: number, recency: number }>} units 单元
 * @param {number} allowance 允许的字符数
 * @param {object} [options]
 * @param {boolean} [options.coarseDegrade] 是否启用粗粒度这一级（默认启用）
 * @returns {{ kept: number[], coarse: number[], dropped: number }}
 */
function selectUnits(units, allowance, options = {}) {
  const costs = units.map((unit) => unit.cost)
  const total = costs.reduce((sum, cost) => sum + cost, 0)
  if (total <= allowance) return { kept: units.map((_, index) => index), coarse: [], dropped: 0 }

  const byRecency = units
    .map((_, index) => index)
    .sort((a, b) => units[b].recency - units[a].recency || a - b)

  const kept = []
  const skipped = []
  let used = 0
  for (const index of byRecency) {
    if (used + costs[index] > allowance) {
      skipped.push(index)
      continue
    }
    kept.push(index)
    used += costs[index]
  }

  // ---- 第二级：粗粒度补位（只处理上面被跳过的那些，仍是近期优先） ----
  const coarse = []
  if (options.coarseDegrade !== false) {
    for (const index of skipped) {
      const cost = units[index].coarseCost
      // 本来就只有一行 → 粗化省不下任何东西，留给"丢弃"，别造出个假降级。
      if (!(cost < costs[index])) continue
      if (used + cost > allowance) continue
      coarse.push(index)
      used += cost
    }
  }

  // ---- 第三级（3.0 ③c）：**置换** —— 丢"最旧的完整单元"换"被丢主体的锚" ----
  //
  // v1.25 曾拒绝过置换（"别动已显示的内容"）。3.0 之后理由变了：锚有了语义
  // （人物状态在线折叠都在用它当"认识的骨架"），一个主体被**整块丢掉**的代价
  // 是"AI 不知道他存在" ✗ —— 比把它降级严重得多。所以只在**交换严格更优**时置换：
  //   · 降级"最旧的完整单元"，用腾出的空间把**被丢主体的锚**按近期优先装回来；
  //   · 只在确实**多救回了主体**时才执行（救不回就不动，保持旧行为）；
  //   · 被降级的旧单元自己也变成锚（它还在，只是不再展开）。
  // 结果：`dropped` 归零（置换只在能把 dropped 清成 0 的点上执行）。
  if (options.coarseDegrade !== false && skipped.length > 0 && coarse.length < skipped.length) {
    const byOldest = [...kept].sort((a, b) => units[a].recency - units[b].recency)
    let room = allowance - used
    // ⚠️ **必须排除第二级已经粗化过的下标**（2026-10-04 体检发现，已复现）：
    //    `skipped` 是"第一级没装下的**全部**"，而第二级已经从里面挑了一部分放进 `coarse`
    //    —— 直接拷 `skipped` 会让那些下标**再被救回一次** ⇒ `coarse` 出现重复
    //    ⇒ 同一主体**渲染两遍**（白烧注入预算），而 `dropped`（`units.length - kept - coarse`）
    //    把重复那部分算成"已展示" ⇒ **少报**，连"本节另有 N 条未展示"都可能整句不出现。
    //    实测（体检脚本，6000 组随机）：579 组出现重复主体，其中 43 组同时"主体被静默丢掉
    //    但 dropped=0"。
    const alreadyCoarse = new Set(coarse)
    const waiting = skipped.filter((index) => !alreadyCoarse.has(index))
    for (const victim of byOldest) {
      if (waiting.length === 0) break
      const freed = costs[victim] - units[victim].coarseCost
      if (freed <= 0) continue
      let space = room + freed
      const rescued = []
      const stillWaiting = []
      for (const index of waiting) {
        const cost = units[index].coarseCost
        if (cost <= space) {
          rescued.push(index)
          space -= cost
        } else {
          stillWaiting.push(index)
        }
      }
      if (rescued.length === 0) continue
      kept.splice(kept.indexOf(victim), 1)
      coarse.push(victim, ...rescued)
      waiting.length = 0
      waiting.push(...stillWaiting)
      room = space
    }
    // ⚠️ 这里从前还有一句 `if (waiting.length === 0) skipped.length = 0` —— **死代码**
    //    （`skipped` 之后没人读；`dropped` 是由 `units.length - kept - coarse` 现算的），
    //    2026-10-04 体检顺手删掉：它看起来像在维护某个不变量，实际什么都不影响。
  }

  kept.sort((a, b) => a - b)
  coarse.sort((a, b) => a - b)
  return { kept, coarse, dropped: units.length - kept.length - coarse.length }
}

/**
 * 按权重把可用预算分给各节：第一趟**统一保底**（与权重无关），第二趟**按权重注水**，
 * 收尾把零头按分区顺序补齐。
 *
 * ## 为什么单独提出来（2026-10-02 批 4 / #16）
 *
 * 这段逻辑从前长在 `renderBackgroundForPrompt` 里，而"权重真的被执行了"这条断言
 * 只能靠**给渲染函数开一个 `options.weights` 参数**来写 —— 那段 docblock 自己
 * 写着"**这是给测试留的接缝**"。测试的需要不该改生产函数的形状：多出来的参数
 * 在生产里没有任何调用方，却成了一个"谁都能塞一套权重进来"的口子。
 * 现在它是一个纯函数：测试直接打它（想塞什么权重塞什么），渲染函数只用官方那份。
 *
 * @param {Array<{name: string, wanted: number}>} sections 各节（`wanted` = 它想占多少字）
 * @param {number} available 可分配的预算（已扣掉标题与提示）
 * @param {number} budget 总预算（算保底用）
 * @param {Readonly<Record<string, number>>} [weights] 权重表，默认官方那一份
 * @returns {number[]} 每节的额度（下标与 `sections` 对齐）
 */
export function allocateSections(sections, available, budget, weights = BACKGROUND_SECTION_WEIGHTS) {
  const weightOf = (name) => {
    const value = weights[name]
    return typeof value === 'number' && value > 0 ? value : 0
  }

  const allowance = sections.map(() => 0)
  let remaining = available

  // 第一趟：统一保底。刻意**不含权重** —— 见 `SECTION_FLOOR_RATIO` 的说明
  // （"按权重给保底"试过，被统一比例封顶后每节一模一样，权重又成摆设）。
  const floor = sections.length === 0
    ? 0
    : Math.min(available / sections.length, Math.max(60, budget * SECTION_FLOOR_RATIO))
  sections.forEach((section, index) => {
    const give = Math.min(section.wanted, floor, remaining)
    allowance[index] = give
    remaining -= give
  })

  // 第二趟：按权重注水。轮数上界 `sections.length + 1` 足够——每轮至少喂饱一节，
  // 或者因为取整一分钱都分不出去而提前收工。
  for (let round = 0; round < sections.length + 1 && remaining > 0; round += 1) {
    const hungry = sections
      .map((section, index) => ({ section, index }))
      .filter(({ section, index }) => section.wanted > allowance[index])
    if (hungry.length === 0) break

    const weightSum = hungry.reduce((sum, { section }) => sum + weightOf(section.name), 0)
    // 全都没有权重时退化成都分，避免除零。
    const divisor = weightSum > 0 ? weightSum : hungry.length

    let given = 0
    for (const { section, index } of hungry) {
      const weight = weightSum > 0 ? weightOf(section.name) : 1
      const want = Math.floor((remaining * weight) / divisor)
      const give = Math.min(section.wanted - allowance[index], want)
      if (give > 0) {
        allowance[index] += give
        given += give
      }
    }
    if (given === 0) break // 取整僵局，交给收尾
    remaining -= given
  }

  // 收尾：按分区顺序把剩下的（通常只有几个字符）给还饿着的节。
  sections.forEach((section, index) => {
    if (remaining <= 0) return
    const give = Math.min(section.wanted - allowance[index], remaining)
    allowance[index] += give
    remaining -= give
  })

  return allowance
}

/**
 * 把认识渲染成给模型看的一段（应用预算与转义）。
 *
 * ## 预算不够时会发生什么（v1.10 重写）
 *
 * 旧版是**整节丢弃**：某一节放不下就跳过它，最后附一句"未提供：人物关系"。
 * 那有两个问题——一是信息损失以"节"为单位，粒度太粗；二是那句"未提供"
 * 读起来像在说"这本书没有人物关系"。
 *
 * 现在是**三级降级**，且每一步都说清丢了多少：
 *   1. 先按权重给每节分配预算，每节还有保底（见 `SECTION_FLOOR_RATIO`）；
 *   2. 某一节仍放不下时，**先把装不下的单元降为粗粒度**（主体 + 最近一条记载，
 *      见 {@link selectUnits}）——这一级是 v1.25 加的，它只补位、不替换，所以
 *      预算充足时输出与加它之前**逐字节相同**；
 *   3. 粗粒度也装不下，才按"近期优先"丢单元，并写明「另有 N 位人物未展示」。
 *
 * @param {object} doc 结果
 * @param {object} [options]
 * @param {number} [options.budgetChars] 预算
 * @param {number} [options.progressIndex] 当前章（0 起），用于提示缺口
 * @param {number} [options.maxChapter] 倒退过滤的上界（1 起章号）。给值时，
 *   **最早章号都大于它**的单元被丢弃；没带章号的条目一律保留。只在读者跳到
 *   了水位线之前时由调用方传入——见下方 `filtered` 与 `collectReadWindow`。
 * @param {boolean} [options.coarseDegrade] 粗粒度那一级是否启用（默认启用）。
 *   设 `false` 即回到 v1.24 的两级降级——这是留给"我不接受这个取舍"的退路，
 *   也是差分断言的抓手。**它是真的生产选项**（`index.js` 的 `backgroundCoarseDegrade`
 *   一路传下来），不是测试接缝。
 * @returns {{ text: string, used: number, omitted: string[], trimmed: Array<object>,
 *             coarsened: Array<{ name: string, coarsened: number, total: number }>,
 *             allowances: Record<string, number>,
 *             filtered: Array<{ name: string, dropped: number }> }}
 */
export function renderBackgroundForPrompt(doc, options = {}) {
  const budget = Number.isInteger(options.budgetChars) && options.budgetChars > 0 ? options.budgetChars : 9000
  const covered = doc?.covered ?? null
  const progressIndex = options.progressIndex
  // 倒退过滤的上界。只在调用方判定"读者跳到了水位线之前"时才给（见
  // `collectReadWindow`）——常开会让这一段随进度变化，破坏逐字节稳定的前缀。
  const maxChapter = Number.isInteger(options.maxChapter) && options.maxChapter >= 1
    ? options.maxChapter
    : null
  // 降级阶梯的第二级（粗粒度）默认**开**：它只在预算不够时补位，预算充足时
  // 输出逐字节不变，所以"默认开"不会改变任何宽裕场景。见 {@link selectUnits}。
  const coarseDegrade = options.coarseDegrade !== false

  const head = covered === null
    ? '## 你对这本书的背景认识\n\n（还没有建立。你只看到了下面提供的正文。）'
    // ⚠️ 图例**计入 `used`**（下面 `let used = head.length`）—— 它是注入的一部分，
    //    不能像从前那些逐节说明一样"在额度之外"追加（见 `BACKGROUND_LEGEND`）。
    : `## 你对这本书的背景认识\n\n> 覆盖：第 ${covered.first}–${covered.last} 章。\n${BACKGROUND_LEGEND}`
  const lines = [head]
  let used = head.length

  // 缺口提示：这是防剧透在这一层的守门人——让模型知道自己"哪一段是空白"，
  // 而不是拿记忆去糊。
  //
  // ⚠️ **两个方向只留一个在这里**（2026-09-27 去重）：
  //   - **前向（记忆落后）**的那句"第 X–Y 章尚未纳入 / 不要下判断"**由「当前情况」那段说**
  //     （`renderSituation`）—— 那是记录在案的意图：「缺口必须明说，而且只有动态区能说」。
  //     这里从前也写一遍，同一轮 prompt 里就有两句同义的话 ✗，已删，**别再加回来**。
  //   - **后向（读者跳回水位线之前）**必须留在这里：它说的是"**这份材料本身已被过滤**"，
  //     只有紧挨着材料的这一句才说得清楚。
  //
  // ⚠️ 两个方向的**章号基准不同**，这里最容易写错：
  //   - 前向用 `progressIndex`（0 起）。它同时是"前一章的 1 起章号"，所以
  //     `covered.last + 1 .. progressIndex` 正好是"前文里还没记下的部分"。
  //   - 后向要说的是"读者**正在读**第几章"，那是 `progressIndex + 1`。用错
  //     一个数就会把**当前章**的条目当成剧透丢掉，而当前章本来整章都要投喂。
  // 倒退（读者跳回了水位线之前）判定 + 如实说明。**这一段被三处共用**（下面那句提示、
  // 「人物状态」整节的取舍、结尾的 `filtered` 记账），所以只算一次。
  //
  // ⚠️ 章号基准：`covered.last` 是 **1 起**章号，`progressIndex` 是 **0 起**索引。
  //    读者"正在读"的那一章是 `progressIndex + 1`。
  const readingChapter = Number.isInteger(progressIndex) ? progressIndex + 1 : null
  const backward = readingChapter !== null && covered !== null && covered.last > readingChapter
  const hasStateSection = Object.keys(doc?.groups?.[BACKGROUND_STATE_SECTION] ?? {}).length > 0
    || (doc?.sections?.[BACKGROUND_STATE_SECTION] ?? []).length > 0
  const filtered = []
  if (backward) {
    // 旧实现只在"落后"方向发警告，于是这一情形**完全静默**——第 900 章的条目会被原样
    // 注入给正在读第 50 章的人。
    //
    // ⚠️ 措辞必须**如实**（2026-10-02 三方评审 P1-2）：原来的"第 N 章及以后的条目已被过滤"
    //    是在「人物状态」**整节照样注入**的前提下写的 —— 同一段文本里一边这么说、
    //    一边印第 999 章的现状，模型会据此认为边界已生效（**假声明比漏更坏**）。
    //
    // ⚠️ **已知的一处保留**：「文本类型」不参与倒退过滤（它按设计永远整条在场 —— 见
    //    `BACKGROUND_TYPE_SECTION`：那是"全书简介 / 这本书该怎么读"的元判断，不是按章的条目）。
    //    它一般不含章号，但若写成"后期转入无限流"这类结构话，仍会随注入。要不要在倒退时
    //    也丢掉它，留给读者拍板（本轮不动：丢掉它会让"怎么读这本书"整块消失）。
    const note = `\n> ⚠️ 这份背景认识覆盖到第 ${covered.last} 章，而你正在读第 ${readingChapter} 章。`
      + `第 ${readingChapter + 1} 章及以后的条目**已被过滤**`
      + (hasStateSection
        // 这一节是"现在进行时"快照 —— 倒退时逐行按锚判，见下面对它的处理。
        // ⚠️ 说法必须与那个处理**逐字对得上**：这里说"只留已读的那几行"，那里就只留已读的。
        ? `，写"现在进行时"的「${BACKGROUND_STATE_SECTION}」只留第 ${readingChapter} 章及以前记下的那几行`
        : '')
      + '；不要提及、推测或暗示它们。'
    lines.push(note)
    used += note.length
  }

  // ---- 「在线折叠」（3.0 ②c，读者 2026-10-02：前 50 章的配角离场了，不该一直占注入）----
  //
  // 活跃窗口（`archiveWindowChapters`）只**向前**看：读第 100 章时 keepFrom = 100-120+1 ≤ 0
  // ⇒ 全书都在窗口内 ⇒ 离场配角的全卡条目一直占着注入 ✗（读者实测到了）。
  //
  // 这里的判据换**人物自己的最后提及**：当前章 − 他最后被提到的章 ≥ `personOfflineChapters`
  // ⇒ 注入时**折叠成锚**（只留最新的一条 = "我最后一次见他时的样子"），他的状态行也不注入
  // （一句过期的"他要去闯荡江湖"摆在面前，比没有更糟）。
  //
  // ⚠️ **只动注入这张视图，不动文件**：他回来时（新条目出现 ⇒ lastSeen 更新）自动展开；
  //    这正是 ③c"注入 = 代码算出来的视图"的第一块落地。
  // ⚠️ `personOfflineChapters: 0` = 关闭；`progressIndex` 没给 = 不折叠（兜底安全）。
  const offlineAfter = Number.isInteger(options.personOfflineChapters) && options.personOfflineChapters > 0
    ? options.personOfflineChapters
    : null
  const foldedSubjects = new Set()
  if (offlineAfter !== null && Number.isInteger(progressIndex)) {
    const currentChapter = progressIndex + 1
    for (const [entity, entries] of Object.entries(doc?.groups?.['人物'] ?? {})) {
      if (!Array.isArray(entries) || entries.length === 0) continue
      const lastSeen = Math.max(...entries.map((entry) => maxChapterIn([entry])))
      if (lastSeen > 0 && currentChapter - lastSeen >= offlineAfter) foldedSubjects.add(entity)
    }
  }

  // ---- 「名录化」（2026-10-06 读者拍板）：锚态主体在注入里**只留一个名字** ----
  //
  // 病根：出了活跃窗口的主体由 `planArchive` 留一条"身份锚"（`### 甲` + 一行，~45 字）。
  //   那是为了"AI 不会一个人都不认识"，但它的代价是**单调下限**：锚只增不减
  //   （压缩的「保主体」不许丢主体、归档规则本身就是留锚）⇒ 实测《一世之尊》
  //   0.33 张/章 ⇒ 全 1428 章约 476 张卡 ⇒ 锚占 ~21,420 字（注入预算 9000）。
  //
  // ⭐ **而现在的注入在超预算时走"广度优先"**：`selectUnits` 的第三级置换会
  //   *丢最旧的完整单元、换被丢主体的锚*（设计原话"一个主体被整块丢掉比降级严重得多"）
  //   ⇒ 稳态下它本来就在做花名册，代价是**把最近的主体也降级成一行**。
  //   名录化把"露一头"的单价从 45 字降到 ~3 字 ⇒ **置换不再被触发** ⇒
  //   省下的预算回流给**活跃主体**的细节。
  //
  // ⚠️ 判据**只由 `subjectOutOfWindow` 给**（与 `planArchive` 同源）——
  //   **活跃主体一个都不动**（窗口内有条目 ⇒ 照旧 `### 甲` + 全部条目）。
  // ⚠️ 名录**不进 `selectUnits`**：它的 recency 是最旧的，当普通单元会被**第一个丢掉**。
  //   它是**固定成本**（计入 `wanted`）而不是可选单元。
  // ⚠️ 默认关闭（不给 `options.archiveWindowChapters` 时行为与从前**逐字相同**）。
  const archiveWindow = Number.isInteger(options.archiveWindowChapters) && options.archiveWindowChapters > 0
    ? options.archiveWindowChapters
    : null
  const rosterKeepFrom = archiveWindow !== null && Number.isInteger(progressIndex)
    ? (progressIndex + 1) - archiveWindow + 1
    : null
  const rosterMaxNames = Number.isInteger(options.rosterMaxNames) && options.rosterMaxNames > 0
    ? options.rosterMaxNames
    : HOST_DEFAULTS.rosterMaxNames

  // ---- 元判断：「文本类型」永远**整条**在场（不参与权重与保底）----
  //
  // 它给后面几节定调（这本书是感情线武侠 / 无限流 / 单元散文…，各类条目该往哪边写）。
  // 按权重分的话它只是"一小节内容"：先拿保底、再被裁，**恰好把最关键那句裁掉** ✗。
  // 所以让它**先占位**：整条带上，长度从预算里先扣（通常几十到两百字符）。
  const metaUnits = sectionUnits(doc, BACKGROUND_TYPE_SECTION)
  if (metaUnits.length > 0) {
    const metaBody = metaUnits.flatMap((unit) => unit.lines).join('\n')
    const metaHeader = `\n### ${BACKGROUND_TYPE_SECTION}\n\n`
    lines.push(metaHeader, metaBody)
    used += metaHeader.length + metaBody.length
  }

  // ---- 「人物状态」同样**整条在场**（3.0 ②）—— 但**离场的人不注入状态行** ----
  //
  // 它是"在场的每一个人"的一句现状：这句就是模型判断"我现在该用什么立场聊这个人"的
  // 依据。**离场的人**（在线折叠的那批）的状态行不注入 —— 他已经不在线，一句过期的现状
  // 反而误导。文件里照旧保留（一个字都不改文件），他回来时会由补齐重新写状态。
  // ⚠️ 正常形态是分组（`### 甲` + 一行）。
  //
  // ⚠️ **倒退时按锚逐行判**（2026-10-02 三方评审 P1-2(a)）：这一节的语义是"**此刻**的现状"，
  //    也就是**读到最远处**的快照。读者跳回第 20 章时它整节都在讲第 999 章的事，而"无章号
  //    ⇒ 通用描述"这条别的节适用的规则在这里**不适用**（状态行常常没章号，放行就等于漏），
  //    所以这里单独一层判据 —— 见下面那段。
  //
  // ⚠️ 这里从前还有一份 `rawStateLines`（同样的两段收集、同样的 `length === 0` 兜底），
  //    而它**一个消费者都没有** —— 同一件事的第二个定义点，且它比下面那份多错一次
  //    （B7：有分组块时看不见散行）。2026-10-03 体检删除；要改"取哪些状态行"只改下面一处。
  // ⚠️ **倒退时按锚逐行判**（2026-10-02 三方评审 P1-2(a)；读者拍板取**折中版**）：
  //      · 锚点在阅读范围内（`earliest <= readingChapter`）⇒ **留** —— 那确实是"读到这儿
  //        时的现状"（读者在第 20 章，第 3 章记下的"出身寒门"没有半点后文信息）；
  //      · 锚点在阅读范围之后 ⇒ **丢**（剧透）；
  //      · **没有章号 ⇒ 一律丢**：别的节里无章号条目算"通用描述"，而状态行的语义是
  //        "**此刻**"，没章号就无法核验它说的是哪一刻 —— 这一层正是"整节不注入"当初的
  //        理由，折中版把它保留在这里，而不连已读的那几行一起丢掉（否则"人物再出场 ⇒
  //        状态行跟着回来"这条折叠特性会在倒退时静默失效）。
  //
  // ⚠️ **人名必须跟着走**（批 2 侦察新发现，评审 13 条里没有）：文件里是 `### 甲` + 一行，
  //    而这里过去只把"行"抽出来 ⇒ 注入进提示词的是**一串没有主人的「现状」**（实测：
  //    `### 人物状态` 下面两行裸句），模型无从知道哪句是谁的 —— 而这一节的全部价值
  //    恰恰是"**这个人**此刻在哪 / 站在哪边"。所以按块渲染（与「人物」同一个形状，
  //    也与补齐侧 `renderExistingForFill` 一致：那边一直带着 `### 甲`）。
  //
  // ⚠️ **C 把状态并进「人物」行 ⇒ 必须知道"C 会折进谁"**（2026-10-05 补，守卫逼出来的）：
  //    不能假设"每个状态主体都有一张人物卡" —— 老文件里 `## 人物` 可能是空的、或全是
  //    平铺条目（C 的落点判据是 `entityOfUnit`），那时**没有行可以并** ⇒ 状态行若照旧
  //    "只算不渲染"，就会**无声消失** ✗（3.1.19 花一整版保的那批的另一种形态）。
  //    ⇒ 先算出 C 会折进谁；**折不进去的状态块照旧作为一节渲染**（见下面 `renderableBlocks`）。
  //    ⚠️ 与 C 的落点**同源**（都用 `sectionUnits(doc, '人物')` + `entityOfUnit`），
  //    别在调用点自己写一套"这个人有没有卡"。
  //    ⚠️ `viewCompaction: false`（压缩的尺子量**文件原样**）⇒ 一个都不折 ⇒ 整节照旧渲染。
  const viewCompaction = options.viewCompaction !== false
  const personRowEntities = new Set()
  if (viewCompaction) {
    for (const unit of sectionUnits(doc, '人物')) {
      const entity = entityOfUnit(unit)
      if (entity !== '') personRowEntities.add(entity)
    }
  }
  const rawStateBlocks = []
  for (const [entity, entries] of Object.entries(doc?.groups?.[BACKGROUND_STATE_SECTION] ?? {})) {
    if (foldedSubjects.has(entity)) continue
    if (Array.isArray(entries) && entries.length > 0) rawStateBlocks.push({ entity, entries })
  }
  // ⚠️ **散行不许因为"已经有分组块"就整批消失**（2026-10-03 体检）：真实文件在**切换形状
  //    的那一批**里两种形态**同时存在**（旧散行 + 新分组），而这里从前只在"一个分组块都
  //    没有"时才看散行 ⇒ 那些散行**一条都进不了提示词，也不报错**（文件里还在，不会丢，
  //    但 AI 看不见 —— 与"归档只扫 `groups` 就一条都搬不走"是同一个静默失效）。
  //    散行没有主体可数 ⇒ 照旧**不参与排序、也不截断**（硬按行数截会砍掉不同人的半截）。
  const flatState = doc?.sections?.[BACKGROUND_STATE_SECTION] ?? []
  if (flatState.length > 0) rawStateBlocks.push({ entity: null, entries: flatState })
  const rawStateCount = rawStateBlocks.reduce((sum, block) => sum + block.entries.length, 0)
  // ---- 「人物状态」只带**最近的几个主体**（2026-10-03 读者拍板）----
  //
  // 这一节服务的是**聊天时的陪读 AI**，它需要的只有一件事：**此刻在场的人站在哪边**。
  // 而"在场"最好的代理就是**状态行自己的章号** —— 那正是它上一次被更新的时刻。
  //
  // ⚠️ 这是**有意的覆盖面牺牲**（读者知情）：被截掉的人只剩「人物」里的**身份锚**
  //    （他最后在干嘛），拿不到一句现状 —— 那正是**冷归档之后本来就有的形状**
  //    （见 `sections.js` 的 `人物状态` 条目），不是新增损失。
  //    换来的是**注入预算有界**：≤ `backgroundStateMaxSubjects` × 30 字，不随书长。
  // ⚠️ 散行块（`entity: null`，手工编辑过的文件）**不参与排序、也不截断** ——
  //    它没有主体可数，硬按"行数"截会砍掉**不同人的半截**，比多花点预算糟得多。
  // ⚠️ 并列时用主体名兜底定序：`Array#sort` 在 V8 上稳定，但输入顺序来自
  //    `Object.entries(groups)`（文件里的书写顺序）⇒ 并列时"谁先写"决定谁被截掉，
  //    那不该由书写顺序决定。
  const maxStateSubjects = Number.isInteger(options.maxStateSubjects) && options.maxStateSubjects > 0
    ? options.maxStateSubjects
    : HOST_DEFAULTS.backgroundStateMaxSubjects
  const flatStateBlocks = rawStateBlocks.filter((block) => block.entity === null)
  const rankedStateBlocks = rawStateBlocks
    .filter((block) => block.entity !== null)
    .map((block) => ({ block, lastSeen: maxChapterIn(block.entries) }))
    .sort((a, b) => (b.lastSeen - a.lastSeen) || a.block.entity.localeCompare(b.block.entity))
    .slice(0, maxStateSubjects)
    .map((item) => item.block)
  const cappedStateBlocks = [...rankedStateBlocks, ...flatStateBlocks]
  const stateCapped = rawStateBlocks.length - cappedStateBlocks.length
  const stateBlocks = []
  let blockedStateLines = 0
  for (const block of cappedStateBlocks) {
    const kept = []
    for (const entry of block.entries) {
      if (!backward) { kept.push(entry); continue }
      const earliest = minChapterIn([entry])
      if (earliest !== 0 && earliest <= readingChapter) kept.push(entry)
      else blockedStateLines += 1
    }
    if (kept.length > 0) stateBlocks.push({ entity: block.entity, entries: kept })
  }
  let stateLines = null
  if (stateBlocks.length > 0) {
    // ⚠️⚠️ **2026-10-05（C）：只留"C 折不进去"的那些块** ✗✗
    //
    // 有主体名的状态已经**并进「人物」索引行**了 ✓（`- 甲：<最新一条> · <此刻>`）——
    // 但下面三类**折不进任何一行** ✗，必须**原样渲染成一节**，否则它们会随"C 把状态节
    // 拿掉"一起**无声消失** ✗✗（正是 3.1.19 花一整版去保的那批）：
    //   ① **没有主体名的散行**（`- 甲还在山门` 这种说不清属于谁的行 ✓）—— 没有主人可并；
    //   ② **有名字、却没有「人物」行**可并的（老文件 `## 人物` 空着 / 全是平铺条目）；
    //   ③ **`viewCompaction: false`**（压缩的尺子要量**文件原样** ⇒ 这一节当然要在）。
    // ⚠️ 这一条是**守卫逼出来的**：`state-section.test.mjs` 四条用例当场变红 ✓
    //    （"散行一行都不许丢" / "活跃主体照旧" / "上限照旧" / "整条在场" ✓）。
    //    第一版把渲染**整个删掉**、只留"算一遍"⇒ 算出来的东西没人用，等于把这些行弄丢 ✗。
    const renderableBlocks = stateBlocks
      .filter((block) => block.entity === null || !personRowEntities.has(block.entity))
    const body = renderableBlocks
      .map((block) => (block.entity === null
        ? block.entries.join('\n')
        : [`### ${block.entity}`, ...block.entries.map((entry) => `- ${entry}`)].join('\n')))
      .join('\n')
    const stateHeader = `\n### ${BACKGROUND_STATE_SECTION}\n\n`
    // ⚠️ 只算**留下的那部分**（有主体名的已并进人物 ✓ 不再重复扣额度 ✓）。
    stateLines = renderableBlocks.length > 0 ? [stateHeader, body] : null
    if (stateLines !== null) used += stateHeader.length + body.length
    // ⚠️ **只算预算、先不插进 `lines`**（2026-10-04）：它的**位置**挪到整块的最后，
    //    但**额度口径一个字没动** —— 长度照旧在算权重**之前**就从预算里扣掉。
    //    真正 `lines.push` 的地方在加权各节渲染完之后（见下面那段说明）。
    // 「截了就要说」：还留下几行时按**逐条**口径报（`sentences`）。
    if (blockedStateLines > 0) {
      filtered.push({ name: BACKGROUND_STATE_SECTION, dropped: 0, sentences: blockedStateLines })
    }
    // ⚠️ **被上限截掉的主体也要报**（与别的过滤同一个口径：「截了就要说」）——
    //    否则"我以为 AI 看得到他现在站在哪边，其实被截了"没人看得见。
    //    ⚠️ 只在真的 >0 时推：`filtered` 的形状被若干条用例逐字比对，
    //    多一个恒为 0 的条目就会让它们全红（这一版就是这么红的）。
    if (stateCapped > 0) {
      filtered.push({ name: BACKGROUND_STATE_SECTION, dropped: stateCapped })
    }
  } else if (backward && rawStateCount > 0) {
    // 整节都没了：按**单元数**报（与扁平节口径一致 —— 一行状态就是一条）。
    filtered.push({ name: BACKGROUND_STATE_SECTION, dropped: rawStateCount })
  }

  const sections = []
  for (const name of BACKGROUND_INJECTED_SECTIONS) {
    const all = sectionUnits(doc, name)
    // ⚠️ **两级过滤都要在**：① `sectionUnits(…, maxChapter)` 是**句级**的（只对「人物」的
    //    段落式条目生效）；② 下面这一层是**单元级**的（扁平节与分组节都靠它）。
    //    第一版把 ② 换成了 ①，扁平节就整个不再过滤了 —— 六条倒退过滤的用例当场变红。
    const built = maxChapter === null ? all : sectionUnits(doc, name, maxChapter)
    // ⚠️ `let`：在线折叠（②c）会把这个数组换成"锚"版 —— `const` 会当场 500。
    let units = maxChapter === null
      ? built
      : built.filter((unit) => unit.earliest === 0 || unit.earliest <= maxChapter)
    const blocked = all.length - units.length
    // 「人物」的段落式条目是**按句**过滤的（见 `sectionUnits`）—— 被丢掉的句数也要报出来，
    // 否则"我在读第 20 章，可模型看到了第 50 章那半句"这种事没人看得见。
    const sentences = units.reduce((sum, unit) => sum + (unit.blockedPieces ?? 0), 0)
    // ⚠️ `sentences` 只在真的 >0 时出现 —— `filtered` 的形状被若干条用例逐字比对，
    //    多一个恒为 0 的字段就会让它们全红（这一版就是这么红的）。
    if (sentences > 0) filtered.push({ name, dropped: blocked, sentences })
    else if (blocked > 0) filtered.push({ name, dropped: blocked })
    if (units.length === 0) continue

    // ---- B1-B（2026-10-06）：只注入"给 AI 的单元" + **元剧透行过滤** ----
    //
    // ① **只给 `injectUnits` 列出的单元**：「时间与分线」同时装着"已经发生过什么"（安全）
    //    与"埋了什么还没收"（元剧透）⇒ 只给骨架（主线），支线结构与单元名不进上下文。
    // ② **行级挡元剧透标记**（见 `SPOILER_LINE_MARKS`）：实测四份真机文件里 3 份的主线里
    //    就写着 `【伏笔】` ⇒ 不是理论风险。
    // ⚠️ 顺序：先按单元筛，再按行筛 —— 反过来会把支线的行也算进报告（数字对不上）。
    const onlyUnits = BACKGROUND_INJECT_UNITS[name]
    let spoilerLines = 0
    if (Array.isArray(onlyUnits) || units.some((unit) => unit.lines.some(isSpoilerLine))) {
      units = units.flatMap((unit) => {
        if (Array.isArray(onlyUnits) && !onlyUnits.includes(entityOfUnit(unit))) return []
        const kept = unit.lines.filter((line, index) => index === 0 || !isSpoilerLine(line))
        spoilerLines += unit.lines.length - kept.length
        // 只剩表头 ⇒ 整个单元丢掉（一个空壳单元比没有更糟）
        if (kept.length <= 1) return []
        return [kept.length === unit.lines.length ? unit : makeUnit(kept, unit.recency, unit.earliest)]
      })
    }
    // 「截了就要说」：挡下的行数按 `sentences` 口径报（那本来就是"逐行挡下的行数"）。
    if (spoilerLines > 0) filtered.push({ name, dropped: 0, sentences: spoilerLines })
    if (units.length === 0) continue
    // ⚠️ **在线折叠的"折"**（3.0 ②c）：离场主体的整卡单元换成"锚"——
    //    `### 名字` + 他最新的一条。小小的单元让预算花在在线的人身上；
    //    他回来（新条目）时 fold 集合自动不含他 ⇒ 展开。
    if (foldedSubjects.size > 0 && name === '人物') {
      units = units.map((unit) => {
        const entity = entityOfUnit(unit)
        if (!foldedSubjects.has(entity) || unit.lines.length <= 2) return unit
        const newest = unit.lines[unit.lines.length - 1].replace(/^- /, '')
        return makeUnit([`### ${entity}`, `- ${newest}`], maxChapterIn([newest]), minChapterIn([newest]))
      })
    }
    // ⚠️ `viewCompaction: false` = **拿文件原样的粒度来量**（2026-10-06）。
    //    为什么要这个开关：`compact.js` 用本函数的 `used` 当"压缩有没有让注入变小"的尺子
    //    （`COMPACT_NO_SHRINK`），而下面两种压缩是**无损的视图压缩**（不反映文件内容多少）
    //    ⇒ 拿压缩后的视图当尺子，会让"文件确实瘦了"被判成"没缩小" ✗（真机上就是这么红的）。
    //    所以：**尺子量原样，触发与真实注入量用压缩后的视图**。
    //    ⚠️ 它在函数开头已经算过一次（「人物状态」的"折进谁"也要用它）——
    //    这里**不再重复声明**（同一作用域里 `const` 重复声明是语法错误）。

    // ---- C（2026-10-05）：**人物节降成"索引级"**（一人一行）+ 状态并入 ----
    //
    // 读者 2026-10-05 拍板：「人物和人物关系在上下文里还是太多了 …… 这两个条目互补而且同时
    // 注入，那么我们就可以**放粗一点，节省 token** …… 我们不追求 AI 记忆的过度完整，只要有
    // **整体性模糊认识**就行，它的主要工作是**专注给他的正文部分**」✓
    //
    // 于是注入里的人物变成**一人一行**：`- 甲：<最新一条> · <此刻的状态>` ✓
    //   · 取**最新一条**（不是全部历史）⇒ "他是谁 + 他最近在干什么" ✓ 够 AI 认出这个人 ✓；
    //   · **「人物状态」并进来**（读者：「人类读者不太需要这个条目，**这个是给 AI 看的**」✓）
    //     ⇒ 注入里**不再单独出 `## 人物状态`** ✓（文件里那一节照旧保留 —— 它是合并/取代
    //     机制要用的 ✗ 不能删 ✓）；
    //   · 细节由 AI **按需去读 `background.md`** ✓（2026-10-05 加的"想回忆前文时"那段 ✓）。
    // ⚠️ 实测收益（《神雕侠侣》）：人物 2,754 + 状态 244 → **~1,500 字**，注入 8,520 → ~5,600 ✓。
    // ⚠️ 与下面那两种压缩**同一个开关**（`viewCompaction`）：C 也是**视图压缩** ✓
    //    ⇒ `compact.js` 量"文件有没有变小"时必须看到**原样形状**（否则它会把"人物降成索引"
    //    当成"文件瘦了"，反过来又把真实压缩判成 `COMPACT_NO_SHRINK` ✗ —— 当场红过两条 ✓）。
    if (name === '人物' && options.viewCompaction !== false) {
      const stateOf = doc?.groups?.[BACKGROUND_STATE_SECTION] ?? {}
      units = units.map((unit) => {
        const entity = entityOfUnit(unit)
        if (entity === '') return unit
        const newest = String(unit.lines[unit.lines.length - 1] ?? '').replace(/^- /, '')
        // ⚠️ **离场的人不给状态后缀**（2026-10-05 补）：在线折叠的语义是"他已经不在线，
        //    一句过期的现状反而误导"（见上面那段）—— 而 C 把状态并进人物行之后，那条保证
        //    **必须在这里也成立** ✗：否则折叠就只剩一个记号、过期状态照旧跟着走
        //    （`background.test.mjs` 那三条折叠守卫当场变红 ✓）。
        const list = foldedSubjects.has(entity) ? [] : stateOf[entity]
        // 状态行自带章号（`- \`第20章\` 此刻在襄阳`）⇒ 只取正文，章号在索引行里已经有位置了。
        const last = Array.isArray(list) && list.length > 0 ? String(list[list.length - 1]) : ''
        const state = last.replace(/^- /, '').replace(/^`第[^`]*章`\s*/, '')
        const suffix = state === '' ? '' : ` · ${state}`
        return makeUnit([`- ${entity}：${newest}${suffix}`], unit.recency, unit.earliest)
      })
    }

    // ---- 注入侧的两种**粒度压缩**（2026-10-06，A 版；**文件与回显一个字都不动**）----
    //
    //  ① **薄主体压一行**：只有一条的 `### 主体` 不出表头（实测《一世之尊》世界观 57 个主体
    //     里 52 个只有一条 ⇒ 光表头 364 字）—— 零内容损失。
    //  ② **「人物关系」一对人一条 + 一面之缘**：见 `compactRelationsForPrompt`。
    // ⚠️ 只在注入侧：回显要给**文件里的真形状**（它教模型"这一节长什么样"，压过的形状会教坏
    //    下一批 —— 3.1.19 的教训）。
    if (viewCompaction && isGroupedSection(name)) units = flattenThinUnits(units)
    let asideText = ''
    if (viewCompaction && name === '人物关系') {
      const split = compactRelationsForPrompt(units, rosterMaxNames)
      units = split.units
      asideText = split.aside
    }
    // ⚠️ 两种压缩都会把 `units` 掏空（例：一个"全是薄主体"的世界观节、一个"全是
    //    一面之缘"的关系节）⇒ 空判据必须放在压缩**之后**，否则会把这一节整块丢掉。
    if (units.length === 0 && asideText === '') continue

    // ---- 名录化：锚态主体退出 `selectUnits`，改成节末一行名字（见上面那段）----
    //
    // ⚠️ 判据走 `subjectOutOfWindow`（与 `planArchive` **同源**）—— **活跃主体一个都不动**。
    //    这条是承重的：名录化只该作用于"文件里只剩一条锚"的人。
    let rosterNames = []
    if (rosterKeepFrom !== null && isGroupedSection(name)) {
      const groups = doc?.groups?.[name] ?? {}
      rosterNames = Object.keys(groups)
        .filter((entity) => subjectOutOfWindow(groups[entity], rosterKeepFrom))
        // 按**最近被提及**降序（最可能被问到的排前面）；并列时用名字兜底定序 ——
        // 书写顺序不该决定谁被 `rosterMaxNames` 截掉。
        .sort((a, b) => (maxChapterIn(groups[b]) - maxChapterIn(groups[a])) || a.localeCompare(b))
      if (rosterNames.length > 0) {
        const roster = new Set(rosterNames)
        units = units.filter((unit) => !roster.has(entityOfUnit(unit)))
      }
    }
    const rosterText = renderRoster(rosterNames, rosterMaxNames)

    // ⚠️ `wanted` 必须**含分区标题**。第一版把它漏在外面，而渲染时又从额度里
    // 扣了一次标题长度，于是每节都凭空少了十来个字符——预算充足时也会因为
    // "一条短条目 + 标题"刚好越界而整节被判超限，产出"未提供：人物关系、人物、
    // 世界观、前文脉络"这种自己打自己脸的输出。被三条测试同时抓出来。
    // ⚠️ 名录与「一面之缘」都计入 `wanted`：它们是**固定成本**（渲染时必然追加），
    //    不参与取舍 —— 漏掉就会让"额度够"的节在追加之后超出预算。
    const headerCost = `\n### ${name}\n\n`.length
    sections.push({
      name,
      units,
      headerCost,
      roster: rosterText,
      aside: asideText,
      wanted: headerCost + rosterText.length + asideText.length
        + units.reduce((sum, unit) => sum + unit.cost, 0),
    })
  }

  // ---- 分配 ----
  //
  // ⚠️ 这里曾经有一段**看起来**在按权重分配、实际完全没读权重表的代码：注释写着
  // "先按权重给每节分配预算"，实现却是 `available / sections.length`（均分），
  // `BACKGROUND_SECTION_WEIGHTS` 导出了、文档里引用了，但从来没被读过。
  //
  // 修的时候先试过"按权重给保底"，结果还是没用：保底被 `SECTION_FLOOR_RATIO`
  // 封顶，而所有权重都 ≥ 0.12，于是每节的保底都等于 `0.12 × 预算`——**一模一样**。
  // 权重换了个理由继续当摆设。
  //
  // 现在分成两件**互不干扰**的事：
  //
  //   1. **保底与权重无关**，它唯一的目的是"每节都要露头"。整节被丢掉的输出
  //      读起来像"这本书没有人物"（见 SECTION_FLOOR_RATIO 的说明）。
  //   2. **剩余预算按权重分**，用注水法：某节吃不下它应得的那份时，多出来的会在
  //      下一轮重新分给还饿着的节，所以预算不会因为"某节内容太少"而白白浪费。
  //
  // 分区顺序（`BACKGROUND_SECTIONS`）退居**收尾时的兜底**：只剩几个字符、按权重
  // 取整分不动时，优先给靠前的节。
  //
  // ⚠️ 分配逻辑在 `allocateSections` 里（#16：它从前长在这里，还带一个只给测试用的
  //    `options.weights`）。渲染函数**只用官方权重表那一份**，这里没有第二个口子。
  const allowance = allocateSections(sections, Math.max(0, budget - used), budget)

  // ---- 渲染：每节在自己的额度内挑单元 ----
  const omitted = []
  const trimmed = []
  const coarsened = []
  sections.forEach((section, index) => {
    // 额度已含标题，所以这里减去标题就是留给条目的空间。
    const room = Math.max(0, allowance[index] - section.headerCost)
    // ⚠️ **深度优先**（2026-10-06）：分组节**不再做粗化/置换**。从前它为了"多露几个名字"
    //    会把大卡也降级成一行（实测《一世之尊》**26/35** ✗）—— 既砍了细节，又让额度花不完
    //    （**13% 闲置** ✗：全压成一行之后，一节的"可渲染上限"塌到 `主体数 × 40 字`）。
    //    现在：保住的人给**全文**，装不下的**只进名录**（一行名字，3 字一个）⇒
    //    细节与预算都用在刀刃上。读者 2026-10-06 拍板："**可以取舍牺牲小配角**"。
    const deepFirst = isGroupedSection(section.name)
    const { kept, coarse, dropped } = selectUnits(section.units, room, {
      coarseDegrade: deepFirst ? false : coarseDegrade,
    })

    // ⚠️ **名录在，这一节就不能算"未提供"**（2026-10-06）：名录化之后，"整节都是锚态主体"
    //    的节里 `units` 会全被过滤掉 ⇒ `kept`/`coarse` 都空 ⇒ 从前那句 `omitted.push`
    //    会把这一节**连名录一起丢掉**，而名录正是它现在唯一的内容。
    if (kept.length === 0 && coarse.length === 0 && section.roster === '' && section.aside === '') {
      omitted.push(section.name)
      return
    }

    // 粗粒度单元与完整单元**混在一起按文件顺序输出**：读者看到的主体顺序必须与
    // `background.md` 一致，否则面板里那份和模型眼里那份对不上，排查时会怀疑人生。
    const coarseSet = new Set(coarse)
    const shown = [...kept, ...coarse].sort((a, b) => a - b)
    // 装不下的人**点名**（不是整块消失 —— 那会让 AI 不知道他存在）
    const shownSet = new Set(shown)
    const droppedNames = deepFirst
      ? section.units.map((unit, i) => (shownSet.has(i) ? '' : entityOfUnit(unit))).filter((n) => n !== '')
      : []

    const headerText = `\n### ${section.name}\n\n`
    let body = shown
      .map((unitIndex) => {
        const unit = section.units[unitIndex]
        return (coarseSet.has(unitIndex) ? unit.coarseLines : unit.lines).join('\n')
      })
      .join('\n')
    // ---- 名录（锚态主体）：节末一行名字 ----
    // ⚠️ 排在**各条说明之前**：它是内容（"有这么些人"），不是解释。
    if (section.roster !== '') body += section.roster
    // ---- 一面之缘（只见过一次的关系）：节末一行对名 + 章号 ----
    if (section.aside !== '') body += section.aside
    // ---- 降级记号：**一处图例 + 每节一个极短记号**（见 `BACKGROUND_LEGEND`）----
    //
    // ⚠️ 粗化（本节装不下 ⇒ 只给最近一条）、离场折叠、丢弃（整单元没投喂）在这里
    //    **合成一个数**：对模型来说它们是同一件事（"这里还有更早的，我没给你"），
    //    区别只对诊断有用 —— `coarsened` / `trimmed` 两个台账**照旧分开报**（面板要用）。
    // ⚠️ 记号**只出一个**（一节里两个 `（+N）` 会读成两件事）。
    const foldedHere = section.name === '人物' ? foldedSubjects.size : 0
    const hidden = coarse.length + foldedHere + dropped
    if (hidden > 0) {
      // ⚠️ 深度优先之后，"没进正文的人"只能靠**这一行名字**让 AI 知道他们存在 ✓
      //    （3 字一个，比给每人一条粗化记载便宜十倍 ✓）。
      // ⚠️ **名单有上限**（见 `UNEXPANDED_MAX_NAMES`）：超出的只报个数 ⇒ 这一行的成本被钉死 ✓
      const shownNames = droppedNames.slice(0, UNEXPANDED_MAX_NAMES)
      const more = droppedNames.length - shownNames.length + foldedHere + coarse.length
      body += droppedNames.length > 0
        ? `\n\n（未展开 ${droppedNames.length}：${shownNames.join(' / ')}${more > 0 ? ` …另 ${more}` : ''}）`
        : `\n\n（+${hidden}）`
    }
    if (coarse.length > 0) {
      coarsened.push({ name: section.name, coarsened: coarse.length, total: section.units.length })
    }
    if (dropped > 0) {
      trimmed.push({ name: section.name, shown: shown.length, total: section.units.length, dropped })
    }
    lines.push(headerText, body)
    used += headerText.length + body.length
  })

  // ---- 「人物状态」放在**整块的最后**（2026-10-04）----
  //
  // 依据：lorebook / World Info 的工程经验 ——「**越靠后的条目对输出影响越大**」，
  // 而「人物状态」是**最"此刻相关"**的一节（"这个人**现在**站在哪边"）。
  // 它从前排在「文本类型」后面（整块的第 2 节），离真正要用它的地方最远。
  //
  // ⚠️ **预算口径一个字没动**：它的长度照旧在算权重**之前**就从 `budget` 里扣掉
  //    （见上面那处 `used += …`）—— 改的只是它在输出里的**位置**，不是它拿多少额度。
  // ⚠️ 代价：注入文本的顺序变了 ⇒ prompt 缓存的稳定前缀**一次性失效**（只此一次，
  //    之后又稳定）。这也是为什么它值得单独一次改动、而不是搭在别的改动里顺手做。
  // ⚠️ **2026-10-05（C）：「人物状态」不再作为单独一节进注入** ✗
  //
  // 它从前放这里（整块最后）是因为 lorebook 的经验"越靠后影响越大"，而它是最"此刻相关"的 ✓。
  // 现在读者拍板把它**并进「人物」索引行**（"人类读者不太需要这个条目，**这个是给 AI 看的**" ✓）
  // ⇒ 它的内容在人物那一行里（`- 甲：<最新一条> · <此刻的状态>` ✓），位置反而**更贴近用到它的
  //   地方**（就在那个人名字后面 ✓）✓。
  // ⚠️ 文件里那一节**照旧保留**（合并/取代/`stateSubjects` 都靠它 ✗ 不能删 ✓）；
  //    `stateLines` 这一段计算也照旧跑（它算出的 `blockedStateLines`/`stateCapped` 还要报给面板 ✓）。
  // ⚠️ **不 push 的前提是"C 真的把状态折进人物行了"** —— 而那**不总成立**：
  //    `renderableBlocks`（见上）里那三类折不进去的块必须照旧渲染，否则它们无声消失 ✗。
  //    正常情况（每个状态主体都有 `###` 卡）`stateLines` 是 `null` ⇒ 行为与 C 完全一致 ✓。
  if (stateLines !== null) lines.push(...stateLines)

  if (omitted.length > 0) {
    lines.push(`\n（因篇幅限制，本次未提供：${omitted.join('、')}。需要时可以向读者询问。）`)
  }

  /**
   * 每节最终拿到的字符额度。
   *
   * 暴露它是因为**分配结果本身就是权重表的产物**，而"渲染出来的字符数"是个
   * 有损的代理指标：条目是按整条取舍的，一条 40 字符的差异会被量化噪声吃掉，
   * 于是"权重没生效"和"尺子不够细"看起来一模一样。
   *
   * @type {Record<string, number>}
   */
  const allowances = Object.fromEntries(
    sections.map((section, index) => [section.name, allowance[index]]),
  )

  /**
   * 因**过滤**被丢弃的单元数，按分区汇总。
   *
   * 暴露它是为了"过滤悄悄发生了"这件事必须看得见：读者跳到水位线之前时，
   * 面板要能说清"有 12 条超前的条目已被挡住"，否则他只会觉得"AI 突然变笨了"。
   *
   * ⚠️ **2026-10-05（3.1.19）注释更正**：这个数组里装的**不只有倒退过滤** ——
   * `人物状态` 那一节还会往里推**被主体上限截掉的**（`stateCapped`，见上面那段），
   * 以及"按锚逐行判"挡下的行（带 `sentences`）。所以读它的人**不能一律说成
   * "你跳到了水位线之前"**：那是三种原因共用一张表。`spoiler.js` 那边把整张表
   * 交给读窗口时也带着同一句提醒。
   *
   * @type {Array<{ name: string, dropped: number, sentences?: number }>}
   */
  return {
    text: escapePromptText(lines.join('\n')),
    used,
    omitted,
    trimmed,
    coarsened,
    // ⚠️ **在线折叠的台账**（2026-10-06 补）：折叠与粗化在**提示词里**合成了一个
    //    `（+N）` 记号（对模型是同一件事），但**读者侧不能合并** —— "N 位人物已离场"
    //    是能改变读者判断的信息（他以为人物卡被压缩器吃了）。所以台账照旧分开给。
    folded: foldedSubjects.size > 0
      ? [{ name: '人物', folded: foldedSubjects.size }]
      : [],
    allowances,
    filtered,
  }
}

/**
 * 背景认识是否已经"胖到该压缩了"。
 *
 * 判据放在这里而不是调用方，是为了让"多少算胖"只有一个定义：`renderBackgroundForPrompt`
 * 在**不设预算**时的用量，超过 `budget × threshold` 就算胖。
 *
 * ⚠️ 刻意不用"实际渲染结果的 used"来判：那个值本身取决于预算，用它判断会形成
 * 自我实现的循环（超预算 → 被截断 → 看起来不大 → 永远不触发压缩）。
 *
 * @param {object} doc 解析结果
 * @param {object} [options]
 * @param {number} [options.budgetChars] 预算
 * @param {number} [options.threshold] 触发比例（0–1）
 * @returns {{ over: boolean, fullChars: number, threshold: number }}
 */
export function needsCompaction(doc, options = {}) {
  const budget = Number.isInteger(options.budgetChars) && options.budgetChars > 0 ? options.budgetChars : 9000
  const rawThreshold = Number.isFinite(options.threshold) ? options.threshold : 0.85
  const threshold = Math.min(1, Math.max(0.1, rawThreshold))
  const full = renderBackgroundForPrompt(doc, { budgetChars: Number.MAX_SAFE_INTEGER })
  return { over: full.used > budget * threshold, fullChars: full.used, threshold: Math.round(budget * threshold) }
}


/**
 * 一条条目**是不是整条都落在活跃窗口之外** —— **全仓唯一的判据**。
 *
 * ⚠️ 这件事**只有这一处定义**：`planArchive` 的归档决定、身份锚的"锚态"判定、
 *    注入里的「名录化」、补齐回显的分级 —— 四处问的都是同一个问题。从前它是
 *    `planArchive` 里的一个**局部闭包** `isOld`，而 3.2 起注入渲染也要问它
 *    （"这个主体是不是只剩一条锚了"）⇒ 再写一遍就是本仓库反复栽的
 *    "同一概念两个定义点"（守卫见 `contract.test.mjs` 那条同族断言）。
 *
 * 判据用**最晚章号**（`maxChapterIn`）：一条里可能引到多个章号，只有**全都**早于窗口
 * 起点才算出去（`第12-15章` 取终点）。⚠️ **没有章号的条目一律不算出窗** ——
 * 判不了就不判（它们是通用设定，与进度无关）。
 *
 * @param {unknown} entry 条目原文
 * @param {number} keepFromChapter 活跃窗口起点（1 起）
 * @returns {boolean}
 */
export function isOutOfWindow(entry, keepFromChapter) {
  const latest = maxChapterIn([entry])
  return latest > 0 && latest < keepFromChapter
}

/**
 * 一个**主体**是不是"锚态"：他名下**所有**条目都出窗了
 * （= 文件里只剩 `planArchive` 给他留的那一条身份锚）。
 *
 * 用途：注入侧的「名录化」（锚态主体只渲染一行名字）与回显侧的分级。
 * ⚠️ 与 {@link isOutOfWindow} **同源**，别在调用点自己 `every(...)` 一遍。
 *
 * @param {unknown} entries 该主体名下的条目
 * @param {number} keepFromChapter 活跃窗口起点（1 起）
 * @returns {boolean} 空数组回 `false`（没有条目就无所谓"锚态"）
 */
export function subjectOutOfWindow(entries, keepFromChapter) {
  const all = Array.isArray(entries) ? entries : []
  return all.length > 0 && all.every((entry) => isOutOfWindow(entry, keepFromChapter))
}

/**
 * **冷归档的计划**：算出哪些条目**整条**落在活跃窗口之外（见 {@link BACKGROUND_ARCHIVE_SECTION}）。
 *
 * 判据用**最晚章号**（`maxChapterIn`）：一条里可能引到多个章号，只有**全都**早于窗口起点
 * 才算老。⚠️ **没有任何章号的条目永不归档** —— 它们是通用设定（`世界观`/`通用概念` 里常见），
 * 与进度无关，归档会把它们从模型视野里拿走 ✗。
 *
 * ⚠️ **「文风（只写一次）」豁免**：它是"这本书怎么写"的稳定特征，永远在场有用；
 * 而它的条目也带章号，会被"按章号归档"误伤。
 *
 * ⚠️ **身份锚的退役窗口**（2026-10-06 读者拍板 **M = 360 章**，`options.anchorMaxAgeChapters`）：
 *    3.0 给"整卡出窗"的主体留一条最新条目当"他是谁"的锚。它救了"AI 一个人都不认识"，
 *    但代价是**单调下限**——锚只增不减（压缩的「保主体」不许丢主体、归档规则本身就是留锚）
 *    ⇒ 「人物」一节的下限 = 立卡数 × ~45 字，**与书长无关、与读者读到第几章无关**。
 *    实测《一世之尊》：0.33 张/章 ⇒ 全 1428 章约 **476 张卡**，锚占 **~21,420 字**
 *    （注入预算 9000、压缩输出墙 12,603 字）⇒ 压缩撞墙、注入被挤成花名册。
 *    ⇒ 出窗超过 M 章的主体**连锚一起进冷档案**（原文不丢，只是 AI 看不到）。
 *    ⚠️ **默认关闭**（不给 `options` 时行为与从前逐字相同）—— 现有守卫与既有调用点不受影响。
 *    ⚠️ 判据是"**最后一次被提及**距今 ≥ M 章"，而"被提及"= **他自己名下有新条目**
 *       （别人条目里提到他不算 —— 那需要全库扫描，代价不成比例）。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {number} keepFromChapter 活跃窗口起点（1 起）；章号全部早于它的条目才归档
 * @param {object} [options]
 * @param {number} [options.readingChapter] 读者**正在读**的那一章（1 起）；不给 = 不退役
 * @param {number} [options.anchorMaxAgeChapters] 身份锚的退役窗口 M（章）；不给 = 不退役
 * @returns {{ total: number, items: Array<{ section: string, entity: string|null, entries: string[] }> }}
 */
export function planArchive(doc, keepFromChapter, options = {}) {
  const items = []
  if (!Number.isInteger(keepFromChapter) || keepFromChapter <= 1) return { total: 0, items }

  const isOld = (entry) => isOutOfWindow(entry, keepFromChapter)

  const anchorMaxAge = Number.isInteger(options?.anchorMaxAgeChapters) && options.anchorMaxAgeChapters > 0
    ? options.anchorMaxAgeChapters
    : null
  const readingChapter = Number.isInteger(options?.readingChapter) && options.readingChapter > 0
    ? options.readingChapter
    : null
  /** 这条锚是不是**过期**了（距最后一次被提及 ≥ M 章）。关掉时恒 `false`。 */
  const anchorExpired = (entry) => {
    if (anchorMaxAge === null || readingChapter === null) return false
    const latest = maxChapterIn([entry])
    return latest > 0 && readingChapter - latest >= anchorMaxAge
  }

  for (const section of BACKGROUND_INJECTED_SECTIONS) {
    if (BACKGROUND_ARCHIVE_EXEMPT_SECTIONS.includes(section)) continue
    // ⚠️ **按单元整体归档的分区走下面那一段**（2026-10-06 B1-B）：「时间与分线」进了注入族，
    //    但归档语义**不能跟着变** —— 注入族是"按主体逐条搬 + 留身份锚"，套到时间线上会把
    //    **主线**搬走（它是这一节存在的理由）✗。这里跳过，交给按单元那套。
    if (BACKGROUND_ARCHIVE_BY_UNIT_SECTIONS.includes(section)) continue
    if (isGroupedSection(section)) {
      for (const [entity, entries] of Object.entries(doc?.groups?.[section] ?? {})) {
        const all = Array.isArray(entries) ? entries : []
        let old = all.filter(isOld)
        // ⚠️ **身份锚**（3.0 第二刀）：若这个主体**所有**条目都出窗口了，给他留**最新的一条**。
        //    否则冷归档会把他从 AI 视野里**整块抹掉** —— 一个"第 1-30 章出场、之后再没被提到"的人，
        //    等到第 200 章有人提他名字时，模型对他**一无所知**（这是冷归档自己引入的新风险，
        //    不是旧问题的复现）。代价有界：主体数 × 约 40 字，换回"他是谁"。
        if (subjectOutOfWindow(all, keepFromChapter)) {
          const newest = old.reduce((best, entry) => (
            maxChapterIn([entry]) >= maxChapterIn([best]) ? entry : best
          ), old[0])
          // ⚠️ **锚也会退役**（M = 360 章，2026-10-06）：距最后一次被提及 ≥ M 章 ⇒
          //    不留锚、整卡进冷档案（原文不丢，只是 AI 看不到）。见 `planArchive` 的 JSDoc。
          if (!anchorExpired(newest)) old = old.filter((entry) => entry !== newest)
        }
        if (old.length > 0) items.push({ section, entity, entries: old })
        // ⚠️ **状态行跟人走**（3.0 ②）：这个主体的**所有**人物条目都出窗口 ⇒ 他的状态行
        //    也过期了（一句过期的"他现在正向北追查"摆在面前，比没有更糟）⇒ 一起归档；
        //    视野里只剩"身份锚"（最新的一条）。他没有状态行就没事。
        if (section === '人物' && subjectOutOfWindow(all, keepFromChapter)) {
          const state = doc?.groups?.[BACKGROUND_STATE_SECTION]?.[entity]
          if (Array.isArray(state) && state.length > 0) {
            items.push({ section: BACKGROUND_STATE_SECTION, entity, entries: state })
          }
        }
      }
    }
    // ⚠️ **无论分组与否，都要看 `sections[section]` 里的散条目** —— 现实里「人物关系」常常是
    //    扁平的（v2.19 的实测文件就是 54 条扁平条目）、「世界观」也常年扁平。
    //    ⚠️ 2026-10-03 更正：那不是"正常形态"，是**提示词教出来的**（格式块的两节示例当时就是
    //    平铺的，已修）；4/4 真实文件至今仍是散行 ⇒ 这条容错**必须留着**，否则老文件一条都归档不到。
    //    只扫 `groups` 的话这些**一条都归档不到，而且不会报错**（静默失效）。
    const looseAll = Array.isArray(doc?.sections?.[section]) ? doc.sections[section] : []
    let loose = looseAll.filter(isOld)
    // ⚠️ **散行也要有身份锚**（2026-10-03 体检）：分组形态在下面按**主体**留最新一条
    //    （"他是谁"）；散行没有主体可数，从前**一条都不留** ⇒ 一个"28 条平铺人物"的书
    //    （真实文件就是这样）越过活跃窗口之后，AI **一个人都不认识**（冷档案永不注入）。
    //    没有主体时能给出的最强保证就是**留最新的一条**（代价 = 1 条），它同时保证
    //    这一节**不会因为归档而整节变空**。
    if (loose.length > 0 && loose.length === looseAll.length) {
      const newest = loose.reduce((best, entry) => (
        maxChapterIn([entry]) >= maxChapterIn([best]) ? entry : best
      ), loose[0])
      loose = loose.filter((entry) => entry !== newest)
    }
    if (loose.length > 0) items.push({ section, entity: null, entries: loose })
  }

  // ---- 读者族的分组节也要有天花板（2026-10-03）----
  // ⚠️ 从前这个函数**只遍历注入族** ⇒ 「时间与分线」成了唯一既不注入、又不压缩、
  //    又不冷归档的节：只增不减、**无上限**（体检时发现）。它是读者要看的"骨架 + 支线"，
  //    所以给它加天花板时守住两条：
  //      · **主线**（骨架）永远保留 —— 它是这一节存在的理由；
  //      · **支线单元整条出窗口才搬**：单元是"一条支线的完整交代"，搬一半会让读者
  //        看到"这件事说了一半"（单元完整性 > 逐条最省）。
  for (const section of BACKGROUND_UNIT_ARCHIVE_SECTIONS) {
    for (const [entity, entries] of Object.entries(doc?.groups?.[section] ?? {})) {
      if (BACKGROUND_BACKBONE_UNITS.includes(entity)) continue
      const all = Array.isArray(entries) ? entries : []
      if (all.length > 0 && all.every(isOld)) items.push({ section, entity, entries: all })
    }
    // ⚠️ **散行也要管**（2026-10-06）：这一族从前只扫 `groups`，而「时间与分线」在旧文件里
    //    可能是**平铺**的（`前文脉络` 并进来的那一批）⇒ 只扫 groups 会让它**一条都归档不到、
    //    而且不报错**（静默失效，与 `planArchive` 上面那段"无论分组与否都要看散条目"同一个病）。
    const looseAll = Array.isArray(doc?.sections?.[section]) ? doc.sections[section] : []
    const loose = looseAll.filter(isOld)
    // 单元完整性 > 逐条最省：**整节都出窗**才搬（搬一半会让读者看到"这件事说了一半"）。
    if (loose.length > 0 && loose.length === looseAll.length) {
      items.push({ section, entity: null, entries: loose })
    }
  }

  return { total: items.reduce((sum, item) => sum + item.entries.length, 0), items }
}

/**
 * **执行冷归档**：把老的条目从活分区**搬**进「冷档案」，返回**新的 doc**（不改原 doc）。
 *
 * 搬进冷档案时保留**来源与主体**：
 *   · 分组来源（`人物` / `世界观` / `通用概念`）→ `### <节名>·<主体名>`；
 *   · 扁平来源（`人物关系` / `前文脉络` 等）→ `### <节名>`。
 * 这样条目的**原文一字不改**（读者日后取并集时去重键才对得上），来源也不会丢。
 *
 * @param {object} doc `parseBackground()` 的结果
 * @param {number} keepFromChapter 活跃窗口起点（1 起）
 * @returns {{ doc: object, moved: number, sections: string[] }} `moved === 0` 时 `doc` 原样返回
 */
export function applyArchive(doc, keepFromChapter, options = {}) {
  const plan = planArchive(doc, keepFromChapter, options)
  if (plan.total === 0) return { doc, moved: 0, sections: [] }

  const next = JSON.parse(JSON.stringify(doc))
  next.groups = next.groups ?? {}
  next.sections = next.sections ?? {}
  const archiveGroups = next.groups[BACKGROUND_ARCHIVE_SECTION] ?? (next.groups[BACKGROUND_ARCHIVE_SECTION] = {})
  const touched = new Set()

  for (const item of plan.items) {
    touched.add(item.section)
    const key = item.entity === null ? item.section : `${item.section}·${item.entity}`
    const bucket = archiveGroups[key] ?? (archiveGroups[key] = [])
    for (const entry of item.entries) {
      bucket.push(entry)
      if (item.entity === null) {
        const list = next.sections[item.section] ?? []
        next.sections[item.section] = list.filter((line) => line !== entry)
      } else {
        const list = next.groups[item.section]?.[item.entity] ?? []
        next.groups[item.section][item.entity] = list.filter((line) => line !== entry)
        // ⚠️ 名下搬干净的主体连**空壳**也一并清掉（尤其状态行跟人走的情形）：
        //    留一个 `甲: []`，渲染时会多出一个无内容的 `### 甲`，文件也难看。
        if (next.groups[item.section][item.entity].length === 0) {
          delete next.groups[item.section][item.entity]
        }
      }
    }
  }

  return { doc: next, moved: plan.total, sections: [...touched] }
}


