# diag-pwsh.ps1 -- why does pwsh fail with 0xC0000142 on this worker?
#
# 0xC0000142 is STATUS_DLL_INIT_FAILED: the process died during initialization, before it
# could read any execution policy. That makes it a different class of problem from a
# script-execution refusal, and this script tests the possible causes separately rather
# than assuming.
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $PSScriptRoot 'diag-pwsh.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { Write-Output $m; Add-Content -Path $log -Value $m -Encoding UTF8 }

W "=== host context ==="
W ("session=$((Get-Process -Id $PID).SessionId) interactive=$([Environment]::UserInteractive) user=$env:USERNAME elevated=$((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))")
W ("os=$([Environment]::OSVersion.VersionString)")
W ("windowsPowerShell=$($PSVersionTable.PSVersion)")

W ""
W "=== execution policy (all scopes) ==="
try { Get-ExecutionPolicy -List | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ } } catch { W "  query failed: $($_.Exception.Message)" }

W "=== where is pwsh? ==="
$cmd = Get-Command pwsh -ErrorAction SilentlyContinue
W ("  Get-Command pwsh: " + $(if ($cmd) { $cmd.Source } else { 'NOT FOUND' }))
foreach ($p in @(
  "$env:ProgramFiles\PowerShell\7\pwsh.exe",
  "${env:ProgramFiles(x86)}\PowerShell\7\pwsh.exe",
  "$env:LOCALAPPDATA\Microsoft\WindowsApps\pwsh.exe",
  "$env:ProgramFiles\PowerShell\7-preview\pwsh.exe"
)) {
  if (Test-Path $p) {
    $f = Get-Item $p
    W ("  exists: $p  ver=$($f.VersionInfo.FileVersion)  size=$($f.Length)")
  }
}
W "  --- all PowerShell install dirs ---"
foreach ($d in @("$env:ProgramFiles\PowerShell", "${env:ProgramFiles(x86)}\PowerShell")) {
  if (Test-Path $d) { Get-ChildItem $d -Directory | ForEach-Object { W ("    " + $_.FullName) } }
}

W ""
W "=== run pwsh the same way the ACP agent does (capture exit code) ==="
$exe = if ($cmd) { $cmd.Source } else { "$env:ProgramFiles\PowerShell\7\pwsh.exe" }
if (Test-Path $exe) {
  # Redirect to files rather than pipes so a pipe failure cannot be mistaken for a crash.
  $outFile = Join-Path $PSScriptRoot 'diag-pwsh-out.txt'
  $errFile = Join-Path $PSScriptRoot 'diag-pwsh-err.txt'
  Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue

  $p = Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-Command', '"pwsh-ok"') `
    -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $p.WaitForExit(20000) | Out-Null
  W ("  exit code = " + $p.ExitCode + "  (0x" + ('{0:X8}' -f $p.ExitCode) + ")")
  # No `??` here: that operator is PowerShell 7+, and the worker runs 5.1.
  $so = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
  $se = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
  if ($null -eq $so) { $so = '' }
  if ($null -eq $se) { $se = '' }
  W ("  stdout: " + $so.Trim())
  W ("  stderr: " + $se.Trim())

  W "  --- same, via cmd.exe (bypasses any PowerShell-startup involvement) ---"
  $rc = (cmd /c "`"$exe`" -NoProfile -Command `"pwsh-via-cmd`" 2>&1")
  W ("  output: " + ($rc -join ' | '))
  W ("  cmd exit = " + $LASTEXITCODE)
} else {
  W "  pwsh.exe not found at the expected paths"
}

W ""
W "=== compare: powershell.exe (known to work here) ==="
$rc2 = (cmd /c "powershell.exe -NoProfile -Command `"ps-ok`" 2>&1")
W ("  output: " + ($rc2 -join ' | '))
W ("  exit = " + $LASTEXITCODE)

W ""
W "=== recent application errors mentioning pwsh or 0xC0000142 ==="
try {
  $since = (Get-Date).AddHours(-6)
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -ErrorAction Stop |
    Where-Object { $_.Message -match 'pwsh|0xc0000142|Application Error|SideBySide' } |
    Select-Object -First 8 |
    ForEach-Object { W ("  [" + $_.TimeCreated.ToString('HH:mm:ss') + "] " + $_.ProviderName + ": " + (($_.Message -split "`n")[0])) }
} catch { W "  event log query failed: $($_.Exception.Message)" }

W ""
W "=== third-party security software (a known cause of process-init blocks) ==="
try {
  Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop |
    ForEach-Object { W ("  AV: " + $_.displayName + "  state=0x" + ('{0:X}' -f $_.productState)) }
} catch { W "  SecurityCenter2 unavailable: $($_.Exception.Message)" }
W "  --- services from common security vendors ---"
# Match on ASCII vendor identifiers only. Localized display names would require non-ASCII
# bytes in this file, and a single one corrupts Windows PowerShell 5.1 parsing (it reads a
# BOM-less file as ANSI), which is how this script first failed to run at all.
Get-Service -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'Huorong|hips|360|Tencent|QQPCMgr|Qihoo|WinDefend|Kaspersky|Avast|ESET' } |
  ForEach-Object { W ("    " + $_.Name + "  " + $_.Status) }

W "RESULT: DONE"
