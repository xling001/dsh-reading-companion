# 打包契约：一个 DSH 插件在磁盘上必须长什么样

> **这份文件是从 DSH 的运行时代码里读出来的，不是从文档抄的。**
>
> 截至本仓库发布时，DSH 安装包内**没有任何插件开发文档**——整个 `resources/app`
> 目录（除 `node_modules`）里一个 `.md` / `.txt` 都找不到。所以"发布规范"没有
> 权威出处，只能以**加载器的实际行为**为准。
>
> 下面每条都标了**证据位置**（`文件:行号`），方便 DSH 升级后回来复核。

---

## 1. 三个字段决定一切

`package.json` 里只有三个字段参与插件装配：

| 字段 | 作用 | 证据 |
|---|---|---|
| `exports["./client"]` | **浏览器半边**的入口，宿主唯一会读的客户端文件 | `@deepseek-ai/dsh-client-modules/lib/index.js:158` |
| `dsh.client` | 声明这是个 Web 客户端插件 | 同上 `:649-655` |
| `dsh.bundle.patch` | 宿主半边要应用的 cordis patch 文件 | `resources/app/lib/profile-39RdjuE6.js:448` |

### `exports["./client"]`

```jsonc
"exports": {
  ".": "./lib/index.js",         // 宿主半边（ESM，可以 import）
  "./client": "./lib/client.js", // 浏览器半边
  "./package.json": "./package.json"
}
```

接受**两种形状**：字符串，或带 `default` 的一层条件对象
（`:155` 的注释：*accepting the string and one-level conditional forms*）。

> ⚠️ **声明了 `dsh.client` 却没有 `exports["./client"]` = 启动即抛错**，不是静默忽略：
>
> ```
> client-modules: <pkg> declares dsh.client but exports no "./client" bundle
> ```
>
> 证据：`:655`。

### `dsh.client`

```jsonc
"dsh": {
  "client": {
    "platform": "web",   // 必填且必须是字符串；只有 "web" 会被装配
    "inject": []         // 可选：声明需要先物化的其他客户端包
  }
}
```

- `platform` 不是字符串 → **抛错**（`:144`）。
- `platform` 不等于 `"web"` → **静默跳过**（`:650-653` 直接 `return null`）：
  这个包不会进客户端图，**也不会报错**。这个失效方向很容易让人白查半天。
- `inject` 必须是字符串数组（`:145`）。
- 还有两个字段在代码里被读取，但没有出现在任何说明里：
  `external`（默认 `[]`，`:661`）与 `immediately`（默认 `false`，`:662`）。

### `dsh.bundle.patch`

```jsonc
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

宿主启动时按这个路径读 patch，把插件那一行 `insert` 进 cordis 组合
（`resources/app/lib/profile-39RdjuE6.js:448`）。

---

## 2. 客户端半边是**普通脚本**，不是 ESM

这条最容易搞错，也是本仓库"`lib/client.js` 不拆文件"这个结论的根据。

- `lib/client.js` 被 **`readFileSync` 读成字符串**，与其它插件的 bundle 用 `;`
  拼接成一个 combo 脚本注入页面。
- 所以它**不能**用 `import` / `export`，也不能用 JSX——**没有转译步骤**。
- 它调 `window.__ModuleLoader__.load({ id, factory })` 登记一个工厂；
  **所有副作用（包括 CSS 注入）必须留在工厂闭包内**
  （`dsh-client-modules/lib/client.js:18`）。
- 客户端 `require()` 只认三样东西：platform seed 词（如 `react`）、已物化的模块、
  已登记的工厂。**三样都不是就大声抛错**（`client.js:308`）——
  它不会静默返回 `undefined`，这是好事。

**推论**：`lib/client.js` 是一个约 4000 行的单文件。这不是没整理，
而是**这个环境的形状**——拆成多文件需要打包器（就是构建步骤）
或拆成多个包（会把 profile 的单行开关变成多行必须同时正确）。
详见 `design-v1.md` 里关于拆分的那一节。

---

## 3. profile 侧的三个键

profile 的 `package.json` 里：

```jsonc
{
  "dependencies": { "dsh-reading-companion": "..." },
  "dsh": {
    "profile": {
      "bundles": [ /* ... */ "dsh-reading-companion" ],
      "patchReload": "live"
    }
  }
}
```

| 键 | 约束 | 证据 |
|---|---|---|
| `dsh.profile.bundles` | 字符串数组；**`desktopBundle` 是启动器私有的，不许出现在这里** | `lib/profile-39RdjuE6.js:321`、`lib/profile-manager-B1i2uYdj.js:75` |
| `dsh.profile.patchReload` | 只能是 `"live"` 或 `"startup"` | `lib/profile-39RdjuE6.js:427` |

> ⚠️ **`bundles` 只在启动时读一次。** `patchReload: "live"` 只覆盖
> `cordis.patch.yml` 的**内容**改动，覆盖不了"新增一个 bundle"。
> 所以装完插件**必须重启 DSH Desktop**，刷新页面不够。

### 3.1 profile 叫什么，以及 `dsh plugin` 究竟做了什么

**profile 名因平台而异，而且 Desktop 那个不是 DSH 自带的模板。**

| 你用的面 | profile 名 | 是自带模板吗 | profile 目录 |
|---|---|---|---|
| DSH Desktop | `desktop` | **否**，应用自有 | `$DSH_HOME/profiles/desktop` |
| DSH Web（`dsh web`） | `web` | 是 | `$DSH_HOME/profiles/web` |

证据：`@deepseek-ai/dsh-app-boot/lib/index.js:327-349` 的 `PROFILE_TEMPLATES` 只有
`acp` / `web` / `headless` / `sdk` / `sdk-minimal` **五个，没有 `desktop`**。
`desktop` 是**应用自有 profile**，走 `loadProfileDirectory()`（`:833-843`），
其注释原文是 *used by application-owned profiles whose package project and lifecycle
belong to that application*——所以它不走共享 Harness home 的模板初始化。

`dsh web` 就是 `--profile web` 的别名（`dsh-cmdline/lib/index.js:100`）。
目录解析见 `resolveProfileDir()`（`dsh-app-boot/lib/index.js:323-326`）：
一切都在 `$DSH_HOME/profiles/<name>` 下。

**`dsh plugin` 自己不实现安装**——它把剩余参数**原样转发给 profile 目录里的 pnpm**
（`@deepseek-ai/dsh-cmdline/lib/index.js:105`）。但 pnpm 结束后 DSH 会做一次调和
（`@deepseek-ai/dsh/lib/plugin-*.js:11-77`，函数注释以 *Reconcile `dsh.profile.bundles`
against the installed state* 开头）：

- 依赖里**声明了** `dsh.bundle` 的包 → **自动补进** `dsh.profile.bundles`；
- 已列入 `bundles`、但依赖里没有（或新版本不再声明 `dsh.bundle`）的 → **保留不动**。

所以 `dsh plugin add` 之后**不需要手动改 `bundles`**——前提是本包确实声明了
`dsh.bundle.patch`（§1）。反过来，一条列进 `bundles` 的包若**没有** `dsh.bundle`，
是**启动即抛错**（`dsh-app-boot/lib/index.js:851-852`），不是"这个包没有 patch"。

> 从 git 源安装时 pnpm 会**拦截构建脚本**（`prepare`）。DSH 会把提示写到 stderr，
> 让你把 pnpm 打印出的 key 加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`
> 后重跑（`plugin-*.js:126`）。本插件**没有构建步骤**，正常不会遇到。

---

### 3.2 前置依赖：注册到**别人的**侧边栏

本插件**自己不画侧边栏**：它往 `dsh-better-sidebar` 提供的右侧栏里注册一个页签。
这条依赖的声明方式值得单独记一笔，因为**最容易写错地方**。

| 写法 | 管什么 | 用在这里对不对 |
|---|---|---|
| `dsh.client.inject` | **客户端包之间的物化顺序** | ❌ 见下 |
| cordis 的 `inject` | **服务是否就绪** | ✅ 本插件用的是这个 |
| `peerDependencies`（optional） | 给人/工具读的元数据 | ✅ 补充声明 |

**为什么不能用 `dsh.client.inject`。** 它对应的是"**你真的 `require()` 了那个包**"：
`arriveGraphRow()` 会先递归到达 `row.inject` 里的包，再到达自己
（`dsh-client-modules/lib/client.js:252-268`）。而本插件的浏览器半边唯一的
`require()` 是 `require('react')`（`lib/client.js:31`），**并不 import
`dsh-better-sidebar` 的 bundle**。更要紧的是那个循环写的是
`if (dependency !== void 0)` ——**包不在图里就静默跳过**，
所以它连"前置没装"这件事都表达不了。

**真正起作用的是 cordis 级 `inject`**：`lib/client.js:4142`
`const inject = ['sidebarRightTabs', 'slots']`。这是 `dsh-better-sidebar`
发布的服务名；服务不出现 → cordis **不执行 `apply`、不报错、一直等**。
这正是"缺前置时界面完全没有、控制台也没有任何错误"的确切来源。

**`package.json` 里再声明一次 optional peer**，纯粹是为了让人和工具能读到它：

```jsonc
"peerDependencies":     { "dsh-better-sidebar": ">=0.19.0" },
"peerDependenciesMeta": { "dsh-better-sidebar": { "optional": true } }
```

标 `optional` 是**刻意**的：pnpm / npm 都不会因为这条声明**自动**把它装进用户的
profile。一个体积不小的第三方插件被悄悄塞进别人的环境是越界的——装什么由用户决定。
（也正因为如此，README 的「装法 A」自带一段让 DSH 主动检查并补齐前置的指令。）

---

## 4. 本仓库怎么用这份契约

- `cordis.patch.yml` 里的行 `id` **必须**等于宿主半边导出的 cordis `name`，
  否则加载器会挂上一行名字解析不到任何东西的 row。
  `test/plugin.test.mjs` 会校验这条一致性。
- patch 是**纯加法**（一个 `insert`），所以禁用/删除它就是这个插件的
  完整、无副作用的关闭开关。

---

## 5. DSH 升级后怎么复核

```bash
DSH_APP="/path/to/DSH/resources/app"

# 证据点 1：客户端半边的入口与 dsh.client 解析
grep -n 'exports\["./client"\]\|dsh\.client\|must be a string' \
  "$DSH_APP/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js"

# 证据点 2：宿主半边读 patch 的地方
grep -n 'bundle?.patch' "$DSH_APP/lib/profile-"*.js
```

如果这两条的输出形态变了，本文件就需要更新——
同时 `test/plugin.test.mjs` 大概率会先变红。
