/**
 * 「回到原文」：从笔记列表跳回那条笔记所属的章。
 *
 * 章号是笔记的机器标记里**现成的**（`<!-- drc-note:begin … chapter=N … -->`），所以
 * 这一步只差一个回调 —— 从前回顾旧摘抄时，想回原文看上下文得自己去目录里找。
 *
 * 为什么只能静态断言：组件冒烟渲染用的是"只取初值、不执行 effect"的 hook 替身，
 * 这条链路（点按钮 → 面板切视图 → 正文滚到那一章）在单测里根本不会被执行。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from './helpers/server.mjs'
import { TAG_VOCABULARY } from '../lib/host/tags.js'

test('回到原文：面板传下跳章回调，每条笔记的按钮带上自己的章号', () => {
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

  assert.match(source, /onJumpToChapter: jumpToChapter/, '跳回原文的回调必须由面板传进去')
  assert.match(
    source,
    /const jumpToChapter = useCallback\(\s*\(index, charOffset\) =>/,
    '它必须是 useCallback —— NoteList 是 memo，函数 prop 换引用会让整张列表重渲染',
  )
  assert.match(source, /onJumpToChapter\(note\.chapterIndex, note\.charOffset\)/, '每条笔记的按钮要带自己的章号与段内偏移')
  assert.match(
    source,
    /Number\.isInteger\(note\.chapterIndex\)/,
    '章号缺失的笔记（老笔记、手写块）不该渲染一个点了没反应的按钮',
  )
})

test('回退守卫：「复习」tag 与「回顾」开关都已按读者要求撤掉', () => {
  // 读者裁定："复习似乎没有必要，因为历史本来就暂时在这里"。这条守卫防的是
  // "下次谁顺手把它加回来" —— 撤掉的东西要有痕迹，否则改天又长出来。
  assert.ok(
    !TAG_VOCABULARY.some((entry) => entry.tag === '复习'),
    '内置 tag 里不该再有「复习」',
  )
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(!source.includes('reviewOnly'), '客户端不该再有「回顾」开关的状态')
  assert.ok(!source.includes('reviewQuery'), '两次取数都不该再带 tag 查询串')
  const host = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
  assert.ok(!host.includes("query.get('tag')"), '笔记路由不该再接 tag 参数')
})
