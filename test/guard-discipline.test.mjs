/**
 * **守卫纪律**（元守卫，2026-10-03）。
 *
 * ## 它治的是什么
 *
 * 普查实测：`test/` 里 51 条"接线守卫"有 **38 条挤在 `client.test.mjs`**，其中 34 条
 * 是**字符串比对** —— 它们几乎每条注释里都写着同一句免责声明（"react 替身只取初值、
 * 不执行 effect，所以只能静态断言"）。那批钉子钉的是 `source.includes('…')`：改注释、
 * 换行、重命名局部变量都可能让它红，而**真正接错线时它又未必红**。
 *
 * 2026-10-03 的 B 档给这半边补了运行时测试台（`test/helpers/hooks-runtime.mjs`），
 * 把能渲染的逐条换成了行为断言。这条元守卫负责**别让它们长回来**：
 *
 * > `test/client.test.mjs` 里凡是**读生产源码再断言**的用例，必须是二者之一：
 * >   ① 名字以 `样式与模板：` 开头（钉的就是那段文本本身，普查单列一类）；
 * >   ② 判定为"为了执行"（把源码跑起来 / 模块契约），不是字符串比对。
 *
 * ## 为什么它自己不会被算成接线守卫
 *
 * 它读的是 `test/client.test.mjs`（**测试文件**），而 `SOURCE_PATH_RE` 只认生产源码
 * 与文档 —— 所以普查不会把它算进那 38 条里。这是刻意的（见 `scripts/guard-classify.mjs`）。
 *
 * ⚠️ 判据**不在这里重写**：import 共用的那一个文件。复制一份就是本仓库反复栽的
 *    "同一概念多份定义"（`isGroupedSection` 那次丢了 627 条守卫才收成一个函数）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TEXT_PIN_PREFIXES, classifyBlock, testBlocks, testName } from '../scripts/guard-classify.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_TEST = join(HERE, 'client.test.mjs')

test('守卫纪律：`client.test.mjs` 里读生产源码的用例，不许再"用字符串匹配代替运行"', () => {
  const text = readFileSync(CLIENT_TEST, 'utf8')
  const offenders = testBlocks(text)
    .filter((block) => classifyBlock(block) === '接线守卫')
    .map((block) => testName(block))

  assert.deepEqual(
    offenders,
    [],
    '这些用例又回到了"读源码 + 字符串比对"。两条出路：'
    + '① 能渲染就转成运行时行为断言（范式见 test/client-runtime.test.mjs）；'
    + `② 钉的确实是那段文本本身（CSS / 模板字符串 / 理由注释 / 路由表）就改名为「${TEXT_PIN_PREFIXES.join('…」或「')}…」，普查会把它单列一类。`,
  )
})

test('守卫纪律：文本钉子的名字前缀不许空挂（它必须真的在读生产源码）', () => {
  // 防"改名躲普查"：给一条**不读源码**的用例挂上文本钉子前缀是没有意义的，
  // 只会让普查的"文本钉子"那一类虚高，反而把真实的接线守卫藏起来。
  const text = readFileSync(CLIENT_TEST, 'utf8')
  const fake = testBlocks(text)
    .filter((block) => TEXT_PIN_PREFIXES.some((prefix) => testName(block).startsWith(prefix)))
    .filter((block) => classifyBlock(block) === '行为')
    .map((block) => testName(block))

  assert.deepEqual(fake, [], `这些用例挂了文本钉子前缀（${TEXT_PIN_PREFIXES.join(' / ')}），却并不读生产源码：`)
})
