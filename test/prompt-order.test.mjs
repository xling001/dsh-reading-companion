/**
 * 注入顺序、时间感知、书友设定 —— P0 那一批改动的测试。
 *
 * 本文件里最重要的一条是「缓存顺序」：它断言**只改进度或时间时，注入文本的
 * 稳定前缀逐字节不变**。那不是审美问题——prompt 缓存是前缀匹配的，前缀一变
 * 后面全部重算。旧版把「读者当前读到第 N 章」放在第一行，于是每翻一章整个
 * 前缀作废，命中率恒为 0。
 *
 * 所以这条测试的真正含义是：**有人把动态值挪回稳定区就会变红。**
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeElapsed,
  describeWindow,
  measureCacheSplit,
  renderCompanionSection,
  renderDiscussions,
  renderPersona,
  renderPolicy,
  renderSituation,
} from '../lib/host/spoiler.js'

/** 两个字符串的公共前缀长度。 */
function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i += 1
  return i
}

/**
 * 造一个最小的已读窗口。
 *
 * @param {object} [over] 覆盖字段
 * @returns {object}
 */
function fakeWindow(over = {}) {
  return {
    title: '测试书',
    totalChapters: 100,
    progress: { chapterIndex: 10, charOffset: 0 },
    current: { index: 10, title: '第十一章', text: '当前章的正文内容。'.repeat(20), truncatedBefore: false, mode: 'full' },
    previous: { index: 9, title: '第十章', text: '上一章的正文内容。'.repeat(20) },
    backgroundText: '## 你对这本书的背景认识\n\n> 覆盖：第 1–9 章。\n\n### 人物关系\n\n- 甲 ↔ 乙：对手（`第3章`）',
    backgroundChars: 120,
    backgroundCovered: { first: 1, last: 9 },
    memoryGap: null,
    ...over,
  }
}

/** 组装一次完整段落。 */
function section(over = {}) {
  const w = over.window ?? fakeWindow()
  return renderCompanionSection({
    window: w,
    title: w.title,
    progress: over.progress ?? w.progress,
    totalChapters: w.totalChapters,
    backgroundText: w.backgroundText,
    backgroundCovered: w.backgroundCovered,
    persona: over.persona,
    discussions: over.discussions,
    lastDiscussionAt: over.lastDiscussionAt ?? null,
    now: over.now ?? '2026-01-01T00:00:00.000Z',
    hasBackground: over.hasBackground ?? true,
    webGate: over.webGate ?? 'block-all',
  })
}

//#region 缓存顺序

test('缓存顺序：只改进度与时间，稳定前缀必须逐字节不变', () => {
  const a = section({ progress: { chapterIndex: 10, charOffset: 0 }, now: '2026-01-01T00:00:00.000Z' })
  const b = section({
    window: fakeWindow({
      progress: { chapterIndex: 20, charOffset: 0 },
      current: { index: 20, title: '第二十一章', text: '完全不同的正文。'.repeat(30), truncatedBefore: false, mode: 'full' },
      previous: { index: 19, title: '第二十章', text: '又一段不同的正文。'.repeat(30) },
    }),
    progress: { chapterIndex: 20, charOffset: 0 },
    now: '2026-03-05T09:30:00.000Z',
  })

  const splitA = measureCacheSplit(a)
  const splitB = measureCacheSplit(b)

  assert.equal(a.slice(0, splitA.stable), b.slice(0, splitB.stable), '稳定前缀不能随进度/时间变化')
  assert.ok(splitA.stable > 400, `稳定前缀太短了（${splitA.stable} 字），缓存收益接近零`)
  assert.equal(splitA.stable, splitB.stable, '两边的分界点必须一致')
})

test('缓存顺序：动态值一个都不能留在稳定前缀里', () => {
  const text = section({ progress: { chapterIndex: 10, charOffset: 0 } })
  const stable = text.slice(0, measureCacheSplit(text).stable)

  // 这几样都是"每章/每天会变"的，出现在稳定区就等于缓存失效。
  assert.doesNotMatch(stable, /当前读到/, '进度不能出现在稳定区')
  assert.doesNotMatch(stable, /今天：/, '日期不能出现在稳定区')
  assert.doesNotMatch(stable, /距上次/, '时间感知不能出现在稳定区')
  // ⚠️ 只匹配**标题行**。头部那段说明里确实有「已读内容」这四个字（它在
  // 介绍下面会给什么），那是稳定文案，不是正文本身。用裸词断言会误报。
  assert.doesNotMatch(stable, /\n## 已读内容/, '正文不能出现在稳定区')

  // 而它们必须在**动态区**里真的出现，否则就是功能丢了。
  const dynamic = text.slice(measureCacheSplit(text).stable)
  assert.match(dynamic, /当前读到/)
  assert.match(dynamic, /今天：/)
  assert.match(dynamic, /已读内容/)
})

test('缓存顺序：分界点必须真的落在「## 当前情况」上', () => {
  // 这条是给 measureCacheSplit 自己用的：它是按字符串找分界线的，一旦渲染
  // 顺序变了而它没跟着改，它就会悄悄报出一个偏大的稳定前缀——而所有依赖
  // 它的断言都会跟着变松。所以这里把两者的定义钉在一起。
  const text = section()
  const split = measureCacheSplit(text)
  assert.equal(text.slice(split.stable, split.stable + '## 当前情况'.length), '## 当前情况')
  assert.equal(split.stable + split.dynamic, split.total)
  assert.equal(split.total, text.length)
})

test('describeWindow：把缓存分界暴露给面板（用户要能自己判断有没有用）', () => {
  const text = section()
  const summary = describeWindow(text, fakeWindow(), { personaChars: 12, discussionCount: 3 })
  assert.equal(summary.cacheSplit.total, text.length)
  assert.ok(summary.cacheSplit.stable > 0)
  assert.equal(summary.personaChars, 12)
  assert.equal(summary.discussionCount, 3)
})

//#endregion

//#region 时间感知

test('时间感知：只算到"天"，且用自然日差而不是 24 小时', () => {
  const now = '2026-03-10T08:00:00.000Z'
  assert.equal(describeElapsed(now, '2026-03-10T01:00:00.000Z'), '今天')
  // 昨晚 23:00 → 今早 08:00 只差 9 小时，但那是「昨天」。
  assert.equal(describeElapsed(now, '2026-03-09T23:00:00.000Z'), '昨天')
  assert.equal(describeElapsed(now, '2026-03-07T23:00:00.000Z'), '3 天前')
  assert.equal(describeElapsed(now, '2026-03-11T00:00:00.000Z'), '今天', '未来时间不该产出负数')
})

test('时间感知：拿不到或非法的时间回 null，而不是编一个', () => {
  assert.equal(describeElapsed('2026-03-10T00:00:00Z', null), null)
  assert.equal(describeElapsed('2026-03-10T00:00:00Z', ''), null)
  assert.equal(describeElapsed(null, '2026-03-10T00:00:00Z'), null)
  assert.equal(describeElapsed('不是时间', '2026-03-10T00:00:00Z'), null)
})

test('时间感知：进了段落，而且是动态区', () => {
  const text = section({ now: '2026-03-10T08:00:00.000Z', lastDiscussionAt: '2026-03-07T08:00:00.000Z' })
  assert.match(text, /今天：2026-03-10/)
  assert.match(text, /距上次和这位读者聊这本书：\*\*3 天前\*\*/)
})

test('时间感知：从没聊过时整行省略，而不是写「不明」', () => {
  const text = section({ now: '2026-03-10T08:00:00.000Z', lastDiscussionAt: null })
  assert.doesNotMatch(text, /距上次/)
})

test('情况：缺口必须明说，而且只有动态区能说', () => {
  const withGap = renderSituation({
    progress: { chapterIndex: 20 },
    backgroundCovered: { first: 1, last: 9 },
    hasBackground: true,
  })
  assert.match(withGap, /覆盖到第 9 章/)
  assert.match(withGap, /第 10–20 章\*\*尚未\*\*纳入/)

  const noGap = renderSituation({
    progress: { chapterIndex: 9 },
    backgroundCovered: { first: 1, last: 9 },
    hasBackground: true,
  })
  assert.doesNotMatch(noGap, /尚未\*\*纳入/)
})

//#endregion

//#region 书友设定

test('书友设定：空内容不产出任何段落（留空 = 不加设定）', () => {
  assert.equal(renderPersona(''), '')
  assert.equal(renderPersona('   \n  '), '')
  assert.equal(renderPersona(null), '')
  assert.equal(renderPersona(undefined), '')
})

test('书友设定：有内容时带框架与结束标记', () => {
  const text = renderPersona('说话简短一点')
  assert.match(text, /## 书友设定（读者自己写的）/)
  assert.match(text, /说话简短一点/)
  assert.match(text, /读者设定开始/)
  assert.match(text, /读者设定结束/)
})

test('书友设定：用户写的 {{ 必须被转义（它同样进 prompt 段落）', () => {
  assert.doesNotMatch(renderPersona('{{书名}}'), /\{\{/)
})

test('书友设定：优先级写在守则里，且无条件存在', () => {
  // 用户完全可能写一句"详细讲讲后续剧情"。守则是唯一能挡住它的地方，
  // 所以这条声明不能只在"有设定时才出现"——那样用户一保存人设，
  // 稳定前缀就变了一次，缓存白丢。
  const policy = renderPolicy('x')
  assert.match(policy, /只调风格，不越守则/)
  assert.match(policy, /以本守则为准/)
})

test('书友设定：先进守则、再进设定——顺序本身就是优先级', () => {
  const text = section({ persona: '用轻松的语气聊' })
  const policyAt = text.indexOf('## 陪读守则')
  const personaAt = text.indexOf('## 书友设定')
  const backgroundAt = text.indexOf('你对这本书的背景认识')
  assert.ok(policyAt >= 0 && personaAt > policyAt, '设定必须排在守则之后')
  assert.ok(backgroundAt > personaAt, '背景认识排在设定之后')
})

test('书友设定：加不加设定，稳定前缀的长度只差设定本身', () => {
  // 换言之：设定不会"激活"别的段落。它一旦激活别的段落（比如让守则多一条），
  // 用户保存一次设置就会让缓存前缀整体位移。
  const without = section({ persona: '' })
  const withPersona = section({ persona: '简短一点' })
  assert.ok(withPersona.length > without.length)
  assert.equal(
    withPersona.slice(0, without.indexOf('## 你对这本书的背景认识')),
    section({ persona: '简短一点' }).slice(0, without.indexOf('## 你对这本书的背景认识')),
  )
})

//#endregion

//#region 讨论时间线

test('讨论时间线：没有记录就不产出段落', () => {
  assert.equal(renderDiscussions([]), '')
  assert.equal(renderDiscussions(null), '')
})

test('讨论时间线：只给几句摘要，不复刻对话', () => {
  const text = renderDiscussions([
    { at: '2026-03-07T00:00:00Z', kind: 'note', chapterIndex: 15, thought: '结尾写得好', excerpt: '一整段摘抄' },
  ], { now: '2026-03-10T00:00:00Z' })

  assert.match(text, /## 你们之前聊过/)
  assert.match(text, /3 天前/)
  assert.match(text, /第 16 章/)
  assert.match(text, /结尾写得好/)
})

test('讨论时间线：感想优先于摘抄（那是读者自己的话）', () => {
  const text = renderDiscussions([{ at: '2026-03-10T00:00:00Z', chapterIndex: 3, thought: '我的感想', excerpt: '书里的原话' }])
  assert.match(text, /我的感想/)
  assert.doesNotMatch(text, /书里的原话/)
})

test('讨论时间线：受 limit 约束，取的是**最近**的几条（入参约定：新在前）', () => {
  // 入参顺序是「新在前」——宿主侧的 recentDiscussions 与 listDiscussions 都
  // 是这个顺序。这里刻意按约定构造，否则测的就不是真实调用路径。
  const records = Array.from({ length: 20 }, (_, i) => ({
    at: '2026-03-10T00:00:00Z',
    chapterIndex: 19 - i,
    thought: `第${19 - i}条`,
  }))
  const text = renderDiscussions(records, { limit: 2 })
  assert.match(text, /第19条/)
  assert.match(text, /第18条/)
  assert.doesNotMatch(text, /第17条/)
})

test('讨论时间线：limit 不合法时回落到默认 8 条', () => {
  const records = Array.from({ length: 20 }, (_, i) => ({ at: '2026-03-10T00:00:00Z', chapterIndex: i, thought: `第${i}条` }))
  const lines = renderDiscussions(records).split('\n').filter((line) => line.startsWith('- '))
  assert.equal(lines.length, 8)
})

test('讨论时间线：单行摘要会被截断，不把整段感想塞进去', () => {
  const long = '很长'.repeat(200)
  const text = renderDiscussions([{ at: '2026-03-10T00:00:00Z', chapterIndex: 1, thought: long }])
  const line = text.split('\n').find((item) => item.startsWith('- '))
  assert.ok(line.length < 120, `摘要太长了：${line.length}`)
  assert.match(line, /…$/)
})

test('讨论时间线：进了段落，而且在动态区', () => {
  const text = section({
    discussions: [{ at: '2026-03-09T00:00:00Z', kind: 'note', chapterIndex: 5, thought: '一句感想' }],
    lastDiscussionAt: '2026-03-09T00:00:00Z',
    now: '2026-03-10T00:00:00Z',
  })
  assert.match(text, /你们之前聊过/)
  const stable = text.slice(0, measureCacheSplit(text).stable)
  assert.doesNotMatch(stable, /你们之前聊过/, '时间线是动态的，不能进稳定区')
})

//#endregion
