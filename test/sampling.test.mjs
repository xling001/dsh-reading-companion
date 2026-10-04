/**
 * 抽样（T2）：按预算均分给额度、卷首章加权、以及"库侧默认值 = 配置缺省值"。
 *
 * ## 这一版改了什么
 *
 * 1. **每章额度只有一种形状：按预算均分**（`u = clamp(budgetChars ÷ 权重和, min, max)`）。
 *    ⚠️ 2026-10-03（乙-2）：从前那条"每章额度 = 章长的一个比例"（`lengthRatio`）
 *    已经**整体退役** —— 它把短章截得比均分狠，而短章是读者的真实用法。退役后
 *    **传 `lengthRatio` 不报错、也不起作用**（静默降级），这条契约有专测。
 * 2. **加权的判据多了一个绝对判据：卷首章。** 原来的"全书开头 5 章"也是绝对的；
 *    两个判据合起来表达同一件事——"这本书里位置固定的那几章值得读厚"。
 *
 * ## 为什么要用差分写
 *
 * 这一版的断言几乎都是**对照**：同一本书、同一份预算，只换一个开关，结果必须
 * 按预期分开。⚠️ 比例模式退役后，"两种形状对照"那几条已经没有对照物了，
 * 它们改成了**"退役契约"**（传了也不生效）—— 对照的对手换成了"另一种写法"，
 * 而不是"另一种形状"。
 */

import { test } from 'node:test'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_DEFAULTS } from '../lib/index.js'
import { createLibrary } from '../lib/host/library.js'

const TMP_ROOT = join(tmpdir(), 'drc-sampling')

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

test('抽样：`lengthRatio` 已退役——传它也不再有比例形状（乙-2，2026-10-03）', () => {
  const f = makeFixture()
  try {
    // ⚠️ 这条钉的是**退役后的契约**，不是"默认值是多少"：老 `settings.json` 里
    //    带着 `sample.lengthRatio: 0.2` 的**不该报错**，但也**不许有任何效果** ——
    //    两种写法必须产出逐字节相同的样本。
    const withKey = f.library.sampleChapters(f.bookId, 0, 5, { ...OPTIONS, lengthRatio: 0.2 })
    const without = f.library.sampleChapters(f.bookId, 0, 5, OPTIONS)
    assert.deepEqual(withKey, without, '`lengthRatio` 必须被完全忽略（静默降级，不报错）')

    // 退役的字段不许再留在返回值里 —— 留着就会有人以为它还有意义。
    assert.equal('lengthRatio' in without, false, '返回值里不许再有 lengthRatio')

    // 均分：非重点章一律拿到同一个绝对额度（这里顶到上限）。
    assert.equal(without.perChapter, 600)
    // ★ 退役的理由就在这一行：短章（约 220 字）在均分模式下**整章装得下**，
    //   而比例模式只给它下限那一小段（v1.24 选过那个取舍，v1.25 读者又退回来了）。
    assert.equal(without.chapters[1].text.includes('（中略）'), false, '均分模式：短章整章装得下')
  } finally {
    f.cleanup()
  }
})

test('抽样：预算被尊重，且永远从前往后覆盖', () => {
  const f = makeFixture()
  try {
    // ⚠️ 预算要小到**均分额度被下限托住**才会真的丢章（比例模式退役后这是唯一的
    //    丢章路径）：权重和 10 × 下限 60 = 600 > 300 ⇒ 从后往前丢到装得下。
    const tight = f.library.sampleChapters(f.bookId, 0, 5, { ...OPTIONS, budgetChars: 300 })

    assert.equal(tight.partial, true, '覆盖不全时必须如实报告')
    assert.equal(tight.chapters[0].index, 0, '从前往后覆盖，第一段一定在')
    assert.ok(tight.to < 5, '不应当一步跨到区间末尾')
    // ⚠️ 均分模式下这条断言**不能**写成"逐字 ≤ 预算"：额度是每章一份、按章取整，
    //    而 `（中略）` 标记本身也占字。真正要钉的是"**没有把预算穿掉**" ——
    //    允许超出"最后那一章拿到的份额 + 它可能的标记"。
    //    （实测：预算 300 / 每章额度 75 / 两章 ⇒ 318，超出的是标记与取整。）
    assert.ok(
      tight.totalChars <= 300 + tight.perChapter + 8 * tight.chapters.length,
      `样本总量必须落在预算附近：${tight.totalChars}（预算 300，每章额度 ${tight.perChapter}）`,
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

// --------------------------------------------------------------------------------------
// 长章取样：**B 半边已删除**（2026-10-03，读者的选择）
//
// 从前这里有五条用例守"4000–8000 的保完整章按比例读厚"（额度 =
// max(均分值, ⌊章长 × longChapterRatio⌋)，上限 longMaxPerChapter）。切分阈值降到
// 4000 之后**那一档不存在了**：> 4000 的章在导入时就被切成 ~2500 的子章，子章各自
// 拿一份均分额度 —— 比整章按比例读厚**更深**。所以那五条连同机制一起删除，
// 只留下下面这条钉住"那一档真的没有了"。
// --------------------------------------------------------------------------------------

/** 506 字的一段。 */
const PARA_506 = LINE.repeat(22)

/**
 * 一本全由等长章组成的书：默认 15 段 ≈ **7604** 字/章（> 5000 ⇒ 导入时会被切）。
 * `paragraphsPerChapter` 调大可以造出更长的章（配合 `longChapterSplit: null` 用）。
 *
 * ⚠️ **长度要同时满足三件事**，换阈值或片长时先看这三条（否则下面那条用例会以
 *    令人费解的方式红）：
 *   ① **被切**：`7604 > thresholdChars`（5000），余量 2604 字；
 *   ② **切成 3 片**：`ceil(7604 / targetChars)`（3500）`= 3` —— 要求长度 > **7000**，余量 604；
 *   ③ **小于 8000**：这是那条用例的**证伪条件** —— 把 `thresholdChars` 调回 8000 时，
 *      7604 必须**不再被切**（否则章数断言照样绿，证伪就失效了），余量 396。
 * ② 与 ③ 把长度夹在 **(7000, 8000)** 这条窄带里，7604 落在它的中间。
 * ⚠️ 这正是 `targetChars` 停在 **3500** 而不是 4000 的原因：4000 下"3 片"要求长度 > 8000，
 *    与 ③ 直接冲突（见 `chapters.js` 里 `DEFAULT_LONG_CHAPTER_SPLIT` 的说明）。
 * ⚠️ 段数**不能少**：10 段 = 5069 字在阈值 5000 下只高 **69 字**，与阈值绑得太死
 *    （正是 `spoiler` 夹具踩过的坑）。
 */
function uniformChapterBook(chapterCount, paragraphsPerChapter = 15) {
  const out = []
  for (let i = 1; i <= chapterCount; i += 1) {
    out.push(`第${i}章 长章之${i}`)
    out.push(Array.from({ length: paragraphsPerChapter }, () => PARA_506).join('\n'))
    out.push('')
  }
  return out.join('\n')
}

/** 通用夹具：给定书文与 createLibrary 选项。 */
function makeFixtureFor(bookText, libraryOptions = {}) {
  seq += 1
  const root = join(TMP_ROOT, `uniform-${process.pid}-${Date.now()}-${seq}`)
  const storageDir = join(root, 'storage')
  mkdirSync(join(storageDir, 'inbox'), { recursive: true })
  const sourcePath = join(root, '等长书.txt')
  writeFileSync(sourcePath, Buffer.from(bookText, 'utf8'))
  const library = createLibrary({ storageDir, fallbackBlockChars: 1000, ...libraryOptions })
  library.ensureDirs()
  const { book } = library.importBook({ absPath: sourcePath, title: '等长书' })
  return { root, library, bookId: book.bookId, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('长章取样：中间档已消失 —— 7604 字的章在导入时就被切成 3 片，各按均分拿额度', () => {
  // ⚠️ 这条**取代**了 B 半边那五条用例（见上方说明）。它守的是"吃掉中间档"这件事
  //    真的发生了，而不是只改了注释。
  //    证伪方式：把 `DEFAULT_LONG_CHAPTER_SPLIT.thresholdChars` 调回 8000 ⇒ 7604 字的
  //    章保持完整、章数断言当场红（也说明"中间档"又回来了）。
  const f = makeFixtureFor(uniformChapterBook(6))
  try {
    const all = f.library.chapters(f.bookId).chapters
    // 片数 = ceil(7604 / 3500) = 3 ⇒ 6 章 × 3 = 18。
    assert.equal(all.length, 18, `6 个 ~7604 字的章各切 3 片 = 18，实际 ${all.length}`)

    // 均分模式下每片拿同一个 unit；只有"重点章"（开头 5 片 / 换卷那一片）拿 3 倍。
    // 18 片：前 5 片重点（Σw = 5×3 = 15）+ 后 13 片（13）⇒ Σw = 28 ⇒
    // unit = ⌊18000 / 28⌋ = 642。⚠️ 若 B 还在，整章会拿到 max(642, ⌊7604×0.25⌋ = 1901)。
    const sample = f.library.sampleChapters(f.bookId, 0, 17)
    const plain = sample.chapters.at(-1).text.length
    assert.ok(
      plain >= 600 && plain <= 900,
      `非重点子章应拿均分值（约 642），实际 ${plain} —— 超过 900 说明"按比例读厚"又回来了`,
    )
  } finally {
    f.cleanup()
  }
})
