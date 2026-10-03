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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, fsyncSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { atomicWriteJson, listQuarantined, mutateJson, openForFsync, readJson, revisionOf, updateJson } from '../lib/host/atomic-json.js'

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

/** 跑一次并把它抛出的错误交回来（断言 `code` 要用）。 */
function capture(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

test('读不到 ≠ 不存在：非 ENOENT 的读失败标 unreadable，写路径一律拒写（2026-10-03，外部评审 #1）', () => {
  // ⚠️ 这条挡的是一个**静默吃数据**的形状。从前 `readJson` 的第一个 catch 是**裸的**：
  //    `ENOENT`（真的没有）与 `EACCES`/`EIO`/被杀毒软件或同步盘锁住**长得一模一样**
  //    —— 都是 `{ revision: null, recovered: false }`。于是调用方以为"这文件还没建"，
  //    `expectedRevision` 传 `null`；而读失败时 `revision` **也是** `null`
  //    ⇒ CAS 判"相等"直接放行 ⇒ **把一份读不到的好数据覆盖成空骨架**，全程无声。
  //
  //    （传**真实** revision 的路径是安全的：`null ≠ 真值` 会抛 `REVISION_CONFLICT`。
  //      危险只落在 `expectedRevision: null` + 文件其实存在 这一种组合上。）
  const f = makeFile()
  try {
    // 造一个"存在但读不出来"的路径：**目录本身**。`readFileSync(目录)` 报 EISDIR
    // —— 这是不依赖平台权限设置、Windows/Linux 都能稳定复现的"非 ENOENT"。
    const asDir = join(f.dir, 'locked.json')
    mkdirSync(asDir)

    const read = readJson(asDir, FALLBACK)
    assert.equal(read.unreadable, true, '非 ENOENT 的读失败必须标 unreadable')
    assert.equal(read.recovered, false, '它不是"损坏"—— 盘上那份可能是完好的')
    assert.equal(read.revision, null)

    // 真的不存在才允许 `unreadable: false`（否则新装用户第一次写就被挡住）
    assert.equal(readJson(join(f.dir, 'never.json'), FALLBACK).unreadable, false)

    // 写路径一律拒写，而且**不要求**调用方声明 CAS（那是"损坏"那条的规矩：
    // 损坏时没有东西可丢，读不到时**有东西可丢**）
    for (const [label, run] of [
      ['updateJson', () => updateJson(asDir, { fallback: FALLBACK, mutate: () => FALLBACK })],
      ['updateJson + 声明 CAS', () => updateJson(asDir, { fallback: FALLBACK, expectedRevision: null, mutate: () => FALLBACK })],
      ['mutateJson', () => mutateJson(asDir, { fallback: FALLBACK, mutate: () => FALLBACK })],
    ]) {
      const error = capture(run)
      assert.ok(error !== null, `${label}：读不到时必须拒写，不能当成"空数据"写下去`)
      assert.equal(error.code, 'STORAGE_UNREADABLE', label)
      assert.equal(error.path, asDir, label)
    }

    // ⚠️ 反向：**真的不存在**必须照旧能首写 —— 否则新装用户连第一本书都存不下。
    const fresh = join(f.dir, 'brand-new.json')
    assert.doesNotThrow(() =>
      updateJson(fresh, { fallback: FALLBACK, expectedRevision: null, mutate: () => ({ schemaVersion: 1, list: ['第一本'] }) }),
    )
    assert.deepEqual(JSON.parse(readFileSync(fresh, 'utf8')).list, ['第一本'], '首写必须真的落盘')
  } finally {
    f.cleanup()
  }
})

/**
 * 刷盘句柄的**打开方式**（2026-10-04 实测修正）。
 *
 * 为什么值得两条用例：`atomicWriteText` 的"内容先落盘再 rename"**全部**建立在
 * `fsyncSync` 真的成功之上，而这件事在 JS 里**不可观测** —— 它成功与失败
 * （Windows 上只读句柄恒抛 `EPERM`，且被 best-effort 的 catch 吞掉）在盘上
 * 长得一模一样。所以守卫只能落在"打开方式"这个**可调用的机制**上：
 * `openForFsync` 是生产路径自己用的那个函数（不是为测试另写一份），
 * 于是"把可写句柄改回只读"会当场红。
 */
test('刷盘句柄：文件以可写方式打开，fsync 必须真的成功', () => {
  const f = makeFile('{}')
  try {
    const fd = openForFsync(f.path)
    try {
      assert.doesNotThrow(() => fsyncSync(fd), '可写句柄上的 fsync 不该失败（Windows 上只读句柄必 EPERM）')
    } finally {
      closeSync(fd)
    }
  } finally {
    f.cleanup()
  }
})

test('刷盘句柄：目录也能真的刷一次（Windows 上目录用只读句柄同样是 EPERM）', () => {
  const f = makeFile('{}')
  try {
    const fd = openForFsync(f.dir)
    try {
      assert.doesNotThrow(() => fsyncSync(fd), '目录项也要能刷 —— rename 本身靠它持久')
    } finally {
      closeSync(fd)
    }
  } finally {
    f.cleanup()
  }
})

test('平台事实：只读句柄上的 fsync 在 Windows 上抛 EPERM（上面那条顺序就是为它定的）', () => {
  const f = makeFile('{}')
  try {
    const fd = openSync(f.path, 'r')
    try {
      if (process.platform === 'win32') {
        assert.throws(() => fsyncSync(fd), /EPERM|operation not permitted/i,
          '这正是"先试可写、失败再退只读"的理由；哪天 Windows 允许了，这条会红并提示可以简化')
      } else {
        assert.doesNotThrow(() => fsyncSync(fd), 'POSIX 上只读句柄的 fsync 有效，所以回退分支不是死路')
      }
    } finally {
      closeSync(fd)
    }
  } finally {
    f.cleanup()
  }
})
