# 参与开发

## 环境

- Node ≥ 22.19（`^22.19.0 || >=24.0.0`）
- **零依赖**：`dependencies` 是空的，**不需要 `npm install`** 就能跑测试

## 跑测试

```bash
npm run test:no-isolation   # 推荐：所有测试共享一个进程
npm test                    # 等价于 node --test（默认进程隔离，慢一些）
```

`test/cordis-integration.test.mjs` 需要本机装着 DSH。找不到时它**跳过而不是失败**——
这是刻意的（开源仓库不该因为"没装 DSH"就变红）。路径按这个顺序解析：

1. 环境变量 `DSH_APP_NODE_MODULES`（指向 `resources/app/node_modules`）；
2. `test/.dsh-app-path` 的第一行 —— **这个文件不入库**（已进 `.gitignore`），
   建议直接放本机路径，比每次设环境变量省事：
   ```bash
   echo 'E:/DSH Desktop/resources/app/node_modules' > test/.dsh-app-path
   ```
3. 桌面版的几个常见安装位置（`C:/Program Files/DSH Desktop/…` 等）。

都找不到就跳过。**别把本机路径写回测试文件**——它会让公开仓库依赖某台机器的布局。

### 测试清单

| 测试文件 | 覆盖 |
|---|---|
| `test/plugin.test.mjs` | 宿主契约：导出、patch 一致性、装配、卸载、段落自我否决 |
| `test/encoding.test.mjs` | 编码探测与解码（含手工构造的 GBK/UTF-16 真实字节）|
| `test/chapters.test.mjs` | 章节解析与误切防护（重点在**拒绝不是章节的行**，含重复目录行合并）|
| `test/library.test.mjs` | 书库往返、字节区间精确性、幂等、路径安全、`reindex` 的锚点重映射与拒绝语义 |
| `test/location.test.mjs` | 笔记落点：第一种**「根之外」的路径**，以及老数据迁移 |
| `test/spoiler.test.mjs` | **防剧透边界**：真实书籍 + 逐字断言后续章节不出现 |
| `test/injection.test.mjs` | **真正的注入路径**：`GET /context` 与 `systemPrompt.section` 两条路必须一致 |
| `test/prompt-order.test.mjs` | 注入顺序（稳定→只增→动态）、**缓存前缀稳定性**、时间感知 |
| `test/notes.test.mjs` | **只追加不重写**（逐字节比较）、AI 回应默认不落盘、草稿 |
| `test/categories.test.mjs` | 书架分类：主观归类、未分类置顶、旧数据迁移 |
| `test/tags.test.mjs` | tag 归一化严格性与建议排序 |
| `test/persona.test.mjs` | `persona.md` 三件事：不存在时不写、存在时只读、坏内容不覆盖 |
| `test/discussions.test.mjs` | 讨论时间线的**向后兼容**（老书没有这个文件）|
| `test/compact.test.mjs` | 背景认识的**预算分配与压缩**（保名 / 保号 / 真变小）|
| `test/background.test.mjs` | 背景认识的分区层与权重表 |
| `test/settings.test.mjs` | 运行期设置（联网档位不再需要改配置重启）|
| `test/memory.test.mjs` | **绝不挂死**（race 而非只 abort）、联网面精确、失败语义分明 |
| `test/routes.test.mjs` | HTTP 数据面（真 `node:http` + 真 `fetch`）|
| `test/contract.test.mjs` | 前后端路由契约（客户端路径必须有宿主路由接住）|
| `test/cordis-integration.test.mjs` | **真实 cordis 集成**：挂真宿主服务，验证 inject / 段落装配 / 工具闸 |
| `test/client.test.mjs` | 浏览器契约 + 进度锚点纯函数 + **组件冒烟执行** |

> `test/digest.test.mjs` 已并入 `spoiler.test.mjs` 与 `memory.test.mjs`；
> `test/helpers/server.mjs` 是共享的 HTTP 夹具，不是测试文件。

`test/spoiler.test.mjs` 与 `test/notes.test.mjs` 是最重要的两份。前者造一本**每章带
唯一标记**的书，把进度停在中间，逐字断言后面几章的标记一个都不在投喂文本里；后者
先往 `notes.md` 里写一段"用户的珍贵内容"，再追加两条笔记，然后**逐字节比较**原文
有没有被动过。任何一次重构让它们变红，就是剧透回归或数据丢失回归。

`test/cordis-integration.test.mjs` 是**唯一在真实宿主服务上跑的测试**：它把真的
`@deepseek-ai/cordis` + `dsh-system-prompt` + `dsh-tools` 装起来，再把本插件挂上去，
断言三个 inject 全部解析、`systemPrompt.assemble()` 真的产出了段落、
`tools.guardReason()` 真的拒了越界读取。这条测试能抓住一类别处抓不到的故障：
**inject 名字写错**——它的表现是插件静默地永远等待，连日志都没有。

## 改客户端半边（`lib/client.js`）

它是**普通脚本**、没有构建步骤，所以：

- 不能用 `import` / `export` / JSX；
- React 必须手写 `React.createElement`（文件里别名 `h`）；
- 样式是 JS 模板字符串，注入的 `<style>` 带 `data-plugin-css` 属性——
  **别改成 `data-plugin`**，那是模块系统 `claimStyles()` 认领其它 `<style>` 时用的名字；
- 改完**重启 DSH Desktop** 才生效（见 `docs/publishing.md`）。

## 硬约束（提 PR 前请确认）

1. **`npm run test:no-isolation` 全绿。**
2. **不引入构建工具、不迁框架、不做大重写。** 这个插件的价值之一就是
   "源码改完即生效、零依赖、零构建"。
3. **`notes.md` 只追加不重写。** `test/notes.test.mjs` 会**逐字节比较**；
   任何让用户已有笔记被动过的改动都会被它抓住。
4. **防剧透是硬承诺。** `test/spoiler.test.mjs` 造一本每章带唯一标记的书，
   逐字断言未读章节的标记不出现在投喂文本里。

## 关于测试替身的盲区（先读这一节再改客户端）

`test/client.test.mjs` 用的 React 替身**不执行 effect、不做状态更新**
（`useState` 返回 `[initial, () => {}]`）。这是刻意的取舍——装真 `react-dom`
需要一整套渲染栈与宿主壳。

**后果**：任何"只有状态更新之后才会走到"的分支，冒烟测试**覆盖不到**。

本项目应对它的方式是**把判定提成纯函数**并单独测。已有的先例：
`groupBooksByCategory` / `shelfBindingState` / `mergeNotesPage` / `planNoteSend` /
`resolveRestoreView` / `takeDraftHandoff`。

改客户端时请沿用它：**能提成纯函数的判定，就别留在组件里。**

这条不是洁癖。本插件有几条**静默 bug** 全都藏在替身覆盖不到的那一层，
而且都是靠真机点击才发现的——它们的共同点是**不报错、不崩溃，界面上看不出异常**：

- 「读到哪记住哪」失效（每次打开书停在章首，进度百分比却显示正常）；
- 选中原文点「记笔记」后摘抄框是空的；
- 跨会话「发到会话」跳过去之后落回目录而不是正文；
- 正文顶部那颗「笔记」按钮点了**毫无反应**（`ReaderPanel` 漏传 `onOpenNotes`）；
- 在笔记页点「发送到会话」，跳过去之后被弹回正文，**正在写的那条笔记从眼前消失**。

**发现**这些靠人在真机上一次次点击；**定位与修复**靠把判定提成纯函数之后补测。

> 最后一类（漏传 prop）有个更可扩展的堵法，值得沿用：**别钉名字，钉规律。**
> 现在的用例会取出 `ReaderView(props)` 的解构列表，再取出 `ReaderPanel` 里对
> `ReaderView` 的那次渲染调用，逐个检查每个名字在不在（`name: value` 与简写
> `name` 两种写法都算数）。将来再加 prop 忘了传，会直接报红。

### 已知的抖动：与改动无关的红 —— **已定位并修掉（两个根因）**

跑**单次**全量通常是稳定的（`fail=0`）。但过去偶尔会多出**几条与本轮改动毫无关系的**
红，而且都落在**宿主侧、碰文件和起真实 HTTP 服务器**的用例上（书库 / HTTP / 时间线 /
落盘形态 / 设定 / 注入；例如 `test/settings.test.mjs` 的 `配置契约：抽样默认值…`）。
见过两种规模：**一两条**（背靠背连跑时）与**一次 14 条**（普通全量运行里也出现过）。

**根因不是并发，是端口号本身：**

1. `fetch`（undici）按 Fetch 规范在**客户端**拒绝一批端口，抛 `Error: bad port`
   ——**即使服务端确实监听成功了**。`6665–6669` 是**五个连续**端口。
2. Windows 是**顺序分配**临时端口的（实测连起 40 个 server → 41227、41228、…）。
3. 临时端口区间默认是 49152–65535，但**可以被改成从 1024 起**
   （`netsh int ipv4 show dynamicport tcp` → `Start Port: 1024 / Number: 58977`）。
   区间一旦覆盖 6000 / 6566 / 6665–6669 / 6679 / 6697 / 10080，就会规律性地踩。

于是端口指针每跑一次全量就往上走几十个：**扫过 6665–6669 那一段时一次跑连红五条
以上，走过去了就连续多次全绿**——"偶发一两条 / 一次 14 条 / 紧接着 6 次 fail=0"
三件事由此全部对上。

⚠️ **`--test-concurrency=1` 不是修复**：`listen(0)` 的次数与分配到的端口序列几乎没变，
它只是**刚好没踩到**。真正的修法是 `test/helpers/server.mjs` 的 `listenOnSafePort()`
——拿到端口后复检，命中禁用集合就关掉重挑；并新增 `test/harness-ports.test.mjs`
把这条性质钉住（含"绑定 6665 的服务器 fetch 确实访问不到"这条现象本身）。

**第二个根因（后来才抓到）：夹具目录名会被两次运行复用。**

夹具目录一直是 `${tag}-${进程号}-${序号}`。而 **Windows 会重用进程号**，序号在
同一文件的同一调用位置又是确定的 —— 于是两次不同的运行可能算出**完全相同的路径**；
那些测试大多不清理自己，于是**读到了上一轮的残留**。

实测证据：`test/.tmp/discussions-prefix-10500-24/discussions.jsonl` 里有 **4 条**记录，
正是"上一轮遗留 2 条 + 本轮又写 2 条"，于是一条只写两条的用例断言 `4 !== 2` 失败。
表现是**20 条与当轮改动毫无关系的红**，落在书库 / 时间线 / 压缩 / 跳读闸上。

修法：**所有夹具目录名加上 `Date.now()`**（要撞得同时满足"同进程号 + 同一毫秒 +
同序号"）。⚠️ 只改**含 `join(` 的行**，不做无差别替换 —— `process.pid` 在别处可能有
别的用途。加完之后旧目录再也不会被命中，**不需要**清理 `test/.tmp`
（清理只是顺手；不清也不会再出问题）。

> 两次踩坑的共同形状值得记住：**"与改动无关的红"不是玄学，是环境里的一个确定性
> 机制** —— 一次是端口号，一次是路径复用。所以遇到它，第一动作是**去量环境**
> （`netsh int ipv4 show dynamicport tcp`、`ls test/.tmp | measure`），
> 而不是重跑、也不是怀疑自己的改动。

**处置**（保留）：遇到无法归因的红，**单独重跑那一条**，再连跑 3 次干净全量。
**不要**把它当成"变异被抓住了"的证据 —— 归因不实的红既不算成果，也不算回归。

## 代码结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半边入口：路由表、错误语义映射、服务发布 |
| `lib/host/paths.js` | 路径安全：containment、禁 `..`/绝对路径/UNC/NUL |
| `lib/host/atomic-json.js` | 原子落盘 + `revision` CAS |
| `lib/host/encoding.js` | TXT 编码探测（BOM → UTF-16 启发式 → 严格 UTF-8 → GB18030）|
| `lib/host/chapters.js` | 章节解析：两遍扫描 + 统计打分 + 定长分块回退 |
| `lib/host/library.js` | 书库：导入、目录、按章读取、进度、会话绑定、已读窗口、笔记与草稿 |
| `lib/host/spoiler.js` | 防剧透：进度切片、`{{` 转义、untrusted 信封、工具闸判定（纯函数）|
| `lib/host/notes.js` | 笔记：Markdown 渲染/解析、**只追加**落盘、草稿库 |
| `lib/host/tags.js` | 自动打 tag：词表 + 加权建议（唯一分类入口，可替换）|
| `lib/host/background.js` | 背景认识：解析/渲染/合并、覆盖区间、缺口、抽样投喂（纯函数）|
| `lib/host/compact.js` | 背景认识的**压缩**：保名 / 保号 / 真变小三道校验，任一不过就整批丢弃 |
| `lib/host/discussions.js` | 讨论时间线：每行一条摘要、按 limit 注入（**不是**对话副本）|
| `lib/host/memory.js` | 记忆补齐：一次调用处理整段缺口、联网面由 `toolFilter` 精确控制 |
| `lib/host/subagent-run.js` | 「跑一次子代理」的共用机制——`memory.js` 与 `compact.js` 都走它 |
| `lib/client.js` | 浏览器半边：页签注册与「书架 → 目录 → 正文 → 笔记 → 陪读」面板 |
| `cordis.patch.yml` | 装配行（`id` 必须等于宿主半边的 `name`）|
| `test/*.test.mjs` | 零依赖测试（清单见上）|
| `scripts/link-into-profile.mjs` | 幂等、可回滚的 profile 安装/卸载 |
| `scripts/reindex-books.mjs` | 让书架里**已有**的书吃到新的切分规则（默认预演，`--apply` 落盘并备份）|
| `docs/design-v1.md` | 设计稿：契约、数据模型、关键算法、共存矩阵、风险清单、逐条修订史 |
| `docs/manual-testing.md` | 发版前的真机回归清单（P1–P19）|
| `docs/publishing.md` | **打包契约**：一个 DSH 插件在磁盘上必须长什么样 |
| `docs/frontend-audit-v1.md` | 外部前端审查报告 —— **v0.10.0 的时间点快照**，不是当前状态 |

## Windows 贡献者注意

**不要用 PowerShell 5.1 改写这些文件。**

`Get-Content -Raw` / `Set-Content` 在 Windows PowerShell 5.1 下默认按系统 ANSI
代码页（简中为 GBK）处理**无 BOM 的 UTF-8**，会把整个文件的中文变成乱码；并且
因为 GBK 会把汉字末字节和后面的引号/换行当成一个双字节字符吃掉，**这个过程是
有损的、不可逆的**。

用编辑器改，或用 `pwsh`（PowerShell 7）、Node 脚本。
