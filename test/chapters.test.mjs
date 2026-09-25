/**
 * 章节解析的测试。
 *
 * 这套测试的重点不是"能不能切出章节"，而是**能不能拒绝不是章节的行**，
 * 以及在结构缺失时**如实降级**。dsh-reader 的失败模式正是后者：
 * 无章节头时退化成"全书一章"，用户打开就是一个几百万字的单页。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseChapters, validateChapters } from '../lib/host/chapters.js'

/** 生成一段足够长的正文行，用来把平均行长拉高。 */
const prose = (seed) =>
  `${seed}，他记得那天的雪落得很慢，像有人在半空里把时间掰开了一点点，然后一片一片地放下。天光从瓦缝里漏下来，落在门槛上，落在他收起来的那把伞上，他没有进去。`

test('章节：标准中文章节头被正确切分，且区间精确铺满全文', () => {
  const text = [
    '第一章 雪',
    prose('甲'),
    '',
    '第二章 夜',
    prose('乙'),
    '',
    '第三章 归',
    prose('丙'),
  ].join('\n')

  const { strategy, chapters, warnings } = parseChapters(text)

  assert.equal(strategy, 'heading-regex')
  assert.equal(chapters.length, 3)
  assert.deepEqual(chapters.map((c) => c.title), ['第一章 雪', '第二章 夜', '第三章 归'])
  assert.deepEqual(chapters.map((c) => c.index), [0, 1, 2])
  assert.deepEqual(validateChapters(chapters, text.length), [], '区间必须有序、不重叠、不越界')
  assert.equal(warnings.length, 0)
})

test('章节：卷级标题被表达为 volume 字段，而不是被丢弃', () => {
  // dsh-reader 用 filter 丢掉空章节，连带把卷标题也丢了。
  const text = [
    '第一卷 长夜',
    '第一章 雪',
    prose('甲'),
    '第二章 夜',
    prose('乙'),
    '第二卷 归途',
    '第三章 归',
    prose('丙'),
  ].join('\n')

  const { chapters, warnings } = parseChapters(text)

  // 卷标题本身没有独立正文，不该占一个可读章节。
  assert.equal(chapters.length, 3, '三章正文，两个卷标题只作为分组信息')
  assert.deepEqual(chapters.map((c) => c.volume), ['第一卷 长夜', '第一卷 长夜', '第二卷 归途'])
  assert.ok(warnings.some((w) => w.includes('卷级标题')))
})

test('章节：书名号/冒号/空格等标题变体都能识别', () => {
  const text = [
    '第1章：雪',
    prose('甲'),
    '第 2 章、夜',
    prose('乙'),
    '第3回 归',
    prose('丙'),
  ].join('\n')

  const { strategy, chapters } = parseChapters(text)
  assert.equal(strategy, 'heading-regex')
  assert.equal(chapters.length, 3)
  assert.deepEqual(chapters.map((c) => c.title), ['第1章：雪', '第 2 章、夜', '第3回 归'])
})

test('章节：正文里出现的“第X章”不会被误切', () => {
  // 这一行是**以章号开头**的完整句子：行长短、无引号，只有句末标点
  // 能把它和真标题区分开。它专门用来钉死"句末标点必须是硬否决"这条规则。
  const text = [
    '第一章 雪',
    prose('甲'),
    '第二章 夜这个标题他看了很久，然后继续往下读去，什么也没说。',
    prose('乙'),
    '第三章 归',
    prose('丙'),
    '第四章 别',
    prose('丁'),
  ].join('\n')

  const { strategy, chapters, warnings } = parseChapters(text)
  assert.equal(strategy, 'heading-regex', '不能被正文里的假标题拖进降级分支')
  assert.equal(chapters.length, 3, '正文中的标题串必须被忽略')
  assert.deepEqual(
    chapters.map((c) => c.title),
    ['第一章 雪', '第三章 归', '第四章 别'],
    '以章号开头但带句号的完整句子不得成为一个章节',
  )
  assert.ok(warnings.some((w) => w.includes('疑似正文')))
})

test('章节：候选不足 3 个时降级为定长分块，并如实标注', () => {
  const text = '完全没有章节结构的一段长文。'.repeat(400)
  const { strategy, chapters, warnings } = parseChapters(text, { fallbackBlockChars: 1000 })

  assert.equal(strategy, 'fixed-blocks')
  assert.ok(chapters.length > 1, '必须分块，而不是退化成全书一章')
  assert.match(chapters[0].title, /^正文 · 第 1 段$/)
  assert.ok(warnings.some((w) => w.includes('未检测到章节结构')))
  assert.deepEqual(validateChapters(chapters, text.length), [])
})

test('章节：定长分块优先在换行处断开，不把句子劈开', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `第 ${i} 行正文内容，长度大致均匀。`)
  const text = lines.join('\n')
  const { chapters } = parseChapters(text, { fallbackBlockChars: 500 })

  assert.ok(chapters.length > 1)
  // 除最后一块外，每块都应恰好结束在换行之后。
  for (const chapter of chapters.slice(0, -1)) {
    assert.equal(text[chapter.endChar - 1], '\n', `第 ${chapter.index} 块应在换行处收尾`)
  }
})

test('章节：空文件不抛错', () => {
  const { chapters, warnings } = parseChapters('   \n  ')
  assert.deepEqual(chapters, [])
  assert.ok(warnings.length > 0)
})

test('章节：首个标题之前的内容单独成章，不丢正文', () => {
  const text = [
    '版权信息与作者前言。',
    '',
    '第一章 雪',
    prose('甲'),
    '第二章 夜',
    prose('乙'),
    '第三章 归',
    prose('丙'),
  ].join('\n')
  const { chapters } = parseChapters(text)

  assert.equal(chapters[0].kind, 'front')
  assert.equal(chapters[0].title, '卷首')
  assert.equal(chapters[0].startChar, 0)
  assert.deepEqual(validateChapters(chapters, text.length), [])
})

test('章节：正文不含标题行本身（避免阅读界面重复显示标题）', () => {
  const text = ['第一章 雪', prose('甲'), '第二章 夜', prose('乙'), '第三章 归', prose('丙')].join('\n')
  const { chapters } = parseChapters(text)

  for (const chapter of chapters) {
    const body = text.slice(chapter.startChar, chapter.endChar)
    assert.ok(!body.startsWith(chapter.title), `第 ${chapter.index} 章正文不应以标题开头`)
    assert.notEqual(text[chapter.startChar], '\n', '正文不应以换行开头')
  }
  // 标题行的坐标单独保留，供目录跳转使用。
  assert.equal(text.slice(chapters[1].titleStartChar, chapters[1].titleEndChar), '第二章 夜')
})

test('章节：番外/外传被标成 extra，便于目录区分', () => {
  const text = ['第一章 雪', prose('甲'), '第二章 夜', prose('乙'), '番外 那天的伞', prose('丙')].join('\n')
  const { chapters } = parseChapters(text)
  assert.equal(chapters.at(-1).kind, 'extra')
})

test('章节：重复的「目录行」被合并，不变成一堆点开没内容的空章节', () => {
  // 一类盗版 TXT 的真实形态：每章正文前多插一行"外层序号 + 书自己的章号"，
  // 于是同一章在文件里出现两次，目录行自己只有一个换行的正文。
  // 《一世之尊》2807 条目录里有 1403 条是它——这正是本次要修的东西。
  const text = [
    '第1章 第1章',
    '',
    '第1章 机心',
    prose('甲'),
    '第2章 第0001章 机心',
    '',
    '第0001章 机心',
    prose('乙'),
    '第0003章 第0002章 空门',
    '',
    '第0002章 空门',
    prose('丙'),
  ].join('\n')

  const { strategy, chapters, warnings } = parseChapters(text)

  assert.equal(strategy, 'heading-regex')
  assert.deepEqual(
    chapters.map((c) => c.title),
    ['第1章 机心', '第0001章 机心', '第0002章 空门'],
    '三个真章节留下，两条目录行不留',
  )
  assert.deepEqual(chapters.map((c) => c.index), [0, 1, 2], 'index 必须是连续位置，客户端按它取正文')
  assert.ok(warnings.some((w) => w.includes('目录行')), '合并了多少条要如实报告')
  assert.ok(!warnings.some((w) => w.includes('没有正文')), '合并掉的不该再被当成空章节')
  assert.deepEqual(validateChapters(chapters, text.length), [])

  // 关键：目录行的文字**不能**被上一章吞掉。
  for (const chapter of chapters) {
    const body = text.slice(chapter.startChar, chapter.endChar)
    assert.ok(!/^第\d+章 第/.test(body), `第 ${chapter.index} 章正文里混进了目录行：${body.slice(0, 30)}`)
  }
  assert.ok(!text.slice(chapters[0].startChar, chapters[0].endChar).includes('第2章 第0001章'))
})

test('章节：只有正文为空的重复标题才合并，带正文的同形标题照样保留', () => {
  // `第1章 第2章的秘密` 形态上"嵌了第二个章号"，但它有正文，不是目录行。
  const text = [
    '第1章 第2章的秘密',
    prose('甲'),
    '第2章 夜',
    prose('乙'),
    '第3章 归',
    prose('丙'),
  ].join('\n')

  const { chapters } = parseChapters(text)
  assert.deepEqual(chapters.map((c) => c.title), ['第1章 第2章的秘密', '第2章 夜', '第3章 归'])
})

test('章节：相邻标题之间无正文时不崩，并报告空章节', () => {
  const text = ['第一章 雪', '第二章 夜', '第三章 归', prose('丙')].join('\n')
  const { chapters, warnings } = parseChapters(text)
  assert.equal(chapters.length, 3)
  assert.ok(warnings.some((w) => w.includes('没有正文')))
  assert.deepEqual(validateChapters(chapters, text.length), [])
})

test('章节：重复标题被计数并报告', () => {
  const text = ['第一章 雪', prose('甲'), '第二章 夜', prose('乙'), '第二章 夜', prose('丙')].join('\n')
  const { warnings } = parseChapters(text)
  assert.ok(warnings.some((w) => w.includes('重复标题')))
})

test('章节：validateChapters 能发现区间重叠与越界', () => {
  const overlap = validateChapters(
    [
      { index: 0, startChar: 0, endChar: 10 },
      { index: 1, startChar: 5, endChar: 8 },
    ],
    20,
  )
  assert.ok(overlap.some((p) => p.includes('重叠')))

  const outOfBounds = validateChapters([{ index: 0, startChar: 0, endChar: 30 }], 20)
  assert.ok(outOfBounds.some((p) => p.includes('超出')))
})
