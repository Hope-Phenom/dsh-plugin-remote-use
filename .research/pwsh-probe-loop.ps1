# pwsh-probe-loop.ps1 -- try to start pwsh repeatedly in the INTERACTIVE session.
#
# The 0xC0000142 (STATUS_DLL_INIT_FAILED) observed earlier came from the ACP agent's pwsh
# spawn, which runs in this session -- while the same binary works from an SSH session.
# So the reproduction has to happen here. The loop is deliberately long enough (~30s) for
# the host to capture several screenshots while it runs, because a HIPS/AV block usually
# shows a dialog rather than only logging.
#
# ASCII-only and PowerShell 5.1 syntax only (no `??`, no ternary): the worker runs 5.1 and
# reads a BOM-less file as ANSI.
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $PSScriptRoot 'pwsh-probe-loop.txt'
$out = Join-Path $PSScriptRoot 'pwsh-probe-out.txt'
$err = Join-Path $PSScriptRoot 'pwsh-probe-err.txt'
Remove-Item $log, $out, $err -Force -ErrorAction SilentlyContinue
function W($m) { Write-Output $m; Add-Content -Path $log -Value $m -Encoding UTF8 }

$exe = "$env:ProgramFiles\PowerShell\7\pwsh.exe"
$ps5 = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

W "session=$((Get-Process -Id $PID).SessionId) interactive=$([Environment]::UserInteractive) user=$env:USERNAME"
W "started=$(Get-Date -Format 'HH:mm:ss.fff')"
W "pwsh=$exe  exists=$(Test-Path $exe)"

function Try-Run($label, $file, $argList) {
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  $t0 = Get-Date
  $code = 'n/a'
  $spawnError = ''
  try {
    $p = Start-Process -FilePath $file -ArgumentList $argList -PassThru -NoNewWindow `
      -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
    $exited = $p.WaitForExit(15000)
    if ($exited) {
      $code = $p.ExitCode
    } else {
      $code = 'TIMEOUT'
      try { $p.Kill() } catch { }
    }
  } catch {
    $spawnError = $_.Exception.Message
  }
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  $hex = ''
  if ($code -is [int]) { $hex = '0x' + ('{0:X8}' -f $code) }
  $so = Get-Content $out -Raw -ErrorAction SilentlyContinue
  $se = Get-Content $err -Raw -ErrorAction SilentlyContinue
  if ($null -eq $so) { $so = '' }
  if ($null -eq $se) { $se = '' }
  $firstErr = ($se.Trim() -split "`r?`n")[0]
  if ($null -eq $firstErr) { $firstErr = '' }
  W ("  [$label] exit=$code $hex ms=$ms spawnErr='$spawnError' stdout='" + $so.Trim() + "' stderr1='" + $firstErr + "'")
}

W ""
W "=== warm-up baseline: powershell.exe (known to work) ==="
Try-Run 'ps51-1' $ps5 @('-NoProfile', '-Command', 'Write-Output ps51-alive')

W ""
W "=== pwsh attempts (the failing case) ==="
for ($i = 1; $i -le 12; $i++) {
  Try-Run "pwsh-$i" $exe @('-NoProfile', '-Command', 'Write-Output pwsh-alive')
  Start-Sleep -Milliseconds 700
}

W ""
W "=== control: powershell.exe again ==="
Try-Run 'ps51-2' $ps5 @('-NoProfile', '-Command', 'Write-Output ps51-alive2')

W "finished=$(Get-Date -Format 'HH:mm:ss.fff')"
W "RESULT: DONE"
