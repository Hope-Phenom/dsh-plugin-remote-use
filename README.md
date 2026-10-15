# dsh-plugin-remote-use

把 DSH 的任务委托给局域网里另一台已配对的工作节点执行，**像调用子 Agent 一样驱动它**。

```text
主机 DSH ── ACP over WebSocket ──▶ 从机中继 ──▶ 从机 DSH（在从机本地跑任务、截图、看 GUI）
   │                                  ▲
   └── 审批 / 审计 / 会话级开关 ────────┘
```

## 为什么需要它

GUI 自动化测试和"看屏幕才知道结果"的验证，必须在一台**真的能操作鼠标键盘**的机器上跑。
如果直接在本机做，就会**和操作者抢电脑**：抢焦点、抢光标、抢剪贴板。

这个插件的做法是把那部分工作推到一台**专门的**工作节点上：

- **任务的核心逻辑仍然在主机**——规划、改代码、看结果都在这里
- **只有需要 GUI 的那一段**被委托到从机执行
- 从机的屏幕、鼠标、键盘与操作者本人完全隔离

## 边界（它不做什么）

| 不做 | 原因 |
|---|---|
| 远程桌面 / 原始鼠标键盘转发 | 委托的是**指令**，不是输入事件。从机上的 DSH 自己决定怎么做 |
| 工作区同步 | GUI 验证在从机本地跑，主机源码不需要同步过去 |
| 后台常驻子会话 | 委托是**一次性**的（`backgroundMode: one-shot`）。要看进度用 `remote_agents` 轮询 |
| `danger-full-access` 自动放行 | 提权一律进人工审批队列，**永远不自动批准** |

---

## 快速开始

### 1. 前置条件

| 位置 | 需要 |
|---|---|
| 主机 | DSH（本项目在 `0.2.0-rc.2` 上开发）、Node ≥ 20 |
| 从机 | DSH 已装并**已登录**、Node ≥ 20、一个**已解锁的交互式桌面会话** |
| 从机 | 沙箱 mediator 生效（见下方"安全模型"）——**沙箱不可用时会拒绝启用** |
| 从机 | **一个虚拟显示器**（见下）——不满足时自检的 S2 **阻断**派单 |

> **从机必须真的登录进桌面**。锁屏或无人登录时无法注入输入，自检会明确报出来。

#### 为什么从机需要一个虚拟显示器

不是为了"多一块屏"，而是为了**让显示固定下来**。勘察记录（`.research/07-slave-recon.md`）里的原始问题：

```
物理控制台 1920×1080  vs  RDP 2560×1440
⇒ 同一个测试在两种会话下看到的布局不同
```

再加上一条运维上的矛盾：**从机若要独占物理显示器，操作者自己就没屏用了**。虚拟显示器一次解决两件事：

| 好处 | 说明 |
|---|---|
| **坐标固定** | `1920×1080@60`、主屏在 `(0,0)` —— GUI 断言的坐标才有意义 |
| **不占用物理屏** | 物理显示器**可随时还给主机**；也不需要 RDP |
| **重启后保持** | Windows 记住布局，无人值守 |

参考实现是 **Virtual-Display-Driver (VDD)**（MIT）。自检里与之相关的检查：

| 检查 | 判据 | 级别 |
|---|---|---|
| **S1** | 至少一个 `ATTACHED_TO_DESKTOP` 的适配器 | 🔴 阻断 |
| **S2** | **虚拟显示器存在且有 EDID** —— 不能是 `WinDisc` 兜底 | 🔴 **阻断** |
| S3 | 主屏分辨率 `1920×1080` | 🟡 警告 |
| **S4** | **主屏必须在 `(0,0)`**（是不是虚拟屏写进报告，不阻断） | 🔴 **阻断** |

> **S2 与 `WinDisc`**：虚拟显示器被禁用或驱动加载失败时，Windows 会回落到 `WinDisc`（Microsoft 基本显示适配器）——通常是 `1024x768`。它**能**让 S1 通过，但**不是**约定的显示，所以 S2 单独把它判为阻断，报错文案就是 `virtual display present (not WinDisc fallback)`。
>
> **S4 阻断的是什么**：主屏不在 `(0,0)`。不在原点时，GUI 自动化的绝对坐标会**整体偏移**，而症状是"点了但点偏了"——**不会报错**。这是这个项目里最危险的失败模式。
>
> **S4 不阻断"主屏是物理屏"。** 这条要求一度被写成"必须是虚拟屏"（设计文档原本就是这么措辞的），
> 但在真机上发现它会**让从机无法登录**：
>
> > **Windows 11 的登录界面只画在主显示器上。** 虚拟显示器是主屏时，登录界面就渲染在一块
> > **没有物理输出**的屏上 —— 操作者的显示器**全程黑屏**，根本没法登录。
>
> 那条要求想保证的是"**坐标空间独立于操作者的显示器**"。而在**KVM 保持 EDID** 的接法下，
> Windows 从不认为显示器消失过 ✓ —— 这个保证**已经由硬件给出**了 ✓。坚持"必须是虚拟屏"
> 只会把登录界面挪到没人看得见的地方。
>
> 所以：**原点**是阻断项 ✓；**主屏是不是虚拟屏**写进报告 ✓（`actual` 里的 `virtual=True/False`），
> 让你看得见，但不拦你。
>
> ⚠️ **切换物理显示器不会让虚拟屏自动接任主屏。** KVM 让物理显示器**继续呈现 EDID**，
> Windows 因此**仍然认为它接着**，于是它继续是主屏 —— 实测如此。"切给主机后虚拟屏自动变成默认"这个预期**不成立**。
>
> **想让从机被派单，主屏在 `(0,0)` 即可** ✓ —— 物理屏当主屏完全可行 ✓，而且登录界面看得见 ✓。
> 坐标空间由那块主屏决定，所以**从机的工作分辨率应当是约定值 1920×1080**（S3 会就分辨率发警告）。
>
> ⚠️ **运维警告（来自实测）**：**大版本 GPU / 芯片组驱动更新可能与 VDD 冲突**，症状是开机黑屏（虚拟屏被排到物理屏前面）。**动显示相关配置前先确认 SSH 可用**，它是唯一的逃生通道。

### 2. 主机侧：装插件

**从零克隆之后先装依赖**（宿主侧与从机侧是两套，别漏第二条）：

```powershell
# 宿主侧：插件自身的依赖（ws、ACP SDK）
npm install --prefix packages/dsh-plugin-remote-use

# 从机侧：relay 的依赖（ws）。它必须随文件一起被拷到从机，
# 而 .gitignore 的 node_modules 规则在任意深度都匹配 —— 新克隆里没有它。
npm install --prefix packages/dsh-plugin-remote-use/slave
```

> 漏掉第二条时 `tools/deploy-slave.ps1` 会**拒绝执行并给出修复命令** —— 它不会拷一个跑不起来的中继过去。

**通过 DSH 的插件管理器安装**（它一次完成装包、注册进 profile 的 `bundles`、启用）：

```
插件管理器 → 安装 → @hope_phenom/dsh-plugin-remote-use
```

<details>
<summary>手动安装（插件管理器不好用时的退路）</summary>

```powershell
# 装到某个 profile —— 这一步只把文件放进去
npm install --prefix "$env:USERPROFILE\.dsh\profiles\desktop" @hope_phenom/dsh-plugin-remote-use
```

⚠️ **光装不够**：还必须把包名加进该 profile 的 `dsh.profile.bundles` ✓，否则**不会被加载** ✗。
profile 的 `package.json` 里那一节长这样（你已有的插件就是这么注册的 ✓）：

```json
"dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@hope_phenom/dsh-plugin-remote-use" ] } }
```

开发时也可以直接在 profile 的 `node_modules` 里放一个**指向本仓库的链接** ✓。

</details>

装完**重启 DSH**，设置页里就会出现「远程工作节点」。

**优先走设置页**：粘贴配对串 + 图形化配置，写入 `%USERPROFILE%\.dsh\storages\dsh-plugin-remote-use\settings.json`（**该文件存在时，profile 补丁里的同名配置不再生效**）。下面那个补丁层入口是等价的**配置即代码**路线——两种方式写的是同一批键，选一种即可。

<details>
<summary><code>%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml</code> 里要加什么（配置即代码路线）</summary>

```yaml
# ① 插件自身的配置
- id: dsh-plugin-remote-use
  config:
    workers:
      - id: worker-pc              # 也决定 provider 名：remote-worker-pc
        name: worker-pc
        url: 'ws://worker-pc:7331' # 建议用主机名，见下方"为什么用主机名"
        token: '<从机上 run-relay.ps1 里的同一个 token>'
        cwd: 'C:\dsh-remote\p0work'      # 从机上的绝对路径；也是沙箱允许写入的范围
        enabled: true
        serialQueue: 1                   # GUI 是独占资源：一个节点同时只跑一个任务
    approvalTimeoutMs: 90000
    requiredTier: workspace-write
    injectTaskSummary: true
# 就这些。0.2.0 起不需要再为每台从机写"工具行"
```

**关于工具行：0.2.0 起不再需要手写。**

早期版本要求在 profile 补丁里为每台从机加一条 `dsh-tool-subagent` 行（`provider: remote-<worker id>`）。
那条路**即使写对了也不生效**：Web 会话的模型工具目录由 **agent preset** 枚举
（`preset-standard.plugins`），不在表里的 loader 行挂了也不会出现在模型面前 —— 详见
[踩坑与教训 F11](docs/PITFALLS.md)。

0.2.0 改为**由插件自己注册委派工具** `remote_subagent`，与它已有的四个 `remote_*` 工具同一条路
（`ctx.tools.register`，按 agent 作用域）。所以：

- **装完插件就能用**，profile 补丁里只需要上面 ① 那段 worker 列表；
- 如果你按旧文档写过 `tool-subagent-remote-*` 那一块，**可以整块删掉**；
- 委派入口的工具名从 `subagent_remote` 改为 **`remote_subagent`**。

**为什么插件不能沿用 `dsh-tool-subagent` 那条现成的路**（记在这里，免得以后有人又去试）：
provider 确实是插件在运行时注册的，但**注册 provider 与把工具暴露给模型是两件事**——后者由
Web 会话的 **agent preset** 枚举（`preset-standard.plugins`），而那个列表里只有官方自己的四行
（`subagent` / `subagent_fork` / `subagent_codex` / `subagent_claude_code`）。
即便把那条 `dsh-tool-subagent` 行**正确地**写进 profile 补丁，**模型也看不到它**。
唯一不需要改 preset 的暴露方式，就是插件自己用 `ctx.tools.register()` 注册 —— 它已有的四个
`remote_*` 工具正是这么工作的。完整推导见 [踩坑与教训 F11](docs/PITFALLS.md)。

</details>

改完**重启 DSH**。

### 3. 从机侧：部署

一条命令（在主机上跑，走 SSH）：

```powershell
.\tools\deploy-slave.ps1 -Remote worker-pc -Destination C:\dsh-remote\plugin-slave
```

它会 `scp` 必需文件（含 `node_modules/ws`），然后**在从机上**验证：逐个 `node --check`、运行 `relay.mjs --print-pairing`、检查 `.ps1` 是不是纯 ASCII 且 `param()` 在第一条语句。**任何一步失败都以非零退出**。

> 这一步不能只靠"清点文件"。从机中继有三个**相对导入**模块和**一个裸包**（`ws`），漏掉任何一个的症状都是"从机连不上"——和网络故障完全一样。所以脚本的验收是**运行**，不是核对清单。

从机上用计划任务拉起中继（参考 `run-relay.ps1`）：

```powershell
node relay.mjs --port 7331 --token <secret> `
  --cmd-file agent-spec.json `
  --selfcheck-script selfcheck.ps1 `
  --screenshot-script screenshot.ps1
```

`agent-spec.json` 由 `slave/make-launch-spec.mjs` 生成——它复刻 DSH 的 `dsh.cmd`，用 **argv 数组**避开 Windows 引号问题。

### 4. 第一次使用

1. 打开 **设置 → 远程工作节点**，确认 worker 卡片显示**已连接**、自检**没有阻断项**
2. 在**需要用到从机的那个会话**里输入：

```text
/remote-use on
```

> **默认是关闭的。** 新会话里远程工具**不可见**，策略提示词也不注入。开关是**按会话**的，且**不持久化**——重启后回到 off。

3. 让模型去做需要 GUI 的事即可。它会先调 `remote_selfcheck` 确认从机可用，再委托。

---

## 日常使用

### 会话开关：`/remote-use`

| 输入 | 效果 |
|---|---|
| `/remote-use on` | 本会话：工具可用 + 注入委派策略 |
| `/remote-use off` | 本会话：工具重新隐藏、策略撤销 |
| `/remote-use status` | 看当前状态 |

**只影响当前会话。** 另一个会话即使同时开着，也各自独立。

### 模型可见的远程工具

| 工具 | 用途 |
|---|---|
| `remote_subagent` | **把一个任务派到工作节点上执行**，像调用子 Agent 一样。`run_in_background: true` 则不占住当前对话，**答案稍后用 `remote_agents` 取回** |
| `remote_selfcheck` | 从机就绪报告（阻断项 / 警告 / 会话段）。**委托前先调它**——未就绪的从机会被派单门禁拒绝 |
| `remote_agents` | 看任务进度与在途任务；`action: status` / `wait` 盯某一个任务，**任务落定后把它的答案正文一并给你** |
| `remote_screenshot` | 抓从机屏幕，落盘到主机，然后 `read_image` 看 |
| `remote_interrupt` | 停止任务（协作式：任务在下一个断点才真正结束） |

**后台派单怎么拿结果**（这是后台模式唯一的路）：

```
remote_subagent { prompt: "…", run_in_background: true }   →  taskId: rtask_xxx
remote_agents   { action: "status", taskId: "rtask_xxx" }  →  状态 + 完整答案
```

⚠️ **两个容易踩的点**：

- **`run_in_background: true` 不是"立刻返回"**。一台从机同时只跑一个任务（GUI 是独占资源），所以 worker 忙时这个调用会**先排队等轮到自己**（实测等过 32 秒）。派单前可以先 `remote_agents action="list"` 看看谁在忙。
- **`status` 读回的是留存下来的答案**，任务落定前没有答案可给（那时它只报进度）。答案上限 64 000 字符，超长时会在标题里写明"first N of M chars"，不会静默截断。

#### 取证：两条规矩，否则会以为"任务没执行"

**规矩一：任务结束后，它启动的 GUI 进程会被一起清理。**

所以「任务执行过」和「事后能看到它留下的界面」是两件事。如果提示词写"打开某程序，**不要关掉窗口，留给主机稍后查看**"，那条指令在任务结束的一瞬间就失效了——从机无权决定任务之后进程树是否存活。

**规矩二：按窗口需要活多久，选一种取证方式。**

| 需求 | 做法 |
|---|---|
| 想知道界面**长什么样** | 让**任务自己在运行期间**截图/断言，把结论写进返回值 |
| 窗口必须活到**主机来看** | `run_in_background: true` 派一个**明确保持存活**的任务（"启动后 `Start-Sleep`，期间不要关闭任何东西"），主机在它 `running` 时调 `remote_screenshot`，看完再 `remote_interrupt` |

**并且：从机的自述不能当证据。** 实测中它给过自相矛盾的报告 —— 同一份回复里既说"窗口存在：否"，又说"标题含 Windows 的窗口出现了：是"。真正定案的是**主机自己截的图**，以及从机**操作系统**留下的记录（事件日志里那次 `Application Error id=1000` 证明任务确实跑过）。实测对照表见[踩坑与教训 F14](docs/PITFALLS.md)。

### 设置页

| 区块 | 内容 |
|---|---|
| **本机角色** | 主机/从机两种身份。下方是**布防面板**：接口下拉、端口、**任务目录**、`先检查`、`布防为工作节点` |
| **工作节点** | 每个节点的卡片：连接状态、自检报告（可展开 17 项）、`重新自检` / `截图` / `连接测试` / `编辑` / `删除`。**配置有问题时卡片上直接标出来**（见下方"任务目录"） |
| **添加工作节点 / 粘贴配对串** | 不用手抄 url+token。配对串里带着从机的**任务目录**，所以通常什么都不用填 |
| **审批与连接** | 默认档位、审批超时、心跳间隔、**每个节点保留的截图数**、委派策略文案 |
| **等待你批准的请求** | 提权请求在这里等你**批准/拒绝**；超时按拒绝处理 |
| **最近的裁定** | 审计留痕（谁、何时、哪个工具、什么档位、结果） |
| **急停** | `全部急停`：打断所有在途任务 |

#### 任务目录：为什么必须由从机给出

`cwd` 是从机上的一个**绝对路径**：任务在这里运行，**同时也是从机沙箱允许它写入的范围**。因此：

- 它**只能由从机提供**——主机不可能猜出另一台机器上的路径，而猜错了不会报错，只会让任务**写到没人选过的目录**；
- **布防时**在「任务目录」里填一次，它会被**写进配对串**（**0.2.1 起**），主机粘贴后自动带上，不必手抄；
- **0.2.0 及更早的从机**产生的配对串**不带**这一项，那时主机的配对卡片会让你补一个 —— 或者先把从机更新到 0.2.1；
- 主机侧**拒绝保存**没有可用任务目录的 worker（400，且**什么都不写**）。理由很直接：这种配置**永远不可能派单成功**，早一点拒绝远好过第一次派单时才炸 `[REMOTE_BAD_CWD]`；
- 从机布防时**留空也可以**（就是"还没决定"），只是那样配对串里不带这一项，主机的「粘贴配对串」卡片会让你补一个；
- 从机侧若填了**相对路径**，`先检查` / 布防会直接拒绝——它会被当成合法路径写进配对串，而主机没有理由怀疑它。

> **为什么不是"警告后照样保存"**：一个连任务目录都没有的 worker，无论链路多健康、自检多绿，都**接不了任何单**。
> 把它存下来只是把一次必然的失败从"粘贴的那一刻"推迟到"下一次委派"，而那正是这个缺陷当初被发现的路径。

### 对称配对：把主机也变成从机

反过来也成立——本机可以**布防为工作节点**：

1. 设置页 →「本机角色」→ 选接口、**填「任务目录」**（本机上一个绝对路径，任务在那里运行并受沙箱约束）
2. `先检查` —— 跑沙箱门禁，并校验任务目录
3. 检查通过后 `布防为工作节点` —— **凭据和配对串只显示这一次**，配对串里已带上任务目录
4. 把配对串给对方，或让对方的设置页用「粘贴配对串」——正常情况下**不需要再填任何东西**

**布防会一直保持到手动关闭**（没有定时器）。`立即停止` 是**本地动作，不联系对端**。

---

## 安全模型

### 默认关闭

新会话不注入策略、远程工具**在该会话内不可见**。这不是"隐藏按钮"——`ctx.tools.restrict()` 是**按 agent 作用域**的（DSH 强制：全局限制会屏蔽所有 agent），外加一个执行守卫兜底，即使限制失败也**拒绝执行**。

### 沙箱必须真实生效

从机的 DSH 跑在受限沙箱里。**沙箱无法被证明生效时，布防会被拒绝**——不是警告，是拒绝。

自检里的六项行为检查会**实际执行**验证：工作区内写入成功（对照）、**工作区外写入被拒**、只读档无法写、只读档仍可读。

> **Windows 注意**：`dsh-sandbox-local` 用 `process.execPath` 构造 mediator 调用，而在 GUI 子系统镜像下（无控制台启动）它会在 DLL 初始化阶段死掉（`STATUS_DLL_INIT_FAILED`）。修法是在 profile 里把 `runnerCommand` 指向一个**控制台子系统**的 mediator（本项目用 `C:\dsh-sandbox-mediator\shim.mjs`），并用 `runnerFailureSignatures` 声明失败特征。

### 人工审批

`needsHuman` / `danger-full-access` 提权**永远不自动批准**：

- 请求进入主机的审批队列，页面上出现**批准 / 拒绝**
- **超时按拒绝处理**，且不打断任务
- 决定送达从机、任务继续，**审计留痕**（谁决定的、什么工具、什么档位）

### 凭据纪律

- worker token **绝不回传浏览器**——页面只拿到 `tokenSet` 和一个掩码
- worker 角色的凭据在**布防时生成一次**，明文**只回传一次**；之后只留掩码
- 配对串携带凭据，当作密码对待
- 从机角色的 token 持久化在 settings 文件里，**重启后保持**；但**再次布防会轮换**

### 设置页的写操作拒绝跨站请求

DSH 会认证**应用外壳**（直接 `GET /` 返回 401），但**不认证插件自己注册的路由** ——
所以这道门必须插件自己把。0.2.2 起：

- **POST 且 `Origin` 头存在且不是本机同源（含 `null`）→ 403**，而且是在**任何动作被分发之前**，
  所以被拒的请求不会写配置、不会开监听、不会打断任务；
- 判据用的是**请求自己的 `Host`**，所以用 `127.0.0.1:19387` 还是 `localhost:19387` 打开页面都正常；
- **没有 `Origin` 头则放行**：浏览器对 POST 一律带这个头（同源也带），所以"没有它"不可能来自
  恶意页面，只可能是 curl、脚本或本仓库的真机 harness；
- **读取不加门**：响应不带 `Access-Control-Allow-Origin`，跨站页面本来就看不到内容。

> 为什么非要有这道门：路由**不检查 `Content-Type`**，所以 `text/plain` 的 POST 照样被当 JSON 解析 ——
> 而 `text/plain` 是浏览器可以**跨站盲发、不触发 preflight** 的那种请求。详见
> [踩坑与教训 F17](docs/PITFALLS.md)。

### settings 文件的优先级

```text
内建默认  <  profile 补丁  <  settings 文件
```

`workers` 是**替换**语义。**文件存在时，profile 补丁里的同名配置不再生效**——插件会把这件事记进日志（`settings file applies: workers, ...`）。

---

## 运维

### 虚拟显示器挂了怎么恢复

**症状**：自检 `S2` 阻断、报 `virtual display present (not WinDisc fallback)`，派单被门禁拒绝。
在从机上（需要管理员）：

```powershell
# 1. 看设备状态。Error + CM_PROB_DISABLED(Code 22) 就是它
Get-PnpDevice -Class Display | Select-Object Status,Problem,FriendlyName,InstanceId | Format-List

# 2. 看当前实际生效的是哪块屏 —— 出现 WinDisc 就说明已经回落到兜底了
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.DeviceName) $($_.Bounds.Width)x$($_.Bounds.Height) at $($_.Bounds.X),$($_.Bounds.Y)" }

# 3. 重新启用
Enable-PnpDevice -InstanceId 'ROOT\DISPLAY\0000' -Confirm:$false

# 4. 让它生效并复核
Start-Sleep 5
Get-PnpDevice -Class Display | Select-Object Status,FriendlyName
```

**如果启用后马上又变回 Code 22**，那就不是"被谁禁用"，而是**驱动框架没起来**。VDD 是用户态（UMDF）驱动，依赖 `\Driver\WUDFRd`：

```powershell
# 开机时是否报过这个 —— 事件 219「驱动程序 \Driver\WUDFRd 加载失败」就是它
Get-WinEvent -FilterHashtable @{LogName='System'; Id=219} -MaxEvents 5 |
  Select-Object TimeCreated,Message | Format-List
```

这种情况**重新启用可能不持久**，会每次开机复发。排查方向：`WUDFRd` 服务的启动类型、VDD 驱动包是否完整（`pnputil /enum-drivers`）、以及最近是否动过 GPU/芯片组驱动。

> ⚠️ **动显示相关配置前先确认 SSH 可用** —— 它是唯一的逃生通道（设计文档 §7.8 的实测警告）。

### 排查顺序

```powershell
# 1. 沙箱是否真的生效（主机/从机角色的前提）
node tools\check-sandbox-ready.mjs --profile %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml

# 2. 从机在哪（IP 会变时）
.\tools\find-slave.ps1                # 扫网段 → 用从机自己的密钥认领 → 更新 hosts

# 3. 端到端真机测试（不需要第二台机器也能跑，见下）
node prototype\host\plugin-live.mjs --url 'ws://worker-pc:7331' --token <secret> --cwd 'C:\dsh-remote\p0work'
```

### 从机离线时的自查

从机自检报告在卡片的「显示全部检查」里。常见阻断项：

| 检查 | 含义 |
|---|---|
| **S9** 睡眠/休眠 | 从机会睡着掉线。`powercfg /change standby-timeout-ac 0`（交流+直流） |
| **S12** 控制台 QuickEdit | 在控制台里选中文本会**阻塞**正在运行的程序——GUI 自动化里很致命 |
| **S8** 合成输入 | `SetCursorPos` 失败。**注意**：从受限 shell（如 agent 的沙箱内）启动中继时这一项必然假失败 |
| **S14/S15** DSH 已装 / 已登录 | 路径从环境派生；报告里会写出**找了哪些位置** |
| **S18** 目标应用 | 未配置时是「未配置」而非「缺失」。用 `-App` 或 `DSH_SELFCHECK_APP` 指定 |

### 更新部署

```powershell
.\tools\deploy-slave.ps1 -Remote <host> -Destination <dir>   # 拷贝 + 在目标机上验证
schtasks /end /tn DshRelay ; schtasks /run /tn DshRelay      # 重启中继
```

### 备份

```powershell
python tools\dsh-env-backup.py backup  --to D:\dsh-backups --name before-upgrade --yes
python tools\dsh-env-backup.py verify  --from D:\dsh-backups\before-upgrade
python tools\dsh-env-backup.py restore --from D:\dsh-backups\before-upgrade
```

退出码：`0` 通过 · **`2` 有差异（工具本身正常）** · `3` 选项未实现 · `1` 操作失败 · `130` 中断。

---

## 测试

三套 harness：**单元**（`node --test`）、**冒烟**（假 `ctx` 挂载真 `apply()`）、**真机**（对着真 worker 跑完整协议）。
发布前都必须通过。命令、判据、以及"每条守卫为什么写成那样"，见 **[`docs/TESTING.md`](docs/TESTING.md)**。

> 真机 harness 不传 `--entry` 时测的是**安装件**，并且会打印它究竟从哪个文件加载。
> 那行必须留着：它曾经一边打印读起来像安装件的路径，一边加载**源码检出**（[踩坑 D12](docs/PITFALLS.md)）。

---

## 架构速览

主机侧一个 `apply()`：**每个 worker** 一个 `RemoteProvider`（注册进 `ctx.subagents`）+ 一个 `PeerConnection`
（`AcpBridge` + 心跳 + 截图），后者经 **ACP over WebSocket** 连到从机 relay，relay 再拉起从机的
`dsh --profile acp` 子进程。审批队列与审计日志在主机侧。

完整的组件图、各关注点落在哪个模块、以及从机形态，见 **[`docs/DESIGN.md` §3 架构总览](docs/DESIGN.md)**。

---

## 文档地图

根 README 只讲**这是什么、怎么用**；**知识都在 `docs/`**。索引页：[`docs/README.md`](docs/README.md)。

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计与全部决策记录（按轮次，含被推翻的结论） | 想知道**为什么这么设计** |
| [`docs/PITFALLS.md`](docs/PITFALLS.md) | **踩坑与教训总集**（A–G 七类，70 条，每条附当时的原始输出与**发现方式**） | **先看这个通常最省时间** |
| [`docs/INTERFACES.md`](docs/INTERFACES.md) | 上游契约与集成事实（provider 接缝、ACP、`ctx.tools.register`、Cordis 补丁语义） | 要改代码或写别的插件 |
| [`docs/TESTING.md`](docs/TESTING.md) | 三套 harness 的命令、判据与每条守卫的理由 | 跑测试、加守卫 |
| [`docs/research/`](docs/research/) | 当初的源码级调研原文与两轮验证发现（**归档**，有些结论已被推翻） | 考古、查"当时为什么这么想" |
| [`tools/README.md`](tools/README.md) | 运维工具说明（备份/还原、从机查找、沙箱检查） | 用那些脚本 |

## 已知限制

- **已验证**：从**发布包**（registry）安装的路径 —— 主机与从机各装 0.2.2 跑过完整真机回归；
  装好的件与仓库源码**逐文件哈希一致**
- **未验证**：两个会话**同时**向同一从机大量派单时的资源表现（串行队列本身已验证：实测第二个任务
  等前一个结束才开始）
- 从机 `run-relay.ps1` 默认保留 **20 张**截图（约 190 MB 上限）；用 `--keep-shots` 调整（负数表示不清理）
- 配对串里带的是从机**当时的 IP**——用主机名写配置才能在 IP 变化后幸存
- 设置导航栏的图标由 DSH **硬编码**，插件无法替换（插件提供的图标显示在**插件管理页**）

## 许可

[MIT](LICENSE) © Hope.Phenom
