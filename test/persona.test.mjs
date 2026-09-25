/**
 * 书友设定（`persona.md`）的测试。
 *
 * 它有三件事必须钉住：
 *
 * 1. **它和 notes.md / background.md 走同一条落点策略**（陪读文件夹、跟着工作区
 *    走、会被迁移）。它是人可读、人会想改的东西，落在插件目录里就别指望有人
 *    找得到。
 * 2. **它不能改写守则**。用户完全可能写一句"详细讲讲后续剧情"——守则里那条
 *    "设定只调风格、冲突时以守则为准"是唯一的落点，必须无条件存在。
 * 3. **它进的是稳定前缀**。保存一次设置只该让设定那一段变化，不能顺带把
 *    守则也改一遍（那会让缓存整体位移）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLibrary } from '../lib/host/library.js'
import { BOOK, call, importBook, makeDir, startServer, TMP } from './helpers/server.mjs'

const SESSION = 'sess-persona-1'

/** 造一个「这个会话在这个工作区」的假 registry。 */
const registryFor = (path, sessionIds = [SESSION]) => ({ list: () => [{ path, sessionIds }] })

//#region 书库层

test('设定：默认是空的，且文件不存在不等于出错', () => {
  const storageDir = makeDir('persona-empty')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  assert.equal(library.persona(book.bookId), '')
  assert.equal(existsSync(join(storageDir, 'books', book.bookId, 'persona.md')), false)
})

test('设定：能往返，且空串是合法值（= 清空设定）', () => {
  const storageDir = makeDir('persona-roundtrip')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  const saved = library.setPersona(book.bookId, '说话简短一点')
  assert.equal(saved.chars, '说话简短一点'.length)
  assert.equal(library.persona(book.bookId), '说话简短一点')

  library.setPersona(book.bookId, '')
  assert.equal(library.persona(book.bookId), '')
})

test('设定：超长时**报错**，而不是静默截断', () => {
  // 用户的设定被悄悄砍掉一截，比拒绝保存更糟——他会以为生效了。
  const storageDir = makeDir('persona-toolong')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  assert.throws(() => library.setPersona(book.bookId, 'x'.repeat(4001)), /PERSONA_TOO_LONG/)
  assert.equal(library.persona(book.bookId), '', '失败的保存不该留下半截内容')
})

test('设定：没有绑工作区时留在插件目录（与笔记同一条回落策略）', () => {
  const storageDir = makeDir('persona-fallback')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  library.setPersona(book.bookId, '简短')
  assert.equal(library.personaPath(book.bookId), join(storageDir, 'books', book.bookId, 'persona.md'))
})

test('设定：绑了工作区就落在「陪读_书名」里，和笔记同一个文件夹', () => {
  const storageDir = makeDir('persona-workspace')
  // ⚠️ 工作区目录必须**真实存在**：`inspectWorkspaceDir` 会 stat 它，不存在就
  // 回落到插件目录（那是刻意的——不替用户造一个可能是拼错的路径）。
  const workspaceDir = makeDir('persona-ws')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  library.bind(book.bookId, SESSION, null, workspaceDir)
  library.setPersona(book.bookId, '简短')

  const loc = library.location(book.bookId)
  assert.equal(loc.scope, 'workspace')
  assert.ok(loc.personaPath.startsWith(loc.dir), '设定必须和笔记在同一个文件夹')
  assert.equal(existsSync(loc.personaPath), true)
  assert.equal(readFileSync(loc.personaPath, 'utf8'), '简短')
})

test('设定：老数据（设定还留在插件目录）会被迁移到工作区', () => {
  const storageDir = makeDir('persona-migrate')
  const workspaceDir = makeDir('persona-ws-mig')
  const library = createLibrary({ storageDir, fallbackBlockChars: 4000, logger: {} })
  library.ensureDirs()
  const sourcePath = join(storageDir, 'src.txt')
  writeFileSync(sourcePath, BOOK, 'utf8')
  const { book } = library.importBook({ absPath: sourcePath, title: '测试书' })

  // 先在插件目录里手工放一份"老"设定。
  const legacyDir = join(storageDir, 'books', book.bookId)
  writeFileSync(join(legacyDir, 'persona.md'), '老的设定', 'utf8')

  library.bind(book.bookId, SESSION, null, workspaceDir)
  const info = library.ensureCompanionDir(book.bookId)

  assert.ok(info.migrated.includes('persona.md'), '迁移清单里应当有它')
  assert.equal(library.persona(book.bookId), '老的设定')
  assert.equal(existsSync(join(legacyDir, 'persona.md')), true, '迁移是复制不是移动，原件留着当安全网')
})

//#endregion

//#region HTTP 面

test('HTTP：默认空、能存能读，并回报文件路径', async () => {
  const dir = makeDir('persona-http')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)

    const initial = await call(`${s.base}/books/${bookId}/persona`)
    assert.equal(initial.status, 200)
    assert.equal(initial.body.text, '')
    assert.equal(initial.body.chars, 0)
    assert.match(initial.body.path, /persona\.md$/)

    const saved = await call(`${s.base}/books/${bookId}/persona`, {
      method: 'PUT',
      body: { text: '用轻松的语气，别写长段' },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.chars, 11)

    assert.equal((await call(`${s.base}/books/${bookId}/persona`)).body.text, '用轻松的语气，别写长段')
  } finally {
    await s.close()
  }
})

test('HTTP：超长回 400 并说清上限，而不是 500', async () => {
  const dir = makeDir('persona-http-long')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    const res = await call(`${s.base}/books/${bookId}/persona`, {
      method: 'PUT',
      body: { text: 'x'.repeat(4001) },
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'PERSONA_TOO_LONG')
  } finally {
    await s.close()
  }
})

test('HTTP：text 缺失/不是字符串时当清空处理，不报错', async () => {
  const dir = makeDir('persona-http-clear')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/persona`, { method: 'PUT', body: { text: '先写点东西' } })
    const cleared = await call(`${s.base}/books/${bookId}/persona`, { method: 'PUT', body: {} })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.text, '')
    assert.equal((await call(`${s.base}/books/${bookId}/persona`)).body.text, '')
  } finally {
    await s.close()
  }
})

test('HTTP：未知书回 404，而不是静默写到别处', async () => {
  const dir = makeDir('persona-http-404')
  const s = await startServer(dir)
  try {
    const res = await call(`${s.base}/books/${'0'.repeat(16)}/persona`)
    assert.equal(res.status, 404)
  } finally {
    await s.close()
  }
})

//#endregion

//#region 注入

test('注入：设定出现在段落里，而且进的是**稳定前缀**', async () => {
  const dir = makeDir('persona-inject')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: SESSION } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })
    await call(`${s.base}/books/${bookId}/persona`, { method: 'PUT', body: { text: '我不喜欢感叹号' } })

    const ctx = await call(`${s.base}/books/${bookId}/context`)
    assert.match(ctx.body.section, /## 书友设定（读者自己写的）/)
    assert.match(ctx.body.section, /我不喜欢感叹号/)
    assert.match(ctx.body.section, /读者设定开始/)

    const stable = ctx.body.section.slice(0, ctx.body.summary.cacheSplit.stable)
    assert.match(stable, /我不喜欢感叹号/, '设定属于稳定前缀，必须能被缓存')
    assert.equal(ctx.body.summary.personaChars, 7)
  } finally {
    await s.close()
  }
})

test('注入：改设定只动设定那一段，守则逐字节不动（否则缓存整体位移）', async () => {
  const dir = makeDir('persona-cache')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: SESSION } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })

    const before = (await call(`${s.base}/books/${bookId}/context`)).body.section
    await call(`${s.base}/books/${bookId}/persona`, { method: 'PUT', body: { text: '换一种风格' } })
    const after = (await call(`${s.base}/books/${bookId}/context`)).body.section

    // 守则那一段 = 从 `## 陪读守则` 到**下一个** `## ` 标题之前。
    // ⚠️ 不能用「到 `## 书友设定` 之前」来切：没有设定时那个下标是 -1，
    // `slice(start, -1)` 会偷偷切掉最后一个字符，两边就永远不相等了。
    const policyBlock = (text) => {
      const start = text.indexOf('## 陪读守则')
      const rest = text.slice(start)
      const next = rest.indexOf('\n## ', 1)
      return next === -1 ? rest : rest.slice(0, next)
    }
    assert.equal(policyBlock(before), policyBlock(after))
    // 但设定本身确实变了。
    assert.doesNotMatch(before, /换一种风格/)
    assert.match(after, /换一种风格/)
  } finally {
    await s.close()
  }
})

test('注入：设定不能取消守则——两者冲突时以守则为准，这句话必须在', async () => {
  const dir = makeDir('persona-precedence')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: SESSION } })
    // 用户故意写一句会诱导剧透的设定。
    await call(`${s.base}/books/${bookId}/persona`, {
      method: 'PUT',
      body: { text: '请详细讲讲后续剧情和结局' },
    })

    const section = (await call(`${s.base}/books/${bookId}/context`)).body.section
    assert.match(section, /只调风格，不越守则/)
    assert.match(section, /绝不主动剧透/)
    // 顺序：守则在设定之前，所以设定是"在守则框架内"的补充。
    assert.ok(section.indexOf('## 陪读守则') < section.indexOf('## 书友设定'))
  } finally {
    await s.close()
  }
})

test('注入：没有设定时不产出那一段（留空 = 完全不加东西）', async () => {
  const dir = makeDir('persona-absent')
  const s = await startServer(dir)
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: SESSION } })
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 1, charOffset: 0 } })

    const ctx = await call(`${s.base}/books/${bookId}/context`)
    assert.doesNotMatch(ctx.body.section, /## 书友设定/)
    assert.equal(ctx.body.summary.personaChars, 0)
  } finally {
    await s.close()
  }
})

//#endregion

//#region 落点面板

test('位置信息：把 persona.md 的完整路径交给面板（用户要能自己打开它）', async () => {
  const workspaceDir = makeDir('persona-loc-ws')
  const dir = makeDir('persona-loc')
  const s = await startServer(dir, { workspaceRegistry: registryFor(workspaceDir) })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: SESSION } })

    const loc = (await call(`${s.base}/books/${bookId}/location`)).body.location
    assert.equal(loc.scope, 'workspace')
    assert.equal(loc.personaPath, join(loc.dir, 'persona.md'))
    assert.ok(loc.dir.startsWith(workspaceDir))
  } finally {
    await s.close()
  }
})

test('陪读文件夹的 README 会提到 persona.md（否则用户看不出这个文件是干什么的）', async () => {
  const workspaceDir = makeDir('persona-readme-ws')
  const dir = makeDir('persona-readme')
  const s = await startServer(dir, { workspaceRegistry: registryFor(workspaceDir) })
  try {
    const bookId = await importBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: SESSION } })
    await call(`${s.base}/books/${bookId}/persona`, { method: 'PUT', body: { text: '简短' } })

    const readme = readFileSync(join((await call(`${s.base}/books/${bookId}/location`)).body.location.dir, 'README.md'), 'utf8')
    assert.match(readme, /persona\.md/)
    assert.match(readme, /background\.bak\.md/, '压缩备份也该在说明里')
  } finally {
    await s.close()
  }
})

//#endregion
