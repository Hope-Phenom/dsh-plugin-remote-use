# validate-shim.ps1 -- standalone validation of sandbox-mediator-shim.mjs.
#
# The shim translates the bubblewrap dialect that dsh-sandbox-local feeds a configured
# `runnerCommand` into the Windows ACL runner's own argv. It is validated here, WITHOUT
# DSH, so a translation bug is found before it can be mistaken for a sandbox behaviour.
#
# ASCII-only and PowerShell 5.1 syntax only: the worker runs 5.1 and reads a BOM-less file
# as ANSI. (Note: an inline SSH script bypasses the project's deploy gate, which is how a
# PowerShell 7 `??` operator reached this worker once already. File-based deployment with
# `deploy-ps1.ps1` is what catches that.)
# Parameterised so the SAME script validates the worker and the host. The defect it checks for
# is a property of the DSH build, not of either machine, so both need the same evidence -- and
# two copies would drift.
#
# `param()` must be the FIRST statement in the script: PowerShell rejects it after any
# assignment, and PS 5.1 reports that as a confusing "invalid assignment operator" at the
# following lines. The deploy gate caught exactly that.
param(
  [string]$Shim = 'C:\dsh-remote\sandbox-mediator\shim.mjs',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$Workspace = 'C:\dsh-remote\p0work'
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }

$log = Join-Path $PSScriptRoot 'validate-shim.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
# NOT Write-Output: that writes to the PIPELINE, so every line a helper printed became part
# of its return value. A function returning a non-empty array is always truthy, which made
# this script report "4/4 checks passed" while one check was visibly FAIL. Console output
# keeps the pipeline clean.
function W($m) { [Console]::WriteLine($m); Add-Content -Path $log -Value $m -Encoding UTF8 }

$shim = $Shim
$node = $NodeExe
$pwshExe = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
$out = Join-Path $PSScriptRoot 'shim-out.txt'
$err = Join-Path $PSScriptRoot 'shim-err.txt'

function Run-Shim($label, $argList, $expectZero, $expectText) {
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  $all = @($shim) + $argList
  $q = ($all | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $line = '"' + $node + '" ' + $q + ' > "' + $out + '" 2> "' + $err + '"'
  cmd /c $line | Out-Null
  $code = $LASTEXITCODE

  $so = Get-Content $out -Raw -ErrorAction SilentlyContinue
  $se = Get-Content $err -Raw -ErrorAction SilentlyContinue
  if ($null -eq $so) { $so = '' }
  if ($null -eq $se) { $se = '' }
  $so = $so.Trim()
  $se = $se.Trim()

  $pass = $false
  if ($expectZero) {
    # Require the payload's own output, not just a zero exit: a payload that prints nothing
    # makes a zero exit ambiguous, and an earlier version of this check silently expected
    # text from `cmd /c exit 0`, which produces none.
    $pass = ($code -eq 0 -and $so -match $expectText)
  } else {
    $pass = ($code -ne 0 -and $se -match 'windows-acl-run:')
  }

  $mark = 'FAIL'
  if ($pass) { $mark = 'OK  ' }
  W "  [$mark] $label"
  W "        exit=$code  stdout='$so'"
  W "        stderr='$se'"
  return $pass
}

W "shim : $(Test-Path $shim)"
W "node : $(Test-Path $node)"
W "pwsh : $(Test-Path $pwshExe)"
W ""

$bwrapReadOnly = @('--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent')
$bwrapWrite = $bwrapReadOnly + @('--tmpfs', '/tmp', '--bind', $Workspace, $Workspace)
$pwshCmd = @('--', $pwshExe, '-NoProfile', '-Command', 'Write-Output shim-child-alive')
$cmdEcho = @('--', 'cmd', '/c', 'echo', 'read-only-ok')

W "=== A. workspace-write shape (has --bind and --tmpfs /tmp) ==="
$r1 = Run-Shim 'node.exe shim + workspace-write + pwsh' ($bwrapWrite + $pwshCmd) $true 'shim-child-alive'

W ""
W "=== B. read-only shape (no --bind) ==="
$r2 = Run-Shim 'node.exe shim + read-only + cmd echo' ($bwrapReadOnly + $cmdEcho) $true 'read-only-ok'

W ""
W "=== C. an unrecognised profile argument must HARD FAIL, never be ignored ==="
$r3 = Run-Shim 'unknown flag must be rejected' (@('--ro-bind', '/', '/', '--bogus-flag', 'x') + $cmdEcho) $false ''

W ""
W "=== D. missing separator must hard fail ==="
$r4 = Run-Shim 'missing -- must be rejected' @('--ro-bind', '/', '/', 'cmd', '/c', 'exit', '0') $false ''

W ""
W "=== summary ==="
$passed = 0
foreach ($r in @($r1, $r2, $r3, $r4)) { if ($r) { $passed += 1 } }
W "  $passed / 4 checks passed"
if ($passed -eq 4) {
  W "  RESULT: SHIM OK -- safe to name it as sandbox-local's runnerCommand."
} else {
  W "  RESULT: SHIM NOT READY -- fix before wiring it into the profile."
}
W "DONE"
