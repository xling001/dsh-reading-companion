/**
 * 路径原语测试 —— `lib/host/paths.js` 的 containment 家族。
 *
 * ⚠️ 2026-10-02 新增（三方评审后的"承诺守卫"）：这一族的导出在本轮之前
 * **一条直接测试都没有** —— `resolveInsideRoot` / `assertInsideRoot` /
 * `assertRealPathInsideRoot` / `splitRelativeSegments` / `inspectImportSource`
 * 在 `test/` 里的命中数都是 0，它们只是被别的模块的用例**间接**扫过。
 *
 * 重点是 `assertRealPathInsideRoot`：书库目录若被换成 junction / symlink 指向别处，
 * 文本层面的 `assertInsideRoot` **完全看不出来**（路径字面量确实落在根内），
 * 只有落到文件系统才能判定。所以这条守卫必须真的在盘上造一个 junction ——
 * "读代码觉得它没问题"不算覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assertInsideRoot,
  assertRealPathInsideRoot,
  resolveInsideRoot,
  splitRelativeSegments,
} from '../lib/host/paths.js'
import { makeDir } from './helpers/server.mjs'

test('路径原语：相对段拆分与越界 / 绝对路径拒绝', () => {
  assert.deepEqual(splitRelativeSegments('a/b/c'), ['a', 'b', 'c'])
  assert.deepEqual(splitRelativeSegments('a//b/./c'), ['a', 'b', 'c'])
  assert.deepEqual(splitRelativeSegments('a\\b'), ['a', 'b'])
  assert.throws(() => splitRelativeSegments('../a'), /PATH_ESCAPES_ROOT/)
  assert.throws(() => splitRelativeSegments('a/../../b'), /PATH_ESCAPES_ROOT/)
  assert.throws(() => splitRelativeSegments('C:\\Windows\\System32'), /PATH_NOT_RELATIVE/)
  assert.throws(() => splitRelativeSegments('\\\\server\\share\\x'), /PATH_NOT_RELATIVE/)
})

test('路径原语：resolveInsideRoot 落在根内，越界与"同级前缀"都拒绝', () => {
  const root = makeDir('paths-root')
  assert.equal(resolveInsideRoot(root, 'a/b.txt'), join(root, 'a', 'b.txt'))
  assert.throws(() => assertInsideRoot(root, join(root, '..', 'x')), /PATH_OUTSIDE_ROOT/)
  // 同级前缀（`<root>-2`）不能被当成根内 —— 这是 `startsWith` 写法的经典漏洞。
  assert.throws(() => assertInsideRoot(root, `${root}-2\\x`), /PATH_OUTSIDE_ROOT/)
  assert.doesNotThrow(() => assertInsideRoot(root, join(root, 'a')))
})

test('路径原语：junction 指向根外时，真实路径复检必须拒绝（新增覆盖）', (t) => {
  const root = makeDir('paths-realpath-root')
  const outside = makeDir('paths-realpath-outside')
  writeFileSync(join(outside, 'secret.txt'), 'x')
  const link = join(root, 'link')

  try {
    // Windows 上 `type: 'junction'` **不需要管理员权限**（symlink 需要开发者模式）；
    // 其它平台回落到普通目录软链。
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`本机无法创建 junction / symlink：${error?.message ?? error}`)
    return
  }

  try {
    const target = join(link, 'secret.txt')
    // 文本层面它落在根内 —— 纯字符串判定看不出来，这正是需要 realpath 的原因。
    assert.doesNotThrow(() => assertInsideRoot(root, target))
    // 真实路径落在根外 —— 必须拒绝。
    assert.throws(() => assertRealPathInsideRoot(root, target), /PATH_OUTSIDE_ROOT/)

    // 反向守卫：根内的普通文件仍然放行（否则这道闸就变成"什么都拦"）。
    const inside = join(root, 'inside.txt')
    writeFileSync(inside, 'x')
    assert.doesNotThrow(() => assertRealPathInsideRoot(root, inside))
    // 不存在的路径原样返回（交给调用方先创建），不该抛错。
    assert.doesNotThrow(() => assertRealPathInsideRoot(root, join(root, 'nope.txt')))
  } finally {
    // 先摘掉链接，避免退出清理时按目录递归走进目标。
    rmSync(link, { recursive: true, force: true })
  }
})
