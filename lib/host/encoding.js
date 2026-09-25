/**
 * TXT 编码探测与解码。
 *
 * 中文 TXT 的编码分布大概是：UTF-8（含 BOM 与无 BOM）、GB18030/GBK、
 * 少量 UTF-16。`dsh-reader` 用 iconv-lite 做这件事，但本插件坚持
 * **零运行时依赖**（我们的包是工作区目录联接，没有自己的 node_modules），
 * 所以改用 Node 内置的 `TextDecoder`：
 *   - `utf-8` 支持 `fatal: true`，可做**严格校验**（这是判定的关键）；
 *   - Node 自带 full-icu，`gb18030` / `utf-16be` 都可用。
 *
 * 判定顺序刻意如此：BOM 最可信 → 严格 UTF-8 次之 → 回落 GB18030。
 * 反过来先试 GB18030 会把合法 UTF-8 也"成功"解成乱码，因为 GB18030
 * 几乎不拒绝任何字节序列。
 */

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf])
const BOM_UTF16LE = Buffer.from([0xff, 0xfe])
const BOM_UTF16BE = Buffer.from([0xfe, 0xff])

/** 替换字符：解码质量的自检信号。 */
const REPLACEMENT = '\uFFFD'

/**
 * 统一换行。
 *
 * 必须在**解析章节之前**做，且只做一次：章节偏移是基于归一化后的文本
 * 计算的，若中途再改动换行，所有偏移都会错位。顺带解决「有的 TXT 是
 * CRLF、有的是 CR」这个真实存在的坑。
 *
 * @param {string} text 原始文本
 * @returns {string} 换行统一为 `\n` 的文本
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * 按 2 字节单位统计某个码位的出现次数。
 *
 * 必须按**单位**而不是按字节统计：`上` 是 U+4E0A，UTF-16LE 下低字节恰好
 * 就是 `0A`。若按字节数 `0x0A`，这个字会被误当成换行，把比例算歪
 * （实测把 10 个真换行稀释成 7/10，直接跌破阈值）。
 *
 * @param {Buffer} sample 采样字节
 * @param {boolean} littleEndian 是否按小端读单位
 * @param {number} value 目标码位
 * @returns {number} 命中数
 */
function countUnits(sample, littleEndian, value) {
  const end = sample.length - (sample.length % 2)
  let count = 0
  for (let i = 0; i + 1 < end; i += 2) {
    const unit = littleEndian ? sample.readUInt16LE(i) : sample.readUInt16BE(i)
    if (unit === value) count += 1
  }
  return count
}

/**
 * 统计「高字节落在 CJK 基本区」的单位占比。
 *
 * 汉字码位在 U+4E00–U+9FFF，其高字节必然落在 0x4E–0x9F。UTF-16 的中文
 * 文本这一比例接近 1.0，而 GBK 文本被按 UTF-16 解读时该比例只有 ~0.35
 * （GBK 首字节 0x81–0xFE、次字节 0x40–0xFE，与目标区间只是部分重叠）。
 * 这条用于**没有换行的单行**中文文本，是信号 1 的补充。
 *
 * @param {Buffer} sample 采样字节
 * @param {boolean} littleEndian 是否按小端
 * @returns {number} 占比 0..1
 */
function highByteRangeRatio(sample, littleEndian) {
  const end = sample.length - (sample.length % 2)
  if (end < 64) return 0
  let inRange = 0
  let total = 0
  for (let i = 0; i + 1 < end; i += 2) {
    const high = littleEndian ? sample[i + 1] : sample[i]
    total += 1
    if (high >= 0x4e && high <= 0x9f) inRange += 1
  }
  return total === 0 ? 0 : inRange / total
}

/**
 * 无 BOM 的 UTF-16 启发式判定。三个信号，**顺序不能反**：
 *
 * 1. **换行码位（最强）**。UTF-16 里 `\n` 是一个完整的 2 字节单位
 *    （LE 是 `0A 00`，BE 是 `00 0A`）；而 GB18030/UTF-8 文本按单位读时
 *    几乎不可能凑出 U+000A。对中文文本同样有效。
 * 2. **CJK 高字节集中度**。覆盖「单行、无换行」的中文文本。
 * 3. **NUL 字节奇偶分布（兜底）**。只对 ASCII 为主的文本有效——
 *    汉字码位都在 U+4E00 以上，UTF-16 下**几乎不产生 0x00**，所以这条
 *    单独用会在中文上彻底失效。
 *
 * 早期版本只用信号 3，导致无 BOM 的中文 UTF-16 文件被误判成 GB18030，
 * 整本书解成乱码。本函数的存在就是为了钉死那个回归。
 *
 * @param {Buffer} buffer 原始字节
 * @returns {'utf-16le'|'utf-16be'|null}
 */
function sniffUtf16WithoutBom(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 65536))
  if (sample.length < 4) return null

  // --- 信号 1：换行码位 ---
  const lfLe = countUnits(sample, true, 0x0a)
  const lfBe = countUnits(sample, false, 0x0a)
  if (lfLe >= 3 && lfLe > lfBe * 3) return 'utf-16le'
  if (lfBe >= 3 && lfBe > lfLe * 3) return 'utf-16be'

  // --- 信号 2：CJK 高字节集中度（单行文本）---
  const leCjk = highByteRangeRatio(sample, true)
  const beCjk = highByteRangeRatio(sample, false)
  if (leCjk >= 0.85 && leCjk > beCjk) return 'utf-16le'
  if (beCjk >= 0.85 && beCjk > leCjk) return 'utf-16be'

  // --- 信号 3：NUL 分布兜底（ASCII 为主）---
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] !== 0) continue
    if (i % 2 === 0) evenNul += 1
    else oddNul += 1
  }
  const total = sample.length / 2
  if (oddNul / total > 0.3 && oddNul > evenNul * 4) return 'utf-16le'
  if (evenNul / total > 0.3 && evenNul > oddNul * 4) return 'utf-16be'
  return null
}

/**
 * 用指定编码解码，严格模式下失败即抛。
 *
 * @param {Buffer} buffer 原始字节
 * @param {string} encoding 编码名
 * @param {boolean} fatal 是否严格
 * @returns {string}
 */
function decodeWith(buffer, encoding, fatal) {
  return new TextDecoder(encoding, { fatal }).decode(buffer)
}

/**
 * 统计替换字符占比，作为「解得对不对」的客观指标。
 *
 * @param {string} text 解码结果
 * @returns {number} 占比 0..1
 */
function replacementRatio(text) {
  if (text === '') return 0
  let count = 0
  for (const ch of text) if (ch === REPLACEMENT) count += 1
  return count / [...text].length
}

/**
 * 解码一本书的原始字节。
 *
 * @param {Buffer} buffer 文件原始字节
 * @returns {{ text: string, encoding: string, confidence: string, warnings: string[] }}
 * @throws {Error} 所有编码都失败时
 */
export function decodeBook(buffer) {
  const warnings = []

  // 1) BOM —— 最可信，见到就用。
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_UTF8)) {
    return finish(decodeWith(buffer.subarray(3), 'utf-8', false), 'utf-8', 'bom', warnings)
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16LE)) {
    return finish(decodeWith(buffer.subarray(2), 'utf-16le', false), 'utf-16le', 'bom', warnings)
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16BE)) {
    return finish(decodeWith(buffer.subarray(2), 'utf-16be', false), 'utf-16be', 'bom', warnings)
  }

  // 2) 无 BOM 的 UTF-16 —— 字节分布太特殊，先于 UTF-8 判定。
  const sniffed = sniffUtf16WithoutBom(buffer)
  if (sniffed !== null) {
    warnings.push(`无 BOM，按字节分布判定为 ${sniffed}`)
    return finish(decodeWith(buffer, sniffed, false), sniffed, 'heuristic', warnings)
  }

  // 3) 严格 UTF-8 —— 不合法就抛，这正是我们要的判别力。
  try {
    return finish(decodeWith(buffer, 'utf-8', true), 'utf-8', 'strict-utf8', warnings)
  } catch {
    warnings.push('不是合法 UTF-8，回落到 GB18030')
  }

  // 4) GB18030 —— 覆盖 GBK/GB2312 的超集，中文老书的主力编码。
  try {
    const text = decodeWith(buffer, 'gb18030', false)
    const ratio = replacementRatio(text)
    if (ratio > 0.02) warnings.push(`GB18030 解码出现 ${(ratio * 100).toFixed(1)}% 替换字符，可能仍是乱码`)
    return finish(text, 'gb18030', 'fallback', warnings)
  } catch (error) {
    throw new Error(`无法解码该文件：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 收尾：归一化换行、补一致性警告。
 *
 * @param {string} text 解码文本
 * @param {string} encoding 编码名
 * @param {string} confidence 判定依据
 * @param {string[]} warnings 警告收集器
 * @returns {{ text: string, encoding: string, confidence: string, warnings: string[] }}
 */
function finish(text, encoding, confidence, warnings) {
  const normalized = normalizeNewlines(text)
  if (normalized.trim() === '') warnings.push('文件解码后为空')
  return { text: normalized, encoding, confidence, warnings: [...warnings] }
}
