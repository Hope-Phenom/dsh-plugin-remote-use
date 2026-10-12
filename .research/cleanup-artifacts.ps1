# cleanup-artifacts.ps1 -- remove test leftovers from the worker, keep the deployment.
#
# Kept on purpose:
#   C:\dsh-remote\plugin-slave\      the relay deployment (relay.mjs, selfcheck.ps1,
#                                    screenshot.ps1, agent-spec.json, node_modules)
#   C:\dsh-remote\relay-ctl.ps1      start/stop/status control
#   C:\dsh-remote\bootstrap-relay.ps1  run relay-ctl as the interactive user
#   C:\dsh-remote\bootstrap-shot.ps1   run a one-off capture as the interactive user
#   C:\dsh-remote\screenshot.ps1     worker-side capture (standalone copy)
#   DshSelfCheckBoot / DshSelfCheckLogon / DshRelay   scheduled tasks
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\cleanup-artifacts.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "=== before ==="
W (Get-ChildItem 'C:\dsh-remote' -Force -File | Select-Object Name | Out-String)
W "p0work:"
W (Get-ChildItem 'C:\dsh-remote\p0work' -Force -ErrorAction SilentlyContinue | Select-Object Name | Out-String)
W "shots:"
W (Get-ChildItem 'C:\dsh-remote\plugin-slave\shots' -Force -ErrorAction SilentlyContinue | Select-Object Name,Length | Out-String)

# Test payloads written by delegated tasks and probes.
$payload = @(
  'C:\dsh-remote\p0work\from-model.txt',
  'C:\dsh-remote\p0work\plugin-live-proof.txt',
  'C:\dsh-remote\p0work\plugin-proof.txt',
  'C:\dsh-remote\p0work\remote-proof.txt',
  'C:\dsh-remote\p0work\image-probe.png',
  'C:\dsh-remote\p0work\selfcheck-screen.png',
  'C:\dsh-remote\p0work\sandbox-inside.txt',
  'C:\Users\worker\p0-approval-test.txt',
  'C:\Users\worker\plugin-escape-attempt.txt',
  'C:\Users\worker\approval-probe.txt',
  'C:\Users\worker\sandbox-outside.txt',
  'C:\Users\worker\sandbox-escalation.txt'
)
# Transients from bringing the relay up, from the standalone capture, and from the pwsh and
# sandbox diagnostics. NOTE: C:\dsh-remote\sandbox-mediator is NOT cleaned -- it is the
# sandbox fix itself (runner + dependency closure + shim), referenced by the profile patch.
$transient = @(
  'C:\dsh-remote\shot.png',
  'C:\dsh-remote\screenshot-report.txt',
  'C:\dsh-remote\diag-out.txt',
  'C:\dsh-remote\diag-err.txt',
  'C:\dsh-remote\diag-relay.txt',
  'C:\dsh-remote\diag-pwsh.txt',
  'C:\dsh-remote\diag-pwsh-out.txt',
  'C:\dsh-remote\diag-pwsh-err.txt',
  'C:\dsh-remote\pwsh-probe-loop.txt',
  'C:\dsh-remote\pwsh-probe-out.txt',
  'C:\dsh-remote\pwsh-probe-err.txt',
  'C:\dsh-remote\bootstrap.txt',
  'C:\dsh-remote\bootstrap-shot.txt',
  'C:\dsh-remote\bootstrap-pwsh.txt',
  'C:\dsh-remote\ctl.txt',
  'C:\dsh-remote\run-ctl.ps1',
  'C:\dsh-remote\run-shot.ps1',
  'C:\dsh-remote\run-pwsh-probe.ps1',
  'C:\dsh-remote\cleanup-p0.txt',
  'C:\dsh-remote\stop.txt',
  'C:\dsh-remote\start.txt',
  'C:\dsh-remote\shim-out.txt',
  'C:\dsh-remote\shim-err.txt',
  'C:\dsh-remote\exp-out.txt',
  'C:\dsh-remote\exp-err.txt',
  'C:\dsh-remote\acl-recon.txt',
  'C:\dsh-remote\find-native.txt',
  'C:\dsh-remote\validate-shim.txt',
  'C:\dsh-remote\sandbox-mediator-test.txt',
  'C:\dsh-remote\plugin-slave\ctl.txt',
  'C:\dsh-remote\plugin-slave\start.txt',
  'C:\dsh-remote\plugin-slave\stop.txt',
  'C:\dsh-remote\plugin-slave\screenshot-report.txt'
)

foreach ($f in ($payload + $transient)) {
  if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue; W "removed $f" }
}

# Captured frames accumulate at ~10 MB each; the relay recreates the directory on demand.
$shots = 'C:\dsh-remote\plugin-slave\shots'
if (Test-Path $shots) {
  $n = (Get-ChildItem $shots -File -ErrorAction SilentlyContinue | Measure-Object).Count
  Remove-Item "$shots\*" -Force -Recurse -ErrorAction SilentlyContinue
  W "cleared $n captured frame(s) from $shots"
}

foreach ($t in 'DshCtl', 'DshShot', 'DshPwshProbe', 'DshCleanup', 'DshStopRelay', 'DshStartRelay') {
  schtasks /delete /tn $t /f 2>&1 | Out-Null
}

W ""
W "=== after: C:\dsh-remote (kept) ==="
W (Get-ChildItem 'C:\dsh-remote' -Force | Select-Object Name | Out-String)
W "=== after: plugin-slave ==="
W (Get-ChildItem 'C:\dsh-remote\plugin-slave' -Force | Select-Object Name | Out-String)
W "=== after: p0work ==="
W (Get-ChildItem 'C:\dsh-remote\p0work' -Force -ErrorAction SilentlyContinue | Select-Object Name | Out-String)
W "=== scheduled tasks ==="
W ((schtasks /query /fo table /nh 2>&1 | Select-String 'Dsh') -join "`n")
W "=== relay ==="
W $(if (Get-NetTCPConnection -LocalPort 7331 -State Listen -ErrorAction SilentlyContinue) { 'listening' } else { 'NOT listening' })
W "=== free space ==="
W ((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | ForEach-Object { [math]::Round($_.FreeSpace/1GB,1).ToString() + ' GB' }) -join '')
W "RESULT: DONE"
