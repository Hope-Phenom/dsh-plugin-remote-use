# set-quickedit-off.ps1 -- stop console click-to-select from freezing processes.
# Writes default console settings + per-console overrides so it applies machine-wide.
$log = 'C:\dsh-remote\evidence\quickedit.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

function Set-Con($key) {
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name 'QuickEdit'  -Value 0 -Type DWord -Force
  Set-ItemProperty -Path $key -Name 'InsertMode' -Value 0 -Type DWord -Force
  Set-ItemProperty -Path $key -Name 'LineSelection' -Value 0 -Type DWord -Force
  $v = Get-ItemProperty $key
  W ("  " + $key + "  QuickEdit=" + $v.QuickEdit + " InsertMode=" + $v.InsertMode)
}

W "=== BEFORE ==="
Set-Con 'HKCU:\Console'   # idempotent; this also creates if missing
W ""

W "=== APPLY: defaults + every existing per-console subkey ==="
Set-Con 'HKCU:\Console'
Get-ChildItem 'HKCU:\Console' -ErrorAction SilentlyContinue | ForEach-Object {
  Set-Con $_.PSPath
}
# explicit well-known consoles even if their subkey does not exist yet
foreach ($k in '%SystemRoot%_System32_cmd.exe',
               '%SystemRoot%_System32_WindowsPowerShell_v1.0_powershell.exe',
               '%SystemRoot%_SysWOW64_WindowsPowerShell_v1.0_powershell.exe',
               'Git Bash','Git CMD') {
  Set-Con ("HKCU:\Console\" + $k)
}

W ""
W "=== NOTE ==="
W "  这是 HKCU 设置 -> 只对 sheng 用户生效，且新开的控制台才生效（已开着的窗口不受影响）。"
W "  对从机执行器而言，正确的做法是【根本不创建可见控制台】，见 DSH 侧设计。"
W "DONE"
