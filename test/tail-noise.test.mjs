/**
 * 章节切片的清洁化：剥掉章末"非正文"块，并把切点对齐到自然边界。
 *
 * ## 为什么这不是"锦上添花"
 *
 * 抽样把每章配额切成头 60% / 尾 40%，尾窗是**专门**留给收束信号的
 * （"于是他明白了那个人是谁"）。而中文网文的章末几乎总是粘着
 * 「作者有话说」「求月票」「（本章完）」——以默认 100 字配额算，
 * 40 字的尾窗会被整块占满，收束信号**归零**：拿到一个起景句和一个附言，
 * 情节推进全丢。
 *
 * ## 这几条测试真正钉住的东西
 *
 * 前五条保住算法；但**算法对而没接线**一样是白做，所以最后一组从
 * `sampleChapters` 走完整条路——那才是"读者实际拿到的那段文本"。
 * 只测纯函数的实现，把 `sampleChapters` 里那行调用删掉时会全绿。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  alignHeadCut,
  alignTailCut,
  createLibrary,
  stripChapterTrailingNoise,
} from '../lib/host/library.js'

const TMP_ROOT = join(tmpdir(), 'drc-tail-noise')
let seq = 0

/** 精确定长的一段假正文，便于把"标记"摆进/摆出尾窗（窗口 = 章长的 15%）。 */
const pad = (n) => '正'.repeat(n)

/** 900 字正文 + 一段尾巴。900 的 15% = 135，标记只要在末尾就落在窗内。 */
const withNote = (tail) => `${pad(900)}\n${tail}`

test('章末附言：整块剥掉，正文最后一句必须留着', () => {
  const out = stripChapterTrailingNoise(`${pad(900)}\n作者有话说：今天有事\n明天两更，抱歉。`)
  assert.equal(out.text.includes('作者有话说'), false)
  assert.equal(out.text.includes('明天两更'), false, '附言是整块的，不能只削掉首行')
  assert.equal(out.text, pad(900))
  assert.equal(out.cutAt, 900)
  assert.ok(out.removedChars > 0)
})

test('章末附言：求票 / 本章完 / 分隔线这些常见形态都认', () => {
  const notes = ['求月票，谢谢大家！', '求推荐票！', '（本章完）', '未完待续', '----------', '* * *', '字数补丁']
  for (const note of notes) {
    assert.equal(stripChapterTrailingNoise(withNote(note)).text, pad(900), `没认出来：${note}`)
  }
})

test('章末附言：正文中段的标记不被动（窗口只覆盖尾部 15%）', () => {
  const text = `求月票\n${pad(900)}`
  const out = stripChapterTrailingNoise(text)
  assert.equal(out.text, text)
  assert.equal(out.removedChars, 0)
})

test('章末附言：标记落在尾窗内、但其后仍有大段正文时不切', () => {
  // 标记在尾窗里（1005 字的 15% = 150 字窗口），但后面还跟着 100 字正文，
  // 超过窗口的 60% → 它不像章末附言，放弃。
  const text = `${pad(900)}\n求月票\n${pad(100)}`
  const out = stripChapterTrailingNoise(text)
  assert.equal(out.text, text, '不能因为正文里偶然出现「求月票」就砍掉后面 100 字')
})

test('切点对齐：头落在句读之后，尾落在段首；无从对齐时原样返回', () => {
  assert.equal(alignHeadCut('甲乙丙。丁戊己庚辛。壬癸', 2), 4, '头窗应取到第一个「。」之后')
  assert.equal(alignHeadCut('甲乙丙丁戊己庚辛', 2, 0), 2, '没有句读时不越界猜测')
  assert.equal(alignTailCut('第一段\n第二段\n第三段', 7), 8, '尾窗应从段首开始')
  assert.equal(alignTailCut('一整段没有换行的文字', 3, 0), 3, '没有换行时原样返回')
})

/**
 * 造一本 4 章的书，每章都是"长正文 + 章末附言"。
 *
 * ⚠️ 中段行以 `【` 开头是刻意的：解析器认「第N章」当章首，而中段行若也以
 * `第N章` 开头，一本 4 章的书会被切成几十章。加上 `【` 前缀即可让它们落选。
 *
 * @param {string} note 章末附言（空串 = 不带附言，用作对照）
 * @returns {object} fixture
 */
function makeBook(note = '作者有话说：今天有事，明天两更。') {
  seq += 1
  const root = join(TMP_ROOT, `noise-${process.pid}-${Date.now()}-${seq}`)
  const storageDir = join(root, 'storage')
  mkdirSync(join(storageDir, 'inbox'), { recursive: true })

  const sourcePath = join(root, '附言本.txt')
  const chapters = Array.from({ length: 4 }, (_, i) => {
    const tag = `【第${i + 1}章】`
    const mid = Array.from({ length: 40 }, (_, k) => `${tag}中段${k + 1}，情节继续推进。`).join('\n')
    return [`第${i + 1}章 标题${i + 1}`, `${tag}开头\n${mid}\n他终于在雪里认出了那个人。`, note].join('\n')
  })
  writeFileSync(sourcePath, Buffer.from(chapters.join('\n\n'), 'utf8'))

  const library = createLibrary({ storageDir, fallbackBlockChars: 1000 })
  library.ensureDirs()
  const { book } = library.importBook({ absPath: sourcePath, title: '附言本' })

  return { root, library, bookId: book.bookId, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('接线：sampleChapters 的尾窗不再被章末附言占满', () => {
  const f = makeBook()
  try {
    const sample = f.library.sampleChapters(f.bookId, 0, 3, {
      budgetChars: 6000,
      minPerChapter: 200,
      maxPerChapter: 400,
      emphasisFactor: 1,
    })

    assert.equal(sample.chapters.length, 4, '夹具本身要先成立，否则下面的断言没有意义')
    for (const c of sample.chapters) {
      assert.equal(c.text.includes('作者有话说'), false, `第 ${c.index + 1} 章的附言没被剥掉`)
      assert.match(c.text, /（中略）/, `第 ${c.index + 1} 章超过配额，中间应当标省略`)
      assert.match(c.text, /他终于在雪里认出了那个人。$/, `第 ${c.index + 1} 章的尾窗没落在收束句上`)

      // ★ 下面两条是**钉接线**用的，不是重复单元测试。
      // `alignHeadCut` / `alignTailCut` 单独测得到，但把 `sampleChapters` 里那两行
      // 调用换成裸数字，纯函数测试仍然全绿——函数对而没接线照样是 bug。
      const head = c.text.split('\n（中略）\n')[0]
      assert.match(head, /[。！？…；”』」）)]$/, `第 ${c.index + 1} 章的头窗没落在句读上`)
      const tail = c.text.split('\n（中略）\n')[1]
      assert.match(tail, /^(【|第|他)/, `第 ${c.index + 1} 章的尾窗没从段首开始`)
    }
  } finally {
    f.cleanup()
  }
})

test('接线：没有附言的章节照常给出，不会被无条件截断', () => {
  const f = makeBook('')
  try {
    const sample = f.library.sampleChapters(f.bookId, 0, 0, {
      budgetChars: 6000,
      minPerChapter: 2000,
      maxPerChapter: 6000,
      emphasisFactor: 1,
    })

    assert.equal(sample.chapters.length, 1)
    assert.equal(sample.chapters[0].text.includes('（中略）'), false, '整章装得下时不该出现省略标记')
    assert.match(sample.chapters[0].text, /他终于在雪里认出了那个人。$/)
  } finally {
    f.cleanup()
  }
})
