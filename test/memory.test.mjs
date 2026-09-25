/**
 * 记忆补齐器测试。
 *
 * 这是整条链上唯一**会起子代理**的地方，也是最容易出现"卡死在那儿没人知道"
 * 的地方。所以这里钉三件事：
 *
 *   1. **绝不挂死** —— 子代理不响应取消时，我们必须靠 `Promise.race` 自己退出；
 *   2. **联网面精确** —— 联网权限由 spawn 时的 `toolFilter` 决定，
 *      因为子代理的 session 与陪读会话不同、工具闸的归属判定认不出它；
 *   3. **失败都要有可读的原因** —— 每条 reason 对应界面上不同的处置建议。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TIMEOUT_MS,
  MEMORY_PERSONA,
  buildMemoryPrompt,
  createMemoryFiller,
  extractText,
} from '../lib/host/memory.js'

test('补齐提示词：「前文脉络」上限 60 字（v1.44 调低），且明写不重写', () => {
  const prompt = buildMemoryPrompt({
    bookTitle: '测试书',
    samples: [{ index: 0, title: '一', text: '正文' }],
    fromChapter: 1,
    toChapter: 1,
  })
  assert.ok(prompt.includes('前文脉络一条 60 字内'), '长度上限应当是 60 字')
  assert.ok(!prompt.includes('80 字内'), '旧的 80 字上限不该再出现（改回去会让这一节继续长胖）')
  assert.ok(
    prompt.includes('已经写过的章号范围不要再写一遍'),
    '「前文脉络」必须明写"不重写" —— 它是扁平列表，重写只会让文件长胖而信息不动',
  )
  // 六个小节与顺序不受这一版影响（只动了长度与权重）。
  for (const section of ['人物关系', '人物', '世界观', '文风', '前文脉络', '通用概念']) {
    assert.ok(prompt.includes(`## ${section}`), `提示词里少了分区 ${section}`)
  }
})

const SAMPLES = [
  { index: 0, title: '第一章 雪', text: '【第1章开头】他站在雪里。\n（中略）\n【第1章结尾】' },
  { index: 1, title: '第二章 夜', text: '【第2章开头】灯灭了。' },
]

/** 一段合法的小节输出。 */
const GOOD_OUTPUT = [
  '## 人物关系',
  '- 甲 ↔ 乙：对手（`第1章`）',
  '## 人物',
  '### 甲',
  '- `第1章` 身份未明',
].join('\n')

/** 造一个记录调用的替身 startRun。 */
function recorder(impl) {
  const calls = []
  return {
    calls,
    startRun: async (spec) => {
      calls.push(spec)
      return impl === undefined ? { output: [{ type: 'text', text: GOOD_OUTPUT }] } : impl(spec)
    },
  }
}

const BASE_REQUEST = {
  sessionId: 'session-abc',
  bookTitle: '夜行',
  samples: SAMPLES,
  fromChapter: 1,
  toChapter: 2,
  webGate: 'block-all',
}

/** 造一个补齐器。 */
function makeFiller(options = {}) {
  const rec = recorder(options.impl)
  const filler = createMemoryFiller({
    getSubagents: () => ({ start: async () => ({}) }),
    getAgent: () => ({ id: 'session-abc' }),
    startRun: rec.startRun,
    timeoutMs: options.timeoutMs,
    logger: {},
  })
  return { filler, calls: rec.calls }
}

//#region 提示词

test('提示词：样本带章节号，「（中略）」原样保留', () => {
  const prompt = buildMemoryPrompt(BASE_REQUEST)
  assert.match(prompt, /第 1 到第 2 章的\*\*节选\*\*/)
  assert.match(prompt, /### 第 1 章 第一章 雪/)
  assert.match(prompt, /### 第 2 章 第二章 夜/)
  // 中略标记必须留着，否则模型会以为文本是连贯的，把两段拼成一句。
  assert.match(prompt, /（中略）/)
  // 五个小节的格式要求，顺序必须与 BACKGROUND_SECTIONS 一致。
  for (const section of ['人物关系', '人物', '世界观', '文风', '前文脉络']) {
    assert.match(prompt, new RegExp(`## ${section}`))
  }
  // 顺序也要钉：模型是按这个顺序产出小节的，而解析侧按 BACKGROUND_SECTIONS
  // 认标题。两边顺序不一致时不会报错，只会让某一节静默落进 unknown。
  assert.ok(
    prompt.indexOf('## 文风') > prompt.indexOf('## 世界观')
    && prompt.indexOf('## 文风') < prompt.indexOf('## 前文脉络'),
    '「文风」必须夹在「世界观」与「前文脉络」之间',
  )
  // 章节归属是合并去重的依据，必须明确要求。
  assert.match(prompt, /每条都用/)
  // 「文风」的约束是**只描述不评价**：MEMORY_PERSONA 原先明令禁止写文风，
  // 现在放开了，就必须换成"可以写特征、不要评好坏"这个更精确的说法。
  assert.match(prompt, /文风只描述特征，不评价好坏/)
})

test('提示词：已有认识会被带上，并要求"只补充新东西"', () => {
  const prompt = buildMemoryPrompt({ ...BASE_REQUEST, existingMarkdown: '## 人物关系\n- 甲 ↔ 乙：对手' })
  assert.match(prompt, /这是我之前整理过的认识/)
  assert.match(prompt, /只补充新东西/)
  assert.match(prompt, /甲 ↔ 乙：对手/)
})

test('提示词：联网那句话只在允许联网时出现', () => {
  assert.ok(!buildMemoryPrompt(BASE_REQUEST).includes('联网'))
  assert.match(buildMemoryPrompt({ ...BASE_REQUEST, allowWeb: true }), /联网查\*\*设定类\*\*资料/)
})

test('提示词：不做 {{ 转义（子代理的 prompt 不走宿主插值）', () => {
  // 转义只对 systemPrompt.section 必要。这里转义反而会改动原著文字。
  const prompt = buildMemoryPrompt({ ...BASE_REQUEST, samples: [{ index: 0, title: '', text: '招式叫 {{破天}}' }] })
  assert.match(prompt, /\{\{破天\}\}/)
})

test('取文本：只认 text 块，忽略别的类型', () => {
  assert.equal(extractText({ output: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.equal(extractText({ output: [] }), '')
  assert.equal(extractText({}), '')
  assert.equal(extractText(null), '')
})

//#endregion

//#region 联网面

test('联网面：非 off 档位一律零工具', async () => {
  for (const webGate of ['block-all', 'block-book', undefined]) {
    const { filler, calls } = makeFiller()
    await filler({ ...BASE_REQUEST, webGate })
    assert.deepEqual(calls[0].toolFilter, { allow: [] }, `${webGate} 档位必须零工具`)
  }
})

test('联网面：off 档位给联网工具，但仍然零文件工具', async () => {
  const { filler, calls } = makeFiller()
  await filler({ ...BASE_REQUEST, webGate: 'off' })
  assert.deepEqual(calls[0].toolFilter, { allow: ['web_search', 'web_fetch'] })
  // 关键：不能顺手给它文件工具 —— 它拿不到章节正文以外的任何东西。
  assert.ok(!calls[0].toolFilter.allow.includes('read'))
})

test('联网面：宿主不认识联网工具时退化成零工具，而不是整个搞挂', async () => {
  // tools.restrict() 对未知工具名会直接抛错。这个宿主没装 web 工具，
  // 那是一次能力缺失，不该让补齐失败。
  let call = 0
  const specs = []
  const filler = createMemoryFiller({
    getSubagents: () => ({ start: async () => ({}) }),
    getAgent: () => ({ id: 'x' }),
    startRun: async (spec) => {
      specs.push(spec)
      call += 1
      if (call === 1) throw new Error('tools.restrict() names unknown global tool "web_search"')
      return { output: [{ type: 'text', text: GOOD_OUTPUT }] }
    },
    logger: {},
  })

  const result = await filler({ ...BASE_REQUEST, webGate: 'off' })
  assert.equal(result.ok, true, '应当退化成零工具并成功')
  assert.equal(specs.length, 2, '应当重试一次')
  assert.deepEqual(specs[1].toolFilter, { allow: [] })
})

//#endregion

//#region 绝不挂死

test('超时：子代理不响应取消时，我们必须自己退出（race，而不是只 abort）', async () => {
  // 这是本模块第一版真实踩过的坑：只调 `controller.abort()` 是**信号**，
  // 它不会替我们结束一个忽略该信号的 promise。宿主卡住时这个调用会永远挂着。
  let sawAbort = false
  const filler = createMemoryFiller({
    getSubagents: () => ({ start: async () => ({}) }),
    getAgent: () => ({ id: 'x' }),
    startRun: (spec) => new Promise(() => {
      // 一个永远不 resolve、也永远不看 signal 的 promise。
      spec.signal.addEventListener('abort', () => { sawAbort = true })
    }),
    timeoutMs: 40,
    logger: {},
  })

  const startedAt = Date.now()
  const result = await filler(BASE_REQUEST)
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'TIMEOUT')
  assert.ok(elapsed < 2000, `必须自己退出，实际用了 ${elapsed}ms`)
  // signal 仍然照传，让宿主有机会真正取消底层工作。
  assert.equal(sawAbort, true, '应当把 abort 信号传给子代理')
})

test('超时：默认超时是两分钟（用户选了阻塞式，愿意等）', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120000)
})

//#endregion

//#region 失败语义

test('失败：没有样本 / 没有活会话 / 没有子代理服务，各有各的原因', async () => {
  const { filler } = makeFiller()
  assert.equal((await filler({ ...BASE_REQUEST, samples: [] })).reason, 'NO_SAMPLES')

  const noParent = createMemoryFiller({
    getSubagents: () => ({}),
    getAgent: () => undefined,
    startRun: async () => ({}),
  })
  assert.equal((await noParent(BASE_REQUEST)).reason, 'NO_LIVE_PARENT')

  const noSubagents = createMemoryFiller({
    getSubagents: () => undefined,
    getAgent: () => ({ id: 'x' }),
    logger: {},
  })
  assert.equal((await noSubagents(BASE_REQUEST)).reason, 'SUBAGENTS_UNAVAILABLE')

  // getAgent 自己抛错也要有可读原因，而不是把异常冒到 HTTP 层。
  const throwing = createMemoryFiller({
    getSubagents: () => ({}),
    getAgent: () => { throw new Error('boom') },
    startRun: async () => ({}),
  })
  assert.match((await throwing(BASE_REQUEST)).reason, /PARENT_LOOKUP_FAILED/)
})

test('失败：模型输出为空或解析不出小节，都要能区分', async () => {
  const empty = makeFiller({ impl: () => ({ output: [] }) })
  assert.equal((await empty.filler(BASE_REQUEST)).reason, 'EMPTY_OUTPUT')

  const chatty = makeFiller({ impl: () => ({ output: [{ type: 'text', text: '好的，我读完了。' }] }) })
  assert.equal((await chatty.filler(BASE_REQUEST)).reason, 'UNPARSABLE_OUTPUT')
})

test('内容挂在 `### 主体` 下时不算"解析不出"（v1.22 分组分区）', async () => {
  // ⚠️ 这条钉的是 v1.22 **带出来的一个真 bug**：判据只数散条目（`sections`）与
  // 人物名，而「人物关系」「世界观」的条目现在大多挂在 `### 主体` 下。于是一份
  // **解析得好好的**输出会被判成 `UNPARSABLE_OUTPUT` —— 整批好数据被丢掉，
  // 而给出的理由还是错的。
  const grouped = makeFiller({
    impl: () => ({
      output: [{
        type: 'text',
        text: [
          '<!-- drc-background: schema=1 covered=1..9 -->',
          '## 人物关系',
          '### 甲 × 乙',
          '- `第2章` 对手',
          '## 世界观',
          '### 落霞谷',
          '- `第1章` 三面环水',
        ].join('\n'),
      }],
    }),
  })
  const result = await grouped.filler(BASE_REQUEST)
  assert.equal(result.ok, true, `不该被判成 ${result.reason}`)
  assert.deepEqual(result.parsed.groups['人物关系']['甲 × 乙'], ['`第2章` 对手'])

  // 同一个判据的另一半（旧代码本来就有）：它数了 `characters`，却没数**散条的**
  // 「人物」——那里放的是模型漏了 `###` 的条目。
  const looseOnly = makeFiller({
    impl: () => ({ output: [{ type: 'text', text: '## 人物\n- `第3章` 一个还没归类的人' }] }),
  })
  assert.equal((await looseOnly.filler(BASE_REQUEST)).ok, true)
})

test('失败：子代理抛异常时不冒泡，回结构化原因', async () => {
  const { filler } = makeFiller({ impl: () => { throw new Error('网络断了') } })
  const result = await filler(BASE_REQUEST)
  assert.equal(result.ok, false)
  assert.match(result.reason, /FAILED/)
  assert.match(result.reason, /网络断了/)
})

//#endregion

//#region 成功路径

test('成功：把模型输出解析成背景认识的小节', async () => {
  const { filler, calls } = makeFiller()
  const result = await filler(BASE_REQUEST)

  assert.equal(result.ok, true)
  assert.deepEqual(result.parsed.sections['人物关系'], ['甲 ↔ 乙：对手（`第1章`）'])
  assert.deepEqual(result.parsed.characters['甲'], ['`第1章` 身份未明'])
  assert.ok(result.elapsedMs >= 0)

  // 子代理必须挂在读者自己的会话下：宿主用父 Agent 解析模型路由与凭据。
  assert.equal(calls[0].parent.id, 'session-abc')
  assert.equal(calls[0].maxDepth, 1)
  assert.equal(calls[0].persona, MEMORY_PERSONA)
  assert.match(calls[0].label, /memory:1-2/)
  // prompt 是普通用户消息，不走宿主插值。
  assert.equal(calls[0].prompt[0].type, 'text')
})

test('成功：persona 是"读者自己"，不是陪读助手', () => {
  // 两种任务的身份不能混：陪读 AI 有"不许说后续"的对话约束，
  // 而整理笔记要的是"如实记录我从已读部分看出了什么"。
  assert.match(MEMORY_PERSONA, /你是这位读者自己/)
  assert.match(MEMORY_PERSONA, /绝不推测后续/)
})

//#endregion
