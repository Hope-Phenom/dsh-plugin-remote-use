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
- [F. 上游与协议事实](#f-上游与协议事实)
  - [F1. `ctx.tools.restrict()` 强制 per-agent](#f1-ctxtoolsrestrict-强制-per-agent)
  - [F2. `defineTool` 是唯一的 schema 转换点](#f2-definetool-是唯一的-schema-转换点)
  - [F3. `ctx.effect` 立即执行，并返回它自己的 disposer](#f3-ctxeffect-立即执行并返回它自己的-disposer)
  - [F4. Cordis patch：新增行需要 `insert:`](#f4-cordis-patch新增行需要-insert)
  - [F5. `dsh-client-modules` 的元数据缓存需要重启](#f5-dsh-client-modules-的元数据缓存需要重启)
  - [F6. DSH 的 pnpm 带三层供应链策略，每层都能让安装静默变形](#f6-dsh-的-pnpm-带三层供应链策略每层都能让安装静默变形)
  - [F7. 陈旧的 lockfile 会让 `pnpm add` 静默装回旧版本](#f7-陈旧的-lockfile-会让-pnpm-add-静默装回旧版本)
  - [F8. 改包名要同步的两类标识符，而且规则相反](#f8-改包名要同步的两类标识符而且规则相反)
  - [F9. DSH 起不来时，第一件事是读它自己写的崩溃日志](#f9-dsh-起不来时第一件事是读它自己写的崩溃日志)
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
- 想补一个缺失的依赖，整个操作被**回滚**，`package.json` 和 `node_modules` 都没变。

**根因**：DSH 的 profile 用 pnpm，而 `pnpm-workspace.yaml` 里预置了策略：

```yaml
nodeLinker: hoisted
autoInstallPeers: false          # ← 不会自动装 peer 依赖（npm 会）
minimumReleaseAgeExclude:        # ← 其余包有"隔离期"：太新的版本不允许装
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

# G. 需求本身的坑

前六类都是"实现没做到要求"。这一类相反：**要求本身是错的**，而且实现得越忠实，坏得越彻底。

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

把 30 条放在一起看，反复出现的其实只有**两条**元教训。

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

## 最后一句

这个项目里**最贵的缺陷没有一个抛出过异常**。它们全部以成功的形式出现：
退出码 0、报告形状正确、断言通过、文档句子通顺。

所以真正的工程动作不是"写更多测试"，而是**周期性地问：
我这个检查，如果它要给我一个错误答案，会以什么形式出现？**
然后去构造那个形式，看它是否已经被挡住。
