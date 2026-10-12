# cleanup-artifacts.ps1 -- remove test leftovers from the worker, keep the deployment.
#
# Kept on purpose:
#   C:\dsh-remote\plugin-slave\      the relay deployment (relay.mjs, selfcheck.ps1, agent-spec.json, node_modules)
#   C:\dsh-remote\relay-ctl.ps1      start/stop/status control
#   C:\dsh-remote\bootstrap-relay.ps1  run relay-ctl as the interactive user
#   C:\dsh-remote\screenshot.ps1     worker-side capture
#   C:\dsh-remote\bootstrap-shot.ps1   run screenshot as the interactive user
#   DshSelfCheckBoot / DshSelfCheckLogon / DshRelay   scheduled tasks
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\cleanup-artifacts.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "=== before ==="
W (Get-ChildItem 'C:\dsh-remote' -Force | Select-Object Name | Out-String)
W (Get-ChildItem 'C:\dsh-remote\p0work' -Force -ErrorAction SilentlyContinue | Select-Object Name | Out-String)

# Test payloads written by delegated tasks.
$payload = @(
  'C:\dsh-remote\p0work\from-model.txt',
  'C:\dsh-remote\p0work\plugin-live-proof.txt',
  'C:\dsh-remote\p0work\plugin-proof.txt',
  'C:\dsh-remote\p0work\remote-proof.txt',
  'C:\Users\worker\p0-approval-test.txt',
  'C:\Users\worker\plugin-escape-attempt.txt'
)
# Diagnostics and transients produced while bringing the relay up.
$transient = @(
  'C:\dsh-remote\shot.png',
  'C:\dsh-remote\diag-out.txt',
  'C:\dsh-remote\diag-err.txt',
  'C:\dsh-remote\diag-relay.txt',
  'C:\dsh-remote\bootstrap.txt',
  'C:\dsh-remote\bootstrap-shot.txt',
  'C:\dsh-remote\screenshot-report.txt',
  'C:\dsh-remote\ctl.txt',
  'C:\dsh-remote\run-ctl.ps1',
  'C:\dsh-remote\run-shot.ps1',
  'C:\dsh-remote\cleanup-p0.txt',
  'C:\dsh-remote\stop.txt',
  'C:\dsh-remote\start.txt'
)

foreach ($f in ($payload + $transient)) {
  if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue; W "removed $f" }
}

# Kick off the log tasks so nothing re-creates diagnostics at shutdown.
foreach ($t in 'DshCtl', 'DshShot', 'DshCleanup', 'DshStopRelay', 'DshStartRelay') {
  schtasks /delete /tn $t /f 2>&1 | Out-Null
}

W ""
W "=== after: C:\dsh-remote ==="
W (Get-ChildItem 'C:\dsh-remote' -Force | Select-Object Name | Out-String)
W "=== after: p0work ==="
W (Get-ChildItem 'C:\dsh-remote\p0work' -Force -ErrorAction SilentlyContinue | Select-Object Name | Out-String)
W "=== remaining scheduled tasks ==="
W ((schtasks /query /fo table /nh 2>&1 | Select-String 'Dsh') -join "`n")
W "=== relay still listening? ==="
W $(if (Get-NetTCPConnection -LocalPort 7331 -State Listen -ErrorAction SilentlyContinue) { 'yes' } else { 'NO' })
W "RESULT: DONE"
