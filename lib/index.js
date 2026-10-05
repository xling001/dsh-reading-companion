/**
 * dsh-reading-companion — 宿主（Node）半边。
 *
 * 职责边界（见 docs/design-v1-archive.md）：
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
import { dirname, isAbsolute, join } from 'node:path'

import { createLibrary } from './host/library.js'
import { DEFAULT_LONG_CHAPTER_SPLIT } from './host/chapters.js'
import { writeAutoBackup } from './host/export.js'
import { suggestTags } from './host/tags.js'
import { applyArchive, backgroundGap, countBeyondProgress, entityCardsFor, needsCompaction } from './host/background.js'
import { createCompactor } from './host/compact.js'
import { createBackgroundUpdateWatcher } from './host/background-update.js'
import { createMemoryFiller } from './host/memory.js'
import { normalizeDiscussionLimit } from './host/discussions.js'
import {
  WEB_GATE_MODES,
  describeWindow,
  normalizeSessionId,
  renderCompanionSection,
  sameSessionKey,
  spoilerGuardReason,
} from './host/spoiler.js'
import { HOST_DEFAULTS } from './host/defaults.js'
import { fillMemoryGap } from './host/memory-pipeline.js'

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
  /**
   * 收件箱目录（面板上「把 .txt 放进哪里」那个地址，也就是「扫描导入目录」真扫的地方）。
   *
   * 相对路径 → 相对 `storageDir`；绝对路径 → 原样使用（想放别的盘、或放一个
   * 看得见的目录时用这个写法）。解析在 `resolveInboxDir`（`lib/host/library.js`）。
   *
   * ⚠️ **这个键曾经是句空话**：它从 v1.0 起就写在 schema 与 `cordis.patch.yml`
   * 里，却从来没被传进 `createLibrary`，宿主一直写死 `storageDir/inbox`。
   * 于是它具备了最难查的那种故障的全部特征 —— 改配置"看起来生效了"（甚至界面
   * 上显示的路径也跟着变），而真正被扫描的还是老地方。v1.71 接上。
   */
  inboxDir: 'inbox',
  fallbackBlockChars: HOST_DEFAULTS.fallbackBlockChars,
  /**
   * **超长章切分**（D 半边，2026-10-02 读者拍板 B+D；三档语义见 `chapters.js`
   * 的 `splitLongChapters`）。
   *
   * 主服务场景是网文（章 2~3 千字），但实体书/出版物一章两三万字：《神雕侠侣》
   * 一章 ≈ 2.5 万字。**实测**（`drc-probe-long-chapter/probe.mjs`）：25,000 字/章的书
   * 取样覆盖率只有 **3.6%**（2,500 字/章的网文是 36.2%），而每轮注入是 **40,002 字**
   * （网文 4,002）——该省的没省、该给的没给，两个方向的失效同时发生。
   *
   * 这一条是治本的"入口"：章长超过 `thresholdChars` 的书在**导入时**就把超长章切成
   * `章节名02 / 03…` 的子章——下游一切机制自动按子章粒度工作，**因为全仓的"章号"
   * 就是章节数组位置 + 1**，不是书里印的回目。
   *
   * ⚠️ **这个值不在本文件里写死**：唯一来源是 `chapters.js` 的
   * `DEFAULT_LONG_CHAPTER_SPLIT`（`thresholdChars: 5000` / `targetChars: 3500`，
   * 为什么是 5000 见那里的说明）。这里**浅拷贝**它 —— 从前两处各写一份、靠注释与
   * 一条测试钉住"不许分叉"，那是容易漏的纪律。
   *
   * ⚠️ **已经导入的书不自动重切**：章号是读者的进度锚点，就地重切必须走
   * `library.reindex()`（`scripts/reindex-books.mjs`），它把进度/笔记/草稿/覆盖
   * 按字符位置**精确搬家**、把对不上号的（讨论时间线）拒之门外。
   * ⚠️ **阈值只决定"切不切"，每片多大是 `targetChars` 决定的** —— 所以调阈值不会让
   * 长章书少切（2.4 万字的章在 4000 / 5000 下都 > 阈值 ⇒ 片数一样）。"想少切、章更大"
   * 要动的是 `targetChars`。`null` = 关闭切分（旧行为）。
   */
  longChapterSplit: { ...DEFAULT_LONG_CHAPTER_SPLIT },
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
    headAllowanceChars: HOST_DEFAULTS.headAllowanceChars,
    /**
     * v1.26：**6000 → 9000**（读者在真机确认功能可用后，按"最省事的办法"选定）。
     *
     * 这是 T3「提 D」那一半。docs/design-v1-archive.md §197 的两个轴（深度 / 合并比）**反向**，加预算是
     * 同时松开它们唯一的办法；而加预算以 R8（缓存命中率实测）为闸门。本版
     * **仍然没有 R8 数据**——所以这里是一次**有意识的赌注**，代价如实说：
     * 缓存命中时多出来的背景几乎不花钱，**不命中则每轮全额付**。
     * 取 **+50%**（最保守的一档）就是为了用最小代价换最大的信息。
     *
     * `compactThreshold`(0.85) 是**按比例**跟走的：6000×0.85=5100，现在
     * 9000×0.85=7650 才触发压缩。所以两道闸是联动的——D 变大不会撑爆上下文，
     * 只是压缩来得晚一些。想退回去把它改回 `6000` 即可（库侧的兜底**不用管**：
     * 它与这里同源于 `HOST_DEFAULTS`，改这一处就够 —— 2026-10-03 之前是两处各写一份、
     * 靠"有测试钉住不许分叉"维持，而那句话本身就说明它分叉过一次）。
     *
     * ⚠️ **`docs/design-v1-archive.md` §197 那条不等式在这里不适用**：`总字数 ≤ 70 × D ÷ k`
     * 的前提是 `u = k × 章长`（按章长比例给额度），而那条路已于 2026-10-03 **退役**
     * （见 `sample` 里的说明）。所以本版提 D 的收益**不是**"能撑更大的书"，而是
     * "同一批预算能多覆盖主体、多留余量"。⚠️ 那份档案（`docs/design-v1-archive.md`）
     * 里的推算**仍然有效**，只是它描述的那个形状**已经不在代码里了** —— 档案是历史，
     * 不要照它调参。
     */
    backgroundBudgetChars: HOST_DEFAULTS.backgroundBudgetChars,
    /**
     * 背景认识的**降级阶梯**：预算不够时，先把装不下的主体降为粗粒度
     * （`### 主体` + 最近一条记载），只有粗粒度也装不下才整块丢弃。默认开。
     *
     * 为什么可以默认开：这一级是**纯补位**——预算充足（没有主体被跳过）时输出
     * **逐字节不变**；只有真的挤不下时，它才让一批原本要消失的主体至少露个头。
     * 设 `false` 回到 v1.24 的两级降级（直接丢弃）。
     */
    backgroundCoarseDegrade: true,
    /**
     * **冷归档的活跃窗口**（章数，3.0）。
     *
     * 每次补齐前，**纯代码**把"整条都落在窗口之外"的旧条目搬进 `## 冷档案`
     * （原文只搬运、零模型调用、永不进提示词，见 `background.js` 的 `applyArchive`）。
     * 于是**注入量由窗口决定，而不是由全书条数决定** —— 这是"百万字"那一课的解药：
     * 压缩（叫模型把整份文件重写一遍）有 32768 输出上限，文件一大就压不出来。
     *
     * ⚠️ 设 0 或负数 = **关掉冷归档**（退回"只靠压缩"的旧行为）。
     */
    archiveWindowChapters: HOST_DEFAULTS.archiveWindowChapters,
    /**
     * **在线折叠**（3.0 ②c，读者 2026-10-02：前 50 章的重要配角离场了，
     * 他的状态不再起判断作用，但条目一直占着注入 —— 因为**窗口只向前看**）：
     * 人物"最后被提及"距今超过这么多章 ⇒ 注入时**折叠成锚**（只留最新一条），
     * 他的状态行也不再注入。**只动注入视图、不动文件**；他再次出现（有新条目）
     * 自动展开，状态由下一次补齐重写 —— 没有"复活"逻辑可写。
     * ⚠️ 设 0 = 关闭折叠（兼容旧行为）。
     */
    personOfflineChapters: HOST_DEFAULTS.personOfflineChapters,
    /**
     * **身份锚的退役窗口 M**（章，2026-10-06）：出活跃窗口超过 M 章的主体，
     * 连"他是谁"的锚一起进冷档案（原文不丢，只是 AI 看不到）。
     * 实测依据见 `background.js` 的 `planArchive` JSDoc。`0` = 关闭（锚永不退役）。
     */
    anchorMaxAgeChapters: HOST_DEFAULTS.anchorMaxAgeChapters,
    /**
     * 「名录化」最多列几个名字（超出的只报个数）。
     * 名录化 = 出了活跃窗口的主体在**注入里只留一个名字**（把预算让给活跃角色的细节）。
     */
    rosterMaxNames: HOST_DEFAULTS.rosterMaxNames,
    compactThreshold: 0.85,
    discussionLimit: HOST_DEFAULTS.discussionLimit,
  },
  /**
   * 抽样预算：一次补齐调用能读多少原著文字。
   *
   * 这个数直接决定"一次调用能补多长的缺口"——预算不够覆盖整个缺口时，
   * 只补前一段，水位线推到位，剩下的下次再补。
   */
  sample: {
    /**
     * ⚠️ **2026-10-02 从 24000 降到 18000**（读者的选择，"先降低到 18000 试试"）：
     * 实测一批的**输出**会随之变小 —— 材料层一胖，模型在一次回复里要写的东西就多，
     * 而**模型的单次输出上限是 32768 tokens**（≈2.6 tokens/字 ⇒ 全份重写在 1.2–1.5 万字就
     * 压不出来）。31-70 章那一批（40 章）就撞过顶、也有过 5 分钟一个字不吐的 stall。
     * 批更小 ⇒ 单次回复更小 ⇒ 不撞顶、也不 stall。批数会多一些，但每一次都更稳。
     */
    budgetChars: 18000,
    /**
     * 每章下限。
     *
     * ⚠️ **它不是"每章都给这么多"**，而是均分额度 `budgetChars ÷ 权重和` 的**封底**：
     * 一批章很多时，均分额度会被它托住。
     *
     * ⚠️ **它同时决定"一批最多吃多少章"**：`一批章数 ≈ budgetChars ÷ minPerChapter`。
     * 也就是说"每章多厚"与"一批多宽"**是同一个旋钮的两个说法** —— 抬下限会自动把
     * 批内章数压下来。
     *
     * ⚠️ 它**不能高过 `maxPerChapter`**：采样里的限额是
     * `unit = min(maxPerChapter, max(minPerChapter, budgetChars ÷ 权重和))`，
     * 下限一旦高过上限，`unit` 恒等于上限 —— 于是"每章至少 N 字"这句话是假的，
     * 面板预估却还按 N 报（实测：min 2000 + max 600 → 每章仍是 600，只是批次变窄）。
     *
     * v1.67：**150 → 600**（读者选定，走"温和"档）。一批从约 160 章收到约 40 章
     * （`24000 ÷ 600`），**每批的总输入不变**（`budgetChars` 没动，一直是这批的
     * 上限），变的是"这一批的预算由几章分"。首轮打底那 30 章恰好权重和 40 →
     * 每章 600 字，与过去逐字相同。
     * 代价如实说：**调用次数变多**（大缺口从约 6 次变成约 25 次），token 总量不变。
     */
    minPerChapter: HOST_DEFAULTS.minPerChapter,
    /**
     * 每章的**基准额度上限**。
     *
     * v1.67：**600 → 1200**。理由是上一条把批宽压到约 40 章之后，`budgetChars ÷ 权重和`
     * 在窄批里会算出 600～1200（例如 20 章一批 → 1200）—— 若上限仍是 600，那些预算
     * 就白白剩下了。抬到 1200 让"缺口越小、每章越厚"这件事真的发生，而**每批总量
     * 依旧封在 24000**，所以总输入仍不变（读者选定的"成本不变"就是这个意思）。
     * 重点章可拿到它的 `emphasisFactor` 倍（默认 3 → 3600 字）。
     *
     * ⚠️ 旁边曾经还有一组 `longChapterThreshold` / `longChapterRatio` /
     * `longMaxPerChapter`（"4000–8000 的保完整章由取样侧按比例读厚"），
     * **2026-10-03 已整体删除**：切分阈值降到 4000 之后那一档不存在了 —— > 4000 的章
     * 在导入时就被切成子章，子章各拿一份均分额度，比整章按比例读厚**更深**。
     * 唯一的残余是"既没换行也没句末标点"的非散文章，它和短章拿同一份额度；那不是漏了
     * 一档，是那种文本本来就没有可落切点的地方
     * （见 `chapters.js` 的 `DEFAULT_LONG_CHAPTER_SPLIT`）。
     */
    maxPerChapter: HOST_DEFAULTS.maxPerChapter,
    // ⚠️ `lengthRatio`（每章额度按章长比例给）已于 2026-10-03 **整体退役**，
    //    配置项连同默认值一起从这里删掉了 —— 它是"读厚"机制的另一半，读者在
    //    2026-10 明确收回了那个机制（短章会被截得比均分狠）。
    //    **退役后 `sampleChapters` 只有一种形状：按预算均分。**
    //    老 `settings.json` 里还带着 `lengthRatio` 的**不会报错**（`sampleChapters`
    //    现在完全忽略它）—— 但也不会有任何效果，这一点必须如实：想让短章多给点，
    //    改用 `minPerChapter` / `maxPerChapter`。
    /**
     * 首次补齐（"打底"）的章数上限。
     *
     * 读者读到第 300 章才第一次补齐时，与其把 24000 字平摊成 240 章各 100 字
     * （覆盖极广、深度为零），不如先把开头读厚，剩下的留到第二次——两次补完，
     * 第一次深、第二次全。只在 `covered === null` 时生效。
     */
    foundationChapters: 30,
    /**
     * **打底批**（首次补齐那一批）专用的字符预算（3.0）。
     *
     * ⚠️ 为什么与 `budgetChars` 分开：`budgetChars` 降到 18000 是为了**后续批次**的输出更小
     * （不撞 32768、不 stall）；而打底批**只有一个**、章数还被 `foundationChapters` 钉在 30 章
     * ⇒ 它的**输出**天生有界（2–4 千字，远不到 1 万 tokens），所以它可以放心保留 24000 的旧预算
     * —— 这是读者的要求："打底还是希望能够跑 30 章，或者 25 章，现在的 20 章有些太少了"。
     * 打底的本意正是"开头**读厚**、一次成型"；每批 600 字的均摊会把这件事做薄。
     */
    foundationBudgetChars: 24000,
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
     * 下面的每章下限算，一批只吃约 20 章，所以大约 10 批才能读得比较厚。
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
     * ⚠️ 厚一倍意味着**一批只吃约 `budgetChars ÷ 这个数` 章**（18000 ÷ 1200 = 15 章），
     * 所以"最近 200 章"要约 10 批。这是刻意的取舍，不是副作用。
     *
     * ⚠️ v1.67：**300 → 1200**，而且必须与 `maxPerChapter`（1200）**同时**抬 ——
     * 若下限高过上限，`unit` 恒等于上限，这条"更厚"就成了一句空话（旧值 300 在
     * `minPerChapter` 改成 600 之后反而**比全量那条路更薄**，与它的用途正好相反）。
     */
    recentMinPerChapter: 1200,
  },
  /**
   * 单次补齐的超时（毫秒）。
   *
   * ⚠️ **2026-10-01 从 120000 提到 300000**：一批最多吃 `sample.budgetChars`（默认 24000）
   * 的字，而**要产出七个小节**（加上「时间与分线」之后更多了）——
   * 2 分钟对慢模型太紧 ✗。超时那一刻我们 `abort()` 掉子代理，读者在界面上看到的是
   * "**子代理停止了**"、外加一句"补齐没完成"，而**具体补到哪儿并不直观**。
   * 读者本来就选了阻塞式（愿意等），所以宁可放长；真嫌慢就调小 `sample.budgetChars`（批更小、批数更多）。
   *
   * ⚠️⚠️ **2026-10-02 再提到 600000（10 分钟）—— 这次有真机会话记录为证**：
   * 《魔女霓裳》重建后第二批（`memory:31-49`，19 章样本 + 已有记忆）的子代理，
   * `sessionStats.llmMs = 300003`（**正好撞上 5 分钟上限**）、`ttftMs = 5089`（首 token 5 秒就到了）、
   * 之后 `outputTokens = 0 / decodeMs = 0` **一个 token 都没吐**，于是被我们 abort，`response` 为空 ⇒
   * 什么都没写进去（覆盖区间停在 1..30）。同一天第一批（1..30）只用了 110 秒 / 16258 tokens 就成功。
   * ⇒ **慢模型在大批次上会长时间不吐字**，5 分钟仍不够；而 abort 掉的代价是"整批白跑"。
   */
  memoryTimeoutMs: 600000,
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
    /** 已经因为超限拒绝过了 —— 之后只把数据丢掉，不再累加、也不再重复拒绝。 */
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        if (!tooLarge) {
          tooLarge = true
          chunks.length = 0
          reject(new Error('BODY_TOO_LARGE'))
          // ⚠️⚠️ **这里绝不能 `req.destroy()`**（2026-10-02 三方评审 P2 实测）。
          //    销毁 IncomingMessage 会把**底下那条 socket 一起销毁**，而我们要回的
          //    400 `{error:'BODY_TOO_LARGE'}` 正是走那条 socket ⇒ 客户端拿到的是
          //    `UND_ERR_SOCKET`（连接被重置），与"服务端炸了"完全分不出来，
          //    文档化的护栏等于不存在。
          //    正确做法：继续把这个请求读完（数据丢掉），让客户端能正常写完并
          //    收到我们的响应。`data` 监听仍在 ⇒ 流不回退，不会把连接挂住。
          req.resume()
        }
        return
      }
      if (tooLarge) return
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
  if (text.startsWith('COMPACT_LOST_PAIRS')) {
    // ⚠️ 与上面「丢人物」同一档处置。判据是"**对不能少**"（条目怎么合并都行）——
    //    它管的是平铺的「人物关系」（2026-10-04 从分组改回平铺）。
    const pairs = text.split(': ')[1] ?? ''
    return {
      status: 502,
      message: `压缩结果丢了整对关系（${pairs}），已**整批丢弃**，你的 background.md 一个字都没动。重试一次通常就好。`,
    }
  }
  if (text.startsWith('COMPACT_LOST_ANCHORS')) {
    // ⚠️ 章号是这份文件**唯一的定位手段**（倒退过滤 / 冷归档 / 取代都吃它）——
    //    丢了就再也定位不到那条记忆，而文件里看不出少了什么。所以与上面两条同一档。
    const detail = text.split(': ')[1] ?? ''
    return {
      status: 502,
      message: `压缩结果把一些条目的**章号**弄丢了（${detail}），已**整批丢弃**，你的 background.md 一个字都没动。章号是这份文件唯一的定位手段，丢了就没法按进度筛选、也没法归档。重试一次通常就好。`,
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
  // ⚠️ 兜底：**所有** `COMPACT_*` 失败都是"整批丢弃、文件没动"（压缩先在内存里做、
  //    校验不过就**不落盘**）—— 从前兜底只印一句裸码，读者看到 `COMPACT_LOST_ENTITIES: …`
  //    却不知道文件是否被动过（其余分支都写着"一个字都没动"，那几句是**承重**的）。
  //    ⚠️ 按**前缀**判，别再逐个补名字：新加的码自动获得同一句保证
  //    （2026-10-04 体检发现漏了 `COMPACT_LOST_ENTITIES` / `_LOST_READER_ENTRIES` /
  //     `COMPACT_SECTION_*` 六个可达的码）。
  if (text.startsWith('COMPACT_')) {
    return {
      status: 502,
      message: `压缩失败（${text}），已**整批丢弃**，你的 background.md 一个字都没动。重试一次通常就好。`,
    }
  }
  return { status: 502, message: `压缩失败：${text}` }
}



/**
 * 这本书的**制品落点**（面板要说一句"写到哪"所需的形状）。
 *
 * ⚠️ `scope: 'plugin'` = **落回插件目录**（未绑定、或绑定记录里没有 `workspaceDir`）——
 *    这时工作区里**不会**出现「陪读_书名」文件夹，而补齐其实跑成功了 ⇒ 读者最容易
 *    误判成"没跑成"。**绝不因为路径解析失败而丢笔记**（`companionDir` 的设计），
 *    但"落在哪"必须说出去。拿不到就回 null（面板照旧只说它原来那句）。
 *
 * @param {object} library 书库
 * @param {string} bookId 书号
 * @returns {{ path: string, scope: string, reason: string|null }|null}
 */
function companionDirInfo(library, bookId) {
  try {
    const info = library.companionDir(bookId)
    if (info === undefined || info === null) return null
    return {
      path: typeof info.dir === 'string' ? info.dir : '',
      scope: typeof info.scope === 'string' ? info.scope : '',
      reason: typeof info.reason === 'string' ? info.reason : null,
    }
  } catch {
    return null
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
    // 判据只有一份：`sameSessionKey`（#13 收敛）。注册表里存的写法与调用方给的
    // 写法未必同形（一个带 `session-` 前缀、一个不带）。
    const found = workspaces.find((workspace) => (workspace?.sessionIds ?? [])
      .some((id) => sameSessionKey(id, sessionId)))
    return typeof found?.path === 'string' && found.path !== '' ? found.path : null
  } catch {
    // registry 的形状变了、或底层存储在抖 —— 都不该让绑定失败。
    return null
  }
}

/**
 * **自动备份的导出根**（3.0）。
 *
 * 优先级与导出路由一致：运行期设置 > cordis 配置；都没配 ⇒ **陪读文件夹的上一层**
 * —— `陪读导出_<书名>/` 本来就与 `陪读_<书名>/` 同层，那正是读者已经习惯的落点。
 * 再拿不到（书还没陪读目录）⇒ null ⇒ 本轮**不写**自动备份（宁可少做，不猜路径）。
 *
 * ⚠️ 刻意做成**模块级 + 参数注入**：`createRoutes` 是模块级函数，拿不到 `apply`
 * 作用域里的东西 —— 第一版把同名函数定义在 `apply` 里，结果整条补齐路由 500
 * （对话里的报错原文：`autoBackupExportRoot is not defined`）。
 *
 * @param {object} input
 * @param {() => string} input.getExportDir 设置侧的导出目录（settings > config）
 * @param {object} input.library
 * @param {string} input.bookId
 * @returns {string|null}
 */
function autoBackupExportRoot({ getExportDir, library, bookId }) {
  const configured = typeof getExportDir === 'function' ? getExportDir() : ''
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  try {
    const dir = library?.companionDir?.(bookId)?.dir ?? ''
    const parent = dir === '' ? '' : dirname(dir)
    return parent === '' ? null : parent
  } catch {
    return null
  }
}


/**
 * 404：请求**点名的东西不存在**（书 / 章 / 草稿 / 笔记）。
 *
 * @type {Set<string>}
 */
const NOT_FOUND_CODES = new Set([
  'BOOK_NOT_FOUND',
  'CHAPTER_NOT_FOUND',
  'CHAPTERS_MISSING',
  'DRAFT_NOT_FOUND',
  'NOTE_NOT_FOUND',
])

/**
 * 409：请求本身没写错，是**当前状态**不允许 —— 重试一次、或先处理别处就能过。
 *
 * ⚠️ 这一族里 `NOTES_CHANGED_SINCE_READ` 是 v1.61 从 400 **改过来**的（审计 §四①）：
 * 它说的是"你的 `notes.md` 在我读过之后又被改过（可能你正在 Obsidian 里编辑），
 * 我没敢覆盖 —— 你重试一下"。400 会让人以为请求参数写错了，排查方向是反的。
 * 同一个理由早已写在下面的 `EXPORT_REJECTED` 上。
 *
 * @type {Set<string>}
 */
const CONFLICT_CODES = new Set([
  'NOTES_CHANGED_SINCE_READ',
  'REVISION_CONFLICT',
  // 2026-10-01 三方评审：这三个都是"重做一次就能过"的状态冲突，不是参数错误。
  // ⚠️ 用 400 会把人的排查方向引到"我请求写错了"，而真正要做的是先处理那份文件。
  'BACKGROUND_CHANGED',
  'LIBRARY_INDEX_CORRUPT',
  'STORAGE_CORRUPT',
  'BOOK_NOT_BOUND',
  'WORKSPACE_NOT_RESOLVED',
  'EXPORT_DIR_REQUIRED',
  'SESSION_ALREADY_BOUND',
  // 2026-10-03 A3：这三条是"文件来自更新版本的插件，我们不敢覆盖"——当前状态
  // 不允许写，不是请求写错了。用 400 会把人的排查方向引到"我哪一步点错了"，
  // 而真正该做的是升级插件（或别用旧版本动这份文件）。人话在抛出点。
  'BACKGROUND_SCHEMA_UNSUPPORTED',
  'NOTES_SCHEMA_UNSUPPORTED',
  'DRAFTS_SCHEMA_UNSUPPORTED',
  // 2026-10-03：上一条保护的**通用版** —— 书架 / 绑定 / 分类 / 设置这些 JSON 状态
  // 文件从前一个都没装。判据现在只有一处（`atomic-json.js` 的 `updateJson`），
  // 所以错误码也只有一个。
  'JSON_SCHEMA_UNSUPPORTED',
  // 2026-10-03：读不到 ≠ 不存在。文件可能好端端躺在盘上（权限 / I/O / 被杀毒软件
  // 或同步盘占着），这时**拒写**——重试一次通常就能过，而硬写会静默吃掉那份数据。
  'STORAGE_UNREADABLE',
])

/**
 * 400：**请求参数 / 内容本身**不对，调用方要改请求再发。
 *
 * @type {Set<string>}
 */
const BAD_REQUEST_CODES = new Set([
  'BOOK_ID_INVALID',
  'PATH_NOT_RELATIVE',
  'PATH_ESCAPES_ROOT',
  'PATH_OUTSIDE_ROOT',
  'PATH_HAS_NUL',
  'PATH_TOO_LONG',
  'SESSION_ID_INVALID',
  'PROGRESS_CHAPTER_INVALID',
  'PROGRESS_OFFSET_INVALID',
  'NOTE_EMPTY',
  'DRAFT_BOOK_INVALID',
  // ⚠️ 草稿的键是全局 `draftId`，所以"URL 里的书"与"这条草稿的归属"可能对不上。
  //    这是**请求本身不对**（400），不是"重试就能过"（409）—— 换一本书的 URL 才成立。
  'DRAFT_OTHER_BOOK',
  'WORKSPACE_DIR_INVALID',
  'PERSONA_TOO_LONG',
  'WEB_GATE_INVALID',
  'EXPORT_DIR_NOT_ABSOLUTE',
  'EXPORT_DIR_TOO_LONG',
])

/**
 * 把「导入被拒」的机器码翻成**一句人能照做的话**（2026-10-02 三方评审 P3-1）。
 *
 * ⚠️ 从前这条路的 `reason` 直接把 `paths.js` 的机器码回给客户端，而客户端是
 * **优先显示 `reason`** 的（见 `callApi`）⇒ 读者看到的是一串内部枚举
 * （`FILE_NOT_FOUND` / `PATH_OUTSIDE_IMPORT_ROOTS` / `FILE_TOO_LARGE`…），
 * 既不知道发生了什么，也不知道下一步做什么。判据很简单：**这条文案的读者是用户，
 * 不是日志**。机器码不删，挪到响应的 `code` 字段留给诊断。
 *
 * @param {string} reason `inspectImportSource` 给的机器码
 * @returns {string} 给人看的一句话
 */
function describeImportRejection(reason) {
  switch (reason) {
    case 'FILE_NOT_FOUND':
      return '没找到这个文件：检查一下路径拼写，或者把 TXT 放进收件箱再点「扫描导入目录」。'
    case 'PATH_NOT_ABSOLUTE':
      return '要填从盘符开始的**完整路径**（例如 D:\\小说\\夜行.txt）——相对路径我们没法猜它是相对谁。'
    case 'PATH_INVALID':
      return '这个路径不合法（可能是空的、含非法字符，或者不是文本）。'
    case 'NOT_A_REGULAR_FILE':
      return '这不是一个普通文件（可能是文件夹、设备，或者链接指向了别处）。请选一个 .txt 文件。'
    case 'FILE_EMPTY':
      return '这个文件是空的（0 字节），没有正文可读。'
    case 'FILE_TOO_LARGE':
      return '这个文件太大了（上限 64 MB）。'
    case 'PATH_OUTSIDE_IMPORT_ROOTS':
      return '这个位置不在允许导入的目录里 —— 配置项 importRoots 限制了可导入的范围。'
    default:
      return `导入被拒绝了（原因：${reason || '未说明'}）。`
  }
}

/**
 * 领域错误码 → HTTP 状态码；`null` = 不是已知的领域错误（交给上层兜 500）。
 *
 * ⚠️ 这三个集合是**唯一**决定状态码的地方（v1.61 之前是一大串 `||` 写在
 * `guarded` 里）。抽成纯函数有两个理由：
 *   ① 一个 code 只出现在一个集合里 —— 不再发生"400 那串里有、409 那串里也有"；
 *   ② 它能被**直接断言**。而 `NOTES_CHANGED_SINCE_READ` 在真实文件系统上没法
 *      稳定复现：它要求"我读完 `notes.md` 之后、写回之前文件被动过"，而
 *      `purgeNotes` 的两次读之间没有任何 I/O 缝隙可以插进一个改动，
 *      所以端到端测不出来 —— 见 `test/routes.test.mjs` 里那条映射用例。
 *
 * @param {string} code 领域错误码（异常消息 `:` 之前那一段）
 * @returns {number|null} 404 / 409 / 400，或 null
 */
export function statusForErrorCode(code) {
  if (NOT_FOUND_CODES.has(code)) return 404
  if (CONFLICT_CODES.has(code)) return 409
  if (BAD_REQUEST_CODES.has(code)) return 400
  return null
}

/**
 * 从抛出的异常里取出**线上错误码**。
 *
 * 规则（2026-10-03 单轨化）：**优先 `error.code`**，读不到才回落到 message 的 `:` 前缀。
 * 从前只读前缀 ⇒ "码要写进 message" 成了一条**隐式契约**（`export.js` 的 `exportError`
 * 为此专门拼前缀，注释还写着"只设 code 而不带前缀，映射就落不到"）。现在前缀只是
 * **给人看的可读性**（日志里 `LIBRARY_INDEX_CORRUPT: 书架索引…` 比裸 message 好读）。
 *
 * ⚠️ **抽成纯函数是为了能被直接断言** —— 这条规则**必须**被钉住：现存每一个设了
 * `error.code` 的错误，它的 message 要么**等于**那个码、要么**带着同样的前缀**，
 * 于是"两种取法结果相同" ⇒ **端到端测试抓不到回退**（见 `test/routes.test.mjs`）。
 *
 * @param {unknown} error
 * @returns {string} 线上错误码（取不到时是 message 的第一段）
 */
export function errorCodeOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  const field = error !== null && typeof error === 'object' ? error.code : undefined
  return typeof field === 'string' && field !== '' ? field : message.split(':')[0]
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
  const { storageDir, config, library, memory, compactor, settings, logger } = deps
  // 联网闸的放行计数（由 `apply` 持有，守卫那边往里累加；拿不到时给一个本地兜底，
  // 让 `createRoutes` 能被单独调用而不炸）。
  const webGatePassthrough = deps?.webGatePassthrough ?? { noSessionId: 0, noBookBinding: 0 }
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
      // ⚠️ **取码优先 `error.code`，读不到才回落到 message 前缀**（2026-10-03 单轨化）——
      // 规则与理由见 {@link errorCodeOf}。
      const code = errorCodeOf(error)
      // ⚠️ 体形特殊的先判掉（它们不带 message / 带的是 reason），剩下的走
      // {@link statusForErrorCode} 那张表 —— 表在模块层，是唯一的状态码决策点。
      if (code === 'IMPORT_REJECTED') {
        // ⚠️ `reason` 是**给人看的一句话**，不是机器码（2026-10-02 三方评审 P3-1）：
        //    客户端优先显示 `reason`，把 `FILE_NOT_FOUND` 这类枚举直接摆到读者面前
        //    等于"报了个我们自己的内部词"。机器码挪到 `code` 留给诊断。
        // ⚠️ 2026-10-03：`reason` 现在是 `error.reason`（独立字段），不再是"前缀后面那段"
        //    —— 因为 `error.code` 已经统一成线上码 `IMPORT_REJECTED`，
        //    再拿 `reason` 当 `code` 会让这条路整个落空。前缀仍作回落。
        const detail = error.reason ?? message.split(': ')[1] ?? ''
        return {
          status: 400,
          body: { ok: false, error: 'IMPORT_REJECTED', reason: describeImportRejection(detail), code: detail },
        }
      }
      if (code === 'EXPORT_REJECTED') {
        // 409 而不是 400：目标文件被**别的书**或**别的文件**占着，是"换个地方或先
        // 处理那个文件"，不是"请求参数写错了"。用 400 会把人引到错误的排查方向。
        return { status: 409, body: { ok: false, error: 'EXPORT_REJECTED', reason: message.split(': ')[1] } }
      }
      if (code === 'BODY_TOO_LARGE' || code === 'BODY_NOT_JSON') {
        return { status: 400, body: { ok: false, error: code } }
      }
      const status = statusForErrorCode(code)
      if (status !== null) return { status, body: { ok: false, error: code, message } }
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
        // ⚠️ **被挪到一边的坏文件**（2026-10-02 三方评审 P2-2）：`mutateJson` 早就算了
        //    出来却零消费者 —— 绑定 / 分类 / 设置损坏时读者侧零提示，于是"我的阅读进度
        //    怎么全变成没读过了"没有任何解释（而紧接着一次翻页就会把这份空状态写实）。
        //    放在 `/health` 是刻意的：书架页本来就在拉它（`ShelfView.reload`），
        //    读者侧因此**不用新增任何请求**。
        quarantined: library.storageQuarantined(),
        // 收件箱的**解析结果**（宿主真正在扫的那个目录）。客户端从前自己拼
        // `${storageDir}\inbox`：配置一改，面板指的目录与真被扫的目录就是两个
        // 地方 —— 读者照面板提示把书放进去，再点「扫描」什么也没有，而看起来
        // 像是插件的错。唯一权威放宿主这一侧，客户端只负责显示。
        inboxDir: library.paths.inbox,
        config,
        // 联网闸"因为认不出会话而放行"的次数（见 apply 里的说明）。它把
        // 「block-all 到底有没有强度」从"只能读源码才知道"变成可观测的数字。
        webGatePassthrough,
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
        // ⚠️ `body?.` 不能写成 `body === null || body.workspaceDir === undefined`：
        //    空 body 时 `readJsonBody` resolve 的是 **undefined**（不是 null），
        //    于是 `undefined.workspaceDir` 当场 TypeError ⇒ 一个"省略 = 重置"的
        //    合法调用被落成 500 INTERNAL（2026-10-02 三方评审 P2 实测）。
        const workspaceDir = body?.workspaceDir ?? null
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
        // ⚠️ **必须带 bookId**：草稿表的键是全局 `draftId`，不带书就等于
        //    "任何一个 id 都能删掉任何一本书的草稿"（2026-10-02 三方评审 P2-4）。
        removed: library.removeDraft(params.bookId, params.draftId),
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
          // 「该压缩了」：面板据此把「压缩背景认识」点亮并解释原因。
          // ⚠️ **这个信号从前挂在 `/context`（AI 视角预览）那条路由上**；那个面板入口在 2.2.2
          //    摘掉之后，客户端就**再也不调 `/context`** 了 ⇒ 信号无声消失，压缩变成"纯手动、
          //    而且没人提醒"（读者某本书的背景认识因此涨到 47 KB ✗）。现在挂在 `/background`
          //    上 —— 它是面板**每轮都在调**的那条。
          compaction: needsCompaction(doc, {
            budgetChars: config.window.backgroundBudgetChars,
            threshold: config.window.compactThreshold,
          }),
          markdown: doc.markdown,
          // ⚠️ 面板看到的是**全文**，而投喂给模型的那一份会按 `progressIndex` 裁掉
          //    超前条目（见 `handle` 里 `renderBackgroundForPrompt` 的 `maxChapter`）。
          //    这个数把"两种视图不一致"如实说出来 —— 不隐藏读者的文件，也不让他
          //    以为"面板上有 ⇒ AI 也知道"（2026-10-01 三方评审 P2）。
          // ⚠️ **章号基准差 1，必须 +1**（2026-10-04 修）：`countBeyondProgress` 收的是
          //    **1 起**章号（见它的 `@param`），而这里的 `progressIndex` 是 **0 起**索引。
          //    不 +1 时"读者正在读的这一章"的条目会被算成超前，与同一个响应里的 `cards`
          //    （`entityCardsFor` 内部做了 +1）自相矛盾 —— 而这个数存在的全部意义
          //    就是如实说出"面板上有 ⇒ AI 并不一定也知道"。
          beyondProgress: countBeyondProgress(doc, progressIndex + 1),
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
          // ⚠️ 日志要真的接上：`fillMemoryGap` 里那两条"如实说一句"（重判没成功 / 这一批写超预算）
          //    都走它。不传就是一个永远静默的 `deps.logger?.warn?.()` —— 本仓库最烦的形状
          //    （写了四层，最后一层是空的）。
          logger,
          // 自动备份（3.0）的导出根：settings > config > 陪读文件夹的上一层。
          autoExportRoot: autoBackupExportRoot({ getExportDir, library, bookId: params.bookId }),
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
        // ⚠️ **整包转发**（2026-10-03）：`fill` 的结果对象**原样**进响应体，不再逐字段手抄。
        //
        // 逐字段手抄在这个仓库踩过**三次**，最狠的一次是 `truncatedSuspected` ——
        // fill 结果里有这个旗子、客户端也在读它，但路由的转发**从来没带上它**，
        // 于是"输出像是被截断了"那句提示在真机上**一直是哑的**。形状是：
        // **算出来 → 结果对象 → 路由转发 → 客户端读**，四层里少一层就静默失效，
        // 而且没有任何一处会报错（这是它比普通 bug 更贵的地方）。
        //
        // 现在新增字段只要在 `fillMemoryGap` 的返回里加上就**自动上线**；各字段的
        // **理由**也写在那个返回处（那里才是产生它的地方），不在这里复述一遍。
        //
        // `covered` / `gap` 仍以**这次现读**的为准 —— 结果对象里那份是补齐过程中的快照。
        return ok({
          ...result,
          bookId: params.bookId,
          covered: doc.covered,
          gap: backgroundGap(doc.covered, progress?.chapterIndex ?? 0),
          // ⚠️ **这次写到哪**（2026-10-06 读者实机提问："神雕侠侣这回没在工作区下生成文件目录"）：
          //    未绑定的书（或绑定记录里没有 `workspaceDir`）⇒ `companionDir` **落回插件目录**
          //    （`storageDir/books/<bookId>`）⇒ **工作区里那个「陪读_书名」文件夹根本不会出现**，
          //    读者据此以为补齐没跑成。面板据此把落点那句话说得更醒目。
          companionDir: companionDirInfo(library, params.bookId),
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
        // ⚠️ **必须取 `readWindow.discussions`，不能另取一份**（2026-10-04 修）：
        //    `collectReadWindow` 里那份**已经过了水位线**（倒退阅读时按 `readingChapter`
        //    滤掉超前的讨论），而 `listDiscussions` 是**未过滤**的 ⇒ 从前这条路由在
        //    倒退时会显示"模型根本看不到的讨论"，与它下面自称的"走同一条读取路径、
        //    保证预览与实际注入看到的是同一份东西"正好相反。
        //    两者形状相同（都是 `recentDiscussions(...)` 的输出），所以是纯替换。
        const discussions = readWindow.discussions
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
        // ⚠️ 子代理挂在**绑定会话**下（3.0 的会话固定；与补齐同一口径），当前会话兜底。
        const subagentSession = typeof bound?.sessionId === 'string' && bound.sessionId !== ''
          ? bound.sessionId
          : effective

        const before = library.background(params.bookId)
        // 手动压缩是**用户主动要做的事**，所以失败必须是他能读懂的失败——不能是
        // 一个从 `await` 里冒出去的裸异常（那在界面上会变成一句无信息量的报错）。
        let result
        try {
          result = await compactor({
            sessionId: subagentSession,
            fallbackSessionId: effective,
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
        // ⚠️ 压缩前面压着一次**很长的模型调用**，而这一步是整份覆盖：必须让 library
        //    侧在落盘前确认磁盘上还是我们读到的那个版本（`expectedMarkdown`）。
        //    否则窗口里补齐落下的条目、或读者自己手工改的内容，会被静默吞掉。
        let written
        try {
          written = library.backgroundCompact(params.bookId, result.parsed, { expectedMarkdown: before.markdown })
        } catch (error) {
          if (error?.code !== 'BACKGROUND_CHANGED') throw error
          return {
            status: 409,
            body: {
              ok: false,
              error: 'BACKGROUND_CHANGED',
              message: '这份背景认识在压缩期间被改动过（补齐落盘、或你在编辑器里直接改过它），'
                + '所以这一次的压缩结果**没有**写下去 —— 拿旧快照整份覆盖会吞掉那些改动。'
                + '文件保持原样，重新点一次「压缩」即可。',
            },
          }
        }
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
      // ⚠️ 参数解码必须**在 try 里面**（2026-10-02 三方评审 P2 实测）：
      //    `decodeURIComponent` 碰到畸形百分号编码（例如 `%E0%A4%A`）会抛
      //    `URIError: URI malformed`，而它从前写在下面那个 try **之外** ⇒
      //    异常从这条 async handler 冒出去，**既不回响应、也不进 500 分支**，
      //    请求就那么挂着（实测：客户端 30 秒超时）。
      //    畸形 URL 是外部输入，必须落成一次**确定的 400**。
      try {
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(matched[i + 1])
        })
      } catch {
        sendJson(res, 400, {
          ok: false,
          error: 'BAD_PARAM_ENCODING',
          message: '请求路径里的百分号编码不合法（多数字节解不出来）。',
        })
        return
      }

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
    // 收件箱：同样规范化。空串 = 回落到默认名（相对 storageDir），
    // 而不是"收件箱变成 storageDir 自己"——那会让扫描把整个书库当收件箱扫。
    inboxDir: (() => {
      const value = typeof raw.inboxDir === 'string' ? raw.inboxDir.trim() : ''
      return value === '' ? DEFAULTS.inboxDir : value
    })(),
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
    // 超长章切分（D）：形状不对时库侧按"关"处理（见 chapters.js 的 normalizeSplitOptions），
    // 这里不做第二份校验——两份校验迟早会分叉。
    longChapterSplit: config.longChapterSplit ?? null,
    importRoots: config.importRoots,
    // 收件箱位置（相对 storageDir 或绝对路径）。不传的话库侧用默认名 —— 但那样
    // 配置里的值就又被忽略了，所以这里显式传下去。
    inboxDir: config.inboxDir,
    // ⚠️ **这三条从前漏接了**（2026-10-06 发现 `personOfflineChapters` 静默失效）：
    //    配置在 `DEFAULTS` 里声明着，而 `createLibrary` 的调用点**一个都没传** ⇒
    //    库侧拿到 `undefined` ⇒ 在线折叠/名录化的判据全落空，而且不报错。
    //    与 `index.js:95` 记的 `inboxDir` 是同一个病，所以这里显式传下去。
    personOfflineChapters: config.window.personOfflineChapters,
    archiveWindowChapters: config.window.archiveWindowChapters,
    rosterMaxNames: config.window.rosterMaxNames,
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
     * ## ⚠️ 两趟：**先全量校验，再一次性落盘**（2026-10-02 三方评审 P2）
     *
     * 旧实现是"边走边写"：先处理 `webGate`（写盘 + 更新缓存），**之后**才校验
     * `exportDir` 并可能抛错。后果实测过 —— 一个 `{webGate:'off', exportDir:'relative'}`
     * 的请求回的是 **400 EXPORT_DIR_NOT_ABSOLUTE**（调用方以为什么都没发生），
     * 而**联网闸已经真的被关掉了**（生效值 block-all → off，且已落盘）。
     * 被拒绝的请求不许改到任何字段，更不许**朝着放松安全的方向**改。
     *
     * 现在的形状：第一趟只做判定（不碰盘、不碰缓存），任何一个字段不合法就整批
     * 拒绝；第二趟把通过的字段**合成一次** `writeSettings`（CAS + 撞车重试仍在
     * 那一份实现里），成功之后才同步缓存。
     *
     * @param {object} patch 要改的字段
     * @returns {object} 改完之后的状态
     */
    apply: (patch) => {
      const isObjectPatch = patch !== null && typeof patch === 'object'

      // ---- 第一趟：只校验，一个字节都不写 ----
      let nextWebGate
      let hasWebGate = false
      if (isObjectPatch && 'webGate' in patch) {
        const raw = patch.webGate
        if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          nextWebGate = null
        } else {
          if (!WEB_GATE_MODES.includes(raw)) {
            throw new Error(`WEB_GATE_INVALID: ${String(raw)}`)
          }
          nextWebGate = raw
        }
        hasWebGate = true
      }

      let nextExportDir
      let hasExportDir = false
      if (isObjectPatch && 'exportDir' in patch) {
        const raw = patch.exportDir
        if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          nextExportDir = null
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
          nextExportDir = trimmed
        }
        hasExportDir = true
      }

      // ---- 第二趟：都合法了才落盘（一次写盘、成功后才更新缓存）----
      const writePatch = {}
      if (hasWebGate) writePatch.webGate = nextWebGate
      if (hasExportDir) writePatch.exportDir = nextExportDir
      if (hasWebGate || hasExportDir) {
        library.writeSettings(writePatch)
        if (hasWebGate) settingsCache.webGate = nextWebGate
        if (hasExportDir) settingsCache.exportDir = nextExportDir
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

  /**
   * 联网闸的**放行计数**（2026-10-01 三方评审 P2）。
   *
   * `webGateReason` 在"认不出会话 / 会话没绑书"时会放行 —— 那是对的（用户的其它
   * 会话不该被锁死），但它的方向是**静默放行**，与规则 A 的 fail-safe 相反：
   * `block-all` 的实际强度完全押在"绑定还在"上。这两个计数把这件事变成
   * **可观察**的 —— `GET /health` 直接看得到"有多少次是因为认不出会话才放行的"，
   * 不必再靠读源码去知道这个性质。
   */
  const webGatePassthrough = { noSessionId: 0, noBookBinding: 0 }

  const routes = createRoutes({
    storageDir,
    config,
    library,
    memory,
    compactor,
    settings,
    logger: ctx.logger ?? {},
    webGatePassthrough,
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
        // ⚠️ 「想回忆前文时读这份文件」（2026-10-05，读者拍板：**不新造工具**，靠文件本身
        //    只含已读章节来防剧透）—— **只在陪伴目录落在会话工作区里时才给路径**：
        //    否则那个路径会话**读不到** ✗，等于让 AI 去撞墙（它还会以为"这本书没有前文记忆" ✗）。
        backgroundPath: (() => {
          const info = companionDirInfo(library, bookId)
          if (info === null || info.scope !== 'workspace' || info.path === '') return ''
          return `${info.path}/background.md`
        })(),
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
        // ⚠️ 书名与人物名**按需取**（2026-10-02 三方评审 P3-5）：它们只在
        //    `block-book` 的启发式里用得到，而默认档 `block-all` 在拿到它们**之前**
        //    就 return 了（非联网工具更早）。从前这里是**无条件先读完**的 —— 读 + 解析
        //    整份 `background.md`，无缓存，评审实测默认档下每次工具调用白做 2.33ms
        //    （真实规模 0.3~0.5ms），结果 100% 被丢弃，而且是在宿主主线程上的同步 fs 读。
        //    所以给的是 thunk：`webGateReason` 走到启发式那一步才会调用它。
        const knownNames = () => {
          try {
            const sessionId = execution?.agent?.session?.id ?? execution?.agent?.id
            const bound = typeof sessionId === 'string' ? bookIdForSession(sessionId) : undefined
            if (typeof bound !== 'string') return []
            const book = library.get(bound)
            const doc = library.background(bound)
            return [
              ...(book === undefined ? [] : [book.title]),
              ...Object.keys(doc?.characters ?? {}),
            ]
          } catch {
            /* 拿不到名单就退化成只用信号词，不该影响放行判定 */
            return []
          }
        }
        return spoilerGuardReason(execution, {
          enabled: config.spoilerGate !== false,
          webGate: effectiveWebGate(),
          bookIdForSession,
          knownNames,
          // ⚠️ **每次现读，不缓存**：读者在界面上收回解锁之后，**下一次工具调用**
          // 就重新锁上。缺省即锁定（见 `spoilerGuardReason` 里的 fail-safe）。
          isBookFinished: (bookId) => library.isFinished(bookId),
          // 放行留痕：只累加 + **首次**记一条日志。这条路的常见形态是"用户在自己的
          // 别的会话里联网"——每次都记会把宿主日志淹没，而"有没有发生过"才是问题。
          onPassthrough: (reason, info) => {
            if (reason === 'NO_SESSION_ID') {
              webGatePassthrough.noSessionId += 1
              if (webGatePassthrough.noSessionId === 1) {
                ctx.logger?.info?.('[reading] 联网闸放行：这次拿不到会话 id，无法判定它是不是陪读会话')
              }
              return
            }
            if (reason === 'NO_BOOK_BINDING') {
              webGatePassthrough.noBookBinding += 1
              if (webGatePassthrough.noBookBinding === 1) {
                ctx.logger?.info?.(
                  `[reading] 联网闸放行：会话 ${info?.sessionId ?? '(未知)'} 没绑书`
                  + '（非陪读会话属正常；若这本来是陪读会话，说明绑定丢了）',
                )
              }
            }
          },
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
   * 里了——从可见面读会漏掉恰好最该被记住的那句（docs/design-v1-archive.md §187 的硬约束）。
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




// ⚠️ `writeAutoBackup`（自动备份）在 `./host/export.js` —— 它属于"往导出文件夹写东西"的家，
//    不在这里（这里曾放过一份，删掉时若发现导入缺失会立刻在模块加载时报出来）。
