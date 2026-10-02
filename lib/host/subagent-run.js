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

// ⚠️ 联网工具名单**只有一处定义**（`spoiler.js` 的 `WEB_TOOL_NAMES`）。
//    这里原来有一份逐字相同的副本（2026-10-01 体检合并）：名单是"哪些工具算联网"，
//    两个模块各定义一次，加一个工具就会漏掉一处 —— 而漏掉的那一侧要么少拦、
//    要么少给权限，两种都不会报错。
//    ⚠️ 反向安全：这个模块本身**不导入任何东西**，加这一条边不会造出环
//    （`spoiler.js` 不导入 `subagent-run.js`）。
import { WEB_TOOL_NAMES } from './spoiler.js'

/**
 * 宿主有没有装子代理服务（**部署探针**，共享判据 —— `createSubagentRunner` 与压缩的
 * 分节编排都用它；3.0 ③b 起压缩要在**发起调用之前**就做这个检查，否则"全是空节、
 * 一次都不调模型"时，"没装子代理"会被误报成"没压出效果"，部署事实就丢了）。
 *
 * @param {object} runnerDeps
 * @returns {boolean}
 */
export function subagentsInstalled(runnerDeps) {
  try {
    const subagents = runnerDeps?.getSubagents?.()
    return subagents !== undefined && subagents !== null
  } catch {
    return false
  }
}

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

    // ⚠️ **2026-10-02 三方评审 P2-3：超时路径不会等 `run.result`，所以
    // "结果拿到再释放"这个形状在超时时等于永不释放。**
    //
    // 调用方（{@link createSubagentRunner} 返回的 `run`）用 `Promise.race` 兜超时：
    // 宿主若卡在一个不响应取消的等待上，`result` **永不 settle** ⇒ 这里的
    // `finally` 永不执行 ⇒ 每次补齐失败都漏一个子代理会话（会话列表里堆积）。
    // 而超时的唯一动作是 `controller.abort()` —— 所以把释放同时挂到中止信号上：
    // abort 时主动释放，`finally` 仍是正常路径的兜底。释放只做一次。
    let released = false
    const release = async () => {
      if (released) return
      released = true
      try {
        await run.dispose?.()
      } catch {
        /* 释放失败不该覆盖已经拿到的结果 */
      }
    }
    const onAbort = () => { void release() }
    const signal = spec?.signal
    if (signal?.aborted === true) {
      // 启动期间就已经中止（超时恰好落在 start 上）：没有"结果"可等了。
      void release()
    } else {
      try {
        signal?.addEventListener('abort', onAbort, { once: true })
      } catch {
        /* 拿不到 signal 也只是少一条提前释放的路径，`finally` 照旧 */
      }
    }

    try {
      return await run.result
    } finally {
      try {
        signal?.removeEventListener?.('abort', onAbort)
      } catch {
        /* 忽略 */
      }
      // run 持有子代理生命周期；结果拿到（或已经放弃）就放掉。
      await release()
    }
  }

  const startRun = typeof deps?.startRun === 'function' ? deps.startRun : defaultStartRun
  /** 注入了自己的 startRun 时就不依赖 `subagents` 服务，不该被它的缺失挡住。 */
  const usesDefaultStart = typeof deps?.startRun !== 'function'

  /** 宿主有没有子代理服务（`createSubagentRunner` 里同一判据 —— 委托给抽出来的共享探针）。 */
  const hasSubagents = () => subagentsInstalled(deps)

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
    // ⚠️ **记忆维护的子代理要挂在"绑定的读书会话"下**（3.0，读者实测：
    //    "子代理跟着当前会话跑，而不是固定到绑定会话里跑"——从哪个会话点补齐，
    //    那批子代理会话就散落在谁的下面）。调用方给 primary = 绑定会话、
    //    fallback = 当前会话；**绑定会话不在线就落回当前** —— 与旧行为一致，
    //    不会变得"不能补"。
    const fallbackSessionId = typeof request?.fallbackSessionId === 'string'
      && request.fallbackSessionId !== ''
      ? request.fallbackSessionId
      : null

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
      if ((parent === undefined || parent === null)
        && fallbackSessionId !== null && fallbackSessionId !== sessionId) {
        parent = deps.getAgent?.(fallbackSessionId)
      }
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
