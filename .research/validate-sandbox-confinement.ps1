# validate-sandbox-confinement.ps1 -- prove the Windows sandbox actually CONFINES.
#
# "The sandbox runs" and "the sandbox restricts" are different claims. The shim validation
# (validate-shim.ps1) settles the first: the mediator no longer dies with 0xC0000142 and the
# child produces output. This script settles the second, because a mediator that runs the
# payload with the SAME token it had before would look identical from the outside and confine
# nothing at all.
#
# WHAT IT ASSERTS, and why each one is the right probe:
#   * workspace-write: a write INSIDE the granted workspace SUCCEEDS. The control, without
#     which the next check would pass even if everything were broken.
#   * workspace-write: a write OUTSIDE it FAILS, and the file is absent afterwards. This is the
#     whole point of the feature; if it passes, workspace-write is decorative.
#   * read-only: a write inside the workspace fails TOO. Otherwise the two modes are the same
#     and the "narrower tier" is a label rather than a policy.
#
# A PROBE THAT LOOKED OBVIOUS AND WAS WRONG, recorded so nobody re-adds it: asserting that
# `whoami` FAILS. The Windows rung creates a WRITE_RESTRICTED token, which restricts WRITE
# access only -- reading the process's own identity still succeeds, and on this host it
# returned `host-pc\dev` while the confinement was working correctly. `whoami` failing
# is a signature of READ restriction (the read-only shape), not of write restriction, so using
# it as a general "is it restricted" probe produces exactly the wrong verdict: it reports a
# healthy sandbox as broken.
#
# ASCII-only and PowerShell 5.1 syntax: the worker runs 5.1 and reads a BOM-less file as ANSI.
param(
  [string]$Shim = 'C:\dsh-sandbox-mediator\shim.mjs',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$Workspace = (Join-Path $env:TEMP 'dsh-sandbox-probe')
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $PSScriptRoot 'validate-confinement.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
# [Console]::WriteLine, not Write-Output: an earlier version of the sibling script polluted the
# pipeline this way and reported success while a check was visibly FAIL.
function W($m) { [Console]::WriteLine($m); Add-Content -Path $log -Value $m -Encoding UTF8 }

$pwshExe = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
if (-not (Test-Path $pwshExe)) { $pwshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
$out = Join-Path $PSScriptRoot 'confine-out.txt'
$err = Join-Path $PSScriptRoot 'confine-err.txt'

New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
$inside = Join-Path $Workspace 'inside-probe.txt'
$outside = Join-Path $env:TEMP 'dsh-sandbox-outside-probe.txt'
Remove-Item $inside, $outside -Force -ErrorAction SilentlyContinue

# The bubblewrap profile dsh-sandbox-local builds for workspace-write.
$profileWrite = @('--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
  '--tmpfs', '/tmp', '--bind', $Workspace, $Workspace)
# ...and for read-only: no --bind at all, so nothing is writable.
$profileReadOnly = @('--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent')

function Run-Confined($label, $profile, $scriptText) {
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
  $all = @($Shim) + $profile + @('--', $pwshExe, '-NoProfile', '-NonInteractive', '-Command', $scriptText)
  $q = ($all | ForEach-Object { '"' + $_ + '"' }) -join ' '
  cmd /c ('"' + $NodeExe + '" ' + $q + ' > "' + $out + '" 2> "' + $err + '"') | Out-Null
  $code = $LASTEXITCODE
  $so = Get-Content $out -Raw -ErrorAction SilentlyContinue
  $se = Get-Content $err -Raw -ErrorAction SilentlyContinue
  if ($null -eq $so) { $so = '' }
  if ($null -eq $se) { $se = '' }
  W "  [$label] exit=$code"
  W "        stdout='$($so.Trim())'"
  W "        stderr='$($se.Trim())'"
  return @{ code = $code; out = $so.Trim(); err = $se.Trim() }
}

W "shim      : $Shim  (exists: $(Test-Path $Shim))"
W "node      : $NodeExe"
W "workspace : $Workspace"
W ""

$passed = 0
$total = 0

W "=== A. workspace-write: a plain command runs at all ==="
$total += 1
$r = Run-Confined 'echo' $profileWrite 'Write-Output confinement-alive'
if ($r.code -eq 0 -and $r.out -match 'confinement-alive') {
  W "  RESULT: OK -- the mediator itself is healthy"
  $passed += 1
} else {
  W "  RESULT: FAIL -- nothing else here is meaningful if the mediator cannot run a command"
}

W ""
W "=== B. workspace-write: a write INSIDE the granted workspace succeeds (the control) ==="
$total += 1
$r = Run-Confined 'inside' $profileWrite ('Set-Content -Path "' + $inside + '" -Value inside-ok; Get-Content -Path "' + $inside + '"')
if ($r.code -eq 0 -and (Test-Path $inside)) {
  W "  RESULT: OK -- wrote $inside"
  $passed += 1
} else {
  W "  RESULT: FAIL -- could not write inside the granted workspace"
}

W ""
W "=== C. workspace-write: a write OUTSIDE it is refused, and leaves nothing behind ==="
$total += 1
$r = Run-Confined 'outside' $profileWrite ('Set-Content -Path "' + $outside + '" -Value should-not-exist -ErrorAction Stop; Write-Output wrote-outside')
$leftBehind = Test-Path $outside
if ($r.code -ne 0 -and -not $leftBehind) {
  W "  RESULT: OK -- refused, and no file was created"
  $passed += 1
} elseif ($leftBehind) {
  W "  RESULT: FAIL -- the file EXISTS: workspace-write is not confining anything"
} else {
  W "  RESULT: FAIL -- it failed for some other reason (see stdout/stderr above)"
}

W ""
W "=== D. read-only: the workspace is NOT writable either ==="
$total += 1
Remove-Item $inside -Force -ErrorAction SilentlyContinue
$r = Run-Confined 'read-only-write' $profileReadOnly ('Set-Content -Path "' + $inside + '" -Value should-not-exist -ErrorAction Stop; Write-Output wrote-readonly')
$readOnlyLeft = Test-Path $inside
if ($r.code -ne 0 -and -not $readOnlyLeft) {
  W "  RESULT: OK -- refused, so read-only is a policy and not a label"
  $passed += 1
} elseif ($readOnlyLeft) {
  W "  RESULT: FAIL -- read-only wrote into the workspace; the tiers are not distinct"
} else {
  W "  RESULT: FAIL -- it failed for some other reason (see stdout/stderr above)"
}

W ""
W "=== E. read-only: reads still work (a sandbox that permits nothing is not a sandbox) ==="
$total += 1
$r = Run-Confined 'read-only-read' $profileReadOnly 'Write-Output read-only-alive'
if ($r.code -eq 0 -and $r.out -match 'read-only-alive') {
  W "  RESULT: OK"
  $passed += 1
} else {
  W "  RESULT: FAIL -- read-only cannot even run a command"
}

Remove-Item $inside, $outside -Force -ErrorAction SilentlyContinue
Remove-Item $Workspace -Recurse -Force -ErrorAction SilentlyContinue

W ""
W "=== summary ==="
W "  $passed / $total checks passed"
if ($passed -eq $total) {
  W "  RESULT: SANDBOX CONFINEMENT VERIFIED -- workspace-write really restricts."
} else {
  W "  RESULT: NOT VERIFIED -- do not rely on workspace-write here."
}
W "DONE"
