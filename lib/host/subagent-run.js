/**
 * 「跑一次子代理」的公共机制。
 *
 * 记忆补齐（`memory.js`）与背景压缩（`compact.js`）都要做同一件事：拿读者的会话
 * 当父 Agent，起一个受限的子代理，等它回一段文本。它们只在**提示词**与**输出
 * 校验**上不同，所以机制部分抽在这里，只写一遍。
 *
 * ## 三个必须写对的地方
 *
 * 1. **父 Agent 必须是读者自己的会话。** 宿主用父 Agent 解析模型路由与凭据；
 *    挂错了要么报"没有可用路由"，要么用了另一个会话的配置。
 * 2. **超时必须 `Promise.race`，不能只 `abort()`。** `AbortController` 只是一个
 *    信号——它不会替我们结束一个不响应取消的 promise。宿主若卡在某个忽略信号的
 *    等待上，只 abort 会让这次调用**永远挂着**。`race` 是"我们自己绝不挂死"的
 *    保证；signal 仍然照传，让宿主有机会真正取消底层工作。
 * 3. **`tools.restrict()` 对未知工具名直接抛错。** 所以"这个部署没装联网工具"
 *    与"这次调用失败"是两件事：前者应当退化成**无工具继续跑**，而不是把整个
 *    功能搞挂。
 *
 * ## 联网权限：这里才是精确的控制点
 *
 * 子代理的 session 与陪读会话**不是同一个**、也没有绑定关系，所以工具闸里那条
 * 按会话归属判定的联网规则**认不出它**。spawn 时给的 `toolFilter` 是唯一可靠的
 * 开关，于是它必须由这里显式决定。
 */

/** 默认超时。读者明确选了"阻塞式，愿意等几十秒"。 */
export const DEFAULT_TIMEOUT_MS = 120000

/** 允许联网时才给的工具白名单。 */
export const WEB_TOOL_NAMES = Object.freeze(['web_search', 'web_fetch'])

/**
 * 造一个子代理运行器。
 *
 * @param {object} deps 依赖
 * @param {() => object|undefined} deps.getSubagents 取 `subagents` 服务
 * @param {(sessionId: string) => object|undefined} deps.getAgent 取会话对应的活 Agent
 * @param {Function} [deps.startRun] 覆盖子代理启动（单测注入用）
 * @param {number} [deps.timeoutMs] 超时（毫秒）
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @returns {(request: object) => Promise<object>} 运行函数
 */
export function createSubagentRunner(deps) {
  const timeoutMs = Number.isFinite(deps?.timeoutMs) && deps.timeoutMs > 0
    ? deps.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const logger = deps?.logger ?? {}

  /**
   * 默认的子代理启动实现。
   *
   * @param {object} spec 启动参数
   * @returns {Promise<object>} 子代理结果
   */
  const defaultStartRun = async (spec) => {
    const subagents = deps.getSubagents()
    if (subagents === undefined || subagents === null) {
      const error = new Error('SUBAGENTS_UNAVAILABLE')
      error.code = 'SUBAGENTS_UNAVAILABLE'
      throw error
    }
    const run = await subagents.start('spawn', spec)
    try {
      return await run.result
    } finally {
      // run 持有子代理生命周期；结果拿到就放掉，否则会话列表里会堆积。
      try {
        await run.dispose?.()
      } catch {
        /* 释放失败不该覆盖已经拿到的结果 */
      }
    }
  }

  const startRun = typeof deps?.startRun === 'function' ? deps.startRun : defaultStartRun
  /** 注入了自己的 startRun 时就不依赖 `subagents` 服务，不该被它的缺失挡住。 */
  const usesDefaultStart = typeof deps?.startRun !== 'function'

  /**
   * 宿主有没有子代理服务。
   *
   * @returns {boolean}
   */
  const hasSubagents = () => {
    try {
      const subagents = deps.getSubagents?.()
      return subagents !== undefined && subagents !== null
    } catch {
      return false
    }
  }

  /**
   * 按联网档位决定工具面，并在宿主不认识联网工具时优雅退化。
   *
   * @param {object} spec 启动参数
   * @param {boolean} allowWeb 是否允许联网
   * @returns {Promise<object>}
   */
  const runWithTools = async (spec, allowWeb) => {
    if (allowWeb !== true) return startRun({ ...spec, toolFilter: { allow: [] } })
    try {
      return await startRun({ ...spec, toolFilter: { allow: [...WEB_TOOL_NAMES] } })
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/unknown global tool|restrict/i.test(message)) {
        logger.warn?.('[reading] 宿主没有联网工具，本次生成退化为仅用给定材料')
        return startRun({ ...spec, toolFilter: { allow: [] } })
      }
      throw error
    }
  }

  /**
   * 跑一次子代理并取回纯文本。
   *
   * @param {object} request
   * @param {string} request.sessionId 父会话 id
   * @param {string} request.label 子代理标签（会话列表里可见）
   * @param {string} request.prompt 用户消息
   * @param {string} request.persona 子代理人格
   * @param {boolean} [request.allowWeb] 是否允许联网
   * @returns {Promise<{ ok: true, text: string, elapsedMs: number }|{ ok: false, reason: string, elapsedMs: number }>}
   */
  return async function run(request) {
    const sessionId = request?.sessionId

    // ⚠️ **先查环境能力，再查会话状态。** 顺序不是小事：
    //   - 「宿主没装子代理」是**部署事实**，用户做任何事都改变不了它；
    //   - 「会话里还没有活 Agent」是**用户自己能修的**（说一句话就行）。
    // 反过来的话，一台根本没装子代理的机器会一直提示"先在会话里说一句话"，
    // 用户照做之后还是失败，而且永远不知道该去改配置。
    if (usesDefaultStart === true && hasSubagents() === false) {
      return { ok: false, reason: 'SUBAGENTS_UNAVAILABLE', elapsedMs: 0 }
    }

    let parent
    try {
      parent = deps.getAgent?.(sessionId)
    } catch (error) {
      return { ok: false, reason: `PARENT_LOOKUP_FAILED: ${error?.message ?? error}`, elapsedMs: 0 }
    }
    if (parent === undefined || parent === null) {
      // 最常见的一种：会话当前没有活 Agent（还没发过消息，或已被回收）。
      // 这不是错误，是一个可预期的状态，调用方据此提示用户。
      return { ok: false, reason: 'NO_LIVE_PARENT', elapsedMs: 0 }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()

    const aborted = new Promise((resolve) => {
      if (controller.signal.aborted) {
        resolve('__abort__')
        return
      }
      controller.signal.addEventListener('abort', () => resolve('__abort__'), { once: true })
    })

    try {
      const result = await Promise.race([
        runWithTools({
          label: request.label,
          parent,
          prompt: [{ type: 'text', text: request.prompt }],
          persona: request.persona,
          signal: controller.signal,
          maxDepth: 1,
        }, request.allowWeb === true),
        aborted,
      ])

      if (result === '__abort__' || controller.signal.aborted === true) {
        return { ok: false, reason: 'TIMEOUT', elapsedMs: Date.now() - startedAt }
      }

      const text = extractText(result)
      if (text.trim() === '') {
        return { ok: false, reason: 'EMPTY_OUTPUT', elapsedMs: Date.now() - startedAt }
      }

      return { ok: true, text, elapsedMs: Date.now() - startedAt }
    } catch (error) {
      if (controller.signal.aborted === true) return { ok: false, reason: 'TIMEOUT', elapsedMs: Date.now() - startedAt }
      if (error?.code === 'SUBAGENTS_UNAVAILABLE') return { ok: false, reason: 'SUBAGENTS_UNAVAILABLE', elapsedMs: 0 }
      logger.warn?.(`[reading] subagent run failed: ${error?.message ?? String(error)}`)
      return { ok: false, reason: `FAILED: ${error?.message ?? String(error)}`, elapsedMs: Date.now() - startedAt }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 从 `SubagentResult.output` 里取出纯文本。
 *
 * @param {unknown} result 子代理结果
 * @returns {string} 拼接后的文本（可能为空）
 */
export function extractText(result) {
  const output = result?.output
  if (!Array.isArray(output)) return ''
  return output
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
