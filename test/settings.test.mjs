/**
 * 运行期设置（P12）。
 *
 * 「陪读会话能不能联网」原先只能改 `cordis.yml` 再重启 —— 界面上的那行文字只
 * 显示当前档位，**没有任何写入路径**。这里钉住新的覆盖层，重点有四条：
 *
 *   1. **优先级**：界面设置 > `cordis.yml` > 已归一化的默认。三档要在同一条
 *      用例里走一遍，因为"设置压过配置"和"清除设置后回落"是两个方向的行为，
 *      只测一个方向的话，把 fallback 写反了照样全绿。
 *   2. **立即生效、不必重启**：这条刻意打在 `systemPrompt.section` 回调上
 *      （**真正投喂给模型的那一份**），而不是打在任何一条 HTTP 路由上 ——
 *      路由绿了不代表注入绿了，这是 `injection.test.mjs` 已经吃过一次的亏。
 *   3. **坏文件只会更严**：手动把 `settings.json` 改成乱码时回落到配置值。
 *      闸门是防剧透用的，配置笔误不该把它悄悄打开。
 *   4. **落点**：`settings.json` 和 `categories.json` 一样留在插件目录，
 *      不占用户的工作区 —— 它是机器配置，不是人读的笔记。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { call, importBook, makeDir, startServer } from './helpers/server.mjs'

const SESSION = 'sess-settings-0001'

/** 真正投喂给某一轮对话的那一段。 */
const injected = (s) => s.hooks.section.text({ agent: { session: { id: SESSION } } })

/**
 * 导入一本书、绑定会话、推到第 2 章。
 *
 * @param {string} base 服务器 base URL
 * @param {string} dir 书库目录
 * @returns {Promise<string>} bookId
 */
async function bindBook(base, dir) {
  const bookId = await importBook(base, dir)
  await call(`${base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: SESSION } })
  await call(`${base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
  return bookId
}

test('设置：没设过时 webGate 为 null，生效值跟随配置', async () => {
  const dir = makeDir('set-default')
  const s = await startServer(dir, { config: { webGate: 'off' } })
  try {
    const bookId = await bindBook(s.base, dir)
    const settings = await call(`${s.base}/settings`)

    assert.equal(settings.status, 200)
    assert.equal(settings.body.webGate, null, '没设过必须是 null（= 跟随配置），不能抄一份默认值进来')
    assert.equal(settings.body.configWebGate, 'off')
    assert.equal(settings.body.effectiveWebGate, 'off', '没设过时生效值就是配置值')
    assert.deepEqual(settings.body.modes, ['block-all', 'block-book', 'off'])
    assert.equal(settings.body.path, join(dir, 'settings.json'), '设置留在插件目录，不占工作区')

    // 面板读的是 /background（client.js 里的 `background?.webGate`）。
    const panel = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(panel.body.webGate, 'off', '面板拿到的必须是生效值，不是配置值')

    // 而真正要紧的是投喂给模型的那一份。
    assert.match(injected(s), /联网只用来查设定/, '档位是 off 时，守则应当说"可以联网查设定"')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置：界面改档位压过配置，且**不需要重启**就生效', async () => {
  const dir = makeDir('set-override')
  const s = await startServer(dir, { config: { webGate: 'off' } })
  try {
    const bookId = await bindBook(s.base, dir)
    assert.match(injected(s), /联网只用来查设定/, '前置：初始档位是 off')

    const saved = await call(`${s.base}/settings`, { method: 'PUT', body: { webGate: 'block-all' } })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.effectiveWebGate, 'block-all', '设置必须压过配置')
    assert.equal(saved.body.configWebGate, 'off', '配置值本身不该被改写')

    // ★ 关键：同一个进程、同一个服务器，**没有重启**。
    // 档位是在每次装配时现读的；一旦有人把它闭包捕获成常量，这两条会失败。
    // 而"改完没生效"在界面上看起来就像开关坏了。
    const after = injected(s)
    assert.match(after, /不要联网查这本书/, '改完档位必须立即改变注入内容')
    assert.doesNotMatch(after, /联网只用来查设定/, '旧档位的措辞必须消失')

    assert.equal(
      (await call(`${s.base}/books/${bookId}/background`)).body.webGate,
      'block-all',
      '面板也要跟着变',
    )

    // 顺带确认真的落盘了（否则重启就丢）。
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.equal(onDisk.webGate, 'block-all')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置：block-all 与 block-book 在提示词里措辞相同，区别只在工具闸', async () => {
  const dir = makeDir('set-two-modes')
  const s = await startServer(dir)
  try {
    await bindBook(s.base, dir)
    await call(`${s.base}/settings`, { method: 'PUT', body: { webGate: 'block-all' } })
    const all = injected(s)
    await call(`${s.base}/settings`, { method: 'PUT', body: { webGate: 'block-book' } })
    const book = injected(s)

    // 这两档的差别是"一律拒绝"vs"拦住看起来在查这本书的查询"，那是**工具闸**
    // 的严格程度，不是给模型的措辞。措辞相同是刻意的：模型两种情况下都该
    // "不要联网查这本书"。若哪天有人把两档的提示词也写成不同，这条会提醒他
    // 想清楚那是不是有意的。
    assert.equal(all, book, '两档在提示词里应当逐字相同')
    assert.match(book, /不要联网查这本书/)
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置：清除覆盖（null）后回落到配置值', async () => {
  const dir = makeDir('set-clear')
  const s = await startServer(dir, { config: { webGate: 'block-book' } })
  try {
    await call(`${s.base}/settings`, { method: 'PUT', body: { webGate: 'off' } })
    assert.equal((await call(`${s.base}/settings`)).body.effectiveWebGate, 'off')

    // 空串与 null 是同一件事：**清除覆盖**，不是"切到一个叫空串的档位"。
    const cleared = await call(`${s.base}/settings`, { method: 'PUT', body: { webGate: '' } })
    assert.equal(cleared.body.webGate, null)
    assert.equal(cleared.body.effectiveWebGate, 'block-book', '清除后必须回到配置值')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置：非法档位被拒，且不破坏已有的值', async () => {
  const dir = makeDir('set-invalid')
  const s = await startServer(dir)
  try {
    await call(`${s.base}/settings`, { method: 'PUT', body: { webGate: 'off' } })

    const bad = await call(`${s.base}/settings`, { method: 'PUT', body: { webGate: '随便写的' } })
    assert.equal(bad.status, 400, '非法档位必须是 4xx，不能 500')
    assert.equal(bad.body.error, 'WEB_GATE_INVALID')

    const still = await call(`${s.base}/settings`)
    assert.equal(still.body.webGate, 'off', '被拒的写入不该动到原来的值')
    assert.equal(still.body.effectiveWebGate, 'off')
    assert.equal(still.body.configWebGate, 'block-all', '默认配置仍是最严的那档')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置：手动改坏 settings.json 只会**回落**到配置，不会把闸门打开', async () => {
  const dir = makeDir('set-garbage')
  // 先正常写一个值，再把文件改成乱码，模拟用户手改出错。
  const first = await startServer(dir)
  try {
    await call(`${first.base}/settings`, { method: 'PUT', body: { webGate: 'off' } })
  } finally {
    await first.close()
  }
  writeFileSync(join(dir, 'settings.json'), '{ 这不是 JSON', 'utf8')

  // 重启（换个进程内实例），让它重新读盘。
  const s = await startServer(dir)
  try {
    const settings = await call(`${s.base}/settings`)
    // `readJson` 对损坏文件返回 fallback（null），于是"没设过"→ 跟随配置。
    assert.equal(settings.body.webGate, null, '坏文件应当当成"没设过"，而不是抛错')
    assert.equal(settings.body.effectiveWebGate, 'block-all', '配置值是最严的档，回落方向必须是安全的那一边')
    assert.equal((await call(`${s.base}/health`)).status, 200, '坏掉的设置文件不该让插件挂不上')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置：未知档位字符串住在文件里也不生效（读取时归一化）', async () => {
  const dir = makeDir('set-unknown')
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ schemaVersion: 1, webGate: 'block-everything' }),
    'utf8',
  )
  const s = await startServer(dir)
  try {
    const settings = await call(`${s.base}/settings`)
    assert.equal(settings.body.webGate, 'block-everything', '原样回显，方便用户看出自己写错了什么')
    assert.equal(settings.body.effectiveWebGate, 'block-all', '但生效值必须回落到配置')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置契约：抽样默认值就是当初约定的那几个数', async () => {
  const dir = makeDir('set-sample-defaults')
  const s = await startServer(dir)
  try {
    const health = await call(`${s.base}/health`)
    assert.equal(health.status, 200)
    const { sample, window: win } = health.body.config

    assert.equal(sample.budgetChars, 24000)
    // v1.25：**回退到 v1.24 之前的形状**——`lengthRatio: 0`（按预算均分）、
    // 下限回到绝对字数 100。回退理由是短章在比例模式下被截得比从前狠。
    // v2.0.2：**100 → 150**（读者选定）。它同时决定"一批最多吃多少章"
    // （`budgetChars ÷ minPerChapter`），所以一批从约 240 章降到约 160 章。
    assert.equal(sample.minPerChapter, 150)
    assert.equal(sample.maxPerChapter, 600)
    assert.equal(sample.lengthRatio, 0)
    // 这三条是读者逐条拍板的：首次批次 30 章、开头 5 章、加权 3 倍。
    assert.equal(sample.foundationChapters, 30)
    assert.equal(sample.emphasisChapters, 5)
    assert.equal(sample.emphasisFactor, 3)
    // 跳读闸的两个概念是**分开**的（v2.0.2）：阈值只管"要不要先问一句"，
    // 窗口管"最近这一段取多宽"；`recentMinPerChapter` 让那条路读得更厚。
    assert.equal(sample.jumpGateChapters, 50)
    assert.equal(sample.recentWindowChapters, 200)
    assert.equal(sample.recentMinPerChapter, 300)
    // 上一章默认只给尾部（v1.24）。
    assert.equal(win.previousChapterMode, 'tail')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
