/**
 * 背景认识（`background.md`）—— 「记忆」的落点。
 *
 * ## 这是什么
 *
 * 陪读 AI 对这本书**世界观 / 人物 / 人物关系 / 文风 / 前文脉络**的理解，落成一份
 * 人可以读、可以改的 Markdown，放在书自己的目录里。非小说的文本另有「通用概念」
 * 一节兜底——见 {@link BACKGROUND_SECTIONS}。
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

import { atomicWriteText } from './atomic-json.js'
import { escapePromptText } from './spoiler.js'
import { readFileSync } from 'node:fs'

/** 背景文件的 schema 版本。 */
export const BACKGROUND_SCHEMA_VERSION = 1

/**
 * 章节归属标记：`第12章` / `第12-15章`。合并去重时用它识别"这条已经有了"。
 */
const CHAPTER_TAG_RE = /`第\s*(\d+)(?:\s*[-–~]\s*(\d+))?\s*章`/

/** 头部覆盖区间注释。 */
const COVERED_RE = /<!--\s*drc-background:([^>]*?)-->/

/**
 * 章节分区，**按写进 prompt 的优先级排列**（超预算时从后往前丢）。
 *
 * 「人物关系」排在最前是**注入侧**的优先级（读者要的是"谁和谁是什么关系"，而不是
 * "这本书讲了什么"），**不等于生成侧要把它写成唯一重点** —— 生成提示词里那句
 * "人物关系是重点" 已在 v1.65 改成平级：它让模型把预算全投在这一节，别的节
 * （人物 / 文风）只剩备份的一半。顺序与权重是注入的裁剪优先级，别拿它当
 * "哪一节更重要"的指令读。
 *
 * 「文风」排在「世界观」之后、「前文脉络」之前，与
 * {@link BACKGROUND_SECTION_WEIGHTS} 的权重大小同序——顺序和权重是同一件事的
 * 两种表达，改一个就要改另一个。
 *
 * ⚠️ 「文风」是**天然防剧透**的一节：叙述视角、句式习惯、用词偏好、节奏、对话
 * 密度都不含剧情信息。告诉模型"作者爱用短句、第三人称限知"不会泄露任何后续。
 *
 * ## 「通用概念」是最后一节，也是唯一的兜底
 *
 * 前面五节都是**为小说定的**：人物、关系、世界观、文风、脉络。读者不只读小说
 * ——读史书、哲学、技术书时，那五节可能全是空的，而这本书的内容却无处可写。
 *
 * 所以加了这一节，它有三条刻意的性质：
 *
 * 1. **只在归不进前面时用。** 一条概念只要能归进「世界观」「人物」等任何一节，
 *    就必须归进去——兜底不是"随便放"的同义词。这条由提示词执行（见
 *    `memory.js` 的格式要求），不靠代码判。
 * 2. **排在最后、权重最低。** 小说阅读是主线：对一本小说，这一节通常是空的，
 *    而 {@link renderBackgroundForPrompt} 会**跳过没有内容的分区**，于是它对
 *    小说的预算分配**一点影响都没有**（这是加法，不是改动）。
 * 3. **可以按主体分组**（`### 概念名`），与「世界观」同形：非虚构书的核心概念
 *    往往正是需要被逐条寻址、逐条修正的东西。
 *
 * @type {readonly string[]}
 */
export const BACKGROUND_SECTIONS = Object.freeze(['人物关系', '人物', '世界观', '文风', '前文脉络', '通用概念'])

/**
 * 「通用概念」的**异名**。
 *
 * 分区的识别是**精确匹配**（`## 通用概念`），而这一节的名字是提示词里现写的，
 * 模型换个说法（`## 通用概念（兜底）`）就会让整节内容落进"认不出的 `## 标题`"
 * 分支——那里的条目会被当成人手写的内容，**不再作为认识渲染，也不再进压缩**。
 * 静默丢失比报错难查得多，所以这里把最可能的几种写法归一。
 *
 * ⚠️ 只给**新增的兜底分区**留异名。既有五节的名字不动：它们已经在读者手上的
 * 文件里出现了几千次，改变它们的匹配规则风险更大。
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
})

/**
 * 把模型可能写出的分区名归一到 {@link BACKGROUND_SECTIONS} 里的那一个。
 *
 * 认不出时**原样返回**——`parseBackground` 依赖"认不出就重置分区"这条行为。
 *
 * @param {string} name 标题原文（已 trim）
 * @returns {string} 归一后的分区名
 */
export function normalizeSectionName(name) {
  if (typeof name !== 'string') return ''
  const trimmed = name.trim()
  return SECTION_ALIASES[trimmed] ?? trimmed
}

/**
 * **分组分区**：条目有明确「主体」、用 `### 主体` 归拢的分区。
 *
 * 「人物」按人名分组是老规矩；这里把它推广到「人物关系」（主体是**关系双方**，
 * 如 `### 甲 × 乙`）与「世界观」（主体是地名/势力名/设定名）。
 *
 * 为什么需要主体：`人物关系` 的条目常常不写清"是谁和谁"（`- \`第12章\` 关系出现
 * 裂痕`），既让人读不明白，也让"这条关系属谁"无从追溯。有了 `###` 分组之后，
 * 每条条目都有一个**可寻址的主体**——这正是 v1.22 §211 那条「取代」能指哪打哪的
 * 前提。
 *
 * 仍然不是分组的「文风」「前文脉络」：它们的主体是**整本书**和**时间轴**，
 * 强行分组只会造出一堆只有一个成员的分区。
 *
 * 「通用概念」按主体分组（`### 概念名`）——见 {@link BACKGROUND_SECTIONS} 的说明。
 *
 * @type {readonly string[]}
 */
export const BACKGROUND_GROUPED_SECTIONS = Object.freeze(['人物关系', '人物', '世界观', '通用概念'])

/**
 * **已取代**：被新条目取代掉的旧条目的归档区。
 *
 * 三条性质，缺一不可：
 * 1. **不删除。** 取代是「搬进归档」，不是「抹掉」——设计约束「条目只增不减」
 *    在取代这件事上依然成立，读者随时能把一行搬回去撤销取代。
 * 2. **永不进展。** 它不在 {@link BACKGROUND_SECTIONS} 里，所以
 *    {@link renderBackgroundForPrompt} 根本走不到它。
 * 3. **不参与压缩。** 它是历史日志，不是活记忆——送给压缩模型既浪费 token，
 *    又给了它把已被推翻的旧说法"重新总结"回正文的机会（见 compact.js）。
 */
export const BACKGROUND_RETIRED_SECTION = '已取代'

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
  + '你可以直接编辑它——下次补充会尊重你写的内容。 -->'

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
    groups: Object.fromEntries(BACKGROUND_GROUPED_SECTIONS.map((name) => [name, {}])),
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
    if (entityMatch !== null && !retired && section !== null && BACKGROUND_GROUPED_SECTIONS.includes(section)) {
      entity = entityMatch[1]
      if (result.groups[section][entity] === undefined) result.groups[section][entity] = []
      continue
    }

    if (line.startsWith('- ') && (section !== null || retired)) {
      const entry = line.slice(2).trim()
      if (entry !== '') {
        if (retired) result.retired.push(entry)
        else if (entity !== null && BACKGROUND_GROUPED_SECTIONS.includes(section)) {
          result.groups[section][entity].push(entry)
        } else result.sections[section].push(entry)
      }
      continue
    }

    // 认不出、且不属于任何已知分区的实义行：留着，别丢。
    // （注释行在上面循环开头就整块跳过了，这里不必再判 `<!--`。）
    if (line.trim() !== '' && section === null && !retired && !line.startsWith('#')) {
      unknownLines.push(line)
    }
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
function entryKey(entry) {
  if (typeof entry !== 'string') return ''
  return entry
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(CHAPTER_TAG_RE, '')
    .replace(/[\s，。,、；;：:]/g, '')
    .trim()
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
 *   （同 §204 那条原则）。
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
  for (const name of BACKGROUND_SECTIONS) {
    const existing = Array.isArray(base.sections?.[name]) ? [...base.sections[name]] : []
    const seen = new Set(existing.map(entryKey))
    for (const entry of add.sections?.[name] ?? []) {
      const key = entryKey(entry)
      if (key === '' || seen.has(key) || suppressed.has(key)) continue
      seen.add(key)
      existing.push(entry)
    }
    sections[name] = existing
  }

  // 分组分区按**主体**归并：同一个主体在后续章节的新描述追加到它自己名下。
  const groups = {}
  for (const name of BACKGROUND_GROUPED_SECTIONS) {
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

  const retired = [...(base.retired ?? [])]
  const unmatched = []
  let superseded = 0

  for (const target of Array.isArray(options.supersedes) ? options.supersedes : []) {
    const key = entryKey(target)
    // 幂等：同一条取代两次不该产生两条归档。
    if (key === '' || suppressed.has(key)) continue
    let removed = null
    for (const name of BACKGROUND_SECTIONS) {
      const index = sections[name].findIndex((entry) => entryKey(entry) === key)
      if (index >= 0) {
        removed = sections[name].splice(index, 1)[0]
        break
      }
    }
    if (removed === null) {
      findGrouped: for (const name of BACKGROUND_GROUPED_SECTIONS) {
        for (const [entity, entries] of Object.entries(groups[name])) {
          const index = entries.findIndex((entry) => entryKey(entry) === key)
          if (index >= 0) {
            removed = entries.splice(index, 1)[0]
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
    retired.push(`${removed} <!-- 已于第 ${range.last} 章被取代 -->`)
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
    // 已经生效，是这一节最不该出现的情形（与 §204 同一条原则）。
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
    lines.push(`## ${name}`, '')
    // 散条目（行首没有 `###`）写在分区标题正下方。**这一小段是修过的数据丢失
    // bug**：旧实现只渲染 `doc.characters`，于是「人物」下没有 `###` 的条目会在
    // 下一次写盘时被静默丢掉（见 `parseBackground` 的说明）。
    const loose = doc?.sections?.[name] ?? []
    for (const entry of loose) lines.push(`- ${entry}`)

    const grouped = BACKGROUND_GROUPED_SECTIONS.includes(name)
    const entities = grouped ? Object.keys(doc?.groups?.[name] ?? {}) : []
    if (loose.length === 0 && entities.length === 0) lines.push('')
    for (const entity of entities) {
      lines.push(`### ${entity}`)
      for (const entry of doc.groups[name][entity]) lines.push(`- ${entry}`)
      lines.push('')
    }
    if (!grouped || entities.length === 0) lines.push('')
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
 * 写背景文件（原子写）。
 *
 * @param {string} path 绝对路径
 * @param {object} doc 结果
 * @param {string} title 书名
 * @returns {string} 落盘后的 Markdown
 */
export function writeBackground(path, doc, title) {
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
 * @returns {{ from: number, to: number }|null} 待补区间（1 起，闭区间）；无缺口回 null
 */
export function backgroundGap(covered, progressIndex) {
  if (!Number.isInteger(progressIndex) || progressIndex < 0) return null
  // 前文末日（1 起）：当前章是 chapterIndex+1，所以前一章就是 chapterIndex。
  const lastReadable = progressIndex
  if (lastReadable < 1) return null
  const from = covered === null || covered === undefined ? 1 : covered.last + 1
  if (from > lastReadable) return null
  return { from, to: lastReadable }
}

/**
 * 各分区的预算权重。
 *
 * 权重只在**超预算需要取舍**时起作用。它编码的是读者的原话：「重点是人物关系」。
 * 所以「人物关系」拿到最大的一份，「通用概念」最小——小说是主线，兜底让路。
 *
 * ⚠️ 只在**两者都有内容**时才有取舍可言：`renderBackgroundForPrompt` 会跳过
 * 空分区，所以对一本小说（兜底为空）加这一节是**纯加法**，不改变任何既有分配。
 *
 * ## 为什么写成 `/ 55` 而不是小数
 *
 * 分配只用**比值**（注水法的除数是"还饿着的那些节的权重和"），所以加上第六节
 * 之后，原五节的权重必须**同比缩小**才能让小说的分配结果一字节不变——原来的
 * 比例是 30:26:18:14:12 = 15:13:9:7:6（和为 50），兜底按 5 加进去，分母正好
 * 55。写成 `15 / 55` 而不是 `0.2727…`，是为了让"比例没变、只是分母大了"
 * 这件事在代码里**看得见**。
 *
 * ⚠️ 这张表的**前五节比例 `15:13:9:7:6` 是受保护的**（`background.test.mjs` 有专测
 * 钉着）：它是"加第六节不改动小说分配"的唯一加法。想动其中任何一个数，
 * 必须**同时**重新基线化那条用例并在注释里写明理由 —— 见 v1.44 的评估
 * （读者曾要求把「前文脉络」降一档，实测在 9000 字预算上只省约 70 字，
 * 而提升「人物关系」的收益只有约 10 字，故**暂缓**；真正的杠杆是提示词里的
 * 每条长度上限）。
 *
 * @type {Readonly<Record<string, number>>}
 */
export const BACKGROUND_SECTION_WEIGHTS = Object.freeze({
  人物关系: 15 / 55,
  人物: 13 / 55,
  世界观: 9 / 55,
  文风: 7 / 55,
  前文脉络: 6 / 55,
  通用概念: 5 / 55,
})

/**
 * 每个分区在分配时的**保底比例**（相对总预算）。
 *
 * 这一条是专门治旧实现的一个真实缺陷：旧版按整节粒度丢弃，于是一旦
 * 「人物关系」自己就吃掉全部预算，其余三节会被**整节**丢掉，模型拿到的是
 * "未提供：人物、世界观、前文脉络"——等于告诉它这本书没有人物。
 * 保底保证每一节至少露个头。
 */
const SECTION_FLOOR_RATIO = 0.12

/**
 * 从条目文本里挖出它提到的**最大章号**（1 起）；没有则 0。
 *
 * 用于"超预算时先丢哪一条"的判据：越近期的越该留下。刻意用正则扫而不是
 * 复用 `CHAPTER_TAG_RE`——那个是非全局的，带 `g` 才有 `lastIndex` 语义，
 * 共用会互相打断。
 *
 * @param {string[]} entries 条目
 * @returns {number}
 */
function maxChapterIn(entries) {
  let max = 0
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (typeof entry !== 'string') continue
    const re = /`第\s*(\d+)(?:\s*[-–~]\s*(\d+))?\s*章`/g
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
  //   · `## 人物关系` 的主体是**成对**的（`### 甲 × 乙`），不是单个的人，另算；
  //   · `## 世界观` / `## 通用概念` 里是设定与概念，本来就不该叫人名卡。
  // 所以"哪些算人物"这件事**由分区的归属决定**，而那份归属是可以手改的（见 README）：
  // 把 `### 白狼` 挪出「人物」、或删掉它，卡片就会跟着变 —— 这比在代码里猜名字可靠。
  const CARD_SECTION = '人物'
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
    })
  }
  // 最近说到的排前面；同章号时按名字稳定排序，免得每次渲染顺序抖动。
  return cards.sort((left, right) => (right.latest - left.latest) || left.name.localeCompare(right.name))
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
    const re = /`第\s*(\d+)(?:\s*[-–~]\s*(\d+))?\s*章`/g
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
 * 把一个分区拆成可独立取舍的**单元**。
 *
 * - 「人物关系」「人物」「世界观」这类分组分区的单元是**一个主体**（连同它名下
 *   的全部条目）——拆到条目粒度会产出"甲有三条、乙一条都没有"这种读起来像
 *   残缺的东西；
 * - 散条目（行首没有 `###`）各自成一个单元：它们没有主体可以归拢；
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
function sectionUnits(doc, name) {
  const units = []

  for (const entry of doc?.sections?.[name] ?? []) {
    units.push(makeUnit([`- ${entry}`], maxChapterIn([entry]), minChapterIn([entry])))
  }

  if (!BACKGROUND_GROUPED_SECTIONS.includes(name)) return units

  for (const [entity, entries] of Object.entries(doc?.groups?.[name] ?? {})) {
    // 名下条目**全部被取代**的主体不进提示词：留一个光秃秃的 `### 沈某某` 只会
    // 让模型看到一个名字却没有任何关于他的信息，像"这个人被删了"。文件里保留
    // （读者要看见发生了什么），但投喂时跳过。
    if (entries.length === 0) continue
    units.push(makeUnit(
      [`### ${entity}`, ...entries.map((entry) => `- ${entry}`)],
      maxChapterIn(entries),
      minChapterIn(entries),
    ))
  }

  return units
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

/** 分区单元的量词，用于省略提示的措辞。 */
const SECTION_UNIT_NOUN = Object.freeze({ 人物: '位人物', 人物关系: '条关系', 世界观: '条设定', 文风: '条风格特征', 前文脉络: '条脉络', 通用概念: '个概念' })

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
 * ⚠️ 但它不是"白拿"：多出来的那批主体以**粗粒度**出现，面板与模型都要能看出
 * "这一条是压缩过的"，否则「`### 甲` + 一条记载」会被读成"甲只有这一件事"。
 * 渲染时会加一句说明。
 *
 * ⚠️ **它只用剩余空间，不做置换。** 完整单元先把额度用到装不下为止，粗粒度再
 * 用**剩下的**补位。于是有些预算点上它一个都补不进去（剩余空间 < 一个粗粒度
 * 单元），该丢的还是丢。曾经想过"丢掉一个完整单元换三个粗粒度单元"——覆盖率
 * 确实更高，但那会把**本来能完整显示**的主体降级，破坏下面那条"`kept` 一个都
 * 不动"的性质。宁可少帮一点忙，也不要让降级去动已经显示好的内容。
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

  kept.sort((a, b) => a - b)
  coarse.sort((a, b) => a - b)
  return { kept, coarse, dropped: units.length - kept.length - coarse.length }
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
 * @param {boolean} [options.coarseDegrade] 是否启用粗粒度那一级（默认启用）。
 *   设 `false` 即回到 v1.24 的两级降级——这是留给"我不接受这个取舍"的退路，
 *   也是差分断言的抓手。
 * @param {Record<string, number>} [options.weights] 分区权重；默认
 *   {@link BACKGROUND_SECTION_WEIGHTS}。**这是给测试留的接缝**——权重是模块级
 *   常量，不留口子就没法写"权重真的被执行了"这种差分断言，而"权重变成死代码"
 *   正是这一节历史上真发生过的事。
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
    : `## 你对这本书的背景认识\n\n> 覆盖：第 ${covered.first}–${covered.last} 章。`
  const lines = [head]
  let used = head.length

  // 缺口提示：这是防剧透在这一层的守门人——让模型知道自己"哪一段是空白"，
  // 而不是拿记忆去糊。
  //
  // ⚠️ 两个方向的**章号基准不同**，这里最容易写错：
  //   - 前向用 `progressIndex`（0 起）。它同时是"前一章的 1 起章号"，所以
  //     `covered.last + 1 .. progressIndex` 正好是"前文里还没记下的部分"。
  //   - 后向要说的是"读者**正在读**第几章"，那是 `progressIndex + 1`。用错
  //     一个数就会把**当前章**的条目当成剧透丢掉，而当前章本来整章都要投喂。
  if (Number.isInteger(progressIndex) && covered !== null) {
    const lastReadable = progressIndex
    const readingChapter = progressIndex + 1
    if (covered.last < lastReadable) {
      const note = `\n> ⚠️ 第 ${covered.last + 1}–${lastReadable} 章**尚未**纳入你的背景认识。`
        + '不要对这一段的内容下判断，也不要去猜。'
      lines.push(note)
      used += note.length
    } else if (covered.last > readingChapter) {
      // 倒退：读者跳回了水位线之前。旧实现只在"落后"方向发警告，于是这一
      // 情形**完全静默**——第 900 章的条目会被原样注入给正在读第 50 章的人。
      const note = `\n> ⚠️ 这份背景认识覆盖到第 ${covered.last} 章，而你正在读第 ${readingChapter} 章。`
        + `第 ${readingChapter + 1} 章及以后的条目**已被过滤**；不要提及、推测或暗示它们。`
      lines.push(note)
      used += note.length
    }
  }

  const sections = []
  const filtered = []
  for (const name of BACKGROUND_SECTIONS) {
    const all = sectionUnits(doc, name)
    const units = maxChapter === null
      ? all
      : all.filter((unit) => unit.earliest === 0 || unit.earliest <= maxChapter)
    const blocked = all.length - units.length
    if (blocked > 0) filtered.push({ name, dropped: blocked })
    if (units.length === 0) continue
    // ⚠️ `wanted` 必须**含分区标题**。第一版把它漏在外面，而渲染时又从额度里
    // 扣了一次标题长度，于是每节都凭空少了十来个字符——预算充足时也会因为
    // "一条短条目 + 标题"刚好越界而整节被判超限，产出"未提供：人物关系、人物、
    // 世界观、前文脉络"这种自己打自己脸的输出。被三条测试同时抓出来。
    const headerCost = `\n### ${name}\n\n`.length
    sections.push({
      name,
      units,
      headerCost,
      wanted: headerCost + units.reduce((sum, unit) => sum + unit.cost, 0),
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
  const available = Math.max(0, budget - used)
  const weights = options.weights ?? BACKGROUND_SECTION_WEIGHTS
  const weightOf = (name) => {
    const value = weights[name]
    return typeof value === 'number' && value > 0 ? value : 0
  }

  const allowance = sections.map(() => 0)
  let remaining = available

  // 第一趟：统一保底。刻意**不含权重** —— 见上面的说明。
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

  // ---- 渲染：每节在自己的额度内挑单元 ----
  const omitted = []
  const trimmed = []
  const coarsened = []
  sections.forEach((section, index) => {
    // 额度已含标题，所以这里减去标题就是留给条目的空间。
    const room = Math.max(0, allowance[index] - section.headerCost)
    const { kept, coarse, dropped } = selectUnits(section.units, room, { coarseDegrade })

    if (kept.length === 0 && coarse.length === 0) {
      omitted.push(section.name)
      return
    }

    // 粗粒度单元与完整单元**混在一起按文件顺序输出**：读者看到的主体顺序必须与
    // `background.md` 一致，否则面板里那份和模型眼里那份对不上，排查时会怀疑人生。
    const coarseSet = new Set(coarse)
    const shown = [...kept, ...coarse].sort((a, b) => a - b)

    const headerText = `\n### ${section.name}\n\n`
    let body = shown
      .map((unitIndex) => {
        const unit = section.units[unitIndex]
        return (coarseSet.has(unitIndex) ? unit.coarseLines : unit.lines).join('\n')
      })
      .join('\n')
    // ⚠️ 这句说明是**承重的**，不是礼貌用语：一个只带一条记载的 `### 甲` 会被读成
    // "甲只做过这一件事"。不说清，粗粒度就从"少给一点"变成"给错的信息"。
    if (coarse.length > 0) {
      body += `\n\n（本节有 ${coarse.length} 个主体只列出最近一条记载，更早的在此未展开；完整内容在 background.md 里。）`
      coarsened.push({ name: section.name, coarsened: coarse.length, total: section.units.length })
    }
    if (dropped > 0) {
      const noun = SECTION_UNIT_NOUN[section.name] ?? '条记录'
      body += `\n\n（本节另有 ${dropped} ${noun}未在此展示；完整内容在 background.md 里。）`
      trimmed.push({ name: section.name, shown: shown.length, total: section.units.length, dropped })
    }
    lines.push(headerText, body)
    used += headerText.length + body.length
  })

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
   * 因**倒退过滤**被丢弃的单元数，按分区汇总。
   *
   * 暴露它是为了"过滤悄悄发生了"这件事必须看得见：读者跳到水位线之前时，
   * 面板要能说清"有 12 条超前的条目已被挡住"，否则他只会觉得"AI 突然变笨了"。
   *
   * @type {Array<{ name: string, dropped: number }>}
   */
  return { text: escapePromptText(lines.join('\n')), used, omitted, trimmed, coarsened, allowances, filtered }
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
