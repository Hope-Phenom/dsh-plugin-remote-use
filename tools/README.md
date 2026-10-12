# DSH 环境备份 / 还原工具

`dsh-env-backup.py` —— 交互式，也可脚本调用。备份 / 还原 / 校验整个 DSH 环境。

```powershell
# 交互式（推荐）
& "C:\Users\you\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" tools\dsh-env-backup.py

# 或者脚本化
$PY = "C:\Users\you\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $PY tools\dsh-env-backup.py backup  --to "D:\dsh-backups" --name before-plugin-install --yes
& $PY tools\dsh-env-backup.py list    --to "D:\dsh-backups"
& $PY tools\dsh-env-backup.py verify  --from "D:\dsh-backups\before-plugin-install"
& $PY tools\dsh-env-backup.py restore --from "D:\dsh-backups\before-plugin-install"
```

---

## 为什么不能直接用 robocopy

裸 `robocopy /MIR` 备份 `.dsh` 有**四个**陷阱。这个工具就是为它们写的。

### 1. 🔴 Junction 会被实体化（最严重）

`profiles\desktop\node_modules\` 里可能有指向源码 checkout 的 **junction**，例如：

```
dsh-plugin-code-quality  ->  F:\WorkSpace\dsh-plugin-code-quality
```

`robocopy` 默认会**跟进 junction 并把内容复制成真实目录**。实测：一次裸 robocopy 备份里，
它变成了 289 个文件的实体目录。

**后果**：用这种备份还原，junction 会被换成副本 —— 你对源码目录的修改**再也不会同步进 profile**，
而你不会收到任何提示。

**工具做法**：备份时 `/XJ` 跳过 junction，把「路径 → 目标」记进 manifest；还原时用
`mklink /J` 重建。测过，目标内容完好且通过 junction 仍可读写。

### 1b. 悬空 junction 是合法状态，不是错误

实测本机环境：**484 个 junction 里有 482 个的目标已不存在**，全部指向

```
C:\Users\you\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\...
```

—— 一个**已经不存在的旧 npm 全局安装**（DSH 现在是 Electron 应用，装在
`AppData\Local\Programs`）。这是历史残留，`profiles\node_modules\` 里堆着 482 个悬空链接。

**关键事实**：Windows **允许** junction 指向不存在的路径（已实测 `mklink /J` 成功）。

**工具做法**：
- **默认忠实重建全部**，包括悬空项 —— 还原的语义是「回到备份时的样子」，而悬空就是当时的样子
- `--drop-dangling` 把悬空项当残留清理（适合「我想要一个干净环境」）
- 两种情况都会在输出里明确说明，不会把有意丢弃误报成失败

⚠️ 这里很容易写错：若写成「目标不存在就跳过」，还原会**删掉 482 个悬空 junction 且不重建**，
并刷 482 条警告 —— 看起来像还原失败，实际是工具破坏了忠实性。这个 bug 在开发中被发现并修正。

### 2. 🔴 还原时目标里的 junction 可能连累它的目标

`/MIR` 会把目标目录里「备份中没有」的东西当多余项删除。junction 就是这样一个多余项 ——
**而删除 junction 的操作有可能连带删掉链接目标里的真实文件**。

**工具做法**：镜像之前先用 `os.rmdir` 摘除 junction（Win32 `RemoveDirectory` 语义：只删重解析点，
不碰内容），**绝不用 `shutil.rmtree`**（它会跟进并删除目标里的真实文件）。实测验证：摘除后
`linktarget\index.js` 完好。

### 3. 运行中的 DSH 让快照不自洽

`sessions\` 正在被实时追加写，`attachments\`、`storages\` 也在动。文件被锁 → 复制失败；
文件在变 → 快照前后不一致。

**工具做法**：检测 DSH 进程并**拒绝还原**（`--force` 可覆盖）；备份时警告但允许继续。
关键文件靠 SHA-256 校验保证，不受 churn 影响。

### 4. 🔴 `dsh-runtimes` 自我覆盖

本工具自己很可能就跑在

```
<DSH_HOME>\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
```

上。还原 `dsh-runtimes` 等于**试图替换正在执行的解释器**：必然失败，而且毫无必要
（运行时由 DSH 重新置备）。

**工具做法**：还原**默认排除** `dsh-runtimes`，并在检测到「自己跑在还原目标里」时明确告警。

---

## 安全设计

| 机制 | 说明 |
|---|---|
| **还原前自动快照** | 先把当前状态完整备份成 `<备份名>.pre-restore-<时间戳>`，并打印撤销命令 |
| **输入备份名确认** | 还原前要求手工输入备份名，防误操作 |
| **DSH 运行检查** | 运行中**拒绝还原**；`--force` 可覆盖（会再次确认） |
| **自覆盖检查** | 检测本进程是否在还原目标内部 |
| **逐字节校验** | 备份后与还原后都对关键文件做 SHA-256 比对 |
| **junction 全生命周期记录** | 备份记录目标、还原默认**忠实重建**（含悬空项）、还原后核对；`--drop-dangling` 可选清理 |
| **输出聚合** | 484 个 junction 不会刷屏：只列前几个 + 汇总数字，全部细节在 manifest 里 |
| **操作日志** | `<目标>\_dsh-env-tool.log` 记录每条 robocopy 命令行与输出 |

关键文件列表（少而准，覆盖安装/还原必需项）：profile 的 `package.json` / `cordis.patch.yml` /
`cordis.yml` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`、用户级 `cordis.patch.yml`、
`settings.yaml.imported`、`.credentials.yaml`、`.anonymous-user-id`。

---

## 备份模式

| 模式 | 内容 | 体积（实测） |
|---|---|---|
| **完整** | 全部 | ~587 MB / 10,793 文件 |
| **精简** | 排除 `dsh-runtimes` `sessions` `attachments` `cache` | ~80 MB |

`dsh-runtimes` 占 272 MB（运行时二进制）、`sessions` 占 234 MB（会话日志）—— 两者都可再生成，
但完整备份也不贵，首次建议完整。

---

## ⚠️ 关于在 DSH 运行时备份

**推荐流程：退出 DSH → 运行备份/还原。**

原因：本工具（以及任何在 DSH 内运行的命令）都活在 DSH 进程树里。你在 DSH 会话里让我执行备份，
我就只能备份「正在运行的 DSH」——sessions 在churn。虽然关键文件有哈希校验兜底，但完整快照
不可能自洽。

**可行做法**：
- 退出 DSH，在普通的 PowerShell 窗口里跑 `backup`（最干净）
- 或者接受 churn，在 DSH 里跑 `backup`（工具会警告；关键文件仍然可信）

**还原则必须退出 DSH** —— 工具会直接拒绝，因为覆盖运行中的 profile 必然不完整。

---

## 已知限制

- **深度校验未实现**：`verify --deep` 目前只做关键文件 + junction + 规模核对，没有逐文件全量哈希。
  全量哈希 10k 文件需要几十秒，需要时再加。
- **不保留 ACL**：robocopy 用 `/COPY:DAT`（数据+属性+时间戳），不复制审计 ACL。
  对 `.dsh` 这种用户自有目录够用。
- **junction 目标丢失时不会失败**：重建时若目标不存在，会警告并继续，不会中断整个还原。
- **仅 Windows**：依赖 robocopy / mklink / tasklist。
- **控制台需 UTF-8**：脚本会自动 `SetConsoleOutputCP(65001)`；在极旧的终端上中文可能仍显示异常，
  但功能不受影响。

---

## 已验证

在含 junction 的夹具上完整走过一遍（备份 → 破坏 → 还原 → 校验）：

```
备份：junction 被记录、未被实体化（链接目标的 index.js 不在备份里）  ✅
校验：3 个关键文件 SHA-256 一致                                      ✅
破坏：改 package.json + 新增 stray-file.txt                          ✅
还原：DSH 运行检查生效（拒绝）→ --force 后继续                        ✅
      自动快照当前状态                                                ✅
      junction 安全摘除（目标内容未受影响）                            ✅
      /MIR 镜像（stray-file 被正确清除）                               ✅
      junction 重建为 Junction 类型                                    ✅
      关键文件 + junction 均校验通过                                   ✅
最关键：linktarget\index.js 内容完好，且通过 junction 仍可读            ✅
```
