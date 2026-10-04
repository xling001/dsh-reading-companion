/**
 * 长章的三档处理（2026-10-02 读者拍板 **B+D**）：
 *
 *   - **> 8000 字**  ⇒ 导入 / 重切分时切成**子章**（"章节名02/03…"），下游一切机制
 *     （取样、注入、防剧透、跳读闸、冷归档）按子章粒度工作——因为**全仓的"章号"就是
 *     章节数组位置 + 1**，不是书里印的回目；
 *   - **4000–8000 字** ⇒ 保持整章，取样按比例读厚（那一半在 `sampling.test.mjs` 里钉）；
 *   - **< 4000 字**   ⇒ 完全维持现状。
 *
 * 守卫纪律：本文件先于实现写好、跑红，再改实现。
 */

import { test } from 'node:test'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_DEFAULTS } from '../lib/index.js'
import { createLibrary } from '../lib/host/library.js'
import { DEFAULT_LONG_CHAPTER_SPLIT, parseChapters, splitLongChapters, validateChapters } from '../lib/host/chapters.js'
import { BACKGROUND_SCHEMA_VERSION } from '../lib/host/background.js'

const TMP_ROOT = join(tmpdir(), 'drc-long-chapter-split')

/** 恰好 500 字的一段。 */
const PARA_500 = '山道上又起了雾，他把斗篷裹紧了些，脚下却没有停。'.repeat(21).slice(0, 500)

/**
 * `行数 × 80 字 + 换行` 的栅格文本：每行恰好 81 字符一个周期，
 * 段边界（换行之后）落在 81 的整倍数上——给"恰好 8000 字"这种精确边界用。
 */
function lineGrid(lines, lastLineChars = 0) {
  const row = '字'.repeat(80)
  const parts = []
  for (let i = 0; i < lines; i += 1) parts.push(`${row}\n`)
  if (lastLineChars > 0) parts.push('字'.repeat(lastLineChars))
  return parts.join('')
}

/** 三章的书：第 2 章 18 段（约 9000 字，必被切），另两章各 1 段（保完整）。 */
function threeChapterText() {
  const ch2 = Array.from({ length: 18 }, () => PARA_500).join('\n')
  return [
    '第一章 起', PARA_500, '',
    '第二章 风雪', ch2, '',
    '第三章 归', PARA_500, '',
  ].join('\n')
}

let seq = 0

/** 建一个隔离书库并导入给定的书文。`libraryOptions` 直通 createLibrary。 */
function makeFixture(bookText, libraryOptions = {}) {
  seq += 1
  const root = join(TMP_ROOT, `longchapter-${process.pid}-${Date.now()}-${seq}`)
  const storageDir = join(root, 'storage')
  mkdirSync(join(storageDir, 'inbox'), { recursive: true })
  const sourcePath = join(root, '书.txt')
  writeFileSync(sourcePath, Buffer.from(bookText, 'utf8'))
  const library = createLibrary({ storageDir, fallbackBlockChars: 1000, ...libraryOptions })
  library.ensureDirs()
  const { book } = library.importBook({ absPath: sourcePath, title: '书' })
  return { root, storageDir, library, bookId: book.bookId, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// --------------------------------------------------------------------------------------
// 纯函数：splitLongChapters
// --------------------------------------------------------------------------------------

test('切分：阈值语义是**严格大于**——恰好 8000 字的章不切，8001 才切', () => {
  const text = lineGrid(98, 62)
  assert.equal(text.length, 8000, '夹具必须恰好是阈值那么长')
  const atThreshold = splitLongChapters(
    [{ title: '第一章 甲', volume: null, kind: 'chapter', startChar: 0, endChar: 8000 }],
    text,
    { thresholdChars: 8000, targetChars: 2500 },
  )
  assert.equal(atThreshold.chapters.length, 1, '恰好等于阈值 ⇒ 保持整章')

  const over = splitLongChapters(
    [{ title: '第一章 甲', volume: null, kind: 'chapter', startChar: 0, endChar: 8001 }],
    lineGrid(98, 63),
    { thresholdChars: 8000, targetChars: 2500 },
  )
  assert.ok(over.chapters.length > 1, '超过阈值（哪怕 1 字）⇒ 必须切')
})

test('切分：只细分、不挪字——各片首尾相接、恰好铺满原章区间、切在换行之后', () => {
  const pieces = splitLongChapters(
    [{ title: '第一章 甲', volume: null, kind: 'chapter', startChar: 0, endChar: 8015 }],
    lineGrid(99), // 99 行 × 81 = 8019 ≥ 8015
    { thresholdChars: 8000, targetChars: 2500 },
  )
  assert.ok(pieces.chapters.length >= 2)
  let cursor = 0
  for (const piece of pieces.chapters) {
    assert.equal(piece.startChar, cursor, '各片必须首尾相接（无重叠无缝隙）')
    assert.ok(piece.endChar > piece.startChar)
    assert.equal(text_prev_is_newline(piece, lineGrid(99)), true, '第 2 片起必须从换行之后开始')
    cursor = piece.endChar
  }
  assert.equal(cursor, 8015, '铺满原章区间')
})

/** 第 n 片（n≥2）的前一个字符应当是换行。 */
function text_prev_is_newline(piece, text) {
  if (piece.startChar === 0) return true
  return text[piece.startChar - 1] === '\n'
}

test('切分：第 1 片保留原标题（与正文里的标题行逐字一致），第 2 片起编号 02、03…', () => {
  const result = splitLongChapters(
    [{ title: '第二章 风雪', volume: '第一卷', kind: 'chapter', startChar: 0, endChar: 8015, titleStartChar: 0, titleEndChar: 7 }],
    lineGrid(99),
    { thresholdChars: 8000, targetChars: 2500 },
  )
  const titles = result.chapters.map((c) => c.title)
  assert.equal(titles[0], '第二章 风雪', '第 1 片 = 原标题：目录与正文标题行逐字一致')
  assert.deepEqual(titles.slice(1), ['第二章 风雪02', '第二章 风雪03', '第二章 风雪04'])
  assert.equal(result.chapters[0].volume, '第一卷')
  assert.equal(result.chapters[3].volume, '第一卷', '各片继承卷归属（卷首加权与分组都靠它）')
  assert.equal(result.chapters[0].kind, 'chapter')
  assert.equal(result.chapters[3].kind, 'chapter')
  // 第 1 片保留标题行锚；第 2 片起没有标题行 ⇒ 不带 titleStartChar（titleAnchor 落到 startChar）
  assert.equal(result.chapters[0].titleStartChar, 0)
  assert.equal(result.chapters[1].titleStartChar, undefined)
})

test('切分：片长要均衡（都在目标的一半到目标 + 余量之间），不能把零头全挤给最后一片', () => {
  const result = splitLongChapters(
    [{ title: '第一章 甲', volume: null, kind: 'chapter', startChar: 0, endChar: 8015 }],
    lineGrid(99),
    { thresholdChars: 8000, targetChars: 2500 },
  )
  for (const piece of result.chapters) {
    const len = piece.endChar - piece.startChar
    assert.ok(len >= 1250, `片长不应小于目标的一半，实际 ${len}`)
    assert.ok(len <= 2600, `片长不应明显超过目标（2500 + 对齐余量），实际 ${len}`)
  }
})

test('切分：既没有换行、也没有句末标点的超长章保持整章，并如实报告（非散文，无从落切点）', () => {
  // ⚠️ 夹具刻意用**无标点**的重复字：这一档才是真的无解（表格 / base64 / 无标点流水账）。
  //    从前"没有换行"本身就等于放弃切分，后果是那一章**整章进每一轮注入**；现在换行
  //    之外还会试句末标点（见下一条），所以这条的判据收窄成"两种边界都没有"。
  const text = '字'.repeat(9000)
  const result = splitLongChapters(
    [{ title: '第一章 甲', volume: null, kind: 'chapter', startChar: 0, endChar: 9000 }],
    text,
    { thresholdChars: 8000, targetChars: 2500 },
  )
  assert.equal(result.chapters.length, 1, '两种边界都没有就保持整章——硬切只会切出无意义的片段')
  assert.ok(
    result.warnings.some((w) => w.includes('也没有句末标点')),
    `必须报告，且原因要如实（不许说成"没有换行边界"）：${result.warnings.join('; ')}`,
  )
})

test('切分：整章一段（没有换行）但**有句末标点**的超长章会被切开 —— 不许整章进每一轮注入', () => {
  // ⚠️ 这条守的是一个**成比例的取舍**（2026-10-03）：句末切点同样不会劈开句子，而放弃
  //    切分的代价是那一章**整章进每一轮注入**（`window.currentChapterMode` 默认 `'full'`、
  //    没有上限）—— 25,000 字的章就是每轮付 25,000 字，正是 D 要治的病。
  //    证伪方式：把 `planPieces` 里那句 `boundaries.push(...sentenceBoundaries(...))` 删掉
  //    （退回"没有换行就放弃"）⇒ 这条用例红。
  const sentence = '山道上又起了雾，他把斗篷裹紧了些，脚下却没有停。'
  const text = sentence.repeat(375)
  assert.equal(text.length, 9000, '夹具自证：24 × 375')
  assert.equal(text.includes('\n'), false, '夹具自证：整章一段，一个换行都没有')
  const result = splitLongChapters(
    [{ title: '第一章 甲', volume: null, kind: 'chapter', startChar: 0, endChar: 9000 }],
    text,
    { thresholdChars: 8000, targetChars: 2500 },
  )
  assert.ok(result.chapters.length > 1, `有句末标点就该切开，实际 ${result.chapters.length} 章`)
  // 每一片（第 1 片之外）都必须**从一个句子开头**开始 —— 不许劈开句子。
  for (const [k, piece] of result.chapters.entries()) {
    if (k === 0) continue
    const head = text.slice(piece.startChar, piece.startChar + 3)
    assert.equal(head, sentence.slice(0, 3), `第 ${k + 1} 片必须从句子开头开始，实际以「${head}」开头`)
  }
  assert.equal(result.chapters.at(-1).endChar, 9000, '最后一片必须铺到章尾')
})

test('切分：目标字数不小于章长时算不出两片，但**不许**说成「没有换行边界」', () => {
  // ⚠️ 体检发现的**假声明**（2026-10-03）：`planPieces` 有四种"规划不出来"的原因，
  //    原先被合并成同一句"没有可用的换行边界"。真机实测：`targetChars` 大于章长时，
  //    文本里有 60 个换行，提示照样那么说 —— 读者会去查**错的东西**。
  //    判据与仓库既有那条一致：说人话 ≠ 说一段听起来像真的模板话。
  const text = lineGrid(99) // 8019 字、99 个换行
  const result = splitLongChapters(
    [{ title: '第一章 甲', volume: null, kind: 'chapter', startChar: 0, endChar: 8015 }],
    text,
    { thresholdChars: 8000, targetChars: 9000 }, // 目标比章还长 ⇒ ceil(8015 / 9000) = 1 片
  )
  assert.equal(result.chapters.length, 1, '算不出两片就保持整章（宁可不切，不硬切）')
  const joined = result.warnings.join('; ')
  assert.ok(result.warnings.length > 0, `必须如实报告，而不是沉默：${joined}`)
  assert.equal(
    result.warnings.some((w) => w.includes('没有可用')),
    false,
    `这里有 99 个换行，"没有换行边界"是假声明：${joined}`,
  )
})

test('切分：定长分块的书再切分，章号必须仍是「数组位置」——不许出现重复章号', () => {
  // ⚠️ 体检发现的**真缺陷**（2026-10-03）：定长分块路径**先**给块编了号（`fixedBlocks`
  //    自己调 `withIndex`），切分时第 1 片继承原块的 `index`，而补号那一步写的是
  //    `{ index, ...chapter }` —— **继承来的值把算出来的位置盖掉了** ⇒ 排在后面的块
  //    拿到一个重复章号。实测（块 10000 / 阈值 8000）得到 `0,1,2,3,1`。
  //    而 `index` 是客户端目录的 key 与"当前章"的判据（`client.js` 的目录与正文页）
  //    ⇒ 重复章号是**静默错位**，不报错、不崩溃、界面看不出异常。
  const text = lineGrid(200) // 16,200 字，无章节结构 ⇒ 走定长分块
  const { strategy, chapters } = parseChapters(text, {
    fallbackBlockChars: 10000,
    longChapterSplit: { thresholdChars: 8000, targetChars: 2500 },
  })
  assert.equal(strategy, 'fixed-blocks')
  assert.ok(chapters.length > 2, `本用例要的是"切分后仍有后续块"的形状，实际 ${chapters.length} 章`)
  assert.deepEqual(
    chapters.map((c) => c.index),
    chapters.map((_, i) => i),
    'index 必须就是数组位置：唯一、连续、递增',
  )
})

// --------------------------------------------------------------------------------------
// 导入链路：parseChapters 集成
// --------------------------------------------------------------------------------------

test('导入：>8000 字的章被切成子章——目录、区间、警告齐全，其余章原样', () => {
  const bookText = threeChapterText()
  // ⚠️ parseChapters 自身的默认是"关"（开关在书库层）——在解析层测试切分要显式传。
  const { chapters, warnings } = parseChapters(bookText, { longChapterSplit: { thresholdChars: 8000, targetChars: 2500 } })
  assert.equal(chapters.length, 6, '1 + 4（9000 字 ≈ ceil/2500）+ 1')
  assert.deepEqual(
    chapters.map((c) => c.title),
    ['第一章 起', '第二章 风雪', '第二章 风雪02', '第二章 风雪03', '第二章 风雪04', '第三章 归'],
  )
  // 切出的各片必须两两相接，且区间不越过第二章的范围
  for (let k = 2; k <= 4; k += 1) {
    assert.equal(chapters[k].startChar, chapters[k - 1].endChar)
    assert.equal(bookText[chapters[k].startChar - 1], '\n', '切点必须在换行之后')
  }
  for (const c of chapters.slice(1, 5)) {
    const len = c.endChar - c.startChar
    assert.ok(len <= 2600 && len >= 1000, `片长应均衡：${len}`)
  }
  assert.ok(warnings.some((w) => w.includes('超长章')), `必须如实报告：${warnings.join('; ')}`)
  assert.deepEqual(
    validateChapters(chapters, bookText.length),
    [],
    '切完的索引必须仍然自洽（有序、不重叠、不越界）',
  )
})

test('导入：阈值上下各一章——8000 上下保完整与切分同时成立（三档语义里的中间档不受影响）', () => {
  // 15 段 × 500 + 14 = 7514（≤ 8000，保完整）；16 段 × 500 + 15 = 8015（> 8000，切）。
  // ⚠️ 夹具至少 3 个章头（MIN_ACCEPTED = 3），所以补一个小第三章。
  const bookText = [
    '第一章 短一点', Array.from({ length: 15 }, () => PARA_500).join('\n'), '',
    '第二章 长一点', Array.from({ length: 16 }, () => PARA_500).join('\n'), '',
    '第三章 收尾', PARA_500, '',
  ].join('\n')
  const { chapters } = parseChapters(bookText, { longChapterSplit: { thresholdChars: 8000, targetChars: 2500 } })
  assert.equal(chapters.length, 1 + 4 + 1, '7514 字保完整（1 片），8015 字切成 4 片')
  assert.equal(chapters[0].title, '第一章 短一点')
  assert.equal(chapters[1].title, '第二章 长一点')
  assert.equal(chapters[5].title, '第三章 收尾')
})

test('导入：longChapterSplit: null 关掉切分（旧行为原样保留；给 B 测试当对照）', () => {
  const bookText = threeChapterText()
  const { chapters } = parseChapters(bookText, { longChapterSplit: null })
  assert.equal(chapters.length, 3, '关掉 ⇒ 9000 字的章保持整章')
})

// --------------------------------------------------------------------------------------
// 书库链路：createLibrary 默认开启；重切分迁移
// --------------------------------------------------------------------------------------

test('书库：createLibrary 的兜底与 CONFIG_DEFAULTS 同源于唯一常量（不是两个字面量碰巧同值）', () => {
  // 这条**取代**了从前那句"两处各写一份默认值、靠测试钉住不许分叉"（2026-10-03）：
  // 默认值现在只有 `chapters.js` 的 `DEFAULT_LONG_CHAPTER_SPLIT` 一处，另两处浅拷贝它。
  // 所以断言从"两个字面量同值"升级成"都等于同一个来源"，并额外钉住**拷贝而非共享引用**
  // ——共享同一个冻结对象会让"改配置"变成运行时异常。
  //
  // ⚠️ 只留这一条：库侧兜底那条路没有可观察的句柄，再写一条"直接调库也切成 5 章"只是把
  //    同一个事实说两遍（9000 字的章在 5000/8000 两条阈值下都会切，证明不了同源）。
  const f = makeFixture(threeChapterText())
  try {
    assert.deepEqual(DEFAULT_LONG_CHAPTER_SPLIT, { thresholdChars: 5000, targetChars: 3500 })
    assert.deepEqual(CONFIG_DEFAULTS.longChapterSplit, DEFAULT_LONG_CHAPTER_SPLIT)
    assert.notEqual(
      CONFIG_DEFAULTS.longChapterSplit,
      DEFAULT_LONG_CHAPTER_SPLIT,
      '必须是浅拷贝，不能是同一个对象（否则改配置会撞上冻结）',
    )
    assert.equal(
      f.library.chapters(f.bookId).chapters.length,
      5,
      '默认导入就该切（9017 字的章 ⇒ ceil(9017/3500) = 3 片，1 + 3 + 1 = 5）',
    )
  } finally {
    f.cleanup()
  }
})

test('切分：**默认阈值就是 5000** —— 7514 字的章走默认路径必须被切（8000 的旧默认下它会保完整）', () => {
  // ⚠️ 上面那条只证明"常量写着 5000"，这条证明**它真的生效**：夹具造一个 7514 字的章
  //    —— 8000 的旧默认下它会保完整，5000 的新默认下它该被切。
  //    走 `createLibrary` 的**默认配置**（不传 `longChapterSplit`），两条默认值路径都被覆盖。
  //
  // 7514 = 15 × 500 + 14 个换行；片数 = min(ceil(7514/3500), 边界数+1) = 3。
  // ⚠️ 长度选 7514 是为了**两侧都有余量**：`ceil(·/3500) = 3` 要求 > 7000（余量 514），
  //    而"调回 8000 就该保完整"这个证伪条件要求 < 8000（余量 486）—— 7514 正好落在这条
  //    窄带 (7000, 8000) 的中间。
  // ⚠️ 从前这里是 7013：在 `targetChars = 2500` 下它只比 2×2500 高 **13 字**，片长一改
  //    就翻面（换 `targetChars` 时最先塌的就是这条）。现在余量是几百字。
  const long = Array.from({ length: 15 }, () => PARA_500).join('\n')
  assert.equal(long.length, 7514, '夹具自证：7514 字（> 7000 且 < 8000）')
  const text = ['第一章 起', PARA_500, '', '第二章 长', long, '', '第三章 归', PARA_500, ''].join('\n')
  const f = makeFixture(text)
  try {
    const titles = f.library.chapters(f.bookId).chapters.map((c) => c.title)
    assert.ok(
      titles.includes('第二章 长02'),
      `默认阈值必须是 5000：7514 字的章该被切，实际目录 ${JSON.stringify(titles)}`,
    )
    assert.equal(titles.length, 5, `1 + 3 片 + 1 = 5 章，实际 ${JSON.stringify(titles)}`)
  } finally {
    f.cleanup()
  }
})

test('切分：**4000–5000 的章不再被切**（阈值抬到 5000 的实际效果；4000 的旧默认下它会切）', () => {
  // ⚠️ 上面那条（7013 字）在 **4000 与 5000 下都会切**，区分不出这两个阈值 —— 它只证明
  //    "默认不是 8000"。**只有落在这条带里的章**才能证明阈值真的抬了，所以这条不能省。
  //
  // 4508 字：阈值退回 4000 ⇒ 切成 2 片（`ceil(4508/3500)`）；默认 5000 ⇒ 保完整。
  // 可证伪：把 `DEFAULT_LONG_CHAPTER_SPLIT.thresholdChars` 调回 4000 ⇒ 这条当场红。
  //
  // ⚠️ 这条同时钉住"阈值只决定切不切"：它断言的是**没有子章**，不是"片更大"。
  const long = Array.from({ length: 9 }, () => PARA_500).join('\n')
  assert.equal(long.length, 4508, '夹具自证：4508 字（> 4000 且 < 5000）')
  const text = ['第一章 起', PARA_500, '', '第二章 长', long, '', '第三章 归', PARA_500, ''].join('\n')
  const f = makeFixture(text)
  try {
    const titles = f.library.chapters(f.bookId).chapters.map((c) => c.title)
    assert.ok(
      !titles.includes('第二章 长02'),
      `4508 字的章不该被切（阈值 5000），实际目录 ${JSON.stringify(titles)}`,
    )
    assert.ok(titles.includes('第二章 长'), `整章必须还在，实际目录 ${JSON.stringify(titles)}`)
    assert.equal(titles.length, 3, `1 + 1 + 1 = 3 章，实际 ${JSON.stringify(titles)}`)
  } finally {
    f.cleanup()
  }
})

test('重切分（迁移）：老书就地升级——进度/笔记/草稿/覆盖**精确**搬家，摘抄一字不动', () => {
  const seqId = `resplit-${process.pid}-${Date.now()}-${(seq += 1)}`
  const root = join(TMP_ROOT, seqId)
  const storageDir = join(root, 'storage')
  mkdirSync(join(storageDir, 'inbox'), { recursive: true })
  const sourcePath = join(root, '长章书.txt')
  writeFileSync(sourcePath, Buffer.from(threeChapterText(), 'utf8'))

  // ---- 第一阶段：关掉切分导入（= 老版本建的书）----
  const oldLib = createLibrary({ storageDir, fallbackBlockChars: 1000, longChapterSplit: null })
  oldLib.ensureDirs()
  const { book } = oldLib.importBook({ absPath: sourcePath, title: '长章书' })
  const bookId = book.bookId
  assert.equal(oldLib.chapters(bookId).chapters.length, 3, '老索引里 9000 字的章没有切')

  // 读者状态：读到第二章 4500 字深处；那里有一条笔记与一份草稿
  const ch2 = oldLib.chapters(bookId).chapters[1]
  const ch2Text = oldLib.readChapter(bookId, 1).text
  const anchorOffset = 4500
  const excerpt = ch2Text.slice(4500, 4500 + 40)
  oldLib.setProgress(bookId, { chapterIndex: 1, charOffset: anchorOffset })
  oldLib.writeNote(bookId, { excerpt, thought: '记一笔', chapterIndex: 1, charOffset: anchorOffset })
  oldLib.saveDraft({ draftId: 'd1', bookId, chapterIndex: 1, charOffset: anchorOffset, excerpt, thought: '草稿' })

  // 已有的背景认识：老章号 1..2
  const bgPath = oldLib.backgroundPath(bookId)
  const bgBefore = [
    `<!-- drc-background: schema=${BACKGROUND_SCHEMA_VERSION} covered=1..2 updated=2026-10-02T00:00:00.000Z -->`,
    '# 《长章书》· 背景认识',
    '',
    '## 人物',
    '',
    '### 甲',
    '',
    '- `第1章` 出场。',
    '',
    '## 世界观',
    '',
  ].join('\n')
  writeFileSync(bgPath, bgBefore, 'utf8')

  const notesBefore = readFileSync(join(storageDir, 'books', bookId, 'notes.md'), 'utf8')

  // ---- 第二阶段：同一书库、默认配置（切分开）⇒ reindex 就地升级 ----
  const newLib = createLibrary({ storageDir, fallbackBlockChars: 1000 })
  newLib.ensureDirs()
  const report = newLib.reindex(bookId, { apply: true })

  assert.equal(report.changed, true)
  assert.equal(report.before, 3)
  assert.equal(report.after, 5)
  assert.equal(report.drift.length, 0, `机械重映射不允许有漂移：${report.drift.join('；')}`)

  const next = newLib.chapters(bookId).chapters
  // 进度：精确搬到 4500 字落进的那一片，偏移换成**片内**偏移
  const globalOffset = ch2.startChar + anchorOffset
  const piece = next.find((c) => c.startChar <= globalOffset && globalOffset < c.endChar)
  assert.ok(piece !== undefined, '4500 字深处必须落在第二章的某一片里')
  const progress = newLib.getProgress(bookId)
  assert.equal(progress.chapterIndex, piece.index)
  assert.equal(progress.charOffset, globalOffset - piece.startChar)

  // 笔记：坐标与标题搬了，摘抄一字不动；全文件只有属性行与标题行变了
  const note = newLib.notes(bookId)[0]
  assert.equal(note.chapterIndex, piece.index)
  assert.equal(note.charOffset, globalOffset - piece.startChar)
  assert.equal(note.excerpt, excerpt)
  const notesAfter = readFileSync(join(storageDir, 'books', bookId, 'notes.md'), 'utf8')
  const beforeLines = notesBefore.split('\n')
  const afterLines = notesAfter.split('\n')
  const changedLines = beforeLines.filter((line, i) => line !== afterLines[i]).length
  assert.equal(changedLines, 2, `外科手术式重映射只许动属性行与标题行两行，实际动了 ${changedLines} 行`)

  // 草稿：章号跟着搬
  const draft = newLib.listDrafts(bookId)[0]
  assert.equal(draft.chapterIndex, piece.index)

  // 覆盖：老章号 1..2 ⇒ 新章号 1..（第二章最后一片的 1 起章号）
  // ⚠️ 片数是 `ceil(9017 / targetChars)` ⇒ 改 `targetChars` 会改这个标题号。
  const lastPieceOfCh2 = next.findIndex((c) => c.title === '第二章 风雪03')
  assert.ok(lastPieceOfCh2 > 0)
  assert.deepEqual(newLib.background(bookId).covered, { first: 1, last: lastPieceOfCh2 + 1 })

  // 端到端：切完之后，注入窗口按**片**给——不再一次吞 9000 字
  const win = newLib.collectReadWindow(bookId, { ...CONFIG_DEFAULTS.window })
  assert.ok(
    win.current.text.length <= 3600,
    `当前"章"应当是一片（≤3600 字 ≈ 9017/3 + 对齐余量），实际 ${win.current.text.length}`,
  )

  rmSync(root, { recursive: true, force: true })
})

test('重切分（迁移）：有讨论时间线的书**拒绝落盘**——章号没有片内偏移，机械重映射无从谈起', () => {
  const f = makeFixture(threeChapterText(), { longChapterSplit: null })
  try {
    f.library.recordDiscussion(f.bookId, { chapterIndex: 1, thought: '这段聊了什么来着' })
    // ⚠️ 必须用**开了切分**的库实例去重切：老库实例的 `longChapterSplit: null` 会让
    // 解析结果与现状逐字相同 ⇒ `changed === false` 直接返回，那样这个用例什么都没验。
    const lib = createLibrary({ storageDir: f.storageDir, fallbackBlockChars: 1000 })
    const report = lib.reindex(f.bookId, { apply: false }) // 预演
    assert.ok(report.drift.some((d) => d.includes('讨论')), `预演必须点明讨论会漂：${report.drift.join('；')}`)
    assert.throws(() => lib.reindex(f.bookId, { apply: true }), /REINDEX_ANCHOR_DRIFT/)
  } finally {
    f.cleanup()
  }
})

test('重切分（迁移）：对不上号的笔记**拒绝落盘**（现状不变——猜一个章号比拒绝更糟）', () => {
  const f = makeFixture(threeChapterText(), { longChapterSplit: null })
  try {
    // 摘抄在正文里根本不存在 ⇒ 无法机械核对它属于哪一片
    f.library.writeNote(f.bookId, { excerpt: '这句摘抄并不存在于正文之中。', thought: '手写的', chapterIndex: 1, charOffset: 0 })
    const lib = createLibrary({ storageDir: f.storageDir, fallbackBlockChars: 1000 })
    const report = lib.reindex(f.bookId, { apply: false })
    assert.ok(report.drift.length > 0, '预演必须报出漂移')
    assert.throws(() => lib.reindex(f.bookId, { apply: true }), /REINDEX_ANCHOR_DRIFT/)
  } finally {
    f.cleanup()
  }
})
