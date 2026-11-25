# @hope_phenom/dsh-plugin-remote-use

[English: `README.md`](README.md)

把 [DSH](https://www.deepseek.com/) 的任务委托给局域网里另一台已配对的**工作节点**执行，像调用子 Agent 一样驱动它。

**解决什么问题**：GUI 自动化测试和"看屏幕才知道结果"的验证必须在一台真能操作鼠标键盘的机器上跑。
在本机做就会**和操作者抢电脑**——抢焦点、抢光标、抢剪贴板。这个插件把那部分工作推到一台专门的节点上，
任务的核心逻辑仍留在主机。

```text
主机 DSH ── ACP over WebSocket ──▶ 从机中继 ──▶ 从机 DSH（在从机本地跑任务、截图、看 GUI）
   │                                  ▲
   └── 审批 / 审计 / 会话级开关 ────────┘
```

## 安装

**通过 DSH 的插件管理器安装**（它能同时完成装包、注册到 profile 的 `bundles`、启用三件事）：

```
插件管理器 → 安装 → @hope_phenom/dsh-plugin-remote-use
```

装完**重启 DSH**。这就是全部 —— 插件管理器是普通用户装任何插件的那条路。

<details>
<summary>手动安装（插件管理器不好用时的退路）</summary>

```powershell
# 装到某个 profile（这一步只把文件放进去）
npm install --prefix "$env:USERPROFILE\.dsh\profiles\<profile>" @hope_phenom/dsh-plugin-remote-use
```

**光装不够 —— 还必须把包名加进该 profile 的 `dsh.profile.bundles`**，否则它不会被加载。
profile 的 `package.json` 长这样：

```json
"dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@hope_phenom/dsh-plugin-remote-use" ] } }
```

然后在该 profile 的补丁层里加**一类**条目：插件自身的配置 —— worker 列表（url / token / cwd）。

**不需要**为每台从机写"工具行"（0.2.0 起）。早期版本要求加一条 `dsh-tool-subagent` 行、
`provider: remote-<worker id>`；那条路**即使写对也不生效**，因为 Web 会话的模型工具目录由
**agent preset** 枚举，而不是由 loader 树决定。插件现在自己注册委派工具 `remote_subagent`，
走的是它四个 `remote_*` 工具已经在用的那条路。若你按旧文档写过
`tool-subagent-remote-*` 那一块，可以直接删掉。

</details>

> **完整的安装步骤、可直接抄的 YAML、从机侧部署、安全模型与排查方法，见
> [仓库 README](https://github.com/Hope-Phenom/dsh-plugin-remote-use#readme)。**
> 这份文件只覆盖 npm 页面上必须说清楚的部分。

## 使用（速览）

1. **默认是关闭的。** 在需要用到工作节点的那个会话里输入：

   ```text
   /remote-use on
   ```

   开关**按会话生效且不持久化**——重启后回到 off，新会话里远程工具不可见。**在对话中途切换也生效**：
   切换会让该会话的下一次请求开启一个新的 request series，模型实际收到的工具清单随之改变
   （PITFALLS F47 —— 没有这一步时，中途新增的工具会被当作"延迟增量"投递，模型拿不到 schema）。

2. 让模型去做需要 GUI 的事。它会先调 `remote_selfcheck` 确认节点可用，再委托。

| 模型可见的工具 | 用途 |
|---|---|
| `remote_subagent` | **把任务派到工作节点上执行**，像调用子 Agent 一样。`run_in_background: true` 则不占住当前对话 |
| `remote_selfcheck` | 节点就绪报告。**委托前先调它**——未就绪的节点会被派单门禁拒绝 |
| `remote_agents` | 查看任务进度；`action: status` / `wait` 盯某一个任务，**任务落定后把它的答案正文一并取回** |
| `remote_screenshot` | 抓节点屏幕并落盘到主机，然后用 `read_image` 看 |
| `remote_file` | **在主节点与工作节点之间传文件**——`action: send` / `fetch` / `list` / `stat`。不需要 SSH、不需要 `scp`、节点上不需要任何配置，而且它**不占用节点唯一的 GUI 任务槽**，所以 GUI 任务在跑的时候也能传 |
| `remote_interrupt` | 停止任务（协作式） |

后台派单的结果这样取回（这是后台模式唯一的路）：

```text
remote_subagent { prompt: "…", run_in_background: true }   →  taskId: rtask_xxx
remote_agents   { action: "status", taskId: "rtask_xxx" }  →  状态 + 完整答案
```

⚠️ `run_in_background: true` **不是"立刻返回"**：一台节点同时只跑一个任务（GUI 是独占资源），
节点忙时这个调用会**先排队等轮到自己**（实测等过 32 秒）。

设置页（**设置 → 远程工作节点**）可以管理节点、处理**提权审批**、查看**审计留痕**、
调整委派策略，以及把本机**布防为工作节点**（对称配对）。

> **任务目录（`cwd`）是从机上的绝对路径**，任务在那里运行，**也是沙箱允许写入的范围**。
> 在从机的布防面板里填一次，它会**写进配对串**（**0.2.1 起**），主机粘贴后自动带上。
> 主机侧**拒绝保存**没有可用任务目录的节点——那种配置永远无法派单成功。

## 安全模型（要点）

- **默认关闭** —— 新会话不注入策略、远程工具在该会话内不可见
- **沙箱必须真实生效** —— 沙箱无法被证明时**拒绝**启用 worker 模式，不是警告。
  从机需要的两样东西（mediator 目录、指名它的 `sandbox` 行）都是**手工部署物**，会消失；
  所以「本机角色」在**页面加载时**就报告状态，并在缺失时给出**填好本机路径、可直接执行**的命令
  （`lib/tools/prepare-sandbox-mediator.mjs`）。它只物化 + 仅在 profile 没有该行时追加 + 跑同一个
  探针，幂等、可 `--dry-run`；**页面不会替你执行** —— 写的是插件自身状态之外的文件。
- **提权永不自动批准** —— `needsHuman` / `danger-full-access` 进人工审批队列，超时按拒绝
- **会话自己的沙箱档位是部署设置，默认 `danger-full-access`** —— 在作为工作节点的那台机器上设置
  （**设置 → 远程工作节点 → 本机远程会话的沙箱档位**），布防时写进启动规格。它是**部署值**而不是逐任务
  谈判，理由是实测的：GUI 程序在受限令牌下起不来是**静默失败**（命令返回成功，只留一个桌面对话框），
  因此这类失败**永远进不了审批队列**。只跑受限任务的工作节点就设成 `workspace-write`。
  主机侧能看到该节点**实际自报**的档位。
- **凭据不回传浏览器** —— 页面只拿到掩码
- 节点侧必须**真的登录进桌面**：锁屏时无法注入输入

## 让启动规格与设置保持一致

`workerSessionMode` 是**部署值**：布防时写进 ACP 启动规格，**不会**改动已经在运行的会话。

### 布防时的模型（`workerModel`）

**设置 → 远程工作节点 → 本机远程会话的模型**，填 `provider/model`（例如 `deepseek-official/deepseek-flash`）。
它和档位是同一类**部署值**，但作用的是"从机的 agent 用哪个模型"：

- 布防时以插件自己的 **`--patch` overlay** 注入 ACP 启动配置，**不修改你的 `cordis.patch.yml`**；
- 留空 = 沿用从机 profile 里配的模型（旧行为）；
- 它决定 `initialize` 的 `promptCapabilities.image`：模型不声明 image 输入时，主机**不能**向从机发图，
  从机的 `read_image` 也会失败 —— 而且这是**静默**的。所以布防时会先用本机模型目录解析这个 id：
  **不存在就拒绝布防**，存在但不带图则给警告（纯文本节点是合法选择，只是别指望它读图）；
- 改了需要**重新布防**：overlay 是启动规格的一部分，运行中的中继不会自己换。

> 为什么不能按任务指定：`dsh-acp` 在 `initialize` 时就按**配置的** provider/model 定下图片能力，并固定给这条连接；
> `session/set_config_option` 只改会话路由，不会重新 advertise。所以它是部署值，不是逐任务参数。

### 从机环境自动配置（提示词）

从机的 GUI 就绪项（虚拟显示器、分辨率与原点、QuickEdit、屏保、睡眠/休眠、被测应用……）可以**交给从机自己的
DSH 会话**去做：把随包发布的 [`lib/tools/selfcheck-fix-prompt.md`](lib/tools/selfcheck-fix-prompt.md) 整段粘进
从机的对话即可。它会：

- 找到并运行 `slave/selfcheck.ps1`，读 `selfcheck.json`；
- 按报告逐项修复（blocking 优先），每步贴原始输出；
- 需要管理员、装驱动、或**需要人登录/解锁**的步骤，停下来说明，不假装成功；
- 最后复跑自检并对比修复前后的 `checks`。

> 自检必须在**已登录、已解锁的交互式桌面会话**里跑（DSH 桌面进程所在的那个）。SSH/服务会话里跑出来的
> `session=0`、S1=0 块屏是假阴性。

- **插件托管的从机**（中继由插件拉起）：运行中修改档位**不会**改写那个中继的启动规格。设置页现在
  同时显示**保存值**和**运行中中继实际使用的档位**，两者不一致时明确提示**需要重新布防**。先停止
  再布防即可生效；凭据跨重启保留，所以**不需要重新配对**。
- **手管中继**（计划任务直接跑 `relay.mjs --cmd-file agent-spec.json`）：不带 `--permission-mode`
  运行 `node slave/make-launch-spec.mjs --out agent-spec.json` 时，它会读取插件设置文件里的
  `workerSessionMode`，所以手工路径也跟随设置页；显式传 `--permission-mode` 仍然优先。中继自己也会
  读同一个设置文件，在规格与设置不一致时报告 `sessionModeMismatch` 和一条警告检查（`S19`），启动时
  还会打一行醒目日志。重建规格并重启中继即可。

> **如果不想每次升级插件都重新部署 `slave/`**，停掉计划任务，改用设置页的
> **远程工作节点 → 本机角色 → 布防为工作节点**。中继会从已安装的插件包启动，升级插件 + 重启 DSH
> 就够；启动规格是临时文件，每次布防自动重建。代价是中继只在 DSH 运行时存在 —— 如果要在登录前
> 就监听，请保留计划任务。

## 工作目录里的 GUI：低完整性陷阱

只要工作目录曾经跑过 `workspace-write`，它就会带上**可继承的 Low 强制标签**。复制进去的文件继承
该标签，而 Windows 会把带 Low 标签的镜像**以低完整性启动**——即使父进程令牌是 High。现象是 GUI 程序
写 `%LOCALAPPDATA%` 抛 `UnauthorizedAccessException`，而 agent shell 写同一路径完全正常，看起来像
ACL 或应用缺陷，而不是沙箱残留。

- `danger-full-access` 下，中继会在启动时**修复显式布防的任务目录**（`icacls ...
  /setintegritylevel (OI)(CI)Medium /T`）。这是关掉沙箱后的正确配套：那个标签已经不再保护任何东西。
  传 `--no-integrity-repair` 可保留标签；传 `--repair-integrity` 才允许修复中继继承来的 cwd（系统目录
  仍然拒绝）。
- 手管中继应传 `--task-dir <workspace>`，这样自动修复与 S20 探针都有明确的目录。手工修复：
  `powershell -File slave/repair-workspace-integrity.ps1 -Path <workspace>`。
- 如果希望 GUI 载荷完全待在工作目录之外：
  `powershell -File slave/stage-app.ps1 -Source <app-dir> [-Launch]`，它会复制到
  `%LOCALAPPDATA%\dsh-remote-use\staging\...` 并把暂存目录设为 Medium。
- `remote_selfcheck` 会把工作目录与 `%TEMP%` 的读数写进 `integrity`，并作为 `S20` 检查上报。降级是
  **警告**而不是阻断：机器仍然可达，但 GUI 工作会一直失败，直到标签被修复。

## 运行要求

- Node ≥ 20
- 主机与工作节点都装 DSH
- 工作节点有一个**已解锁的交互式桌面会话**
- 工作节点上运行 `slave/relay.mjs`（随包提供，含它需要的 `ws` 依赖）

## 文档

| | |
|---|---|
| [仓库 README](https://github.com/Hope-Phenom/dsh-plugin-remote-use#readme) | 完整安装、使用、运维 |
| [设计文档](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/DESIGN.md) | 设计取舍与决策记录 |
| [踩坑与教训](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/PITFALLS.md) | 开发中真实遇到的问题及**发现方式** |
| [接口契约](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/INTERFACES.md) | 上游 API 与集成事实 |

## 许可

MIT
