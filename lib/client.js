/**
 * dsh-reading-companion — 浏览器（Client）半边。
 *
 * 落点（见 docs/design-v1-archive.md §5.4）：
 *   注册一个**右侧栏 tab 类型**，本体挂在 session 域的 keyed 槽
 *   `sidebar.right.pane.tab` 上。选它的三个理由：
 *     1. `replaceRisk: none` —— 不顶掉任何宿主 UI；
 *     2. scope 是 session，槽会通过 `inject(sessionId)` 把会话 id 交给我们 ——
 *        「一本书一个会话」的绑定关系天然拿得到锚点；
 *     3. 与 dsh-tavern 零冲突：它占 shell.overlay / sidebar.workspaces /
 *        conversation.view，我们一个都不占。
 *
 * 模块格式：宿主浏览器侧是**惰性 CJS 表**——本文件执行时只向
 * `window.__ModuleLoader__.load` 注册一个 factory，真正的副作用（含 CSS 注入）
 * 必须留在 factory 闭包内、在 materialize 时才发生。因此本文件没有构建步骤，
 * 唯一的外部依赖是 `require('react')`（壳直接提供）。
 *
 * 视图机：书架 → 目录 → 正文。刻意做成**单面板内的三态**而不是三个页签，
 * 因为侧边栏面板本身很窄，多一层页签会把可读宽度再削一刀。
 */

window.__ModuleLoader__.load({
  id: 'dsh-reading-companion',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    //#region 依赖
    /** react 由宿主壳以 seed 形式提供，无需打包、无需声明版本。 */
    const React = require('react')
    const { memo, useCallback, useEffect, useMemo, useRef, useState } = React
    /** createElement 的短别名——本文件不使用 JSX（没有构建步骤）。 */
    const h = React.createElement
    //#endregion

    //#region 浮动提示条（观感对标 MilkFeng/lumina 的 ToastBubble / ToastService，MIT）

    /** 短提示停留多久（毫秒）。这个数取自它的 `ToastService`。 */
    const TOAST_DWELL_MS = 3000
    /** 超过这么多字就**不自动消失** —— 长文是"要读的信息"，不是"确认一下"。 */
    const TOAST_LONG_CHARS = 60

    /**
     * 浮动提示条。三处提示（书架 / 笔记 / 设置）共用它，所以观感只有一份定义。
     *
     * ## 为什么不需要一个全局 toast 队列
     *
     * 面板同时只挂载一个视图，而每个视图的 `notice` 状态**天然只持有一条** —— "同一时刻
     * 只有一个、永不堆叠"这条规格已经由 React 状态本身保证了。换视图时旧视图卸载、提示
     * 随之消失，这正好也是我们要的语义。少写一个单例，就少一处能在卸载后 setState 的坑。
     *
     * ## 两处与它不同的地方（都是刻意的）
     *
     * 1. **长文不自动消失**：`importOutcomeText()` 那类结果要留给人读，3 秒后消失等于丢信息。
     *    超过 {@link TOAST_LONG_CHARS} 字就一直留着，直到被下一条替换、或读者点掉。
     * 2. **点击即消**，而且外壳不吃点击（`.drc-toast-wrap` 是 `pointer-events: none`），
     *    免得它挡住底下的按钮。
     *
     * @param {{ notice: { kind: string, text: string }|null, onDismiss: () => void }} props
     * @returns {unknown}
     */
    function Notice({ notice, onDismiss }) {
      // 用 ref 拿最新的 onDismiss：调用方每次渲染都传一个新的箭头函数，直接进依赖数组
      // 会让计时器**每渲染一次就重置**（面板渲染很频繁，那样它永远不触发）。
      const dismissRef = useRef(onDismiss)
      dismissRef.current = onDismiss
      const text = notice === null ? '' : String(notice.text ?? '')
      useEffect(() => {
        if (notice === null || text.length > TOAST_LONG_CHARS) return undefined
        const timer = setTimeout(() => dismissRef.current?.(), TOAST_DWELL_MS)
        return () => clearTimeout(timer)
      }, [notice, text])
      if (notice === null) return null
      // ⚠️ 长提示**单独一个形状**：胶囊圆角（999px）只在单行时好看，而长提示恰恰是
      //    **不会自动消失**的那一类（见 TOAST_LONG_CHARS）—— 多行还硬套胶囊会糊成一团。
      //    所以按同一个长度阈值切形状：短提示 = 胶囊居中，长提示 = 圆角矩形 + 左对齐。
      const long = text.length > TOAST_LONG_CHARS
      return h(
        'div',
        { className: 'drc-toast-wrap' },
        h(
          'div',
          {
            className: (notice.kind === 'error' ? 'drc-toast drc-toast-error' : 'drc-toast')
              + (long ? ' drc-toast-long' : ''),
            role: 'status',
            title: '点击关闭',
            onClick: () => dismissRef.current?.(),
          },
          notice.text,
        ),
      )
    }

    //#endregion

    //#region 常量
    /**
     * 与宿主半边共用的路由前缀。
     * ⚠️ 改这里必须同步改 lib/index.js 的 API_ROOT。
     */
    const API_ROOT = '/dsh-reading-companion/api'

    /** tab 类型 id（同时是 keyed 槽的键）。 */
    const TAB_ID = 'dsh-reading-companion:reader'
    /** tab 类型 kind。各类型按 kind 归并，我们独占一个自有的 kind。 */
    const TAB_KIND = 'dsh-reading-companion'
    /**
     * 页签标题（右侧栏「+」列表里显示的名字，也是页签上的字）。
     *
     * 名字换过三次，每次都跟着"这个面板到底是什么"走：`陪读` →（v1.30，和三处标签一起
     * 对齐）`陪读模式` →（v2.2.0，读者看着右侧栏列表定的）**`本地书架`**。
     * 这一次的理由很直接：它排在「终端」「图像工作台」旁边，**它是一个"地方"**
     * （你的书放在这儿），不是一种"模式"；叫"模式"会和"陪读"这个动作混起来。
     * ⚠️ 插件本身的身份没变（仓库仍是 `dsh-reading-companion`，页签 id 也没动），
     * 变的只是给读者看的那个名字。
     */
    const TAB_TITLE = '本地书架'
    /** CSS 归属标记，用于幂等注入与整体卸载。 */
    const CSS_ID = 'dsh-reading-companion'

    /** 滚动停下多久之后回写进度（毫秒）。 */
    const PROGRESS_IDLE_MS = 1200

    /**
     * 笔记列表每次加载的条数。
     *
     * ⚠️ 必须和宿主 `NOTES_PAGE_DEFAULT` 保持一致才有意义：这里传 `limit`，
     * 宿主按它切片。契约测试会盯着两边不走偏。
     */
    const NOTES_PAGE_SIZE = 10

    /**
     * 回收站一次取多少条。
     *
     * 回收站**不做翻页**（它通常很短：真被彻底删掉的东西都在这儿等着），所以这个数
     * 就是一个上限，不是页长。⚠️ 计数**不能**用取回来的条数（见 `trashTotal`）——
     * 超过这个上限时那个数字会说谎。宿主那边 `limit` 的硬上限是 200，所以这里取 200。
     */
    const TRASH_PAGE_LIMIT = 200

    /**
     * 「讨论历史」在面板里显示的条数。
     *
     * 刻意**只显示最近几条**：这个列表的用途是回答"我们上次聊到哪了"，
     * 它是一条导航时间线，不是账本。宿主落盘上限是 200 条
     * （`MAX_DISCUSSIONS`），全铺出来会把「AI 视角预览」这一屏拉得极长，
     * 反而找不到下面真正要看的东西。
     *
     * 被截掉的条数由一行说明交代清楚——**"被截断"必须是可见的**，
     * 否则读者会以为历史一共就这么多。
     */
    const DISCUSSION_LIMIT = 5

    /**
     * 宿主的 open-in-app 路由（**根路径**，不在我们的 API_ROOT 之下）。
     *
     * 这是宿主自己 host/client 两侧共用同一份常量的**公开 wire 契约**：
     *   GET  /open-in-app/apps  → { apps: [...] }   已探到的应用 id
     *   POST /open-in-app/open  { app, path }        在某个绝对路径上启动它
     * 我们只用它来"把收件箱交给系统文件管理器"，**不自己执行任何命令** ——
     * 插件里加一条平台相关的启动命令既是新的执行面，也绕开了宿主自己的安全栅。
     */
    const OPEN_IN_APP_APPS_ROUTE = '/open-in-app/apps'
    const OPEN_IN_APP_OPEN_ROUTE = '/open-in-app/open'

    /**
     * 宿主应用目录里那三个"打开文件夹"的条目。
     *
     * 它们的 `launch` 都是 `shell-open`（= 交给操作系统打开），也就是我们要的
     * 那个语义；其余应用（编辑器 / 终端）不是。按平台各有一个：win32 `explorer`、
     * darwin `finder`、其它 `filemanager` —— 顺序即优先级，所以这里**不需要**
     * 知道自己在哪个平台上跑，清单会告诉我们。
     */
    const FILE_MANAGER_APP_IDS = ['explorer', 'finder', 'filemanager']
    //#endregion

    //#region 样式
    /**
     * 样式文本。
     *
     * 刻意只用继承色与 semantic token 的软引用（`var(--x, fallback)`），
     * 这样换肤/换主题时不会把面板变成一块突兀的色块。
     */
    const CSS_TEXT = `
/* ═══ 语义别名层（v1.73）═══
   全局只有这**一处**声明"我们借用哪些宿主 token"。这样做有三个理由：

   1. **归属清楚**：每一处颜色先问一句"这是宿主世界的语义（层级 / 描边 / 状态 /
      选中），还是这本书自己的东西？" —— 前者**借**宿主的 alias token（只引用、
      不定义值），后者才允许对宿主现值做偏移。这一层就是"借"的清单。
   2. **可测**：宿主改了 token 名（或在某个版本里没有它）时，要检查的只有这一块；
      test/client.test.mjs 有一条守卫拿这一块与真宿主的 token 表逐个对。
   3. **回落也得是"偏移"而不是固定颜色**：从前落回的是一个**写死的蓝**，那是我们
      自己发明的、宿主调色板里根本没有的颜色。现在文字类的回落一律是对 currentColor
      按比例偏移（color-mix），于是即便一个宿主 token 都没有，面板也只是"同一种墨的
      深浅"，不会冒出一个异色。

   ⚠️ 定义在 .drc-root 而不是 :root：只有面板内部用这些别名（页签标题那个 span
      不带类、也不引用它们），而 :root 上的 currentColor 是文档根的颜色，会让
      "对本地颜色做偏移"这条性质在局部失去意义。
   ⚠️ 故意**没有**换掉的那几处 opacity：.drc-quote(.85) / .drc-badge(.8) 是"容器级
      的轻微压暗"（不是为了表达三级文字），:disabled(.45) 与 :hover(.75/1) 是**交互
      反馈**。把它们换成离散的 label 档会**过度压暗**（宿主的 label 档是粗粒度阶梯，
      而这里是一条 .35→.85 的细阶梯）。 */
.drc-root {
  --drc-ink: var(--dsw-alias-brand-primary, currentColor);
  /* 线的四档。宿主有 border-l1..l4（浅色 ≈ 4% / 10% / 12% / 16% 的墨），而我们原本
     是 7 档 alpha（.2/.24/.25/.28/.35/.4/.45）—— **全部比宿主最重的那一档还重**。
     这里保住原本的轻重次序、收进宿主的四档；回落也照原阶梯给，所以"一个宿主 token
     都没有"时观感与从前一致（不会因为对齐而突然变淡或变重）。 */
  --drc-line-1: var(--dsw-alias-border-l1, rgba(128,128,128,.2));
  --drc-line-2: var(--dsw-alias-border-l2, rgba(128,128,128,.27));
  --drc-line-3: var(--dsw-alias-border-l3, rgba(128,128,128,.35));
  --drc-line-4: var(--dsw-alias-border-l4, rgba(128,128,128,.44));
  --drc-select-border: var(--dsw-alias-button-ghost-active-border, rgba(128,128,128,.6));
  --drc-select-fill: var(--dsw-alias-button-ghost-active-fill, rgba(128,128,128,.14));
  --drc-text-1: var(--dsw-alias-label-primary, currentColor);
  --drc-text-2: var(--dsw-alias-label-secondary, color-mix(in oklab, currentColor 75%, transparent));
  --drc-text-3: var(--dsw-alias-label-tertiary, color-mix(in oklab, currentColor 60%, transparent));
  --drc-text-4: var(--dsw-alias-label-caption, color-mix(in oklab, currentColor 40%, transparent));
  /* 两个状态色。宿主的三档**各自带深色变体**（例如 error 浅色是 red-600、深色换
     red-400），所以从前写死的 bootstrap 系颜色不仅不跟随主题，也从来没做过深色适配。
     ⚠️ 曾经还有第三个别名 --drc-success（配 .drc-ok 那条提示样式）—— 提示条改成浮动
     toast 之后它们**没有任何使用者了**，于 v2.2.1 体检时一并删掉。借来的别名**没人用
     就该还回去**，否则别名层会慢慢变成一份"看起来都在用"的清单。 */
  --drc-danger: var(--dsw-alias-state-error-primary, #d9534f);
  /* 成功色：只给「导出结果」这类"好消息"用（宿主自己也在用 state-success-primary）。 */
  --drc-ok: var(--dsw-alias-state-success-primary, #2e7d32);
  --drc-warn: var(--dsw-alias-state-warn-primary, rgba(200,140,40,.75));
  /* 选中文字的高亮。⚠️ 宿主**没有**定义 ::selection（整棵安装树搜过），也没有现成的
     "文字选中"底色：--dsw-alias-bg-multi-select 在浅色下是 neutral-bluish-60（**近白**）
     —— 读者实测"像纯白，看不出选中了哪儿"。所以这里用宿主的两个 alias **现算一个暖灰**：
     墨（**随主题翻转**）+ 一点警告色（暖，朝读者说的"灰褐"那个方向）。
     这不是写死颜色，而是"关系"：**墨偏暖 18%，再以 34% 铺上去**。
       · 浅色：82% 近黑 + 18% 琥珀 → 深暖褐；34% 铺在白底上 = 明显的暖灰。
       · 深色：82% 近白 + 18% 琥珀 → 暖奶油；34% 铺在深底上 = 暖灰高光。
     ⚠️ **34% 是对标来的**：read-aware 的选中色是 rgba(168,162,158,.34)（暖灰、三四成），
        而且它三个主题共用同一个值。我们原来是 22% —— 读者实测"偏淡/看不出"，所以抬到 34%。
     ⚠️ 两个数字就是旋钮：嫌浓就降这个 34%，嫌偏黄就降那个 18%。深色目前与浅色同值，
        真机若觉得太亮，再分极性（read-aware 深色用的是 0.28）。 */
  --drc-select-seed: color-mix(in oklab, var(--dsw-alias-label-primary) 82%, var(--dsw-alias-state-warn-primary));
  --drc-selection: color-mix(in oklab, var(--drc-select-seed) 34%, transparent);
  /* 面（底色）。⚠️ 宿主在**浅色**下 bg-layer-1/2/3 **都等于 base** —— 它表达层级靠
     描边、不靠填充。所以"凹陷 / 抬升"这两类**不能用 bg-layer 系列**：浅色下会和页面
     同色，读者看不出那儿有个块。改用两类在两种主题下都区别于 base 的 token。 */
  --drc-block: var(--dsw-alias-markdown-code-block, rgba(128,128,128,.08)); /* 引用块 / AI 回应 / 代码块 */
  --drc-wash: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.06)); /* 悬停、插入物 */
  --drc-wash-strong: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.12)); /* 当前项 */
  /* ⚠️ 按钮的面**刻意保持透明**，不借宿主那几个 button-*-fill：宿主那几档是给
     "浮起的白色按钮"用的（button-elevated-fill 在浅色下就是 #fff），而我们面板里是
     **描边式小按钮** —— 借过来的结果是浅色下变成一片白块，读者真机否掉了
     （"按钮的颜色变白了，这一部分不用改"）。透明 = 面板底色透出来，与从前一致。
     这是"我们自己的"一个值，按规矩写在别名层里。 */
  --drc-raise: transparent;
  /* 浮动提示条的两种壳（观感对标 MilkFeng/lumina 的 ToastBubble，MIT）。
     ⚠️ 宿主**没有** inverse 语义 token（整棵安装树搜过），所以"反色"是用宿主自己的两个值
     **互相顶替**拼出来的：墨色当面、底色当字。
       · 浅色：近黑的面 + 白字；深色：近白的面 + 近黑字 —— 自动翻转，换肤插件改了它也跟着改。
     这不是写死颜色，是"关系"。错误那一档用它自己的语义色当面（字号小，取对比度更稳的那对）。 */
  --drc-toast-bg: var(--dsw-alias-label-primary);
  --drc-toast-fg: var(--dsw-alias-bg-base);
  --drc-toast-error-bg: var(--dsw-alias-state-error-primary);
  /* 字体族。宿主真名是 --dsw-font-family；等宽那族由
     --dsw-font-markdown-code-block-font-family 转发到 --ds-font-family-code（SF Mono / Consolas…）。 */
  --drc-font-ui: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
  --drc-font-code: var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace);
  /* 纸感：取宿主 bg-base 的现值当基准，我们只贡献"掺多少暖色"（见 paperStyleOf）。 */
  --drc-paper-base: var(--dsw-alias-bg-base);
  --drc-paper: #f4ecd8;
}
/* 纸感的深色一极。⚠️ 深色下掺的是**暖炭**而不是米黄 —— 米黄铺在深色上就是一块奶油砖，
   那才是真正"和主题打架"的样子。宿主自己的深色契约是 body 上的属性，用它分极性。
   ⚠️ 写成多条属性、让字面量单独占一行：守卫要求"我们自己的颜色"写在 --drc-…: 开头的行上。 */
body[data-ds-dark-theme] .drc-root {
  --drc-paper: #17140f;
}

.drc-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  font-size: 13px;
  line-height: 1.7;
  color: var(--drc-text-1);
  overflow: hidden;
  /* 界面文字默认**不可选中**（见下面那条例外表）。 */
  user-select: none;
  /* 浮动提示条的定位基准。⚠️ 我们全库**没有别的绝对定位**，所以加这一行不会挪动任何东西；
     提示条用 absolute 而不是 fixed：fixed 是相对视口居中，而面板在右侧栏里，
     那样它会飘到整个窗口的中间去。 */
  position: relative;
}

/* 可选中文字的**例外**：这些内容都是"你要拿去用的东西"，必须能选、能复制。
   ⚠️ 其中 **.drc-article 是最关键的一条** —— 选不中正文，「记笔记」的摘抄功能
   直接废掉（读者选中一段 → 面板浮出操作条，那条路全靠这里能选）。
   其余三类：输入控件 / 笔记里的三段文本（你可能想复制自己的笔记）/ AI 视角预览
   （它存在的意义就是"逐行核对"，读不出去等于没用）。
   导入说明里带着收件箱路径，也留着可选（「复制路径」按钮是主路，手选是备路）。 */
.drc-root input,
.drc-root textarea,
.drc-root select,
.drc-root .drc-article,
.drc-root .drc-quote,
.drc-root .drc-thought,
.drc-root .drc-reply,
.drc-root .drc-pre,
.drc-root .drc-import-hint { user-select: text; }

/* 选中文字的高亮（读者两轮反馈：先"这蓝太亮"、再"变成纯白看不出"）。
   只设 background、**不动 color**：文字色交给主题，免得选中态与正文的对比度自己失控
   （浏览器默认会同时给反色，两层叠在深浅主题切换时最容易出错）。
   选择器写成 .drc-root 的后代：只作用面板内部，不碰宿主其它界面。 */
.drc-root ::selection { background: var(--drc-selection); }
.drc-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--drc-line-2);
  flex: 0 0 auto;
}
.drc-bar-title { font-weight: 600; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drc-body { flex: 1 1 auto; overflow: auto; position: relative; }
/* 阅读区专属：给「居中的正文」补偿滚动条占位（读者反馈"文本更靠近左边了一些"）。
   max-width: 36em + margin: 0 auto 的居中是在**扣掉竖直滚动条之后**的宽度里做的，
   而滚动条只占右侧 ~15px —— 于是右内边距比左内边距大出一个滚动条宽，肉眼就是整体偏左。
   both-edges 让两侧都预留同样的槽，居中就回到"相对整个面板"居中。
   ⚠️ **只给阅读区加**：书架 / 目录 / 笔记那几页的正文是**左对齐**的（没有 margin:auto），
   给它们加左侧空槽只会凭空多出一块空白。 */
.drc-body-reader { scrollbar-gutter: stable both-edges; }
.drc-pad { padding: 10px; }

button.drc-btn {
  font: inherit;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--drc-line-3);
  background: var(--drc-raise);
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
button.drc-btn:hover:not(:disabled) { border-color: var(--drc-line-4); }
button.drc-btn:disabled { opacity: .45; cursor: default; }
button.drc-btn-primary { border-color: var(--drc-ink); }
/* 分段控件里「当前生效」的那一档。只用边框色太弱 —— 三选一的控件必须让人
   一眼看出选中的是哪个，否则读者会以为点了没反应。
   ⚠️ **不要在这里加 font-weight（v1.62 去掉的 600）**：选中态变粗会让那一颗
   变宽，于是切换时**整行左右抖一下**（「笔记（5）」比「草稿（0）」宽，左边的变粗
   等于把右边的顶走）。选中靠**底色 + 边框色**表达就够（界面上一直是这么显示的），
   而且读屏那边还有 aria-pressed。
   ⚠️ 本段是 JS 模板字符串里的 CSS：**注释里不许出现反引号**（会提前闭合模板串，
   见 docs/design-v1-archive.md 的 v1.49 §313）—— 所以这里一律用「」引词。 */
button.drc-btn-on {
  border-color: var(--drc-select-border);
  background: var(--drc-select-fill);
}
/* 三个分页选项卡那一行。
   ⚠️ 它**必须自带左右内边距**（v1.62）：这一行是 .drc-body 的直接子节点，而
   .drc-body 没有内边距（那一层的内边距一向由 .drc-section 提供）—— 少了这 10px，
   它会比同页的表单元素左 6px、比列表里的笔记文字左 21px（截图上量出来的原话：
   "tab 的 ui 有一点没对齐"）。 */
.drc-tabs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 8px 10px 0; }
/* 计数（「（5）」）：数字用等宽字形，切换 tab 时不会因为 1 与 8 的宽度差而抖；
   0 淡一点，让"这一栏是空的"自己也说得出口。 */
.drc-tab-num { margin-left: 2px; font-variant-numeric: tabular-nums; color: var(--drc-text-2); }
.drc-tab-num-zero { color: var(--drc-text-4); }
.drc-section { padding: 10px; border-bottom: 1px solid var(--drc-line-1); }
.drc-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
/* 笔记编辑区 */
.drc-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.drc-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--drc-line-3);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.drc-chip-on { border-color: var(--drc-select-border); }
.drc-field { margin: 0 0 8px; }
.drc-label { display: block; font-size: 11px; color: var(--drc-text-2); margin: 0 0 3px; }
/* 可折叠的标题：书架的分类、背景认识里的人物卡，共用同一套外观与交互。
   ⚠️ 它们各自的基类不同（.drc-label / .drc-item-sub）—— 字号与颜色沿用基类，
   这里只补"它其实是个按钮"这件事，所以必须写在基类**之后**（同权重，后写的赢）。 */
.drc-cat-toggle,
.drc-card-toggle {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.drc-cat-toggle:hover,
.drc-card-toggle:hover { opacity: .75; }
/* 三角只占一格，靠换字形表示开合（不旋转图标：少一个动画，就少一处会和
   "减少动态偏好"打架的地方）。 */
.drc-cat-caret { flex: 0 0 auto; font-size: 9px; opacity: .8; }
textarea.drc-input { width: 100%; resize: vertical; font-family: inherit; line-height: 1.6; }
.drc-selected {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  margin: 0 12px 6px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--drc-select-border);
  font-size: 11px;
}
/* ⚠️ 水平内边距**必须是 0**（v1.67 统一左基线）：列表项的左边界要落在 .drc-section
   的内容基线上，与那一行的 tab、表单控件、drc-item-sub 说明文字**同一条线**。
   从前这里是 8px 10px，于是笔记标题比同一页的表单元素右 10px —— 读者原话是
   "tab 的 ui 有一点没对齐"，追到底是这一页有**三条**左基线（16 / 10 / 31px）。
   ⚠️ 本条注释自己就踩过坑：这里**不许出现反引号**（会提前闭合模板串，v1.62 写下的规矩，
   v1.67 我又违反了一次）—— 引词一律用「」。 */
.drc-note-item { border-bottom: 1px solid var(--drc-line-1); padding: 8px 0; }
.drc-note-head { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
/* 正文字体设置条 */
.drc-fontbar {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--drc-line-1);
  font-size: 11px;
}
.drc-fontval { min-width: 2.6em; text-align: center; color: var(--drc-text-2); font-family: var(--drc-font-code); }
.drc-fontsep { color: var(--drc-text-4); margin: 0 2px; }
/* 笔记正文：记完必须能**读**回来，否则笔记等于没记。 */
.drc-quote {
  margin: 6px 0;
  padding: 2px 0 2px 8px;
  border-left: 2px solid var(--drc-line-4);
  opacity: .85;
  white-space: pre-wrap;
  word-break: break-word;
}
.drc-thought { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; }
.drc-reply {
  margin: 6px 0 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--drc-block);
  white-space: pre-wrap;
  word-break: break-word;
}
.drc-inline-label { font-size: 11px; color: var(--drc-text-3); margin-right: 4px; }
.drc-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 0; }
/* AI 视角预览：必须是等宽 + 可滚动，用户才有可能真的逐行核对。 */
.drc-pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--drc-font-code);
  font-size: 11px;
  line-height: 1.5;
  background: var(--drc-block);
  border: 1px solid var(--drc-line-2);
  border-radius: 6px;
  padding: 8px;
  max-height: 46vh;
  overflow: auto;
  margin: 8px 0 0;
}

.drc-list { list-style: none; margin: 0; padding: 0; }
.drc-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.drc-item:hover { background: var(--drc-wash); }
.drc-item-main { flex: 1 1 auto; min-width: 0; }
.drc-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drc-item-sub { font-size: 11px; color: var(--drc-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drc-item-cur { background: var(--drc-wash-strong); font-weight: 600; }
.drc-item-num { font-size: 11px; color: var(--drc-text-3); font-family: var(--drc-font-code); }

/* 正文页里那块「本章你记过 N 条」。
   ⚠️ 它长在**阅读区**里，而阅读区整块套着读者的字体偏好（「fontStyleOf」：字号 / 行距 / 字体族），
   所以这里必须**显式换回界面字体**并锁死字号 —— 否则笔记摘要与小说正文长得一模一样，
   分不清哪是「我写的」、哪是「书里写的」。读者的真机反馈原话：
   「多条笔记的目录和正文字体没有区分，会有些不好用」。 */
.drc-chapter-notes {
  font-family: var(--drc-font-ui);
  font-size: 12.5px;
  line-height: 1.65;
  margin: 8px 0 10px;
  padding: 6px 8px;
  border: 1px solid var(--drc-line-2);
  border-radius: 6px;
  background: var(--drc-wash);
}

/* 二级确认条：三处共用（解锁「已读完」/ 跳读闸 / 回收站确认删除·清空）。
   与「.drc-chapter-notes」同一套观感 —— 都是「界面插入物」，不是正文。 */
.drc-confirm {
  margin: 8px 0;
  padding: 8px 10px;
  border: 1px solid var(--drc-line-2);
  border-left: 3px solid var(--drc-warn);
  border-radius: 6px;
  background: var(--drc-wash);
}
.drc-confirm-text { line-height: 1.7; }
.drc-volume { font-size: 11px; color: var(--drc-text-3); padding: 10px 8px 3px; }

/* 书架：每本书右侧的控制区（绑定状态 + 分类下拉）。 */
.drc-shelf-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.drc-cat-edit { display: flex; align-items: center; gap: 4px; }

/* .drc-badge 一直被用（「含 AI 回应」）但从来没定义过样式，顺手补上。 */
.drc-badge {
  font-size: 10px;
  line-height: 1.7;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--drc-line-3);
  opacity: .8;
  white-space: nowrap;
}
.drc-badge-muted { color: var(--drc-text-3); }

/* 用两个 class 提高优先级去覆盖 button.drc-btn 的内边距，而不是加 !important。 */
button.drc-btn.drc-btn-small { font-size: 10px; padding: 1px 6px; }
.drc-input.drc-input-small { flex: 0 0 auto; width: 8.5em; font-size: 11px; padding: 1px 4px; }

/* 目录筛选条。上千章的书（实测《一世之尊》1404 章）全靠它定位——在那本书里
   「滚到第 812 章」本来要划过七千来个元素。输入框刻意允许拉宽（用 flex:1
   覆盖上面 .drc-input-small 的固定 8.5em），因为筛选词可能是章节标题。 */
.drc-toc-filter { display: flex; align-items: center; gap: 6px; padding: 4px 0 8px; }
.drc-toc-filter .drc-input { flex: 1 1 auto; width: auto; min-width: 0; font-size: 12px; }
.drc-toc-filter .drc-item-sub { flex: 0 0 auto; white-space: nowrap; }

/* 卷标题：可点（展开/收起），右侧显示「起止章号 · 章数」。
   折叠的意义是把 1400 章的书从"一次铺七千个元素"降到"只渲染当前卷"。 */
.drc-volume-btn { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; cursor: pointer; user-select: none; }
.drc-volume-btn:hover { opacity: .75; }

.drc-note { padding: 10px; color: var(--drc-text-3); }
.drc-warn { font-size: 11px; opacity: .7; border-left: 2px solid var(--drc-line-4); padding-left: 8px; margin: 8px 0; }

/* 「导入说明」折条。默认只占一行，展开才是列表 —— 和目录筛选条同一个理由：
   面板很窄，而这条信息只在"怀疑正文有问题"或"想知道这份正文是从哪来的"时
   才有用。它是**可点的一行文字**而不是按钮：它旁边没有别的动作，做成按钮会
   让目录页顶部挤满方块。 */
.drc-import { margin: 8px 0; }
.drc-import-toggle {
  display: block; width: 100%; text-align: left; cursor: pointer;
  background: none; border: none; padding: 0; font: inherit; color: inherit;
  font-size: 11px; color: var(--drc-text-3);
}
.drc-import-toggle:hover { color: var(--drc-text-1); }
.drc-import-list {
  margin: 6px 0 0; padding: 0 0 0 8px; list-style: none;
  border-left: 2px solid var(--drc-line-4);
  font-size: 11px; color: var(--drc-text-3);
}
.drc-import-list li { margin: 2px 0; }

/* 导入区那两句说明 **必须能换行**。
   它们从前借用的「.drc-item-sub」是单行省略号样式（书架列表要的正是那个），于是
   「导入成功后，收件箱里那份会移到 .imported/（不删除）」被截成「导入…」——
   恰好把最不能省的那半句省掉了。overflow-wrap 是让那个长绝对路径在窄面板里换行，
   而不是把卡片撑破。 */
.drc-import-hint { font-size: 11px; color: var(--drc-text-3); line-height: 1.5; margin-bottom: 4px; white-space: normal; overflow-wrap: anywhere; }

/* 收件箱那三颗动作按钮：**排成一行**（读者指定；他最初的意思只是把「扫描导入目录」
   提到另外两颗所在的那一行）。flex-wrap 是为了窄面板里宁可折行，也别挤成三个窄条。
   ⚠️ 不要再改成竖排 —— 读者看过真机后说"太占空间"。 */
.drc-import-actions { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; }
.drc-error { padding: 10px; color: var(--drc-danger); }

/* ---- 浮动提示条（观感对标 MilkFeng/lumina 的 ToastBubble / ToastService，MIT）----
   照搬的是这几条**观感规格**：胶囊圆角 999、毛玻璃、**永不堆叠**（同一时刻只有一个）、
   底部居中、进出场 250ms、停留 3000ms、点击即消。
   两处**必要的本地化**，都写在这里以免以后被当成"没照做"：
     ① 颜色走我们的别名层（宿主墨色/底色互相顶替），不写死 —— 所以它跟着主题与皮肤走；
     ② 底色的不透明度取 **90%**（它用 80%）：我们是 12px 的小字 + 更窄的面板，
        再透一点就开始影响可读性了。
   内容超过 60 字时**不自动消失**（见组件里的规则）：我们的提示里有"导入结果"这种要留给人
   读的信息，3 秒后消失等于丢信息。 */
.drc-toast-wrap {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 16px;
  display: flex;
  justify-content: center;
  padding: 0 12px;
  /* 壳不吃点击：只有胶囊本身可点，免得它挡住底下的东西。 */
  pointer-events: none;
  z-index: 30;
}
.drc-toast {
  pointer-events: auto;
  max-width: 100%;
  padding: 10px 14px;
  border-radius: 999px;
  /* ⚠️ 不透明度是毛玻璃能不能被看见的开关：90% 时背后的内容几乎透不过来，
     模糊了也等于没模糊（读者实测"效果好像没生效"）。85% 是两者兼顾的位置。 */
  background: color-mix(in oklab, var(--drc-toast-bg) 85%, transparent);
  color: var(--drc-toast-fg);
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  cursor: pointer;
  animation: drc-toast-in 250ms cubic-bezier(.22, 1, .36, 1);
}
/* 长提示：多行 + 不自动消失，所以换形状（圆角矩形、左对齐），别硬套胶囊。 */
.drc-toast-long {
  border-radius: 14px;
  text-align: left;
}
.drc-toast-error {
  background: color-mix(in oklab, var(--drc-toast-error-bg) 85%, transparent);
  color: var(--drc-toast-fg);
}
/* 导出结果那一行（常驻在「导出到笔记库」的说明里，不走弹窗）：成功绿、失败红。 */
.drc-export-line { font-size: 11px; line-height: 1.45; word-break: break-all; }
.drc-export-ok { color: var(--drc-ok); }
.drc-export-fail { color: var(--drc-danger); }
@keyframes drc-toast-in {
  from { opacity: 0; transform: translateY(25%) scale(.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
/* 面层不加阴影（我们的规矩）：胶囊靠不透明底色和毛玻璃分层，不靠阴影。 */
.drc-toast { box-shadow: none; }
@media (prefers-reduced-motion: reduce) {
  .drc-toast { animation: none; }
}
.drc-card {
  border: 1px solid var(--drc-line-2);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}

/* 正文栏。
   行宽用 em 是**刻意的**：em 解析成正文自身的字号，所以调大字号时每行字数
   不变，只是整栏变宽——「一行多少字」才是阅读舒适度的自变量，像素宽度不是。
   42em 在中文里就是 42 字/行，偏宽；36em 落在中文长文比较舒服的区间。
   顶部留白从 4px 提到 10px：原来第一行几乎贴住工具栏，读起来像被切掉一截。 */
.drc-article { padding: 10px 16px 64px; max-width: 36em; margin: 0 auto; }

/* ⚠️ 章节标题必须用 em，**不能用 px**。
   正文字号是用户可调的（13–30px，见 DEFAULT_FONT_PREFS）。写死 15px 的话：
   默认 16px 时标题就已经**比正文小**，把字号调到 20px 之后标题会明显"塌"
   进正文里，章节与段落的层级彻底消失。em 让标题跟随正文字号一起缩放，
   任何字号下都保持同一个比例关系。 */
.drc-article h2 { font-size: 1.3em; line-height: 1.4; margin: 1.2em 0 .7em; }

.drc-article p { margin: 0 0 1em; text-indent: 2em; }
/* 标题后的第一段：保留 2em 缩进（中文排版惯例），但不叠加标题的下边距。 */
.drc-article h2 + p { margin-top: 0; }
.drc-progress {
  flex: 0 0 auto;
  height: 2px;
  background: var(--drc-ink);
  width: 0;
  transition: width .15s linear;
}
.drc-input {
  font: inherit;
  font-size: 12px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid var(--drc-line-3);
  background: transparent;
  color: inherit;
}
`
    /**
     * 幂等注入样式表。
     *
     * 幂等是**必须**的：插件 stop→start 或热更新时 apply 会重跑，若每次
     * 都 append 一个 <style>，样式元素会无界累积。这也是 dsh-reader 踩过
     * 的同类坑（它的幂等旗标只置真不重置，导致更新后再也挂不上）。
     *
     * @returns {() => void} 卸载函数
     */
    function installStyles() {
      const existing = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
      if (existing !== null) {
        // 已存在：可能是上一轮 fiber 留下的，接管它并在卸载时移除。
        return () => existing.remove()
      }
      const el = document.createElement('style')
      el.setAttribute('data-plugin-css', CSS_ID)
      el.textContent = CSS_TEXT
      document.head.appendChild(el)
      return () => el.remove()
    }
    //#endregion

    //#region 数据访问
    /**
     * 调宿主半边的 JSON 接口。
     *
     * @param {string} path API_ROOT 之后的短路径，例如 '/health'
     * @param {object} [options] { method, body, signal }
     * @returns {Promise<any>} 已解析的 JSON
     * @throws {Error} 网络失败或非 2xx
     */
    async function callApi(path, options = {}) {
      const { method = 'GET', body, signal } = options
      const res = await fetch(`${API_ROOT}${path}`, {
        method,
        signal,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      let parsed
      try {
        parsed = text === '' ? null : JSON.parse(text)
      } catch {
        throw new Error(`宿主返回了非 JSON 响应（HTTP ${res.status}）`)
      }
      if (!res.ok) {
        const error = new Error(parsed?.reason ?? parsed?.message ?? parsed?.error ?? `HTTP ${res.status}`)
        // 结构化信息挂在 Error 上。像**跳读闸**那种"失败"其实不是失败，而是
        // "请你选一个"——光有文案的话界面只能把它渲染成一行红字，而那句话里
        // 塞着两个选项，用户没有可点的地方。
        error.status = res.status
        error.body = parsed
        throw error
      }
      return parsed
    }

    /** 把任意异常转成可显示的一行文案。 */
    const describeError = (error) => (error instanceof Error ? error.message : String(error))

    /**
     * 让操作系统的文件管理器打开某个目录。
     *
     * 走宿主 open-in-app 的公开契约（见 `OPEN_IN_APP_APPS_ROUTE` 的说明）：
     * 先问有哪些应用，再从里面挑一个"打开文件夹"的，最后请宿主启动它。
     *
     * ## 三条刻意的取舍
     *
     *   1. **探测失败要说清楚，不能静默。** 老宿主没有这条路由、或宿主没探到
     *      文件管理器时，读者点下去必须有回音 —— 一个点了没反应的按钮比没有这个
     *      按钮更糟。
     *   2. **不写死平台。** 挑应用靠清单（`FILE_MANAGER_APP_IDS`），不靠
     *      `process.platform` 之类我们其实拿不到的东西。
     *   3. **不缓存探测结果。** 每次点都问一次：应用是可能被装上/卸掉的，而这是
     *      一次本地 HTTP 往返，成本可以忽略；换来的是"不会拿着过期的清单"。
     *
     * @param {string} path 要打开的绝对路径
     * @returns {Promise<void>} 失败时抛带可读文案的 Error
     */
    async function openPathInFileManager(path) {
      const listed = await fetch(OPEN_IN_APP_APPS_ROUTE)
      // 措辞刻意留了两义：这个 DSH 版本没有 open-in-app，与渲染器令牌没被接受，
      // 都会走到这里（实测从命令行直接 GET 得到的是 403，两者无法从状态码区分）。
      // 不猜是哪一种，也不假装成功。
      if (!listed.ok) throw new Error(`宿主没有放行 open-in-app（HTTP ${listed.status}），这次打不开目录`)
      const payload = await listed.json()
      const app = pickFileManagerApp(payload?.apps)
      if (app === null) throw new Error('宿主没探到能打开文件夹的应用（explorer / finder / filemanager）')
      const opened = await fetch(OPEN_IN_APP_OPEN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app, path }),
      })
      if (!opened.ok) throw new Error(`打开目录失败（HTTP ${opened.status}）`)
    }

    /**
     * 复制一段文字到剪贴板。
     *
     * 只走 `navigator.clipboard`（DSH 是 Electron 的安全上下文，它一直在），
     * 拿不到或写失败就**如实返回 false**。刻意不做 hidden textarea +
     * `execCommand('copy')` 那套兜底：它已废弃，而且在权限被拒时会"看起来成功了"——
     * 读者以为路径进了剪贴板，粘出来是上一次的东西。
     *
     * @param {string} text
     * @returns {Promise<boolean>} 是否真的写进去了
     */
    async function copyText(text) {
      try {
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /**
     * 跑一次导出，把结果整理成一句给界面看的话。
     *
     * 两个入口（「陪读」页与「笔记」页）共用它，所以**行为与文案只有这一份** ——
     * 这正是仓库里既有的做法（「正文顶部那颗笔记按钮」与「目录里的笔记」两个入口
     * 行为完全一致，靠的就是共用同一个动作）。
     *
     * @param {string} bookId
     * @param {string} dir 导出目录；空串 = 交给宿主按「设置 > 会话工作区根」现算
     * @returns {Promise<{ kind: 'ok'|'error', text: string }>} 直接能塞进 notice 的形状
     */
    async function exportBookFiles(bookId, dir) {
      const trimmed = typeof dir === 'string' ? dir.trim() : ''
      try {
        const data = await callApi(`/books/${bookId}/export`, {
          method: 'POST',
          body: trimmed === '' ? {} : { dir: trimmed },
        })
        const files = Array.isArray(data.files) ? data.files : []
        const created = files.filter((file) => file.action === 'create').length
        const updated = files.filter((file) => file.action === 'update' || file.action === 'append').length
        const parts = [`已导出 ${files.length} 个文件到 ${data.dir}`]
        parts.push(`新建 ${created} · 更新 ${updated} · 未变 ${files.length - created - updated}`)
        if ((data.notes?.appended ?? 0) > 0) parts.push(`本次追加了 ${data.notes.appended} 条新笔记`)
        if (Array.isArray(data.warnings) && data.warnings.length > 0) parts.push(data.warnings.join('；'))
        return {
          kind: 'ok',
          text: parts.join('。'),
          // ⚠️ 另外给一份**结构化的**结果，供「导出到笔记库」那节**常驻显示**
          //    （读者 2026-10-01：这条提示太长，走 toast 会永远不消失 ✗ —— 改成标在说明里，
          //    并记住"上次导出是什么时候"）。
          detail: {
            at: new Date().toISOString(),
            dir: data.dir,
            created,
            updated,
            unchanged: files.length - created - updated,
            appended: data.notes?.appended ?? 0,
            warnings: Array.isArray(data.warnings) ? data.warnings : [],
          },
        }
      } catch (error) {
        return { kind: 'error', text: describeError(error), detail: null }
      }
    }

    /**
     * 一处需要**二级确认（或二选一）**的说明条 —— 三处共用：解锁「已读完」、跳读闸、
     * 回收站的确认删除 / 清空。
     *
     * ## 为什么要有它
     *
     * 这三处的共同点是「**先把后果说清，再给你两个写了动词的按钮**」。而从前它们是三种
     * 形态：解锁用浏览器原生 `window.confirm`、跳读闸自己一套、回收站还没有 —— 读者在
     * 每个地方都得重新学一遍「点下去会发生什么」。
     *
     * ## 不对称原则（与插件其它地方一致）
     *
     * **收紧安全 / 可逆的动作不确认**（收回解锁、删除进回收站都是**一键即时**）；
     * **放宽约束 / 不可逆的才确认**（解锁、确认删除、清空）。
     *
     * ⚠️ 第二个按钮**不一定**是「取消」：跳读闸的第二个按钮是另一个动作（只记最近这一段）。
     * 所以参数叫 `primary` / `secondary`，而不是 `confirm` / `cancel`。
     *
     * @param {object} input
     * @param {string} input.text 后果说明 —— **必须具体**：会发生什么、影响哪一部分
     * @param {{ label: string, onClick: () => void }} input.primary 第一个按钮（主色）
     * @param {{ label: string, onClick: () => void }} input.secondary 第二个按钮
     * @param {Array} [input.extra] 额外渲染的内容（例如预估的批数与每章字数），画在按钮之上
     * @param {boolean} [input.busy] 进行中：两个按钮都禁用
     * @returns {object} vnode
     */
    function confirmBar(input) {
      const primary = input?.primary ?? {}
      const secondary = input?.secondary ?? {}
      const extra = Array.isArray(input?.extra) ? input.extra : []
      return h(
        'div',
        { className: 'drc-confirm' },
        h('div', { className: 'drc-confirm-text' }, input?.text ?? ''),
        ...extra,
        h(
          'div',
          { className: 'drc-row', style: { marginTop: 8 } },
          h(
            'button',
            {
              type: 'button',
              className: 'drc-btn drc-btn-primary',
              disabled: input?.busy === true,
              onClick: () => primary.onClick?.(),
            },
            primary.label ?? '确定',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'drc-btn',
              disabled: input?.busy === true,
              onClick: () => secondary.onClick?.(),
            },
            secondary.label ?? '取消',
          ),
        ),
      )
    }

    /**
     * 从一次失败的 `callApi` 里认出**跳读闸**，把它变成界面可渲染的选择。
     *
     * 跳读闸回的是 409，但它**不是错误**——是"请你先表态"。认不出来（别的失败）
     * 就回 `null`，调用方照旧显示一行错误文案。
     *
     * ⚠️ 判据要求 `gap` 真的存在：只有 `error === 'LARGE_GAP'` 而**没有**缺口
     * 区间时，界面渲染不出有意义的选择，那时退回普通错误比渲染两个点下去会坏
     * 的按钮好。
     *
     * @param {unknown} error `callApi` 抛出的错误
     * @returns {{ gap: object, gate: number|null, recentWindow: number|null, estimate: object|null }|null}
     */
    function gatePromptOf(error) {
      const body = error?.body
      if (body === null || body === undefined || body.error !== 'LARGE_GAP') return null
      if (body.gap === null || body.gap === undefined || typeof body.gap !== 'object') return null
      return {
        gap: body.gap,
        gate: Number.isInteger(body.gate) ? body.gate : null,
        // 窗口的默认值由宿主算（配置里那个数），客户端不自己猜一个。
        recentWindow: Number.isInteger(body.recentWindow) ? body.recentWindow : null,
        // 两个预估（约几批 / 每章多少字）也由宿主算好 —— *预算 → 批数* 这条算术
        // 只该有一处实现，客户端再算一遍迟早就分叉。
        estimate: body.estimate !== null && typeof body.estimate === 'object' ? body.estimate : null,
      }
    }

    /**
     * 把"顺手补前文记忆"这一趟的结果，变成一句**必须属实**的话。
     *
     * ⚠️ 这里曾经是无条件的「前文记忆已更新」。而补齐调用是 `.catch(() => null)`，
     * 结果被整个丢掉——于是**跳读闸拦下、宿主调用失败、网络断掉**三种情况下，
     * 读者看到的都是同一句"已更新"。这是一句关于"已经发生了什么"的陈述，不是愿望；
     * 说错了它，读者就会带着"记忆里有前文"的预期去聊，然后困惑于 AI 怎么不记得。
     * （同一个文件在 `grabSelection` 那里已经为这条原则留过注释：最不该做的就是"说了但没做"。）
     *
     * 三态各自成句，调用方只负责把它拼进自己的文案里，不再自己判断成败。
     *
     * @param {{kind:'ok', data:object}|{kind:'error', error:unknown, gate:object|null}} fill
     * @returns {string} 一句话，以「。」结尾
     */
    function memoryFillClause(fill) {
      if (fill === null || fill === undefined) return '前文记忆这次没有检查。'
      if (fill.kind === 'ok') {
        const data = fill.data ?? {}
        // `skipped` 是服务端的正式回答（没有缺口），不是失败。
        if (data.skipped === true) {
          // 自动打底却**没有可补的**（开头那几十章早就纳入过）：缺口还在，只是这一趟
          // 没事可干。照样要指路，否则读者会以为"没缺口"。
          if (data.autoFoundation === true) {
            return '前文记忆没有新增：开头的几十章早就纳入过了。更大的缺口请到面板点「补齐」手动补。'
          }
          return '前文记忆本来就是最新的，没有缺口。'
        }
        const covered = data.covered
        // ⚠️ 输出**像是被截断**时必须说出来（2026-10-02 读者实测"子代理超出 token 被截断"）：
        //    已写入的部分是有效的（背景只增不减），但"这次只补了一半"必须可见 ——
        //    不说的话读者会以为这一段补完了，而文件里可能少了后半截。
        const truncated = data.truncatedSuspected === true
          ? '⚠️ 这次的输出像是被截断了（超出模型单次输出上限）：已写入的部分保留，'
            + '建议把 `sample.budgetChars` 调小一些再补一次。'
          : ''
        // ⚠️ **自动压缩失败时也必须说出来**（2026-10-02 实测发现：某本书的背景认识已经
        //    16 KB —— 阈值的两倍多，而备份目录里**没有任何 `background.bak`** ⇒ 压缩从没成功
        //    落盘过，而界面上从来没提示过。文件一直超预算 ⇒ 每轮注入都被裁、缓存前缀每次都变）。
        //    以前这一支是**静默**的：读者只看到"记忆已更新"，不知道它已经胖到压不动。
        const compactNote = data.compact?.ok === false
          ? ` ⚠️ 顺手做的那次压缩没成功（${data.compact.reason ?? '未知原因'}），文件还是原来那么长；`
            + '到面板点「压缩背景认识」可看详情。'
          : ''
        // ⚠️ **冷归档也要说出来**（3.0）：把超出活跃窗口的旧条目搬进「冷档案」是**纯代码**做的、
        //    一个字都没删，但它们**从此不再进上下文** —— 这件事看不见，读者只会以为"AI 突然忘事了"。
        const archivedNote = data.archived?.moved > 0
          ? ` 另有 ${data.archived.moved} 条更早的记忆已**归档**（不再进上下文；原文仍在 `
            + '`background.md` 的「冷档案」里，随时可查、可取并集）。'
          : ''
        // ⚠️ 增量记录（`background.history/` 那件备份）**没写成时要明说**（2026-10-02 三方评审 P3-5）：
        //    "历代备份三件套"少一件是不可逆的 —— 那条 delta 记的是"这一笔搬走了什么"的**原文**，
        //    写失败时文件照旧被搬走，而读者以为备份齐全。
        const historyNote = data.archived?.moved > 0 && data.archived?.historyWritten === false
          ? '⚠️ 这次归档的**历代增量记录没写成功**（「冷档案」本身没问题）—— 建议先别再归档，查一下陪读文件夹是不是满了或只读。'
          : ''
        // ⚠️ 自动备份（3.0）：处理后的全文落到了导出文件夹的「自动备份」——不说明落点，
        //    读者会以为它只是"藏起来 / 删掉了"。
        const autoBackupNote = data.archived?.autoBackup?.path || data.compact?.autoBackup?.path
          ? '处理后的全文已导出到导出文件夹的「**自动备份**」子文件夹。'
          : ''
        const suffix = truncated + compactNote + archivedNote + historyNote + autoBackupNote
        if (covered !== null && covered !== undefined
          && Number.isInteger(covered.first) && Number.isInteger(covered.last)) {
          const base = `前文记忆已更新到第 ${covered.first}–${covered.last} 章。`
          // ⚠️ 大缺口时这一趟**只自动补了开头那几十章**（读者选定）：必须同时说清
          // "整段缺口没补完"与"去哪儿补"，否则读者会以为前文都补上了。
          return (data.autoFoundation === true
            ? `${base}缺口太大，这次**只自动补了开头这一段**；剩下的缺口请到面板点「补齐」手动补。`
            : base) + suffix
        }
        return `前文记忆已更新。${suffix}`
      }
      const prompt = fill.gate
      if (prompt !== null && prompt !== undefined) {
        // ⚠️ 这条现在只会在**宿主比客户端旧**时走到（新宿主对"没有 ask 的调用"一律走
        // 自动打底，不再回 409）。留着它比"认不出来就报个网络错误"诚实。
        const gap = prompt.gap ?? {}
        const span = Number.isInteger(gap.chapters) ? `（共 ${gap.chapters} 章）` : ''
        const limit = prompt.gate === null || prompt.gate === undefined ? '' : `（跳读闸 ${prompt.gate} 章）`
        // ⚠️ 这一句必须点明"没更新"。读者此刻手上还拿着"我点了发送"的动作感，
        // 不说清就会以为记忆跟着更新了。
        return `前文缺口是第 ${gap.from}–${gap.to} 章${span}，超过跳读闸${limit}，**没有**自动补，记忆没更新。`
          + '到面板点「补齐」，选「全部纳入」（这些章确实读过）或「只记最近这一段」（从这里接着读）。'
      }
      return `前文记忆这次没补上：${describeError(fill.error)}`
    }

    /**
     * 把「补齐前文记忆」从"点一次补一段"变成"点一次补到底"。
     *
     * 服务端每次调用只处理**一段**缺口（首次 30 章打底，之后按预算一批，见
     * `fillMemoryGap`），缺口大时回 `partial: true`。旧版把"再点一次继续"交给
     * 读者——于是一本跳读几百章的书要点十几次、等十几分钟，而中途没有任何进度。
     *
     * ⚠️ 循环放在**客户端**而不是服务端：那条路由是阻塞的，服务端自己转圈等于
     * 把一次 HTTP 请求拖过宿主的超时线；客户端循环天然能报进度、也能中途停。
     *
     * ⚠️ 四条出口缺一不可：
     *   1. `partial !== true`——本批已经补到底；
     *   2. `skipped === true`——下一批发现没有缺口了；
     *   3. **水位线没有前进**——兜底。若服务端因为任何原因回了 `partial: true`
     *      而 `covered.last` 不往前走，前两条都不成立，就会一直转下去。宁可停下
     *      并如实说"停在原地"，也不能让读者对着一个转不完的按钮干等；
     *   4. **批次上限**——服务端行为异常时的最后一道保险。
     *
     * @param {object} deps
     * @param {() => Promise<object>} deps.fill 一次补齐调用（抛错=失败）
     * @param {() => boolean} [deps.alive] 返回 false = 已被取消或被更新的一次运行取代
     * @param {(progress: object) => void} [deps.onProgress] 每批之后回调，用于报进度
     * @param {number} [deps.maxBatches] 批次上限，缺省 40
     * @returns {Promise<object>} 结构化结局，`kind` ∈ done / cancelled / stalled / capped / failed
     */
    async function runFillLoop({ fill, alive, onProgress, maxBatches }) {
      const stillAlive = typeof alive === 'function' ? alive : () => true
      const report = typeof onProgress === 'function' ? onProgress : () => {}
      const cap = Number.isInteger(maxBatches) && maxBatches > 0 ? maxBatches : 40

      let batches = 0
      let elapsedMs = 0
      let covered = null
      let remaining = null
      let advancedTo = null

      for (;;) {
        if (!stillAlive()) return { kind: 'cancelled', batches, elapsedMs, covered, remaining }

        let data
        try {
          data = await fill()
        } catch (error) {
          // 取消多半发生在请求还在飞的时候，那个错误是它的**后果**而不是失败本身。
          if (!stillAlive()) return { kind: 'cancelled', batches, elapsedMs, covered, remaining }
          return { kind: 'failed', batches, elapsedMs, covered, remaining, error }
        }
        if (!stillAlive()) return { kind: 'cancelled', batches, elapsedMs, covered, remaining }
        if (data === null || typeof data !== 'object') {
          return {
            kind: 'failed',
            batches,
            elapsedMs,
            covered,
            remaining,
            error: new Error('补齐接口没有返回可读的结果。'),
          }
        }

        // 服务端的正式回答：没有缺口。这一次没有花任何模型调用。
        if (data.skipped === true) {
          return {
            kind: 'done',
            skipped: true,
            // ⚠️ 读者在这一次补齐期间**清空过背景认识** ⇒ 这一批的结果被整批丢弃
            //    （服务端一个字都没写）。**必须转出去**：否则下面那句
            //    "前文已经都在记忆里了"会变成一句谎话（刚清空，缺口是全书）。
            resetDuringFill: data.resetDuringFill === true,
            batches,
            elapsedMs,
            covered: data.covered ?? covered,
            remaining: 0,
          }
        }

        batches += 1
        elapsedMs += Number.isFinite(data.elapsedMs) ? data.elapsedMs : 0
        covered = data.covered ?? covered
        remaining = Number.isInteger(data.gap?.chapters) ? data.gap.chapters : null
        report({ batches, covered, remaining, elapsedMs })

        // ⚠️ **自动打底那趟绝不进循环**（读者 2026-10-01 定过："打底只补开头那一批，
        //     绝不顺手把整段缺口补掉"）。以前"打底批次恰好盖满请求范围 ⇒ partial=false"
        //     就天然停了；3.0 把预算降到 18000 之后，打底批次（1..20）不再盖满它要的
        //     1..30 ⇒ partial 变成 true ⇒ 循环会接着把整个缺口补完 ✗ —— 所以这里
        //     **显式**把 `autoFoundation` 当停止信号（分批的 batch=paid 情形之外，
        //     "这一批是自动打底"本身就该停）。
        if (data.partial !== true || data.autoFoundation === true) {
          return { kind: 'done', skipped: false, batches, elapsedMs, covered, remaining: remaining ?? 0 }
        }

        // ⚠️ 用**服务端回报的水位线**判断有没有前进，而不是"又跑了一批"。
        const nowAt = Number.isInteger(covered?.last) ? covered.last : null
        if (nowAt !== null && advancedTo !== null && nowAt <= advancedTo) {
          return { kind: 'stalled', batches, elapsedMs, covered, remaining }
        }
        advancedTo = nowAt

        if (batches >= cap) return { kind: 'capped', batches, elapsedMs, covered, remaining }
      }
    }

    /**
     * 把一次补齐**循环**的结局翻成一句必须属实的话。
     *
     * ⚠️ 与 `memoryFillClause` 的分工：那个函数管的是"顺手补"那一趟的单批结果，
     * 这个管的是循环。两者都必须分清"补完了 / 只补了一部分 / 停在原地 / 压根没补"，
     * 因为读者是拿这句话去决定"要不要现在开聊"的。
     *
     * @param {object} outcome `runFillLoop` 的返回值
     * @returns {{kind:'ok'|'error', text:string}}
     */
    function fillOutcomeNotice(outcome) {
      const batches = Number.isInteger(outcome?.batches) ? outcome.batches : 0
      const seconds = Math.round((Number.isFinite(outcome?.elapsedMs) ? outcome.elapsedMs : 0) / 1000)
      const covered = outcome?.covered
      const range = covered !== null && covered !== undefined
        && Number.isInteger(covered.first) && Number.isInteger(covered.last)
        ? `第 ${covered.first}–${covered.last} 章`
        : '这一段'
      const cost = batches > 1 ? `（${batches} 批，共 ${seconds} 秒）` : `（${seconds} 秒）`
      const left = Number.isInteger(outcome?.remaining) && outcome.remaining > 0
        ? `，还剩 ${outcome.remaining} 章`
        : ''

      // ⚠️ 这个分支在组件路径上走不到：取消时 `alive()` 已经为 false，`cancelFill`
      // 自己出文案。保留它是为了让本函数对其声明的输入域是**全函数**，任何未来的
      // 调用方都不会把"取消"误报成"失败"。
      if (outcome?.kind === 'cancelled') {
        return { kind: 'ok', text: `补齐已停止。记忆当前覆盖到 ${range}。` }
      }
      if (outcome?.kind === 'stalled') {
        return {
          kind: 'error',
          text: `补齐停在原地：水位线没有前进，已主动停下以免空转。记忆当前覆盖到 ${range}${left}。`,
        }
      }
      if (outcome?.kind === 'capped') {
        return {
          kind: 'ok',
          text: `连续补了 ${batches} 批后到达单次上限，记忆当前覆盖到 ${range}${left}。`
            + (left === '' ? '' : '可以再点一次接着补。'),
        }
      }
      // ⚠️ 读者在这一批跑完之前点了「清空重建」⇒ 服务端**整批丢弃**了结果。
      //    这时**绝不能说"没有缺口"**（刚清空，缺口是全书），也不能说"补完了"。
      if (outcome?.resetDuringFill === true) {
        return {
          kind: 'ok',
          text: '你在这一批补齐跑完之前清空了背景认识，所以这一批的结果没有写回去（清空保持生效）。'
            + '再点一次「补齐前文记忆」会从头建立。',
        }
      }
      if (outcome?.kind === 'done' && outcome.skipped === true) {
        return { kind: 'ok', text: '前文已经都在记忆里了，没有缺口。' }
      }
      if (outcome?.kind === 'done') {
        return { kind: 'ok', text: `已把 ${range} 纳入记忆${cost}。` }
      }
      // ⚠️ 失败时要说清两件事，否则读者只会看到子代理"停止了"而不知道接下来怎么办：
      //    ① **已经补进去的批次都留着**（每批都是独立落盘的）；② **再点一次会接着往下补**。
      return {
        kind: 'error',
        text: `补齐没完成：${describeError(outcome?.error)}`
          + `（已经补进去的批次都保留着 —— 记忆现在覆盖到 ${range}，再点一次会接着往下补。）`,
      }
    }

    /**
     * 上次导出的结果（每本书一份，存在 localStorage）。
     *
     * ⚠️ 它是**常驻状态**，不是提示条：导出结果往往好几行（"新建 2 · 更新 0 · 未变 0"），
     * 走 toast 就会**永远不消失**（长文不自动消失是刻意的规则），读者实测把它当成了 bug ✗。
     * 所以它显示在「导出到笔记库」那节的说明里（成功绿、失败红），并记住时间。
     */
    const LAST_EXPORT_KEY = (bookId) => `drc:last-export:${bookId}`

    function loadLastExport(bookId) {
      try {
        const raw = globalThis.localStorage?.getItem(LAST_EXPORT_KEY(bookId))
        if (raw === null || raw === undefined) return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    function saveLastExport(bookId, value) {
      try {
        globalThis.localStorage?.setItem(LAST_EXPORT_KEY(bookId), JSON.stringify(value))
      } catch {
        /* 存不下就算了（隐私模式 / 配额），本次会话内仍然显示 */
      }
    }

    /** 把 ISO 时间显示成人看的短格式（「导出到笔记库」那节用）。 */
    function formatExportTime(iso) {
      const t = Date.parse(typeof iso === 'string' ? iso : '')
      if (!Number.isFinite(t)) return '未知时间'
      const d = new Date(t)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /**
     * 把宿主给出的「为什么没落在工作区」翻译成一句人话。
     *
     * 刻意不写成"未知错误"：用户发现笔记没落在工作区时，唯一有用的信息就是
     * **为什么**。`null` 表示宿主手里根本没有工作区路径（还没绑定过会话）。
     *
     * @param {string|null|undefined} reason 宿主返回的 fallbackReason
     * @returns {string}
     */
    function describeFallback(reason) {
      if (reason === null || reason === undefined || reason === '') {
        return '还没绑定会话，宿主不知道这个会话的工作区在哪'
      }
      const table = {
        PATH_INVALID: '工作区路径不合法',
        PATH_NOT_ABSOLUTE: '工作区路径不是绝对路径',
        PATH_IS_ROOT: '工作区路径是盘根，不该往那里写',
        DIR_NOT_FOUND: '工作区目录不存在',
        NOT_A_DIRECTORY: '工作区路径指向的不是目录',
      }
      return table[reason] ?? `工作区路径不可用（${reason}）`
    }

    /**
     * 归一化会话 id：宿主一侧 agent 是裸 UUID，而槽注入给面板的可能是
     * `session-<uuid>`。两边折叠到同一形态，才能判断"绑的是不是本会话"。
     *
     * 与宿主 lib/host/spoiler.js 的 normalizeSessionId 保持一致。
     *
     * @param {unknown} id 会话 id
     * @returns {string}
     */
    const normalizeId = (id) => {
      if (typeof id !== 'string') return ''
      const trimmed = id.trim()
      return trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed
    }

    /**
     * 讨论记录的来源标签。
     *
     * 三种来源对应三个**不同的动作**，值得区分：`note` 是"我写下了想法"，
     * `sent` 是"我把它发去聊了"，`reply` 是"我把 AI 的回应抓回来了"。
     * 只显示一个"讨论"会让人分不清这条到底走到哪一步了。
     *
     * @param {string} kind 来源
     * @returns {string}
     */
    const describeKind = (kind) => {
      const table = { note: '写了笔记', sent: '发去聊', reply: '抓回回应' }
      return table[kind] ?? '记录'
    }

    /**
     * 把 ISO 时间格式化成人看的短形式。
     *
     * 刻意用**绝对**时间（而不是"3 天前"）：这个区块是给人回顾"我什么时候记过
     * 什么"用的，绝对时间能直接对上你的日程。相对时间在 prompt 里更合适
     * （模型只需要"多久没聊了"这个概念），两者分工不同。
     *
     * @param {string} iso ISO 时间
     * @returns {string}
     */
    const formatWhen = (iso) => {
      if (typeof iso !== 'string' || iso === '') return ''
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /**
     * 联网档位的人话。刻意与宿主侧 `WEB_GATE_MODES` 一一对应。
     *
     * @param {string|undefined} mode 档位
     * @returns {string}
     */
    const webGateLabel = (mode) => {
      const table = {
        'block-all': '完全（陪读会话不能联网）',
        'block-book': '本书（拦住看起来在查这本书的查询）',
        off: '关闭（不拦）',
      }
      return table[mode] ?? '未知（按最严的「完全」处理）'
    }

    /**
     * 三档联网闸的短标签，给分段控件用。
     *
     * ⚠️ `value` 与宿主侧 `WEB_GATE_MODES` 一一对应，**顺序也一样**。客户端
     * bundle 不能 import 宿主模块，所以只能各写一份；`contract.test.mjs` 有一条
     * 用例逐个比对两边，防止哪天加了一档却只改了一边——那会让新档位在界面上
     * 根本无法选中。
     */
    const WEB_GATE_CHOICES = Object.freeze([
      { value: 'block-all', label: '完全', hint: '陪读会话一律不能联网（默认，最严）' },
      { value: 'block-book', label: '本书', hint: '允许联网，但拦住看起来在查这本书的查询' },
      { value: 'off', label: '关闭', hint: '不拦。陪读会话可以随意联网（也最容易撞见剧透）' },
    ])

    /** 档位 → 短标签；认不出就回落成"未知"。 */
    const webGateShort = (mode) => {
      const found = WEB_GATE_CHOICES.find((choice) => choice.value === mode)
      return found === undefined ? '未知' : found.label
    }

    /**
     * 往讨论时间线记一条。
     *
     * 只由客户端在两个**明确时刻**触发：把笔记发去聊（`sent`）、把 AI 回应抓回来
     * （`reply`）。笔记落盘那一条由**宿主**记（见 `POST /notes` 路由），因为那是
     * 服务端的动作，不该依赖面板有没有记性。
     *
     * @param {string} bookId 书 id
     * @param {object} record 记录
     * @returns {Promise<object>}
     */
    const recordDiscussion = (bookId, record) => callApi(`/books/${bookId}/discussions`, {
      method: 'POST',
      body: record,
    })
    //#endregion

    //#region 正文字体偏好
    //
    // 存 localStorage 而不是服务端：这是**纯界面偏好**，改一下就该立刻见效，
    // 不该为一次字号调整走一趟 HTTP。代价是它按浏览器域共享、不进 profile
    // 备份——对"读小说时字大一点"这个用途完全够。

    /** localStorage 键。 */
    const FONT_PREFS_KEY = 'drc:font-prefs'

    /** 默认 16px / 行高 1.9 —— 中文长文里 1.5 会挤，1.9 接近纸书。 */
    const DEFAULT_FONT_PREFS = { size: 16, lineHeight: 1.9, family: 'serif', paper: 0 }

    /** 允许区间。超出就夹住，而不是拒绝——用户拖过头不该报错。 */
    const FONT_SIZE_MIN = 13
    const FONT_SIZE_MAX = 30
    const LINE_HEIGHT_MIN = 1.2
    const LINE_HEIGHT_MAX = 2.6

    /**
     * 「纸感」的区间与步进。
     *
     * 默认 **0**，含义是"**一个字节都不加**"（见 `paperStyleOf`）—— 0 = 面板与宿主
     * 逐像素一致 = 这个功能等价于不存在。上限 30%：再高就不是"纸感"而是"换了个底色"，
     * 那会让正文与宿主的深浅主题打架（而这正是我们一直在避免的事）。
     */
    const PAPER_MAX = 30
    const PAPER_STEP = 5

    /**
     * 可选字体族。
     *
     * 中文长文的阅读体验差别很大：宋体（衬线）耐读，黑体清晰但久看累，
     * 楷体有纸书感。字体栈**优先列系统自带**，不下载任何字体文件——
     * 插件是零依赖的，不该因为换个字体就产生网络请求。
     */
    const FONT_FAMILIES = [
      { id: 'serif', label: '宋体', stack: '"Songti SC", "Noto Serif SC", "Source Han Serif SC", SimSun, serif' },
      { id: 'sans', label: '黑体', stack: '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif' },
      { id: 'kai', label: '楷体', stack: 'KaiTi, STKaiti, "Kaiti SC", "Noto Serif SC", serif' },
      { id: 'mono', label: '等宽', stack: 'ui-monospace, "Cascadia Mono", Consolas, "Sarasa Mono SC", monospace' },
    ]

    /**
     * 夹住并补全一份字体偏好。
     *
     * 输入可能是 localStorage 里的任意垃圾（用户手改、旧版本写的、别的插件
     * 写坏的），所以这里必须**永不抛错**：任何非法值都回落到默认。
     *
     * @param {unknown} raw 原始偏好
     * @returns {{ size: number, lineHeight: number, family: string }}
     */
    function clampFontPrefs(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const size = Number(source.size)
      const lineHeight = Number(source.lineHeight)
      const paper = Number(source.paper)
      const family = FONT_FAMILIES.some((entry) => entry.id === source.family)
        ? source.family
        : DEFAULT_FONT_PREFS.family
      return {
        size: Number.isFinite(size)
          ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)))
          : DEFAULT_FONT_PREFS.size,
        lineHeight: Number.isFinite(lineHeight)
          ? Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, Math.round(lineHeight * 10) / 10))
          : DEFAULT_FONT_PREFS.lineHeight,
        family,
        paper: Number.isFinite(paper)
          ? Math.min(PAPER_MAX, Math.max(0, Math.round(paper)))
          : DEFAULT_FONT_PREFS.paper,
      }
    }

    /** 取某个字体族的 CSS 字体栈。 */
    function fontStackOf(familyId) {
      const entry = FONT_FAMILIES.find((item) => item.id === familyId)
      return (entry ?? FONT_FAMILIES[0]).stack
    }

    /** 把偏好转成给 article 的内联样式。 */
    function fontStyleOf(prefs) {
      const safe = clampFontPrefs(prefs)
      return {
        fontSize: `${safe.size}px`,
        lineHeight: String(safe.lineHeight),
        fontFamily: fontStackOf(safe.family),
      }
    }

    /**
     * 「纸感」的内联样式（加在阅读区的**滚动容器**上，不是正文块上）。
     *
     * ## 四条刻意的约束
     *
     *   1. **默认 0 = 返回空对象**，也就是一个字节都不加。这是"不打架"的可证伪定义：
     *      关掉它时，面板的内联样式与"没有这个功能"逐元素相同（有专测钉着）。
     *   2. **只改阅读区那一整块**背景，壳 / 按钮 / 边框一律不碰。
     *   3. **加在滚动容器上而不是 36em 的正文块上**：加在正文块上会得到"一条暖色带
     *      两侧露白"，而"整页偏暖"才是纸感的意思。
     *   4. **颜色由宿主现值现算**：`color-mix` 的两个输入是 `--drc-paper-base`
     *      （= 宿主 bg-base 的现值）与我们定义的 `--drc-paper`（浅色奶油 / 深色暖炭）。
     *      换肤插件改了 bg-base，我们跟着改，只贡献"掺多少"。
     *      ⚠️ 所以这里引用的是**我们自己的别名**，不是宿主 token ——"借用了哪些宿主
     *      token"这件事只在别名层里声明一次（有守卫钉着）。
     *
     * @param {object} prefs 字体偏好（含 paper，0–30）
     * @returns {object} 内联样式；`paper` 为 0 时是空对象
     */
    function paperStyleOf(prefs) {
      const safe = clampFontPrefs(prefs)
      if (safe.paper <= 0) return {}
      return {
        background: `color-mix(in oklab, var(--drc-paper-base) ${100 - safe.paper}%, var(--drc-paper))`,
      }
    }

    /** 读偏好；任何异常都回默认。 */
    function loadFontPrefs() {
      try {
        const raw = globalThis.localStorage?.getItem(FONT_PREFS_KEY)
        return clampFontPrefs(raw === null || raw === undefined ? null : JSON.parse(raw))
      } catch {
        return { ...DEFAULT_FONT_PREFS }
      }
    }

    /** 写偏好；写不进去（隐私模式、配额满）也不该影响阅读。 */
    function saveFontPrefs(prefs) {
      try {
        globalThis.localStorage?.setItem(FONT_PREFS_KEY, JSON.stringify(prefs))
      } catch {
        /* 存不下就算了，本次会话内仍然生效 */
      }
    }
    //#endregion

    //#region 纯函数（导出以便单测，见 test/client.test.mjs）
    /**
     * 把一章正文切成「段落 + 章内字符偏移」。
     *
     * 偏移是**进度锚点**的载体：滚动时取视口顶部那一篇的 `offset` 回写，
     * 下次打开就能落回同一处。所以这里的 offset 必须相对**章正文起点**
     * （与服务端 `charOffset` 的口径一致），而不是相对整本书。
     *
     * @param {string} text 章正文
     * @returns {Array<{ offset: number, text: string }>}
     */
    function buildParagraphs(text) {
      const out = []
      if (typeof text !== 'string' || text === '') return out
      let offset = 0
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed !== '') out.push({ offset, text: trimmed })
        offset += line.length + 1
      }
      return out
    }

    /**
     * 找出 `offset` 落在哪一段（返回该段下标）。
     *
     * 二分查找而不是线性扫描：一章可能有上千段，而滚动事件每秒会触发几十次。
     *
     * @param {Array<{ offset: number }>} paragraphs 段落列表
     * @param {number} offset 章内字符偏移
     * @returns {number} 段落下标；段落为空时返回 0
     */
    function findParagraphIndex(paragraphs, offset) {
      if (paragraphs.length === 0) return 0
      let lo = 0
      let hi = paragraphs.length - 1
      let best = 0
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (paragraphs[mid].offset <= offset) {
          best = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return best
    }

    /**
     * 按卷把目录分组。
     *
     * 解析器把「卷」表达为章节上的 `volume` 字段（而不是一个独立条目），
     * 所以目录树要在这里重建。没有卷的书会得到一个 `volume: null` 的组，
     * UI 对这种情况直接平铺、不显示组标题。
     *
     * @param {Array<object>} chapters 目录条目
     * @returns {Array<{ volume: string|null, chapters: Array<object> }>}
     */
    function groupByVolume(chapters) {
      const groups = []
      for (const chapter of chapters ?? []) {
        const volume = chapter.volume ?? null
        const last = groups[groups.length - 1]
        if (last !== undefined && last.volume === volume) last.chapters.push(chapter)
        else groups.push({ volume, chapters: [chapter] })
      }
      return groups
    }

    /**
     * 判断目录里的某一卷要不要**展开**。
     *
     * 卷分组已经有了（`groupByVolume`），但默认是**所有卷全开**——一本 1404 章的
     * 书会一次铺出七千来个元素（见 `TOC_FILTER_MIN` 的注释）。折叠之后只渲染
     * 当前卷，其余卷只留一行标题。
     *
     * 抽成纯函数是为了能测：这条规则写错的表现是**章节看不见了**，而"看不见"
     * 与"这本书没有这一章"在界面上长得一样 —— 一条不会报错的失效路径。
     *
     * 三条规则（都是"少渲染"，不是"藏起来"）：
     *   · **筛选时一律全开**：否则命中的章藏在折叠卷里，表现就是搜不到；
     *   · **当前卷始终开**：打开目录第一眼就该看到自己读到哪；
     *   · 其余卷点标题开合，一次只留一卷手动开的。
     *
     * @param {{ key: string, isCurrent: boolean, openVolume: string|null, filtering: boolean }} input
     * @returns {boolean}
     */
    function isVolumeOpen(input) {
      // 无卷的书只有一个组（key 是空串），它**没有可点的标题** —— 必须始终展开。
      // 否则"还没开始读"时 current = -1、isCurrent 为假，整份目录会一片空白。
      if (input.key === '') return true
      if (input.filtering) return true
      // ⚠️ **显式收起优先于"当前卷常开"**：读者点过收起就照他的意思来 ——
      // 默认仍然是"当前卷展开"（打开目录第一眼该看到自己读到哪），但不再**锁死**
      // 那一卷（读者的真机反馈："已读到的那卷默认展开并且无法点击收起"）。
      if (Array.isArray(input.closedKeys) && input.closedKeys.includes(input.key)) return false
      if (input.isCurrent) return true
      return input.openVolume !== null && input.openVolume === input.key
    }

    /**
     * 正文页角标里一行摘要的字符数。
     *
     * 30 是读者定的：正文页的价值是"**回到打动我的那一段原文**"，不是"在正文里
     * 读我的笔记"。他自己的笔记实测 522–1183 字/条（平均 ~805），把全文铺进
     * 正文流会直接把小说顶下去 —— 所以那里只给一行索引，长文回笔记页读。
     */
    const NOTE_SUMMARY_CHARS = 30

    /**
     * 笔记页里长文折叠的字符阈值（约手机一屏半）。
     */
    const NOTE_CLAMP_CHARS = 160

    /**
     * 一条笔记的**一行摘要**：优先「我的感想」，没写就用「原文摘抄」。
     *
     * 抽成纯函数是为了能测：这里出错的表现是**摘要串行**（把感想和摘抄接在一起）
     * 或者切出半个字，两者都不会报错。
     *
     * 按**码点**切而不是 `slice`：`slice` 会把 emoji / 代理对切成半个字，
     * 在界面上就是一个乱码方块。
     *
     * @param {object} note 笔记
     * @param {number} [limit] 摘要上限（字符）
     * @returns {string}
     */
    function noteSummary(note, limit = NOTE_SUMMARY_CHARS) {
      const flat = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
      const thought = flat(note?.thought)
      const source = thought !== '' ? thought : flat(note?.excerpt)
      if (source === '') return '（这条没有正文）'
      const chars = Array.from(source)
      return chars.length <= limit ? source : `${chars.slice(0, limit).join('')}…`
    }

    /**
     * 笔记页里把长文折成预览。返回 `{ text, clamped }` —— `clamped` 决定要不要
     * 显示「展开全文」：短文本不该长出一个多余按钮。
     *
     * @param {string} text 原文
     * @param {number} [limit] 折叠阈值（字符）
     * @returns {{ text: string, clamped: boolean }}
     */
    function clampNoteText(text, limit = NOTE_CLAMP_CHARS) {
      const value = typeof text === 'string' ? text : ''
      const chars = Array.from(value)
      if (chars.length <= limit) return { text: value, clamped: false }
      return { text: `${chars.slice(0, limit).join('')}…`, clamped: true }
    }

    /**
     * 阅读进度百分比。
     *
     * 用「已完成章数 + 本章内比例」估算，而不是只数章号——长篇里一章可能
     * 上万字，只按章号算会让进度条长时间卡住不动。
     *
     * @param {{ chapterIndex: number, charOffset: number }|null} progress 进度
     * @param {Array<object>} chapters 目录条目
     * @returns {number} 0..100 的整数
     */
    function percentOf(progress, chapters) {
      if (progress === null || progress === undefined || chapters.length === 0) return 0
      const index = Math.min(Math.max(0, progress.chapterIndex), chapters.length - 1)
      const totalChars = chapters.reduce((sum, chapter) => sum + (chapter.length ?? 0), 0)
      if (totalChars <= 0) return Math.round(((index + 1) / chapters.length) * 100)
      let read = 0
      for (let i = 0; i < index; i += 1) read += chapters[i].length ?? 0
      read += Math.min(progress.charOffset ?? 0, chapters[index].length ?? 0)
      return Math.min(100, Math.max(0, Math.round((read / totalChars) * 100)))
    }

    /**
     * 进度的一行人类可读描述。
     *
     * @param {{ chapterIndex: number }|null} progress 进度
     * @param {Array<object>} chapters 目录条目
     * @returns {string}
     */
    function progressLabel(progress, chapters) {
      if (progress === null || progress === undefined || chapters.length === 0) return '尚未开始'
      const index = Math.min(Math.max(0, progress.chapterIndex), chapters.length - 1)
      const chapter = chapters[index]
      const title = chapter?.title ?? `第 ${index + 1} 章`
      const short = title.length > 18 ? `${title.slice(0, 18)}…` : title
      return `读至 ${short} · ${index + 1}/${chapters.length} 章 · ${percentOf(progress, chapters)}%`
    }

    /**
     * 目录筛选条的**启用阈值**（章数）。
     *
     * 短书不需要这个输入框：一本 20 章的书里，筛选条本身比目录还占地方。
     * 50 章大致是"一眼扫不完"的界线。
     */
    const TOC_FILTER_MIN = 50

    /**
     * 按章号、标题或卷名筛选章节。
     *
     * 抽成纯函数是因为它是**上千章的书里唯一好用的定位方式**：实测《一世之尊》
     * 有 1404 章，全铺开是七千来个元素，"滚到第 812 章"要划过整份目录。而
     * "筛选逻辑写错了"在界面上的表现是"搜不到那一章"，很容易被误当成
     * "这本书没有这一章"——那是一条不会报错的失效路径，必须测。
     *
     * 匹配范围刻意宽：章号（**1 起**，与界面上显示的一致）、标题、卷名。
     * 章号用 `includes` 而不是相等——用户找"第 8 卷附近"时只会打 `8`，
     * 得到 8 / 18 / 80-89 一串候选，比要求打全更好用。
     *
     * @param {Array<object>} chapters 目录条目
     * @param {string} query 筛选词
     * @returns {Array<object>} 命中的条目（保持原顺序）
     */
    function filterChapters(chapters, query) {
      const list = Array.isArray(chapters) ? chapters : []
      const raw = typeof query === 'string' ? query.trim() : ''
      if (raw === '') return list
      const needle = raw.toLowerCase()
      return list.filter((chapter) => {
        if (chapter === null || typeof chapter !== 'object') return false
        // 章号用 index + 1：界面上显示的就是它（见目录里的 padStart(3,'0')），
        // 匹配用 index 的话用户打「1」会搜不到第一段。
        if (String(chapter.index + 1).includes(needle)) return true
        if (typeof chapter.title === 'string' && chapter.title.toLowerCase().includes(needle)) return true
        return typeof chapter.volume === 'string' && chapter.volume.toLowerCase().includes(needle)
      })
    }

    /** 标题自带序号时的识别式（与 host 侧 `spoiler.js` 保持一致）。 */
    const TITLE_HAS_ORDINAL = /^(?:第\s*[0-9零一二三四五六七八九十百千万亿两]+\s*[章回节卷篇]|[卷回节篇]\s*[0-9零一二三四五六七八九十百千万亿两]+)/

    /**
     * 章节名——**优先用书自己的编号**。
     *
     * 这是 host 侧 `chapterLabel`（`lib/host/spoiler.js`）的**镜像**，两边必须
     * 逐字一致：同一条笔记出现在会话输入框里和出现在 md 里时，章号不能是两样。
     * 实测踩过：某本书的 index 0 是「卷首」，`index + 1` 与书内编号整体错位，
     * 于是产出 `第 17 章 · 第16章 带子` 这种自相矛盾的标题。
     *
     * 为什么只能镜像而不能复用：host 与 client 是两个 bundle，client 不能 import
     * `lib/host/*`。所以 `test/contract.test.mjs` 用一张输入表断言两边输出相同
     * ——那条测试才是这份重复的护栏，缺了它就只是两处各写各的。
     *
     * @param {number|null} index 章序号（0 起）
     * @param {string} [title] 章标题
     * @returns {string}
     */
    function chapterHeading(index, title) {
      const safe = typeof title === 'string' ? title.trim() : ''
      if (!Number.isInteger(index)) return safe
      if (safe === '') return `第 ${index + 1} 章`
      if (TITLE_HAS_ORDINAL.test(safe)) return safe
      return `第 ${index + 1} 章 · ${safe}`
    }

    /** 「未分类」这个分组名。宿主对"没设过分类"的书回 `null`，名字由 UI 给。 */
    const UNCATEGORIZED = '未分类'

    /**
     * 分类下拉里「新建」那一项的哨兵值。
     *
     * 它是带下划线的形式，而不是 `＋ 新建分类…` 这个显示文案本身：哨兵必须是
     * **用户不可能输成同一个东西**的值。用文案当哨兵的话，一个真的叫
     * `＋ 新建分类…` 的分类会永远点不中——选它就等于选"新建"。
     */
    const NEW_CATEGORY = '__new__'

    /**
     * 把书架按分类分组，**「未分类」永远排第一**。
     *
     * 为什么未分类要置顶而不是跟着一起按拼音排：它是"还没整理"的收件箱，新导入
     * 的书都落在这里。让它淹没在分类列表中间，等于每次都要先找一遍。
     *
     * 「未分类」这个桶**总是存在**，哪怕它现在是空的——分组的出现与消失会让
     * 书架在整理过程中不断跳动，而一个稳定的入口比省一行更有价值。
     *
     * 用户若把某个分类**真的命名成「未分类」**，会和真正的未分类合并。这是刻意
     * 的：两个长得一模一样的分组本就是同一个东西。
     *
     * @param {Array<object>} books 书架条目（每项可带 `category`）
     * @returns {Array<{ category: string, books: object[] }>}
     */
    function groupBooksByCategory(books) {
      const list = Array.isArray(books) ? books : []
      const buckets = new Map([[UNCATEGORIZED, []]])
      for (const book of list) {
        const raw = typeof book?.category === 'string' ? book.category.trim() : ''
        const category = raw === '' ? UNCATEGORIZED : raw
        if (!buckets.has(category)) buckets.set(category, [])
        buckets.get(category).push(book)
      }
      const others = [...buckets.keys()]
        .filter((name) => name !== UNCATEGORIZED)
        .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
      return [UNCATEGORIZED, ...others].map((category) => ({ category, books: buckets.get(category) }))
    }

    /**
     * 书架分类"收起"名单的 localStorage 键。
     *
     * ⚠️ **这个字符串是契约**：改了它，读者已经收起的分类会"自己又展开"。
     */
    const SHELF_COLLAPSED_KEY = 'drc:collapsed-categories'

    /**
     * 背景认识里「人物卡」**展开**名单的键。
     *
     * ⚠️ 注意语义与书架**相反**：书架默认全展开、所以存"收起的"；人物卡**默认全折叠**
     * （读者 2026-09-27 定的："第一次打开的时候应该默认折叠起来比较好"），所以这里存
     * **展开的** —— 空集合正好等于"全折叠"，一个默认值都不用写。
     *
     * 两处的键必须不同，否则收一个人物会让同名的书架分类一起消失。
     */
    const CARDS_EXPANDED_KEY = 'drc:expanded-cards'

    /**
     * 把读到的任意值规整成"名字集合"（收起名单 / 展开名单都走它）。
     *
     * ⚠️ **永不抛错**：这个值只由我们写，但用户可能手改、旧版本可能写过别的形状 ——
     * 读坏了就当"空集合"，不该让整个界面白屏。
     *
     * @param {unknown} value 原始值
     * @returns {string[]} 去空、去重、保序
     */
    function normalizeNameSet(value) {
      if (!Array.isArray(value)) return []
      const out = []
      for (const item of value) {
        if (typeof item !== 'string') continue
        const name = item.trim()
        if (name === '' || out.includes(name)) continue
        out.push(name)
      }
      return out
    }

    /**
     * 点一下标题：把名字加进集合 / 从集合里拿掉。返回**新数组**（React 要新引用才会重渲染）。
     *
     * @param {unknown} list 现在的集合
     * @param {string} name 名字（书架分类名，或人物卡的 `分区/名字`）
     * @returns {string[]}
     */
    function toggleNameInSet(list, name) {
      const current = normalizeNameSet(list)
      return current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name]
    }

    /**
     * 读一个名字集合。读不出来（或存储不可用）就当**空集合**。
     *
     * ## ⚠️ 为什么这里的几处**要**持久化，而目录里的「卷」**不要**
     *
     * 同样是"收起来"，性质不同，所以处理相反 —— **这不是不一致，别把它们统一掉**：
     *   · **卷**（`isVolumeOpen`）：那是"我正在翻这本书的目录"的过程状态，按书、按次算，
     *     开关一次不该写进任何持久层；
     *   · **书架分类 / 人物卡**：那是"我平时不想看见哪几类 / 哪几个人"的**偏好**，
     *     它跨书（分类）、跨会话都成立 —— 所以它们就该记住。
     *
     * @param {string} key 用哪个 storage 键（`SHELF_COLLAPSED_KEY` / `CARDS_EXPANDED_KEY`）
     * @returns {string[]}
     */
    function loadNameSet(key) {
      try {
        const raw = globalThis.localStorage?.getItem(key)
        return normalizeNameSet(raw === null || raw === undefined ? null : JSON.parse(raw))
      } catch {
        return []
      }
    }

    /**
     * 写一个名字集合。
     *
     * @param {string} key 用哪个 storage 键
     * @param {unknown} list 集合
     * @returns {void}
     */
    function saveNameSet(key, list) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(normalizeNameSet(list)))
      } catch {
        /* 存不下就算了（隐私模式 / 配额），本次会话内仍然生效 */
      }
    }

    /**
     * 书架上一本书的**绑定状态**：显示成什么，以及能不能跳过去。
     *
     * 抽成纯函数是因为这里有**三条回落分支**（未绑定 / 已绑定但跳不了 / 已绑定
     * 且可跳），而组件层恰好测不到它——测试里的 React 替身不做状态更新（见
     * `useState` 替身），所以书架的"已经加载出书"那个状态根本渲染不出来。
     * 把分支逻辑留在组件里，等于它没有护栏。
     *
     * @param {object} book 书架条目（`sessionId` 为 `null`/空 = 未绑定）
     * @param {Function|null|undefined} openSession 会话跳转函数（宿主没有 sessions 时为 null）
     * @returns {{ bound: boolean, canJump: boolean, label: string, sessionId: string|null }}
     */
    function shelfBindingState(book, openSession) {
      const sessionId = typeof book?.sessionId === 'string' && book.sessionId !== ''
        ? book.sessionId
        : null
      if (sessionId === null) return { bound: false, canJump: false, label: '未绑定', sessionId: null }
      const canJump = typeof openSession === 'function'
      return {
        bound: true,
        canJump,
        label: canJump ? '已绑定 · 跳过去' : '已绑定会话',
        sessionId,
      }
    }

    /**
     * 跨会话交接的有效期。
     *
     * 超过就丢掉，免得读者很久以后自己切到那个会话时，输入框里**突然冒出**
     * 一段早就不记得的旧摘抄。接力区现在是**模块级**的（见下面的说明），
     * 所以它会一直等到有人来取、或者等到过期为止。
     */
    const DRAFT_HANDOFF_TTL_MS = 120000

    /**
     * 「发到会话去聊」该发去哪。
     *
     * 为什么需要这一步：输入框接口（`inputActions`）是**按会话**交到面板手上
     * 的 —— 面板拿到的永远是**当前**会话那一份，没有任何办法直接写进另一个
     * 会话的输入框。所以当一本书绑的是**别的**会话时，只能先把文字交接出去，
     * 跳过去，等面板带着新会话的 `sessionId` 与新的 `inputActions` 再写一次。
     *
     * 三种去向对应三条不同的收尾动作：
     *   `here`      —— 本书没绑会话，或绑的就是当前会话：照旧放当前输入框。
     *   `handoff`   —— 绑的是**另一个**会话：交接，然后跳过去。
     *   `here-only` —— 绑的是另一个会话，但宿主没给会话跳转能力：只能放当前
     *                  输入框，并且必须**如实告诉读者**它去错了地方。
     *
     * @param {object} input
     * @param {unknown} input.boundSessionId 服务端记录的绑定会话
     * @param {unknown} input.currentSessionId 面板所属会话
     * @param {boolean} input.canOpenSession 宿主是否既给跳转、也给了交接通道
     * @returns {{ mode: 'here'|'handoff'|'here-only', targetSessionId: string|null }}
     */
    function planNoteSend({ boundSessionId, currentSessionId, canOpenSession }) {
      const bound = typeof boundSessionId === 'string' && boundSessionId.trim() !== ''
        ? boundSessionId
        : null
      if (bound === null) return { mode: 'here', targetSessionId: null }
      // 两边都过 `normalizeId`：绑定记录里存的是带 `session-` 前缀的形式，而槽
      // 注入的 `sessionId` 不一定带，直接比字符串会把"本会话"误判成"另一个会话"，
      // 于是读者在自己会话里发笔记反而被弹走。
      if (normalizeId(bound) === normalizeId(currentSessionId)) {
        return { mode: 'here', targetSessionId: null }
      }
      if (canOpenSession !== true) return { mode: 'here-only', targetSessionId: bound }
      return { mode: 'handoff', targetSessionId: bound }
    }

    /**
     * 宿主**真正在用**的收件箱目录。
     *
     * ⚠️ 不能自己拼（v1.71 修）。从前这里写死 `${storageDir}\inbox`，两个后果：
     *   · `inboxDir` 配置一改，面板显示的路径与宿主实际扫的目录就是**两个地方**：
     *     读者照着面板提示把书放进去、点「扫描」什么也没有 —— 而看起来像插件的错；
     *   · 反斜杠写死，在 macOS / Linux 上显示也是错的。
     * 现在以宿主的答复为唯一权威（`/health` 的 `inboxDir`，宿主自己解析好的）；
     * 下面那段拼接只作**老宿主**的回落，且至少跟着 `config.inboxDir` 走。
     *
     * @param {object|null|undefined} health `/health` 的响应
     * @returns {string|null} 绝对路径；拿不到则 null（界面据此不显示这一块）
     */
    function resolveInboxPath(health) {
      if (health === null || health === undefined || typeof health !== 'object') return null
      if (typeof health.inboxDir === 'string' && health.inboxDir !== '') return health.inboxDir
      const storageDir = typeof health.storageDir === 'string' ? health.storageDir : ''
      if (storageDir === '') return null
      const configured = health.config === null || typeof health.config !== 'object'
        ? ''
        : health.config.inboxDir
      const sub = typeof configured === 'string' && configured !== '' ? configured : 'inbox'
      const sep = storageDir.includes('\\') ? '\\' : '/'
      return `${storageDir}${sep}${sub}`
    }

    /**
     * 从宿主探到的应用清单里挑一个"能把文件夹交给系统打开"的。
     *
     * 清单为空 / 不是数组 / 三个候选一个都没有 → null。调用方据此把话说清楚，
     * 而不是渲染一个点下去没反应的按钮。
     *
     * @param {unknown} apps 宿主 `/open-in-app/apps` 回的 `apps`
     * @returns {string|null} 应用 id
     */
    function pickFileManagerApp(apps) {
      if (!Array.isArray(apps)) return null
      for (const id of FILE_MANAGER_APP_IDS) {
        if (apps.includes(id)) return id
      }
      return null
    }

    /**
     * 一次导入结束后给读者看的那句话。
     *
     * 抽成纯函数是为了能直接钉住「搬走了要说、没搬不许说」这条 ——
     * **文件自己不见了而界面不吭声**是最让人不放心的行为，而它恰好只发生在
     * "从收件箱导入"这一条路上（从别处导入不会搬走任何东西）。
     *
     * @param {object} data `/library/import` 的响应
     * @returns {string}
     */
    function importOutcomeText(data) {
      const title = typeof data?.book?.title === 'string' && data.book.title !== '' ? data.book.title : '这本书'
      const parts = [
        data?.deduped === true
          ? `《${title}》已在书架里（同一份文件）`
          : `已导入《${title}》· ${data?.book?.chapterCount ?? 0} 章`,
      ]
      if (typeof data?.inboxMovedTo === 'string' && data.inboxMovedTo !== '') {
        parts.push('收件箱里那份已移到 .imported/（没有删除）')
      }
      return parts.join('；')
    }

    /**
     * 有一份状态文件损坏被挪走时的那句提示；`null` = 没有，不用显示。
     *
     * ## 为什么要有这句话（2026-10-02 三方评审 P2-2）
     *
     * `bindings.json` / `categories.json` / `settings.json` 是"随时可重建的派生状态"，
     * 宿主损坏时**挪开重建**（坏文件一份不丢，名字带 `.corrupt-<时间戳>`）——
     * 设计上是对的，可它对读者是**可见的状态丢失**：全部书的阅读进度、会话绑定
     * 会显示成"没读过 / 没绑过"，紧接着一次翻页（自动且高频）就把这份空状态写实了。
     * 而从前这三份文件损坏时读者侧**零提示**（只有书架索引 `library.json` 那条路会说），
     * 读者只能自己猜"我的进度去哪了"。
     *
     * ⚠️ 说人话的要点是**三件事都要有**：哪一份文件、影响的是什么、坏文件**没删**。
     *    只说"有文件损坏"等于没说 —— 读者真正在问的是"我那本书的进度为什么显示成没读过"。
     * ⚠️ 数据从 `/health.quarantined` 来（宿主直接读盘，见 `listQuarantined`）⇒ 重启后
     *    仍然说得出事，所以这条提示是**常驻**的，不是一闪而过的 toast。
     *
     * @param {Array<{base?: string, file?: string}>|null|undefined} quarantined `/health` 里那份清单
     * @returns {string|null}
     */
    function quarantineNoticeText(quarantined) {
      const items = Array.isArray(quarantined)
        ? quarantined.filter((item) => item !== null && typeof item === 'object')
        : []
      if (items.length === 0) return null
      // 文件名 → 读者看得懂的影响面。认不出来也不许把整条提示吞掉（宁可说得笼统）。
      const labels = {
        'bindings.json': '绑定与阅读进度',
        'categories.json': '书架分类',
        'settings.json': '插件设置',
        'library.json': '书架索引',
      }
      const parts = items.map((item) => {
        const base = typeof item.base === 'string' ? item.base : ''
        const file = typeof item.file === 'string' && item.file !== '' ? item.file : base
        return `${file}（${labels[base] ?? '未认出的文件'}）`
      })
      // ⚠️ 例子必须跟着"到底哪一份坏了"走（2026-10-02 批 3 打印原文时抓到的**假声明**：
      //    只坏了分类那份，却说"绑定与阅读进度会显示成没读过"）。说人话 ≠ 说一段
      //    听起来像真的模板话 —— 后者比不说更坏，它把读者引去查错的东西。
      const impact = items.some((item) => item.base === 'bindings.json')
        ? '受它影响的状态被重置过 —— 绑定与阅读进度会显示成"没读过"。'
        : '受它影响的那部分状态被重置过（不会自己恢复）。'
      return `⚠️ 有 ${items.length} 份状态文件损坏，已挪到一边（没删）：${parts.join('、')}。`
        + impact
        + '文件还在插件目录里：把它修好、或移走之后这条提示就会消失。'
    }

    /**
     * 「这本书的导入说明」—— 导入那一刻交代过的事，进书之后还能重看。
     *
     * ⚠️ 数据**全在** `/library` 的条目里（`warnings` / `encoding` /
     *    `encodingConfidence` / `sourceName`）⇒ 这条功能一个字节的后端都不用动，
     *    不许为它新增路由。
     * ⚠️ 一切正常时返回**空数组**：每本书都挂一条说明会变成噪音，读者第二次就学会
     *    无视它 —— 真出事的那本会跟着一起被无视。
     * ⚠️ 「定长分段」那句交代**不在这里**（目录页顶部已经单独说了一遍）：同一件事
     *    说两遍，读者会以为是两件事。
     *
     * 来历（"交代过就没了"为什么是个问题）见 `docs/design-v1-archive.md` §401。
     *
     * @param {object|null|undefined} book 书架上那本书（`/library` 的条目）
     * @returns {string[]} 要显示的行；空数组 = 这本书没什么好交代的
     */
    function importNotes(book) {
      if (book === null || book === undefined || typeof book !== 'object') return []
      const warnings = Array.isArray(book.warnings)
        ? book.warnings.filter((line) => typeof line === 'string' && line.trim() !== '')
        : []
      const encoding = typeof book.encoding === 'string' && book.encoding.trim() !== ''
        ? book.encoding.trim()
        : ''
      const confidence = typeof book.encodingConfidence === 'string' ? book.encodingConfidence : ''
      // 只有"猜出来的编码"值得说。`bom` / `strict-utf8` 是**确定**的判定，
      // 说它等于没说；`heuristic`（按字节分布猜）与 `fallback`（严格 UTF-8
      // 失败后回落 GB18030）才是"我们替你赌了一把"。
      const guessed = confidence === 'heuristic' || confidence === 'fallback'
      if (warnings.length === 0 && guessed === false) return []

      const lines = []
      // 来源文件名放第一行：它是这本书里**所有**东西的出处（正文、笔记、导出），
      // 而书名是我们替它起的（`normalizeTitle` 会剥扩展名），两者不是一回事。
      const sourceName = typeof book.sourceName === 'string' && book.sourceName.trim() !== ''
        ? book.sourceName.trim()
        : ''
      if (sourceName !== '') lines.push(`来源文件：${sourceName}`)
      // ⚠️ 编码那一行**只在"是猜的"时**才出现。这条与上面 `guessed` 的判据是
      // 同一件事的两半：判据决定"要不要开口"，这一行决定"要不要提编码"。
      // 曾经写成"只要有 warning 就把编码一起打出来"，于是「未检测到章节结构」
      // 这种纯切分问题旁边会挂一句「编码：utf-8（文件头 BOM 判定）」—— 读者会
      // 以为编码也有问题，而那句话的信息量是零。测试当场抓住了它。
      if (guessed === true && encoding !== '') {
        const how = confidence === 'fallback'
          ? '不是合法 UTF-8，回退判定'
          : '按字节分布猜的，不是文件自己声明的'
        lines.push(`编码：${encoding}（${how}）`)
      }
      for (const line of warnings) lines.push(line)
      return lines
    }

    //#region 跨会话接力区
    /**
     * 跨会话存活的面板记忆。
     *
     * ⚠️ 这两个 Map **必须是模块级**，绝不能放进组件的 `useState`。
     *
     * 右侧栏页签的槽 `scope` 是 `session`，所以**切会话 = 本面板被卸载、
     * 在目标会话里重新挂载**。任何存在组件状态里的东西都会随之下葬 ——
     * v0.13.0 的交接棒就是这么丢的：它存在 `ReaderPanel` 的 `useState` 里，
     * 而"跳过去"这个动作恰好会卸载那个组件，于是读者看到的是
     * **跳过去了，但输入框是空的、阅读界面也没了**。
     *
     * 本插件的 factory 在整个页面**只跑一次**（`window.__ModuleLoader__.load`
     * 只登记一次工厂），所以模块级变量是这个页面里唯一能横跨会话切换的私有
     * 存储。它不触碰任何平台契约 —— 平台完全看不见这块内存。
     */
    const draftHandoffs = new Map() // 目标会话 id -> { text, at }
    // 会话 id -> { view, book, draft, origin }
    //
    // 记的是**面板此刻整层的样子**，不只是"哪本书"：
    //   `view`   —— 停在哪一层（书架/目录/正文/笔记/陪读）
    //   `book`   —— 哪本书（普通 JSON，直接留着即可）
    //   `draft`  —— 笔记页正在编的那条草稿（没有它，笔记页还原出来是个空编辑框）
    //   `origin` —— 「返回」该回到哪一层（与 `view` 不是一回事：发送**保留**层次，
    //               返回才回到来源）
    const sessionViews = new Map()

    /**
     * 上面那两张表的上限（见 {@link capSessionMemory}）。
     *
     * 64 个会话远大于任何真实用法（读者不可能同时开着几十个陪读会话），
     * 又足够小到"页面开一整天也不会累积成泄漏"。
     */
    const SESSION_MEMORY_MAX = 64

    /**
     * 给模块级的这两张表**加上界**。
     *
     * ⚠️ "必须是模块级"不等于"永远不清理"（2026-10-01 三方评审 P3）：它们每见一个
     * 新会话就多一条，而一个页面从不主动清空 —— 会话开得越多，这块内存只会越长。
     * 到顶时丢**最早记下的那一条**（`Map` 保持插入顺序）：那是最不可能再切回去的
     * 会话。最近记过的会重新排到队尾（`rememberSessionView` 先 delete 再 set），
     * 所以这实际上是 LRU，而不是"先进先出"。
     *
     * @param {Map<string, object>} map 表
     */
    function capSessionMemory(map) {
      if (!(map instanceof Map)) return
      while (map.size > SESSION_MEMORY_MAX) {
        const oldest = map.keys().next()
        if (oldest.done === true) break
        map.delete(oldest.value)
      }
    }

    /**
     * 往接力区放一根交接棒，按**目标会话**索引。
     *
     * 按目标索引而不是"只留一个格子"：两本书各绑一个会话时，先发的会被后发的
     * 顶掉；按会话分开之后两边互不干扰。
     *
     * @param {Map<string, {text: string, at: number}>} handoffs 接力区
     * @param {unknown} targetSessionId 目标会话
     * @param {unknown} text 要带过去的正文
     * @param {number} now 当前时间戳（注入是为了可测）
     */
    function depositDraftHandoff(handoffs, targetSessionId, text, now) {
      if (!(handoffs instanceof Map)) return
      const id = normalizeId(targetSessionId)
      if (id === '') return
      if (typeof text !== 'string' || text === '') return
      handoffs.set(id, { text, at: Number.isFinite(now) ? now : 0 })
      capSessionMemory(handoffs)
    }

    /**
     * 判断**当前会话**有没有一根该兑现的交接棒。
     *
     * 分开返回 `wait` / `drop` / `deliver`，而不是"能兑现就返回文字"，是因为
     * 调用方对这三者的处理**完全不同**：`wait` 必须**留着**交接（棒子属于别的
     * 会话），`drop` 必须**清掉**（过期了，留着就会在很久以后突然冒出一段旧
     * 摘抄）。一个只返回字符串的版本会逼调用方自己再判一次，而"忘了清"正是
     * 最容易写错、又最难在界面上发现的那一种。
     *
     * 纯函数：**不修改** `handoffs`。清理由 {@link commitDraftHandoff} 显式做，
     * 于是"什么时候清"是一个看得见、测得到的动作，而不是藏在读操作里的副作用。
     *
     * @param {Map<string, {text: string, at: number}>} handoffs 接力区
     * @param {unknown} sessionId 当前面板所属会话
     * @param {number} now 当前时间戳
     * @param {number} [ttlMs] 有效期
     * @returns {{ action: 'wait'|'drop'|'deliver', text?: string }}
     */
    function takeDraftHandoff(handoffs, sessionId, now, ttlMs = DRAFT_HANDOFF_TTL_MS) {
      if (!(handoffs instanceof Map)) return { action: 'wait' }
      const id = normalizeId(sessionId)
      if (id === '') return { action: 'wait' }
      const entry = handoffs.get(id)
      if (entry === null || entry === undefined || typeof entry !== 'object') return { action: 'wait' }
      const at = typeof entry.at === 'number' ? entry.at : 0
      if (!Number.isFinite(now) || now - at > ttlMs) return { action: 'drop' }
      return typeof entry.text === 'string' && entry.text !== ''
        ? { action: 'deliver', text: entry.text }
        : { action: 'drop' }
    }

    /**
     * 兑现或丢弃之后把格子清掉。
     *
     * ⚠️ `wait` 时**不要**调用；`deliver` 时也必须在**真的写进输入框之后**才调，
     * 否则输入框接口晚到一步（`inputActions` 还没注入）就会把文字永久丢掉 ——
     * 那是这一版最容易写错的一行。
     *
     * @param {Map<string, object>} handoffs 接力区
     * @param {unknown} sessionId 会话
     */
    function commitDraftHandoff(handoffs, sessionId) {
      if (!(handoffs instanceof Map)) return
      const id = normalizeId(sessionId)
      if (id !== '') handoffs.delete(id)
    }

    /**
     * 记下"这个会话的面板之前在干什么"。
     *
     * `book` 与 `draft` 存的是接口回来的**普通 JSON**（不是 Cordis 的活对象），
     * 所以整份留下是安全的，重挂时不必再等一次列表请求。
     *
     * @param {Map<string, object>} views 会话视图记忆
     * @param {unknown} sessionId 会话
     * @param {{ view?: unknown, book?: unknown, draft?: unknown, origin?: unknown }} next 当前状态
     */
    function rememberSessionView(views, sessionId, next) {
      if (!(views instanceof Map)) return
      const id = normalizeId(sessionId)
      if (id === '') return
      const book = next?.book ?? null
      if (book !== null && typeof book.bookId !== 'string') return
      // 草稿要和落点**一起**记。只记 `view: 'notes'` 而不记草稿，还原出来就是
      // 一个空编辑框 —— `resolveRestoreView` 正是靠"有没有草稿"决定要不要还原
      // 笔记页（见那里的说明）。
      const draft = next?.draft ?? null
      // ⚠️ 从前这里要求 `draft.draftId` 必须是字符串。现在**未保存的起稿**也要能记：
      // 只选了正文、还没点「保存草稿」时，服务端根本没有这条记录（那是刻意的，
      // 见 `captureNote`），可它照样得跟着"落点"一起记 —— 否则读者切个页签再回来，
      // 摘抄和感想就没了，而界面上看起来只是"它没记住"。有 `draftId` 的是服务端
      // 草稿，没有的是本地起稿，两者都是"这一层有东西可还原"的合法证据
      // （`resolveRestoreView` 只判它空不空）。
      if (draft !== null && typeof draft !== 'object') return
      // 先删后插：让"最近记过的"排到队尾（见 `capSessionMemory` 的 LRU 说明）。
      views.delete(id)
      views.set(id, {
        view: typeof next?.view === 'string' ? next.view : 'shelf',
        book,
        draft,
        origin: typeof next?.origin === 'string' ? next.origin : null,
      })
      capSessionMemory(views)
    }

    /**
     * 取回这个会话上次的面板状态；没有就返回 `undefined`。
     *
     * @param {Map<string, object>} views 会话视图记忆
     * @param {unknown} sessionId 会话
     * @returns {{ view?: string, book?: object|null }|undefined}
     */
    function recallSessionView(views, sessionId) {
      if (!(views instanceof Map)) return undefined
      const id = normalizeId(sessionId)
      if (id === '') return undefined
      return views.get(id)
    }

    /**
     * 重挂时该落到哪个视图。
     *
     * `notes` 是**有条件**还原的：笔记页的内容来自草稿，所以只在草稿也在的时候
     * 才还原。两种情况分得很清楚 ——
     *
     *   - 草稿在（跨会话交接会把它一起交过来、未保存的起稿也在记忆里）：还原
     *     笔记页才对。读者发完摘抄正要接着写感想，界面不该从他眼前跳走；
     *   - 草稿不在（切页签、刷新页面、同一个会话自己重挂）：还原过去是一个
     *     **空编辑框**，比回目录更糟 —— 读者会以为自己的摘抄丢了。
     *
     * ⚠️ 这里的"草稿"**包含没有 `draftId` 的未保存起稿**。它与服务端草稿在
     * "有没有 id"上不同，但在"有没有东西可还原"上完全一样，所以这一层不必也不该
     * 区分。
     *
     * `reader` 会被还原，但要等目录到位（见 `ReaderPanel` 里的落点 effect）：
     * `ReaderView` 需要 `chapters[chapterIndex]`，目录没到时渲染不出正文。
     *
     * @param {unknown} view 记下的视图
     * @param {unknown} [draft] 同一个会话记忆里的草稿（可能是未保存的起稿）
     * @returns {'shelf'|'toc'|'reader'|'notes'|'companion'}
     */
    function resolveRestoreView(view, draft = null) {
      if (view === 'reader') return 'reader'
      if (view === 'companion') return 'companion'
      if (view === 'notes') {
        return draft === null || draft === undefined ? 'toc' : 'notes'
      }
      if (view === 'toc') return 'toc'
      return 'shelf'
    }

    /**
     * 重挂之后，那笔"待落点"的还原该怎么办。
     *
     * 三态的理由和 {@link takeDraftHandoff} 一样：`stay` 必须**留着**待办
     * （目录还没到，现在落点会渲染出没有正文的阅读页），`drop` 必须**清掉**
     * （读者自己换了书，那是他主动选的另一本）。
     *
     * ⚠️ 存在的理由是踩过的坑：挂载那一趟 `catalog` 还是初始的
     * `{ chapters: [], loading: false }`，而 `openBook` 是在**同一次提交的
     * 另一个 effect** 里才把它置成 loading 的 —— 所以"已经加载完、并且章节
     * 为空"是个**假象**。老代码在这一趟就把待还原项清掉了，紧接着因为章节为
     * 空而 `return`，等目录真到位时已经没得还原：从笔记页跳过去只会停在
     * **目录页**，而不是读者刚才在读的正文。
     *
     * 那一条只对 `reader` 成立。目录页 / 笔记页 / 陪读页都不读目录，让它们一起
     * 等，代价是读者看得见的一次多余跳转。
     *
     * @param {{bookId: string, view: string}|null} pending 待还原项
     * @param {{bookId?: string}|null} book 当前书
     * @param {{loading?: boolean, chapters?: unknown[]}|null} catalog 目录
     * @returns {'stay'|'drop'|'apply'}
     */
    function resolveRestoreStep(pending, book, catalog) {
      if (pending === null || pending === undefined) return 'stay'
      if (book === null || book === undefined) return 'stay'
      if (pending.bookId !== book.bookId) return 'drop'
      // 只有**正文**需要目录：`ReaderView` 要 `chapters[chapterIndex]` 才渲染得出
      // 正文。目录页 / 笔记页 / 陪读页都不需要它，所以别让它们白等一次目录请求 ——
      // 笔记页尤其明显：等目录会让读者先看到一眼目录，再跳回笔记页。
      if (pending.view !== 'reader') return 'apply'
      if (catalog?.loading === true) return 'stay'
      const chapters = Array.isArray(catalog?.chapters) ? catalog.chapters : []
      // 章节为空就还不能落点：`ReaderView` 需要 `chapters[chapterIndex]`。
      if (chapters.length === 0) return 'stay'
      return 'apply'
    }

    /**
     * 跳过去之后，把阅读页签在**目标会话**里显示出来的重试间隔。
     *
     * 为什么要重试：`openTab` 用的是**当前已挂载**的侧边栏 binding。宿主
     * `SidebarRightController.require()` 在没有挂载面时**直接抛**
     * `no session surface is mounted`；而 `sessions.open()` 之后，目标会话的
     * 侧边栏要等一次 React 提交才挂上 —— 所以**第一次几乎必然太早**。
     *
     * 为什么可以无脑重试：`openTab(..., { revealIfOpened: true })` 对已经开着的
     * 页签只是"再显示一次"，是幂等的；多打几次没有副作用。
     */
    const REVEAL_RETRY_DELAYS = [150, 340, 560, 820, 1120]

    /**
     * 在目标会话里把本插件的阅读页签显示出来。
     *
     * ⚠️ 这是**尽力而为**，不是保证。三种情况下会静默失败：
     *   1. 宿主没把 `sidebarRight` 服务给出来；
     *   2. 目标会话的侧边栏始终没挂载（右侧栏被收起等）；
     *   3. 宿主改了 `openTab` 的名字或语义（它标着 `ISidebarRight`，是公开面）。
     *
     * 失败时降级为"自己点一下页签"，其余一切（书、章、位置、摘抄）照常就位 ——
     * 所以这里**绝不会**因为打不开页签而影响任何其他功能。
     *
     * @param {object|undefined} sidebarRight 宿主侧边栏控制器
     * @param {unknown} targetSessionId 目标会话
     * @param {Function} schedule `setTimeout` 形态的调度器（注入是为了可测）
     * @returns {boolean} 是否至少发出了尝试
     */
    function revealReaderTab(sidebarRight, targetSessionId, schedule) {
      if (sidebarRight === null || sidebarRight === undefined) return false
      const hasOpenTab = typeof sidebarRight.openTab === 'function'
      const hasOpenTabIn = typeof sidebarRight.openTabIn === 'function'
      if (!hasOpenTab && !hasOpenTabIn) return false
      const attempt = () => {
        try {
          if (hasOpenTab) {
            sidebarRight.openTab(TAB_KIND, { revealIfOpened: true })
            return
          }
          // `openTabIn` 被宿主自己标注为「Not part of `ISidebarRight`」，是内部
          // 路径。只在没有公开的 `openTab` 时才退到它，且同样包在 try 里 ——
          // 拿不到就只是不开这个页签，不会连累别的功能。
          sidebarRight.openTabIn(targetSessionId, TAB_KIND, { revealIfOpened: true })
        } catch {
          /* 侧边栏还没挂上：交给后面那几次重试 */
        }
      }
      for (const delay of REVEAL_RETRY_DELAYS) {
        if (typeof schedule === 'function') schedule(attempt, delay)
        else attempt()
      }
      return true
    }
    //#endregion

    /**
     * 人类可读的字节数。
     *
     * @param {number} bytes 字节数
     * @returns {string}
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }
    //#endregion

    //#region 展示组件
    /**
     * 面板顶栏：返回、标题、右侧动作。
     *
     * @param {{ title: string, onBack?: Function, actions?: any[] }} props
     */
    function TopBar(props) {
      const { title, onBack, actions } = props
      return h(
        'div',
        { className: 'drc-bar' },
        onBack === undefined
          ? null
          : h('button', { type: 'button', className: 'drc-btn', onClick: onBack, title: '返回' }, '←'),
        h('div', { className: 'drc-bar-title', title }, title),
        ...(actions ?? []),
      )
    }

    /**
     * 书架视图：书列表 + 导入区。
     *
     * @param {{ onOpen: Function }} props
     */
    function ShelfView(props) {
      const { onOpen, openSession } = props
      const [state, setState] = useState({ loading: true, books: [], error: null, recovered: false })
      const [health, setHealth] = useState(null)
      const [scan, setScan] = useState(null)
      const [manualPath, setManualPath] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      /** 正在内联输入新分类名的那本书（`null` = 没有）。 */
      const [editingCategory, setEditingCategory] = useState(null)
      const [categoryDraft, setCategoryDraft] = useState('')

      /**
       * 状态文件损坏的提示（P2-2）；`null` = 一切正常，不显示。
       *
       * ⚠️ 数据搭 `/health` 一起回来（`reload()` 本来就在拉它）⇒ **零新增请求**。
       *    它常驻（宿主直接读盘），不是 toast —— 读者得能对着它去处理那份坏文件。
       */
      const quarantineText = quarantineNoticeText(health === null ? null : health.quarantined)

      /**
       * 书架分组，**每次渲染只算一遍**。
       *
       * ⚠️ 这里曾经是 O(N²)：`renderCategoryPicker` 内部直接调
       * `groupBooksByCategory(state.books)` 取分类名，而它是**逐本书**调用的
       * （在书架列表的 `map` 里），于是渲染一次书架要跑 N 次"建 Map + 排序"。
       * 而 `manualPath`（导入路径输入框）是 `ShelfView` 自己的 state ——
       * **每敲一个字符都会重渲染整张书架**，所以那 N 次重算是绑在打字上的。
       *
       * 分组和"分类名清单"都只依赖 `state.books`，提到这里算一次即可。
       * 实测代价本来就不大（书架通常只有个位数本书），但它是**随书数平方增长**
       * 的形状，不该留着——真正的成本在将来，而修复成本是零。
       */
      const groups = useMemo(() => groupBooksByCategory(state.books), [state.books])
      /** 下拉候选：来自"现在真的有书在里面"的分类（见 library.js 的 readCategories）。 */
      const categoryNames = useMemo(
        () => groups.map((group) => group.category).filter((name) => name !== UNCATEGORIZED),
        [groups],
      )

      /**
       * 收起了哪几个分类。
       *
       * **默认全展开**（名单为空就是全展开）—— 新导入的书落在「未分类」里，
       * 一进来就找不到书是最糟的默认值。只有读者亲手收过的那些才记在名单里，
       * 且**跨会话记住**（理由见 `loadCollapsedCategories`）。
       */
      const [collapsedCategories, setCollapsedCategories] = useState(() => loadNameSet(SHELF_COLLAPSED_KEY))

      /**
       * 收起 / 展开一个分类，并立刻落盘。
       *
       * 用**函数式更新**再落盘：`collapsedCategories` 是这次渲染的闭包值，
       * 连点两下时它会过期，而 `next` 一定是最新的那份。
       */
      const toggleCategory = useCallback((category) => {
        setCollapsedCategories((prev) => {
          const next = toggleNameInSet(prev, category)
          saveNameSet(SHELF_COLLAPSED_KEY, next)
          return next
        })
      }, [])

      const reload = useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: null }))
        return Promise.all([callApi('/library'), callApi('/health')])
          .then(([library, info]) => {
            // ⚠️ `recovered` 是宿主如实报的"`library.json` 坏了、这份书架是空的"信号
            //    （`library.js` 的 `list()`）。**必须接住它**：不接的话读者看到的就是
            //    一个没有解释的空书架，而他会以为书丢了（书其实还在 books/ 目录里）。
            setState({ loading: false, books: library.books ?? [], error: null, recovered: library.recovered === true })
            setHealth(info)
          })
          .catch((error) => setState({ loading: false, books: [], error: describeError(error), recovered: false }))
      }, [])

      useEffect(() => {
        reload()
      }, [reload])

      const doScan = useCallback(() => {
        setBusy(true)
        setNotice(null)
        callApi('/library/scan', { method: 'POST' })
          .then((data) => setScan(data.entries ?? []))
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setBusy(false))
      }, [])

      /**
       * 复制收件箱路径。读者真实的下一步是"打开资源管理器、粘进地址栏" ——
       * 而那个路径在一个点开头的深层目录里，手敲等于自罚。
       *
       * 复制失败要**明说**（见 `copyText` 的取舍）：剪贴板里留着上一次的内容
       * 却提示"已复制"，比不提示更坏。
       */
      const doCopyInbox = useCallback((path) => {
        copyText(path).then((ok) => setNotice(ok
          ? { kind: 'ok', text: `已复制收件箱路径：${path}` }
          : { kind: 'error', text: '复制失败——宿主没给剪贴板权限，请手动选中路径复制' }))
      }, [])

      /** 在系统文件管理器里打开收件箱（拿不到能力时按 `openPathInFileManager` 的说明如实报错）。 */
      const doOpenInbox = useCallback((path) => {
        setNotice(null)
        openPathInFileManager(path).catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
      }, [])

      const doImport = useCallback(
        (absPath) => {
          setBusy(true)
          setNotice(null)
          callApi('/library/import', { method: 'POST', body: { absPath } })
            .then((data) => {
              setNotice({ kind: 'ok', text: importOutcomeText(data) })
              setScan(null)
              return reload()
            })
            .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
            .finally(() => setBusy(false))
        },
        [reload],
      )

      const doRemove = useCallback(
        (book) => {
          setBusy(true)
          setNotice(null)
          callApi(`/library/${book.bookId}?keepNotes=1`, { method: 'DELETE' })
            .then(() => {
              setNotice({ kind: 'ok', text: `已移除《${book.title}》（笔记已留副本）` })
              return reload()
            })
            .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
            .finally(() => setBusy(false))
        },
        [reload],
      )

      /**
       * 设置一本书的分类。
       *
       * 传空串 = 移回「未分类」。服务端也是这么解释的（见 `/library/:bookId/category`
       * 路由），所以这里不需要另开一个"清除"接口。
       */
      const doSetCategory = useCallback(
        (book, category) => {
          setBusy(true)
          setNotice(null)
          callApi(`/library/${book.bookId}/category`, { method: 'POST', body: { category } })
            .then(() => {
              setNotice({
                kind: 'ok',
                text: category === '' || category === undefined
                  ? `《${book.title}》已移回「${UNCATEGORIZED}」`
                  : `《${book.title}》已归入「${category}」`,
              })
              setEditingCategory(null)
              setCategoryDraft('')
              return reload()
            })
            .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
            .finally(() => setBusy(false))
        },
        [reload],
      )

      /**
       * 一本书右侧的分类控件。
       *
       * 用 `select` + 一个「＋ 新建分类…」选项，而**不是 `window.prompt`**：
       * Electron 根本没有实现 `window.prompt`（调用返回 `null`，且不报错），
       * 那会让"新建分类"变成一个点了没反应的按钮。内联输入框在任何宿主里都工作。
       *
       * @param {object} book 书架条目
       * @param {string[]} names 分类候选（由调用方 `useMemo` 算好，别在这里重算）
       * @returns {object} React 元素
       */
      const renderCategoryPicker = (book, names) => {
        const current = typeof book.category === 'string' ? book.category : ''
        if (editingCategory === book.bookId) {
          const commit = () => doSetCategory(book, categoryDraft)
          const cancel = () => {
            setEditingCategory(null)
            setCategoryDraft('')
          }
          return h(
            'span',
            { className: 'drc-cat-edit' },
            h('input', {
              className: 'drc-input drc-input-small',
              value: categoryDraft,
              placeholder: '分类名',
              autoFocus: true,
              onChange: (event) => setCategoryDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') commit()
                if (event.key === 'Escape') cancel()
              },
            }),
            h('button', { type: 'button', className: 'drc-btn drc-btn-small', disabled: busy, onClick: commit }, '确定'),
            h('button', { type: 'button', className: 'drc-btn drc-btn-small', disabled: busy, onClick: cancel }, '取消'),
          )
        }
        // 选项来自"现在真的有书在里面"的分类——服务端刻意不维护分类清单，
        // 分类存在当且仅当有书属于它（见 library.js 的 readCategories）。
        // 候选由调用方算好传进来：在这里算就是每本书重算一遍整张书架。
        return h(
          'select',
          {
            className: 'drc-input drc-input-small',
            value: current,
            title: '设置分类',
            disabled: busy,
            onChange: (event) => {
              const value = event.target.value
              if (value === NEW_CATEGORY) {
                setEditingCategory(book.bookId)
                setCategoryDraft('')
                return
              }
              doSetCategory(book, value)
            },
          },
          h('option', { value: '' }, UNCATEGORIZED),
          ...names.map((name) => h('option', { key: name, value: name }, name)),
          h('option', { value: NEW_CATEGORY }, '＋ 新建分类…'),
        )
      }

      const inbox = resolveInboxPath(health)

      return h(
        'div',
        { className: 'drc-root' },
        h(TopBar, {
          title: '书架',
          actions: [
            h('button', { key: 'r', type: 'button', className: 'drc-btn', onClick: reload, disabled: busy }, '刷新'),
          ],
        }),
        h(
          'div',
          { className: 'drc-body' },
          h(
            'div',
            { className: 'drc-pad' },
            h(Notice, { notice, onDismiss: () => setNotice(null) }),

            // --- 导入区 ---
            h(
              'div',
              { className: 'drc-card' },
              h('div', { style: { marginBottom: 6 } }, '导入本地 TXT'),
              inbox === null
                ? null
                : h(
                    'div',
                    { className: 'drc-import-hint' },
                    '把 .txt 放进 ',
                    h('code', null, inbox),
                    ' 再点「扫描导入目录」；也可以直接粘贴绝对路径。',
                  ),
              inbox === null
                ? null
                : h(
                    'div',
                    { className: 'drc-import-hint' },
                    // 搬走这件事必须**事先**交代：否则读者回头发现文件"不见了"，
                    // 第一反应是插件把他的东西弄丢了。
                    '导入成功后，收件箱里那份会移到 ',
                    h('code', null, '.imported/'),
                    '（不删除）。',
                  ),
              // 三颗动作**横排**（`flex-wrap: wrap` 兜窄面板）—— 它们是一组"围绕收件箱
              // 的动作"，拆开排会显得零散。
              // ⚠️ 2026-10-03 更正：这里原先写"竖排一列（读者指定）"，与下面 `.drc-import-actions`
              //    的 `flex-direction: row` **正好相反**（测试断言的也是"不许 column"）。
              //    读者 2026-09-27 那次更正的只是把「扫描导入目录」提到同一行，不是改成竖排。
              h(
                'div',
                { className: 'drc-import-actions' },
                ...(inbox === null
                  ? []
                  : [
                      h(
                        'button',
                        { key: 'copy', type: 'button', className: 'drc-btn', onClick: () => doCopyInbox(inbox) },
                        '复制路径',
                      ),
                      h(
                        'button',
                        { key: 'open', type: 'button', className: 'drc-btn', onClick: () => doOpenInbox(inbox) },
                        '打开导入目录',
                      ),
                    ]),
                h(
                  'button',
                  { key: 'scan', type: 'button', className: 'drc-btn', onClick: doScan, disabled: busy },
                  '扫描导入目录',
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 6 } },
                h('input', {
                  className: 'drc-input',
                  value: manualPath,
                  // 说清这个框是干什么的：它是一条"绕过收件箱"的旁路，
                  // 而 placeholder 从前只给了一个孤零零的路径样例。
                  placeholder: '手动导入书籍路径：C:\\books\\夜行.txt',
                  onChange: (event) => setManualPath(event.target.value),
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'drc-btn drc-btn-primary',
                    disabled: busy || manualPath.trim() === '',
                    onClick: () => doImport(manualPath.trim()),
                  },
                  '手动导入',
                ),
              ),
              scan === null
                ? null
                : h(
                    'ul',
                    { className: 'drc-list', style: { marginTop: 8 } },
                    ...(scan.length === 0
                      ? [h('li', { key: 'none', className: 'drc-item-sub' }, '导入目录里没有可导入的文件')]
                      : scan.map((entry) =>
                          h(
                            'li',
                            { key: entry.absPath, className: 'drc-item', style: { cursor: 'default' } },
                            h(
                              'div',
                              { className: 'drc-item-main' },
                              h('div', { className: 'drc-item-name' }, entry.name),
                              h(
                                'div',
                                { className: 'drc-item-sub' },
                                formatBytes(entry.byteLength),
                                entry.alreadyImported ? ' · 已在书架' : '',
                                entry.looksLikeText ? '' : ' · 不是 .txt，可能无法解析',
                              ),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'drc-btn',
                                disabled: busy || entry.alreadyImported,
                                onClick: () => doImport(entry.absPath),
                              },
                              entry.alreadyImported ? '已导入' : '导入',
                            ),
                          ),
                        )),
                  ),
            ),

            // --- 状态文件损坏提示（P2-2）---
            // ⚠️ 位置是刻意的：**在书列表之上**，而且不管书架是空是满都显示。
            //    这一节从前只给"书架索引坏了"（`recovered`）一句话，而绑定 / 分类 / 设置
            //    损坏时读者侧零提示；更要紧的是它**放在空书架那支分支里**就看不到 ——
            //    进度丢光的读者往往书架是满的。
            quarantineText === null ? null : h('div', { className: 'drc-error' }, quarantineText),

            // --- 书列表（按分类分组，「未分类」永远在最前） ---
            state.loading
              ? h('div', { className: 'drc-note' }, '正在读取书架…')
              : state.error !== null
                ? h('div', { className: 'drc-error' }, `读取书架失败：${state.error}`)
                : state.books.length === 0
                  ? (state.recovered === true
                    // ⚠️ 「书架是空的」与「书架索引坏了」必须分开说。不说的话读者会以为
                    //    自己导入的书丢了 —— 它们其实都在磁盘上（books/ 目录），
                    //    只是索引（`library.json`）读不出来。并如实告诉他下一步会被拒。
                    ? h('div', { className: 'drc-error' }, '⚠️ 书架索引（library.json）损坏了，'
                      + '所以现在按空书架显示 —— 书没有丢：每本书的正文、笔记与背景认识都还在'
                      + '磁盘上的 books/ 目录里。请先修好或移走那份索引；在它恢复之前导入会被拒绝'
                      + '（那是刻意的：否则新导入会把整份索引覆盖成"只有这一本"）。')
                    : h('div', { className: 'drc-note' }, '书架还是空的。先导入一本 TXT 吧。'))
                  : h(
                      'div',
                      null,
                      ...groups.map((group) => h(
                        'div',
                        { key: group.category, className: 'drc-section' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'drc-label drc-cat-toggle',
                            // 收起时也把它做成按钮（而不是换个 div）：键盘与读屏用户
                            // 拿到的仍是同一个可聚焦、可切换的控件，只差 aria-expanded 的值。
                            'aria-expanded': collapsedCategories.includes(group.category) ? 'false' : 'true',
                            title: collapsedCategories.includes(group.category) ? '展开这个分类' : '收起这个分类',
                            onClick: () => toggleCategory(group.category),
                          },
                          h(
                            'span',
                            { className: 'drc-cat-caret', 'aria-hidden': 'true' },
                            collapsedCategories.includes(group.category) ? '▸' : '▾',
                          ),
                          `${group.category}（${group.books.length}）`,
                        ),
                        // 收起时只留这一行标题（连同它的书目数）—— 书多的时候，
                        // 这一步省掉的是"滚动半屏才能翻到下一个分类"。
                        collapsedCategories.includes(group.category) ? null : group.books.length === 0
                          ? h('div', { className: 'drc-note' }, '这里还没有书。')
                          : h(
                              'ul',
                              { className: 'drc-list' },
                              ...group.books.map((book) => {
                                const bind = shelfBindingState(book, openSession)
                                return h(
                                  'li',
                                  { key: book.bookId, className: 'drc-item', onClick: () => onOpen(book) },
                                  h(
                                    'div',
                                    { className: 'drc-item-main' },
                                    h('div', { className: 'drc-item-name' }, book.title),
                                    h(
                                      'div',
                                      { className: 'drc-item-sub' },
                                      `${book.chapterCount} 章 · ${formatBytes(book.byteLength)} · ${book.encoding}`,
                                    ),
                                    h(
                                      'div',
                                      { className: 'drc-item-sub' },
                                      book.progress === null
                                        ? '尚未开始'
                                        : `读至第 ${book.progress.chapterIndex + 1} 章`,
                                    ),
                                  ),
                                  // 控制区整块 stopPropagation：这一行本身是可点的
                                  // （点开书）。点下拉或按钮时不该顺带把书打开。
                                  h(
                                    'div',
                                    {
                                      className: 'drc-shelf-actions',
                                      onClick: (event) => event.stopPropagation(),
                                    },
                                    // 未绑定 → 静态灰标；已绑定 → 能跳就做成按钮，
                                    // 跳不了（宿主没有 sessions 服务）就退回静态标。
                                    bind.canJump
                                      ? h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'drc-btn drc-btn-small',
                                            title: `跳到会话 ${bind.sessionId}`,
                                            onClick: () => openSession(bind.sessionId),
                                          },
                                          bind.label,
                                        )
                                      : h(
                                          'span',
                                          {
                                            className: bind.bound
                                              ? 'drc-badge'
                                              : 'drc-badge drc-badge-muted',
                                          },
                                          bind.label,
                                        ),
                                    renderCategoryPicker(book, categoryNames),
                                  ),
                                  h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'drc-btn',
                                      disabled: busy,
                                      title: '移除（笔记会留一份副本）',
                                      onClick: (event) => {
                                        event.stopPropagation()
                                        doRemove(book)
                                      },
                                    },
                                    '移除',
                                  ),
                                )
                              }),
                            ),
                      )),
                    ),
          ),
        ),
      )
    }

    /**
     * 「导入说明」折条：默认收起成一行，点开看逐条。
     *
     * 收起是刻意的（和目录筛选条同一个理由）：面板宽度有限，而这条信息只在
     * "怀疑正文有问题"或"想知道这份正文从哪来"时才需要。没有可交代的内容时
     * 直接不渲染（`importNotes` 返回空数组）—— 不留一个空壳。
     *
     * @param {{ book: object|null|undefined }} props
     * @returns {object|null} vnode
     */
    function ImportNotes(props) {
      const book = props?.book ?? null
      const lines = useMemo(() => importNotes(book), [book])
      // ⚠️ hook 必须在 early return **之前**：`useState` 排在 `if` 后面的话，
      // 一旦某本书的说明从有变无（重新导入），hook 顺序就与上一次渲染不同了。
      const [open, setOpen] = useState(false)
      if (lines.length === 0) return null
      return h(
        'div',
        { className: 'drc-import' },
        h(
          'button',
          {
            type: 'button',
            className: 'drc-import-toggle',
            onClick: () => setOpen((value) => !value),
            title: '导入这份正文时交代过的事',
          },
          `导入说明（${lines.length} 条）${open ? ' ▾' : ' ▸'}`,
        ),
        open
          ? h(
              'ul',
              { className: 'drc-import-list' },
              lines.map((line, index) => h('li', { key: `${index}-${line}` }, line)),
            )
          : null,
      )
    }

    /**
     * 目录视图。
     *
     * @param {{ book: object, chapters: Array<object>, progress: object|null, loading: boolean,
     *           error: string|null, onBack: Function, onPick: Function,
     *           onOpenCompanion: Function, onOpenNotes: Function }} props
     */
    function TocView(props) {
      const { book, chapters, progress, loading, error, onBack, onPick, onOpenCompanion, onOpenNotes } = props
      /**
       * 目录筛选词。
       *
       * 上千章的书（实测《一世之尊》1404 章）里，"滚到第 812 章"要划过七千来个
       * 元素——筛选是这本书里唯一好用的定位方式。空串 = 不筛选，此时渲染结果
       * 与加这个功能之前**逐元素相同**。
       */
      const [tocFilter, setTocFilter] = useState('')
      const filtered = useMemo(() => filterChapters(chapters, tocFilter), [chapters, tocFilter])
      const groups = useMemo(() => groupByVolume(filtered), [filtered])
      const current = progress === null ? -1 : progress.chapterIndex
      /**
       * 手动展开的那一卷（`null` = 只看"正在读的那一卷"）。
       *
       * 一次只留一卷手动开的：读者的意图是"去翻某一卷"，不是"把书架摊开"。
       * 规则本身在 `isVolumeOpen` 里（纯函数，有专测）。
       */
      const [openVolume, setOpenVolume] = useState(null)
      /**
       * 被读者**显式收起**的卷（即使它是当前卷）。
       *
       * 有它才能做到"当前卷默认展开、但你说收起就收起" —— 否则"当前卷常开"会把
       * 那一卷**锁死**。数组而不是 Set：测试替身不调用 `useState` 的初始化函数
       * （见 `NoteList` 里 `openIds` 的同款说明）。
       */
      const [closedVolumes, setClosedVolumes] = useState([])

      return h(
        'div',
        { className: 'drc-root' },
        h(TopBar, {
          title: book.title,
          onBack,
          actions: [
            h(
              'button',
              { key: 'notes', type: 'button', className: 'drc-btn', onClick: onOpenNotes, title: '读书笔记' },
              '笔记',
            ),
            h(
              'button',
              { key: 'companion', type: 'button', className: 'drc-btn', onClick: onOpenCompanion, title: '陪读设置：绑定、背景认识、书友设定、防剧透、导出' },
              // 这颗按钮进的是「陪读」页（绑定 / 背景认识 / 书友设定 / 防剧透闸 / 导出），
              // 它本质上是一页**设置**。叫「陪读」会和页签名（现在是「本地书架」）混起来，
              // 也说不清点下去会看到什么。
              '设置',
            ),
          ],
        }),
        h(
          'div',
          { className: 'drc-body' },
          loading
            ? h('div', { className: 'drc-note' }, '正在解析目录…')
            : error !== null
              ? h('div', { className: 'drc-error' }, `读取目录失败：${error}`)
              : h(
                  'div',
                  { className: 'drc-pad' },
                  h('div', { className: 'drc-item-sub', style: { marginBottom: 4 } }, progressLabel(progress, chapters)),
                  // 导入说明排在定长分段那句之上：它是**更一般**的交代（编码、
                  // 切分质量），而定长分段只是其中一种已被单独强调的情形。
                  h(ImportNotes, { book }),
                  ...(book.strategy === 'fixed-blocks'
                    ? [
                        h(
                          'div',
                          { key: 'warn', className: 'drc-warn' },
                          '这本书没有可识别的章节标题，已按定长分段。目录里的「第 N 段」是分段序号，不是原书章节。',
                        ),
                      ]
                    : []),
                  // 目录筛选条。短书不显示（见 TOC_FILTER_MIN）：一本 20 章的
                  // 书里，筛选条本身比目录还占地方。
                  chapters.length < TOC_FILTER_MIN
                    ? null
                    : h(
                        'div',
                        { className: 'drc-toc-filter' },
                        h('input', {
                          className: 'drc-input',
                          value: tocFilter,
                          placeholder: `在这 ${chapters.length} 章里找（章号 / 标题 / 卷名）`,
                          onChange: (event) => setTocFilter(event.target.value),
                        }),
                        tocFilter === ''
                          ? null
                          : h('span', { className: 'drc-item-sub' }, `匹配 ${filtered.length} 章`),
                        tocFilter === ''
                          ? null
                          : h(
                              'button',
                              {
                                type: 'button',
                                className: 'drc-btn drc-btn-small',
                                onClick: () => setTocFilter(''),
                              },
                              '清除',
                            ),
                      ),
                  // 筛到空时要明说。"什么都不显示"和"这本书坏了"在界面上长得一样。
                  filtered.length === 0
                    ? h('div', { className: 'drc-note' }, `没有匹配「${tocFilter}」的章节。`)
                    : null,
                  ...groups.map((group, groupIndex) => {
                    const groupKey = group.volume ?? ''
                    const firstIndex = group.chapters[0]?.index ?? 0
                    const lastIndex = group.chapters[group.chapters.length - 1]?.index ?? 0
                    const open = isVolumeOpen({
                      key: groupKey,
                      isCurrent: current >= firstIndex && current <= lastIndex,
                      openVolume,
                      closedKeys: closedVolumes,
                      filtering: tocFilter !== '',
                    })
                    /**
                     * 开关这一卷（鼠标与键盘共用一条路径 —— 见下面 `onKeyDown` 的说明）。
                     * 展开状态是**本地**的：开关一次目录不该写进任何持久层，
                     * 也不该影响阅读进度（进度只由正文滚动与显式动作推进）。
                     */
                    const toggleVolume = () => {
                      if (open) {
                        // 收起：记进"显式收起"（**当前卷也照收**），并让出手动展开位。
                        setClosedVolumes((prev) => (prev.includes(groupKey) ? prev : [...prev, groupKey]))
                        setOpenVolume((prev) => (prev === groupKey ? null : prev))
                        return
                      }
                      setClosedVolumes((prev) => prev.filter((item) => item !== groupKey))
                      setOpenVolume(groupKey)
                    }
                    return h(
                      'div',
                      { key: `g${groupIndex}-${group.volume ?? 'none'}` },
                      group.volume === null
                        ? null
                        : h(
                            'div',
                            {
                              className: 'drc-volume drc-volume-btn',
                              // ⚠️ **键盘可达**（2026-10-02 三方评审 P2-11）：这一行从前只是个带
                              //    `onClick` 的 `div` ⇒ 键盘用户**展不开卷、也进不了章节**，而这是
                              //    插件的主导航路径。这里不改成 `<button>` 是因为 `.drc-volume-btn`
                              //    的布局是专门为这一行写的（flex + baseline），换标签会牵动观感；
                              //    补上 role / tabIndex / 键盘处理 / 展开状态即可达成同样的可达性。
                              role: 'button',
                              tabIndex: 0,
                              'aria-expanded': open,
                              onKeyDown: (event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return
                                event.preventDefault()
                                toggleVolume()
                              },
                              // 展开状态是**本地**的：开关一次目录不该写进任何持久层，
                              // 也不该影响阅读进度（进度只由正文滚动与显式动作推进）。
                              onClick: toggleVolume,
                              title: open ? '收起这一卷' : '展开这一卷',
                            },
                            h('span', null, `${open ? '▾' : '▸'} ${group.volume}`),
                            h(
                              'span',
                              { className: 'drc-item-sub' },
                              `${firstIndex + 1}–${lastIndex + 1} 章 · ${group.chapters.length} 章`,
                            ),
                          ),
                      open
                        ? h(
                            'ul',
                            { className: 'drc-list' },
                            ...group.chapters.map((chapter) =>
                              h(
                                'li',
                                {
                                  key: chapter.index,
                                  className: chapter.index === current ? 'drc-item drc-item-cur' : 'drc-item',
                                  // ⚠️ 同上：只带 `onClick` 的 `li` 键盘选不了章。
                                  //    `aria-current` 让读屏软件知道"你现在在这一章"。
                                  role: 'button',
                                  tabIndex: 0,
                                  'aria-current': chapter.index === current ? 'true' : undefined,
                                  onKeyDown: (event) => {
                                    if (event.key !== 'Enter' && event.key !== ' ') return
                                    event.preventDefault()
                                    onPick(chapter)
                                  },
                                  onClick: () => onPick(chapter),
                                },
                                h('span', { className: 'drc-item-num' }, String(chapter.index + 1).padStart(3, '0')),
                                h(
                                  'div',
                                  { className: 'drc-item-main' },
                                  h('div', { className: 'drc-item-name' }, chapter.title),
                                ),
                                h('span', { className: 'drc-item-num' }, `${Math.round((chapter.length ?? 0) / 100) / 10}k`),
                              ),
                            ),
                          )
                        : null,
                    )
                  }),
                ),
        ),
      )
    }

    /**
     * 位置恢复的账本键：**按「书 + 章」记账**。
     *
     * ⚠️ 这里踩过一次坑，必须写下来：原先是 `useRef(false)` 的一个布尔旗标，
     * 语义是"恢复过一次就不再恢复"。但 `ReaderView` 挂载那一刻 `chapter` 还是
     * `null`、`paragraphs` 是空数组，恢复位置的 effect **却照样会跑一趟**，
     * 把旗标提前消耗掉。等正文真的到达、依赖变化让 effect 重跑时，旗标已经是
     * `true` → 直接 `return`，于是**再也没有人滚动过视口**。
     *
     * 后果不是"偶尔偏一点"，而是「进度持久化 → 下次落回原处」整条链路事实上
     * 失效：每次打开书、每次切章，正文都停在章首。而进度在服务端存得好好的
     * （百分比也对），所以从界面上看不出它是坏的，只觉得"它怎么不记得我读到哪"。
     *
     * 换成按书+章记账之后：
     *   - 空 `paragraphs` **不记账**（见 {@link shouldRestorePosition}）；
     *   - 同一章只恢复一次，所以自动进度回写导致 `initialOffset` 变化时
     *     不会再滚一趟——旧的布尔版配上 `initialOffset` 依赖数组，会让每次
     *     进度回写都把视口往上拉 `handleScroll` 里那 12px 的差值。
     *
     * @param {string} bookId 书 id
     * @param {number} chapterIndex 章号
     * @returns {string} 账本键
     */
    function positionKey(bookId, chapterIndex) {
      return `${bookId}:${chapterIndex}`
    }

    /**
     * 这一趟该不该恢复位置。
     *
     * 抽成纯函数是因为它**就是那个 bug 的全部**：`hasParagraphs` 为假时绝不能
     * 记账，否则正文到达时账已经记过了。三个分支都能被单测直接打中。
     *
     * @param {string|null} restoredKey 已经恢复过的账本键
     * @param {string} key 本轮的账本键
     * @param {boolean} hasParagraphs 正文段落是否已经渲染出来
     * @returns {boolean}
     */
    function shouldRestorePosition(restoredKey, key, hasParagraphs) {
      if (!hasParagraphs) return false
      return restoredKey !== key
    }

    /**
     * 正文视图。
     *
     * 进度回写策略：滚动时**只记在 ref 上**，停手 `PROGRESS_IDLE_MS` 之后
     * 才发一次 PUT；切章或卸载时立刻 flush。这样一次快速通读不会产生
     * 上百个请求，而异常退出最多丢最后 1.2 秒的位置。
     *
     * 边界语义：记的是**视口顶部**那一段的偏移，也就是"读到这儿为止"——
     * 它正好是防剧透要用的边界。打开新章时 scrollTop 为 0、进度即 0，
     * 此时靠宿主侧的章首豁免补上首屏（见 cordis.patch.yml 的 headAllowanceChars）。
     *
     * @param {object} props
     */
    function ReaderView(props) {
      const { book, chapters, chapterIndex, initialOffset, onBack, onNavigate, onOffsetChange, onOpenCompanion, onOpenNotes, onCaptureNote, finished } = props
      const [chapter, setChapter] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      /** 当前选区；有值时显示「记笔记」条。 */
      const [selection, setSelection] = useState(null)
      /** 正文字体偏好（持久化在 localStorage，跨章节/跨会话保留）。 */
      const [fontPrefs, setFontPrefs] = useState(() => loadFontPrefs())
      const [showFontBar, setShowFontBar] = useState(false)
      /**
       * 本章的笔记（**新的在前**）。空数组 = 这一章没记过 —— 正常情况，不是错误。
       *
       * 用途只有一个：正文页章节标题下面那行「本章你记过 N 条」。它不参与
       * 阅读进度的推进，也不写任何东西（纯只读视图）。
       */
      const [chapterNotes, setChapterNotes] = useState([])
      const [showChapterNotes, setShowChapterNotes] = useState(false)

      /**
       * 改字体偏好。**每次都夹住再写**，所以连点 A+ 到上限不会溢出，
       * 也不会把非法值写进 localStorage。
       */
      const updateFont = useCallback((patch) => {
        setFontPrefs((prev) => {
          const next = clampFontPrefs({ ...prev, ...patch })
          saveFontPrefs(next)
          return next
        })
      }, [])

      const scrollerRef = useRef(null)
      const paraRefs = useRef([])
      /** 已经恢复过位置的账本键（见 {@link positionKey}）；`null` = 还没恢复过。 */
      const restoredRef = useRef(null)
      const pendingOffset = useRef(null)
      const saveTimer = useRef(null)

      const paragraphs = useMemo(() => buildParagraphs(chapter?.text ?? ''), [chapter])
      const meta = chapters[chapterIndex]

      // --- 取正文 ---
      useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        setChapter(null)
        restoredRef.current = null
        // 一次性跳转请求只在它所属的那一章有效：换章必须清掉，
        // 否则它会拿旧偏移去滚新章（表现是"翻到下一章就自己跳到半空"）。
        setJumpRequest(null)
        callApi(`/books/${book.bookId}/chapters/${chapterIndex}`)
          .then((data) => {
            if (!cancelled) setChapter(data.chapter)
          })
          .catch((err) => {
            if (!cancelled) setError(describeError(err))
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
        return () => {
          cancelled = true
        }
      }, [book.bookId, chapterIndex])

      // --- 取本章的笔记（角标用） ---
      //
      // 与正文同一个依赖（书 + 章）：换章就要换一批，切书更要换。
      // ⚠️ 这里**不弹错**：它只是个角标，拿不到就不显示 —— 不能因为"取笔记失败"
      // 让读者读不了正文（正文那一路有它自己的错误处理）。
      useEffect(() => {
        let cancelled = false
        setChapterNotes([])
        setShowChapterNotes(false)
        callApi(`/books/${book.bookId}/notes/chapter/${chapterIndex}`)
          .then((data) => {
            if (!cancelled) setChapterNotes(Array.isArray(data?.notes) ? data.notes : [])
          })
          .catch(() => {
            if (!cancelled) setChapterNotes([])
          })
        return () => {
          cancelled = true
        }
      }, [book.bookId, chapterIndex])

      /**
       * 一次性跳转请求（从角标跳到"我记的那一段"）。
       *
       * ⚠️ 这里**不能**复用 `pickChapter`：角标列的是**当前这一章**的笔记，所以它
       * 永远是"同章内跳转"，而同一章的位置恢复被账本键挡着（见 `positionKey` /
       * `shouldRestorePosition`）—— 那一层是给"落回上次位置"用的，它**故意**让
       * 同一章只滚一次。于是这里用一个**一次性请求**：每次点击都是新对象，
       * 连点同一条也会再滚一趟。
       */
      const [jumpRequest, setJumpRequest] = useState(null)

      const jumpToNote = useCallback((note) => {
        setJumpRequest({
          offset: Number.isInteger(note?.charOffset) && note.charOffset > 0 ? note.charOffset : 0,
        })
      }, [])

      useEffect(() => {
        if (jumpRequest === null) return
        const scroller = scrollerRef.current
        if (scroller === null) return
        const index = findParagraphIndex(paragraphs, jumpRequest.offset)
        const el = paraRefs.current[index]
        scroller.scrollTop = el === undefined || index === 0 ? 0 : el.offsetTop
      }, [jumpRequest, paragraphs])

      // --- 落回上次的位置 ---
      //
      // ⚠️ 依赖数组里**必须**留 `paragraphs`：正文是异步来的，挂载那一趟它还是
      // 空数组，真正能滚的时刻是数据到达后的那一趟。`initialOffset` 也要留——
      // 但它变化时**不该**再滚一次，那由账本键挡住（见 {@link positionKey}）。
      useEffect(() => {
        const key = positionKey(book.bookId, chapterIndex)
        if (!shouldRestorePosition(restoredRef.current, key, paragraphs.length > 0)) return
        const scroller = scrollerRef.current
        if (scroller === null) return
        restoredRef.current = key
        const index = findParagraphIndex(paragraphs, initialOffset ?? 0)
        const el = paraRefs.current[index]
        // 首段不滚动：否则"回到顶部"会被当成异常状态，且首屏会白一下。
        scroller.scrollTop = el === undefined || index === 0 ? 0 : el.offsetTop
      }, [book.bookId, chapterIndex, paragraphs, initialOffset])

      // --- 进度回写 ---
      const flush = useCallback(() => {
        const offset = pendingOffset.current
        if (offset === null) return
        pendingOffset.current = null
        callApi(`/books/${book.bookId}/progress`, {
          method: 'PUT',
          body: { chapterIndex, charOffset: offset },
        }).catch(() => {
          // 进度写失败不该打断阅读：静默略过，下一次滚动会再试。
        })
        onOffsetChange?.(offset)
      }, [book.bookId, chapterIndex, onOffsetChange])

      useEffect(
        () => () => {
          if (saveTimer.current !== null) {
            clearTimeout(saveTimer.current)
            saveTimer.current = null
          }
          flush()
        },
        [flush],
      )

      const handleScroll = useCallback(() => {
        const scroller = scrollerRef.current
        if (scroller === null || paragraphs.length === 0) return

        // 视口顶部往下 12px 处落在哪一段，就算读到那一段。
        const top = scroller.scrollTop + 12
        const els = paraRefs.current
        let lo = 0
        let hi = paragraphs.length - 1
        let best = 0
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          const el = els[mid]
          if (el === undefined || el === null) break
          if (el.offsetTop <= top) {
            best = mid
            lo = mid + 1
          } else {
            hi = mid - 1
          }
        }
        pendingOffset.current = paragraphs[best]?.offset ?? 0

        if (saveTimer.current !== null) return
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null
          flush()
        }, PROGRESS_IDLE_MS)
      }, [paragraphs, flush])

      /**
       * 抓取正文里的选区，供「记笔记」用。
       *
       * 锚点取**选区起点所在段落**的 `data-off`，与进度、与章节 charOffset
       * 是同一套口径——否则笔记上记的位置会和阅读进度对不上。
       *
       * 全程防御式写法：拿不到 selection（非浏览器环境、或宿主壳的假 DOM）
       * 就当作没有选区，绝不抛错——一次误判不该把阅读界面打崩。
       */
      const handleSelect = useCallback(() => {
        const sel = typeof window !== 'undefined' && typeof window.getSelection === 'function'
          ? window.getSelection()
          : null
        if (sel === null || sel === undefined || sel.rangeCount === 0 || sel.isCollapsed === true) {
          setSelection(null)
          return
        }
        const text = String(sel.toString()).trim()
        if (text === '') {
          setSelection(null)
          return
        }

        let el = sel.anchorNode
        if (el !== null && el !== undefined && el.nodeType === 3) el = el.parentElement
        let guard = 0
        while (el !== null && el !== undefined && guard < 40) {
          if (typeof el.getAttribute === 'function' && el.getAttribute('data-off') !== null) break
          el = el.parentElement
          guard += 1
        }
        const raw = el !== null && el !== undefined && typeof el.getAttribute === 'function'
          ? el.getAttribute('data-off')
          : null
        const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
        setSelection({ text, charOffset: Number.isFinite(parsed) ? parsed : null })
      }, [])

      const ratio = paragraphs.length === 0 ? 0 : percentOf(
        { chapterIndex, charOffset: initialOffset ?? 0 },
        chapters,
      )
      const canPrev = chapterIndex > 0
      const canNext = chapterIndex < chapters.length - 1

      return h(
        'div',
        { className: 'drc-root' },
        h(TopBar, {
          title: meta?.title ?? `第 ${chapterIndex + 1} 章`,
          onBack,
          actions: [
            // ⚠️ **常驻**标记：解锁之后，读者在正文页也必须看得见 —— 否则就是"静默放开"，
            // 而那恰恰是这件事最不该有的样子。完整说明在陪读面板那一段，这里给最短的一句。
            finished === true
              ? h(
                  'span',
                  {
                    key: 'unlocked',
                    className: 'drc-badge',
                    title: '已解锁：这本书的全文对陪读 AI 可见（在陪读面板里可以一键收回）',
                  },
                  '⚠️ 已解锁全书',
                )
              : null,
            h(
              'button',
              {
                key: 'prev',
                type: 'button',
                className: 'drc-btn',
                disabled: !canPrev,
                onClick: () => onNavigate(chapterIndex - 1),
              },
              '上一章',
            ),
            h(
              'button',
              {
                key: 'next',
                type: 'button',
                className: 'drc-btn',
                disabled: !canNext,
                onClick: () => onNavigate(chapterIndex + 1),
              },
              '下一章',
            ),
            h(
              'button',
              {
                key: 'companion',
                type: 'button',
                className: 'drc-btn',
                onClick: onOpenCompanion,
                title: '陪读设置：绑定、背景认识、书友设定、防剧透、导出',
              },
              // 同 TocView 那颗：它进的是设置那一页，名字要一致。
              '设置',
            ),
            h(
              'button',
              {
                key: 'notes',
                type: 'button',
                className: 'drc-btn',
                onClick: onOpenNotes,
                title: '读书笔记',
              },
              '笔记',
            ),
            h(
              'button',
              {
                key: 'font',
                type: 'button',
                className: showFontBar ? 'drc-btn drc-btn-primary' : 'drc-btn',
                onClick: () => setShowFontBar((prev) => !prev),
                title: '正文显示设置',
              },
              'Aa',
            ),
          ],
        }),
        h('div', { className: 'drc-progress', style: { width: `${ratio}%` } }),
        // 字体设置条：挂在正文容器之外，滚动时不会被带走。
        showFontBar
          ? h(
              'div',
              { className: 'drc-fontbar' },
              h('button', {
                type: 'button',
                className: 'drc-btn',
                title: '缩小字号',
                onClick: () => updateFont({ size: fontPrefs.size - 1 }),
              }, 'A−'),
              h('span', { className: 'drc-fontval' }, `${fontPrefs.size}px`),
              h('button', {
                type: 'button',
                className: 'drc-btn',
                title: '放大字号',
                onClick: () => updateFont({ size: fontPrefs.size + 1 }),
              }, 'A+'),
              h('span', { className: 'drc-fontsep' }, '·'),
              h('button', {
                type: 'button',
                className: 'drc-btn',
                title: '行距变紧',
                onClick: () => updateFont({ lineHeight: fontPrefs.lineHeight - 0.1 }),
              }, '行−'),
              h('span', { className: 'drc-fontval' }, fontPrefs.lineHeight.toFixed(1)),
              h('button', {
                type: 'button',
                className: 'drc-btn',
                title: '行距变松',
                onClick: () => updateFont({ lineHeight: fontPrefs.lineHeight + 0.1 }),
              }, '行+'),
              h('span', { className: 'drc-fontsep' }, '·'),
              ...FONT_FAMILIES.map((entry) => h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  className: fontPrefs.family === entry.id ? 'drc-chip drc-chip-on' : 'drc-chip',
                  onClick: () => updateFont({ family: entry.id }),
                },
                entry.label,
              )),
              h('span', { className: 'drc-fontsep' }, '·'),
              // 纸感：0 = 完全不掺（默认），与宿主逐像素一致。「纸−」回到 0 就等于关掉。
              h('button', {
                type: 'button',
                className: 'drc-btn',
                title: '纸张感更淡',
                onClick: () => updateFont({ paper: fontPrefs.paper - PAPER_STEP }),
              }, '纸−'),
              h('span', { className: 'drc-fontval' }, `${fontPrefs.paper}%`),
              h('button', {
                type: 'button',
                className: 'drc-btn',
                title: '纸张感更浓',
                onClick: () => updateFont({ paper: fontPrefs.paper + PAPER_STEP }),
              }, '纸+'),
            )
          : null,
        // 选中正文后浮出的操作条。放在正文容器之外，滚动时不会被带走。
        selection === null
          ? null
          : h(
              'div',
              { className: 'drc-selected' },
              h('span', null, `已选 ${selection.text.length} 字`),
              h(
                'span',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'drc-btn drc-btn-primary',
                    onClick: () => {
                      onCaptureNote?.({ excerpt: selection.text, charOffset: selection.charOffset })
                      setSelection(null)
                    },
                  },
                  '记笔记',
                ),
                ' ',
                h('button', { type: 'button', className: 'drc-btn', onClick: () => setSelection(null) }, '取消'),
              ),
            ),
        h(
          'div',
          { className: 'drc-body drc-body-reader', ref: scrollerRef, onScroll: handleScroll, style: paperStyleOf(fontPrefs) },
          loading
            ? h('div', { className: 'drc-note' }, '正在读取正文…')
            : error !== null
              ? h('div', { className: 'drc-error' }, `读取正文失败：${error}`)
              : h(
                  'article',
                  { className: 'drc-article', style: fontStyleOf(fontPrefs), onMouseUp: handleSelect },
                  meta?.volume === null || meta?.volume === undefined
                    ? null
                    : h('div', { className: 'drc-volume' }, meta.volume),
                  h('h2', null, meta?.title ?? ''),
                // 「本章你记过 N 条」——只读角标，点开**每条一行**：一行摘要 + tag +
                // 「跳到这一段」（没有偏移的显示「整章」，点了跳章首）。
                //
                // 刻意**不**在这里铺开全文：读者的笔记实测 522–1183 字/条（平均
                // ~805），铺进正文流会把小说顶下去、丢掉阅读位置。正文页的价值是
                // "回到打动我的那一段原文"，不是"在正文里读我的笔记" —— 长文回
                // 笔记页读（那里有「展开全文」）。
                //
                // 一行摘要反而是**必须**的：只显示"第 k 条"的话，读者没法在点之前
                // 判断哪一条是自己要的那段。
                chapterNotes.length === 0
                  ? null
                  : h(
                      'div',
                      { className: 'drc-chapter-notes' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'drc-btn drc-btn-small',
                          onClick: () => setShowChapterNotes((prev) => !prev),
                        },
                        showChapterNotes
                          ? `收起本章的 ${chapterNotes.length} 条笔记`
                          : `本章你记过 ${chapterNotes.length} 条`,
                      ),
                      showChapterNotes
                        ? h(
                            'ul',
                            { className: 'drc-list' },
                            ...chapterNotes.map((note) =>
                              h(
                                'li',
                                {
                                  key: note.id,
                                  className: 'drc-item',
                                  style: { cursor: 'pointer' },
                                  onClick: () => jumpToNote(note),
                                  title:
                                    Number.isInteger(note.charOffset) && note.charOffset > 0
                                      ? '跳到这一段'
                                      : '跳到本章开头',
                                },
                                h('div', { className: 'drc-item-main' }, h('div', {}, noteSummary(note))),
                                Array.isArray(note.tags) && note.tags.length > 0
                                  ? h(
                                      'span',
                                      { className: 'drc-item-sub' },
                                      note.tags.map((tag) => `#${tag}`).join(' '),
                                    )
                                  : null,
                                h(
                                  'span',
                                  { className: 'drc-item-num' },
                                  Number.isInteger(note.charOffset) && note.charOffset > 0 ? '跳到这一段' : '整章',
                                ),
                              ),
                            ),
                          )
                        : null,
                    ),
                  paragraphs.length === 0
                    ? h('div', { className: 'drc-note' }, '这一章没有正文。')
                    : paragraphs.map((paragraph, index) =>
                        h(
                          'p',
                          {
                            key: paragraph.offset,
                            'data-off': paragraph.offset,
                            ref: (el) => {
                              paraRefs.current[index] = el
                            },
                          },
                          paragraph.text,
                        ),
                      ),
                ),
        ),
      )
    }
    //#endregion

    //#region 面板

    /**
     * 「只认最新一次请求」的守卫 —— 竞态的解药。
     *
     * ## 它解决什么
     *
     * 陪读页有四个加载器（绑定、背景认识、书友设定、讨论历史），每个都是
     * 「发请求 → 回来 setState」，而且**互不等待**。所以快速切书时会这样：
     * 书 A 的响应比书 B 的**晚**回来，于是 B 的界面上显示着 A 的数据。
     *
     * 书友设定那一路最危险，因为它**会回填编辑框**：A 的人设被灌进 B 的编辑框，
     * 你再点一次「保存」，就把 A 的人设写到 B 上了。这不是显示错乱，是写错书。
     *
     * ## 为什么用「票号」而不是 `AbortController`
     *
     * 两者都能解决。选票号的理由是它**是纯的**：没有 fetch、没有 signal、
     * 没有平台差异，可以直接单测。而 `AbortController` 的失败模式（abort 之后
     * 那个 rejection 到底该不该吞）在组件测试的 react 替身里根本验不到。
     *
     * `issue()` 让票号自增，于是**最新那次**永远是唯一有效的；任何更早发出的
     * 请求回来时都会发现自己已经过期。
     *
     * @returns {{ issue: () => number, isCurrent: (ticket: number) => boolean }}
     */
    function createLatestGuard() {
      let latest = 0
      return {
        issue() {
          latest += 1
          return latest
        },
        isCurrent(ticket) {
          return ticket === latest
        },
      }
    }

    /**
     * 把 {@link createLatestGuard} 挂到组件实例上。
     *
     * 懒初始化，而不是 `useRef(createLatestGuard())`——后者每次渲染都会白造一个
     * 守卫对象然后丢掉。这是 React 文档给出的 ref 懒初始化写法。
     *
     * ⚠️ **每个资源各用一个守卫**。共用会把互不相关的两个加载器互相作废：
     * 比如「重新生成预览」触发背景认识重载时，会顺手把还在飞的讨论历史判成过期。
     *
     * @returns {{ issue: () => number, isCurrent: (ticket: number) => boolean }}
     */
    function useLatestGuard() {
      const ref = useRef(null)
      if (ref.current === null) ref.current = createLatestGuard()
      return ref.current
    }

    /**
     * 一条笔记的三段正文：原文摘抄 / 我的感想 / AI 回应。
     *
     * 抽成组件是为了**能按需折叠**：长笔记实测 522–1183 字/条（平均 ~805），
     * 十条一页就是八千多字，"一眼扫不完"会让回看列表本身失去意义。
     * 折叠阈值与截断都在 `clampNoteText` 里（纯函数，有专测）。
     *
     * 只有**真的被截断**时才显示按钮：短笔记不该长出一个多余按钮。
     *
     * @param {{ note: object, expanded: boolean, onToggle: Function }} props
     */
    function NoteBody(props) {
      const { note, expanded, onToggle } = props
      const excerpt = clampNoteText(note?.excerpt)
      const thought = clampNoteText(note?.thought)
      const reply = clampNoteText(note?.reply)
      const clamped = excerpt.clamped || thought.clamped || reply.clamped
      return h(
        'div',
        null,
        note?.excerpt
          ? h('blockquote', { className: 'drc-quote' }, expanded ? note.excerpt : excerpt.text)
          : null,
        note?.thought
          ? h(
              'div',
              { className: 'drc-thought' },
              h('span', { className: 'drc-inline-label' }, '我的感想'),
              expanded ? note.thought : thought.text,
            )
          : null,
        note?.reply
          ? h(
              'div',
              { className: 'drc-reply' },
              h('span', { className: 'drc-inline-label' }, 'AI 回应'),
              expanded ? note.reply : reply.text,
            )
          : null,
        clamped
          ? h(
              'button',
              {
                type: 'button',
                className: 'drc-btn drc-btn-small',
                onClick: () => onToggle(note.id),
              },
              expanded ? '收起' : '展开全文',
            )
          : null,
      )
    }

    /**
     * 已落盘笔记的列表（分页，新的在前）。
     *
     * ## 为什么它是一个独立的 `memo` 组件
     *
     * 在这之前，列表是**内联**在 {@link NotesView} 的返回值里的，而
     * `thought` / `excerpt` / `reply` / `tagsText` 都是 `NotesView` 的 state。
     * 于是**每敲一个字**，整张列表都要重新协调一遍——而列表不是只显示标题，
     * 它把每条笔记的摘抄、感想、回应全文都渲染出来。1000 条笔记约等于
     * 7000+ 个元素参与每一次按键的 diff，打字会随笔记数线性变卡。
     *
     * 抽出来之后，列表只在下面这几个 prop 真的变化时才重渲染。
     *
     * ⚠️ 两个能把优化悄悄废掉的地方，都钉在这里：
     *
     *   1. **必须有 `memo`**。父组件重渲染时子组件照样会重渲染，"抽出去"
     *      本身没有任何作用——`test/client.test.mjs` 专门盯着这一点。
     *   2. **传进来的 props 必须是稳定引用**。所以：
     *      - `notes` 由宿主侧排好"新的在前"（见 `host/notes.js` 的
     *        {@link paginateNotes}），客户端**不做** `slice().reverse()`；
     *        顺手 reverse 一下就会每次渲染产生新数组，memo 永远不命中。
     *      - `onPrev` / `onNext` 必须由 `useCallback` 包过，同理。
     *
     * @param {{ notes: object[], total: number, loading: boolean,
     *           page: number, pageCount: number, hasPrev: boolean, hasNext: boolean,
     *           onPrev: Function, onNext: Function,
     *           onJumpToChapter?: Function }} props
     */
    const NoteList = memo(function NoteList(props) {
      const { notes, total, loading, page, pageCount, hasPrev, hasNext, onPrev, onNext, onJumpToChapter, mode, onTrash, onRestore, onPurge } = props
      /**
       * 已展开全文的那些笔记 id。
       *
       * 长笔记实测 522–1183 字/条（平均 ~805），十条一页就是八千多字 ——
       * **一眼扫不完，回看列表这件事本身就失去意义**。所以默认折叠成预览，
       * 由读者决定展开哪一条。
       */
      // ⚠️ 用**数组**而不是 `useState(() => new Set())`：测试替身不调用初始化
      // 函数，会把那个函数本身当成 state（`openIds.has` 直接报错）。数组在这里
      // 完全够用（一页最多十条），也少一个类型假设。
      const [openIds, setOpenIds] = useState([])
      const toggleOpen = (id) => {
        setOpenIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
      }

      const body = loading
        ? h('div', { className: 'drc-note' }, '读取中…')
        : notes.length === 0
          ? h('div', { className: 'drc-note' }, '还没有笔记。选中正文里的一段，点「记笔记」开始。')
          : h(
              'div',
              null,
              ...notes.map((note) => h(
                'div',
                { key: note.id || note.createdAt, className: 'drc-note-item' },
                h(
                  'div',
                  { className: 'drc-note-head' },
                  h('span', { className: 'drc-item-name' }, note.heading || '读书笔记'),
                  note.hasReply ? h('span', { className: 'drc-badge' }, '含 AI 回应') : null,
                  // ⚠️ **没有章号、也没有摘抄**的笔记 = 对整本书的感想（合法，但必须标明）。
                  // 不标的话，它在列表里与"针对某一段"的笔记长得一样 —— 读者分不清它
                  // 指的是哪儿；而"没选原文直接写"正是他担心会变成"散乱记录"的那一类
                  // （tag 能说明是随手写的，但列表里得先看得见）。
                  Number.isInteger(note.chapterIndex) !== true && (note.excerpt ?? '') === ''
                    ? h(
                        'span',
                        {
                          className: 'drc-badge',
                          title: '这条笔记没有对应原文的某一段（对整本书的感想）',
                        },
                        '未选定原文',
                      )
                    : null,
                ),
                note.tags.length === 0
                  ? null
                  : h('div', { className: 'drc-item-sub' }, note.tags.map((tag) => `#${tag}`).join(' ')),
                // 三段正文必须**显示出来**：只列标题的话，用户记完就再也
                // 看不见自己写了什么，笔记等于白记。
                //
                // 但长文默认**折叠成预览**、由读者点「展开全文」（见 `NoteBody`）：
                // 正文页那边只给一行摘要，全文在这里读 —— 两个界面的分工就是
                // "正文页负责回到原文，笔记页负责读自己的字"。
                h(NoteBody, {
                  note,
                  expanded: openIds.includes(note.id),
                  onToggle: toggleOpen,
                }),
                // 每条笔记的操作行。**两种模式复用同一个列表组件**（v1.57）：
                //   · 笔记页：`回到第 N 章` + **删除本条**（进回收站，一键、不确认 —— 可逆 ✓）；
                //   · 回收站页：`恢复`（一键 ✓）+ **确认删除**（不可逆 → 走确认条 ✓）。
                // 删除按钮对**每条**都有（包括没选原文的那类），所以这里不再包在
                // "有章号才显示"的条件里。
                h(
                  'div',
                  { className: 'drc-row', style: { marginTop: 4 } },
                  ...(mode === 'trash'
                    ? [
                        h(
                          'button',
                          { key: 'restore', type: 'button', className: 'drc-btn', onClick: () => onRestore?.(note) },
                          '恢复',
                        ),
                        h(
                          'button',
                          { key: 'purge', type: 'button', className: 'drc-btn', onClick: () => onPurge?.(note) },
                          '确认删除',
                        ),
                      ]
                    : [
                        Number.isInteger(note.chapterIndex) && typeof onJumpToChapter === 'function'
                          ? h(
                              'button',
                              {
                                key: 'jump',
                                type: 'button',
                                className: 'drc-btn',
                                onClick: () => onJumpToChapter(note.chapterIndex, note.charOffset),
                              },
                              `回到第 ${note.chapterIndex + 1} 章`,
                            )
                          : null,
                        h(
                          'button',
                          { key: 'trash', type: 'button', className: 'drc-btn', onClick: () => onTrash?.(note) },
                          '删除本条',
                        ),
                      ]),
                ),
              )),
            )

      return h(
        'div',
        { className: 'drc-section' },
        // ⚠️ 这里从前有一行「已落盘的笔记（N）」。去掉了（读者反馈）：**选项卡本身就是
        // 这一块的标题**，计数也写在 tab 上 —— 再挂一行说明是重复。
        body,
        // 翻页：**替换**而不是追加 —— 一次只渲染一页，列表就不会越读越长。
        // 游标由 `NotesView` 的栈管着，所以"← 更新"是真的能回去的。
        //
        // ⚠️ `mode === 'trash'` 时**不渲染这一行**（v1.62）：回收站是一次取一批、
        // 根本没有分页（`NotesView` 传进来的永远是 `page: 0 / pageCount: 1`），
        // 所以这行只会出现两颗禁用按钮 + 一句「每页 10 条」—— 而回收站实际一次取
        // 200 条，那句话本身就是错的（数字说谎比没有更糟）。
        mode === 'trash'
          ? null
          : h(
              'div',
              { className: 'drc-row', style: { marginTop: 6 } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn',
                  disabled: loading || !hasPrev,
                  onClick: onPrev,
                  title: '更新的一页',
                },
                '← 更新',
              ),
              h(
                'span',
                { className: 'drc-inline-label' },
                `第 ${page + 1} / ${pageCount} 页（每页 ${NOTES_PAGE_SIZE} 条）`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn',
                  disabled: loading || !hasNext,
                  onClick: onNext,
                  title: '更旧的一页',
                },
                '更旧 →',
              ),
            ),
      )
    })

    /**
     * 笔记视图。
     *
     * 三段式「原文摘抄 — 我的感想 — AI 回应」的编辑与落盘。
     *
     * **AI 回应默认不落盘**在这里是可见的：回应是一个独立的输入框，
     * 框空着 → 写进 `notes.md` 的笔记里连「AI 回应」四个字都不出现；
     * 框里有内容 → 才带上那一节。
     *
     * 零复制粘贴的闭环：
     *   ① 发到会话去聊 —— 摘抄 + 感想放进会话输入框（顺带阻塞式补一次前文记忆）
     *   ② 抓取选中文字作回应 —— 在会话里拖选 AI 的回复，一键填进回应框
     *
     * @param {{ book: object, activeDraft: object|null, sessionId?: string,
     *           inputActions?: object, existingDraft?: string, onBack: Function,
     *           openSession?: Function|null, requestHandoff?: Function,
     *           onDraftChange?: Function }} props
     */
    /**
     * **笔记列表 + 分页 + 回收站**：`NotesView` 的读取侧自成一簇（甲-6 第 1 步）。
     *
     * ## 为什么抽出来
     *
     * 它原本和另外二十来个 `useState`、三个 tab 状态机、草稿编辑器挤在**同一个
     * 函数作用域**里（`NotesView` 那时 1,337 行）。这一簇自己有 9 份状态、2 个票号
     * 守卫、7 个回调 —— 而它们**只服务于一件事**："把这本书的笔记列表翻给你看"。
     *
     * ⚠️ **它不减 `client.js` 的行数**（宿主模块加载器契约要求单文件，所以 hook 就写在
     * 同一个文件里）。它买的是**作用域**：`NotesView` 从此只剩"渲染 + 接线"。
     *
     * ## 抽出来顺带消掉的那条约束
     *
     * `reloadNotesPage` 从前必须**紧挨着 `applyPage`** 定义 —— 因为 `setTrashed` /
     * `runPurge` 要用它，而 `const` 不能先用后定义（TDZ）。现在 hook 把
     * `reloadNotesPage` **返回**出去，调用方按名字取，那个"定义顺序"的约束连同它
     * 的注释一起消失了（这类"位置也是语义"的规则正是本仓库反复踩的坑）。
     *
     * ## 逃生口只有 `setLoading`
     *
     * 实测（2026-10-03）：其余 setter **全部**只在这一簇内被用到（`setNotes` /
     * `setNotesTotal` / `setPageNext` / `setNotesHasMore` / `setCursors` /
     * `setTrash*` 各 2–7 处，逐处都在本文件下面那几个回调里）。唯一的例外是
     * `setLoading` —— 落点加载器 `refresh()` 也要用它（`Promise.all` 的最后一段），
     * 所以它被**返回**出去。**新增第二个逃生口之前先问一句**：那个 setter 是不是
     * 该连它的逻辑一起搬进来。
     *
     * @param {{ book: object, setNotice: Function }} deps
     * @returns {object} 9 份状态 + 7 个回调 + 一个逃生口
     */
    function useNotesCollection(deps) {
      const { book, setNotice } = deps
      const bookId = book.bookId

      const [notes, setNotes] = useState([])
      /** 笔记**总数**（不是本页条数）——分页后标签仍要显示总数。 */
      const [notesTotal, setNotesTotal] = useState(0)
      /**
       * 翻页用的**游标栈**：`cursors[i]` 是第 i 页的 `before`（第 0 页 = null = 最新一页）。
       *
       * ⚠️ 为什么是栈而不是一个游标：翻页必须能**往回**翻，而宿主的接口只提供
       * "往更旧"的单向游标（`before` = 该页之前那一条的 id）。所以走过的游标
       * 只能自己存下来 —— 下一页 push、上一页 pop，天然对。
       */
      const [cursors, setCursors] = useState([null])
      /** 下一页要用哪个游标（宿主回的 `nextCursor`）；null = 没有更旧的了。 */
      const [pageNext, setPageNext] = useState(null)
      const [notesHasMore, setNotesHasMore] = useState(false)
      const [loading, setLoading] = useState(true)
      /** 回收站里的笔记。单独取、不分页（它通常很短）。 */
      const [trashNotes, setTrashNotes] = useState([])
      /**
       * 回收站里**一共**有多少条（宿主回的 `total`）。
       *
       * ⚠️ 它与 `trashNotes.length` 不是一回事（审计 §四②）：列表只取前
       * `TRASH_PAGE_LIMIT` 条，所以计数必须用 `total` —— 否则回收站超过那个上限之后，
       * tab 上的数字会永远停在上限上（"清空"走服务端的 `all: true`，仍然会全部清掉，
       * 所以那只是个**数字说谎**的问题，没有数据风险）。
       */
      const [trashTotal, setTrashTotal] = useState(0)
      /**
       * 回收站**取不到**时的错误文案（`null` = 取到了或还没取）。
       *
       * ⚠️ 为什么不能"取不到就当空"（2026-10-02 三方评审 P2-10）：从前 catch 里把列表
       * 与计数一起归零，界面于是渲染「回收站是空的。」—— 一次**读取失败**被说成
       * "你没有删过东西"，把一份**可恢复的数据**藏起来了。而这一屏正是读者找回落
       * 掉的东西的地方，这里的假话代价最大。所以现在分开：空就是空，取不到就说取不到。
       */
      const [trashError, setTrashError] = useState(null)

      /**
       * ⚠️ 这几条加载器从前**一个票号守卫都没有**（2026-10-01 三方评审 P3）：
       * 换书、换章、连点两次删除时，先发的请求可能**后回来**，把旧数据写进已经
       * 翻篇的界面。`useLatestGuard` 在本文件里已经用了 5 处，这里就是漏掉的那一批。
       * 同一个资源共用一个守卫 —— 票号只对"同一份状态"才有意义
       * （笔记列表 / 草稿列表 / 回收站 / 落点各一份，互不干扰）。
       */
      const notesGuard = useLatestGuard()
      const trashGuard = useLatestGuard()

      /** 把一页笔记响应写进状态（**替换**：翻页语义，不是追加）。 */
      const applyPage = useCallback((data) => {
        setNotes(data.notes ?? [])
        setNotesTotal(data.total ?? 0)
        setNotesHasMore(data.hasMore === true)
        setPageNext(data.nextCursor ?? null)
      }, [])

      /**
       * 只重取**当前页**（保住翻页位置）。
       *
       * ⚠️ v1.62：删除 / 恢复 / 彻底删除**不能**用 `refreshNotes()` —— 那个函数里有
       * `setCursors([null])`，它服务的是"刚写完一条新笔记"（新笔记在最上面，本来就该回
       * 第一页 ✓）。拿它刷回收站动作，会把翻到第 5 页的读者**弹回顶部** ✗。
       *
       * 位置为什么保得住：游标（`before`）指的是"这一页之前**那一条**的 id"，删掉
       * **本页**里的一条不会动到它 ✓。若游标真的失效了（那一条被外部编辑器删了），
       * 宿主会回 `reset: true` —— 那时才归零，与 `loadPage` 同一条规矩 ✓。
       */
      const reloadNotesPage = useCallback(() => {
        const ticket = notesGuard.issue()
        const before = cursors[cursors.length - 1]
        return callApi(`/books/${bookId}/notes?limit=${NOTES_PAGE_SIZE}`
          + (before === null || before === undefined ? '' : `&before=${encodeURIComponent(before)}`))
          .then((data) => {
            if (!notesGuard.isCurrent(ticket)) return
            if (data.reset === true) setCursors([null])
            applyPage(data)
          })
          // ⚠️ **刷新失败必须有人接**（2026-10-02 三方评审 P3-2）：这条函数被
          //    进回收站 / 恢复 / 彻底删除三条路**不 await 地**调用，从前没有 catch ⇒
          //    一次失败的 GET 会变成未处理的拒绝，而界面还停在**旧列表**上、
          //    同时显示"已移入回收站"——读者看到的成功与列表不符，且没有任何提示。
          .catch((error) => {
            if (!notesGuard.isCurrent(ticket)) return
            setNotice({
              kind: 'error',
              text: `笔记列表刷新失败（${describeError(error)}）—— 下面的列表可能不是最新的，切一下页签再回来可重试。`,
            })
          })
      }, [bookId, cursors, applyPage, notesGuard, setNotice])

      /**
       * 只重取首屏笔记。
       *
       * 拆出它（而不是每次都 `refresh` 全量重取）有两个理由：
       *   1. 写入笔记之后只有笔记变了，草稿和落点都没变；
       *   2. 全量重取会把读者已经"加载更旧"翻出来的那几页**丢掉**，把他
       *      弹回列表顶部——那正是分页要避免的体验。
       */
      const refreshNotes = useCallback(() => {
        const ticket = notesGuard.issue()
        return callApi(`/books/${bookId}/notes?limit=${NOTES_PAGE_SIZE}`)
          .then((data) => {
            if (!notesGuard.isCurrent(ticket)) return
            // 回到第一页：刚写了一条新笔记、或改了落点之后，读者该看到最新那批。
            setCursors([null])
            applyPage(data)
            setLoading(false)
          })
      }, [bookId, applyPage, notesGuard])

      /**
       * 取回收站列表（`?trashed=1` 就是宿主那边的"只看回收站"口径）。
       *
       * ⚠️ 计数取宿主的 `total`，**不是** `notes.length`（审计 §四②）：这个请求带
       * `limit`，超过它的那部分不会被取回来，但 `total` 说的是回收站里**一共**多少条。
       */
      const loadTrash = useCallback(() => {
        const ticket = trashGuard.issue()
        callApi(`/books/${bookId}/notes?trashed=1&limit=${TRASH_PAGE_LIMIT}`)
          .then((data) => {
            if (!trashGuard.isCurrent(ticket)) return
            setTrashNotes(Array.isArray(data?.notes) ? data.notes : [])
            setTrashTotal(Number.isInteger(data?.total) ? data.total : 0)
            setTrashError(null)
          })
          .catch((error) => {
            if (!trashGuard.isCurrent(ticket)) return
            // ⚠️ **取不到 ≠ 空的**（2026-10-02 三方评审 P2-10）：列表与计数照旧归零
            //    （免得留一个"有 N 条"却列不出来的幻影），但要记下错误 —— 界面据此
            //    渲染"读取失败 + 重试"，而不是那句"回收站是空的。"
            setTrashNotes([])
            setTrashTotal(0)
            setTrashError(describeError(error))
          })
      }, [bookId, trashGuard])

      /**
       * 取某一页（**替换**列表，不是追加）。
       *
       * `stack` 就是"走到这一页为止用过的 `before` 序列"，最后一项是这一页的游标。
       * 宿主那边的游标语义（`before` = 这一页之前那一条的 id）**一点没改** ——
       * 翻页要的"往回"，是客户端把走过的游标存下来实现的（见 `cursors` 的说明）。
       */
      const loadPage = useCallback((stack) => {
        const ticket = notesGuard.issue()
        const before = stack[stack.length - 1]
        setLoading(true)
        callApi(`/books/${bookId}/notes?limit=${NOTES_PAGE_SIZE}`
          + (before === null ? '' : `&before=${encodeURIComponent(before)}`))
          .then((data) => {
            if (!notesGuard.isCurrent(ticket)) return
            // 游标失效（笔记被外部编辑器删改过）：宿主会把**第一页**重新给我们并置
            // `reset: true`。翻页时这意味着**页号也要归零** —— 不然界面会写着"第 3 页"
            // 而内容其实是第一页。
            if (data.reset === true) setCursors([null])
            applyPage(data)
            setLoading(false)
          })
          .catch((error) => {
            if (!notesGuard.isCurrent(ticket)) return
            setNotice({ kind: 'error', text: describeError(error) })
            setLoading(false)
          })
      }, [bookId, applyPage, notesGuard, setNotice])

      /** 更旧的一页：宿主给的 `nextCursor` 压进栈。 */
      const goNextPage = useCallback(() => {
        if (loading || pageNext === null) return
        const next = [...cursors, pageNext]
        setCursors(next)
        loadPage(next)
      }, [cursors, pageNext, loading, loadPage])

      /** 更新的一页：把本页的游标弹掉。 */
      const goPrevPage = useCallback(() => {
        if (loading || cursors.length <= 1) return
        const next = cursors.slice(0, -1)
        setCursors(next)
        loadPage(next)
      }, [cursors, loading, loadPage])

      return {
        notes,
        notesTotal,
        cursors,
        pageNext,
        notesHasMore,
        loading,
        // ⚠️ 唯一的逃生口（落点加载器 `refresh()` 也要用它）—— 见上面的说明。
        setLoading,
        trashNotes,
        trashTotal,
        trashError,
        applyPage,
        reloadNotesPage,
        refreshNotes,
        loadTrash,
        loadPage,
        goNextPage,
        goPrevPage,
      }
    }

    /**
     * **草稿编辑器**：编辑区四个输入框 + 草稿列表 + 保存 / 落盘 / 提交 / 丢弃（甲-6 第 2 步）。
     *
     * ## 为什么抽出来
     *
     * 它原本和二十来个 `useState`、分页游标栈、回收站、tab 状态机挤在 `NotesView`
     * 那一个函数作用域里。这一簇自己有 6 份状态、1 个票号守卫、9 个回调（含
     * `commit` 57 行、`grabSelection` 36 行、`save` 29 行、`persist` 27 行）。
     *
     * ⚠️ **它不减 `client.js` 的行数**（宿主模块加载器契约要求单文件）。它买的是
     * **作用域** —— 和 `useNotesCollection` 同一类收益。
     *
     * ## 逃生口只有两个
     *
     * 实测（2026-10-03）：`setDrafts` / `setActive` / `setSuggested` / `setAutosaveFailed`
     * 与 `draftsGuard` **完全自封**；四个输入框的 setter 只在 `applyActive` /
     * `addTag` / `grabSelection` 里被写 —— 而 `grabSelection`（抓选中文字填进编辑框）
     * **本身就是编辑区逻辑**，所以它一起搬进来了。剩下两个逃生口是
     * `setDiscardTarget` / `setSwitchTarget`：JSX 里那两条二次确认的「取消」要清掉它们。
     *
     * ⚠️ `refreshNotes` 由外面传进来（来自 `useNotesCollection`）—— `commit` 写完笔记
     * 要重取首屏。**两个 hook 的依赖方向是单向的**：草稿编辑器知道笔记列表，反过来不知道。
     *
     * @param {{ book: object, activeDraft: object|null, onDraftChange: Function,
     *           setNotice: Function, setBusy: Function, refreshNotes: Function }} deps
     * @returns {object} 6 份状态 + 1 个派生值 + 9 个回调 + 2 个逃生口
     */
    function useDraftEditor(deps) {
      const { book, activeDraft, onDraftChange, setNotice, setBusy, refreshNotes } = deps
      const bookId = book.bookId

      const [drafts, setDrafts] = useState([])
      const [active, setActive] = useState(activeDraft ?? null)
      const [suggested, setSuggested] = useState([])
      /**
       * 正等二次确认要丢弃的那条草稿（`null` = 没在等）。
       *
       * ⚠️ v1.61 起它装的是**哪一条**，不再只是一个布尔（审计 §四③）：列表里
       * 每条草稿都有「丢弃草稿」，所以确认条必须知道自己在确认哪一条 —— 从前
       * 只有"正在编辑"那条能丢，正是因为 `discard()` 只认 `active`。
       */
      const [discardTarget, setDiscardTarget] = useState(null)
      /**
       * 正等二次确认要**载入**的那条草稿（「接着写」用；`null` = 没在等）。
       *
       * 只有编辑区里有没落盘的改动（见 `dirty`）时才会用到它：`applyActive` 是无条件
       * 替换四个输入框的，从前的「接着写」会**静默丢掉**读者刚写的字（v1.62 修）。
       */
      const [switchTarget, setSwitchTarget] = useState(null)
      /**
       * 「上一次自动保存没成功」（2026-10-02 三方评审 P3-3）。
       *
       * ⚠️ 它是**常驻标记**，不是 toast：失败这件事在读者重试成功之前一直成立，
       * 而 toast 会消失（读者切个页签回来就再也看不到它了）。
       */
      const [autosaveFailed, setAutosaveFailed] = useState(false)

      // 三个编辑框的本地状态。tags 用空格分隔的字符串，保存时再归一化——
      // 让用户用最自然的方式输入，而不是要求他记住分隔符规则。
      const [excerpt, setExcerpt] = useState(activeDraft?.excerpt ?? '')
      const [thought, setThought] = useState(activeDraft?.thought ?? '')
      const [reply, setReply] = useState(activeDraft?.reply ?? '')
      const [tagsText, setTagsText] = useState((activeDraft?.tags ?? []).join(' '))

      const applyActive = useCallback((draft) => {
        // ⚠️ **必须归一成 `null`，不能把 `undefined` 放进来**（2026-10-03 修的白屏）。
        //    它是 `active` 唯一的写入点（另一个是上面的 `useState` 初值），而下游有**五处**
        //    守卫写成 `active === null ? … : active.xxx`：`undefined` 会走 **else 分支**
        //    去读 `undefined.excerpt` / `.chapterIndex` ⇒ 组件抛错 = **白屏**。
        //    实测触发形状：保存草稿的响应里没有 `draft` 字段（旧宿主 / 出错分支 / 字段改名）
        //    ⇒ "保存成功了反而白屏"，最难查的那种。
        //    ⚠️ 归一化放在**这里**而不是两个调用点：`data.draft ?? null` 写两遍，
        //    将来加第三个调用点就会漏 —— 不变量要写在唯一的入口上。
        setActive(draft ?? null)
        setExcerpt(draft?.excerpt ?? '')
        setThought(draft?.thought ?? '')
        setReply(draft?.reply ?? '')
        setTagsText((draft?.tags ?? []).join(' '))
      }, [])

      /**
       * 把编辑内容一路回报给面板（`ReaderPanel` 存进模块级会话记忆）。
       *
       * 为什么需要它：起稿同步化之后，**未保存的内容在服务端没有任何记录**
       * （见 `captureNote`），而本组件会被"切页签、切会话"卸载。报了之后，
       * "没保存"不再等于"切一下就没"。
       *
       * ⚠️ 上报的是一份**新对象**，面板存下来只会被当作 `NotesView` 的初值读一次，
       * 所以这条线不会反过来影响本组件的渲染。真正要防的是**循环**：面板那个
       * `onDraftChange` 必须是稳定引用（见 `ReaderPanel.handleDraftChange`）。
       */
      useEffect(() => {
        if (typeof onDraftChange !== 'function') return
        onDraftChange({
          // 没有就是 `null`（未保存的起稿），有就是服务端那一条 —— 下游全靠这个
          // 字段分派，所以类型要稳。
          draftId: typeof active?.draftId === 'string' ? active.draftId : null,
          bookId,
          chapterIndex: Number.isInteger(active?.chapterIndex) ? active.chapterIndex : null,
          chapterTitle: typeof active?.chapterTitle === 'string' ? active.chapterTitle : '',
          charOffset: Number.isFinite(active?.charOffset) ? active.charOffset : null,
          excerpt,
          thought,
          reply: reply.trim() === '' ? null : reply,
          tags: tagsText.split(/[\s,，]+/).filter((tag) => tag !== ''),
        })
      }, [onDraftChange, active, bookId, excerpt, thought, reply, tagsText])

      /**
       * ⚠️ 票号只对"同一份状态"才有意义 —— 每个按书加载的资源**各用一个守卫**。
       * 共用会把互不相关的两个加载器互相作废。
       */
      const draftsGuard = useLatestGuard()

      /** 只重取草稿列表。保存草稿只影响草稿，不该顺带动笔记列表。 */
      const refreshDrafts = useCallback(() => {
        const ticket = draftsGuard.issue()
        return callApi(`/books/${bookId}/drafts`)
          .then((data) => {
            if (!draftsGuard.isCurrent(ticket)) return
            setDrafts(data.drafts ?? [])
          })
      }, [bookId, draftsGuard])

      /**
       * 把当前编辑框内容存回去（**新建或更新**）。
       *
       * 新建与更新共用同一条路：`draftId` 有就更新、没有就让宿主新建一条。这就是
       * "未保存的起稿"变成草稿栏里一条记录的**唯一**入口 —— `captureNote` 不再建，
       * 所以草稿栏里出现的东西恰好等于读者亲手存过的东西。
       */
      const save = useCallback(() => {
        setBusy(true)
        setNotice(null)
        return callApi(`/books/${bookId}/drafts`, {
          method: 'POST',
          body: {
            draftId: active?.draftId,
            // ⚠️ 章节必须一起送。从前章号是由"在正文里起稿"那一次 POST 带上去的；
            // 现在第一次 POST 发生在这里，不带就等于把草稿挂到一个**没有出处**
            // 的位置上（宿主对缺失的 `chapterIndex` 回落成 `null`）。
            chapterIndex: Number.isInteger(active?.chapterIndex) ? active.chapterIndex : null,
            chapterTitle: typeof active?.chapterTitle === 'string' ? active.chapterTitle : '',
            charOffset: Number.isFinite(active?.charOffset) ? active.charOffset : null,
            excerpt,
            thought,
            reply: reply.trim() === '' ? null : reply,
            tags: tagsText.split(/[\s,，]+/).filter((tag) => tag !== ''),
          },
        })
          .then((data) => {
            applyActive(data.draft)
            setSuggested(data.suggestedTags ?? [])
            // 只重取草稿：这条路径不碰笔记，重取笔记只会把读者的分页位置弹回顶部。
            return refreshDrafts()
          })
          .then(() => setNotice({ kind: 'ok', text: '草稿已保存。' }))
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setBusy(false))
      }, [bookId, active, excerpt, thought, reply, tagsText, applyActive, refreshDrafts, setBusy, setNotice])

      /**
       * 把当前编辑框的内容存回服务端草稿。
       *
       * 为什么必须要有它：早期版本里，**回应框的内容只活在组件 state**。
       * 切页签、切会话或刷新页面都会让面板重挂，`activeDraft` 变回 null，
       * 你打的字就没了——读者明明填了回应，回头打开 md 却没有，这是问题 1
       * 的成因之一（另一个成因是两个写入按钮，见 `commit`）。
       *
       * @param {object} [override] 用这些值代替当前 state（抓取回应时用）
       * @returns {Promise<object|null>}
       */
      const persist = useCallback((override) => {
        const draftId = active?.draftId
        // ⚠️ 没有 `draftId` 就**什么都不做**，而不是"顺手建一条"。
        //
        // 从前起稿会先 POST 一条，所以这里总有个 id。现在"未保存的起稿"没有 id，
        // 如果这里替读者建记录，就等于**绕过「保存草稿」**把东西塞进草稿栏 ——
        // 而那正是这一版要修掉的行为。保存是读者的动作，不是我们自动补的。
        // 代价：还没保存过的内容不落盘（切页签/切会话由 `onDraftChange` 那条线
        // 兜住，见 `ReaderPanel`；整页刷新会丢，那种情况下读者本来也回了书架）。
        if (draftId === undefined || draftId === null) return Promise.resolve(null)
        const nextReply = override?.reply ?? reply
        return callApi(`/books/${bookId}/drafts`, {
          method: 'POST',
          body: {
            draftId,
            excerpt: override?.excerpt ?? excerpt,
            thought: override?.thought ?? thought,
            reply: nextReply.trim() === '' ? null : nextReply,
            tags: (override?.tags ?? tagsText).split(/[\s,，]+/).filter((tag) => tag !== ''),
          },
        }).then((data) => {
          applyActive(data.draft)
          // 存成功了就把"上次自动保存失败"的提示撤掉（见下面的自动保存 effect）。
          setAutosaveFailed(false)
          return data
        })
      }, [bookId, active, excerpt, thought, reply, tagsText, applyActive])

      // 回应框改动后自动存一次（防抖）。刻意只依赖 `reply`：
      // 把 persist 也放进依赖会因为它随 reply 变化而反复触发。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => {
        if (active === null) return undefined
        const timer = setTimeout(() => {
          persist().catch(() => {
            // ⚠️ **失败要留痕，不能只是"不打扰"**（2026-10-02 三方评审 P3-3）：从前这里
            //    是空的 catch —— 一条静默失败的自动保存，配上"切页签/刷新会回到服务端
            //    那一份"的既有语义，结果是读者以为回应存住了，实际磁盘上还是旧的。
            //    现在置一个**常驻标记**（不是 toast：toast 会消失，而这件事在读者
            //    解决它之前一直成立）。
            setAutosaveFailed(true)
          })
        }, 800)
        return () => clearTimeout(timer)
      }, [reply])

      /**
       * 把草稿变成正式笔记。
       *
       * **只有一个按钮**，写什么完全由框里有什么决定——回应框非空就带上，
       * 空就不带。
       *
       * 早期版本有两个按钮（「写入笔记」/「写入并附上回应」），结果是：读者
       * 刚填完回应、顺手点了左边那个，回应就**按设计被丢弃**，而且草稿随即
       * 删除、磁盘上不留痕迹。一个刚填完的字段被相邻按钮静默丢掉，这种设计
       * 不该存在。现在"要不要带回应"由**输入框是否为空**表达，不再由按钮表达。
       */
      const commit = useCallback(() => {
        // ⚠️ 判据是**框里有没有东西**，不再是"有没有正在编辑的草稿"。
        //
        // 起稿同步化之后，"没有草稿"成了一个常见且合法的状态（刚进笔记页、什么都
        // 没写），而旧判据 `active === null` 会把"手动粘了一段摘抄、还没保存"也一起
        // 挡掉。反过来，如果这里不判内容，一次空提交会往 `notes.md` 里追加一条
        // **空笔记** —— 那是真正不可接受的失效方向。
        if (excerpt.trim() === '' && thought.trim() === '') {
          setNotice({ kind: 'error', text: '先写点摘抄或感想再写入笔记。' })
          return
        }
        const attachReply = reply.trim() !== ''
        setBusy(true)
        setNotice(null)
        // 先保存编辑框里的最新内容，再提交——否则用户改完直接点写入会丢掉改动。
        //
        // ⚠️ 提交用的 id 必须取自**这一次 POST 的响应**，不能取自 `active.draftId`：
        // 未保存的起稿没有 id，那条 POST 就是"新建"，id 只有响应里才有。写成
        // `active.draftId` 的话，新起稿点「写入笔记」会去提交一个 `undefined`。
        callApi(`/books/${bookId}/drafts`, {
          method: 'POST',
          body: {
            draftId: active?.draftId,
            chapterIndex: Number.isInteger(active?.chapterIndex) ? active.chapterIndex : null,
            chapterTitle: typeof active?.chapterTitle === 'string' ? active.chapterTitle : '',
            charOffset: Number.isFinite(active?.charOffset) ? active.charOffset : null,
            excerpt,
            thought,
            reply: reply.trim() === '' ? null : reply,
            tags: tagsText.split(/[\s,，]+/).filter((tag) => tag !== ''),
          },
        })
          .then((data) => {
            const draftId = data?.draft?.draftId
            // 宿主没回 id 就**不要**往下走：拿 `undefined` 去提交会在服务端变成
            // "草稿不存在"，而界面上看起来只是写入失败了。
            if (typeof draftId !== 'string') throw new Error('服务端没有返回草稿 id')
            return callApi(`/books/${bookId}/drafts/${draftId}/commit`, {
              method: 'POST',
              body: { attachReply },
            })
          })
          .then(() => {
            applyActive(null)
            setSuggested([])
            setNotice({
              kind: 'ok',
              text: attachReply
                ? '已写入笔记（摘抄 + 感想 + AI 回应）。'
                : '已写入笔记（摘抄 + 感想）。回应框是空的，所以没带回应。',
            })
            // 新笔记插在列表最前面，所以要重取首屏；草稿也少了一条。
            return Promise.all([refreshNotes(), refreshDrafts()])
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setBusy(false))
      }, [bookId, active, excerpt, thought, reply, tagsText, applyActive, refreshNotes, refreshDrafts, setBusy, setNotice])

      /**
       * 丢弃一条草稿 —— **按它自己的 id**，所以列表里任意一条都能丢。
       *
       * ⚠️ 从前它只作用于"正载入编辑区的那条"（`discard()` 认的是 `active`），于是
       * 列表里别的草稿只能先点「接着写」载进来才能丢（审计 §四③）。现在目标由调用方
       * 显式给（`discardTarget`），所以不存在"删错人"的可能。
       *
       * @param {object|null} target 要丢弃的那条草稿；`null` 或没有 `draftId` = 编辑区里
       *   还没保存过的内容（服务端没有记录可删，清掉编辑框就算丢弃）
       */
      const discardDraft = useCallback((target) => {
        setDiscardTarget(null)
        if (target === null || typeof target?.draftId !== 'string') {
          applyActive(null)
          setNotice({ kind: 'ok', text: '已丢弃未保存的内容。' })
          return
        }
        setBusy(true)
        callApi(`/books/${bookId}/drafts/${target.draftId}`, { method: 'DELETE' })
          .then(() => {
            // 丢的正好是编辑区里那条 → 编辑框也要空掉，否则它会指着一个已经不在的草稿。
            // 丢的是别的草稿 → **不动编辑区**：读者正在写的东西不该因为他在列表里
            // 清掉另一条就消失。
            if (target.draftId === active?.draftId) applyActive(null)
            setNotice({ kind: 'ok', text: '草稿已丢弃。' })
            return refreshDrafts()
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setBusy(false))
      }, [bookId, active, applyActive, refreshDrafts, setBusy, setNotice])

      /** 点建议 tag：已经在框里就忽略，否则追加。 */
      const addTag = useCallback((tag) => {
        setTagsText((prev) => {
          const parts = prev.split(/[\s,，]+/).filter((item) => item !== '')
          if (parts.includes(tag)) return prev
          return [...parts, tag].join(' ')
        })
      }, [])

      /**
       * 编辑区里有没有**没落盘**的改动。
       *
       * ⚠️ 它与 `unsaved` 不是一回事（v1.62）：`unsaved` 只覆盖"从没保存过的起稿"
       * （没有 `draftId`，界面上给了一句提示）。而**改过一条已有草稿却没保存**时
       * `unsaved` 是 false —— 但那些字同样会丢。所以这个判断按"编辑区 ≠ 当前那条"来做。
       */
      const dirty = active === null
        ? (excerpt.trim() !== '' || thought.trim() !== '' || reply.trim() !== '' || tagsText.trim() !== '')
        : (excerpt !== (active.excerpt ?? '')
          || thought !== (active.thought ?? '')
          || reply !== (active.reply ?? '')
          || tagsText !== ((active.tags ?? []).join(' ')))

      /**
       * 把一条草稿载进编辑区（列表里的「接着写」）。
       *
       * ⚠️ 编辑区里有没保存的改动时**先问一句**（v1.62）：`applyActive` 无条件替换四个
       * 输入框，从前这会静默丢掉读者刚写的字 —— 而服务端那条草稿还是旧内容，找不回来。
       * 确认条渲染在**草稿列表正上方**（理由见那边的说明）。
       */
      const loadDraft = useCallback((draft) => {
        if (dirty) {
          setSwitchTarget(draft)
          return
        }
        applyActive(draft)
      }, [dirty, applyActive])

      /**
       * 抓会话里选中的文字填进「AI 回应」。
       *
       * ⚠️ 它住在这一簇里是**有意的**：它写的是编辑区（`setReply`），而且抓完立刻
       * `persist()` 一次。搬进 `NotesView` 会多出一个逃生口，边界反而更糊。
       */
      const grabSelection = useCallback(() => {
        const sel = typeof window !== 'undefined' && typeof window.getSelection === 'function'
          ? window.getSelection()
          : null
        const text = sel === null || sel === undefined ? '' : String(sel.toString()).trim()
        if (text === '') {
          setNotice({ kind: 'error', text: '没有选中文字。先在会话里把 AI 的回应拖选上，再点这里。' })
          return
        }
        const next = reply.trim() === '' ? text : `${reply}\n\n${text}`
        setReply(next)
        setNotice({ kind: 'ok', text: `已抓取 ${text.length} 字到「AI 回应」，正在保存草稿…` })
        // 立刻落盘一次：抓来的回应如果只活在内存里，切页签就没了。
        //
        // ⚠️ 还没保存过的起稿没有 `draftId`，`persist` 会**原样返回 null** —— 那
        // 不是失败，是"这条还没落过盘"。此时**不能**说"草稿已保存"：那句话会让
        // 读者以为草稿栏里已经有它了（这个功能最不该做的就是"说了但没做"）。
        persist({ reply: next })
          .then((saved) => {
            setNotice({
              kind: 'ok',
              text: saved === null
                ? `已抓取 ${text.length} 字到「AI 回应」。这条还没保存过，点「保存草稿」才会落盘。`
                : `已抓取 ${text.length} 字到「AI 回应」，草稿已保存。`,
            })
            // 时间线记一条"抓回回应"。同样失败不提示——草稿已经存住了，
            // 那是用户真正在乎的东西。
            recordDiscussion(bookId, {
              kind: 'reply',
              chapterIndex: active === null ? null : active.chapterIndex,
              thought,
              reply: next,
            }).catch(() => null)
          })
          .catch((error) => setNotice({ kind: 'error', text: `已抓取，但草稿保存失败：${describeError(error)}` }))
      }, [bookId, reply, persist, thought, active, setNotice])

      return {
        drafts,
        active,
        suggested,
        discardTarget,
        switchTarget,
        autosaveFailed,
        excerpt,
        thought,
        reply,
        tagsText,
        dirty,
        applyActive,
        refreshDrafts,
        save,
        persist,
        commit,
        discardDraft,
        addTag,
        loadDraft,
        grabSelection,
        // ⚠️ 逃生口（实测 2026-10-03，共 6 个）：
        //    · 四个输入框的 setter —— JSX 里那四个 `onChange` 直接写它们；
        //    · `setDiscardTarget` / `setSwitchTarget` —— 那两条二次确认的「取消」要清掉。
        //    我原先以为"把 `grabSelection` 搬进来就只剩两个"，**判断错了**：
        //    漏了 JSX 这条更直接的写入路径，全量 7 红就是这件事。
        setExcerpt,
        setThought,
        setReply,
        setTagsText,
        setDiscardTarget,
        setSwitchTarget,
      }
    }

    /**
     * **回收站动作**：进回收站 / 恢复 / 彻底删除（甲-6 第 3 步之一）。
     *
     * 三件事共用一条边界，因为它们的**善后完全一样**：都不动笔记文件里已有的字节
     * （进/出回收站是纯追加一条标记），都只重取**笔记列表与回收站**两样、
     * 且都**不该**把读者的翻页位置弹回第一页 —— 所以它们用 `reloadNotesPage()`
     * 而不是 `refresh()`。
     *
     * ⚠️ `purgeTarget` 与它的 setter 是**逃生口**：确认条（JSX）要读它来决定渲染哪一条，
     * 「取消」要清掉它。
     *
     * @param {{ book: object, reloadNotesPage: Function, loadTrash: Function, setNotice: Function }} deps
     */
    function useTrashActions(deps) {
      const { book, reloadNotesPage, loadTrash, setNotice } = deps
      const bookId = book.bookId

      /** 正等二次确认的那条笔记；`'all'` = 清空整个回收站。 */
      const [purgeTarget, setPurgeTarget] = useState(null)

      /**
       * 进回收站 / 从回收站恢复。
       *
       * ⚠️ 两个都是**纯追加一条标记**（宿主侧实现）：既不读也不改笔记文件里已有的字节 ——
       * 所以它们**一键即时、不确认**（可逆 ✓）。这也与"收紧安全不需要摩擦"一致：
       * 删除只是挪了个地方，彻底删除才是不可逆的那一步。
       */
      const setTrashed = useCallback((note, kind) => {
        setNotice(null)
        // ⚠️ 两条路径**都写成字面量**、不拼 `${kind}`：`client.test.mjs` 有一条**契约用例**
        // 把客户端用到的每条路径与宿主路由表逐条对 —— 拼出来的路径它认不出（会假红）。
        const call = kind === 'trash'
          ? callApi(`/books/${bookId}/notes/${note.id}/trash`, { method: 'POST' })
          : callApi(`/books/${bookId}/notes/${note.id}/restore`, { method: 'POST' })
        call
          .then(() => {
            // ⚠️ `reloadNotesPage()` 而不是 `refresh()`（v1.62）：进回收站 / 恢复只影响
            // 笔记列表与回收站两样，而且**不该**把读者的翻页位置弹回第一页。
            reloadNotesPage()
            loadTrash()
            setNotice({
              kind: 'ok',
              text: kind === 'trash' ? '已移入回收站（可随时恢复）。' : '已从回收站恢复。',
            })
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
      }, [bookId, reloadNotesPage, loadTrash, setNotice])
      const trashOne = useCallback((note) => setTrashed(note, 'trash'), [setTrashed])
      const restoreOne = useCallback((note) => setTrashed(note, 'restore'), [setTrashed])

      /**
       * **彻底删除**（一条或清空）：全插件唯一会改读者笔记文件的一步。
       *
       * 宿主侧的三道保险在 `library.purgeNotes`：先备份 → 写前核对文件没被别人改过 → 才写。
       * 所以这里**只负责把结果说清楚**（删了几条、备份在哪） —— 以及把"文件被你改过"那种
       * 中止如实报出来（那是**可重试**的，不是出错）。
       *
       * ⚠️ **清空走 `{ all: true }`，不是"把列表里看到的那几条的 id 传过去"**
       * （2026-10-02 三方评审 P2-8）：回收站列表一次只取 `TRASH_PAGE_LIMIT`（200）条，
       * 传 id 就等于**只清前 200 条**，而确认条的文案用的是宿主报的 `total`
       * （"把里面 N 条真正抹掉"）⇒ 说的和做的不是一个数，且"清空"清不干净。
       * 宿主本来就支持 `all`（`library.trashedNoteIds` 明说"清空要的就是清干净"）。
       *
       * @param {string[]|'all'} target `'all'` = 清空回收站；数组 = 只删这几条
       */
      const runPurge = useCallback((target) => {
        setPurgeTarget(null)
        setNotice(null)
        const body = target === 'all' ? { all: true } : { ids: target }
        callApi(`/books/${bookId}/notes/purge`, { method: 'POST', body })
          .then((data) => {
            // 同上：保住翻页位置（彻底删除删的是回收站里的东西，与"列表翻到哪一页"无关）。
            reloadNotesPage()
            loadTrash()
            const removed = data?.purged?.removed ?? 0
            const backup = data?.purged?.backupPath ?? ''
            setNotice({
              kind: 'ok',
              text: `已彻底删除 ${removed} 条。${backup === '' ? '' : `写前备份在 ${backup}`}`,
            })
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
      }, [bookId, reloadNotesPage, loadTrash, setNotice])

      return { purgeTarget, setPurgeTarget, trashOne, restoreOne, runPurge }
    }

    /**
     * **把「摘抄 + 感想」发到会话**（甲-6 第 3 步之二）。
     *
     * 这一簇是本插件**最该早做对**的一件事：读者不该把摘抄复制到会话、聊完再把回应
     * 复制回来。它的依赖很多（补齐前文记忆 / 绑定以服务端为准 / 三条降级路径 /
     * 交接），但**全部来自 props**，所以它自封得很好 —— 只暴露一个 `sendToSession`。
     *
     * ⚠️ 它**不是**"把文字塞进输入框"那么简单，里面有两条容易踩的线：
     *   · 补齐前文记忆是**阻塞**的（读者明确说"愿意等几十秒"），但**失败不拦**聊天；
     *   · 补齐结果必须**三态留住**，否则"前文记忆已更新"会在闸门拦下/调用失败时照样说出口。
     * 两者的理由都写在下面。
     *
     * @param {{ book: object, sessionId: string, active: object|null, excerpt: string,
     *           thought: string, inputActions: object, existingDraft: string,
     *           openSession: Function, requestHandoff: Function,
     *           setNotice: Function, setBusy: Function }} deps
     */
    function useSessionSend(deps) {
      const {
        book, sessionId, active, excerpt, thought,
        inputActions, existingDraft, openSession, requestHandoff, setNotice, setBusy,
      } = deps
      const bookId = book.bookId

      /**
       * 把「摘抄 + 感想」一键发到会话。
       *
       * 输入框里已有的内容会被**保留**（拼在前面）——静默冲掉用户正在打的字
       * 是不可接受的。
       */
      const sendToSession = useCallback(() => {
        if (excerpt.trim() === '' && thought.trim() === '') {
          setNotice({ kind: 'error', text: '先写点摘抄或感想再发。' })
          return
        }
        const lines = []
        // 开头写明这是第几章：会话里翻到这条消息时该一眼看出摘抄的出处，
        // 而不是只看到一段没有来处的引用。
        const heading = chapterHeading(
          active === null ? null : active.chapterIndex,
          active === null ? '' : active.chapterTitle,
        )
        if (heading !== '') lines.push(`**${heading}**`)
        if (excerpt.trim() !== '') {
          lines.push(excerpt.trim().split('\n').map((line) => `> ${line}`).join('\n'))
        }
        if (thought.trim() !== '') lines.push(thought.trim())
        const text = lines.join('\n\n')
        if (inputActions === undefined || typeof inputActions.setDraft !== 'function') {
          setNotice({ kind: 'error', text: '宿主没有把输入框接口交给面板，请手动复制到会话。' })
          return
        }
        // 送进会话**之前**先把缺失的前文补进记忆。
        //
        // 这一趟是阻塞的，读者明确说了"愿意等几十秒"。阻塞在这里是值得的：
        // 补完之后你跟 AI 聊时，它对前文的了解一定是最新的——否则会出现
        // "它怎么不记得前面"的困惑，而那正是要解决的问题。
        //
        // 补齐失败**不拦**你聊天：本章与上一章是直接投喂的，不依赖背景认识。
        setBusy(true)
        setNotice({ kind: 'ok', text: '正在检查前文记忆…' })
        // 绑定以**服务端为准**：读者可能刚在「陪读」页改过绑定，而书架列表里
        // 那份 `sessionId` 是打开这本书时抓的快照，已经旧了。
        //
        // 与补齐**并行**发：补齐是慢路径（宿主默认 120 秒），没必要让它后面
        // 再排一个来回。
        const boundRequest = callApi(`/books/${bookId}/progress`)
          .then((data) => (typeof data.binding?.sessionId === 'string' ? data.binding.sessionId : null))
          .catch(() => null)
        // ⚠️ 补齐的结果**必须留住**。原来这里是一个 `.catch(() => null)`，结果被整个
        // 丢掉，于是下面那句"前文记忆已更新"在**闸门拦下 / 调用失败 / 网络断掉**时
        // 照样说出口。改成三态，文案由 `memoryFillClause` 按真实结果生成。
        // ⚠️ **带上这条笔记所属的那一章。** 读者可能刚用目录跳到很靠后的一章、还没
        // 滚动过，此时落盘的进度是旧的 —— 缺口会算错、跳读闸也不会弹（读者实测到的
        // 正是这个：在第 430 章发笔记，界面一声不响）。服务端拿它把边界推到位，
        // 于是投喂、缺口、补齐三者用同一个数。
        const atChapter = Number.isInteger(active?.chapterIndex) ? active.chapterIndex : undefined
        const fillRequest = callApi(`/books/${bookId}/background/fill`, {
          method: 'POST',
          body: atChapter === undefined ? { sessionId } : { sessionId, atChapter },
        })
          .then(
            (data) => ({ kind: 'ok', data }),
            (error) => ({ kind: 'error', error, gate: gatePromptOf(error) }),
          )
        Promise.all([fillRequest, boundRequest])
          .then(([fill, boundSessionId]) => {
            const memoryClause = memoryFillClause(fill)
            // 记忆没更新时，整条提示降级成 error 色——它此刻比"摘抄放进去了"更该被看见。
            const memoryOk = fill.kind === 'ok'
            try {
              const plan = planNoteSend({
                boundSessionId,
                currentSessionId: sessionId,
                // 两个条件都要：跳得过去，且跳过去之后有人接住这段文字。
                canOpenSession: typeof openSession === 'function' && typeof requestHandoff === 'function',
              })
              if (plan.mode === 'handoff') {
                // ⚠️ 只交接**正文**，不在这里拼「输入框里已有的字」。
                //
                // 此刻手上的 `existingDraft` 是**源会话**的，拼进去等于把源会话里
                // 打了一半的话搬到目标会话去——那不是读者想要的。合并推迟到兑现
                // 那一刻，那边读到的 `existingDraft` 才是目标会话自己的。
                // 把 `book` 一起交出去：目标会话的面板可能从没打开过，需要这份
                // 种子才知道该落到哪本书上（见 `requestHandoff`）。
                //
                // `draft` 也要交：那边的笔记页就是靠它渲染出摘抄与感想的。用本地
                // 的 `active` 而不是面板传下来的 `activeDraft` —— 回应框的改动只
                // 活在本地 state 里（`applyActive` 更新的正是它），prop 那份还是旧的。
                requestHandoff({ sessionId: plan.targetSessionId, text, book, draft: active })
                openSession(plan.targetSessionId)
                setNotice({
                  kind: memoryOk ? 'ok' : 'error',
                  text: `${memoryClause}已切到这本书绑定的会话，那边接着开笔记页；摘抄与感想放进了那边的输入框（不会自动发送）。`,
                })
              } else {
                const existing = typeof existingDraft === 'string' ? existingDraft.trim() : ''
                inputActions.setDraft(existing === '' ? text : `${existing}\n\n${text}`)
                setNotice({
                  kind: memoryOk ? 'ok' : 'error',
                  text: plan.mode === 'here-only'
                    ? `${memoryClause}摘抄与感想放进了**当前**会话的输入框——这本书绑的是另一个会话，而宿主没有提供会话跳转，请手动切过去。`
                    : `${memoryClause}摘抄与感想已放进会话输入框（不会自动发送）。发出去聊完，再回来抓取回应。`,
                })
              }
              // 时间线记一条"发去聊"。**失败不提示**：这是旁路记录，它出问题
              // 不该打扰一件已经成功的事（内容已经进输入框了）。宿主侧对
              // 笔记落盘也会记一条，所以最坏情况只是少了一次"发去聊"的标记。
              recordDiscussion(bookId, {
                kind: 'sent',
                chapterIndex: active === null ? null : active.chapterIndex,
                excerpt,
                thought,
              }).catch(() => null)
            } catch (error) {
              setNotice({ kind: 'error', text: `放入输入框失败：${describeError(error)}` })
            }
          })
          .finally(() => setBusy(false))
      }, [bookId, sessionId, excerpt, thought, active, inputActions, existingDraft, openSession, requestHandoff, setNotice, setBusy])

      return { sendToSession }
    }

    /**
     * **笔记落点**：位置读在哪、改到哪、以及那一趟"全量重取"（甲-6 第 3 步下）。
     *
     * `refresh()` 之所以住在这里而不是留在 `NotesView`：它要做的事就是
     * **草稿 + 笔记 + 落点**三样一起重读，而落点这一条是它唯一自己发起、也唯一
     * 由它的票号罩住的请求（另外两条各自在 `useNotesCollection` / `useDraftEditor`
     * 内部验票）。把它放在资源旁边，这条"谁发的谁验票"的规矩才不用跨作用域追。
     *
     * ⚠️ 落点是**第四个**按书加载的资源，2026-10-03 才装上守卫。它漏了很久的原因
     * 值得记：补守卫时说的是"**列表类**资源一个票号都没有"，补完之后没人回头看
     * `refresh()` 的 `Promise.all` 里还挂着一条 `/location`。后果不是"少显示一个
     * 字段"——落点下面就是「重新检测位置 / 手填绝对目录 / 改到此处」三颗按钮，
     * 它们都作用在**当前**这本书上，于是读者会照着**旧书**的落点去操作新书。
     *
     * 它同时也是**普查的盲区**：反向断言只查"声明了却没登记"，对"新加了一个按书
     * 加载的资源、一个守卫都没装"完全无感（见 `test/client-runtime-review-fixes`
     * 里那条竞态用例的注释）。
     *
     * ⚠️ `manualDir` 与它的 setter 是**逃生口**：JSX 里那个"手填绝对目录"的输入框
     * 要读它、要能改它（成功后由 `moveLocation` 自己清空）。
     *
     * @param {{ book: object, refreshDrafts: Function, refreshNotes: Function,
     *           setLoading: Function, setNotice: Function, setBusy: Function }} deps
     */
    function useBookLocation(deps) {
      const { book, refreshDrafts, refreshNotes, setLoading, setNotice, setBusy } = deps
      const bookId = book.bookId

      /** 笔记实际落在哪（工作区 / 插件目录），以及为什么。 */
      const [location, setLocation] = useState(null)
      const [manualDir, setManualDir] = useState('')
      const locationGuard = useLatestGuard()

      /**
       * 全量重取（首屏、以及改了笔记落点之后）。
       *
       * 落点变化必须走这条：笔记文件可能整个挪了目录，三样东西都得重新读。
       *
       * ⚠️ 这一趟里只有 `/location` 需要**在这里**验票：`refreshDrafts` / `refreshNotes`
       * 各自在自己内部验票，而 `Promise.all` 的第三条没人管（2026-10-03 补）。
       * 两个分支都要验——失败分支会把错误文案写进界面，那也是**旧书**的错误。
       */
      const refresh = useCallback(() => {
        const ticket = locationGuard.issue()
        return Promise.all([
          refreshDrafts(),
          refreshNotes(),
          callApi(`/books/${bookId}/location`),
        ])
          .then(([, , locationData]) => {
            if (!locationGuard.isCurrent(ticket)) return
            setLocation(locationData.location ?? null)
            setLoading(false)
          })
          .catch((error) => {
            if (!locationGuard.isCurrent(ticket)) return
            setNotice({ kind: 'error', text: describeError(error) })
            setLoading(false)
          })
      }, [bookId, refreshDrafts, refreshNotes, setLoading, setNotice])

      /**
       * 改笔记落点。
       *
       * `dir` 为 null 表示回到插件自己的目录。三条路径（自动检测 / 手动指定 /
       * 还原）共用这一个函数，是因为它们的失败语义完全一样：**位置没改成，
       * 但已有的笔记一个字都不会丢**——位置只是"以后往哪写"。
       */
      const moveLocation = useCallback((dir, label) => {
        setBusy(true)
        setNotice(null)
        const request = dir === '__detect__'
          ? callApi(`/books/${bookId}/location/detect`, { method: 'POST' })
          : callApi(`/books/${bookId}/location`, { method: 'PUT', body: { workspaceDir: dir } })
        request
          .then((data) => {
            setLocation(data.location ?? null)
            const migrated = data.location?.migrated ?? []
            const where = data.location?.dir ?? ''
            setNotice({
              kind: 'ok',
              text: `${label}：${where}${migrated.length > 0 ? `（已把 ${migrated.join('、')} 复制过来，原文件保留）` : ''}`,
            })
            setManualDir('')
            return refresh()
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setBusy(false))
      }, [bookId, refresh, setNotice, setBusy])

      return { location, manualDir, setManualDir, moveLocation, refresh }
    }

    function NotesView(props) {
      const { book, activeDraft, onBack, sessionId, inputActions, existingDraft, requestHandoff, openSession, onDraftChange, onJumpToChapter } = props
      /** 当前分页选项卡（v1.57）：`notes` / `drafts` / `trash` —— 按生命周期排。 */
      const [tab, setTab] = useState('notes')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)

      // ⚠️ **必须排在 `setNotice` 之后**（它在下面几行才声明，`const` 有 TDZ）——
      //    hook 内部要用 `setNotice` 报"笔记列表刷新失败"。这是本文件第 N 次踩
      //    "定义顺序也是语义"，所以这次把它写在注释里。
      const {
        notes, notesTotal, cursors, pageNext, notesHasMore, loading, setLoading,
        trashNotes, trashTotal, trashError,
        applyPage, reloadNotesPage, refreshNotes, loadTrash, loadPage, goNextPage, goPrevPage,
      } = useNotesCollection({ book, setNotice })

      // ⚠️ 顺序（TDZ，本文件第 N 次踩）：`useNotesCollection` 要用 `setNotice`；
      //    `useDraftEditor` 要用 `setNotice` / `setBusy` **以及 `refreshNotes`**
      //    （`commit` 写完笔记要重取首屏）⇒ 两个 hook 只能依次排在它们之后。
      //    **依赖方向是单向的**：草稿编辑器知道笔记列表，反过来不知道。
      const {
        drafts, active, suggested, discardTarget, switchTarget, autosaveFailed,
        excerpt, thought, reply, tagsText, dirty,
        applyActive, refreshDrafts, save, persist, commit, discardDraft, addTag, loadDraft, grabSelection,
        setExcerpt, setThought, setReply, setTagsText,
        setDiscardTarget, setSwitchTarget,
      } = useDraftEditor({ book, activeDraft, onDraftChange, setNotice, setBusy, refreshNotes })

      // ⚠️ 顺序（TDZ）：回收站动作要用 `reloadNotesPage` / `loadTrash`（来自
      //    `useNotesCollection`）；发到会话要用 `active` / `excerpt` / `thought`
      //    （来自 `useDraftEditor`）⇒ 两个都只能排在它们之后。
      const { purgeTarget, setPurgeTarget, trashOne, restoreOne, runPurge } =
        useTrashActions({ book, reloadNotesPage, loadTrash, setNotice })
      const { sendToSession } = useSessionSend({
        book,
        sessionId,
        active,
        excerpt,
        thought,
        inputActions,
        existingDraft,
        openSession,
        requestHandoff,
        setNotice,
        setBusy,
      })

      // ⚠️ 顺序（TDZ）：`useBookLocation` 要用 `refreshDrafts` / `refreshNotes` /
      //    `setLoading`（都来自 `useNotesCollection`）⇒ 排在它之后。
      //    它把 `refresh`（草稿 + 笔记 + 落点一起重读）也一并收了进去。
      const { location, manualDir, setManualDir, moveLocation, refresh } =
        useBookLocation({ book, refreshDrafts, refreshNotes, setLoading, setNotice, setBusy })

      useEffect(() => {
        refresh()
      }, [refresh])

      const currentTags = tagsText.split(/[\s,，]+/).filter((tag) => tag !== '')

      /**
       * 框里有内容、但服务端还没有这条记录 = "写了，还没保存"。
       *
       * ⚠️ 这个状态必须**看得见**。起稿不再自动落盘之后，"我明明写了"与"草稿栏里
       * 没有它"会同时成立 —— 那是正常的，但不说明就只剩下困惑（甚至以为丢了）。
       */
      const unsaved = typeof active?.draftId !== 'string'
        && (excerpt.trim() !== '' || thought.trim() !== '' || reply.trim() !== '' || tagsText.trim() !== '')

      /**
       * 三个分页选项卡里的一颗（v1.62 抽出来，三处只写一遍）。
       *
       * ⚠️ 标签拆成「文字 + 计数」两个节点，不是为了好看：计数要能**单独调轻**，
       * 并且用等宽数字（`.drc-tab-num`）—— 否则 1 与 8 的宽度差会让这一行在切 tab 时抖。
       * `aria-pressed` 是给读屏的"当前选中"：颜色表达不了这件事，选中态又刻意不加粗了
       * （见 `.drc-btn-on` 的说明）。
       *
       * @param {string} label 选项名
       * @param {number} count 这一栏有几条
       * @param {'notes'|'drafts'|'trash'} value 它对应的 tab
       * @returns {object} 虚拟节点
       */
      const tabButton = (label, count, value) => h(
        'button',
        {
          type: 'button',
          className: tab === value ? 'drc-btn drc-btn-on' : 'drc-btn',
          'aria-pressed': tab === value,
          onClick: () => {
            setTab(value)
            // ⚠️ 回收站是"点开才取"的（它不在首屏那三样里），所以切过去要现取一次。
            // 笔记与草稿随 `refresh()` 一起来，切回去不用再取。
            if (value === 'trash') loadTrash()
          },
        },
        label,
        h(
          'span',
          { className: count === 0 ? 'drc-tab-num drc-tab-num-zero' : 'drc-tab-num' },
          `（${count}）`,
        ),
      )

      return h(
        'div',
        { className: 'drc-root' },
        h(TopBar, { title: `笔记 · ${book.title}`, onBack }),
        h(
          'div',
          { className: 'drc-body' },
          h(Notice, { notice, onDismiss: () => setNotice(null) }),

          // 笔记落点。默认在**绑定会话的工作区**下的「陪读_书名」文件夹里，
          // 拿不到工作区时回落到插件自己的目录。这里把它摊开，因为"我的笔记
          // 到底写哪去了"必须是一个能自己回答的问题。
          h(
            'div',
            { className: 'drc-section' },
            h('div', { className: 'drc-label' }, '笔记保存位置'),
            location === null
              ? h('div', { className: 'drc-item-sub' }, '读取中…')
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'drc-item-sub', style: { userSelect: 'text', wordBreak: 'break-all' } },
                    location.dir,
                  ),
                  h(
                    'div',
                    { className: 'drc-item-sub', style: { marginTop: 2 } },
                    location.scope === 'workspace'
                      ? '落在会话工作区里，可以直接打开、改、提交到版本管理。'
                      : `暂存在插件自己的目录（${describeFallback(location.fallbackReason)}）。绑定会话后点「重新检测位置」即可搬到工作区。`,
                  ),
                  h(
                    'div',
                    { className: 'drc-row' },
                    h(
                      'button',
                      { type: 'button', className: 'drc-btn', disabled: busy, onClick: () => moveLocation('__detect__', '已重新检测') },
                      '重新检测位置',
                    ),
                    location.scope === 'workspace'
                      ? h(
                          'button',
                          { type: 'button', className: 'drc-btn', disabled: busy, onClick: () => moveLocation(null, '已还原到插件目录') },
                          '还原到插件目录',
                        )
                      : null,
                  ),
                  h(
                    'div',
                    { className: 'drc-row' },
                    h('input', {
                      className: 'drc-input',
                      type: 'text',
                      value: manualDir,
                      placeholder: '也可手填一个绝对目录，例如 D:\\my-notes',
                      onChange: (event) => setManualDir(event.target.value),
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'drc-btn',
                        disabled: busy || manualDir.trim() === '',
                        onClick: () => moveLocation(manualDir.trim(), '已改到指定目录'),
                      },
                      '改到此处',
                    ),
                  ),
                ),
          ),

          // 已有草稿：点一下接着写。
          // ⚠️ 这里从前是**编辑区上方**的一块草稿区（含三个 tab）。读者反馈：
          // tab 管的是**列表**，就该在列表的位置常驻；草稿列表也属于「草稿」tab。
          // 所以整块搬到了下面的列表区（见 `tab === 'drafts'` 那一支）。

          h(
            'div',
            { className: 'drc-section' },
            // ⚠️ 四个输入框的 `label` 从前是**兄弟节点**、没有 `htmlFor`，控件也没有 `id`
            //    ⇒ 读屏软件拿不到可访问名（只有 placeholder，而它一输入就没了）。
            //    2026-10-02 三方评审 P2-12：补上 `htmlFor` / `id` 配对（`drc-note-*` 前缀
            //    避免与页面上别的 id 撞车）。
            h('div', { className: 'drc-field' },
              h('label', { className: 'drc-label', htmlFor: 'drc-note-excerpt' }, '原文摘抄'),
              h('textarea', {
                id: 'drc-note-excerpt',
                className: 'drc-input',
                rows: 3,
                value: excerpt,
                placeholder: '在正文里选中一段，点「记笔记」会自动填进来；也可以直接粘贴。',
                onChange: (event) => setExcerpt(event.target.value),
              })),
            h('div', { className: 'drc-field' },
              h('label', { className: 'drc-label', htmlFor: 'drc-note-thought' }, '我的感想'),
              h('textarea', {
                id: 'drc-note-thought',
                className: 'drc-input',
                rows: 4,
                value: thought,
                placeholder: '想跟书友说点什么？这段也会成为打 tag 的主要依据。',
                onChange: (event) => setThought(event.target.value),
              })),
            h('div', { className: 'drc-field' },
              h('label', { className: 'drc-label', htmlFor: 'drc-note-tags' }, 'tag（空格分隔，可自己加）'),
              h('input', {
                id: 'drc-note-tags',
                className: 'drc-input',
                type: 'text',
                value: tagsText,
                placeholder: '人设 文笔 世界观',
                onChange: (event) => setTagsText(event.target.value),
              })),
            suggested.length === 0
              ? null
              : h(
                  'div',
                  { className: 'drc-chips' },
                  h('span', { className: 'drc-label', style: { margin: '2px 4px 0 0' } }, '建议：'),
                  ...suggested.map((tag) => h(
                    'button',
                    {
                      key: tag,
                      type: 'button',
                      className: currentTags.includes(tag) ? 'drc-chip drc-chip-on' : 'drc-chip',
                      onClick: () => addTag(tag),
                    },
                    `#${tag}`,
                  )),
                ),
            h('div', { className: 'drc-field' },
              h('label', { className: 'drc-label', htmlFor: 'drc-note-reply' }, 'AI 回应（可选，不填就不落盘）'),
              h('textarea', {
                id: 'drc-note-reply',
                className: 'drc-input',
                rows: 3,
                value: reply,
                placeholder: '在会话里和书友聊完，回来点下面的「抓取选中文字」；留空则笔记里不会出现「AI 回应」这一节。',
                onChange: (event) => setReply(event.target.value),
              })),
            // ⚠️ 「自动保存没成功」必须常驻可见（2026-10-02 三方评审 P3-3）：它是**常驻标记**
            //    而不是 toast —— 失败这件事在重试成功之前一直成立，toast 会消失。
            autosaveFailed
              ? h(
                  'div',
                  { className: 'drc-item-sub', style: { color: 'var(--drc-warn)' } },
                  '⚠️ 刚才那次**自动保存**没成功 —— 回应框里的字还没落盘，点下面的「保存草稿」重试一次。',
                )
              : null,
            // 主路径：把摘抄与感想一键送进会话，聊完把回应抓回来。
            // 这条路径上读者**不需要复制粘贴任何东西**。
            h(
              'div',
              { className: 'drc-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn drc-btn-primary',
                  disabled: busy,
                  title: '把摘抄与感想放进会话输入框',
                  onClick: sendToSession,
                },
                '① 发到会话去聊',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn',
                  title: '把当前页面上选中的文字填进「AI 回应」',
                  onClick: grabSelection,
                },
                '② 抓取选中文字作回应',
              ),
            ),
            h(
              'div',
              { className: 'drc-row' },
              // ⚠️ **落盘是唯一的主按钮**；「保存草稿」是**往后的出口**。
              // 从前它叫「保存草稿」、与「写入笔记」并排同款 —— 读者反馈"位置有些臃肿、
              // 和这个功能的地位有偏差"：它其实是「写到一半 / 有感觉但没话」的**暂存**，
              // 不是第二个"完成"动作。
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn drc-btn-primary',
                  disabled: busy,
                  title: reply.trim() === ''
                    ? '把「摘抄 + 感想」写进笔记（回应框是空的，所以不带回应）'
                    : '把「摘抄 + 感想 + AI 回应」写进笔记',
                  onClick: commit,
                },
                reply.trim() === '' ? '写入笔记' : '写入笔记（含回应）',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn',
                  disabled: busy,
                  // ⚠️ 必须说清它**不动**你的笔记文件 —— 读者的原话是"我希望不会"。
                  // 事实：草稿存在插件数据目录的 `drafts.json`（与 `notes.md` 是两个文件，
                  // 见 `library.js` 的 `draftsPath` / `notes.js` 的 `upsertDraft`）；
                  // **只有点「写入笔记」才会往 `notes.md` 追加一条**。
                  title: '先存成草稿（只写插件自己的 drafts.json，不动你的笔记文件），以后再回来写',
                  onClick: save,
                },
                '保存草稿',
              ),
              // 「丢弃草稿」**不在这一行** —— 它挪进了「草稿」tab 里每条草稿上
              // （读者反馈：与「删除笔记」同一逻辑 —— 编辑区只管"存 / 落盘"，
              // 对"已经存在的那条"做处理放在列表里）。
              unsaved
                ? h('span', { className: 'drc-inline-label' }, '尚未保存 · 点「保存草稿」才会进草稿栏')
                : null,
            ),
            // ⚠️ 「导出」是**页面级**的动作、不是编辑区的一步 —— 从前它挤在
            // 「写入笔记 / 保存草稿」那一行里，跟两个动作抢注意力（v1.62 挪出来单独一行）。
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 6 } },
              '导出背景与全部笔记在「设置」页 —— 那里还能记住导出目录。',
            ),
          ),

          // 「丢弃草稿」的二次确认条 —— 单独一行放在按钮行**下面**（不进那个 flex 行），
          // 与解锁「已读完」用的是同一个 `confirmBar`（v1.52 起三处确认同一套形态）。
          // ⚠️ 丢弃**不可逆**（不像回收站会留一份），所以它必须确认 ✓。
          // ⚠️ `discardTarget` 装的是**哪一条**（v1.61）：文案里点名那条草稿，
          // 读者才知道自己确认的是列表里的哪一行（尤其是丢的不是正在编辑的那条时）。
          discardTarget === null
            ? null
            : confirmBar({
                text: `丢弃这条草稿：${(discardTarget.excerpt || discardTarget.thought || '（空草稿）').slice(0, 20)}`
                  + ` —— 它存在草稿库里，没落盘的内容（摘抄 / 感想 / 回应）会一起没了。`
                  + '⚠️ 这个动作**不可逆** —— 它不像回收站那样留一份。',
                primary: {
                  label: '确认丢弃',
                  onClick: () => discardDraft(discardTarget),
                },
                secondary: { label: '取消', onClick: () => setDiscardTarget(null) },
                busy,
              }),

          // 列表抽成了 memo 组件（理由见 NoteList 的说明）：它把每条笔记的
          // 摘抄/感想/回应全文都渲染出来，内联在这里会让"每敲一个字"都重渲染
          // 整张列表。
          //
          // ⚠️ 传进去的 props 必须是**稳定引用**，否则 memo 形同虚设：
          //    - `notes` 直接传状态数组，**不做** `slice().reverse()`——次序
          //      已经由宿主侧的 paginateNotes 定成"新的在前"；
          //    - `loadMore` 是 useCallback 包过的。
          // 「彻底删除 / 清空」的确认条 —— 全插件唯一改你笔记文件的一步，所以必须确认，
          // 而且是把**后果**说清（不可逆 / 会先备份 / 文件被改过时会中止）。
          purgeTarget === null
            ? null
            : confirmBar({
                text: purgeTarget === 'all'
                  ? `清空回收站：把里面 ${trashTotal} 条笔记从 notes.md 里**真正抹掉**（连标记一起）。`
                    + '⚠️ 不可逆 —— 但宿主**会先备份**你的笔记文件；如果文件正被你编辑着，它会中止并让你重试。'
                  : `彻底删除这一条：「${(purgeTarget.excerpt || purgeTarget.thought || '这条').slice(0, 20)}」`
                    + ' 会从 notes.md 里**真正抹掉**。⚠️ 不可逆 —— 宿主会先备份；文件被你改过时会中止。',
                primary: {
                  label: purgeTarget === 'all' ? '确认清空' : '确认删除',
                  // ⚠️ 清空传**字符串 `'all'`**，由 `runPurge` 换成 `{ all: true }` ——
                  //    传列表 id 只能清掉"当前取回的那一页"（见 runPurge 的说明）。
                  onClick: () => runPurge(purgeTarget === 'all' ? 'all' : [purgeTarget.id]),
                },
                secondary: { label: '取消', onClick: () => setPurgeTarget(null) },
              }),

          // 三个分页选项卡**常驻在这里**（读者反馈：tab 管的是列表，就该在列表的位置）。
          // 计数直接写在 tab 上，所以列表里不再另挂一行「已落盘的笔记（N）」。
          // ⚠️ 用 `.drc-tabs` 而不是裸 `.drc-row`：这一行是 `.drc-body` 的直接子节点，
          // 内边距得自己带（否则它会比同页的表单元素左 6px，见 CSS 里那段说明）。
          h(
            'div',
            { className: 'drc-tabs' },
            tabButton('笔记', notesTotal, 'notes'),
            tabButton('草稿', drafts.length, 'drafts'),
            tabButton('回收站', trashTotal, 'trash'),
          ),

          // 三路列表：回收站 / 草稿 / 笔记 —— 各归各的 tab，位置都在这里。
          //
          // ⚠️ 这三支**都不要**再套一层 `.drc-section`（v1.62）：`NoteList` 的根自己就是
          // `.drc-section`（`padding: 10px`），外面再套一层 = 内容多缩进 10px —— 表现是
          // "切到回收站，整张列表往右跳一下"。表头那几行自己带内边距就够了。
          tab === 'trash'
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'drc-row', style: { padding: '0 10px' } },
                  h('div', { className: 'drc-label' }, '回收站'),
                  trashTotal === 0
                    ? null
                    : h(
                        'button',
                        { type: 'button', className: 'drc-btn', onClick: () => setPurgeTarget('all') },
                        '清空回收站',
                      ),
                ),
                h(
                  'div',
                  { className: 'drc-item-sub', style: { padding: '0 10px' } },
                  '删掉的笔记在这里等着 —— 可以一条条恢复；彻底删除是不可逆的，但宿主会先备份你的笔记文件。',
                ),
                // ⚠️ **取不到的时候不许说"空的"**（2026-10-02 三方评审 P2-10）：
                //    "没有删过东西"和"这次没读到"是两件完全不同的事，而这一屏
                //    正是读者找回误删内容的地方 —— 在这里说假话的代价最大。
                trashError !== null
                  ? h(
                      'div',
                      { className: 'drc-item-sub', style: { padding: '6px 10px 10px' } },
                      `回收站这次没读到：${trashError}`,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'drc-btn',
                          style: { marginLeft: '8px' },
                          onClick: () => loadTrash(),
                        },
                        '重试',
                      ),
                    )
                  : trashNotes.length === 0
                    ? h('div', { className: 'drc-item-sub', style: { padding: '6px 10px 10px' } }, '回收站是空的。')
                    : h(NoteList, {
                        notes: trashNotes,
                        total: trashTotal,
                        loading: false,
                        page: 0,
                        pageCount: 1,
                        hasPrev: false,
                        hasNext: false,
                        mode: 'trash',
                        onRestore: restoreOne,
                        onPurge: (note) => setPurgeTarget(note),
                      }),
              )
            : tab === 'drafts'
              ? h(
                  'div',
                  null,
                  // 「接着写」会替换编辑区里正在编的那一份 —— 若编辑区还有没保存的字，
                  // 先在这里问一句（v1.62）。
                  // ⚠️ 这条确认**放在草稿列表正上方**，而不是跟别的确认条一起放在编辑区下面：
                  // 编辑区很长（四个输入框 + 两行按钮），放上面会滚出视野 —— 读者点了
                  // 「接着写」却什么都没看见，只会以为按钮坏了，然后再点一次。
                  switchTarget === null
                    ? null
                    : h(
                        'div',
                        { style: { padding: '10px 10px 0' } },
                        confirmBar({
                          text: '编辑区里还有**没保存**的内容 —— 换成编辑另一条草稿会把它丢掉。'
                            + '想留着就先按「取消」，再点编辑区那行的「保存草稿」。',
                          primary: {
                            label: '丢弃并切换',
                            onClick: () => {
                              const target = switchTarget
                              setSwitchTarget(null)
                              applyActive(target)
                            },
                          },
                          secondary: { label: '取消', onClick: () => setSwitchTarget(null) },
                          busy,
                        }),
                      ),
                  // ⚠️ 草稿是「摘抄 + 感想」在落盘之前的**暂存区**：它在插件数据目录的
                  // `drafts.json` 里，与 `notes.md` 不是一个文件（读者问过、已核实）。
                  drafts.length === 0
                    ? h(
                        'div',
                        { className: 'drc-item-sub', style: { padding: '10px 10px 0' } },
                        '还没有草稿。想先存着、以后再写，就在上面点「保存草稿」。',
                      )
                    : h(
                        'ul',
                        // `ul` 默认没有内边距，而这里**不能**靠外面套 `.drc-section` 来给
                        // （那个类是给 `NoteList` 的根用的，套两层就是多缩进 10px，见上面）。
                        { className: 'drc-list', style: { padding: '0 10px' } },
                        ...drafts.map((draft) => h(
                          'li',
                          { key: draft.draftId, className: 'drc-note-item' },
                          h(
                            'div',
                            { className: 'drc-note-head' },
                            h(
                              'span',
                              { className: 'drc-item-num' },
                              Number.isInteger(draft.chapterIndex) ? `第 ${draft.chapterIndex + 1} 章` : '未选定章',
                            ),
                            h('span', { className: 'drc-item-sub' }, formatWhen(draft.updatedAt)),
                            draft.draftId === active?.draftId
                              ? h('span', { className: 'drc-badge' }, '正在编辑')
                              : null,
                          ),
                          h(
                            'div',
                            { className: 'drc-item-sub' },
                            (draft.excerpt || draft.thought || '（空草稿）').slice(0, 40),
                          ),
                          // 「丢弃草稿」在这里 —— 与「删除本条」同一逻辑：对**已经存在的那条**
                          // 做处理放在列表里（编辑区那行只管"存 / 落盘"）。
                          // ⚠️ v1.61：**每条**草稿都给这个按钮（审计 §四③）。从前只给
                          // "正在编辑"那条，理由是 `discard()` 作用于 `active`、给别的草稿
                          // 一个"丢弃"会删错人 —— 现在 `discardDraft(draft)` 按**这一条的
                          // id** 删，目标由调用方显式给，所以不会删错。
                          h(
                            'div',
                            { className: 'drc-row', style: { marginTop: 4 } },
                            h(
                              'button',
                              // ⚠️ 走 `loadDraft`（不是 `applyActive`）：编辑区脏的时候它
                              // 先要一句确认（v1.62）。
                              { type: 'button', className: 'drc-btn', onClick: () => loadDraft(draft) },
                              '接着写',
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'drc-btn',
                                disabled: busy,
                                onClick: () => setDiscardTarget(draft),
                              },
                              '丢弃草稿',
                            ),
                          ),
                        )),
                      ),
                )
              : h(NoteList, {
                  notes,
                  total: notesTotal,
                  loading,
                  page: cursors.length - 1,
                  pageCount: Math.max(1, Math.ceil(notesTotal / NOTES_PAGE_SIZE)),
                  hasPrev: cursors.length > 1,
                  hasNext: notesHasMore && pageNext !== null,
                  onPrev: goPrevPage,
                  onNext: goNextPage,
                  onJumpToChapter,
                  onTrash: trashOne,
                }),
        ),
      )
    }

    /**
     * 陪读视图（P2）：把两件平时看不见的事摊开 —— **谁在陪读**（书籍 ↔ 会话绑定），
     * 以及 **AI 到底看到了什么**（防剧透层的真实投喂内容）。
     *
     * ⚠️ 后者**不是调试工具**，而是这个功能能被信任的前提：用户必须能自己验证
     * 「它确实只看到了我读过的部分」，而不是只能相信我们的说法。别把它当可删的
     * 开发者面板（现行约定见 `docs/design.md`）。
     *
     * @param {{ book: object, sessionId?: string, onBack: Function }} props
     * @param {object} props
     * @param {number|null} [props.currentChapter] 读者**正在看**的那一章（0 起）。
     *   两个用途：① 背景认识那条 GET 带上它，缺口按"正在看的章"算（否则进度一旦滞后，
     *   界面会显示"前文已全部纳入"、补齐按钮变灰 —— 读者实测撞到的正是这个）；
     *   ② 补齐请求带上它，服务端据此把边界推到位再算缺口。
     *   ⚠️ **普通翻页不写进度**，只有"发笔记 / 点补齐"这两个主动动作会（见
     *   `lib/index.js` 的 `fillMemoryGap` 里那段长注释）。
     */
    function CompanionView(props) {
      const { book, sessionId, onBack, currentChapter = null } = props
      const [binding, setBinding] = useState({ loading: true, sessionId: null, error: null })
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      /** 背景认识：{ covered, gap, characters, markdown, exists } */
      const [background, setBackground] = useState(null)
      /**
       * **展开了**哪几个人物卡。
       *
       * ⚠️ 注意与书架相反：人物卡**默认全折叠**（读者 2026-09-27："第一次打开的时候应该默认
       * 折叠起来比较好"），所以这里存的是展开名单 —— 空集合 = 全折叠，默认值不用写。
       *
       * ⚠️ 键用 `分区/名字`（不是只用名字）：同一本书里「人物」与「通用概念」可能有同名主体，
       * 只用名字会把两张卡一起展开/折叠 —— 而卡片自己的 React key 也是这个组合，两处一致。
       */
      const [expandedCards, setExpandedCards] = useState(() => loadNameSet(CARDS_EXPANDED_KEY))
      const toggleCard = useCallback((cardKey) => {
        setExpandedCards((prev) => {
          const next = toggleNameInSet(prev, cardKey)
          saveNameSet(CARDS_EXPANDED_KEY, next)
          return next
        })
      }, [])
      const [filling, setFilling] = useState(false)
      // 补齐**循环**的进度（null = 没在补）。循环可能跑十几分钟，没有这一份状态
      // 读者就只有一个不动的按钮。
      const [fillProgress, setFillProgress] = useState(null)
      // 运行号：每次开工自增，循环里只认自己那一号。于是「停止」和「重新开一次」
      // 都只需要改这一个数字——飞在半路的那一趟会因为 `alive()` 变假而自行收手。
      const fillRunRef = useRef(0)
      /**
       * 跳读闸的待决选择：`{ gap, gate }` 或 null。
       *
       * 存在的理由：读者从目录点开很靠后的一章时，服务端**拒绝**自动补齐并
       * 回 409。那不是错误，是"请你先表态"——所以它不能走 `notice`（一行红字），
       * 必须渲染成可点的选择。
       */
      const [gate, setGate] = useState(null)
      /**
       * 跳读闸弹窗里选中的「最近窗口」（章）。
       *
       * 初值取服务端带回来的 `recentWindow`（就是配置里的默认值），读者可以在弹窗
       * 里改成 50 / 200 / 300。它是**逐次**的、不写回配置 —— 想固定下来就改
       * `cordis.patch.yml` 里的 `sample.recentWindowChapters`。
       */
      const [gateWindow, setGateWindow] = useState(null)
      const [showMarkdown, setShowMarkdown] = useState(false)
      const [compacting, setCompacting] = useState(false)
      /**
       * 书友设定。
       *
       * 刻意存两份：`persona` 是**服务端那一份**（原文与路径），`personaDraft`
       * 是你正在编辑的。分开是为了让「没有未保存改动」这个状态是**可判定**的
       * ——只有一个 state 的话，保存成功后无法区分"刚好和服务器一样"和
       * "我改过但还没存"。
       */
      const [persona, setPersona] = useState(null)
      const [personaDraft, setPersonaDraft] = useState('')
      const [savingPersona, setSavingPersona] = useState(false)
      const [discussions, setDiscussions] = useState([])
      /** 讨论历史的**总条数**（不是这一页的条数）。用来把「只显示最近几条」讲明白。 */
      const [discussionTotal, setDiscussionTotal] = useState(0)
      /** 正在写联网档位（写盘往返期间禁用按钮，避免连点）。 */
      const [gateSaving, setGateSaving] = useState(false)

      /**
       * 五个「按书加载」的资源各配一个守卫。
       *
       * 它们**必须各用各的**：共用会让互不相关的两个加载器互相作废——比如
       * 背景认识的重载（点了「重新生成」）会顺手把还在飞的讨论历史判成过期。
       *
       * ⚠️ 加新的按书加载器时**必须**照着接一个守卫。漏掉的那个就又回到
       * 「谁后回来谁说了算」，而这类 bug 在单测里看不见（替身不跑真状态机）。
       */
      const bindingGuard = useLatestGuard()
      const backgroundGuard = useLatestGuard()
      const personaGuard = useLatestGuard()
      const discussionsGuard = useLatestGuard()

      const reload = useCallback(() => {
        const ticket = bindingGuard.issue()
        setBinding({ loading: true, sessionId: null, error: null })
        return callApi(`/books/${book.bookId}/progress`)
          .then((data) => {
            if (!bindingGuard.isCurrent(ticket)) return
            setBinding({ loading: false, sessionId: data.binding?.sessionId ?? null, error: null })
          })
          .catch((error) => {
            if (!bindingGuard.isCurrent(ticket)) return
            setBinding({ loading: false, sessionId: null, error: describeError(error) })
          })
      }, [book.bookId, bindingGuard])

      useEffect(() => {
        reload()
      }, [reload])

      const loadBackground = useCallback(() => {
        const ticket = backgroundGuard.issue()
        // ⚠️ 带上"读者正在看哪一章"（见 `currentChapter` 的说明）。它进了 deps，于是
        // 翻章时这个 effect 会重跑一次 —— 缺口与按钮状态跟着走，不会停在旧章上。
        // ⚠️ 查不到章号时传**空串**而不是省略整个查询串：宿主侧 `parseInt('')` 不是
        // 整数，会回落到落盘的进度（行为与从前一致）。这样路径保持**静态可读** ——
        // `contract.test.mjs` 会扫出客户端调用的每条路径并与宿主路由表对账，拼成
        // 两个分支的那种写法它认不出来（第一次就是这么被拦下的）。
        const at = Number.isInteger(currentChapter) ? currentChapter : ''
        callApi(`/books/${book.bookId}/background?atChapter=${at}`)
          .then((data) => {
            if (!backgroundGuard.isCurrent(ticket)) return
            setBackground(data)
          })
          .catch(() => {
            if (!backgroundGuard.isCurrent(ticket)) return
            setBackground(null)
          })
      }, [book.bookId, backgroundGuard, currentChapter])

      useEffect(() => {
        loadBackground()
      }, [loadBackground])

      /**
       * 读书友设定。
       *
       * ⚠️ 只在**首次加载**时把服务端内容灌进编辑框。之后重新拉取（比如点了
       * 「重新生成」预览）绝不覆盖编辑框——否则你写到一半的内容会被后台刷新
       * 无声抹掉，那正是这套 UI 之前最容易出的事故。
       */
      const loadPersona = useCallback((seedDraft) => {
        const ticket = personaGuard.issue()
        return callApi(`/books/${book.bookId}/persona`)
          .then((data) => {
            // ⚠️ 这一路的过期丢弃比别处更要紧：它会**回填编辑框**。放过去的话，
            // 上一本书的人设会被灌进这一本的编辑框，你再点一次「保存」，
            // 就把前一本的人设写到这一本上了——那不是显示错乱，是写错书。
            if (!personaGuard.isCurrent(ticket)) return undefined
            setPersona(data)
            if (seedDraft === true) setPersonaDraft(data.text ?? '')
            return undefined
          })
          .catch(() => {
            if (!personaGuard.isCurrent(ticket)) return
            setPersona(null)
          })
      }, [book.bookId, personaGuard])

      useEffect(() => {
        loadPersona(true)
      }, [loadPersona])

      const loadDiscussions = useCallback(() => {
        const ticket = discussionsGuard.issue()
        callApi(`/books/${book.bookId}/discussions?limit=${DISCUSSION_LIMIT}`)
          .then((data) => {
            if (!discussionsGuard.isCurrent(ticket)) return
            setDiscussions(data.discussions ?? [])
            setDiscussionTotal(data.total ?? 0)
          })
          .catch(() => {
            if (!discussionsGuard.isCurrent(ticket)) return
            setDiscussions([])
            setDiscussionTotal(0)
          })
      }, [book.bookId, discussionsGuard])

      useEffect(() => {
        loadDiscussions()
      }, [loadDiscussions])

      /** 保存书友设定。 */
      const savePersona = useCallback(() => {
        setSavingPersona(true)
        setNotice(null)
        callApi(`/books/${book.bookId}/persona`, { method: 'PUT', body: { text: personaDraft } })
          .then((data) => {
            setPersona(data)
            // 保存成功必须**回写编辑框**：服务端可能拒绝/规整过内容，
            // 让框里显示的和真正生效的一致，才不会出现"我看到的是 A、生效的是 B"。
            setPersonaDraft(data.text ?? '')
            setNotice({ kind: 'ok', text: `书友设定已保存（${data.chars ?? 0} 字），下一次对话立刻生效。` })
            return undefined
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setSavingPersona(false))
      }, [book.bookId, personaDraft])

      /** 导出：记住的目录（从 /settings 读回）、输入框里的值、以及两个忙标志。 */
      const [exportDir, setExportDir] = useState('')
      /** 解锁「已读完」的二次确认是否展开（见 `confirmBar`；从前是 `window.confirm`）。 */
      const [finishConfirm, setFinishConfirm] = useState(false)
      const [exportDirSaved, setExportDirSaved] = useState('')
      const [exporting, setExporting] = useState(false)
      const [savingExportDir, setSavingExportDir] = useState(false)
      /**
       * 上次导出的结果（常驻，显示在「导出到笔记库」那节的说明里）。
       *
       * ⚠️ **刻意不走 toast**（读者 2026-10-01）：那条结果好几行，而长文提示**不自动消失**
       * ⇒ 读者实测把它当成"弹窗不会消失"的 bug ✗。它属于"这一节的当前状态"，就该住在这里。
       */
      const [lastExport, setLastExport] = useState(() => loadLastExport(book.bookId))

      // 导出目录是**运行期设置**（存 settings.json），面板每次重挂都要读回来，
      // 否则输入框会显示上一次挂载留下的初值。
      useEffect(() => {
        let alive = true
        callApi('/settings')
          .then((data) => {
            if (!alive) return
            const saved = typeof data.exportDir === 'string' ? data.exportDir : ''
            setExportDir(saved)
            setExportDirSaved(saved)
          })
          .catch(() => { /* 读不到就留空：留空 = 由宿主按会话工作区根定 */ })
        return () => { alive = false }
      }, [])

      /** 记住（或清除）导出目录。留空 = 回到"本会话工作区根"。 */
      const saveExportDir = useCallback(() => {
        setSavingExportDir(true)
        callApi('/settings', { method: 'PUT', body: { exportDir } })
          .then((data) => {
            const saved = typeof data.exportDir === 'string' ? data.exportDir : ''
            setExportDirSaved(saved)
            setNotice({
              kind: 'ok',
              text: saved === '' ? '导出目录已清除：以后导出到本会话的工作区根。' : `已记住导出目录：${saved}`,
            })
            return undefined
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setSavingExportDir(false))
      }, [exportDir])

      /**
       * 手动压缩背景认识。 */
      const compactBackground = useCallback(() => {
        setCompacting(true)
        setNotice(null)
        callApi(`/books/${book.bookId}/background/compact`, { method: 'POST', body: { sessionId } })
          .then((data) => {
            setNotice({
              kind: 'ok',
              text: `背景认识已压缩：${data.beforeChars} → ${data.afterChars} 字`
                + (data.backupPath ? `。原件备份在 ${data.backupPath}` : '。'),
            })
            loadBackground()
            return undefined
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setCompacting(false))
      }, [book.bookId, sessionId, loadBackground])

      /**
       * 补齐背景认识，**一次点到底**。
       *
       * 服务端一次调用只处理**一段**缺口（首次 30 章打底，之后按预算一批），缺口
       * 大时回 `partial: true`。这里交给 `runFillLoop` 接着补下一批，直到补完、
       * 出错、或读者按停。**每一批都是一次阻塞调用**——读者明确选了"愿意等"。
       *
       * `mode` 只在**跳读闸**拦下之后才传（服务端见 `sample.jumpGateChapters`）：
       *   'all'     这些章我确实都读过
       *   'recent'  我从这里接着读，只记最近这一段
       *
       * `window` 只与 'recent' 搭配：这次要纳入的窗口章数（不传则由服务端用配置默认）。
       *
       * ⚠️ 调用处必须写成 `() => fillBackground()`。直接挂 `onClick: fillBackground`
       * 会把点击事件当成 `mode` 传进来。
       */
      const fillBackground = useCallback((mode, window) => {
        // 只认这两个字面量。调用方若误写成 `onClick: fillBackground`，传进来的
        // 会是点击事件对象——归一化之后它会静默退成"没给 mode"（再次弹闸），
        // 而不是把一个 Event 序列化进请求体。
        const asked = mode === 'all' || mode === 'recent' ? mode : undefined
        // 窗口只对 'recent' 有意义；别的情况下不带这个字段，免得服务端多一处归一化。
        const askedWindow = asked === 'recent' && Number.isInteger(window) ? window : null
        // ⚠️ `atChapter` **只在本轮补齐的第一次调用**带（见下面的 `bodyFor`）：它的作用是
        // "把边界推到我正在看的这一章"，而补齐循环可能跑十几分钟 —— 每一批都重发一次的话，
        // 读者在这期间翻了章，他的阅读位置会被一批批**数回去**（与他自己滚动的回写打架）。
        const at = Number.isInteger(currentChapter) ? { atChapter: currentChapter } : {}
        const run = fillRunRef.current + 1
        fillRunRef.current = run
        const alive = () => fillRunRef.current === run
        // ⚠️ `body` **每次调用现算**，不是一次算好反复用：`runFillLoop` 会连着发很多批。
        // ⚠️ `ask: true` **只**在手动补（`asked === undefined`）时带：它的意思是"我是主动
        // 来补的"，于是大缺口仍然把那几个选项交给我选。带 `mode` 的那两次已经表过态，
        // 不该再被问一次 —— 再问会让它们变成"点了没反应"。
        // ⚠️ `...at` 两边都要带（`at` 见上）。⚠️ 它一度**声明了却没被用上**，而当时的用例
        // 只断言了"那个声明在"，于是面板手动补完全不推边界 —— 断言要落在"被用上"。
        let firstCall = true
        const bodyFor = () => {
          const carried = firstCall ? at : {}
          firstCall = false
          return asked === undefined
            ? { sessionId, ask: true, ...carried }
            : { sessionId, mode: asked, ...(askedWindow === null ? {} : { recentWindow: askedWindow }), ...carried }
        }

        setFilling(true)
        setNotice(null)
        setGate(null)
        setFillProgress(null)

        runFillLoop({
          alive,
          fill: () => callApi(`/books/${book.bookId}/background/fill`, { method: 'POST', body: bodyFor() }),
          onProgress: (progress) => { if (alive()) setFillProgress(progress) },
        })
          .then((outcome) => {
            if (!alive()) return
            // 跳读闸是 409，经 `callApi` 变成一个带结构信息的错误。它不是失败，
            // 是一道**要读者回答的问题**——所以不走 notice，走闸门那两个按钮。
            const failed = outcome.error !== undefined && outcome.error !== null
            const prompt = failed ? gatePromptOf(outcome.error) : null
            if (prompt !== null) {
              setGate(prompt)
              // 弹窗里的窗口初值 = 服务端带回来的配置默认值（客户端不自己猜一个）。
              setGateWindow(Number.isInteger(prompt?.recentWindow) ? prompt.recentWindow : null)
              return
            }
            setNotice(fillOutcomeNotice(outcome))
          })
          .catch((error) => {
            // `runFillLoop` 已经把失败收成 `kind:'failed'`，所以这里只可能是它
            // 之外的东西炸了。仍然如实报出来，不吞。
            if (alive()) setNotice({ kind: 'error', text: describeError(error) })
          })
          .finally(() => {
            if (!alive()) return
            setFilling(false)
            setFillProgress(null)
            loadBackground()
          })
      }, [book.bookId, sessionId, loadBackground, currentChapter])

      /**
       * 停下补齐循环。已补进去的部分保留——每一批都是**独立落盘**的，没有半成品。
       *
       * ⚠️ 只把运行号加一，不 abort 那次 fetch：请求可能正卡在宿主里跑模型调用，
       * 硬断它既省不下这次调用，又会让服务端白写一遍合并。让它自己跑完、由
       * `alive()` 决定**要不要采信结果**，是这里唯一诚实的做法。
       */
      const cancelFill = useCallback(() => {
        const at = fillProgress?.covered?.last
        fillRunRef.current += 1
        setFilling(false)
        setFillProgress(null)
        setNotice({
          kind: 'ok',
          text: Number.isInteger(at)
            ? `已停止补齐。记忆已经补到第 ${at} 章，剩下的下次可以接着补。`
            : '已停止补齐。已经补进去的部分会保留。',
        })
        loadBackground()
      }, [fillProgress, loadBackground])

      /** 清空重建。刻意是显式动作：清空不可逆，只有用户自己点才做。 */
      const resetBackground = useCallback(() => {
        setFilling(true)
        setNotice(null)
        callApi(`/books/${book.bookId}/background/reset`, { method: 'POST' })
          .then(() => {
            setNotice({ kind: 'ok', text: '背景认识已清空，下次补齐会从头建立。' })
            loadBackground()
            return undefined
          })
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setFilling(false))
      }, [book.bookId, loadBackground])

      /**
       * 切联网档位。
       *
       * 写的是**运行期设置**（`settings.json`），不是 `cordis.yml` —— 所以改完
       * 立即生效，不用重启。
       *
       * 乐观更新：先把界面切过去，失败再回滚。理由是**这个开关的反馈必须即时**
       * （否则你会以为没点中而连点三次），而它失败的概率很低、后果可逆。
       * 回滚是必需的：界面显示是你判断"AI 到底能不能联网"的唯一依据，让一个
       * 并未生效的档位留在那儿，比报一次错更糟。
       */
      const saveWebGate = useCallback((mode) => {
        const previous = background?.webGate
        if (gateSaving || previous === mode) return
        setGateSaving(true)
        setNotice(null)
        setBackground((prev) => (prev === null ? prev : { ...prev, webGate: mode }))
        callApi('/settings', { method: 'PUT', body: { webGate: mode } })
          .then((data) => {
            setBackground((prev) => (prev === null ? prev : { ...prev, webGate: data.effectiveWebGate }))
            setNotice({
              kind: 'ok',
              text: `联网档位已切到「${webGateShort(data.effectiveWebGate)}」，立即生效（不用重启）。`,
            })
            return undefined
          })
          .catch((error) => {
            setBackground((prev) => (prev === null ? prev : { ...prev, webGate: previous }))
            setNotice({ kind: 'error', text: describeError(error) })
          })
          .finally(() => setGateSaving(false))
      }, [background?.webGate, gateSaving])

      /**
       * 标记 / 取消「已读完」（v1.45）。
       *
       * ⚠️ 这是全插件**唯一会放松**那条硬规则的动作，所以两端刻意不对称：
       * **解锁要二次确认**（界面上的确认条，见 `confirmBar`）；**收回一键即时** ——
       * 收紧安全不需要摩擦。二次确认在**渲染层**（`finishConfirm`），所以这个函数只管
       * 真正落盘那一步。
       *
       * 与 `saveWebGate` 同形：先乐观更新、失败回滚。界面显示是你判断"AI 到底能不能
       * 读全书"的唯一依据，让一个并未生效的状态留在那儿，比报一次错更糟。
       */
      const saveFinished = useCallback((finished) => {
        const previous = background?.finished === true
        if (gateSaving || previous === finished) return
        setGateSaving(true)
        setNotice(null)
        setBackground((prev) => (prev === null ? prev : { ...prev, finished }))
        callApi(`/books/${book.bookId}/finished`, { method: 'POST', body: { finished } })
          .then((data) => {
            setBackground((prev) => (prev === null ? prev : { ...prev, finished: data.finished === true }))
            setNotice({
              kind: 'ok',
              text: data.finished === true
                ? '已解锁：这本书的原文对陪读 AI 可见（立即生效）。'
                : '已收回：这本书的原文重新对 AI 关闭（立即生效）。',
            })
            return undefined
          })
          .catch((error) => {
            setBackground((prev) => (prev === null ? prev : { ...prev, finished: previous }))
            setNotice({ kind: 'error', text: describeError(error) })
          })
          .finally(() => setGateSaving(false))
      }, [background?.finished, gateSaving, book.bookId])

      const boundHere = binding.sessionId !== null
        && sessionId !== undefined
        && normalizeId(binding.sessionId) === normalizeId(sessionId)

      const bindCurrent = useCallback(() => {
        if (sessionId === undefined || sessionId === '') {
          setNotice({ kind: 'error', text: '宿主没有把当前会话 id 交给面板，无法绑定。' })
          return
        }
        setBusy(true)
        setNotice(null)
        callApi(`/books/${book.bookId}/binding`, { method: 'PUT', body: { sessionId } })
          .then(reload)
          .then(() => setNotice({ kind: 'ok', text: '已绑定。现在在会话里发感想，AI 就会以书友身份回应。' }))
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setBusy(false))
      }, [book.bookId, sessionId, reload])

      const unbind = useCallback(() => {
        setBusy(true)
        setNotice(null)
        callApi(`/books/${book.bookId}/binding`, { method: 'DELETE' })
          .then(reload)
          .then(() => setNotice({ kind: 'ok', text: '已解除绑定。阅读进度保留，陪读上下文不再注入。' }))
          .catch((error) => setNotice({ kind: 'error', text: describeError(error) }))
          .finally(() => setBusy(false))
      }, [book.bookId, reload])

      return h(
        'div',
        { className: 'drc-root' },
        h(TopBar, { title: `设置 · ${book.title}`, onBack }),
        h(
          'div',
          { className: 'drc-body' },
          h(
            'div',
            { className: 'drc-section' },
            h('div', { className: 'drc-item-name' }, '陪读会话'),
            binding.loading
              ? h('div', { className: 'drc-item-sub' }, '读取绑定状态…')
              : binding.error !== null
                ? h('div', { className: 'drc-error' }, binding.error)
                : h(
                    'div',
                    { className: 'drc-item-sub' },
                    binding.sessionId === null
                      ? '未绑定。绑定后，本会话的 AI 会以「只看过你读过的部分」的姿态陪你聊。'
                      : `已绑定：${binding.sessionId}`,
                  ),
            binding.sessionId !== null && !boundHere && sessionId !== undefined
              ? h(
                  'div',
                  { className: 'drc-warn' },
                  `这本书绑的是另一个会话（${String(binding.sessionId).slice(0, 16)}…）。一本书只允许绑一个会话，要换绑请先解除。`,
                )
              : null,
            h(
              'div',
              { className: 'drc-row' },
              h(
                'button',
                { type: 'button', className: 'drc-btn drc-btn-primary', disabled: busy || boundHere, onClick: bindCurrent },
                boundHere ? '已绑定本会话' : '把本会话绑定到这本书',
              ),
              h(
                'button',
                { type: 'button', className: 'drc-btn', disabled: busy || binding.sessionId === null, onClick: unbind },
                '解除绑定',
              ),
            ),
            sessionId === undefined
              ? null
              : h('div', { className: 'drc-item-sub', style: { marginTop: 6 } }, `当前会话：${sessionId}`),
            h(Notice, { notice, onDismiss: () => setNotice(null) }),
          ),
          h(
            'div',
            { className: 'drc-section' },
            h('div', { className: 'drc-item-name' }, '书友设定（你写给 AI 的）'),
            h(
              'div',
              { className: 'drc-item-sub' },
              '在这里写你希望陪读 AI 用什么口吻、关注什么。它和插件自带的「陪读守则」一起生效：'
              + '守则管硬底线（不剧透、不猜后续），这里管风格与侧重。两者冲突时以守则为准。',
            ),
            persona === null
              ? h('div', { className: 'drc-item-sub', style: { marginTop: 6 } }, '读取中…')
              : h(
                  'div',
                  null,
                  h('textarea', {
                    className: 'drc-input',
                    style: { marginTop: 8, minHeight: 108 },
                    rows: 5,
                    value: personaDraft,
                    // ⚠️ 这是 **placeholder**（一打字就消失），所以"默认人设是空的"这个性质天然成立 ——
                    // 下面这段只是**方向示例**，不是预填内容，也不该被当成"默认稿"。
                    // 五个方向刻意写得短：读者可以照着写，也可以完全不写。
                    placeholder: '例（写成你自己的话就行）：'
                      + '口吻与篇幅 —— 说话简短一点，别用感叹号；'
                      + '称呼 —— 叫我「你」就好；'
                      + '关注点 —— 我关心人物动机多过情节，可以多问我「你觉得她为什么这么做」；'
                      + '聊多深 —— 我说「别分析」时陪我待一会儿，说「往深了聊」再跟我较真；'
                      + '卡住时 —— 先告诉我这一段在做什么，再给一两个能用的读法。\n'
                      + '（留空 = 不加任何额外设定。）',
                    onChange: (event) => setPersonaDraft(event.target.value),
                  }),
                  h(
                    'div',
                    { className: 'drc-row' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'drc-btn drc-btn-primary',
                        disabled: savingPersona || personaDraft === (persona.text ?? ''),
                        onClick: savePersona,
                      },
                      savingPersona
                        ? '保存中…'
                        : (personaDraft === (persona.text ?? '') ? '已保存' : '保存设定'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'drc-btn',
                        disabled: savingPersona || personaDraft === '',
                        onClick: () => setPersonaDraft(''),
                      },
                      '清空',
                    ),
                    h('span', { className: 'drc-inline-label' }, `${personaDraft.length} / 4000 字`),
                  ),
                  personaDraft !== (persona.text ?? '')
                    ? h('div', { className: 'drc-warn' }, '有未保存的改动 —— 现在对话还用着旧的那一份。')
                    : null,
                  h(
                    'div',
                    { className: 'drc-item-sub', style: { marginTop: 6, userSelect: 'text', wordBreak: 'break-all' } },
                    `它存在这个文件里，你也可以直接编辑它：${persona.path ?? ''}`,
                  ),
                ),
          ),
          h(
            'div',
            { className: 'drc-section' },
            h('div', { className: 'drc-item-name' }, '背景认识（记忆）'),
            h(
              'div',
              { className: 'drc-item-sub' },
              '陪读 AI **完整阅读本章**，以及**上一章的结尾**（默认只给尾部，'
              + '见 `window.previousChapterMode`）；更早的前文靠这份背景认识 —— '
              + '世界观、人物、**人物关系**（非小说文本另有「通用概念」兜底）。'
              + '它随你的阅读进度增量补充，条目只增不减。',
            ),
            // ⚠️ 「该压缩了」的提醒：这个信号从前跟着 `/context`（AI 视角预览）走，而那个
            //    面板入口在 2.2.2 被摘掉之后，客户端就再也不调那条路由了 ⇒ 提醒无声消失，
            //    压缩变成"纯手动、没人提醒"（读者的某本书因此涨到 47 KB）。
            //    现在宿主在 `/background` 里回 `compaction`，这里把它说给读者。
            background?.compaction?.over === true
              ? h(
                  'div',
                  { className: 'drc-warn' },
                  `⚠️ 这份背景认识已经偏胖（约 ${background.compaction.fullChars} 字，建议上限 `
                  + `${background.compaction.threshold} 字）—— 点下面的「压缩背景认识」把它压小：`
                  + '压完每轮注入更省、聊起来也更快。',
                )
              : null,
            background === null
              ? h('div', { className: 'drc-item-sub', style: { marginTop: 6 } }, '读取中…')
              : h(
                  'div',
                  { className: 'drc-item-sub', style: { marginTop: 6 } },
                  // 「读到第 N 章」与「记忆到第 M 章」并排：进度一旦滞后，这一对数字会
                  // 当场露馅（读者实测那次就是被它坑了 —— 界面只说"记忆到第 2 章"，
                  // 而人明明在第 430 章）。
                  (Number.isInteger(currentChapter) ? `读到第 ${currentChapter + 1} 章 · ` : '')
                  + (background.covered === null
                    ? '还没有建立背景认识。'
                    : `记忆到第 ${background.covered.last} 章 · 已知人物 ${background.characters.length} 位`)
                  + (background.gap === null
                    ? '（前文已全部纳入）'
                    : ` · 缺口：第 ${background.gap.from}–${background.gap.to} 章`),
                ),
            // 「已读完」时补一句：这颗按钮是**一次跑到底**的（读者既然宣布读完，
            // 补齐全书就是正当且一次性的事 —— 但依然是他点才跑 ✓）。
            background?.finished === true && background?.gap !== null && background?.gap !== undefined
              ? h(
                  'div',
                  { className: 'drc-item-sub', style: { marginBottom: 4 } },
                  `⚠️ 这本书你已标记读完：补齐会一次跑到底（缺口 ${background.gap.chapters} 章），中途可以点「停止补齐」。`,
                )
              : null,
            h(
              'div',
              { className: 'drc-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn drc-btn-primary',
                  // ⚠️ 补齐中**不能**把这个按钮禁掉——循环可能跑十几分钟，禁掉
                  // 就等于读者没有任何出口。它在补齐中变成「停止」。
                  disabled: !filling && (background?.gap === null || background?.gap === undefined),
                  title: filling
                    ? '停下补齐循环。已经补进去的批次会保留'
                    : (background?.gap === null || background?.gap === undefined
                      ? '当前没有缺口'
                      : '点一次补到底：缺口大时会连续补几批，中途可以停'),
                  onClick: () => { if (filling) cancelFill(); else fillBackground() },
                },
                filling ? '停止补齐' : '补齐前文记忆',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn',
                  disabled: background === null,
                  onClick: () => setShowMarkdown((prev) => !prev),
                },
                showMarkdown ? '收起原文' : '查看 / 校对',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn',
                  disabled: compacting || background?.covered === null || background?.covered === undefined,
                  title: '把 background.md 本身变小：合并重复条目。保名保号，压不动就整批丢弃、文件不动。',
                  onClick: compactBackground,
                },
                compacting ? '压缩中…' : '压缩背景认识',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn',
                  disabled: filling || background?.covered === null || background?.covered === undefined,
                  onClick: resetBackground,
                },
                '清空重建',
              ),
            ),
            // 补齐循环可能跑十几分钟，中间必须看得出"走到哪了"。
            // 旧版一次调用只补一批，所以只需要一句"再点一次继续"；循环化之后
            // 没有这一行，读者面对的就是一个十几分钟不动的按钮。
            filling && fillProgress !== null
              ? h(
                  'div',
                  { className: 'drc-item-sub', style: { marginTop: 6 } },
                  `补齐中：已补到第 ${Number.isInteger(fillProgress.covered?.last) ? fillProgress.covered.last : '?'} 章`
                  + (Number.isInteger(fillProgress.remaining) ? `，还剩 ${fillProgress.remaining} 章…` : '…'),
                )
              : null,
            // 跳读闸拦下时，这里出现两个诚实的答案 + 一个「先不补」。
            // 刻意**不**把它渲染成错误：把还没读到的内容写进背景认识是不可逆的，
            // 而这一屏正是阻止它的唯一地方。
            //
            // 还多两样东西，都是为了回答"值不值得、要等多久"：
            //   1. 两个预估（约几批 / 每章多少字）—— **由宿主算好带回来**，客户端
            //      不自己算预算，免得同一套算术有两处实现、迟早在某处对不上；
            //   2. 窗口可选（50 / 配置默认 / 300）—— 想换一个数不必去改配置文件。
            gate === null
              ? null
              : h(
                  'div',
                  // 与解锁「已读完」、回收站同一套确认形态（v1.52）。从前这里是**写死的
                  // 颜色** `#d9a441` + 内联边距 —— 三处确认于是各长一个样。
                  { className: 'drc-confirm' },
                  h(
                    'div',
                    { className: 'drc-item-sub' },
                    `这次要补的是第 ${gate.gap.from}–${gate.gap.to} 章，共 ${gate.gap.chapters} 章，`
                    + `超过跳读闸（${gate.gate === null ? '阈值' : gate.gate} 章）。`,
                  ),
                  h(
                    'div',
                    { className: 'drc-item-sub', style: { marginTop: 4 } },
                    '这不是报错，是防止把**你还没读到**的内容写进记忆——那一旦写进去就只能「清空重建」。',
                  ),
                  // 预估只报"约几批 × 每章约多少字"这两个**由配置直接决定**的数，
                  // 不编造耗时（"每批几十秒"是经验值，写进代码只会随模型换代过时）。
                  gate.estimate === null || gate.estimate === undefined
                    ? null
                    : h(
                        'div',
                        { className: 'drc-item-sub', style: { marginTop: 4 } },
                        `按当前设置约：全部纳入 ${gate.estimate.all.batches} 批（每章约 ${gate.estimate.all.perChapter} 字）`
                        + ` · 只记最近 ${gate.estimate.recent.window} 章 ${gate.estimate.recent.batches} 批`
                        + `（每章约 ${gate.estimate.recent.perChapter} 字）。每批都是一次模型调用。`,
                      ),
                  h(
                    'div',
                    { className: 'drc-row', style: { marginTop: 8 } },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'drc-btn drc-btn-primary',
                        disabled: filling,
                        title: '这些章我确实都读过，按老办法补',
                        onClick: () => fillBackground('all'),
                      },
                      '这些我都读过',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'drc-btn',
                        disabled: filling,
                        title: '只把最近这一段纳入记忆，不碰前面那几百章',
                        onClick: () => fillBackground('recent', gateWindow),
                      },
                      `只记最近 ${Number.isInteger(gateWindow) ? gateWindow : (gate.recentWindow ?? 200)} 章`,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'drc-btn',
                        disabled: filling,
                        onClick: () => { setGate(null); setGateWindow(null) },
                      },
                      '先不补',
                    ),
                  ),
                  // 窗口三档：50 / 配置默认 / 300。去掉"差一点点"的中间档 ——
                  // 三档足够表达"少一点 / 默认 / 多一点"，多了反而选不动。
                  h(
                    'div',
                    { className: 'drc-row', style: { marginTop: 6 } },
                    h('span', { className: 'drc-inline-label' }, '最近窗口：'),
                    ...[50, gate.recentWindow ?? 200, 300]
                      .filter((size) => Number.isInteger(size) && size > 0)
                      .filter((size, at, all) => all.indexOf(size) === at)
                      .sort((left, right) => left - right)
                      .map((size) => h(
                        'button',
                        {
                          key: `gate-window-${size}`,
                          type: 'button',
                          className: (Number.isInteger(gateWindow) ? gateWindow : (gate.recentWindow ?? 200)) === size
                            ? 'drc-btn drc-btn-on'
                            : 'drc-btn',
                          disabled: filling,
                          onClick: () => setGateWindow(size),
                        },
                        `${size} 章`,
                      )),
                  ),
                ),
            showMarkdown && background !== null && (background.beyondProgress?.entries ?? 0) > 0
              ? h(
                  'div',
                  { className: 'drc-note', style: { marginTop: 6 } },
                  `⚠️ 这份文件里有 ${background.beyondProgress.entries} 条记的是你还没读到的章`
                  + (Number.isInteger(background.beyondProgress.maxChapter)
                    ? `（最远到第 ${background.beyondProgress.maxChapter} 章）`
                    : '')
                  // ⚠️ 说清方向：面板如实显示（这是你的文件），但 AI 那一份被裁掉了。
                  //    不写清的话读者会以为"面板上有 ⇒ AI 也看得到"，校对时改错目标。
                  + '。面板如实显示它，但**这部分不会投喂给 AI**。',
                )
              : null,
            showMarkdown && background !== null
              ? h('pre', { className: 'drc-pre' }, background.markdown)
              : null,
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 6 } },
              '一次补齐 = 一次模型调用，花的是你自己的额度（借用你当前会话的模型路由，插件里不用配 key）。'
              + '它就在书的目录里：background.md —— 你可以直接打开改它。',
            ),
          ),
          h(
            'div',
            { className: 'drc-section' },
            h('div', { className: 'drc-item-name' }, '防剧透闸'),
            h(
              'div',
              { className: 'drc-item-sub' },
              '工具层只有两条精确规则，**都不限制 AI 的正常能力**（查史料、算数、写文件都不受影响）。',
            ),
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 6 } },
              '① 路径闸（与会话无关的硬规则）：任何工具只要参数指向本书的 content.txt / source.txt / '
              + 'chapters.json，一律拒绝 —— 否则模型可以绕过上面的投喂，自己去翻后面的章节。',
            ),
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 6 } },
              '② 联网闸：只在**绑定过的**陪读会话里生效，不影响你在别的会话里搜东西。',
            ),
            h(
              'div',
              { className: 'drc-row' },
              ...WEB_GATE_CHOICES.map((choice) => h(
                'button',
                {
                  key: choice.value,
                  type: 'button',
                  className: background?.webGate === choice.value
                    ? 'drc-btn drc-btn-on'
                    : 'drc-btn',
                  disabled: gateSaving || background === null,
                  title: choice.hint,
                  onClick: () => saveWebGate(choice.value),
                },
                choice.label,
              )),
            ),
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 4 } },
              `当前生效：${webGateLabel(background?.webGate)}。改完**立即生效，不用重启**。`,
            ),
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 4 } },
              '「完全」与「本书」给模型的措辞是一样的（都让它别联网查这本书），'
              + '区别只在**工具闸的严格程度**：前者一律拒绝，后者只拦看起来在查本书的查询。',
            ),
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 6 } },
              '⚠️ 「不主动剧透」本身不靠工具实现，靠的是 Prompt 里的守则 —— 模型可能本来就知道结局，'
              + '它只是答应不说。这是提示词层面的约束，不是技术保证。',
            ),
            // ---- 「已读完」：解锁本书的原始文本（v1.45） ----
            //
            // ⚠️ 这是全插件**唯一会放松**那条硬规则的地方 —— 所以状态必须**常驻可见**
            // （不是只体现在按钮文案上），解锁要二次确认，收回一键即时。
            h(
              'div',
              { className: 'drc-label', style: { marginTop: 10 } },
              background?.finished === true
                ? '⚠️ 已解锁：这本书的全文对陪读 AI 可见'
                : '这本书读完了吗',
            ),
            h(
              'div',
              { className: 'drc-item-sub' },
              background?.finished === true
                ? '你可以让它翻任意一章、任意一段（"帮我看看第 300 章那段"）。'
                  + '⚠️ 这**不影响每轮自动投喂的内容** —— 它平时仍然只看得到'
                  + '「本章全文 + 上一章结尾 + 背景认识」，解锁只是"你问，它才读得到"。'
                : '标记之后，**这本书**的原始文本对陪读 AI 放开（别的书照旧锁着）。'
                  + '适合你已经读完、想回头梳理或讨论全书的时候。',
            ),
            // ⚠️ **解锁要二次确认、收回一键即时**（不对称；与跳读闸、回收站同一套形态）。
            // 从前这里是浏览器原生 `window.confirm` —— 与站内那套「先讲清后果、再给两个
            // 写了动词的按钮」不统一，读者在三处确认里要各学一遍。
            background?.finished === true
              ? h(
                  'div',
                  { className: 'drc-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'drc-btn',
                      disabled: gateSaving || background === null,
                      title: '收回解锁：这本书的原文重新对 AI 关闭（立即生效，不需要确认）',
                      onClick: () => saveFinished(false),
                    },
                    '收回解锁',
                  ),
                )
              : finishConfirm
                ? confirmBar({
                    text: '解锁后，陪读 AI 可以读这本书的原文（你让它翻哪一章，它就翻哪一章）。'
                      + '⚠️ 只影响这一本书，而且**不影响每轮自动投喂的内容** —— 它平时仍然只看得到'
                      + '「本章全文 + 上一章结尾 + 背景认识」，解锁只是「你问，它才读得到」。',
                    primary: {
                      label: '确认这本书我已读完',
                      onClick: () => {
                        setFinishConfirm(false)
                        saveFinished(true)
                      },
                    },
                    secondary: { label: '取消', onClick: () => setFinishConfirm(false) },
                    busy: gateSaving,
                  })
                : h(
                    'div',
                    { className: 'drc-row' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'drc-btn',
                        disabled: gateSaving || background === null,
                        title: '解锁：这本书的原文对 AI 可见（会先让你确认一次）',
                        onClick: () => setFinishConfirm(true),
                      },
                      '标记为已读完',
                    ),
                  ),
          ),
          // ---- 导出 ----------------------------------------------------------
          h(
            'div',
            { className: 'drc-section' },
            h('div', { className: 'drc-item-name' }, '导出到笔记库'),
            h(
              'div',
              { className: 'drc-item-sub' },
              '把这本书的笔记与背景认识写成**文件名自带书名**的一组文件，直接丢进 '
              + 'Obsidian 之类的笔记软件，不必再手工改名：',
            ),
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 4 } },
              `${book.title}-笔记.md · ${book.title}-背景.md · `
              + `${book.title}-背景-压缩前.md（最新一代）· ${book.title}-背景-压缩前-<时间戳>.md（每一代各一份）`,
            ),
            h(
              'div',
              { className: 'drc-item-sub', style: { marginTop: 6 } },
              '笔记是**按 id 增量追加**：你在笔记库里写的批注、加的双链都不会被动，'
              + '重复导出也不会产生重复条目。压缩是唯一会删内容的步骤，所以每次压缩前都留一代，'
              + '导出时一代不漏。',
            ),
            // ⚠️ 导出结果**常驻**在这里，不走 toast（读者 2026-10-01）：那条结果好几行，
            //    而长文提示不自动消失 ⇒ 读者实测把它当成"弹窗不会消失"的 bug ✗。
            //    它属于"这一节的当前状态"：成功绿、失败红，并说清**上次导出是什么时候**。
            lastExport === null
              ? null
              : h(
                  'div',
                  {
                    className: lastExport.ok === true
                      ? 'drc-export-line drc-export-ok'
                      : 'drc-export-line drc-export-fail',
                    style: { marginTop: 6 },
                  },
                  lastExport.ok === true
                    ? `✅ 上次导出：${formatExportTime(lastExport.at)} → ${lastExport.dir ?? ''}`
                      + `（新建 ${lastExport.created ?? 0} · 更新 ${lastExport.updated ?? 0}`
                      + ` · 未变 ${lastExport.unchanged ?? 0}）`
                      + ((lastExport.appended ?? 0) > 0 ? `，追加了 ${lastExport.appended} 条新笔记` : '')
                      + (Array.isArray(lastExport.warnings) && lastExport.warnings.length > 0
                        ? ` ⚠️ ${lastExport.warnings.join('；')}`
                        : '')
                    : `❌ 上次导出失败（${formatExportTime(lastExport.at)}）：${lastExport.text ?? ''}`,
                ),
            h(
              'div',
              { className: 'drc-row', style: { marginTop: 6 } },
              h('input', {
                type: 'text',
                className: 'drc-input',
                style: { flex: 1 },
                placeholder: '导出目录（留空 = 本会话工作区根）',
                value: exportDir,
                onChange: (event) => setExportDir(event.target.value),
              }),
              h(
                'button',
                { type: 'button', className: 'drc-btn', disabled: savingExportDir, onClick: saveExportDir },
                savingExportDir ? '保存中…' : '记住',
              ),
            ),
            h(
              'div',
              { className: 'drc-row', style: { marginTop: 6 } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'drc-btn drc-btn-primary',
                  disabled: exporting,
                  // 导出用的**始终是记住的那个值**（不是输入框里的草稿）—— 所以"改了输入框
                  // 却忘了点记住"不会让这次导出和上一次落在不同目录。
                  // ⚠️ 导出**只有这一处入口**了（笔记页那颗同名按钮已按读者要求撤掉，原地留了
                  // 指路提示）：两个界面各放一颗一模一样的按钮，只会让人怀疑
                  // 「它们导到的是不是同一个地方」。
                  onClick: () => {
                    setExporting(true)
                    setNotice(null)
                    exportBookFiles(book.bookId, '')
                      .then((result) => {
                        // ⚠️ **不弹提示**（读者 2026-10-01）：这条结果太长，走 toast 会
                        //    **永远不消失** ✗。它改在这一节的说明里常驻显示（成功绿 / 失败红），
                        //    并把"上次导出是什么时候"记下来（每本书一份）。
                        const record = result.kind === 'ok'
                          ? { ok: true, ...result.detail }
                          : { ok: false, at: new Date().toISOString(), text: result.text }
                        setLastExport(record)
                        saveLastExport(book.bookId, record)
                      })
                      .finally(() => setExporting(false))
                  },
                },
                exporting ? '导出中…' : '导出背景与全部笔记',
              ),
              h(
                'span',
                { className: 'drc-inline-label' },
                exportDirSaved === '' ? '当前：本会话工作区根（改完记得点「记住」）' : `当前：${exportDirSaved}`,
              ),
            ),
          ),
          // ---- 人物卡：把背景认识按实体归堆的只读视图 ----
          //
          // ⚠️ 读者 2026-09-27 要求把它从「背景认识（记忆）」里**摘出来做成独立小节**、
          // 放在「讨论历史」正上方：它本来就排在那节之前，但埋在背景认识里翻起来费劲。
          // ⚠️ 服务端已经**按读者读到第几章过滤过**（`entityCardsFor` 与背景认识那个 `gap`
          // 用的是同一条边界），所以这里不必再判一次 —— 界面上的数字与卡片必须来自同一个
          // `progressIndex`，否则会出现"缺口到第 227 章，但卡片里已经写着第 900 章的事"。
          h(
            'div',
            { className: 'drc-section' },
            h('div', { className: 'drc-item-name' }, '人物卡'),
            background === null
              ? h('div', { className: 'drc-item-sub' }, '正在读取背景认识…')
              : !Array.isArray(background.cards) || background.cards.length === 0
                ? h('div', { className: 'drc-item-sub' }, '还没有人物卡 —— 补齐前文记忆之后会自动出现。')
                : h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'drc-item-sub' },
                      `共 ${background.cards.length} 张，只含你读到的部分；`
                      + '来源是 background.md 的「人物」一节，想增删就改它：',
                    ),
                    ...background.cards.slice(0, 12).map((card) => {
                      const cardKey = `${card.section}/${card.name}`
                      // 默认折叠：不在"展开名单"里就是折着的。
                      const folded = !expandedCards.includes(cardKey)
                      return h(
                        'div',
                        { key: cardKey, style: { marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--drc-line-4)' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'drc-item-sub drc-card-toggle',
                            // 与书架分类同一个交互：收起时它仍是同一个可聚焦、可切换的控件。
                            'aria-expanded': folded ? 'false' : 'true',
                            title: folded ? '展开这张卡' : '收起这张卡',
                            onClick: () => toggleCard(cardKey),
                          },
                          h('span', { className: 'drc-cat-caret', 'aria-hidden': 'true' }, folded ? '▸' : '▾'),
                          h('strong', null, card.name),
                          `　${card.entries.length} 条`,
                          card.latest > 0 ? `　最新：第 ${card.latest} 章` : '',
                        ),
                        // 收起时只留标题那一行 —— 五张卡各带两条，"屏"就是这么被占满的。
                        // 展开时仍只显示**最后两条**：这是"快速想起这个人是谁"，
                        // 不是把背景认识重念一遍（要看全文有**上面**那节的「查看 / 校对」）。
                        folded ? null : card.entries.slice(-2).map((entry, at) => h(
                          'div',
                          { key: `e${at}`, className: 'drc-item-sub' },
                          `· ${entry.slice(0, 160)}`,
                        )),
                      )
                    }),
                    background.cards.length > 12
                      ? h('div', { className: 'drc-item-sub' }, `（另有 ${background.cards.length - 12} 张未显示）`)
                      : null,
                  ),
          ),
          // 讨论历史**刻意放最后**（读者：它是最"回顾性"的一节，放在设置类区块之间会把
          // 面板读成两段）。它与上面各节没有依赖，只是位置。
          h(
            'div',
            { className: 'drc-section' },
            h('div', { className: 'drc-item-name' }, '讨论历史'),
            h(
              'div',
              { className: 'drc-item-sub' },
              '你和 AI 聊这本书的时间线。它不是对话记录的副本（会话本身就有完整记录），'
              + '而是每次「写了笔记 / 发去聊 / 抓回回应」留一小条摘要 —— 用来回答'
              + '「我们上次聊是什么时候、聊到哪一章」。',
            ),
            discussions.length === 0
              ? h('div', { className: 'drc-item-sub', style: { marginTop: 6 } }, '还没有记录。写一条笔记或发一次对话就会出现在这里。')
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'drc-item-sub', style: { marginTop: 6 } },
                    // 「被截断」必须**可见**：不说的话，读者会把最近 5 条当成全部。
                    discussionTotal > discussions.length
                      ? `共 ${discussionTotal} 条，这里只显示最近 ${discussions.length} 条。`
                      : `共 ${discussionTotal} 条。`,
                  ),
                  h(
                    'ul',
                    { className: 'drc-list', style: { marginTop: 6 } },
                    ...discussions.map((item, index) => h(
                      'li',
                      { className: 'drc-note-item', key: `${item.at}-${index}` },
                      h(
                        'div',
                        { className: 'drc-note-head' },
                        h('span', { className: 'drc-inline-label' }, describeKind(item.kind)),
                        h('span', { className: 'drc-item-num' }, item.chapterIndex === null ? '—' : `第 ${item.chapterIndex + 1} 章`),
                        h('span', { className: 'drc-item-sub' }, formatWhen(item.at)),
                      ),
                      item.thought === '' && item.excerpt === '' && item.reply === ''
                        ? null
                        : h('div', { className: 'drc-thought' }, item.thought || item.excerpt || item.reply),
                    )),
                  ),
                ),
          ),
        ),
      )
    }

    /**
     * 阅读面板本体。
     *
     * props 由槽注入：`inject: (sessionId) => ({ sessionId, getOpenSession, getSidebarRight })`。
     *     · `getOpenSession()` 用于从书架跳到某本书绑定的会话；宿主的 `sessions` 服务
     *       缺席时回 `null`（那时书架那行渲染成不可点的静态标）。
     *     · `getSidebarRight()` 用于跳过去之后把阅读页签在目标会话里显示出来。
     * ⚠️ 两者都是**取用函数**而不是取好的值（v2.1.3）：那两个服务可能在插件 `apply`
     * 之后才注册（加载顺序由 profile 的 bundles 决定），取一次就会永久拿不到 ——
     * 见 `apply` 里 2.5 / 2.6 两段的实测记录。旧形状（直接传 `openSession` /
     * `sidebarRight`）仍作为回落保留：组件冒烟用例就是直接塞它们的。
     *
     * @param {{ sessionId?: string, inputActions?: object, useInput?: Function,
     *           getOpenSession?: Function, getSidebarRight?: Function,
     *           openSession?: Function|null, sidebarRight?: object }} props
     */
    function ReaderPanel(props) {
      const { sessionId, inputActions, useInput, getOpenSession, getSidebarRight } = props
      const openSession = typeof getOpenSession === 'function'
        ? getOpenSession()
        : (props.openSession ?? null)
      const sidebarRight = typeof getSidebarRight === 'function' ? getSidebarRight() : props.sidebarRight
      /**
       * 会话输入框里已有的内容。
       *
       * 读它是为了「发到会话」不把用户正在打的字冲掉——`setDraft` 是**覆盖**
       * 语义。宿主没给 `useInput` 时退回空串，此时行为退化成覆盖，但界面上
       * 已经把话说清楚了。
       */
      const inputSnapshot = typeof useInput === 'function' ? useInput((state) => state) : undefined
      const existingDraft = typeof inputSnapshot?.text === 'string'
        ? inputSnapshot.text
        : (typeof inputSnapshot?.draft === 'string' ? inputSnapshot.draft : '')
      /**
       * 面板状态从**模块级记忆**起步。
       *
       * 切会话会卸载本面板，所以"上次在读什么"只能从模块级取回来 —— 否则读者
       * 跳过来看到的又是书架，还得再点一次那本书（这正是他反馈的问题）。
       *
       * 记忆里装的是**整层的样子**（哪本书、停在哪一层、笔记页的草稿、返回该回
       * 哪一层），不只是"哪本书"：读者在笔记页点发送，跳过去之后该接着写那条
       * 笔记，而不是被弹回正文。
       */
      const [boot] = useState(() => recallSessionView(sessionViews, sessionId) ?? null)
      const [view, setView] = useState(() => resolveRestoreView(boot?.view, boot?.draft))
      const [book, setBook] = useState(() => boot?.book ?? null)
      const [catalog, setCatalog] = useState({ chapters: [], loading: false, error: null })
      const [progress, setProgress] = useState(null)
      /**
       * 正在编的那一份东西。
       *
       * 两个来源，形状相同，**区别只在有没有 `draftId`**：
       *
       *   - **服务端草稿**（有 id）：点草稿栏里的条目接着写、或跨会话交接过来；
       *   - **未保存的起稿**（没有 id）：从正文选区进笔记页时由 `captureNote`
       *     就地装出来的那一份。它在服务端**还不存在** —— 这正是刻意的：进笔记页
       *     这个动作不该往草稿栏里塞东西（见 `captureNote`）。
       *
       * `save` / `commit` / `discardDraft` 都靠 `draftId` 的有无来分派，所以这两者
       * 能共用一条通路。它同时也是 `NotesView` 的**初值**（只读一次）。
       */
      const [activeDraft, setActiveDraft] = useState(() => boot?.draft ?? null)
      /**
       * 「正在编的是哪一份」的世代号 —— `NotesView` 的 `key`。
       *
       * `NotesView` 把 props 只读进 `useState` 的**初值**，之后不再听 prop（这是
       * 刻意的：编辑框不能让服务端的旧值盖掉读者刚敲的字）。所以"换一个编辑目标"
       * 只能靠**重挂**来表达，而重挂需要一个会变的 `key`。
       *
       * ⚠️ 这个 `key` **不能**再写成 `activeDraft?.draftId`。从前可以，因为起稿是
       * 一发 POST、`draftId` 由服务端的响应带回来；现在起稿是同步的（见
       * `captureNote`），而**保存**之后面板会从 `onDraftChange` 拿到真实的
       * `draftId` —— 那时候换 key 会把 `NotesView` 重挂一次，`notice`
       * （"草稿已保存。"）连同编辑框里还没回写的中间态一起没掉。世代号只在
       * "换目标"时 +1，保存不算换目标。
       *
       * 它同时是把老 `key` 的**意图**保留下来：不依赖"换目标恰好也换了视图"
       * 这个偶然性质。这个 `key` 是**功能性的，不是性能优化** —— 别顺手删掉。
       */
      const [noteEpoch, setNoteEpoch] = useState(0)

      /**
       * `NotesView` 的编辑内容回传。
       *
       * ⚠️ 必须是**稳定引用**（`useCallback` 空依赖）。它会出现在 `NotesView`
       * 那个上报 effect 的依赖里，每次渲染换一个新函数就会形成
       * "上报 → 面板 setState → 重渲染 → 新函数 → 再上报"的**无限循环**。
       */
      const handleDraftChange = useCallback((draft) => {
        setActiveDraft(draft)
      }, [])

      /**
       * 「最后一次打开的书才是当前书」的守卫。
       *
       * 之前这里**没有身份校验**：连着点开 A、B 两本书（或书很大、目录解析慢）
       * 时，A 的响应可能**晚于** B 回来，于是把 B 的目录和进度覆盖成 A 的 ——
       * 界面上标题是 B、目录是 A，接着 `pickChapter` 拿 A 的章号去请求 B 的书，
       * 读到的是 B 里那个位置的章。同族的其他路径早就做对了（`ReaderView` 取正文
       * 用 `cancelled` 旗标、`saveWebGate` 用函数式更新），这里是唯一漏掉的一处。
       */
      const openGuard = useLatestGuard()

      /**
       * 「发到会话去聊」的跨会话交接（规则见 `planNoteSend` / `takeDraftHandoff`）。
       *
       * ⚠️ 交接棒装在**模块级**的 `draftHandoffs` 里，**不再**是组件状态。
       *
       * v0.13.0 用的是父层 `useState`，理由写的是"模块级变量的变化不触发重渲染，
       * 所以 sessionId 不变时 effect 不会重跑"。那个顾虑本身没错，但它防的是一个
       * **不会发生**的情况：交接只在"绑定会话 ≠ 当前会话"时才发生（见 `planNoteSend`），
       * 而那种情况下本面板必然要**换会话重挂**，这个 effect 一定跑得到。
       * 反过来，组件状态有一个致命的坏处：跳转会卸载本组件，棒子随之下葬 ——
       * 于是文字永远送不到。
       *
       * 现在的形状：按**目标会话**索引存在模块里，本面板在目标会话重挂时按自己的
       * `sessionId` 去取。于是"跳过去"这个动作本身就把棒子送到了。
       */
      useEffect(() => {
        const decision = takeDraftHandoff(draftHandoffs, sessionId, Date.now())
        // 棒子属于别的会话（还没轮到我们）：什么都别动。
        if (decision.action === 'wait') return
        // 过期或空了：清掉。留着会在很久以后突然往输入框里塞一段旧摘抄。
        if (decision.action === 'drop') {
          commitDraftHandoff(draftHandoffs, sessionId)
          return
        }
        // ⚠️ 输入框接口还没到就**先留着**，等依赖变化再来一次。这一句的位置是
        // 关键：先清后写的话，`inputActions` 晚一步注入就会把文字永久丢掉。
        if (inputActions === undefined || typeof inputActions.setDraft !== 'function') return
        // ⚠️ 合并「输入框里已有的字」必须发生在这里，而不是发送那一刻：
        // 这一层的 `existingDraft` 才是**目标会话**自己的。
        const existing = typeof existingDraft === 'string' ? existingDraft.trim() : ''
        inputActions.setDraft(existing === '' ? decision.text : `${existing}\n\n${decision.text}`)
        // ⚠️ 清空必须在**真的写进输入框之后**。反过来的话，`setDraft` 一旦抛错
        // （宿主接口换了形状），文字就从接力区消失了、而输入框里也没有 —— 两头空。
        // 放在同一个同步段里，又保证下一次 effect 不会把同一段文字再送一遍。
        commitDraftHandoff(draftHandoffs, sessionId)
      }, [sessionId, inputActions, existingDraft])

      /**
       * 「返回」该回到哪一层 —— 与"现在在哪一层"是**两件事**。
       *
       * 发送到会话发生在笔记页上，那一刻 `view` 恒为 `'notes'`。所以：
       *
       *   - 「发送」保留**层次**：跳过去之后读者接着写那条笔记
       *     （`requestHandoff` 交出去的是 `'notes'`）；
       *   - 「返回」回到**来源**：从正文里选的那段，记完回正文（`onBack`）。
       *
       * 这两件事我一度混成了一个值（交接也用了来源），结果是读者在笔记页点发送、
       * 跳过去却直接被弹回正文 —— 正在写的笔记从眼前消失，还得重新进来一次。
       * 真机反馈的那一条。
       *
       * 来源必须在**进入笔记页那一刻**记下，那时 `view` 才是真的（正文或目录）。
       * 每个入口都要记，见 `captureNote`、`ReaderView` 的「笔记」按钮与
       * `TocView.onOpenNotes`；测试里有一条反向断言把"入口数 == 记账处数"钉住，
       * 防止将来多一个入口却忘了记。
       *
       * 交接过来的面板也会带上来源（`boot.origin`）：目标会话自己没进过笔记页，
       * 它的「返回」只能靠这份种子才知道该回正文。
       */
      const noteOriginRef = useRef(typeof boot?.origin === 'string' ? boot.origin : null)

      /**
       * 把面板当前状态写进模块级记忆，供**本会话**下次重挂时取回。
       *
       * 每次 view/book/draft 变化都写一遍（写的是同一个 Map 的同一个键，很便宜）：
       * 这样"读者停在哪一页"永远是新鲜的，不需要在卸载那一刻去抢救。
       *
       * `draft` 只在笔记页记：笔记页少了草稿就还原不出来（见
       * `resolveRestoreView`），所以别的时候一律记 `null`。
       */
      useEffect(() => {
        rememberSessionView(sessionViews, sessionId, {
          view,
          book,
          draft: view === 'notes' ? activeDraft : null,
          origin: noteOriginRef.current,
        })
      }, [sessionId, view, book, activeDraft])

      /**
       * 交接：把正文放进接力区、给目标会话**播下整层种子**、并尽力打开页签。
       *
       * 三件事缺一不可：
       *   1. 正文 —— 否则读者到了那边输入框还是空的；
       *   2. 整层种子 —— 目标会话的面板可能是**这个页面里第一次**被打开，那块记忆
       *      还是空的；不播种子，读者跳过去只会看到书架，还得再点一次那本书；
       *   3. 打开页签 —— 否则面板根本不会挂载，前两件事都没人来兑现。
       *
       * ⚠️ 种子里的 `view` 是**此刻这一层**（发送发生在笔记页上，所以是
       * `'notes'`），**不是** `noteOriginRef`：读者跳过去要接着写那条笔记，而不是
       * 被弹回正文。来源另走一路（`origin`），只供那边的「返回」用。
       */
      const requestHandoff = useCallback((payload) => {
        depositDraftHandoff(draftHandoffs, payload?.sessionId, payload?.text, Date.now())
        rememberSessionView(sessionViews, payload?.sessionId, {
          view: payload?.view ?? 'notes',
          book: payload?.book ?? book,
          // 草稿一起交出去：目标会话的笔记页要靠它才渲染得出内容。
          draft: payload?.draft ?? activeDraft,
          origin: payload?.origin ?? noteOriginRef.current ?? 'reader',
        })
        revealReaderTab(sidebarRight, payload?.sessionId, (fn, delay) => setTimeout(fn, delay))
      }, [book, activeDraft, sidebarRight, noteOriginRef])

      /** 打开一本书：拉目录与进度。 */
      const openBook = useCallback((nextBook) => {
        const ticket = openGuard.issue()
        setBook(nextBook)
        setView('toc')
        setCatalog({ chapters: [], loading: true, error: null })
        setProgress(nextBook.progress ?? null)
        Promise.all([
          callApi(`/books/${nextBook.bookId}/chapters`),
          callApi(`/books/${nextBook.bookId}/progress`),
        ])
          .then(([toc, prog]) => {
            if (!openGuard.isCurrent(ticket)) return
            setCatalog({ chapters: toc.chapters ?? [], loading: false, error: null })
            setProgress(prog.progress ?? null)
          })
          .catch((error) => {
            if (!openGuard.isCurrent(ticket)) return
            setCatalog({ chapters: [], loading: false, error: describeError(error) })
          })
      }, [openGuard])

      /**
       * 重挂时把目录与进度补上。
       *
       * `book` 是从记忆里直接拿到的，还没有目录 —— 不补这一次，`ReaderView` 会因为
       * `chapters` 是空的而渲染不出正文。
       */
      const bootedRef = useRef(false)
      useEffect(() => {
        if (bootedRef.current) return
        bootedRef.current = true
        if (book !== null) openBook(book)
      }, [book, openBook])

      /**
       * 重挂后把读者送回他刚才待的那一页。
       *
       * 为什么不直接在初始化时 `setView('reader')`：`ReaderView` 需要
       * `chapters[chapterIndex]`，而目录要靠 `openBook` 现拉；目录没到就切过去，
       * 会渲染出一个没有正文的阅读页。所以这里等目录落地再落点。
       */
      const restoreRef = useRef(
        book === null
          ? null
          : { bookId: book.bookId, view: resolveRestoreView(boot?.view, boot?.draft) },
      )
      useEffect(() => {
        const step = resolveRestoreStep(restoreRef.current, book, catalog)
        // 读者自己换了书：那是他主动选的另一本，不该被塞进阅读页。
        if (step === 'drop') {
          restoreRef.current = null
          return
        }
        // ⚠️ `stay` 时**绝不能**清待办。
        //
        // 挂载那一趟 `catalog` 是初始的 `{ chapters: [], loading: false }`，
        // 而 `openBook` 要到**同一次提交的另一个 effect** 里才把它置成 loading。
        // 老代码在这一趟就清了待办、又因为章节为空而 return，于是目录真到位时
        // 已经没得还原 —— 从笔记页跳过去停在目录页。消费必须发生在真正落点这一刻。
        if (step !== 'apply') return
        const pending = restoreRef.current
        restoreRef.current = null
        setView(pending.view)
      }, [book, catalog])

      /** 选章：同章保留原偏移，换章从章首开始。 */
      const pickChapter = useCallback(
        (chapter) => {
          // `charOffset` 可给可不给：目录点一章是"从章首开始读"（0），而笔记的
          // 「跳到这一段」要落在**具体那一段**上（锚点里一直记着它，见
          // `lib/host/notes.js` 的 `charOffset`）。
          //
          // ⚠️ 同章 + **带偏移**时必须更新进度：否则"从笔记页跳回本段"会因为
          // "章号没变"被当成无事发生，落到上次的位置上（跨章那条路不受影响）。
          const offset = Number.isFinite(chapter.charOffset) && chapter.charOffset > 0 ? chapter.charOffset : 0
          setProgress((prev) => {
            if (prev !== null && prev.chapterIndex === chapter.index && offset === 0) return prev
            return { chapterIndex: chapter.index, charOffset: offset }
          })
          setView('reader')
        },
        [],
      )

      /**
       * 「回到原文」：从回顾列表跳回那条笔记所属的章。
       *
       * ⚠️ 必须包 `useCallback`：`NoteList` 是 `memo` 组件，而**函数 prop 每次换引用
       * 都会让整张列表重渲染** —— 那正是当初把它抽成 memo 的理由（见 `NoteList` 的
       * 说明）。传内联箭头函数就会把那个优化悄悄抵消掉。
       */
      const jumpToChapter = useCallback(
        (index, charOffset) =>
          pickChapter({ index, charOffset: Number.isFinite(charOffset) ? charOffset : 0 }),
        [pickChapter],
      )

      const navigate = useCallback((nextIndex) => {
        setProgress({ chapterIndex: nextIndex, charOffset: 0 })
      }, [])

      const backToShelf = useCallback(() => {
        setView('shelf')
        setBook(null)
      }, [])

      /**
       * 从正文选区**起一条草稿**，并切到笔记视图。
       *
       * ⚠️ 这里**不落服务端**。
       *
       * 从前它会立刻 POST 一条草稿到宿主，理由是"读者写完感想要去会话里发给 AI、
       * 拿到回应之后才回来点写入，这中间可能隔一次刷新"。但那样做的代价是：
       * **光是进一趟笔记页，就会在「未落盘的草稿」里多出一个条目** —— 读者可能
       * 只是想看看，却在草稿栏里留下了一条他从没保存过的东西（真机反馈）。
       * 而草稿栏是"我存过哪些"的清单，不该被浏览动作污染。
       *
       * 现在的规则和正文顶部那颗「笔记」按钮**完全一致**：进笔记页只把选区装进
       * 编辑框，服务端的记录等读者点「保存草稿」（或「写入笔记」）才产生。于是
       * "草稿栏里出现的东西"恰好等于"读者亲手存过的东西"。
       *
       * 代价与兜底：未保存的内容只活在内存里 —— 但 `NotesView` 会把编辑内容一路
       * 上报给面板（`onDraftChange`），而面板每次变化都写进**模块级会话记忆**，
       * 所以切页签、切会话回来都还在。真正会丢的只有"整页刷新"。
       *
       * 顺带消失的是从前的 `captureGuard`：它挡的是"两次起稿的 POST 乱序"，而
       * 现在起稿是同步的，没有响应会晚到。
       */
      const captureNote = useCallback((payload) => {
        // 来源恒为正文：`captureNote` 只从 `ReaderView` 的选区弹出层调用
        // （见 `onCaptureNote`）。记下来，"发到会话"跳过去才能回到正文。
        noteOriginRef.current = 'reader'
        const chapterIndex = progress?.chapterIndex ?? 0
        // 形状与**服务端草稿**一致，唯独没有 `draftId` —— `save` / `commit` 正是
        // 靠"有没有 id"决定要不要先建记录（见 `NotesView` 里的说明）。
        setActiveDraft({
          excerpt: payload?.excerpt ?? '',
          charOffset: payload?.charOffset ?? null,
          chapterIndex,
          chapterTitle: catalog.chapters[chapterIndex]?.title ?? '',
          thought: '',
          reply: null,
          tags: [],
        })
        setNoteEpoch((epoch) => epoch + 1)
        setView('notes')
      }, [catalog.chapters, progress])

      // ⚠️ 这里**刻意没有**「切章就自动补记忆」。
      //
      // 早期版本在每次切章时后台发一次补齐，于是一本 300 章的书会起 300 个子代理
      // ——读者实测反馈"每一章都会生成一个子代理去概括，这样设计有点问题"。
      // 现在补齐只在一处触发：**你发笔记的时候**（见 NotesView 的 sendToChat）。
      // 那次是阻塞的，补完才把你的感想送进会话，所以你聊的时候记忆一定是新的。
      //
      // 代价是：如果你只读不聊，背景认识不会增长。这是刻意的取舍——记忆只在
      // 要用的时候才值得花钱去建。

      // `book !== null` 是**新加的**守卫：`'notes'` 从前只可能由用户动作进入
      // （那时必然已经打开了一本书），现在它还能从模块级记忆里还原出来，而记忆
      // 里的 `book` 允许是 `null`。少了这个判断，`NotesView` 会拿着 `null` 去读
      // `book.bookId` 而白屏 —— 退回书架是更好的失效方向。
      if (view === 'notes' && book !== null) {
        return h(NotesView, {
          // ⚠️ 这个 `key` 是**功能性的，不是性能优化**（理由见 `noteEpoch`）。
          //
          // 它替代了从前那个按 `activeDraft?.draftId` 算出来的 key：那个写法在起稿
          // 同步化之后会**在保存那一刻**变，把 `NotesView` 重挂掉，于是"草稿已保存。"
          // 连同编辑框里还没回写的中间态一起消失。
          //
          // 测试替身不做状态更新，所以这条路径在单测里渲染不出来 —— 上一版的
          // 摘抄丢失 bug（`useState` 初值不重跑）就是**靠读时序发现的**。
          key: noteEpoch,
          book,
          activeDraft,
          sessionId,
          // 返回要**回到进来的地方**，不是固定的目录。
          //
          // 从正文选区起稿时，笔记页的上一层是正文；写死 `'toc'` 的话，读者记完
          // 笔记点返回会掉到目录，得重新找章、重新滚回原来那一段 —— 真机反馈的
          // 就是这一条。
          //
          // 来源由两个入口在进入笔记页时写下（`noteOriginRef`），和「发送到会话」
          // 播给目标会话的视图种子**是同一个值**，所以返回与跳转的落点永远一致。
          onBack: () => setView(noteOriginRef.current ?? 'toc'),
          onJumpToChapter: jumpToChapter,
          inputActions,
          existingDraft,
          openSession,
          requestHandoff,
          // 编辑内容一路回报给面板：**未保存的起稿**已经没有服务端记录可依靠了，
          // 只能靠这条线进到会话记忆里，切页签/切会话回来才还在。
          onDraftChange: handleDraftChange,
        })
      }

      if (view === 'shelf' || book === null) {
        return h(
          'div',
          { className: 'drc-root' },
          h(ShelfView, { onOpen: openBook, openSession }),
          sessionId === undefined
            ? null
            : h('div', { className: 'drc-item-sub', style: { padding: '0 10px 8px' } }, `会话 ${sessionId.slice(0, 12)}…`),
        )
      }

      if (view === 'toc') {
        return h(TocView, {
          book,
          chapters: catalog.chapters,
          progress,
          loading: catalog.loading,
          error: catalog.error,
          onBack: backToShelf,
          onPick: pickChapter,
          onOpenCompanion: () => setView('companion'),
          onOpenNotes: () => {
            // 从目录进的笔记页：来源记成目录，跳会话后该回目录而不是正文。
            noteOriginRef.current = 'toc'
            setActiveDraft(null)
            setNoteEpoch((epoch) => epoch + 1)
            setView('notes')
          },
        })
      }

      if (view === 'companion') {
        return h(CompanionView, {
          book,
          sessionId,
          // ⚠️ 面板必须知道**读者正在看哪一章**：缺口要按它算（落盘的进度可能因为
          // "跳章后没滚动"而停在很久以前），补齐请求也要靠它把边界推到位。
          // 用本地 `progress` 而不是服务端那份 —— 前者跟着翻页走，后者是滞后的。
          currentChapter: progress?.chapterIndex ?? null,
          onBack: () => setView('toc'),
        })
      }

      return h(ReaderView, {
        book,
        chapters: catalog.chapters,
        chapterIndex: progress?.chapterIndex ?? 0,
        initialOffset: progress?.charOffset ?? 0,
        // 已读完解锁时给正文页一项**常驻标记**（漏传就是一个不报错的洞 —— 同 `onOpenNotes`
        // 那次真机反馈，所以 `client.test.mjs` 里有一条接线守卫钉着它）。
        //
        // ⚠️ 从 **`book`** 上取而不是面板的 `background`：`finished` 由书架列表一起下发
        // （`library.list()` 里与 `progress` 并排），而 `background` 是**陪读面板**
        // （`CompanionView`）自己的状态，`ReaderPanel` 作用域里没有它 —— 冒烟用例当场
        // 用 `background is not defined` 抓到了这一条。
        finished: book?.finished === true,
        onBack: () => setView('toc'),
        onNavigate: navigate,
        onOpenCompanion: () => setView('companion'),
        // 正文顶部那颗「笔记」按钮。
        //
        // ⚠️ 这里曾经**漏传**了这个 prop，而 `ReaderView` 内部一直都在调
        // `onOpenNotes` —— 于是那颗按钮点了毫无反应：不先在正文里选中一段，
        // 就进不了笔记页（真机反馈）。渲染层不认识"哪个 prop 忘了传"，它只是
        // 安静地什么都不做，所以这个洞只能靠用例来堵。
        onOpenNotes: () => {
          noteOriginRef.current = 'reader'
          setActiveDraft(null)
          setNoteEpoch((epoch) => epoch + 1)
          setView('notes')
        },
        onCaptureNote: captureNote,
        onOffsetChange: (charOffset) => {
          setProgress((prev) => ({ chapterIndex: prev?.chapterIndex ?? 0, charOffset }))
        },
      })
    }

    /**
     * 页签标题。
     * 与 body 分开注册在 `sidebar.right.pane.tab.title` 上。
     */
    function ReaderTitle() {
      return h('span', null, TAB_TITLE)
    }

    /**
     * 「本地书架」在右侧栏选择器里的图标（一本摊开的书）。
     *
     * ⚠️ guide 条目的 `icon` 会被宿主**当成组件渲染**，并且会传入
     * `size` 与 `className`：
     *
     *   // ui-sidebar-right/lib/client.js · EntryBox
     *   const Icon = entry.icon ?? CubeGlyph
     *   jsx(Icon, { size: description === undefined ? 22 : 26, className })
     *
     * 所以它必须容忍这两个 props，而不是一个普通 <img>。不传 `icon` 也是合法的
     * ——宿主会回落到自带的 CubeGlyph；给一个书本图形只是为了更好认。
     *
     * @param {{ size?: number, className?: string }} [props]
     */
    function ReaderGlyph(props) {
      const size = props?.size ?? 22
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: props?.className,
          'aria-hidden': 'true',
        },
        h('path', { key: 'left', d: 'M12 7.4C10.3 5.7 8.1 5 5.6 5H4v12.3h1.6c2.5 0 4.7.7 6.4 2.4' }),
        h('path', { key: 'right', d: 'M12 7.4C13.7 5.7 15.9 5 18.4 5H20v12.3h-1.6c-2.5 0-4.7.7-6.4 2.4' }),
        h('path', { key: 'spine', d: 'M12 7.4v12.3' }),
      )
    }
    //#endregion

    //#region 插件体
    /**
     * 需要宿主浏览器侧已就绪的服务。
     * cordis 只在服务齐备后才会跑 apply，因此 apply 里可以放心地直接取用。
     */
    const inject = ['sidebarRightTabs', 'slots']

    /**
     * 注册阅读页签。
     *
     * @param {object} ctx 浏览器侧上下文
     */
    function apply(ctx) {
      // 1) 样式。放在 apply（= materialize 期）里而不是文件顶层：
      //    模块加载器要求副作用留在 factory 闭包内。
      ctx.effect(() => installStyles(), 'dsh-reading-companion: styles')

      // 2) 先登记 tab **类型**。
      //    priority 用 'extension'（= 默认 band），不会顶掉任何 builtin 类型。
      //
      //    ⚠️ `guide` 不是可有可无的装饰，**右侧栏那个「+」选择器完全由它构建**：
      //
      //      // @deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js
      //      refresh() {
      //        this.cached = this.active().map((entry) => entry.definition)
      //        this.guideEntries = this.cached.flatMap((d) => (d.guide ?? []).map((e) => ({
      //          ...e, kind: d.kind,
      //        }))).sort((left, right) => left.order - right.order)
      //      }
      //
      //    也就是说：**没有 guide 的类型，注册得再正确也不会出现在菜单里**，
      //    而它不会有任何报错——只是"看不见"。这正是"没看到入口"的成因。
      //    条目形状对齐官方 ui-sidebar-files 的 filesDefinition()。
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => TAB_TITLE,
            guide: [
              {
                order: 90,
                title: () => TAB_TITLE,
                description: () => '本地 TXT 阅读 · 不剧透的 AI 陪读 · 摘抄笔记',
                icon: ReaderGlyph,
              },
            ],
          }),
        'dsh-reading-companion: tab type',
      )

      // 2.5) 会话导航（书架 → 跳到某本书绑定的那个会话）。
      //
      //      用 `ctx.get` 而**不是**把它写进 inject 数组：`sessions` 是宿主客户端
      //      的核心服务，但硬依赖意味着它一旦缺席**整个插件都不挂载**——书架、
      //      正文、笔记会一起消失。为一个便利按钮赌上整个插件不划算。
      //      拿不到就只是不渲染那个按钮，其余功能一律照常。
      //
      //      ⚠️ **必须惰性取用**（v2.1.3 修）：`sessions` 在 `apply` 那一刻**可能还没
      //      注册** —— 客户端插件的加载顺序由 profile 的 bundles 与各插件自己的
      //      `inject` 决定，读者新装一个插件就可能把我们排到它后面。2026-09-27 实测：
      //      读者装了 dsh-dream-skin 之后，书架那一行的「已绑定 · 跳过去」整块退化成
      //      **不可点的静态标「已绑定会话」**（`shelfBindingState` 的三条分支里，
      //      `canJump` 直接成了 false）。从前是在这里取一次、把结果当 prop 传下去，
      //      于是那种情况下**永久**拿不到。现在只留一个取用函数，面板每次渲染现取。
      const resolveOpenSession = () => {
        const current = ctx.get('sessions')
        return current === undefined || typeof current.open !== 'function'
          ? null
          : (id) => current.open(id)
      }

      // 2.6) 侧边栏控制器：用来在**跳过去之后**把阅读页签在目标会话里显示出来。
      //
      //      它是宿主 ui-sidebar-right 提供的公开服务
      //      （`ctx.reflect.provide("sidebarRight", controller)`）。同样用 `ctx.get`
      //      而不是写进 `inject` 数组：它缺席只该让"自动打开页签"降级成"自己点
      //      一下"，绝不该拖垮整个插件。**同样是惰性取用**（同上一条的理由）。
      const resolveSidebarRight = () => ctx.get('sidebarRight')

      // 3) 页签本体。keyed 槽的键 = 类型 id。
      //    用 slots.inject 等槽出现再注册，避免与 sidebar-right 的装配顺序竞争。
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                // 槽把 sessionId 交给我们；一本书绑一个会话就靠它。
                // `sidebarRight` 一起带进去：跳过去之后要靠它把页签在目标会话里
                // 显示出来（拿不到就只是不自动开，其余照常）。
                // ⚠️ 传的是**取用函数**不是取好的值：服务可能还没注册（见 2.5 的说明）。
                // 面板每次渲染自己现取一次，所以"服务晚到"也能补上那个按钮。
                inject: (sessionId) => ({ sessionId, getOpenSession: resolveOpenSession, getSidebarRight: resolveSidebarRight }),
              },
              ReaderPanel,
            ),
          ),
        'dsh-reading-companion: reader pane body',
      )

      // 4) 页签标题。
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, ReaderTitle),
          ),
        'dsh-reading-companion: reader pane title',
      )
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    /**
     * 仅供单测使用的内部句柄。
     * 宿主加载器只读 `apply` / `inject`，这个字段不影响运行时；
     * 但把纯函数暴露出来，才能在不拉起一整套 React 的前提下测它们的边界。
     */
    exports.__internals = {
      buildParagraphs,
      findParagraphIndex,
      positionKey,
      shouldRestorePosition,
      groupByVolume,
      isVolumeOpen,
      noteSummary,
      clampNoteText,
      // 状态文件损坏的提示文案（P2-2）：纯函数，所以要能单测 —— 它是"说人话"的全部。
      quarantineNoticeText,
      NOTE_SUMMARY_CHARS,
      NOTE_CLAMP_CHARS,
      filterChapters,
      TOC_FILTER_MIN,
      percentOf,
      progressLabel,
      formatBytes,
      chapterHeading,
      groupBooksByCategory,
      UNCATEGORIZED,
      // 折叠：规整 + 切换是纯函数（读/写 localStorage 那两个不导出——它们要一个真存储，
      // 而这里要测的是"任何垃圾进来都不该抛错"）。两个键都导出：**它们是契约**，
      // 改字符串 = 读者已经收起/展开的东西会自己翻回去。
      normalizeNameSet,
      toggleNameInSet,
      SHELF_COLLAPSED_KEY,
      CARDS_EXPANDED_KEY,
      NEW_CATEGORY,
      shelfBindingState,
      // 收件箱路径以宿主答复为唯一权威（配置改了要跟着变，见函数说明）；
      // 挑"打开文件夹"的应用靠清单，不靠平台判断。
      resolveInboxPath,
      pickFileManagerApp,
      FILE_MANAGER_APP_IDS,
      // 导入结束的那句话：搬走了要说、没搬不许说（纯函数，有专测）。
      importOutcomeText,
      copyText,
      openPathInFileManager,
      // 导入说明的**判定规则**是纯函数（什么时候说、说什么、什么时候闭嘴），
      // 所以它单独可测；组件只是把它画出来。
      importNotes,
      planNoteSend,
      takeDraftHandoff,
      depositDraftHandoff,
      commitDraftHandoff,
      rememberSessionView,
      recallSessionView,
      resolveRestoreView,
      resolveRestoreStep,
      revealReaderTab,
      REVEAL_RETRY_DELAYS,
      // 两个模块级 Map 也交出去：单测要在用例之间清空它们（它们是整个页面共享的，
      // 不清会串用例），而"跨会话存活"这条性质本身也正是靠它们验证的。
      draftHandoffs,
      sessionViews,
      DRAFT_HANDOFF_TTL_MS,
      callApi,
      // 导出：两个入口共用它，所以行为与文案只有一份（见函数上的说明）。
      exportBookFiles,
      gatePromptOf,
    confirmBar,
      memoryFillClause,
      runFillLoop,
      fillOutcomeNotice,
      normalizeId,
      describeKind,
      formatWhen,
      webGateLabel,
      webGateShort,
      WEB_GATE_CHOICES,
      recordDiscussion,
      createLatestGuard,
      clampFontPrefs,
      fontStackOf,
      fontStyleOf,
      // 纸感：0 = 返回空对象（一个字节都不加），这是"不打架"的可证伪定义。
      paperStyleOf,
      PAPER_MAX,
      PAPER_STEP,
      loadFontPrefs,
      saveFontPrefs,
      FONT_FAMILIES,
      DEFAULT_FONT_PREFS,
      FONT_PREFS_KEY,
      API_ROOT,
      TAB_ID,
      TAB_KIND,
      TAB_TITLE,
      // 组件本体也暴露出来：单测会把它们**真的执行一遍**（用一个迷你渲染器
      // 逐层调用函数组件），这样组件体里的拼写错误、属性访问错误才会在
      // 测试里炸掉，而不是等用户点开面板才白屏。
      ReaderPanel,
      ShelfView,
      TocView,
      ImportNotes,
      ReaderView,
      CompanionView,
      NotesView,
      NoteList,
      TopBar,
      ReaderGlyph,
    }
    return module.exports
  },
})
