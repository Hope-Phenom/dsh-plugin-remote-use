# 从机实地勘察报告 — worker-pc

> 勘察时间：本会话；方式：SSH 免密登录 + 只读命令。**未在从机上修改任何配置。**

## 1. SSH 运维通道（已建立）

| 项 | 值 |
|---|---|
| 主机名 / IP | `worker-pc` / `192.168.1.101`（mDNS 解析，ARP MAC `02-00-00-00-00-01`） |
| 登录账户 | `WORKER-PC\sheng`（**管理员**） |
| 认证 | ed25519 公钥，免密已生效（`ssh -o BatchMode=yes` 返回 0） |
| 私钥位置（主机） | `C:\Users\you\.dsh-remote-ops\id_ed25519_worker-pc`（ACL 仅当前用户） |
| 主机 config | `~/.ssh/config` 中 `Host worker-pc` 块 |
| 从机 authorized_keys | `C:\ProgramData\ssh\administrators_authorized_keys`（ACL 已收紧，无继承） |
| 服务 | MSI 版 OpenSSH（`C:\Program Files\OpenSSH`），`sshd` 已注册自启；防火墙 `sshd-22` Profile=Any |

**排障记录**：MSI 首次安装未注册 `sshd` 服务（只有 `ssh-agent`），且原防火墙规则 `Profile: Private` 与实际的 `Public` 网络不匹配。卸载后用 MSI 重装解决。

## 2. 硬件与系统

| 项 | 值 |
|---|---|
| OS | Windows 11，`10.0.26200`（25H2 一代） |
| CPU | 13th Gen Intel Core i5-13400 |
| RAM | 15.6 GB |
| 磁盘 | `C:` 181.4 / 300 GB 可用；`D:` 299.7 / 300 GB 可用；`E:` 353.3 / 353.5 GB 可用 |
| 显示器（物理） | Intel UHD Graphics 730 @ 1920×1080 |
| 显示器（RDP） | Microsoft Remote Display Adapter @ 2560×1440 |

磁盘充裕，但**注意 §6.8：同步峰值需要 3 倍工作区**，staging 必须与目标同卷。

## 3. 🔴 DSH 已安装，版本与本机一致

| 项 | 值 |
|---|---|
| 安装路径 | `C:\Users\worker\AppData\Local\Programs\DeepSeek Harness`（1,015 MB） |
| **版本** | **`0.2.0-rc.2`（与本机完全相同）** |
| 更新通道 | `channel: nightly`，feed `download.deepseek.com/dsh-desk/feeds/win-x64/` |
| DSH home | `C:\Users\worker\.dsh`（有 `profiles` / `sessions` / `storages`） |
| 模型凭据 | `.credentials.yaml` 存在（223 B，2026-10-10 11:33）→ **从机可独立访问模型** |
| `dsh` on PATH | ❌ 不在（只有桌面快捷方式） |

**从机的 profile 配置**（`profiles/desktop/package.json`）：

```json
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-experimental-agent-team-profile",
  "@deepseek-ai/dsh-experimental-auto-review",
  "@hope_phenom/dsh-plugin-code-quality"
]
```

关键含义：

- ✅ **版本一致** → 协议协商层当前可通过
- ⚠️ **nightly 通道 + 两机独立更新** → 版本随时可能漂移，**协商层不是可选项而是必需品**
- ✅ 从机已有 `auto-review` bundle（虽然按 §2.3/§3.1 的结论，ACP 会话用不到它）
- ✅ 从机可独立工作、有凭据（符合"完整 DSH 机器"的定位）

## 4. 🔴 会话拓扑 —— 对 GUI 方案影响最大

```
SESSIONNAME   USERNAME   ID    STATE      DEVICE
services                 0    Disconn
console                  1    Conn       (无用户)
rdp-tcp#0     sheng      2    Conn       2560x1440    ← 用户在这里
rdp-tcp                  65536 Listen
```

| 事实 | 含义 |
|---|---|
| **`sheng` 的交互会话在 Session 2（RDP）** | ✅ 存在真实交互桌面 → **GUI 自动化可行** |
| explorer.exe 运行中，PID 7520 / Session 2 | ✅ 桌面已加载 |
| **SSH 落地在 Session 0（services）** | 🔴 **Session 0 没有交互桌面** |
| `rdp-tcp` 65536 在 Listen | 用户当前/近期是通过 **RDP** 连的 |
| DSH 桌面进程未在运行 | 从机的 DSH 当前没启动 |

### 4.1 🔴 设计结论：从机中继**不能以服务或 SSH 方式运行**

因为 SSH 命令落在 Session 0，而 Session 0 无桌面。任何从 Session 0 启动的进程做 GUI 操作都会失败。

⇒ **从机中继必须是运行在用户交互会话（Session 2）里的进程**，也就是从机的 DSH Desktop 应用本体。这**恰好印证了已定的设计决策**（从机跑完整桌面实例 + 插件），但把「为什么不能做成 Windows 服务」变成了硬约束。

### 4.2 ⚠️ RDP 会话语义带来的两个待解问题

| 问题 | 影响 |
|---|---|
| **断开 RDP 会锁屏/断会话** | GUI 自动化在锁屏下通常失败（截图黑屏、UI 不可交互）。从机需要保持 RDP 连接，或用 `tscon` 把会话移交控制台 |
| **分辨率随会话类型变化** | 物理控制台 1920×1080 vs RDP 2560×1440。**同一测试在两种会话下看到的布局不同** |

⇒ 需要在设计里明确：**从机必须固定在一种会话形态下跑 GUI 测试**，并且测试不能依赖分辨率。建议在从机的「工作节点」页把当前会话类型/分辨率显示出来。

## 5. 工具链

| 工具 | 状态 |
|---|---|
| `git` | ✅ `C:\Program Files\Git\cmd\git.exe` |
| `pwsh` | ✅ PowerShell 7 已装（`C:\Program Files\PowerShell\7\pwsh.exe`） |
| **`node` / `npm` / `pnpm`** | ❌ **全部未安装** |
| `python` | ⚠️ 只有 `WindowsApps\python.exe`（**很可能是 Microsoft Store 占位别名**，需实测确认） |

`node` 缺失**不影响 DSH 本体**（Electron 自带 Node runtime），但会影响：

- 工作区同步里的 `rehydrate` 步骤（`npm ci` 重建依赖）—— 需要从机装 Node
- 若 GUI 测试用 Playwright/Puppeteer —— 需要 Node

## 6. 浏览器与自动化驱动

| 项 | 状态 |
|---|---|
| Chrome | ❌ 未安装 |
| **Edge** | ✅ `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| Firefox | ✅ `C:\Program Files\Mozilla Firefox\firefox.exe` |
| **chromedriver / msedgedriver / geckodriver** | ❌ **深度 ≤3 全盘未找到** |

⇒ **从机当前不具备任何 GUI 自动化能力。** 这是你整个需求的核心能力，需要在 P0/P1 之前补齐。三条路：

1. **Edge + msedgedriver**（最省事，Edge 已装，微软官方支持）
2. **Playwright**（推荐：自带浏览器管理、跨浏览器、截图/等待语义完善；但需装 Node）
3. 从机装 Chrome + chromedriver

## 7. 对设计的净影响

| 设计条目 | 影响 |
|---|---|
| §3.2 从机形态（完整桌面实例） | ✅ 确认正确；**并升级为硬约束**：不能做成服务 |
| §4.1 协议版本协商 | ✅ 必需的（两机 nightly 独立更新） |
| §6.6 blob 走独立 HTTP 通道 | ✅ 不变 |
| §6.8 staging 同卷 + 3 倍空间 | ✅ 磁盘充裕（D: 300 GB / E: 353 GB 可用） |
| 新增约束 §7.x | 🔴 **中继必须运行在交互会话**；从机不能以服务形态部署 |
| 新增约束 | ⚠️ **会话形态（RDP vs 控制台）与分辨率必须固定并上报** |
| 新增待办 | 从机需安装：Node（若用 Playwright）、自动化驱动、目标浏览器 |

### 7.1 新增未决项

| # | 问题 |
|---|---|
| U11 | 从机保持 RDP 连接 vs `tscon` 移交控制台 vs 保持本地登录——哪种作为标准部署形态？ |
| U12 | 从机 GUI 自动化技术栈选型（Edge+msedgedriver / Playwright / Chrome） |
| U13 | 从机是否需要装 Node（取决于 U12 与 rehydrate 需求） |
| U14 | 从机的 `python` 是否可用（Store 占位别名会弹窗，属于「意外的副作用」，与 `dsh-plugin-notify` 里处理过的坑同类） |

## 8. 下一步建议

1. **先在从机上手工验证 GUI 自动化能跑通**（这是所有设计的前提）：装驱动 → 在 Session 2 里跑一个最小脚本 → 确认截图正常、点击有效。**如果这一步不成立，整个插件的价值主张就要重新评估。**
2. 然后做 P0：`dsh --profile acp` ↔ 最小 WS 中继 ↔ 最小 ACP client。注意中继必须在 Session 2 里跑。
3. 再谈工作区同步——从机磁盘充裕，这块风险低。

## 9. 安全提醒

- 私钥落在主机 `C:\Users\you\.dsh-remote-ops\`，ACL 已收紧为仅当前用户。**该密钥对 `worker-pc` 拥有完全控制权，建议纳入你的密钥管理流程或定期轮换。**
- 从机 `sshd` 现已对局域网开放 22 端口（`Profile Any`）。若要收紧，可改为 `RemoteAddress 192.168.1.0/24` 限定来源网段。
