/**
 * 笔记系统测试（P3）。
 *
 * 这里钉的是三条硬约束，每一条都对应一个真实会让人丢掉数据的失效模式：
 *
 *   1. **只追加，永不重写既有内容** —— 用逐字节比较证明，而不是"看着没动"；
 *   2. **AI 回应默认不落盘** —— 断言的是"渲染结果里根本不存在那四个字"；
 *   3. **块可被机器读回** —— 结构化的前提是解析器真的能还原，包括被用户
 *      在外部编辑器里改过之后。
 */

import { test } from 'node:test'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLibrary } from '../lib/host/library.js'
import {
  NOTES_PAGE_DEFAULT,
  NOTES_PAGE_MAX,
  appendNote,
  deleteDraft,
  emptyNotesHeader,
  listDrafts,
  locateNoteAnchor,
  noteHeading,
  paginateNotes,
  parseNotes,
  readDrafts,
  readNotes,
  renderNoteBlock,
  upsertDraft,
} from '../lib/host/notes.js'

const TMP_ROOT = join(tmpdir(), 'drc-notes')

let seq = 0
/** 建一个隔离目录。 */
function makeDir() {
  seq += 1
  const dir = join(TMP_ROOT, `notes-${process.pid}-${Date.now()}-${seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

//#region 渲染：AI 回应默认不落盘

test('渲染：没有 reply 时，「AI 回应」四个字根本不出现在块里', () => {
  const block = renderNoteBlock({
    excerpt: '他站在雪里。',
    thought: '这句真好。',
    tags: ['文笔'],
  })
  // 这是「AI 回应默认不落盘」的落点：不是靠调用方少传字段，
  // 而是渲染层就没有那条分支。
  assert.ok(!block.includes('AI 回应'), '未传 reply 却渲染出了 AI 回应小节')
  assert.match(block, /\*\*我的感想\*\*/)
  assert.match(block, /\*\*原文摘抄\*\*|^> 他站在雪里。$/m)
  // tag 现在写在**标题行**里（没有章节时标题只剩 tag）。
  assert.match(block, /^### #文笔$/m)
})

test('渲染：传了空串/null 也等同未传', () => {
  for (const reply of ['', null, undefined]) {
    const block = renderNoteBlock({ excerpt: 'x', thought: 'y', reply })
    assert.ok(!block.includes('AI 回应'), `reply=${JSON.stringify(reply)} 时不该出现 AI 回应`)
  }
})

test('渲染：显式传了 reply 才出现，且内容原样保留', () => {
  const block = renderNoteBlock({
    excerpt: '他站在雪里。',
    thought: '这句真好。',
    reply: '是啊，冷得能听见声音。',
    tags: ['文笔'],
  })
  assert.match(block, /\*\*AI 回应\*\*：是啊，冷得能听见声音。/)
})

//#region 文本锚（摘抄前后文 + 源文件指纹）

test('文本锚：`>` 与 `<` 必须转义，否则整条笔记会「落盘了却读不回来」', () => {
  // 这是加文本锚时发现的洞：块标记的正则是 `[^>]*?-->`，属性值里只要出现 `>`，
  // 标记行就被截断 —— 笔记**落了盘却解析不出来**（而 notes.md 是"只追加、永不重写"
  // 的，写坏一条就永远坏在那儿）。
  // 从前的字段（id / created / chapter / offset / tags）恰好都不可能含 `>`，
  // 所以这个洞一直没被踩到；而摘抄前后文是**正文原样**，中文正文里出现
  // `<` / `>`（引用标记、箭头、代码片段）完全可能。
  const prefix = '他说：<记住> 这句'
  const suffix = '> 然后他走了'
  const markdown = `${emptyNotesHeader('夜行')}\n${renderNoteBlock({
    id: 'n1',
    excerpt: '正文摘抄',
    thought: '感想',
    chapterIndex: 2,
    charOffset: 10,
    sourceSha: 'abcdef012345',
    quotePrefix: prefix,
    quoteSuffix: suffix,
  })}\n`

  const notes = parseNotes(markdown)
  assert.equal(notes.length, 1, '含 `>` 的属性值不该让整条笔记消失')
  assert.equal(notes[0].quotePrefix, prefix, '前后文要能原样往返')
  assert.equal(notes[0].quoteSuffix, suffix)
  assert.equal(notes[0].sourceSha, 'abcdef012345')
  assert.equal(notes[0].excerpt, '正文摘抄')
})

test('文本锚：没有锚点时标记行不膨胀；旧笔记解析成空串', () => {
  const bare = renderNoteBlock({ excerpt: 'x', thought: 'y' })
  for (const key of [' src=', ' pre=', ' post=']) {
    assert.ok(!bare.includes(key), `没有锚点就不该写出 ${key.trim()} 属性`)
  }

  // v2.1.5 之前写的笔记没有这三个属性 → 解析成**空串**（不是 undefined/null）：
  // 面板与导出只关心"有没有"，少一种形态就少一处分支。
  const legacy = parseNotes([
    emptyNotesHeader('夜行'),
    '<!-- drc-note:begin id=n0 created=2020-01-01T00:00:00.000Z chapter=1 offset=5 tags=a -->',
    '### 第2章 夜 #a',
    '',
    '> 旧的',
    '',
    '<!-- drc-note:end -->',
    '',
  ].join('\n'))
  assert.equal(legacy.length, 1)
  assert.deepEqual(
    [legacy[0].sourceSha, legacy[0].quotePrefix, legacy[0].quoteSuffix],
    ['', '', ''],
  )
})

//#endregion

//#region 文本锚核对（reindex 用它判断"笔记会不会漂"）

/**
 * 造一份可控的正文与目录：两章，正文是**互不相同**的字母串 —— 这样"这段摘抄
 * 在不在原地"能一眼判定，不会因为重复字符而误判。
 */
const ANCHOR_TEXT = `第一章 雪\nABCDEFGHIJ\n第二章 夜\nKLMNOPQRST\n`
const ANCHOR_CHAPTERS = [
  { startChar: 6, endChar: 16 }, // ABCDEFGHIJ
  { startChar: 23, endChar: 33 }, // KLMNOPQRST
]

test('文本锚核对：原位 / 同章挪动 / 邻近章节 —— 三种都要说清「在哪」', () => {
  const base = { chapterIndex: 0, charOffset: 2, excerpt: 'CDE', quotePrefix: 'AB', quoteSuffix: 'FGH' }

  // ① 原位：偏移处逐字相同 → intact，且报回同一个偏移。
  const intact = locateNoteAnchor(base, ANCHOR_TEXT, ANCHOR_CHAPTERS)
  assert.deepEqual(
    [intact.status, intact.chapterIndex, intact.charOffset],
    ['intact', 0, 2],
  )

  // ② 同一章里挪了位置（偏移变了）→ moved，报回新偏移。
  const movedInChapter = locateNoteAnchor({ ...base, charOffset: 6 }, ANCHOR_TEXT, ANCHOR_CHAPTERS)
  assert.deepEqual(
    [movedInChapter.status, movedInChapter.chapterIndex, movedInChapter.charOffset, movedInChapter.sameChapter],
    ['moved', 0, 2, true],
  )

  // ③ 挪到了**邻近章节**（±2 之内）→ moved，报回新章号。（不做全书扫描）
  const movedChapter = locateNoteAnchor(
    { ...base, chapterIndex: 0, charOffset: 0, excerpt: 'NOP', quotePrefix: 'LM', quoteSuffix: 'QR' },
    ANCHOR_TEXT,
    ANCHOR_CHAPTERS,
  )
  assert.deepEqual(
    [movedChapter.status, movedChapter.chapterIndex, movedChapter.charOffset, movedChapter.sameChapter],
    ['moved', 1, 3, false],
  )

  // ④ 邻近都找不到 → lost（**不猜**）。
  const lost = locateNoteAnchor({ ...base, excerpt: 'ZZZ' }, ANCHOR_TEXT, ANCHOR_CHAPTERS)
  assert.equal(lost.status, 'lost')
  assert.equal(lost.reason, 'NOT_FOUND')
})

test('文本锚核对：同一段出现多次、前后文也分不出时**不猜**，报 lost', () => {
  // 一章里 'ABC' 出现两次，且两次后面的字符都是 'X' → 前后文无法唯一确定。
  const text = `第一章 雪\nABCXABCX\n`
  const chapters = [{ startChar: 6, endChar: 14 }]
  const verdict = locateNoteAnchor(
    // 偏移 5 处是 'BCX'，不是 'ABC' → 先排除"原位"，逼它走"按摘抄重新找"那条路；
    // 而章内两处 'ABC' 后面都跟着 'X'，前后文同样分不出 → 必须放弃而不是猜。
    { chapterIndex: 0, charOffset: 5, excerpt: 'ABC', quotePrefix: '', quoteSuffix: 'X' },
    text,
    chapters,
  )
  assert.equal(verdict.status, 'lost', '分不出唯一位置时宁可说"对不上"，也不许指一个错的')
  assert.equal(verdict.charOffset, null)
})

test('文本锚核对：拿不出证据的一律 unverifiable（**不算通过**）', () => {
  const cases = [
    ['没有章号', { charOffset: 0, excerpt: 'CDE', quotePrefix: 'AB' }],
    ['没有摘抄（只有感想）', { chapterIndex: 0, charOffset: 0, excerpt: '', quotePrefix: 'AB' }],
    ['旧笔记没有文本锚', { chapterIndex: 0, charOffset: 2, excerpt: 'CDE' }],
  ]
  for (const [why, note] of cases) {
    const verdict = locateNoteAnchor(note, ANCHOR_TEXT, ANCHOR_CHAPTERS)
    assert.equal(verdict.status, 'unverifiable', `${why} 应当判为 unverifiable`)
    assert.notEqual(verdict.reason, '', `${why} 要给出原因`)
  }
  // 章号越界（书被重新切分过，章数变少）→ lost 而不是 unverifiable：这是**确定**的对不上。
  const gone = locateNoteAnchor(
    { chapterIndex: 9, charOffset: 0, excerpt: 'CDE', quotePrefix: 'AB' },
    ANCHOR_TEXT,
    ANCHOR_CHAPTERS,
  )
  assert.equal(gone.status, 'lost')
  assert.equal(gone.reason, 'CHAPTER_GONE')
})

//#endregion

test('渲染：多行摘抄每行都进引用块，空行也不会把引用块断开', () => {
  const block = renderNoteBlock({ excerpt: '第一行\n\n第三行', thought: 'x' })
  assert.match(block, /^> 第一行$/m)
  assert.match(block, /^> $/m, '空行也必须带引用前缀，否则 markdown 会把它当段落分隔')
  assert.match(block, /^> 第三行$/m)
})

test('渲染：没有 tag 时标题没有任何 tag 残留', () => {
  const block = renderNoteBlock({ excerpt: 'x', thought: 'y', tags: [] })
  assert.match(block, /^### 读书笔记$/m, '既没有章节也没有 tag 时回落到「读书笔记」')
  const withGarbage = renderNoteBlock({ excerpt: 'x', thought: 'y', tags: ['人 设', '', null] })
  assert.match(
    withGarbage,
    /^### 读书笔记$/m,
    '非法 tag（含空格/空串）归一化后为空，不该在标题里留下半截 #',
  )
})

//#region 标题行：章节与 tag 同一行
//
// 形状是 `### 第16章 带子 #人设 #文笔`。这里逐条钉住三种回落，因为它们都是
// 真实会出现的输入：这本书的 index 0 可能是「卷首」，标题可能自带序号，
// 也可能整本书没有章节（纯文本分块）。

test('标题行：章节在前，tag 依次跟在同一行', () => {
  assert.equal(noteHeading(15, '第16章 带子', ['人设', '文笔']), '第16章 带子 #人设 #文笔')
})

test('标题行：章节标题自带序号时不再叠一层我们自己的编号', () => {
  // 实测踩过：某本书的 index 0 是「卷首」，`第 ${index + 1} 章` 与书内编号
  // 整体错位，产出 `第 17 章 · 第16章 带子` —— 同一行里两个矛盾的章号。
  assert.equal(noteHeading(15, '第16章 带子', []), '第16章 带子')
  assert.equal(noteHeading(15, '卷二 风起', []), '卷二 风起')
})

test('标题行：标题没有序号时补上章号', () => {
  assert.equal(noteHeading(2, '雪夜', []), '第 3 章 · 雪夜')
  assert.equal(noteHeading(2, '', []), '第 3 章')
})

test('标题行：这本书没有章节时，章节那部分整个不出现', () => {
  assert.equal(noteHeading(null, '卷一', ['文笔']), '#文笔')
  assert.equal(noteHeading(null, '卷一', []), '读书笔记')
})

test('渲染：tag 不再单独占一行', () => {
  const block = renderNoteBlock({
    chapterIndex: 15,
    chapterTitle: '第16章 带子',
    excerpt: 'x',
    tags: ['人设'],
  })
  assert.match(block, /^### 第16章 带子 #人设$/m)
  assert.ok(!/^`#/m.test(block), '旧的独立 tag 行不该再出现')
})

test('读回：标题行里的 tag 被精确剥掉，面板上不会显示两遍', () => {
  const notes = parseNotes(renderNoteBlock({
    chapterIndex: 15,
    chapterTitle: '第16章 带子',
    excerpt: 'x',
    tags: ['人设', '文笔'],
  }))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].heading, '第16章 带子', '标题行里的 #tag 应当被剥掉')
  assert.deepEqual(notes[0].tags, ['人设', '文笔'], 'tag 仍从属性里读出')
})

test('读回：章节标题里出现 # 不会被误当成 tag 剥掉', () => {
  // 剥 tag 只认属性里确实记着的那几个，所以标题里的 `#` 是安全的 ——
  // 换成"按空白切分、见到 # 就当 tag"就会把这个标题切坏。
  const md = '<!-- drc-note:begin id=x tags=人设 -->\n### 第3章 C# 入门 #人设\n\n> x\n\n<!-- drc-note:end -->\n'
  const notes = parseNotes(md)
  assert.equal(notes[0].heading, '第3章 C# 入门')
})

test('读回：旧格式（tag 自己占一行）仍然读得出来', () => {
  const md = '<!-- drc-note:begin id=x chapter=15 tags=文笔 -->\n'
    + '### 第16章 带子\n\n`#文笔`\n\n> 他站在雪里。\n\n<!-- drc-note:end -->\n'
  const notes = parseNotes(md)
  assert.equal(notes[0].heading, '第16章 带子')
  assert.deepEqual(notes[0].tags, ['文笔'])
  assert.equal(notes[0].excerpt, '他站在雪里。', '旧的独立 tag 行不该被当成摘抄')
})

//#endregion

//#endregion

//#region 追加：永不重写既有内容

test('追加：既有字节逐个字节不变（用户手写的内容不能被吃掉）', () => {
  const dir = makeDir()
  try {
    const notesPath = join(dir, 'notes.md')
    // 模拟"用户已经在这个文件里手写过东西"，甚至不用我们的头部格式。
    const precious = '# 我自己写的\n\n这条绝对不能被动。\n'
    writeFileSync(notesPath, precious, 'utf8')
    const before = readFileSync(notesPath)

    appendNote(notesPath, { excerpt: '摘抄', thought: '感想' })
    appendNote(notesPath, { excerpt: '摘抄2', thought: '感想2' })

    const after = readFileSync(notesPath)
    assert.ok(after.length > before.length, '应当确实追加了内容')
    assert.ok(
      after.subarray(0, before.length).equals(before),
      '既有字节被改动了 —— 这是最严重的一类数据丢失',
    )
    // 两次追加都要在。
    const text = after.toString('utf8')
    assert.ok(text.includes('摘抄2'))
    assert.ok(text.includes('这条绝对不能被动'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('追加：文件不存在时连头部一起建，且头部与 readNotes 的默认一致', () => {
  const dir = makeDir()
  try {
    const notesPath = join(dir, 'notes.md')
    const result = appendNote(notesPath, { bookTitle: '夜行', excerpt: 'x', thought: 'y' })
    assert.equal(result.created, true)

    const text = readFileSync(notesPath, 'utf8')
    assert.ok(text.startsWith('# 夜行 · 读书笔记'), '首行应当是书名标题')
    assert.ok(text.includes('dsh-reading-companion:notes schema='))
    // 已存在之后再追加不该重复建头部。
    const second = appendNote(notesPath, { excerpt: 'x2', thought: 'y2' })
    assert.equal(second.created, false)
    assert.equal(readFileSync(notesPath, 'utf8').match(/· 读书笔记/g).length, 1, '头部被重复写入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

//#endregion

//#region 解析：结构化能往返

test('解析：渲染 → 解析必须回到等价的字段', () => {
  const block = renderNoteBlock({
    id: 'fixed-id',
    chapterIndex: 11,
    chapterTitle: '夜行',
    charOffset: 843,
    excerpt: '他站在雪里。',
    thought: '这句真好。',
    reply: '是啊。',
    tags: ['文笔', '人设'],
    createdAt: '2026-02-14T13:30:00.000Z',
  })
  const parsed = parseNotes(`${emptyNotesHeader('夜行')}\n${block}\n`)

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, 'fixed-id')
  assert.equal(parsed[0].chapterIndex, 11)
  assert.equal(parsed[0].charOffset, 843)
  assert.deepEqual(parsed[0].tags, ['文笔', '人设'])
  assert.equal(parsed[0].createdAt, '2026-02-14T13:30:00.000Z')
  assert.equal(parsed[0].hasReply, true)
  assert.match(parsed[0].heading, /第 12 章 · 夜行/)
})

test('解析：章标题里的空格不会截断属性（转义必须往返）', () => {
  const block = renderNoteBlock({
    id: 'spaced',
    chapterIndex: 0,
    chapterTitle: '雪 落 无 声',
    excerpt: 'x',
    thought: 'y',
  })
  const parsed = parseNotes(block)
  assert.equal(parsed[0].id, 'spaced', '属性在第一个空格处断开了 —— 转义没生效')
  // heading 是给界面用的纯文本，不带 markdown 前缀。
  assert.equal(parsed[0].heading, '第 1 章 · 雪 落 无 声')
})

test('解析：hasReply 反映真实内容，不会被别处的字样骗到', () => {
  const noReply = parseNotes(renderNoteBlock({ excerpt: 'x', thought: 'y' }))
  assert.equal(noReply[0].hasReply, false)
  const withReply = parseNotes(renderNoteBlock({ excerpt: 'x', thought: 'y', reply: 'r' }))
  assert.equal(withReply[0].hasReply, true)
})

test('解析：未闭合的块被跳过，而不是让整个列表打不开', () => {
  const good = renderNoteBlock({ id: 'ok', excerpt: 'x', thought: 'y' })
  const broken = '<!-- drc-note:begin id=broken -->\n没闭合\n'
  const parsed = parseNotes(`${broken}\n${good}\n`)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, 'ok', '一条坏块不该拖垮其它笔记')
})

test('解析：空文件、非字符串、没有块都回空数组', () => {
  assert.deepEqual(parseNotes(''), [])
  assert.deepEqual(parseNotes(null), [])
  assert.deepEqual(parseNotes('# 只有标题\n'), [])
})

test('读取：文件不存在时回落到头部骨架，且 notes 为空', () => {
  const dir = makeDir()
  try {
    const { exists, markdown, notes } = readNotes(join(dir, 'nope.md'), '夜行')
    assert.equal(exists, false)
    assert.deepEqual(notes, [])
    assert.match(markdown, /# 夜行 · 读书笔记/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

//#endregion

//#region 草稿

test('草稿：增删改查与「显式置空 reply」', () => {
  const dir = makeDir()
  try {
    const path = join(dir, 'drafts.json')

    const created = upsertDraft(path, { bookId: 'b1', excerpt: '摘抄', thought: '感想' })
    assert.equal(created.thought, '感想')
    assert.equal(created.reply, null)
    assert.ok(created.draftId)

    // 更新：未提供的字段保留。
    const updated = upsertDraft(path, { draftId: created.draftId, bookId: 'b1', thought: '改过的感想' })
    assert.equal(updated.excerpt, '摘抄', '未提供的字段应当保留')
    assert.equal(updated.thought, '改过的感想')
    assert.equal(updated.createdAt, created.createdAt, 'createdAt 不该被覆盖')

    // 显式置空 reply：用户先贴了回应又决定不写进去。
    upsertDraft(path, { draftId: created.draftId, bookId: 'b1', reply: '一段回应' })
    assert.equal(readDrafts(path)[created.draftId].reply, '一段回应')
    upsertDraft(path, { draftId: created.draftId, bookId: 'b1', reply: null })
    assert.equal(readDrafts(path)[created.draftId].reply, null, 'null 必须能清掉已贴的回应')

    // 另一本书的草稿不该串进来。
    upsertDraft(path, { bookId: 'b2', excerpt: '别的书', thought: 'x' })
    assert.equal(listDrafts(path, 'b1').length, 1)
    assert.equal(listDrafts(path, 'b2').length, 1)

    assert.equal(deleteDraft(path, created.draftId), true)
    assert.equal(deleteDraft(path, created.draftId), false, '重复删除应当回 false')
    assert.equal(listDrafts(path, 'b1').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('草稿：没有 bookId 必须拒绝，否则会写出一条永远回不来的孤儿草稿', () => {
  const dir = makeDir()
  try {
    assert.throws(() => upsertDraft(join(dir, 'd.json'), { excerpt: 'x' }), /DRAFT_BOOK_INVALID/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('草稿：坏掉的 drafts.json 不让插件崩，只是读回空集', () => {
  const dir = makeDir()
  try {
    const path = join(dir, 'drafts.json')
    writeFileSync(path, '{ 这不是 JSON', 'utf8')
    assert.deepEqual(readDrafts(path), {})
    // 而且能自愈：往里写一条会把文件重建好。
    const draft = upsertDraft(path, { bookId: 'b1', excerpt: 'x', thought: 'y' })
    assert.equal(readDrafts(path)[draft.draftId].bookId, 'b1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

//#endregion

//#region 书库层：端到端

/** 造一个带真书的书库 fixture。 */
function makeLibraryFixture() {
  const root = makeDir()
  const storageDir = join(root, 'storage')
  mkdirSync(join(storageDir, 'inbox'), { recursive: true })
  const sourcePath = join(root, '夜行.txt')
  writeFileSync(sourcePath, [
    '第一章 雪',
    '他站在雪里，风把衣角吹得笔直。',
    '',
    '第二章 夜',
    '灯灭之后，他才听见自己的心跳。',
    '',
  ].join('\n'), 'utf8')

  const library = createLibrary({ storageDir, fallbackBlockChars: 1000 })
  library.ensureDirs()
  const { book } = library.importBook({ absPath: sourcePath, title: '夜行' })
  return { root, library, book, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('书库：写笔记 → 读回来（走真实文件）', () => {
  const f = makeLibraryFixture()
  try {
    const bookId = f.book.bookId
    assert.deepEqual(f.library.notes(bookId), [], '刚导入时应当没有笔记')

    const written = f.library.writeNote(bookId, {
      chapterIndex: 0,
      chapterTitle: '第一章 雪',
      charOffset: 3,
      excerpt: '他站在雪里',
      thought: '开篇就把冷写出来了。',
      tags: ['文笔'],
    })
    assert.ok(written.id)

    const notes = f.library.notes(bookId)
    assert.equal(notes.length, 1)
    assert.deepEqual(notes[0].tags, ['文笔'])
    assert.equal(notes[0].hasReply, false, '没要求写 AI 回应，就不该有')
    assert.equal(notes[0].chapterIndex, 0)
  } finally {
    f.cleanup()
  }
})

test('书库：原文与感想都为空时拒绝写（否则会落一条空笔记进 md）', () => {
  const f = makeLibraryFixture()
  try {
    assert.throws(() => f.library.writeNote(f.book.bookId, { excerpt: '   ', thought: '' }), /NOTE_EMPTY/)
    assert.throws(() => f.library.writeNote(f.book.bookId, {}), /NOTE_EMPTY/)
    assert.deepEqual(f.library.notes(f.book.bookId), [], '被拒的写入不该留下痕迹')
  } finally {
    f.cleanup()
  }
})

test('书库：AI 回应只有 attachReply 显式要求时才落盘', () => {
  const f = makeLibraryFixture()
  try {
    const bookId = f.book.bookId

    // ① 默认：不落盘
    const draft = f.library.saveDraft({
      bookId,
      chapterIndex: 0,
      excerpt: '他站在雪里',
      thought: '真好。',
      reply: '我也觉得，那种冷是听觉上的。',
    })
    const first = f.library.writeNoteFromDraft(bookId, draft.draftId)
    assert.equal(first.draftRemoved, true, '写完应当把草稿清掉，否则用户会重复写第二条')

    let notes = f.library.notes(bookId)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].hasReply, false, '没显式要求却把 AI 回应写进去了')

    const md = readFileSync(f.library.paths.notes(bookId), 'utf8')
    assert.ok(!md.includes('AI 回应'), '不落盘就必须连字样都不出现')
    assert.ok(md.includes('我也觉得，那种冷是听觉上的。') === false, '回应正文泄漏进 md 了')

    // ② 显式要求：落盘
    const draft2 = f.library.saveDraft({
      bookId,
      excerpt: '灯灭之后',
      thought: '这段节奏好。',
      reply: '嗯，前面越静，这里越响。',
    })
    f.library.writeNoteFromDraft(bookId, draft2.draftId, { attachReply: true })
    notes = f.library.notes(bookId)
    assert.equal(notes.length, 2)
    assert.equal(notes[1].hasReply, true)
    assert.ok(readFileSync(f.library.paths.notes(bookId), 'utf8').includes('前面越静，这里越响。'))
  } finally {
    f.cleanup()
  }
})

test('书库：提交不存在的草稿回 DRAFT_NOT_FOUND，而不是静默写空笔记', () => {
  const f = makeLibraryFixture()
  try {
    assert.throws(() => f.library.writeNoteFromDraft(f.book.bookId, 'nope'), /DRAFT_NOT_FOUND/)
    assert.deepEqual(f.library.notes(f.book.bookId), [])
  } finally {
    f.cleanup()
  }
})

test('书库：未知书的笔记操作回 BOOK_NOT_FOUND', () => {
  const f = makeLibraryFixture()
  try {
    assert.throws(() => f.library.notes('0123456789abcdef'), /BOOK_NOT_FOUND/)
    assert.throws(() => f.library.writeNote('0123456789abcdef', { excerpt: 'x' }), /BOOK_NOT_FOUND/)
  } finally {
    f.cleanup()
  }
})

test('书库：导入时预建的 notes.md 与追加用的头部是同一份定义', () => {
  const f = makeLibraryFixture()
  try {
    // 关键：如果两处头部格式不一致，用户会看到两个标题。
    const md = readFileSync(f.library.paths.notes(f.book.bookId), 'utf8')
    assert.match(md, /^# 夜行 · 读书笔记\n/)
    assert.ok(md.includes('dsh-reading-companion:notes schema='))
    assert.equal(md.match(/· 读书笔记/g).length, 1)
    // 往里追加后，头部不该被再写一遍。
    f.library.writeNote(f.book.bookId, { excerpt: 'x', thought: 'y' })
    const after = readFileSync(f.library.paths.notes(f.book.bookId), 'utf8')
    assert.equal(after.match(/· 读书笔记/g).length, 1, '追加路径重复写了头部')
  } finally {
    f.cleanup()
  }
})

//#endregion

//#region 分页
//
// 笔记到几百条之后，全量返回会让「打开面板 / 保存草稿 / 写入笔记」每次都拖
// 500 KB 左右的响应体，并把上千条笔记全文塞进一次渲染。分页是这两件事的
// 共同解药——所以这里钉的是**分页本身的正确性**，而不只是"能切开"。

/** 造 n 条假笔记（顺序：旧 → 新），id 形如 n0…n{n-1}。 */
function fakeNotes(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    createdAt: `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
    excerpt: `摘抄 ${i}`,
    thought: `感想 ${i}`,
    reply: '',
    tags: [],
    hasReply: false,
  }))
}

test('分页：默认页大小生效，顺序是新的在前，total 是全部条数', () => {
  const page = paginateNotes(fakeNotes(50))
  assert.equal(page.notes.length, NOTES_PAGE_DEFAULT)
  assert.equal(page.total, 50, 'total 必须是全部条数，不是本页条数——面板要显示它')
  assert.equal(page.hasMore, true)
  // 最新的一条排在最前：次序在宿主侧定好，客户端才不用在渲染里 reverse。
  assert.equal(page.notes[0].id, 'n49')
  assert.equal(page.notes[NOTES_PAGE_DEFAULT - 1].id, `n${50 - NOTES_PAGE_DEFAULT}`)
  assert.equal(page.nextCursor, page.notes[page.notes.length - 1].id)
  assert.equal(page.reset, false)
})

test('分页：游标按 id 锚定——翻页途中向头部追加新笔记不会产生重复', () => {
  const all = fakeNotes(50)
  const first = paginateNotes(all, { limit: 20 })
  const seen = new Set(first.notes.map((note) => note.id))

  // 读者在翻页途中又写了一条新笔记，它插在**头部**。
  // 如果游标是下标，下一页就会整体后移一位、重复第一页的最后一条。
  const withNew = [...all, { ...all[0], id: 'fresh', excerpt: '刚写的' }]

  const second = paginateNotes(withNew, { limit: 20, before: first.nextCursor })
  assert.equal(second.reset, false, '游标还在，不该判定为失效')
  assert.equal(second.notes[0].id, 'n29', '第二页应当从第一页的锚点之后接着给')
  for (const note of second.notes) {
    assert.ok(!seen.has(note.id), `第二页重复了已经看过的 ${note.id}`)
  }
  assert.equal(second.total, 51, 'total 应当反映新增的那一条')
})

test('分页：游标失效时回第一页并置 reset，让面板替换而不是追加', () => {
  const page = paginateNotes(fakeNotes(50), { limit: 20, before: '这个 id 已经不存在了' })
  assert.equal(page.reset, true, '失效游标必须被标出来，否则面板会追加出重复条目')
  assert.equal(page.notes[0].id, 'n49', '失效游标应当回第一页')
  assert.equal(page.nextCursor, page.notes[19].id)
})

test('分页：limit 被夹到合法区间，非法值回落默认值而不是抛错', () => {
  const all = fakeNotes(300)
  assert.equal(paginateNotes(all, { limit: 5 }).notes.length, 5)
  assert.equal(
    paginateNotes(all, { limit: NOTES_PAGE_MAX + 100 }).notes.length,
    NOTES_PAGE_MAX,
    '超出上限必须夹住，否则一个调用方就能把整个笔记文件要走',
  )
  for (const bad of [undefined, null, '', 'abc', '0', '-3', 'NaN', {}, []]) {
    assert.equal(
      paginateNotes(all, { limit: bad }).notes.length,
      NOTES_PAGE_DEFAULT,
      `limit=${JSON.stringify(bad)} 应当回落默认值，而不是让笔记列表打不开`,
    )
  }
})

test('分页：手写的、没有 id 的块也有能推进的游标（否则「加载更多」会卡死）', () => {
  // 用户可能手写笔记块而不写 id 属性。此时游标必须退化成下标形式——
  // 否则 nextCursor 会是空串，被当成"没有游标"，点「加载更多」永远回第一页。
  const all = fakeNotes(50).map((note) => ({ ...note, id: '' }))
  const first = paginateNotes(all, { limit: 20 })
  assert.equal(first.nextCursor, 'at:20')
  assert.equal(first.hasMore, true)

  const second = paginateNotes(all, { limit: 20, before: first.nextCursor })
  assert.equal(second.notes.length, 20)
  assert.equal(second.notes[0].excerpt, '摘抄 29', '第二页应当接着第一页往下给')
  assert.equal(second.hasMore, true)
})

test('分页：最后一页 hasMore=false 且不给游标', () => {
  const all = fakeNotes(25)
  const first = paginateNotes(all, { limit: 20 })
  const last = paginateNotes(all, { limit: 20, before: first.nextCursor })
  assert.equal(last.notes.length, 5)
  assert.equal(last.hasMore, false)
  assert.equal(last.nextCursor, null, '没有下一页时不该给出游标')
})

test('分页：空列表与非数组输入都不抛错', () => {
  assert.deepEqual(
    paginateNotes([]),
    { notes: [], total: 0, hasMore: false, nextCursor: null, reset: false },
  )
  for (const bad of [undefined, null, 'not an array', 42]) {
    const page = paginateNotes(bad)
    assert.equal(page.total, 0)
    assert.deepEqual(page.notes, [])
    assert.equal(page.hasMore, false)
  }
})

test('解析：笔记对象不再带整块原文（body）——它和三段正文是同一份内容', () => {
  const md = `# 夜行 · 读书笔记\n\n${renderNoteBlock({
    id: 'x1',
    excerpt: '摘抄',
    thought: '感想',
    reply: '回应',
    chapterIndex: 0,
    chapterTitle: '第一章 雪',
  })}\n`
  const notes = parseNotes(md)
  assert.equal(notes.length, 1)
  assert.ok(
    !Object.hasOwn(notes[0], 'body'),
    'body 实测占响应体的一半（1000 条 940 KB 里 488 KB），而面板从来没用过它',
  )
  // 但读者能看见的三段必须一个不少。
  assert.equal(notes[0].excerpt, '摘抄')
  assert.equal(notes[0].thought, '感想')
  assert.equal(notes[0].reply, '回应')
})

test('书库：notesPage 与 notes 并存——前者分页，后者仍是全部', () => {
  const f = makeLibraryFixture()
  try {
    for (let i = 0; i < 3; i += 1) {
      f.library.writeNote(f.book.bookId, { excerpt: `摘抄 ${i}`, thought: `感想 ${i}` })
    }
    assert.equal(f.library.notes(f.book.bookId).length, 3, 'notes() 语义没变，仍是全部')

    const page = f.library.notesPage(f.book.bookId, { limit: 2 })
    assert.equal(page.notes.length, 2)
    assert.equal(page.total, 3)
    assert.equal(page.hasMore, true)
    // 新的在前：最新那条是「摘抄 2」。
    assert.equal(page.notes[0].excerpt, '摘抄 2')

    assert.throws(() => f.library.notesPage('0123456789abcdef'), /BOOK_NOT_FOUND/)
  } finally {
    f.cleanup()
  }
})

test('彻底删除：备份名撞名时必须另起一个，绝不覆盖上一代（回归：同一秒第二次删除）', () => {
  // ⚠️ 2026-10-02 三方评审 P1-4（B 发现，主评审把档位从 P2 提到 P1）：
  // 备份名的时间戳**只到秒**，而这里没有任何撞名检查 ⇒ 同一秒内的第二次「彻底删除」
  // 会让 `atomicWriteText` 直接**覆盖**上一代备份。
  //
  // 背景备份那一侧早就有撞名循环（`backupBackground` 的 `-2` / `-3`），笔记这一侧没有
  // —— 同一件事两份实现，改了一处漏了另一处。这是本轮唯一**不可逆丢读者文本**的路径：
  // 上一代备份里装的正是"删掉之前那份更全的笔记"。
  //
  // 守卫直接钉承诺：**已存在的备份文件不许被改动**。用当前这一秒的名字提前占位，
  // 复现的正是"同秒第二次删除"。
  const f = makeLibraryFixture()
  try {
    const bookId = f.book.bookId
    const note = f.library.writeNote(bookId, { excerpt: '要删掉的摘抄', thought: 'x', chapterIndex: 0 })
    f.library.trashNote(bookId, note.id)

    const notesPath = f.library.paths.notes(bookId)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const occupied = `${notesPath}.bak.${stamp}.md`
    writeFileSync(occupied, '上一代：绝不能被覆盖\n', 'utf8')

    const result = f.library.purgeNotes(bookId, [note.id])

    assert.equal(result.removed, 1)
    assert.notEqual(result.backupPath, occupied, '撞名时必须另起一个文件名')
    assert.equal(readFileSync(occupied, 'utf8'), '上一代：绝不能被覆盖\n', '已存在的备份被覆盖了')
    assert.ok(existsSync(result.backupPath), '新的一代要真的落盘')
    assert.ok(readFileSync(result.backupPath, 'utf8').includes('要删掉的摘抄'), '新备份应当是删除前的内容')
  } finally {
    f.cleanup()
  }
})

//#endregion
