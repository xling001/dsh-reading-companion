/**
 * 笔记落点测试。
 *
 * 这一层引入了本插件**第一种「根之外」的路径**：以前所有路径都由 bookId
 * （我们自己生成的十六进制）拼成，天然安全；现在文件夹名来自**书名**、
 * 父目录来自**会话工作区**——两者都是外部输入。所以这里要钉死三件事：
 *
 *   1. **书名不能用来逃逸**（`../../evil`、`C:foo`、保留设备名、以点结尾）；
 *   2. **同一工作区里两本不同的书绝不共用文件夹**（用户明确担心的点）；
 *   3. **大文件永远不搬**——只有 notes.md / background.md 去工作区，
 *      content.txt 那十几 MB 留在插件目录。
 */

import { test } from 'node:test'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, parse } from 'node:path'

import { createLibrary } from '../lib/host/library.js'
import { inspectWorkspaceDir, sanitizeFolderName } from '../lib/host/paths.js'

const TMP_ROOT = join(tmpdir(), 'drc-location')

const PROSE = '他记得那天的雪落得很慢，像有人在半空里把时间掰开了一点点，然后一片一片地放下。天光从瓦缝里漏下来。'

let seq = 0

/**
 * 建一个隔离 fixture：一个「工作区」目录 + 一个书库 + 一本导入好的书。
 *
 * @param {{ title?: string, fileName?: string }} [options]
 * @returns {object}
 */
function makeFixture(options = {}) {
  seq += 1
  const root = join(TMP_ROOT, `loc-${process.pid}-${Date.now()}-${seq}`)
  const storageDir = join(root, 'storage')
  const workspaceDir = join(root, 'my-workspace')
  mkdirSync(join(storageDir, 'inbox'), { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })

  const sourcePath = join(root, options.fileName ?? 'novel.txt')
  writeFileSync(sourcePath, Buffer.from([
    '第一章 雪', PROSE, '',
    '第二章 夜', PROSE.replace(/雪/g, '风'), '',
  ].join('\n'), 'utf8'))

  const library = createLibrary({ storageDir, fallbackBlockChars: 1000 })
  library.ensureDirs()
  const { book } = library.importBook({ absPath: sourcePath, title: options.title ?? '夜行' })

  return { root, storageDir, workspaceDir, library, book, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

//#region 纯函数：文件夹名与外部目录

test('文件夹名：书名不能用来逃逸', () => {
  // 路径分隔符与盘符必须被替换掉，否则 join 之后能跑出工作区。
  assert.equal(sanitizeFolderName('../../evil'), '.._.._evil')
  assert.equal(sanitizeFolderName('a/b\\c'), 'a_b_c')
  assert.equal(sanitizeFolderName('C:foo'), 'C_foo')
  assert.ok(!sanitizeFolderName('..\\..\\x').includes('\\'))
  assert.ok(!sanitizeFolderName('a/b').includes('/'))
})

test('文件夹名：Windows 的坑一个不落', () => {
  // 以点或空格结尾的目录名在 Windows 上会静默创建失败。
  assert.equal(sanitizeFolderName('书名.'), '书名')
  assert.equal(sanitizeFolderName('书名   '), '书名')
  assert.equal(sanitizeFolderName('书名. . '), '书名')
  // 保留设备名做目录会出各种诡异问题。
  assert.equal(sanitizeFolderName('CON'), '_CON')
  assert.equal(sanitizeFolderName('nul'), '_nul')
  assert.equal(sanitizeFolderName('COM1'), '_COM1')
  // 但只是以保留字开头的正常名字不该被误伤。
  assert.equal(sanitizeFolderName('CONTEXT'), 'CONTEXT')
  assert.equal(sanitizeFolderName('console 日志'), 'console 日志')
  // 控制字符。
  assert.equal(sanitizeFolderName('书\u0000名'), '书_名')
})

test('文件夹名：空与超长的兜底', () => {
  assert.equal(sanitizeFolderName(''), '未命名')
  assert.equal(sanitizeFolderName('   '), '未命名')
  assert.equal(sanitizeFolderName('...'), '未命名')
  assert.equal(sanitizeFolderName(null), '未命名')
  assert.equal(sanitizeFolderName(undefined, '回退'), '回退')
  // 超长要截断，且截断后不能以点结尾。
  const long = sanitizeFolderName('长'.repeat(200))
  assert.ok(long.length <= 60, `实际 ${long.length}`)
  assert.ok(!long.endsWith('.'))
})

test('外部目录校验：相对路径、盘根、不存在、不是目录全部拒绝', () => {
  const root = parse(TMP_ROOT).root
  assert.equal(inspectWorkspaceDir('relative/path').reason, 'PATH_NOT_ABSOLUTE')
  assert.equal(inspectWorkspaceDir('').reason, 'PATH_INVALID')
  assert.equal(inspectWorkspaceDir(null).reason, 'PATH_INVALID')
  assert.equal(inspectWorkspaceDir('a\0b').reason, 'PATH_INVALID')
  // 盘根：往 C:\ 丢一个「陪读_x」是很坏的习惯。
  assert.equal(inspectWorkspaceDir(root).reason, 'PATH_IS_ROOT')
  assert.equal(inspectWorkspaceDir(join(root, 'definitely-not-here-xyz')).reason, 'DIR_NOT_FOUND')

  seq += 1
  const root2 = join(TMP_ROOT, `probe-${process.pid}-${Date.now()}-${seq}`)
  mkdirSync(root2, { recursive: true })
  try {
    writeFileSync(join(root2, 'a.txt'), 'x')
    assert.equal(inspectWorkspaceDir(join(root2, 'a.txt')).reason, 'NOT_A_DIRECTORY')
    const ok = inspectWorkspaceDir(root2)
    assert.equal(ok.ok, true)
    assert.equal(ok.path, root2)
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
})

//#endregion

//#region 落点：插件目录 → 工作区

test('落点：没绑定时落在插件目录，并说明原因', () => {
  const f = makeFixture()
  try {
    const location = f.library.location(f.book.bookId)
    assert.equal(location.scope, 'plugin')
    assert.equal(location.workspaceDir, null)
    assert.equal(location.fallbackReason, null, 'null 表示"宿主手里还没有工作区路径"')
    assert.ok(location.dir.includes(f.book.bookId), '应当落在 books/<bookId>/ 里')
  } finally {
    f.cleanup()
  }
})

test('落点：绑定会话时给出工作区，笔记就落到「陪读_书名」下面', () => {
  const f = makeFixture({ title: '夜行' })
  try {
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    const location = f.library.location(f.book.bookId)

    assert.equal(location.scope, 'workspace')
    assert.equal(location.folderName, '陪读_夜行')
    assert.equal(location.dir, join(f.workspaceDir, '陪读_夜行'))

    // 真的写进去了，而且 notes.md 就在那个文件夹里。
    f.library.writeNote(f.book.bookId, { excerpt: '摘抄', thought: '感想' })
    assert.ok(existsSync(join(location.dir, 'notes.md')), 'notes.md 必须在工作区文件夹里')
    assert.match(readFileSync(join(location.dir, 'notes.md'), 'utf8'), /摘抄/)

    // 认领标记与说明文件。
    assert.ok(existsSync(join(location.dir, '.dsh-reading-companion.json')))
    assert.ok(existsSync(join(location.dir, 'README.md')))
    const marker = JSON.parse(readFileSync(join(location.dir, '.dsh-reading-companion.json'), 'utf8'))
    assert.equal(marker.bookId, f.book.bookId)
  } finally {
    f.cleanup()
  }
})

test('落点：十几 MB 的正文绝不搬进用户工作区', () => {
  const f = makeFixture()
  try {
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    f.library.writeNote(f.book.bookId, { excerpt: 'x', thought: 'y' })
    const location = f.library.location(f.book.bookId)

    // 只有人可读的两份过去。
    assert.ok(existsSync(join(location.dir, 'notes.md')))
    // 大文件留在插件目录 —— 把用户的工作区当仓库使是冒犯。
    for (const name of ['content.txt', 'source.txt', 'chapters.json']) {
      assert.ok(!existsSync(join(location.dir, name)), `${name} 不该出现在工作区里`)
      assert.ok(existsSync(join(f.library.paths.bookDir(f.book.bookId), name)), `${name} 必须还在插件目录`)
    }
    // 而且工作区文件夹里只有预期的那几样，没有夹带任何大文件。
    const packed = readdirSync(location.dir).sort()
    assert.deepEqual(
      packed,
      ['.dsh-reading-companion.json', 'README.md', 'notes.md'],
      `工作区文件夹里出现了预期外的文件：${packed.join(', ')}`,
    )
  } finally {
    f.cleanup()
  }
})

test('落点：两本同名的书绝不共用文件夹（用户担心的那件事）', () => {
  const f = makeFixture({ title: '同名书' })
  try {
    // 第二本：不同文件、不同 bookId、**同名**。
    const second = join(f.root, 'another.txt')
    writeFileSync(second, Buffer.from(`第一章 雪\n${PROSE}\n`, 'utf8'))
    const { book: bookB } = f.library.importBook({ absPath: second, title: '同名书' })
    assert.notEqual(bookB.bookId, f.book.bookId, '两本书的 bookId 必须不同')

    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    f.library.bind(bookB.bookId, 'session-b', null, f.workspaceDir)
    f.library.writeNote(f.book.bookId, { excerpt: 'A 的摘抄', thought: 'A' })
    f.library.writeNote(bookB.bookId, { excerpt: 'B 的摘抄', thought: 'B' })

    const locA = f.library.location(f.book.bookId)
    const locB = f.library.location(bookB.bookId)

    assert.notEqual(locA.dir, locB.dir, '两本同名的书必须落在不同文件夹')
    assert.equal(locA.folderName, '陪读_同名书')
    assert.equal(locB.folderName, `陪读_同名书_${bookB.bookId.slice(0, 6)}`, '后来者应当被消歧')

    // 内容不能串。
    const notesA = readFileSync(join(locA.dir, 'notes.md'), 'utf8')
    const notesB = readFileSync(join(locB.dir, 'notes.md'), 'utf8')
    assert.ok(notesA.includes('A 的摘抄') && !notesA.includes('B 的摘抄'), 'A 的笔记串进了 B')
    assert.ok(notesB.includes('B 的摘抄') && !notesB.includes('A 的摘抄'), 'B 的笔记串进了 A')
  } finally {
    f.cleanup()
  }
})

test('落点：同一本书重复解析文件夹名是稳定的（不会每次都造一个新的）', () => {
  const f = makeFixture({ title: '稳定' })
  try {
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    const first = f.library.location(f.book.bookId).dir
    // 已经写过一次（标记落地）之后再解析，必须还是同一个。
    f.library.ensureCompanionDir(f.book.bookId)
    const second = f.library.location(f.book.bookId).dir
    assert.equal(first, second)
    assert.equal(f.library.location(f.book.bookId).folderName, '陪读_稳定')
  } finally {
    f.cleanup()
  }
})

//#endregion

//#region 迁移与手动指定

test('迁移：老位置的笔记被复制到工作区，且原文件保留', () => {
  const f = makeFixture({ title: '迁移本' })
  try {
    // 先在插件目录写一条（模拟"绑定之前已经读过、记过"）。
    f.library.writeNote(f.book.bookId, { excerpt: '绑定前写的', thought: '旧位置' })
    const legacyNotes = join(f.library.paths.bookDir(f.book.bookId), 'notes.md')
    assert.ok(existsSync(legacyNotes))
    const before = readFileSync(legacyNotes, 'utf8')

    // 绑定到工作区 → 触发迁移。
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    const location = f.library.ensureCompanionDir(f.book.bookId)
    assert.deepEqual(location.migrated, ['notes.md'], '应当报告迁移了 notes.md')

    const migrated = readFileSync(join(location.dir, 'notes.md'), 'utf8')
    assert.ok(migrated.includes('绑定前写的'), '老笔记必须跟过来')
    // 关键：原文件**保留**（复制而非移动），它是安全网。
    assert.ok(existsSync(legacyNotes), '老位置必须保留，不能搬走')
    assert.equal(readFileSync(legacyNotes, 'utf8'), before, '老文件内容不该被改动')
  } finally {
    f.cleanup()
  }
})

test('迁移：**历代备份**也要跟着走（新式名字从前一个都迁不走）', () => {
  // ⚠️ 2026-10-04 体检发现（已复现）：迁移循环手写的判据是 `/^background\.bak.*\.md$/`，
  //    它只认**遗留**的 `background.bak*`，而实际写出的名字是
  //    `background.compactbak.<时间戳>.md` / `background.cleanbak.<时间戳>.md`
  //    ⇒ **新式备份一个都迁不走**，与那段注释明写的意图正好相反：落点一变，历代快照
  //    就留在旧目录里，而 `listBackgroundBackups` 只扫新目录 ⇒ 面板与导出都看不到它们；
  //    `lastCompanionDir` 再被覆盖一次就**永久失去线索**（文件还在盘上，没人指向它）。
  //    证伪：把判据改回 `^background\.bak` ⇒ 本用例红。
  const f = makeFixture({ title: '备份迁移本' })
  try {
    const legacyDir = f.library.paths.bookDir(f.book.bookId)
    // 两种族都种一份：新式的（这次修的）+ 遗留的（本来就认得）。
    const fresh = 'background.compactbak.20260101-000000.md'
    const legacy = 'background.bak.20251231-235959.md'
    writeFileSync(join(legacyDir, fresh), '<!-- 压缩前的完整认识 -->\n', 'utf8')
    writeFileSync(join(legacyDir, legacy), '<!-- 遗留名的那一代 -->\n', 'utf8')

    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    const location = f.library.ensureCompanionDir(f.book.bookId)
    assert.ok(
      location.migrated.includes(fresh),
      `新式备份必须跟着走，实际迁移了 ${JSON.stringify(location.migrated)}`,
    )
    assert.ok(location.migrated.includes(legacy), '遗留名的那一代也要跟着走')
    assert.ok(existsSync(join(location.dir, fresh)), '新式备份要真的出现在新位置')
    // 与 notes.md 同一条规矩：**复制而非移动**，老位置保留。
    assert.ok(existsSync(join(legacyDir, fresh)), '老位置必须保留（它是安全网）')
  } finally {
    f.cleanup()
  }
})

test('迁移：目标已有笔记时不覆盖（用户在新位置写的更权威）', () => {
  const f = makeFixture({ title: '不覆盖' })
  try {
    f.library.writeNote(f.book.bookId, { excerpt: '老位置', thought: 'x' })
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    const dir = f.library.ensureCompanionDir(f.book.bookId).dir
    // 先把新位置写上内容。
    writeFileSync(join(dir, 'notes.md'), '# 新位置写的\n', 'utf8')

    const location = f.library.ensureCompanionDir(f.book.bookId)
    assert.deepEqual(location.migrated, [], '已有内容就不该再迁移')
    assert.match(readFileSync(join(dir, 'notes.md'), 'utf8'), /新位置写的/, '新位置的内容被覆盖了')
  } finally {
    f.cleanup()
  }
})

test('手动指定：非法路径显式报错，而不是静默忽略', () => {
  const f = makeFixture()
  try {
    // 与 bind 不同：用户是主动指定位置，静默忽略会让他以为设置成功了。
    assert.throws(() => f.library.setCompanionDir(f.book.bookId, 'relative/dir'), /WORKSPACE_DIR_INVALID/)
    assert.throws(() => f.library.setCompanionDir(f.book.bookId, join(f.root, 'nope-xyz')), /WORKSPACE_DIR_INVALID/)
    // 报错后落点不该被改动。
    assert.equal(f.library.location(f.book.bookId).scope, 'plugin')
  } finally {
    f.cleanup()
  }
})

test('手动指定：可以显式还原回插件目录', () => {
  const f = makeFixture()
  try {
    f.library.setCompanionDir(f.book.bookId, f.workspaceDir)
    assert.equal(f.library.location(f.book.bookId).scope, 'workspace')
    f.library.setCompanionDir(f.book.bookId, null)
    const location = f.library.location(f.book.bookId)
    assert.equal(location.scope, 'plugin')
    assert.equal(location.workspaceDir, null)
  } finally {
    f.cleanup()
  }
})

test('绑定：无效的工作区路径不该丢掉已经设好的好路径', () => {
  const f = makeFixture()
  try {
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    assert.equal(f.library.location(f.book.bookId).scope, 'workspace')
    // 再绑一次，这次给一个坏路径 —— 应当保留原来那个，而不是清空。
    f.library.bind(f.book.bookId, 'session-a', null, 'C:\\definitely\\not\\here')
    const location = f.library.location(f.book.bookId)
    assert.equal(location.scope, 'workspace', '好路径被一次坏输入冲掉了')
    assert.equal(location.workspaceDir, f.workspaceDir)
  } finally {
    f.cleanup()
  }
})

test('落点：工作区目录被删掉之后，笔记要能自愈（重建文件夹）', () => {
  const f = makeFixture()
  try {
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    const dir = f.library.ensureCompanionDir(f.book.bookId).dir
    rmSync(dir, { recursive: true, force: true })

    f.library.writeNote(f.book.bookId, { excerpt: '重建后', thought: 'y' })
    assert.ok(existsSync(join(dir, 'notes.md')), '文件夹应当被重建')
    assert.match(readFileSync(join(dir, 'notes.md'), 'utf8'), /重建后/)
  } finally {
    f.cleanup()
  }
})

test('落点：background.md 与 notes.md 走同一个落点（单一收口的证据）', () => {
  const f = makeFixture()
  try {
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    const location = f.library.location(f.book.bookId)
    assert.equal(location.notesPath, join(location.dir, 'notes.md'))
    assert.equal(location.backgroundPath, join(location.dir, 'background.md'))

    // 实测两条路径真的落在同一个目录里（而不是一个搬了一个没搬）。
    f.library.backgroundMerge(f.book.bookId, {
      sections: [{ key: '世界观', bullets: ['一个江湖'] }],
      characters: [],
      relations: [],
    }, { first: 1, last: 1 })
    assert.ok(existsSync(join(location.dir, 'background.md')), 'background.md 没跟着搬')
    assert.ok(!existsSync(join(f.library.paths.bookDir(f.book.bookId), 'background.md')), '不该还留在插件目录')
  } finally {
    f.cleanup()
  }
})

test('移除：`keepNotes` 保留的是**活的那一份**（落在工作区时不能拷插件目录里的空壳）', () => {
  // ⚠️ 2026-10-01 三方评审 P2：旧的实现只从 `bookDir` 拷 `notes.md`，而笔记的落点
  //    可能是**工作区**（`artifactPath` 是唯一收口）—— `bookDir` 下那份往往只是
  //    导入时建的空骨架。于是"我帮你把笔记留了一份"是一句假话，
  //    而假的安全感比没有更坏。
  const f = makeFixture()
  try {
    f.library.bind(f.book.bookId, 'session-a', null, f.workspaceDir)
    const location = f.library.location(f.book.bookId)
    mkdirSync(location.dir, { recursive: true })
    const live = '# 《夜行》· 读书笔记\n\n## 第一章\n\n- 摘抄：雪落得很慢\n'
    writeFileSync(location.notesPath, live, 'utf8')

    const result = f.library.remove(f.book.bookId, { keepNotes: true })
    assert.ok(result.notesKeptAt, '必须给出保留路径')
    assert.equal(
      readFileSync(result.notesKeptAt, 'utf8'),
      live,
      '保留的必须是工作区那份活的笔记，而不是插件目录里的空骨架',
    )
  } finally {
    f.cleanup()
  }
})

test('迁移：换落点（工作区 A → 工作区 B）时真笔记必须跟过去，不许只补一份空骨架', () => {
  // ⚠️ 2026-10-02 三方评审 P2-1（触发概率最高的几条之一：换会话 = 一次点击）：
  // 迁移源**只有插件目录**，而插件目录里那份 `notes.md` 是**导入时写下的空骨架**
  // （`library.js` 的导入段）。于是从 W1 换到 W2 时，W2 拿到的是一份空文件，
  // 而 `migrated` / 界面提示照样报「已把 notes.md 复制过来，原文件保留」——
  // 报的是迁移成功，搬过来的却是空骨架。W1 的笔记成为孤儿：
  // 笔记页、本章笔记数、导出、注入 prompt 全部读到空的那份。
  //
  // 这条守卫钉两件事：① 真内容必须跟过去；② 报告必须如实（骨架不算"已复制过来"）。
  const f = makeFixture({ title: '换落点' })
  try {
    const bookId = f.book.bookId

    // 落在 W1，写一条真笔记。
    f.library.setCompanionDir(bookId, f.workspaceDir)
    f.library.writeNote(bookId, { excerpt: 'W1 写的摘抄', thought: '在第一个工作区', chapterIndex: 0 })
    const w1 = f.library.location(bookId).dir
    assert.ok(readFileSync(join(w1, 'notes.md'), 'utf8').includes('W1 写的摘抄'), '前置：W1 里得有真笔记')

    // 换到 W2。
    const w2Root = join(f.root, 'ws-two')
    mkdirSync(w2Root, { recursive: true })
    // ⚠️ 报告是随**换落点这一次**的响应回给界面的（`PUT /location` → `location.migrated`，
    //    `client.js` 用它拼那句「已把 … 复制过来」），所以要接住这个返回值 ——
    //    后一次 `ensureCompanionDir` 只会看到"目标已经有内容"，报不出任何东西。
    const switched = f.library.setCompanionDir(bookId, w2Root)
    const w2 = f.library.location(bookId).dir
    assert.notEqual(w2, w1, '前置：落点确实换了')

    assert.ok(
      readFileSync(join(w2, 'notes.md'), 'utf8').includes('W1 写的摘抄'),
      '换落点后笔记必须跟过来（现在是给一份空骨架，读者以为笔记丢了）',
    )
    assert.deepEqual(switched.migrated, ['notes.md'], '应当如实报告迁移了 notes.md')
    assert.deepEqual(f.library.ensureCompanionDir(bookId).migrated, [], '迁移过就不该反复报')

    // 原文件保留（复制而非移动）——这是既有的承诺，换落点后同样成立。
    assert.ok(existsSync(join(w1, 'notes.md')), '旧落点的文件必须保留')
    assert.ok(readFileSync(join(w1, 'notes.md'), 'utf8').includes('W1 写的摘抄'), '旧落点内容不该被改动')
  } finally {
    f.cleanup()
  }
})

//#endregion
