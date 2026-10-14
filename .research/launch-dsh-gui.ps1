# launch-dsh-gui.ps1 -- start the real Electron app with its output captured.
#
# WHY NOT THE CLI: the host CLI refuses the desktop profile ("managed exclusively by the Electron
# application"), so the only way to reproduce what the operator sees is to launch the app itself.
#
# WHY THIS RUNS IN THE CONSOLE SESSION: it is a GUI. Launched from an SSH login it lands in session 0,
# which has no desktop, and would fail for a reason that has nothing to do with the fault.
#
# The app is left RUNNING: the point is to hand the operator a working window. Whatever it prints
# before it settles is captured to a file either way.
#
# ASCII-ONLY, param() first.
param(
  [int]$WaitSeconds = 25,
  [switch]$KillAfter,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

# Clear anything left over, so the captured output belongs to THIS launch only.
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
Say "exe = $exe"
if (-not (Test-Path -LiteralPath $exe)) { Say 'FATAL: exe not found'; exit 2 }

$out = Join-Path $env:TEMP 'dsh-gui.out.txt'
$err = Join-Path $env:TEMP 'dsh-gui.err.txt'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Say "started pid=$($p.Id)"
Start-Sleep -Seconds $WaitSeconds

$alive = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Say "processes alive after $WaitSeconds s: $($alive.Count)"
foreach ($q in $alive) { Say "  pid=$($q.Id)  mem=$([int]($q.WorkingSet64 / 1MB))MB" }

Say ''
Say '--- stderr ---'
if (Test-Path -LiteralPath $err) { Get-Content -LiteralPath $err -Tail 40 | ForEach-Object { Say "  $_" } } else { Say '  (none)' }
Say ''
Say '--- stdout ---'
if (Test-Path -LiteralPath $out) { Get-Content -LiteralPath $out -Tail 30 | ForEach-Object { Say "  $_" } } else { Say '  (none)' }

if ($KillAfter) {
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Say ''
  Say 'stopped (KillAfter)'
}

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
