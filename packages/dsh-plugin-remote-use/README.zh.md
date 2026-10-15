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

   开关**按会话生效且不持久化**——重启后回到 off，新会话里远程工具不可见。

2. 让模型去做需要 GUI 的事。它会先调 `remote_selfcheck` 确认节点可用，再委托。

| 模型可见的工具 | 用途 |
|---|---|
| `remote_subagent` | **把任务派到工作节点上执行**，像调用子 Agent 一样。`run_in_background: true` 则不占住当前对话 |
| `remote_selfcheck` | 节点就绪报告。**委托前先调它**——未就绪的节点会被派单门禁拒绝 |
| `remote_agents` | 查看任务进度；`action: status` / `wait` 盯某一个任务，**任务落定后把它的答案正文一并取回** |
| `remote_screenshot` | 抓节点屏幕并落盘到主机，然后用 `read_image` 看 |
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
- **沙箱必须真实生效** —— 沙箱无法被证明时**拒绝**启用 worker 模式，不是警告
- **提权永不自动批准** —— `needsHuman` / `danger-full-access` 进人工审批队列，超时按拒绝
- **会话自己的沙箱档位是部署设置，默认 `danger-full-access`** —— 在作为工作节点的那台机器上设置
  （**设置 → 远程工作节点 → 本机远程会话的沙箱档位**），布防时写进启动规格。它是**部署值**而不是逐任务
  谈判，理由是实测的：GUI 程序在受限令牌下起不来是**静默失败**（命令返回成功，只留一个桌面对话框），
  因此这类失败**永远进不了审批队列**。只跑受限任务的工作节点就设成 `workspace-write`。
  主机侧能看到该节点**实际自报**的档位。
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
| [仓库 README](https://github.com/Hope-Phenom/dsh-plugin-remote-use#readme) | 完整安装、使用、运维 |
| [设计文档](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/DESIGN.md) | 设计取舍与决策记录 |
| [踩坑与教训](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/PITFALLS.md) | 开发中真实遇到的问题及**发现方式** |
| [接口契约](https://github.com/Hope-Phenom/dsh-plugin-remote-use/blob/master/docs/INTERFACES.md) | 上游 API 与集成事实 |

## 许可

MIT
