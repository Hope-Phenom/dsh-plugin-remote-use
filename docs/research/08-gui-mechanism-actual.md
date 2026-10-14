# GUI 测试实际机制 — 源码级确认

> 结论来源：`F:\WorkSpace\libvlc3-bridge` 的实际实现与证据文档，**非推测**。
> 用户记忆为「对启动的进程发 Windows 消息、等价于真人点击」；实机实现与之**在关键点相反**。

## 1. 权威证据

| 文件 | 作用 |
|---|---|
| `libvlc3-bridge\avalonia-demo\tools\verify-criteria.ps1`（419 行） | **唯一做点击验证的脚本**，端到端验收（场景 A 正常 / B 注入原生子窗口的对照组） |
| `libvlc3-bridge\qt5-flicker\evidence\dvd-mouse-inject.md`（312 行） | 鼠标注入专题文档，含三条注入通路的实测对照 |

`verify-criteria.ps1` 头部注释（`:10-13`）直接给出了设计取舍：

```
# Both checks use REAL input injection (SetCursorPos + mouse_event), not PostMessage:
# PostMessage delivers straight to the target window procedure and therefore bypasses the
# z-order / hit-testing that the whole airspace question is about. It happily "clicks" a
# button that is completely covered, which is exactly the wrong answer here.
```

**这段是整个方案的关键：不是「不知道 PostMessage」，而是「刻意拒绝 PostMessage」。**

## 2. 实际使用的三级机制

### 2.1 注入层 = 真实系统输入（`SendInput`）

```csharp
// verify-criteria.ps1:167-206
// Real synthetic input: goes through the OS hit test, so a covered control stays covered.
// SendInput, not mouse_event. Measured: the legacy mouse_event API dropped the click on
// [some attempts, which made the] harness look flaky. SendInput is the supported path
// and takes a batch atomically.
public static void RealClick(int sx, int sy) {
    SetCursorPos(sx, sy);
    INPUT[] down = ...  MOUSEEVENTF_MOVE, MOUSEEVENTF_LEFTDOWN
    SendInput(2, down, cb);
    INPUT[] up = ...    MOUSEEVENTF_LEFTUP
    SendInput(1, up, cb);
    // 失败才回退 mouse_event
}
```

所以是 **`SetCursorPos` + `SendInput(MOUSEEVENTF_*)`**，实际光标会移动。

### 2.2 判据层 = `WindowFromPoint`（硬判据）

```csharp
// Which window would receive a real click at this screen point. THE hard criterion.
public static string ClassAt(int x, int y) => ClassOf(WindowFromPoint(p));
```

这与 Qt 侧的 `WindowFromPoint(center)` 是同一把尺子（跨两套实现一致）。

### 2.3 前台抢占 = `AttachThreadInput` 舞步

```csharp
// verify-criteria.ps1:125-151
// Real input goes to whatever is topmost at that screen point, and Windows refuses a plain
// SetForegroundWindow unless the caller is already foreground-eligible. The classic way
// around it is to temporarily share the input queue with both the current foreground
// window's thread and the target's. Without this the click silently goes nowhere whenever
[we are not foreground]
AttachThreadInput(myThread, fgThread, true);      // 与当前前台线程共享输入队列
AttachThreadInput(myThread, targetThread, true);  // 与目标线程共享
SetForegroundWindow(h);
AttachThreadInput(..., false);                    // 还原
```

### 2.4 还有重试与前置校验

- 点击前用 `WindowFromPoint` + `GetAncestor` **校验光标下确实是自己的窗口**，否则跳过并打诊断（`:286-300`）
- 点击**循环重试**：`verify-criteria.ps1:320-340`（"real input needs the window to actually be [foreground]"）
- `SetProcessDpiAwarenessContext(-4)`（PerMonitorV2）——**坐标正确性依赖 DPI 感知**
- 脚本注释明写：*"this script moves the mouse cursor; it restores the original position afterwards."*

## 3. `PostMessage` 为什么被否定

会话日志里记录了当时的推理过程：

> **"`PostMessage` to the parent HWND delivers the message straight to the parent's window proc, bypassing the child window entirely. Real OS input goes through `WindowFromPoint` → the child window. So PostMessage is NOT a valid hit-test."**
> "my verification method was wrong"

对一个**研究空域（airspace）遮挡问题**的测试来说，这个区别就是被测对象本身：
- `PostMessage` → 会「点中」一个**完全被遮住**的按钮 → 假绿
- `SendInput` → 走 z-order 命中测试 → 被遮住就点不到 → 正确

## 4. 与用户记忆的差异对照

| 用户记忆 | 实际实现 |
|---|---|
| 「对启动的进程发 Windows 消息」 | ❌ 用的是**系统级合成输入**（`SendInput`/`mouse_event`），不是窗口消息 |
| 「直接发送鼠标点击的事件消息」 | ⚠️ 发的是 `MOUSEEVENTF_*` 输入事件，**不是 `WM_LBUTTONDOWN` 消息** |
| 「这样和人鼠标点击是等价的」 | ✅ **这句完全正确**，而且正是刻意追求的性质——但代价是它**真的会移动光标、会抢前台** |
| 隐含：「不抢用户的鼠标」 | ❌ **会抢**。`SetCursorPos` 移动真实光标，`AttachThreadInput`+`SetForegroundWindow` 抢前台 |

**所以「避免与本人抢占计算机交互」这个诉求不是优化，而是这套测试方式的必然结果。**

## 5. 另一个注入通路：应用内 API 注入（vd 文档）

`dvd-mouse-inject.md` 记录了对 DVD 菜单的三种注入方式，其中**直接注入**是最优雅的一条：

```
VlcEngine::dvdMouseSend(x, y, click)
  → var_SetChecked(vout, "mouse-moved",   (x,y))
  → var_SetChecked(vout, "mouse-clicked", (x,y))
  → libvlc 内部 ⇒ dvdnav_mouse_select() / dvdnav_mouse_activate()
```

**这条路完全在进程内**，不需要窗口消息、不需要光标、不需要前台。文档里实测 `currentTitle 0→99`（菜单进正片）三次复现，且有空白处点击的对照组。

但它需要：
- 目标应用**自己**暴露这类注入接口（这里是 VLC 内核的 `VLC_VAR_COORDS` 变量）
- 或者能注入代码进目标进程（DLL 注入 + 调用内部 API）

**这条路线的性质与 `SendInput` 相反：不抢鼠标、不抢前台、可后台运行。** 但它要求对每个被测应用做适配（不是通用黑盒方案）。

## 6. 对远程从机方案的净影响

### 6.1 确认「浏览器 driver 无关」

已从设计剔除。相关的是：目标应用 + 输入注入能力 + 会话/桌面状态。

### 6.2 🔴 新增硬约束（比之前更强）

| # | 约束 | 原因 |
|---|---|---|
| D1′ | **注入进程必须与目标应用在同一交互会话** | `SendInput` 是会话作用域的；`AttachThreadInput` **不能跨会话**。所以从机的 DSH（内含本插件与测试脚本）必须运行在 Session 2，**不能靠 SSH 启动**（SSH 落在 Session 0） |
| D2′ | **从机会话必须处于已登录、未锁屏、且非断开的 RDP** | 断开的 RDP 会话窗口不可见；锁屏停止渲染。两者都会让 `SendInput` 路径失效 |
| D3′ | **从机的会话类型 + 分辨率 + DPI 缩放必须固定并上报** | 坐标正确性依赖 `SetProcessDpiAwarenessContext` 与屏幕几何。主机 1920×1080 / 从机 RDP 2560×1440，坐标不可直接搬 |
| D4′ | **从机测试期间不能有别人用鼠标** | `SendInput` 移动真实光标、`SetForegroundWindow` 抢前台；真实用户一动就打断测试 |
| D5′ | **从机上不能有安全软件阻断合成输入** | 部分 EDR/杀软会拦截 `SendInput`（也让 `mouse_event` 更不可靠） |

### 6.3 D2′ 的一个直接后果：RDP 断开会话

从机当前状态：`rdp-tcp#0 sheng 2 Conn 2560x1440`。**用户一旦断开 RDP，会话状态变化，GUI 测试会失效。** 可选缓解：

1. 保持 RDP 常连（简单，但要求一台设备一直挂着）
2. `tscon <sessionid> /dest:console` 把会话移交控制台，使其在无人连接时仍保持活动桌面
3. 从机保持本地登录 + 关闭锁屏（显示器可关，但会话不能锁）

**这三条都要实测验证**（列为本项目 U11 的验收条件）。

### 6.4 一个可能大幅简化方案的机会

`dvd-mouse-inject.md` 的**应用内 API 注入**路线不抢鼠标、不抢前台、不需要解锁。

- 如果**每个被测应用**都能暴露类似的注入接口（哪怕只是一个调试用 CLI/命名管道/共享内存环形命令队列）
- 那么从机方案里「会话必须保持解锁 + 不能有人用鼠标」这两条硬约束**全部消失**，而且主机侧的多任务并发也不再受 GUI 独占限制

代价：需要**给每个被测应用做适配**（一次性开发成本），而不是通用黑盒点击。

⇒ **这是一个值得在实现前先评估的架构分叉**：通用黑盒（`SendInput`）vs 应用内适配（每个 app 加一个测试命令通道）。前者零适配但强约束；后者需适配但约束几乎全消。

### 6.5 现有测试矩阵

| 脚本 | 用真实输入 | 说明 |
|---|---|---|
| `verify-criteria.ps1` | ✅ | **唯一**做点击的验收脚本（场景 A/B） |
| `capture-demo.ps1` | ❌ | 只抓屏 |
| `verify-drag.ps1` | ❌ | 用 `SetWindowPos` 驱动 resize，不点鼠标 |
| `verify-perf.ps1` / `verify-resize.ps1` / `verify-soak.ps1` | ❌ | 纯测量 |

⇒ **只有 `verify-criteria.ps1` 这一个脚本真正需要被搬到从机。** 这让 P0 验证的成本比预想低得多。

---

## 7. 从机输入注入实测（本机 → worker-pc，2026-10-12）

用一份自写的探针脚本（`.research/probe-input-session.ps1`）在从机上实测，对照三种会话形态。

### 7.1 三种形态的实测结果

| 指标 | **SSH / Session 0** | **RDP Session 2（客户端已断）** | **`tscon` 移交控制台后** |
|---|---|---|---|
| `SessionId` | 0 | 2 | 2 |
| `UserInteractive` | `False` | `True` | `True` |
| `OpenInputDesktop` | ❌ err=203 | ✅ OK | ✅ OK |
| `ShellWindow`（`GetShellWindow`） | `<null>` | `Progman` | `Progman` |
| 顶层窗口数 | 1 | 154 | 141 |
| `GetCursorPos` | `0,0`（假值） | `0,0`（假值） | **`540,960`（真实）** |
| `SetCursorPos` | ❌ `False` | ❌ `False` | ✅ **`True`** |
| 光标实际移动 | ❌ | ❌ | ✅ **`400,300`** |
| **`SendInput` 返回** | ❌ **0/3** | ❌ **0/3** | ✅ **3/3** |

### 7.2 关键结论

1. 🔴 **SSH 落在 Session 0，`SendInput` 完全不可用（0/3）** —— `AttachThreadInput` 不能跨会话，`WindowFromPoint` 返回 `<null>`。**SSH 只能当部署/运维通道，绝不能用来跑 GUI 测试。**
2. 🔴 **「会话存在」不等于「桌面可用」**。RDP 会话在 `query session` 里显示 `Active`、`UserInteractive=True`、`OpenInputDesktop=OK`、有 154 个顶层窗口、`Progman` 在——**但 `SetCursorPos` 仍失败、`SendInput` 仍 0/3**。
   根因：`Get-NetTCPConnection -LocalPort 3389 -State Established` **为空** —— RDP 客户端早已断开，会话虽在但**没有显示设备附着**，桌面不渲染。
3. ✅ **`tscon <id> /dest:console` 是有效的无人工方案**：把会话移交给物理控制台后，`SendInput` 立刻变成 3/3、光标真实可移。**断开 RDP 也不再影响**，因为会话已绑到控制台而非 RDP 通道。

### 7.3 可复制的激活流程（已验证）

必须用 **SYSTEM** 身份执行（交互式用户跑 `tscon` 会因缺少 `SeTcbPrivilege` 失败）：

```powershell
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument '/c tscon 2 /dest:console > C:\tscon.log 2>&1'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'DshTscon' -Action $action -Principal $principal -Force
Start-ScheduledTask -TaskName 'DshTscon'
```

迁移后 `query session` 应显示 `console  sheng  2  Active`。**这一步应做成从机配对时的标准前置动作之一（或至少在诊断页暴露）。**

### 7.4 ⚠️ 迁移后暴露的两个新环境风险

**(a) 🔴 分辨率与主机的差异比预期更大**

| 项 | 值 |
|---|---|
| 显卡能力（Intel UHD 730） | 1920×1080 |
| **tscon 后实际桌面** | **`WinDisc` 1024×768（primary）** |
| 物理控制台会话 1（无人） | 未附着 |
| 之前 RDP 会话 | 2560×1440 |

物理显示器很可能**没开**，Windows 因此启用了替代/虚拟显示设备，桌面落在 **1024×768**。

⇒ **坐标空间与主机（1920×1080）和与 RDP（2560×1440）都不同。** 如果你们的 GUI 测试对分辨率/布局敏感（空域测试几乎必然敏感），**从机的桌面分辨率必须被固定成与主机一致**，否则测试结果不可比。

**(b) ⚠️ 屏保是开着的**

`ScreenSaveActive = 1`。屏保触发会让桌面进入非渲染状态 → `SendInput` 再次失效。**无人值守测试必须关闭屏保**，并处理锁屏策略。

### 7.5 ✅ 真实端到端验证：在从机上跑通

**结论：`verify-criteria.ps1` 在从机 `worker-pc` 上完整通过（两个场景全绿）。**

部署量很小：`avalonia-demo` 的 `bin\Debug\net10.0` 去掉 `.pdb` 与非 win-x64 原生库后 **30.6 MB / 40 文件**，纯托管 + SkiaSharp，**不需要 VLC SDK、不需要测试 ISO**（不带 `-Vlc` 时用合成帧源）。

从机实际输出：

```
=== scenario A-normal ===
  [occl] try  1: class='Avalonia-55e78b45-...' pid=17636 ours=1
  probe point  : client 368,374  screen 480,509
  WindowFromPoint class = 'Avalonia-...'  (expected '~Avalonia*')  => MATCH
  before click : probeClicks=0 childHwnds=0 present=503 import=5 fault=0
  [click] try 1: foregroundOurs=1 probeClicks delta=1
  click reached the probe: True  (expected True)

=== scenario B-control-group ===
  [occl] try  1: class='AsDemoAirspaceProbe' pid=5124 ours=1
  probe point  : client 368,374  screen 558,587
  WindowFromPoint class = 'AsDemoAirspaceProbe'  (expected 'AsDemoAirspaceProbe')  => MATCH
  [click] try 1: foregroundOurs=1 probeClicks delta=0
  click reached the probe: False  (expected False)

================ verdict ================
PASS: A the probe takes the click; B a native child window covers it and the click never arrives
SCRIPT COMPLETED NORMALLY
```

`verify-report.txt`（机器可读）：

| Scenario | ClassOk | ExpectClick | Clicked | Pass | ChildHwnds | **LuidMatch** |
|---|---|---|---|---|---|---|
| A-normal | True | True | **True** | ✅ | 0 | **True** |
| B-control-group | True | False | **False** | ✅ | 1 | **True** |

**这证明了整条链在从机上成立**：

| 环节 | 证据 |
|---|---|
| 应用能在从机启动 | pid 17636 / 5124，存活 |
| `WindowFromPoint` 的 z-order/遮挡判据正确 | A 命中 `Avalonia-*`，B 命中 `AsDemoAirspaceProbe` |
| **`SendInput` 真实输入可用** | 两次都是 `try 1` 一次成功，`foregroundOurs=1` |
| 点击真的到达 Avalonia 控件 | A `probeClicks delta=1` |
| 点击被原生子窗口正确挡住 | B `delta=0`、`childHwnds=1` —— **空域问题判据完整复现** |
| 抓屏可用 | `verify-A-normal.png` 88 KB、`verify-B-control-group.png` 74 KB |
| GPU 互操作在 Intel 核显上成立 | `LuidMatch=True`、`interop import=5 fault=0`、`present=608` |

### 7.6 ⚠️ 主从硬件差异（影响测试可比性）

| 项 | 主机 | 从机 |
|---|---|---|
| GPU | **NVIDIA RTX 3050**（drv 32.0.16.1742）+ ToDesk 虚拟显示适配器 | **Intel UHD Graphics 730**（drv 32.0.101.7092） |
| 桌面分辨率 | 2048×1152 + 1080×1920（双屏） | 1024×768（`WinDisc`） |
| DPI 缩放 | — | scale=1.00 |

对**空域/遮挡这类结构判据**无影响（判据是窗口类与点击到达与否，与 GPU 无关）。但以下类别**不可跨机比较**：

- 性能/延迟（`avgInvokeMs`、`copyUs`、帧率）—— 核显与独显差异巨大
- 任何依赖渲染后端行为的判据（ANGLE/驱动回退路径）
- 若测试对窗口尺寸敏感，1024×768 与主机双屏的布局不同

⇒ **设计含义**：从机上报能力清单时必须包含 **GPU 型号 + 驱动版本 + 桌面分辨率 + DPI 缩放**，主机据此决定该派哪类任务。

### 7.7 部署配方（已验证，可复用）

```
从机目录布局（必须保持 tools/ 与 avalonia-demo/ 的相对关系）：
C:\dsh-remote\avalonia-demo\
├── tools\verify-criteria.ps1
├── avalonia-demo\bin\Debug\net10.0\        ← 40 文件 / 30.6 MB
└── evidence\                                ← 输出/截图

执行（必须落在交互会话，且会话已 tscon 到控制台）：
schtasks 以 Interactive 主体注册 → 运行 wrapper → Start-Transcript 抓完整输出
```

⚠️ **踩坑记录**：直接用 `schtasks` 把 `verify-criteria.ps1` 的输出用 `*>&1 | Out-File` 重定向会**只得到 scenario 头就结束**。改用 **`Start-Transcript`** 后一次通过。推测与 `$ErrorActionPreference='Stop'` 加上调度任务的输出流处理有关。**从机侧执行器应统一用 transcript 而不是管道重定向。**


