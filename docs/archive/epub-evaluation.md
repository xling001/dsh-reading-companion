# EPUB 导入：调研记录与结论（2026-09-27）

> **结论：先不做。** 这份文件把"如果哪天要做"需要知道的事实、成本与风险一次记全，
> 免得下次又从零查一遍。**下面每条事实都注明依据**；估计值明确标为估计。

## 一、为什么先不做

1. **形态不匹配**：本插件的价值主轴是「中长篇小说 + 不剧透陪读 + 笔记/背景导出」，
   而现有 TXT 管线（编码探测 → 切章 → 进度 → 笔记 → 背景认识 → 防剧透闸 → 导出）
   **已经完整**。EPUB 带来的增量主要是"多认一种文件格式"。
2. **要做只能做"文字版"**：忠实渲染（保留原书排版/图片/竖排）需要在侧栏里塞一个
   不透明浏览上下文，等于把选区、进度、笔记、主题全部重接一遍（见 §四 C 路线）。
   而"文字版"会丢掉原书的排版与图片。
3. 读者裁定：**"epub 会比较麻烦吧，这一块不做了"**（2026-09-27）。调研后的成本判断见 §四——
   比原先以为的**便宜**（解压不用手写），但"要不要做"仍是产品决定，不是技术决定。

## 二、DSH 官方能给的（只读 `E:\DSH Desktop\resources\app` 核到）

| 结论 | 能力 | 依据 |
|---|---|---|
| ✅ 能直接用 | **`node:zlib`（含 `inflateRawSync`）** —— 解 ZIP 条目就是它 | 官方包 `dsh-session-persistence-jsonl/lib/index.js` 从 `"node:zlib"` 导入（zstd 一族 API 只有它提供） |
| ✅ 能直接用 | HTTP 路由注册（可加资源路由） | `ctx.webServer`（本插件已在用） |
| ✅ 能直接用 | 客户端 React 原子（MarkdownText / CodeBlock / 文件类型图标 / Tag） | `@deepseek-ai/dsh-client-ui-primitives` |
| 🔶 可借机制 | **文档预览注册表** `ctx.documentPreviews.register({id, extensions, loading:'bytes-complete'})` + 子槽 `sidebar.right.tab.document` | `dsh-client-ui-sidebar-documentpreview/README.zh.md` |
| 🔶 可借机制 | 客户端自定义资源协议 `ctx.resources.register({protocol, open})` + `useResource` | `dsh-client-resources/README.zh.md` |
| 🔶 可借机制 | 沙箱 iframe 渲染本地 HTML 的**完整先例**（限额：单 4 MiB / 总 32 MiB / 64 个文件；**不支持**本地 module import、CSS `url()`、fetch） | 同 README |
| ❌ 没有 | 任何 **zip/inflate 的宿主 seam**（没有 `ctx.zip` 这类服务） | 全包名清单里没有 |
| ❌ 没有 | EPUB 阅读器 / 预览 —— 官方文档预览**只认** md、代码、图片、PDF、HTML、纯文本 | 同 README |
| 📌 参考 | 官方 PDF 是**把 pdf.js 打包进客户端**（那个 `lib/client.js` 有 **6.88 MB**） | package.json + 文件体量 |

## 三、第三方已有的 EPUB 实现（许可是核过的）

| 仓库 | 许可 | 有什么 | 能复用多少 |
|---|---|---|---|
| `xrn1997/dsh-novel` | **Apache-2.0** | **真有 EPUB 解析**：`src/services/epub/` 8 文件 ≈ 4–5k 行（中央目录、**spine 计章**、保留原书目录树/插图/脚注、插图投影成 `[图片：替代文字]`、有损项落成持久「导入说明」、50 MiB 上限、含真浏览器测试） | **法律上可复用**（署名 + 保留 NOTICE）。工程上是 TS + 3 个运行时依赖（yauzl / cheerio / iconv-lite）+ 它自己的 service 分层 ⇒ **实际做法是照它的算法重写**，不是搬文件 |
| `liznee/dsh-file-resource` | **MIT** | **形态最接近我们**：宿主 Node 解析 + 路由 + 会话隔离资源；**自写 EOCD/中央目录扫描**、禁 ZIP64、条目 ≤1e4 / 展开 ≤256 MiB / 压缩比 ≤500:1、派生文本 gzip + SHA-256 去重缓存 | ⚠️ 它的 **EPUB 正文抽取没被核到**（`epub` 只出现在扩展名表与魔数校验处）——可能只做"收进来 + 当文件给出去" |
| `beancookie/dsh-plugin-anydoc` | ⚠️ **无 LICENSE** | Word/PDF/EPUB → Markdown 的 agent 工具 | **别碰**（许可不明） |
| dsh-reader / novel-forge / novel-writer / talebook | —— | 都没有 EPUB 解析 | talebook 只能借"书库托管"思路 |

参照（都是**只借鉴思路**，不是 DSH 插件）：

- **MilkFeng/lumina**（Flutter，**MIT**）：WebView 里三个绝对定位 iframe（prev/curr/next）+
  自注入分页 CSS/JS + 自定义协议从**未解压**的 zip 里按需取资源。
  ⚠️ 那条路线的引擎对**手机 App**成立，对我们在宿主 DOM 里的 React 面板不成立（见 §四 C）。
- **ahpxex/read-aware**（**AGPL-3.0** —— 只能借鉴思路，**不能抄代码**）：事件溯源 + 投影、
  FTS + 结构化检索、记忆的晋升/冲突/去重/遗忘。

## 四、三条路线的工作量（估计，含依据）

基线契约（现状）：`content.txt` = 解码后 UTF-8 全文，逐章记 **char + byte 双区间**；
`chapters.json` = 卷/章两级索引；正文在侧栏以 DOM 长页渲染；进度 = `{chapterIndex, charOffset}`；
防剧透路径闸只认 `books/<16hex>/{content,source}.txt|chapters.json`。

### A. 文字优先（推荐的第一步）

- **要写**：`lib/host/epub.js`（中央目录解析 + `inflateRawSync` + `container.xml` → OPF →
  manifest/spine → XHTML 去标签成文本）700–1000 行；`library.js` 按魔数分流 + meta 加 `format` ~150 行。
- **完全复用**：`chapters` / `notes` / 进度 / 背景认识 / 防剧透闸（spine 天然顶替切章，nav/NCX 供标题）。
- **风险**：XHTML 的编码（BOM / utf-16）、fixed-layout、deflate vs stored、ZIP64、
  加密条目要**明说失败**；**抽取后必须仍能精确累加逐章 char/byte 双区间**。
- **估计：1–2 轮 / 2–3 人日。**

### B. 文字 + 图片与基础版式（再 +1–2 轮 / 4–6 人日，累计 2–4 轮 / 6–9 人日）

- 再加：宿主资源路由（按需 inflate + MIME + 限额）150–250 行；客户端正文加白名单内联标记与 `<img>` 300–500 行。
- ⚠️ **要动的既有契约**：① `content.txt` 的**单文本假设被打破**（另存标记文件或扩契约）；
  ② **防剧透路径闸的正则必须扩到新资源目录**，否则新文件就是一个绕过口；
  ③ 笔记的文本锚（前后 32 字）仍须从**纯文本**抽，不能从标记抽；④ meta `schemaVersion` 升版。
- **风险**：EPUB 内 CSS 可能带绝对路径 / 外部字体；白名单一放宽就是 HTML 注入面。

### C. 忠实渲染（不推荐，≈ 5–8 轮 / 15–25 人日）

陡增在四处：① 浏览器半边**零依赖没有 zip**（要么手写 DEFLATE，要么每章多一次宿主往返）；
② 沙箱 iframe 得自己做 bootstrap 注入、相对资源内联限额、`<base href>`，且官方先例明确**不支持**
module import / CSS `url()` / fetch；③ **选区 / 进度 / 笔记跨浏览上下文重接**（现有客户端全部假设
同文档选区）——**最大不确定点在这里**；④ `--dsw-*` 主题变量不被 iframe 继承，要序列化进注入样式。

## 五、如果哪天真要做：建议的第一步是**探针**，不是立项

写一个最小脚本（zip → spine → 抽文本），**拿一本真实的 EPUB 跑一遍**，只回答一个问题：

> **抽取后的文本能不能精确产出"逐章 char/byte 双区间"？**

能 —— 那 EPUB 就是"多一个导入格式"，A 路线的估计成立；
不能 —— 那就得先动 `content.txt` / `chapters.json` 的契约，成本要重新估。
（这条探针半天之内能出结论，比先写 1000 行再发现契约不对便宜得多。）

## 六、来源

- DSH 安装树 `E:\DSH Desktop\resources\app`（官方包与 README，2026-09-27 读）
- 各仓库的 GitHub API（许可、文件树、体量）与 `raw.githubusercontent.com` 的源码
- 本次调研的三份深读报告：解析管线 / 引擎与翻页 / 界面与阅读设计规格
  （界面规格另存 `lumina-ui-spec.md`）
