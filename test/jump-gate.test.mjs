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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { call, makeDir, startServer } from './helpers/server.mjs'

const prose = (seed) =>
  `${seed}，他记得那天的雪落得很慢，像有人在半空里把时间掰开了一点点，然后一片一片地放下。`

/** 一本 160 章的书——足够造出远超跳读闸（默认 50 章）的缺口。 */
const LONG_BOOK = Array.from(
  { length: 160 },
  (_, i) => [`第${i + 1}章 标题${i + 1}`, prose(`正文${i + 1}`)].join('\n'),
).join('\n\n')

// 假模型输出：只要是一份能解析的背景认识就够，闸门测试不关心内容。
// ⚠️ 必须以**句读收尾**（真实模型输出都这样）：3.0 ③a 的截断启发式会把
// "最后一条没有句读收尾"的输出判成可疑 ⇒ 触发砍半重试 ⇒ 本文件那些
// "出来一批就是一批"的断言全都会错位 —— 夹具要像真的。
const MEMORY_OUTPUT = ['## 世界观', '- `第1章` 抽样得到的设定。'].join('\n')

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
    // ⚠️ "全部纳入"是 5 批而不是 1 批：首次补齐先走 30 章打底，剩下的按每批 30 章
    //（18000 ÷ 600，3.0 起预算是 18000）切。预估漏掉打底就会少报一批。
    assert.equal(res.body.estimate.all.batches, 5, '30 章打底 + 119 章 ÷ 30 章 = 5 批')
    assert.equal(res.body.estimate.recent.batches, 10, '149 章 ÷ 每批 15 章（18000 ÷ 1200）')

    // ★ 这条是整组测试的重点：闸门不能"先花钱再报错"。
    assert.deepEqual(labels, [], '被闸门拦下时不该发出任何一次模型调用')

    // 文件也必须一个字都没动。
    const bg = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(bg.body.covered, null, '被拦下时不该推进水位线')
  } finally {
    await s.close()
  }
})

test('跳读闸：**被拒的那一趟一个字节都不许改文件** —— 冷归档不许抢在闸门之前（2026-10-02 三方评审 P2）', async () => {
  // ⚠️ 旧形状是"先冷归档、再压缩、最后才问闸门"。于是"点补齐 → 缺口很大 → 409 让读者选"
  //    这一趟会**先**把旧条目搬进「冷档案」并落盘（连增量记录与自动备份一起写）：
  //    读者看到的是**一次征询**（"还没做，你来选"），实际发生的是**记忆已经被改了**
  //    —— 那些条目从此不再进上下文；而 409 的响应体里**没有** `archived`，
  //    连"发生过什么"都不会被说出来。这条守卫钉的是"被拒的请求不许改状态"。
  //
  // ⚠️ 上面那条用例只断言了 `covered === null`（水位线没动）—— 而冷归档**不改** covered，
  //    所以它对这个问题**完全不敏感**：旧实现能全绿放行。灯要打在"文件字节"上。
  const { s, bookId, labels } = await setup('jump-gate-archive')
  try {
    const loc = await call(`${s.base}/books/${bookId}/location`)
    const bgPath = loc.body.location.backgroundPath
    mkdirSync(join(bgPath, '..'), { recursive: true })
    const before = [
      '<!-- drc-background: schema=1 covered=1..5 -->',
      '# 《长书》· 背景认识',
      '## 人物',
      '### 甲',
      '- `第3章` 早年的事，早已落在活跃窗口之外。',
      '- `第4章` 还有一条。',
      '## 世界观',
      '- `第4章` 一条旧设定。',
    ].join('\n')
    writeFileSync(bgPath, before, 'utf8')

    // 跳到第 150 章：缺口 1–149 章、活跃窗口 120 章 ⇒ 归档与闸门**都会想动**。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: { ask: true } })

    assert.equal(res.status, 409, '大缺口 + 手动补 ⇒ 先问一句')
    assert.equal(res.body.error, 'LARGE_GAP')
    assert.equal(
      readFileSync(bgPath, 'utf8'),
      before,
      '被拒的那一趟必须**逐字节不变** —— 尤其不许抢跑冷归档（把旧条目搬进「冷档案」）',
    )
    assert.deepEqual(labels, [], '一次模型调用都没发')
  } finally {
    await s.close()
  }
})

test('补齐竞态：读者在补齐期间清空 ⇒ 那一批的结果一个字都不许写回去（2026-10-02 三方评审 P2-9）', async () => {
  // ⚠️ 补齐会先读一份底稿、再叫模型跑到几十秒到十分钟、最后才落盘；读者完全可以在
  //    那期间点「清空重建」。而落盘前的 CAS **挡不住它** —— 那条路撞上
  //    `BACKGROUND_CHANGED` 时会**故意不复核、直接用当前文件重做一次合并**
  //    （那是为"读者在 Obsidian 里改了一句"设计的恢复路径）⇒ 飞在路上的那一批会把
  //    结果合并进**刚被清空的**文件：读者看到"已清空"，几十秒后旧内容又回来了，
  //    而且**没有任何一处会说**。
  //
  // 这条用例用"可控的子代理"复现那个窗口：模型调用卡在 `gate` 上不返回，
  // 期间发一次 `reset`，然后才放行。
  const labels = []
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const dir = makeDir('fill-reset-race')
  const s = await startServer(dir, {
    subagents: {
      start: async (kind, spec) => {
        labels.push(spec.label)
        return {
          result: gate.then(() => ({ output: [{ type: 'text', text: MEMORY_OUTPUT }] })),
          dispose: async () => {},
        }
      },
    },
    agents: { get: () => ({ id: 'parent' }) },
  })
  try {
    const bookId = await importLongBook(s.base, dir)
    await call(`${s.base}/books/${bookId}/binding`, { method: 'PUT', body: { sessionId: 'sess-race' } })
    // 缺口小（1–2 章）⇒ 不撞跳读闸，直奔模型调用。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 0 } })

    const filling = call(`${s.base}/books/${bookId}/background/fill`, {
      method: 'POST',
      body: { sessionId: 'sess-race' },
    })
    // 等它真的把调用发出去（否则下面那次 reset 可能与它错开）。
    for (let i = 0; i < 100 && labels.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(labels.length > 0, '前提：补齐已经发起模型调用（这一批正卡在模型里）')

    const reset = await call(`${s.base}/books/${bookId}/background/reset`, { method: 'POST' })
    assert.equal(reset.status, 200, '读者点「清空重建」必须成功')

    release()
    const done = await filling
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal(done.body.resetDuringFill, true, '必须如实回报"读者在这期间清空过"')

    const bg = await call(`${s.base}/books/${bookId}/background`)
    assert.equal(bg.body.covered, null, '清空之后不许被在飞的那一批填回去')
    assert.ok(
      !bg.body.markdown.includes('抽样得到的设定'),
      '那一批的产物一个字都不许落盘（清空是读者的显式动作，不能被悄悄撤销）',
    )
  } finally {
    await s.close()
  }
})

test('冷归档：增量记录（历代备份那件）的成败要如实带上（2026-10-02 三方评审 P3-5）', async () => {
  // ⚠️ 从前 `writeArchiveDelta(...)` 的返回值被**直接丢掉** —— 于是"历代备份三件套"
  //    里的那件（`background.history/` 增量）写失败时，`archived` 里没有这个事实，
  //    读者以为备份齐全。而那条 delta 记的是"这一笔搬走了什么"的**原文**，少一件不可逆。
  const { s, bookId, labels } = await setup('archive-history')
  try {
    const loc = await call(`${s.base}/books/${bookId}/location`)
    const bgPath = loc.body.location.backgroundPath
    mkdirSync(join(bgPath, '..'), { recursive: true })
    writeFileSync(bgPath, [
      '<!-- drc-background: schema=1 covered=1..5 -->',
      '# 《长书》· 背景认识',
      '## 人物',
      '### 甲',
      '- `第3章` 早年的事，早已落在活跃窗口之外。',
      '- `第4章` 还有一条。',
    ].join('\n'), 'utf8')

    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: { mode: 'all' } })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(res.body.archived?.moved > 0, `前提：这一趟确实归档了条目，实际 ${JSON.stringify(res.body.archived)}`)
    // ★ 这条钉的是**接线**：字段一旦被丢回 `undefined`，这一句就红。
    assert.equal(res.body.archived.historyWritten, true, '增量记录的成败必须如实回报')
    // 顺带确认它真的写下了（不是"报了 true 但没落盘"）。
    const names = readdirSync(join(bgPath, '..', 'background.history'))
    assert.ok(
      names.some((name) => name.endsWith('-归档.md')),
      `历代增量记录应当真的落盘，实际目录里是 ${JSON.stringify(names)}`,
    )
    assert.ok(labels.length > 0)
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
    // （3.0：打底批用**专用预算** `foundationBudgetChars: 24000` —— 后续批次的预算降到了
    //   18000，但打底批只有一个、输出有界 ⇒ 保住"开头 30 章读厚、一次成型"。）
    assert.deepEqual(res.body.covered, { first: 1, last: 30 })
    assert.equal(res.body.partial, true, '149 章的缺口不可能一次补完')
  } finally {
    await s.close()
  }
})

test('跳读闸：mode=recent 只记最近这一段，**绝不碰前面那几百章**', async () => {
  // 把窗口钉成 15 章。这本书只有 160 章 —— 用默认的 200 会让"最近 200 章"盖住整个
  // 缺口，这条用例就失去意义了。顺带钉住"窗口与阈值是两个数"：阈值仍是默认的 50，
  // 窗口却只取 15。（3.0 预算 18000：窗口必须 ≤ budgetChars ÷ recentMinPerChapter = 15 章，
  // 否则这条"全取不被截"的性质就装不下。）
  const { s, bookId, labels } = await setup('jump-gate-recent', { sample: { recentWindowChapters: 15 } })
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 149, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, {
      method: 'POST',
      body: { mode: 'recent' },
    })

    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(labels.length > 0)
    // 最近 15 章 = 第 135–149 章。起点是 135 而不是 1，这正是这道选项的全部意义。
    assert.deepEqual(res.body.covered, { first: 135, last: 149 })
    assert.equal(res.body.sampled.first, 135)
    assert.equal(res.body.sampled.last, 149)
    assert.equal(res.body.sampled.chapters, 15)
    // ⚠️ recentMinPerChapter 是 **1200**：15 章 × 1200 = 18,000（3.0 的预算），正好用满
    // —— 限额 `min(max, max(min, 预算 ÷ 权重和))` 三边相等。
    assert.equal(res.body.sampled.perChapter, 1200, '窄窗口下这一段直接拿满（18000 ÷ 15 章 = 1200）')

    // ⚠️ 并且**不能**走打底：读者已经明确说"只要最近这一段"，再按打底从窗口
    // 起点截章，等于把他要的那段砍掉一半。15 章全取 = 没被截。
    assert.equal(res.body.partial, false, 'mode=recent 必须关掉打底，否则选它就等于选了个假选项')
  } finally {
    await s.close()
  }
})

test('跳读闸：默认窗口大于缺口时夹到缺口起点（不能算出 0 或负章号）', async () => {
  // 默认窗口 200 > 这本书的 149 章缺口。若不夹，`from` 会算成 -50。
  // 同时钉住"更厚 = 一批更少吃几章"：下限 1200 → 18000 ÷ 1200 = **15 份权重**的空间
  //（3.0 起预算是 18000），而这一批头部 5 章各占 3 份权重（15）→ 正好装下 **5 章**。
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
      5,
      '头部 5 章各 3 份权重 = 15 份 = 18000 ÷ 1200（预算从 24000 降到 18000 后，一批从 10 章收到 5 章）',
    )
    assert.equal(res.body.partial, true, '装不下就要如实说 partial，剩下的下次再补')
  } finally {
    await s.close()
  }
})

test('跳读闸：缺口在阈值内时完全不受影响（回归）', async () => {
  const { s, bookId, labels } = await setup('jump-gate-small')
  try {
    // 第 30 章：缺口 29 章，低于阈值 50 ⇒ 一次补完（covered===null ⇒ 打底模式，
    // 用专用预算 24000 ⇒ 29 章一批盖得下；后续批次的 18000 预算管的是别处）。
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 29, charOffset: 0 } })
    const res = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: {} })

    assert.equal(res.status, 200, JSON.stringify(res.body))
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
    // 3.0：打底批用专用预算 24000 ⇒ 开头 30 章一次跑满（见"mode=all"那条的说明）。
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
  // （3.0：后续批次的预算降到 18000，但打底批用**专用预算** 24000 ⇒ 开头 30 章仍一次跑满。）
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

test('进度：补齐只在**章号真的变了**时才归零章内偏移（乙-1）', async () => {
  // ⚠️ 这条修的是一个**读者能感觉到**的副作用：从前 `atChapter` 那条路一律
  //    `charOffset: 0`，于是"在第 3 章读到一半、顺手发条笔记"会把他弹回**章首** ——
  //    之后不滚动就关掉，下次打开落在章首，而不是他读到的位置。
  //
  // 两件事本来就无关：这一段要推的是**章号边界**（缺口算错的那个 bug），
  // 章内位置是读者的阅读落点。章号真的变了才归零（新章的位置就是章首）。
  const { s, bookId } = await setup('char-offset')
  try {
    await call(`${s.base}/books/${bookId}/progress`, { method: 'PUT', body: { chapterIndex: 2, charOffset: 5 } })

    // ★ 先证明夹具前提真的成立：偏移是个**正数**。若 `setProgress` 把它夹成 0，
    //   下面的断言就变成了"0 === 0"—— 看着绿，其实什么都没验证。
    const seeded = await call(`${s.base}/books/${bookId}/progress`)
    const offset = seeded.body.progress.charOffset
    assert.equal(seeded.body.progress.chapterIndex, 2)
    assert.ok(offset > 0, `夹具前提：章内偏移必须是个正数（实际 ${offset}）`)

    // ① 章号没变（发笔记那一路带的 `atChapter` 就是当前章）⇒ 偏移**必须留着**。
    const same = await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: { atChapter: 2 } })
    assert.equal(same.status, 200)
    const after1 = await call(`${s.base}/books/${bookId}/progress`)
    assert.equal(after1.body.progress.chapterIndex, 2, '章号不变')
    assert.equal(
      after1.body.progress.charOffset,
      offset,
      '章号没变 ⇒ 章内位置不该被抹掉（抹掉就是"下次打开落回章首"）',
    )

    // ② 章号真的变了 ⇒ 归零（旧偏移对新章没有意义）。
    await call(`${s.base}/books/${bookId}/background/fill`, { method: 'POST', body: { atChapter: 5 } })
    const after2 = await call(`${s.base}/books/${bookId}/progress`)
    assert.equal(after2.body.progress.chapterIndex, 5, '章号推进了')
    assert.equal(after2.body.progress.charOffset, 0, '换章 ⇒ 章内偏移归零')
  } finally {
    await s.close()
  }
})
