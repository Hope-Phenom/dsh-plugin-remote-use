# dsh-plugin-remote-use

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

```powershell
npm install dsh-plugin-remote-use
```

然后把包链接到某个 DSH profile，并在该 profile 的补丁层里加**两类**条目：

1. **插件配置** —— worker 列表（url / token / cwd）
2. **每个 worker 一行工具行** —— `provider: remote-<worker id>`

第二部分不能省：provider 是插件在运行时注册的，但**模型可见的工具行是静态装载器条目**，
插件无法在运行时追加。

> **完整的安装步骤、可直接抄的 YAML、从机侧部署、安全模型与排查方法，见
> [仓库 README](https://github.com/OWNER/dsh-plugin-remote-use#readme)。**
> 这份文件只覆盖 npm 页面上必须说清楚的部分。

## 使用（速览）

1. **默认是关闭的。** 在需要用到工作节点的那个会话里输入：

   ```text
   /remote-use on
   ```

   开关**按会话生效且不持久化**——重启后回到 off，新会话里远程工具不可见。

2. 让模型去做需要 GUI 的事。它会先调 `remote_selfcheck` 确认节点可用，再委托。

| 模型可见的工具 | 用途 |
|---|---|
| `remote_selfcheck` | 节点就绪报告。**委托前先调它**——未就绪的节点会被派单门禁拒绝 |
| `remote_agents` | 查看任务进度 |
| `remote_screenshot` | 抓节点屏幕并落盘到主机，然后用 `read_image` 看 |
| `remote_interrupt` | 停止任务（协作式） |

设置页（**设置 → 远程工作节点**）可以管理节点、处理**提权审批**、查看**审计留痕**、
调整委派策略，以及把本机**布防为工作节点**（对称配对）。

## 安全模型（要点）

- **默认关闭** —— 新会话不注入策略、远程工具在该会话内不可见
- **沙箱必须真实生效** —— 沙箱无法被证明时**拒绝**启用 worker 模式，不是警告
- **提权永不自动批准** —— `needsHuman` / `danger-full-access` 进人工审批队列，超时按拒绝
- **凭据不回传浏览器** —— 页面只拿到掩码
- 节点侧必须**真的登录进桌面**：锁屏时无法注入输入

## 运行要求

- Node ≥ 20
- 主机与工作节点都装 DSH
- 工作节点有一个**已解锁的交互式桌面会话**
- 工作节点上运行 `slave/relay.mjs`（随包提供，含它需要的 `ws` 依赖）

## 文档

| | |
|---|---|
| [仓库 README](https://github.com/OWNER/dsh-plugin-remote-use#readme) | 完整安装、使用、运维 |
| [设计文档](https://github.com/OWNER/dsh-plugin-remote-use/blob/master/docs/DESIGN.md) | 设计取舍与决策记录 |
| [踩坑与教训](https://github.com/OWNER/dsh-plugin-remote-use/blob/master/docs/PITFALLS.md) | 开发中真实遇到的问题及**发现方式** |
| [接口契约](https://github.com/OWNER/dsh-plugin-remote-use/blob/master/docs/INTERFACES.md) | 上游 API 与集成事实 |

## 许可

MIT
