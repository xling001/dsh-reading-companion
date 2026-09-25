/**
 * 抽样（T2）：按章长给额度、卷首章加权、以及"库侧默认值 = 配置缺省值"。
 *
 * ## 这一版改了什么
 *
 * 1. **每章额度从"绝对字数"改成"章长的一个比例"**
 *    （`u = clamp(lengthRatio × 章长, min, max)`）。旧形状（`lengthRatio: 0`，按预算
 *    均分）保留为合法配置，两种形状各有专测。
 * 2. **加权的判据多了一个绝对判据：卷首章。** 原来的"全书开头 5 章"也是绝对的；
 *    两个判据合起来表达同一件事——"这本书里位置固定的那几章值得读厚"。
 *
 * ## 为什么要用差分写
 *
 * 这一版没有让任何东西"变得能用"，它换的是两种取舍的形状。所以本文件的断言
 * 几乎都是**对照**：同一本书、同一份预算，只换一个开关，结果必须按预期分开。
 * "旧形状还在"这条尤其重要——它是出问题时的退路。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_DEFAULTS } from '../lib/index.js'
import { createLibrary } from '../lib/host/library.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = join(HERE, '.tmp')

/** 一句 22 字的填充，用来精确控制章长。 */
const LINE = '雪落在瓦上，像有人在半空里把时间掰开了一点点。'

/** 一章正文：`种子。` + n 句填充。 */
const body = (seed, sentences) => `${seed}。${LINE.repeat(sentences)}`

/**
 * 一本**两卷六章**的书。
 *
 *   - 长章约 3300 字、短章约 220 字：比例模式下它们分别落在上限与下限上，
 *     于是"按章长给"和"按预算均分"的差别在长度上看得见；
 *   - 卷首是第 1 章与第 4 章。测试里把 `emphasisChapters` 设成 1，于是**只有**
 *     第 4 章能验证"卷首"这个判据——第 1 章会被"全书开头"那条覆盖掉。
 */
function twoVolumeBook() {
  return [
    '第一卷 风起',
    '第一章 长甲', body('甲', 150), '',
    '第二章 短', body('乙', 10), '',
    '第三章 长丙', body('丙', 150), '',
    '第二卷 云涌',
    '第四章 长丁', body('丁', 150), '',
    '第五章 长戊', body('戊', 150), '',
    '第六章 长己', body('己', 150), '',
  ].join('\n')
}

let seq = 0

/** 建一个隔离书库并导入上面那本书。 */
function makeFixture() {
  seq += 1
  const root = join(TMP_ROOT, `sample-${process.pid}-${Date.now()}-${seq}`)
  const storageDir = join(root, 'storage')
  mkdirSync(join(storageDir, 'inbox'), { recursive: true })

  const sourcePath = join(root, '两卷本.txt')
  writeFileSync(sourcePath, Buffer.from(twoVolumeBook(), 'utf8'))

  const library = createLibrary({ storageDir, fallbackBlockChars: 1000 })
  library.ensureDirs()
  const { book } = library.importBook({ absPath: sourcePath, title: '两卷本' })

  return { root, library, bookId: book.bookId, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * 一份**固定**的抽样参数。
 *
 * `emphasisChapters: 1` 是关键：只有第 1 章落在"全书开头"的重点区间里，于是
 * 第 4 章若也拿到加权，只可能是因为它是**卷首**。
 */
const OPTIONS = {
  budgetChars: 100000,
  minPerChapter: 60,
  maxPerChapter: 600,
  lengthRatio: 0.2,
  emphasisChapters: 1,
  emphasisFactor: 3,
}

test('抽样：夹具本身成立（六章、两卷、长短分明）', () => {
  const f = makeFixture()
  try {
    const index = f.library.chapters(f.bookId).chapters
    assert.equal(index.length, 6, '章节解析必须先成立，否则下面的断言没有意义')
    assert.equal(index[0].volume, '第一卷 风起')
    assert.equal(index[3].volume, '第二卷 云涌')
    assert.equal(index[2].volume, '第一卷 风起', '第 3 章仍属于第一卷')

    const lengths = index.map((chapter) => chapter.endChar - chapter.startChar)
    assert.ok(lengths[1] < 300, `第 2 章应当是短章，实际 ${lengths[1]}`)
    for (const i of [0, 2, 3, 4, 5]) {
      assert.ok(lengths[i] > 3000, `第 ${i + 1} 章应当是长章，实际 ${lengths[i]}`)
    }
  } finally {
    f.cleanup()
  }
})

test('抽样：额度按章长给——短章不再白占一份绝对配额', () => {
  const f = makeFixture()
  try {
    const sample = f.library.sampleChapters(f.bookId, 0, 5, OPTIONS)

    assert.equal(sample.partial, false)
    assert.equal(sample.chapters.length, 6)
    assert.equal(sample.lengthRatio, 0.2)
    // 比例模式下每章额度不同，`perChapter` 只能承诺"至少这么多"——取本批实际
    // 发出的最小基准（这里正是短章那份，= 下限）。
    assert.equal(sample.perChapter, 60)

    const short = sample.chapters[1].text.length
    const long = sample.chapters[4].text.length
    assert.ok(short < long, `短章拿到的样本必须更少：${short} vs ${long}`)
    assert.ok(short <= 60 + 8, `短章应当只拿到下限那一点（+标记），实际 ${short}`)
  } finally {
    f.cleanup()
  }
})

test('抽样：卷首章拿到加权——**绝对**判据的第二个来源', () => {
  const f = makeFixture()
  try {
    const sample = f.library.sampleChapters(f.bookId, 0, 5, OPTIONS)

    // 第 1 章：落在"全书开头"的重点区间里。
    assert.ok(
      sample.chapters[0].text.length > sample.chapters[4].text.length * 2,
      '全书开头必须比普通章厚',
    )
    // 第 4 章：**不在**开头区间里，只因为它是第二卷的卷首。
    assert.ok(
      sample.chapters[3].text.length > sample.chapters[4].text.length * 2,
      `卷首章必须比普通章厚：${sample.chapters[3].text.length} vs ${sample.chapters[4].text.length}`,
    )
    // 第 2、3 章既不是开头也不是卷首 → 不加权。
    assert.ok(
      sample.chapters[2].text.length < sample.chapters[3].text.length,
      '第一卷的第二个长章不该享受卷首待遇',
    )
  } finally {
    f.cleanup()
  }
})

test('抽样加权：判据是**绝对**位置，不是"本批的头几章"（含卷首这条）', () => {
  const f = makeFixture()
  try {
    // 从第 5 章起取两章：两章都不是重点章。若判据写成了相对位置，本批的"头一章"
    // 会被当成重点——那样这两章就不等长了。
    const plain = f.library.sampleChapters(f.bookId, 4, 5, OPTIONS)
    const lengths = plain.chapters.map((chapter) => chapter.text.length)
    assert.equal(new Set(lengths).size, 1, `第 5、6 章应当等长，实际 ${lengths.join('/')}`)
    assert.equal(plain.emphasisChapters, 1)

    // 同一套参数从第 4 章起：它是卷首，必须更长——而它并不在"全书开头"区间里。
    const fromVolumeStart = f.library.sampleChapters(f.bookId, 3, 4, OPTIONS)
    assert.ok(
      fromVolumeStart.chapters[0].text.length > lengths[0] * 2,
      '卷首章在任何一批里都应当更厚',
    )
  } finally {
    f.cleanup()
  }
})

test('抽样：默认形状是**按预算均分**（v1.25 回退），按章长比例仍是可选项', () => {
  const f = makeFixture()
  try {
    // 默认（**不传** lengthRatio）必须就是均分——这是 v1.25 那次回退的核心断言。
    const { lengthRatio: omittedRatio, ...withoutRatio } = OPTIONS
    assert.equal(omittedRatio, 0.2, '夹具自己得先真的开着比例模式，否则下面的对照是假的')
    const byDefault = f.library.sampleChapters(f.bookId, 0, 5, withoutRatio)
    const uniform = f.library.sampleChapters(f.bookId, 0, 5, { ...OPTIONS, lengthRatio: 0 })
    assert.equal(byDefault.lengthRatio, 0, '默认必须是均分，不能悄悄回到比例')
    assert.deepEqual(
      byDefault.chapters.map((chapter) => chapter.text),
      uniform.chapters.map((chapter) => chapter.text),
    )

    const proportional = f.library.sampleChapters(f.bookId, 0, 5, OPTIONS)

    // 均分模式：非重点章一律拿到同一个绝对额度（这里顶到上限）。
    assert.equal(uniform.perChapter, 600)

    // ★ 回退的理由就在这两行：**同一章**在两种形状下命运不同。
    // 短章（约 220 字）在均分模式下整章装得下，在比例模式下只拿到下限那一小段。
    // v1.24 选过这个取舍（省下来的预算让给更多章），v1.25 又把它退回去了——
    // 因为读者读的不只是长篇，短章是他的真实用法。比例模式保留为选项。
    assert.equal(proportional.chapters[1].text.includes('（中略）'), true, '比例模式：短章被截断')
    assert.equal(uniform.chapters[1].text.includes('（中略）'), false, '均分模式：短章整章装得下')

    // 长章在两种形状下都被截断，但比例模式给得更多一些（均分要照顾所有章）。
    assert.ok(proportional.chapters[4].text.length >= uniform.chapters[4].text.length)
  } finally {
    f.cleanup()
  }
})

test('抽样：预算被尊重，且永远从前往后覆盖', () => {
  const f = makeFixture()
  try {
    const tight = f.library.sampleChapters(f.bookId, 0, 5, { ...OPTIONS, budgetChars: 2500 })

    assert.equal(tight.partial, true, '覆盖不全时必须如实报告')
    assert.equal(tight.chapters[0].index, 0, '从前往后覆盖，第一段一定在')
    assert.ok(tight.to < 5, '不应当一步跨到区间末尾')
    // 每章的正文部分不超过它的额度；`（中略）` 标记本身是额外 5 个字符。
    assert.ok(
      tight.totalChars <= 2500 + 5 * tight.chapters.length,
      `样本总量必须落在预算附近：${tight.totalChars}`,
    )
  } finally {
    f.cleanup()
  }
})

test('抽样：库侧兜底默认值与配置缺省值是**同一套**（别写两遍）', () => {
  // 这一条治的是一个很具体的形状：同一份默认值写在两处（`sampleChapters` 里的
  // `?? 60` 与 `index.js` 的 DEFAULTS），改一处忘一处时，走配置的路径与直接调库
  // 的路径会**悄悄分叉**。做法是让两个调用逐字段相等——比逐键比对更强，因为
  // 新增一个键忘了同步也会让它们不等。
  const f = makeFixture()
  try {
    const bare = f.library.sampleChapters(f.bookId, 1, 3, {})
    const explicit = f.library.sampleChapters(f.bookId, 1, 3, { ...CONFIG_DEFAULTS.sample })
    assert.deepEqual(bare, explicit, '库侧兜底默认值必须与 CONFIG_DEFAULTS.sample 等价')
    assert.equal(bare.lengthRatio, CONFIG_DEFAULTS.sample.lengthRatio)
    assert.equal(bare.lengthRatio, 0, 'v1.25 的默认是均分')
    // 下限要被**真的用到**才证明它与配置同源：预算给到极小，均分额度就只能落到
    // 下限上。⚠️ 这一条以前写的是"这一批含短章，所以最小值就是下限"——那在**比例**
    // 模式下成立，v1.25 回到均分之后不再成立（均分给每章同一份额度，短章只是装得下
    // 而已）。换形状时这种"顺手写下的断言"最容易变成一句无意义的真话。
    const squeezed = f.library.sampleChapters(f.bookId, 1, 3, { budgetChars: 1 })
    assert.equal(squeezed.perChapter, CONFIG_DEFAULTS.sample.minPerChapter)

    f.library.setProgress(f.bookId, { chapterIndex: 3, charOffset: 0 })
    const bareWindow = f.library.collectReadWindow(f.bookId, {})
    const fullWindow = f.library.collectReadWindow(f.bookId, { ...CONFIG_DEFAULTS.window })
    assert.deepEqual(bareWindow, fullWindow, '库侧兜底默认值必须与 CONFIG_DEFAULTS.window 等价')
    assert.equal(bareWindow.previous.mode, CONFIG_DEFAULTS.window.previousChapterMode)
  } finally {
    f.cleanup()
  }
})
