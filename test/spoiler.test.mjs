/**
 * 防剧透层测试 —— 本插件最不能出错的一层。
 *
 * 这里钉住的不是"功能能用"，而是**「AI 看不到进度之后的东西」这个承诺**。
 * 所以除了纯函数单测，还有一个真实书籍的端到端测试：造一本每章带唯一标记
 * 的书，把进度停在中间，然后把防剧透层真正要投喂给模型的文本整个拿出来，
 * 逐字断言后续章节的标记一个都不在里面。
 *
 * 任何一次重构如果让这个测试变红，就是剧透回归，必须就地修掉。
 *
 * ## v0.5 的两处结构性变化（本文件已按新架构重写）
 *
 * 1. **规则 B 没了。** 早期在陪读会话里一刀切拒绝 `read`/`bash`/`web_*` 等
 *    一批工具，那是过度设计——读者的诉求是"别剧透"，不是"别用工具"。
 *    现在工具层只剩两条精确规则：路径闸（规则 A）+ 联网闸（规则 C）。
 * 2. **前文从"每章一条梗概"改成"一份背景认识"。** 窗口的 `earlierText`
 *    变成 `backgroundText`，`missingDigest` 变成 `memoryGap`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLibrary } from '../lib/host/library.js'
import { backgroundGap, parseBackground, renderBackgroundForPrompt } from '../lib/host/background.js'
import {
  RAW_TEXT_ARTIFACTS,
  WEB_GATE_MODES,
  chapterLabel,
  describeElapsed,
  describeWindow,
  escapePromptText,
  foldPathSegments,
  measureCacheSplit,
  normalizeSessionId,
  renderCompanionSection,
  renderDiscussions,
  renderPersona,
  renderPolicy,
  renderSituation,
  sessionIdsMatch,
  spoilerGuardReason,
  webGateReason,
} from '../lib/host/spoiler.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = join(HERE, '.tmp')

//#region 纯函数：转义与归一化

test('转义：任何形态的连续大括号都不再产出 {{', () => {
  // 宿主 dsh-system-prompt 会把 `{{name}}` 当变量插值，未注册的名字直接抛错，
  // 从而毁掉整次 prompt 装配。所以这里必须穷尽形态。
  const cases = [
    '普通正文，没有大括号',
    '{{evil}}',
    '{{{evil}}}',
    '{{{{',
    '}}}}',
    'a{{b',
    '{{}}',
    '中文{{变量}}混排',
    '紧邻的正则量词 {2,3} 不应受影响',
  ]
  for (const input of cases) {
    const out = escapePromptText(input)
    assert.ok(!out.includes('{{'), `转义后仍含 {{{{：${JSON.stringify(input)} -> ${JSON.stringify(out)}`)
  }
})

test('转义：普通文本原样保留，不引入多余变化', () => {
  // 只处理连续 `{`，其余字符必须逐字不动 —— 这是书籍正文，不能改字。
  assert.equal(escapePromptText('雪落在瓦上。'), '雪落在瓦上。')
  assert.equal(escapePromptText('单个 { 花括号'), '单个 { 花括号')
  assert.equal(escapePromptText('量词 {2,3}'), '量词 {2,3}')
  assert.equal(escapePromptText(''), '')
  // 非字符串一律回空串，绝不抛错。
  assert.equal(escapePromptText(null), '')
  assert.equal(escapePromptText(undefined), '')
  assert.equal(escapePromptText(42), '')
})

test('会话 id：容忍 session- 前缀差异', () => {
  assert.equal(normalizeSessionId('session-abc'), 'abc')
  assert.equal(normalizeSessionId('abc'), 'abc')
  assert.equal(normalizeSessionId('  abc  '), 'abc')
  assert.equal(normalizeSessionId(''), '')
  assert.equal(normalizeSessionId(null), '')

  assert.equal(sessionIdsMatch('session-abc', 'abc'), true)
  assert.equal(sessionIdsMatch('abc', 'session-abc'), true)
  assert.equal(sessionIdsMatch('abc', 'abd'), false)
  // 空 id 永不相等：否则"没有会话"会被判成同一个会话。
  assert.equal(sessionIdsMatch('', ''), false)
  assert.equal(sessionIdsMatch(null, undefined), false)
})

test('章标签：标题自带序号时用书自己的编号，不再叠加我们拼的序号', () => {
  // 实测踩过：某本书 index 0 是「卷首」，于是 index+1 与书内编号整体错位，
  // 产出 `第 17 章 · 第16章 带子` —— 同一行里两个互相矛盾的章号。
  assert.equal(chapterLabel(16, '第16章 带子'), '第16章 带子')
  assert.equal(chapterLabel(2, '第三回 折柳'), '第三回 折柳')
  assert.equal(chapterLabel(1, '卷二 风起'), '卷二 风起')
  // 标题没有序号时才加前缀。
  assert.equal(chapterLabel(0, '卷首'), '第 1 章 · 卷首')
  assert.equal(chapterLabel(11, '夜行'), '第 12 章 · 夜行')
  assert.equal(chapterLabel(0, ''), '第 1 章')
  assert.equal(chapterLabel(0, undefined), '第 1 章')
  // 标签同样要过转义 —— 章标题是书籍内容。
  assert.ok(!chapterLabel(0, '第{{x}}章').includes('{{'))
})

//#endregion

const BOOK_HEX = '0123456789abcdef'

test('路径闸：指向本书原始文本的调用一律拒绝，且不依赖会话归属', () => {
  const deps = { bookIdForSession: () => undefined }

  // 绝对路径、相对路径、正反斜杠都要拦。
  const paths = [
    `C:\\Users\\someone\\.dsh\\dsh-reading-companion\\books\\${BOOK_HEX}\\content.txt`,
    `books/${BOOK_HEX}/content.txt`,
    `/home/x/books/${BOOK_HEX}/chapters.json`,
    `books\\${BOOK_HEX}\\source.txt`,
  ]
  for (const filePath of paths) {
    const reason = spoilerGuardReason({ name: 'read', arguments: { file_path: filePath } }, deps)
    assert.ok(typeof reason === 'string', `应拦截：${filePath}`)
    assert.match(reason, /原始文本/)
  }

  // 同样是 read，但指向无关文件 —— 放行。
  assert.equal(spoilerGuardReason({ name: 'read', arguments: { file_path: 'C:\\tmp\\note.md' } }, deps), undefined)
  // 路径嵌在数组/嵌套对象里也要能被挖出来。
  assert.ok(spoilerGuardReason(
    { name: 'grep', arguments: { paths: [`books/${BOOK_HEX}/content.txt`] } },
    deps,
  ))
})

test('路径闸：`.` / `..` 不能绕过（回归）', () => {
  // ⚠️ 这是本轮修掉的一个**真的能绕过**的口子。
  //
  // 旧实现直接拿参数字符串跑正则，而正则要求出现连续的
  // `books/<16位hex>/content.txt`。在 hex 段前后插一个 `.` 或 `..`（或重复
  // 分隔符）就能让它看不见 —— 但操作系统和宿主在真正打开文件时会把那些段
  // **归一化回同一个文件**，也就是正文。README 把这一层写成"硬保证"，
  // 所以它是实现漏了一行，不是取舍。
  const deps = { bookIdForSession: () => undefined }
  const bypasses = [
    `books/${BOOK_HEX}/../${BOOK_HEX}/content.txt`,
    `books/./${BOOK_HEX}/./content.txt`,
    `books//${BOOK_HEX}//content.txt`,
    `books\\${BOOK_HEX}\\..\\${BOOK_HEX}\\content.txt`,
    `a/../books/${BOOK_HEX}/content.txt`,
    `./books/${BOOK_HEX}/chapters.json`,
  ]
  for (const filePath of bypasses) {
    const reason = spoilerGuardReason({ name: 'read', arguments: { file_path: filePath } }, deps)
    assert.ok(typeof reason === 'string', `应拦截（. 或 .. 绕过）：${filePath}`)
  }
})

test('路径折叠：只折 `.` / `..` / 空段，不碰含点的文件名', () => {
  // 折成什么样不重要，重要的是**只往"多加拒绝"的方向偏**。
  assert.equal(foldPathSegments('a/b/c'), 'a/b/c')
  assert.equal(foldPathSegments('a/./b'), 'a/b')
  assert.equal(foldPathSegments('a/../b'), 'b')
  assert.equal(foldPathSegments('a//b///c'), 'a/b/c')
  assert.equal(foldPathSegments('a\\b'), 'a/b')
  // 含点的**文件名**不是 `..` 段，不能被折掉。
  assert.equal(foldPathSegments('books/x..y/content.txt'), 'books/x..y/content.txt')
  assert.equal(foldPathSegments('..content.txt'), '..content.txt')
  // 越出根的 `..` 折到空、不抛错（这条只用于多加拒绝，不用于判断放行）。
  assert.equal(foldPathSegments('../../etc/passwd'), 'etc/passwd')
  // 非字符串一律回落到空串，不抛错。
  assert.equal(foldPathSegments(null), '')
  assert.equal(foldPathSegments(42), '')
  assert.equal(foldPathSegments(''), '')
  assert.equal(foldPathSegments(undefined), '')
})

test('路径闸：notes.md 与 meta.json 刻意不拦（用户可能正经要看笔记）', () => {
  const deps = { bookIdForSession: () => undefined }
  assert.equal(
    spoilerGuardReason({ name: 'read', arguments: { file_path: `books/${BOOK_HEX}/notes.md` } }, deps),
    undefined,
  )
  assert.equal(
    spoilerGuardReason({ name: 'read', arguments: { file_path: `books/${BOOK_HEX}/meta.json` } }, deps),
    undefined,
  )
})

test('路径闸：被拦的名单与 RAW_TEXT_ARTIFACTS **同源**（不许有第二个真相源）', () => {
  // 治的是一个很具体的形状：名单从前在 `spoiler.js` 里写了**两遍** —— 一个导出常量
  // （注释齐全、看着最像权威的）和一条手写的正则。加第四个制品、或给某个制品改名时，
  // 改常量、正则照旧，这道"硬保证"就会**静默失效**；而它恰恰是本插件唯一一条与会话
  // 归属无关的硬规则。现在正则由常量生成，这条用例再按常量**逐个**验证一遍。
  const deps = { bookIdForSession: () => undefined }
  for (const name of RAW_TEXT_ARTIFACTS) {
    assert.notEqual(
      spoilerGuardReason({ name: 'read', arguments: { file_path: `books/${BOOK_HEX}/${name}` } }, deps),
      undefined,
      `${name} 必须被拦下`,
    )
  }
})

test('路径闸：读完解锁只影响**这一本**，收回后立刻恢复拦截', () => {
  // v1.45：读者声明读完一本书之后，**那一本**的原始文本不再算剧透。
  // 这是全插件**唯一会放松**这条硬规则的地方，所以每条边界各钉一句断言。
  const BOOK_A = 'aaaaaaaaaaaaaaaa'
  const BOOK_B = 'bbbbbbbbbbbbbbbb'
  let deps = { bookIdForSession: () => undefined }
  const read = (hex, name = 'content.txt') =>
    spoilerGuardReason({ name: 'read', arguments: { file_path: `books/${hex}/${name}` } }, deps)

  // ① 缺省即锁定：没有判定函数时，行为和从前一字不差。
  assert.notEqual(read(BOOK_A), undefined, '没有判定函数时必须照旧锁着')

  // ② 判定命中**正则里捕获到的那个 bookId** 才放行（三个制品一视同仁）。
  deps = { bookIdForSession: () => undefined, isBookFinished: (id) => id === BOOK_A }
  for (const name of RAW_TEXT_ARTIFACTS) {
    assert.equal(read(BOOK_A, name), undefined, `${name}：这一本读完了就该放行`)
  }

  // ③ 别的书**不受影响** —— 这是"只影响这一本"的核心断言。
  assert.notEqual(read(BOOK_B), undefined, '别的书照旧锁着')

  // ④ 收回 → 立刻恢复拦截：判定每次现读，没有缓存窗口。
  deps = { bookIdForSession: () => undefined, isBookFinished: () => false }
  assert.notEqual(read(BOOK_A), undefined, '收回后必须立刻锁回去')

  // ⑤ fail-safe：判定抛错时按**锁定**处理 —— 闸被改坏的最坏后果必须是"照旧锁着"。
  deps = {
    bookIdForSession: () => undefined,
    isBookFinished: () => {
      throw new Error('boom')
    },
  }
  assert.notEqual(read(BOOK_A), undefined, '判定抛错 → 按锁定处理')
})

test('路径闸：关掉总开关后放行（用户显式选择的代价）', () => {
  const deps = { bookIdForSession: () => undefined, enabled: false }
  assert.equal(
    spoilerGuardReason({ name: 'read', arguments: { file_path: `books/${BOOK_HEX}/content.txt` } }, deps),
    undefined,
  )
})

test('工具闸：畸形输入不抛错', () => {
  const deps = { bookIdForSession: () => undefined }
  assert.equal(spoilerGuardReason(null, deps), undefined)
  assert.equal(spoilerGuardReason('nonsense', deps), undefined)
  assert.equal(spoilerGuardReason({}, deps), undefined)
  assert.equal(spoilerGuardReason({ name: '' }, deps), undefined)
  assert.equal(spoilerGuardReason({ name: 'read' }, deps), undefined)
})

//#endregion

//#region 规则 C：联网闸（三档）

/** 造一个绑定了 abc 会话的查询器。 */
const boundTo = (bookId) => (sessionId) => (normalizeSessionId(sessionId) === 'abc' ? bookId : undefined)

const WEB_DEPS = {
  bookIdForSession: boundTo(BOOK_HEX),
  bookTitles: ['魔女霓裳'],
  characterNames: ['沈某某', '顾某'],
}

test('联网闸：档位齐全，且默认档位是"完全"', () => {
  assert.deepEqual([...WEB_GATE_MODES], ['block-all', 'block-book', 'off'])
})

test('联网闸：block-all 在陪读会话里拦掉一切联网', () => {
  const deps = { ...WEB_DEPS, webGate: 'block-all' }
  for (const name of ['web_search', 'web_fetch']) {
    const reason = webGateReason(
      { name, arguments: { query: '明朝官制' }, agent: { session: { id: 'session-abc' } } },
      deps,
    )
    assert.ok(typeof reason === 'string', `block-all 下 ${name} 必须被拦`)
    assert.match(reason, /首次阅读防剧透/)
  }
  // 非联网工具不受影响。
  assert.equal(
    webGateReason({ name: 'read', arguments: {}, agent: { session: { id: 'session-abc' } } }, deps),
    undefined,
  )
})

test('联网闸：off 档位放行', () => {
  const deps = { ...WEB_DEPS, webGate: 'off' }
  assert.equal(
    webGateReason(
      { name: 'web_search', arguments: { query: '魔女霓裳 结局' }, agent: { session: { id: 'session-abc' } } },
      deps,
    ),
    undefined,
  )
})

test('联网闸：block-book 只拦"看起来在查这本书"的查询', () => {
  const deps = { ...WEB_DEPS, webGate: 'block-book' }
  const agent = { session: { id: 'session-abc' } }

  // 命中书名 / 人物名 / 剧情信号词 —— 拦。
  for (const query of ['魔女霓裳 怎么样', '沈某某 是谁', '这本书的结局', '大结局是什么']) {
    const reason = webGateReason({ name: 'web_search', arguments: { query }, agent }, deps)
    assert.ok(typeof reason === 'string', `应当拦住：${query}`)
    assert.match(reason, /与本书有关/)
  }

  // 与本书无关的设定类查询 —— 放行。这是这个档位存在的意义。
  for (const query of ['明朝 官制 几品', '宋代 点茶 做法']) {
    assert.equal(
      webGateReason({ name: 'web_search', arguments: { query }, agent }, deps),
      undefined,
      `不该拦住：${query}`,
    )
  }
})

test('联网闸：只在陪读会话生效，非陪读会话一律放行', () => {
  const deps = { ...WEB_DEPS, webGate: 'block-all' }
  // 没有绑定 → 不是陪读会话。
  assert.equal(
    webGateReason({ name: 'web_search', arguments: {}, agent: { session: { id: 'other' } } }, deps),
    undefined,
  )
  // 没有 agent 归属 → 无法正面证明，放行。
  assert.equal(webGateReason({ name: 'web_search', arguments: {} }, deps), undefined)
  // 非法档位回落到最严的 block-all（配置写错不该把闸门关掉）。
  assert.ok(typeof webGateReason(
    { name: 'web_search', arguments: {}, agent: { session: { id: 'abc' } } },
    { ...WEB_DEPS, webGate: 'nonsense' },
  ) === 'string')
})

test('守则：联网说法跟着档位变，但"不主动剧透"始终在', () => {
  const blocked = renderPolicy('魔女霓裳', { webGate: 'block-all' })
  const open = renderPolicy('魔女霓裳', { webGate: 'off' })

  for (const text of [blocked, open]) {
    assert.match(text, /绝不主动剧透/, '守则的第一条不受档位影响')
    assert.match(text, /不猜后续/)
    assert.match(text, /背景认识/)
    // 「人设不能取消守则」这一条必须**无条件**出现：它是唯一能挡住
    // "读者写一句『详细讲讲后续』"的地方，而且它一旦随人设有无而变化，
    // 稳定前缀就会跟着抖（缓存）。
    assert.match(text, /书友设定.*只调风格/s)
  }
  assert.match(blocked, /不要联网查这本书/)
  assert.match(open, /联网只用来查设定/)
})

test('守则：与"有没有背景认识"无关——它必须逐字节稳定，否则缓存每章失效', () => {
  // 这条曾经是反例：旧版把「你还没有建立背景认识」写进守则，于是第一次补齐
  // 记忆之后整段守则变了一次，前面所有缓存作废。"状态"已经搬去 renderSituation。
  const a = renderPolicy('x', { webGate: 'block-all' })
  const b = renderPolicy('x', { webGate: 'block-all', hasBackground: false })
  assert.equal(a, b, '守则不能依赖任何会随阅读变化的量')

  // 状态现在在这里，而且只有这里。
  assert.match(renderSituation({ hasBackground: false }), /还没有建立背景认识/)
  assert.doesNotMatch(renderSituation({ hasBackground: true, backgroundCovered: { first: 1, last: 3 }, progress: { chapterIndex: 3 } }), /还没有建立背景认识/)
})

//#endregion

//#region 背景认识：缺口与渲染

test('缺口：前文末日是当前章的前一章（当前章由窗口全文投喂，不需要梗概）', () => {
  // 还没建过任何认识 → 缺口是 1..当前章
  assert.deepEqual(backgroundGap(null, 4), { from: 1, to: 4 })
  // 已覆盖到第 3 章、读者在第 6 章（index 5）→ 缺口 4..5
  assert.deepEqual(backgroundGap({ first: 1, last: 3 }, 5), { from: 4, to: 5 })
  // 已经没有缺口
  assert.equal(backgroundGap({ first: 1, last: 5 }, 5), null)
  // 第一章：前面什么都没有
  assert.equal(backgroundGap(null, 0), null)
  // 非法进度
  assert.equal(backgroundGap(null, -1), null)
})

test('背景渲染：覆盖区间与缺口都要明说，缺口是这一层的守门人', () => {
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..3 -->',
    '# 《魔女霓裳》· 背景认识',
    '## 人物关系',
    '- 沈某某 ↔ 顾某：对手（`第2章`）',
    '## 人物',
    '### 沈某某',
    '- `第1章` 身份未明',
    '## 世界观',
    '- `第1章` 江湖与魔教',
    '## 前文脉络',
    '- `第1-3章` 初遇',
  ].join('\n'))

  const out = renderBackgroundForPrompt(doc, { progressIndex: 6 })
  assert.match(out.text, /覆盖：第 1–3 章/)
  assert.match(out.text, /第 4–6 章\*\*尚未\*\*纳入/, '缺口必须明说')
  assert.match(out.text, /沈某某 ↔ 顾某/)
})

test('背景渲染：超预算时按优先级丢，人物关系最后才动', () => {
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..9 -->',
    '## 人物关系',
    '- 甲 ↔ 乙：很重要',
    '## 前文脉络',
    `- \`第1-9章\` ${'很长'.repeat(200)}`,
  ].join('\n'))

  const out = renderBackgroundForPrompt(doc, { budgetChars: 300, progressIndex: 9 })
  assert.ok(out.omitted.includes('前文脉络'), '超预算时应当先丢前文脉络')
  assert.ok(!out.omitted.includes('人物关系'), '人物关系是重点，最后才动')
  assert.match(out.text, /甲 ↔ 乙/)
})

test('背景渲染：没有任何认识时给一句明确的说明，而不是空白', () => {
  const out = renderBackgroundForPrompt(parseBackground(''), { progressIndex: 0 })
  assert.match(out.text, /还没有建立/)
})

//#endregion

//#region 端到端：真实书籍的已读边界

/** 中文数字，用来拼「第N章」。 */
const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八']

/** 每章填充正文，长度足够让章首豁免与章尾都落在不同区间。 */
const FILLER = '雪落在瓦上，像有人在半空里把时间掰开了一点点。'.repeat(200)

/**
 * 造一本「每章都带唯一标记」的书。
 *
 * 每章正文形如：`【第N章开头】{{evil}}` + 填充 + `【第N章结尾】`
 * 这样就能分别断言「本章已读部分进来了」与「本章未读部分没进来」。
 *
 * @param {number} count 章数
 * @returns {string}
 */
function markedBook(count = 8) {
  const lines = []
  for (let i = 0; i < count; i += 1) {
    const n = i + 1
    lines.push(`第${NUMERALS[i]}章 标题${NUMERALS[i]}`)
    // 只有第五章塞 {{evil}}：它会被当作当前章投喂，正好验证转义真的生效。
    const head = n === 5 ? `【第${n}章开头】{{evil}}` : `【第${n}章开头】`
    lines.push(head + FILLER + `【第${n}章结尾】`)
    lines.push('')
  }
  return lines.join('\n')
}

let seq = 0

/**
 * 建一个隔离书库并导入带标记的书。
 *
 * @param {object} [options]
 * @returns {object} fixture
 */
function makeFixture(options = {}) {
  seq += 1
  const root = join(TMP_ROOT, `spoil-${process.pid}-${Date.now()}-${seq}`)
  const storageDir = join(root, 'storage')
  mkdirSync(join(storageDir, 'inbox'), { recursive: true })

  const sourcePath = join(root, '标记本.txt')
  writeFileSync(sourcePath, Buffer.from(options.bookText ?? markedBook(), 'utf8'))

  const library = createLibrary({ storageDir, fallbackBlockChars: 1000 })
  library.ensureDirs()

  const { book } = library.importBook({ absPath: sourcePath, title: '标记本' })

  return { root, library, book, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * 固定预算，让断言可复现。
 *
 * ⚠️ 这几个数**不是配置缺省值**——缺省值在 `lib/index.js`（v1.26 起背景预算是
 * 9000）。这里手写一份是为了让本文件的断言不随缺省值漂移；两者不同值是有意的，
 * 不要"顺手对齐"。
 */
const BUDGET = {
  currentChapterMode: 'full',
  headAllowanceChars: 1500,
  backgroundBudgetChars: 6000,
}

/** 按窗口组装一次段落，省掉每个用例重复五行。 */
function sectionOf(library, bookId, options = BUDGET) {
  const readWindow = library.collectReadWindow(bookId, options)
  return {
    readWindow,
    section: renderCompanionSection({
      window: readWindow,
      title: readWindow.title,
      progress: readWindow.progress,
      backgroundText: readWindow.backgroundText,
    }),
  }
}

test('已读窗口：章节解析必须认出全部 8 章（否则下面的边界断言没有意义）', () => {
  const f = makeFixture()
  try {
    const index = f.library.chapters(f.book.bookId)
    assert.equal(index.chapters.length, 8, `期望 8 章，实际 ${index.chapters.length} 章`)
  } finally {
    f.cleanup()
  }
})

test('防剧透：无论哪种模式，进度**之后**的章节一个字都不能出现', () => {
  for (const mode of ['full', 'read-so-far']) {
    const f = makeFixture()
    try {
      const bookId = f.book.bookId
      f.library.setProgress(bookId, { chapterIndex: 4, charOffset: 200 })
      const { section } = sectionOf(f.library, bookId, { ...BUDGET, currentChapterMode: mode })

      // 反向：进度之后的章节一个标记都不能出现。
      for (const n of [6, 7, 8]) {
        assert.ok(!section.includes(`【第${n}章开头】`), `${mode} 模式：第 ${n} 章开头泄漏了`)
        assert.ok(!section.includes(`【第${n}章结尾】`), `${mode} 模式：第 ${n} 章结尾泄漏了`)
      }
      if (mode === 'read-so-far') {
        assert.ok(!section.includes('【第5章结尾】'), `${mode} 模式：本章未读部分泄漏了`)
      }
    } finally {
      f.cleanup()
    }
  }
})

test('已读窗口：默认模式给完整本章，严格模式只给到光标', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.setProgress(bookId, { chapterIndex: 4, charOffset: 200 })

    const full = f.library.collectReadWindow(bookId, { ...BUDGET, currentChapterMode: 'full' })
    assert.equal(full.current.mode, 'full')
    assert.ok(full.current.text.includes('【第5章结尾】'), 'full 模式应当给整章')

    const strict = f.library.collectReadWindow(bookId, { ...BUDGET, currentChapterMode: 'read-so-far' })
    assert.equal(strict.current.mode, 'read-so-far')
    assert.ok(strict.current.text.includes('【第5章开头】'), 'read-so-far 应当给到光标之前')
    assert.ok(!strict.current.text.includes('【第5章结尾】'), 'read-so-far 不该越过光标')
  } finally {
    f.cleanup()
  }
})

test('已读窗口：上一章默认只给尾部，且标题跟着改口', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.setProgress(bookId, { chapterIndex: 4, charOffset: 200 })

    const tail = f.library.collectReadWindow(bookId, BUDGET)
    assert.ok(tail.previous !== null, '上一章应当存在')
    assert.equal(tail.previous.index, 3)
    assert.equal(tail.previous.mode, 'tail')
    assert.equal(tail.previous.truncatedBefore, true, '截断了就必须标出来')
    assert.ok(tail.previous.text.includes('【第4章结尾】'), '结尾正是这一段存在的理由')
    assert.ok(!tail.previous.text.includes('【第4章开头】'), '尾部模式不该带上上一章的开头')

    // ★ 差分断言：同一个窗口、只换 `previousChapterMode`。它同时钉两件事——
    // 逃生门还在（`full` = 旧行为），以及"到底截掉多少"是个可测的数字，
    // 而不是注释里的一个说法。
    const whole = f.library.collectReadWindow(bookId, { ...BUDGET, previousChapterMode: 'full' })
    assert.equal(whole.previous.mode, 'full')
    assert.equal(whole.previous.truncatedBefore, false)
    assert.ok(whole.previous.text.includes('【第4章开头】'), 'full 模式仍应给整章')

    const ratio = tail.previous.text.length / whole.previous.text.length
    assert.ok(ratio > 0.55 && ratio < 0.65, `尾部应当约为 60%，实际 ${(ratio * 100).toFixed(1)}%`)

    // ★ 接线：渲染层必须跟着改口。窗口说"这是结尾"而 prompt 写「上一章全文」，
    // 就是产物替我们声称了一件没发生的事（§204）。
    assert.match(renderCompanionSection({ window: tail, title: '测试书' }), /### 上一章结尾/)
    assert.doesNotMatch(renderCompanionSection({ window: tail, title: '测试书' }), /上一章全文/)
    assert.match(renderCompanionSection({ window: whole, title: '测试书' }), /### 上一章全文/)

    // 面板摘要也要说得出这件事：只报字数的话，用户会以为那是整章。
    const summary = describeWindow(renderCompanionSection({ window: tail, title: '测试书' }), tail)
    assert.equal(summary.previousTruncated, true)
    assert.equal(
      describeWindow(renderCompanionSection({ window: whole, title: '测试书' }), whole).previousTruncated,
      false,
      '没截断就不能说截断',
    )
  } finally {
    f.cleanup()
  }
})

test('已读窗口：更早的前文由背景认识代表，且缺口如实报告', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.setProgress(bookId, { chapterIndex: 4, charOffset: 200 })

    // 还没建过背景认识。
    let readWindow = f.library.collectReadWindow(bookId, BUDGET)
    assert.equal(readWindow.backgroundCovered, null)
    assert.deepEqual(readWindow.memoryGap, { from: 1, to: 4 }, '应当报告 1..4 的缺口')
    assert.match(readWindow.backgroundText, /还没有建立/)

    // 把 1..4 纳入认识后，缺口消失，认识进入段落。
    f.library.backgroundMerge(bookId, parseBackground([
      '## 人物关系',
      '- 甲 ↔ 乙：对手（`第2章`）',
      '## 人物',
      '### 甲',
      '- `第1章` 身份未明',
    ].join('\n')), { first: 1, last: 4 })

    readWindow = f.library.collectReadWindow(bookId, BUDGET)
    assert.deepEqual(readWindow.backgroundCovered, { first: 1, last: 4 })
    assert.equal(readWindow.memoryGap, null, '补完就不该再有缺口')
    assert.match(readWindow.backgroundText, /甲 ↔ 乙/)
  } finally {
    f.cleanup()
  }
})

test('倒退过滤：读者跳回水位线之前时，超前条目被挡住并**明说**', () => {
  // 这是本插件里唯一不可逆的剧透路径：读者点开很靠后的一章、记忆被推到那里，
  // 再回到前面老实读——旧实现在这个方向上**完全静默**，第 7 章的条目会被
  // 原样注入给正在读第 2 章的人。
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.backgroundMerge(bookId, parseBackground([
      '## 人物关系',
      '- 甲 ↔ 乙：对手（`第2章`）',
      '## 世界观',
      '- `第7章` 后期才揭晓的真相',
    ].join('\n')), { first: 1, last: 7 })

    // 倒退：读者回到第 2 章。
    f.library.setProgress(bookId, { chapterIndex: 1, charOffset: 0 })
    const readWindow = f.library.collectReadWindow(bookId, BUDGET)

    assert.equal(readWindow.backgroundBackward, true)
    assert.match(readWindow.backgroundText, /甲 ↔ 乙/, '第 2 章的条目要留下')
    assert.doesNotMatch(readWindow.backgroundText, /后期才揭晓的真相/, '第 7 章的条目必须被挡住')
    assert.match(readWindow.backgroundText, /已被过滤/, '过滤了却不说，读者只会觉得"AI 变笨了"')
    assert.ok(readWindow.backgroundFiltered.length > 0, '过滤必须被报出来，不能悄悄发生')

    // 文件本身一个字都不动——过滤只发生在"渲染给模型看"这一步。
    assert.deepEqual(readWindow.backgroundCovered, { first: 1, last: 7 })
    assert.match(f.library.backgroundMarkdown(bookId), /后期才揭晓的真相/, '文件不该被改写')
  } finally {
    f.cleanup()
  }
})

test('倒退过滤：只丢**当前章之后**的条目，当前章要留', () => {
  // 章号基准差 1 的专测：`covered.last` 是 1 起章号，`chapterIndex` 是 0 起索引。
  // 把上界写成 `chapterIndex` 而不是 `chapterIndex + 1`，正在读的那一章的条目
  // 就会被当成剧透丢掉——而那一章整章本来就要投喂给模型。
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.backgroundMerge(bookId, parseBackground([
      '## 世界观',
      '- `第7章` 当前这一章的设定',
      '- `第9章` 更后面的设定',
    ].join('\n')), { first: 1, last: 9 })

    // 读者正在读第 7 章（0 起索引 6）。
    f.library.setProgress(bookId, { chapterIndex: 6, charOffset: 0 })
    const readWindow = f.library.collectReadWindow(bookId, BUDGET)

    assert.equal(readWindow.backgroundBackward, true, '覆盖到 9 章、在读到第 7 章 —— 是倒退')
    assert.match(readWindow.backgroundText, /当前这一章的设定/, '当前章的条目必须保留')
    assert.doesNotMatch(readWindow.backgroundText, /更后面的设定/, '当前章之后的条目必须丢掉')
  } finally {
    f.cleanup()
  }
})

test('倒退过滤：正常前进时**不过滤**（过滤常开会毁掉缓存里最值钱的前缀）', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.backgroundMerge(bookId, parseBackground([
      '## 世界观',
      '- `第7章` 当前这一章的设定',
    ].join('\n')), { first: 1, last: 7 })

    // 水位线正好推到"当前章"——这是正常阅读的稳态，不是倒退。
    f.library.setProgress(bookId, { chapterIndex: 6, charOffset: 0 })
    const readWindow = f.library.collectReadWindow(bookId, BUDGET)

    assert.equal(readWindow.backgroundBackward, false, 'covered.last === 当前章号 不是倒退')
    assert.deepEqual(readWindow.backgroundFiltered, [], '稳态下一条都不该被过滤')
    assert.match(readWindow.backgroundText, /当前这一章的设定/)
  } finally {
    f.cleanup()
  }
})

test('背景认识：条目只增不减，重复条目会去重', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.backgroundMerge(bookId, parseBackground('## 人物关系\n- 甲 ↔ 乙：对手（`第2章`）\n'), { first: 1, last: 2 })

    // 同一个意思、不同章节标记 → 视为同一条，不重复入库。
    f.library.backgroundMerge(bookId, parseBackground('## 人物关系\n- 甲 ↔ 乙：对手（`第3章`）\n'), { first: 3, last: 3 })
    let doc = f.library.background(bookId)
    assert.equal(doc.sections['人物关系'].length, 1, '同一描述不该重复')

    // 新内容追加。
    f.library.backgroundMerge(bookId, parseBackground('## 人物关系\n- 甲 ↔ 乙：同盟（`第5章`）\n'), { first: 4, last: 5 })
    doc = f.library.background(bookId)
    assert.equal(doc.sections['人物关系'].length, 2, '新描述应当追加')
    assert.deepEqual(doc.covered, { first: 1, last: 5 }, '覆盖区间应当往后长')

    // 既有条目绝不因为"这次模型没提"而消失。
    const md = f.library.backgroundMarkdown(bookId)
    assert.match(md, /对手/)
    assert.match(md, /同盟/)
  } finally {
    f.cleanup()
  }
})

test('背景认识：手写内容在往返中不丢', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    // 模拟用户在文件里手写了一段。
    writeFileSync(f.library.backgroundPath(bookId), [
      '<!-- drc-background: schema=1 covered=1..2 -->',
      '# 《标记本》· 背景认识',
      '## 人物关系',
      '- 甲 ↔ 乙：对手',
      '## 人物',
      '## 世界观',
      '## 前文脉络',
    ].join('\n'), 'utf8')

    f.library.backgroundMerge(bookId, parseBackground('## 世界观\n- `第3章` 新增设定\n'), { first: 3, last: 3 })
    const md = f.library.backgroundMarkdown(bookId)
    assert.match(md, /甲 ↔ 乙：对手/, '已有的手写条目必须还在')
    assert.match(md, /新增设定/)
  } finally {
    f.cleanup()
  }
})

test('背景认识：清空是显式动作，清完缺口重新出现', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.backgroundMerge(bookId, parseBackground('## 世界观\n- `第1章` x\n'), { first: 1, last: 2 })
    assert.deepEqual(f.library.background(bookId).covered, { first: 1, last: 2 })

    f.library.backgroundReset(bookId)
    assert.equal(f.library.background(bookId).covered, null)
    assert.equal(f.library.background(bookId).sections['世界观'].length, 0)
  } finally {
    f.cleanup()
  }
})

test('抽样：从前往后覆盖，预算不够时只给前一段', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    // 每章约 4500 字；下限 1000 时预算 5000 只够 5 章。
    //
    // ⚠️ 这里显式 `emphasisFactor: 1`（= 均匀抽样）。默认的 3 倍加权会把预算
    // 集中到开头几章，于是每章的额度涨到 4998 字——超过单章长度，就不再有
    // 「（中略）」了。那条性质由下面独立的用例负责，不该和加权混在一个断言里。
    const sample = f.library.sampleChapters(bookId, 0, 7, {
      budgetChars: 5000,
      minPerChapter: 1000,
      maxPerChapter: 2000,
      emphasisFactor: 1,
    })

    assert.equal(sample.from, 0)
    assert.equal(sample.requestedTo, 7)
    assert.equal(sample.partial, true, '覆盖不全时必须如实报告')
    assert.ok(sample.to < 7, '不应当一步跨到区间末尾')
    assert.equal(sample.chapters.length, sample.to - sample.from + 1)
    // 头尾都在，中间标了省略。
    assert.match(sample.chapters[0].text, /【第1章开头】/)
    assert.match(sample.chapters[0].text, /（中略）/)
  } finally {
    f.cleanup()
  }
})

test('抽样：预算充足时一次覆盖整段，且每章都带章节归属', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    const sample = f.library.sampleChapters(bookId, 0, 3, { budgetChars: 60000, minPerChapter: 100, maxPerChapter: 3000 })
    assert.equal(sample.partial, false)
    assert.equal(sample.chapters.length, 4)
    assert.deepEqual(sample.chapters.map((c) => c.index), [0, 1, 2, 3])
    assert.equal(sample.chapters[0].title, '第一章 标题一')
  } finally {
    f.cleanup()
  }
})

test('抽样加权：开头的重点章拿到更多字数', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    const sample = f.library.sampleChapters(bookId, 0, 7, {
      budgetChars: 60000,
      minPerChapter: 100,
      maxPerChapter: 600,
      emphasisChapters: 5,
      emphasisFactor: 3,
    })

    assert.equal(sample.emphasisChapters, 5)
    assert.equal(sample.emphasisFactor, 3)
    assert.equal(sample.chapters.length, 8)

    const emphasized = sample.chapters.slice(0, 5).map((c) => c.text.length)
    const plain = sample.chapters.slice(5).map((c) => c.text.length)
    assert.ok(
      Math.min(...emphasized) > Math.max(...plain) * 2,
      `重点章应当明显更长：最短的重点章 ${Math.min(...emphasized)} vs 最长的普通章 ${Math.max(...plain)}`,
    )
  } finally {
    f.cleanup()
  }
})

test('抽样加权：判据是**绝对**章号，不是"本批的头几章"', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    const options = {
      budgetChars: 60000,
      minPerChapter: 100,
      maxPerChapter: 600,
      emphasisChapters: 5,
      emphasisFactor: 3,
    }

    // 从第 6 章（index 5）起：本批的"第一章"已经在重点区间之外，所以这一批
    // **整批都不加权**，各章字数应当完全一致。
    //
    // 这一条钉的是一个很容易写错的地方：判据若写成 `(index - from) < 重点章数`，
    // 那"第二批从第 51 章开始"又会把它自己的头 5 章当成重点，而那 5 章毫无特殊
    // 之处。写成相对偏移时，下面第二个断言会失败。
    const later = f.library.sampleChapters(bookId, 5, 7, options)
    const lengths = later.chapters.map((c) => c.text.length)
    assert.equal(new Set(lengths).size, 1, `第 6–8 章应当等长，实际 ${lengths.join('/')}`)

    // 同样的参数从第 1 章起：这三章落在重点区间内，必须更长。
    const early = f.library.sampleChapters(bookId, 0, 2, options)
    assert.ok(
      early.chapters[0].text.length > later.chapters[0].text.length * 2,
      '重点区间内的章应当比区间外的长',
    )
  } finally {
    f.cleanup()
  }
})

test('抽样：首次批次按"打底"限章，剩下的如实报告为未覆盖', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    // 用 3 章来测**机制**。默认值 30 由配置契约那条用例负责——这里要钉的是
    // "首次批次会限章"这个行为，不是那个数字。
    const sample = f.library.sampleChapters(bookId, 0, 7, {
      budgetChars: 24000,
      minPerChapter: 100,
      maxPerChapter: 600,
      foundation: true,
      foundationChapters: 3,
    })

    assert.equal(sample.foundation, true)
    assert.equal(sample.from, 0)
    assert.equal(sample.to, 2, '首次批次只覆盖前 3 章')
    assert.equal(sample.partial, true, '剩下的必须如实报告为未覆盖')
    assert.equal(sample.chapters.length, 3)
  } finally {
    f.cleanup()
  }
})

test('抽样：打底 + 常规两趟收敛，区间不留缝', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    const base = { budgetChars: 24000, minPerChapter: 100, maxPerChapter: 600 }

    const first = f.library.sampleChapters(bookId, 0, 7, { ...base, foundation: true, foundationChapters: 3 })
    assert.equal(first.foundation, true)
    assert.equal(first.to, 2)

    // 第二趟从水位线之后接着补。调用方就是这么算的（`covered.last + 1`），
    // 所以这里用 `first.to + 1` 模拟，断言的重点是"接得上、补得完"。
    const second = f.library.sampleChapters(bookId, first.to + 1, 7, { ...base, foundation: false })
    assert.equal(second.foundation, false)
    assert.equal(second.from, 3, '第二趟必须紧接第一趟，不能留缝')
    assert.equal(second.to, 7, '剩下的应当一趟补完')
    assert.equal(second.partial, false)
  } finally {
    f.cleanup()
  }
})

test('防剧透：书籍原文被包在 untrusted 信封里（正文不能当指令执行）', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.setProgress(bookId, { chapterIndex: 4, charOffset: 200 })
    const { section } = sectionOf(f.library, bookId)

    assert.match(section, /<book-excerpt trust="untrusted">/, '正文必须被信封包住')
    assert.match(section, /<\/book-excerpt>/, '信封必须闭合')
    assert.match(section, /只读数据/, '必须显式声明这不是指令')

    const open = section.indexOf('<book-excerpt')
    const body = section.indexOf('【第5章开头】')
    const close = section.indexOf('</book-excerpt>')
    assert.ok(open < body && body < close, '正文应当落在信封内部')
  } finally {
    f.cleanup()
  }
})

test('防剧透：书里的 {{ 已被转义，段落不会毁掉 prompt 装配', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.setProgress(bookId, { chapterIndex: 4, charOffset: 200 })
    const { readWindow, section } = sectionOf(f.library, bookId)

    assert.ok(readWindow.current.text.includes('{{evil}}'), '夹具本身应当含 {{evil}}')
    assert.ok(!section.includes('{{'), '段落里泄漏了 {{，会毁掉整次 prompt 装配')
    assert.ok(section.includes('evil'), '转义不应把内容整个吃掉')
  } finally {
    f.cleanup()
  }
})

test('防剧透：背景认识里的 {{ 也必须被转义（它同样进段落）', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.setProgress(bookId, { chapterIndex: 4, charOffset: 200 })
    f.library.backgroundMerge(bookId, parseBackground('## 世界观\n- `第1章` 招式叫 {{破天}}\n'), { first: 1, last: 4 })

    const { readWindow, section } = sectionOf(f.library, bookId)
    assert.equal(readWindow.backgroundText.includes('{{'), false, '背景文本自身就该已转义')
    assert.ok(!section.includes('{{'))
  } finally {
    f.cleanup()
  }
})

test('防剧透：进度在第一章开头时，不给出任何"更早的章节"', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.setProgress(bookId, { chapterIndex: 0, charOffset: 0 })
    const readWindow = f.library.collectReadWindow(bookId, BUDGET)

    assert.equal(readWindow.previous, null, '第一章没有上一章')
    assert.equal(readWindow.memoryGap, null, '第一章之前没有前文可补')
    // 章首豁免：读者点开第一章就已经看见首屏了，所以这里必须给出内容，
    // 否则 AI 在每章开头都"什么也没看到"，陪读直接失效。
    assert.ok(readWindow.current.text.includes('【第1章开头】'))
  } finally {
    f.cleanup()
  }
})

test('防剧透：进度缺失时按最保守边界（第一章开头）处理', () => {
  const f = makeFixture()
  try {
    const readWindow = f.library.collectReadWindow(f.book.bookId, BUDGET)
    assert.equal(readWindow.progress, null)
    assert.equal(readWindow.boundary.chapterIndex, 0)
    assert.equal(readWindow.boundary.charOffset, 0)
  } finally {
    f.cleanup()
  }
})

test('绑定：session- 前缀两侧不同形也必须能反查到书', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.bind(bookId, 'session-abc')

    assert.equal(f.library.bookForSession('abc'), bookId, '裸 UUID 必须能反查到')
    assert.equal(f.library.bookForSession('session-abc'), bookId, '原样形态也必须能反查到')
    assert.equal(f.library.bookForSession('other'), undefined)
  } finally {
    f.cleanup()
  }
})

test('防剧透：未绑定时段落为空（对宿主 = 无贡献）', () => {
  const f = makeFixture()
  try {
    const bookId = f.book.bookId
    f.library.setProgress(bookId, { chapterIndex: 2, charOffset: 100 })
    assert.equal(f.library.bookForSession('session-abc'), undefined)

    f.library.bind(bookId, 'session-abc')
    assert.equal(f.library.bookForSession('abc'), bookId)

    const { section } = sectionOf(f.library, bookId)
    assert.match(section, /陪读守则/)
    assert.ok(!section.includes('【第4章'), '不能越过进度')
  } finally {
    f.cleanup()
  }
})

test('防剧透：未知书回 BOOK_NOT_FOUND，而不是泄成内部错误', () => {
  const f = makeFixture()
  try {
    assert.throws(
      () => f.library.collectReadWindow('0123456789abcdef', BUDGET),
      /BOOK_NOT_FOUND/,
    )
    assert.throws(() => f.library.background('0123456789abcdef'), /BOOK_NOT_FOUND/)
  } finally {
    f.cleanup()
  }
})

//#endregion
