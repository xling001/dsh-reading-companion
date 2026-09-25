/**
 * 真实 cordis 集成测试（可选）。
 *
 * 前面那些测试都用**手写的宿主替身**。替身能钉住我们自己的契约，但钉不住
 * 一件事：**宿主的真实服务到底接不接受我们的用法**。inject 名字写错、
 * `section()` 的 spec 形状不对、`guard()` 的返回值语义理解错——这些都只有
 * 在真 cordis 上装一遍才会暴露，而它们的表现是**插件静默地永远等待**
 * （inject 解析不了就不 apply），连日志都不会有。
 *
 * 所以这里直接把真实的 `@deepseek-ai/cordis` + `dsh-system-prompt` +
 * `dsh-tools` 装起来，再把本插件挂上去，断言：
 *   1. inject 三个名字全部解析（apply 真的跑到了）；
 *   2. `systemPrompt.assemble()` 在**绑定会话**上产出我们的段落，
 *      在未绑定会话上不产出；
 *   3. `tools.guardReason()` 对指向书籍原始文本的调用给出拒绝，
 *      对无关路径放行。
 *
 * 它依赖本机的 DSH 安装路径，所以在别人的机器上会**跳过**而不是失败——
 * 开源仓库里不能因为"没装 DSH"就变红。路径按这个顺序解析：
 *
 *   1. 环境变量 `DSH_APP_NODE_MODULES`（指向 node_modules 根）
 *   2. `test/.dsh-app-path` 的第一行（**不入库**，见 .gitignore）
 *   3. 桌面版几个常见安装位置
 *
 * 都找不到就跳过。**这里刻意不写死某一个盘符**：那是开发者的机器布局，
 * 不该成为公开仓库的一部分。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TMP_ROOT = join(HERE, '.tmp')

/** 放本机路径的地方。一行，指向 node_modules 根；这个文件不提交。 */
const LOCAL_APP_FILE = join(HERE, '.dsh-app-path')

/** 桌面版常见的安装根，顺序即优先级。 */
const DSH_APP_ROOTS = [
  'C:/Program Files/DSH Desktop/resources/app',
  'C:/Program Files (x86)/DSH Desktop/resources/app',
  join(homedir(), 'AppData/Local/Programs/DSH Desktop/resources/app'),
  '/Applications/DSH Desktop.app/Contents/Resources/app',
  '/opt/DSH Desktop/resources/app',
]

/** DSH 安装里的 node_modules 根。 */
const DSH_APP = resolveDshApp()

function resolveDshApp() {
  const explicit = process.env.DSH_APP_NODE_MODULES
  if (explicit !== undefined && explicit !== '') return explicit

  try {
    const local = readFileSync(LOCAL_APP_FILE, 'utf8').trim()
    if (local !== '') return local
  } catch {
    // 没有这个文件是常态，不是错误。
  }

  for (const root of DSH_APP_ROOTS) {
    const candidate = join(root, 'node_modules')
    if (existsSync(join(candidate, '@deepseek-ai'))) return candidate
  }
  // 一个都不在：返回一个必然不存在的路径，让下面的 import 失败并走 skip 分支。
  return join(DSH_APP_ROOTS[0], 'node_modules')
}

/** 从 DSH 安装里按绝对路径加载一个官方包。 */
const loadFromDsh = (rel) => import(pathToFileURL(`${DSH_APP}/@deepseek-ai/${rel}`).href)

test('真实宿主：workspaceRegistry 包的形状没变（笔记落点依赖它）', async (t) => {
  let mod
  try {
    mod = await loadFromDsh('dsh-workspace/lib/index.js')
  } catch {
    t.skip(`未找到 DSH 的 dsh-workspace（${DSH_APP}），跳过`)
    return
  }

  // 笔记能不能落到会话工作区，全靠这个服务：`super(ctx, "workspaceRegistry")`
  // 加一个同步的 `list()`（返回的实体带 `path` 与已按 cwd 索引过滤的
  // `sessionIds`）。包一旦改名或换导出，这里立刻变红——而不是等用户发现
  // 笔记莫名其妙落在别处。
  assert.equal(typeof mod.WorkspaceRegistry, 'function', 'WorkspaceRegistry 必须仍然导出')
  assert.ok(mod.default !== undefined, '默认导出应当存在（宿主按它装配）')

  // 服务名是我们读取它的唯一凭据，单独钉一次。
  const source = readFileSync(join(DSH_APP, '@deepseek-ai', 'dsh-workspace', 'lib', 'index.js'), 'utf8')
  assert.match(source, /super\(ctx,\s*"workspaceRegistry"\)/, '服务名变了 —— workspaceDirForSession 会静默失效')
  assert.match(source, /\blist\(\)\s*\{/, 'list() 不见了 —— 宿主侧解析工作区的入口')
})

/**
 * 尝试加载真实的宿主依赖。
 *
 * @returns {Promise<object|null>} 加载失败（本机没有 DSH）时回 null
 */
async function loadRealHost() {
  try {
    const { Context } = await loadFromDsh('cordis/lib/index.js')
    const { SystemPrompt, renderPrompt } = await loadFromDsh('dsh-system-prompt/lib/index.js')
    const { ToolRuntime } = await loadFromDsh('dsh-tools/lib/index.js')
    return { Context, SystemPrompt, ToolRuntime, renderPrompt }
  } catch {
    return null
  }
}

/** 等 apply 与 service 发布落地。cordis 的装配是异步的。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

const PROSE = '他记得那天的雪落得很慢，像有人在半空里把时间掰开了一点点，然后一片一片地放下。天光从瓦缝里漏下来。'

test('真实 cordis：插件能在真宿主服务上装配，且三个 inject 全部解析', async (t) => {
  const real = await loadRealHost()
  if (real === null) {
    t.skip(`未找到 DSH 安装（${DSH_APP}），跳过真实 cordis 集成测试`)
    return
  }

  const dir = join(TMP_ROOT, `cordis-${process.pid}-${Date.now()}`)
  mkdirSync(join(dir, 'inbox'), { recursive: true })

  const ctx = new real.Context()
  ctx.provide('webServer', { register: () => () => {} })
  ctx.plugin(real.SystemPrompt, {})
  ctx.plugin(real.ToolRuntime, {})

  const plugin = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)

  let mounted = null
  // cordis 只在 inject 全部解析后才会跑 apply —— 所以这个插件能 apply，
  // 本身就证明了三个服务名写对了。
  ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { storageDir: dir, fallbackBlockChars: 1000 })

  // 下游插件拿服务面：服务由插件自己的 fiber 提供，父 ctx 看不见，必须 inject。
  ctx.plugin({
    name: 'dsh-reading-companion-test-capture',
    inject: ['readingCompanion', 'systemPrompt', 'tools'],
    apply(c) {
      mounted = { service: c.readingCompanion, ctx: c }
    },
  })

  await settle()

  try {
    assert.ok(mounted !== null, 'apply 没有跑到 —— 多半是某个 inject 名字与实际服务名不符（会表现为插件静默等待）')
    assert.equal(typeof mounted.service.library.importBook, 'function')
    assert.equal(typeof mounted.ctx.systemPrompt.assemble, 'function', '真宿主必须提供 assemble')
    assert.equal(typeof mounted.ctx.tools.guardReason, 'function', '真宿主必须提供 guardReason')

    // ---- 造一本真书并绑定会话 ----
    const sourcePath = join(dir, '夜行.txt')
    writeFileSync(sourcePath, Buffer.from([
      '第一章 雪', PROSE, '',
      '第二章 夜', PROSE.replace(/雪/g, '风'), '',
      '第三章 归', PROSE.replace(/雪/g, '灯'), '',
    ].join('\n'), 'utf8'))

    const { book } = mounted.service.library.importBook({ absPath: sourcePath, title: '夜行' })
    mounted.service.library.setProgress(book.bookId, { chapterIndex: 1, charOffset: 30 })
    mounted.service.library.bind(book.bookId, 'session-bound')

    // ---- 段落：绑定会话必须产出，未绑定会话必须不产出 ----
    const boundAgent = { id: 'session-bound', session: { id: 'session-bound' } }
    const assembly = await mounted.ctx.systemPrompt.assemble({ agent: boundAgent, scope: boundAgent })
    const text = real.renderPrompt(assembly)

    assert.match(text, /本地阅读陪读/, '真宿主装配结果里应当出现我们的段落')
    assert.match(text, /陪读守则/, '守则必须在')
    assert.match(text, /book-excerpt trust="untrusted"/, '正文必须被信封包住')
    // 章标签优先用书自己的编号：索引 1 的标题是「第二章 夜」，
    // 所以段落里应当是「第二章 夜」而不是我们自己拼的「第 2 章」。
    assert.match(text, /第二章 夜/, '应当给出当前章，且用书自己的编号')

    // 关键：把整段 prompt 当纯文本看，不能出现尚未读到的第三章正文。
    assert.ok(
      !text.includes('灯'),
      '第三章的正文（替换成了「灯」）泄漏进了 prompt —— 防剧透失效',
    )

    const otherAgent = { id: 'session-other', session: { id: 'session-other' } }
    const otherAssembly = await mounted.ctx.systemPrompt.assemble({ agent: otherAgent, scope: otherAgent })
    const otherText = real.renderPrompt(otherAssembly)
    assert.ok(!otherText.includes('本地阅读陪读'), '未绑定会话不该拿到陪读段落')

    // ---- 工具闸：真宿主上的 guardReason ----
    const bookPath = join(dir, 'books', book.bookId, 'content.txt')
    const denied = mounted.ctx.tools.guardReason({ name: 'read', arguments: { file_path: bookPath } })
    assert.ok(typeof denied === 'string' && denied.length > 0, '指向 content.txt 的读取必须被拒绝')
    assert.match(denied, /原始文本/)

    const allowed = mounted.ctx.tools.guardReason({ name: 'read', arguments: { file_path: join(dir, 'unrelated.md') } })
    assert.equal(allowed, undefined, '无关路径必须放行')

    // 规则 B（一刀切工具黑名单）**已被刻意移除**：读者的诉求是"别剧透"，
    // 不是"别用工具"。所以陪读会话里 bash 现在是**放行**的——这里把这条
    // 反向断言钉住，防止哪天有人又把黑名单加回来。
    const bashAllowed = mounted.ctx.tools.guardReason({
      name: 'bash',
      arguments: {},
      agent: { id: 'session-bound', session: { id: 'session-bound' } },
    })
    assert.equal(bashAllowed, undefined, '陪读会话里普通工具不该被一刀切拦下（那会连查个史料都做不到）')

    // 取而代之的是联网闸：默认档位 block-all，陪读会话不能联网。
    const webBlocked = mounted.ctx.tools.guardReason({
      name: 'web_search',
      arguments: { query: '随便什么' },
      agent: { id: 'session-bound', session: { id: 'session-bound' } },
    })
    assert.ok(typeof webBlocked === 'string', '默认档位下陪读会话的联网必须被拦住')
    assert.match(webBlocked, /首次阅读防剧透/)

    // 非陪读会话不受联网闸影响 —— 你在别的会话里搜什么是你的自由。
    const webElsewhere = mounted.ctx.tools.guardReason({
      name: 'web_search',
      arguments: { query: '随便什么' },
      agent: { id: 'session-other', session: { id: 'session-other' } },
    })
    assert.equal(webElsewhere, undefined, '联网闸只该管陪读会话，不该锁死用户其它会话')
  } finally {
    await ctx.stop?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
