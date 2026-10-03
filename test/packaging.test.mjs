/**
 * 发布清单（`package.json` 的 `files`）：**被引用的本地资源必须随包发布**。
 *
 * ## 为什么值得一条守卫（2026-10-04）
 *
 * `files` 是**发布白名单**，而 README / 设计文档是**随包发布**的。两者一旦分叉，
 * 后果不是报错而是**静默**：安装副本里 README 的截图裂开、链接 404，而仓库里
 * 一切正常（GitHub 上全都在）—— 所以本地跑测试、看仓库，永远发现不了。
 *
 * 已经踩过一次的形状：README 引用了 `docs/images/` 下三张截图（约 731 KB）与
 * `docs/manual-testing.md`，而 `docs/design.md`（在白名单里）引用了
 * `docs/design-history.md` / `docs/design-v1-archive.md` —— 四样都不在 `files` 里。
 *
 * ## 判据
 *
 * 取 README 与 `docs/design.md` 里**指向本仓库**的引用（相对路径的图片与链接），
 * 逐个问"它被 `files` 里的某一条覆盖了吗"。覆盖规则与 npm 一致：**目录条目按前缀**，
 * 文件条目按全等；`*` 通配交给 npm，这里只按字面比较（本仓库的 `files` 没有通配符）。
 *
 * ⚠️ 刻意**不**去校验 GitHub 绝对 URL 与锚点（那不是本地资源）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 读 `files` 白名单（顺带把 `package.json` 自己算进去，npm 一定会带上它）。 */
function publishedEntries() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json 必须有非空的 files 白名单')
  return [...pkg.files, 'package.json']
}

/** 某条相对路径是否被白名单覆盖（目录按前缀、文件按全等）。 */
function covered(rel, entries) {
  const norm = rel.replace(/\\/g, '/')
  return entries.some((entry) => norm === entry || norm.startsWith(`${entry}/`))
}

/**
 * 从一份 markdown 里抽出**指向本仓库**的引用。
 *
 * @param {string} markdown 文件内容
 * @param {string} fileDir 该文件所在目录（相对仓库根，例如 `docs`）
 * @returns {string[]} 相对仓库根的路径（去重、保序）
 */
function localRefs(markdown, fileDir) {
  const raw = [
    ...[...markdown.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]),
    ...[...markdown.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]),
  ]
  const out = []
  for (const ref of raw) {
    if (/^https?:|^#|^mailto:|^data:/.test(ref)) continue
    const bare = ref.split('#')[0]
    if (bare === '') continue
    const rel = normalize(join(fileDir, bare)).replace(/\\/g, '/')
    if (!out.includes(rel)) out.push(rel)
  }
  return out
}

test('发布清单：README 引用的本地资源必须都在 `files` 里', () => {
  const entries = publishedEntries()
  const refs = localRefs(readFileSync(join(ROOT, 'README.md'), 'utf8'), '')

  assert.ok(refs.length > 0, 'README 至少该引用点什么（否则这条守卫是空转的）')

  const missing = refs.filter((rel) => !covered(rel, entries))
  assert.deepEqual(
    missing,
    [],
    '这些资源被 README 引用却没进 `files` ⇒ 安装副本里截图裂开 / 链接 404，'
    + '而仓库里一切正常（GitHub 上全都在），所以只有这条守卫看得见',
  )
})

test('发布清单：随包发布的 docs/design.md 引用的本地资源也必须都在 `files` 里', () => {
  const entries = publishedEntries()
  assert.ok(covered('docs/design.md', entries), '前提：design.md 是随包发布的（否则这条不用管）')
  const refs = localRefs(readFileSync(join(ROOT, 'docs', 'design.md'), 'utf8'), 'docs')

  const missing = refs.filter((rel) => !covered(rel, entries))
  assert.deepEqual(missing, [], 'design.md 里指向仓库内的链接，在安装副本里会 404')
})

test('发布清单：白名单里的每一条都真的存在（别写一个拼错的目录进去）', () => {
  // ⚠️ 反向：`files` 里写一个不存在的路径，npm **不报错**、只是少装东西 ——
  //    与上面两条同一个"静默"家族。这里让拼错当场红。
  const entries = publishedEntries()
  const absent = entries.filter((entry) => !existsSync(join(ROOT, entry)))
  assert.deepEqual(absent, [], 'files 里写了不存在的路径（npm 会静默忽略它）')
})
