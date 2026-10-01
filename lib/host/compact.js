/**
 * 背景认识的**压缩**（compaction）。
 *
 * ## 为什么需要它
 *
 * `background.md` 的核心约定是"只增不减"——那保证了认识是单调累积的，早期细节
 * 不会被反复重写而磨掉。但它有个必然的代价：**文件只会越来越长**，而注入 prompt
 * 的预算是有限的。
 *
 * 超预算时 `renderBackgroundForPrompt` 会截断。截断能保证不超预算，却会
 * **破坏缓存**：每次截断的保留集合都不同，于是这一段前缀每轮都变。
 *
 * 所以真正的解法是让文件本身保持在预算以内——这就是压缩。压缩之后
 * `renderBackgroundForPrompt` 不再触发截断，第 3 段重新变成一个**稳定的增长
 * 前缀**，缓存持续命中。
 *
 * ## 它是"只增不减"的唯一例外，因此有五条硬约束
 *
 * 1. **保名**：压缩前有的每一位人物，压缩后必须还在。丢了谁就是丢了记忆。
 * 2. **保主体**：压缩前有的每一个分组主体（人物关系的一对、世界观的一个条目），
 *    压缩后必须还在——与「保名」同一原则，只是推广到了 v1.22 新增的分组分区。
 *    读者族的「时间与分线」按单元分组，同样走这一条（判分组一律用 `isGroupedSection`）。
 * 3. **保号**：覆盖区间只能不变或变大，绝不能缩小。
 * 4. **必须真的变小**：否则这次调用白花，还会陷入"压缩→没效果→再压缩"的循环。
 * 5. **保读者族的条目**：读者族永不注入 ⇒ 前两条的计数都够不到它，
 *    必须单独按"条目一条都不能少"守（见 {@link validateCompaction}）。
 *
 * 五条都在 {@link validateCompaction} 里检查；**检查不过就整批丢弃**，宁可
 * 保持原样，也不接受一次可能丢了人物的"压缩"。
 *
 * ⚠️ 「已取代」归档区**不进压缩输入**（`renderBackground(..., { includeRetired:
 * false })`），压缩后也**原样保留**。它是历史日志：送进模型既浪费 token，又给了
 * 它把已被推翻的旧说法"重新总结"回正文的机会——那正好把取代白做了。
 *
 * 落盘前还会把原文件复制成 `background.bak.md`——压缩是唯一会**删掉**用户
 * 可见内容的一步，留个后路是应该的。
 */

import {
  BACKGROUND_READER_SECTIONS,
  BACKGROUND_SECTIONS,
  isGroupedSection,
  parseBackground,
  renderBackground,
  renderBackgroundForPrompt,
} from './background.js'
import {
  DEFAULT_TIMEOUT_MS,
  createSubagentRunner,
  extractText,
} from './subagent-run.js'

export { DEFAULT_TIMEOUT_MS, extractText }

/**
 * 压缩者的身份。
 *
 * 与 `MEMORY_PERSONA` 的区别很关键：整理者是"往上加"，压缩者是"往下减"。
 * 减东西比加东西危险，所以这里把"不许丢人物、不许丢章号"写进约束本身，
 * 而不只依赖代码侧校验——校验是最后一道，不是唯一一道。
 *
 * @type {string}
 */
export const COMPACT_PERSONA = [
  '你在整理自己的读书笔记：把它压短，但**一个信息点都不丢**。',
  '保留范围：人物、关系、设定、概念 —— **每一个主体都要在**（哪怕它后面再没被提到）。',
  '压缩手段：同一主体名下语义重复、或时间相邻的多条合成一条（例："第3章 拜师"+"第7章 出师"合成一句），'
  + '合并后章号写成区间（如 `第3-7章`）；每条信息都要能在素材里找到出处。',
  '覆盖区间（`covered=`）原样抄写；按要求的格式输出。',
  // ⚠️ 读者 2026-09-27 问过"这条有没有必要"：**素材本身严格落在进度之内、看不到后文**，
  //    所以旧措辞"不推测后续"几乎打不到东西。但**它防的不是素材，是模型自己** ——
  //    一本名著在它的训练数据里，它完全可能在"压缩"的名义下把**后面**的情节写进来，
  //    而这份文件每轮都会被投喂回去、还会持久化。所以这条**留着，但换了靶子**。
  '只用素材里的事实：这本书后面会怎样**不在素材里**，写进去等于把剧透永久留在记忆里'
  + '（这份文件每轮都投喂回去）。',
].join('\n')

/**
 * 构造压缩提示词。
 *
 * @param {object} input
 * @param {string} input.bookTitle 书名
 * @param {string} input.markdown 现有背景认识的全文
 * @param {number} [input.targetChars] 目标字符数
 * @returns {string}
 */
export function buildCompactPrompt(input) {
  const target = Number.isInteger(input?.targetChars) && input.targetChars > 0 ? input.targetChars : 3000
  return [
    `这是我在读《${input.bookTitle}》时整理的背景认识。它现在太长了，请帮我压缩。`,
    '',
    '原文：',
    '',
    input.markdown,
    '',
    '请输出压缩后的版本，要求：',
    '',
    `1. 总体长度压到 **${target} 字以内**。`,
    '2. **格式完全不变**：',
    '   - 第一行是 `<!-- drc-background: schema=1 covered=A..B updated=... -->`，**原样照抄**；',
    '   - 然后是 `# 《书名》· 背景认识`；',
    '   - 再是八个小节 `## 文本类型` / `## 人物关系` / `## 人物` / `## 世界观` / `## 前文脉络` / `## 文风（只写一次）` / `## 通用概念`'
      + ' / `## 时间与分线`，顺序不变；',
    '   - `## 人物关系` / `## 人物` / `## 世界观` / `## 通用概念` / `## 时间与分线` 这几节下，'
      + '每个主体一个 `### 名字`，下面是他名下的 `- ` 条目；⚠️ **`## 时间与分线` 的主体是「单元」**：'
      + '主线写 `### 主线`，一条支线 / 副本写 `### 【支线】名字 · 第N-M章`（**标题里的章号区间照抄，别丢**）。',
    // ⚠️ 读者族（2026-10-01）：这一节不进提示词，但**会导出给读者**。
    //    压缩是**整份重写**文件 —— 提示词里漏掉它，文件里就永久少了这一节 ✗。
    //    ⚠️ 它的处理尺度（一条都不能丢 / 一个字都不许改写）写在**第 4 条**，这里只留一句指针：
    //    同一件事写两遍，模型每次都要读两遍，而读者 2026-10-02 的要求正是"少罗列、把需求说清"。
    '   - ⚠️ `## 时间与分线`（只给读者看、不进提示词）**一条都不能丢** —— 处理尺度见第 4 条。',
    '3. **每一位人物、每一个 `###` 主体都要在**，一个都不能少。',
    // ⚠️ 2026-10-01（读者："压缩时是否每个条目压缩程度和方法不同"）：**把尺子分开**。
    //    从前只有一个总目标字数 + 一句通用规则，于是"哪节能合并、哪节不能动"全靠
    //    模型自己猜 —— 而它猜错的方向恰恰是最贵的那个（改写「时间与分线」、
    //    或把「人物」的主体合并掉）。
    '4. **每一节的压缩尺度不一样**，别用一把尺子（这是压缩质量的关键）：',
    '   · `## 文本类型`：**原样保留，一个字都别改** —— 它是"后面几节该怎么写"的指南针',
    '     （读者与你自己都按它理解这份文件），改写它等于把方向改掉了。',
    '   · `## 人物` / `## 人物关系` / `## 世界观` / `## 通用概念`：**按主体**压 —— 同一个主体',
    '     名下**语义重复的条目**、或时间相邻的多条，合成一条；**主体一个都不能少**（少一个就是丢了一位人物）。',
    '   · `## 文风（只写一次）`：**可以压得最狠** —— 它是稳定的特征清单，不随章节变；说同一件事的多条只留最准的一条，',
    '     宁可少留几条，也不要并列堆着。',
    '   · `## 前文脉络`：**按章号区间**把相邻条目并成一条，但**覆盖的范围不许缩小**（首尾章号照旧）。',
    '      ⚠️ `## 文风（只写一次）` 与 `## 前文脉络` 是**扁平节**（没有 `###` 主体）—— "同一个主体内部合并"',
    '     这条够不到它们，所以这两节里的**语义重复的条目**要靠你自己判断着合并（精炼主要就来自这一步）。',
    '   · `## 时间与分线`：**一个字都不许改写**，原样搬过去就行。它不进提示词，改写了、删掉了',
    '     **没有任何人能替你重建**（那是读者自己看的整理，不是给模型看的速记）。',
    '   · 一句话原则：**同一主体名下的多条 = 合并；不同主体之间 = 不许动。**',
    '5. 压缩的手段是：把同一位人物名下语义重复、或时间相邻的多条**合并成一条**，'
      + '保留最有信息量的措辞；合并后章号写成区间（如 `第3-7章`）。',
    '6. 直接输出压缩后的 Markdown 全文，不要前后加任何解释、不要用代码块包起来。',
  ].join('\n')
}

/**
 * 压缩的安全校验。
 *
 * 五条硬约束见文件头。**任何一条不过就整批丢弃**——这是刻意的失败方向：
 * 一次没压缩成功只是浪费一次调用，而一次丢了人物的压缩是不可逆的记忆损失。
 *
 * @param {object} before 压缩前的解析结果
 * @param {object} after 压缩后的解析结果
 * @param {object} [options]
 * @param {number} [options.budgetChars] 预算（用于判断是否真的小了）
 * @returns {{ ok: boolean, reason?: string, savedChars?: number, beforeChars?: number, afterChars?: number }}
 */
export function validateCompaction(before, after, options = {}) {
  const beforeFull = renderBackgroundForPrompt(before, { budgetChars: Number.MAX_SAFE_INTEGER })
  const afterFull = renderBackgroundForPrompt(after, { budgetChars: Number.MAX_SAFE_INTEGER })
  const beforeChars = beforeFull.used
  const afterChars = afterFull.used

  // ---- 保号：覆盖区间不能缩 ----
  if (after?.covered === null || after?.covered === undefined) {
    return { ok: false, reason: 'COMPACT_LOST_COVERAGE' }
  }
  const beforeCovered = before?.covered ?? null
  if (beforeCovered !== null && after.covered.last < beforeCovered.last) {
    return { ok: false, reason: 'COMPACT_SHRANK_COVERAGE' }
  }

  // ---- 保名：压缩前有的人，压缩后必须还在 ----
  const beforeNames = Object.keys(before?.characters ?? {})
  const afterNames = new Set(Object.keys(after?.characters ?? {}))
  const lost = beforeNames.filter((name) => !afterNames.has(name))
  if (lost.length > 0) {
    return { ok: false, reason: `COMPACT_LOST_CHARACTERS: ${lost.slice(0, 5).join('、')}` }
  }

  // ---- 保主体：分组分区的主体一个都不能少 ----
  //
  // 与「保名」同一原则。人物关系的主体是**一对人**（`### 甲 × 乙`）、世界观的主体
  // 是一个地名/势力/设定——丢一个和丢一位人物一样，是丢了记忆。
  for (const name of BACKGROUND_SECTIONS) {
    if (!isGroupedSection(name)) continue
    const beforeEntities = Object.keys(before?.groups?.[name] ?? {})
    const afterEntities = new Set(Object.keys(after?.groups?.[name] ?? {}))
    const lostEntities = beforeEntities.filter((entity) => !afterEntities.has(entity))
    if (lostEntities.length > 0) {
      return { ok: false, reason: `COMPACT_LOST_ENTITIES: ${name} · ${lostEntities.slice(0, 5).join('、')}` }
    }
  }

  // ---- 保读者族条目：这一族**上面两条口径都够不到它**，所以必须单独守 ----
  //
  // ⚠️ 两条都漏它：`beforeChars/afterChars` 量的是**注入**六节
  //    （`renderBackgroundForPrompt` 只遍历 `BACKGROUND_INJECTED_SECTIONS`），
  //    而「保主体」在这一版之前只跑注入族。后果：压缩模型把整个「时间与分线」
  //    （含每个单元的 `⭐ 影响`）删光，只要注入六节小了一点，这次压缩仍然判
  //    `ok:true` 并落盘 —— 而这一族**只有读者能重建**（它永不注入，AI 也纠不了）。
  //    判据取"条目一条都不能少"：这一族是读者自己维护的那一半记忆，
  //    压缩对它只该做"原样搬过去"，任何净减少都当失败。
  for (const name of BACKGROUND_READER_SECTIONS) {
    const countOf = (doc) => (Array.isArray(doc?.sections?.[name]) ? doc.sections[name].length : 0)
      + Object.values(doc?.groups?.[name] ?? {})
        .reduce((sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0), 0)
    const beforeCount = countOf(before)
    const afterCount = countOf(after)
    if (afterCount < beforeCount) {
      return {
        ok: false,
        reason: `COMPACT_LOST_READER_ENTRIES: ${name} · ${beforeCount} → ${afterCount}`,
      }
    }
  }

  // ---- 必须真的变小 ----
  if (afterChars >= beforeChars) {
    return { ok: false, reason: 'COMPACT_NO_SHRINK', beforeChars, afterChars }
  }

  return { ok: true, savedChars: beforeChars - afterChars, beforeChars, afterChars }
}

/**
 * 造一个压缩器。
 *
 * @param {object} deps 依赖（同 {@link createSubagentRunner}）
 * @returns {(request: object) => Promise<object>} 压缩函数
 */
export function createCompactor(deps) {
  const run = createSubagentRunner(deps)

  return async function compact(request) {
    const markdown = typeof request?.markdown === 'string' ? request.markdown : ''
    if (markdown.trim() === '') return { ok: false, reason: 'NO_BACKGROUND', elapsedMs: 0 }

    const before = request?.doc ?? parseBackground(markdown)
    // 归档区不进压缩输入——它是历史日志，不是活记忆（见文件头说明）。从 `before`
    // 重新渲染而不是字符串裁剪，是为了不依赖"归档恰好排在文件末尾"这个位置假设。
    const live = renderBackground(before, request?.bookTitle, { includeRetired: false })
    const result = await run({
      sessionId: request?.sessionId,
      label: 'dsh-reading-companion:compact',
      prompt: buildCompactPrompt({
        bookTitle: request?.bookTitle,
        markdown: live,
        targetChars: request?.targetChars,
      }),
      persona: COMPACT_PERSONA,
      // 压缩**不需要**联网：材料全在手上，联网只会引进外部信息。
      allowWeb: false,
    })
    if (result.ok !== true) return result

    const after = parseBackground(result.text)
    const verdict = validateCompaction(before, after)
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, elapsedMs: result.elapsedMs }
    }

    // 归档区**原样带回**：模型没见过它，所以它没有资格动它。不这样做的话，一次
    // 压缩就会把全部取代记录抹掉，被推翻的旧说法会在下一次合并时复活。
    after.retired = [...(before.retired ?? [])]

    return {
      ok: true,
      parsed: after,
      text: renderBackground(after, request?.bookTitle),
      elapsedMs: result.elapsedMs,
      savedChars: verdict.savedChars,
      beforeChars: verdict.beforeChars,
      afterChars: verdict.afterChars,
    }
  }
}
