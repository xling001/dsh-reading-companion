/**
 * 书库往返测试：导入 → 目录 → 按章读取 → 进度 → 绑定 → 移除。
 *
 * 重点验证三件容易写错的事：
 *   1. **字节区间必须精确**——读出来的字节要能还原该章的字符区间，
 *      否则 GB18030 的书会切出乱码半字；
 *   2. **幂等导入**——同一份文件重复导入不能产生第二本书、不能覆盖笔记；
 *   3. **路径安全**——bookId 是拼进文件系统的，必须在校验层就被挡住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLibrary } from '../lib/host/library.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = join(HERE, '.tmp')

/** 重复出现的正文行，用来把平均行长拉高。 */
const prose = (seed) =>
  `${seed}，他记得那天的雪落得很慢，像有人在半空里把时间掰开了一点点，然后一片一片地放下。天光从瓦缝里漏下来，落在门槛上。`

/** 造一本结构规整的书。 */
function sampleBook() {
  return [
    '第一章 雪',
    prose('甲'),
    '',
    '第二章 夜',
    prose('乙'),
    '',
    '第三章 归',
    prose('丙'),
  ].join('\n')
}

let seq = 0

/**
 * 建一个隔离的书库 + 一个隔离的 inbox。
 *
 * @param {{ bookText?: string, encoding?: BufferEncoding, fileName?: string, bom?: boolean }} [options]
 * @returns {{ storageDir: string, inboxDir: string, sourcePath: string, library: object, cleanup: Function }}
 */
function makeFixture(options = {}) {
  seq += 1
  const root = join(TMP_ROOT, `lib-${process.pid}-${Date.now()}-${seq}`)
  const storageDir = join(root, 'storage')
  const inboxDir = join(storageDir, 'inbox')
  mkdirSync(inboxDir, { recursive: true })

  const sourcePath = join(root, options.fileName ?? '夜行.txt')
  const text = options.bookText ?? sampleBook()
  const body = Buffer.from(text, options.encoding ?? 'utf8')
  // Windows 记事本存「Unicode」一定会写 BOM，所以带 BOM 才是真实形态。
  const withBom = options.bom === true
    ? Buffer.concat([
        options.encoding === 'utf16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xef, 0xbb, 0xbf]),
        body,
      ])
    : body
  writeFileSync(sourcePath, withBom)

  const library = createLibrary({
    storageDir,
    fallbackBlockChars: 1000,
    // 只有显式传了才注入：默认不传 = 走"不限制导入路径"的真实默认值，
    // 否则测试会替生产代码做了一个它自己没做的决定。
    ...(options.importRoots === undefined ? {} : { importRoots: options.importRoots }),
  })
  library.ensureDirs()

  return {
    root,
    storageDir,
    inboxDir,
    sourcePath,
    sourceText: text,
    library,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('书库：导入落盘 meta / content / chapters / notes 四件套', () => {
  const f = makeFixture()
  try {
    const { book, deduped } = f.library.importBook({ absPath: f.sourcePath })

    assert.equal(deduped, false)
    assert.equal(book.title, '夜行')
    assert.equal(book.chapterCount, 3)
    assert.equal(book.encoding, 'utf-8')
    assert.equal(book.strategy, 'heading-regex')
    assert.equal(book.charLength, f.sourceText.length)

    const dir = f.library.paths.bookDir(book.bookId)
    for (const name of ['meta.json', 'source.txt', 'content.txt', 'chapters.json', 'notes.md']) {
      assert.ok(readFileSync(join(dir, name)).length > 0, `${name} 必须落盘`)
    }

    // 原始字节原样保存——这是"原书只读"的承诺。
    assert.deepEqual(readFileSync(join(dir, 'source.txt')), readFileSync(f.sourcePath))
    // content.txt 是解码并归一化换行后的文本。
    assert.equal(readFileSync(join(dir, 'content.txt'), 'utf8'), f.sourceText)
  } finally {
    f.cleanup()
  }
})

test('书库：重复导入同一份文件幂等，不产生第二本书、不覆盖笔记', () => {
  const f = makeFixture()
  try {
    const first = f.library.importBook({ absPath: f.sourcePath })
    // 用户手写了一条笔记。
    const notesPath = f.library.paths.notes(first.book.bookId)
    writeFileSync(notesPath, '# 夜行 · 读书笔记\n\n## 我写的\n\n> 不能被覆盖\n')

    const second = f.library.importBook({ absPath: f.sourcePath })

    assert.equal(second.deduped, true)
    assert.equal(second.book.bookId, first.book.bookId)
    assert.equal(f.library.list().books.length, 1, '书架里只能有一本')
    assert.match(readFileSync(notesPath, 'utf8'), /不能被覆盖/)
  } finally {
    f.cleanup()
  }
})

test('书库：字节区间精确——按字节读回的内容等于按字符切的正文', () => {
  const f = makeFixture()
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    const index = f.library.chapters(book.bookId)
    const rawBytes = readFileSync(f.library.paths.content(book.bookId))

    for (const chapter of index.chapters) {
      const byByte = f.library.readRange(book.bookId, chapter.startByte, chapter.endByte)
      const byChar = f.sourceText.slice(chapter.startChar, chapter.endChar)
      assert.equal(byByte, byChar, `第 ${chapter.index} 章：字节区间与字符区间必须一致`)

      // 字节偏移本身也要对得上真实文件。
      assert.deepEqual(
        rawBytes.subarray(chapter.startByte, chapter.endByte),
        Buffer.from(byChar, 'utf8'),
        `第 ${chapter.index} 章的 startByte/endByte 指向了错误的字节`,
      )
    }
  } finally {
    f.cleanup()
  }
})

test('书库：章节正文不含标题行，标题由结构化字段单独给出', () => {
  const f = makeFixture()
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    const chapters = f.library.chapters(book.bookId).chapters

    const first = f.library.readChapter(book.bookId, 0)
    assert.equal(first.title, '第一章 雪')
    assert.ok(!first.text.startsWith('第一章 雪'), '正文里不该重复出现标题')
    assert.match(first.text, /^甲，他记得/)

    assert.deepEqual(chapters.map((c) => c.index), [0, 1, 2])
    assert.deepEqual(chapters.map((c) => c.title), ['第一章 雪', '第二章 夜', '第三章 归'])
  } finally {
    f.cleanup()
  }
})

test('书库：多字节字符不会把字节区间切碎', () => {
  // 中文在 UTF-8 里占 3 字节，区间算错会解出 U+FFFD。
  const f = makeFixture({ bookText: ['第一章 雪', '中文正文内容。'.repeat(80), '第二章 夜', '更多中文内容。'.repeat(80), '第三章 归', '结尾。'.repeat(80)].join('\n') })
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    for (const chapter of f.library.chapters(book.bookId).chapters) {
      const text = f.library.readChapter(book.bookId, chapter.index).text
      assert.ok(!text.includes('\uFFFD'), `第 ${chapter.index} 章解出了替换字符`)
    }
  } finally {
    f.cleanup()
  }
})

test('书库：UTF-16LE 文件端到端导入并正确解码', () => {
  const f = makeFixture({ encoding: 'utf16le', bom: true })
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    assert.equal(book.encoding, 'utf-16le')
    assert.equal(book.encodingConfidence, 'bom')
    assert.equal(book.chapterCount, 3)
    assert.match(f.library.readChapter(book.bookId, 0).text, /甲，他记得/)
  } finally {
    f.cleanup()
  }
})

test('书库：无 BOM 的中文 UTF-16LE 也能端到端导入（曾经解成乱码的回归）', () => {
  const f = makeFixture({ encoding: 'utf16le' })
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    assert.equal(book.encoding, 'utf-16le', '无 BOM 的中文 UTF-16 必须被认出来')
    assert.equal(book.chapterCount, 3)
    const first = f.library.readChapter(book.bookId, 0)
    assert.ok(!first.text.includes('\uFFFD'))
    assert.match(first.text, /甲，他记得/)
  } finally {
    f.cleanup()
  }
})

test('书库：无章节结构时降级为定长分块，并在 meta 里记录策略', () => {
  const f = makeFixture({ bookText: '没有任何标题的一段长文。'.repeat(500) })
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    assert.equal(book.strategy, 'fixed-blocks')
    assert.ok(book.chapterCount > 1)
    assert.ok(book.warnings.some((w) => w.includes('未检测到章节结构')))
  } finally {
    f.cleanup()
  }
})

test('书库：进度写入并被夹到合法范围，越界不报错', () => {
  const f = makeFixture()
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    assert.equal(f.library.getProgress(book.bookId), null)

    const set = f.library.setProgress(book.bookId, { chapterIndex: 1, charOffset: 12 })
    assert.equal(set.chapterIndex, 1)
    assert.equal(set.charOffset, 12)
    assert.equal(set.clamped, false)
    assert.equal(f.library.getProgress(book.bookId).chapterIndex, 1)

    // 章号越界：夹到最后一章，而不是抛错——客户端可能拿着过期目录。
    const clampedChapter = f.library.setProgress(book.bookId, { chapterIndex: 999, charOffset: 5 })
    assert.equal(clampedChapter.chapterIndex, 2)
    assert.equal(clampedChapter.clamped, true)

    // 章内偏移越界：夹到该章长度。
    const clampedOffset = f.library.setProgress(book.bookId, { chapterIndex: 0, charOffset: 10 ** 9 })
    assert.equal(clampedOffset.clamped, true)
    assert.ok(clampedOffset.charOffset > 0)
  } finally {
    f.cleanup()
  }
})

test('书库：进度拒绝非法输入', () => {
  const f = makeFixture()
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    assert.throws(() => f.library.setProgress(book.bookId, { chapterIndex: -1 }), /PROGRESS_CHAPTER_INVALID/)
    assert.throws(() => f.library.setProgress(book.bookId, { chapterIndex: 0, charOffset: -5 }), /PROGRESS_OFFSET_INVALID/)
    assert.throws(() => f.library.setProgress(book.bookId, { chapterIndex: 1.5 }), /PROGRESS_CHAPTER_INVALID/)
  } finally {
    f.cleanup()
  }
})

test('书库：绑定与反查，且一个会话不能同时绑两本书', () => {
  const f = makeFixture()
  try {
    // 两本书必须在**同一个**书库里，绑定冲突才可能发生。
    const a = f.library.importBook({ absPath: f.sourcePath }).book
    const otherPath = join(f.storageDir, '..', '另一本.txt')
    writeFileSync(otherPath, Buffer.from(sampleBook().replace(/雪|夜|归/g, '风'), 'utf8'))
    const b = f.library.importBook({ absPath: otherPath }).book
    assert.notEqual(a.bookId, b.bookId, '前提：两本书必须是不同的书')

    f.library.bind(a.bookId, 'session-1', 'ws-1')
    assert.equal(f.library.bookForSession('session-1'), a.bookId)
    assert.equal(f.library.bindingForBook(a.bookId).workspaceId, 'ws-1')
    assert.equal(f.library.bookForSession('session-unknown'), undefined)

    // 同一本书重复绑同一个会话是幂等的。
    f.library.bind(a.bookId, 'session-1')
    assert.equal(f.library.bookForSession('session-1'), a.bookId)

    // 同一个会话绑到另一本书必须失败，否则"当前读到哪"就没有唯一答案。
    assert.throws(() => f.library.bind(b.bookId, 'session-1'), /SESSION_ALREADY_BOUND/)

    assert.equal(f.library.unbind(a.bookId), true)
    assert.equal(f.library.bookForSession('session-1'), undefined)
    // 解绑不清进度。
    f.library.setProgress(a.bookId, { chapterIndex: 1, charOffset: 3 })
    assert.equal(f.library.getProgress(a.bookId).chapterIndex, 1)
  } finally {
    f.cleanup()
  }
})

test('书库：移除书籍会清掉目录与绑定，且可保留笔记副本', () => {
  const f = makeFixture()
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    f.library.bind(book.bookId, 'session-x')
    const notesPath = f.library.paths.notes(book.bookId)
    writeFileSync(notesPath, '# 夜行\n\n> 珍贵的手写笔记\n')

    const result = f.library.remove(book.bookId, { keepNotes: true })

    assert.equal(result.removed, true)
    assert.ok(result.notesKeptAt, '应给出一份笔记副本的路径')
    assert.match(readFileSync(result.notesKeptAt, 'utf8'), /珍贵的手写笔记/)
    assert.equal(f.library.list().books.length, 0)
    assert.equal(f.library.bookForSession('session-x'), undefined, '绑定必须一起清掉')
    assert.equal(f.library.remove(book.bookId).removed, false, '重复移除返回 false')
  } finally {
    f.cleanup()
  }
})

test('书库：scanInbox 报告待导入文件并标记已导入', () => {
  const f = makeFixture()
  try {
    writeFileSync(join(f.inboxDir, '另一本.txt'), Buffer.from(sampleBook(), 'utf8'))
    writeFileSync(join(f.inboxDir, '.hidden'), Buffer.from('x', 'utf8'))

    const before = f.library.scanInbox()
    assert.deepEqual(before.map((e) => e.name), ['另一本.txt'], '隐藏文件必须跳过')
    assert.equal(before[0].alreadyImported, false)

    f.library.importBook({ absPath: before[0].absPath })
    assert.equal(f.library.scanInbox()[0].alreadyImported, true, '同名同大小应被判为已导入')
  } finally {
    f.cleanup()
  }
})

test('书库：list 附带进度与绑定会话', () => {
  const f = makeFixture()
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    f.library.bind(book.bookId, 'session-9')
    f.library.setProgress(book.bookId, { chapterIndex: 2, charOffset: 7 })

    const entry = f.library.list().books[0]
    assert.equal(entry.sessionId, 'session-9')
    assert.equal(entry.progress.chapterIndex, 2)
    assert.equal(entry.progress.charOffset, 7)
  } finally {
    f.cleanup()
  }
})

test('书库：bookId 形态在进文件系统之前就被挡住', () => {
  const f = makeFixture()
  try {
    for (const bad of ['../../etc/passwd', 'not-hex!', 'ABCDEF0123456789', '', 'a'.repeat(17)]) {
      assert.throws(() => f.library.chapters(bad), /BOOK_ID_INVALID/, `应拒绝 ${JSON.stringify(bad)}`)
    }
    assert.throws(() => f.library.get('..\\..\\windows'), /BOOK_ID_INVALID/)
  } finally {
    f.cleanup()
  }
})

test('书库：导入拒绝不存在的文件与非绝对路径', () => {
  const f = makeFixture()
  try {
    assert.throws(() => f.library.importBook({ absPath: join(f.storageDir, '不存在.txt') }), /IMPORT_REJECTED/)
    assert.throws(() => f.library.importBook({ absPath: 'relative.txt' }), /IMPORT_REJECTED/)
    assert.throws(() => f.library.importBook({ absPath: f.storageDir }), /IMPORT_REJECTED/)
  } finally {
    f.cleanup()
  }
})

test('书库：importRoots 非空时只接受白名单内路径，且不误判前缀相同的兄弟目录', () => {
  const f = makeFixture()
  try {
    const allowedRoot = join(f.root, '允许导入')
    const prefixSibling = join(f.root, '允许导入-但不是它')
    mkdirSync(allowedRoot, { recursive: true })
    mkdirSync(prefixSibling, { recursive: true })
    const insidePath = join(allowedRoot, '在范围内.txt')
    const prefixPath = join(prefixSibling, '前缀相同.txt')
    writeFileSync(insidePath, sampleBook())
    writeFileSync(prefixPath, sampleBook())

    const scoped = createLibrary({
      storageDir: f.storageDir,
      fallbackBlockChars: 1000,
      importRoots: [allowedRoot],
    })

    // ① 白名单内的书照常导入 —— 这条闸不该顺手把正常用法也挡掉。
    assert.equal(scoped.importBook({ absPath: insidePath }).book.chapterCount, 3)

    // ② 白名单的**父目录**不在里面。
    assert.throws(
      () => scoped.importBook({ absPath: f.sourcePath }),
      /IMPORT_REJECTED: PATH_OUTSIDE_IMPORT_ROOTS/,
    )

    // ③ 前缀相同的兄弟目录**也不在**里面。这一条钉的是判定方式：用字符串前缀
    //    会把 `允许导入-但不是它` 判成在 `允许导入` 之内，`relative()` 不会。
    assert.throws(
      () => scoped.importBook({ absPath: prefixPath }),
      /IMPORT_REJECTED: PATH_OUTSIDE_IMPORT_ROOTS/,
    )
  } finally {
    f.cleanup()
  }
})

test('书库：损坏的 library.json 不让插件崩，而是回落为空书架', () => {
  const f = makeFixture()
  try {
    f.library.importBook({ absPath: f.sourcePath })
    writeFileSync(f.library.paths.library, '{ 这不是 JSON')

    const listed = f.library.list()
    assert.deepEqual(listed.books, [])
    assert.equal(listed.recovered, true, '必须如实报告索引已损坏')
  } finally {
    f.cleanup()
  }
})

test('书库：损坏的 bindings.json 不影响书籍列表', () => {
  const f = makeFixture()
  try {
    f.library.importBook({ absPath: f.sourcePath })
    writeFileSync(f.library.paths.bindings, 'garbage')

    assert.equal(f.library.list().books.length, 1)
    assert.equal(f.library.getProgress(f.library.list().books[0].bookId), null)
  } finally {
    f.cleanup()
  }
})

/**
 * 造一本「外层序号 + 书自己的章号」双标题的书——盗版 TXT 的典型形态，
 * 也是《一世之尊》那 1403 条空章节的来源。
 */
function duplicatedHeadingBook() {
  return [
    '第2章 第0001章 雪',
    '',
    '第0001章 雪',
    prose('甲'),
    '第3章 第0002章 夜',
    '',
    '第0002章 夜',
    prose('乙'),
    '第4章 第0003章 归',
    '',
    '第0003章 归',
    prose('丙'),
  ].join('\n')
}

/**
 * 复刻**修复前**的切分行为：每个标题行都算一章（重复的目录行也不例外）。
 *
 * 用它把书架里的 `chapters.json` 改回"老索引"，才能验证 `reindex` 真的能把
 * 一款已经导入过的书从老索引搬到新索引——而不是只验证"新导入的书本来就对"。
 *
 * @param {string} text 全文
 * @param {string[]} titles 要当成章节的全部标题行
 * @returns {object[]} 老式章节索引
 */
function legacyIndex(text, titles) {
  const hits = []
  let cursor = 0
  for (const line of text.split('\n')) {
    if (titles.includes(line)) {
      hits.push({ title: line, start: cursor, end: cursor + line.length })
    }
    cursor += line.length + 1
  }
  return hits.map((hit, index) => ({
    index,
    title: hit.title,
    volume: null,
    kind: 'chapter',
    startChar: hit.end + 1,
    endChar: index + 1 < hits.length ? hits[index + 1].start : text.length,
    titleStartChar: hit.start,
    titleEndChar: hit.end,
  }))
}

/** 把手写的索引落盘成"书架里的书"（老索引 + 老章数）。 */
function installLegacyIndex(fixture, bookId, text) {
  const titles = [
    '第2章 第0001章 雪', '第0001章 雪',
    '第3章 第0002章 夜', '第0002章 夜',
    '第4章 第0003章 归', '第0003章 归',
  ]
  const chapters = legacyIndex(text, titles)
  const dir = fixture.library.paths.bookDir(bookId)
  writeFileSync(join(dir, 'chapters.json'), JSON.stringify({
    schemaVersion: 1,
    strategy: 'heading-regex',
    chapters,
    warnings: ['识别到 0 个卷级标题'],
  }))
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  meta.chapterCount = chapters.length
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
  return chapters
}

test('书库：reindex 预演不改盘，但说清会合并几条目录行、搬几条草稿', () => {
  const text = duplicatedHeadingBook()
  const f = makeFixture({ bookText: text })
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    const legacy = installLegacyIndex(f, book.bookId, text)
    assert.equal(legacy.length, 6, '老索引里有 3 条重复目录行')

    f.library.setProgress(book.bookId, { chapterIndex: 3, charOffset: 12 })
    f.library.saveDraft({ bookId: book.bookId, chapterIndex: 3, chapterTitle: '第0002章 夜', excerpt: '……' })

    const report = f.library.reindex(book.bookId, { apply: false })

    assert.equal(report.changed, true)
    assert.equal(report.before, 6)
    assert.equal(report.after, 3)
    assert.equal(report.droppedTitles.length, 3)
    assert.equal(report.remap.drafts, 1, '预演也要能算出草稿会被搬')
    assert.equal(report.remap.progress, true)

    // 预演就是不落盘：盘上还是老索引、老进度、老草稿。
    assert.equal(f.library.chapters(book.bookId).chapters.length, 6)
    assert.equal(f.library.getProgress(book.bookId).chapterIndex, 3)
  } finally {
    f.cleanup()
  }
})

test('书库：reindex 落盘后索引只剩真章节，进度与草稿按标题锚一起搬', () => {
  const text = duplicatedHeadingBook()
  const f = makeFixture({ bookText: text })
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    installLegacyIndex(f, book.bookId, text)
    f.library.setProgress(book.bookId, { chapterIndex: 3, charOffset: 12 })
    f.library.saveDraft({ bookId: book.bookId, chapterIndex: 3, chapterTitle: '第0002章 夜', excerpt: '……' })

    const report = f.library.reindex(book.bookId, { apply: true })
    assert.equal(report.applied, true)

    const after = f.library.chapters(book.bookId)
    assert.deepEqual(after.chapters.map((c) => c.title), ['第0001章 雪', '第0002章 夜', '第0003章 归'])
    assert.deepEqual(after.chapters.map((c) => c.index), [0, 1, 2])
    assert.ok(report.backupDir !== null && readFileSync(join(report.backupDir, 'chapters.json')).length > 0, '改盘前必须留备份')

    // 老索引第 3 条 = 第0002章 夜 → 新索引第 1 条。读者进度必须跟着走。
    assert.equal(f.library.getProgress(book.bookId).chapterIndex, 1)
    assert.equal(f.library.getProgress(book.bookId).charOffset, 12, '章内偏移不该被改动')
    const drafts = f.library.listDrafts(book.bookId)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].chapterIndex, 1)

    // 正文读得回来，且读到的就是这一章的内容（区间没漂）。
    assert.ok(f.library.readChapter(book.bookId, 1).text.includes('乙'))
    assert.equal(f.library.get(book.bookId).chapterCount, 3, 'meta/书架里的章数也要更新')

    // 幂等：再跑一次没有可改的。
    assert.equal(f.library.reindex(book.bookId, { apply: true }).changed, false)
  } finally {
    f.cleanup()
  }
})

test('书库：reindex 检测到按章笔记会漂时拒绝落盘，而不是偷偷改坏', () => {
  const text = duplicatedHeadingBook()
  const f = makeFixture({ bookText: text })
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    installLegacyIndex(f, book.bookId, text)
    f.library.writeNote(book.bookId, { chapterIndex: 3, chapterTitle: '第0002章 夜', excerpt: '……', thought: '想记一笔' })

    const preview = f.library.reindex(book.bookId, { apply: false })
    assert.equal(preview.drift.length, 1, 'notes.md 是人工内容，报告出来就行')

    assert.throws(() => f.library.reindex(book.bookId, { apply: true }), /REINDEX_ANCHOR_DRIFT/)
    assert.equal(f.library.chapters(book.bookId).chapters.length, 6, '拒绝落盘 = 盘上一点没动')
  } finally {
    f.cleanup()
  }
})

test('书库：背景备份"一代一份"——带时间戳，同秒也不互相覆盖', () => {
  const f = makeFixture()
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    // 直接造一份背景认识：这里要测的是**备份行为**，不必绕一次模型合并。
    writeFileSync(
      f.library.backgroundPath(book.bookId),
      '<!-- drc-background: schema=1 covered=1..2 -->\n# 背景\n\n## 世界观\n- `第1章` 双女主\n',
    )
    const doc = f.library.background(book.bookId)

    const first = f.library.backgroundCompact(book.bookId, doc)
    const second = f.library.backgroundCompact(book.bookId, doc)

    assert.ok(first.backupPath !== null, '压缩前必须留备份')
    assert.ok(second.backupPath !== null)
    // 连着压两次，时间戳落在同一秒是常态——必须靠序号避开覆盖。
    assert.notEqual(first.backupPath, second.backupPath, '同秒也不能互相覆盖')
    assert.equal(existsSync(first.backupPath), true)
    assert.equal(existsSync(second.backupPath), true)

    const backups = f.library.listBackgroundBackups(book.bookId)
    assert.equal(backups.length, 2, '两代都要在，一代都不能被盖掉')
    for (const item of backups) {
      assert.match(item.name, /^background\.bak\.\d{8}-\d{6}(-\d+)?\.md$/)
      assert.equal(item.legacy, false)
    }
  } finally {
    f.cleanup()
  }
})

test('书库：遗留的单槽 background.bak.md 仍算一代（mtime 补时间戳），且不改名不删除', () => {
  const f = makeFixture()
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    const dir = f.library.location(book.bookId).dir
    const legacyPath = join(dir, 'background.bak.md')
    writeFileSync(legacyPath, '# 老的单槽备份，压缩前的完整信息\n')

    const backups = f.library.listBackgroundBackups(book.bookId)
    assert.equal(backups.length, 1)
    assert.equal(backups[0].legacy, true)
    assert.match(backups[0].stamp, /^\d{8}-\d{6}$/, '老文件没有时间戳，用 mtime 补一个')

    // 老文件留在原地：那是用户的文件，插件没有理由动它。
    assert.equal(existsSync(legacyPath), true)
    assert.equal(readFileSync(legacyPath, 'utf8'), '# 老的单槽备份，压缩前的完整信息\n')
  } finally {
    f.cleanup()
  }
})

test('书库：exportBook 把笔记与背景导成"书名-…"，并且幂等', () => {
  const f = makeFixture()
  const out = join(TMP_ROOT, `export-lib-${process.pid}-${Date.now()}-${Date.now()}`)
  try {
    const { book } = f.library.importBook({ absPath: f.sourcePath })
    f.library.writeNote(book.bookId, {
      chapterIndex: 0,
      chapterTitle: '第一章 雪',
      excerpt: '他站在雪里。',
      thought: '这句真好。',
      tags: ['人设'],
    })
    writeFileSync(
      f.library.backgroundPath(book.bookId),
      '<!-- drc-background: schema=1 covered=1..1 -->\n# 背景\n\n## 世界观\n- `第1章` 双女主\n',
    )

    const first = f.library.exportBook(book.bookId, { dir: out, now: '2026-09-25T13:20:00.000Z' })
    assert.equal(first.dir, join(out, '陪读导出_夜行'), '落点是导出根下面的每本书一个文件夹')
    assert.deepEqual(first.files.map((file) => file.name).sort(), ['夜行-笔记.md', '夜行-背景.md'])
    assert.ok(readFileSync(join(first.dir, '夜行-笔记.md'), 'utf8').includes('他站在雪里。'))

    const second = f.library.exportBook(book.bookId, { dir: out, now: '2026-09-25T13:21:00.000Z' })
    assert.deepEqual(
      second.files.map((file) => file.action),
      ['unchanged', 'unchanged'],
      '第二次导出必须什么都不写（改了时间戳也算改了内容，所以标记要复用）',
    )
    assert.equal(second.notes.appended, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
    f.cleanup()
  }
})
