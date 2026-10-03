/**
 * 导出：把一本书的笔记 / 背景认识 / 历代压缩前备份写成**文件名自带书名**的一组文件。
 *
 * 这组测试盯的是三件一旦写错就会**毁用户数据**的事：
 *   1. **绝不覆盖**：笔记只能追加，导出文件头部必须有归属标记；不是我们导出的文件
 *      一律不碰（那是"往别人的 .md 里追加"的高危动作）。
 *   2. **幂等**：重复导出不该产生重复内容，也不该白写一遍（白写会动 mtime，
 *      让 Obsidian / 同步工具重新索引）。
 *   3. **同名不互踩**：两本同名书导出到同一目录，谁也不能踩谁。
 *
 * 纯函数与 `runExport` 都在这里测；需要整套书库存的用例在 `library.test.mjs`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decideExportTarget,
  mergeExportedNotes,
  parseExportMarker,
  renderExportMarker,
  runExport,
  writeAutoBackup,
} from '../lib/host/export.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = join(HERE, '.tmp')

let seq = 0
/** 建一个隔离目录。 */
function makeDir(tag = 'export') {
  seq += 1
  const dir = join(TMP_ROOT, `${tag}-${process.pid}-${Date.now()}-${seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const BOOK_ID = 'a1b2c3d4e5f60718'
const OTHER_BOOK_ID = 'ffffffffffffffff'

/** 造一条形状与真实 `notes.md` 一致的笔记块。 */
function noteBlock(id, text) {
  return [
    `<!-- drc-note:begin id=${id} created=2026-01-01T00:00:00.000Z chapter=3 offset=12 tags=人设 -->`,
    '### 第4章 带子 #人设',
    '',
    `> ${text}`,
    '',
    `**我的感想**：${text} 这句真好。`,
    '',
    '<!-- drc-note:end -->',
  ].join('\n')
}

test('导出：归属标记可往返，缺 book 时不认', () => {
  const markdown = `${renderExportMarker(BOOK_ID, '2026-09-25T00:00:00.000Z')}\n# 标题\n`
  const parsed = parseExportMarker(markdown)
  assert.equal(parsed.bookId, BOOK_ID)
  assert.equal(parsed.generated, '2026-09-25T00:00:00.000Z')

  assert.equal(parseExportMarker('# 完全没有标记'), null)
  assert.equal(parseExportMarker('<!-- drc-export generated=2026-01-01 -->'), null, '缺 book 不算标记')
  assert.equal(parseExportMarker(''), null)
})

test('导出许可：不存在=创建、同书=更新、他书与无标记一律拒绝', () => {
  assert.deepEqual(
    decideExportTarget({ existingText: null, bookId: BOOK_ID }),
    { ok: true, mode: 'create' },
  )
  assert.deepEqual(
    decideExportTarget({ existingText: renderExportMarker(BOOK_ID), bookId: BOOK_ID }),
    { ok: true, mode: 'update' },
  )

  const other = decideExportTarget({ existingText: renderExportMarker(OTHER_BOOK_ID), bookId: BOOK_ID })
  assert.equal(other.ok, false)
  assert.equal(other.reason, 'TARGET_OTHER_BOOK')
  assert.equal(other.owner, OTHER_BOOK_ID)

  // ⚠️ 最要紧的一条：用户自己写满内容的 .md 放在同名位置时，绝不能往里追加。
  const foreign = decideExportTarget({ existingText: '# 我自己的读书笔记\n\n手写的东西\n', bookId: BOOK_ID })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.reason, 'TARGET_NOT_OURS')
})

test('导出增量：只补目标里没有的块；没有 id 的手写块不追加、但要报出来', () => {
  const source = [
    noteBlock('id-1', '甲'),
    noteBlock('id-2', '乙'),
    noteBlock('id-3', '丙'),
    // 手写块：没有 id 属性，没有"这条导过没有"的判据
    '<!-- drc-note:begin chapter=1 -->\n### 手写块\n\n**我的感想**：没有 id\n\n<!-- drc-note:end -->',
  ].join('\n\n')
  const target = [noteBlock('id-2', '乙'), noteBlock('id-1', '甲')].join('\n\n')

  const merged = mergeExportedNotes(source, target)
  assert.deepEqual(merged.missing.map((block) => block.id), ['id-3'])
  assert.equal(merged.sourceCount, 4)
  assert.equal(merged.skippedNoId, 1, '没有 id 的块必须计数，好让界面说清为什么没导')
})

test('导出落盘：文件名自带书名；重复导出幂等（动作全 unchanged）', () => {
  const src = makeDir('export-src')
  const out = makeDir('export-out')
  try {
    writeFileSync(
      join(src, 'notes.md'),
      `${noteBlock('id-1', '甲')}\n\n${noteBlock('id-2', '乙')}\n`,
    )
    writeFileSync(join(src, 'background.md'), '# 《夜行》· 背景认识\n\n## 世界观\n- `第3章` 双女主\n')

    const spec = () => ({
      bookId: BOOK_ID,
      title: '夜行',
      targetDir: out,
      notesMarkdown: readFileSync(join(src, 'notes.md'), 'utf8'),
      backgroundBytes: readFileSync(join(src, 'background.md')),
      backups: [{ stamp: '20260925-131717', bytes: Buffer.from('# 压缩前\n- 详细得多的一条\n', 'utf8') }],
      now: '2026-09-25T13:20:00.000Z',
    })

    const first = runExport(spec())
    // 落点是**每本书一个文件夹**（在导出根下面），文件名继续自带书名 —— 双保险。
    assert.equal(first.dir, join(out, '陪读导出_夜行'))
    assert.deepEqual(first.files.map((file) => file.name).sort(), [
      '夜行-笔记.md',
      '夜行-背景-压缩前-20260925-131717.md',
      '夜行-背景.md',
    ])

    // 每个导出文件都带归属标记（重复导出靠它认出"这是我自己的"）。
    for (const file of first.files) {
      const text = readFileSync(file.target, 'utf8')
      assert.equal(parseExportMarker(text)?.bookId, BOOK_ID, `${file.name} 必须带归属标记`)
    }

    // 背景是**字节级搬运**：源文件那行必须原样在里面。
    assert.ok(readFileSync(join(first.dir, '夜行-背景.md'), 'utf8').includes('- `第3章` 双女主'))
    // 笔记导出带自己的头部，并且原始块逐字保留。
    const exportedNotes = readFileSync(join(first.dir, '夜行-笔记.md'), 'utf8')
    assert.ok(exportedNotes.includes('id=id-1'))
    assert.ok(exportedNotes.includes('> 甲'))

    // ⚠️ 只有带时间戳的那一份，**没有**"固定名"稳定入口 —— 它会让最新一代在目录里
    // 出现两次，读者实测到之后要求去掉（时间戳可排序，最新 = 按名排序最后一个）。
    assert.equal(
      existsSync(join(first.dir, '夜行-背景-压缩前.md')),
      false,
      '不该再有"固定名"那一份',
    )

    const second = runExport(spec())
    assert.deepEqual(
      second.files.map((file) => file.action),
      ['unchanged', 'unchanged', 'unchanged'],
      '内容没变就不该写盘（写一次动一次 mtime）',
    )
    assert.equal(second.notes.appended, 0)
  } finally {
    rmSync(src, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('导出追加：新笔记追加到尾部，既有字节一个不改（含用户在 Obsidian 侧写的批注）', () => {
  const src = makeDir('export-append-src')
  const out = makeDir('export-append-out')
  try {
    writeFileSync(join(src, 'notes.md'), `${noteBlock('id-1', '甲')}\n`)
    const spec = (now) => ({
      bookId: BOOK_ID,
      title: '夜行',
      targetDir: out,
      notesMarkdown: readFileSync(join(src, 'notes.md'), 'utf8'),
      backgroundBytes: null,
      backups: [],
      now,
    })

    const first = runExport(spec('2026-09-25T13:20:00.000Z'))

    // 模拟用户把导出的文件搬进笔记库之后，在里面写了一句自己的批注。
    const target = join(first.dir, '夜行-笔记.md')
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n> 我在 Obsidian 里补的一句批注\n`)
    const before = readFileSync(target, 'utf8')

    // 书库里又写了一条新笔记
    writeFileSync(join(src, 'notes.md'), `${noteBlock('id-1', '甲')}\n\n${noteBlock('id-3', '丙')}\n`)
    const report = runExport(spec('2026-09-25T13:25:00.000Z'))

    const after = readFileSync(target, 'utf8')
    assert.ok(after.startsWith(before), '既有字节必须原样保留（这是"绝不覆盖"的落点）')
    assert.ok(after.includes('id=id-3'), '新笔记必须被追加')
    assert.ok(after.includes('我在 Obsidian 里补的一句批注'), '用户手写的批注不能被冲掉')
    assert.equal(report.notes.appended, 1)
    assert.equal(report.files[0].action, 'append')
  } finally {
    rmSync(src, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('导出避让：首选名被外来文件占着时改用消歧名并给出警告，绝不碰那个文件', () => {
  const out = makeDir('export-avoid')
  try {
    const bookDir = join(out, '陪读导出_夜行')
    mkdirSync(bookDir, { recursive: true })
    const foreignPath = join(bookDir, '夜行-笔记.md')
    writeFileSync(foreignPath, '# 我自己写的，不是插件导出的\n')
    const foreignBefore = readFileSync(foreignPath, 'utf8')

    const report = runExport({
      bookId: BOOK_ID,
      title: '夜行',
      targetDir: out,
      notesMarkdown: `${noteBlock('id-1', '甲')}\n`,
      backgroundBytes: null,
      backups: [],
      now: '2026-09-25T13:20:00.000Z',
    })

    assert.equal(readFileSync(foreignPath, 'utf8'), foreignBefore, '外来文件一个字节都不能动')
    assert.equal(report.files[0].name, `夜行_${BOOK_ID.slice(0, 6)}-笔记.md`)
    assert.ok(report.warnings.some((line) => line.includes('占用')), '必须把"换了名字"说出来')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('导出同名书：两本同名书各自一个文件夹，谁也不踩谁', () => {
  const out = makeDir('export-same-title')
  try {
    // 另一本同名书已经在**它自己的文件夹**里留下了带标记的导出文件
    const otherDir = join(out, '陪读导出_未命名')
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(
      join(otherDir, '未命名-笔记.md'),
      `${renderExportMarker(OTHER_BOOK_ID)}\n# 另一本《未命名》\n`,
    )

    const report = runExport({
      bookId: BOOK_ID,
      title: '未命名',
      targetDir: out,
      notesMarkdown: `${noteBlock('id-9', '甲')}\n`,
      backgroundBytes: null,
      backups: [],
      now: '2026-09-25T13:20:00.000Z',
    })

    // ⚠️ 消歧发生在**文件夹一级**：文件夹已经属于另一本书，后来者换一个文件夹。
    // （文件级那道消歧仍然在，见上一条用例 —— 两层都必要：文件夹分开"整本"，
    //   文件名分开"从文件夹里单拿出去的那一个"。）
    assert.equal(report.dir, join(out, `陪读导出_未命名_${BOOK_ID.slice(0, 6)}`))
    assert.equal(report.files[0].name, '未命名-笔记.md')
    // 另一本那份没被动过
    assert.equal(
      parseExportMarker(readFileSync(join(otherDir, '未命名-笔记.md'), 'utf8')).bookId,
      OTHER_BOOK_ID,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('导出拒绝：连消歧名都被外来文件占着时，报错而不是往别人文件里写', () => {
  const out = makeDir('export-refuse')
  try {
    const bookDir = join(out, '陪读导出_夜行')
    mkdirSync(bookDir, { recursive: true })
    const plain = join(bookDir, '夜行-笔记.md')
    const disambiguated = join(bookDir, `夜行_${BOOK_ID.slice(0, 6)}-笔记.md`)
    writeFileSync(plain, '# 外来文件\n')
    writeFileSync(disambiguated, '# 另一个外来文件\n')

    assert.throws(
      () => runExport({
        bookId: BOOK_ID,
        title: '夜行',
        targetDir: out,
        notesMarkdown: `${noteBlock('id-1', '甲')}\n`,
        backgroundBytes: null,
        backups: [],
        now: '2026-09-25T13:20:00.000Z',
      }),
      /EXPORT_REJECTED/,
    )
    assert.equal(existsSync(disambiguated), true)
    assert.equal(readFileSync(disambiguated, 'utf8'), '# 另一个外来文件\n')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

//#region 自动备份（3.0）：命名 / 计数 / 不重复 / 没配就不写

test('自动备份：命名 = 书名-第N次自动(归档|压缩).md；计数按既有文件名走，删一个也不乱', () => {
  const dir = makeDir('auto-backup')
  const root = dir
  // ① 第 1 次
  const a = writeAutoBackup({ root, title: '01小说-魔女霓裳', bookId: 'b1', markdown: '一' })
  assert.ok(a !== null)
  assert.match(a.path.replace(/\\/g, '/'), /自动备份\/01小说-魔女霓裳-第1次自动备份\.md$/)
  // ② 内容变了 ⇒ 第 2 次；③ 归档与压缩共用一个池子（后缀只有一个：自动备份）
  const b = writeAutoBackup({ root, title: '01小说-魔女霓裳', bookId: 'b1', markdown: '一 二' })
  assert.match(b.path.replace(/\\/g, '/'), /第2次自动备份\.md$/)
  const c = writeAutoBackup({ root, title: '01小说-魔女霓裳', bookId: 'b1', markdown: '一 二 三' })
  assert.match(c.path.replace(/\\/g, '/'), /第3次自动备份\.md$/)
  // ④ 计数来自**现存文件名**的最大值 + 1 ⇒ 删掉一份也不会让序号复活/错位
  const backupDir = join(dir, '陪读导出_01小说-魔女霓裳', '自动备份')
  assert.deepEqual(
    readdirSync(backupDir),
    [
      '01小说-魔女霓裳-第1次自动备份.md',
      '01小说-魔女霓裳-第2次自动备份.md',
      '01小说-魔女霓裳-第3次自动备份.md',
    ].sort(),
    `命名要规整：${readdirSync(backupDir).join(' / ')}`,
  )
})

test('自动备份：内容一字不差 ⇒ 不新增（备份之间不重复）', () => {
  const dir = makeDir('auto-backup-dedup')
  const root = dir
  const first = writeAutoBackup({ root, title: '书甲', bookId: 'b2', markdown: '同内容' })
  const again = writeAutoBackup({ root, title: '书甲', bookId: 'b2', markdown: '同内容' })
  assert.equal(again.path, first.path, '复用已有备份')
  assert.equal(again.reused, true)
  const filesOf = () => readdirSync(join(dir, '陪读导出_书甲', '自动备份'))
  assert.equal(filesOf().length, 1, `不增文件：${filesOf().join(' / ')}`)
})

test('自动备份：导出根没配 ⇒ 不写（宁可少做，不猜路径）；书名非法字符要被清洗', () => {
  const dir = makeDir('auto-backup-empty')
  assert.equal(writeAutoBackup({ root: '', title: '书', bookId: 'b', markdown: 'x' }), null)
  // 书名来自用户导入的文件名（可能带 Windows 非法字符），必须与导出路由同一把尺子；
  // 空书名不会失败 —— sanitizeFolderName 有兜底名，那与导出路由的行为一致。
  const weird = writeAutoBackup({ root: dir, title: '坏:名?字', bookId: 'b3', markdown: 'x' })
  assert.ok(weird !== null, '非法书名不该让写入失败')
  assert.ok(!/[:?]/.test(weird.path.split('陪读导出_')[1] ?? ''), `清洗后不该有非法字符：${weird.path}`)
})

//#endregion


test('导出命名：来源进文件名 —— 压缩留的叫「压缩前」，清空重建留的叫「清空前」', () => {
  const src = makeDir('export-kind-src')
  const out = makeDir('export-kind-out')
  try {
    writeFileSync(join(src, 'background.md'), '# 《夜行》· 背景认识\n\n## 世界观\n- `第3章` 双女主\n')

    // 同一批里两种来源**同一个时间戳**：名字必须不同，否则读者分不清、会乱合并。
    const run = (backups) => runExport({
      bookId: BOOK_ID,
      title: '夜行',
      targetDir: out,
      notesMarkdown: null,
      backgroundBytes: readFileSync(join(src, 'background.md')),
      backups,
      now: '2026-10-03T14:00:00.000Z',
    })

    const compact = run([{ stamp: '20261003-140000', kind: 'compact', bytes: Buffer.from('# 压缩前\n', 'utf8') }])
    assert.deepEqual(
      compact.files.map((file) => file.name).filter((name) => name.includes('背景-')).sort(),
      ['夜行-背景-压缩前-20261003-140000.md'],
      'kind: compact ⇒ 导出名说「压缩前」',
    )

    const clean = run([{ stamp: '20261003-140000', kind: 'clean', bytes: Buffer.from('# 清空前\n', 'utf8') }])
    assert.ok(
      clean.files.some((file) => file.name === '夜行-背景-清空前-20261003-140000.md'),
      'kind: clean ⇒ 导出名必须说「清空前」；一律叫「压缩前」就是丢了来源（读者 2026-10-03 反馈）',
    )

    // ⚠️ 老调用方不传 kind（历史形状）⇒ 必须回落到「压缩前」，不能变成「清空前」或报错。
    const legacy = run([{ stamp: '20261003-140000', bytes: Buffer.from('# 老\n', 'utf8') }])
    assert.ok(
      legacy.files.some((file) => file.name === '夜行-背景-压缩前-20261003-140000.md'),
      '没传 kind 时回落「压缩前」',
    )
  } finally {
    rmSync(src, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('「读不出来」的 notes.md 必须**报出来**，不能静默少掉整个笔记文件', async () => {
  // ⚠️ 这一条防的是"看起来成功的残缺产物"。`notesMarkdown === null` 有两种来源：
  //    ① 真的没有这份文件；② 有、但这次读不出来（EACCES / 被同步盘或杀毒占着）。
  //    从前两者同一个处置 ⇒ 导出照常"成功"，而读者拿到的那份**一条笔记都没有**，
  //    文件却完好无损 —— 他会以为笔记丢了，或者以为导出没问题。
  //    `library.exportBook` 现在用"文件在不在"把②认出来，并通过 `notesUnreadable`
  //    传进来；这里钉住 export 侧的处置（以及**不误报**那一半）。
  const out = makeDir('export-notes-unreadable')
  const out2 = makeDir('export-notes-absent')
  try {
    const common = {
      bookId: BOOK_ID,
      title: '夜行',
      backgroundBytes: null,
      backups: [],
      now: '2026-10-04T00:00:00.000Z',
    }

    const unreadable = runExport({ ...common, targetDir: out, notesMarkdown: null, notesUnreadable: true })
    assert.ok(
      unreadable.warnings.some((line) => line.includes('没有包含笔记')),
      `读不出来时必须如实说（面板会把 warnings 拼进出导结果），实际 ${JSON.stringify(unreadable.warnings)}`,
    )
    assert.ok(
      !unreadable.files.some((file) => file.name.includes('笔记')),
      '说清了"没包含"就不该同时写出一个空笔记文件',
    )

    // ⚠️ 反向：**真的没有**这份文件时不许报警 —— 一本还没记过笔记的书导出是正常操作，
    //    每次导出都弹一句"读不出来"会让这句话立刻变成噪音（而噪音等于没有提示）。
    const absent = runExport({ ...common, targetDir: out2, notesMarkdown: null, notesUnreadable: false })
    assert.deepEqual(absent.warnings, [], '没有笔记文件不是异常，不该产生任何警告')
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(out2, { recursive: true, force: true })
  }
})
