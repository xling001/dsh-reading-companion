/**
 * 子代理启动的形状守卫。
 *
 * 为什么需要这一组：补齐记忆与压缩背景**都**只走这一条路，而它与宿主的接口
 * 曾整体换过一代（2026-11-03：官方 DSH 0.2.1-rc5 把 `subagents.start('spawn', spec)`
 * 换成了 `startActivation({ provider, delivery, label, request, signal })`）。
 * 换的时候**不报错、只是静默失效**，读者看到的是一句 `subagents.start is not a
 * function`——那时候没有任何测试盯着这个形状。
 *
 * 三条断言分别钉住：新接口的形状（含防剧透的 toolFilter）、旧宿主的回落、
 * 以及"接口又变了要立刻失败而不是挂到 10 分钟超时"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSubagentRunner } from '../lib/host/subagent-run.js'

/** 宿主的活 Agent 对象（`startActivation` 会做身份校验，必须原样传回去）。 */
const parentAgent = { id: 'sess-1', session: { id: 'sess-1' } }

/** 一个包成 SuccessResult 的子代理结果 —— 形状取自宿主的 `SubagentResult`。 */
const okResult = (text) => ({
  output: [{ type: 'text', text }],
  stopReason: 'end',
})

test('子代理启动：0.2.x 走 startActivation，且防剧透的 toolFilter 两处都传', async () => {
  const calls = []
  const subagents = {
    // 只有新接口 ⇒ 必须走它（老 `start` 不存在）
    async startActivation(spec) {
      calls.push(spec)
      return { childId: 'child-1', result: Promise.resolve(okResult('整理好的背景')), dispose: async () => {} }
    },
  }
  const runner = createSubagentRunner({
    getSubagents: () => subagents,
    getAgent: () => parentAgent,
    timeoutMs: 5000,
  })

  const out = await runner({
    sessionId: 'sess-1',
    label: '记忆整理',
    prompt: '把这一批写进背景',
    persona: '整理者',
  })

  assert.equal(out.ok, true, `应当成功，实际：${JSON.stringify(out)}`)
  assert.equal(out.text, '整理好的背景')

  assert.equal(calls.length, 1, '只该启动一次')
  const spec = calls[0]
  assert.equal(spec.provider, 'spawn', 'provider 要用宿主默认的 spawn')
  // ⚠️ **`delivery` 必须是 `'caller'`**：`'parent'` 会让宿主在子代理跑完时
  // 给主会话发一条"后台子代理完成了"的通知（主会话据此自说自话回一轮话），
  // 还可能叫子代理用 send_message 回报。补齐/压缩是我们自己 await 结果的工作流，
  // **不该惊动主会话** —— 2026-11-03 真机就是因为这里写成 'parent' 才冒出那段回复。
  assert.equal(spec.delivery, 'caller', '不许让宿主通知主会话（那会让主会话回一句）')
  assert.equal(spec.label, '记忆整理')
  assert.equal(spec.request.parent, parentAgent, 'parent 必须是活 Agent 对象（传 id 会被身份校验拒掉）')
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: '把这一批写进背景' }])
  assert.equal(spec.request.maxDepth, 1)

  // ⚠️ **这一条是防剧透的**：不给任何工具的 toolFilter 必须真的传到宿主。
  // 传丢了 ⇒ 子代理拿到 `read` ⇒ 能读到原文后文。
  assert.deepEqual(spec.request.toolFilter, { allow: [] }, '顶层的 toolFilter 不能丢')
  assert.deepEqual(spec.request.agentOptions.toolFilter, { allow: [] }, 'agentOptions 里也要有（0.2.x 位置不明）')
  assert.equal(spec.request.agentOptions.persona, '整理者')
})

test('子代理启动：老宿主没有 startActivation 时，回落 start(spawn, spec)', async () => {
  const calls = []
  const subagents = {
    async start(kind, spec) {
      calls.push({ kind, spec })
      return { result: Promise.resolve(okResult('老宿主的结果')), dispose: async () => {} }
    },
  }
  const runner = createSubagentRunner({
    getSubagents: () => subagents,
    getAgent: () => parentAgent,
    timeoutMs: 5000,
  })

  const out = await runner({ sessionId: 'sess-1', label: '记忆整理', prompt: '写背景' })

  assert.equal(out.ok, true, `应当成功，实际：${JSON.stringify(out)}`)
  assert.equal(out.text, '老宿主的结果')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'spawn')
  assert.deepEqual(calls[0].spec.toolFilter, { allow: [] }, '回落路径同样不许丢 toolFilter')
})

test('子代理启动：启动成功但拿不到 result ⇒ 立刻报 SUBAGENT_API_INCOMPATIBLE（不挂到超时）', async () => {
  const subagents = {
    // 形状又变了：没有 result
    async startActivation() {
      return { childId: 'child-1' }
    },
  }
  const runner = createSubagentRunner({
    getSubagents: () => subagents,
    getAgent: () => parentAgent,
    // 超时设得很长 —— 如果实现是"挂到超时"，这条会跑很久
    timeoutMs: 600000,
  })

  const startedAt = Date.now()
  const out = await runner({ sessionId: 'sess-1', label: '记忆整理', prompt: '写背景' })
  const elapsed = Date.now() - startedAt

  assert.equal(out.ok, false)
  assert.equal(out.reason, 'SUBAGENT_API_INCOMPATIBLE')
  assert.ok(elapsed < 2000, `必须立刻失败，实际等了 ${elapsed}ms`)
})
