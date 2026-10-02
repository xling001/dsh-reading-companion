/**
 * 冷归档 + 历代备份（delta / 并集）的守卫。
 *
 * 背景（`docs/design-history.md` v2.22）：压缩这条路有硬上限（模型单次输出 32768 tokens ≈ 2.6 tokens/字
 * ⇒ 文件到 1.2–1.5 万字就压不出完整输出）。冷归档把"把旧条目移出上下文"这一步
 * **从模型手里拿回来**：纯代码、零模型调用、原文一字不改。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BACKGROUND_ARCHIVE_SECTION,
  applyArchive,
  isGroupedSection,
  parseBackground,
  planArchive,
  renderBackground,
  renderBackgroundForPrompt,
} from '../lib/host/background.js'
import {
  HISTORY_DIR,
  buildArchiveDelta,
  historyFileName,
  nextHistorySeq,
  unionHistory,
  unionKey,
} from '../lib/host/background-history.js'

/** 一份覆盖 1..60 的样本：甲的早年条目在第 5 章，晚年条目在第 55 章。 */
const SAMPLE = [
  '<!-- drc-background: schema=1 covered=1..60 -->',
  '# 《某书》· 背景认识',
  '',
  '## 人物关系',
  '- 甲 ↔ 乙：`第3章` 同门；`第55章` 反目',
  '',
  '## 人物',
  '### 甲',
  '- `第5章` 出身寒门，被师父收留。',
  '- `第55章` 已经当上掌门。',
  '',
  '## 世界观',
  '- `第4章` 门派规矩：入门三年不得下山。',
  '- 江湖通称「上三门」，与进度无关的通用设定。',
  '',
  '## 文风（只写一次）',
  '- `第2章` 短句为主，对话密集。',
  '',
  '## 时间与分线',
  '### 主线',
  '- `第1-60章` 从入门到接掌。',
].join('\n')

test('冷归档：只搬"整条都在窗口之外"的条目，没章号的条目不搬', () => {
  const doc = parseBackground(SAMPLE)
  const plan = planArchive(doc, 30) // 活跃窗口从第 30 章起

  const flat = plan.items.flatMap((item) => item.entries)
  assert.ok(flat.includes('`第5章` 出身寒门，被师父收留。'), '第 5 章的老条目要被点到')
  assert.ok(!flat.includes('`第55章` 已经当上掌门。'), '第 55 章的条目在窗口内，不能搬')
  assert.ok(!flat.includes('江湖通称「上三门」，与进度无关的通用设定。'), '没有章号的通用设定永不归档')
  assert.ok(flat.includes('`第4章` 门派规矩：入门三年不得下山。'), '世界观里的老条目也要搬（它是注入族）')
  // 「文风（只写一次）」豁免：它是稳定特征，永远在场有用（它的条目也带章号，会被误伤）
  assert.ok(
    !plan.items.some((item) => item.section === '文风（只写一次）'),
    '「文风（只写一次）」不参与冷归档',
  )
})

test('冷归档：「时间与分线」也要有天花板——支线单元整条出窗口才搬，主线永不搬', () => {
  // ⚠️ 2026-10-03 体检发现：这一节从前是**唯一**既不注入、又不压缩、又不冷归档的节
  //    （`planArchive` 原先只遍历注入族，见它的循环）⇒ 只增不减、**无上限**。
  //    它是读者要看的"骨架 + 支线"，所以给它加天花板时：**主线**（骨架）永远保留，
  //    **支线单元**整条出窗口就搬进冷档案（仍是读者族，仍可看、可导出）。
  const doc = parseBackground([
    '<!-- drc-background: schema=1 covered=1..200 -->',
    '# 《某书》· 背景认识',
    '',
    '## 时间与分线',
    '### 主线',
    '- `第1-30章` 从入门到接掌。',
    '### 【支线】押镖 · 第45-72章',
    '- `第45章` 起：接下镖局的活。',
    '- `第72章` 收：镖银到手，与镖头结下交情。',
    '### 【支线】南疆 · 第150-190章',
    '- `第150章` 起：南下查一桩旧案。',
    '- `第190章` 收：旧案了结。',
  ].join('\n'))

  const plan = planArchive(doc, 100)
  const units = plan.items.filter((item) => item.section === '时间与分线').map((item) => item.entity)
  assert.deepEqual(units, ['【支线】押镖 · 第45-72章'], '只有整条出窗口的支线搬；窗口内的南疆不搬')
  assert.equal(units.includes('主线'), false, '主线是骨架、永远保留 —— 它是这一节存在的理由')

  // ⚠️ 单元是**整体**：搬一半会把一条支线拆成两半（读者看到的是"这件事说了一半"）
  const partial = planArchive(doc, 60)
  assert.equal(
    partial.items.some((item) => item.section === '时间与分线'),
    false,
    '第45-72章那条在窗口 60 处只老了一半 ⇒ 整条都不搬',
  )
})

test('冷归档：搬进「冷档案」时保留来源与主体，原文一字不改', () => {

  const doc = parseBackground(SAMPLE)
  const { doc: next, moved } = applyArchive(doc, 30)
  assert.ok(moved > 0)

  const haystack = JSON.stringify(next.groups?.[BACKGROUND_ARCHIVE_SECTION] ?? {})
  assert.ok(haystack.includes('第5章` 出身寒门，被师父收留。'), '搬到归档区的条目必须**原文**（去重键要靠它）')
  assert.ok(haystack.includes('`第4章` 门派规矩：入门三年不得下山。'), '世界观的老条目进归档')

  // 活分区里就没有它了，而且**新内容还在**
  const aliveAfter = JSON.stringify(next.groups?.['人物'] ?? {})
  assert.ok(!aliveAfter.includes('出身寒门'), '活分区的老条目已经搬走')
  assert.ok(aliveAfter.includes('已经当上掌门'), '窗口内的条目必须留在活分区')

  // 写盘后仍是合法的文件（能再解析、且归档节在）
  const md = renderBackground(next, '某书')
  const round = parseBackground(md)
  assert.ok(md.includes(`## ${BACKGROUND_ARCHIVE_SECTION}`), '文件里有冷档案节')
  assert.ok(round.md !== undefined || md.length > 0)
  assert.ok(JSON.stringify(round.groups?.[BACKGROUND_ARCHIVE_SECTION] ?? {}).includes('出身寒门'), '解析回来还在')
})

test('冷归档：归档区**绝不进注入**（归档的意义就是从上下文里移出）', () => {
  const doc = parseBackground(SAMPLE)
  const { doc: next, moved } = applyArchive(doc, 30)
  assert.ok(moved > 0)
  const injected = renderBackgroundForPrompt(next, { budgetChars: 6000 }).text
  assert.ok(!injected.includes('冷档案'), '元数据里都不该出现"冷档案"')
  assert.ok(!injected.includes('出身寒门'), '被归档的条目一个字都不该进提示词')
  assert.ok(injected.includes('已经当上掌门'), '窗口内的条目照旧进提示词')
})

test('冷归档：窗口起点 ≤ 1 时一件都不动；窗口内的条目不许动', () => {
  const doc = parseBackground(SAMPLE)
  assert.equal(applyArchive(doc, 1).moved, 0)
  assert.equal(planArchive(doc, 1).total, 0)
  // 窗口从第 10 章起：第 5 章 / 第 4 章两条出窗口（文风豁免），第 55 章那条在窗口内
  const { doc: next, moved } = applyArchive(doc, 10)
  assert.equal(moved, 2)
  assert.ok(JSON.stringify(next.groups?.['人物'] ?? {}).includes('已经当上掌门'), '窗口内的条目必须留在活分区')
})

test('历代备份：命名有规律有顺序（四位序号 + 时间 + 操作），序号即时间序', () => {
  const at = new Date(2026, 9, 2, 3, 15, 0)
  const name = historyFileName(7, at, '归档')
  assert.equal(name, '0007-20261002-031500-归档.md')
  assert.deepEqual(
    [historyFileName(2, at, '归档'), historyFileName(10, at, '覆盖')].sort(),
    ['0002-20261002-031500-归档.md', '0010-20261002-031500-覆盖.md'],
    '字典序 = 序号序（读者要按顺序取并集）',
  )
  assert.equal(nextHistorySeq(['0001-a.md', '0007-b.md', 'note.md']), 8)
  assert.equal(nextHistorySeq([]), 1)
  assert.equal(HISTORY_DIR, 'background.history')
})

test('历代备份：delta 只记这一笔搬走的条目（所以备份之间不重复）', () => {
  const doc = parseBackground(SAMPLE)
  const plan = planArchive(doc, 30)
  const delta = buildArchiveDelta({ keepFromChapter: 30, at: new Date(2026, 9, 2), items: plan.items })
  assert.ok(delta.includes('keepFromChapter=30'))
  assert.ok(delta.includes('### 人物·甲'), '保留来源与主体（取并集时要归位）')
  assert.ok(delta.includes('出身寒门'))
  // ⚠️ 它**不该**包含窗口内的条目（那就是"备份之间重复"）
  assert.ok(!delta.includes('已经当上掌门'), 'delta 只记被搬走的，不抄活内容')
})

test('历代备份：取并集按正文去重、按主体归位', () => {
  const deltaA = ['## 人物', '### 人物·甲', '- `第5章` 出身寒门，被师父收留。'].join('\n')
  // 同一件事换了个章号写法 / 标点 —— 必须算重复
  const deltaB = ['## 人物', '### 甲', '- 出身寒门 被师父收留（`第5章`）'].join('\n')
  const merged = unionHistory([deltaA, deltaB], { title: '# 合集' })
  assert.equal(merged.entries, 2)
  assert.equal(merged.duplicates, 1, '换写法的同一条要被并掉')
  assert.ok(merged.markdown.includes('## 甲'), '`人物·甲` 要归位成 `甲`')
  assert.equal(unionKey('`第5章` 出身寒门，被师父收留。'), unionKey('出身寒门 被师父收留（第5章）'))
})

test('冷档案：登记为读者族的分组节（不进注入、能保 `###` 原文）', () => {
  const doc = parseBackground(SAMPLE)
  assert.ok(isGroupedSection(BACKGROUND_ARCHIVE_SECTION), '归档区里的 `### 人物·甲` 要被当成主体保留')
  assert.ok(!renderBackgroundForPrompt(doc, { budgetChars: 6000 }).text.includes('冷档案'))
})

test('冷归档 · 身份锚（3.0 第二刀）：一个主体的条目**全都出窗口**时，给他留最新的一条在活分区', () => {
  // ⚠️ 这是冷归档**自己**引入的风险：把他整块搬走 ⇒ 第 200 章有人提他名字时，模型对他一无所知。
  //    留一条（约 40 字）换回"他是谁"，代价有界（主体数 × 40 字）。
  const md = [
    '<!-- drc-background: schema=1 covered=1..100 -->',
    '# 《锚》· 背景认识',
    '',
    '## 人物',
    '### 甲',
    '- `第3章` 早年的事。',
    '- `第10章` 中段的事。',
    '- `第20章` 最后被提到的一次。',
    '### 乙',
    '- `第5章` 乙早年。',
    '- `第80章` 乙最近还在场。',
  ].join('\n')
  const doc = parseBackground(md)
  const plan = planArchive(doc, 40) // 窗口从第 40 章起

  const jia = plan.items.find((item) => item.entity === '甲')
  assert.ok(jia !== undefined, '甲有两条要归档')
  assert.deepEqual(
    jia.entries,
    ['`第3章` 早年的事。', '`第10章` 中段的事。'],
    '甲的最新一条（第 20 章）要**留在活分区**当身份锚',
  )
  const yi = plan.items.find((item) => item.entity === '乙')
  assert.deepEqual(yi.entries, ['`第5章` 乙早年。'], '乙还有近期条目 ⇒ 老的照常全搬（不回锚）')

  const { doc: next } = applyArchive(doc, 40)
  const aliveJia = JSON.stringify(next.groups?.['人物']?.['甲'] ?? [])
  assert.ok(aliveJia.includes('最后被提到的一次'), '锚留在活分区')
  const injected = renderBackgroundForPrompt(next, { budgetChars: 9000 }).text
  assert.ok(injected.includes('最后被提到的一次'), '锚必须进提示词（否则等于把人忘了）')
  assert.ok(!injected.includes('早年的事'), '被归档的条目不进提示词')
})

test('冷归档 · 身份锚：主体只有一条时也要留（不能搬成空卡）', () => {
  const md = [
    '<!-- drc-background: schema=1 covered=1..50 -->',
    '# 《锚2》· 背景认识',
    '',
    '## 人物',
    '### 丙',
    '- `第4章` 丙只出现过一次。',
  ].join('\n')
  const doc = parseBackground(md)
  const plan = planArchive(doc, 30)
  assert.equal(plan.total, 0, '只剩一条的主体不搬（搬了就成空卡）')
  assert.equal(applyArchive(doc, 30).moved, 0)
})
