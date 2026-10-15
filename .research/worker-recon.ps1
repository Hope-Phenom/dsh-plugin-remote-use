# worker-recon.ps1 -- read-only report about the worker's relay + launch spec.
#
# WHY A PUSHED SCRIPT AND NOT AN ssh ONE-LINER: nested quoting through ssh is unreliable
# (the project has been bitten by it: `^|`, inner quotes and BOM-less encodings all mangle),
# so the script travels as a FILE and is run with -File. It changes nothing.
#
# ASCII-ONLY on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so a non-ASCII
# byte breaks parsing.
param(
  [string]$OutFile = 'C:\dsh-remote\worker-recon.json'
)

$ErrorActionPreference = 'Continue'
$result = [ordered]@{}

# 1) the scheduled task that (re)starts the relay
$task = Get-ScheduledTask -TaskName 'DshRelay' -ErrorAction SilentlyContinue
if ($task -ne $null) {
  $result.taskExists = $true
  $result.taskState = [string]$task.State
  $info = Get-ScheduledTaskInfo -TaskName 'DshRelay' -ErrorAction SilentlyContinue
  $result.taskLastRun = if ($info) { [string]$info.LastRunTime } else { '' }
  $result.taskLastResult = if ($info) { [string]$info.LastTaskResult } else { '' }
  $result.taskAction = ($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | '
} else {
  $result.taskExists = $false
}

# 2) the relay process and how it was started
$me = $PID
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
$relay = @()
foreach ($p in $procs) {
  if ($p.CommandLine -ne $null -and $p.CommandLine -match 'relay\.mjs') {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" -ErrorAction SilentlyContinue
    $relay += [ordered]@{
      pid = $p.ProcessId
      parentPid = $p.ParentProcessId
      parentName = if ($parent) { $parent.Name } else { '' }
      parentCmd = if ($parent) { [string]$parent.CommandLine } else { '' }
    }
  }
}
$result.relayProcesses = $relay

# 3) the launch spec's permission mode
$specPath = 'C:\dsh-remote\plugin-slave\agent-spec.json'
if (Test-Path $specPath) {
  $spec = Get-Content -LiteralPath $specPath -Raw | ConvertFrom-Json
  $result.specPermissionMode = [string]$spec.env.DSH_PERMISSION_MODE
  $result.specProfile = ($spec.args -join ' ')
} else {
  $result.specPermissionMode = '(spec missing)'
}

# 4) sessions, so a probe knows which session it is in
$result.mySessionId = (Get-Process -Id $me).SessionId
$result.myUserInteractive = [Environment]::UserInteractive
$result.sessionName = $env:SESSIONNAME
$explorers = Get-Process -Name explorer -ErrorAction SilentlyContinue
$result.explorerCount = @($explorers).Count
$result.explorerSessions = (@($explorers | Select-Object -ExpandProperty SessionId -Unique) -join ',')

# 5) the leftover F21 error dialog: class #32770, an error text mentioning 0xc0000142
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
'@ -ErrorAction SilentlyContinue

$dialogs = @()
try {
  $cb = [Win+EnumProc]{
    param($h, $l)
    $cls = New-Object System.Text.StringBuilder 256
    [void][Win]::GetClassName($h, $cls, 256)
    if ($cls.ToString() -eq '#32770') {
      $len = [Win]::GetWindowTextLength($h)
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][Win]::GetWindowText($h, $sb, $sb.Capacity)
      $title = $sb.ToString()
      if ($title -match 'Application Error' -or $title -match 'explorer') {
        $ownerPid = 0
        [void][Win]::GetWindowThreadProcessId($h, [ref]$ownerPid)
        $script:dialogs += [ordered]@{ hwnd = [int64]$h; title = $title; ownerPid = $ownerPid }
      }
    }
    return $true
  }
  [void][Win]::EnumWindows($cb, [IntPtr]::Zero)
} catch { }
$result.errorDialogs = $dialogs

$json = $result | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $OutFile -Value $json -Encoding UTF8
Write-Output $json
