/**
 * dsh-reading-companion — 宿主（Node）半边。
 *
 * 职责边界（见 docs/design-v1.md）：
 *   P0 骨架：证明宿主半边可被 cordis 挂载，并开放一条健康检查路由。
 *   P1 书库：TXT 编码探测、章节解析（两遍扫描 + 打分）、书架与目录、
 *            按章读取、进度持久化            ← 本文件当前所在阶段
 *   P2 起追加：防剧透上下文装配（systemPrompt.section）与工具闸（tools.guard）。
 *   P3 起追加：结构化 Markdown 笔记的追加写入与 AI 打 tag。
 *
 * 低破坏性约定：不注册任何 replaceRisk 非 none 的槽、不接管宿主既有服务、
 * 不写 <DSH_HOME>/storages/。全部数据落在插件自己的目录里。
 *
 * 关于浏览器访问：DSH Desktop 的 `DesktopWebServer` 会给每条路由套一层
 * `decideDesktopBrowserAccess`，只有携带 Electron 渲染器令牌的请求才放行，
 * 其余一律 403。这不是插件能或应该绕过的东西——本插件只在渲染器里被调用。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { createLibrary } from './host/library.js'
import { suggestTags } from './host/tags.js'
import { backgroundGap, entityCardsFor, needsCompaction } from './host/background.js'
import { createCompactor } from './host/compact.js'
import { createBackgroundUpdateWatcher } from './host/background-update.js'
import { createMemoryFiller } from './host/memory.js'
import { normalizeDiscussionLimit } from './host/discussions.js'
import {
  WEB_GATE_MODES,
  describeWindow,
  normalizeSessionId,
  renderCompanionSection,
  spoilerGuardReason,
} from './host/spoiler.js'

/**
 * cordis 插件名。
 * ⚠️ 必须与 cordis.patch.yml 里那一行的 `id` 完全一致，否则装配出的行
 * 解析不到任何实现。
 */
export const name = 'dsh-reading-companion'

/**
 * 硬依赖清单。
 * cordis 只物化这里声明过的服务——未声明就去读 `ctx.xxx` 会**直接抛错**，
 * 而不是返回 undefined。
 *
 * `systemPrompt` 与 `tools` 是 P2 的两个防剧透挂点，缺任何一个都无法装配，
 * 所以它们是硬依赖（宁可整个插件等待，也不要静默失去防剧透能力）。
 */
export const inject = ['webServer', 'systemPrompt', 'tools']

/** 浏览器半边与宿主半边共用的路由前缀（必须两边一致）。 */
export const API_ROOT = '/dsh-reading-companion/api'

/** 插件自有的数据根目录名（相对 $DSH_HOME）。 */
export const STORAGE_DIR_NAME = 'dsh-reading-companion'

/** 请求体上限：导入请求只有一个小 JSON，1MB 绰绰有余。 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 导出目录的长度上限。
 *
 * 与 `lib/host/library.js` 的 `SETTING_PATH_MAX_CHARS` 同值——那里是**读取**时的
 * 清洗上限，这里是**写入**时的拒绝上限。两处必须一致，否则会出现"存得进去但读出来
 * 被截掉"这种最难查的不一致。
 */
const EXPORT_DIR_MAX_CHARS = 1024

/** 防剧透 system 段落在装配顺序里的位置（紧跟运行时上下文之后）。 */
const SECTION_ORDER = 60

/** 段落名：必须全局唯一，且是"谁注册了它"的可读证据。 */
const SECTION_NAME = 'dsh-reading-companion:companion'

/** cordis.patch.yml 未显式给值时的默认配置。 */
const DEFAULTS = {
  /** 空字符串 = 走 $DSH_HOME/<STORAGE_DIR_NAME>，随 profile 迁移。 */
  storageDir: '',
  inboxDir: 'inbox',
  fallbackBlockChars: 4000,
  /**
   * 导入白名单：非空时，`POST /library/import` 只接受落在这些根目录里的路径。
   *
   * 默认 **空数组 = 不限制**，因为"从磁盘任意位置导一本 TXT"是这个功能的正当用法。
   * 这条闸是给**想收窄**的人准备的：导入接口是一条本地文件读取面，插件侧没有
   * 鉴权，完全依赖宿主的渲染器令牌门（`decideDesktopBrowserAccess`）。设成
   * `['D:\\Books', 'D:\\Download']` 之后，即便渲染器侧被攻破，也读不到这几个
   * 目录之外的东西。判定走**真实路径**，所以用链接指向白名单里也绕不过去。
   */
  importRoots: [],

  /**
   * 导出目录（`POST /books/:bookId/export` 的目标）。
   *
   * 空 = **不留默认值**，导出时按"请求体 > 运行期设置 > 会话工作区根"现算。
   * 不在这里给一个具体默认是刻意的：默认值应该跟着**这本书绑定的会话工作区**走
   * （那通常就在用户的笔记库旁边），而配置项是全局的、算不出"哪本书"。
   *
   * 运行期可以在界面上改（存 `settings.json`），优先级：设置 > 这里 > 会话工作区根。
   */
  exportDir: '',
  /**
   * 原始文本路径闸（规则 A）的总开关。
   *
   * 关掉后模型可以用 `read` 直接读 `content.txt` —— 那等于把全书交给它。
   * 只在这条规则误伤了正常工作时才关。
   */
  spoilerGate: true,
  /**
   * 「首次阅读防剧透」的联网档位。
   *
   *   'block-all'  完全 —— 陪读会话一律不能联网（默认）
   *   'block-book' 本书 —— 允许联网，但拦住看起来在查这本书的查询
   *   'off'        关闭 —— 不拦
   *
   * ⚠️ 这个开关**只影响工具层**。「不主动剧透」的提示词守则始终生效，
   * 不受它影响。
   */
  webGate: 'block-all',
  /**
   * 已读窗口预算。
   *
   * `currentChapterMode`：
   *   'full'         当前章整章投喂（默认，读者要求「完整阅读本章和前一章」）
   *   'read-so-far'  只投喂到进度光标，保留"严格到光标"的旧语义
   *
   * `backgroundBudgetChars`：背景认识段落的字符上限。
   *
   * `compactThreshold`：背景认识"胖到该压缩了"的比例。超过
   * `backgroundBudgetChars × 这个值` 时，下次补齐会先压缩再合并。设成 1 就
   * 等于关掉自动压缩（截断仍然生效，只是会破坏缓存）。
   *
   * `discussionLimit`：注入 prompt 的讨论时间线条数。
   */
  window: {
    currentChapterMode: 'full',
    /**
     * 上一章给多少：`'tail'`（默认）只给**尾部** 60%，`'full'` 是旧行为（整章）。
     *
     * 见 `collectReadWindow` 的说明。跨章讨论回看的几乎总是上一章的结尾，而整章
     * 投喂等于每轮白带几千字。想退回旧行为把它改成 `'full'` 即可。
     */
    previousChapterMode: 'tail',
    headAllowanceChars: 1500,
    /**
     * v1.26：**6000 → 9000**（读者在真机确认功能可用后，按"最省事的办法"选定）。
     *
     * 这是 T3「提 D」那一半。§197 的两个轴（深度 / 合并比）**反向**，加预算是
     * 同时松开它们唯一的办法；而加预算以 R8（缓存命中率实测）为闸门。本版
     * **仍然没有 R8 数据**——所以这里是一次**有意识的赌注**，代价如实说：
     * 缓存命中时多出来的背景几乎不花钱，**不命中则每轮全额付**。
     * 取 **+50%**（最保守的一档）就是为了用最小代价换最大的信息。
     *
     * `compactThreshold`(0.85) 是**按比例**跟走的：6000×0.85=5100，现在
     * 9000×0.85=7650 才触发压缩。所以两道闸是联动的——D 变大不会撑爆上下文，
     * 只是压缩来得晚一些。想退回去把它改回 `6000` 即可（同时把库侧那两处
     * `?? 9000` 兜底改回，它们必须与这里同值，有测试钉住不许分叉）。
     *
     * ⚠️ **在均分形状（`sample.lengthRatio: 0`）下，§197 那条不等式不适用**：
     * `总字数 ≤ 70 × D ÷ k` 的前提是 `u = k × 章长`。所以本版提 D 的收益**不是**
     * "能撑更大的书"，而是"同一批预算能多覆盖主体、多留余量"。想要前者得同时
     * 打开 `lengthRatio`——而那个代价（短章被截）读者已经明确撤回过。
     */
    backgroundBudgetChars: 9000,
    /**
     * 背景认识的**降级阶梯**：预算不够时，先把装不下的主体降为粗粒度
     * （`### 主体` + 最近一条记载），只有粗粒度也装不下才整块丢弃。默认开。
     *
     * 为什么可以默认开：这一级是**纯补位**——预算充足（没有主体被跳过）时输出
     * **逐字节不变**；只有真的挤不下时，它才让一批原本要消失的主体至少露个头。
     * 设 `false` 回到 v1.24 的两级降级（直接丢弃）。
     */
    backgroundCoarseDegrade: true,
    compactThreshold: 0.85,
    discussionLimit: 8,
  },
  /**
   * 抽样预算：一次补齐调用能读多少原著文字。
   *
   * 这个数直接决定"一次调用能补多长的缺口"——预算不够覆盖整个缺口时，
   * 只补前一段，水位线推到位，剩下的下次再补。
   */
  sample: {
    budgetChars: 24000,
    /**
     * 每章下限。
     *
     * ⚠️ **默认形状（`lengthRatio: 0`）下它不是"每章都给这么多"**，而是均分
     * 额度 `budgetChars ÷ 权重和` 的**封底**：一批章很多时，均分额度会被它托住。
     * 只有按章长比例那个形状（`lengthRatio > 0`）里，它才是"公式的封底"。
     *
     * ⚠️ **它同时决定"一批最多吃多少章"**：`一批章数 ≈ budgetChars ÷ minPerChapter`。
     * 也就是说"每章多厚"与"一批多宽"**是同一个旋钮的两个说法** —— 抬下限会自动把
     * 批内章数压下来。
     *
     * v2.0.2：**100 → 150**（读者选定）。全量纳入那条路每章从约 100 字提到约 150 字；
     * 代价如实说：一批从约 240 章降到约 160 章，**批数变多、总耗时变长**。
     * 而"读得厚"这件事主要交给下面 `recentMinPerChapter` 那条路。
     */
    minPerChapter: 150,
    maxPerChapter: 600,
    /**
     * 每章的**基准**额度占它自身章长的比例。**默认 `0` = 关**。
     *
     * `u = clamp(lengthRatio × 章长, minPerChapter, maxPerChapter)`，再乘重点章
     * 的权重。设 `0` 的含义是**按预算均分**（`budgetChars ÷ 权重和`，同样 clamp）。
     *
     * ⚠️ **这条在 v1.24 曾经默认 `0.2`，v1.25 又改回 `0`——是读者要求的回退，
     * 不是又一轮调参。** 回退的理由只有一个，但它足够硬：**短章被截得比从前狠**。
     * 按章长比例时，一章 200 字的短章只拿得到下限那一小段；而均分模式下它整章
     * 都装得下。读者读的不只是长篇，短章（笔记体、段子、诗歌、公文体）是他的
     * 真实用法，不能为了长篇的合并比牺牲它。
     *
     * **按比例那条路保留着**，改一个数就能打开（`lengthRatio: 0.2` 即 v1.24 的
     * 形状，`0.2` 来自 §197 的推算——210 万字的分界，**没有实测语料调优**）。
     * 打开时通常还要把 `minPerChapter` 一起降到 60。两种形状各有专测。
     */
    lengthRatio: 0,
    /**
     * 首次补齐（"打底"）的章数上限。
     *
     * 读者读到第 300 章才第一次补齐时，与其把 24000 字平摊成 240 章各 100 字
     * （覆盖极广、深度为零），不如先把开头读厚，剩下的留到第二次——两次补完，
     * 第一次深、第二次全。只在 `covered === null` 时生效。
     */
    foundationChapters: 30,
    /** 开头的重点章数。 */
    emphasisChapters: 5,
    /** 重点章的加权倍数（同一批预算下，开头这几章拿到这么多倍的字数）。 */
    emphasisFactor: 3,
    /**
     * 跳读闸：一次补齐的缺口超过这么多章时**不自动补**，先让读者表态。
     *
     * 为什么要这道闸：读者从目录直接点开第 1000 章时，缺口是第 1–999 章。
     * 此刻自动补齐会把**第 900 章的条目**写进 `background.md`，而这份文件
     * 之后会被原样注入——等他回到第 50 章读，那些条目就是静默剧透，而且
     * **不可逆**：唯一的补救是 `background/reset`，那会连真读过的记忆一起清掉。
     *
     * 触发后客户端会收到 409 与缺口区间，由读者选「全部纳入」或「只记最近
     * 这一段」；两个选择分别对应请求体里的 `mode: 'all'` / `mode: 'recent'`。
     *
     * 设 `0` 关掉这道闸（回到旧行为）。
     *
     * ⚠️ **它现在只是"阈值"，不再兼作"最近窗口"**（v2.0.2 拆开）。此前这一个数
     * 身兼两职：`mode: 'recent'` 直接拿它当窗口大小，于是"想放大最近窗口"就不得不
     * 放松闸门 —— 两件不相干的事被绑在了一起。窗口现在是下面那个键。
     */
    jumpGateChapters: 50,
    /**
     * 「只记最近这一段」的**窗口大小**（章）。
     *
     * 读者从中间开始读时的正确答案：不碰前面那几百章，于是既不会把远处的条目写进
     * 文件，也不用烧掉十几次调用。默认 **200** —— 够覆盖"最近这一段剧情"，而按
     * 下面的每章下限算，一批只吃约 80 章，所以大约 3 批就能读得比较厚。
     *
     * 读者在跳读闸的弹窗里可以**逐次改**（请求体带 `recentWindow`），所以这个值是
     * "默认给多少"，不是"只能给多少"。
     */
    recentWindowChapters: 200,
    /**
     * 「只记最近这一段」那条路**专用的每章下限**（比 `minPerChapter` 厚）。
     *
     * 为什么两条路要两套厚度：用途不同 —— **全量纳入**是"别一脸茫然"（覆盖优先），
     * **最近这一段**是"我在这一章要聊得起来"（深度优先）。用同一个下限伺候两种用途，
     * 必然有一个不满意。
     *
     * ⚠️ 厚一倍意味着**一批只吃约 `budgetChars ÷ 这个数` 章**（24000 ÷ 300 = 80 章），
     * 所以"最近 200 章"要约 3 批。这是刻意的取舍，不是副作用。
     */
    recentMinPerChapter: 300,
  },
  /** 单次补齐的超时（毫秒）。用户选了阻塞式，愿意等几十秒。 */
  memoryTimeoutMs: 120000,
}

/**
 * 配置缺省值的**只读**视图。
 *
 * 导出它只有一个用途：让断言能拿"库侧的兜底默认值"与"配置的缺省值"作**同一个
 * 比较**。同一套默认值写在两处（`sampleChapters` 里的 `?? 60` 与这里的 `60`）
 * 是这一仓库里反复出现的形状——写两遍、只测一遍，等于有一遍没有守卫。有了这个
 * 出口，"两处一致"就是一条会被执行的断言，而不是一句注释。
 *
 * @type {Readonly<object>}
 */
export const CONFIG_DEFAULTS = Object.freeze({
  ...DEFAULTS,
  window: Object.freeze({ ...DEFAULTS.window }),
  sample: Object.freeze({ ...DEFAULTS.sample }),
})

/** 从 package.json 读版本，避免与元数据漂移。 */
function readVersion() {
  try {
    const url = new URL('../package.json', import.meta.url)
    return JSON.parse(readFileSync(url, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const VERSION = readVersion()

/**
 * 解析书库根目录。
 *
 * 优先级：显式配置 > 宿主提供的 dshHomePath() > ~/.dsh/<name>。
 * 走 dshHomePath 而不是自己拼 ~/.dsh，是为了跟随用户的 DSH_HOME 设置。
 *
 * @param {object} ctx 宿主上下文
 * @param {object} config 校验后的配置
 * @returns {string} 绝对路径
 */
function resolveStorageDir(ctx, config) {
  if (typeof config.storageDir === 'string' && config.storageDir.trim() !== '') {
    return config.storageDir
  }
  const dshHomePath = ctx.get('dshHomePath')
  if (typeof dshHomePath === 'function') {
    try {
      return dshHomePath(STORAGE_DIR_NAME)
    } catch {
      /* 降级到下面的兜底 */
    }
  }
  return join(homedir(), '.dsh', STORAGE_DIR_NAME)
}

/**
 * 写一个 JSON 响应。集中处理编码与 Content-Length，避免各路由重复。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    // 本地开发面：禁止任何中间层缓存，避免刷新后拿到旧响应。
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * 读并解析 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 * @throws {Error} 超限或非法 JSON
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve(undefined)
        return
      }
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('BODY_NOT_JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 把路由模板编译成正则与参数名。
 *
 * 模板形如 `/books/:bookId/chapters/:index`；`:name` 捕获一段非斜杠字符。
 *
 * @param {string} pattern 路由模板
 * @returns {{ re: RegExp, keys: string[] }}
 */
function compilePattern(pattern) {
  const keys = []
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) {
        // 模板里的字面量段按原样匹配（转义正则元字符）。
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      keys.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { re: new RegExp(`^${source}$`), keys }
}

/**
 * 归一化「绑定」的对外形态。
 *
 * 进度与会话绑定共用 `bindings.json` 里的一条记录，所以一本只读过、
 * 还没绑定会话的书**也有记录**。若原样回给客户端，它拿到的会是一个
 * 没有 `sessionId` 的"绑定"，语义上等于说谎。这里统一收口：没有会话
 * 就回 `null`。
 *
 * @param {object|undefined} record 书库里的绑定记录
 * @returns {object|null}
 */
function sessionBinding(record) {
  if (record === undefined || record === null) return null
  return typeof record.sessionId === 'string' && record.sessionId !== '' ? record : null
}

/**
 * 把摘要失败的原因翻译成 HTTP 语义与给人看的话。
 *
 * 这里刻意区分「环境不具备」（501/409，用户改配置或换个会话就能解决）与
 * 「这次生成失败了」（502/504，重试有意义）——把它们混成一个 500 会让用户
 * 完全不知道下一步该做什么。
 *
 * @param {string} reason 摘要器给的失败原因
 * @returns {{ status: number, message: string }}
 */
function describeMemoryFailure(reason) {
  const text = String(reason ?? '')
  if (text === 'SUBAGENTS_UNAVAILABLE') {
    return { status: 501, message: '当前部署没有可用的子代理服务，无法补齐背景认识。陪读本身不受影响，只是 AI 对前文的理解有限。' }
  }
  if (text === 'NO_LIVE_PARENT') {
    return { status: 409, message: '这个会话当前没有活的 Agent（还没发过消息，或已被回收）。先在会话里说一句话，再回来补齐。' }
  }
  if (text === 'TIMEOUT') {
    return { status: 504, message: '补齐超时。可以调大插件配置里的 memoryTimeoutMs，或先缩小缺口再试。' }
  }
  if (text === 'NO_SAMPLES') {
    return { status: 400, message: '缺口区间里没有可抽样的正文（都是空章或只有标题）。' }
  }
  if (text === 'EMPTY_OUTPUT' || text === 'UNPARSABLE_OUTPUT') {
    return { status: 502, message: '模型这次的输出没能解析成背景认识。重试一次通常就好。' }
  }
  return { status: 502, message: `补齐背景认识失败：${text}` }
}

/**
 * 把压缩失败的原因翻译成 HTTP 语义与给人看的话。
 *
 * 压缩的失败模式里有三条是**安全校验主动拦下的**（保名、保号、没变小）。
 * 它们必须说清楚"我拒绝了它，你的文件没动"——否则用户会以为压缩成功了、
 * 只是没效果。
 *
 * @param {string} reason 压缩器给的失败原因
 * @returns {{ status: number, message: string }}
 */
function describeCompactFailure(reason) {
  const text = String(reason ?? '')
  if (text === 'SUBAGENTS_UNAVAILABLE') {
    return { status: 501, message: '当前部署没有可用的子代理服务，无法压缩。背景认识保持原样。' }
  }
  if (text === 'NO_LIVE_PARENT') {
    return { status: 409, message: '这个会话当前没有活的 Agent（还没发过消息，或已被回收）。先在会话里说一句话，再回来压缩。' }
  }
  if (text === 'TIMEOUT') {
    return { status: 504, message: '压缩超时。可以调大插件配置里的 memoryTimeoutMs，或先手动精简 background.md。' }
  }
  if (text === 'NO_BACKGROUND') {
    return { status: 400, message: '这本书还没有背景认识，没有可压缩的内容。' }
  }
  if (text.startsWith('COMPACT_LOST_CHARACTERS')) {
    const names = text.split(': ')[1] ?? ''
    return {
      status: 502,
      message: `压缩结果丢了人物（${names}），已**整批丢弃**，你的 background.md 一个字都没动。重试一次通常就好。`,
    }
  }
  if (text === 'COMPACT_SHRANK_COVERAGE' || text === 'COMPACT_LOST_COVERAGE') {
    return { status: 502, message: '压缩结果把覆盖区间改小了，已丢弃。你的文件保持原样。' }
  }
  if (text === 'COMPACT_NO_SHRINK') {
    return { status: 502, message: '这次压缩没能让内容变短（模型基本照抄了一遍），已丢弃，不算你一次浪费——文件没动。再点一次通常会有不同结果。' }
  }
  if (text === 'EMPTY_OUTPUT' || text === 'UNPARSABLE_OUTPUT') {
    return { status: 502, message: '模型这次的输出没能解析成背景认识。重试一次通常就好。' }
  }
  return { status: 502, message: `压缩失败：${text}` }
}

/**
 * 补齐背景认识：一次调用，处理「缺失的全部前文」这一整段。
 *
 * 单独抽出来是因为「发笔记时自动补」与「手动点按钮」两条路由共用它，而且它是
 * 唯一需要同时碰书库、记忆器与会话的地方。
 *
 * ## 一次调用能补多少
 *
 * 取决于 `sample.budgetChars` 与缺口大小。缺口太大时**只覆盖前一段**
 * （抽样器会从前往后取），水位线推到覆盖到的地方，剩下的下次再补。
 * 用户能在「陪读」页看到 `记忆到第 M 章 / 阅读到第 N 章` 的差距在缩小。
 *
 * ## 为什么压缩也塞在这里
 *
 * 因为它们共用同一个前提：**读者已经同意为这次操作等一次模型调用**。既然
 * 已经要等，把"该压缩了"顺手做掉比让用户再点一次按钮更合理。
 *
 * 顺序是**先压缩、再补缺口**：压缩会让文件变小，于是本次合并后的结果更可能
 * 留在预算内，下一次就不用再压缩。反过来做的话，刚合并完就又胖了。
 *
 * 压缩是**尽力而为**的：它失败（模型没变小、丢了人物……）不影响补齐。宁可
 * 背景认识长一点被截断，也不能因为压缩不顺就让记忆停住。
 *
 * @param {object} deps 依赖
 * @returns {Promise<object>}
 */
async function fillMemoryGap(deps) {
  const { library, memory, compactor, config, bookId, sessionId, getWebGate, mode, recentWindow: askedWindow, atChapter, ask } = deps

  const book = library.get(bookId)
  if (book === undefined) return { ok: false, reason: 'BOOK_NOT_FOUND', status: 404, message: '没有这本书。' }

  // 用哪个会话来挂子代理：优先客户端显式给的，否则用这本书绑定过的会话。
  const bound = library.bindingForBook(bookId)
  const effective = typeof sessionId === 'string' && sessionId !== '' ? sessionId : bound?.sessionId
  if (typeof effective !== 'string' || effective === '') {
    return { ok: false, reason: 'NO_SESSION', status: 400, message: '这本书还没有绑定会话，无法补齐背景认识。先在「陪读」页绑定。' }
  }

  const budgetChars = config.window.backgroundBudgetChars
  const threshold = config.window.compactThreshold

  // ---- 第一趟：够胖就先压缩 ----
  //
  // ⚠️ **这一趟刻意「算而不写」。** 压缩是整条流程里**唯一会删掉内容**的一步，
  // 而第二趟（合并）是**会失败**的一步。旧形状"先压缩落盘、再合并"有两个洞，
  // 都是 `dsh-adaptive-context` 实测踩过的形状（连续 24 批失败 → 水位永不推进）：
  //
  //   1. **压缩侧的失败必须只降级、不可致命。** 传输层的崩溃（子代理 `start`
  //      抛异常）已经被 `createSubagentRunner` 转成 `{ok:false}`，但压缩器**自己**
  //      抛（`compact.js` 里 run 之后的解析 / 校验 / 渲染）会从 `await` 处直接冒
  //      出去。⚠️ 如实说明：按现在的接线，后者**没有已知的可达路径**，所以这个
  //      `try/catch` 是**守卫**，不是已复现 bug 的修复——它钉的是一条不变式：
  //      "压缩怎么坏，都不能让水位线停住"。
  //   2. **压缩成功、合并失败**时，删过的文件已经写下去了：内容少了，缺口还在，
  //      没有任何进展换来这次损失。**这一条是已复现的真问题**（旧形状里
  //      `backgroundCompact` 的落盘就压在合并之前），由下面的"算而不写"修掉。
  //
  // 所以现在：抛异常降级成"这一次不压"，补齐照走；压缩结果先拿在手上，等合并
  // 真的成功了，再和它**一次写下去**（`backgroundMerge` 的 `base` / `backup`）。
  let compact = null
  let compacted = null
  const before = library.background(bookId)
  const weight = needsCompaction(before, { budgetChars, threshold })
  if (weight.over === true && typeof compactor === 'function') {
    try {
      const result = await compactor({
        sessionId: effective,
        bookTitle: book.title,
        markdown: before.markdown,
        doc: before,
        // 目标留出余量：压到刚好等于预算，下一次合并立刻又超。
        targetChars: Math.round(budgetChars * 0.6),
      })
      if (result.ok === true) {
        compact = {
          ok: true,
          savedChars: result.savedChars,
          beforeChars: result.beforeChars,
          afterChars: result.afterChars,
          elapsedMs: result.elapsedMs ?? 0,
          // 落盘与否在下面决定；写到这一步为止它还在内存里。
          persisted: false,
        }
        compacted = result.parsed
      } else {
        // 压缩失败不该伪装成成功，但也不该阻断补齐——如实回报原因即可。
        compact = { ok: false, reason: result.reason, elapsedMs: result.elapsedMs ?? 0 }
      }
    } catch (error) {
      // 这里是 T4 的关键一行：**压缩怎么坏，都不能让它挡住补齐**。
      // 失败方向选"这次不压"而不是"这次不补"——压缩只是省 token，补齐才是进度。
      compact = {
        ok: false,
        reason: `COMPACT_THREW: ${error?.message ?? String(error)}`,
        elapsedMs: 0,
      }
    }
  }

  // ---- 第二趟：补缺口 ----
  //
  // ⚠️ **`atChapter` = 把"边界"移到读者正在看的那一章。**
  //
  // 背景：进度此前**只在滚动时**回写（`ReaderView` 的 `flush`），于是"用目录跳到
  // 第 430 章、读首屏、没滚动"这条很常见的路径**一次都不会写盘** —— 服务端仍以为
  // 读者在第 3 章。后果不是"进度显示不准"，而是缺口算错：缺口 = 前文里还没纳入的
  // 区间，上界是**当前章的前一章**，于是它被算成 `1..2`（甚至 null），跳读闸不弹、
  // 记忆补到了错误的地方（读者实测：读第 430 章发笔记，界面一声不响）。
  //
  // 处置（读者选定）：**只在他主动的那两个动作里把边界推过去** —— 发笔记、点补齐。
  // 普通翻页与纯浏览一律不动（"偷看一眼最后一章"不该把防剧透边界也推过去）。
  // 所以这里要**落盘**：投喂（`collectReadWindow`）读的就是这个进度，而
  // **投喂与补齐必须用同一个数** —— 否则 AI 会拿到"覆盖到 429 章的记忆"、
  // 同时每轮仍被告知"你在读第 3 章"，那比现状更糟。
  if (Number.isInteger(atChapter) && atChapter >= 0) {
    library.setProgress(bookId, { chapterIndex: atChapter, charOffset: 0 })
  }
  const progress = library.getProgress(bookId)
  const progressIndex = progress?.chapterIndex ?? 0

  // 合并的底稿：压缩成了就用压缩后的，否则重新读盘（= 旧行为）。
  const doc = compacted ?? library.background(bookId)
  let gap = backgroundGap(doc.covered, progressIndex)
  // 没有缺口就直接回——这是"发笔记时顺手补"的常态，不该白花一次调用。
  if (gap === null) {
    // 这时压缩就是这一趟**唯一的成果**，得单独落盘（仍带备份）。它没换来章号
    // 进展，但它换了 token，而且没有任何失败步骤压在它后面——可以安全生效。
    if (compacted !== null) {
      const written = library.backgroundCompact(bookId, compacted)
      compact = { ...compact, backupPath: written.backupPath, persisted: true }
    }
    return { ok: true, skipped: true, covered: library.background(bookId).covered, compact, elapsedMs: 0 }
  }

  // ---- 跳读闸 ----
  //
  // 见 `config.sample.jumpGateChapters`。闸门只拦"一次补一大段"的情形；
  // 缺口本来就小、或者读者已经明确表态（`mode`）时直接放行。
  // ⚠️ 缺省必须是**开**（50），不是 0。`sample` 是整体替换的配置对象，早于这个键
  // 写下的 profile 配置里根本没有它——退成 0 等于把安全闸**静默关掉**，而"静默失效"
  // 恰恰是它要防的那类失败。要关就显式写 0。
  const gate = Number.isInteger(config.sample?.jumpGateChapters) ? config.sample.jumpGateChapters : 50
  const span = gap.to - gap.from + 1
  const asked = mode === 'all' || mode === 'recent' ? mode : null

  // ---- 两个"预算→批数"的粗算 ----
  //
  // 它们只服务**弹窗**：读者最想知道的是"要等多久、值不值"，而那是可以算出来的。
  // ⚠️ 刻意只算"批数 × 每章下限"这两个**由配置直接决定**的数，不编造耗时 ——
  // "每批几十秒"是经验值，写进代码只会随模型换代而过时。
  // ⚠️ 重点章（开头 5 章 + 卷首章）会多拿字数，所以实际一批可能**少于**这里的估值；
  // 因此这一屏的措辞必须带"约"。
  const budget = Number.isInteger(config.sample?.budgetChars) ? config.sample.budgetChars : 24000
  const allMin = Number.isInteger(config.sample?.minPerChapter) ? config.sample.minPerChapter : 150
  const recentMin = Number.isInteger(config.sample?.recentMinPerChapter) ? config.sample.recentMinPerChapter : 300
  const foundationChapters = Number.isInteger(config.sample?.foundationChapters)
    ? config.sample.foundationChapters
    : 30
  const batchOf = (min) => Math.max(1, Math.floor(budget / Math.max(1, min)))
  /**
   * 估一批数。`firstIsFoundation` 要如实算进去 —— 首次那批只吃
   * `foundationChapters` 章，漏掉它就会把"2 批"报成"1 批"。
   */
  const batchesFor = (chapters, min, firstIsFoundation) => {
    const per = batchOf(min)
    if (firstIsFoundation !== true) return Math.max(1, Math.ceil(chapters / per))
    const first = Math.min(chapters, foundationChapters)
    return chapters <= first ? 1 : 1 + Math.ceil((chapters - first) / per)
  }

  // ⚠️ 窗口**独立于闸门阈值**（v2.0.2 拆开）。优先取请求体（读者在弹窗里逐次改），
  // 再回落配置，最后兜底 200。上限 5000 是防手改请求体传一个荒唐的数。
  const configuredWindow = Number.isInteger(config.sample?.recentWindowChapters)
    ? config.sample.recentWindowChapters
    : 200
  const recentWindow = Number.isInteger(askedWindow)
    ? Math.min(Math.max(askedWindow, 10), 5000)
    : configuredWindow

  /** 这一趟是不是"自动打底"（大缺口 + 读者没表态）——回报给客户端，好把话说准。 */
  let autoFoundation = false

  if (gate > 0 && span > gate) {
    if (asked === 'recent') {
      // 「只记最近这一段」：读者从中间开始读时的正确答案。不碰前面那几百章，
      // 于是既不会把远处的条目写进文件，也不用烧掉十几次调用。
      //
      // ⚠️ 窗口比缺口还大时**夹到缺口起点**：不然 `from` 会算成 0 或负数，而章号
      // 是 1 起的（实测触发过：缺口 149 章、窗口 200）。
      gap = { from: Math.max(gap.from, gap.to - recentWindow + 1), to: gap.to }
    } else if (asked !== 'all') {
      // ---- 大缺口的两种处理（读者选定）----
      //
      // 从前这里**一律**回 409。读者实测到的后果是：发笔记那一路只拿到一句**无法
      // 操作**的文字 —— 笔记栏根本没有渲染那些选项（选项只存在于面板），于是他
      // "发了笔记，而 AI 对本章一无所知"。
      //
      // 现在按**调用方**分：
      //   · `ask === true`（面板手动点「补齐前文记忆」）→ 仍然回 409 让他选
      //     「全部纳入 / 只记最近」—— 他本来就打算补，问一句才有意义；
      //   · 其余（发笔记顺手补）→ **自动把全书开头的 `foundationChapters` 章跑完**，
      //     绝不空手而归；剩下的缺口留在那里，由他到面板手动补。
      if (ask !== true) {
        autoFoundation = true
        // ⚠️ 夹的是**全书前 N 章**，不是"缺口起点的 N 章" —— 读者明确要的是
        // "至少把 1–30 章跑完"。夹完可能是空缺口（开头早就纳入过），那条路在
        // 下面单独如实回报，不硬造一次调用。
        gap = { from: gap.from, to: Math.min(gap.to, foundationChapters) }
      } else {
        const windowSize = Math.min(recentWindow, span)
        return {
          ok: false,
          reason: 'LARGE_GAP',
          status: 409,
          message: `这次要补的是第 ${gap.from}–${gap.to} 章，共 ${span} 章，超过跳读闸（${gate} 章）。`
            + '如果这些你确实都读过了，选「全部纳入」；如果只是从这里接着读，选「只记最近这一段」——'
            + '后者不会把远处的条目写进 background.md，回到前面读时也不会被剧透。',
          gap: { from: gap.from, to: gap.to, chapters: span },
          gate,
          recentWindow,
          // 给弹窗显示的两个预估。`recent` 那一项按**窗口**算，而不是按整个缺口 ——
          // 否则"只记最近一段"会被显示成和"全部纳入"一样久，那就等于没给选择。
          estimate: {
            all: { batches: batchesFor(span, allMin, doc.covered === null), perChapter: allMin },
            recent: { window: windowSize, batches: batchesFor(windowSize, recentMin, false), perChapter: recentMin },
          },
        }
      }
    }
  }

  // 自动打底夹完可能是**空缺口**（开头那几十章早就纳入过了）：那种情况没有可补的东西，
  // 如实回一句"只剩手动补"，而不是报一个 `NO_SAMPLES` 的 400 让读者以为出错了。
  // ⚠️ 此时**不落盘压缩**：这一趟没换来任何进展 —— 与"补齐失败就不写压缩"同一条规矩。
  if (autoFoundation && gap.from > gap.to) {
    return { ok: true, skipped: true, autoFoundation: true, covered: doc.covered, elapsedMs: 0 }
  }

  // `foundation` = 这是**首次**补齐（还没有任何背景认识）。首次走"打底"模式：
  // 限制章数、把开头读厚，剩下的留到第二次。之后开头已经读厚过了，不必再照顾。
  //
  // ⚠️ 用 `covered === null` 而不是"水位线是 0"：补齐失败时 `covered` 不变，
  // 于是下一次仍然是打底模式——这是对的，第一次没成功就该重来。
  //
  // ⚠️ `mode === 'recent'` 时**强制关掉打底**：读者已经明确说了"只要最近这
  // 一段"，再把批次缩到 30 章从窗口**起点**往后读，等于把他要的那段砍掉一半。
  const sample = library.sampleChapters(bookId, gap.from - 1, gap.to - 1, {
    ...config.sample,
    // ⚠️ 「只记最近这一段」那条路用**更厚**的每章下限（见 `recentMinPerChapter`）。
    // 这一个数同时决定"每章多厚"与"一批多宽"，所以换它 = 换深度（代价是批数）。
    minPerChapter: asked === 'recent' ? recentMin : allMin,
    foundation: doc.covered === null && asked !== 'recent',
  })
  if (sample.chapters.length === 0) {
    return { ok: false, reason: 'NO_SAMPLES', status: 400, message: '缺口区间里没有可抽样的正文。' }
  }

  const result = await memory({
    sessionId: effective,
    bookTitle: book.title,
    samples: sample.chapters,
    existingMarkdown: doc.markdown,
    fromChapter: sample.from + 1,
    toChapter: sample.to + 1,
    // ⚠️ 走依赖注入而不是直接读 `config.webGate`：档位现在是**运行期**的
    // （界面上能改），这个函数在 `apply` 之外，拿不到那个闭包。
    webGate: getWebGate(),
  })
  if (result.ok !== true) {
    const described = describeMemoryFailure(result.reason)
    // 缺口没补成。压缩这一趟**刻意没有落盘**（见上）：它是唯一会删内容的一步，
    // 没换来任何进展就不该生效。如实把"压了但没写"报出去，别让读者以为文件变小了。
    if (compacted !== null) compact = { ...compact, persisted: false }
    // 缺口没补成，但压缩可能成功了——把两件事分别报出来，别让用户以为白等一场。
    return { ok: false, reason: result.reason, status: described.status, message: described.message, compact }
  }

  // 压缩与合并**共用这一次写入**：合并成功，两者一起生效；合并失败就什么都没写。
  const merged = library.backgroundMerge(bookId, result.parsed, {
    first: sample.from + 1,
    last: sample.to + 1,
  }, compacted === null ? {} : { base: compacted, backup: true })
  if (compacted !== null) {
    compact = { ...compact, backupPath: merged.backupPath ?? null, persisted: true }
  }

  // ⚠️ 刻意**不**往讨论时间线里写一条。补齐是维护动作，不是"聊过"——
  // 写进去会让"距上次聊这本书"在用户只点了个按钮之后变成「今天」，那是撒谎。
  return {
    ok: true,
    covered: merged.covered,
    compact,
    // 大缺口时**这一趟只自动补了全书开头那几十章**（读者选定）。客户端据此把话说准：
    // 不是"没补"，而是"补了开头，剩下的要手动补"。
    autoFoundation,
    sampled: {
      first: sample.from + 1,
      last: sample.to + 1,
      chapters: sample.chapters.length,
      chars: sample.totalChars,
      // 这一批**实际给出的每章额度**（重点章再乘权重）。它就是"深度"这个数 ——
      // 界面上用得到，测试也靠它把"recent 那条路更厚"钉死。
      perChapter: sample.perChapter,
    },
    partial: sample.partial,
    elapsedMs: (result.elapsedMs ?? 0) + (compact?.elapsedMs ?? 0),
  }
}

/**
 * 用宿主自己的 `workspaceRegistry` 解析某个会话的工作区目录。
 *
 * 为什么不让客户端上报：客户端其实也能拿到（槽标准注入了 `useWorkspaces`），
 * 但那要求面板正开着、且那个 hook 的契约稳定。宿主侧这条路是现成的服务
 * ——`dsh-workspace` 的 `super(ctx, "workspaceRegistry")`，`list()` **同步**
 * 返回实体数组，而每个实体的 `sessionIds` 已经按启动/实时的 canonical-cwd
 * 索引过滤好了。更可靠，也少一次往返。
 *
 * 拿不到就回 null：调用方会回落到插件目录。**绝不因为路径解析失败而丢笔记。**
 *
 * @param {object} ctx 宿主上下文
 * @param {unknown} sessionId 会话 id
 * @returns {string|null} 工作区绝对路径
 */
function workspaceDirForSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const registry = ctx.get?.('workspaceRegistry')
  if (registry === undefined || registry === null) return null
  try {
    const workspaces = registry.list()
    if (!Array.isArray(workspaces)) return null
    const wanted = normalizeSessionId(sessionId)
    if (wanted === '') return null
    const found = workspaces.find((workspace) => (workspace?.sessionIds ?? [])
      .some((id) => normalizeSessionId(id) === wanted))
    return typeof found?.path === 'string' && found.path !== '' ? found.path : null
  } catch {
    // registry 的形状变了、或底层存储在抖 —— 都不该让绑定失败。
    return null
  }
}

/**
 * 路由分发表。
 *
 * 返回值约定：{ status, body }；抛出的异常由 {@link createApiHandler} 兜成
 * 500。之所以不用框架，是因为宿主只给了裸 (req, res)，引入路由库属于无谓
 * 的依赖面——而本插件坚持零运行时依赖。
 *
 * @param {object} deps 依赖
 * @returns {Array<object>} 已编译的路由
 */
function createRoutes(deps) {
  const { storageDir, config, library, memory, compactor, settings } = deps
  /**
   * 导出目录的当前生效值。
   *
   * ⚠️ 它**必须**由 `apply` 通过 deps 传进来，不能在这里自己读一次：那个值是
   * "运行期设置 > 配置"算出来的，而设置是**随时可改**的（界面上点一下就变），
   * 在 `createRoutes` 这一层缓存成常量就等于把"改完立即生效"这条性质丢了。
   * 传函数、每次现调，和 `settings.getWebGate` 是同一个理由。
   */
  const getExportDir = typeof deps.getExportDir === 'function' ? deps.getExportDir : () => ''
  /**
   * 「现在」。
   *
   * 走依赖注入而不是直接 `new Date()`，是为了让时间感知**可被单测固定**：
   * "距上次聊过了 3 天"这种断言，只有把时钟钉死才可能稳定。生产环境用默认实现。
   */
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString()

  /** 统一的成功响应包装。 */
  const ok = (body) => ({ status: 200, body: { ok: true, ...body } })

  /**
   * 包一层错误语义：把已知的领域错误映射成 4xx，未知错误交给上层兜 500。
   *
   * @param {Function} fn 处理器
   * @returns {Function}
   */
  const guarded = (fn) => async (req, params) => {
    try {
      return await fn(req, params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = message.split(':')[0]
      if (code === 'BOOK_NOT_FOUND' || code === 'CHAPTER_NOT_FOUND' || code === 'CHAPTERS_MISSING' || code === 'DRAFT_NOT_FOUND' || code === 'NOTE_NOT_FOUND') {
        return { status: 404, body: { ok: false, error: code, message } }
      }
      if (
        code === 'BOOK_ID_INVALID'
        || code === 'PATH_NOT_RELATIVE'
        || code === 'PATH_ESCAPES_ROOT'
        || code === 'PATH_OUTSIDE_ROOT'
        || code === 'PATH_HAS_NUL'
        || code === 'PATH_TOO_LONG'
        || code === 'SESSION_ID_INVALID'
        || code === 'PROGRESS_CHAPTER_INVALID'
        || code === 'PROGRESS_OFFSET_INVALID'
        || code === 'NOTE_EMPTY'
        || code === 'NOTES_CHANGED_SINCE_READ'
        || code === 'DRAFT_BOOK_INVALID'
        || code === 'WORKSPACE_DIR_INVALID'
        || code === 'PERSONA_TOO_LONG'
        || code === 'WEB_GATE_INVALID'
        || code === 'EXPORT_DIR_NOT_ABSOLUTE'
        || code === 'EXPORT_DIR_TOO_LONG'
      ) {
        return { status: 400, body: { ok: false, error: code, message } }
      }
      if (code === 'IMPORT_REJECTED') {
        return { status: 400, body: { ok: false, error: 'IMPORT_REJECTED', reason: message.split(': ')[1] } }
      }
      if (code === 'EXPORT_REJECTED') {
        // 409 而不是 400：目标文件被**别的书**或**别的文件**占着，是"换个地方或先
        // 处理那个文件"，不是"请求参数写错了"。用 400 会把人引到错误的排查方向。
        return { status: 409, body: { ok: false, error: 'EXPORT_REJECTED', reason: message.split(': ')[1] } }
      }
      if (code === 'REVISION_CONFLICT') {
        return { status: 409, body: { ok: false, error: 'REVISION_CONFLICT', message } }
      }
      if (code === 'BOOK_NOT_BOUND' || code === 'WORKSPACE_NOT_RESOLVED' || code === 'EXPORT_DIR_REQUIRED') {
        return { status: 409, body: { ok: false, error: code, message } }
      }
      if (code === 'SESSION_ALREADY_BOUND') {
        return { status: 409, body: { ok: false, error: 'SESSION_ALREADY_BOUND', message } }
      }
      if (code === 'BODY_TOO_LARGE' || code === 'BODY_NOT_JSON') {
        return { status: 400, body: { ok: false, error: code } }
      }
      throw error
    }
  }

  const routes = [
    {
      method: 'GET',
      pattern: '/health',
      handler: () => ok({
        name,
        version: VERSION,
        // 这里曾经有一个 `phase: 'P2'`。它是 P0–P3 分阶段开发期的残留：P3（笔记）
        // 早已完成，这个字段却一直写着 'P2'，而且 test/routes.test.mjs 与
        // test/plugin.test.mjs 把它**写死断言**了——一个陈旧的标签被测试固化成契约，
        // 以后真要推进阶段反而得先改测试。阶段划分是开发期语言，不该进对外接口，
        // 所以直接删掉；版本用 `version`（从 package.json 读，不会漂移），
        // 两条测试也改成断言"version 与 package.json 一致"。
        storageDir,
        config,
        node: process.version,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
      }),
    },
    {
      method: 'GET',
      pattern: '/settings',
      handler: () => ok(settings.describe()),
    },
    {
      method: 'PUT',
      pattern: '/settings',
      handler: guarded(async (req) => ok(settings.apply(await readJsonBody(req)))),
    },
    {
      method: 'GET',
      pattern: '/library',
      handler: guarded(() => ok(library.list())),
    },
    {
      method: 'POST',
      pattern: '/library/scan',
      handler: guarded(() => ok({ entries: library.scanInbox() })),
    },
    {
      method: 'POST',
      pattern: '/library/import',
      handler: guarded(async (req) => {
        const body = await readJsonBody(req)
        const result = library.importBook({ absPath: body?.absPath, title: body?.title })
        return ok(result)
      }),
    },
    {
      method: 'DELETE',
      pattern: '/library/:bookId',
      handler: guarded((req, params) => {
        const result = library.remove(params.bookId, {
          keepNotes: new URL(req.url ?? '/', 'http://x').searchParams.get('keepNotes') === '1',
        })
        return ok(result)
      }),
    },
    {
      // 给一本书设置分类。空字符串 = 取消分类（回到「未分类」），而不是
      // "分到一个叫空字符串的类"——那会在界面上变成一个删不掉、也点不中的空分组。
      method: 'POST',
      pattern: '/library/:bookId/category',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        return ok(library.setCategory(params.bookId, body?.category))
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/chapters',
      handler: guarded((req, params) => {
        const index = library.chapters(params.bookId)
        return ok({
          bookId: params.bookId,
          strategy: index.strategy,
          warnings: index.warnings ?? [],
          // 目录只回元信息，不回正文：一本 3000 章的书回全文会炸掉面板。
          chapters: index.chapters.map((chapter) => ({
            index: chapter.index,
            title: chapter.title,
            volume: chapter.volume ?? null,
            kind: chapter.kind,
            length: chapter.length ?? chapter.endChar - chapter.startChar,
          })),
        })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/chapters/:index',
      handler: guarded((req, params) => {
        const parsed = Number.parseInt(params.index, 10)
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`CHAPTER_NOT_FOUND: ${params.index}`)
        return ok({ bookId: params.bookId, chapter: library.readChapter(params.bookId, parsed) })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/progress',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        progress: library.getProgress(params.bookId),
        binding: sessionBinding(library.bindingForBook(params.bookId)),
      })),
    },
    {
      method: 'PUT',
      pattern: '/books/:bookId/progress',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const progress = library.setProgress(params.bookId, {
          chapterIndex: body?.chapterIndex,
          charOffset: body?.charOffset,
        })
        return ok({ bookId: params.bookId, progress })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/binding',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        binding: sessionBinding(library.bindingForBook(params.bookId)),
      })),
    },
    {
      method: 'PUT',
      pattern: '/books/:bookId/binding',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        // 客户端可以显式给（手动指定位置）；没给就由宿主自己按会话解析。
        const workspaceDir = body?.workspaceDir ?? deps.workspaceDirForSession(body?.sessionId)
        const binding = library.bind(params.bookId, body?.sessionId, body?.workspaceId, workspaceDir)
        return ok({ bookId: params.bookId, binding, location: library.location(params.bookId) })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/location',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        location: library.location(params.bookId),
      })),
    },
    {
      method: 'PUT',
      pattern: '/books/:bookId/location',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        // workspaceDir 传 null / 省略 = 回到插件自己的目录（一个可逆的显式动作）。
        const workspaceDir = body === null || body.workspaceDir === undefined ? null : body.workspaceDir
        return ok({
          bookId: params.bookId,
          location: library.setCompanionDir(params.bookId, workspaceDir),
        })
      }),
    },
    {
      method: 'POST',
      pattern: '/books/:bookId/location/detect',
      handler: guarded((req, params) => {
        // 「重新检测位置」：按当前绑定的会话，用宿主的 workspaceRegistry 重新解析。
        // 给已经绑过、但当时还没记下工作区路径的书（老数据）一条一键补齐的路。
        const boundSessionId = library.location(params.bookId).boundSessionId
        if (boundSessionId === null) throw new Error('BOOK_NOT_BOUND')
        const workspaceDir = deps.workspaceDirForSession(boundSessionId)
        if (workspaceDir === null) throw new Error('WORKSPACE_NOT_RESOLVED')
        return ok({
          bookId: params.bookId,
          location: library.setCompanionDir(params.bookId, workspaceDir),
        })
      }),
    },
    {
      method: 'DELETE',
      pattern: '/books/:bookId/binding',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        unbound: library.unbind(params.bookId),
      })),
    },
    {
      // 导出：把这本书的笔记 / 背景认识 / 历代压缩前备份，写成**文件名自带书名**的
      // 一组文件，直接丢进 Obsidian 之类的笔记软件即可（见 host/export.js 的文件头）。
      //
      // 目标目录的优先级（这是本路由唯一的"聪明"之处）：
      //   1. 请求体里的 `dir`（界面上的路径框，用户临时改一次）
      //   2. 运行期设置 / cordis 配置里的 `exportDir`（"我永远导到这里"）
      //   3. **这本书绑定会话的工作区根** —— 算不出前两个时的兜底，它通常就在
      //      用户的笔记库旁边，比任何全局默认值都合理
      // 三个都拿不到就报 EXPORT_DIR_REQUIRED（409），而不是悄悄导到一个别的地方。
      method: 'POST',
      pattern: '/books/:bookId/export',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const requested = typeof body?.dir === 'string' && body.dir.trim() !== '' ? body.dir.trim() : null
        const configured = getExportDir()

        let dir = requested ?? configured
        let origin = requested !== null ? 'request' : 'settings'
        if (dir === '') {
          const boundSessionId = library.location(params.bookId).boundSessionId
          const workspaceDir = boundSessionId === null ? null : deps.workspaceDirForSession(boundSessionId)
          if (typeof workspaceDir !== 'string' || workspaceDir === '') throw new Error('EXPORT_DIR_REQUIRED')
          dir = workspaceDir
          origin = 'workspace'
        }

        const report = library.exportBook(params.bookId, { dir })
        const book = library.get(params.bookId)
        return ok({ bookId: params.bookId, title: book?.title ?? '', origin, ...report })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/notes',
      handler: guarded((req, params) => {
        // 分页参数从 query string 取，而不是从 body —— 这是 GET，且面板要能
        // 直接把它渲进链接语义里（"更旧的一页"）。
        const query = new URL(req.url ?? '/', 'http://x').searchParams
        return ok({
          bookId: params.bookId,
          ...library.notesPage(params.bookId, {
            limit: query.get('limit'),
            before: query.get('before'),
            // `?trashed=1` = 看回收站（v1.55）。默认 false = 只看还在用的笔记；
            // 两种口径都在 `notesPage` 里实现，这里只负责把参数带过去。
            trashed: query.get('trashed') === '1',
          }),
        })
      }),
    },
    {
      // 「这一章我记过什么」—— 正文页每翻一章问一次的取值范围查询。
      //
      // 刻意**不**做成 `/notes?chapter=`：那会把"按时间翻页"与"按章取全集"两种
      // 语义塞进同一个分页入口，而它们的次序与游标含义完全不同。分成两条路由，
      // 各自的契约都还是干净的。
      //
      // 没有这一章的笔记 → 200 + 空数组（大多数章本来就没记过，不是错误）。
      method: 'GET',
      pattern: '/books/:bookId/notes/chapter/:index',
      handler: guarded((req, params) => {
        const parsed = Number.parseInt(params.index, 10)
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`CHAPTER_NOT_FOUND: ${params.index}`)
        return ok({
          bookId: params.bookId,
          chapterIndex: parsed,
          notes: library.notesForChapter(params.bookId, parsed),
        })
      }),
    },
    {
      method: 'POST',
      pattern: '/books/:bookId/notes',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const written = library.writeNote(params.bookId, body ?? {})
        // 笔记落盘 = 一次真实的"我在这里想过什么"，所以它进讨论时间线。
        // 这是**服务端**记的，不依赖客户端有没有记得上报——即使面板被关掉、
        // 或者用户从别处调用这条 API，时间线也不会漏。
        library.recordDiscussion(params.bookId, {
          kind: 'note',
          chapterIndex: Number.isInteger(body?.chapterIndex) ? body.chapterIndex : null,
          chapterTitle: body?.chapterTitle,
          excerpt: body?.excerpt,
          thought: body?.thought,
          reply: body?.reply,
        })
        return ok({ bookId: params.bookId, written })
      }),
    },
    {
      // 进回收站（v1.55）。**纯追加**：只在 `notes.md` 文件尾加一条标记，既不读也不改
      // 既有字节 —— 所以读者同时在 Obsidian 里编辑也不会丢字；随时可以一键恢复 ✓。
      method: 'POST',
      pattern: '/books/:bookId/notes/:noteId/trash',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        note: library.trashNote(params.bookId, params.noteId),
      })),
    },
    {
      // 从回收站恢复（同样是纯追加）。
      method: 'POST',
      pattern: '/books/:bookId/notes/:noteId/restore',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        note: library.restoreNote(params.bookId, params.noteId),
      })),
    },
    {
      // **彻底删除 / 清空回收站**：全插件第二处"读-改-写"（第一处是背景认识的压缩），
      // 纪律见 `library.purgeNotes`：先备份 → 写前核对文件没被别人改过 → 才写。
      // body：`{ ids: [...] }` 删指定几条，或 `{ all: true }` 清空当前回收站。
      method: 'POST',
      pattern: '/books/:bookId/notes/purge',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const ids = body?.all === true
          ? library.trashedNoteIds(params.bookId)
          : (Array.isArray(body?.ids) ? body.ids : [])
        return ok({ bookId: params.bookId, purged: library.purgeNotes(params.bookId, ids) })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/drafts',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        drafts: library.listDrafts(params.bookId),
      })),
    },
    {
      method: 'POST',
      pattern: '/books/:bookId/drafts',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const draft = library.saveDraft({ ...(body ?? {}), bookId: params.bookId })
        // 打 tag 建议随草稿一起回：面板直接填进 tag 框，用户可改。
        return ok({
          bookId: params.bookId,
          draft,
          suggestedTags: suggestTags({
            excerpt: draft.excerpt,
            thought: draft.thought,
            reply: draft.reply,
          }),
        })
      }),
    },
    {
      method: 'DELETE',
      pattern: '/books/:bookId/drafts/:draftId',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        removed: library.removeDraft(params.draftId),
      })),
    },
    {
      method: 'POST',
      pattern: '/books/:bookId/drafts/:draftId/commit',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        return ok({
          bookId: params.bookId,
          // attachReply 必须由客户端显式传 true —— 这是「AI 回应默认不落盘」
          // 在协议层的落点：省略或 false 都写不进去。
          written: library.writeNoteFromDraft(params.bookId, params.draftId, {
            attachReply: body?.attachReply === true,
          }),
        })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/background',
      handler: guarded((req, params) => {
        const doc = library.background(params.bookId)
        const progress = library.getProgress(params.bookId)
        // ⚠️ `atChapter`（查询参数）：面板知道读者**正在看**哪一章，而落盘的进度可能
        // 停在很久以前（进度只在滚动与两个主动动作时回写）。缺口按"正在看的那一章"
        // 算，按钮才不会明明是空的却点不动、显示也不会自相矛盾。
        // **这里只算不写** —— 落盘由补齐那条路负责（读者选定：普通翻页不动边界）。
        const at = new URL(req.url ?? '/', 'http://x').searchParams.get('atChapter')
        const parsedAt = at === null ? null : Number.parseInt(at, 10)
        const progressIndex = Number.isInteger(parsedAt) && parsedAt >= 0
          ? parsedAt
          : (progress?.chapterIndex ?? 0)
        return ok({
          bookId: params.bookId,
          covered: doc.covered,
          updated: doc.updated,
          // 缺口：前文里还没纳入认识的连续区间（1 起章号）。
          gap: backgroundGap(doc.covered, progressIndex),
          characters: Object.keys(doc.characters ?? {}),
          // 「人物卡」：把背景认识按实体归堆、并按"读者读到第几章"过滤后的只读视图。
          // ⚠️ 与上面的 `gap` 用**同一个** `progressIndex`（它已经把 `?atChapter` 算进去了）
          // —— 界面上的"记忆到第几章 / 缺口"和这里的卡片必须是同一条边界。
          cards: entityCardsFor(doc, progressIndex),
          markdown: doc.markdown,
          exists: doc.exists,
          // 面板要用它把「防剧透闸」那一段说准。档位是运行期设置（界面可改），
          // 不是每本书的状态，但面板只会读这一个响应里的它，所以在这里回。
          webGate: settings.getWebGate(),
          // 这本书读者是否已声明读完（v1.45）。面板据此显示常驻横幅、并决定
          // 「解锁 / 收回」按钮的形态；**未读完一律 false**（fail-safe）。
          finished: library.isFinished(params.bookId),
        })
      }),
    },
    {
      // 「已读完」标记（v1.45）：读者声明读完之后，**这一本**的原始文本不再算剧透。
      //
      // ⚠️ 这是全插件**唯一会放松**那条硬规则的地方，所以三条边界写在这里：
      //   · **默认锁定** —— 没有标记就是锁着（判定侧 fail-safe，缺函数/抛错都按锁）；
      //   · **只影响这一本** —— 判定用工具参数里捕获的 bookId 精确匹配；
      //   · **收回立即生效** —— 判定每次现读，没有缓存窗口。
      // 界面上的"解锁要二次确认"由客户端负责；这里只做状态落盘。
      method: 'POST',
      pattern: '/books/:bookId/finished',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const { finishedAt } = library.setFinished(params.bookId, body?.finished === true)
        return ok({ bookId: params.bookId, finished: finishedAt !== null, finishedAt })
      }),
    },
    {
      // ⚠️ 这条是**阻塞**的：用户明确选了"愿意等几十秒"。宿主没有旁路重试，
      // 超时由 memory.js 自己 race 掉，所以这里不会无限挂住。
      method: 'POST',
      pattern: '/books/:bookId/background/fill',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const result = await fillMemoryGap({
          library,
          memory,
          compactor,
          config,
          bookId: params.bookId,
          sessionId: body?.sessionId,
          // 跳读闸的三选一：「全部纳入」= 'all'，「只记最近这一段」= 'recent'，
          // 不给（或给了别的值）= 闸门自己判断。
          mode: body?.mode,
          // 读者在弹窗里选的窗口大小（可选）。不合法就由闸门回落到配置默认。
          recentWindow: body?.recentWindow,
          // 读者**正在看**的那一章（0 起）。只有"发笔记 / 点补齐"这两个主动动作会带它，
          // 服务端据此把进度推到那一章再算缺口（见 `fillMemoryGap` 里的长注释）。
          atChapter: body?.atChapter,
          // `ask: true` = "我是**主动**来补的"（面板那颗「补齐前文记忆」）。
          // 只有它会撞上跳读闸的 409 与那些选项；发笔记那一路走自动打底。
          ask: body?.ask === true,
          getWebGate: settings.getWebGate,
        })
        if (result.ok !== true) {
          return {
            status: result.status ?? 502,
            body: {
              ok: false,
              error: result.reason,
              message: result.message,
              compact: result.compact ?? null,
              // 跳读闸专用：客户端据此渲染「全部纳入 / 只记最近这一段」两个选择，
              // 外加两个预估（约几批 / 每章约多少字）。
              gap: result.gap ?? null,
              gate: result.gate ?? null,
              recentWindow: result.recentWindow ?? null,
              estimate: result.estimate ?? null,
            },
          }
        }
        const doc = library.background(params.bookId)
        const progress = library.getProgress(params.bookId)
        return ok({
          bookId: params.bookId,
          // skipped = 缺口本来就没有，补齐那一次调用没花。压缩可能仍然跑了。
          skipped: result.skipped === true,
          // compact: { ok, savedChars, ... } 或 { ok:false, reason } 或 null（本来就不胖）
          compact: result.compact ?? null,
          sampled: result.sampled ?? null,
          partial: result.partial === true,
          // 这次是"大缺口 + 没表态"→ **只自动补了全书开头那几十章**。客户端靠它把话说准：
          // 不是"没补"，而是"补了开头，剩下的要手动补"。
          autoFoundation: result.autoFoundation === true,
          elapsedMs: result.elapsedMs ?? 0,
          covered: doc.covered,
          gap: backgroundGap(doc.covered, progress?.chapterIndex ?? 0),
        })
      }),
    },
    {
      method: 'POST',
      pattern: '/books/:bookId/background/reset',
      handler: guarded((req, params) => ok({
        bookId: params.bookId,
        background: library.backgroundReset(params.bookId),
      })),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/context',
      handler: guarded((req, params) => {
        // 「AI 视角预览」：把防剧透层真正要投喂的东西原样回给用户看。
        // 透明性是这个功能能不能被信任的前提——用户必须能亲眼验证
        // 「模型确实只看到了我读过的部分」。
        const readWindow = library.collectReadWindow(params.bookId, config.window)
        const background = library.background(params.bookId)
        const persona = library.persona(params.bookId)
        const discussions = library.listDiscussions(params.bookId, config.window.discussionLimit)
        const section = renderCompanionSection({
          window: readWindow,
          title: readWindow.title,
          progress: readWindow.progress,
          totalChapters: readWindow.totalChapters,
          backgroundText: readWindow.backgroundText,
          backgroundCovered: background.covered,
          persona,
          discussions,
          lastDiscussionAt: readWindow.lastDiscussionAt,
          now: now(),
          hasBackground: background.covered !== null,
          webGate: settings.getWebGate(),
        })
        return ok({
          bookId: params.bookId,
          section,
          summary: describeWindow(section, readWindow, {
            personaChars: persona.trim().length,
            discussionCount: discussions.length,
          }),
          // 压缩建议：超预算且还没压缩时，面板据此把「压缩」按钮点亮并解释原因。
          backgroundWeight: needsCompaction(background, {
            budgetChars: config.window.backgroundBudgetChars,
            threshold: config.window.compactThreshold,
          }),
        })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/persona',
      handler: guarded((req, params) => {
        const text = library.persona(params.bookId)
        return ok({
          bookId: params.bookId,
          text,
          chars: text.length,
          path: library.location(params.bookId).personaPath,
        })
      }),
    },
    {
      method: 'PUT',
      pattern: '/books/:bookId/persona',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const saved = library.setPersona(params.bookId, body?.text)
        return ok({ bookId: params.bookId, ...saved, path: library.location(params.bookId).personaPath })
      }),
    },
    {
      method: 'GET',
      pattern: '/books/:bookId/discussions',
      handler: guarded((req, params) => {
        // `limit` 来自 URL，是**外部输入**：`normalizeDiscussionLimit` 负责
        // 夹上限（光判正数的话，`?limit=100000` 足以让宿主切片整份文件再回传）。
        const limit = normalizeDiscussionLimit(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'))
        // total 必须是**未截断**的总数：面板靠它把「只显示最近几条」讲清楚。
        const page = library.discussionPage(params.bookId, limit)
        return ok({ bookId: params.bookId, discussions: page.items, total: page.total })
      }),
    },
    {
      method: 'POST',
      pattern: '/books/:bookId/discussions',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        // 「讨论历史」由客户端在几个明确时刻回报：发到会话、抓取回应。
        // 它们都不是"笔记落盘"这个动作的副产物，所以必须在客户端显式触发。
        return ok({ bookId: params.bookId, recorded: library.recordDiscussion(params.bookId, body ?? {}) })
      }),
    },
    {
      // 手动压缩。自动压缩在补齐流程里（见 fillMemoryGap），这条是给"我就是想
      // 现在压一下"以及"自动压缩失败了想重试"用的。
      method: 'POST',
      pattern: '/books/:bookId/background/compact',
      handler: guarded(async (req, params) => {
        const body = await readJsonBody(req)
        const book = library.get(params.bookId)
        if (book === undefined) throw new Error(`BOOK_NOT_FOUND: ${params.bookId}`)
        const bound = library.bindingForBook(params.bookId)
        const effective = body?.sessionId ?? bound?.sessionId
        if (typeof effective !== 'string' || effective === '') {
          return { status: 400, body: { ok: false, error: 'NO_SESSION', message: '这本书还没有绑定会话，无法压缩。' } }
        }

        const before = library.background(params.bookId)
        // 手动压缩是**用户主动要做的事**，所以失败必须是他能读懂的失败——不能是
        // 一个从 `await` 里冒出去的裸异常（那在界面上会变成一句无信息量的报错）。
        let result
        try {
          result = await compactor({
            sessionId: effective,
            bookTitle: book.title,
            markdown: before.markdown,
            doc: before,
            targetChars: Math.round(config.window.backgroundBudgetChars * 0.6),
          })
        } catch (error) {
          return {
            status: 502,
            body: {
              ok: false,
              error: 'COMPACT_THREW',
              message: `压缩调用本身出错了，背景认识未被改动：${error?.message ?? String(error)}`,
            },
          }
        }
        if (result.ok !== true) {
          const described = describeCompactFailure(result.reason)
          return { status: described.status, body: { ok: false, error: result.reason, message: described.message } }
        }
        const written = library.backgroundCompact(params.bookId, result.parsed)
        const after = library.background(params.bookId)
        return ok({
          bookId: params.bookId,
          savedChars: result.savedChars,
          beforeChars: result.beforeChars,
          afterChars: result.afterChars,
          backupPath: written.backupPath,
          elapsedMs: result.elapsedMs ?? 0,
          covered: after.covered,
        })
      }),
    },
    {
      method: 'GET',
      pattern: '/session/:sessionId/book',
      handler: guarded((req, params) => {
        const bookId = library.bookForSession(params.sessionId)
        return ok({ sessionId: params.sessionId, bookId: bookId ?? null })
      }),
    },
  ]

  return routes.map((route) => ({ ...route, ...compilePattern(route.pattern) }))
}

/**
 * 把路由表包成宿主 webServer 认的裸 handler。
 *
 * @param {Array<object>} routes 已编译的路由
 * @returns {(req: any, res: any) => Promise<void>}
 */
function createApiHandler(routes) {
  return async (req, res) => {
    // 只看 pathname：查询串交给各路由自己按需解析。
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: 'BAD_URL' })
      return
    }

    // 去掉共同前缀，得到路由表里的短路径（'' 归一成 '/'）。
    const suffix = pathname.startsWith(API_ROOT) ? pathname.slice(API_ROOT.length) : pathname
    const normalized = suffix === '' ? '/' : suffix
    const method = req.method ?? 'GET'

    let pathMatched = false
    for (const route of routes) {
      const matched = route.re.exec(normalized)
      if (matched === null) continue
      pathMatched = true
      if (route.method !== method) continue

      const params = {}
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(matched[i + 1])
      })

      try {
        const { status, body } = await route.handler(req, params)
        sendJson(res, status, body)
      } catch (error) {
        // 绝不把栈暴露给浏览器面；只回一个可定位的错误码。
        sendJson(res, 500, {
          ok: false,
          error: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    // 路径存在但方法不对 → 405，比笼统的 404 更好定位。
    sendJson(res, pathMatched ? 405 : 404, {
      ok: false,
      error: pathMatched ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
      route: `${method} ${normalized}`,
    })
  }
}

/**
 * 合并配置。
 *
 * 嵌套对象（`window` / `sample`）单独深合并：浅合并会让 patch 里只写其中一个
 * 字段就把其余全抹成 undefined。
 *
 * `webGate` 在这里**归一化**：写错了就回落到最严的 `'block-all'`。
 * 闸门是防剧透用的，一个配置笔误不该把它悄悄关掉；而且归一化之后，
 * 下游（`webGateReason`）就不必再对非法值做判断。
 *
 * @param {object|undefined} rawConfig patch 行上的 config
 * @returns {object} 完整配置
 */
function resolveConfig(rawConfig) {
  const raw = rawConfig ?? {}
  return {
    ...DEFAULTS,
    ...raw,
    webGate: WEB_GATE_MODES.includes(raw.webGate) ? raw.webGate : DEFAULTS.webGate,
    // 归一化白名单：非字符串 / 空串一律丢掉。否则 `['']` 会变成"限制到空目录"，
    // 拒绝一切导入——而界面上看起来像 bug，不像配置。
    importRoots: (Array.isArray(raw.importRoots) ? raw.importRoots : DEFAULTS.importRoots)
      .filter((root) => typeof root === 'string' && root.trim() !== ''),
    // 导出目录：非字符串或空白一律回落到默认（空串 = 由路由回落到会话工作区根）。
    exportDir: typeof raw.exportDir === 'string' ? raw.exportDir.trim() : DEFAULTS.exportDir,
    window: { ...DEFAULTS.window, ...(raw.window ?? {}) },
    sample: { ...DEFAULTS.sample, ...(raw.sample ?? {}) },
  }
}

/**
 * cordis 插件体。
 *
 * @param {object} ctx 宿主上下文（已物化 inject 里声明的服务）
 * @param {object} [rawConfig] cordis.patch.yml 行上的 config
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const storageDir = resolveStorageDir(ctx, config)

  const library = createLibrary({
    storageDir,
    fallbackBlockChars: config.fallbackBlockChars,
    importRoots: config.importRoots,
    logger: ctx.logger ?? {},
  })
  library.ensureDirs()

  /**
   * 运行期设置的缓存。
   *
   * 启动时读一次盘，之后只由 `/settings` 的写入路由更新。
   *
   * ⚠️ 刻意**不**在 `effectiveWebGate()` 里每次读文件：联网闸的守卫回调是
   * **每次工具调用**都跑的，热路径上一次同步 fs 读不划算。代价是**手动**编辑
   * `settings.json` 需要重启才生效——这笔交换划算，因为改档位的正常路径是
   * 界面上的开关，而那条路径会同步更新这个缓存。
   */
  const initialSettings = library.readSettings()
  const settingsCache = {
    webGate: initialSettings.webGate,
    exportDir: initialSettings.exportDir,
  }

  /**
   * 联网档位的**运行期**值。
   *
   * 优先级：设置（界面改的）> 配置（`cordis.yml`）> 已归一化的默认。
   *
   * ⚠️ 必须在**每次**用到档位时现调，不能把结果存进常量：守卫回调每次工具调用
   * 都跑，现读才能让切档位**立即生效、不必重启**。
   *
   * 归一化也在这里：`settings.json` 被手动改坏时只**回落**到配置值，不会静默
   * 把闸门打开。
   *
   * @returns {string} 三档之一
   */
  function effectiveWebGate() {
    return WEB_GATE_MODES.includes(settingsCache.webGate) ? settingsCache.webGate : config.webGate
  }

  /**
   * 导出目录的**运行期**值。
   *
   * 优先级：设置（界面改的）> 配置 > `''`。
   *
   * `''` 的含义是"没有配"，由导出路由**现算**成"这本书绑定会话的工作区根"——
   * 那个位置通常就在用户的笔记库旁边，比任何全局默认值都合理。配置项算不出这一点
   * （它是全局的，"哪本书"它不知道），所以真正的默认值只能放在路由那一层。
   *
   * @returns {string} 目录，或空串表示"没配"
   */
  function effectiveExportDir() {
    const fromSettings = settingsCache.exportDir
    if (typeof fromSettings === 'string' && fromSettings.trim() !== '') return fromSettings
    return typeof config.exportDir === 'string' ? config.exportDir : ''
  }

  /**
   * 设置控制器（给路由用）。
   *
   * 写入时**同时**落盘与更新缓存，所以界面上的改动是立即生效的。
   */
  const settings = {
    /**
     * 取当前生效的档位。
     *
     * ⚠️ 必须作为**函数**暴露出去，不能把值传出去：路由和守卫都在别的函数里，
     * 拿到的是调用时刻的值；传值会在切换档位后继续用旧值。
     */
    getWebGate: effectiveWebGate,

    describe: () => ({
      webGate: settingsCache.webGate,
      effectiveWebGate: effectiveWebGate(),
      configWebGate: config.webGate,
      modes: [...WEB_GATE_MODES],
      path: library.readSettings().path,
      note: 'webGate 为 null 表示跟随 cordis.yml 里的配置值。',
      // 导出目录：null = 没设过；effectiveExportDir 为空串 = 由导出路由回落到
      // 这本书绑定会话的工作区根。
      exportDir: settingsCache.exportDir,
      effectiveExportDir: effectiveExportDir(),
      exportDirMaxChars: EXPORT_DIR_MAX_CHARS,
    }),

    /**
     * 改设置。`webGate: null` 或空串 = **清除覆盖**（回到跟随配置），不是一个
     * 叫 "null" 的档位。`exportDir` 同理：空串/null = 清除，回到"由路由现算"。
     *
     * @param {object} patch 要改的字段
     * @returns {object} 改完之后的状态
     */
    apply: (patch) => {
      if (patch !== null && typeof patch === 'object' && 'webGate' in patch) {
        const raw = patch.webGate
        if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          library.writeSettings({ webGate: null })
          settingsCache.webGate = null
        } else {
          if (!WEB_GATE_MODES.includes(raw)) {
            throw new Error(`WEB_GATE_INVALID: ${String(raw)}`)
          }
          library.writeSettings({ webGate: raw })
          settingsCache.webGate = raw
        }
      }
      if (patch !== null && typeof patch === 'object' && 'exportDir' in patch) {
        const raw = patch.exportDir
        if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          library.writeSettings({ exportDir: null })
          settingsCache.exportDir = null
        } else {
          if (typeof raw !== 'string') throw new Error(`EXPORT_DIR_NOT_ABSOLUTE: ${String(raw)}`)
          const trimmed = raw.trim()
          // ⚠️ 超长**报错，不静默截断**：被砍掉尾巴的路径会安静地指向别的地方。
          if (trimmed.length > EXPORT_DIR_MAX_CHARS) {
            throw new Error(`EXPORT_DIR_TOO_LONG: ${trimmed.length}`)
          }
          // 相对路径一律拒绝：导出目录会用 `join` 拼，相对路径拼出来的东西跟着
          // 进程的工作目录走——那是"文件导到别处去了"最常见的一种成因。
          if (!isAbsolute(trimmed)) throw new Error(`EXPORT_DIR_NOT_ABSOLUTE: ${trimmed}`)
          library.writeSettings({ exportDir: trimmed })
          settingsCache.exportDir = trimmed
        }
      }
      return settings.describe()
    },
  }

  /**
   * 记忆补齐器（背景认识）。
   *
   * ⚠️ `subagents` / `agents` 走 `ctx.get` 而不是 `inject`：cordis 的 inject
   * **只有必选没有可选**，注进去等于"宿主没有子代理时整个插件不加载"——
   * 陪读本身不该因为一个锦上添花的记忆功能而消失。拿不到就优雅降级，
   * 背景认识停在那里，正文照常投喂。
   */
  const memory = createMemoryFiller({
    getSubagents: () => ctx.get('subagents'),
    getAgent: (sessionId) => ctx.get('agents')?.get?.(sessionId),
    logger: ctx.logger ?? {},
    timeoutMs: config.memoryTimeoutMs,
  })

  /**
   * 背景压缩器。
   *
   * 与记忆补齐共用同一套子代理机制（`subagent-run.js`），区别只在提示词与
   * 输出校验：补齐是"往上加"，压缩是"往下减"。减东西危险，所以压缩的输出要
   * 过三道安全校验（保名 / 保号 / 真的变小）。
   */
  const compactor = createCompactor({
    getSubagents: () => ctx.get('subagents'),
    getAgent: (sessionId) => ctx.get('agents')?.get?.(sessionId),
    logger: ctx.logger ?? {},
    timeoutMs: config.memoryTimeoutMs,
  })

  const routes = createRoutes({
    storageDir,
    config,
    library,
    memory,
    compactor,
    settings,
    // 传函数而不是值：导出目录随时可能在界面上被改（同 settings.getWebGate 的理由）。
    getExportDir: effectiveExportDir,
    workspaceDirForSession: (id) => workspaceDirForSession(ctx, id),
  })

  // 注册即返回 disposer；交给 ctx.effect 托管，插件停用/更新时自动摘除路由。
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_ROOT, handler: createApiHandler(routes) }),
    'dsh-reading-companion: api routes',
  )

  // 暴露服务面，供未来的子插件或脚本复用。
  ctx.effect(() => ctx.provide('readingCompanion', { library, config, storageDir }), 'dsh-reading-companion: service')

  //#region 防剧透 · 正向：按进度投喂

  /**
   * system 段落回调。
   *
   * 全局注册、按会话自我否决：只有 `context.agent.session.id` 能反查到绑定
   * 书籍时才产出文本，其余会话拿到空串（= 对它们毫无影响）。
   *
   * @param {object} context 装配上下文 { agent, scope, signal? }
   * @returns {string} 段落文本；非陪读会话回空串
   */
  const companionSection = (context) => {
    try {
      // agent 侧是裸 UUID，绑定侧可能带 `session-` 前缀，所以交给
      // bookForSession 做归一化匹配，这里不做任何字符串假设。
      const sessionId = context?.agent?.session?.id ?? context?.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') return ''

      const bookId = library.bookForSession(sessionId)
      if (bookId === undefined) return ''

      const readWindow = library.collectReadWindow(bookId, config.window)
      const background = library.background(bookId)
      return renderCompanionSection({
        window: readWindow,
        title: readWindow.title,
        progress: readWindow.progress,
        totalChapters: readWindow.totalChapters,
        // 背景认识的文本已经在 collectReadWindow 里按预算渲染过（并转义过）。
        backgroundText: readWindow.backgroundText,
        backgroundCovered: background.covered,
        // 书友设定与讨论时间线也来自 readWindow——它们同样是"每本书一份"的状态，
        // 走同一条读取路径可以保证面板预览与实际注入**看到的是同一份东西**。
        persona: readWindow.persona,
        discussions: readWindow.discussions,
        lastDiscussionAt: readWindow.lastDiscussionAt,
        // ⚠️ 时间感知在**动态区**，且只到"日"粒度：它每轮都可能变，所以绝不能
        // 混进上面的稳定前缀，否则缓存每轮失效（见 renderPolicy 的说明）。
        now: new Date().toISOString(),
        hasBackground: background.covered !== null,
        webGate: effectiveWebGate(),
      })
    } catch (error) {
      // ⚠️ 段落回调抛错会让**整次 prompt 装配失败**，把用户正常的一轮对话
      // 一起毁掉。所以这里永远吞掉异常：拿不出上下文时退回"没有贡献"。
      ctx.logger?.warn?.(`[reading] companion section failed: ${error?.message ?? String(error)}`)
      return ''
    }
  }

  ctx.effect(
    () => ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: companionSection }),
    'dsh-reading-companion: companion section',
  )

  //#endregion

  //#region 防剧透 · 反向：拒绝绕过投喂的读取

  /**
   * 工具闸。
   *
   * ⚠️ 关于失败方向，这里做了一个**刻意的取舍**：
   *   `tools.guard` 是全局注册的，一旦守卫自身抛错就"失败即拒绝"，会把
   *   **所有会话的所有工具**一起锁死——那是比剧透严重得多的故障。所以这里
   *   选择失败即放行 + 大声记日志。
   *   支撑这个选择的依据是：正向投喂（上面的段落）本身永远不会**多给**
   *   内容，它只会少给；工具闸是第二道防线，坏掉时退化到"AI 不主动去翻"，
   *   而不是"AI 被喂了后续剧情"。
   *
   * 把 `bookForSession` 的异常一并挡在这里，是为了让这条 catch 成为真正
   * 不会走到的路径。
   *
   * 书名人物的名单从**背景认识**里取——它们是 `block-book` 档位识别
   * "这次查询是不是在查这本书"的依据。取不到就只用书名与信号词。
   */
  ctx.effect(
    () => ctx.tools.guard((execution) => {
      try {
        const bookIdForSession = (sessionId) => {
          try {
            return library.bookForSession(sessionId)
          } catch {
            return undefined
          }
        }
        let bookTitles = []
        let characterNames = []
        try {
          const sessionId = execution?.agent?.session?.id ?? execution?.agent?.id
          const bound = typeof sessionId === 'string' ? bookIdForSession(sessionId) : undefined
          if (typeof bound === 'string') {
            const book = library.get(bound)
            const doc = library.background(bound)
            if (book !== undefined) bookTitles = [book.title]
            characterNames = Object.keys(doc.characters ?? {})
          }
        } catch {
          /* 拿不到名单就退化成只用书名/信号词，不该影响放行判定 */
        }
        return spoilerGuardReason(execution, {
          enabled: config.spoilerGate !== false,
          webGate: effectiveWebGate(),
          bookIdForSession,
          bookTitles,
          characterNames,
          // ⚠️ **每次现读，不缓存**：读者在界面上收回解锁之后，**下一次工具调用**
          // 就重新锁上。缺省即锁定（见 `spoilerGuardReason` 里的 fail-safe）。
          isBookFinished: (bookId) => library.isFinished(bookId),
        })
      } catch (error) {
        ctx.logger?.error?.(`[reading] spoiler guard failed (failing open): ${error?.message ?? String(error)}`)
        return undefined
      }
    }),
    'dsh-reading-companion: spoiler guard',
  )

  //#endregion

  //#region 背景更新 · 从 durable 事件流读（T1-②）

  /**
   * 背景更新观察者。
   *
   * ## 为什么订阅 `session/event` 而不是 `agent/assistant-stream`
   *
   * 后者是**进程内**的流式发布，逐帧、且只对"正在流的那一次"有意义；前者是
   * 宿主的 durable 追加流，消息**落盘之后**才来一次，与上下文压缩无关。
   * 本功能要的是后者：读者的指正可能发生在九轮之前，那一轮早已不在"模型可见面"
   * 里了——从可见面读会漏掉恰好最该被记住的那句（§187 的硬约束）。
   *
   * ## 作用域
   *
   * 观察者注册在插件根 fiber，拿到的是**全部会话**的追加事件；具体是不是陪读会话
   * 由 `bookForSession` 在回调里判定。这与 system 段落"全局注册、按会话自我否决"
   * 是同一套做法——挂载点只有一个，判定点也只有一个。
   *
   * `session/event` 对观察者的失败已经是"记日志并隔离"，但这条回调会被
   * **每一次消息追加**触发，所以 `handleEvent` 自己再兜一层异常：一条背景更新的
   * 解析失败绝不该影响读者正在进行的对话。
   */
  const updateWatcher = createBackgroundUpdateWatcher({ library, logger: ctx.logger ?? {} })

  ctx.effect(
    // `ctx.on` 自带 disposer；交给 ctx.effect 托管，插件停用/更新时自动摘除。
    () => ctx.on('session/event', (session, event) => {
      updateWatcher.handleEvent(session, event)
    }),
    'dsh-reading-companion: background update watcher',
  )

  //#endregion

  ctx.logger?.info?.(
    `[reading] host half mounted — api=${API_ROOT} storage=${storageDir} spoilerGate=${config.spoilerGate !== false}`,
  )
}
