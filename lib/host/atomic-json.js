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
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 损坏文件被挪走时的名字后缀（**唯一**一份口径：挪走、找回来都认它）。 */
const CORRUPT_MARK = '.corrupt-'

/**
 * 把刚写的文件**刷到盘上**（best-effort）。
 *
 * `rename` 是原子的，但那说的是"文件名切换"；文件**内容**可能还在页缓存里。
 * 断电时元数据先落盘、数据没落 ⇒ 读者得到的是"名字在、内容是空的"这种损坏
 * （2026-10-02 三方评审 P2-2 判定的最可能来源）。
 *
 * ⚠️ 刻意 best-effort：某些网络盘 / 容器文件系统不支持 `fsync`，报错**不该**让一次
 *    正常的写盘失败 —— 那会把"防损坏"变成"写不进去"。
 * ⚠️ 目录也刷一次（让 `rename` 本身持久）；Windows 上目录的 fsync 同样失败，一并吞掉。
 *
 * ⚠️⚠️ **打开方式必须优先可写**（2026-10-04 实测修正）。Windows 的 `FlushFileBuffers`
 *    要求句柄带**写权限**，用 `'r'` 打开时 `fsyncSync` 直接抛 `EPERM` —— 于是这道刷盘
 *    在 Windows 上**一次都没成功过**，而它正是"内容先落盘再 rename"的**全部**依据。
 *    文件与目录一样（实测目录用 `'r'` 也是 EPERM；旧注释写的"Windows 上打不开目录
 *    句柄"是**错的**：打得开，失败的是 fsync 本身）。
 *    回退到 `'r'` 是给 POSIX 的目录留的路 —— 那里目录**不能**以写方式打开（EISDIR），
 *    而只读句柄上的 `fsync` 在 Linux 上有效。所以是"先试可写、失败再退只读"，
 *    不是二选一。
 *
 * @param {string} path 文件或目录
 * @returns {number} 文件描述符（调用方负责 close）
 */
export function openForFsync(path) {
  // 见上面第三段 ⚠️⚠️：可写句柄是 Windows 上唯一能让 fsync 真正生效的打开方式。
  try {
    return openSync(path, 'r+')
  } catch {
    // POSIX 的目录只能只读打开（写方式会 EISDIR），而那边只读句柄上的 fsync 有效。
    return openSync(path, 'r')
  }
}

/**
 * 把刚写的文件**刷到盘上**（best-effort）。
 *
 * @param {string} path 文件或目录
 */
function fsyncQuietly(path) {
  let fd
  try {
    fd = openForFsync(path)
    fsyncSync(fd)
  } catch {
    /* 不支持就算了：见上面的第二段 ⚠️ */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 同上 */
      }
    }
  }
}


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
    // ⚠️ 内容先落盘再 rename（2026-10-02 三方评审 P2-2 的顺手项）：不刷的话断电可能
    //    只留下"文件名换过去了、内容是空的"。
    fsyncQuietly(tmp)
    renameSync(tmp, path)
    // 目录项也刷一次：否则 rename 本身在断电后可能没生效（Windows 上打不开目录 ⇒ 吞掉）。
    fsyncQuietly(dirname(path))
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
 * 所有**持久化 JSON 状态文件**共用的 schema 版本号。
 *
 * ⚠️ 从前这个 `1` 在 `library.js`（`SCHEMA_VERSION`）与 `notes.js`
 * （`DRAFTS_SCHEMA_VERSION`）里各写一份 —— 又是"同值多处"。数字本身不重要，
 * 重要的是**只有一处**：`updateJson` 拿它当"我认识到第几版"的基准，
 * 而拒写判据（见下）一旦与某个文件的声明分叉，就会变成"有的文件保护、有的不保护"。
 *
 * 它只管 **JSON**。`notes.md` / `background.md` 是 markdown 制品，各有自己的
 * `NOTES_SCHEMA_VERSION` / `BACKGROUND_SCHEMA_VERSION`（同一套判据、不同的载体）。
 */
export const JSON_SCHEMA_VERSION = 1

/**
 * 读一个 JSON 文件，缺失或损坏时回落到默认值。
 *
 * 损坏时**不抛错**：一个坏掉的 library.json 不应该让整个插件挂不上，
 * 那会让用户连导入入口都打不开。调用方拿 `recovered` 决定要不要提示。
 *
 * ## ⚠️ 「读不到」不等于「不存在」（2026-10-03，外部评审 #1）
 *
 * 从前这里是个**裸 catch**：`ENOENT`（真的没有）、`EACCES`（没有权限）、
 * `EIO`（盘出错）、被杀毒软件/同步盘临时锁住 —— **全都**返回"文件不存在"的形状，
 * 而且 `recovered: false` ⇒ 调用方连"出事了"都不知道。
 *
 * 后果很具体：调用方以为"这文件还没建"，于是 `expectedRevision` 传 `null`，
 * 而读失败时 `revision` **也是** `null` ⇒ CAS 判"相等"放行 ⇒ **把一份读不到的好数据
 * 覆盖成空骨架**。（传真实 revision 的路径是安全的：`null ≠ 真值` 会抛
 * `REVISION_CONFLICT`。危险只在那一种组合上。）
 *
 * ⇒ 只有 **`ENOENT` 是 definitive 的"不存在"**；其余一律标 `unreadable: true`，
 * 由写路径拒写（见 `updateJson` 的 `STORAGE_UNREADABLE`）。
 * 这里**不抛错**：读不动也得让插件挂上，拒写是写路径的事。
 *
 * @param {string} path 绝对路径
 * @param {unknown} fallback 缺失/损坏时的返回值
 * @returns {{ value: unknown, revision: string|null, recovered: boolean, unreadable: boolean }}
 */
export function readJson(path, fallback) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { value: fallback, revision: null, recovered: false, unreadable: true }
    }
    return { value: fallback, revision: null, recovered: false, unreadable: false }
  }
  try {
    return { value: JSON.parse(text), revision: revisionOf(text), recovered: false, unreadable: false }
  } catch {
    return { value: fallback, revision: null, recovered: true, unreadable: false }
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
  // ⚠️ **「读不到」比「损坏」更危险，所以先拦它。** 损坏 = 盘上那份是垃圾，写回去
  //    顶多是把垃圾换成空骨架（而且 `recovered: true` 会让调用方知道出事了）；
  //    读不到 = 盘上那份**可能是完好的**，只是这会儿读不出来（权限、I/O、被杀毒
  //    软件或同步盘占着）⇒ 写回去就是**把一份好数据换成空骨架，而且全程静默**。
  //
  //    与下面那条不同，这里**不**要求调用方声明 CAS：损坏的临时存储"读回空集、
  //    下次写重建"是合理的契约（没有东西可丢），而读不到时**有东西可丢**。
  //    写失败会让读者看到一次报错——那比无声地吃掉他的书架/绑定/分类/草稿好。
  if (current.unreadable === true) {
    const error = new Error('STORAGE_UNREADABLE')
    error.code = 'STORAGE_UNREADABLE'
    error.path = path
    throw error
  }
  // ⚠️ **未来版本写下的格式，绝不覆盖**（2026-10-03，外部评审 #2）。
  //
  //    从前这条保护只有 `notes.md` / `background.md` / 草稿有，而**书架、绑定、
  //    分类、设置一个都没有**：`readLibrary` 只查 `books` 是不是数组，`writeLibrary`
  //    则把对象**从零重建**成 `{ schemaVersion: 1, books }` ⇒ 更新版本写下的
  //    `schemaVersion: 2` 连同它的新字段会被**降级抹掉**，而且没有提示。
  //
  //    放在这里而不是每类文件各判一次：这是**同一件事**（"盘上的比我认识到的新"），
  //    四个文件四份判据就迟早会分叉。载体不同（markdown 制品）的那几处仍各判各的，
  //    但用的是同一个判据形状。
  const declared = current.value?.schemaVersion
  if (Number.isInteger(declared) && declared > JSON_SCHEMA_VERSION) {
    const error = new Error('JSON_SCHEMA_UNSUPPORTED')
    error.code = 'JSON_SCHEMA_UNSUPPORTED'
    error.path = path
    error.declared = declared
    error.supported = JSON_SCHEMA_VERSION
    throw error
  }
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
  const target = `${path}${CORRUPT_MARK}${stamp}`
  try {
    renameSync(path, target)
    return target
  } catch {
    return undefined
  }
}

/**
 * 列出该目录下所有「被挪到一边的坏文件」：`<原名>.corrupt-<时间戳>`。
 *
 * ## 为什么要有它（2026-10-02 三方评审 P2-2）
 *
 * `mutateJson` 把 `quarantinedTo` 返回出来已经很久了，全树却**零消费者** ——
 * 绑定 / 分类 / 设置三份文件损坏时，读者侧**零提示**（只有书架索引 `library.json`
 * 那条路会说），于是"我的阅读进度怎么全变成没读过了"没有任何解释。
 *
 * ⚠️ 刻意**读磁盘**，不靠"内存里那次写入留下的残影"：损坏多半发生在断电那一刻，
 *    而重启之后那份坏文件还躺在盘上 —— 只有读盘才能做到"重启后照样说得出事"
 *    （这也是读者侧那条提示能**常驻**的原因）。
 *
 * ⚠️ 找不到目录（还没建过）⇒ 空数组，不是错误：正常的新装用户就是这个状态。
 *
 * @param {string} dir 目录（宿主的状态目录）
 * @returns {Array<{ file: string, base: string, path: string, mtime: string|null }>} 按文件名字典序
 */
export function listQuarantined(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found = []
  for (const name of names) {
    const markAt = name.indexOf(CORRUPT_MARK)
    // `markAt <= 0` 也排除"名字开头就是 .corrupt-"这种怪东西（认不出原名 ⇒ 不报）。
    if (markAt <= 0) continue
    const full = join(dir, name)
    let mtime = null
    try {
      mtime = statSync(full).mtime.toISOString()
    } catch {
      mtime = null // 刚好被删掉 / 权限问题：照样报出来，只是没有时间
    }
    found.push({ file: name, base: name.slice(0, markAt), path: full, mtime })
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}
