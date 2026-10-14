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
| **S4** | **虚拟屏必须是 primary 且在 `(0,0)`**（两半都要满足） | 🔴 **阻断** |

> **S2 与 `WinDisc`**：虚拟显示器被禁用或驱动加载失败时，Windows 会回落到 `WinDisc`（Microsoft 基本显示适配器）——通常是 `1024x768`。它**能**让 S1 通过，但**不是**约定的显示，所以 S2 单独把它判为阻断，报错文案就是 `virtual display present (not WinDisc fallback)`。
>
> **S4 为什么是阻断级**：主屏不在原点时，GUI 自动化的绝对坐标会**整体偏移**，而症状是"点了但点偏了"——**不会报错**。这是这个项目里最危险的失败模式，所以它比分辨率（警告）更严格。
>
> ⚠️ **S4 检查的是两件事：主屏必须是虚拟屏，且位于 `(0,0)`。** 早期版本只查了原点这一半，
> 于是在一台真从机上出现：物理显示器（Intel 适配器、**竖屏 1080×1920**）在 `(0,0)` 且是主屏 →
> **S4 通过、派单放行**，而约定的 1920×1080 虚拟屏闲置。S3 只会就分辨率发警告，没有别的检查能拦住。
> 现已修正为**两半都满足才算通过**。
>
> ⚠️ **切换物理显示器并不会让虚拟屏自动接任主屏。** KVM 会让物理显示器**继续呈现 EDID**，
> Windows 因此**仍然认为它接着**，于是它继续是主屏、继续在 `(0,0)` —— 实测如此。
> 所以"把显示器切给主机，虚拟屏就变成默认"这个预期**不成立**。
>
> **要让从机变成可用状态，必须显式把虚拟屏设为主屏**（VDD 自带控制程序，或显示设置里指定），
> 而不是指望系统自动重排。
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

然后把包放进某个 profile 的 `node_modules`，**并在同一个 profile 的补丁层里加两类条目**。

```powershell
# 装到某个 profile 里（DSH 从 profile 的 node_modules 解析插件）
npm install --prefix "$env:USERPROFILE\.dsh\profiles\desktop" dsh-plugin-remote-use

# 或者在开发时用 link: 指向本仓库
```

<details>
<summary><code>%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml</code> 里要加什么</summary>

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

# ② 每个 worker 一行模型可见的工具行
- insert:
    - id: tool-subagent-remote-aoko
      name: "@deepseek-ai/dsh-tool-subagent"
      config:
        provider: remote-worker-pc   # 必须等于 remote-<worker id>
        toolName: subagent_remote
        backgroundMode: one-shot
        maxDepth: provider-managed
        modelSelectionSettings: false
```

**两个容易踩的点：**

- **`insert:` 是必需的。** 在补丁层里，带 `id` 的条目是**覆盖**已有条目，不是新增。忘了写 `insert:` 会得到 `patch: entry "<id>" not found`。
- **`agentOptions` / `persona` / `toolFilter` 必须完全不出现。** 哪怕写成空值，`dsh-tool-subagent` 的 `provider-added` 监听器也会抛错，而 Cordis 的 `emit` 会传播监听器异常，导致整个 provider 注册被回滚。

**为什么需要第二类条目**：provider 是插件在运行时注册的，但**模型可见的工具行是静态装载器条目**——插件无法在运行时追加。所以每个要能被调用的 worker 都需要自己的一行。

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
| `remote_selfcheck` | 从机就绪报告（阻断项 / 警告 / 会话段）。**委托前先调它**——未就绪的从机会被派单门禁拒绝 |
| `remote_agents` | 看任务进度与在途任务 |
| `remote_screenshot` | 抓从机屏幕，落盘到主机，然后 `read_image` 看 |
| `remote_interrupt` | 停止任务（协作式：任务在下一个断点才真正结束） |

### 设置页

| 区块 | 内容 |
|---|---|
| **本机角色** | 主机/从机两种身份。下方是**布防面板**：接口下拉、端口、`先检查`、`布防为工作节点` |
| **工作节点** | 每个节点的卡片：连接状态、自检报告（可展开 17 项）、`重新自检` / `截图` / `连接测试` / `编辑` / `删除` |
| **添加工作节点 / 粘贴配对串** | 不用手抄 url+token |
| **审批与连接** | 默认档位、审批超时、心跳间隔、**每个节点保留的截图数**、委派策略文案 |
| **等待你批准的请求** | 提权请求在这里等你**批准/拒绝**；超时按拒绝处理 |
| **最近的裁定** | 审计留痕（谁、何时、哪个工具、什么档位、结果） |
| **急停** | `全部急停`：打断所有在途任务 |

### 对称配对：把主机也变成从机

反过来也成立——本机可以**布防为工作节点**：

1. 设置页 →「本机角色」→ `先检查`（跑沙箱门禁）
2. 检查通过后 `布防为工作节点` —— **凭据和配对串只显示这一次**
3. 把配对串给对方，或让对方的设置页用「粘贴配对串」

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

三个 harness，**都必须通过**：

```powershell
# 单元（不需要任何外部资源）
cd packages\dsh-plugin-remote-use ; node --test

# 冒烟：用假 ctx 挂载真 apply()，检查装配（用临时 DSH_HOME，不碰你的配置）
cd prototype\host ; node plugin-smoke.mjs

# 真机：对着一个真的 worker 跑完整协议
node prototype\host\plugin-live.mjs --url <ws-url> --token <token> --cwd <worker-path>
```

**没有第二台机器时**也可以跑真机测试——先用回环布防一个工作节点：

```powershell
node tools\arm-loopback-worker.mjs                    # 宣告一行 JSON，含 url 与 token
# 然后 plugin-live 指向它
```

> `arm-loopback-worker.mjs` 由 agent 的 shell 启动时会**继承 DSH 沙箱**，从机自检的 S8（合成输入）会假失败。要避开就用 `tools\run-unconfined.ps1` 把它放到计划任务里跑。

### 真机测试会实际验证什么

链路连通 · 17 项自检 · 委派任务完成 · **真实截图且校验 PNG 签名** · 每会话开关（新会话工具被拒、`on` 后放行、**另一会话仍关**、`off` 后恢复） · **人工审批闭环**（提权进队列 → 决定送达 → 任务完成 → **审计留痕**） · 本机角色状态（**永不含 token**）

---

## 架构速览

```text
┌─ 主机 ────────────────────────────────────────────────────────┐
│ 插件 apply()                                                  │
│  ├─ 每个 worker 一个 RemoteProvider（subagents.registerProvider）│
│  ├─ 每个 worker 一个 PeerConnection = AcpBridge + 心跳 + 截图   │
│  │    └─ ACP over WebSocket ──▶ 从机 relay ──▶ 从机 DSH(acp)   │
│  ├─ 审批队列（人工决定）+ 审计日志（append-only JSONL）          │
│  └─ 设置路由 /api/dsh/dsh-plugin-remote-use                    │
└───────────────────────────────────────────────────────────────┘
```

| 关注点 | 落点 |
|---|---|
| 模型怎么看到工具 | 静态装载器条目 `tool-subagent-remote-*`（**不是**插件注册的） |
| provider 名 | `remote-<worker id>`，与工具行里的 `provider` 必须一致 |
| 委托是同步还是异步 | `start()` 返回 run 句柄，`run.result` 等待完成 |
| 一个节点同时几个任务 | `serialQueue`（默认 1）——GUI 是独占资源 |
| 截图怎么回来 | 走 relay 的 HTTP 侧（不走 ACP 消息泵，避免 base64 膨胀） |
| 提权怎么问人 | 从机 DSH 发 `session/request_permission` → 主机桥接 → 审批队列 |

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计文档与全部决策记录（含每一轮的验证与发现） |
| [`docs/INTERFACES.md`](docs/INTERFACES.md) | 上游契约与集成事实 |
| [`docs/PITFALLS.md`](docs/PITFALLS.md) | **踩坑与教训总集**——开发过程中真实遇到的问题及发现方式 |
| [`tools/README.md`](tools/README.md) | 运维工具说明（备份/还原、从机查找、沙箱检查） |
| [`.research/`](.research/) | 源码级调研报告（子 Agent 接缝、插件与传输、ACP 可行性、审批模型、API 验证、工作区同步） |

## 已知限制

- **未验证**：从**发布包**安装的路径（本项目用 `link:` 安装）、两个会话**同时**向同一从机大量派单时的资源表现
- 从机 `run-relay.ps1` 默认保留 **20 张**截图（约 190 MB 上限）；用 `--keep-shots` 调整（负数表示不清理）
- 配对串里带的是从机**当时的 IP**——用主机名写配置才能在 IP 变化后幸存
- 设置导航栏的图标由 DSH **硬编码**，插件无法替换（插件提供的图标显示在**插件管理页**）

## 许可

[MIT](LICENSE) © Hope.Phenom
