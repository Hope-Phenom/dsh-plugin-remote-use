# 02 — DSH 插件装配机制 & 局域网主机↔从机传输可行性

> 只读调研报告。调研期间除 `F:\WorkSpace\dsh-plugin-remote-use\.research\` 下的解包镜像外，未修改任何文件、未安装依赖、未运行宿主。
>
> **证据路径约定**：本文用 `app.asar/dsh/node_modules/@deepseek-ai/<pkg>/...` 表示 asar 内原始路径；对应已解包的本地镜像在 `F:\WorkSpace\dsh-plugin-remote-use\.research\asar\@deepseek-ai\<pkg>\...`（内容逐字节相同，行号一致）。第三方插件样本用其磁盘绝对路径。
>
> **解包方法**：asar 前 16 字节 pickle，偏移 12 处 uint32LE = header JSON 长度；header 内每个 entry 的 `offset` 相对 `16 + headerSize` 起算。工具脚本：
> - `.research\asar-tool.mjs`（`list` / `sizes` / `extract`）
> - `.research\asar-extract-all.mjs`（按正则批量解包）
>
> 已解包：`@deepseek-ai/**` 全部 2911 个条目 / 52.2 MB；根级 `package.json`、`dsh/package.json`、`dsh/desktop-runtime.json`；`@agentclientprotocol/sdk`、`@modelcontextprotocol/{client,core}`、`ws`、`got` 的 manifest。
>
> **本机 DSH 版本**：`0.2.0-rc.2`，Node `24.18.1`，pnpm `11.7.0`
> 证据：`app.asar/dsh/desktop-runtime.json:1-10`

---

## A. 插件装配机制

### A1. 一个 DSH 插件包的完整形态

**结论**

1. 插件包 = 一个普通 npm 包 + `package.json` 里的 `dsh` 字段。Host-only 插件**零依赖、零构建**，只需 `exports` 指向 `index.js` 和 `dsh.bundle.patch` 指向一个 YAML 补丁文件（`host-plugin.md:7-27`）。
2. `dsh.bundle.patch` 是**补丁文件路径**（可为数组），该 YAML 是一个顶层数组，元素为 Loader patch entry。`dsh.client` 是**浏览器半边声明**，只对"双面插件"有意义；纯 Host 插件不需要它。
3. `insert:` 的语义：**追加** entry，而不是替换；`- id: X` + `insert:` 表示插进 id 为 X 的 **group** 的 `config` 数组里（`app-boot:73-90`）。非 insert 的 patch 按 `id` 定位已有行，**`config` 整体替换而非深合并**，`name` 只做断言不改名，匹配不到就 warn 并跳过（`app-boot:2760`，`app-boot:91-99`）。
4. `dsh.profile.bundles` 是 profile 的 bundle 顺序表；启动时按 `bundles` 顺序把每个 bundle 的 patch 层**平铺**，再叠加 `<profile>/cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`、CLI `--patch` 覆盖层。所以"插件被拉起来"= 它的 patch 里的 `insert:` 行进入了最终 entry list。
5. bundle 解析顺序是 **安装目录优先，profile 目录次之**（`app-boot:901-907`）——这是"in-box bundle 永远来自 dsh 安装副本"的硬契约。读不到/不兼容的 bundle 只记入 `skippedBundles`，不改变 manifest（`app-boot:920-945`）。

**证据**

profile 现场 —— `C:\Users\you\.dsh\profiles\desktop\package.json:12-27`：

```json
12	  "dsh": {
13	    "profile": {
14	      "bundles": [
15	        "@deepseek-ai/dsh-base",
16	        "@deepseek-ai/dsh-web-app",
17	        "dsh-cost-meter",
18	        "@deepseek-ai/dsh-experimental-auto-review",
19	        "@smalltailqwq/dsh-client-ui-skin-deep-whale-manager",
...
22	        "@hope_phenom/dsh-plugin-notify",
23	        "@hope_phenom/dsh-plugin-code-quality",
24	        "@deepseek-ai/dsh-experimental-agent-team-profile"
25	      ]
26	    }
27	  }
```

profile 根 list 是空的，一切都靠 patch 组合 —— `C:\Users\you\.dsh\profiles\desktop\cordis.yml:1-5`：

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

第三方插件的最小完整形态（活样本）—— `F:\WorkSpace\dsh-plugin-notify\package.json:23-56`：

```json
23	  "type": "module",
24	  "icon": "./assets/icon.svg",
25	  "exports": {
26	    ".": "./lib/index.js",
27	    "./client": "./lib/client.js",
28	    "./core": "./lib/core.js",
29	    "./package.json": "./package.json",
30	    "./locale/*.json": "./locale/*.json"
31	  },
...
48	  "dsh": {
49	    "bundle": {
50	      "patch": "./cordis.patch.yml"
51	    },
52	    "client": {
53	      "platform": "web",
54	      "inject": []
55	    }
56	  },
```

它的 patch —— `F:\WorkSpace\dsh-plugin-notify\cordis.patch.yml:11-13`：

```yaml
11	- insert:
12	    - id: dsh-plugin-notify
13	      name: '@hope_phenom/dsh-plugin-notify'
```

`insert:` 的实现语义 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:72-99`：

```js
72	  for (const patch of patches) {
73	    const { id, insert, name, ...overrides } = patch;
74	    if (insert) {
75	      if (id) {
76	        const target = entryMap.get(id);
...
85	        if (!Array.isArray(target.config)) target.config = [];
86	        target.config.push(...insert);
87	      } else data.push(...insert);
88	      buildMap(insert);
89	      continue;
90	    }
91	    if (!id) {
92	      warn("patch: id is required for non-insert patches");
93	      continue;
94	    }
```

官方 schema 自述 —— `app-boot/lib/index.js:2760`：

```
An insert appends entries, optionally inside the group identified by id. Other patches replace
supplied fields; config is replaced wholesale, not deep-merged. A truthy name asserts the existing
plugin name rather than renaming it. Unknown targets and non-insert patches without a nonempty id
are warned and skipped.
```

层序 —— `app-boot/lib/index.js:1023-1034`：

```js
1025	  const patches = structuredClone([
1026	    ...profile.layers.flatMap((layer) => layer.patches),
1027	    ...initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? [],
1028	    ...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],
1029	    ...context.overlays
1030	  ]);
```

bundle 目录解析（安装优先） —— `app-boot/lib/index.js:901-907`：

```js
901	function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
902		for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
903			const dir = packageDirFromAnchor(anchor, packageName);
904			if (dir !== void 0) return dir;
905		}
906		throw new Error(`${binName}: cannot resolve profile bundle ...`);
907	}
```

`dsh.client` 的字段与扫描 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:63-73`：

```js
63		if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
65		if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
66		const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
67		const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
68		if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
```

`dsh-client-modules/lib/index.js:713-719`（node 半边扫描 Loader entries，认 `platform === "web"`，要求 `exports["./client"]`）：

```js
713		const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
714		if (decl === void 0 || decl.platform !== "web") {
...
719		if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```

浏览器半边由 `/plugins/<id>/client.js` 提供 —— `dsh-client-modules/lib/index.js:918`、`:259`：

```js
259		const fallbackSource = sourceUrl === void 0 ? `/plugins/${resource.id}/${resource.fileName}` : ...
918			const prefix = `/plugins/${record.entry.id}/`;
```

官方 Host 插件导出形态（二选一，不可混用） —— `.../dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:47-54`：

```
- `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
- A service class as the default export.

Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup.
```

官方模板（含 `dsh.client` 双面） —— `.../cordis-plugin-development/templates/decoration/package.json`：

```json
{ "name": "@local/my-decoration", "version": "1.0.0", "private": true, "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
           "client": { "platform": "web", "immediately": true,
                       "inject": ["@deepseek-ai/dsh-client-ui-conversation"] } } }
```

**`dsh.bundle.patch` 可为数组**：`dsh-web-app/package.json` 的 `dsh.bundle.patch` 列出 `cordis.patch.yml` + `presets/*.patch.yml`；见 `dsh-web-app/cordis.patch.yml:558-565` 注释 "The shipped preset declarations follow as separate patch files under `presets/`, listed after this file in `package.json` `dsh.bundle.patch`."

---

### A2. 插件运行时能注入/使用的 Host 服务清单

**结论**

- 服务名 = Cordis Service 的 ctx key。取法是 `super(ctx, "<name>", ...)` 或 `ctx.provide("<name>", value)`。
- 注入方式：`export const inject = ['tools', ...]`（静态、缺失即不激活）或 `ctx.inject(['webServer'], child => ...)`（可选、就地降级）。读取用 `ctx.get('name')`。
- 下面列出**在本机 asar 中存在**的全部服务名（共 70+）。凡未列出的名字（如 `bash`、`workspace`、`webSearch`）都**不是**服务名，见文末"常见误记"。

**证据（服务名 → 来源包 / 文件:行）**

| 服务名 | 来源包 | 证据位置（`app.asar/dsh/node_modules/@deepseek-ai/...`） |
|---|---|---|
| `webServer` | dsh-host-webserver | `dsh-host-webserver/lib/index.js:158` |
| `connection` | dsh-client-connection | `dsh-client-connection/lib/index.js:566` |
| `typert` | dsh-typert-registry | `dsh-typert-registry/lib/index.js:359` |
| `typertGateway` | dsh-api-gateway | `dsh-api-gateway/lib/index.js:618` |
| `remote` (Client 侧) | dsh-api-gateway/client | `dsh-api-gateway/lib/client.js:1595` |
| `agents` | dsh-agent | `dsh-agent/lib/index.js:332` |
| `agentLoop` | dsh-agent-loop | `dsh-agent-loop/lib/index.js:1552` |
| `agentPresets` | dsh-agent-preset-registry | `dsh-agent-preset-registry/lib/index.js:481` |
| `subagents` | dsh-subagent | `dsh-subagent/lib/index.js:2834` |
| `sessions` | dsh-session | `dsh-session/lib/index.js:1621` |
| `sessionTitle` | dsh-session-title | `dsh-session-title/lib/index.js:214` |
| `sessionQuery` | dsh-session-query | `dsh-session-query/lib/index.js:1046` |
| `sessionPersistence` | dsh-session-persistence | `dsh-session-persistence/lib/index.js:265` |
| `sessionProjections` | dsh-session-projection | `dsh-session-projection/lib/index.js:52` |
| `sessionProjectionCache` | dsh-session-projection-cache | `dsh-session-projection-cache/lib/index.js:147` |
| `sessionReferenceResolver` | dsh-session-reference | `dsh-session-reference/lib/index.js:440` |
| `sessionFeedback` | dsh-command-feedback | `dsh-command-feedback/lib/index.js:132` |
| `sessionTelemetry` | dsh-session-telemetry | `dsh-session-telemetry/lib/index.js:275` |
| `tools` | dsh-tools | `dsh-tools/lib/index.js:2704` |
| `systemPrompt` | dsh-system-prompt | `dsh-system-prompt/lib/index.js:213` |
| `commands` | dsh-commands | `dsh-commands/lib/index.js:259` |
| `skills` | dsh-skill | `dsh-skill/lib/index.js:132` |
| `userQuestions` | dsh-user-questions | `dsh-user-questions/lib/index.js:490` |
| `approval` | dsh-user-approval | `dsh-user-approval/lib/index.js:76`（+ `invariant.js:71`） |
| `permissionPresets` | dsh-permission-presets | `dsh-permission-presets/lib/index.js:170` |
| `settings` | dsh-settings（抽象 seam，ctx.settings） | `dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:378` |
| `storage` | dsh-storage | `dsh-storage/lib/index.js:109` |
| `storageDomain` | dsh-storage-domain | `dsh-storage-domain/lib/index.js:450`（`ctx.provide`） |
| `storage backend json` | dsh-storage-json | `dsh-storage-json/lib/index.js:607`（`ctx.provide(storageBackendServiceKey("json"), ...)`） |
| `credentials` | dsh-credentials | `dsh-credentials/lib/index.js:110` |
| `authorization` | dsh-authorization | `dsh-authorization/lib/index.js:64` |
| `deepseekAccount` | dsh-deepseek-account | `dsh-deepseek-account/lib/index.js:36` |
| `fs` | dsh-fs | `dsh-fs/lib/index.js:60` |
| `shell` | dsh-shell | `dsh-shell/lib/index.js:85` |
| `shellEnv` | dsh-shell-env | `dsh-shell-env/lib/index.js:49` |
| `subprocess` | dsh-subprocess | `dsh-subprocess/lib/index.js:88` |
| `terminals` | dsh-terminal | `dsh-terminal/lib/index.js:58` |
| `jobs` | dsh-jobs | `dsh-jobs/lib/index.js:118` |
| `spillStore` | dsh-spill | `dsh-spill/lib/index.js:54` |
| `attachments` | dsh-attachment | `dsh-attachment/lib/index.js:207` |
| `fileReferences` | dsh-file-reference | `dsh-file-reference/lib/index.js:58` |
| `web` | dsh-web | `dsh-web/lib/index.js:56` |
| `llm` | dsh-llm | `dsh-llm/lib/index.js:1801` |
| `tokenMeter` | dsh-token-meter | `dsh-token-meter/lib/index.js:611` |
| `compaction` | dsh-compaction | `dsh-compaction/lib/index.js:171` |
| `toolResultPruner` | dsh-compaction-tool-result-pruner | `.../lib/index.js:71` |
| `sandbox` | dsh-sandbox | `dsh-sandbox/lib/index.js:285` |
| `sandboxPolicy` | dsh-sandbox-policy | `dsh-sandbox-policy/lib/index.js:111` |
| `goals` | dsh-goal | `dsh-goal/lib/index.js:592` |
| `planMode` | dsh-plan-mode | `dsh-plan-mode/lib/index.js:149` |
| `schedule` | dsh-schedule | `dsh-schedule/lib/index.js:2614` |
| `workflowEngine` | dsh-workflow | `dsh-workflow/lib/index.js:61` |
| `invariants` | dsh-invariants | `dsh-invariants/lib/index.js:60` |
| `otel` | dsh-otel | `dsh-otel/lib/index.js:377` |
| `productTelemetry` | dsh-host-product-telemetry-otel | `.../lib/index.js:41` |
| `webhookRuntime` | dsh-webhook | `dsh-webhook/lib/index.js:274` |
| `mcpResources` | dsh-mcp-resources | `dsh-mcp-resources/lib/index.js:116` |
| `messageFeedback` | dsh-message-feedback | `dsh-message-feedback/lib/index.js:168` |
| `officeToPdf` | dsh-office-to-pdf | `dsh-office-to-pdf/lib/index.js:453` |
| `directoryPicker` | dsh-host-directory-picker | `dsh-host-directory-picker/lib/index.js:40` |
| `pluginManager` | dsh-plugin-manager | `dsh-plugin-manager/lib/index.js:1380` |
| `pluginInventory` | dsh-host-plugin-inventory | `dsh-host-plugin-inventory/lib/index.js:97` |
| `pluginPackages` | dsh-app-boot | `dsh-app-boot/lib/index.js:3213` |
| `clientModules` | dsh-client-modules | `dsh-client-modules/lib/index.js:526` |
| `fileUploads` | dsh-client-file-upload | `dsh-client-file-upload/lib/index.js:168` |
| `productAnalytics` | dsh-client-product-analytics | `dsh-client-product-analytics/lib/index.js:103` |
| `hmr` | dsh-hmr | `dsh-hmr/lib/index.js:314` |
| `cordisInspect` / `dynamicCordisRunner` | dsh-cordis-host-runner | `.../lib/index.js:728` / `:1585` |
| `timer` | cordis-plugin-timer | `cordis-plugin-timer/lib/index.js:6` |
| `loader` | cordis-plugin-loader | `cordis-plugin-loader/lib/index.js:603`（`ctx.reflect.provide`） |
| `sessionController` | dsh-api-session-controller | `.../lib/index.js:2847` |
| `sessionFileReferences` | dsh-api-session-controller | `.../lib/index.js:1768` |
| `sessionSkillCatalog` | dsh-api-session-controller | `.../lib/index.js:2249` |
| `jobController` | dsh-api-job-controller | `dsh-api-job-controller/lib/index.js:319` |
| `terminalController` | dsh-api-terminal-controller | `.../lib/index.js:765` |
| `workspaceController` | dsh-api-workspace-controller | `.../lib/index.js:853` |
| `directoryPickerController` | dsh-api-workspace-controller | `.../lib/index.js:474` |
| `workspaceFiles` | dsh-api-workspace-files | `dsh-api-workspace-files/lib/index.js:395` |
| `accountController` | dsh-api-account-controller | `dsh-api-account-controller/lib/index.js:202` |
| `settingsController` / `credentialsController` | dsh-api-settings-controller | `.../lib/index.js:382` / `:144` |
| `workspaceRegistry` | dsh-workspace | `dsh-workspace/lib/index.js:374` |
| `workspaceChanges` | dsh-workspace-changes | `dsh-workspace-changes/lib/index.js:1044`（`ctx.provide`） |
| `agentTeams` | dsh-experimental-agent-team | `.../lib/index.js:1704` |
| `speechToText` / `speechController` | dsh-experimental-*speech* | `dsh-experimental-speech-to-text/lib/index.js:18` / `dsh-experimental-api-speech-to-text/lib/index.js:141` |
| `webStartup` | dsh-web-app/startup | `dsh-web-app/lib/startup.js:42`（`ctx.provide`） |
| `webRuntime` | dsh-web-app | `dsh-web-app/lib/index.js:175`（`ctx.provide`） |
| `profileContext` | dsh（CLI profile-boot） | `dsh/lib/profile-boot-BZ2ZjNWi.js:273`（`ctx.provide`） |
| `dshHomePath` | dsh-app-boot | `dsh-app-boot/lib/index.js:4071`（`ctx.provide`） |
| `cmdlineArgs` / `appExit` / `appReady` | dsh-cmdline | `dsh-cmdline/lib/index.js:29-31`（`ctx.provide`） |
| `acpAppStartup`（常量名 `ACP_APP_STARTUP_SERVICE`） | dsh-acp-app | `dsh-acp-app/lib/index.js:35` |
| `sdkAppStartup`（`SDK_APP_STARTUP_SERVICE`） | dsh-sdk-app | `dsh-sdk-app/lib/index.js:40` |
| `headlessStartup`（`HEADLESS_STARTUP_SERVICE`） | dsh-headless | `dsh-headless/lib/startup.js:84` |

**事件（`ctx.on`）也很多**，第三方插件样本用到的两个：
- `session/event`：`F:\WorkSpace\dsh-plugin-notify\lib\index.js:707-713`
- `webserver/index-inject`：`dsh-host-webserver/lib/index.js:352`（`this.ctx.emit("webserver/index-inject", table)`），消费方 `dsh-client-connection/lib/index.js:822-828`

**常见误记（这些名字在本机 asar 中不是服务名）**

- `bash` — 没有；bash 执行器是 `dsh-bash-local` / `dsh-bash-sandbox`，但提供的是 **seam 的实例**（`ctx.shell` 的 provider），对外只看到 `shell`。`packages.md:382-387` 描述为 "implementation of the DeepSeek Harness bash executor seam"。
- `workspace` — 没有；是 `workspaceRegistry`（`dsh-workspace`）。
- `webSearch` — 没有；是 `web`（`dsh-web`），`packages.md:487` "Abstract web access capability seam (ctx.web)"。
- `spill` — 没有；是 `spillStore`。
- `approval` 存在（`dsh-user-approval`），但 `dsh-permission-presets` 提供的是 `permissionPresets`。
- `pwsh` — 没有独立服务；`dsh-pwsh-local`/`dsh-pwsh-sandbox` 同为 `shell` seam 的 Windows 实现（`packages.md:386-387`）。

---

### A3. 第三方插件能否 `import @deepseek-ai/*`（类型 / 运行时）？

**结论（推翻了 dsh-plugin-notify 注释的说法）**

1. **运行时：能。** 但**不是靠 Node 原生解析**，而是靠 `dsh-app-boot` 安装的 **runtime interception layer**。profile 里 `node_modules` 确实**没有** `@deepseek-ai/` 目录，Node 原生解析会失败；DSH 覆盖了 ESM `resolve`/`resolveSync` 与 CJS `_resolveFilename`，把 profile 内模块对 `@deepseek-ai/*` 的请求**改路由到安装副本的 declarer** 上去解析。
2. 判定条件（`routeScoped`）：请求名命中 installation-scope entry 就拦截。installation-scope 集合 = `@deepseek-ai/dsh`（CLI 包，即 `installAnchor`）的 **dependencies + peerDependencies 传递闭包**。`@deepseek-ai/dsh` 的 dependencies 里就列了几乎所有 `@deepseek-ai/dsh-*`，所以**全部 in-box 包对 profile 插件可见**。
3. **也顺带能拿到 `ws`、`@agentclientprotocol/sdk`、`@modelcontextprotocol/client`、`undici`、`got`**：它们分别是 `dsh-api-gateway`、`dsh-acp`、`dsh-mcp-client`、`dsh-http-proxy`/`dsh-web-fetch-http`、`dsh-otel` 的 **dependencies**，因此进入同一个 installation-scope 闭包。
4. **但有一个关键例外**：如果插件是通过 **symlink/junction 链接进 profile 的**（本机 `dsh-plugin-code-quality` 就是 junction），它落在 `linked` 层而不是 `profile` 层；此时 interception **只在插件自己的 `package.json` 显式声明了该名字为 `peerDependencies` 时才生效**。这就是为什么 npm 上的 `@smalltailqwq/dsh-client-ui-skin-*`、`dsh-cost-meter` 都在 manifest 里写了 `@deepseek-ai/cordis` / `@deepseek-ai/dsh` 等 peer。
5. **类型（.d.ts）：** 安装副本里 ship 了 `lib/**/*.d.ts` 与 `src/*.ts`，但 profile 的 `node_modules` 里没有 `@deepseek-ai/*`，所以**类型解析走不到**；`host-plugin.md:7` 明确说 Host-only bundle "needs no dependencies, install scripts, or build tool"，`host-plugin.md:18` 说"Packages shipped with dsh resolve from the dsh installation, so the bundle declares no dependencies on them"——指的是 Loader 解析 `name:`，不是 TS 类型。
6. **`dsh-plugin-notify/lib/index.js:10-13` 的注释是过时/错误的**（该插件 v0.1.0，面对的是更早的 runtime）。同样 `cordis-plugin-development/references/practices.md:35` 里"不要 import `@deepseek-ai/dsh-client-ui-primitives`"是**策略禁令（防止 API 漂移 + plain-JS 无类型检查）**，不是技术上解析不到。

**证据**

profile 的 node_modules **没有** `@deepseek-ai`（`Get-ChildItem C:\Users\you\.dsh\profiles\desktop\node_modules` 输出）：

```
.bin  .pnpm  @hope_phenom  @smalltailqwq  dsh-cost-meter
dsh-plugin-code-quality   -> Junction  F:\WorkSpace\dsh-plugin-code-quality
zod
.modules.yaml  .pnpm-workspace-state-v1.json
```

`@deepseek-ai` 目录 **不存在**（`Get-ChildItem .../node_modules/@deepseek-ai` 返回空）。pnpm 配置为 `nodeLinker: hoisted`、`autoInstallPeers: false`，`publicHoistPattern: []` —— `C:\Users\you\.dsh\profiles\desktop\pnpm-workspace.yaml:1-10`、`node_modules\.modules.yaml`（`"autoInstallPeers": false` 在 `pnpm-lock.yaml:4`）。

过时注释 —— `F:\WorkSpace\dsh-plugin-notify\lib\index.js:10-13`：

```js
10	 * It imports nothing from `@deepseek-ai/*`: a profile-installed bundle cannot
11	 * resolve those packages at runtime, so the plugin depends only on Node
12	 * builtins and its own files.
13	 */
```

interception 的安装点 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1641-1651, 1668-1694`：

```js
1641	function installRuntimeInterception(resolution) {
...
1650			if (parent === void 0 || !router.hasInterceptionLayerForUrl(parent)) return native(request, parent, attributes);
1651			const state = router.routeUrl(request, parent);
...
1668			const route = state.route;
1669			if (route.kind === "native") { ... }
1674			const routedParent = pathToFileURL(route.kind === "interception" ? route.entry.declarer : route.parent).href;
...
1684					result = native(request, routedParent, attributes);
```

路由判定 —— `app-boot/lib/index.js:1459-1466`：

```js
1459		const route = target !== void 0 && (target.scope === "installation" || layer.active) ? {
1460			kind: "interception",
1461			entry: target,
1462			after: layer.after
1463		} : {
1464			kind: "native-after-interception",
1465			parent: layer.nativeAfter
1466		};
```

profile 层判定（`layer.active` = 当前 profile） —— `app-boot/lib/index.js:1203-1221`：

```js
1203	function computeProfileLayer(dir, active) {
1204		const profileParent = dirname(dir);
1205		return { kind: "profile", active, localPrefix: dir + sep,
1209			nativeAfter: join(profileParent, "package.json"),
1210			after: join(dirname(profileParent), "package.json") };
1211	}
...
1219		if (!startsWithin(path, resolution.linkedPaths)) return void 0;
1220		if (startsWithin(path, resolution.installationPaths)) return void 0;
1221		return { kind: "linked" };
```

installation-scope 集合的构造 —— `app-boot/lib/index.js:681-724`（`collectInstallationScopePackages`，从 `installAnchor` 的 manifest 出发走 `dependencies`+`peerDependencies` 闭包）：

```js
677	function profileDependencyNames(manifest) {
678		return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
679	}
681	function collectInstallationScopePackages(installAnchor, skippedBundles) {
...
699		for (const dep of profileDependencyNames(next.manifest)) {
...
711			links.set(dep, dir);
```

安装锚点 = `app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json` —— `dsh-desktop-host/lib/index.js:220`：

```js
220		const installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
```

`@deepseek-ai/dsh` 的 dependencies 覆盖全部 in-box 包（节选） —— `app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json:95-104`：

```json
95	    "@deepseek-ai/dsh-webhook": "0.2.0-rc.2",
96	    "@deepseek-ai/dsh-web-app": "0.2.0-rc.2",
...
101	    "@deepseek-ai/dsh-plugin-manager": "0.2.0-rc.2",
102	    "@deepseek-ai/dsh-agent-preset": "0.2.0-rc.2",
```

第三方网络库进入闭包（都是 **dependencies**，我逐段核对过 section）：
- `dsh-api-gateway/package.json:54` → `ws: ^8.21.0`（`dependencies`）
- `dsh-acp/package.json:30` → `@agentclientprotocol/sdk: 1.4.0`（`dependencies`）
- `dsh-mcp-client/package.json:41` → `@modelcontextprotocol/client: 2.0.0`（`dependencies`）
- `dsh-http-proxy/package.json:33` / `dsh-web-fetch-http/package.json:37` → `undici: ^8.10.0`（`dependencies`）
- `dsh-otel/package.json:37` → `got: ^14.6.6`（`dependencies`）
- 对照：`@deepseek-ai/dsh/package.json:106-112` 里 `@agentclientprotocol/sdk`、`ws` 位于 **devDependencies** —— 单看它不算数，是靠上面那些包的 dependencies 传递进来的。

linked 层需要 peerDependency 声明 —— `app-boot/lib/index.js:1224-1231, 1479-1497`：

```js
1224	function readPeerNames(directory) {
1226		const peers = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).peerDependencies;
...
1479			if (ancestorSet.has(searchPath) && readPeerNames(directory).has(name)) {
1480				const route = { kind: "interception", entry: target, after: join(dirname(directory), "package.json") };
```

现实印证 —— `C:\Users\you\.dsh\profiles\desktop\pnpm-lock.yaml` 里第三方包都声明了 DSH peer，例如：

```yaml
  '@smalltailqwq/dsh-client-ui-skin-maid-atelier@0.1.7':
    peerDependencies:
      '@deepseek-ai/cordis': ^4.0.1
      '@deepseek-ai/dsh': '>=0.1.7-rc.1 <0.3.0-0'
    peerDependenciesMeta:
      '@deepseek-ai/dsh': { optional: true }
```

版本门（不是解析门） —— `app-boot/lib/index.js:286-313`：任何 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer 若与 runtime 版本不满足，该 bundle **被跳过**（`:930-931`），除非 `compatibility.json` 里有精确豁免（`:320-322`，`dsh plugin allow-version`）。

官方文档的两处相关表述：
- `host-plugin.md:18`："Packages shipped with dsh resolve from the dsh installation, so the bundle declares no dependencies on them."
- `practices.md:35`："Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed."

**未找到 / 已搜索但无结果**：asar 内是否存在 `src/` 形式的 TS 类型映射文档、是否存在把 `@deepseek-ai/*` 显式暴露给 profile 的 `paths`/`imports` 映射。已搜索关键词：`imports`、`paths`、`tsconfig`、`createRequire`、`moduleRoot`、`node_modules`（在 `app-boot`、`cordis-plugin-loader`、`dsh-hmr`、`plugin-manager` 的 `lib/index.js` 中）。结论：**只有 runtime interception，没有 TS 级别的路径映射**。

---

### A4. 插件的 HMR / 重载行为

**结论**

1. **配置热更（默认开启）**：`dsh-hmr` 始终 watch `<profile>/cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`、`<profile>/package.json`（bundles 表）。改 patch / 加删 bundle → **热生效，无需重启**。
2. **插件 JS 代码热更（默认关闭）**：模块 watch 只覆盖 `hmr.config.root`，而 `dsh-base` 里 `root: []`（空）。所以要改 `lib/index.js` 生效，必须把插件目录加进某个 patch 层的 `hmr` 行 `config.root`，否则**必须重启**。
3. **替换已安装的包 → 必须重启**：`ResolutionRouter.replace()` 对 packageDir / declarer / version / scope 变化直接抛 `profile resolution: replacing "X" requires a process restart`。`plugin_manager.install_bundle` 在覆盖已存在的依赖时返回 `restart-required`；只有"新增 bundle"且 `hmr` 在场才返回 `application: applied`。
4. 浏览器半边另有独立链路 `dsh-client-hmr`（`client-hmr` 行，永远挂载但闲置），只在 `pnpm run dev:web` 真的重写 client bundle 时才工作。

**证据**

profile patch / manifest watch —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js:353-376`：

```js
353				const manifestPath = join(profile.dir, "package.json");
354				const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)];
...
369					const patches = readProfilePatches("dsh", profile);
370					const warnings = await reconcileProfilePatches(this.ownerContext.root, patches, "dsh");
...
375				for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false));
376				await this.watchConfig(manifestPath, () => refresh(true));
```

模块 watch 只看 `config.root` —— `dsh-hmr/lib/index.js:378-392, 439-444`：

```js
378			const { loader } = this.ctx;
379			const { root, ignored } = this.config;
...
387			this.watcher = watch(root, { ...this.config, cwd: watchBaseDir, ... });
...
439			let readyState = root.length === 0 ? "resolved" : "pending";
440			if (root.length === 0) ready.resolve();
```

base 里 root 为空 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:27-32`：

```yaml
27	    # Profile configuration reloads by default; module roots are opt-in.
28	    - id: hmr
29	      name: '@deepseek-ai/dsh-hmr'
30	      disabled: !!js "!ctx.get('profileContext')"
31	      config:
32	        root: []
```

client HMR 行 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:198-203`：

```yaml
198	    # The client-plugin reload chain, always mounted: it is idle until a
199	    # rebuild watcher (pnpm run dev:web) actually rewrites client bundles.
202	    - id: client-hmr
203	      name: '@deepseek-ai/dsh-client-hmr'
```

替换包必须重启 —— `app-boot/lib/index.js:1360-1372`：

```js
1360		replace(successor) {
...
1365			if (next === void 0 || !sameResolution(current.packageDir, next.packageDir) || !sameResolution(current.declarer, next.declarer) || current.version !== next.version || current.scope !== next.scope) throw new Error(`profile resolution: replacing ${JSON.stringify(name)} requires a process restart`);
...
1369			for (const name of localPackageNames) if (!this.current.localPackageNames.has(name) && this.current.entries.has(name)) throw new Error(`profile resolution: overriding ${JSON.stringify(name)} locally requires a process restart`);
```

plugin-manager 的判定 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:1801`、`:2042`：

```js
1801					if (Object.hasOwn(before, name)) return "restart-required";
2042					application: this.ownerContext.get("hmr") !== void 0 ? "applied" : "restart-required"
```

官方文档 —— `.../cordis-plugin-development/references/host-plugin.md:60`：

```
Installing a new bundle can activate through HMR; replacing an installed package requires
restart to load a fresh JavaScript module generation.
```

---

## B. 网络与传输

### B5. `dsh-host-webserver` 暴露的接口

**结论**

1. **route 形状**：`{ kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`。`register()` 返回 disposer。`(kind, path)` 重复**直接抛错**。
   - `exact`：`Map` 精确命中。
   - `prefix`：**最长前缀优先**；匹配条件等价于 `pathname === prefix || pathname.startsWith(prefix + "/")`。**没有通配符/正则**。
2. 另有 `registerUpgrade({ path, handler(req, socket, head) })`（WebSocket 升级，精确路径）、`registerFallback(handler)`（唯一占位，SPA dist 用）、`tapIndex(transform)`（index.html 字符串变换）。**不提供静态文件服务、不提供 body 解析、不提供 CORS、不提供鉴权、不提供 CORS/同源校验**——handler 完全拥有 `res`。
3. **绑定地址与端口**来自本行的 `config`：schema 只接受 `host ∈ {127.0.0.1, 0.0.0.0}`（必填）与 `port`（必填自然数，≤65535；`0` = OS 分配，运行后读 `webServer.port`）。web-app 的默认是 `host ?? '127.0.0.1'`、`port ?? 3080`。
4. **能绑 `0.0.0.0`，但 CLI 明确拒绝**：`dsh --profile web --host 0.0.0.0` 会被 `program.error` 拦下（"it would expose remote code execution to the network"）。不过 webserver 的 schema 允许 `0.0.0.0`，且 web-app 已有 `resolveLanTrust()` 会**自动枚举本机非内部 IPv4 并加进 `trustedHosts`**——说明"改 patch 里的 config 把 host 设成 `0.0.0.0`"是被代码支持但被 CLI 门拦住的路径。
5. **同源/鉴权**：webserver 本身**没有**任何中间件。真正的关卡在 `dsh-client-connection`：只有 `/api` 这一条 prefix 路由经过 `isTrustedApiRequest`（Host 头必须是 loopback 或 `trustedHosts` 里的 authority；`sec-fetch-site: cross-site` 拒绝；有 Origin 时必须同 host）+ `browserAuth`（进程 launch token 换签名的 HttpOnly Cookie，30 天）。**其它插件自己 `register()` 的路由完全不经过这道关卡**——例如 `dsh-plugin-notify` 自己在 handler 里手写 `sameOrigin()`。全仓 `grep -i "access-control-allow"` **零命中**：**没有任何 CORS 头**。
6. 本机 Desktop 现网：`dsh-desktop-host` 用 `--port 19387 --no-open`、**不传 `--host`** → 即 `127.0.0.1:19387`（与 GUI 地址一致）。

**证据**

Config schema 与 listen —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:139-166, 295-305`：

```js
139	var WebServer = class extends Service {
141		static Config = z.object({
142			host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
143			port: z.natural().max(65535).required(),
144			compression: z.union([z.const("none"), z.const("gzip")]).default(DEFAULT_COMPRESSION),
145			compressionLevel: ...
146			compressionThresholdBytes: ...
147		});
148		exact = new Map();
149		prefixes = new Map();
150		upgrades = new Map();
...
163		/** The listening port (the OS-assigned value when config.port is 0). */
164		get port() { return this.listenedPort; }
167		get host() { return this.config.host; }
...
297			this.server.listen(this.config.port, this.config.host, () => {
...
302				this.listenedPort = this.server.address().port;
```

三个注册 API —— `dsh-host-webserver/lib/index.js:177-226`：

```js
177		register(route) {
178			const table = route.kind === "exact" ? this.exact : this.prefixes;
179			if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
180			table.set(route.path, route);
181			return () => { table.delete(route.path); };
182		}
...
191		registerUpgrade(route) {
192			if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
...
220		tapIndex(transform) { ... }
```

前缀匹配（最长前缀胜，无通配） —— `dsh-host-webserver/lib/index.js:322-332`：

```js
322		match(pathname) {
323			const exact = this.exact.get(pathname);
324			if (exact !== void 0) return exact;
325			let best;
326			for (const [prefix, route] of this.prefixes) {
327				if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
328				if (best === void 0 || prefix.length > best.path.length) best = route;
329			}
330			return best;
331		}
```

host/port 来源 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:169-177`：

```yaml
169	    - id: webserver
170	      name: '@deepseek-ai/dsh-host-webserver'
171	      inject: [webStartup]
172	      config:
173	        host: !!js ctx.webStartup.host ?? '127.0.0.1'
174	        port: !!js ctx.webStartup.port ?? 3080
175	        compression: gzip
```

CLI 拒绝 `0.0.0.0` —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/lib/startup.js:36-47`：

```js
40			if (options.host === "0.0.0.0") program.error("error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead");
...
42			ctx.provide(WEB_STARTUP_SERVICE, {
44				...options.host !== void 0 && { host: options.host },
45				...options.port !== void 0 && { port: Number(options.port) },
46				trustedHosts: options.trustedHost ?? []
47			});
```

LAN 信任推导（已为 `0.0.0.0` 准备好） —— `dsh-web-app/lib/index.js:83-89, 173-175`：

```js
83	function resolveLanTrust(bindHost, extra) {
84		const lanAddresses = bindHost === ALL_INTERFACES_HOST ? Object.values(networkInterfaces()).flat().filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal).map((iface) => iface.address) : [];
85		return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] };
86	}
...
173		const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts);
175		ctx.provide(WEB_RUNTIME_SERVICE, runtime);
```

`/api` 的信任栅栏 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:205-219`：

```js
205	function isTrustedApiRequest(request, trustedHosts) {
206		const host = header$1(request.headers, "host");
207		if (host === void 0) return false;
208		const hostUrl = parseAuthority(host);
209		if (hostUrl === void 0) return false;
210		if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
211		if (header$1(request.headers, "sec-fetch-site") === "cross-site") return false;
212		const origin = header$1(request.headers, "origin");
213		if (origin === void 0) return true;
214		try { return new URL(origin).host === hostUrl.host; } catch { return false; }
219	}
```

栅栏自述"不是鉴权层" —— `dsh-client-connection/lib/index.js:136-140`：

```
Non-browser and remote clients pass the same fence via loopback, deployment-derived LAN IP
literals, or a declared `trustedHosts` authority. Network reachability and authentication stay
out of scope: binding policy belongs to the webserver config, and this fence is not an auth layer.
```

`/api` 只有这条路由受保护 —— `dsh-client-connection/lib/index.js:830-843`：

```js
830		const route = {
831			kind: "prefix",
832			path: API_PATH,
833			handler: async (req, res) => {
834				const admission = connection.admit(req);
835				if ("rejection" in admission) { res.writeHead(admission.rejection); ... }
840				await webCtx.waterfall("connection/request", req, res, () => bridge(req, res, fetchHandler, maxRequestBodyBytes));
```

插件自己写同源检查 —— `F:\WorkSpace\dsh-plugin-notify\lib\index.js:551-563, 627-635`：

```js
551	/** Reject cross-site callers the way the shipped plugins do. */
552	function sameOrigin(req) {
553		if (req.headers['sec-fetch-site'] === 'cross-site') return false;
...
628	  return {
629	    kind: 'exact',
630	    path: NOTIFY_ROUTE,
631	    async handler(req, res) {
632	      if (!sameOrigin(req)) { json(res, 403, { ok: false, error: 'cross-site-request-rejected' }); return; }
```

Desktop 启动参数 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:231-235`：

```js
231		args: [
232			"--no-open",
233			"--port",
234			"19387"
235		],
```

**未找到**：webserver 里的 CORS、CSRF、静态文件、body 上限、请求日志中间件。已搜索关键词：`access-control-allow`、`Access-Control-Allow`、`cors`（`@deepseek-ai/**/*.js`，仅命中一个无关的 PDF viewer `mode: "cors"`）。

---

### B6. Typert / remote 体系是不是可复用的跨进程 RPC 底座？

**结论**

1. **各包角色**
   - `dsh-typert-protocol`：**纯声明库**，注册 0 个 Cordis 服务。提供 `@Remote` / `@RemoteScope` 装饰器、`InvocationDescriptor`、`RemoteError`、`TypertLookupMap`/`TypertContextMap`、codec 契约。`README.md:12`。
   - `dsh-typert-registry`：运行时注册表，提供 `ctx.typert`（本地 descriptors / lookups / providers）。`lib/index.js:359`。
   - `dsh-api-gateway`：**Host 端 dispatcher** 提供 `ctx.typertGateway`；`/client` 提供 `ctx.remote`。Host 侧把 `invoke()` 注册成 `connection` 的 **`/api` 拦截器**，并把 **`/api/remote.mux` WebSocket upgrade** 注册到 `webServer`；Client 侧 `ctx.remote.$mount()` 把生成的 contribution 挂成 concrete 方法。
   - `dsh-api-remotes`：**应用级 BFF/白名单**。Host 半边持有 `API_REMOTE_FORWARDED_EVENTS`（`ctx.remote.$on` 的合法 key 全集）并调用 `ctx.typertGateway.registerRemoteEvents(source, { home })`；Client 半边 import 生成的 `/remote` 产物并逐个 `$mount()`。
2. **语义**
   - `ctx.remote.$mount()`：**Client 侧**。校验并注册一个"Host→Client 生成贡献"，为调用它的 fiber 安装 direct/scoped 方法；每个 namespace 变成 `remote.<ns>` 子 Service，最后一个方法撤走即卸载。
   - `registerRemoteEvents(source, host)`：**Host 侧**。注册**唯一**一个转发事件源；Gateway 保留内部 `$events` 逻辑端点，开流时先发 `{ type: 'ready', clientId, host: { home } }`。重复注册抛错。
3. **设计目标是"浏览器 client ↔ 同进程 Host"。** 证据：包描述 "Two-sided Typert RPC endpoint for Host and Client Cordis environments"（`api-gateway/README.md:12`）；Client 半边跑在浏览器（`ctx.connection.rpc.call('/api', ...)`，走 fetch/SSE）；Android 端 `$on` 的注释明确说 "carriers from the browser"；`api-remotes/README.md:36` "This package owns no physical transport or Host service discovery... Its Client face can be reused by Web or a future TUI that provides the same React-free `ctx.remote` contract."
4. **物理上能不能用于"机器 A Host ↔ 机器 B Host"？能，但不现成。** 传输本身是标准 HTTP `POST /api/<endpoint>` + `GET /api/remote.mux` (WebSocket)，`api-gateway/README.md:105` 甚至写明 "./stream-protocol export supplies the shared Remote stream framing and parser to **native Desktop callers**. These callers use the same authenticated WebSocket endpoint as the browser client." 也就是说：**只要有对端实现同一套 framing，就能在局域网里当 RPC 用**。但它把三件事绑死在"同一个 harness 的本地浏览器"假设上：
   - Host/Origin 栅栏要求对端把 `Host` 写成 loopback、或本机 LAN IP 字面量、或显式 `trustedHosts` authority；
   - 需要浏览器 auth：`GET /?token=<processLaunchToken>` → 303 + `Set-Cookie: dsh-auth-<sha256(authority)>=v1....`（HMAC 签名、HttpOnly、SameSite=Strict、30 天），之后 `/api` 才放行。token 是**进程级随机 secret**（`randomBytes(32)`），换个 Host 进程就变；
   - `$mount()` 只在 **Client** 侧存在；Host 侧没有等价的"我主动连到另一台 Host"的 API。
5. **实践结论**：拿它当"主机→从机"通道，等于让从机**实现一个 DSH Web 客户端**（浏览器角色）+ 走 token→cookie 交换 + Host 头栅栏。可行但成本高、且完全依赖 DSH 内部协议版本。**更划算的是 B5 里"自己 register 一条路由/upgrade"或 B7 里的现成协议。**

**证据**

设计目标自述 —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-api-gateway/README.md:12`：

```
Two-sided Typert RPC endpoint for Host and Client Cordis environments. The Host entry provides
`ctx.typertGateway`, while `@deepseek-ai/dsh-api-gateway/client` provides `ctx.remote`; both
consume the same generated `InvocationDescriptor` contract and leave business selection to API
Remotes. Connection carries unary request correlation, trust, and response envelopes, while
Gateway owns multiplexed Remote streams...
```

协议库只声明不注册 —— `dsh-typert-protocol/README.md:12`："The package registers no Cordis service and runs no TypeScript analysis."

`$mount()` 语义 —— `dsh-api-gateway/README.md:52`：

```
`ctx.remote.$mount()` validates and registers a generated Host-for-Client contribution, then
installs concrete direct and scoped methods for the calling Cordis fiber. Each namespace is a
traced `remote.<namespace>` child Service and unloads after its last method is withdrawn.
```

`registerRemoteEvents()` 语义 —— `dsh-api-gateway/README.md:43` + 实现 `dsh-api-gateway/lib/index.js:673-697`：

```js
673		registerRemoteEvents(source, host) {
674			if (this.remoteEvents !== void 0) throw new Error("typert gateway: forwarded Remote event source is already registered");
...
686			host: { home: host.home }
```

流多路复用 + WS 路径 —— `dsh-api-gateway/lib/index.js:12, 623-643`：

```js
12	const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
...
623			ctx.inject(["connection"], (connectionCtx) => {
624				connectionCtx.connection.rpc.intercept("/api", (endpoint) => this.claimsEndpoint(endpoint), (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer));
625			});
626			ctx.inject(["connection", "webServer"], (webCtx) => {
...
642					yield webCtx.webServer.registerUpgrade(route);
```

浏览器/RPC 事实 —— `dsh-api-gateway/README.md:35`：

```
The Client opens the Gateway-owned `/api/remote.mux` WebSocket when its plugin activates and
keeps it connected while idle. ... A socket that has not answered the previous Ping is
terminated at the next interval. ... an in-process Connection carrier provides equivalent
streams directly without opening it.
```

`api-remotes` 的角色 —— `dsh-api-remotes/lib/index.js:131-135`：

```js
131	const inject = ["typertGateway"];
133	function apply(ctx) {
134		ctx.effect(() => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx), { home: homedir() }), "api-remotes: forwarded Cordis event source");
135	}
```

`$on` 白名单（26 个事件，包含 `plugin-manager/*`、`user-questions/request`、`approval/request` 等） —— `dsh-api-remotes/lib/index.js:17-126`。

认证交换 —— `dsh-client-connection/lib/index.js:223-231, 374-378, 388-427`：

```js
226	const TOKEN_QUERY = "token";
227	const COOKIE_PREFIX = "dsh-auth-";
...
247		const created = encodeBase64Url(randomBytes(SECRET_BYTES));
248		PROCESS_LAUNCH_TOKENS.set(owner, created);
...
374		authenticatedUrl(baseUrl) {
375			const url = new URL(baseUrl);
376			url.searchParams.set(TOKEN_QUERY, this.launchToken);
377			return url.href;
378		}
...
394				if (req.method === "GET" && url.pathname === "/" && tokens.length === 1 && authority !== void 0 && tokenMatches(tokens.join(""), this.launchToken)) {
...
407						"set-cookie": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3))
```

Cookie 属性 —— `dsh-client-connection/lib/index.js:297`：`HttpOnly; SameSite=Strict`，`Max-Age` 由 `cookieMaxAgeDays`（默认 30）决定（`:802`）。

客户端 API 边界 —— `dsh-client-connection/lib/index.js:572-584`（`ctx.connection.rpc.handle/intercept`、`ctx.connection.fetch.register`）：

```js
572		get rpc() {
573			const owner = this.ctx;
574			return {
575				handle: (channel, handler) => this.register(owner, channel, handler),
576				intercept: (channel, matches, handler) => this.registerInterceptor(owner, channel, matches, handler)
577			};
578		}
580		get fetch() {
581			const owner = this.ctx;
582			return { register: (route) => this.registerFetchRoute(owner, route) };
583		}
```

---

### B7. 已有的局域网 / 远程能力盘点

**结论表**

| 包 | 传输 | 能否当"主机→从机指令通道" | 协议 / 鉴权现状 |
|---|---|---|---|
| `dsh-acp` | **仅 JSON-RPC over stdio**（`process.stdin/stdout`）。`config.stream` 只是测试注入点 | ❌ 不能直接当网络通道；但 **ACP SDK 1.4.0 随应用分发**，SDK 自带 `experimental/ws-client`、`experimental/http-client`、`experimental/server`（WS/SSE/HTTP 流），可自己接线成 TCP/WS | 无鉴权概念（信任本地父进程）。`Config = { provider, model, sessionListPageSize }` |
| `dsh-acp-app` | 只是把 ACP bundle 的 startup 服务 `provide` 出去 | ❌ | 无 |
| `dsh-sdk-jsonrpc-server` | **仅 stdio**（newline-delimited JSON-RPC，`JsonRpcLineTransport`）；`config.input/output/exit` 不在 Config schema 里，只有测试用 | ❌ 现成不可网络化；协议本身（`initialize`/`session/prompt`/`shutdown` + `session.event` 通知）可承载 | **无任何鉴权**（假定父进程可信）。`Config = { maxTokensAsSuccess }` |
| `dsh-mcp-client` | 它是 **MCP 客户端**：`transport: stdio` 或 `transport: streamable-http`（`url` + `headers`） | ⚠️ 反向：让 DSH 当**客户**去连远端 MCP server；不能当"从机听指令"的 server。但 `headers` 支持自定义鉴权头，是现成的"带 token 的 HTTP 调用"范式 | HTTP 侧只有 `headers: z.dict(String)`，无内建 OAuth；`failOnStartupError`/reconnect 有 |
| `dsh-webhook` + `dsh-webhook-github` | **HTTP 入口**：`webServer.register({kind:'exact', path, handler})`（in-tree 的 `webServer` 路由范例） | ✅ **最接近的现成范式**：外部 POST → 校验 → 建 Session 跑 agent。但语义是 fire-and-forget 单向"投递"，无回程通道 | GitHub adapter 用 **HMAC-SHA256 `x-hub-signature-256`**，secret 从 `ctx.credentials` 取；返回 202。**注意：这条路由不经过 `/api` 的信任栅栏**，全靠自己验签 |
| `dsh-ssh` / `dsh-fs-ssh` / `dsh-sandbox-ssh` / `dsh-subprocess-ssh` | OpenSSH | ✅ 概念上是真正的"跨机器"通道（DSH 驱动远端 shell/fs/sandbox），但**方向是单向的**（Host 作为 SSH 客户端），不是对等从机 | 复用用户 OpenSSH 配置与密钥 |
| `dsh-subagent-acp` / `dsh-subagent-dsh-sdk` | ACP / stdio JSON-RPC 子进程 | ❌ 是"派生子进程子代理"，非跨机器 | — |

**本机 asar 实际分发情况**（重要）：`dsh-acp-app`、`dsh-sdk-app`、`dsh-headless`、`dsh-experimental-agent-team` **存在**；`dsh-ssh`、`dsh-fs-ssh`、`dsh-subagent-acp`、`dsh-subagent-dsh-sdk` **在本机 asar 中不存在**（只在 `packages.md` 目录里登记）。已搜索关键词：`@deepseek-ai/(dsh-ssh|dsh-fs-ssh|dsh-subagent-acp|dsh-subagent-dsh-sdk|dsh-sdk-app|dsh-headless|dsh-acp-app|dsh-experimental-agent-team)/package.json`。

**证据**

ACP 只走 stdio —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-acp/lib/index.js:1047-1053, 1318-1323`：

```js
1047	const name = "acp";
1049	const inject = ["agents", "llm", "sessionPersistence", "sessions"];
...
1318		/* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
1319		const stream = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
1323		}).onRequest(methods.agent.session.new, ...).onRequest(methods.agent.session.prompt, ...).connect(stream);
```

ACP 的 Config 只到 provider/model —— `dsh-acp/lib/index.js:1063-1067`；模块自述 `:1037`："Automation-only Agent Client Protocol server over JSON-RPC stdio."

**ACP SDK 自带 WS/HTTP 传输**（应用已分发 `@agentclientprotocol/sdk@1.4.0`） —— 解包出的 `@agentclientprotocol/sdk/package.json:36-55`：

```json
    "./experimental/http-client": { "import": "./dist/http-stream.js" },
    "./experimental/ws-client":   { "import": "./dist/ws-stream.js" },
    "./experimental/server":      { "import": "./dist/server.js" },
```

磁盘上确实有 `dist/ws-server.js`、`dist/ws-stream.js`、`dist/server-sse.js`、`dist/http-stream.js`、`dist/sse.js`（asar 内 `dsh/node_modules/@agentclientprotocol/sdk/dist/**`）。

SDK JSON-RPC server 只走 stdio —— `dsh-sdk-jsonrpc-server/lib/index.js:248-269`：

```js
248	const name = "sdk-jsonrpc-server";
249	const inject = ["agents"];
250	const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) });
257	function apply(ctx, config) {
...
261		const input = config.input ?? process.stdin;
263		const output = config.output ?? process.stdout;
...
268		const transport = new JsonRpcLineTransport(input, output);
```

MCP client 的传输与鉴权字段 —— `dsh-mcp-client/lib/index.js:39-46, 780-795`：

```js
39		switch (config.transport) {
40			case "stdio": return new StdioClientTransport({ ... });
46			case "streamable-http": return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
...
780	const Config = z.union([z.object({
781		transport: z.const("stdio"),
782		serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
...
792		transport: z.const("streamable-http"),
793		serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
794		url: z.string().required(),
795		headers: z.dict(String).default({}),
```

Webhook 运行时 vs HTTP 适配器 —— `dsh-webhook/lib/index.js:274`（`super(ctx, "webhookRuntime")`）只做规则注册/派发；真正的监听在 `dsh-webhook-github/lib/index.js:178-191`：

```js
178	function apply(ctx, config) {
180		assertConfig(config);
181		const route = {
182			kind: "exact",
183			path: config.path,
184			handler: createGitHubWebhookHandler(ctx, { source: ..., secretEnv: credentialRef(config.secretEnv), maxBodyBytes: config.maxBodyBytes })
185		};
190		ctx.effect(() => ctx.webServer.register(route), `webhook-github: ${config.path}`);
191	}
```

验签 —— `dsh-webhook-github/lib/index.js:116-127`：

```js
116			if (!isJsonContentType(request.headers["content-type"])) throw new WebhookHttpError(415, ...);
118			const signature = requiredHeader(request, "x-hub-signature-256");
121			const credential = await ctx.credentials.resolve(config.secretEnv);
...
125				verified = await new Webhooks({ secret: credential.value }).verify(body, signature);
127			if (!verified) throw new WebhookHttpError(401, "invalid webhook signature");
```

**另一个 in-tree 的"插件自己开监听端口"范例**（非常关键，见 B8）：`dsh-experimental-speech-to-text-sensevoice/lib/worker.js:145-151, 196-203`：

```js
143	/** Authenticated loopback transport for one serial native recognizer. */
151	async function startRecognitionServer(token, maxAudioBytes, transcribe) {
152		const expected = Buffer.from(`Bearer ${token}`);
153		const server = createServer((request, response) => {
157			const authorization = Buffer.from(request.headers.authorization ?? "");
158			if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
160				reply(401, { error: "Unauthorized" });
...
196			server.listen(0, "127.0.0.1", () => {
203				port: server.address().port
```

---

### B8. Windows 上开监听端口 / 发现对等机的注意事项

**结论**

1. **不需要新依赖就能开监听**：Node 内置 `node:http`/`node:net`/`node:dgram` 全可用；DSH 已经有一个 in-tree 范例（sensevoice worker，`listen(0, "127.0.0.1")` + Bearer token）。**in-tree 里没有任何 mdns/bonjour/SSDP/zeroconf 实现**。
2. **asar 里可用的现成网络库**（能被 installation interception 解析到，见 A3）：
   - `ws@8.x`（服务端/客户端 WebSocket；`dsh-api-gateway` 的 dependencies）
   - `@agentclientprotocol/sdk@1.4.0`（含 WS/SSE/HTTP 传输）
   - `@modelcontextprotocol/client@2.0.0`（含 StreamableHTTP）
   - `undici@8.x`、`got@14.x`（HTTP 客户端）
   - Node 24 本身有全局 `fetch` / `WebSocket`（客户端侧）
3. **`0.0.0.0` 绑定在 DSH CLI 层被明确拒绝**（`dsh-web-app/lib/startup.js:40`），但 webserver schema 与 LAN 信任推导都支持它——所以"要让主机的 19387 端口对局域网开放"这件事，在**当前版本被产品决策挡住**（理由写在错误信息里："would expose remote code execution to the network"）。第三方插件若自己 `listen` 一个新端口，则完全不受这条限制（那是它自己的 socket）。
4. **Windows 防火墙**：DSH 代码里没有任何防火墙处理。绑 `0.0.0.0`（或任何非 loopback）时会触发 Windows Defender Firewall 的"允许访问"对话框，且**对话框的进程名是 Electron / node 宿主进程**，不是插件；如果用户点"取消"或规则被限制为专用网络，插件端口在局域网上不可达。绑 `127.0.0.1` 不触发防火墙，但也就无法被对端访问。
5. **服务发现**：**没有现成依赖**。已搜索 `bonjour|bonjour-service|mdns|multicast-dns|node-ssdp|ssdp|zeroconf|dns-discovery|libp2p|socket.io|mDNSResponder`（整个 12967 个 asar 条目）→ **0 命中**。要做发现只能：(a) 手工配置对端 IP（写进插件 Config / `$DSH_HOME/storages/...`）；(b) 用 `node:dgram` 自己实现 UDP 多播公告（Windows 上需注意多播需放行、以及"公用网络"配置档会静默丢弃入站）；(c) 走 `node:os.networkInterfaces()` 枚举（DSH 自己就是这么做的，见 `dsh-web-app/lib/index.js:84`）。
6. **沙箱不拦网络**：`dsh-sandbox-windows-acl` 只限制**写/删**（"confines child-process writes and deletes to the workspace and a private temporary directory"），没有网络命名空间/防火墙能力。所以插件进程与管理工具进程的网络能力一致。
7. **IPC 已存在但不是网络**：desktop 场景 Electron ↔ Host 走 `process.send` 子进程 IPC（`dsh-desktop-host/lib/index.js:248-269`），不是 TCP。

**证据**

in-tree 唯一自建 listener —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/worker.js:196-203`：

```js
196			server.listen(0, "127.0.0.1", () => {
...
203				port: server.address().port
```

`ws` 随应用分发、且是 `dsh-api-gateway` 的 dependencies —— `app.asar/dsh/node_modules/@deepseek-ai/dsh-api-gateway/package.json:54`（`"ws": "^8.21.0",` 位于 `dependencies`）；实际包 `dsh/node_modules/ws/package.json:2-4`：

```json
  "name": "ws",
  "version": "8.22.0",
  "description": "Simple to use, blazing fast and thoroughly tested websocket client and server for Node.js",
```

实际使用 —— `dsh-api-gateway/lib/index.js:8`：`import WebSocket, { WebSocketServer } from "ws";`；`:179` `server = new WebSocketServer({ noServer: true });`（挂在 `webServer.registerUpgrade` 上，自己不开端口）。

`networkInterfaces()` 枚举范例 —— `dsh-web-app/lib/index.js:84`：

```js
84		const lanAddresses = bindHost === ALL_INTERFACES_HOST ? Object.values(networkInterfaces()).flat().filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal).map((iface) => iface.address) : [];
```

沙箱只管写删 —— `dsh-sandbox-windows-acl/README.md:12`：

```
On Windows, this package confines child-process writes and deletes to the workspace and a private
temporary directory: `workspace-write` grants both, `read-only` grants neither.
```

**未找到（已搜索关键词）**：
- `bonjour`、`bonjour-service`、`mdns`、`multicast-dns`、`node-ssdp`、`zeroconf`、`dns-discovery`、`libp2p`、`socket.io`、`mDNSResponder` → **全 asar 0 命中**（12967 条目）。
- `express` / `fastify` / `hono` / `koa` → **0 命中**：HTTP 全靠 `node:http` + 自研路由（`dsh-host-webserver`）。
- DSH 代码里的防火墙 / `netsh` / `New-NetFirewallRule` → 无。

---

## C. 给"第三方插件开局域网端口做主机↔从机通信"的直接结论

按"最省事 → 最重"排序：

1. **复用共享 webServer + 自己 `register()` 路由（推荐）**
   - Host 从机插件：`ctx.inject(['webServer'], c => c.effect(() => c.webServer.register({ kind: 'exact'|'prefix', path, handler }), '...'))`，或需要长连接就 `registerUpgrade`。
   - **优点**：零新依赖；端口/压缩/index 注入都由宿主管；进程已在（Electron 主进程）。
   - **必须自己做**：鉴权（参考 `dsh-webhook-github` 的 HMAC 或 sensevoice 的 Bearer + `timingSafeEqual`）、同源/CSRF（参考 notify 的 `sameOrigin`）、body 上限。**别指望 webserver 帮你挡**。
   - **限制**：只有 `127.0.0.1` / `0.0.0.0` 两个 host 值，且 `0.0.0.0` 只能通过 patch 改 config（CLI 拒绝），并且需要把对端 authority 加进 `connection.trustedHosts` 才有 LAN 信任语义（虽然你自己的路由不受该栅栏约束，但浏览器访问 `/api` 会）。
2. **插件自己 `node:net`/`node:http` 开独立端口**
   - 完全绕开 DSH 的产品策略（包括 `0.0.0.0` 禁令），端口自己选（建议默认 `127.0.0.1` + 显式 Config 打开 LAN）。
   - 需要自己处理：Windows 防火墙首次放行、无 mDNS（对端 IP 靠配置）、TLS（局域网明文要自己评估）。
   - `ws` 可直接 import（见 A3/B8），或干脆用 `webServer.registerUpgrade` 省掉 `ws` 依赖。
3. **复用 Typert Remote（`/api` + `/api/remote.mux`）**：协议完备（unary/stream/uplink/cancel/重连/心跳），但需要从机扮演 DSH Web Client 并完成 `token → cookie` 交换与 Host 头栅栏，且 `$mount()` 只在 Client 侧。**高成本、强耦合内部协议**（B6）。
4. **用 ACP / ACP SDK 的 WS/HTTP 传输**：`@agentclientprotocol/sdk@1.4.0` 已在包里且带 `ws-server`/`ws-stream`/`http-stream` 实现，是**真正为"跨进程驱动 agent"设计的协议**（Zed 生态）。用它做主机↔从机最"对味"，代价是要自己接 transport（DSH 的 `dsh-acp` 只接 stdio）并且鉴权仍要自建。
5. **MCP streamable-http**：让从机当 MCP server（`url` + `headers` 鉴权），主机用 `dsh-mcp-client` 直接挂——**几乎零胶水**，缺点是把能力表达约束成 tools/resources/prompts，且 `dsh-mcp-client` 是"Host 当 client"，不能反向。
6. **Webhook 入口**：适合"从机 → 主机投递一个任务"，不适合双向指令通道（fire-and-forget，返回 202）。

---

## 附：本次调研的解包产物（可复现）

| 路径 | 内容 |
|---|---|
| `.research\asar-tool.mjs` | 单文件 `list`/`sizes`/`extract`（pickle 头解析） |
| `.research\asar-extract-all.mjs` | 按正则批量解包 |
| `.research\asar\@deepseek-ai\**` | 2911 个文件 / 52.2 MB，全部 DSH 包（`lib/index.js` 与 `lib/types/**/*.d.ts` 可直接读） |
| `.research\asar-root\` | 根 `package.json`、`dsh/package.json`、`dsh/desktop-runtime.json`、根 `node_modules/@deepseek-ai/{cordis,cosmokit,schemastery,dsh-brand,dsh-deque,dsh-timeout,dsh-typert-protocol,dsh-api-gateway}` |
| `.research\asar-third\` | `@agentclientprotocol/sdk`、`@modelcontextprotocol/{client,core}`、`ws`、`got` 的 `package.json` |

**官方文档位置**（本次最重要的发现）：插件开发文档以 skill 形式随应用分发在
`app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/`
—— `cordis-plugin-development/{SKILL.md, references/*.md, templates/*}` 与
`cordis-composition-reference/references/packages.md`（512 行，全部可加载插件的注册表）。
asar 内**没有** `docs/` 目录（已搜索 `^dsh/docs/` → 0 命中），README 里引用的 `docs/api-gateway.md` 只在源码 checkout 存在。

**已确认读不到的东西**（明确列出，免得被当成"没查"）：`docs/api-gateway.md`、`docs/subsystems/typert.md`、`.agents/notes/**`（源码 checkout 内容，不在 asar）；`dsh-agent-preset` skill 目录在 Desktop 下位于 asar 内，shell/glob/grep/node 都打不开（`SKILL.md:38`），只能用本报告的 asar 解析法读取。
