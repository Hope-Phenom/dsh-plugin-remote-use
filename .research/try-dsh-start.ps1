# try-dsh-start.ps1 -- launch the DSH host CLI and capture WHY it fails to start.
#
# WHY THE CLI RATHER THAN THE GUI: the desktop app is a GUI, so its startup failure is a dialog or a
# flash, not something an operator can copy. The ACP profile is launched as exactly this CLI with
# ELECTRON_RUN_AS_NODE=1 (see the worker's agent-spec.json), so the same command with --profile
# desktop loads the desktop profile's bundles headlessly and prints whatever throws.
#
# THE QUOTING IS THE POINT: "DeepSeek Harness" contains a space. `Start-Process -ArgumentList @(...)`
# joins the array with spaces WITHOUT quoting, so the executable receives a truncated path and dies
# with "Cannot find module 'C:\...\Programs\DeepSeek'" -- which looks like a DSH fault and is not.
# Passing one pre-quoted string is the only form that survives.
#
# ASCII-ONLY, param() first.
param(
  [string]$Profile = 'desktop',
  [int]$WaitSeconds = 25,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$install = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
$exe = Join-Path $install 'DeepSeek Harness.exe'
$cli = Join-Path $install 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$out = Join-Path $env:TEMP 'dsh-try.out.txt'
$err = Join-Path $env:TEMP 'dsh-try.err.txt'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue

Say "exe     : $exe"
Say "cli     : $cli"
Say "profile : $Profile"
if (-not (Test-Path -LiteralPath $exe)) { Say 'FATAL: exe not found'; exit 2 }
# NOT checked with Test-Path: cli.js lives INSIDE app.asar. Electron resolves asar paths; the
# filesystem APIs do not, so a Test-Path guard here reports "missing" for a file that runs fine.
# (This project already has that written down as pitfall E7, and it still got written here first.)

$env:ELECTRON_RUN_AS_NODE = '1'
# ONE pre-quoted argument string. See the note above.
$args = "--expose-internals `"$cli`" --profile $Profile"
Say "args    : $args"
Say ''

$p = Start-Process -FilePath $exe -ArgumentList $args -NoNewWindow -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err

Say "started pid=$($p.Id); waiting up to $WaitSeconds s"
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }

if ($p.HasExited) {
  Say "EXITED with code $($p.ExitCode)"
} else {
  Say "STILL RUNNING after $WaitSeconds s -- that is a good sign; stopping it"
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

Say ''
Say '--- stderr (last 40 lines) ---'
if (Test-Path -LiteralPath $err) {
  Get-Content -LiteralPath $err -Tail 40 | ForEach-Object { Say "  $_" }
} else { Say '  (none)' }

Say ''
Say '--- stdout (last 25 lines) ---'
if (Test-Path -LiteralPath $out) {
  Get-Content -LiteralPath $out -Tail 25 | ForEach-Object { Say "  $_" }
} else { Say '  (none)' }

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
