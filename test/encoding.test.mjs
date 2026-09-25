/**
 * 编码探测与解码的测试。
 *
 * 这里刻意用**手工构造的真实字节**而不是"编码后再解码"的往返测试——
 * 往返测试对同一份实现既是编码器又是解码器，解错了也照样通过。
 * 例如 GBK 的 `中` 是 `D6 D0`，这是查表得来的常量，不由本仓库生成。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decodeBook, normalizeNewlines } from '../lib/host/encoding.js'

const BOM_UTF8 = [0xef, 0xbb, 0xbf]
const BOM_UTF16LE = [0xff, 0xfe]
const BOM_UTF16BE = [0xfe, 0xff]

test('编码：UTF-8 BOM 优先于一切，且 BOM 不进正文', () => {
  const buffer = Buffer.from([...BOM_UTF8, ...Buffer.from('第一章 雪', 'utf8')])
  const result = decodeBook(buffer)
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.confidence, 'bom')
  assert.equal(result.text, '第一章 雪', 'BOM 必须被剥掉')
})

test('编码：无 BOM 的合法 UTF-8 走严格校验分支', () => {
  const result = decodeBook(Buffer.from('他说：“下雪了。”', 'utf8'))
  assert.equal(result.encoding, 'utf-8')
  assert.equal(result.confidence, 'strict-utf8')
  assert.equal(result.warnings.length, 0)
})

test('编码：GBK 字节序列（手工构造）回落到 GB18030 并正确解码', () => {
  // '中文' 在 GBK/GB2312 中：中 = D6 D0，文 = CE C4。
  const buffer = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  const result = decodeBook(buffer)

  assert.equal(result.encoding, 'gb18030')
  assert.equal(result.confidence, 'fallback')
  assert.equal(result.text, '中文')
  assert.ok(
    result.warnings.some((w) => w.includes('GB18030')),
    '必须如实告知发生了回落',
  )
})

test('编码：UTF-16LE BOM', () => {
  const body = Buffer.from('夜行', 'utf16le')
  const result = decodeBook(Buffer.concat([Buffer.from(BOM_UTF16LE), body]))
  assert.equal(result.encoding, 'utf-16le')
  assert.equal(result.confidence, 'bom')
  assert.equal(result.text, '夜行')
})

test('编码：UTF-16BE BOM', () => {
  // '夜' = U+591C → BE 字节序 59 1C。
  const buffer = Buffer.from([...BOM_UTF16BE, 0x59, 0x1c])
  const result = decodeBook(buffer)
  assert.equal(result.encoding, 'utf-16be')
  assert.equal(result.text, '夜')
})

test('编码：无 BOM 的 UTF-16LE 靠字节分布判定', () => {
  // 纯 ASCII 内容在 UTF-16LE 下偶数位全是 0x00，分布特征极强。
  const text = 'Chapter 1 The Snow Falls Tonight And Keeps Falling'
  const body = Buffer.from(text, 'utf16le')
  const result = decodeBook(body)

  assert.equal(result.encoding, 'utf-16le')
  assert.equal(result.confidence, 'heuristic')
  assert.equal(result.text, text)
  assert.ok(result.warnings.some((w) => w.includes('字节分布')))
})

test('编码：无 BOM 的中文 UTF-16LE 靠换行奇偶判定（NUL 分布在此失效）', () => {
  // 汉字码位都在 U+4E00 以上，UTF-16 下**几乎不产生 0x00 字节**，
  // NUL 分布启发式在这里完全失灵。若退回只看 NUL，这段会被误判成
  // GB18030 并整体解成乱码——这正是本用例要钉死的回归。
  const text = ['第一章 雪', '他记得那天的雪落得很慢。', '第二章 夜', '天光从瓦缝里漏下来。'].join('\n')
  const body = Buffer.from(text, 'utf16le')

  // 前提确认：这段字节里确实几乎找不到 NUL。
  const nulCount = [...body].filter((b) => b === 0).length
  assert.ok(nulCount < 8, `前提不成立：NUL 字节太多（${nulCount}）`)

  const result = decodeBook(body)
  assert.equal(result.encoding, 'utf-16le')
  assert.equal(result.text, text)
})

test('编码：无 BOM 的 UTF-16BE 同样靠换行奇偶判定', () => {
  const text = ['第一章 雪', '他记得那天的雪落得很慢。', '第二章 夜', '天光从瓦缝里漏下来。'].join('\n')
  const le = Buffer.from(text, 'utf16le')
  const be = Buffer.from(le)
  be.swap16()

  const result = decodeBook(be)
  assert.equal(result.encoding, 'utf-16be')
  assert.equal(result.text, text)
})

test('编码：GB18030 的长文不会被误判成 UTF-16', () => {
  // 反向回归：GB18030 文本里没有 NUL 也没有 `0A 00` 配对，
  // 必须老实走 GB18030 分支，不能被换行启发式抢走。
  const gbk = Buffer.from([
    0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, // 第一章\n
    0xd6, 0xd0, 0xce, 0xc4, 0x0a, // 中文\n
    0xb5, 0xda, 0xb6, 0xfe, 0xd5, 0xc2, 0x0a, // 第二章\n
    0xc4, 0xda, 0xc8, 0xdd, // 内容
  ])
  const result = decodeBook(gbk)
  assert.equal(result.encoding, 'gb18030')
  assert.match(result.text, /^第一章\n中文\n第二章\n内容$/)
})

test('编码：CRLF 与孤立 CR 都归一成 LF', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd')
})

test('编码：解码时已归一化换行（偏移一致性依赖这一点）', () => {
  const buffer = Buffer.from('第一章\r\n正文', 'utf8')
  const result = decodeBook(buffer)
  assert.equal(result.text, '第一章\n正文')
})

test('编码：空文件给出警告而不是抛错', () => {
  const result = decodeBook(Buffer.alloc(0))
  assert.equal(result.text, '')
  assert.ok(result.warnings.some((w) => w.includes('空')))
})
