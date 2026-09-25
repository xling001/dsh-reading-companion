/**
 * 补齐循环（`runFillLoop` / `fillOutcomeNotice`）的边界。
 *
 * 为什么单开一个文件、自带加载器，而不是并进 `test/client.test.mjs`：
 * 那份文件里的夹具是**合成过**的（书名的占位、账本键的假哈希），而循环这套
 * 逻辑跟夹具毫无关系。分开之后，这个文件可以整份搬进任何一棵树，不必连带
 * 处理夹具的版本差异。
 *
 * 这里钉的是**循环本身**，它是这轮改动里唯一会反复发起模型调用、也会反复
 * 落盘的东西。四条出口（补完 / 没有缺口 / 停在原地 / 批次上限）各有用例，
 * 而且**用"调用了几次"来验证"停住了"**——只看返回值的用例，抓不住一个
 * 返回了正确答案却继续转了十次的实现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let loadSeq = 0
function freshUrl(rel) {
  loadSeq += 1
  // ⚠️ 查询串前缀不能只用 `t=`：`--test-isolation=none` 把**所有**测试文件跑在
  //    同一个进程里，而 `client.test.mjs` 也用 `?t=1,2,…` 做缓存击穿。两边计数
  //    各自从 1 开始，`lib/client.js?t=1` 会命中对方已经加载过的那份**缓存**，
  //    `import()` 不重新执行模块，capture 就是 null。单独跑这个文件时看不出来，
  //    只有全套才会炸——前缀必须带上本文件自己的名字。
  return `${pathToFileURL(join(ROOT, rel)).href}?fillloop=${loadSeq}`
}

/** document 替身：模块加载期会做样式注入，缺了它会直接抛。 */
function makeFakeDocument() {
  const appended = []
  return {
    querySelector(selector) {
      const matched = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
      if (matched === null) return null
      return appended.find((el) => el.attrs['data-plugin-css'] === matched[1]) ?? null
    },
    createElement() {
      const el = {
        tagName: 'style',
        attrs: {},
        textContent: '',
        setAttribute(key, value) { this.attrs[key] = value },
        remove() {
          const at = appended.indexOf(el)
          if (at !== -1) appended.splice(at, 1)
        },
      }
      return el
    },
    head: { appendChild(el) { appended.push(el) } },
  }
}

/** react 替身：这个文件不渲染任何组件，只要能过模块加载期即可。 */
const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [initial, () => {}],
  memo: (fn) => fn,
}

async function internals() {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load(definition) { captured = definition } } }
  globalThis.document = makeFakeDocument()
  try {
    await import(freshUrl('lib/client.js'))
  } finally {
    delete globalThis.window
    delete globalThis.document
  }
  const mod = captured.factory((spec) => {
    if (spec === 'react') return reactStub
    throw new Error(`未预期的 require: ${spec}`)
  })
  return mod.__internals
}

/** 造一个按脚本逐次应答的 `fill`，并记录被调用了几次。 */
function scriptedFill(steps) {
  const calls = []
  const fill = () => {
    const step = steps[Math.min(calls.length, steps.length - 1)]
    calls.push(step)
    if (typeof step === 'function') return step()
    if (step instanceof Error) return Promise.reject(step)
    return Promise.resolve(step)
  }
  return { fill, calls }
}

/** 一批成功的应答。`partial` 缺省为 true（服务端说"没补到底"）。 */
function batch({ first = 1, last = 240, remaining = 100, partial = true, elapsedMs = 700 } = {}) {
  return {
    covered: { first, last },
    gap: remaining === null ? null : { chapters: remaining },
    partial,
    elapsedMs,
  }
}

// ---------------------------------------------------------------- 四条出口

test('循环：一批就补完时只调用一次', async () => {
  const { fill, calls } = scriptedFill([batch({ last: 149, remaining: 0, partial: false })])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill })

  assert.equal(out.kind, 'done')
  assert.equal(out.skipped, false)
  assert.equal(out.batches, 1)
  assert.equal(calls.length, 1, '补完了就不该再调用第二次')
  assert.deepEqual(out.covered, { first: 1, last: 149 })
})

test('循环：partial 继续补，直到某批补到底', async () => {
  const { fill, calls } = scriptedFill([
    batch({ last: 240, remaining: 900 }),
    batch({ first: 1, last: 480, remaining: 660 }),
    batch({ first: 1, last: 999, remaining: 0, partial: false }),
  ])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill })

  assert.equal(out.kind, 'done')
  assert.equal(out.batches, 3)
  assert.equal(calls.length, 3, '每批都要真的发出去')
  assert.deepEqual(out.covered, { first: 1, last: 999 })
  assert.equal(out.remaining, 0)
  assert.equal(out.elapsedMs, 2100, '耗时必须累加，不能只留最后一批')
})

test('循环：skipped 是正式回答，不是失败，且不花调用', async () => {
  const { fill, calls } = scriptedFill([{ skipped: true, covered: { first: 1, last: 9 } }])
  const { runFillLoop } = await internals()
  const seen = []
  const out = await runFillLoop({ fill, onProgress: (p) => seen.push(p) })

  assert.equal(out.kind, 'done')
  assert.equal(out.skipped, true)
  assert.equal(out.batches, 0, 'skipped 不该被算成一批')
  assert.equal(calls.length, 1)
  assert.deepEqual(out.covered, { first: 1, last: 9 })
  assert.equal(seen.length, 0, '没有批次就不该报进度')
})

test('循环：停在原地——水位线不动就收手，而不是一直转', async () => {
  // ⚠️ 这是本轮最要紧的一条兜底：服务端回了 partial:true 但水位线不前进，
  //    前两条出口都不成立。没有这一条，页面上就是一个转不完的按钮。
  const stuck = batch({ last: 240, remaining: 900 })
  const { fill, calls } = scriptedFill([stuck, { ...stuck }])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill })

  assert.equal(out.kind, 'stalled')
  assert.equal(calls.length, 2, '必须在**发现没前进的那一批**就停下，不能继续试探')
  assert.equal(out.covered.last, 240)
})

test('循环：批次上限是最后一道保险', async () => {
  let last = 0
  const { fill, calls } = scriptedFill([() => {
    last += 100
    return batch({ last, remaining: 1000 - last })
  }])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill, maxBatches: 3 })

  assert.equal(out.kind, 'capped')
  assert.equal(out.batches, 3)
  assert.equal(calls.length, 3, '上限就是上限，不能多跑一批')
})

// ---------------------------------------------------------------- 取消

test('循环：调用前就被取消时一次都不发', async () => {
  const { fill, calls } = scriptedFill([batch()])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill, alive: () => false })

  assert.equal(out.kind, 'cancelled')
  assert.equal(calls.length, 0)
})

test('循环：取消后不再开下一批', async () => {
  let alive = true
  const { fill, calls } = scriptedFill([batch({ last: 240 })])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({
    fill,
    alive: () => alive,
    onProgress: () => { alive = false },
  })

  assert.equal(out.kind, 'cancelled')
  assert.equal(calls.length, 1, '取消了就不该再补第二批')
  assert.equal(out.covered.last, 240, '已经落盘的那一批要如实回报，不能当没发生')
})

test('循环：取消打断飞行中的请求时，算取消而不是失败', async () => {
  // ⚠️ 真实的取消就长这样：fetch 还在飞，错误是它被中断的**后果**。
  //    如果这里报成 failed，读者会看到一句"补齐没完成"，而他明明是自己按停的。
  let alive = true
  const { fill } = scriptedFill([
    batch({ last: 240 }),
    () => { alive = false; return Promise.reject(new Error('请求被中断')) },
  ])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill, alive: () => alive })

  assert.equal(out.kind, 'cancelled')
  assert.equal(out.error, undefined, '取消不该带一个错误出去')
})

// ---------------------------------------------------------------- 失败

test('循环：抛错如实变成 failed，并保留原因', async () => {
  const boom = new Error('宿主调用失败')
  const { fill, calls } = scriptedFill([batch({ last: 240 }), boom])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill })

  assert.equal(out.kind, 'failed')
  assert.equal(out.error, boom, '原始错误必须原样带出去，否则闸门信息会丢')
  assert.equal(out.batches, 1, '成功的那一批要计入')
  assert.equal(calls.length, 2)
})

test('循环：接口返回非对象时算失败，而不是当成"没有缺口"', async () => {
  for (const bad of [null, undefined, 42, 'ok']) {
    const { fill } = scriptedFill([bad])
    const { runFillLoop } = await internals()
    const out = await runFillLoop({ fill })
    assert.equal(out.kind, 'failed', `${String(bad)} 不该被当成正常应答`)
    assert.ok(out.error instanceof Error)
  }
})

test('循环：缺 covered 时不误判为"停在原地"', async () => {
  // 服务端没回 covered 时 `nowAt` 是 null，兜底判据无从下手——此时应当
  // 依赖批次上限，而不是把第一批就误报成 stalled。
  const noCovered = { partial: true, elapsedMs: 10 }
  const { fill, calls } = scriptedFill([noCovered, { ...noCovered }, { ...noCovered, partial: false }])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill })

  assert.equal(out.kind, 'done')
  assert.equal(calls.length, 3)
})

// ---------------------------------------------------------------- 进度

test('循环：每批之后报一次进度，最后一批就是终态', async () => {
  const { fill } = scriptedFill([
    batch({ last: 240, remaining: 900, elapsedMs: 700 }),
    batch({ first: 1, last: 480, remaining: 660, elapsedMs: 800 }),
    batch({ first: 1, last: 999, remaining: 0, partial: false, elapsedMs: 900 }),
  ])
  const { runFillLoop } = await internals()
  const seen = []
  await runFillLoop({ fill, onProgress: (p) => seen.push(p) })

  assert.equal(seen.length, 3, '每批一次，不多不少')
  assert.deepEqual(seen.map((p) => p.batches), [1, 2, 3])
  assert.deepEqual(seen.map((p) => p.remaining), [900, 660, 0])
  assert.deepEqual(seen.map((p) => p.elapsedMs), [700, 1500, 2400])
  assert.equal(seen.at(-1).covered.last, 999)
})

test('循环：maxBatches 给垃圾值时退回缺省，而不是变成"跑 0 批"', async () => {
  let last = 0
  const { fill, calls } = scriptedFill([() => {
    last += 100
    // 永远 partial：只能靠上限收手
    return batch({ last, remaining: 1 })
  }])
  const { runFillLoop } = await internals()
  const out = await runFillLoop({ fill, maxBatches: 0 })

  assert.equal(out.kind, 'capped')
  assert.equal(calls.length, 40, '缺省是 40；0 / 负数 / 非整数都不该让循环空转或立停')
})

// ---------------------------------------------------------------- 文案

test('文案：补完 / 没有缺口 / 停在原地 / 上限 / 失败，五种结局各说各的', async () => {
  const { fillOutcomeNotice } = await internals()

  const done = fillOutcomeNotice({
    kind: 'done', skipped: false, batches: 3, elapsedMs: 2400,
    covered: { first: 1, last: 999 }, remaining: 0,
  })
  assert.equal(done.kind, 'ok')
  assert.match(done.text, /第 1–999 章/)
  assert.match(done.text, /3 批/)

  const none = fillOutcomeNotice({
    kind: 'done', skipped: true, batches: 0, elapsedMs: 0, covered: { first: 1, last: 9 },
  })
  assert.equal(none.kind, 'ok')
  assert.match(none.text, /没有缺口/)

  const stalled = fillOutcomeNotice({
    kind: 'stalled', batches: 2, elapsedMs: 900, covered: { first: 1, last: 240 }, remaining: 900,
  })
  assert.equal(stalled.kind, 'error', '停在原地是异常，不能报成 ok')
  assert.match(stalled.text, /停在原地/)
  assert.match(stalled.text, /还剩 900 章/)

  const capped = fillOutcomeNotice({
    kind: 'capped', batches: 40, elapsedMs: 30000, covered: { first: 1, last: 9600 }, remaining: 400,
  })
  assert.equal(capped.kind, 'ok')
  assert.match(capped.text, /40 批/)
  assert.match(capped.text, /还剩 400 章/)
  assert.match(capped.text, /再点一次/)

  const failed = fillOutcomeNotice({ kind: 'failed', batches: 1, elapsedMs: 700, covered: null, error: new Error('网络炸了') })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /没完成/)
})

test('文案：失败与停住时**绝不说**"已纳入记忆"', async () => {
  // ⚠️ 这条是本轮的原始病灶。上一版无论补齐成没成，都无条件说"前文记忆已更新"。
  //    所以这里不看某一句怎么写，而是断言**一整类结局**都不许出现那句话。
  const { fillOutcomeNotice } = await internals()
  const bad = [
    { kind: 'failed', batches: 0, elapsedMs: 0, covered: null, error: new Error('炸了') },
    { kind: 'stalled', batches: 2, elapsedMs: 10, covered: { first: 1, last: 240 }, remaining: 900 },
    { kind: 'stalled', batches: 2, elapsedMs: 10, covered: null, remaining: null },
    { kind: 'failed', batches: 3, elapsedMs: 10, covered: { first: 1, last: 720 }, error: new Error('半路炸了') },
  ]
  for (const outcome of bad) {
    const notice = fillOutcomeNotice(outcome)
    assert.equal(notice.kind, 'error', `${outcome.kind} 应当报成错误`)
    assert.ok(!notice.text.includes('纳入记忆'), `不该说纳入记忆：${notice.text}`)
    assert.ok(notice.text.length > 0)
  }
})

test('文案：缺 covered 时也不崩，且照样给出可读的一句话', async () => {
  const { fillOutcomeNotice } = await internals()
  for (const covered of [null, undefined, {}, { first: 'x', last: 2 }]) {
    const done = fillOutcomeNotice({ kind: 'done', skipped: false, batches: 1, elapsedMs: 0, covered })
    assert.equal(done.kind, 'ok')
    assert.ok(done.text.length > 0)
    assert.ok(!done.text.includes('undefined'), `不该把 undefined 漏进文案：${done.text}`)
  }
})

// ------------------------------------------------- 接线（纯函数测试抓不到的那一类）

test('接线：组件真的用上了循环、停止、文案与进度', async () => {
  // ⚠️ 为什么非要有静态断言：上面每一条都在测**纯函数**。把调用处换回
  //    一次性 `callApi(...).then(...)`，纯函数测试**仍然全绿**，而循环、
  //    停止、进度就全都没了。`runFillLoop` 写对了但没接线，跟没写是一样的。
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

  assert.ok(source.includes('runFillLoop({'), 'runFillLoop 没有被调用')
  assert.ok(source.includes('fillOutcomeNotice(outcome)'), 'fillOutcomeNotice 没有被调用')
  assert.ok(source.includes('onProgress:'), '没有把进度回调接上去，读者就看不到进度')
  assert.ok(source.includes('fillRunRef.current += 1'), 'cancelFill 没有让飞行中的那一趟失效')
  assert.ok(source.includes('setFillProgress(progress)'), '进度没有进 state')

  // 主按钮在补齐中必须变成「停止」——否则循环十几分钟没有出口。
  assert.ok(
    source.includes('if (filling) cancelFill(); else fillBackground()'),
    '主按钮没有接上「停止」',
  )
  assert.ok(
    !source.includes('disabled: filling || background?.gap === null'),
    '主按钮在补齐中被禁用了——那样「停止」永远点不到',
  )
})
