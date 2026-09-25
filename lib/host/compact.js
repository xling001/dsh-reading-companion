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
 * ## 它是"只增不减"的唯一例外，因此有四条硬约束
 *
 * 1. **保名**：压缩前有的每一位人物，压缩后必须还在。丢了谁就是丢了记忆。
 * 2. **保主体**：压缩前有的每一个分组主体（人物关系的一对、世界观的一个条目），
 *    压缩后必须还在——与「保名」同一原则，只是推广到了 v1.22 新增的分组分区。
 * 3. **保号**：覆盖区间只能不变或变大，绝不能缩小。
 * 4. **必须真的变小**：否则这次调用白花，还会陷入"压缩→没效果→再压缩"的循环。
 *
 * 四条都在 {@link validateCompaction} 里检查；**检查不过就整批丢弃**，宁可
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
  BACKGROUND_GROUPED_SECTIONS,
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
  '你在整理自己的读书笔记，把它压缩得更短但**不丢信息点**。',
  '严格约束：',
  '1. **每一位人物、每一对关系、每一条设定或概念都必须保留**，一个都不能删——哪怕它在后面的章节里再没出现。',
  '2. **每一条保留的条目都要保留它的 `第N章` 标记**，可以合并区间（如 `第3-7章`）。',
  '3. 覆盖区间（文件头部 `covered=`）**原样抄写**，不要改动。',
  '4. 只压缩表达，不新增任何原文里没有的信息，也不推测后续。',
  '5. 严格按要求的分节格式输出，不要任何额外说明。',
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
    '   - 再是六个小节 `## 人物关系` / `## 人物` / `## 世界观` / `## 文风` / `## 前文脉络` / `## 通用概念`，顺序不变；',
    '   - `## 人物关系` / `## 人物` / `## 世界观` / `## 通用概念` 这几节下，每个主体一个 `### 名字`，下面是他名下的 `- ` 条目。',
    '3. **每一位人物、每一个 `###` 主体都要在**，一个都不能少。',
    '4. 压缩的手段是：把同一位人物名下语义重复、或时间相邻的多条**合并成一条**，'
      + '保留最有信息量的措辞；合并后章号写成区间（如 `第3-7章`）。',
    '5. 直接输出压缩后的 Markdown 全文，不要前后加任何解释、不要用代码块包起来。',
  ].join('\n')
}

/**
 * 压缩的安全校验。
 *
 * 三条硬约束见文件头。**任何一条不过就整批丢弃**——这是刻意的失败方向：
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
  for (const name of BACKGROUND_GROUPED_SECTIONS) {
    const beforeEntities = Object.keys(before?.groups?.[name] ?? {})
    const afterEntities = new Set(Object.keys(after?.groups?.[name] ?? {}))
    const lostEntities = beforeEntities.filter((entity) => !afterEntities.has(entity))
    if (lostEntities.length > 0) {
      return { ok: false, reason: `COMPACT_LOST_ENTITIES: ${name} · ${lostEntities.slice(0, 5).join('、')}` }
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
