/**
 * 书架分类（P6）。
 *
 * 分类是**用户的主观归类**，不是从源文件派生的客观信息。这个区别决定了三个
 * 容易做错的地方，这里逐条钉住：
 *
 *   1. **存在哪**：独立于 `library.json`（书架索引）与书的 `meta.json`（sha、
 *      编码、章数 —— 全部可从源文件重算）。混进去会让"重导入时能不能覆盖
 *      meta"变成一个没有干净答案的问题。
 *   2. **空值语义**：空串 = **取消分类**，而不是"分到一个叫空字符串的类"。
 *      后者会在界面上变成一个点不中、也删不掉的空分组。
 *   3. **悬垂条目**：删掉一本书必须同时删掉它的分类，否则下拉里会多出一个
 *      永远分不进去的幽灵分类。
 *
 * 还有一条刻意**没有**维护的东西：分类清单。分类存在当且仅当至少有一本书
 * 属于它，所以"删掉最后一本书之后还留着一个空分类"这种状态根本不可能出现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLibrary } from '../lib/host/library.js'
import { BOOK, call, importBook, makeDir, startServer } from './helpers/server.mjs'

let seq = 0

/**
 * 建一个带若干本书的真书库。
 *
 * 每本书的正文都要**不一样**：`bookId` 取源文件 sha256 前 16 位，内容相同就
 * 会命中幂等导入、两本书变成同一本 —— 那样这组测试会静默退化成单书测试。
 *
 * @param {string} [tag] 目录名前缀
 * @param {string[]} [titles] 书名
 * @returns {{ dir: string, library: object, ids: string[] }}
 */
function makeLibrary(tag = 'cat', titles = ['甲书', '乙书', '丙书']) {
  seq += 1
  const dir = makeDir(`${tag}-${seq}`)
  const library = createLibrary({ storageDir: dir, logger: {} })
  library.ensureDirs()
  const ids = titles.map((title, index) => {
    const absPath = join(dir, `src-${index}-${title}.txt`)
    // 尾部加一句独一无二的话，只为让三份文件的 sha 不同。
    writeFileSync(absPath, `${BOOK}\n\n${title}独有的一句话。\n`, 'utf8')
    return library.importBook({ absPath, title }).book.bookId
  })
  assert.equal(new Set(ids).size, ids.length, '三本书的 bookId 撞了 —— 源文件内容没能区分开')
  return { dir, library, ids }
}

test('分类：没设过就是 null，list() 里也是 null', () => {
  const { dir, library, ids } = makeLibrary('default')
  try {
    assert.equal(library.categoryFor(ids[0]), null)
    const listed = library.list()
    assert.equal(listed.books.length, 3)
    for (const book of listed.books) {
      assert.equal(book.category, null, '没分过类的书必须是 null，而不是空串或 undefined')
    }
    assert.deepEqual(listed.categories, [], '没有任何分类时清单为空')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分类：设了能读回，list() 与 categories 都跟着变', () => {
  const { dir, library, ids } = makeLibrary('set')
  try {
    library.setCategory(ids[0], '武侠')
    library.setCategory(ids[1], '科幻')
    library.setCategory(ids[2], '武侠')

    assert.equal(library.categoryFor(ids[0]), '武侠')
    const listed = library.list()
    const byId = new Map(listed.books.map((book) => [book.bookId, book.category]))
    assert.equal(byId.get(ids[0]), '武侠')
    assert.equal(byId.get(ids[1]), '科幻')
    assert.deepEqual(listed.categories, ['科幻', '武侠'], '去重且按中文排序')
    assert.deepEqual(library.listCategories(), ['科幻', '武侠'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分类：空值 = 取消分类，不是"分到一个空名字的类"', () => {
  const { dir, library, ids } = makeLibrary('clear')
  try {
    library.setCategory(ids[0], '武侠')
    assert.equal(library.categoryFor(ids[0]), '武侠')

    for (const empty of ['', '   ', null, undefined, 123]) {
      const result = library.setCategory(ids[0], empty)
      assert.equal(result.category, null, `${JSON.stringify(empty)} 应当被理解成取消分类`)
      assert.equal(library.categoryFor(ids[0]), null)
    }
    assert.deepEqual(library.listCategories(), [], '取消之后不该留下空分类')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分类：名字会被 trim、剥掉控制字符、并截断到上限', () => {
  const { dir, library, ids } = makeLibrary('normalize')
  try {
    assert.equal(library.setCategory(ids[0], '  武侠  ').category, '武侠')
    assert.equal(library.setCategory(ids[1], '科\u0000幻\u001f').category, '科幻')
    const long = '长'.repeat(200)
    const result = library.setCategory(ids[2], long)
    assert.equal(result.category.length, 40, '超长分类名必须被截断，而不是把界面撑爆')
    assert.ok(long.startsWith(result.category), '截断应当是前缀，而不是重新拼一个字符串')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分类：给不存在的书设分类会报 BOOK_NOT_FOUND（路由层才能回 404）', () => {
  const { dir, library } = makeLibrary('missing')
  try {
    assert.throws(
      () => library.setCategory('0123456789abcdef', '武侠'),
      /BOOK_NOT_FOUND/,
    )
    // 形态非法要在进文件系统之前就被挡掉。
    assert.throws(() => library.setCategory('../../etc', '武侠'), /BOOK_ID_INVALID/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分类：删掉一本书会连它的分类一起删（不留幽灵分类）', () => {
  const { dir, library, ids } = makeLibrary('remove')
  try {
    library.setCategory(ids[0], '武侠')
    library.setCategory(ids[1], '科幻')
    assert.deepEqual(library.listCategories(), ['科幻', '武侠'])

    library.remove(ids[0])

    assert.deepEqual(
      library.listCategories(),
      ['科幻'],
      '删书之后「武侠」应当整个消失 —— 否则下拉里会多出一个永远分不进去的分类',
    )
    // 文件里也不该留下悬垂条目。
    const raw = JSON.parse(readFileSync(join(dir, 'categories.json'), 'utf8'))
    assert.equal(raw.assignments[ids[0]], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分类：写坏的分类文件不会让书架打不开', () => {
  const { dir, library, ids } = makeLibrary('corrupt')
  try {
    library.setCategory(ids[0], '武侠')
    // 用户拿笔记本来编辑这个文件，写成了别的东西。
    writeFileSync(join(dir, 'categories.json'), '{"assignments": "不是对象"}', 'utf8')
    const listed = library.list()
    assert.equal(listed.books.length, 3, '分类坏了也必须能列出书架')
    assert.equal(library.categoryFor(ids[0]), null, '坏数据回 null，而不是抛错')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

//#region 路由

test('路由：POST /library/:bookId/category 设置与取消，都要真的落盘', async () => {
  const dir = makeDir('cat-route')
  const server = await startServer(dir)
  try {
    const bookId = await importBook(server.base, dir, '分类书')

    const set = await call(`${server.base}/library/${bookId}/category`, {
      method: 'POST',
      body: { category: '武侠' },
    })
    assert.equal(set.status, 200)
    assert.deepEqual(set.body, { ok: true, bookId, category: '武侠' })

    const listed = await call(`${server.base}/library`)
    assert.equal(listed.body.books[0].category, '武侠')
    assert.deepEqual(listed.body.categories, ['武侠'])

    // 空串 = 取消分类（回「未分类」），不是"分到一个空名字的类"。
    const cleared = await call(`${server.base}/library/${bookId}/category`, {
      method: 'POST',
      body: { category: '' },
    })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.category, null)

    const after = await call(`${server.base}/library`)
    assert.equal(after.body.books[0].category, null)
    assert.deepEqual(after.body.categories, [])
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('路由：分类接口对坏 bookId 与不存在的书给出正确的状态码', async () => {
  const dir = makeDir('cat-route-err')
  const server = await startServer(dir)
  try {
    const missing = await call(`${server.base}/library/0123456789abcdef/category`, {
      method: 'POST',
      body: { category: '武侠' },
    })
    assert.equal(missing.status, 404, '不存在的书应当 404，而不是 500')
    assert.equal(missing.body.error, 'BOOK_NOT_FOUND')

    const bad = await call(`${server.base}/library/..%2F..%2Fetc/category`, {
      method: 'POST',
      body: { category: '武侠' },
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'BOOK_ID_INVALID')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('路由：带 `session-` 前缀的会话绑定会出现在 books[].sessionId 上（书架要显示它）', async () => {
  const dir = makeDir('cat-bind')
  const server = await startServer(dir)
  try {
    const bookId = await importBook(server.base, dir, '绑定书')
    const before = await call(`${server.base}/library`)
    assert.equal(before.body.books[0].sessionId, null, '没绑定时必须是 null，界面才知道显示「未绑定」')

    const bound = await call(`${server.base}/books/${bookId}/binding`, {
      method: 'PUT',
      body: { sessionId: 'session-abc' },
    })
    assert.equal(bound.status, 200, `绑定失败：${JSON.stringify(bound.body)}`)

    const after = await call(`${server.base}/library`)
    assert.equal(after.body.books[0].sessionId, 'session-abc')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

//#endregion
