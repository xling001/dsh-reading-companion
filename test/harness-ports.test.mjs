/**
 * 测试夹具的端口护栏。
 *
 * ## 这条测试为什么存在
 *
 * 本仓库曾经有一条**每次全量跑都可能随机出现、而且与当次改动毫无关系**的红：
 * HTTP 用例报 `TypeError: fetch failed` + cause `Error: bad port`。
 * CONTRIBUTING 把它记为"成因仍未定位"，并建议试 `--test-concurrency=1`。
 *
 * 根因**不是并发，是端口号本身**：
 *
 *   1. `fetch`（undici）按 Fetch 规范在**客户端**拒绝一批端口，抛 `bad port`
 *      ——**即使服务端确实监听成功了**。`6665–6669` 是**五个连续**端口。
 *   2. Windows 是**顺序分配**临时端口的（实测连起 40 个 server → 41227、41228、…）。
 *   3. 临时端口区间默认 49152–65535，但**可以被配置成从 1024 起**
 *      （`netsh int ipv4 show dynamicport tcp` → `Start Port: 1024 / Number: 58977`
 *      就是这么一台机器），于是区间里出现了 6000、6566、6665–6669、6679、6697、10080。
 *
 * 于是端口指针每跑一次全量就往上走几十个：**扫过 6665–6669 那一段时，一次跑连红
 * 五条以上；走过去了就连续多次全绿**。这正好解释"偶发一两条 / 一次 14 条 /
 * 紧接着 6 次 fail=0"。
 *
 * `--test-concurrency=1` 看起来"修好了"，其实只是**刚好没踩到**：`listen(0)` 的
 * 次数与分配到的端口序列几乎没变。真正的修法是 `listenOnSafePort`：拿到端口后
 * 复检，命中禁用集合就关掉重来。
 *
 * ## 第三条测试红了怎么办
 *
 * 它钉的是**平台的既有行为**，也就是当初那条红的现象本身。若它某天变红，说明
 * Node 不再按 Fetch 规范拦这些端口——那护栏和这条测试都可以一起删掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { FETCH_BLOCKED_PORTS, listenOnSafePort } from './helpers/server.mjs'

test('端口护栏：清单覆盖了那几个"一连五个"的高危端口', () => {
  // 6665–6669 连续五个 —— 这是"一次跑红一片"的直接原因，必须一个不漏。
  for (let port = 6665; port <= 6669; port += 1) {
    assert.ok(FETCH_BLOCKED_PORTS.has(port), `${port} 必须在禁用清单里`)
  }
  assert.ok(FETCH_BLOCKED_PORTS.has(6000), '6000 在动态区间内且是禁用端口')
  assert.ok(FETCH_BLOCKED_PORTS.has(10080), '10080 同理')
  // 常用端口不能被误伤，否则夹具会在正常端口上死循环。
  for (const safe of [3000, 8080, 43120]) {
    assert.equal(FETCH_BLOCKED_PORTS.has(safe), false, `${safe} 不该在禁用清单里`)
  }
})

test('端口护栏：listenOnSafePort 给出的端口真的能被 fetch 访问', async () => {
  const server = createServer((req, res) => res.end('ok'))
  try {
    const port = await listenOnSafePort(server)
    assert.equal(FETCH_BLOCKED_PORTS.has(port), false, '拿到的端口不能是禁用端口')
    const res = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'ok')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('端口护栏：监听成功的 6665，fetch 依然访问不到（这就是当初那条红）', async (t) => {
  const server = createServer((req, res) => res.end('ok'))
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(6665, '127.0.0.1', resolve)
    })
  } catch {
    t.skip('6665 已被占用，跳过')
    return
  }
  try {
    // 服务端**确实在监听**——所以问题不在我们起的 server，而在 fetch 这一侧。
    assert.equal(server.address().port, 6665)
    await assert.rejects(
      () => fetch('http://127.0.0.1:6665/'),
      (error) => String(error?.cause?.message ?? error?.message).includes('bad port'),
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
