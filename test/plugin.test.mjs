/**
 * 宿主半边的结构性契约与装配检查。
 *
 * 浏览器半边的契约在 test/client.test.mjs；这里只钉宿主这一侧：
 *  1. 导出符合 cordis 契约，且 patch 行 id 与 name 一致；
 *  2. package.json 的 `dsh` 字段是宿主发现插件的方式，不能被改坏；
 *  3. 路由以 prefix 形态注册、错误语义正确、config 覆盖真的生效。
 *
 * 任何一条被后续改动破坏，都会在这里当场炸掉，而不是等到真机上
 * "页签不见了"或"patch 里的配置被静默忽略"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 测试期落盘根目录：必须在工作区内，否则会被文件沙箱拒绝。 */
const TMP = join(ROOT, 'test', '.tmp')
const API_ROOT = '/dsh-reading-companion/api'
const PLUGIN_NAME = 'dsh-reading-companion'

/** 每次带不同的 query，绕开 ESM 模块缓存。 */
let loadSeq = 0
function freshUrl(rel) {
  loadSeq += 1
  return `${pathToFileURL(join(ROOT, rel)).href}?t=${loadSeq}`
}

function makeFakeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk.toString('utf8')
    },
  }
}

/** 记录路由注册与服务发布的宿主上下文替身。 */
function makeFakeHostContext() {
  const routes = []
  const services = {}
  const effects = []
  const sections = []
  const guards = []
  /** `ctx.on` 注册的监听器：卸载断言靠它证明订阅被摘掉了。 */
  const events = new Map()
  const ctx = {
    // 让 dshHomePath 指向测试目录：真实的默认值是 $DSH_HOME，
    // 那是工作区之外，测试既不该也无法在那里写。
    get: (name) => (name === 'dshHomePath' ? (...parts) => join(TMP, ...parts) : undefined),
    /**
     * 宿主事件订阅（背景更新 T1-② 的唯一入口）。
     *
     * 与 systemPrompt / tools 一样返回**真的会摘掉自己**的 disposer——否则
     * 「卸载是否干净」那条断言会漏掉本插件新开的这一条订阅。
     */
    on(event, listener) {
      if (!events.has(event)) events.set(event, new Set())
      events.get(event).add(listener)
      return () => {
        events.get(event)?.delete(listener)
      }
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    provide(name, value) {
      services[name] = value
      return () => {
        delete services[name]
      }
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    // P2 的两个防剧透挂点。真实宿主会返回 disposer，这里同样返回，
    // 否则「卸载是否干净」这条断言就测不到东西。
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {
          const at = sections.indexOf(spec)
          if (at !== -1) sections.splice(at, 1)
        }
      },
    },
    tools: {
      guard(guard) {
        guards.push(guard)
        return () => {
          const at = guards.indexOf(guard)
          if (at !== -1) guards.splice(at, 1)
        }
      },
    },
    logger: {},
  }
  return { ctx, routes, services, effects, sections, guards, events }
}

test('宿主半边：导出符合 cordis 契约，且插件名与 patch 行 id 一致', async () => {
  const host = await import(freshUrl('lib/index.js'))

  assert.equal(host.name, PLUGIN_NAME, 'name 必须与 cordis.patch.yml 的行 id 一致')
  assert.ok(Array.isArray(host.inject), 'inject 必须是数组')
  assert.ok(host.inject.includes('webServer'), '宿主半边需要 webServer')
  // 这两个是 P2 的防剧透挂点：少任何一个，插件应当等待而不是静默失去防护。
  assert.ok(host.inject.includes('systemPrompt'), '防剧透正向：按进度投喂')
  assert.ok(host.inject.includes('tools'), '防剧透反向：工具闸')
  assert.equal(typeof host.apply, 'function')

  // patch 行 id 必须等于 name，否则装配出的行解析不到实现。
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`id:\\s*'${PLUGIN_NAME}'`))
  assert.match(patch, new RegExp(`name:\\s*'${PLUGIN_NAME}'`))
})

test('宿主半边：package.json 的 dsh 字段是宿主发现插件的方式', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  assert.equal(pkg.name, PLUGIN_NAME, '包名必须与插件名一致')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.main, './lib/index.js')
  // 浏览器半边的模块 id 必须等于包名，否则 <pkg> 与 <pkg>/client 不会归一。
  assert.ok(pkg.files.includes('lib'), 'lib 必须随包发布')
})

test('宿主半边：注册 prefix 路由并正确响应 /health', async () => {
  const host = await import(freshUrl('lib/index.js'))
  const { ctx, routes } = makeFakeHostContext()

  host.apply(ctx, {})

  assert.equal(routes.length, 1, '只注册一条 prefix 路由')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, API_ROOT)
  assert.equal(typeof routes[0].handler, 'function')

  const res = makeFakeResponse()
  await routes[0].handler({ url: `${API_ROOT}/health`, method: 'GET' }, res)

  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.name, PLUGIN_NAME)
  // 曾经断言 `body.phase === 'P2'`（开发阶段标签，早已过期）。改成版本一致性契约。
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(body.version, pkg.version, '版本必须与 package.json 一致')
  assert.equal(typeof body.storageDir, 'string')
})

test('宿主半边：apply 会发布 readingCompanion 服务并建好书库目录', async () => {
  const host = await import(freshUrl('lib/index.js'))
  const { ctx, services, effects, sections, guards } = makeFakeHostContext()

  host.apply(ctx, {})

  assert.ok(services.readingCompanion, '未来的子插件与脚本要靠它')
  const { library } = services.readingCompanion
  assert.equal(typeof library.bookForSession, 'function', '防剧透链路的入口')
  assert.equal(typeof library.collectReadWindow, 'function', '正向投喂的唯一来源')
  assert.equal(typeof library.importBook, 'function')

  // 两个防剧透挂点都必须真的挂上。
  assert.equal(sections.length, 1, '必须注册且只注册一个 system 段落')
  assert.equal(sections[0].name, 'dsh-reading-companion:companion')
  assert.equal(typeof sections[0].text, 'function')
  assert.equal(guards.length, 1, '必须注册且只注册一个工具闸')

  // 路由 + 服务 + 段落 + 工具闸 + 背景更新订阅，五个 effect 都必须可卸载。
  assert.equal(effects.length, 5)
  for (const entry of effects) {
    assert.equal(typeof entry.dispose, 'function', `effect「${entry.label}」必须可卸载`)
  }
})

test('宿主半边：非陪读会话拿到空段落（全局注册必须自我否决）', async () => {
  const host = await import(freshUrl('lib/index.js'))
  const { ctx, sections } = makeFakeHostContext()
  host.apply(ctx, {})

  const text = sections[0].text
  // 没有 agent、agent 无 session、会话未绑定 —— 三种都必须回空串，
  // 否则全局注册的段落会污染用户所有正常会话。
  assert.equal(text({}), '')
  assert.equal(text({ agent: {} }), '')
  assert.equal(text({ agent: { id: 'not-bound-session' } }), '')
  assert.equal(text({ agent: { session: { id: 'not-bound-session' } } }), '')
})

test('宿主半边：段落回调永不抛错（抛错会毁掉整次 prompt 装配）', async () => {
  const host = await import(freshUrl('lib/index.js'))
  const { ctx, sections, services } = makeFakeHostContext()
  host.apply(ctx, {})

  // 强行让书库查询爆炸，段落回调必须吞掉异常并退回空串。
  services.readingCompanion.library.bookForSession = () => {
    throw new Error('boom')
  }
  assert.equal(sections[0].text({ agent: { session: { id: 'x' } } }), '')
})

test('宿主半边：未知路由回 404，且不泄漏内部细节', async () => {
  const host = await import(freshUrl('lib/index.js'))
  const { ctx, routes } = makeFakeHostContext()
  host.apply(ctx, {})

  const res = makeFakeResponse()
  await routes[0].handler({ url: `${API_ROOT}/nope`, method: 'GET' }, res)
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.body).error, 'NOT_FOUND')
})

test('宿主半边：config 覆盖生效（patch 里的值不会被静默忽略）', async () => {
  const host = await import(freshUrl('lib/index.js'))
  const { ctx, routes } = makeFakeHostContext()
  const customDir = join(TMP, 'custom-books')
  host.apply(ctx, { storageDir: customDir, fallbackBlockChars: 1234 })

  const res = makeFakeResponse()
  await routes[0].handler({ url: `${API_ROOT}/health`, method: 'GET' }, res)
  const body = JSON.parse(res.body)

  assert.equal(body.storageDir, customDir)
  assert.equal(body.config.fallbackBlockChars, 1234)
  // 未覆盖的键要回落到默认值。
  assert.equal(body.config.inboxDir, 'inbox')
})

test('宿主半边：卸载后路由与服务都摘掉（低破坏性）', async () => {
  const host = await import(freshUrl('lib/index.js'))
  const { ctx, services, effects, events } = makeFakeHostContext()
  host.apply(ctx, {})

  assert.ok(services.readingCompanion)
  assert.ok((events.get('session/event')?.size ?? 0) > 0, '背景更新订阅必须挂上')
  for (const entry of effects) entry.dispose()
  assert.equal(services.readingCompanion, undefined, '卸载必须摘掉服务，不能留悬挂引用')
  // 订阅也要摘干净：留下悬挂监听器意味着插件停用之后仍在吃每一条会话事件。
  assert.equal(events.get('session/event')?.size ?? 0, 0, '卸载必须摘掉 session/event 订阅')
})
