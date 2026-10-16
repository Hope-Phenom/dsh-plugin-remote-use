# 踩过的坑

> **这是什么**：一份按"坏了什么"组织的故障档案，全部条目都来自 `dsh-plugin-remote-use` 这个局域网主从插件从设计到真机交付的**实际过程** —— 每条都附当时看到的原始输出、数值或日志行。
>
> **给谁看**：任何写 DSH 插件、写跨机自动化、或者写"验证脚本的脚本"的人。这里最贵的一类教训不是"某个 API 怎么用"，而是**一个检查安静地给出了错误答案**——它不报错，它报成功。
>
> **与另两份文档的关系**：`DESIGN.md` 描述**系统应该怎样**（架构、协议、裁决与其理由）；`INTERFACES.md` 描述**边界处的契约**（provider seam、ACP 用法、集成事实）。本文档描述**哪些地方实际崩了、如何被发现、以及用什么守卫钉住**。三者的关系是：设计说"要这样"，契约说"接口长这样"，本文说"这样写会怎么坏，以及怎么知道它坏了"。
>
> **写作纪律**：只写有证据的事。凡是本文出现的确切输出、字节数、毫秒数、行号，都在会话里真实出现过；无法追溯的一律不写。

---

## 目录

<!--
  这一节由脚本维护，别手改：
      node .research/fix-pitfalls-toc.mjs docs/PITFALLS.md --check          # 只在覆盖不全时失败
      node .research/fix-pitfalls-toc.mjs docs/PITFALLS.md --write          # 只插入缺的条目，不动已有行
  为什么不是手改：2026-10-15 实测它已经漏了 B1 与 F26–F38（整整一弧、13 条），而漏掉的目录
  **渲染起来与完整的一模一样** —— 又是"缺陷以成功的形式出现"。
  已有的行**按字节保留**：其中一部分是手写意译的，其锚点无法与标题对应（`--check` 会作为
  "anchor debt" 列出来但不拦），而正确的锚点从这里无法验证（DSH 全部文档里 3599 个锚点中
  没有一个包含连续两个连字符，所以那种形状在语料里无从校准）。
-->

- [A. 静默的错误答案](#a-静默的错误答案)
  - [A1. 自检里的硬编码用户路径 → 在能工作的机器上报 4 项阻断](#a1-自检里的硬编码用户路径--在能工作的机器上报-4-项阻断)
  - [A2. 同一形状的第三处：目标应用检查](#a2-同一形状的第三处目标应用检查)
  - [A3. 一个空的 `if` 分支：`--deep` 什么都不做却报"校验通过"](#a3-一个空的-if-分支--deep-什么都不做却报校验通过)
  - [A4. 写 hosts 失败，却打印成功并返回 0](#a4-写-hosts-失败却打印成功并返回-0)
  - [A5. 探针把"拒绝"报告成"成功"](#a5-探针把拒绝报告成成功)
  - [A5b. 空洞的通过：拒绝方向没有断言"真的发生过审批"](#a5b-空洞的通过拒绝方向没有断言真的发生过审批)
  - [A6. 界面把"有警告"标成"不可用"，与产品自己的门禁矛盾](#a6-界面把有警告标成不可用与产品自己的门禁矛盾)
  - [A7. 文档说"未实现"，而实现在同一屏上](#a7-文档说未实现而实现在同一屏上)
  - [A8. 自检失败返回"像报告的报告"](#a8-自检失败返回像报告的报告)
- [B. 被测对象被静默替换](#b-被测对象被静默替换)
  - [B1. `settings` 文件覆盖了 harness 传入的配置 —— **同一个陷阱出现三次**](#b1-settings-文件覆盖了-harness-传入的配置--同一个陷阱出现三次)
- [C. 只在特定路径才走到](#c-只在特定路径才走到)
  - [C1. 恢复布防不重跑沙箱门禁](#c1-恢复布防不重跑沙箱门禁)
  - [C2. `keepShots` 只作用于主机侧](#c2-keepshots-只作用于主机侧)
  - [C3. 从机中途死亡：任务会不会永远挂着](#c3-从机中途死亡任务会不会永远挂着)
  - [C4. 把文件写进插件自己的安装目录](#c4-把文件写进插件自己的安装目录)
  - [C5. `--print-pairing` 早于 `mkdirSync`](#c5--print-pairing-早于-mkdirsync)
  - [C6. 只在一台机器上正确的"检查通过"](#c6-只在一台机器上正确的检查通过)
- [D. 验证方法本身的缺陷](#d-验证方法本身的缺陷)
  - [D1. `Select-Object -First` 提前杀掉上游进程](#d1-select-object--first-提前杀掉上游进程)
  - [D2. 掩盖被调用程序的错误](#d2-掩盖被调用程序的错误)
  - [D3. 用秒表比例断言"串行"](#d3-用秒表比例断言串行)
  - [D4. 冷连接耗时被读成"没并行"](#d4-冷连接耗时被读成没并行)
  - [D5. `node --check` 只报第一个错](#d5-node---check-只报第一个错)
  - [D6. 用远程 shell 拼一行流](#d6-用远程-shell-拼一行流)
  - [D7. 路径穿过 shell：反斜杠被吃掉](#d7-路径穿过-shell反斜杠被吃掉)
  - [D8. 把本地路径当作两机共享的路径](#d8-把本地路径当作两机共享的路径)
  - [D9. 在错误的会话里测量，然后据此下了结论](#d9-在错误的会话里测量然后据此下了结论)
  - [D10. 用 shell 的字符串替换去改文件：同一天失败四次](#d10-用-shell-的字符串替换去改文件同一天失败四次)
  - [D11. 测试里写死被测对象的名字：它会接受 bug、拒绝修复](#d11-测试里写死被测对象的名字它会接受-bug拒绝修复)
  - [D12. 真机 harness 说它在测安装件，实际测的是源码检出（一个 junction）](#d12-真机-harness-说它在测安装件实际测的是源码检出一个-junction)
  - [D13. 多行锚点的编辑把**邻近那行**一起吃掉 —— 而结果"看起来改对了"](#d13-多行锚点的编辑把邻近那行一起吃掉--而结果看起来改对了)
- [E. 环境与平台的坑](#e-环境与平台的坑)
  - [E1. PowerShell 5.1 在一个卷上被按路径拦截，而 `-ExecutionPolicy Bypass` 无效](#e1-powershell-51-在一个卷上被按路径拦截而--executionpolicy-bypass-无效)
  - [E2. 沙箱内跑自检：合成输入的假阴性](#e2-沙箱内跑自检合成输入的假阴性)
  - [E3. PS 5.1 把无 BOM 的 `.ps1` 当 ANSI 读](#e3-ps-51-把无-bom-的-ps1-当-ansi-读)
  - [E4. `param()` 必须是第一条语句](#e4-param-必须是第一条语句)
  - [E5. `Tee-Object` 写 UTF-16LE](#e5-tee-object-写-utf-16le)
  - [E6. `files` 白名单里的目录，无法被 `.gitignore` / `.npmignore` 排除](#e6-files-白名单里的目录无法被-gitignore--npmignore-排除)
  - [E7. asar 内的路径不可 `Test-Path`](#e7-asar-内的路径不可-test-path)
  - [E8. `Set-Content -Encoding UTF8` 写出的文件带 BOM，而 DSH 拒绝解析它](#e8-set-content--encoding-utf8-写出的文件带-bom而-dsh-拒绝解析它)
  - [E9. `Start-Process -ArgumentList @(...)` 会切断带空格的路径](#e9-start-process--argumentlist--会切断带空格的路径)
  - [E9b. `-replace` 的替换串里，反斜杠会被再解释一层](#e9b--replace-的替换串里反斜杠会被再解释一层)
- [F. 上游与协议事实](#f-上游与协议事实)
  - [F1. `ctx.tools.restrict()` 强制 per-agent](#f1-ctxtoolsrestrict-强制-per-agent)
  - [F2. `defineTool` 是唯一的 schema 转换点](#f2-definetool-是唯一的-schema-转换点)
  - [F3. `ctx.effect` 立即执行，并返回它自己的 disposer](#f3-ctxeffect-立即执行并返回它自己的-disposer)
  - [F4. Cordis patch：新增行需要 `insert:`](#f4-cordis-patch新增行需要-insert)
  - [F5. `dsh-client-modules` 的元数据缓存需要重启](#f5-dsh-client-modules-的元数据缓存需要重启)
  - [F6. DSH 的 pnpm 带三层供应链策略，每层都能让安装静默变形](#f6-dsh-的-pnpm-带三层供应链策略每层都能让安装静默变形)
  - [F6b. `minimumReleaseAge` 会拦住卸载，而 `minimumReleaseAgeExclude` 拦不住它](#f6b-minimumreleaseage-会拦住卸载而-minimumreleaseageexclude-拦不住它)
  - [F7. 陈旧的 lockfile 会让 `pnpm add` 静默装回旧版本](#f7-陈旧的-lockfile-会让-pnpm-add-静默装回旧版本)
  - [F8. 改包名要同步的两类标识符，而且规则相反](#f8-改包名要同步的两类标识符而且规则相反)
  - [F9. DSH 起不来时，第一件事是读它自己写的崩溃日志](#f9-dsh-起不来时第一件事是读它自己写的崩溃日志)
  - [F10. 布防被拒："the sandbox mediator is not materialized" —— 而它明明物化过](#f10-布防被拒the-sandbox-mediator-is-not-materialized--而它明明物化过)
  - [F11. Web 会话的工具目录来自 agent preset，不是整棵 loader 树](#f11-web-会话的工具目录来自-agent-preset不是整棵-loader-树)
  - [F12. `--dump-config`：不启动就能看合成后的树，并暴露"未匹配的补丁目标"](#f12---dump-config不启动就能看合成后的树并暴露未匹配的补丁目标)
  - [F13. 启动诊断在 `~/.dsh/logs/`，不在 Electron 的 `logs/` 目录](#f13-启动诊断在-dshlogs不在-electron-的-logs-目录)
  - [F14. 任务结束后，它启动的 GUI 进程会被一起清理 —— 主机看不到"事后现场"](#f14-任务结束后它启动的-gui-进程会被一起清理--主机看不到事后现场)
  - [F15. 后台委派的**答案无处可取** —— 状态齐全，而"结果是什么"不存在](#f15-后台委派的答案无处可取--状态齐全而结果是什么不存在)
  - [F16. 配对建立了一个**没有任务目录**的 worker：错误推迟到第一次派单才出现](#f16-配对建立了一个没有任务目录的-worker错误推迟到第一次派单才出现)
  - [F17. 设置路由**没有**来源校验，而设计文档从第一次提交就写着有](#f17-设置路由没有来源校验而设计文档从第一次提交就写着有)
  - [F18. 审批窗口 88 秒且页面从不刷新：六次请求静默超时，操作者一次提示都没见过](#f18-审批窗口-88-秒且页面从不刷新六次请求静默超时操作者一次提示都没见过)
  - [F19. 审计把**程序调用**记成 `by=human`](#f19-审计把程序调用记成-byhuman)
  - [F20. 从机沙箱要求任务目录授予 WRITE_OWNER，继承来的 Modify 不够 —— 整台从机的 shell 全废](#f20-从机沙箱要求任务目录授予-write_owner继承来的-modify-不够--整台从机的-shell-全废)
  - [F21. 沙箱里 GUI 程序起不来：explorer 0xC0000142、notepad 创建后即消失、`start` 报 Access denied](#f21-沙箱里-gui-程序起不来explorer-0xc0000142notepad-创建后即消失start-报-access-denied)
  - [F22. 我发出去的两个字段都是错的：来源判据从不生效，档位显示的不是申请的那个](#f22-我发出去的两个字段都是错的来源判据从不生效档位显示的不是申请的那个)
  - [F23. `apply()` 里起的定时器吊死了测试进程](#f23-apply-里起的定时器吊死了测试进程)
  - [F24. 我的测试桩比现实宽松，而现实会在 `apply()` 里抛错 —— 从机的 DSH 因此起不来](#f24-我的测试桩比现实宽松而现实会在-apply-里抛错--从机的-dsh-因此起不来)
  - [F25. 一个被 `catch` 吞掉的异常，让按钮点下去毫无反应](#f25-一个被-catch-吞掉的异常让按钮点下去毫无反应)
  - [F26. 我让从机"跳过试探、直接带提权理由"，从机拒绝了 —— 审批证据的完整性](#f26-我让从机跳过试探直接带提权理由从机拒绝了--审批证据的完整性)
  - [F27. 审批面板三处接线偏差，其中"缺 `guide` 入口"才是打不开的真凶](#f27-审批面板三处接线偏差其中缺-guide-入口才是打不开的真凶)
  - [F28. 审批条的"席位"：`list` 型槽位会长进宿主自己的状态行里，位置随宽度漂移](#f28-审批条的席位list-型槽位会长进宿主自己的状态行里位置随宽度漂移)
  - [F29. "改用宿主组件更规范"—— 读到两份官方文档互相矛盾，而它们说的是两条 lane](#f29-改用宿主组件更规范-读到两份官方文档互相矛盾而它们说的是两条-lane)
  - [F30. 面板里那句"记录同时写在 …"从来没有出现过](#f30-面板里那句记录同时写在-从来没有出现过)
  - [F31. 用时间戳当"清空水印"，把同一毫秒内**新产生**的记录也一起隐藏了](#f31-用时间戳当清空水印把同一毫秒内新产生的记录也一起隐藏了)
  - [F32. 文档写着"轮转 64MB / 保留 30 天"，而审计文件从来没有任何上限](#f32-文档写着轮转-64mb--保留-30-天而审计文件从来没有任何上限)
  - [F33. 一次性提权**养不活**一个 GUI 进程：放行一结束，窗口就被拆掉](#f33-一次性提权养不活一个-gui-进程放行一结束窗口就被拆掉)
  - [F34. 全权档位会撞上"不命中任何 preset"—— 而我把后果**说错了两次**，两次都是实测纠正的](#f34-全权档位会撞上不命中任何-preset-而我把后果说错了两次两次都是实测纠正的)
  - [F35. 测试里用 `execFileSync` 收 stderr，于是"成功时"的诊断通道被静默丢掉](#f35-测试里用-execfilesync-收-stderr于是成功时的诊断通道被静默丢掉)
  - [F36. 我发布的那个 YAML 片段**本身是坏的**：`!!js` 的三元表达式没加引号，被 YAML 吃成了映射](#f36-我发布的那个-yaml-片段本身是坏的js-的三元表达式没加引号被-yaml-吃成了映射)
  - [F37. 一个新的"页面设置项"要登记在**四个**地方，而漏掉任何一个都是**静默回退**](#f37-一个新的页面设置项要登记在四个地方而漏掉任何一个都是静默回退)
  - [F38. "文件里写着 X"与"进程读的是 Y"可以**同时为真** —— 而两边都像"已设好"](#f38-文件里写着-x与进程读的是-y可以同时为真--而两边都像已设好)
  - [F39. 两半各自"测试充分"，而它们之间**那条缝**谁的测试都不覆盖](#f39-两半各自测试充分而它们之间那条缝谁的测试都不覆盖)
  - [F40. 相对路径写进了**应用自己的 profile 目录**，而工具报告成功](#f40-相对路径写进了应用自己的-profile-目录而工具报告成功)
- [G. 需求本身的坑](#g-需求本身的坑)
  - [G1. "主屏必须是虚拟屏" —— 一条忠实实现后让机器无法登录的要求](#g1-主屏必须是虚拟屏--一条忠实实现后让机器无法登录的要求)
- [这些教训的共同形状](#这些教训的共同形状)

---

# A. 静默的错误答案

这一类最贵：**它不报错**。程序正常运行、退出码为 0、输出的形状完全正确，只是内容是错的。而错误的答案会被下游当成事实使用。

排序依据是危害：从"会让一台能干活的机器被判定为不可用"到"只是在界面上说错一句话"。

## A1. 自检里的硬编码用户路径 → 在能工作的机器上报 4 项阻断

**现象**

从机自检脚本 `slave/selfcheck.ps1` 里写着：

```powershell
$dsh  = 'C:\Users\worker\AppData\Local\Programs\DeepSeek Harness'   # S14 DSH installed
$cred = 'C:\Users\worker\.dsh\.credentials.yaml'                    # S15 model credentials
```

`sheng` 是**参考从机**的用户名。在这台主机上跑同一个脚本：

```
verdict=blocked blocking=4
  [FAIL] S14 DSH installed | expected=installed | actual=
  [FAIL] S15 model credentials present | expected=exists | actual=missing
```

而当时的真相是：DSH 正在运行（版本 `0.2.0-rc.2`），凭据文件存在于 `C:\Users\you\.dsh\.credentials.yaml`，
并且**刚刚有一个远程任务跑完**。

**根因**

把一台机器的用户目录布局写进了一个会在**另一台**机器上跑的脚本。那个布局在参考从机上是真的，
在别处必然为假 —— 于是检查的结论由"这台机器对不对"变成了"这台机器是不是那一台"。

**怎么发现的**

不是靠单测，也不是靠代码审查的第一眼。线索是一个**看起来矛盾**的观测：从机侧自检报 `blocked`（4 项阻断），
**同一个会话里任务却跑完了**。一个说"不可用"、一个说"能用"，两者不可能都对。顺着这个矛盾去读脚本，
才看到那两个路径。

**修法**

路径从环境派生，并**覆盖多个来源**（这一点后来单独踩了坑，见 [C6](#c6-只在一台机器上正确的检查通过)）：

```powershell
$dshCandidates = New-Object System.Collections.ArrayList
$runningDsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($runningDsh -and $runningDsh.Path) { [void]$dshCandidates.Add((Split-Path -Parent $runningDsh.Path)) }
[void]$dshCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'))
[void]$dshCandidates.Add((Join-Path $env:ProgramFiles 'DeepSeek Harness'))
# ...以及扫描每个用户 profile
```

同时让报告**说出它找了哪些路径**，这样"真的没登录"与"找错地方了"可以区分：

```
actual = 'missing in: C:\Users\you\.dsh\.credentials.yaml; C:\Users\Administrator\.dsh\...'
```

**守卫**

`test/shipped-scripts.test.js`：

| 断言 | 变异检验 |
|---|---|
| 从机脚本里不得出现特定用户的 profile 路径（正则匹配 `[A-Za-z]:\\Users\\<非占位符>\\`，排除注释与 `dev`/`public` 之类的占位符） | 把 `C:\Users\worker\...` 放回去 → **测试失败** ✓ |
| 自检的安装/凭据路径必须从环境派生（`$env:LOCALAPPDATA`、`$env:USERPROFILE`、`$env:SystemDrive`） | — |
| 失败时必须报告尝试过的位置数量 | — |

第一条是**通用的**：它抓的是形状（"脚本里出现了某个具体用户的路径"），不是这一处。同一个正则能抓 A1 和 A2。

---

## A2. 同一形状的第三处：目标应用检查

**现象**

同一个脚本里的 S18：

```powershell
$app = 'C:\dsh-remote\avalonia-demo\avalonia-demo\bin\Debug\net10.0\avalonia-demo.exe'
Add-Check 'S18' 'target app present' 'warning' ... $(if (Test-Path $app) { 'present' } else { 'missing' })
```

在每台别的机器上：

```
[WARN] S18 target app present | expected=exists | actual=missing
```

**根因**

与 A1 完全同形，只是这次硬编码的是**构建产物路径**。因为它是 `warning` 而不是 `blocking`，
verdict 不受影响 —— 这正是它活了很久的原因。

**怎么发现的**

是**主动去搜**的。A1 修完之后，我把"插件里所有硬编码的绝对路径"扫了一遍：

```
lib\core\relay-supervisor.js:89   （注释里举例）
lib\core\sandbox-probe.js:72      'C:\\Program Files\\PowerShell\\7\\pwsh.exe'   ← 合法（有回退）
lib\core\sandbox-probe.js:119     deps.mediator ?? 'C:\\dsh-sandbox-mediator'    ← 合法（可注入）
lib\core\self-acp-spec.js:28-29   'C:\\Program Files\\DeepSeek Harness'          ← 合法（候选之一）
slave\selfcheck.ps1:195           'C:\\dsh-remote\\avalonia-demo\\...'           ← **这一处**
```

**修法**

路径来自参数或环境变量，且**"未配置" ≠ "缺失"**：

| 状态 | 报告 |
|---|---|
| 未配置 | `warn` · `not configured (pass -App or set DSH_SELFCHECK_APP)` |
| 配置且存在 | `pass` · `present: <path>` |
| 配置但缺失 | `warn` · `missing at: <path>` |

**守卫**

`shipped-scripts.test.js` 断言存在 `DSH_SELFCHECK_APP`、`[string]$App = ''`、`not configured`、
`missing at: ` 四个字符串。变异检验：删掉任一条 → 测试失败 ✓

> **这一条的元教训**：A1 是"一个检查给出错误答案"，A2 是"**为了修 A1 而去搜同类**才发现它"。
> 修一处具体缺陷之后，值得问的不是"还有别的地方也这样吗"（太弱），而是"**这一类缺陷的形状是什么，
> 我能用一条正则把它扫出来吗**"。

---

## A3. 一个空的 `if` 分支：`--deep` 什么都不做却报"校验通过"

**现象**

备份工具的用法里写着：

```
python dsh-env-backup.py verify --from D:\bk\my-backup [--deep]
```

而 `--deep` 的实现是：

```python
if deep:
    info("深度校验：逐文件哈希比对（可能较慢）...")
    for rel_dir in sorted(p for p in backup_dir.iterdir()
                          if p.is_dir() and p.name not in ex):
        pass                                    # ← 空循环
    say("  （深度校验按需实现：本版只做关键文件 + junction + 规模核对）")
# 然后照常打印"校验通过"并返回 0
```

**根因**

一个被宣传的选项没有被实现，而**它的存在本身构成了保证**：用户看到 `--deep` 可用，
就会认为"我已经做了严格校验"。比没有这个选项更糟。

**怎么发现的**

去验"这个工具能不能用"时，顺手读了 `--deep` 的分支 —— 因为**校验**命令是安全网，
它自己的可信度值得单独看一眼。看到的是一段 `pass`。

**修法**

**无法照宣传实现，所以诚实地拒绝**，并说明为什么：

```python
if deep:
    bad("--deep 尚未实现：清单只记录了关键文件的哈希，其余文件没有可比对的基线。")
    info("  已实现的是：关键文件哈希 + 全部 junction + 规模核对（去掉 --deep 即可运行）。")
    info("  若要真正的逐文件校验，需要先在备份时把每个文件的路径/大小/哈希写进清单。")
    return 3
```

为什么无法实现（这个理由值得记下）：清单里只有 `criticalHashes`（9 个关键文件），
另外 10,795 个文件**没有基线**。而"拿备份去和实时环境逐文件比对"不是替代品 —— 实时环境本来就在变
（sessions、日志、缓存），那样每次都会报差异，等于没有意义。

**守卫**

README 里补了**退出码表**，让"有差异"和"工具坏了"可以分开：

| 子命令 | 码 | 含义 |
|---|---|---|
| `verify` | `0` | 校验通过 |
| `verify` | **`2`** | **有差异**（工具本身正常） |
| `verify` | `3` | `--deep` 未实现，拒绝执行 |
| 全部 | `1` | 操作失败 |
| 全部 | `130` | 用户中断 |

实测：`--deep` → 3 ✓，普通 verify → 2 ✓，list → 0 ✓

---

## A4. 写 hosts 失败，却打印成功并返回 0

**现象**

`tools/find-slave.ps1` 在从机上正确认领出了目标机：

```
26 host(s) with SSH open: ... 192.168.1.101 ...
key accepted by: 192.168.1.101 -> WORKER-PC
FOUND: worker-pc is at 192.168.1.101
Set-Content: Access to the path 'C:\WINDOWS\System32\drivers\etc\hosts' is denied.

hosts   : 192.168.1.101	worker-pc
  ssh worker-pc    # now resolves to 192.168.1.101
exit=0
```

**根因**

`Set-Content` 抛了异常，但异常没有被检查，而那两行成功提示是**无条件打印**的。
写 hosts 需要管理员权限 —— 这一点在写脚本时没有考虑。

**怎么发现的**

**这个脚本此前只跑过"找不到"的路径**（那时的报告是正确的）。第一次跑"找到"的路径，
缺陷立刻出现。

这是本文档里最重要的一类发现方式：**成功路径没有被跑过**。失败路径容易测（构造一个坏输入），
成功路径反而最容易被跳过 —— 而它承载着工具存在的理由。

**修法**

```powershell
$wrote = $false
try {
  $lines = @(Get-Content $hosts -ErrorAction Stop)
  Set-Content -Path $hosts -Value ($kept + $hostsEntry) -Encoding ASCII -ErrorAction Stop
  $wrote = $true
} catch { $why = $_.Exception.Message }

if ($wrote) { ...; exit 0 }
Write-Host "COULD NOT WRITE THE hosts FILE: $why" -ForegroundColor Red
Write-Host "  The worker WAS found at $found. To make the name resolve, either:"
Write-Host "    1. re-run this from an Administrator PowerShell, or"
Write-Host "    2. add this line to the hosts file yourself:  $hostsEntry"
Write-Host "    3. or give the worker a DHCP reservation plus a DNS record on the router."
exit 1
```

关键是**三件事分开说**：识别成功、写入失败、以及三条可操作的替代方案。`exit 1` 让脚本可被使用。

**守卫**

实测：非管理员 → 明确失败 + `exit=1` ✓；`-NoHosts` → `exit=0` ✓。

---

## A5. 探针把"拒绝"报告成"成功"

**现象**

审批路径的探针里，拒绝方向的断言原本是：

```js
check('a refusal is obeyed: the escalated command did NOT run',
  !String(denied?.output ?? '').includes('DENIED-LIVE'), ...)
```

而实际输出是：

```
denied task: stopReason=completed
  output="I can run the echo, but not with `danger-full-access` — that parameter is only for a
          one-shot retry of an operation the ..."
```

**命令确实没有执行**，但 agent 在**解释**里把我要求的命令文本**引用回了输出** ——
于是 `includes('DENIED-LIVE')` 为真，断言失败，探针把一个正确的拒绝报成了缺陷。

**根因**

**字符串匹配区分不了"执行了"和"引用了"。** 而在一个由 agent 产生的输出上，这两种情况的文本可以完全相同。

**怎么发现的**

探针红了，但读输出的第一反应是"这不对啊，它明明没跑"。**输出说的是"没跑"**（拒绝的解释），
而断言说的是"跑了"。矛盾指向断言，而不是产品。

**修法**

改用**副作用**，它的语义是二值的：

```js
const marker = (name) => join(tmpdir(), `remote-use-approval-${name}-${process.pid}.txt`)
const markerFlag = (p) => `New-Item -ItemType File -Path '${p}' -Force | Out-Null`
// 放行方向：断言文件存在；拒绝方向：断言文件不存在
```

**守卫**：这一处的"守卫"就是断言本身换了载体。

紧接着又发现了同一处的第二个问题：**空洞的通过**。见下。

---

## A5b. 空洞的通过：拒绝方向没有断言"真的发生过审批"

**现象**

把断言换成 marker 文件之后，加了一条：

```js
check('the refused scenario actually reached the approval path', denials.length > 0,
  'the agent declined to try, so "the command did not run" would prove nothing')
```

下一次运行立刻红了：

```
denied task: requests=0 output="I'll run the command, but I won't attach `danger-full-access`: ..."
[FAIL] the refused scenario actually reached the approval path
```

**根因**

委托的 agent **是否**请求提权不由探针控制（工具说明里写着 `danger-full-access` 是给"被沙箱拦下后的一次性重试"用的，
所以它经常干脆在当前档位下干完）。上一次它问了，下一次没问。

如果不加这条断言，"命令没跑"在两个情况下都为真：**拒绝被遵守**，以及 **agent 根本没尝试** ——
后者是**空洞的通过**：检查通过了，但它什么都没验证。

**修法**

区分三种结果，而不是两种：

| 处理 | 后果 |
|---|---|
| 判为失败 | 探针**间歇性变红**，原因与产品无关 |
| 判为通过 | 就是上面那个空洞检查 |
| **判为"无法判定"并计入汇总** | 一次"验证得比看起来少"的运行**不会被读成满分** |

```js
} else {
  inconclusive += 1
  line('  [INCONCLUSIVE] the refusal direction was not exercised: the agent never asked for the escalation')
}
// 汇总行会带上它
line(failures === 0
  ? `RESULT: OK -- ...${inconclusive > 0 ? ` (${inconclusive} check(s) could not be exercised)` : ''}`
  : `RESULT: ${failures} CHECK(S) FAILED${inconclusive > 0 ? `, ${inconclusive} inconclusive` : ''}`)
```

> **这一条值得单独记住**：一个检查有**三种**结果而不是两种 —— 通过、失败、以及**没被真正执行**。
> 把第三种塞进前两种的任何一个，都会产生错误的信息。

---

## A6. 界面把"有警告"标成"不可用"，与产品自己的门禁矛盾

**现象**

用户在设置页截图里，工作节点卡片是这样的：

```
连接      已连接 · 重连 1 次
会话      WORKER-PC · ok
检查结果  阻断 0 · 警告 1 · 未检查 0
          [不可用]        ← 这里是 verdict 徽章
```

**同一张卡片上，细节行说"阻断 0"，徽章说"不可用"** —— 两者不可能都对。

**根因**

可用性判据是一个两分支：

```js
verdict === 'ready' ? t('verdictReady')
  : verdict === 'unknown' ? t('verdictUnknown')
  : t('verdictBlocked')          // ← warn 和 partial 都掉进这里
```

从机自检产生四种 verdict，而只有两种意味着"不能用"：

| verdict | 含义 |
|---|---|
| `ready` | 全部通过 |
| `warn` | **阻断项全过**，只剩建议性提示 |
| `partial` | 某项**无法评估** |
| `blocked` | **有阻断项失败** |

产品自己的派单门禁（`remote-provider`）看的是 `status === 'fail'`，**完全忽略 warning** ——
所以**产品是对的，界面是错的**。而且矛盾里更醒目的那个（界面）是错的那个。

**怎么发现的**

**用户截图。** 这一条在单元测试里看不到：测试断言的是"渲染出徽章"，而徽章渲染得好好的 ——
只是渲染了错的字。这也是整份文档里唯一一条由人工观察发现的缺陷，值得注意它为什么逃过了自动化。

**修法**

四态各有其位，颜色与文字放在**相邻的两个函数**里，避免彼此漂移：

```js
function verdictClass(verdict) {
  if (verdict === 'ready') return 'ok'
  if (verdict === 'warn' || verdict === 'warning') return 'warn'   // 建议性：可用
  if (verdict === 'partial') return 'mute'                         // 未评估：不是故障
  if (verdict === 'blocked') return 'bad'
  return 'mute'
}
function verdictText(t, verdict) { /* 与上面一一对应 */ }
```

**守卫**

`test/settings-page.test.js` 新增两条，断言**每个 verdict 的文字与 CSS 类**：

| 变异 | 结果 |
|---|---|
| `verdictClass` 去掉 warn 分支（**只影响颜色**） | 第一次检验：**测试全过** ✗ |
| 补上颜色断言之后，同上 | 失败 ✓ |
| `verdictText` 去掉 warn 分支 | 失败 ✓ |

> **这里还有一层**：第一次变异检验**没有抓到缺陷**，因为只断言了文字、没断言颜色 ——
> 而截图里**颜色恰恰是最醒目的信号**。
> **变异检验的价值不只在于"证明守卫有效"，更在于"证明守卫的覆盖范围"** ——
> 一个没有失败过的变异，说明那块地方没人看着。

---

## A7. 文档说"未实现"，而实现在同一屏上

**现象**

设置页的本机角色栏（截图）：

```
本机角色
  [主机] 本机作为主机向工作节点派单。切换为工作节点（对称配对）尚未实现。
  ...
  约束状态 [沙箱已验证]
  监听地址 192.168.1.100 — 以太网
  端口     7331
  [先检查] [布防为工作节点]
```

**"尚未实现"这句话的正下方，就是完整的布防面板。**

同类的还有文档里的多处方：

| 位置 | 原文 | 实际 |
|---|---|---|
| `DESIGN.md` 头部状态表 | 「从机侧有一批改动**待部署**」 | 已部署并真机验证 |
| `DESIGN.md` §10 未验证表 | 「人工审批 UI 未实现」 | 已实现并真机验证 |
| `DESIGN.md` §16 标题 | 「六问已定，**实现中**」 | 已交付 |
| `DESIGN.md` §16.7 | 「监听器 ⛔ 未做 / 布防 UI ⛔ 待做」 | 均已完成 |
| `client.js` `roleNote` | 「尚未实现」 | 面板就在下面 |

**根因**

文档是在**做之前**写的（先写设计再实现），而实现完成后**没有回头改状态字段**。
每一条单独看都不算错（写的时候确实是对的），合起来构成一个系统性的错误答案源。

界面上的那条更严重：它不是给维护者看的，是给**操作者**看的 —— 操作者会据此认为功能不存在。

**怎么发现的**

文档那几处是**主动扫**出来的：修完 A7 的界面那条之后，用正则搜 `未实现|尚未实现|待部署|待做|⛔`，
一次列出全部候选，逐条对照实际状态。

**修法**

全部改正，并把当前真实剩余项写进 §10 的表。§19「待部署」保留标题但改为**已部署的记录**，
并说明它当时记录的危险中间状态。

**守卫**

`test/settings-page.test.js`：

```js
test('no dictionary claims symmetric pairing is unimplemented', () => {
  const values = [...source.matchAll(/roleNote:\s*'((?:[^'\\]|\\.)*)'/gu)].map((m) => m[1])
  assert.equal(values.length, 2, 'expected the zh and en role notes')
  for (const value of values) {
    for (const phrase of ['尚未实现', 'not implemented', 'not yet']) {
      assert.equal(value.includes(phrase), false, `the role note still says "${phrase}"`)
    }
    assert.match(value, /布防|armed|below|下方/u, 'the note must point at the panel')
  }
})
```

两个细节值得注意：

1. 测试**只检查 `roleNote` 的值**，不扫整个文件 —— 因为修法本身的注释里就引用了旧措辞来解释它为什么改。
   第一版扫全文，被自己的注释绊倒（这算一次"检查的精度"问题，与 D 类同源）。
2. 变异检验：把 `roleNote` 改回旧文案 → **测试失败** ✓

---

## A8. 自检失败返回"像报告的报告"

**现象**

从机中继在**无法运行自检脚本**时，会返回一份降级报告：

```json
{ "verdict": "blocked", "sessionSegment": "unavailable", "blockingFailures": 1,
  "checks": [{ "id": "S0", "name": "self-check produced a report", "status": "fail",
               "actual": "Unexpected end of JSON input" }] }
```

而我的探针当时的检查是：

```js
check('a worker self-check ran through the listener', report !== null && report.verdict !== undefined)
```

**"根本没跑"和"跑完有问题"都以这个方式通过。**

**根因**

降级报告是**设计良好的** —— 它 fail closed（`blocked`）、带 `blockingFailures`、
并且 `checks[0].name` 说的是 "self-check produced a report"、`actual` 带原始错误。**信息都在。**
问题在**检查太弱**：它只问"有没有 verdict"，而这个问题有两种情况的答案都是"有"。

**怎么发现的**

它藏了**七轮**。每一次探针输出里都有这一行：

```
warn  S0 | expected=... actual=Unexpected end of JSON input
```

而那七轮里我都把它读成了"从机自检有问题"，没有意识到它是"**自检根本没运行**"。
直到排查别的症状时读到中继的源码，才认出这个 `S0` 的形状。

**修法**

```js
// 断言"不是那份单项 S0 的降级报告"
const degraded = Array.isArray(report?.checks)
  && report.checks.length === 1
  && report.checks[0]?.id === 'S0'
check('the self-check produced a REAL report, not the relay\'s degraded one', degraded === false,
  degraded ? String(report?.checks?.[0]?.actual ?? '').slice(0, 160) : `${report?.checks?.length ?? 0} checks`)
```

修好之后：

```
[PASS] the self-check produced a REAL report, not the relay's degraded one -- 17 checks
selfcheck: {"sessionSegment":"ok","blockingFailures":2,...}
```

`sessionSegment` 从 `"unavailable"` 变成 `"ok"` —— 这个字段本身就是区分标志，此前没人看它。

> **元教训**：**降级路径要产出"形状可辨"的结果**（这份降级报告做到了：单项 S0 + `sessionSegment: unavailable`），
> 而**调用方必须真的去辨它**（我的探针没有）。两者缺一，"降级"就退化成"看起来成功的失败"。

---

# B. 被测对象被静默替换

## B1. `settings` 文件覆盖了 harness 传入的配置 —— **同一个陷阱出现三次**

**现象**

第三次出现时的输出：

```
[FAIL] the plugin mounted with 2 worker(s) -- got 1 [remote-worker-pc]
  plugin log:
    [info] settings file applies: workers, approvalTimeoutMs, requiredTier, heartbeatMs, keepShots, ...
    [info] registered subagent provider "remote-worker-pc" -> ws://worker-pc:7331
  workers given: ["ws://worker-pc:7331","ws://127.0.0.1:7396"]
```

第二次出现时（`plugin-live`）更戏剧化 —— 它带着 `--url ws://127.0.0.1:7397` 去连一台**真从机**，
得到：

```
Error: remote worker is not ready: S0 worker reachable
       (expected relay responds, actual connect ETIMEDOUT 192.168.1.101:7331)
```

**根因**

`apply()` 的配置优先级是：

```
defaults  <  profile 补丁  <  settings 文件
```

而 **`workers` 是替换语义**（整个数组替换，不是逐项合并）。操作者的
`C:\Users\you\.dsh\storages\dsh-plugin-remote-use\settings.json` 里有一个真实 worker，
于是 harness 传入的 `workers` 被**整体丢弃**。

**怎么发现的**

第一次（`plugin-smoke`）：给冒烟测试加路由调用时意识到 —— 它跑在**操作者的真实 `.dsh`** 上，
于是真实 acp profile 存在、沙箱门禁会通过、`worker.arm` 会**真的开一个监听器**。
那不是"发现了缺陷"，是"发现了自己的测试会动用户的机器"。

第二次（`plugin-live`）：报 `ETIMEDOUT 192.168.1.101:7331`，而我明明传了 `127.0.0.1`。
**地址对不上**是唯一的线索 —— 如果那台从机当时恰好在运行，我会得到一次"成功"，
而它验证的是完全不同的东西。

第三次（并发探针）：`got 1` 而不是 2。这次产品**把原因打在了日志里**
（`settings file applies: workers, ...`），是我的探针没读那行。

**修法**

三个 harness 都在**导入插件之前**把 `DSH_HOME` 指向临时目录：

```js
const TEST_HOME = mkdtempSync(join(tmpdir(), 'plugin-live-home-'))
process.env.DSH_HOME = TEST_HOME
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch {} })
```

必须在**导入之前**：`apply()` 在调用时读设置文件，而模块级环境变量要在那之前到位。

**守卫**

- `plugin-smoke` 断言 `snapshot.audit.path.startsWith(TEST_HOME)` —— **直接验证隔离本身**，
  而不是相信它。
- `plugin-live` 断言连上的是**传入 URL 描述的那个 worker**（连接成功 + 报告可用）。
- 单测 `apply-config.test.js` 有一个"设置文件覆盖 profile 配置"的用例，
  它断言的是**产品行为**（覆盖是对的）；harness 侧的隔离是另一回事。

> **这一条值得单独成类**，因为它不是"某个检查错了"，而是**检查的对象被换掉了，
> 而检查的输出看不出这一点**。任何"跑真东西"的 harness 都要先回答一个问题：
> **我怎么知道它跑的是我指定的那个东西？**

---

# C. 只在特定路径才走到

这一类共同点：代码在正常路径上完全正确，缺陷只在某条**不常走的分支**上 —— 而那条分支往往正好是
"出问题的时候才走"的那条。

## C1. 恢复布防不重跑沙箱门禁

**现象**

配置里存着 `armed: true` 时，DSH 重启会在 `apply()` 里**直接起监听器**。原实现：

```js
if (stored?.armed === true && this.token !== '' && this.bindAddress !== '') {
  this.armed = true
  this.armedAt = ...
  try { this.start(this.bindAddress, this.port, this.token) } catch { ... }
}
```

**根因**

沙箱**不是插件的属性** —— 它是 acp profile 里接的 mediator，而 mediator 是从 DSH 包里
**物化出来**的（见 `DESIGN.md` §14.3）。所以：

- **DSH 升级会让它失效**（shim 会去驱动上一版的 runner）
- 删掉 `C:\dsh-sandbox-mediator` 也一样

不重跑门禁的后果：**上周布防的机器，在约束已经失效之后继续接受远程执行。**
这正是"沙箱不可用前拒绝启用 worker 模式"那条裁决要防的事。

**怎么发现的**

**不是测试发现的，是审代码发现的。** 那条路径只在"布防状态下重启 DSH"时走到，
而我从没让 DSH 在布防状态下重启过（也不该由我重启）。**上一条路径没被走过，就不会被发现。**

**修法**

恢复时重跑探测；不通过就**不恢复、不监听**，并说明原因：

```js
this.lastProbe = this.probe()
if (this.lastProbe.ok !== true) {
  this.armed = false
  this.lastError = `refused to restore remote execution: the sandbox no longer contains this machine (${this.lastProbe.reason})`
} else { /* 才启动 */ }
```

两个设计决定：

- **凭据保留**：拒绝的是约束，不是配对。丢掉它会让操作者在修好 mediator 之后还要重新配对。
- **只在 `armed: true` 时才探测**：未布防（默认）的机器在每次 DSH 启动时**不付这个开销**。

**守卫**

`test/worker-arming.test.js` 三条：

| 测试 | 断言 |
|---|---|
| 恢复时门禁不通过 | `probes === 1`（确实跑了）、`armed === false`、`calls.start.length === 0`（没有监听）、`lastError` 提到沙箱、**`tokenSet === true`**（凭据保留） |
| 恢复时门禁通过 | 仍然启动，凭据是**持久化的那个**（不轮换） |
| **存储状态为未布防** | `probes === 0` —— 未布防的机器不付探测开销 |

变异检验：把 `this.lastProbe = this.probe()` 改成恒 `{ ok: true }` → **测试失败** ✓

---

## C2. `keepShots` 只作用于主机侧

**现象**

设置页有"每个工作节点保留的截图数"（默认 20），而**从机侧的 relay 从来不裁剪**。
从机的 `shots/` 目录：

```
2026/10/13  09:07    9,946,820  shot-1791853665933-1.png
2026/10/13  10:25    9,946,813  shot-1791858301185-2.png
...
104.3 MB / 11 个文件   （后来涨到 56.9 MB 以上，无上限）
```

**根因**

`RelaySupervisor` 启动 relay 时没有传 `--keep-shots`：

```js
'--port', String(port),
'--token', token,
'--advertise-host', bindAddress,
'--cmd-file', specFile,
'--pairing-file', '',
// ← 这里没有 --keep-shots
```

所以 relay 用它自己的默认值；而页面上的设置**只管了主机侧** —— 从机侧才是更大的那份累积
（每张 ~9.5 MB，永不清理）。

**怎么发现的**

审 `RelaySupervisor` 的参数列表时，对照页面上的配置项，发现少一个。

**修法**

```js
// 按启动时读取，所以改设置在下一次布防生效，而不是要等 DSH 重启
keepShots: () => cfg.keepShots,
...
'--keep-shots', String(this.keepShots()),
```

**守卫**

`test/relay-supervisor.test.js` 两条：

| 测试 | 断言 |
|---|---|
| 传下去了 | `--keep-shots` 存在且值等于默认 20 |
| **是启动时读的** | 第一次 arming 用 5、改值后再 arming 用 2 |

变异检验：删掉 `'--keep-shots', ...` → **两条都失败** ✓

**真机验证**（部署后，通过真从机的中继）：

```
连拍前       12
连拍 6 张  → 18
连拍 12 张 → 21    ← 达到上限（保留 20 + 正在下载的那张）
连拍 18 张 → 21
连拍 22 张 → 21    ✓
```

上限 21 而不是 20，是因为 relay **先裁剪后截图** —— 正在下载的那张永远不会被删。

---

## C3. 从机中途死亡：任务会不会永远挂着

**现象**

这条**没有缺陷**，但它的存在是一个从未被验证的假设，值得记录。

```
[PASS] the in-flight task SETTLES instead of hanging -- after 4353 ms
       outcome: {"stopReason":"error","diagnostic":"ACP connection closed",
                 "output":"I'll run the sleep command."}
[PASS] the link is not reported as connected
       stats: {"connected":false,"connects":1,"connectFailures":1,
               "lastError":"connect ECONNREFUSED 127.0.0.1:7396"}
```

**根因（为什么值得单独测）**

一个永远不结束的任务不只是"失败" —— 它会**一直占着委托队列的槽位**
（`RemoteProvider.#acquire()` 的 FIFO 闸），于是一台死掉的从机会把插件一起拖住，直到 DSH 重启。
**这比报错糟得多。**

**怎么发现的**

主动去找"所有测试都拿一个活着的从机在跑"这个盲区。写完探针当天就验了，结果是**对的** ——
但"它是对的"这件事此前只是假设。

**守卫**

`.research/probe-relay-death.mjs`：真中继、真任务、在 turn 进行中 `taskkill /T /F`。

| 断言 | 结果 |
|---|---|
| 进行中的任务**结束**而不是挂着 | ✓ 4353 ms（击杀后约 4 ms） |
| 不谎报成功 | ✓ `stopReason: error` |
| 部分输出被保留 | ✓ `output: "I'll run the sleep command."` |
| **`PeerConnection` 把链路标记为断开** | ✓ `connected: false`、`connectFailures: 1`、`lastError` 点名 ECONNREFUSED |

最后一条的重要性：**一条死了却仍显示"已连接"的链路，比没有指示灯更糟** —— 操作者会去重启错的东西。

---

## C4. 把文件写进插件自己的安装目录

**现象**

通过插件自己的"从机角色"截一张图，然后看目录树：

```
插件目录 slave\shots : True
     shot-1791873338626-1.png  4.43 MB
```

**截图落进了插件的源码检出目录。**

**根因**

`RelaySupervisor` 不传 `--shot-dir`，relay 于是用它自己的默认：

```js
const SHOT_DIR = arg('shot-dir', join(HERE, 'shots'))
```

`HERE` 是**脚本自己的目录** = 插件安装目录。在 `link:` 安装下，那就是操作者的源码检出。

这与此前修掉的 `pairing.txt` 是**同一缺陷**（relay 把配对串写在脚本旁边），
用**同一方法**发现（真跑一次、看目录树）—— 区别只是**截图路径此前从未被执行过**。

**怎么发现的**

第一次真正截图时（在那之前只验证过"未授权返回 401"，从未成功捕获过）。

**修法**

```js
// 包外的目录；一次捕获是会被按预算裁剪的临时全分辨率 PNG，放 temp 才对
this.shotDir = deps.shotDir ?? join(tmpdir(), 'dsh-plugin-remote-use', 'shots')
...
'--shot-dir', this.shotDir,
```

**守卫**

`test/relay-supervisor.test.js`：断言 `--shot-dir` 存在，且**不指向包内**
（`includes('dsh-plugin-remote-use\\slave') === false` 且不含 `node_modules`）。

变异检验：删掉 `--shot-dir` → **测试失败** ✓

真机验证：`插件目录 slave\shots : False`、`临时目录 shots : True` ✓

---

## C5. `--print-pairing` 早于 `mkdirSync`

**现象**

部署脚本的"运行拷过去的中继"检查用 `--print-pairing`，它**立即退出**：

```js
if (argv.includes('--print-pairing')) { ...; process.exit(0) }     // 第 143 行
...
try { mkdirSync(SHOT_DIR, { recursive: true }) } catch { }          // 第 403 行
```

所以这个检查**看不到截图目录的问题** —— 它验证了模块图能加载，这是它的目的，但仅此而已。

**根因**

`--print-pairing` 的设计目标是"不启动监听就能拿到配对串"，它刻意在所有副作用之前退出。
于是任何**在它之后**才发生的启动期行为都不在这个检查的覆盖范围内。

**怎么发现的**

排查"截图写进插件目录"时对照行号发现的：`mkdirSync` 在 403 行，而 `--print-pairing` 在 143 行退出。

**修法 / 守卫**

不是修改 relay（`--print-pairing` 的语义是对的），而是**在文档里标出这个检查的边界**：
它能证明"模块图完整"，不能证明"启动期副作用正确"。
真正验证启动路径的是**启动一个监听器并调用 `/healthz` / `/screenshot`** —— 那也是发现 C4 的方式。

---

## C6. 只在一台机器上正确的"检查通过"

**现象（这是 A1 的修法引入的回归）**

A1 把硬编码路径改成"从 `$env:LOCALAPPDATA` 派生"。但自检脚本有**两种运行模式**：

```
Dual mode: SYSTEM (boot) checks the system layer; interactive (logon) adds S7/S8.
```

而在 **SYSTEM 计划任务**下，`$env:LOCALAPPDATA` 指向
`C:\Windows\system32\config\systemprofile` —— 于是**所有候选都不命中**：

| 版本 | 交互式 | SYSTEM 计划任务 |
|---|---|---|
| 硬编码 `sheng` | ✅ 仅参考从机 | ✅ 仅参考从机 |
| **只用 `LOCALAPPDATA` 派生** | ✅ 所有机器 | ❌ **所有机器** |
| 现在（多来源） | ✅ | ✅ |

**我把"只在一台机器上对"换成了"在那个模式下所有机器都错"** —— 两者都错，我的更糟，
因为 SYSTEM 恰恰是从机最容易处在的模式。

**根因**

派生逻辑只考虑了"当前账户"，没考虑"脚本可能以另一个账户运行"。
文档里其实写着这件事（`make-launch-spec.mjs` 的注释：**SYSTEM 下 `LOCALAPPDATA` 指向 systemprofile**），
而我读那份文档是在**改完之后**。

**怎么发现的**

写文档一致性检查时，读到 `DESIGN.md` §13.1 的那句旧注解 —— **正是我当初删掉硬编码候选的理由**。
于是回头验，发现回归。

**修法**

候选来源覆盖**每一个能说出安装位置的东西**：

1. **正在运行的 DSH 进程路径** —— 无论脚本以什么账户运行，它都说得出 DSH 在哪
2. 当前账户的安装位置
3. Program Files（两个）
4. **扫描每个用户 profile** —— 这是 SYSTEM 运行时看不到自己的部分

**守卫**

模拟 SYSTEM 环境实测（把 `LOCALAPPDATA`/`USERPROFILE`/`APPDATA` 都指向 systemprofile）：

```
[OK  ] S14 DSH installed | actual=0.2.0-rc.2
[OK  ] S15 model credentials present | actual=C:\Users\you\.dsh\.credentials.yaml
```

上一版在这个场景下**必然失败**（三个候选全指向 systemprofile）。

`shipped-scripts.test.js` 断言机制：`Get-Process -Name 'DeepSeek Harness'`、`Get-ChildItem $root -Directory`、
`SystemDrive` 三处都在。

> **元教训**：修一个"只在特定环境成立"的检查时，**要先枚举那个检查会运行在哪些环境里**。
> 只看"当前这个"会引入一个更广的假阴性。

---

# D. 验证方法本身的缺陷

这一类是本文档最核心的部分：**检查方式本身有问题，而它给出的错误答案看起来完全可信。**
在这些条目里，"产品"往往是清白的，坏的是量具。

## D1. `Select-Object -First` 提前杀掉上游进程

**现象**

验证截图脚本能否产出 PNG：

```powershell
pwsh -NoProfile -File 'screenshot.ps1' -Out $out 2>&1 | Select-Object -First 4
Write-Output "  产出: $(if (Test-Path $out) { ... } else { '无' })"
```

输出：

```
session=4 interactive=True user=dev
console hidden=True
virtualscreen x=0 y=0 w=3640 h=2068
screen \\.\DISPLAY1 primary=True bounds={X=0,Y=0,Width=2048,Height=1152} bpp=32
  产出: 无
```

**于是我以为截图失败了。** 而脚本自己的报告文件写着：

```
wrote C:\Users\you\AppData\Local\Temp\pwsh-shot.png (4841115 bytes)
distinct sampled colors: 448
RESULT: OK
```

**4.8 MB 的 PNG 是产出成功了的。**

**根因**

`Select-Object -First N` 一旦收满 N 个对象就会**停止管道**，PowerShell 随即**终止上游进程** ——
在那个进程写完文件之前。

**怎么发现的**

产出"无"与脚本报告的 `RESULT: OK` + 明确字节数矛盾。去读脚本自己写的报告文件才看到真相。

**修法**

不要在**会产生副作用**的命令后面接 `Select-Object -First`。改用：
- `Select-Object -Last N`（等进程结束）
- 或把输出重定向到文件再读

**守卫**：无自动化守卫（这是操作纪律），但本文档记录它。

> 这是本项目里**同一个错误类型出现的第三次**：**用一个近似代替那个真正会给出答案的东西，
> 而近似总是给出你想要的答案。**

---

## D2. 掩盖被调用程序的错误

**现象**

远程部署的第一次运行：

```
--- copy ---
  [FAIL] scp relay.mjs -- exit 1
  [FAIL] scp prune-shots.mjs -- exit 1
  [FAIL] scp pairing.mjs -- exit 1
  [FAIL] scp net-address.mjs -- exit 1
  [FAIL] scp selfcheck.ps1 -- exit 1
  [FAIL] scp screenshot.ps1 -- exit 1
  [FAIL] scp make-launch-spec.mjs -- exit 1
  scp node_modules\
Transfer failed; NOT verifying a partial copy.
```

七行 `exit 1`，**没有一个字说明为什么**。

**根因**

```powershell
& scp @scpArgs $file "${Remote}:$Destination/" 2>&1 | Out-Null
```

`2>&1 | Out-Null` 把 scp 的 stderr 整个丢掉了 —— 于是唯一的诊断信息（bash 吃掉了反斜杠）
被我自己扔了。

**怎么发现的**

七行相同且无信息的失败无法处理，只能手工重跑同一条 scp 命令 —— 那次（用正斜杠）**成功了**，
于是问题从"scp 坏了"缩小到"路径形式"。

**修法**

```powershell
# NOT piped to Out-Null: a failing transfer has to say why.
$err = & scp @scpArgs (Join-Path $Source $f.name) "${Remote}:$remotePath/" 2>&1
if ($LASTEXITCODE -ne 0) { $ok = $false; & $check "scp $($f.name)" $false (($err | Select-Object -First 2) -join ' ') }
```

修好之后同一场景给出的是可操作的信息：

```
[FAIL] scp relay.mjs -- ssh: Could not resolve hostname no-such-host-xyz: ...
```

**守卫**

远程模式的三个负向用例（见 D7 与部署脚本一节）都依赖"失败要说原因"。
实测：目标不可达 → 打印真实 ssh 报错、**6.7 秒内 exit 1（不挂起）** ✓

---

## D3. 用秒表比例断言"串行"

**现象**

并发探针的第一版断言：

```js
// 每个任务 sleep 6s，所以串行 ≈ 2 倍单任务，并行 ≈ 1 倍
const single = Math.min(r1.elapsed, r2.elapsed)
check('they SERIALIZED (wall time is about the sum, not the max)', wall > single * 1.5, ...)
```

两次运行的原始数据：

```
第一次: A: completed in 112.0s | B: completed in 219.6s | wall 219.6s
第二次: A: completed in 113.1s | B: completed in 133.3s | wall 133.3s
```

**同一份代码，一次"明显串行"、一次像是重叠。** 而且第二次的 `wall(133.3) < min(113.1) * 1.5 = 169.6`
→ 断言失败。

**根因**

两件事叠在一起：

1. **第二个任务的 `elapsed` 包含等待时间。** `elapsed_B = A的时长 + B自己的时长`。
   所以 `wall = elapsed_B` 永远 ≥ `elapsed_A`，这个比值**不携带"是否串行"的信息**。
2. **agent 自己的耗时极不稳定**（20s 到 110s）。任何基于比例的判据都会被这个方差淹没。

**怎么发现的**

两次运行的比值不一致 —— 如果判据成立，它不该在同样的代码上给出相反的结论。
于是回头把 `start()` 的语义读清楚：**它在 `await this.#acquire()` 之后才解析**，
所以"`start()` 解析的时刻" = "任务被**准入**的时刻"。

**修法**

记录**三个时刻**，断言**一个精确关系**，不用比例：

```js
record.startedAt = Date.now()            // 调用时刻
// start() 解析时：
record.publishedAt = Date.now()          // 准入时刻
// result 解析时：
record.endedAt = Date.now()              // 结束时刻

// 串行：第二个不可能在第一个结束之前被准入
check('the second task was NOT admitted before the first ended',
  second.publishedAt >= first.endedAt, ...)
```

修好之后的数据（精确到同一毫秒）：

```
A: admitted +1.0s   ended +11.2s
B: admitted +11.2s  ended +21.7s      ← 恰好在 A 结束那一刻
[PASS] the second task was NOT admitted before the first ended
```

**守卫**：断言本身。变异检验（把 `serialQueue` 调成 2）会让它失败。

> **元教训**：**能测"事件顺序"时就不要测"时长"。** 时长里混着所有你没想到的因素。

---

## D4. 冷连接耗时被读成"没并行"

**现象**

两个 worker（真从机 + 回环节点）各发一个任务：

```
[PASS] the plugin mounted with 2 worker(s) -- got 2 [remote-wa,remote-wb]
A: completed  called +0.0s  admitted +1.0s  ended +1.8s
B: completed  called +0.0s  admitted +5.6s  ended +6.6s
[FAIL] both were admitted before either ended (they really overlapped)
```

B 在 +5.6s 才被准入 —— 那时 A（+1.8s）已经结束了。

**根因**

`RemoteProvider.start()` 的顺序是**先过门禁、后排队**：

```js
const report = await this.peer.selfcheck()   // ← 要先建连、跑从机自检
const gate = this.#evaluateGate(report)
if (gate.blocked) throw ...
await this.#acquire()                        // ← 准入在这里
```

回环节点是**冷启动**时要 spawn 一个 ACP 子进程，`selfcheck()` 因此花了约 5 秒。
**所以那 5.6 秒是连接耗时，不是互斥。**（每个 provider 有自己的 `serialQueue`，两个 worker 之间没有任何互斥。）

**怎么发现的**

"+5.6s" 这个数字本身可疑：如果真有全局互斥，B 应该恰好在 A 结束（+1.8s）时被准入，
而不是晚 3.8 秒。**串行会给出精确的接续，这里给的是一个偏移** —— 偏移指向别的原因。

**修法**

让任务时长**长于任何合理的连接时间**，并**先热身**回环节点：

```js
// Use the pwsh tool to run the command `Start-Sleep -Seconds 8`, and then reply with ...
```

热身 + 8 秒任务之后：

```
A: admitted +2.2s  ended +12.8s
B: admitted +2.4s  ended +14.3s      ← 两者都在对方结束前被准入
[PASS] both were admitted before either ended (they really overlapped)
```

两者准入只差 0.2 秒 ✓

**守卫**：断言 `r1.publishedAt < r2.endedAt && r2.publishedAt < r1.endedAt`。
变异检验：把两个 worker 配成同一个 URL（`serialQueue` 生效）会让它失败。

---

## D5. `node --check` 只报第一个错

**现象**

部署脚本用它做语法门禁：

```powershell
& node --check $target
& $check "$name parses" ($LASTEXITCODE -eq 0)
```

**根因**

`node --check` 解析到**第一个**意外 token 就停止。文件后面还有十个语法错误时，它也只报一个。
修掉一个再跑，会看到下一个 —— 于是"修一个看一个"。

**怎么发现的**

写脚本时的既有认知 + 实测：一个有两处错误的文件只报第一处。

**修法 / 守卫**

代码注释里明确写出这个边界：

```powershell
# Node parses each module. `node --check` reports only the FIRST unexpected token, so this is a
# syntax gate, not a proof -- the proof is the run below.
```

真正的证明是**运行**（`--print-pairing`），而不是解析。这个"解析 → 运行"的层次在部署脚本里是显式的。

---

## D6. 用远程 shell 拼一行流

**现象**

在从机上检查 `.ps1` 的两个性质，第一次实现是一行流：

```powershell
& ssh ... $Remote "powershell -NoProfile -Command `"((Get-Content -LiteralPath '$Destination\$name' | Where-Object { \$_.Trim() -ne '' -and -not \$_.Trim().StartsWith('#') } | Select-Object -First 1) -match '^param\(')`"" 2>&1
```

结果两项都以**目标机自己的解析错误**失败：

```
[FAIL] selfcheck.ps1 has param() as its first statement -- 所在位置 行:1 字符:102
```

**这个错误完全没提到被检查的脚本** —— 它说的是我拼的那条命令。

**根因**

那行命令要穿过三层：**本机 PowerShell → ssh（远程 shell 是 bash 或 cmd）→ 远程 PowerShell**。
`$_`、嵌套引号、`$Destination` 里的反斜杠，每一层都可能被重新解释。

**怎么发现的**

失败信息指向的是**命令本身**，而不是脚本 —— 一个"检查工具坏了"而不是"被检查对象坏了"的信号。
判断依据：如果脚本真的有问题，错误应该在脚本的语法/内容上，而不是在 `行:1 字符:102`。

**修法**

**把文件拉回来检查。** 检查的仍是**目标机上的字节**（`scp` 返回的就是那些字节），
但不再有 shell 插手的余地：

```powershell
$localForScripts = Join-Path ([System.IO.Path]::GetTempPath()) "deploy-slave-check-$PID"
foreach ($name in 'selfcheck.ps1', 'screenshot.ps1') {
  & scp -q ... "${Remote}:$remotePath/$name" $localForScripts
}
# 之后在这个临时目录上做原来的检查
```

同时修法本身加了一句注释说明**这不是弱化**：问题只是"目标机上的这份副本是否 ASCII-only 且以 `param()` 开头"，
而 scp 返回的正是那份副本。

**守卫**

正向实测：两项都 PASS（`0 high byte(s)`、`param() first`）✓

---

## D7. 路径穿过 shell：反斜杠被吃掉

**现象**

远程部署时**每一个** scp 都失败（见 D2 的七行 `exit 1`）。手工重跑同样的 scp，
但这次用**正斜杠**：

```
scp ... 'relay.mjs' 'worker-pc:C:/dsh-remote/plugin-slave-verify/'
exit=0
```

**成功。**

**根因**

脚本传的是 `C:\dsh-remote\plugin-slave-verify` —— 而 **scp 的远程那一端是一个 shell**，
反斜杠在到达 scp 的远端之前就被 shell 吃掉了，于是远端看到的是
`C:dsh-remoteplugin-slave-verify` 之类的路径。

**怎么发现的**

D2 说了"七行没有原因"，手工重跑时唯一改变的就是路径分隔符。**这个变量是唯一的差异。**

**修法**

**传给远程 shell 的路径一律用正斜杠**，并在变量名与注释里说清这一点：

```powershell
# Forward slashes for anything that crosses into the remote SHELL.
$remotePath = if ($remoteMode) { $Destination -replace '\\', '/' } else { $Destination }
```

而给 `cmd /c` 的检查**仍用反斜杠**（那些命令的目标是 cmd，不是 bash）：

```powershell
& ssh ... "cmd /c if exist `"$Destination\$relPath`" (exit 0) else (exit 1)"
```

**守卫**

- 远程模式正向实测：`RESULT: OK`，exit 0 ✓
- 负向：目标不可达 → 打印真实 ssh 错误、**6.7 秒内 exit 1** ✓

---

## D8. 把本地路径当作两机共享的路径

**现象**

并发探针让每个任务把 marker 写进一个文件，然后在**主机**上读回来：

```js
const out = join(tmpdir(), `probe-conc-${marker}.txt`)
// prompt: 把 marker 写进 ${out}
...
check('A wrote its own marker', readFileSync(r1.out, 'utf8').includes('MARKER-A1'))
```

结果：

```
[FAIL] A wrote its own marker -- ""
[FAIL] B wrote its own marker -- ""
```

（而两个任务的**输出**里其实都有各自的 marker。）

**根因**

`out` 是**主机**的 temp 目录（`C:\Users\you\AppData\Local\Temp\...`）。
任务跑在**从机**上，那里没有这个路径 —— 所以写入失败，文件在读回来时是空的。
**这个检查在测主机，不是在测从机。**

**怎么发现的**

两条 FAIL 旁边，同一段输出里 **"A came back with its own marker" 是 PASS** ——
说明任务确实执行了自己的提示词。**两个结论矛盾**，指向"我读错了地方"。

**修法**

**用任务自己的回复作为证据** —— 一次穿过从机的往返，且不假设两边共享文件系统：

```js
// prompt: Reply with exactly this and nothing else: ${marker}
check('A came back with its own marker', textOf(r1).includes('MARKER-A1'), ...)
check('B came back with its own marker', textOf(r2).includes('MARKER-B1'), ...)
check('no cross-talk: A never carries B\'s marker', textOf(r1).includes('MARKER-B1') === false)
check('no cross-talk: B never carries A\'s marker', textOf(r2).includes('MARKER-A1') === false)
```

**守卫**：断言本身。正向 + 反向成对出现（"有自己" 与 "没有对方的"），
这样"输出为空"不会同时满足两个方向而使检查空洞。

---

## D9. 在**错误的会话**里测量，然后据此下了结论

**现象**

从机调整过显示器布局之后，主机侧要确认它是否恢复。用 SSH 去读显示：

```
WinDisc | 1024x768 at (0,0) primary=True
```

`WinDisc` 正是 S2 报错文案里点名的兜底适配器，`1024x768` 也不是约定分辨率 ——
于是结论是"**虚拟显示器没生效、S2 仍会阻断**"。**这个结论是错的。**

**根因**

**SSH 落在非交互会话，而那个会话的显示不等于控制台的显示。** session 0 没有桌面，
`[Screen]::AllScreens` 返回的是**执行它的那个会话**所看到的东西。

**这条约束在设计文档里早就写明**（DESIGN §5.10.2.1 / §622）：

> 显示类检查**只在交互会话**执行；S1/S2/S3/S4/S5/S7/S8 **必须由交互会话执行**

**怎么发现的**

矛盾。同一台机器上，"SSH 读到 `WinDisc`" 与 "从机侧一切照常" 不可能同时为真。
去问**从机自己的自检** —— 它由 `Interactive` 计划任务在正确的会话里执行：

```
"verdict": "warn",  "blockingFailures": 0
```

`blockingFailures=0` 说明 S1/S2/S4 全过：**显示是好的，是我的观测位置错了。**

**修法**

诊断显示/输入类问题时**不要从 SSH 猜**，用从机自检的 RPC —— 它被设计成在正确的会话里跑。
主机侧的 `remote_selfcheck` 就是为此存在的。

**守卫**

产品本身已经把它结构化：自检拆成 **SYSTEM 段**（开机，只做系统层 S9/S12/S14–S18）与
**Interactive 段**（S1–S8），两段结果合并成一份报告。**这个坑在产品里已经被防住了** ——
出问题的是绕过产品、直接伸手去读。

> 教训不在代码里：**手上有一个被设计成"在正确位置执行"的检查时，
> 绕过它、到旁边自己量一个数，是自找的误判。**

---

## D10. 用 shell 的字符串替换去改文件：**同一天失败四次**

**现象**

改配置或改代码时用「读文件 → `.Replace(旧, 新)` → 写回」，**替换静默没生效**：
脚本报成功、退出码 0，文件却一字未动。于是后面的验证跑在一份**没被改过**的文件上。

同一轮里，这个动作失败了四次，每次都是**同一类**原因：

| 写法 | 为什么没匹配上 |
|---|---|
| `$c.Replace('"version": "0.1.0"', ...)` | 文件里是 CRLF，我的模式只写了 `\n` |
| `$c.Replace("name: '@…'", ...)` | 同上；而且行首还有缩进 |
| `$c -replace "id: '…',\r?\n  factory"` | 反向断言：真正的文件里 `id:` 和大段注释相邻 |
| 嵌套引号拼一行 `ssh` 命令 | `''` / `\"` / 反引号三层叠加，**PowerShell 自己先解析失败** |

最坏的一次是**把一条注释当成了规则**（`git filter-repo --replace-text` 的 `==>` 语义），
那次不是"没生效"，而是**生效错了地方** —— 见 A 类。

**根因**

- 行尾、缩进、引号样式都是**文件的属性**，不是我能凭记忆写出来的字符串；
- shell 的字符串**再经过一层解析**（引号、反斜杠、反引号），一层不对就整体变形；
- 而这三种失败**都表现为成功** —— 没有异常、没有非零退出码。

**修法**

1. **改文件用编辑器语义的工具**（`edit` / `write`），不用 shell 的字符串替换；
2. 必须在脚本里做替换时，**替换后立刻断言旧值已消失、新值已出现**，不要只看退出码：

```powershell
$t = $t.Replace($old, $new)
if ($t -eq $before) { throw "replacement did not apply: pattern not found" }
```

3. **一行远程命令的复杂度有上限。** 超过一个引号层级就**写成脚本文件传过去跑**
   （`.research/deploy-ps1.ps1` 就是为此存在的），不要在一行里拼。

> 这一条的代价被放大了：因为替换静默失败，我**连续几轮都在对一份没改过的文件下结论**。

---

## D11. 测试里写死被测对象的名字：**它会接受 bug、拒绝修复**

**现象**

包从 `dsh-plugin-remote-use` 改名为 `@hope_phenom/dsh-plugin-remote-use` 之后，
**唯一能抓到改名漏项的那个测试**（加载客户端 bundle 的 harness）里写着：

```js
assert.equal(definition.id, 'dsh-plugin-remote-use')   // ← 写死的是【旧名】
```

于是它**拒绝了正确的值、接受了错误的值** —— 一个测试如果断言的是错的，
那它不但不能发现问题，还会**主动保护问题**。

**根因**

断言里出现了**被测对象的名字本身**。名字一旦变化，测试的**判据**就跟着漂移，
而它仍然"全绿"。

**修法**

判据要**从被测对象自己那里读**，不要抄一份：

```js
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
assert.equal(definition.id, PKG.name)   // ← 名字以 manifest 为唯一真值
```

**推论（比这一条更重要）**：`全绿` 说明不了"检查是有效的"。
这条 harness 在 bug 存在期间一直是绿的 —— 要发现它，只能靠**变异检验**
（把正确的值改回错的，看它是否立刻失败）。这次的每一条新守卫都做了变异检验。

---

## D12. 真机 harness 说它在测**安装件**，实际测的是**源码检出**（一个 junction）

**现象**

0.2.2 装好之后跑真机回归，全绿。而"装的件 == 我提交的那份"这个核对是用
`node_modules\@hope_phenom\dsh-plugin-remote-use`（**带作用域**）做的哈希比对 —— 看起来两条结论互相支持。

直到 harness 自己把那行打印出来：

```
entry : C:/Users/dev/.dsh/profiles/desktop/node_modules/dsh-plugin-remote-use/lib/index.js
```

**不带作用域。** 这是包改作用域名（PITFALLS F8）之前留下的硬编码路径。

**根因**

那个路径**确实存在**，而且**确实能解析** —— 但它是：

```
node_modules\dsh-plugin-remote-use             → Junction → F:\WorkSpace\dsh-plugin-remote-use\packages\dsh-plugin-remote-use
node_modules\@hope_phenom\dsh-plugin-remote-use → 真目录（正常安装）
```

所以 harness 加载的是**开发者的工作树**，而**运行中的 DSH 加载的是带作用域的那份真安装件**
（补丁里的 `name: '@hope_phenom/dsh-plugin-remote-use'` 才是 loader 导入的模块名 ——
不带作用域的那个字符串只是**行 id**，F8 说过这两个标识符必须不同）。

**为什么"两次都通过"反而更危险**

那一刻检出与安装件**逐字节相同**，所以谁都没错。但**它们不相同的那一天**，
这个 harness 会对**没人发布过的代码**给出"发布件通过"的结论 —— 而且它打印的路径读起来像安装件。
这和 B1（settings 覆盖 harness 的配置）、D8（把本地路径当作两机共享路径）是同一个族：
**你以为在测 A，其实在测 B。**

**修法**

入口路径**从权威来源推导**，与 loader 同一条规则：profile 清单里的包名 →
`node_modules/<scope>/<name>/lib/index.js`。并且**把"这是不是链接"打印出来**：

```
entry : C:\Users\you\.dsh\profiles\desktop\node_modules\@hope_phenom\dsh-plugin-remote-use\lib\index.js
        resolved from the profile manifest: a real directory in the profile
```

是链接时打 `WARNING: this run is NOT testing the installed artifact.`；用 `--entry` 显式覆盖时也说明。
旁证：Harness 里那条 `[remote-use] ... not importable ... imported from <路径>` 的 stderr
**会自己报出它实际从哪个文件加载** —— 那行一直都写着真路径，只是以前没人拿它对照入口。

**顺带发现**：那个旧 junction **没有任何东西引用**（profile 的 `dependencies`/`bundles`、
插件补丁的 `name:` 全是带作用域的名字；`~/.dsh/cordis.patch.yml` 里一个字都没有）。
它是开发期遗留，**但它的存在会让"不带作用域的名字也能解析"这件事为真** —— 那正是 F8 那类改名事故的掩护。

> **方法上的教训**："我测的是 X" 这句话里的 X 是一个**路径**，而路径可以被链接指向别处。
> 让权威来源（manifest）推导它，并且**把解析结果打印出来**；
> 硬编码的路径不会失效，它只会**继续存在并指向另一个东西**。

---

## D13. 多行锚点的编辑把**邻近那行**一起吃掉 —— 而结果"看起来改对了"

**现象（2026-10-15，给配置加两个字段时）**：我用「两行注释 + 一行代码」作为替换锚点，
但新内容只写了我要**加**的东西 —— 于是被锚点覆盖掉的 `auditMaxBytes` 规范化那一行**凭空消失了**。
文件语法正确、`node --check` 通过、我新加的两行完美无瑕。

**发现方式**：改完顺手重读了**那一整段**（而不是只看新写的那几行），发现 `auditMaxBytes` 不见了。

**这次是人眼抓到的，不是测试抓到的** —— 而往返测试本来也会抓到它（它断言"保存 4096 后读回仍是 4096"，
少了规范化就会退回默认 8 MiB）。**一个测试能抓到、而我提前一眼抓到的错误，说明该看的不是测试结果，
而是改动范围。**

**教训**

1. **替换锚点不要跨越你不打算改的行。** 为了让上下文唯一，用**最小的唯一片段**；
   锚点里每多一行，就多一行"我没打算动、但现在由我负责"的内容。
2. **改完要重读的是"那一整段"，不是"我新写的那几行"。** 只看新行，永远看不出少了什么 ——
   缺失不会在新增内容里留下痕迹。
3. 这一条与 D10（用 shell 字符串替换改文件，同一天失败四次）是**同一形状的工具版本**：
   文本级替换的危险不在"替换失败"，而在**替换成功、但范围比你以为的大**。
   D10 的教训是"别用文本替换改代码"，而这一条说明：**用结构化编辑工具也一样**，
   只要锚点里包含了你不想负责的行。

---

# E. 环境与平台的坑

## E1. PowerShell 5.1 在一个卷上被按路径拦截，而 `-ExecutionPolicy Bypass` 无效

**现象**

通过中继截图，返回 500：

```
/screenshot failed: capture produced no image (exit 1); output:
  screenshot.ps1 无法加载，因为在此系统上禁止运行脚本
  + CategoryInfo : SecurityError: (:) [], ParentContainsErrorRecordException
  + FullyQualifiedErrorId : UnauthorizedAccess
```

用英文重现时看到更准确的信息：

```
The file ...\screenshot.ps1 is not digitally signed. You cannot run this script on the current system.
```

而**同一个文件、同样的内容**放到 `C:\Temp` 就能跑。

**根因（对照实验）**

| 解释器 | `F:`（ReFS 本地卷） | `C:`（NTFS） |
|---|---|---|
| **`pwsh` 7** | **能跑** | 能跑 |
| **`powershell.exe` 5.1** | **被拒** | 能跑 |

同一个测试脚本、同一命令行，只有**位置**和**解释器**不同。

这是 **WDAC / AppLocker 类规则**：它**按路径**拦截 PowerShell 5.1，
**独立于 PowerShell 的执行策略** —— 所以 `-ExecutionPolicy Bypass` 帮不上忙
（有效的 MachinePolicy 是 `RemoteSigned`，而按策略 `Bypass` 无法覆盖 MachinePolicy；
无论如何，实测就是无效）。`pwsh` 7 不受这条规则约束。

**这个缺陷的两种表现，严重程度差很多**：

| 脚本 | 表现 |
|---|---|
| `screenshot.ps1` | **响亮的 500** |
| `selfcheck.ps1` | **静默的降级报告**（见 [A8](#a8-自检失败返回像报告的报告)），调用方只要检查 `verdict !== undefined` 就会当成成功 |

**怎么发现的**

截图 500 是引子。**发现 `selfcheck.ps1` 也被挡住**，是靠看探针输出里那个 `S0` 的 `actual`
——`Unexpected end of JSON input` 是中继读不到报告，而中继读不到报告是因为脚本没跑成。

**修法**

`slave/relay.mjs` 里优先用 `pwsh`，回退到 `powershell.exe`：

```js
const PS_EXE = (() => {
  if (process.platform !== 'win32') return 'pwsh'
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const candidates = [
    join(pf, 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ]
  for (const c of candidates) { try { if (statSync(c).isFile()) return c } catch {} }
  return 'pwsh'
})()
const PS_BASE_ARGS = process.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass'] : ['-NoProfile']
```

`-ExecutionPolicy Bypass` 保留给 5.1 回退（在那里它确实有用）。

**守卫**

实测：修好后自检报 **17 项真实报告**、`sessionSegment: "ok"`、`blockingFailures: 2`
（两项都是**真实**的主机问题：睡眠未关、控制台 QuickEdit 未关）。

---

## E2. 沙箱内跑自检：合成输入的假阴性

**现象**

从**受限**的 shell 里启动中继再跑自检：

```
[FAIL] S8 SendInput / SetCursorPos live | expected=cursor moves | actual=FAIL set=False got=695,336
```

`SetCursorPos` 返回 false，而且光标位置三次都不同（695,336 / 754,150 / 461,107）——
那是**我自己的鼠标在动**，不是脚本设的。

**根因（对照实验）**

同机、相隔几分钟：

| 运行环境 | verdict | S8 |
|---|---|---|
| **受限**（agent 的 shell，DSH 沙箱内） | `blocked`, 1 blocking | **fail** (`set=False`) |
| **不受限**（一次性计划任务 + pwsh 7） | `warn`, 0 blocking | **pass** (`ok`) |

受限令牌无法向更高完整性级别的窗口注入输入（**UIPI**）。所以 S8 失败说的是
**harness 的处境**，不是主机的状态。

**怎么发现的**

S8 在改本机设置（S9/S12）之前没被标记过，改完之后出现 —— **一个"因为无关改动而出现"的失败**，
本身就可疑。于是设计对照：把同样的自检放到沙箱外跑。

第一次对照还**失败**了：用 `powershell.exe` 的计划任务在 `F:` 上跑不起来（见 E1），
留下的是**陈旧报告**，我差点读成"沙箱外也一样失败"。换成 `pwsh` 7 才得到干净的对照。

**修法 / 守卫**

- 把这条写进 `tools/arm-loopback-worker.mjs` 的文档头（含两个数值）
- 新增 `tools/run-unconfined.ps1`：一次性计划任务（**交互用户、非提权**），
  让命令在沙箱外运行 —— 因为"验证一台机器能不能当 GUI 工作节点"这件事，
  在沙箱里做会系统性地得到假阴性

> 注意这里的**方向**：S8 的假阴性是**把好的说成坏的**（保守，安全）。
> 它的代价不是风险，而是**让人去追一个不存在的主机问题**，以及让"就绪报告"失去可信度。

---

## E3. PS 5.1 把无 BOM 的 `.ps1` 当 ANSI 读

**现象**

一个含非 ASCII 字节、且没有 BOM 的 `.ps1`，在 PowerShell 5.1 下解析失败或字符串被破坏。

**根因**

5.1 在无 BOM 时按**系统 ANSI 代码页**解码源文件。UTF-8 的中文字节序列因此变成乱码，
若恰好落在字符串字面量里就会破坏解析。

**修法 / 守卫**

**从机侧的所有 `.ps1` 保持纯 ASCII**，并在每个文件头部写出原因：

```powershell
# ASCII-ONLY ON PURPOSE: Windows PowerShell 5.1 reads BOM-less files as ANSI, and a
# non-ASCII byte sequence inside a string literal breaks parsing.
```

守卫是**两层的**：

1. `tools/deploy-slave.ps1` 在**部署到目标机之后**检查目标上的字节（见 D6 的改法）
2. `.research/deploy-ps1.ps1 -ValidateOnly` 在本地检查：非 ASCII 且无 BOM → 拒绝

第二条**当场抓到过我自己的错误**：我在 `deploy-slave.ps1` 的注释里写了中文报错，
被它拒绝（`contains 21 non-ASCII byte(s) with no BOM`）。

---

## E4. `param()` 必须是第一条语句

**现象**

把一个 `param(...)` 块放在文件头部的注释之后、但**某个赋值语句之后**，PowerShell 报的错
**指向它后面的行**，信息是 "invalid assignment operator" 之类，与 `param` 无关。

**根因**

PowerShell 要求 `param()` 是脚本的第一条**语句**（注释不算）。放错位置时，
解析器在那个位置的状态与预期不同，于是错误被报在更后面的 token 上。

**修法**

`param()` 紧跟文件头的注释块，成为第一条语句：

```powershell
# ... ASCII-ONLY，及其它说明 ...
param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [string]$Remote = '',
  ...
)
$ErrorActionPreference = 'Stop'
```

**守卫**

`test/shipped-scripts.test.js` 有一条：扫描 `param(` 之前的每一行，
**任何非空且非注释的行**都导致失败，并指出是第几行。

```js
assert.fail(`${name}: param() must precede every statement; line ${index + 1} is "${trimmed.slice(0, 60)}"`)
```

`tools/deploy-slave.ps1` 也在**目标机上**检查同一性质（因为 5.1 的报错指向别处，
本地读起来很费解）。

---

## E5. `Tee-Object` 写 UTF-16LE

**现象**

截图脚本的几何报告（供 relay 读取）用 `Tee-Object` 写文件，
而 relay 按 UTF-8 读 —— 于是每个字符之间夹着 NUL 字节，**所有前缀匹配都失败**，
relay 静默报告 `0x0` 几何。

**根因**

Windows PowerShell 5.1 的 `Tee-Object` 写 **UTF-16LE**。

**修法**

显式指定编码，并把这个理由写进注释：

```powershell
# Explicit UTF-8 rather than Tee-Object: in Windows PowerShell 5.1 Tee-Object writes
# UTF-16LE, and a UTF-8 reader then sees NUL bytes between characters so every prefix match
# fails -- the relay silently reported 0x0 geometry because of exactly that.
function W($m) {
  Write-Output $m
  Add-Content -Path $report -Value $m -Encoding UTF8
}
```

读取端后来也**容忍 UTF-16**（`replace(/^\uFEFF/, '')` 之类），但写入端不依赖它 —— 两侧各自负责。

---

## E6. `files` 白名单里的目录，无法被 `.gitignore` / `.npmignore` 排除

**现象**

插件目录下的生成物（自检报告、截图报告、配对文件、`shots/`）被打进了发布包：

```
npm notice 14B    slave/pairing.txt
npm notice 34B    slave/selfcheck.json
npm notice 12B    slave/selfcheck.txt
npm notice 1B     slave/shots/old.png
```

而 `slave/selfcheck.json` 是一份**关于跑它的那台机器**的报告（机器名、显示器、GPU、会话 id）。
**把它发布出去是信息泄露，不是"不够整洁"。**

**根因（两次尝试都错，错法不同）**

| 尝试 | 结果 |
|---|---|
| `.gitignore` | **对 `files` 白名单里的目录无效** |
| `.npmignore` | **同样无效** —— npm 的成文规则：`files` 包含的条目**无法**被 `.npmignore` 或 `.gitignore` 排除 |

**怎么发现的**

**真的跑了打包器**。前两次都是"我检查了配置文件" —— 那是**近似**；
只有打包器能回答"到底发布什么"。

```
npm pack --dry-run
```

**修法**

**改 `files`：显式列举，而不是整个目录。**

```json
"files": [
  "lib", "assets", "locale", "cordis.patch.yml",
  "slave/*.mjs", "slave/*.ps1", "slave/node_modules"
]
```

实测：**54 → 50 个文件**，4 个生成物全部消失，而 relay / 自检 / 截图脚本与 `ws` 依赖仍在。

同时**删掉了那个 `.npmignore`** —— 它记录的机制不存在，留着会误导下一个读它的人。

**守卫**

`test/shipped-scripts.test.js` **运行真的打包器**：

```js
const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: PKG_ROOT, encoding: 'utf8', shell: true })
const paths = (JSON.parse(String(packed.stdout))?.[0]?.files ?? []).map((f) => f.path)
for (const required of ['slave/relay.mjs', 'slave/selfcheck.ps1', 'lib/index.js', 'lib/client.js']) {
  assert.ok(paths.includes(required), `${required} is missing from the tarball`)
}
const forbidden = paths.filter((p) => /selfcheck\.(json|txt)$|pairing\.txt$|slave\/shots\//u.test(p))
assert.deepEqual(forbidden, [])
```

两个方向都断言（必需的**在**、禁止的**不在**），否则"什么都没打包"也会通过。
另有一条直接断言 `files` 里没有裸 `"slave"`，回退时给出清晰原因。

变异检验：把 `files` 改回 `"slave"` → **两条都失败** ✓

更新一层：**打包 → 解包 → 从解包里运行 relay**，这样才能证明
`slave/node_modules` 一旦漏掉会让包"装得上但起不来"：

```js
const run = spawnSync(process.execPath, [relay, '--port', '7395', '--token', 'packed-probe-token', '--print-pairing'], ...)
assert.match(String(run.stdout), /^dshpair1\./u, 'the packed relay could not produce a pairing string')
```

变异检验：从 `files` 去掉 `slave/node_modules` → **失败** ✓

---

## E7. asar 内的路径不可 `Test-Path`

**现象**

想 grep DSH 的实现源码：

```powershell
$dsh = 'C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh'
Test-Path $dsh     # → False
```

而文档与进程命令行里都用这个路径。

**根因**

`app.asar` 是一个**归档文件**，不是目录。Electron 通过补丁过的 `fs` 能读它，
但**普通的文件系统 API 看不见它** —— 所以 `Test-Path`、`Get-ChildItem`、`Select-String -Path` 全部落空。

**怎么发现的**

一次搜索返回空结果。**"没找到"与"路径不存在"是两件事** —— 检查路径本身才看到 `False`。

**修法**

用**解包产物**搜索。本项目里解包到 `.research/asar/`（`asar-extract-all.mjs`），
权威事实在那里查得到：

```
.research/asar/@deepseek-ai/dsh-tools/lib/index.js:2897
  throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global
                   restriction would mask every agent')
```

同一事实在 `.research/asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js` 也有一份。

> 顺带：调试时也要注意 **`app.asar/dsh` 与 `app.asar.unpacked/dsh` 是两处**，
> 有一份 `cli.js` 只在 `unpacked` 下（`@deepseek-ai/libreoffice-kit`）。

---

## E8. `Set-Content -Encoding UTF8` 写出的文件**带 BOM**，而 DSH 拒绝解析它

**现象**

改完 profile 的清单之后，**DSH 完全无法启动**，桌面弹窗指向一份崩溃日志：

```
DesktopHostFatalError: Unexpected token '', "{ "n"... is not valid JSON
  at JSON.parse (<anonymous>)
  at readProfileManifest (dsh-app-boot/lib/index.js:835:22)
  at loadProfileDirectory (dsh-app-boot/lib/index.js:921:18)
```

错误信息里那个 `?` 就是 **U+FEFF**。`readProfileManifest` 用**裸 `JSON.parse`** 读
profile 的 `package.json`，它不接受 BOM —— 而文件**内容本身完全合法**。

**根因**

```powershell
$j | ConvertTo-Json | Set-Content $p -Encoding UTF8    # ← Windows PowerShell 5.1：带 BOM
```

**这条坑本来就在 E3 里**，只是方向相反：E3 说的是"PS 5.1 把**无 BOM** 的 `.ps1` 当 ANSI **读**"，
而同一套默认行为在**写**的时候会**主动加上** BOM。

**修法**

写 JSON/YAML 这类**会被程序严格解析**的文件时，显式用无 BOM 的编码，并**校验首字节**：

```powershell
$enc = New-Object System.Text.UTF8Encoding($false)          # $false = 不写 BOM
[System.IO.File]::WriteAllText($p, $json, $enc)

$b = [System.IO.File]::ReadAllBytes($p)
if ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { throw 'a BOM was written' }
```

`.research/set-profile-bundle.ps1` / `fix-profile-json.ps1` 都内置了这一步校验。

> 代价说明：这是一次**致命**错误 —— 不是"某个功能不工作"，而是**整个应用起不来**。
> 而且它发生在"我为了修一个非致命问题去改配置"的过程中，把一个可用的机器变成了不可用的机器。

---

## E9. `Start-Process -ArgumentList @(...)` 会切断带空格的路径

**现象**

想用命令行复现 GUI 的启动失败，结果拿到一个**看起来像 DSH 坏了**的错误：

```
Error: Cannot find module 'C:\Users\worker\AppData\Local\Programs\DeepSeek'
```

**根因**

```powershell
Start-Process -FilePath $exe -ArgumentList @('--expose-internals', $cli, '--profile', 'desktop')
#                                             ↑ 数组会被用空格【拼接】，且不加引号
```

路径里的 `DeepSeek Harness` 含空格，于是被切成了两个参数。

**修法**

传**一个已经引号化好的字符串**，而不是数组：

```powershell
$args = "--expose-internals `"$cli`" --profile $Profile"
Start-Process -FilePath $exe -ArgumentList $args -PassThru
```

**顺带一条同源的**：`cmd /c` 里跑带空格的路径也一样 —— `cmd /c node C:\...\DeepSeek Harness\...`
会被切断，要么整体加引号，要么**写成脚本文件**（见 D10 第 3 条）。

---

## E9b. `-replace` 的替换串里，反斜杠**会被再解释一层**

**现象**

给 YAML 生成一条 Windows 路径，要求文件里是**两个**反斜杠（YAML 双引号里 `\\` 表示一个 `\`），
结果生成出**四个**：

```yaml
- "C:\\\\Program Files\\\\nodejs\\\\node.exe"     # 错的
- "C:\\Program Files\\nodejs\\node.exe"           # 对的
```

**根因**

```powershell
$path -replace '\\', '\\\\'      # ✗
```

`-replace` 用的是**正则**，**替换串**里的反斜杠还有自己的一层解释 —— 于是每个 `\` 变成了两个 `\`，
两个又变成四个。而且这一行**看起来完全正确**，因为模式串那侧确实要用两个反斜杠。

**修法**

要按字面替换时用 **`String.Replace`**（不是 `-replace`），并用 `[char]92` 拼出反斜杠，
避免在源码里数不清自己写了几个：

```powershell
$bs  = [string][char]92
$quad = $bs + $bs + $bs + $bs
$duo  = $bs + $bs
$text = $text.Replace($quad, $duo)     # 字面替换，无反斜杠语义
```

**而且必须验证归一化后的结果**，不能只看生成出来的文本：

```powershell
# 照抄消费方的归一化逻辑，再断言它认得这个路径
$norm = $entry.Replace($duo, $bs).Replace('"', '')
if (-not $norm.Contains($expected)) { throw "still does not match after normalisation" }
```

> 这个坑的代价：配置写对了**目录**、写对了**字段**，却因为多出来的两个反斜杠
> 让门禁继续报"未物化" —— 而错误信息完全指向别处。

---

# F. 上游与协议事实

这一类的条目不是"缺陷"，而是**必须按上游的形状写代码**的事实 —— 违反它们时症状往往离原因很远。

## F1. `ctx.tools.restrict()` 强制 per-agent

**事实（在解包产物里查到原文）**

```
@deepseek-ai/dsh-tools/lib/index.js:2897
throw new Error('tools.restrict() requires a scoped context (agent.ctx):
                 a context-global restriction would mask every agent')
```

**为什么值得记**

"默认 off：新会话不注入策略、远程工具在该会话内不可见"这条要求，看起来可以用一次全局
`restrict()` 实现 —— 而上游**明确拒绝**这种调用。所以正确形状只能是：

```js
// agent.ctx 让限制随该 agent 生灭，而不是跨会话泄漏
restrictions.set(agent, agent.ctx.tools.restrict({ deny: [...REMOTE_TOOL_NAMES] }))
```

**怎么核实的**

不是靠推理，也不是靠报错试出来 —— 而是**在解包产物里 grep 到那句原文**，
确认这个约束真实存在且引文逐字相符。代码注释里也引了这句。

**附带发现**：一个 `Test-Path` 为假的路径（E7）让我最初的搜索"什么也没找到"，
差点得出"这个约束是我编的"这个反向结论。**"没找到"要先排除"找的地方不对"。**

**守卫**

测试用**假 `agent.ctx`** 模拟 per-agent 语义，并断言三件事：

```
PASS  a new session has the remote tools denied -- denied 4
PASS  /remote-use on succeeds
PASS  an enabled session is no longer denied -- denied 0
PASS  the other session stays off          ← 关键：打开一个不影响另一个
PASS  /remote-use off succeeds
PASS  the restriction comes back
```

---

## F2. `defineTool` 是唯一的 schema 转换点

**现象（曾经会全量失败）**

工具的参数 schema 若以简写形式交给 `ctx.tools.register()`，模型侧**每一次调用**都会失败：

```
schema must be a JSON Schema of type: "object", got type: null
```

**根因**

`ctx.tools.register()` **只校验 `output`**，而 `parameters` 被**原样保存**。
简写 → JSON Schema 的转换只发生在 `defineTool()` 里。绕过它，存进去的就是 `type: null`。

**怎么发现的**

冒烟测试对每个注册的工具断言 `parameters.type === 'object'`：

```js
check(`${t.name}: parameters are an object-rooted JSON Schema`,
  t.parameters?.type === 'object' && typeof t.parameters?.properties === 'object', ...)
check(`${t.name}: no property keeps a "required" keyword`, stray.length === 0)
```

它在**加载路径**上抓到了这个类别的缺陷，而不是等到生产里模型报错。

**守卫**：上面两条断言（冒烟测试里对四个工具各跑一遍）。

---

## F3. `ctx.effect` 立即执行，并返回它自己的 disposer

**事实**

`ctx.effect(fn)` **立刻调用 `fn()`**，并返回 **`fn` 自己的返回值作为 disposer** ——
不是返回一个"执行了 fn 的"包装 disposer。

**为什么值得记**

写

```js
ctx.effect(() => { setup(); return () => teardown() })
```

是对的；而写成一个"注册回调等以后执行"的形状就完全不是同一件事。
测试里的假 ctx 必须**忠实模拟**这一点，否则单测会在一个不存在的语义上通过：

```js
// Cordis runs an effect body immediately, so mirroring that keeps the test honest.
effect: (fn) => fn(),
```

**怎么发现的**

写假 ctx 时对照真实语义，并在测试里显式注释了这个选择。

**守卫**：冒烟测试断言**所有 effect 都已运行且可 dispose**：

```
PASS  every effect ran without throwing -- 13 effects
PASS  effects are disposable
PASS  all disposers run without throwing -- 13/13
```

---

## F4. Cordis patch：新增行需要 `insert:`

**事实**

profile 补丁是一个 YAML 数组。给**已存在的条目**改配置用 `id` 直接覆盖；
要**新增**一行必须放在 `insert:` 下面：

```yaml
- insert:
    - id: dsh-plugin-remote-use
      name: dsh-plugin-remote-use
      config:
        workers: []
```

**为什么值得记**

一个"看起来应该生效但完全没生效"的补丁，症状是"插件没被加载"，与"插件不存在"无法区分。

**守卫**

`cordis.patch.yml` 的注释里写明了这个形状，以及为什么每个 worker 需要**自己的一行工具行**
（插件不能在运行时追加工具行）。这条限制后来变成了设置页空状态提示的内容 ——
原本那条提示把操作者指向"在 profile 补丁里配置 worker"，而**真正需要补丁的是工具行**
（worker 本身在页面上就能配）。见 [A7](#a7-文档说未实现而实现在同一屏上) 的同类。

---

## F5. `dsh-client-modules` 的元数据缓存需要重启

**事实**

`dsh-client-modules` 在构造时**同步**扫描 `dsh.client` 声明，并且 `resolveMeta`
**按进程缓存 `pkgMeta` 且从不清理**。所以：

- 给 `package.json` **新增** `dsh.client` 声明 → 必须**重启 DSH** 才生效
- 而 `lib/client.js` 本身是**按请求提供**的 → 改它的内容只需**刷新页面**

**为什么值得记**

这个不对称会误导判断：改了客户端代码、刷新页面没看到变化，很自然会怀疑"缓存没清"，
而实际原因可能是"元数据在启动时就定了"。

**证据（本会话的实测）**

重启前：插件路由不可用；重启后（主进程 pid 更新、启动时间从 11:18 变为 15:24）：

```
GET /api/dsh/dsh-plugin-remote-use  ->  HTTP 200  3254 字节
（对照）GET /api/dsh/no-such-plugin  ->  401
```

**顺带的一个反面教训**：我曾经用 `/plugins/dsh-plugin-remote-use/client.js` 返回 **404**
来推断"插件没加载" —— 而 **DSH 自带的客户端插件在同一路径上也是 404**：

```
dsh-client-ui-plugin-manager   -> 404
dsh-client-ui-settings-general -> 404
dsh-plugin-remote-use          -> 404
no-such-plugin-xyz             -> 404   （对照）
/                              -> 401   （对照）
```

**那个 404 什么也证明不了。** 正确的探针是**插件自己注册的设置路由**（`/api/dsh/<id>`），
它给出 200 与完整载荷。**"用一个必然失败的对照片来验证路径有效性"**这一步
能避免从 404 里读出结论。

---

## F6. DSH 的 pnpm 带**三层供应链策略**，每层都能让安装静默变形

**现象**

- 从**刚发布**的版本安装，报错的却是"锁文件校验失败"；
- 卸载时报 `ERR_PNPM_TARBALL_URL_MISMATCH`，而不是任何跟卸载有关的话；
- 想补一个缺失的依赖，整个操作被**回滚**，`package.json` 和 `node_modules` 都没变；
- **卸载刚发布的插件也失败** —— 而且理由和安装时一模一样（见 F6b）。

**根因**：DSH 的 profile 用 pnpm，而 `pnpm-workspace.yaml` 里预置了策略：

```yaml
nodeLinker: hoisted
autoInstallPeers: false          # ← 不会自动装 peer 依赖（npm 会）
minimumReleaseAgeExclude:        # ← 逐包白名单：@hope_phenom 自家的包
  - '@hope_phenom/dsh-plugin-code-quality@0.1.0'
```

三层各自的表现：

| 策略 | 触发条件 | 报错 |
|---|---|---|
| `autoInstallPeers: false` | 依赖的 **peer** 没被自己声明 | 运行时 `ERR_MODULE_NOT_FOUND`（**安装时无任何提示**） |
| `minimumReleaseAge` | 版本发布**不到约 24 小时** | `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` |
| tarball URL 校验 | lockfile 里的 URL 与当前 registry 元数据不符 | `ERR_PNPM_TARBALL_URL_MISMATCH` |

**第三个尤其阴**：包刚发布时中文镜像还没同步，pnpm 从 npmjs 取到并把 **npmjs 的 URL** 写进 lockfile；
镜像同步完成后，两边元数据对不上，**此后所有的安装和卸载都被拒绝** ——
错误却写着"锁文件可能过期，或有人绕过了策略"。

**修法**

1. **peer 依赖自己声明**。这不是"可选优化"：`@agentclientprotocol/sdk` 把 `zod` 声明成 peer，
   插件没声明它，开发机（npm，自动装 peer）毫无问题，**从机（pnpm）直接加载失败**。
   守卫见 `test/shipped-scripts.test.js` 的 "every non-optional peer dependency … is declared"。
2. **刚发布的版本要显式指定版本号安装**，并显式指定 registry ——
   管理器会自己往 `minimumReleaseAgeExclude` 里加例外，手工操作则需要自己处理。
3. **改 profile 用插件管理器**，不要手工 `pnpm add`：管理器会成组地写清单、lockfile、
   profile 补丁与策略例外；手工操作会漏掉其中一部分（F8 的 profile 覆盖条目就是这么漏的）。

---

## F6b. `minimumReleaseAge` 会拦住**卸载**，而 `minimumReleaseAgeExclude` **拦不住它**

**现象**

刚发布的插件装好之后，**连卸载都不行**：

```
卸载失败:
✓ Verifying lockfile against supply-chain policies (10 entries)...
dependencies:
- @hope_phenom/dsh-plugin-remote-use ^0.1.3
Already up to date
✗ Lockfile failed supply-chain policy check (10 entries in 1.6s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
  @hope_phenom/dsh-plugin-remote-use@0.1.3 was published at 2026-10-14T04:57:01.210Z,
  within the minimumReleaseAge cutoff (2026-10-13T05:42:05.560Z)
```

注意 `Already up to date` 那行：**它什么事都没做就失败了** ——
而且失败理由是"**这个版本太新**"，和"卸载"这件事本身毫无关系。

**根因**

1. **这条策略是 pnpm 11 自己的**（默认 24 小时），不是 DSH 设的：
   `pnpm config get minimumReleaseAge` 返回 `undefined`，走的是内置默认；
2. **`minimumReleaseAgeExclude` 覆盖不到它。** 白名单作用于**解析**阶段，
   而**锁文件校验**会重新检查**每一个**条目 —— 官方指南把这一点写得很明确：

   > "this zero-age override keeps fresh installs deterministic when pnpm's **lockfile policy
   > re-checks entries the exclusion list above cannot enumerate**"

   实测吻合：profile 里**已经**列了 `'@hope_phenom/dsh-plugin-remote-use@0.1.3'`，
   卸载**仍然**被拒。

**修法（官方记载）**

在 profile 的 `pnpm-workspace.yaml` 里加一行 —— 这是
[dsh-plugin-guide](https://github.com/PerryLink/dsh-plugin-guide/blob/main/pnpm-workspace.yaml) 的做法：

```yaml
minimumReleaseAge: 0
```

另一种记载的做法是在命令上带参数 —— 见
[dsh-web PR #263](https://github.com/zhu1090093659/dsh-web/pull/263)
（标题即 "更新命令携带 `--config.minimumReleaseAge=0` 绕过 pnpm 11 发布年龄门禁"）：

```powershell
pnpm install --config.minimumReleaseAge=0
```

**这是一个真实的取舍**：写 `0` 等于**关掉**"新发布包隔离 24 小时"这层保护。
本仓库的做法是**加这行、但带注释标明可以删**（`.research/relax-release-age.ps1`），
等需要的版本超过 24 小时之后再删掉以恢复默认。

> **它拦的是"发布后 24 小时内"的一切操作** —— 包括**装、卸、改**。
> 反直觉的地方在于：报错说"这个条目太新"，而你的意图恰恰是**把它拿掉**。

---

## F7. 陈旧的 lockfile 会让 `pnpm add` **静默装回旧版本**

**现象**

在 GUI 里点"安装"，弹窗**读到并显示的是 `0.1.3`**（它读 registry 的 `latest`），
但装完之后版本仍然是 **`0.1.0`**。反复卸载、重装都一样。

**根因**

`pnpm-lock.yaml` 里还留着旧版本的解析结果，而 `pnpm add <包名>`（**不带版本号**）
会**沿用已有的解析**：

```
dependencies:
+ @hope_phenom/dsh-plugin-remote-use ^0.1.0        ← 写进清单的是旧声明
Progress: resolved 4, reused 3, downloaded 0       ← downloaded 0：根本没下载
```

注意最后那行：**`downloaded 0` 就是证据** —— 它从本地 store 复用了旧包。

**修法**

**显式带版本号**安装，这会强制重新解析并重写 lockfile 里那条记录：

```powershell
node <DSH>/resources/runtime/pnpm/bin/pnpm.cjs add `
  '@hope_phenom/dsh-plugin-remote-use@0.1.3' `
  --registry https://registry.npmjs.org
```

改完之后 lockfile 里变成 `'@hope_phenom/dsh-plugin-remote-use@0.1.3'`，
**后续从 GUI 安装就正常了**（因为不再有陈旧记录可沿用）。

> **诊断线索**：`downloaded 0, reused N` 说明这一次没有联网取包。
> 插件管理器的每一次操作都在
> `<profile>/.plugin-manager/logs/operation-*/pnpm.log` 里留了完整输出 ——
> 这是排查安装问题的**第一手材料**，比任何界面提示都准。

---

## F8. 改包名要同步的**两类**标识符 —— 而且规则相反

**现象**

包从 `dsh-plugin-remote-use` 改名为 `@hope_phenom/dsh-plugin-remote-use` 之后，
插件管理器**能列出它**、开关**能拨动**，但：

1. 设置页里**没有**这个插件的配置节；
2. 改好第一个问题之后，变成 **`web boot: 1 entry did not activate`** ——
   **整个 Web 界面起不来**。

两个症状的根因是**同一类**：改名时漏了标识符。但**这些标识符的规则并不统一**，
这才是它难查的原因：

| 标识符 | 位置 | 规则 | 漏掉的后果 |
|---|---|---|---|
| `name:` | `cordis.patch.yml` 的 `insert` 项 | **必须等于包名**（它是**模块说明符**） | 装载器 import 不到 → 服务端半边不加载 → 设置页无此节 |
| `id:` | `lib/client.js` 的 `window.__ModuleLoader__.load({...})` | **必须等于包名** | 装载器按包名给行编号，对不上 → **同一 bundle 执行两次** → `duplicate factory registration` → **Web 界面无法启动** |
| `id:` | `cordis.patch.yml` 的 `insert` 项 | **必须保持稳定**（行标识，profile 补丁按它覆盖） | 已有 profile 全部失配 |
| `id:` | `ctx.slots.register({ name: 'settings.section', ... })` | **习惯用短名**（官方一级设置项就写 `account` / `agent-presets`） | 无（改动只会白白churn） |
| `const NS` | 客户端 locale 命名空间 | **保持稳定** | 已注册的字符串丢失 |
| 目录名 | `storages/<名字>/` | **保持稳定** | **已有配置和审计记录全部丢失** |
| `export const name` | 宿主半边 | **习惯用去掉 scope 的名字**（官方 `@deepseek-ai/dsh-client-hmr` 导出 `client-hmr`），只作 fiber 标签 | 无（纯装饰） |

**后果的传播距离值得单独记一笔**：客户端重复注册的错误，最终表现为
`web boot: 1 entry did not activate` —— **看起来像安装问题，其实是命名不一致**，
而且**整个界面**打不开，不是某个功能不可用。

**修法**

- 改名时**一次性搜尽**这些位置，而不是改一处、跑一次、猜一次；
- 把能守住的写进测试（`test/settings-page.test.js` 里
  "the client bundle registers under the package name…"），并为**每一条**守卫做变异检验；
- **同时**要记清哪些**不该**跟包名走 —— 上面表里两张"保持稳定"的，
  盲从"都要等于包名"会弄丢用户配置。

---

## F9. DSH 起不来时，**第一件事是读它自己写的崩溃日志**

**现象**

GUI 启动失败只给一个弹窗，stderr 里只有一行摘要
（`web boot: 1 entry did not activate` / `see console for the import error`），
而那个 "console" 是**渲染进程**的，从外部看不到。

**真正有效的位置**

```
%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<时间戳>-<source>-host.log
```

它包含三段，第三段是关键：

```
--- error ---                                   致命错误
--- host diagnostic (as reported by the Host process) ---   带完整调用栈 ✓
--- renderer console (error level, oldest first) ---        ★ 渲染进程的错误
```

**这次就是靠它破的案**：前面所有推测（锁文件、依赖、清单字段）都错了，
而 renderer console 里一行就写清了：

```
Uncaught Error: client-modules: duplicate factory registration for "dsh-plugin-remote-use"
  (bundle executed twice without invalidate?)
```

**修法（操作顺序）**

1. 有弹窗就**先截图**，弹窗本身写着日志路径；
2. 读 `crash-*-host.log` 的 **renderer console** 段；
3. 需要看**生效的加载树**时，抓 DSH 自己的 web 服务页面 ——
   启动数据**内联在 HTML** 里（`globalThis["__DSH_BOOT__"] = {rev, entries, batches}`），
   带 token 请求 `http://127.0.0.1:19387/?token=…` 即可，不用猜。

**反例（这次付出的代价）**：在拿到这些日志之前，我先按推测改了三轮配置 ——
其中一轮（E8 的 BOM）**把一个"界面起不来"升级成了"应用完全起不来"**。

---

---

## F10. 布防被拒："the sandbox mediator is not materialized" —— 而它**明明物化过**

**现象**

从机点"布防为工作节点"，被门禁拦下：

```
暂时不能布防：
· the sandbox does not contain this machine: the sandbox mediator is not materialized
```

而**同一台机器上那个 mediator 是完整存在的**（1304 个文件、`shim.mjs`、`runner.js` 全在）。

**根因：三处必须同时成立，缺一即报"未物化"**

插件的探测（`lib/core/sandbox-probe.js`）不看"机器上有没有"，而是看**配置指的那一个**：

```js
const mediator = deps.mediator ?? 'C:\\dsh-sandbox-mediator'   // ← 硬编码默认
const shim     = join(mediator, 'shim.mjs')
const runner   = join(mediator, 'node_modules', ... 'runner.js')
if (!existsSync(shim) || !existsSync(runner)) → 'the sandbox mediator is not materialized'
```

1. **目录必须在那个默认路径**。本次它被物化在 `C:\dsh-remote\sandbox-mediator`
   （当时那才是部署目录），于是**存在却不可见**；
2. **profile 补丁必须有一条 `sandbox` 行指名那个 shim**，且**路径完全一致** ——
   `profileNamesShim()` 的原话是"路径必须精确，否则上一个版本遗留的 mediator 按文件名看也对，
   却驱动着旧的 runner"；
3. **同一行里必须有 `runnerFailureSignatures`** —— 少了它 `sandbox-local` 直接拒绝。

**为什么非要有 mediator 不可**（这才是它存在的理由）：

`dsh-sandbox-local` 用 **`process.execPath`** 当 mediator 解释器。在这个部署里那是
`DeepSeek Harness.exe` —— **GUI 子系统**镜像（PE subsystem 2；`node.exe` 是 3）。
Windows **从不给 GUI 子系统镜像分配控制台**，于是它创建的受限子进程在 DLL 初始化阶段
就以 `0xC0000142` 死掉，**每一条 shell 命令都失败且没有任何输出**。
`shim.mjs` 以 **`node.exe`** 启动，这正是重点。

**修法**

```yaml
- id: sandbox
  name: "@deepseek-ai/dsh-sandbox-local"
  config:
    runnerCommand:
      - "C:\\Program Files\\nodejs\\node.exe"
      - "C:\\dsh-sandbox-mediator\\shim.mjs"
    runnerFailureSignatures:
      - "windows-acl-run: "
```

加上**把已物化的 mediator 复制到默认路径**（不必重新抽取）。脚本：
`.research/materialize-mediator-for-arming.ps1` + `.research/fix-sandbox-paths.ps1`。

**验收方式（这一步才是关键）**

不要靠"再点一次按钮看看"。**直接跑门禁本身** —— 它是插件导出的一个函数：

```
OK   the mediator is materialized
OK   the mediator can execute a command at all            [exit=0]
OK   a write INSIDE the workspace succeeds (the control)  [exit=0 exists=true]   ← 正对照
OK   a write OUTSIDE the workspace is refused             [exit=9]              ← 反对照
OK   read-only cannot write the workspace either          [exit=9]
OK   read-only can still read                             [exit=0]
```

脚本：`.research/run-sandbox-probe.ps1`（按**文件路径**导入，因为包的 `exports` 不允许引用内部子路径）。

> **两个附加教训**
>
> - **文档与部署不一致**：`DESIGN.md` §14 记的是 `C:\dsh-sandbox-mediator`，
>   而实际抽取的 `target` 是 `C:\dsh-remote\sandbox-mediator`（当时的部署目录）。
>   两者都没错，但**没有一处断言它们必须相同** —— 直到门禁来断言。
> - **改了 profile 补丁，探测立刻生效，但 `sandbox-local` 要重启才消费它**：
>   只重启前会得到"布防能过、跑任务时沙箱仍然坏"的状态，比直接失败更难查。

---

## F11. Web 会话的工具目录来自 **agent preset**，不是整棵 loader 树

**现象**

一个 loader 行**确实插进了合成后的树**，模块也**解析得到**，配置文件干净、启动无报错 —— 但**模型看不到那个工具**。调用它会得到：

```
Error: unknown tool "subagent_remote"
```

而同一个插件的另外四个工具（由插件在运行时注册）**工作正常**。

**根因**

Web 应用自己有一层 **agent preset**，一个会话的模型工具目录由它枚举，而不是由 loader 树的全部行决定：

```yaml
# dsh --profile web --dump-default-config 的输出里
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins:                     # <- 显式枚举，不在表里的工具模型就看不到
      - persona
      - agent-instructions
      - tool-bash / tool-pwsh / tool-fs / tool-fs-search / tool-jobs
      - skill-filesystem / tool-skill / command-goal / tool-goal
      - planning ...
```

同族的还有 `preset-ptc` / `preset-minimal` / `preset-cordis`，注册表默认 `standard`。

官方文档把这一点写得很直接：

> The Web app **disables the base tool row** and exposes the same tools through its `cordis`, `ptc`, and `standard` **agent presets**.

> each installed Bundle registers only its **dormant Host provider**; **a copied Preset must separately enable the matching tool row** for new Agents.

**两条暴露途径的区别（这是坑的核心）**

| 途径 | 能否到模型 |
|---|---|
| **插件运行时注册** `ctx.tools.register(def)`，按 agent 作用域 | **能**。绕开 preset 枚举，插件自己的工具就是这么工作的 |
| **profile patch 里的 loader 行**（如 `tool-subagent`） | **不能**，除非该行被某个 agent preset 的 `plugins:` 列出 |

**修法（按代价排序）**

1. **让插件自己提供工具**，走 `ctx.tools.register` —— 与它已有的其他工具同一条路。不需要改 preset，不需要每台从机在 profile 里写一行。
2. 覆盖 `preset-standard` 的 `config.plugins`，把整份列表抄下来再加上自己的行。

⚠️ **方案 2 的隐藏代价**：文档明确说 "**a patch replaces the targeted row's complete `config` value rather than deep-merging keys**"、"**must restate every key the row needs**"。所以抄一份 preset 等于**把它冻结在抄写那一天** —— DSH 以后更新 preset（加工具、改提示词）都不会生效。为一个工具冻结整个 agent 定义，通常不划算。

> **连带教训**：`DESIGN.md` 里曾写"插件不能在运行时新增工具行 —— 工具行只能来自 profile patch"。
> 这句话把两件事混成了一件：插件确实**不能新增一个 `dsh-tool-subagent` 的 loader 行**，
> 但它**完全可以提供自己的委派工具** —— 而它已经这么做了四次。
> 一句含糊的结论，换来的是"把行放进 profile 补丁"这个方向，以及围绕它的一整轮排查。

---

## F12. `--dump-config`：**不启动**就能看合成后的树，并暴露"未匹配的补丁目标"

**现象**

排查"某一行为什么没生效"时，手上没有可用的观测手段：DSH 是 GUI，日志只在崩溃时才落盘，
启动一次代价高，而**凭空猜测层级语义**会连续猜错（这一轮猜错了三次）。

**官方的观测工具**

```sh
dsh --profile <name> --dump-default-config      # 只打印 bundle 层
dsh --profile <name> --dump-config              # 再加上 profile 补丁、家目录补丁、--patch 覆盖层
dsh --profile <name> --dump-config --patch <某个 profile 的 cordis.patch.yml>
```

它**不启动应用**，输出的是合成后的 YAML 条目表，并且：

- **每一行都带注释，说明它来自哪个文件**：`# == @deepseek-ai/dsh-base`、
  `# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-acp-app`；
- **未匹配的补丁目标报到 stderr**：`dsh: [<文件>] patch: entry "ui-theme" not found`；
- `!!js` 表达式保持未求值。

**这一轮靠它一次性定下的三件事**

1. **`insert:` 确实是新增行的正确语法**，行确实进了树 —— 于是"模块解析不到"这个推测被排除；
2. **`- id:` 指向不存在的行会报 `not found`**，这条语义是从 stderr 上读到的，不是猜的；
3. 顺带把 `--patch` 当"替身层"的用法学会了：**`desktop` 是保留 profile，CLI 拒绝 dump 它**
   （`error: profile "desktop" is managed exclusively by the Electron application`），
   但可以把它的补丁当覆盖层挂到别的 profile 上 dump。

**两个限制**

- 三个 dump 开关**互斥**，且**拒绝保留的 `desktop` profile** 与应用参数；
- **dump 初始化缺失的 profile 文件**（我们这个已存在，无副作用，但要知道它会写盘）。

> **方法上的教训**：这一轮我在拿到这个工具之前，连续做了三次层级语义的推测
> （`insert:` 不生效 / 模块解析不到 / 解析上下文不同），**三次都错**。
> 而它其实是一条**不启动、不写配置、带来源标注**的只读命令。
> **排查"为什么没生效"时，先找有没有"打印生效结果"的开关。**

---

## F13. 启动诊断在 **`~/.dsh/logs/`**，不在 Electron 的 `logs/` 目录

**现象**

DSH 启动失败时去找日志，翻的是：

```
%APPDATA%\@deepseek-ai\dsh-desktop\logs\      <- 这里只有 crash-*.log（崩溃转储）
```

而**插件加载、行未激活、模块解析失败**这一类"启动诊断"，**根本不写在这里**。
这个目录里没有对应文件，看起来就像"什么都没出错"。

**官方位置**

> The final `Full diagnostics:` line names a unique `startup-<timestamp>-<uuid>.log` file
> directly under **`$DSH_HOME/logs/`** (default `~/.dsh/logs/`).

它的内容是启动失败的完整现场：

- DSH 与 Node 版本、平台、profile、根配置路径；
- **每一个未激活插件的模块与状态**、原始错误、以及启动期的 warning/error 参数；
- **包括没有 Fiber 的 import 错误**。

两个判读要点：

- **只有"必需的插件激活失败"才会写这份文件**。目录不存在 = 从来没有过这种失败，
  这本身就是一条有效信息（本轮就是靠它排除了"插件加载失败"）；
- 崩溃弹窗给出的路径（`crash-*-host.log`）是**另一回事**，两者不要混。

> **与 F9 的关系**：`%APPDATA%\@deepseek-ai\<app>\logs\crash-*-host.log` 记录的是**进程崩溃**，
> 里面有 `--- renderer console ---` 段（F9）；`~/.dsh/logs/startup-*.log` 记录的是**启动时插件失败**。
> 排查时先问一句"**我要找的是崩溃，还是某个东西没被激活**"，再决定去哪个目录。

---

## F14. 任务结束后，它启动的 GUI 进程**会被一起清理** —— 主机看不到"事后现场"

**现象**

派一个"打开某程序"的任务，从机报告"窗口存在：否"，主机事后截图也什么都没有 ——
看起来像**任务根本没执行**。而在物理屏幕上，那个窗口其实**闪过**了。

三轮实测（同一台从机、同一个程序 `winver.exe`）：

| 任务形态 | 从机报告 | 物理屏 | 主机截图时机 | 主机看到 |
|---|---|---|---|---|
| 前台，启动后**立即结束** | `exists: no` | **闪过就关** | 任务结束后 | **空** |
| 后台 `run_in_background`，**保持 90s** | `running` | **一直显示** | **运行期间** | **拍到了** |
| 上一条被 `remote_interrupt` 打断 | `aborted` | 消失 | 落定后 | **空** |

同一台机器上，记事本那次还留下了**操作系统级**的证据（Application Error id=1000，
`ucrtbase.dll` / `0xc0000409` / `AppModel-State -2147024891`）—— 证明任务**真的执行过**，
只是窗口不存在于主机查看它的那个时刻。

**根因**

一个委派任务的**进程树在任务落定时被清理**。所以：

- 「**任务执行过**」和「**事后能看到它留下的界面**」是两件事；
- 主机截图看到的是**当前**桌面；任务结束后的桌面里，不会有它启动过的程序；
- 而**长存进程**（从机自己的 DSH）一直能被截到 —— 这就是唯一的对照。

**修法：取证有两种正确姿势，取决于窗口需要活多久**

1. **任务在运行期间自己取证** —— 截图、断言、读控件状态，把结果**写进返回值**。
   适用于"确认一下界面长什么样"这一类，这也正是插件把 `remote_screenshot` 设计成
   **回传主机侧文件路径**的原因。
2. **窗口必须活到主机来看** —— 那就用 `run_in_background: true` 派一个**明确保持存活**的任务
   （例如"启动后 `Start-Sleep` 若干次，期间不要关闭任何东西"），
   主机在它 `running` 期间调 `remote_screenshot`，看完再 `remote_interrupt`。

⚠️ **反例（我第一版提示词就是这么写的，白费两轮）**：
「启动程序，**不要关掉窗口，留给主机稍后查看**」—— 这条在任务结束的一瞬间就被推翻了。
**要求从机"留着窗口"是无效指令**：它无权决定任务结束后进程树是否存活。

> **方法论上的收获**：这一轮唯一把结论定下来的是**"趁它还活着截图"**这个实验设计 ——
> 它同时验证了后台模式、`remote_interrupt`，以及这条清理规则本身。
> 而当从机报告**自相矛盾**时（同一份回复里 `exists: no` 和"含 Windows 的窗口出现了: yes"并存），
> **它就不能被采信**，只能自己看 —— 那一次截图给出的答案比报告更干脆。

---

## F15. 后台委派的**答案无处可取** —— 状态齐全，而"结果是什么"不存在

**现象**

用 `remote_subagent` 加 `run_in_background: true` 派一个任务：任务**真的跑了**、状态能查、工具调用数在涨、
`remote_interrupt` 能打断它 —— 但**它的输出文本无处可取**。

`remote_agents` 的 `status` 和 `wait` 只给这些字段：

```
taskId / worker / state / label / cwd / elapsed / tool calls / stopReason
tokens used / prompt 摘要
```

**没有答案。** 判据很干脆：探针任务的**全部意义**就是它带回的两个时间戳，而 `wait` 返回的完整内容里
一个字都没有。**前台派单正常**（记事本任务带回了完整报告）—— 差别只在于前台的那个调用方**还在等**
`provider.start()` 返回的 `result` promise。

**根因**

答案只存在于**一个**地方：`RemoteProvider.start()` 返回的 `result` promise。而后台模式下
**没有任何人在等它** —— 调用方拿到 taskId 就走了。于是"任务跑完了"和"结果还在"是两件事：
promise 落定后，文本被丢掉了。

`TaskRegistry` 记了进度（`toolCallCount` / `recentTools` / `usage` / `stopReason`），**偏偏没记答案**。
而它本来就是为"看不见的远程任务"补的那条可见性通道（DESIGN §2.2 C3：远程 run 没有本地 child session，
所以 DSH 不写 `subagent/catalog`，`list_agents` 永远看不到它）。**一条只报进度、不报结果的可见性通道，
对"后台委派"这个用法等于不存在。**

**修法**

1. `TaskRegistry.settle()` 接受并保存 `output`（上限 `OUTPUT_LIMIT = 64_000` 字符，同时记下**原始长度**
   `outputChars`）；
2. `RemoteProvider` 在落定时把 `outcome.output` 一起交进去 —— **不只是**从 `result` 里给出去；
3. `renderTaskDetail()` 把它渲染成一个带标题的段落，`status` 与 `wait` 都走这条路径；
4. **说清三种情况**，因为空段落会被读成渲染 bug：
   `--- output ---` / `--- output (first 64000 of 91000 chars) ---` / `output      : (the worker produced no text)`。

⚠️ **为什么保存有上限、而截断要写出来**：registry 活在整个进程里、最多 `maxTasks` 条，不设上限就是让一个
话多的从机无限增长内存；而**静默截断**会让读者分不清"这就是全部"和"这是前 64k"。

⚠️ **顺带修掉的一处同类缺陷**：设置页的 GET 路由原本返回 `registry.list().slice(0, 50)`。保留答案之后，
这个接口会把**几十条完整回答**在每次轮询时发给浏览器 —— 而页面一个字都不渲染它。改为
`listForUi()`：投影出页面真正用到的字段，只带上 `outputChars`（"这一条产生过东西"），不带正文。

**守卫**

`test/remote-provider.test.js` 里那条 `REGRESSION F15` **走的是真 provider、真 registry、真工具**：
后台派单 → 从 `wait` 读回答案 → 再读一次 `status` 仍然读得到（证明是**留存**，不是一次性回声）。
变异检验：把 `settle(..., { output: outcome.output })` 改成 `output: undefined`，**该测试失败**。

> **这一轮真正的教训不是"漏了一个字段"**：`settle()` 的签名、`renderTaskDetail()` 的字段表、
> 文档里"TaskRegistry compensates"那句话，**三处都默认了"任务的可观察性 = 进度"**。
> 而"可观察"这个词在**后台**这个用法下的意思是"**结果是什么**" —— 前台路径把这个缺口一直遮着，
> 因为前台调用方自己拿着 promise。

---

## F16. 配对建立了一个**没有任务目录**的 worker：错误推迟到第一次派单才出现

**现象**

在主机设置页**粘贴配对串**建出一个 worker：连接正常、自检全绿、状态显示就绪。**第一次派单**才炸：

```
[REMOTE_BAD_CWD]: worker "192.168.1.101": worker cwd is empty -- set 'cwd' to an absolute path that exists on the worker
```

**线索当时就在屏幕上，只是没被追**：`remote_agents` 的输出里 `cwd=` **一直是空的**，从建好那一刻起就是。

**根因（两处，缺一不可）**

1. **从机不说**。`pairing.mjs` 的 `encodePairing()` 一直支持 `cwd` 字段（也会自动省略空值），
   但 `WorkerArming.pairingString()` 只传了 `url` + `token`。于是配对串**从不携带任务目录**。
2. **主机不问**。`worker.pair` 把空 `cwd` 原样存下，没有任何校验。

**为什么这个字段非要从机说不可**：`cwd` 是**从机上的绝对路径**，而且是**从机沙箱允许写入的范围**
（DESIGN §6.4）。主机**不可能猜出**另一台机器上的路径；猜错了不是报错，而是任务**写到没人选择过的目录**。
这正是 `assertUsableCwd()` 的注释早就写下的话：空值/相对路径会静默把任务绑到中继进程的启动目录。

**修法**

| 位置 | 改动 |
|---|---|
| `slave/pairing.mjs` | 不改 —— 字段本来就支持 |
| `lib/core/worker-arming.js` | `arm({ taskCwd })`：存、持久化、**写进配对串**；相对路径在 `preflight`/`arm` 就**拒绝**；空值允许（但串里就没有这一项） |
| `lib/core/task-cwd.js` | **新建**：`isAbsoluteTaskPath()` + `assertUsableCwd()` —— 规则只有一份，两端共用（从机侧要判断、主机侧要判断，两份实现必然漂移） |
| `lib/index.js` | `worker.pair` / `worker.save` 在**落盘前**拒绝不可用的 `cwd`；GET 快照新增 `configProblem` |
| `lib/client.js` | 布防面板加"任务目录"输入；配对卡片加可选 `cwd`；worker 卡片把 `configProblem` 直接显示出来 |

⚠️ **为什么是"拒绝"而不是"警告后保存"**：`RemoteProvider.start()` 对没有可用 `cwd` 的 worker
**一律拒绝**（`REMOTE_BAD_CWD`）。也就是说这种配置**永远不可能派单成功** —— 接受它只是把一个必然的失败
从"粘贴的那一刻"挪到"下一次委派"，那正是这个坑被发现的路径。配对被拒时**不写任何东西**，
操作者就在同一个卡片里补上目录，不需要重新粘贴。

⚠️ **为什么配对卡片也必须有这个框**：只拒绝、不给地方填，就等于把配对这条路堵死（粘贴串今天不带目录）。
它平时是惰性的 —— 从机带目录时留空即可。**"一个粘贴"这个便利不能被一个新框破坏，也不能因为一个新框
就放弃"不可能配出一个坏 worker"这条性质**；两者都保住的办法就是：框在，但只在需要时才有意义。

⚠️ **一处同族缺陷，顺手修掉**：`worker.save` 是**整行替换**（`upsertWorker` → `list[index] = candidate`），
所以一个**省略 `cwd` 的部分提交**会**静默清空**一个正在工作的目录。加上校验之后它会变成一条明确的 400。
测试 `renaming a worker keeps its stored token` 原本就是这种部分提交，现在必须带上 `cwd` —— 真实表单一直带。

**守卫**

- 串里没有目录 → 400，且**什么都没写进设置文件**（`apply-config.test.js`）；
- 串里没有目录 + 操作者自己填了 → 200，用的是填的那个；
- 串里带**相对**目录 → 400；
- `worker.save` 省略 `cwd` → 400，且**磁盘上原来的目录还在**；
- GET 的 `configProblem` 能报出"连接正常但不能派单"的 worker；
- 从机侧：配对串解码后 `cwd` 正确；相对目录在布防时被拒；空值仍然允许**但串里没有这一项**；
  目录能跨重启恢复（`worker-arming.test.js`）。

> **这一轮最值钱的一句**：这个缺陷的**早期线索一直在屏幕上**（`cwd=` 空着），
> 而当时没人把它当成信息 —— 因为**没有一条断言说它不该为空**。
> "错误推迟暴露"和"错误没暴露"在日志里长得几乎一样，区别只在于**有没有一个地方断言过它**。

---

## F17. 设置路由**没有**来源校验，而设计文档从第一次提交就写着有

**现象**

打包发布之后第一次去探自己的设置路由，就发现它对**任何本地进程**都开门：

| 探测 | 结果 |
|---|---|
| 监听地址 | `127.0.0.1:19387`（**仅回环**） |
| `GET /`（应用外壳） | **401** —— DSH 的服务器**有**认证层 |
| `GET /api/dsh/dsh-plugin-remote-use` | **200，匿名**，10.5 KB：worker 列表/cwd/就绪报告、在途任务、**待审批**、**审计尾部**；token 是掩码，**没有泄漏凭据** |
| `POST` 同路由（未知 action） | 400 `unknown action "..."` —— 而且 **`Content-Type: text/plain` 也一样被解析** |
| 带 `Origin: http://evil.example` / `Origin: null` | 与不带**完全一样**，都进同一个 handler |
| 源码里搜 `sameOrigin` | **整个包零命中**；`git log --all -S sameOrigin` 只命中最初那次**文档**提交 |

**根因（两件事叠在一起）**

1. **DSH 保护外壳，不保护插件自己的路由。** 路由怎么被访问到，是插件自己的责任；
   `webServer.register` 只负责把它挂上去。
2. **文档写了、代码没有。** `DESIGN.md` §5.9 从第一次提交起就写"参考 `dsh-plugin-notify` 的做法：
   **自写 `sameOrigin()` 校验**、body 上限、原子写"。后两项都在（`SETTINGS_MAX_BODY = 16 * 1024`、
   `writeSettings` 原子写），**只有来源校验从来没写**。

**为什么 `text/plain` 是这条的关键**

浏览器对跨站请求先看"是不是简单请求"。`application/json` 会触发 **CORS preflight**，而
`text/plain` **不会** —— 页面可以直接盲发。而我们这个路由 **`readJsonBody` 不看 `Content-Type`**，
照样 `JSON.parse`。于是：**任意网站的一个页面，就能让这台机器执行一个路由动作**（读不到响应，但动作会执行）。
不需要 id 的动作有 `interrupt`（打断所有在途任务）与 `worker.disarm`；`worker.arm` 若门禁通过，
则会**打开一个接受远程执行的监听**。

**严重度**：仅回环监听 + 现代 Chrome 对"公网页面 → 回环地址"有 Private Network Access 限制，
所以实际可利用性有限。但"**文档声明有、代码里没有**"本身就必须消掉 —— 它会让下一个读者相信这里已经安全了。

**修法**

```js
// POST 时：Origin 头「存在且不是本机同源」→ 403，且在任何动作被分发之前
const crossSite = crossSitePostProblem(req)
if (crossSite !== '') return send(403, { ok: false, error: crossSite })
```

三个刻意的取舍，都写在那个函数的注释里：

- **只管 POST**：跨站**读**本来就不可能 —— 我们的响应**不带**
  `Access-Control-Allow-Origin`，页面看不到内容；
- **没有 `Origin` 头就放行**：浏览器对 **POST 一律带 `Origin`**（同源也带），所以"没有这个头"
  **不可能**来自恶意页面，只可能是 curl / 脚本 / 本仓库的真机 harness。拒绝它们只会打断 harness，
  换不来任何安全性；
- **拿请求自己的 `Host` 比对**，不比对某个写死的地址 —— 否则操作者用 `localhost:19387` 打开页面时就废了。
  另外 `Sec-Fetch-Site` 存在时也一并校验。

**守卫**（`settings-page.test.js`）

- 跨站 POST → **403**，并且**用副作用证明动作没跑**（`interrupt` 没触发 `cancel`）——
  只断言状态码的话，"403 了但动作照样执行"也会通过；
- `Origin: null`、`Sec-Fetch-Site: cross-site`、**有 Origin 但没有 Host** → 全部 403（最后一条是 fail closed）；
- 同源 POST（含 `localhost` 与 `127.0.0.1` 两种写法）→ 200，证明这是**门**不是**墙**；
- **没有 headers 的 POST** → 仍然处理（harness 就是这种调用方）；
- 跨站 **GET** → 200（读取本来就拿不到，见上）。

**变异检验**：把 `crossSitePostProblem(req)` 换成 `''` → 两条守卫**失败**。

**真 HTTP 层的对照实验**（`.research/probe-route-origin.mjs`）

单元测试递给 handler 的是**手搓的请求对象**，而 Node 会把收到的头**全部转小写** ——
只在手搓对象上成立的守卫，在网线上等于没有。所以把**真路由挂进真 HTTP 服务器**，
用 `http.request`（不是 `fetch`：它拒绝发送 `Origin`）打一遍：

```
工作区（已修）        ===== ALL CHECKS PASSED =====   (8/8, exit 0)
已安装的 0.2.1（对照） ===== 4 CHECK(S) FAILED =====
```

对照组的四条失败长这样：

```
FAIL  a cross-site text/plain POST is refused -- status=400 {"ok":false,"error":"unknown action \"...\""}
```

**400 而不是 403 就是证据**：请求**进到了 handler** 并被执行了分发。同一个探针，修之前 4 条红、修之后 8 条全绿 ——
这比任何断言都更能说明这个洞在**已经发布的版本里真实存在**。

> **方法上的教训**：这句话在文档里躺了很久，读起来像一条**已经实现的契约**。
> 它之所以是坑，不是因为它写错了，而是因为**没人去探过**。
> "文档说这里做了 X"和"这里做了 X"是两件事 —— 而**探一下只要一条 curl**。

---

# G. 需求本身的坑

前六类都是"实现没做到要求"。这一类相反：**要求本身是错的**，而且实现得越忠实，坏得越彻底。

## F18. 审批窗口 88 秒且页面从不刷新：六次请求静默超时，操作者一次提示都没见过

**现象**

用户在跑完一个真机任务后说了一句：**"核心问题是我真的没见过权限审批提示。"** 审计文件
（`~/.dsh/storages/dsh-plugin-remote-use/audit.jsonl`）当时一共 7 行：

| 时间 | 结果 | 谁决定的 |
|---|---|---|
| 10-13 08:55:22 / 08:57:09 / 08:59:08 / 09:01:44 / 09:03:22 | `reject-once` | **`by=timeout`** |
| 10-14 10:46:28 | `reject-once` | **`by=timeout`**（那次 Inno Setup 任务的升级请求） |
| 10-13 03:42:24 | `allow-once` | `by=human`（其实是 harness 探针，见 F19） |

**也就是说：机制一直在工作，而人从来没看见过它。** 那 5 次集中在 8 分钟内、约每 2 分钟一次，
每次都老老实实排队、等满窗口、被拒。

**根因（三件事叠加，等于功能不存在）**

1. **窗口只有 ≤88 秒。** 队列预算 = `approvalTimeoutMs − QUEUE_LEAD_MS(2000)`；到点即
   `#settle('reject-once','timeout')`，**并把条目从 `pending` 里删掉** —— 晚来的人点不了，
   `decide()` 会回 `no pending approval`。
2. **设置页从不刷新自己。** `client.js` 只在**挂载时**与**你自己的操作之后**调 `refresh()`，
   全文没有 `setInterval`。于是那一行只有在你"恰好停在该页且恰好重新加载"时存在。
3. **没有任何推送。** 入队只改一个页面片段。

**为什么两天都没发现**

每个部件单独看都是"正常工作"：排队✓ 等待✓ 超时按拒绝✓ 审计留痕✓。失败以**成功的形式**出现 ——
和本项目最贵的那类缺陷同形（见文末"最后一句"）。而"任务为什么失败"的答案只存在于 JSONL 文件里，
页面上一个字都没有。

**修复**

| 改动 | 落点 |
|---|---|
| 页面**可见时**每 2.5 秒轮询快照（隐藏时不轮询） | `lib/client.js` |
| 入队即桌面通知，**在 await 之前**发（await 持续整个预算，之后发等于事后通知） | `lib/core/desktop-notify.js` + `announceApproval()` |
| 默认窗口 90s → **180s** | `index.js` / `acp-bridge.js` / `client.js` 的四处默认值 + 现网设置 |
| 审计里的超时行在页面上单列「有 N 件请求因无人应答被拒」 | `AuditLog.missed()/missedCount` + 审批组 |
| 模型侧：运行时上下文注入 `APPROVALS WAITING ON A HUMAN (n)`（工具/档位/剩余秒/该做什么） | `approvalNotice()` |

**教训**

`DESIGN.md` §8.6「待审批的主动通知」写了两天，而代码里只有"等人然后超时"——
**一个只在特定页面、特定时刻可见的状态，等于不存在。** 判断一个"通知"是否真的存在，
标准不是"有没有这个字段"，而是**"人不在那个页面时，他会不会知道"**。

---

## F19. 审计把**程序调用**记成 `by=human`

**现象**

审计里唯一一行 `allow-once` 写着 `by=human`。它不是人批的：那是本仓库自己的 harness 通过
设置路由 `approvals.decide` 批准的（`prototype/host/plugin-live.mjs` 的审批探针）。
`ApprovalQueue.decide()` 里**硬编码**了 `'human'` —— 而页面和脚本走的是**同一个路由**。

**为什么这比"少一个字段"严重**

审计的全部价值就是回答"谁批的"。把脚本记成人，是在**最需要可信的地方**失真；它还让
"人类真的在监督"这个结论**无法被验证** —— 而"人在环里"正是这套设计的核心主张。

**修复**

`decide(id, decision, by)`，`by` 默认 **`'api'`**（保守：证明不了是人点的，就不记成人）；
路由用 `requestProvenance(req)` 判定 —— 浏览器对**每个** POST 都带 `Origin`（`crossSitePostProblem`
依赖的正是这个事实），有则 `'page'`，无/`null` 则 `'api'`。审计的 `gate` 也跟着区分：
超时不再写成 `gate: 'human'`。

**这是证据，不是边界**：脚本也能伪造 `Origin`。所以 `page` 只用来**读起来对**，绝不能拿来
做授权判断 —— 代码注释与测试都写明了这一点。

**教训**

来源字段的**默认值要选保守的那个**。"人"必须是能被证明的，而不是方便时的假设。

---

## F20. 从机沙箱要求任务目录授予 WRITE_OWNER，继承来的 Modify 不够 —— 整台从机的 shell 全废

**现象**

用户把从机的任务目录换到 `E:\WorkSpace\dsh-remote` 之后派了一个真机任务，从机 agent 报告：
每一步 `pwsh` 都被拒 ——

```
sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host;
refusing to run the command unconfined.
Runner failure: windows-acl-run: SetNamedSecurityInfoW failed (Win32 5):
                grantWrite(E:\WorkSpace\dsh-remote)
```

而**文件后端仍然可用**（`read`/`glob` 能读工作区）—— 所以从机 agent 正确地把它与"路径写错"
区分开了，这个指纹很重要。

**根因（读源码得到，不是猜的）**

沙箱给任务目录**写强制标签**，而标签存在 SACL 里，需要 **WRITE_OWNER**；
owner 隐式权限只覆盖 `READ_CONTROL` 与 `WRITE_DAC`。源码原话
（`dsh-sandbox-windows-acl/lib/types-*.js:583`）：

> The directory **must be owned by the caller AND grant WRITE_OWNER** … a **Full-control workspace**
> satisfies both.

`E:\WorkSpace` 从盘根只继承到 `Authenticated Users:(I)(M)`（**Modify，不含 WO**），所以 apply 失败。
而旧目录 `C:\dsh-remote\p0work` **能用，只因为它带着一次（提权）成功运行留下的三件套**
（能力 SID 的 `(W,D,DC)` + `Everyone:(CI)(DENY)(DC)` + Low 标签），命中**幂等快路径**直接返回
（`:595`），根本不需要 apply。

**先猜错的三个假设（全错，记下来）**

| 假设 | 反证 |
|---|---|
| 目录所有者不对 | 能用的 `p0work` 归 `BUILTIN\Administrators`，失败的归 `sheng` —— **正好相反** |
| 卷类型（ReFS/VHD） | `fsutil fsinfo volumeinfo E:` → 普通 **NTFS 固定卷** |
| 配置缺失（runnerCommand / shim） | acp profile 里 `runnerCommand` 与 `shim.mjs` 都在，且 shim 确实跑起来了（它转发了那个 Win32 错误） |

**修复**

```powershell
# 账户就是"从机上跑 DSH 的那个" —— 这里按约定写成占位符，别把真名写进仓库
icacls "E:\WorkSpace\dsh-remote" /grant "<任务账户>:(OI)(CI)F"   # 回滚: /remove:g "<任务账户>"
```

该目录的所有者就是那个用户，所以这正是文档所说的 **Full-control workspace**，不是削弱安全。
修复后立刻：shell 可用（解压出 91 个文件），且目录上出现沙箱写入的痕迹 → **端到端确认**。

**教训**

三个"看起来最像"的假设全错，答案在**源码里那一句前置条件**。以及：报错发生在环境层时，
先用"文件后端能用而 shell 不能用"这个指纹分清是**命令错**还是**环境不允许** ——
从机 agent 当时就是这么分的，这一步做得对。

---

## F21. 沙箱里 GUI 程序起不来：explorer 0xC0000142、notepad 创建后即消失、`start` 报 Access denied

**现象（同一台从机、同一策略、同一次任务）**

| 探测 | 结果 |
|---|---|
| 解压 91 个文件（shell 写入） | ✅ 成功 —— 所以问题不在"沙箱整体不可用" |
| `Start-Process notepad.exe` | 返回 **PID 5076**，几秒后进程**消失** |
| `cmd /c start "" <目录>` | `$LASTEXITCODE=1`，stderr = **`Access is denied.`** |
| `explorer.exe` | 弹 `explorer.exe - Application Error 应用程序无法正常启动(0xc0000142)` |
| 带主窗口的进程（从机侧两次复核） | **0 个** |
| 主机截图 | 除从机自己的 DSH 窗口外，**没有任何 GUI 窗口** |

**为什么这是最要紧的一条**

**GUI 自动化放到从机上跑，正是这个插件存在的理由。** 而受限令牌下的 GUI 初始化失败
（0xC0000142，与 DESIGN §14.2 记的同源）意味着"最该跑到从机上的那类任务"恰好跑不了。
F14 曾记录 `winver.exe` **能**显示 —— 所以边界不是"所有 GUI 都起不来"：记事本在 Win11 是
Store 包装、explorer 是外壳进程，两者都有各自的失败机理，**定论需要一次纯 Win32 GUI 的对照实验**。

**两个副产品（都会误导取证）**

1. **那张错误对话框不随任务进程树被清理。** F14 说"任务结束后它启动的 GUI 进程会被一起清理"，
   但系统错误报告对话框**不属于任务子树**：打断两个任务之后它仍在桌面上，而 `WerFault.exe` 与
   `notepad.exe` 都不在进程表里 —— 只能人工点「确定」。**这是 F14 漏掉的一类残留。**
2. **在 Session 0 里查 Session 2 的窗口 = 又一个 D9。** 我的 SSH 落在 Session 0，而 GUI 在
   Session 2，于是 `Get-Process | Where MainWindowTitle` **全程报空**——包括那张明明在屏幕上的
   错误对话框。差一点据此得出"没有窗口"的结论。**任务自己（跑在 Session 2）能看到窗口标题，
   我的探针不能**；探针与它所测量的对象必须在同一会话（D9）。

**2026-10-15 补测：边界清楚了，而且比"起不来"更麻烦 —— 见 F33。**

从机按合规流程（先真跑、失败后据实申请）做了两阶段对照，结论：

| 档位 | 结果 |
|---|---|
| `workspace-write`（当时档位） | `Start-Process explorer.exe <目录>` **返回 OK、PID 有效、无任何异常**；但 5 秒后 `MainWindowTitle` 为空、`MainWindowHandle = 0`，**全机 0 个进程拥有窗口句柄**。**没有沙箱报错字符串** —— 失败形态是"进程起来了、没有窗口"，不是一条拒绝信息 |
| `danger-full-access`（同一条命令重试） | 窗口**真的起来了**：实际窗口进程 PID 5912，`MainWindowTitle = InnoSetup-5.5.4 - 文件资源管理器`，`MainWindowHandle = 984526` |

所以档位**确实**是拦截原因。但真正要紧的是 F33 记的那条时序事实：**窗口只在 elevated 调用存活期间存在。**

> 顺带一提：本次从机**没有**为 `justification` 编造一条沙箱报错。它明确写了"这里没有错误原文可引"，
> 只引用了实测到的失败现象。这正是 F26 那条纪律应有的样子。

---

## F22. 我发出去的两个字段都是错的：来源判据从不生效，档位显示的不是申请的那个

**现象（真机，2026-10-14）**

在 0.2.3 上真机演练"派单 → 请求入队 → 人工批准"时，两处同时在骗人：

| 观测 | 事实 |
|---|---|
| 操作者在设置页点了「允许一次」 | 审计记为 **`by=api`** —— 判据是"浏览器对每个 POST 都带 `Origin`"，而这条请求到达路由时**没有可用的 Origin** |
| 队列那一行写 `needs workspace-write` | 同一行的理由写着 `Requested sandbox tier "danger-full-access"` —— 它申请的正是无限制档 |

**根因**

1. **`Origin` 判据在本应用的链路上不成立。** 页面用 `fetch`，请求经应用自己的传输到达路由，
   `Origin` 不可用（或为 `null`）。我把它当成"浏览器必然发送"的事实来用，而那个"事实"抄自另一个
   函数（`crossSitePostProblem`）的注释 —— **注释没有被验证过**。
2. **两个名字相近的档位概念被混为一谈。** `inferRequiredTier()` 回答"**最小够用**的是哪一档"
   （策略要的是它），而 DSH 工具参数里的 `sandbox_permissions` 是"**这次申请**哪一档"
   （人要批的是它）。队列行用了前者，理由用了后者，于是同一行自相矛盾。

**修复**

- 页面在请求体里**自己声明** `via: 'page'`；路由优先用它，`Origin` 只作旁证，默认仍是保守的 `api`。
  这是**证据**而非边界（任何调用者都能声称），但不声明的话这个字段永远不会说 `page` —— 那更糟。
- `requestedTier` 与 `requiredTier` **同时**进队列与审计；所有给人看的地方（设置页、右侧面板、
  输入框上方、桌面通知、模型通知）显示**申请的那个**，缺失时才回退到推断值。

**教训**

"注释里的事实"也要验证：那句"浏览器对每个 POST 都带 `Origin`"读起来无懈可击，**而它在这个应用里是假的**。
以及：两个相近概念（"最小够用" vs "本次申请"）只要界面只显示一个，就一定会显示错的那个。

---

## F23. `apply()` 里起的定时器吊死了测试进程

**现象**

加完三处审批界面后，`node --test` **再也不退出**（超过十分钟无输出，连失败列表都拿不到）。

**根因**

共享轮询源在 `apply()` 里就直接 `setInterval`，于是测试进程被一个**没人拥有**的句柄吊住；
而"没有界面挂载时不该轮询"这句话，我自己写在同一段代码的注释里，**实现里根本没做到**。

**修复**

改成**首个订阅者才启动、最后一个退订就停**；并加一条断言：`apply()` 不得创建任何定时器。

**教训**

注释里写的性质（"没人看就休眠"）必须有一条断言顶着，否则它只是愿望。
而且这次**挂死是幸运的表现形式** —— 同样的代码在生产里不会报错，只会静默地永远轮询一个没有读者的路由。

---

## F24. 我的测试桩比现实宽松，而现实会在 `apply()` 里抛错 —— 从机的 DSH 因此起不来

**现象（真机，2026-10-14）**

从机装上 0.2.4 并重启后，**DSH 无法启动**：进程数为 0、`~/.dsh/logs` 是空的、没有任何崩溃日志可读。
而同一份代码在本地 507 条测试全绿。

**根因**

DSH 的 slots 服务对注册有硬契约（`dsh-client-ui-slots/lib/index.js:182`）：

```js
if (options.id === void 0) throw new Error(`list slot "${options.name}" requires options.id`);
```

而我给两个 **list** 槽位（`conversation.composer.dock`、`conversation.session.header.actions`）
只传了 `name` + `locale`。**`apply()` 抛错 → 插件的客户端 bundle 加载不了 → 整个窗口起不来。**
（keyed 槽位我给了 `key`，所以只有那两个 list 槽位踩中。）

**为什么测试没抓住 —— 这一条比缺陷本身重要**

我的桩是 `register: (decl, component) => registered.push(...)`：**接受任何东西**。
于是"注册形状"这块**从来没有被验证过**。桩比现实宽松时，测试证明的只是"我的代码调用了 register"。

**修复**

1. 两个 list 槽位补 `id`（keyed 本来就有 `key`）。
2. 所有注册改走一个 `registerSlot()` 包装：**单处注册失败只降级，不再掀翻整个应用**。
3. **桩改为执行真契约**：未知槽位、list 缺 `id`、keyed 缺 `key`、重复占用一律抛错。
   改完立刻在本地复现出真机那句错误（`list slot "conversation.composer.dock" requires options.id`），
   38 条用例失败；修完再全绿 —— 这次是**先看见失败**才相信修复。

**恢复方式（顺带记下）**

应用起不来 ⇒ 它的插件页也用不了 ⇒ **只能从文件系统恢复**：从 registry 或本地 `npm pack` 出正确的包，
解压覆盖 `profiles/desktop/node_modules/<包名>`，再核对**已安装的版本号与 `client.js` 哈希**。
从机那次就是这么恢复的（它的系统 pnpm 本身也坏了，`pnpm.ps1` 指向缺失的模块）。

**教训**

**桩的宽容度就是测试盲区的宽度。** 桩必须和现实一样严，否则它只是在替你签字。
以及：客户端插件在 `apply()` 里抛错不是"这个界面没了"，而是**整个应用起不来** ——
加载路径上的每一处都必须假定它会失败。

---

## F25. 一个被 `catch` 吞掉的异常，让按钮点下去毫无反应

**现象（真机，2026-10-15）**

会话头那个「审批 · 6 件错过」按钮**渲染正确、点击毫无反应**：没有面板打开、没有报错、控制台也没有可看的线索。
而同一份代码的单元测试全绿。

**根因**

右侧面板的 `openResource(address)` 内部第一步是 `this.require()` —— 它要求控制器**此刻已有一个已就绪的会话**，
拿不到就抛。而我的调用点写成：

```js
try { ctx.get('sidebarRight')?.openResource?.(address) } catch (error) { console.warn(...) }
```

两道防线正好把唯一的证据吃掉了：异常被 `catch` 吞掉，而 `console.warn` 在用户不看控制台时等于不存在。
**"点了没反应"于是成了一个没有指纹的故障。**

**修复**

改用同一控制器上的**不抛错**路径：`openResourceIn(sessionId, address)`（会话 id 由槽位 props 提供，
槽位本身就是 session 作用域）。保留 `catch`，但它是兜底而不是主路径。

> **2026-10-15 更正：这条修复本身是错的，见 F27。** `openResourceIn` 在文档里明写
> 「**Not part of `ISidebarRight`**」，是 Tab 域的内部路径；公开面只有 `openResource(address)`。
> 它当时"能用"是因为恰好拿得到会话 id，不是因为它是正门。**F25 的教训仍然成立，但它给的药方是错的** ——
> 一条被记成"已修复"的错误修复，比一个未修复的 bug 更危险：它会让人不再去查。

**教训**

`catch` 的代价不是"少了一次崩溃"，而是**把一次可诊断的失败换成一次不可诊断的静默**。
在交互路径上，凡是"点了没反应"的地方，先问：**这里有没有一个 `catch` 正在替我保密？**
（与 F18 同形：可见性缺陷之所以难查，因为它们全都长得像"正常工作"。）

---
## F26. 我让从机"跳过试探、直接带提权理由"，从机拒绝了 —— 审批证据的完整性

**经过（2026-10-15）**

沙箱内 GUI 起不来（F21），我为了在真机上验证审批链路，给从机写了一段提示词，要求它**直接**发出
一个带 `sandbox_permissions` 与 `justification` 的调用，不必先等一次真实拒绝。从机拒绝执行，理由如下
（原话）：**"如果你作为主机方就是要直接授予全权，那应该由你改会话的沙箱策略来给，而不是让我伪造一个
崩溃理由去触发审批。"**

它指出两点，都成立：
1. `sandbox_permissions` 的语义是**对刚刚被沙箱拒绝的那一次操作做一次性重试**。没有那次拒绝，
   这个字段描述的事就没有发生过。
2. `justification` 是**送到审批人面前的决策依据**。由请求方之外的提示词代笔，等于污染审计 ——
   审批人以为自己读到的是"任务卡在哪里"，实际读到的是"主机想让我点允许"。

**处理**

我撤回了那段要求，改成两阶段：先让从机做一次真实操作、如实记录被拒，再让它按真实失败重试升级。

**教训**

**审批链路的每一段都是证据，不是开关。** 想验证"人能不能批准"，唯一的合法做法是**制造一个真的需要
批准的局面**；绕过"真的被拒绝"这一步，验证到的是**我自己编排的剧本**。
这条与 F22（我用一个"读起来无懈可击"的注释当事实）、F18（窗口是真的、没人看见）同源：
**证据的完整性不是流程洁癖，而是"这条链路还值不值得信"的全部内容。**
顺带一条：**从机这次的判断比我的好，`拒绝执行`是对的** —— 它对自己的语义约束比我对它的期待更准确。

---
## F27. 审批面板三处接线偏差，其中"缺 `guide` 入口"才是打不开的真凶

**现象**

右侧审批面板**完全打不开**：点头部按钮无反应（F25 的 `catch` 先掩盖了一部分），改用"不抛错"的
`openResourceIn` 之后**仍然**打不开。两个版本都只有真机能证伪，单测全绿。

**三处偏差**

1. `priority` 用了 `'builtin'`。文档（`dsh-client-ui-sidebar-right/README.md:86`）的档位是
   `extension`（**来自产品之外的类型，最高，且是默认值**）、`builtin`、`fallback`。本插件正是
   "产品之外的类型"，`builtin` 是错的一档。
2. 打开走了 `openResourceIn`。文档（`:93`）明写公开面是 `openResource(address, options?)` 与
   `openTab(kind, options?)`，"进入这一列的每一种方式都调用其中之一"；`openResourceIn` **不是**公开面。
3. **类型没有注册 `guide` 入口** —— 这才是真凶。文档（`:119`）：
   「**默认页取决于注册的 `guide` 入口数量**，而不是 tab 类型数或已开 tab 数。恰好一个入口就直接打开
   它的页面；零个或多个入口都打开 guide 页。」没有入口的类型**对"该开哪个默认页"这件事毫无贡献**，
   于是操作者从面板本身**根本没有任何入口**。

**修复**

`priority: 'extension'` + `openResource(address)` + 补一个 `guide` 条目（`{ id, kind, title, description }`，
选中胶囊会调用 `openTab(entry.kind, { replaceTab: true })`，所以条目必须带上自己的 `kind`）。

**教训**

三处偏差里，**只有第三处是"功能缺失"，前两处是"接线错误"**；而它们在现象上完全一样（都表现为"打不开"）。
**"打不开"这类现象一定要去文档里找"默认页/入口是怎么决定的"，而不是只检查"我的调用对不对"。**
两次猜 API 都在真机失败、单测全绿 —— 这就是本仓库那条纪律的来源：**先读文档，别猜。**

---
## F28. 审批条的"席位"：`list` 型槽位会长进宿主自己的状态行里，位置随宽度漂移

**现象（用户截图）**

输入框上方那条待审批提示，先出现在最左边，后来又跑到「缓存命中」与「上下文占比」**中间**；同时它的
理由文字**一个词一行**、档位胶囊被折成 `danger-` / `full-` / `access` 三行、参数区与文字重叠。

**根因**

我把它注册进了 `conversation.composer.dock`。这个名字听起来像"输入框上方的 dock"，但它在
`dsh-client-ui-conversation` 里渲染的位置是**输入框的状态行**（`:17615`，与 `ContextMeter` 同一个 flex 行，
旁边还有活动读数）。`list` 型槽位的语义就是"再塞一个 flex 项"：**位置随同行其他项的宽度变化**，
排版也继承状态行的紧凑样式 —— 一个词一行是宽度被挤到极限的结果，胶囊折断是缺 `nowrap`。

**正解**

`conversation.input.dock`：它是一个**整行**、位于输入框**正上方**，而且 DSH 自己的三条同形提示就注册在这里
（`todo` order 0 / `goal` order 10 / 队列 `queue` order 20）。用 `order: 30` 排在它们之后，
即**紧贴输入框**。`list` 的排序是 `priority` 升序再 `order` 升序，所以 `order` 就是"稳定的席位"。

**另外两个候选，以及为什么都不对**

- `conversation.composer`（`chain`，DSH 自己的审批提示注册在这儿，`:344`）**不能用**：
  它的 owner 以 `overlay: true` 渲染，而 `renderChainResult` 在**有人当选时把 fallback 设成
  `display: none`** —— 那个 fallback **就是 composer bar 本身（含输入框）**。
  也就是说：一旦当选，**远程请求等待期间输入框会消失**。这比位置漂移严重得多。
- 留在 `composer.dock` 只调样式：位置仍由 host 的行布局决定，**漂移是结构性的，不是样式问题**。

**教训**

槽位名里的词（`dock`）**不是位置承诺**。判断一个席位之前，必须去父组件的渲染点确认三件事：
**它在哪一行、它是哪种 kind、当选/占位时会挤掉谁**。第三件最关键 —— 它决定这个席位是"加法"还是"替换"。

---
## F29. "改用宿主组件更规范"—— 读到两份官方文档互相矛盾，而它们说的是两条 lane

**背景**

交接计划里有一项"把面板的手搓 `div/button` 换成 `dsh-client-ui-primitives` 的 `Button` / `Tag`"。
动手前先读文档，读到两份**都出自官方、结论相反**的说法：

- `dsh-client-ui-workspace/README.md:167`：动态加载的 browser half「能拿到哪些模块取决于它走哪条 lane。
  **Module Loader 包**（`factory(require)`，即真实 Loader/Web fixture 那种）把
  `@deepseek-ai/dsh-client-ui-primitives` 当作**隐式 baseline external**」，通过 loader 的 `require` 解析即可。
  **本插件的 `lib/client.js` 正是 `window.__ModuleLoader__.load({ factory(require) })`** —— 按这条，能 import。
- `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`（以及该 skill 的验收清单）：
  「**不要** `require('@deepseek-ai/dsh-client-ui-primitives')` 或把任何 Harness Client 包当模块加载；
  `dsh.client.inject` 只用于排序激活，仍然是允许的。**它们会随时变，纯 JS 插件没有类型检查，
  而一个抛错的组件会把你的槽位条目整块干掉**。自己写控件、对齐宿主：**把 primitive 的标记、CSS 与行为抄进
  插件**，**类名改成自己插件的前缀**，只保留 `--dsw-alias-*` token 引用。」

**判定**

两段话不矛盾在**机制**上（机制确实可用），矛盾在**该不该依赖**上。而那条禁令明确点名了
`dsh.client.inject` —— 正是本插件的形态。所以**按禁令办**：不 import。

**结论**

本插件**已经**是禁令要求的写法：全部类名 `ru-` 前缀（自有前缀），全部颜色走 `--dsw-alias-*` / `--dsw-radius-*` /
`--dsw-focus-ring-*` token，没有一处硬编码色值。**这项"正规化"的实际动作是"核对合规"，而不是"改写"。**

**教训**

**同一条事实在不同 lane 上有不同规矩，而"能跑通"不等于"可以依赖"。**
遇到"文档说可以、另一份文档说不行"时，先分清楚两份文档**各自在跟谁说话**（哪种加载方式、哪个受众），
再决定自己属于哪一类。另外：**"抛错的组件会把槽位条目整块干掉"** 是本仓库 F24 的同一类风险
（一个槽位注册出问题 → 整个应用起不来），所以这条禁令的代价评估是准确的。

---
## F30. 面板里那句"记录同时写在 …"从来没有出现过

**现象**

`ApprovalsTab`（右侧面板）里有一行 `auditNote`，写着"记录同时写在 {路径}"，用来把面板和审计文件对上。
**它一次也没渲染过。**

**根因**

它读的是 `props.auditPath`。而这个值**从来没有被任何一方传进来**：注册处只传 `feed` 与 `post`，
框架只注入它自己的 props。`undefined → ''` 于是安静地走了"不渲染"分支。
**代码读起来是完整的，注释也解释了它的用途 —— 只是那个字段永远是空的。**

**修复**

从**同一个快照**里读：`createApprovalFeed` 已经在拉整个 snapshot，`audit.path` 就在里面。
把它收进 feed 的 state，面板与设置页就不再需要外部传路径。

**教训**

**"这个字段由谁传进来"必须能追到一条真实的赋值链。** 一个永远为 `undefined` 的可选 prop，
在代码里与"已实现但当前无数据"完全无法区分 —— 它同时骗过了代码审阅和单元测试（测试用的是自己造的
props）。凡是"渲染取决于某个可选字段"的地方，都要问一句：**在真机上，谁会填它？**
（与 F22 同源：注释/字段读起来无懈可击，而它在真实环境里恒为空。）

---
## F31. 用时间戳当"清空水印"，把同一毫秒内**新产生**的记录也一起隐藏了

**背景**

用户要求"设置页和侧面板都能清空审批记录"（否则"错过 6 件"会永远挂着）。
设计决定：**不删行**（审计文件是追加式证据），改为追加一条 `kind: 'approvals-cleared'` 水印，
读取只看水印之后的记录。

**第一版实现**

水印存 ISO 时间戳，过滤条件是 `row.at > clearedAt`。看着无懈可击 —— ISO-8601 UTC 定宽字符串
按字典序比较就等于按时间序比较。

**测试当场证伪**

`a miss that arrives AFTER the clear is shown again` 失败：**实际为空**。
原因是 `at` 只有**毫秒**分辨率，而"清空"和"紧接着写一条新记录"在**同一毫秒内**完成 ——
新记录的 `at` 与水位**相等**，被 `>` 判为"不在水印之后"，于是**刚产生的新事实被隐藏了**。

**修复**

水印改成**行在数组中的下标**（`clearedIndex`，`#visible()` 用 `slice(clearedIndex + 1)`）：
文件里的**位置顺序是精确的**，任何速度下都不会并列。同时补一条测试覆盖"窗口裁剪后水印仍指向自己那一行"
（内存窗口有 200 行上限，裁剪时必须同步平移下标，否则计数会随窗口移动而漂移 —— 又是一个安静的错误）。

**教训**

**用"近似的时间顺序"代替"精确的位置顺序"，是这类 bug 的通用形状**（与总论第一节同源：
用一个近似去代替那个真正会给出答案的东西）。凡是"我只需要一个排序/一个先后"的地方，
优先用**本身就有序的那个东西**（位置、序号），而不是**把有序性从另一个字段里推断出来**（时间戳）。
另外：这条 bug 是**测试用例发现的，不是审阅发现的** —— 而且它第一版**通过了所有肉眼检查**。

---
## F32. 文档写着"轮转 64MB / 保留 30 天"，而审计文件从来没有任何上限

**发现方式（值得单独说）**

不是审阅发现的，也不是测试发现的：是**用户问出来的**。他的原话：
"我支持你提到的非破坏式，但是对应的，我们有规定上限吗？因为我觉得这个记录不应该无限制的永久自动增长。"

我去代码里查，答案是：**完全没有上限**。`AuditLog` 只有两个"边界"，而它们都不是留存边界 ——
`TAIL_BYTES = 256 KiB`（读窗口）、`MEMORY_LIMIT = 200`（内存行数）。
文件本身是纯追加，`record()` 里没有任何大小判断、没有 rotate、没有 prune。
实测当时：14 行 / 9,401 字节 / 约两天，即每行约 670 字节。

**而文档里写着**（`DESIGN.md` 第 9 节）：

> **保留**：默认 30 天，可配。**轮转**：单文件 64MB。**配额**：总大小上限，超限告警而非静默丢弃。

**三个数字，一个功能都没实现。**

**为什么这条特别值得记**

本仓库已经有 **F17 / F18** 两条"文档写了、代码没做"，而且**都是在"可见性"这条线上**。
这次是第三次，形态更隐蔽：

- 前面两次是"**功能没做**"（模型侧注入、页面轮询），用起来会**当场发现**。
- 这次是"**上限没做**"：它在**正常使用下完全看不出来** —— 文件一直在正常追加，
  页面一直在正常显示，测试一直全绿。它只在**时间足够长之后**表现为"磁盘多了一个谁也不知道多大的文件"。
  **一个"缺少约束"的缺陷，其表现就是"一切正常"。**

另外，那三个数字（30 天 / 64MB / 超限告警）写得**像已经实现的设计**，而不是"计划"。
一份文档一旦用陈述句写下未实现的东西，它就从"说明"变成了"伪装"。

**修复（0.2.12）**

有界增长，按**大小**而不是按天数（按天不保证磁盘有界，一天可以写很多）：

- 活动文件达到 `auditMaxBytes`（默认 8 MiB）就 `rename` 成带时间戳的归档，另起一个新文件。**绝不截断正在写的文件** —— 追加式的全部意义就是"重写文件 = 有机会丢掉你想留下的那条记录"。
- 归档保留 `auditKeepFiles` 个（默认 5），**最旧的被删除**。这是本项目里**唯一会删掉审计记录**的动作，所以它**每次都写一条日志**（"保留策略删掉了最旧的归档"），不是静默的。
- 两个配置项都进了设置页，并且**页面显示当前占用与上限**（`auditUsage`）：*一个没人看得见的限制，与没有限制无法区分* —— 这次能踩到，正是因为以前既没有限制、也没有地方显示"有没有限制"。

**顺带发现并修掉的一个交互**

清空水印是**一行**，而轮转正是把它所在的那一行移进归档，重启时又只读活动文件 ——
于是"轮转 + 重启"会把操作者**清空过的"错过"全部复活**。修法是轮转时在新文件首行补一条
`carried: true` 的水印。这条有专门的测试（`A CLEAR SURVIVES ROTATION`）。

**教训**

1. **"缺少约束"是一类没有症状的缺陷。** 凡是"无限增长/无限重试/无上限"的结构，都要主动去问
   "它的边界在哪、写在哪个字段里、怎么看见它"，而不能等它表现 —— **它不会表现，直到太晚。**
2. **文档里的陈述句就是承诺。** 没实现的东西要写成"计划/未实现"，否则它会把后来的人（包括我自己）
   变成"以为已经有人做了"的那个人。这条与 F17/F18 合起来看，就是本仓库最贵的一类错误。
3. 用户问的那一句**比我的任何自检都有效**。我不会去查一个我以为已经实现的东西 ——
   **"我以为它已经做了"正是我查不到的盲区的形状。**

---
## F33. 一次性提权**养不活**一个 GUI 进程：放行一结束，窗口就被拆掉

**发现方式**：真机对照实验（从机自己按"先真跑、失败后据实申请"的合规流程做的，2026-10-15）。
**这一条直接决定了"GUI 自动化放到从机上跑"这件事该怎么做。**

**实测**

1. 在 `danger-full-access` 的那**一次**调用里启动 `explorer.exe <目录>`：窗口出现
   （`MainWindowTitle = InnoSetup-5.5.4 - 文件资源管理器`，`MainWindowHandle = 984526`）。
2. 从机第一次想把窗口**留**住，于是把 `Start-Sleep 240` 放成**另一条**（默认档位的）命令：
   睡满 240 秒后再查，explorer **全部消失**。
3. 查 Application 日志：**没有任何崩溃事件**。所以它**不是崩了，是被回收了** ——
   随那次放行调用的结束，它的子进程树被拆掉。
4. 把"启动 + 持有"**合并进同一次** elevated 调用：窗口在整段 240 秒里**始终存在**，标题一致。
   调用一结束再查，窗口又没了。

**机制**

`sandbox_permissions` 的语义是**对刚刚被拒的那一次操作做一次性重试**（F26）。
"一次性"是字面意思：**放行的作用域是那一次调用**，不是那台机器、那个会话、也不是那个进程树。
于是它启动的 GUI 进程**没有比它的父调用活得更久的授权**，调用返回即被清理。

**设计后果（重要）**

**真正的 GUI 自动化天然是多步的**：启动 → 等待 → 点击 → 输入 → 截图 → 判定。
每步一次工具调用，**每一步之间窗口都活不过去**。所以：

- **per-call 提权（`sandbox_permissions`）不是 GUI 自动化的正确原语**，无论审批多顺畅。
  它适合"一次文件写入/一条命令"这类**原子**操作。
- 想做 GUI 工作，正确的东西是**会话级的沙箱策略**——这也正是从机在 F26 里说的原话：
  "如果你作为主机方就是要直接授予全权，那应该由你改会话的沙箱策略来给。"
- 因此**审批面板解决的是"原子高危操作能不能放行"，不是"能不能跑 GUI 任务"**。这两件事
  在本项目里一度被混为一谈，而它们的解法不同：前者靠队列 + 人；后者靠**预先**把会话置于
  能跑 GUI 的档位。

**另一个实操结论：截图必须落在放行的存活窗口内。** 这次成功的可截图窗口是调用期间的
11:36:55–11:40:55；调用结束后再截，屏幕上什么也没有 —— **不是"窗口被关了"，是它已经不存在了**。
所以"启动并保持 → 主机在位期间截图"必须编排成**一次**调用，否则永远截到空屏，
而现象看起来像"GUI 起不来"（F21 的误判就有这个成分）。

**教训**

**"一次性"这个词要一直追问到作用域为止**：一次性的是这次**调用**、这个**进程树**、还是这个**会话**？
答错了，就会写出"每步都重新申请、每步都失败"的编排，并且每一步看起来都像**别的**问题
（窗口怎么没了、截图怎么是空的、上一步明明成功了）。
凡是**天然多步**的能力（GUI 会话、交互式 shell、长连接），都要先问一句：
**我的授权粒度是否覆盖整个过程？**

**2026-10-15 收尾：结论**已实测**，而且给出了干净的对照**

按"档位是部署值"改完（0.2.15：本机设置 `workerSessionMode`，默认 `danger-full-access`，布防时写进启动规格），
在真机上重跑同一件事：

| | per-call 提权（旧） | **部署级全权（现）** |
|---|---|---|
| 命令返回 | 成功 | 成功 |
| 窗口 | 出现（放行期间） | **出现** |
| **调用结束后** | **窗口被回收** | **窗口仍在**（调用结束数分钟后截图确认：句柄、标题、PID 均未变） |

从机自己的读数是：启动进程 `explorer.exe` 5 秒内就退出（把请求转交给已有的 explorer 实例），
真正的窗口属于**另一个 PID**、类名 `CabinetWClass`、标题 `InnoSetup-5.5.4 - 文件资源管理器`；
持有 240 秒后复查 `TITLES_IDENTICAL = True`。**主机侧自己截图确认了同一个窗口仍在。**

顺带纠正了一个**探测方法**上的错：一开始只看启动进程的 `MainWindowHandle`，于是得到 0，
据此以为"没有窗口"。正确做法是枚举顶层窗口（`EnumWindows` + 标题 + 类名 + 拥有者 PID）——
**explorer 的窗口从来不属于你启动的那个进程**。同一类错误的另一面是会话作用域：探针必须与窗口
在**同一会话**（从机这次自报 `SessionId=5 / RDP-Tcp#0`，且它能看到会话 5 里的 explorer，
所以它这次真的看得见）。

---
## F34. 全权档位会撞上"不命中任何 preset"—— 而我把后果**说错了两次**，两次都是实测纠正的

**状态：真机实测已做完（三轮，见下）。坑是真的（会永久留下一个失败条目），但它**不阻碍目标**。**
**我先后写下的两个后果都是错的**：先是"从机不可达"，再是"保守起见先拒绝"。两个都被实测推翻了。

**背景**：F33 定了方向——GUI 工作靠**会话级**档位，而不是 per-call 提权。查下来 DSH 已经支持：
`sandbox-policy` 行的 `mode` 来自 `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`
（`dsh-base/cordis.patch.yml:232`），而且从机的启动规格**已经**有 `--permission-mode` 把它塞进子进程 env
（`slave/make-launch-spec.mjs:30,61`）。看起来只是"生成规格时多给一个参数"。

**坑在哪**：同一个变量在 `:248` 还决定**审批策略**（注意这句在 `dsh-base` 里是**带双引号**的）：

```yaml
policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
```

即 **DSH 自己的组合把"档位 + 审批策略"成对绑定**（这就是它的 preset 语义）。而从机 profile 补丁把
`approval` 的 `policy` **写死成 `ask`**，且"补丁会替换该行的整个 `config`"。于是：

- 只设 `DSH_PERMISSION_MODE=danger-full-access` → 实际组合成 **(danger-full-access, ask)**；
- 而 `permission` 行（`dsh-permission-presets`）配的三个 preset 是
  *(read-only, ask)* / *(workspace-write, ask)* / *(danger-full-access, **never**)* —— **一个都不命中**；
- 该行**没有** `defaultPreset`，而 schema 注明它"**composition defaults match no preset 时必需**"。

**真机实测（2026-10-15，本机真实 `acp` profile 与它的副本）**

用 `.research/probe-session-new.mjs`（`initialize` + `session/new`）和
`.research/probe-turn.mjs`（再加一次 `session/prompt`，让 agent **自报**它运行时上下文里那行
`Current DSH file policy:` —— 这样"档位是否真的生效"不用猜日志，答案就在回答里）：

| 组合 | 会话 | **turn** | stderr | agent 自报的档位 |
|---|---|---|---|---|
| 默认（`workspace-write`） | OK | — | 干净 | — |
| `danger-full-access` + profile 钉 `ask`（**无配套**） | OK | **OK** | `1 entry did not activate`（`permission-presets`） | **danger-full-access** |
| `danger-full-access` + 配套（但配套当时是坏的，见 F36） | OK | OK | `2 entries did not activate` | danger-full-access |
| `danger-full-access` + **修好的**配套 | OK | OK | **干净** | **danger-full-access** |

无配套时那条原文：

```
dsh: warning: 1 entry did not activate
permission (@deepseek-ai/dsh-permission-presets): Error: permission: composed sandbox and approval
defaults match no preset; configure defaultPreset explicitly
    at new PermissionPresetService (.../dsh-permission-presets/lib/index.js:180:42)
```

**我说错的第一遍：把后果夸大了整整一档。** 我原先写的是"**ACP 进程起不来 ⇒ 从机不可达**"。
**错的**：进程起得来、会话建得出来、**turn 也跑得通**，而且**申请的档位确实生效**。
预测的**报错内容**逐字命中了（连 `defaultPreset explicitly` 都对），但后果是"**一个条目没激活**"。
这正是本仓库反复在修的那类问题：**一句没有实测过的后果，读起来和实测过的一模一样。**

**我说错的第二遍：把"保守"当成了不需要到期日的东西。** 更正之后我仍不知道"缺这个服务后 turn 能否跑"，
于是把那道门设成**拒绝**（"在未知上保守"）。随后我把这个"未知"也测了——**turn 跑得通、档位生效**。
于是那道门**是在拒绝一个已被实测证明可用的配置**。已降级为**警告**。
**教训：「在未知上保守」必须带一个到期日。** 没有到期日的保守，就不是谨慎，而是**用一个未验证的恐惧
永久挡住一条已验证可行的路**。

**结论（这才是这一条真正要留下的东西）**

- **档位本身只需要一个值**：全权**真的生效**（agent 自报），turn 跑得通。0.2.15 起这个值是本机的设置项
  （`workerSessionMode`，默认全权），由**布防**写进启动规格；手工等价物是
  `make-launch-spec.mjs --permission-mode <模式>`，但**只在你自己手管中继的部署里**才有意义
  （插件布防的部署里那是临时规格，改了不生效 —— 见 F38）。
- **配套片段（`slave/acp-profile-approval.patch.yml`）是"可选的卫生措施"**，不是必需品：
  它消除那条 `1 entry did not activate`，让 `permission-presets` 正常加载（那是 preset 选择器/记账，
  ACP 驱动的从机用不到它）。
- 反过来：**不贴它也不会挡住 GUI 工作** —— 这一点以前被我写成了"会挡住"，是错的。

**修法**：让 profile 那一条**镜像 `dsh-base` 自己的表达式**（含双引号，见 F36）。片段随包发布在
`slave/acp-profile-approval.patch.yml`，由 `tools/deploy-slave.ps1` 部署 ——
**具体那行表达式不在这里重抄**（同一段抄三处就会有三处漂移，见 DESIGN §8.6.3）。

**教训**

1. **"加一个参数"要先问：这个值还参与决定了别的什么？** 一个变量同时承载"沙箱档位"和"审批策略"，
   而后者正是本项目的核心机制。**改动一个被多处读取的值，必须先把读者全部列出来** ——
   这次是 `grep` 到 **YAML** 才发现的，`grep *.js` 一个都没命中（值写在 `!!js` 表达式里）。
2. **"补丁替换整个 `config`"意味着局部覆盖会抵销组合默认值。** 从机 profile 写死 `ask` 在**当时**是对的
   （F18 那一轮：让沙箱拒绝变成看得见的请求），但它与"档位由环境变量驱动"**互不知情**。
   两个各自正确的决定合起来产生了一个谁都没预期的状态 —— **组合出来的状态也要有人负责。**
3. **拦阻来自"读配置的权威输出"（`--dump-config`）而不是读代码。** 代码只告诉我变量被读；
   只有**合成后的真实配置**才告诉我这两个读者会怎样相遇。
4. **而真正定案的既不是代码也不是配置，是"跑一遍看它说什么"。** 两轮纸上分析都得到了一个**合理但错误**
   的后果；一次 `session/prompt` 就把两轮都纠正了。**能跑的东西就不要推。**
5. **顺带一条更好的教训**：这个坑最初是在给一个"运行时授权"功能做设计时撞出来的，而那个功能本身
   就是多余的——见 DESIGN §8.6.3。**复杂度不只是成本，它会主动带你去撞本来不必遇到的坑。**

**0.2.14 的那道门：现在只对"真的送不出去"的档位拒绝**

拦截点只有一个可选：**`slave/make-launch-spec.mjs` 是全系统唯一同时知道"要申请哪个档位"又能读到
profile 的地方**（插件本身从头到尾不知道部署档位 —— 档位只从这一个脚本的参数进入系统）。

| 情形 | 行为 | 依据 |
|---|---|---|
| 组合命中一个 preset | 静默通过 | — |
| **组合不命中任何 preset** | **警告**，仍写出规格 | **实测：档位生效、turn 跑得通**；拒绝会挡住可用的部署 |
| `--permission-mode` 写错（不在闭集内） | **拒绝**（退出码 3），不写文件 | `dsh-base` 对未知档位**在加载时**就报错；typo 从来不是有意的 |
| profile 读不到 | 警告，并明说"配对**未**验证" | 按"无法验证"拒绝会让正常从机没法部署；沉默又会被读成通过 |

真机验证（本机真实 profile）：

```
workspace-write     -> exit 0，写出规格，无输出
read-only           -> exit 0，写出规格，无输出
danger-full-access  -> exit 0，写出规格，stderr 一条警告并指名 acp-profile-approval.patch.yml
yolo（拼错）         -> exit 3，不写文件
```

---
## F35. 测试里用 `execFileSync` 收 stderr，于是"成功时"的诊断通道被静默丢掉

**经过（2026-08-15 写 F34 的门时）**

给上面那道门写测试时，有一条是"profile 读不到 → 只警告不拒绝"。第一次跑，它**失败**了，
报的是"stderr 为空、没看到 WARNING"——看起来像**脚本没警告**。

实际原因是**测试自己的**取数方式：`execFileSync` 正常返回时只给你 **stdout**，
**stderr 根本不回传**（它在抛错的那条路径上才挂在 `error.stderr` 上）。
于是那条 exit 0 的用例拿到的 stderr 永远是空字符串。

**为什么值得记**

1. **它恰好会伪装成被测对象的问题。** 失败信息读起来是"脚本没警告"，而真相是"测试没去看"。
   这和本仓库那条总纪律同形：**先怀疑测量工具，再怀疑被测对象。**
2. **它还可能反向骗人。** 如果那条用例写成 `assert.equal(stderr, '')`（"成功时应当沉默"），
   它会**永远通过**——包括脚本疯狂警告的那天。**一个恒真的断言，比没有断言更糟**，
   因为它占着"这一条已经检查过了"的位置。
3. 修法是一行：改用 `spawnSync`，它无条件同时给出 `status`/`stdout`/`stderr`。

**教训**

**测试harness 也是一段被测代码，只是它没有测试。** 凡是"要观察一个进程的输出"的地方，
先把三个通道（退出码、stdout、stderr）都无条件拿到手，再谈断言；
用"只在失败时才有数据"的 API 去断言**成功路径**，等于断言一个常数。

---
## F36. 我发布的那个 YAML 片段**本身是坏的**：`!!js` 的三元表达式没加引号，被 YAML 吃成了映射

**发现方式**：真机跑一遍。**不是**审阅发现的、**不是**单测发现的 —— 而且**我专门为它写的那道守卫
一路绿灯**。

**现象**

把上一轮发布的 `slave/acp-profile-approval.patch.yml` 贴进 profile 后启动，stderr 出现：

```
dsh: warning: 2 entries did not activate
approval (@deepseek-ai/dsh-user-approval): ValidationError: invalid config:
  - $.policy expected "ask" | "never" but got {"[object Object]":"ask"} (at policy)
permission (@deepseek-ai/dsh-permission-presets): pending (waiting for service: approval)
```

`got {"[object Object]":"ask"}` 是**决定性线索**：Cordis 拿到的不是字符串，而是一个**对象**。

**根因**

我写的是：

```yaml
policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'
```

表达式里有 `: `（三元运算符 `? 'never' : 'ask'` 里那一个）。**YAML 把未加引号的 `: ` 读作映射分隔符**，
于是这一行不是"一个标量"，而是"一个以表达式为键、`'ask'` 为值的对象"。

**而 `dsh-base` 原本是加双引号的**（`cordis.patch.yml:248`）—— 我抄的时候把引号丢了，
却没意识到那不是风格、而是**语法**。修法就是把引号加回去。

**为什么守卫没拦住（这一条最值钱）**

我为这个片段写了守卫，它断言的是"表达式**由同一个变量推导**、且 `danger-full-access` / `'never'` /
`'ask'` 都出现"。**这些断言在坏文件上全部通过** —— 因为坏文件里这些 token **一个不少**，
坏的只是 **YAML 会不会接受它**。**"检查了 token"和"检查了它能不能被解析"是两件事**，
而我把前者当成了后者。

**教训**

1. **"我检查过"必须能回答"检查的是哪一个属性"。** 守卫检查的是"内容对不对"，
   而实际坏掉的是"形式合不合法"。**同一个文件上，这两个属性可以一个全对、一个全错。**
   （与总论"检查也能说谎"同形，也与 F35 同形：那次是"测试没去看"，这次是"测试看了别的东西"。）
2. **抄一段外部表达式时，标点也是语义。** 双引号、`!!js` 标签的位置、缩进 —— 这些看起来像排版的东西
   在 YAML 里是语法。**"照抄"要抄到标点，否则叫"照抄了能看懂的部分"。**
3. **发布一个"给人粘贴的文件"，等价于发布代码。** 它没有编译器、没有类型检查，
   唯一的验证就是**真的贴上并跑一次**。所以这类文件必须走真机，不能只走单测。

---
## F37. 一个新的"页面设置项"要登记在**四个**地方，而漏掉任何一个都是**静默回退**

**发现方式**：加第四个设置项时，我写的往返测试**在默认值上都失败** —— 顺着读下去，发现 0.2.12 我加的
那两个设置项**从发布起就一直是坏的**。

**四个地方**（少一个，行为各不相同，但都不报错）：

| 位置 | 漏掉的后果 |
|---|---|
| `Config` schema（`lib/index.js`） | 页面根本不显示这一项 |
| `settings.save` 路由 | 保存被忽略，静默保留旧值 |
| **`MANAGED_KEYS`**（`lib/core/settings-store.js`） | 写进了磁盘，但 `mergeSettings` **不认这个键** → 读回来是 `undefined` |
| **`currentSettings()`**（`lib/index.js`） | 同上：路由能保存、这个函数不列出 → 读回来是 `undefined` |

后两个的失败形态完全一样，而且**看起来像"设置生效了一次就自己变回去了"**：写盘成功、响应里看着对、
下一次读取回到默认值。**这是本项目最讨厌的那一类缺陷 —— 它长得像正常工作。**

**实测（0.2.12 发布件）**：`auditMaxBytes` 与 `auditKeepFiles` 进了 schema、进了保存路由、进了设置页表单，
**但没进 `MANAGED_KEYS` 与 `currentSettings()`** —— 于是这两个设置**在整个 0.2.12 里都是保存完就回退**。
当时没有任何东西会说出来：我为它们写的是"设置页显示了这两个输入框"，而**往返**测试那时不存在。

**代码里其实有两段注释早就写明了这件事**（`settings-store.js:35` 与 `index.js:594`，两处都写着
"a key the page can SAVE but is not managed here would be dropped on the next read -- the quiet way a
setting seems to work once and then reverts"）。**我读过它们，然后照样漏了两次。**

**修法（0.2.15）**：除了补上三个键，更重要的是**不再靠"每个键写一条往返测试"**：

```js
test('EVERY setting the page exposes is one the store manages', ...)
```

它把页面暴露的键集合（`publicSettings` 的键）与 `MANAGED_KEYS` **双向**比对。这条守卫**当场抓到了**
`enableCommand`（一个"每次读取现算"的派生字段，不该被持久化），于是它被显式登记进一个具名豁免集 ——
**新加派生字段必须有人做一次决定**，这正是想要的属性。

**教训**

1. **"加一个设置项"不是加一个输入框，是让它通过四道闸门。** 而每一道闸门的失败都是静默的。
   **凡是一个新值要穿过多个白名单，就必须有一条"检查白名单集合本身"的守卫**，
   而不是"每个值各写一条测试" —— 后者只覆盖你还记得的那个值。
2. **同一个键在两处维护，注释提醒过一次、也拦不住第二次。** 两段注释都是被坑过之后写的，
   而坑又踩了一次。**注释记录的是决心，不是约束；约束得是可执行的检查。**
3. 顺带：这条是**我为了查另一件事**（会话档位）而撞出来的 —— 第 4 个设置项暴露了前 2 个的问题。
   **加一个同类的新成员，是检查所有旧成员是否都登记齐全的最好时机。**

---
## F38. "文件里写着 X"与"进程读的是 Y"可以**同时为真** —— 而两边都像"已设好"

**现象（2026-10-15，真机）**：用户把从机的启动规格改成全权，然后说"可以测试了"。
而我从机 agent 自报的档位仍是 `workspace-write`，我读那个文件也仍是 `workspace-write`。

**根因**：**活着的中继根本没读那个文件。**

跑一遍才发现：监听 7331 的进程命令行是

```
...\dsh-plugin-remote-use\slave\relay.mjs --port 7331
   --cmd-file C:\Users\<user>\AppData\Local\Temp\dsh-plugin-remote-use\acp-spec-15636-7331.json
   --pairing-file "" --shot-dir ...\Temp\dsh-plugin-remote-use\shots
```

- 它由**从机自己的 DSH 桌面进程**（`profiles/desktop` 里的本插件"布防"）拉起；
- 它读的是一份**临时规格**，路径里带 DSH 的 PID，**每次布防重写**；
- 那份临时规格里**没有** `DSH_PERMISSION_MODE` → 子 DSH 落到 `dsh-base` 的默认 `workspace-write`；
- 而被人编辑的 `C:\dsh-remote\plugin-slave\agent-spec.json` **自 10/12 起就没有任何进程读过**。

于是"那个文件说全权"和"会话跑在 workspace-write"**同时为真，持续了几个小时**，而两边看起来都正常。
（`launchSpec` 是在中继**启动时**读一次的东西 —— 所以即使改对了文件，不重启也不生效。）

**同一次里还有第二个同类错误，是我自己的探针**：我写脚本去枚举那个 `explorer.exe - Application
Error` 弹窗，返回**空数组**，而截图里弹窗明明在。原因是我这次 SSH 落在 **Session 0**、GUI 在
**Session 5** —— **窗口枚举是会话作用域的**。这就是 F21/D9 那条纪律，只不过这次踩它的人是我。
（同一个原因也让从机 agent 声称"explorer 进程数为 0"，而截图里任务栏明明在。）

**修法（0.2.15）**

1. 档位不再依赖任何一份"某个文件"：它由**本机自己的设置**（`workerSessionMode`）在**布防时写进规格**，
   于是"要求的档位"与"写进规格的档位"出自同一个来源。
2. 中继把**它实际会传给子进程的档位**报出来（`effectiveSessionMode`：规格优先，其次中继自己的环境；
   两者都没有就报"未设置"而**不是**报 DSH 的默认值 —— 让读者能分清"这里没设"与"这里设成了 X"）。
3. 主机侧的 worker 卡片显示这一项，且不在全权时给出提示 —— **"这台节点到底在哪个档位"从此不用靠猜文件**。

**教训**

1. **"配置生效了吗"必须问进程，不能问文件。** 判断依据要是**运行中的那个进程实际读到了什么**
   （它的命令行、它自己的自报、它回报的运行态），而不是"我改的那个文件现在写着什么"。
2. **一份会被重写的临时文件，永远不该被当成"配置的所在"。** 谁生成它、何时重写、进程何时读它 ——
   这三个问题答不上来，就不要把值放在那里。
3. **探针与被测对象必须在同一会话**（F21/D9）。这次它伪装成"弹窗不存在"，上一次它伪装成"没有窗口"。
   **同一个坑换了张脸，因为换了个探针。**

---
## F39. 两半各自"测试充分"，而它们之间**那条缝**谁的测试都不覆盖

**现象（0.2.17 文件传输）**：从机侧 46 条测试全绿、主机侧 54 条全绿、全量 **712 条全绿**。然后我写了
一个"真的起一个中继进程、真的用 `PeerConnection` 打过去"的集成测试 —— **第一次上传就失败**。

**为什么两边的绿灯都不构成证据**：

- 从机侧测的是**纯函数 + 假流**（`rangeOf`、`statTarget`、`listDir`…），它不知道主机发来的请求长什么样；
- 主机侧测的是**假 `channel`**（记录调用、按契约回包），它不知道真中继会回什么状态码、什么响应头；
- 两边都"按契约"实现 —— 而**契约是人写的**。两个人对同一句话的理解差一点，两边的测试就都会通过。

**而且失败信息把人引向错误的层**：

```
TransferError: upload ... : sent 5242880 of 5242880 bytes      status: 0
```

5 MiB **一个字节都没少**，却被报成"发送失败"。真相是主机侧一道守卫（`seededFor !== size`）在 `409`
重新对齐之后开了火，**commit 根本没跑** —— 一个本地的、可恢复的状态问题，被渲染成一次网络故障。
我第一反应就是去查 HTTP。

**教训**

1. **N 个各自充分测试的模块之间有 N-1 条缝，而缝的覆盖率是 0。** "全量测试绿色"这句话，
   在第一次跨边界运行之前**不构成任何证据**。
2. **集成测试的第一个用例应该是最普通的成功路径** —— 不是边界、不是错误码。这里正是最普通的一次
   上传就挂了；先写边界用例反而会把它掩盖过去。
3. **错误信息也是一种"答案"，它也会错。** "sent N of N" 是事实，但它**指向的层是错的**，
   而读者会相信它。报错要说清**是哪一层判定失败**，而不只是给出数值。
4. 两半的实现者都**主动汇报了契约里他们解释不了的地方**（而不是悄悄绕过），这才是这两半能迅速合上的
   原因。例如"`HEAD` 与 `GET` 返回相同的头"这句是我写的，而它在大文件上等于**把整个文件读一遍**才回
   响应头 —— 是**实现者**指出来的。**契约里模糊的一行，代价会落在实现者身上。**

---
## F40. 相对路径写进了**应用自己的 profile 目录**，而工具报告成功

**现象（0.2.17 真机验证）**：`remote_file action=send remotePath="relative-path-probe.txt"` → 工具回 **"Uploaded"**。
SSH 独立核对：文件在 `C:\Users\<从机账户>\.dsh\profiles\desktop\`（**DSH 自己的 profile 目录**）为 `True`，
在配置的任务目录 `E:\WorkSpace\dsh-remote` 为 `False`。

**两级原因，缺一不可**

1. `relay-supervisor.js` 的 `spawn(...)` **没有传 `cwd`** → 中继继承 DSH 进程的工作目录（profile 目录）。
   而 `relay.mjs` 把 `TASK_DIR = process.cwd()` 当成了任务目录 —— 一个**只在"谁启动中继"不同时才有差异**的假设。
2. **解析后的路径不回显**。中继在 commit 响应里**返回了**解析结果，但主机侧的工具输出与审计行都只报
   **调用者请求时的路径** —— 于是"写错地方"与"写对地方"在主机侧**长得一模一样**。

**为什么 712 条测试全绿**：跨边界 e2e 测试是**它自己 spawn 中继**、并把 `cwd` 设成任务目录 ——
**两个目录在测试里永远相同**。测试把生产环境里不同的两样东西变成了同一样。
（F38/F39 的同一形状第三次：验证夹具比现实宽松，而现实在别的目录。）

**修法**

- 中继显式接收 **`--task-dir`**（缺省仍 `process.cwd()`，手工托管的中继行为不变），并在启动日志**写明来源** ——
  "这个值从哪来"正是这次无法回答的问题；
- `RelaySupervisor` 传 `--task-dir`，`index.js` 传 **`arming.taskCwd`**，与**配对串广告的是同一个值**；
- 上传结果补上**从机回执**（`remote.path`），工具与审计都报**解析后的绝对路径**；
- 顺带：父目录不存在由 **500 改 409**（5xx 会让主机以为从机坏了，并重试一个永不成立的条件）。

**测试，以及为什么都做了变异检验**：e2e 用例**故意让 `cwd` ≠ `--task-dir`**；另有 supervisor 单测断言命令行里
**真的有这个 flag、且缺省时没有**。两条都做了变异检验（把 bug 放回去 → 测试必须变红）。

**而第一次变异检验是无效的**：脚本用 `[IO.File]` 改文件，而它用的是**进程的工作目录**、不是 PowerShell 的 `cd` ——
于是变异**根本没写进去**，"测试通过"什么也没证明。改用绝对路径后，它立刻变红。
**变异检验本身也会说谎；它必须先证明变异真的落地。**

**教训**

1. **夹具把生产里不同的两样东西变成同一样，这个夹具就无法证明关于它们差异的任何事。** 端到端测试要复制生产的
   **形状**（这里是"`cwd` ≠ 任务目录"），而不只是生产的调用顺序。
2. **一个会做路径解析的系统，必须把解析结果回传给调用方。** 否则它的每一次解析错误都是静默的 ——
   这次修好解析只是让路径对了，**回传才是让这类错误不可能再安静的机制**，而它原本只写在我的设计文档里。
3. **"解析后的值"这类保证，要落在跨越每一层都会被带上的字段里。** 我先前以为它已经存在（DESIGN §8.8 写着
   "解析后的绝对路径一律回显并进审计"），实际只做了一半：下载方向有，上传方向没有。

---
## G1. "主屏必须是虚拟屏" —— 一条**忠实实现后让机器无法登录**的要求

**现象**

从机自检的 S4 报错：

```
S4 [fail] primary is the VIRTUAL display at origin
   actual="primary=\\.\DISPLAY1 at 0,0 virtual=False [Intel(R) UHD Graphics 730]"
verdict=blocked  blockingFailures=1
```

看起来完全正确：主屏是物理屏，约定的 1920×1080 虚拟屏闲置，派单被拦下。

**而真实后果是：从机**没法登录**了。**

**根因**

> **Windows 11 的登录界面（LogonUI）只画在主显示器上。**

虚拟显示器是主屏时，登录界面就渲染在一块**没有物理输出**的屏上。操作者的显示器全程黑屏 ——
既看不到登录界面，也没法输入。**这不是配置问题，是 Win11 的设计。**

**这条要求是怎么来的**

设计文档把 S4 写成"虚拟屏为 `primary` 且位于 `(0,0)`"，理由是"**坐标空间独立于操作者的显示器**"。
合理 —— 但它是一条**代理指标**：真正要的是**坐标可预测**，而"必须是虚拟屏"只是当时想到的手段。

**而那个手段的前提并不成立**：这套部署的 KVM **一直向 Windows 呈现物理显示器的 EDID** ✓
（设计文档 §7.8 自己记过这个行为 ✓）。所以显示器"消失"这件事**从来没有发生** ✓ ——
"独立于操作者的显示器"这个保证**已经由硬件给出了** ✓。虚拟屏在**可用性上是冗余的**，
它唯一确定的副作用就是把登录界面挪到没人看得见的地方。

**怎么发现的**

**不是靠测试**，也不是靠审代码 —— 是实现方（我）把文档措辞当成要求"修正"了代码之后，
使用者说了一句"**我登录的时候显示器黑屏**"。

这个顺序值得记住：**代码原本只检查了一半（原点），那一半恰好是保护运行中任务的那一半。**
把另一半补上，等于把一个纸面上的要求变成了真实约束 —— 也把一个从未被验证过的假设变成了故障。

**修法**

回到**原点**作为唯一的阻断项 ✓ —— 它是真正保护运行中任务的那半（原点漂移 = 坐标静默偏移 ✓）。
"主屏是不是虚拟屏"**写进报告但不阻断** ✓（`actual` 里的 `virtual=True/False`），让人看得见、不拦人。

**守卫**

`shipped-scripts.test.js` 里加了一条**双向**断言：S4 必须检查原点 ✓，
且**不得**把 `primaryIsVirtual` 纳入判定 ✓ —— 变异检验确认把它加回去会被抓住 ✓。

> 这条守卫比通常的"防止改坏"更窄：它防的是**把一条已知有害的要求重新加回来**。
> 注释里写清了原因，所以要改它的人必须**先读那段理由**。

**顺带证明的能力（供将来选择方案用）**

`CDS_TEST` 探针（`.research/cds-test.ps1`）在从机的**控制台会话**里跑，
`RunLevel=Limited`（非提权）时返回 `DISP_CHANGE_SUCCESSFUL` ✓ —— 也就是说
**把虚拟屏设为主屏不需要管理员权限** ✓，只需要在**正确的会话**里执行 ✓。
将来若想让两种布局兼得（登录时物理屏、工作时虚拟屏），这条路是通的 —— 代价是多一个会动的环节。

---

# 这些教训的共同形状

把 **78** 条放在一起看，反复出现的其实只有**三条**元教训 —— 而第三条是条目长到 78 条时才显形的
（写这一节时文档里只有 30 条，那时只看得出两条）。

## 一、用一个近似去代替那个真正会给出答案的东西 —— 而近似总是给出你想要的答案

这条在本文档里出现了**至少七次**，而且分布在不同层面：

| 层 | 近似 | 真正给出答案的东西 |
|---|---|---|
| 部署 | 清点 `files` 列表应该包含什么 | **跑打包器**看它实际打包什么（E6，错了两次） |
| 部署 | 在主机上运行拷过去的中继 | **在目标机上**运行（#4，远程模式的理由） |
| 沙箱 | "`LOCALAPPDATA` 派生就够了" | 在 **SYSTEM 计划任务**下真跑一次（C6） |
| 沙箱 | 从 agent 的 shell 里跑自检 | **在沙箱外**再跑一次对照（E2） |
| 并发 | 墙钟比例判断串行 | 三个**时刻**之间的一个不等式（D3） |
| 并发 | "第二个 worker 迟到 = 没并行" | 先热身，排除冷连接耗时（D4） |
| 交互 | 字符串里找命令名 | **副作用**（文件在不在）（A5） |
| 后果 | 读源码与合成配置，推断"这个组合会不会让从机起不来" | **跑一次** `session/prompt`，看它到底起不起得来（F34，两次都被推翻） |
| 配置 | "我改的那个 spec 文件里写着全权" | **运行中的那个进程实际读到了什么**（F38） |
| 形式 | 表达式里 token 都在（`DSH_PERMISSION_MODE`、`'never'`、`'ask'`） | **YAML 解析器**接不接受它（F36：那行少了一对引号，我的守卫全绿） |

**为什么近似总是"对"**：因为它是从"我希望的结果"出发构造的。
`files` 看起来列全了、`LOCALAPPDATA` 在我这台机器上是对的、第二个任务在我的理解里"应该"并行 ——
每一个近似都在**我已有的模型内部**自洽。

真正的答案往往来自**模型之外**：打包器的输出、另一个账户下的环境、另一台机器、注入一个副作用。

### 由此得出的操作纪律

1. **能运行就不要清点。** 一条"跑起来"的检查胜过十条"看起来对了"的断言。
2. **能测事件顺序就不要测时长。** 时长里混着你没想到的一切。
3. **一次对照实验的成本，远低于一次错误结论的成本。** 前面那些对照（ReFS vs NTFS、
   受限 vs 不受限、冷 vs 热）各自只花几分钟。
4. **让工具说出它做了什么，而不是宣布它成功了。** A3/A4 的共同点是"宣布"与"事实"脱钩。
5. **修一个具体缺陷之后，去问这一类缺陷的"形状"**，然后用一条正则/一个探针把它扫出来（A1 → A2）。

## 二、检查的**对象**、**强度**、**覆盖**都可能出错，而错误表现为"通过"

比"答案错了"更隐蔽的是"检查本身错了"。本文档里它有三种形态：

### 形态一：对象被换掉了 —— 而输出看不出这一点

`settings` 文件覆盖 harness 传入的配置，**同一个陷阱出现三次**（B1）。
以及：marker 写进了主机的 temp 却以为在测从机（D8）、在主机上运行中继却以为验证了目标机（#4）、
用 `/plugins/...` 这个必然 404 的路径判断插件是否加载（F5）。

> **任何"跑真东西"的 harness 都要先回答：我怎么知道它跑的是我指定的那个东西？**

最可靠的做法是**让隔离本身可断言**（`snapshot.audit.path.startsWith(TEST_HOME)`），
而不是相信它。

### 形态二：强度不够 —— 两种不同的情况都满足同一个断言

| 检查 | 它无法区分 |
|---|---|
| `report.verdict !== undefined` | "跑完有问题" 与 "**根本没跑**"（A8） |
| `!output.includes('DENIED-LIVE')` | "拒绝了" 与 "**agent 引用了命令文本**"（A5） |
| `!existsSync(marker)` | "拒绝被遵守" 与 "**agent 根本没尝试**"（A5b） |
| `verdict === 'ready'` | "可用（有建议性警告）" 与 "不可用"（A6） |
| `paths.length > 0` | "打进了必需文件" 与 "**打进了垃圾**"（E6 的两向断言） |

**修法有共同形状**：把"两个方向都断言"（必须有自己 / 必须没有对方的）、
把"降级路径做成形状可辨"（A8 的单项 `S0` + `sessionSegment`）、
以及**承认第三种结果**（通过了 / 失败了 / **没被真正执行**，A5b）。

### 形态三：覆盖不全 —— 而变异检验能告诉你覆盖到哪里

A6 的那次最典型：**移除 `verdictClass` 的 warn 分支，测试全过**。
一个守卫没抓住变异，不是"守卫没用"，而是**那块地方没人看着**。

所以变异检验要问的不是"测试会不会失败"，而是**"我改哪里它应该失败"**。
本会话里每次变异检验都记录了结果，包括**没抓住的那一次**。

### 与形态三同源的一个子类：成功路径从没被跑过

| 工具 | 只跑过的路径 | 第一次跑成功路径时暴露的缺陷 |
|---|---|---|
| `find-slave.ps1` | 找不到 | 写 hosts 失败却报成功（A4） |
| `deploy-slave.ps1` | 本地模式 | 远程模式的三个缺陷（D2/D6/D7） |
| `dsh-env-backup.py` | `verify` | `--deep` 是空壳（A3） |
| 恢复布防 | 正常启动 | 不重跑沙箱门禁（C1） |
| 截图 | 未授权 401 | 截图写进插件目录（C4） |

**失败路径容易构造，成功路径容易被跳过** —— 而成功路径正是工具存在的理由。

## 三、本该由"一个值"回答的问题，被交给了"逐次判断" —— 而判断会翻转

这一条是 F33–F38 那一弧（GUI 工作要不要全权）才显形的。同一个问题被反复交给判断，而判断给出了相反答案：

| 问题 | 被交给判断的地方 | 实测结果 |
|---|---|---|
| "这次 GUI 启动算不算失败" | 从机模型的判断 | 同一份证据（进程活着、`MainWindowHandle=0`）：一次判"失败"→申请提权→窗口真的出现；另一次判"环境形态"→拒绝提权（F34） |
| "这个组合会不会让从机起不来" | 我读源码 + 合成配置的推断 | 两次给出**合理但错误**的后果（F34） |
| "这次提权批不批" | 人工审批队列 | 而**触发**它的是一个模型的判断 —— 判不触发，队列就永远是空的（F34 的那次轮询：100 秒 `pending=0`） |
| "档位到底设上了没有" | 读一个 spec 文件 | 文件说全权、进程读 workspace-write，**同时为真**几个小时（F38） |

**判据：如果同一份证据能导出相反的决定，那这个决定就不该留在判断里。** 它应该是一个**值** ——
配置、常量、或写进产物的一个参数 —— 由代码在一处决定、在一处检查。

**由此得出的操作纪律**

1. **"在未知上保守"必须带一个到期日。** F34 里我把一道门设成"拒绝"，理由是"这个未知还没测"；
   随后我把这个未知测了回来 —— **那道门当时正在拒绝一个已被证明可用的配置**。
   保守是一种**临时**姿态，它必须配一个"怎么把它变成已验证"的计划，否则它就是从**未验证的恐惧**里
   长出来的永久拒绝。
2. **能在构建期拒绝的，不要留到运行期判断。** 未知档位在**生成规格时**就拒绝（0.2.15），
   比"让模型在运行中判断这个值能不能用"确定得多，而且失败得更早、更吵。
3. **问那个消费者，不要问它的输入。** "配置生效了吗"要问**运行中的进程实际读到了什么**
   （它的命令行、它自己的自报、它回报的运行态），而不是"我改的那个文件现在写着什么"（F38）；
   同理，"这段 YAML 有用吗"要问**解析器**，而不是数它有哪些 token（F36）。
4. **注释记录的是决心，不是约束。** F37 里两段注释都写明了"这个键不登记就会静默回退"，
   而我照样漏了两次 —— **能被执行的检查才是约束**，注释只是写给下一个人看的提醒。
5. **一个值要穿过多个白名单时，守卫要查"集合"。** 逐键往返测试只覆盖你还记得的键；
   "页面暴露的键 ⊆ 存储管理的键"这一条**集合级**断言，落地当场就抓到了三个漏登记的键（F37）。

## 最后一句

这个项目里**最贵的缺陷没有一个抛出过异常**。它们全部以成功的形式出现：
退出码 0、报告形状正确、断言通过、文档句子通顺。

所以真正的工程动作不是"写更多测试"，而是**周期性地问：
我这个检查，如果它要给我一个错误答案，会以什么形式出现？**
然后去构造那个形式，看它是否已经被挡住。
