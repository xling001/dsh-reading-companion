/**
 * 原子 JSON 落盘 + 乐观并发（CAS）。
 *
 * 为什么不用 `ctx.storage`：那是官方存储服务的领地，第三方插件往里头塞
 * 自己的 schema 会污染它的命名空间（tavern 也是刻意避开、自建目录的）。
 * 书库是纯本地的用户资产，用一个可读、可迁移、可被别的工具消费的 JSON
 * 反而更合适。
 *
 * 为什么需要 CAS：同一个书库可能被两个浏览器标签页同时打开。没有
 * `revision` 校验的读-改-写会静默吞掉另一边的写入（丢进度、丢笔记）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 计算内容的 revision。
 *
 * @param {string} text 文件文本
 * @returns {string} `sha256:<hex>`
 */
export function revisionOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * 原子写一个 JSON 文件。
 *
 * 先写同目录的临时文件再 `rename`：`rename` 在同一卷上是原子的，
 * 因此读者永远看不到「写了一半」的 JSON。临时文件名带 pid 与随机数，
 * 避免两个进程/标签页撞名。
 *
 * @param {string} path 目标绝对路径
 * @param {unknown} value 可 JSON 序列化的值
 * @param {{ pretty?: boolean }} [options] pretty 默认 true（人要读这些文件）
 * @returns {{ revision: string, text: string }}
 */
export function atomicWriteJson(path, value, options = {}) {
  const { pretty = true } = options
  const text = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value)
  atomicWriteText(path, text)
  return { revision: revisionOf(text), text }
}

/**
 * 原子写一个文本文件。
 *
 * @param {string} path 目标绝对路径
 * @param {string} text 文本内容
 */
export function atomicWriteText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不应掩盖原始错误 */
    }
    throw error
  }
  // 顺手扫掉**明显过期**的兄弟临时文件（见 sweepStaleTemps 的说明）。放在成功后、
  // best-effort：清不掉不算错误。
  sweepStaleTemps(path)
}

/** 超过这个年龄的 `*.tmp` 才认为是残骸（不是别人正在写的那一份）。 */
const STALE_TEMP_MS = 60 * 60 * 1000

/**
 * 清掉同目录下**明显过期**的临时文件残骸。
 *
 * 为什么会有残骸：写盘是"先写 `<name>.<pid>.<rand>.tmp` 再 rename"。进程被强杀
 * （崩溃、任务管理器结束、断电）时，那个 tmp 就永远留在盘上 —— `catch` 只清理
 * 本次调用自己那一份。它们不影响正确性（没人会读 `*.tmp`），但会越积越多，
 * 而且看着像"写盘写坏了"（2026-10-01 三方评审 P3）。
 *
 * ⚠️ 两条克制：
 *   1. 只扫**同一个目标文件**的兄弟（前缀 = `<basename>.`），不乱删别人的文件；
 *   2. 只删**超过一小时**的 —— 另一个进程此刻正在写的那一份就在旁边，
 *      按"看见就删"会毁掉别人这次写入。
 *
 * @param {string} path 刚写完的目标文件路径
 */
function sweepStaleTemps(path) {
  const dir = dirname(path)
  const prefix = `${basename(path)}.`
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    const full = join(dir, name)
    try {
      if (now - statSync(full).mtimeMs < STALE_TEMP_MS) continue
      rmSync(full, { force: true })
    } catch {
      /* 卫生问题，不是正确性问题：清不掉就算了。 */
    }
  }
}

/**
 * 读一个 JSON 文件，缺失或损坏时回落到默认值。
 *
 * 损坏时**不抛错**：一个坏掉的 library.json 不应该让整个插件挂不上，
 * 那会让用户连导入入口都打不开。调用方拿 `recovered` 决定要不要提示。
 *
 * @param {string} path 绝对路径
 * @param {unknown} fallback 缺失/损坏时的返回值
 * @returns {{ value: unknown, revision: string|null, recovered: boolean }}
 */
export function readJson(path, fallback) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { value: fallback, revision: null, recovered: false }
  }
  try {
    return { value: JSON.parse(text), revision: revisionOf(text), recovered: false }
  } catch {
    return { value: fallback, revision: null, recovered: true }
  }
}

/**
 * 带 CAS 的读-改-写。
 *
 * `mutate` 拿到当前值，返回新值；若 `expectedRevision` 与磁盘上的实际
 * revision 不一致则抛 `REVISION_CONFLICT`，由调用方决定重试或报错。
 *
 * ⚠️ 文件**损坏**、且调用方声明了 CAS（`expectedRevision !== undefined`）时，
 * 一律抛 `STORAGE_CORRUPT`（除非显式传 `allowCorrupt: true`）：见函数体里的说明——
 * 读-改-写会拿 `fallback` 覆盖掉整份数据，而 CAS 判不出来。**没声明 CAS 的路径
 * 不受影响**（草稿那类可重建的临时存储继续"读回空集、下次写重建"）。
 *
 * @param {string} path 绝对路径
 * @param {object} options
 * @param {unknown} options.fallback 文件缺失时的初始值
 * @param {(current: unknown, meta: { revision: string|null, recovered: boolean }) => unknown} options.mutate
 * @param {string|null} [options.expectedRevision] 调用方上次读到的 revision；null 表示要求文件不存在
 * @param {boolean} [options.allowCorrupt] 明知文件损坏也要写下去（**危险**，默认不允许）
 * @returns {{ value: unknown, revision: string }}
 */
export function updateJson(path, options) {
  const { fallback, mutate, expectedRevision } = options
  const current = readJson(path, fallback)
  // ⚠️ **损坏的文件不能拿来做带 CAS 的读-改-写。** 调用方从 `readJson` 拿到的是
  //    `fallback`（多半是空骨架），写回去等于把整份数据换成空骨架；而
  //    `expectedRevision` **挡不住它** —— 调用方读到的 revision 与磁盘上的 revision
  //    都是 `null`，CAS 判"相等"直接放行。2026-10-01 三方评审的 P1 就是这个形状：
  //    一个坏掉的 `library.json` 会被下一次导入覆写成"只剩那一本"（书的目录还在，
  //    索引没了，且没有重建入口）。
  //
  //    ⚠️ 只在**调用方声明了 CAS**（`expectedRevision !== undefined`）时拦：
  //    传 `expectedRevision` 就等于说"我是照着刚读到的那份内容写的"，而损坏时
  //    这份声明根本不成立。没传的那些路径（草稿这类**可重建**的临时存储）
  //    保持既有契约不变 —— 坏文件读回空集、下次写重建它，不让插件崩。
  //    要明知故犯地覆盖一个损坏文件，显式写 `allowCorrupt: true`。
  if (current.recovered === true && expectedRevision !== undefined && options.allowCorrupt !== true) {
    const error = new Error('STORAGE_CORRUPT')
    error.code = 'STORAGE_CORRUPT'
    error.path = path
    throw error
  }
  if (expectedRevision !== undefined) {
    if (expectedRevision !== current.revision) {
      const error = new Error('REVISION_CONFLICT')
      error.code = 'REVISION_CONFLICT'
      error.expected = expectedRevision
      error.actual = current.revision
      throw error
    }
  }
  const next = mutate(current.value, { revision: current.revision, recovered: current.recovered })
  const written = atomicWriteJson(path, next)
  return { value: next, revision: written.revision }
}

/**
 * 带**冲突重试**的读-改-写 —— 要改一份共享 JSON 时用这个，别手写 `updateJson`。
 *
 * ## 为什么需要它（2026-10-01 三方评审）
 *
 * `mutateBindings` / `mutateCategories` / `writeSettings` 三处的注释一直写着
 * "以 CAS 方式改"，但**都没传 `expectedRevision`** —— 于是它们其实是
 * **最后写入者获胜**：两个标签页同时改，先写的那一份被静默吞掉（丢进度、
 * 丢绑定、丢分类）。而本文件开头恰恰写着"没有 `revision` 校验的读-改-写会静默
 * 吞掉另一边的写入"—— 注释说了实话，接线没跟上。
 *
 * 这里一次做对三件事：
 *   1. **先读、带 revision 写**（真正的 CAS）；
 *   2. 撞上 `REVISION_CONFLICT` 就**重读重试**（别人刚写过是常态，不是错误；
 *      调用方不该被迫自己写重试循环）；
 *   3. 文件**损坏**时先把它**挪到一边**（`.corrupt-<时间戳>`，不删），再当作
 *      "没有这份文件"重建。
 *
 * ⚠️ 第 3 条与 {@link updateJson} 的 `STORAGE_CORRUPT` 是**两种刻意不同的处置**：
 * 书架索引（`library.json`）走 `updateJson` + 显式 revision，损坏时**拒写** ——
 * 它是"书的清单"，重建它得扫描目录，不能被一个空骨架覆盖；
 * 而绑定 / 分类 / 设置是"随时可重建的派生状态"，挪开重建比让读者卡住更好，
 * 而且**一份都没丢**（坏的留在盘上，文件名带 `.corrupt-`）。
 *
 * @param {string} path 绝对路径
 * @param {object} options
 * @param {unknown} options.fallback 文件缺失（或损坏被挪走后）时的初始值
 * @param {(current: unknown, meta: { revision: string|null, recovered: boolean }) => unknown} options.mutate
 * @param {number} [options.attempts] 冲突重试上限（默认 3）
 * @returns {{ value: unknown, revision: string, quarantinedTo?: string }}
 */
export function mutateJson(path, options) {
  const { fallback, mutate, attempts = 3 } = options
  let conflict = null
  let quarantinedTo

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let current = readJson(path, fallback)
    if (current.recovered === true) {
      quarantinedTo = quarantineCorrupt(path)
      // 挪走之后再读一次：成功的话它现在是"缺失"，revision 为 null；
      // 挪不动（被别的程序占着）就还是损坏 —— 那时 `updateJson` 会拒写，也是安全方向。
      current = readJson(path, fallback)
    }
    try {
      const result = updateJson(path, {
        fallback,
        expectedRevision: current.revision,
        // 用**我们这次**读到的值算新状态：`expectedRevision` 已经保证中间没人改过。
        mutate: () => mutate(current.value, { revision: current.revision, recovered: current.recovered }),
      })
      return quarantinedTo === undefined ? result : { ...result, quarantinedTo }
    } catch (error) {
      if (error?.code !== 'REVISION_CONFLICT') throw error
      // 有人在我们读和写之间改了它（另一个标签页）。重读再来一次。
      conflict = error
    }
  }
  throw conflict
}

/**
 * 把损坏的文件挪到一边（**不删**）：`<原名>.corrupt-<ISO 时间戳>`。
 *
 * 挪不动（Windows 上被别的程序占着）就回 undefined，让调用方走"拒写"那条路。
 *
 * @param {string} path 原路径
 * @returns {string|undefined} 挪到哪儿了
 */
function quarantineCorrupt(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${path}.corrupt-${stamp}`
  try {
    renameSync(path, target)
    return target
  } catch {
    return undefined
  }
}
