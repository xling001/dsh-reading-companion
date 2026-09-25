/**
 * 跳读闸：读者从目录直接点开很靠后的一章时，**不自动补齐**。
 *
 * ## 为什么必须有一道闸
 *
 * 这是本插件里唯一**不可逆**的数据损坏路径。读者点开第 150 章时缺口是
 * 第 1–149 章；此刻自动补齐会把第 140 章的条目写进 `background.md`，而这份
 * 文件之后会被原样注入。等他回到第 20 章老实读，那些条目就是静默剧透——
 * 而且**没有干净的补救**：唯一的办法是 `background/reset`，那会连真读过的
 * 记忆一起清掉。
 *
 * 闸门不是"禁止补齐"，是**先问一句**。读者有两个诚实的答案：
 *
 *   - `mode: 'all'`    —— 这些章我确实都读过（旧行为）
 *   - `mode: 'recent'` —— 我从这里接着读：只记最近这一段，别碰前面几百章
 *
 * ## 这几条测试真正钉住的东西
 *
 * 最要紧的是 `labels.length === 0`：闸门拦下时必须**一次模型调用都没发**。
 * 只断言状态码 409、不断言"没花钱"的话，"先跑一次调用再报错"这种实现会全绿，
 * 而它恰好烧掉了用户明确拒绝的那次十几分钟的等待。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { call, makeDir, startServer } from './helpers/server.mjs'

const prose = (seed) =>
  `${seed}，他记得那天的雪落得很慢，像有人在半空里把时间掰开了一点点，然后一片一片地放下。`

/** 一本 160 章的书——足够造出远超跳读闸（默认 50 章）的缺口。 */
const LONG_BOOK = Array.from(
  { length: 160 },
  (_, i) => [`第${i + 1}章 标题${i + 1}`, prose(`正文${i + 1}`)].join('\n'),
).join('\n\n')

/** 假模型输出：只要是一份能解析的背景认识就够，闸门测试不关心内容。 */
const MEMORY_OUTPUT = ['## 世界观', '- `第1章` 抽样得到的设定'].join('\n')

/**
 * 假子代理服务，**记录每一次调用的 label**。
 *
 * 记录是刻意的：`labels.length` 就是"这次操作花了多少钱"的唯一证据。
 *
 * @param {string[]} labels 收件箱
 * @returns {object} 假的 subagents 服务
 */
function fakeSubagents(labels) {
  return {
    start: async (kind, spec) => {
      labels.push(spec.label)
      return {
        result: Promise.resolve({ output: [{ type: 'text', text: MEMORY_OUTPUT }] }),
        dispose: async () => {},
      }
    },
  }
}

/**
 * 导入那本 160 章的书。
 *
 * 不复用 `helpers/server.mjs` 的 `importBook`：它写死了一本三章的书，而
 * 跳读闸只有在缺口足够大时才可能触发。
 *
 * @param {string} base 服务器 base URL
 * @param {string} dir 书库目录
 * @returns {Promise<string>} bookId
 */
async function importLongBook(base, dir) {
  const absPath = join(dir, `long-${process.pid}-${Date.now()}.txt`)
  writeFileSync(absPath, LONG_BOOK, 'utf8')
  const res = await call(`${base}/library/import`, { method: 'POST', body: { absPath, title: '长书' } })
  assert.equal(res.status, 200, `导入失败：${JSON.stringify(res.body)}`)
  return res.body.book.bookId
}

/**
 * 起服务、导入长书、绑定会话，并把进度推到第 `chapterIndex + 1` 章。
 *
 * @param {string} tag 临时目录前缀
 * @param {object} [config] 额外配置
 * @returns {Promise<{ s: object, bookId: string, labels: string[] }>}
 */
async function setup(tag, config) {
  const labels = []
  const dir = makeDir(tag)
  const s = await startServer(dir, {
    subagents: fakeSubagents(labels),
    agents: { get: () => ({ id: 'parent' }) },
    ...(config === undefined ? {} : { config }),
  })
  const bookId = await importLongBook(s.base, dir)
  await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: `sess-${tag}` } })
  return { s, bookId, labels }
}

test('跳读闸：**手动补**时缺口超阈值不自动补，回 409 且**一次调用都没发**', async () => {
  // ⚠️ `ask: true` = "我是主动来补的"（面板那颗「补齐前文记忆」）。只有它会撞上闸门；
  // 发笔记那一路走的是"自动打底"（见下面那条用例）。
  const { s, bookId, labels } = await setup('jump-gate')
  try {
    // 直接跳到第 150 章。缺口 = 第 1–149 章。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: { ask: true } })

    assert.equal(res.status, 409)
    assert.equal(res.body.error, 'LARGE_GAP')
    assert.deepEqual(res.body.gap, { from: 1, to: 149, chapters: 149 })
    assert.equal(res.body.gate, 50, '响应要把阈值带上，客户端才能把话说准')
    // 窗口与阈值是**两个数**：阈值（50）只管"要不要先问一句"，窗口（200）管
    // "最近这一段取多宽"。v2.0.2 之前它们共用一个数，于是想放大窗口就得放松闸门。
    assert.equal(res.body.recentWindow, 200, '默认窗口 200 章')
    // 两个预估必须一起带上，否则弹窗只能干说一句"超过阈值了"，读者没法判断值不值。
    assert.equal(res.body.estimate.all.perChapter, 600, '全量纳入的每章下限（v1.67：150 → 600）')
    assert.equal(res.body.estimate.recent.perChapter, 1200, 'recent 那条路更厚（1200）')
    assert.equal(res.body.estimate.recent.window, 149, '窗口比缺口大时，预估按整个缺口算')
    // ⚠️ "全部纳入"是 4 批而不是 1 批：首次补齐先走 30 章打底，剩下的按每批 40 章
    //（24000 ÷ 600）切。预估漏掉打底就会少报一批。
    assert.equal(res.body.estimate.all.batches, 4, '30 章打底 + 119 章 ÷ 40 章 = 4 批')
    assert.equal(res.body.estimate.recent.batches, 8, '149 章 ÷ 每批 20 章（24000 ÷ 1200）')

    // ★ 这条是整组测试的重点：闸门不能"先花钱再报错"。
    assert.deepEqual(labels, [], '被闸门拦下时不该发出任何一次模型调用')

    // 文件也必须一个字都没动。
    const bg = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(bg.body.covered, null, '被拦下时不该推进水位线')
  } finally {
    await s.close()
  }
})

test('跳读闸：mode=all 放行，回到旧行为（打底批次）', async () => {
  const { s, bookId, labels } = await setup('jump-gate-all')
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, {
      method: 'POST',
      body: { mode: 'all' },
    })

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(labels.length > 0, '放行之后必须真的发起了补齐')
    // 首次补齐走"打底"：前面 30 章读厚，剩下的留到下一次。
    assert.deepEqual(res.body.covered, { first: 1, last: 30 })
    assert.equal(res.body.partial, true, '149 章的缺口不可能一次补完')
  } finally {
    await s.close()
  }
})

test('跳读闸：mode=recent 只记最近这一段，**绝不碰前面那几百章**', async () => {
  // 把窗口钉成 20 章。这本书只有 160 章 —— 用默认的 200 会让"最近 200 章"盖住整个
  // 缺口，这条用例就失去意义了。顺带钉住"窗口与阈值是两个数"：阈值仍是默认的 50，
  // 窗口却只取 20。
  const { s, bookId, labels } = await setup('jump-gate-recent', { sample: { recentWindowChapters: 20 } })
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, {
      method: 'POST',
      body: { mode: 'recent' },
    })

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(labels.length > 0)
    // 最近 20 章 = 第 130–149 章。起点是 130 而不是 1，这正是这道选项的全部意义。
    assert.deepEqual(res.body.covered, { first: 130, last: 149 })
    assert.equal(res.body.sampled.first, 130)
    assert.equal(res.body.sampled.last, 149)
    assert.equal(res.body.sampled.chapters, 20)
    // ⚠️ v1.67：这里拿到的是 **1200**（= 新的 `recentMinPerChapter`）—— 20 章 × 1200
    // = 24,000，正好把这一批的预算用满，限额 `min(max, max(min, 预算 ÷ 权重和))` 三边相等。
    // 从前是 600（旧的 `maxPerChapter` 封顶）：那时 20 章 × 300 只花 6000，预算用不完。
    assert.equal(res.body.sampled.perChapter, 1200, '窄窗口下这一段直接拿满（24000 ÷ 20 章 = 1200）')

    // ⚠️ 并且**不能**走打底：读者已经明确说"只要最近这一段"，再按打底从窗口
    // 起点截 30 章，等于把他要的那段砍掉一半。20 章全取 = 没被截。
    assert.equal(res.body.partial, false, 'mode=recent 必须关掉打底，否则选它就等于选了个假选项')
  } finally {
    await s.close()
  }
})

test('跳读闸：默认窗口大于缺口时夹到缺口起点（不能算出 0 或负章号）', async () => {
  // 默认窗口 200 > 这本书的 149 章缺口。若不夹，`from` 会算成 -50。
  // 同时钉住"更厚 = 一批更少吃几章"：下限 1200 → 24000 ÷ 1200 = **20 份权重**的空间，
  // 而这一批头部 5 章各占 3 份权重（15）+ 5 章 ×1 = 正好 20 → 只装得下 **10 章**。
  const { s, bookId, labels } = await setup('jump-gate-recent-wide')
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, {
      method: 'POST',
      body: { mode: 'recent' },
    })

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.sampled.first, 1, '窗口比缺口大时，夹到缺口起点')
    assert.equal(res.body.sampled.perChapter, 1200)
    assert.ok(res.body.sampled.chapters < 149, '每章下限 1200，一趟装不下 149 章')
    assert.equal(
      res.body.sampled.chapters,
      10,
      '头部 5 章各 3 份权重（15）+ 5 章（5）= 20 份 = 24000 ÷ 1200（v1.67 之前是 80 份 → 装更多章）',
    )
    assert.equal(res.body.partial, true, '装不下就要如实说 partial，剩下的下次再补')
  } finally {
    await s.close()
  }
})

test('跳读闸：缺口在阈值内时完全不受影响（回归）', async () => {
  const { s, bookId, labels } = await setup('jump-gate-small')
  try {
    // 第 30 章：缺口 29 章，低于阈值 50。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 29, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    assert.equal(res.status, 200, '正常阅读必须一次就把记忆补上，不该被闸门烦')
    assert.ok(labels.length > 0)
    assert.deepEqual(res.body.covered, { first: 1, last: 29 })
  } finally {
    await s.close()
  }
})

test('跳读闸：设 0 关掉它（老用户/自动化脚本的退路）', async () => {
  const { s, bookId, labels } = await setup('jump-gate-off', { sample: { jumpGateChapters: 0 } })
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    assert.equal(res.status, 200, '闸门关掉之后必须回到旧行为')
    assert.ok(labels.length > 0)
    assert.deepEqual(res.body.covered, { first: 1, last: 30 })
  } finally {
    await s.close()
  }
})

test('补齐：`atChapter` 把边界移到"读者正在看的那一章"，并且真的落盘', async () => {
  // 这一条盯的是一个真机事故的形状：进度**只在滚动时**回写，于是"用目录跳到第 150 章、
  // 读首屏、没滚动"会让服务端一直以为你在第 1 章 —— 缺口算成 null，跳读闸不弹、
  // 记忆补到错的地方。处置是"只在他主动的两个动作里把边界推过去"（发笔记、点补齐）。
  const { s, bookId, labels } = await setup('jump-gate-at-chapter')
  try {
    // 进度留在第 1 章（chapterIndex 0）—— 此时**没有前文**，缺口是 null。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 0, charOffset: 0 } })
    const before = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(before.body.gap, null, '第 1 章没有前文，不该有缺口')

    // 只说一句"我在第 150 章"（0 起 149），缺口就出来了 → 超闸 → 409。
    const res = await call(`${s.base}/books/${bookId}/background/fill`, {
      method: 'POST',
      body: { atChapter: 149, ask: true },
    })
    assert.equal(res.status, 409)
    assert.equal(res.body.error, 'LARGE_GAP')
    assert.deepEqual(res.body.gap, { from: 1, to: 149, chapters: 149 })
    assert.deepEqual(labels, [], '被闸门拦下时一次调用都不发')

    // ★ 关键：进度**已经落盘**。第二次不给 atChapter 也认得出同一个缺口 —— 这一条
    // 才是"投喂与补齐用同一个数"的证据（投喂读的就是落盘的那份进度）。
    const second = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: { ask: true } })
    assert.equal(second.status, 409, '不带 atChapter 也该认得出同一个缺口（进度已落盘）')
    assert.deepEqual(second.body.gap, { from: 1, to: 149, chapters: 149 })
  } finally {
    await s.close()
  }
})

test('背景认识：GET 带 `atChapter` 时缺口按"正在看的章"算（进度滞后也不该说"已全部纳入"）', async () => {
  // 读者实测撞到的样子：面板说"记忆到第 2 章（前文已全部纳入）"、补齐按钮是灰的，
  // 而人明明在第 430 章。根因是面板问的是**落盘的进度**，而不是"他在看哪一章"。
  const { s, bookId } = await setup('jump-gate-bg-at')
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 0, charOffset: 0 } })
    const plain = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(plain.body.gap, null, '不带 atChapter：按落盘进度（第 1 章）算，没有前文')

    const at = await call(`${s.base}/books/${bookId}/background?atChapter=149`)
    // ⚠️ 只读那条路回的是 `backgroundGap` 的原样 `{from,to}` —— 带 `chapters` 的是
    // 补齐那条路的 409（那边为了给弹窗报"共几章"才补上这个字段）。
    assert.deepEqual(at.body.gap, { from: 1, to: 149 }, '带 atChapter：按正在看的章算')

    // ⚠️ 只算不写：这条只读路径**不该**把进度推走（落盘只发生在补齐那条路上）。
    const again = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(again.body.gap, null, 'GET 不得改进度')
  } finally {
    await s.close()
  }
})

test('跳读闸：配置里有 sample、但没写这个键时**仍然是开**（fail-safe）', async () => {
  // 这一条来自一次真机事故：profile 里的 `sample` 是**整体替换**的配置对象，写在
  // 这个键存在之前，于是 `jumpGateChapters` 缺失。原实现缺省退成 0 = 静默关闸，
  // 读者点第 150 章直接跑了补齐、一次提示都没有。
  //
  // 安全功能的缺省值必须是**开**：缺配置是常态，而"没配"绝不该等于"不要保护"。
  const { s, bookId, labels } = await setup('jump-gate-nokey', {
    sample: { budgetChars: 24000, minPerChapter: 100, maxPerChapter: 600 },
  })
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: { ask: true } })

    assert.equal(res.status, 409, '缺键不能等于关闸')
    assert.equal(res.body.gate, 50)
    assert.deepEqual(labels, [], '被拦下时一次调用都不该发')
  } finally {
    await s.close()
  }
})

test('补齐：大缺口 + 发笔记那一路（没有 ask）→ 自动补**全书前 30 章**，不弹闸门', async () => {
  // 读者实测的抱怨："我发了笔记，而 AI 对本章一无所知"——因为从前这里一律回 409，
  // 而笔记栏根本没有渲染那些选项（选项只存在于面板），他拿到的只是一句无法操作的文字。
  // 现在：**发笔记顺手补**这一路绝不空手而归，至少把开头那几十章跑完。
  const { s, bookId, labels } = await setup('jump-gate-auto-foundation')
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.autoFoundation, true, '要如实告诉客户端"这只补了开头"')
    assert.ok(labels.length > 0, '自动打底必须真的跑（这正是它的意义）')
    // ★ 覆盖的是**全书前 30 章**（读者选定），不是"缺口起点的 30 章"。
    assert.deepEqual(res.body.covered, { first: 1, last: 30 })
    assert.equal(res.body.sampled.last, 30)
    // ⚠️ `partial: false` 是**对的**：这一批的"请求范围"就是夹过的 1–30，它盖满了。
    // 于是客户端的补齐循环到此为止 —— **绝不顺手把整段缺口补掉**（那正是打底的本意）。
    assert.equal(res.body.partial, false, '循环必须停在打底这一批')
    // 而"还剩多少"由响应里的 gap 如实回报，客户端才说得出一句真话。
    assert.deepEqual(res.body.gap, { from: 31, to: 149 })

    // 再调一次：缺口变成 31–149，而"全书前 30 章"已经纳入过 → 夹完是**空缺口**。
    // 那种情况**不该硬造一次调用**，而要如实回报"只剩手动补"。
    const calls = labels.length
    const again = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })
    assert.equal(again.status, 200)
    assert.equal(again.body.skipped, true)
    assert.equal(again.body.autoFoundation, true)
    assert.equal(again.body.covered.last, 30, '水位线停在 30，没被空跑推走')
    assert.equal(labels.length, calls, '空缺口不该再烧一次模型调用')
  } finally {
    await s.close()
  }
})
