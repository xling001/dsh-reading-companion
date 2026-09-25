#!/usr/bin/env node
/**
 * 把 dsh-reading-companion 装进一个 DSH profile，或从其中卸载。
 *
 * 为什么不直接 `dsh plugin --profile desktop add`？
 *   那个命令只是把参数**转发给 pnpm**，它会写 `dependencies`，
 *   但**不会**把包名写进 `dsh.profile.bundles` —— 而 bundles 才是让宿主真正
 *   装配这个插件的开关。只 add 不写 bundles，结果是"装了但没生效"。
 *
 * 本脚本做的事（全部幂等，只碰自己那一个键，不触碰 profile 里其它包）：
 *   1. profile package.json 的 dependencies 里写入/移除 `file:` 依赖；
 *   2. dsh.profile.bundles 里加入/移除包名；
 *   3. 在 profile 的 node_modules 里建立/删除一个目录联接（junction），
 *      让宿主立刻能 resolve 到本地开发目录，**无需跑 pnpm install**。
 *
 * 之所以用 junction 而不是跑 `pnpm install`：profile 里挂着 20 个插件（含多个
 * GitHub 依赖），为装一个包触发全量重装既不必要，也有破坏别人环境的风险。
 * 目录联接是纯加法的，删掉即完全回滚。
 *
 * 用法：
 *   node scripts/link-into-profile.mjs --profile desktop
 *   node scripts/link-into-profile.mjs --profile desktop --unlink
 *   node scripts/link-into-profile.mjs --profile-dir "C:/Users/me/.dsh/profiles/desktop"
 *   node scripts/link-into-profile.mjs --profile desktop --dry-run
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录（scripts/ 的上一级）。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 包名。同时也是 bundles 里的条目名与 node_modules 里的目录名。 */
const PACKAGE_NAME = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).name

//#region 参数解析

/** 极简 argv 解析：只认长选项，够用且无依赖。 */
function parseArgs(argv) {
  const options = { profile: '', profileDir: '', unlink: false, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') options.profile = argv[++i] ?? ''
    else if (arg === '--profile-dir') options.profileDir = argv[++i] ?? ''
    else if (arg === '--unlink') options.unlink = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

const USAGE = `
用法: node scripts/link-into-profile.mjs [选项]

  --profile <name>       $DSH_HOME/profiles 下的 profile 名（本机默认值：desktop）
  --profile-dir <path>   直接指定 profile 目录（优先于 --profile）
  --unlink               卸载：移除依赖、bundles 条目与 node_modules 联接
  --dry-run              只打印将要做的改动，不写盘
  -h, --help             显示本帮助
`.trim()

//#endregion

//#region 路径

/** 解析 $DSH_HOME：环境变量优先，否则 ~/.dsh。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** 解析 profile 目录。 */
function resolveProfileDir(options) {
  if (options.profileDir !== '') return resolve(options.profileDir)
  const profile = options.profile !== '' ? options.profile : 'desktop'
  return join(resolveDshHome(), 'profiles', profile)
}

/**
 * 把绝对路径转成 npm 的 `file:` 说明符。
 * Windows 上必须用正斜杠，反斜杠会被 npm 当作转义。
 */
function toFileSpec(absolutePath) {
  return `file:${absolutePath.replace(/\\/g, '/')}`
}

//#endregion

//#region package.json 改写

/**
 * 原子写 JSON：先写临时文件再 rename，避免中途失败留下半个文件。
 * 保留末尾换行与 2 空格缩进，尽量减少与用户手写格式的差异。
 */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * 就地把包名加入/移出 dsh.profile.bundles。
 * 只动我们自己那一个条目，其它条目原样保留且顺序不变。
 */
function toggleBundle(manifest, shouldAdd) {
  // 没有 dsh.profile 结构时按需创建，避免整块丢失。
  if (manifest.dsh === undefined) manifest.dsh = {}
  if (manifest.dsh.profile === undefined) manifest.dsh.profile = {}
  const profile = manifest.dsh.profile
  if (!Array.isArray(profile.bundles)) profile.bundles = []

  const at = profile.bundles.indexOf(PACKAGE_NAME)
  const present = at !== -1

  if (shouldAdd && !present) {
    profile.bundles.push(PACKAGE_NAME)
    return { changed: true, detail: `bundles += ${PACKAGE_NAME}` }
  }
  if (!shouldAdd && present) {
    profile.bundles.splice(at, 1)
    return { changed: true, detail: `bundles -= ${PACKAGE_NAME}` }
  }
  return { changed: false, detail: `bundles 已${shouldAdd ? '包含' : '不含'} ${PACKAGE_NAME}` }
}

/** 就地把 file: 依赖加入/移出 dependencies。 */
function toggleDependency(manifest, shouldAdd, fileSpec) {
  if (manifest.dependencies === undefined) manifest.dependencies = {}
  const deps = manifest.dependencies
  const current = deps[PACKAGE_NAME]

  if (shouldAdd) {
    if (current === fileSpec) return { changed: false, detail: `dependencies 已是 ${fileSpec}` }
    deps[PACKAGE_NAME] = fileSpec
    return { changed: true, detail: `dependencies[${PACKAGE_NAME}] = ${fileSpec}` }
  }
  if (current === undefined) return { changed: false, detail: `dependencies 不含 ${PACKAGE_NAME}` }
  delete deps[PACKAGE_NAME]
  return { changed: true, detail: `dependencies -= ${PACKAGE_NAME}` }
}

//#endregion

//#region node_modules 联接

/**
 * 建立/删除 profile node_modules 里的目录联接。
 *
 * Windows 上用 'junction'：它不需要管理员权限或开发者模式（符号链接需要），
 * 且对 Node 的解析器完全透明。
 */
function toggleLink(linkPath, shouldAdd, { dryRun }) {
  const exists = existsSync(linkPath) || isLooseLink(linkPath)

  if (shouldAdd) {
    if (exists) {
      // 已存在就必须先确认它指向我们，避免覆盖用户自己的安装。
      const target = readLinkTarget(linkPath)
      if (target !== null && samePath(target, PACKAGE_ROOT)) {
        return { changed: false, detail: `联接已存在 → ${PACKAGE_ROOT}` }
      }
      return {
        changed: false,
        detail: `已存在且未改动（指向 ${target ?? '未知'}）— 如需替换请先 --unlink 或手工删除`,
        blocked: true,
      }
    }
    if (!dryRun) {
      mkdirSync(dirname(linkPath), { recursive: true })
      symlinkSync(PACKAGE_ROOT, linkPath, 'junction')
    }
    return { changed: true, detail: `联接 ${linkPath} → ${PACKAGE_ROOT}` }
  }

  if (!exists) return { changed: false, detail: '联接不存在' }
  const target = readLinkTarget(linkPath)
  if (target !== null && !samePath(target, PACKAGE_ROOT)) {
    return { changed: false, detail: `联接指向别处（${target}），拒绝删除`, blocked: true }
  }
  if (!dryRun) {
    // junction 在 Windows 上表现为目录，rmSync 的 recursive 能删掉它而不动目标。
    try {
      unlinkSync(linkPath)
    } catch {
      rmSync(linkPath, { recursive: true, force: true })
    }
  }
  return { changed: true, detail: `移除联接 ${linkPath}` }
}

/** 联接是否"看起来存在"（包括悬空的），lstat 不跟随链接。 */
function isLooseLink(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** 读取联接目标；不是链接时返回 null。 */
function readLinkTarget(path) {
  try {
    const stat = lstatSync(path)
    if (!stat.isSymbolicLink()) return null
    // Windows 的 junction 常带 \\?\ 长路径前缀，去掉后才能和普通路径比较。
    return readlinkSync(path).replace(/^\\\\\?\\/, '')
  } catch {
    return null
  }
}

/** 路径同一性判断：Windows 大小写不敏感，且要先把分隔符与 .. 归一。 */
function samePath(a, b) {
  if (typeof a !== 'string' || a === '') return false
  const norm = (value) => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return norm(a) === norm(b)
}

//#endregion

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const profileDir = resolveProfileDir(options)
  const manifestPath = join(profileDir, 'package.json')

  if (!existsSync(manifestPath)) {
    console.error(`✗ 找不到 profile：${manifestPath}`)
    console.error('  用 --profile <name> 或 --profile-dir <path> 指定。')
    return 1
  }

  const shouldAdd = !options.unlink
  const fileSpec = toFileSpec(PACKAGE_ROOT)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  const changes = [
    toggleDependency(manifest, shouldAdd, fileSpec),
    toggleBundle(manifest, shouldAdd),
  ]

  const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
  const linkChange = toggleLink(linkPath, shouldAdd, { dryRun: options.dryRun })
  changes.push(linkChange)

  const blocked = changes.filter((entry) => entry.blocked === true)

  console.log(`${options.unlink ? '卸载' : '安装'} ${PACKAGE_NAME}`)
  console.log(`  profile : ${profileDir}`)
  console.log(`  包目录  : ${PACKAGE_ROOT}`)
  console.log(`  模式    : ${options.dryRun ? 'dry-run（不写盘）' : '写入'}`)
  console.log('')
  for (const entry of changes) {
    console.log(`  ${entry.blocked ? '!' : entry.changed ? '+' : '='} ${entry.detail}`)
  }

  if (blocked.length > 0) {
    console.error('\n✗ 有项目被拒绝改动，未写入 package.json。请先处理上面的 ! 行。')
    return 1
  }

  const manifestChanged = changes[0].changed || changes[1].changed
  if (manifestChanged && !options.dryRun) {
    writeJsonAtomic(manifestPath, manifest)
    console.log(`\n✓ 已更新 ${manifestPath}`)
  } else if (!manifestChanged) {
    console.log('\n= package.json 无需改动')
  }

  console.log(
    options.unlink
      ? '\n✓ 卸载完成。书库与笔记数据未被删除，仍在 $DSH_HOME/' + PACKAGE_NAME + ' 下。'
      : '\n✓ 安装完成。刷新 DSH 页面后，在会话右侧栏点「+」应能看到「陪读」页签。',
  )
  return 0
}

process.exitCode = main()
