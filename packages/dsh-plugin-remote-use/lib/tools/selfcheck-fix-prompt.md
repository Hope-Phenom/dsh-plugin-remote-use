# 从机环境自动配置提示词（复制给从机的 DSH 会话）

> 用法：在**从机**的 DSH 会话里新建一个对话，把本文件从「你要做什么」往下整段粘进去。
> 它让从机自己的 agent 去跑自检、按项修复、再复跑证明。需要管理员权限或需要人登录/解锁的步骤，
> 它会停下来告诉你，而不是假装成功。

---

## 你要做什么

这台 Windows 机器是 DSH 的**远程工作节点**。请实际执行下面的清单，把它的 GUI 就绪环境配好，并用自检脚本
**证明**每一项都过了。不要猜测；每一步都贴**原始输出**；做不到的项明确写"做不到，原因/需要什么"。

## 纪律

- 只在这台机器上操作；**不要修改 DSH 安装目录，也不要手改任何 profile**。
- 需要管理员权限的步骤先说明再执行；安装驱动/软件前先征得操作者同意。
- 装驱动只用官方发布（Virtual-Display-Driver 是 MIT）；**不要**为了"让检查过"而关 UAC / 防火墙 / 安全策略。
- 最后必须**复跑自检并贴 JSON**。"命令返回 0" 不等于 "检查项通过"。

## 第 0 步：找到并运行自检

```powershell
$selfcheck = Get-ChildItem "$env:USERPROFILE\.dsh\profiles\*\node_modules\@hope_phenom\dsh-plugin-remote-use\slave\selfcheck.ps1" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $selfcheck) { throw "找不到 selfcheck.ps1：这台机器还没装 @hope_phenom/dsh-plugin-remote-use" }
$ps = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }
& $ps -NoProfile -ExecutionPolicy Bypass -File $selfcheck.FullName
Get-Content (Join-Path $selfcheck.DirectoryName "selfcheck.json") -Raw
```

- 自检必须在**已登录、已解锁的交互式桌面会话**里跑（就是 DSH 桌面进程所在的那个会话）。
  SSH / 计划任务 / 服务里跑会得到 `session=0` 的假阴性（S1 显示 0 块屏、S6/S7/S8 n/a），那些不是真问题。
- 布防时填了任务目录的话，加 `-Workspace "<任务目录>"`（它会顺带测量 S20 工作目录完整性）。
- 把输出的 `verdict`、`blockingFailures` 和 `checks[]`（每项的 `id/status/actual/fix`）都留着，后面要对比。

## 第 1 步：按报告逐项修复

> 先修 **blocking** 项，再修 warning。每修完一类就复跑一次自检，确认那一项真的变了。

### S1 / S2 显示适配器与虚拟显示器（blocking）

判据：至少一个 `ATTACHED_TO_DESKTOP` 的适配器；并且存在**带 EDID 的虚拟显示器**，不能回落到 `WinDisc`
（Microsoft 基本显示适配器，通常 1024x768）。

```powershell
Get-PnpDevice -Class Display | Select-Object Status, Problem, FriendlyName, InstanceId | Format-List
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.DeviceName) $($_.Bounds.Width)x$($_.Bounds.Height) at $($_.Bounds.X),$($_.Bounds.Y) primary=$($_.Primary)" }
```

- 如果 VDD 已装但被禁用（`Problem=CM_PROB_DISABLED` / Code 22）：
  `Enable-PnpDevice -InstanceId 'ROOT\DISPLAY\0000' -Confirm:$false`（需要管理员）。
- 如果根本没装 VDD：按官方 **Virtual-Display-Driver（VDD，MIT）** 的发布说明安装（需要管理员，通常要重启）。
  **先向操作者确认**再装；装完再跑一次自检，S2 的 `actual` 里应出现 VDD 与 EDID，而不是 `WinDisc`。
- ⚠️ **不要把虚拟屏设成主屏**：Windows 的登录界面只画在主屏上，主屏若是没有物理输出的虚拟屏，
  操作者会看到黑屏、无法登录。主屏保持物理屏，虚拟屏作为**第二块**。

### S3 / S4 分辨率与原点（S3 警告，S4 阻断）

- **S4 是阻断项**：主屏必须在 `(0,0)`，否则 GUI 自动化的绝对坐标会整体偏移（而且不报错）。
- S3 期望主屏 `1920x1080`；物理主屏做不到时它只是警告，不用强求。

下面的脚本会把**主屏**设成 1920x1080@(0,0)，并（可选）把第二块屏设成 1920x1080@(1920,0)：

```powershell
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DispCfg {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
  public const int ENUM_CURRENT_SETTINGS = -1;
  public const int CDS_UPDATEREGISTRY = 0x01;
  public const int DM_POSITION = 0x20, DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
}
"@

Add-Type -AssemblyName System.Windows.Forms
$displays = @([System.Windows.Forms.Screen]::AllScreens)

function Set-DisplayMode([string]$dev, [int]$w, [int]$h, [int]$x, [int]$y, [int]$hz) {
  $dm = New-Object DispCfg+DEVMODE
  $dm.dmSize = [short][Runtime.InteropServices.Marshal]::SizeOf($dm)
  if (-not [DispCfg]::EnumDisplaySettings($dev, -1, [ref]$dm)) { return "READ-FAILED $dev" }
  $dm.dmPelsWidth = $w; $dm.dmPelsHeight = $h
  $dm.dmPositionX = $x; $dm.dmPositionY = $y
  $dm.dmDisplayFrequency = $hz
  $dm.dmFields = [DispCfg]::DM_PELSWIDTH -bor [DispCfg]::DM_PELSHEIGHT -bor [DispCfg]::DM_POSITION -bor [DispCfg]::DM_DISPLAYFREQUENCY
  $rc = [DispCfg]::ChangeDisplaySettingsEx($dev, [ref]$dm, [IntPtr]::Zero, [DispCfg]::CDS_UPDATEREGISTRY, [IntPtr]::Zero)
  return "rc=$rc $dev ${w}x${h}@${x},${y} ${hz}Hz"
}

$primary = $displays | Where-Object { $_.Primary } | Select-Object -First 1
Set-DisplayMode $primary.DeviceName 1920 1080 0 0 60
# 可选：把第二块屏排到主屏右侧，同样 1920x1080
$others = @($displays | Where-Object { -not $_.Primary })
if ($others.Count -gt 0) { Set-DisplayMode $others[0].DeviceName 1920 1080 1920 0 60 }
Start-Sleep -Seconds 2
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.DeviceName) $($_.Bounds.Width)x$($_.Bounds.Height) at $($_.Bounds.X),$($_.Bounds.Y) primary=$($_.Primary)" }
```

返回码含义：`0` 成功、`1` 需要重启、`-1` 失败、`-2` 不支持该模式。失败就贴返回码，**不要换别的分辨率硬试**。
（如果该屏不支持 1920x1080，S3 保持警告即可；S4 必须满足。）

### S6 / S7 / S8 交互式会话（S6/S7/S8）

判据：自检运行在 **console 会话**里，且该会话**已登录、未锁屏**；S7/S8 需要真的能动鼠标（S8 会移动光标）。

- 这三项**不是 agent 远程能修的**：锁屏/未登录时必须由操作者在这台机器上（或 RDP）登录并解锁。
- 先用 `query session` 确认有一个 `Active` 的 console 会话；S6 会告诉你 `mySession` 与 `consoleId` 是否一致。
- 如果自检是在 SSH 里跑的，换到 DSH 桌面会话里重跑（见第 0 步）。

### S9 睡眠/休眠超时（blocking）

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
```

可能需要管理员。目标是 AC/DC 的超时都变成 `0`。

### S10 屏保（warning）

```powershell
$k = "HKCU:\Control Panel\Desktop"
Set-ItemProperty $k -Name ScreenSaveActive  -Value "0" -Type String
Set-ItemProperty $k -Name ScreenSaveTimeOut -Value "0" -Type String
Set-ItemProperty $k -Name ScreenSaverIsSecure -Value "0" -Type String
```

### S11 自动锁屏策略（blocking）

```powershell
$k = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
if (Test-Path $k) { Remove-ItemProperty $k -Name InactivityTimeoutSecs -ErrorAction SilentlyContinue }
```

需要管理员；删完注销/重启才彻底生效。

### S12 控制台 QuickEdit（blocking）

`QuickEdit` 会让控制台在选中文字时**挂起输出**，GUI 任务里表现为"命令卡住"。对当前用户和默认控制台都关掉：

```powershell
Set-ItemProperty "HKCU:\Console" -Name QuickEdit -Value 0 -Type DWord
Get-ChildItem "HKCU:\Console" -ErrorAction SilentlyContinue | ForEach-Object {
  Set-ItemProperty $_.PSPath -Name QuickEdit -Value 0 -Type DWord -ErrorAction SilentlyContinue
}
```

**新开的控制台**才会读到新值（中继/自检下次启动时生效）。

### S14 / S15 DSH 与模型凭据（blocking）

- S14：DSH 已安装（`actual` 会给出安装版本）。
- S15：`%USERPROFILE%\.dsh\.credentials.yaml` 存在。**缺凭据只能由人登录 DSH 解决**（agent 不能替登录）。

### S16 磁盘空间（blocking）

自检要求 ≥ 50 GB 可用。清理临时目录/旧截图（`%TEMP%\dsh-plugin-remote-use\shots` 等），或在布防面板把
截图缓存上限设小。

### S18 被测应用（warning，可选）

只有在需要从机验证某个具体程序时才配：给自检传 `-App "<exe 路径>"`，或设置 `DSH_SELFCHECK_APP`。
没配就是"不验证具体应用"，不影响 GUI 任务。

### S20 工作目录完整性（warning）

`danger-full-access` 下中继启动时会自动修复任务目录的 Low 完整性标签。需要手工修时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $selfcheck.DirectoryName "repair-workspace-integrity.ps1") -Path "<任务目录>"
```

## 第 2 步：复跑并汇报

再跑一次第 0 步（带 `-Workspace`），然后把**修复前/修复后**两份 `verdict + checks` 贴出来，逐项说明：

- 哪些从 fail → pass；
- 哪些仍是 fail，原因是什么、需要操作者做什么（登录/解锁、管理员、装驱动、重启）；
- **不要**把"我改了注册表"当成"检查通过"——以复跑结果为准。

## 不要做的事

- 不要把虚拟屏设成主屏（登录界面会黑屏）。
- 不要关 UAC / 防火墙 / Defender 来"让检查通过"。
- 不要在 SSH/服务会话里下结论（你会看到 session=0 的假阴性）。
- 不要改 DSH 的安装目录或 profile 文件；本清单只动操作系统设置。
