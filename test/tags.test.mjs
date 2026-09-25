/**
 * 自动打 tag 测试。
 *
 * 打 tag 是**建议**而非断言，所以这里只钉两类东西：
 *   1. 归一化必须严格（tag 会进 md 的机器可读标记，含空白/逗号就解析不了）；
 *   2. 排序必须跟着**读者关心什么**走，而不是书里写了什么。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TAG_VOCABULARY, mergeTags, normalizeTag, normalizeTags, suggestTags } from '../lib/host/tags.js'

test('归一化：去掉 # 与空白，拒绝会破坏机器标记的字符', () => {
  assert.equal(normalizeTag('人设'), '人设')
  assert.equal(normalizeTag('#人设'), '人设')
  assert.equal(normalizeTag('##人设'), '人设')
  assert.equal(normalizeTag('  人设  '), '人设')

  // 内部空白会把一个 tag 变成两个词；逗号是 `tags=a,b` 标记的分隔符。
  assert.equal(normalizeTag('人 设'), '')
  assert.equal(normalizeTag('a,b'), '')
  assert.equal(normalizeTag('a，b'), '')
  assert.equal(normalizeTag(''), '')
  assert.equal(normalizeTag('#'), '')
  assert.equal(normalizeTag(null), '')
  assert.equal(normalizeTag(42), '')
  assert.equal(normalizeTag(undefined), '')

  // 过长要截断，而不是让一条笔记把文件名/标记撑爆。
  assert.equal(normalizeTag('x'.repeat(100)).length, 24)
})

test('归一化：列表去空、去重、保序', () => {
  assert.deepEqual(normalizeTags(['#人设', '人设', ' 文笔 ', '', null, '人 设']), ['人设', '文笔'])
  assert.deepEqual(normalizeTags('不是数组'), [])
  assert.deepEqual(normalizeTags(undefined), [])
})

test('建议：读者的感想比书的原文更能决定 tag', () => {
  // 同一句话：只有感想里出现"人设"，摘抄里出现"设定"。
  const fromThought = suggestTags({ excerpt: '这里的设定很扎实。', thought: '这段人设崩了吧。' })
  assert.ok(fromThought.includes('人设'), `感想里的信号应当被采信，得到 ${JSON.stringify(fromThought)}`)

  // 感想权重是摘抄的三倍：两边各命中一次时，感想那边应当排前面。
  const ranked = suggestTags({
    excerpt: '世界观很宏大。',
    thought: '这段情节的伏笔埋得真好。',
  })
  assert.equal(ranked[0], '情节', `感想侧应当排在摘抄侧之前，得到 ${JSON.stringify(ranked)}`)
})

test('建议：没有信号时回空数组，而不是硬塞一个 tag', () => {
  // 宁可不给，也不要给一个错的——用户看到空框会自己填，看到错 tag 会以为坏了。
  assert.deepEqual(suggestTags({ excerpt: '他走了。', thought: '嗯。' }), [])
  assert.deepEqual(suggestTags({}), [])
  assert.deepEqual(suggestTags(), [])
})

test('建议：受 limit 约束，且 limit 非法时回落到默认值', () => {
  const noisy = { thought: '人设崩了，文笔很好，世界观有趣，情节紧凑，太感动了，这是名场面，主题深刻，结构精巧' }
  assert.equal(suggestTags({ ...noisy, limit: 2 }).length, 2)
  assert.ok(suggestTags({ ...noisy }).length <= 4, '默认上限是 4')
  assert.ok(suggestTags({ ...noisy, limit: 0 }).length > 0, '非法 limit 应回落到默认值')
  assert.ok(suggestTags({ ...noisy, limit: -3 }).length > 0)
})

test('建议：重复提到同一主题会加分', () => {
  const once = suggestTags({ thought: '文笔不错。' })
  const thrice = suggestTags({ thought: '文笔不错。文笔真的很好。这个文笔我喜欢。' })
  assert.ok(once.includes('文笔'))
  assert.ok(thrice.includes('文笔'))
  // 反复提到时它应当成为首位。
  assert.equal(thrice[0], '文笔')
})

test('建议：可以传自定义词表（这是换领域的接缝）', () => {
  const vocabulary = [{ tag: '自建', keywords: ['暗号'] }]
  assert.deepEqual(suggestTags({ thought: '这是暗号', vocabulary }), ['自建'])
  // 默认词表里的词在自定义词表下不该再命中。
  assert.deepEqual(suggestTags({ thought: '文笔很好', vocabulary }), [])
})

test('建议：词表里的 tag 名必须本身就能通过归一化', () => {
  // 否则建议出来的 tag 会在写入时被 normalizeTags 悄悄丢掉。
  for (const entry of TAG_VOCABULARY) {
    assert.equal(normalizeTag(entry.tag), entry.tag, `内置 tag「${entry.tag}」无法通过归一化`)
    assert.ok(entry.keywords.length > 0, `内置 tag「${entry.tag}」没有信号词`)
  }
})

test('合并：建议在前、手写在后，整体去重', () => {
  assert.deepEqual(mergeTags(['人设'], ['文笔', '人设'], ['主题']), ['人设', '文笔', '主题'])
  assert.deepEqual(mergeTags(null, undefined), [])
})
