/**
 * **注入侧的取舍策略**（2026-10-06 起：**深度优先**）。
 *
 * ## 为什么改了
 *
 * 从前分组节走的是"**广度优先**"：额度不够时先做**粗化**（主体只留最新一条），再做
 * **置换**（丢最旧的完整单元，换更多主体的锚）—— 设计原话是"一个主体被整块丢掉意味着
 * AI 不知道他存在，比降级严重得多"。
 *
 * 实测（四份真机文件）它**两头都亏**：
 *   · 细节亏：为多露几个名字，把大卡也降级成一行 ⇒ 《一世之尊》**26/35** 张卡只剩一行 ✗；
 *   · 预算亏：全压成一行之后，一节的"可渲染上限"塌到 `主体数 × 40 字` ⇒ **13% 预算闲置** ✗。
 *
 * 读者 2026-10-06 拍板：**"可以取舍牺牲小配角"** ⇒ 改成：
 *   · 保住的人（近期优先）给**全文**；
 *   · 装不下的人**只进名录**（`（未展开 N：甲 / 乙 …）`，一行 3 字一个）——
 *     **照样让 AI 知道他们存在** ✓，但不再用"每人一条粗化记载"去换 ✓。
 *
 * ⚠️ 于是 `selectUnits` 的粗化/置换那一级**对分组节不再生效**（`coarseDegrade: false`）。
 *    代码留着（它对扁平节本来也无效、且是一条独立的降级路径），但**不要再为它写守卫**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseBackground, renderBackgroundForPrompt } from '../lib/host/background.js'

const md = (lines) => ['<!-- drc-background: schema=1 covered=1..60 -->', ...lines].join('\n')

/** 造一个有 N 个主体、每个 M 条记载的分组节。 */
const manySubjects = (count, perSubject) => {
  const lines = ['## 人物']
  for (let c = 0; c < count; c += 1) {
    lines.push(`### 甲${c}`)
    for (let i = 0; i < perSubject; i += 1) lines.push(`- \`第${i + 1}章\` 甲${c}的第${i + 1}条记载`)
  }
  return parseBackground(md(lines))
}

test('深度优先：额度够时，**每个主体都给全文**（不粗化）', () => {
  const out = renderBackgroundForPrompt(manySubjects(3, 4), { budgetChars: 9000, progressIndex: 30 })
  assert.deepEqual(out.coarsened, [], '预算充足时不该有任何主体被粗化')
  for (const c of [0, 1, 2]) {
    assert.match(out.text, new RegExp(`### 甲${c}`), `甲${c} 应当有 \`###\` 块`)
    assert.match(out.text, new RegExp(`甲${c}的第4条记载`), '最新一条在')
    assert.match(out.text, new RegExp(`甲${c}的第1条记载`), '⭐ **最早一条也在**（深度优先：给了全文就给全）')
  }
})

test('深度优先：额度紧张时，**保住的人给全文、装不下的只给名字**', () => {
  const out = renderBackgroundForPrompt(manySubjects(12, 4), { budgetChars: 900, progressIndex: 30 })

  // ① 保住的人：**全文**（不是"只剩最新一条"）
  const keptHeadings = [...out.text.matchAll(/^### 甲\d+$/gm)].map((m) => m[0])
  assert.ok(keptHeadings.length > 0, '预算 900 时应当至少留下一个主体')
  for (const heading of keptHeadings) {
    const name = heading.replace('### ', '')
    const at = out.text.indexOf(heading)
    const next = out.text.indexOf('\n### ', at + 1)
    const block = next === -1 ? out.text.slice(at) : out.text.slice(at, next)
    assert.match(block, /第1条记载/, `⭐ 「${name}」被保住 ⇒ 要给**全文**（含最早那条），不许只剩最新一条`)
  }

  // ② 装不下的人：**点名**（不是整块消失）
  const aside = /（未展开 (\d+)：([^）]*)）/.exec(out.text)
  assert.ok(aside !== null, `装不下的人要点名，实际：${out.text.slice(0, 300)}`)
  assert.ok(Number(aside[1]) > 0, '点名的人数要是正数')
  assert.match(aside[2], /甲\d+/, '名单里要有主体名')
  assert.equal(
    keptHeadings.length + Number(aside[1]), 12,
    '保住的人 + 点名的人 = 全部主体（一个都不许无声消失）',
  )
})

test('深度优先：分组节**不再出现"粗化"台账**（那一级对分组节已关闭）', () => {
  const out = renderBackgroundForPrompt(manySubjects(12, 4), { budgetChars: 900, progressIndex: 30 })
  assert.deepEqual(
    out.coarsened.filter((item) => item.name === '人物'), [],
    '分组节不许再走"每人只留最新一条"那条路 —— 它既砍细节又让额度花不完',
  )
})

test('深度优先：额度要**真的花掉**（不再出现"饿着 + 留着"）', () => {
  const out = renderBackgroundForPrompt(manySubjects(12, 4), { budgetChars: 900, progressIndex: 30 })
  // 从前这条会掉到 ~60%：全压成一行之后一节的"可渲染上限"塌了，预算花不出去。
  assert.ok(
    out.used >= 900 * 0.8,
    `预算 900 时应当花掉 ≥80%（深度优先之后内容更贵），实际 ${out.used}`,
  )
})

test('深度优先：图例里必须有 `（未展开 N：…）` 这个记号（否则模型看不懂那一行）', () => {
  const out = renderBackgroundForPrompt(manySubjects(12, 4), { budgetChars: 900, progressIndex: 30 })
  assert.match(out.text, /`（未展开 N：…）`/, '记号的含义由顶部图例定义（唯一一处）')
  assert.match(out.text, /装不下的人，只给名字/, '图例要说清它是什么意思')
})
