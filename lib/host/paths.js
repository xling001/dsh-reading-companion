/**
 * 路径安全层。
 *
 * 全部落盘操作都必须经过这里，理由是 dsh-reader 的实测故障之一：
 * 它把客户端传来的 `path` 直接丢给 `readFile`，既无 containment 复检，
 * 也不限制越出书库根目录。本插件把这条规矩钉死在唯一的入口上。
 *
 * 参照 dsh-tavern `play/src/paths.js` 的做法（它已在本机跑通）：
 *   1. 相对路径必须是「干净的单段或多段」，禁绝对路径/盘符/UNC/`..`/NUL；
 *   2. 拼好之后用 `relative()` 复检真的落在根里；
 *   3. 对已存在的路径再 `realpath` 复检一次，防 symlink/junction 逃逸。
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 单段相对路径的长度上限（对齐 tavern 的 512）。 */
export const MAX_SEGMENT_LENGTH = 512

/** 文件夹名长度上限。Windows 单段上限 255，留足「陪读_」前缀与消歧后缀的余量。 */
export const MAX_FOLDER_NAME_LENGTH = 60

/** Windows 文件名里非法或有特殊含义的字符。控制字符一并清掉。 */
// eslint-disable-next-line no-control-regex
const WINDOWS_ILLEGAL_RE = /[<>:"/\\|?*\u0000-\u001f]/g

/** Windows 的保留设备名，做目录名会出各种诡异问题。 */
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * 把一个书名变成安全的**文件夹名片段**。
 *
 * 这一步是新的攻击面：以前所有路径都由 `bookId`（我们自己生成的十六进制）
 * 拼成，天然安全；现在文件夹名来自**书名**，而书名来自用户导入的文件名，
 * 完全可以叫 `../../evil` 或 `C:foo`。所以清洗必须在这里做死，而不是
 * 指望调用方记得。
 *
 * @param {unknown} raw 原始名称
 * @param {string} [fallback] 清洗后为空时的兜底
 * @returns {string} 安全的文件夹名片段
 */
export function sanitizeFolderName(raw, fallback = '未命名') {
  let name = typeof raw === 'string' ? raw : ''
  name = name.replace(WINDOWS_ILLEGAL_RE, '_')
  name = name.replace(/\s+/g, ' ').trim()
  // Windows 不允许以点或空格结尾（`foo.` / `foo ` 会静默创建失败）。
  name = name.replace(/[. ]+$/, '')
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    name = name.slice(0, MAX_FOLDER_NAME_LENGTH).replace(/[. ]+$/, '')
  }
  if (WINDOWS_RESERVED_RE.test(name)) name = `_${name}`
  return name === '' ? fallback : name
}

/**
 * 校验一个**外部**的绝对目录（会话工作区）。
 *
 * 与 {@link inspectImportSource} 同一套威胁模型（本机单用户 + 已认证渲染器），
 * 所以不禁止任意绝对路径——用户就是想让笔记落在自己的工作区里。但仍然拒绝：
 *   - 相对路径 / 含 NUL；
 *   - **盘根**（`C:\`、`\\server\share`）：往盘根丢一个「陪读_x」目录是很坏的习惯；
 *   - 不存在、或存在但不是目录。
 *
 * 刻意**不**在这里做 mkdir：路径不存在时应当让调用方回落到插件目录，
 * 而不是顺手造一个可能是拼错路径的空目录。
 *
 * @param {unknown} absPath 候选目录
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function inspectWorkspaceDir(absPath) {
  if (typeof absPath !== 'string' || absPath.trim() === '' || absPath.includes('\0')) {
    return { ok: false, reason: 'PATH_INVALID' }
  }
  if (!isAbsolute(absPath)) return { ok: false, reason: 'PATH_NOT_ABSOLUTE' }

  const resolved = resolve(absPath)
  // dirname 等于自身 ⟺ 这是根（盘根或 UNC 共享根）。
  if (resolved === resolve(dirname(resolved))) return { ok: false, reason: 'PATH_IS_ROOT' }

  let stat
  try {
    stat = statSync(resolved)
  } catch {
    return { ok: false, reason: 'DIR_NOT_FOUND' }
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'NOT_A_DIRECTORY' }
  return { ok: true, path: resolved }
}

/** 路径里出现这些就是明确的攻击/误用信号。 */
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/
const UNC_RE = /^(?:\\\\|\/\/)/

/**
 * 把一个用户/客户端提供的「相对路径」拆成安全的分段。
 *
 * @param {string} value 原始相对路径，例如 'books/abc/content.txt'
 * @returns {string[]} 已校验的分段
 * @throws {Error} 含绝对路径、盘符、UNC、`..`、NUL 或超长时抛错
 */
export function splitRelativeSegments(value) {
  if (typeof value !== 'string') throw new Error('PATH_NOT_STRING')
  if (value.includes('\0')) throw new Error('PATH_HAS_NUL')
  if (value.length > MAX_SEGMENT_LENGTH) throw new Error('PATH_TOO_LONG')
  if (isAbsolute(value) || WINDOWS_DRIVE_RE.test(value) || UNC_RE.test(value)) {
    throw new Error(`PATH_NOT_RELATIVE: ${value}`)
  }
  const segments = value.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  for (const segment of segments) {
    if (segment === '..') throw new Error(`PATH_ESCAPES_ROOT: ${value}`)
  }
  return segments
}

/**
 * 把相对路径解析到根目录内，并做 containment 复检。
 *
 * @param {string} root 绝对根目录
 * @param {string} value 相对路径
 * @returns {string} 绝对路径
 */
export function resolveInsideRoot(root, value) {
  const segments = splitRelativeSegments(value)
  const base = resolve(root)
  const target = resolve(join(base, ...segments))
  assertInsideRoot(base, target)
  return target
}

/**
 * 断言 `target` 确实落在 `root` 之内。
 *
 * @param {string} root 绝对根目录（调用方保证已 resolve）
 * @param {string} target 绝对目标路径
 */
export function assertInsideRoot(root, target) {
  if (target === root) return
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`PATH_OUTSIDE_ROOT: ${target}`)
  }
  if (rel.split(sep).includes('..')) throw new Error(`PATH_OUTSIDE_ROOT: ${target}`)
}

/**
 * 对**已存在**的路径做真实路径复检，挡住 symlink/junction 逃逸。
 *
 * 只在路径存在时才有意义；不存在的路径交给调用方先创建。
 *
 * @param {string} root 绝对根目录
 * @param {string} target 绝对目标路径
 * @returns {string} realpath 后的路径
 */
export function assertRealPathInsideRoot(root, target) {
  if (!existsSync(target)) return target
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root)
  const realTarget = realpathSync(target)
  assertInsideRoot(realRoot, realTarget)
  return realTarget
}

/**
 * ## 这里**故意没有**"二进制文件过滤器"
 *
 * 试过两版都撤了，把结论留在这里，免得后人再走一遍：
 *
 *   1. **"开头有 NUL 就拒"** —— 当场把两条 UTF-16 导入用例打红。UTF-16 每个字符
 *      2 字节，ASCII 的高字节恒为 `0x00`，所以 UTF-16 **就是**满是 NUL 的文本；
 *      而 UTF-16 是本插件明确支持的编码（`encoding.js` 的探测链里有它）。
 *   2. **"按 NUL 的位置奇偶性区分"** —— 原理上就不成立。实测：
 *      `一`（U+4E00）的 UTF-16LE 字节是 `00 4E`，**低字节本身就是 `00`**，
 *      NUL 因此落在偶数位；而 ASCII 的 NUL 落在奇数位。同一份 UTF-16 文本里
 *      两种奇偶性都会出现，判据当场失效（实测 13 偶 / 10 奇）。
 *
 * 更根本的理由是**这跟本仓库自己的取舍相冲突**：能被正确解码的编码有
 * UTF-8 / UTF-16 / GB18030 三种，任何"看字节像不像文本"的判据都只能是压在它们
 * 之上的一层启发式，而启发式的每一次误判，代价都是**用户的书导不进来**。
 * 当初删掉"陪读会话一律禁工具"那条规则也是同一个理由：
 * 防越界面不该靠"让正常功能变残废"实现。
 *
 * 所以这一侧**只保留精确规则**：常规文件复检 + 真实路径复检 + 可选的导入根白名单。
 * 二进制文件会被 `encoding.js` 解码成乱码——那是用户自己能看出来的结果，
 * 不是静默的越界。
 */

/**
 * 判定一个导入源文件是否可接受。
 *
 * 威胁模型是「本机单用户 + 已认证渲染器」，所以**默认不禁止绝对路径**——
 * 用户就是要从磁盘任意位置导入书。三道限制，每一道都对应一个具体的坏结果：
 *
 *   1. 必须是**常规文件**（不是目录 / 设备 / 管道）；
 *   2. **真实路径**也必须是常规文件（挡 junction / 符号链接指向别处）；
 *   3. 不超过体积上限。
 *
 * ⚠️ **"能导入任意可读路径"是刻意保留的能力，不是遗漏。** 残余风险要说清：
 * 渲染器侧一旦被攻破，攻击者可以把本机任意可读文件（`id_rsa`、`.env` 这类）
 * 导进书库、再通过阅读接口读回来。插件侧没有鉴权，这条完全依赖宿主的渲染器
 * 令牌门（`decideDesktopBrowserAccess`），那不是插件能或应该绕过的东西。
 * 想收窄就用 `importRoots`：非空时只接受落在那些根目录内的路径。
 *
 * @param {string} absPath 用户给出的绝对路径
 * @param {object} [options]
 * @param {number} [options.maxBytes] 体积上限
 * @param {string[]} [options.importRoots] 非空时只接受这些根目录内的路径
 * @returns {{ ok: true, size: number } | { ok: false, reason: string }}
 */
export function inspectImportSource(absPath, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 64 * 1024 * 1024
  if (typeof absPath !== 'string' || absPath.includes('\0')) return { ok: false, reason: 'PATH_INVALID' }
  if (!isAbsolute(absPath)) return { ok: false, reason: 'PATH_NOT_ABSOLUTE' }
  let stat
  try {
    stat = statSync(absPath)
  } catch {
    return { ok: false, reason: 'FILE_NOT_FOUND' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'NOT_A_REGULAR_FILE' }
  if (stat.size === 0) return { ok: false, reason: 'FILE_EMPTY' }
  if (stat.size > maxBytes) return { ok: false, reason: 'FILE_TOO_LARGE' }

  // 真实路径复检：`statSync` 是跟着链接走的，所以这里要再确认落点本身也是常规文件。
  let real
  try {
    real = realpathSync(absPath)
  } catch {
    return { ok: false, reason: 'FILE_NOT_FOUND' }
  }
  try {
    if (!statSync(real).isFile()) return { ok: false, reason: 'NOT_A_REGULAR_FILE' }
  } catch {
    return { ok: false, reason: 'FILE_NOT_FOUND' }
  }

  const roots = Array.isArray(options.importRoots)
    ? options.importRoots.filter((root) => typeof root === 'string' && root.trim() !== '')
    : []
  if (roots.length > 0) {
    // ⚠️ 用**真实路径**判定：拿链接指向白名单里就能绕过的写法不算通过。
    const inside = roots.some((root) => {
      try {
        return isInsideRoot(realpathSync(root), real)
      } catch {
        return false
      }
    })
    if (!inside) return { ok: false, reason: 'PATH_OUTSIDE_IMPORT_ROOTS' }
  }

  return { ok: true, size: stat.size }
}

/**
 * `target` 是否落在 `root` 之内（含等于）。
 *
 * 用 `relative()` 判定而不是字符串前缀：`C:\Books2` 不能算在 `C:\Books` 之内，
 * 而字符串前缀会把它们判成包含关系。
 *
 * @param {string} root 已 realpath 的根
 * @param {string} target 已 realpath 的目标
 * @returns {boolean}
 */
function isInsideRoot(root, target) {
  const rel = relative(root, target)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}
