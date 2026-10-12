# sandbox-mediator-test.ps1 -- does a console-subsystem mediator fix 0xC0000142?
#
# HYPOTHESIS UNDER TEST (third-party, unverified -- a claim to check, not a fact):
#   `dsh-sandbox-local` builds the mediator invocation from `process.execPath`. In an ACP
#   session started by our relay that is `DeepSeek Harness.exe`, a GUI-subsystem image,
#   which Windows never auto-allocates a console to. The restricted-token child then has no
#   console to inherit and dies during DLL init with 0xC0000142 (STATUS_DLL_INIT_FAILED).
#   A console-subsystem mediator (`node.exe`) is claimed to work instead.
#
# METHOD: same runner, same mode, same payload -- only the interpreter changes.
#
# MEASUREMENT NOTES (each of these bit an earlier version of this experiment):
#   * `Start-Process -PassThru` left ExitCode EMPTY after a timed WaitForExit, so every run
#     looked failed and the verdict read "REFUTED" while stdout showed the child had run.
#     `cmd /c ... > out 2> err` plus $LASTEXITCODE is reliable.
#   * A bundle that cannot LOAD the runner is not evidence about the sandbox. Such runs are
#     marked INVALID and excluded, or a missing dependency reads as a broken sandbox.
#   * Exit code alone is weak here, so success is ALSO read from the payload's own stdout,
#     which is deterministic by construction.
#
# ASCII-only and PowerShell 5.1 syntax only: the worker runs 5.1 and reads a BOM-less file
# as ANSI, so one non-ASCII byte would break parsing.
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $PSScriptRoot 'sandbox-mediator-test.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { Write-Output $m; Add-Content -Path $log -Value $m -Encoding UTF8 }

$mediator = 'C:\dsh-remote\sandbox-mediator'
$runner = Join-Path $mediator 'node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$electronExe = 'C:\Users\worker\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$pwshExe = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
$workspace = 'C:\dsh-remote\p0work'
$tempRoot = Join-Path $env:TEMP 'sandbox-probe-temp'
$outFile = Join-Path $PSScriptRoot 'exp-out.txt'
$errFile = Join-Path $PSScriptRoot 'exp-err.txt'

W "=== preconditions ==="
W "  runner.js        : $(Test-Path $runner)"
W "  node.exe         : $(Test-Path $nodeExe)"
W "  DeepSeek Harness : $(Test-Path $electronExe)"
W "  pwsh             : $(Test-Path $pwshExe)"
W "  workspace        : $(Test-Path $workspace)"
New-Item -ItemType Directory -Force $tempRoot | Out-Null
W "  temp root        : $tempRoot"
W ""

$script:results = @()

function Quote-Arg($a) { return '"' + ($a -replace '"', '\"') + '"' }

function Try-Run($label, $interp, $electronAsNode, $mode, $payloadLabel, $payloadArgs) {
  $all = @($runner, '--workspace', $workspace, '--temp', $tempRoot, '--mode', $mode, '--') + $payloadArgs
  $quoted = ($all | ForEach-Object { Quote-Arg $_ }) -join ' '
  $cmdLine = (Quote-Arg $interp) + ' ' + $quoted + ' > ' + (Quote-Arg $outFile) + ' 2> ' + (Quote-Arg $errFile)

  Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue

  $saved = $env:ELECTRON_RUN_AS_NODE
  if ($electronAsNode) { $env:ELECTRON_RUN_AS_NODE = '1' } else { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }

  $t0 = Get-Date
  cmd /c $cmdLine | Out-Null
  $code = $LASTEXITCODE
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds

  if ($null -eq $saved) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $saved }

  $hex = ''
  if ($code -is [int]) { $hex = '0x' + ('{0:X8}' -f $code) }
  $so = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
  $se = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
  if ($null -eq $so) { $so = '' }
  if ($null -eq $se) { $se = '' }
  $so = $so.Trim()
  $se = $se.Trim()
  $soShort = $so
  $seShort = $se
  if ($soShort.Length -gt 200) { $soShort = $soShort.Substring(0, 200) + '...' }
  if ($seShort.Length -gt 360) { $seShort = $seShort.Substring(0, 360) + '...' }

  $invalid = ''
  if ($se -match 'ERR_MODULE_NOT_FOUND|Cannot find package|MODULE_NOT_FOUND|Cannot find module') { $invalid = 'module-not-found' }

  # Success is read from the payload's own stdout, which the payload controls.
  $payloadOk = $false
  if ($payloadLabel -eq 'pwsh') { $payloadOk = ($so -match 'sandbox-child-alive') }
  elseif ($payloadLabel -eq 'cmd') { $payloadOk = ($code -eq 0) }

  $verdict = 'FAIL'
  if ($invalid -ne '') { $verdict = 'INVALID' }
  elseif ($payloadOk) { $verdict = 'OK' }

  W "  [$verdict] $label"
  W "        exit=$code $hex  ${ms}ms  payloadOk=$payloadOk"
  W "        stdout: $soShort"
  W "        stderr: $seShort"
  if ($invalid -ne '') { W "        INVALID RUN ($invalid): says nothing about the hypothesis" }

  $script:results += [pscustomobject]@{
    Label = $label
    Interp = (Split-Path $interp -Leaf)
    Payload = $payloadLabel
    Mode = $mode
    Exit = $code
    Hex = $hex
    Ms = $ms
    Invalid = $invalid
    Ok = $payloadOk
  }
}

$cmdPayload = @('cmd', '/c', 'exit', '0')
$pwshPayload = @($pwshExe, '-NoProfile', '-Command', 'Write-Output sandbox-child-alive')

W "=== A. read-only probe: cmd /c exit 0 (the shape DSH's own probe uses) ==="
Try-Run 'node.exe + read-only + cmd' $nodeExe $false 'read-only' 'cmd' $cmdPayload
Try-Run 'Electron + read-only + cmd' $electronExe $true 'read-only' 'cmd' $cmdPayload

W ""
W "=== B. the real payload: pwsh through workspace-write (our failing case) ==="
Try-Run 'node.exe + workspace-write + pwsh #1' $nodeExe $false 'workspace-write' 'pwsh' $pwshPayload
Try-Run 'Electron + workspace-write + pwsh #1' $electronExe $true 'workspace-write' 'pwsh' $pwshPayload
Try-Run 'node.exe + workspace-write + pwsh #2' $nodeExe $false 'workspace-write' 'pwsh' $pwshPayload
Try-Run 'Electron + workspace-write + pwsh #2' $electronExe $true 'workspace-write' 'pwsh' $pwshPayload
Try-Run 'node.exe + workspace-write + pwsh #3' $nodeExe $false 'workspace-write' 'pwsh' $pwshPayload
Try-Run 'Electron + workspace-write + pwsh #3' $electronExe $true 'workspace-write' 'pwsh' $pwshPayload

W ""
W "=== summary ==="
foreach ($r in $script:results) {
  W ("  {0,-42} {1,-22} exit={2,-12} ok={3} {4}" -f $r.Label, $r.Interp, $r.Exit, $r.Ok, $r.Invalid)
}

$valid = @($script:results | Where-Object { $_.Invalid -eq '' })
$invalid = @($script:results | Where-Object { $_.Invalid -ne '' })
$nodeRuns = @($valid | Where-Object { $_.Interp -eq 'node.exe' })
$elecRuns = @($valid | Where-Object { $_.Interp -eq 'DeepSeek Harness.exe' })
$nodeOk = @($nodeRuns | Where-Object { $_.Ok }).Count
$elecOk = @($elecRuns | Where-Object { $_.Ok }).Count

W ""
W "  valid runs  : $($valid.Count) / $($script:results.Count)"
W "  invalid runs: $($invalid.Count)  (runner never loaded -- no bearing on the hypothesis)"
W "  node.exe            : $nodeOk/$($nodeRuns.Count) succeeded"
W "  DeepSeek Harness.exe: $elecOk/$($elecRuns.Count) succeeded"
W ""
if ($nodeRuns.Count -eq 0 -or $elecRuns.Count -eq 0) {
  W "  VERDICT: INCONCLUSIVE -- too few valid runs to compare."
} elseif ($nodeOk -gt 0 -and $elecOk -eq 0) {
  W "  VERDICT: HYPOTHESIS SUPPORTED -- the mediator interpreter is the variable."
  W "           A console-subsystem mediator runs the restricted child; the GUI one does not."
  W "           Product-side fix: point sandbox-local's runnerCommand at a console interpreter."
} elseif ($nodeOk -eq 0 -and $elecOk -eq 0) {
  W "  VERDICT: HYPOTHESIS REFUTED -- both mediators fail; the interpreter is not the cause."
} elseif ($nodeOk -eq 0 -and $elecOk -gt 0) {
  W "  VERDICT: HYPOTHESIS INVERTED -- the GUI mediator works and node.exe does not."
} else {
  W "  VERDICT: BOTH SUCCEEDED -- the sandbox may be a no-op here; verify a restricted"
  W "           token was actually created before drawing any conclusion."
}
W "RESULT: DONE"
