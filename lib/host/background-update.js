/**
 * 背景更新（T1-②）：把「陪读 AI 在回复里顺手带回的一条修正」写进 `background.md`。
 *
 * ## 为什么需要它
 *
 * 补齐（`memory.js`）只在**缺口存在**时跑，而且一次总结一整段前文。读者在对话里
 * 纠正一句（"沈某其实没死，第 30 章写了他被救走"）走不到那条路径上——缺口早就
 * 补完了。于是这句话说完就没了，下一轮 AI 又按旧说法讲，读者得再纠一次。
 *
 * ## 为什么数据源必须是 DSH 事件，而不是「模型可见面」
 *
 * 读者的指正发生在第 N 轮，插件真正读到它时可能已经是第 N+9 轮。中间只要发生过
 * 上下文压缩（`contextCompactionEnabled`），那一轮就已经不在模型可见的历史里了
 * ——**从可见面读，会漏掉恰好最该被记住的那句**。
 *
 * `session/event` 是宿主的 **durable 追加流**（"Post-commit, fire-and-forget
 * append feed"）：每条消息一旦落日志就来一次，与压缩无关。这是这条路径唯一
 * 站得住的数据源，也是 §187 写下的硬约束。
 *
 * ## 传递方式：回复里带一个 HTML 注释块
 *
 * 「零额外调用」是硬约束，所以不能"回复完再问一次模型"。做法是让陪读 AI 在回复里
 * 顺手带一个 `<!--drc-update ...-->` 块（格式见 {@link renderUpdateInstruction}）。
 *
 * 用 HTML 注释而不是可见文本，是因为**渲染器不会显示它，而原文里它在**——插件读的
 * 正是原文（durable 日志），从不需要经过渲染。所以"读者看不到"和"插件看得到"
 * 同时成立，也不必给界面加任何东西。
 *
 * ## 反向安全：章号不得超前进度
 *
 * 一个块声称"第 300 章的事实"、而读者才读到第 30 章时，写进去就是**用一次修正
 * 换一次剧透**，而且不可逆：`background.md` 之后会被原样注入。所以
 * `章 > 进度 + 1` 的块一律拒绝，理由如实回报（见 {@link validateUpdate}）。
 * 这与跳读闸是同一类关口，只是入口不同——**入口越多，越要保证判定在每一条上
 * 都成立**。
 *
 * ## 不谎报覆盖
 *
 * 写进去的是一条修正，**不代表这些章被补过**。所以落盘时走
 * `mergeBackground(..., { extendCoverage: false })`：覆盖区间原样不动。
 * 否则一条关于第 30 章的修正会让文件声称 `covered=1..30`，真正的第 1–29 章缺口
 * 就被**静默抹掉**了。
 */

import {
  BACKGROUND_GROUPED_SECTIONS,
  BACKGROUND_SECTIONS,
} from './background.js'

/** 块标记。刻意用 HTML 注释（见文件头）。 */
const BLOCK_RE = /<!--\s*drc-update\b([\s\S]*?)-->/g

/** 便宜的前置检查：整条消息里没有这个词，就不必跑正则。 */
const MARKER = 'drc-update'

/** 认识的字段。只认这几个；别的（含拼错的）按"续行"处理。 */
const FIELDS = Object.freeze(['节', '主体', '章', '事实', '取代'])
const FIELD_SET = new Set(FIELDS)

/** 一行 `键: 值` / `键：值`。键限短，避免把正文里的冒号误认成字段。 */
const FIELD_LINE_RE = /^([^\s:：]{1,8})\s*[:：]\s*([\s\S]*)$/

/** 没有 `节` 时的归属。人物是绝大多数修正的落点。 */
const DEFAULT_SECTION = '人物'

/**
 * 解析一个块的**体内**文本（`<!--drc-update` 与 `-->` 之间）。
 *
 * 认不出的行**不丢弃**，而是接到上一个字段后面——模型换行写一条长事实是常态，
 * 把续行丢掉会让"事实"被悄悄截断，而截断后的句子仍然像一句完整的话。
 *
 * @param {string} body 块体
 * @returns {{ 节: string, 主体: string, 章: string, 事实: string, 取代: string[] }}
 */
function parseUpdateBody(body) {
  const raw = { 节: [], 主体: [], 章: [], 事实: [], 取代: [] }
  let last = null

  for (const line of String(body ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    const matched = FIELD_LINE_RE.exec(trimmed)
    if (matched !== null && FIELD_SET.has(matched[1])) {
      last = matched[1]
      raw[last].push(matched[2].trim())
      continue
    }
    if (last === null || trimmed === '') continue
    const index = raw[last].length - 1
    raw[last][index] = raw[last][index] === '' ? trimmed : `${raw[last][index]} ${trimmed}`
  }

  return {
    // ⚠️ 同名多值用空格连接而不是取第一个：拼错的块应当**解析失败**（于是被拒绝、
    // 被记进日志），而不是静默采用其中一个。
    节: raw.节.join(' ').trim(),
    主体: raw.主体.join(' ').trim(),
    章: raw.章.join(' ').trim(),
    事实: raw.事实.join(' ').trim(),
    取代: raw.取代.map((text) => text.trim()).filter((text) => text !== ''),
  }
}

/**
 * 校验一条更新，返回可写入的规范化结果或一个**具体**的拒绝理由。
 *
 * 理由必须是可分辨的：`CHAPTER_AHEAD`（安全闸）与 `EMPTY_FACT`（块没写全）对
 * 用户的意义完全不同——前者是"我拦下了一次剧透"，后者是"模型没按格式写"。
 * 混成一个"非法"会让日志毫无用处。
 *
 * @param {object} update {@link parseUpdateBody} 的结果
 * @param {object} [options]
 * @param {number} [options.progressIndex] 读者当前的 `chapterIndex`（0 起）
 * @returns {{ ok: true, value: object }|{ ok: false, reason: string, detail?: string }}
 */
export function validateUpdate(update, options = {}) {
  const progressIndex = Number.isInteger(options.progressIndex) ? options.progressIndex : 0

  const section = typeof update?.节 === 'string' && update.节 !== '' ? update.节 : DEFAULT_SECTION
  if (!BACKGROUND_SECTIONS.includes(section)) {
    return { ok: false, reason: 'UNKNOWN_SECTION', detail: section }
  }

  const grouped = BACKGROUND_GROUPED_SECTIONS.includes(section)
  const subject = typeof update?.主体 === 'string' ? update.主体.trim() : ''
  if (grouped && subject === '') {
    return { ok: false, reason: 'NO_SUBJECT', detail: section }
  }

  const fact = typeof update?.事实 === 'string' ? update.事实.trim() : ''
  if (fact === '') return { ok: false, reason: 'EMPTY_FACT' }

  // 章号缺省 = 当前章。读者正在读它，所以必然安全——这也是"块没写章号"时
  // 唯一不会出错的选择（猜别的章号都可能猜到他还没读到的地方）。
  const rawChapter = typeof update?.章 === 'string' ? update.章.trim() : ''
  let chapter = progressIndex + 1
  if (rawChapter !== '') {
    if (!/^\d+$/.test(rawChapter)) {
      return { ok: false, reason: 'CHAPTER_INVALID', detail: rawChapter }
    }
    chapter = Number.parseInt(rawChapter, 10)
  }

  // ⚠️ 反向安全闸：见文件头。`+1` 是因为 `chapterIndex` 是 0 起、章号是 1 起，
  // 读者正在读的那一章就是 `progressIndex + 1`。
  if (chapter > progressIndex + 1) {
    return { ok: false, reason: 'CHAPTER_AHEAD', detail: `第${chapter}章 > 第${progressIndex + 1}章` }
  }

  return {
    ok: true,
    value: {
      section,
      grouped,
      subject: grouped ? subject : '',
      chapter,
      fact,
      supersedes: Array.isArray(update?.取代) ? update.取代 : [],
    },
  }
}

/**
 * 从一段文本里取出全部更新块并校验。
 *
 * @param {string} text 消息正文
 * @param {object} [options] 传给 {@link validateUpdate}
 * @returns {{ accepted: object[], rejected: Array<{ reason: string, detail?: string }> }}
 */
export function parseBackgroundUpdates(text, options = {}) {
  const accepted = []
  const rejected = []
  if (typeof text !== 'string' || !text.includes(MARKER)) return { accepted, rejected }

  // `g` 正则带 `lastIndex`，复用同一个字面量必须每次归零。
  BLOCK_RE.lastIndex = 0
  let matched
  while ((matched = BLOCK_RE.exec(text)) !== null) {
    const verdict = validateUpdate(parseUpdateBody(matched[1]), options)
    if (verdict.ok === true) accepted.push(verdict.value)
    else rejected.push({ reason: verdict.reason, detail: verdict.detail })
  }

  return { accepted, rejected }
}

/**
 * 把校验通过的更新装成 `mergeBackground` 认的「新解析结果」。
 *
 * 条目格式与模型补齐时产出的**完全一致**（`` `第N章` 事实 ``）：这样
 * `CHAPTER_TAG_RE`、`maxChapterIn` / `minChapterIn` 的分区配平、以及取代匹配的
 * 比较键（`entryKey` 会剥掉章号标记）全都自动生效，不必为这条路径另立一套。
 *
 * @param {object[]} updates {@link validateUpdate} 通过的结果
 * @returns {object}
 */
export function updatesToIncomingDoc(updates) {
  const incoming = {
    covered: null,
    updated: null,
    sections: {},
    groups: {},
    retired: [],
    unknown: '',
  }
  for (const name of BACKGROUND_SECTIONS) incoming.sections[name] = []
  for (const name of BACKGROUND_GROUPED_SECTIONS) incoming.groups[name] = {}

  for (const update of updates ?? []) {
    const entry = `\`第${update.chapter}章\` ${update.fact}`
    if (update.grouped === true) {
      const bucket = incoming.groups[update.section]
      if (bucket[update.subject] === undefined) bucket[update.subject] = []
      bucket[update.subject].push(entry)
    } else {
      incoming.sections[update.section].push(entry)
    }
  }
  return incoming
}

/**
 * 汇总所有更新要取代掉的旧说法。
 *
 * @param {object[]} updates
 * @returns {string[]}
 */
export function supersedesList(updates) {
  const list = []
  for (const update of updates ?? []) {
    for (const target of update.supersedes ?? []) list.push(target)
  }
  return list
}

/**
 * 所有更新里最大的章号。用作「已于第 N 章被取代」的落款。
 *
 * @param {object[]} updates
 * @returns {number} 没有更新时回 0
 */
export function maxUpdateChapter(updates) {
  let max = 0
  for (const update of updates ?? []) {
    if (Number.isInteger(update.chapter) && update.chapter > max) max = update.chapter
  }
  return max
}

/**
 * 写进守则的那段格式说明。
 *
 * ⚠️ 它是**稳定前缀**的一部分（见 `renderPolicy` 的说明）。内容必须只在格式
 * 变更时改动——随每轮状态变化会让前缀缓存整体失效。
 *
 * 最后一行的"没有更正时不要输出"是刻意的：一个每轮都出现的空块会让读者以为
 * AI 在记东西，而它什么也没记。这与 §204 是同一条原则。
 *
 * ⚠️ 示例刻意写**具体值**而不是 `<占位符>`。第一版写的是 `章: <这个事实属于第几章>`，
 * 而它**通不过本模块自己的校验**（`CHAPTER_INVALID`）——一个要模型照抄的示例，
 * 起码得是它自己的解析器接受的形状。测试里有一条把这段说明喂回
 * {@link parseBackgroundUpdates} 的往返断言，专门钉这一点。
 *
 * @returns {string}
 */
export function renderUpdateInstruction() {
  return [
    '8. **读者纠正你时，把修正交回给插件。** 当读者指出你说错了、或你发现自己',
    '   之前的说法与原文不符时，**在这条回复的最后**附一个块（读者看不到它，',
    '   渲染器会把它当注释略去；插件会把它写进背景认识）：',
    '',
    '   ```',
    '   <!--drc-update',
    '   节: 人物',
    '   主体: 沈某',
    '   章: 30',
    '   事实: 第 30 章里他其实没死，是被救走了',
    '   取代: 沈某已死',
    '   -->',
    '   ```',
    '',
    // ⚠️ 这一段**每轮都随静态段发出去**，却只在模型**真的要回传修正**时才用得上。
    // 所以它按"能省一个字是一个字"写：把节名清单以外的规矩压成三句，
    // 但**一条约束都没删**（节名清单 / 四节必须给主体 / 章不能往后指 /
    // 取代的语义 / 没有修正就整块不输出 —— 少哪条都会开一个真实的洞）。
    '   把值换成你要记的那一条。`节` 取「人物 / 人物关系 / 世界观 / 文风 / 前文脉络 / 通用概念」之一',
    '   （省略按「人物」；`通用概念` 兜底）。前四节**必须给 `主体`**，其余不用。',
    '   `章` 必须是你**已经读过**的章（往后指会被拒绝）。`取代` 写旧说法原文，',
    '   它只移进「已取代」、不会删除；没有就省略整行。**没有修正时不要输出这个块。**',
  ].join('\n')
}

/**
 * 从一条消息里取出全部文本块的正文。
 *
 * @param {string} type 事件类型
 * @param {object} data 事件 data
 * @returns {string} 没有文本时回空串
 */
function messageText(type, data) {
  const message = type === 'assistant/message' ? data?.message : data
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 背景更新观察者。
 *
 * 单独抽成工厂而不是把逻辑写进 `apply`，是为了**可测**：它只依赖
 * `{ library, logger }` 两个东西，测试可以直接喂 `(session, event)` 两个对象，
 * 不必起一个真的 cordis 上下文。事件接线本身由 `index.js` 一行完成，
 * 那行另有"钉接线"的静态断言守着（见 test/background-update.test.mjs）。
 *
 * ## 它永远不会抛
 *
 * 宿主对观察者已经是"记日志并隔离"（`session/event` 的契约），但这条路径还会被
 * 每一次消息追加触发，所以自己再兜一层：**一条背景更新的解析失败绝不该影响
 * 读者的正常对话**。
 *
 * @param {object} deps
 * @param {object} deps.library 书库（需要 `bookForSession` / `getProgress` / `backgroundApplyUpdates`）
 * @param {object} [deps.logger]
 * @returns {{ handleEvent: (session: object, event: object) => object|null }}
 */
export function createBackgroundUpdateWatcher(deps) {
  const { library, logger } = deps ?? {}
  const log = logger ?? {}

  return {
    /**
     * 处理一条宿主追加事件。
     *
     * @param {object} session 追加发生的会话
     * @param {object} event 已落日志的那条事件
     * @returns {object|null} 发生了什么（没有相关块时回 null）
     */
    handleEvent(session, event) {
      try {
        const sessionId = session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return null

        const type = event?.type
        // 先按类型短路：`session/event` 每一次追加都会走到这里，热路径上不能做
        // 任何比字符串比较更贵的事。
        if (type !== 'assistant/message' && type !== 'user/message') return null

        const text = messageText(type, event.data)
        if (text === '' || !text.includes(MARKER)) return null

        const bookId = library?.bookForSession?.(sessionId)
        if (typeof bookId !== 'string' || bookId === '') return null

        const progressIndex = library.getProgress?.(bookId)?.chapterIndex ?? 0
        const { accepted, rejected } = parseBackgroundUpdates(text, { progressIndex })

        if (accepted.length === 0) {
          // 有块但一条都没通过：这必须留痕。静默丢弃会让"AI 记下了"变成错觉，
          // 而那正是这一节最不该出现的情形（§204）。
          if (rejected.length > 0) {
            log.warn?.(
              `[reading] background update refused for ${bookId}: `
              + rejected.map((item) => `${item.reason}${item.detail === undefined ? '' : `(${item.detail})`}`).join(', '),
            )
          }
          return { accepted: 0, rejected }
        }

        const merged = library.backgroundApplyUpdates(bookId, accepted, { progressIndex })
        const unmatched = merged?.lastMerge?.unmatched ?? []
        log.info?.(
          `[reading] background update applied for ${bookId}: `
          + `${accepted.length} entr${accepted.length === 1 ? 'y' : 'ies'}`
          + `, superseded=${merged?.lastMerge?.superseded ?? 0}`
          + (unmatched.length > 0 ? `, unmatched=${unmatched.length}` : ''),
        )
        return {
          accepted: accepted.length,
          rejected,
          covered: merged?.covered ?? null,
          superseded: merged?.lastMerge?.superseded ?? 0,
          // 「想取代但没找到」要能传出去：模型写错了旧说法时，它以为修正生效了。
          unmatched,
        }
      } catch (error) {
        log.error?.(`[reading] background update failed: ${error?.message ?? String(error)}`)
        return null
      }
    },
  }
}
