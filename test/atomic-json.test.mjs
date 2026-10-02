/**
 * `atomic-json`：原子写、CAS、冲突重试、以及**损坏文件的两种处置**。
 *
 * ## 为什么这个文件在 2026-10-01 才有
 *
 * 三方评审查出：`mutateBindings` / `mutateCategories` / `writeSettings` 三处的
 * 注释都写着"以 CAS 方式改"，但**都没传 `expectedRevision`** —— 那三处其实是
 * "最后写入者获胜"，而本模块开头恰好写着"没有 revision 校验的读-改-写会静默
 * 吞掉另一边的写入"。注释说了实话、接线没跟上，于是没有任何守卫看着它。
 *
 * 这里把四条行为钉死：累积写、CAS 真的拦、损坏时**挪开重建**（`mutateJson`）、
 * 损坏 + 声明了 CAS 时**拒写**（`updateJson`，书架索引走这条）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { atomicWriteJson, listQuarantined, mutateJson, readJson, revisionOf, updateJson } from '../lib/host/atomic-json.js'

const HERE = dirname(fileURLToPath(import.meta.url))
let seq = 0

/** 一个隔离的临时 JSON 文件。 */
function makeFile(initial) {
  seq += 1
  const dir = join(HERE, '.tmp', `atomic-${process.pid}-${Date.now()}-${seq}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'store.json')
  if (initial !== undefined) writeFileSync(path, initial, 'utf8')
  return { path, dir, read: () => readFileSync(path, 'utf8'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const FALLBACK = { schemaVersion: 1, list: [] }

test('mutateJson：读-改-写会累积，并给出新的 revision', () => {
  const f = makeFile(JSON.stringify({ schemaVersion: 1, list: ['a'] }))
  try {
    const result = mutateJson(f.path, {
      fallback: FALLBACK,
      mutate: (current) => ({ ...current, list: [...current.list, 'b'] }),
    })
    assert.deepEqual(result.value.list, ['a', 'b'])
    assert.equal(result.revision, revisionOf(f.read()), '返回的 revision 必须等于盘上那份')
    assert.equal(result.quarantinedTo, undefined, '正常路径不该挪任何文件')
  } finally {
    f.cleanup()
  }
})

test('CAS：拿着过期的 revision 写 → REVISION_CONFLICT（这是"最后写入者获胜"的解药）', () => {
  const f = makeFile(JSON.stringify({ schemaVersion: 1, list: ['a'] }))
  try {
    const stale = readJson(f.path, FALLBACK).revision
    // 模拟另一个进程/标签页先写了一次
    updateJson(f.path, {
      fallback: FALLBACK,
      expectedRevision: stale,
      mutate: (current) => ({ ...current, list: [...current.list, '别的进程'] }),
    })

    assert.throws(
      () => updateJson(f.path, {
        fallback: FALLBACK,
        expectedRevision: stale,
        mutate: (current) => ({ ...current, list: [...current.list, '我'] }),
      }),
      (error) => error.code === 'REVISION_CONFLICT',
      '过期的 revision 必须被拦住 —— 否则先写的那一份被静默吞掉',
    )
    assert.deepEqual(JSON.parse(f.read()).list, ['a', '别的进程'], '被拒的那次不能留下任何痕迹')
  } finally {
    f.cleanup()
  }
})

test('损坏 + 声明了 CAS → 拒写，且**原样留着**（书架索引的处置）', () => {
  const f = makeFile('{ 这不是 JSON')
  try {
    assert.throws(
      () => updateJson(f.path, {
        fallback: FALLBACK,
        expectedRevision: null,
        mutate: () => ({ schemaVersion: 1, list: ['重建'] }),
      }),
      (error) => error.code === 'STORAGE_CORRUPT',
      '损坏的 library.json 不该被一个空骨架覆盖 —— 那是"只剩这一本"那个 P1 的根因',
    )
    assert.equal(f.read(), '{ 这不是 JSON', '那份坏文件必须一个字节都不动，好让读者能修它')
  } finally {
    f.cleanup()
  }
})

test('损坏 + 没声明 CAS → 保持既有宽容契约（草稿那条路）', () => {
  const f = makeFile('garbage')
  try {
    const result = updateJson(f.path, {
      fallback: FALLBACK,
      mutate: () => ({ schemaVersion: 1, list: ['重建'] }),
    })
    assert.deepEqual(result.value.list, ['重建'], '临时存储（草稿）的契约是"读回空集、下次写重建"')
  } finally {
    f.cleanup()
  }
})

test('mutateJson：损坏的文件被**挪到一边**（不删）后重建 —— 派生态自愈，但一份都没丢', () => {
  const f = makeFile('{ 坏掉的绑定表')
  try {
    const result = mutateJson(f.path, {
      fallback: { schemaVersion: 1, books: {} },
      mutate: (current) => ({ ...current, books: { ...current.books, 第一本: {} } }),
    })

    assert.ok(result.quarantinedTo, '必须告诉调用方坏文件挪到哪儿了')
    assert.equal(readFileSync(result.quarantinedTo, 'utf8'), '{ 坏掉的绑定表', '坏内容必须**完整保留**在挪走的那份里')
    assert.deepEqual(Object.keys(result.value.books), ['第一本'], '新的一份照常建立')
    assert.equal(readdirSync(f.dir).filter((name) => name.includes('.corrupt-')).length, 1)
  } finally {
    f.cleanup()
  }
})

test('listQuarantined：把"挪到一边的坏文件"列出来（读者侧那句提示的数据来源）', () => {
  // ⚠️ 2026-10-02 三方评审 P2-2：`quarantinedTo` 早就返回了，全树却**零消费者** ——
  //    绑定 / 分类 / 设置三份文件损坏时读者侧零提示（只有书架索引那条路会说），
  //    于是"我的阅读进度怎么全没了"没有任何解释。这条函数是那条提示的数据源：
  //    它从**磁盘**上读（不是内存里某次写入的残留）⇒ 重启后仍然说得出事。
  const f = makeFile('{ 坏掉的绑定表')
  try {
    assert.deepEqual(listQuarantined(f.dir), [], '没出事时必须安静（否则会天天报警）')

    mutateJson(f.path, {
      fallback: { schemaVersion: 1, books: {} },
      mutate: (current) => current,
    })

    const found = listQuarantined(f.dir)
    assert.equal(found.length, 1, '挪走的那一份必须被列出来')
    assert.equal(found[0].base, basename(f.path), '要能认出它原本是哪份文件（界面靠它说人话）')
    assert.ok(found[0].file.includes('.corrupt-'), '给的是磁盘上那个真名')
    assert.equal(readFileSync(found[0].path, 'utf8'), '{ 坏掉的绑定表', '内容仍然完整')
  } finally {
    f.cleanup()
  }
})

test('atomicWriteText：顺带清掉**过期**的临时残骸，但绝不碰新鲜的（别人正在写的那份）', () => {
  // 被强杀的进程会留下 `<名字>.<pid>.<随机>.tmp`（`catch` 只清得掉本次那一份）。
  // 它们不影响正确性，但会越积越多，看着像"写盘写坏了"。
  const f = makeFile(JSON.stringify({ schemaVersion: 1, list: [] }))
  try {
    const stale = `${f.path}.999.deadbeef.tmp`
    const fresh = `${f.path}.999.cafebabe.tmp`
    writeFileSync(stale, '残骸', 'utf8')
    writeFileSync(fresh, '别人正在写', 'utf8')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, old, old)

    atomicWriteJson(f.path, { schemaVersion: 1, list: ['新'] })

    assert.ok(!existsSync(stale), '超过一小时的残骸应当被清掉')
    assert.ok(existsSync(fresh), '新鲜的临时文件必须留着 —— 那可能是另一个进程正在写的那一份')
  } finally {
    f.cleanup()
  }
})
