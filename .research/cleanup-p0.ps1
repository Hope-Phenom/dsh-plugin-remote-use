# cleanup-p0.ps1 -- stop the P0 relay and remove its task/firewall rule; keep the self-check tasks.
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\cleanup-p0.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "=== stopping relay ==="
Stop-ScheduledTask -TaskName 'DshRelayP0' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
foreach ($n in 'DshRelayP0','DshRelayStart','DshFixS9','DshFixS10','DshSC2','DshSCFinal','DshDbgSC','DshVdd','DshVdd2','DshVdd3') {
  schtasks /delete /tn $n /f 2>&1 | Out-Null
}
W "temp tasks removed"

W "=== removing firewall rule ==="
Remove-NetFirewallRule -Name 'dsh-relay-7331' -ErrorAction SilentlyContinue
W ("rule present: " + [bool](Get-NetFirewallRule -Name 'dsh-relay-7331' -ErrorAction SilentlyContinue))

W "=== regenerating launch spec with DEFAULT permission mode ==="
# leave the machine in its natural state: workspace-write is the base default, so an
# unset DSH_PERMISSION_MODE is the honest configuration to persist.
W (& node C:\dsh-remote\relay\make-launch-spec.mjs --profile acp --out C:\dsh-remote\relay\agent-spec.json 2>&1 | Select-Object -First 3 | Out-String)

W "=== final state ==="
W ("port 7331 listening: " + $(if (Get-NetTCPConnection -LocalPort 7331 -State Listen -ErrorAction SilentlyContinue) { 'YES' } else { 'no (clean)' }))
W ("node processes     : " + (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count)
W "remaining Dsh tasks:"
W ((schtasks /query /fo table /nh 2>&1 | Select-String 'Dsh') -join "`n")
W ("leftover test file : " + (Test-Path 'C:\Users\worker\p0-approval-test.txt'))
W "selfcheck verdict:"
W (Get-Content 'C:\dsh-remote\selfcheck.txt' -TotalCount 1 -ErrorAction SilentlyContinue)
W "DONE"
