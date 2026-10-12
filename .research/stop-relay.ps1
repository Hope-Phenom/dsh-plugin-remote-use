# stop-relay.ps1 -- stop the plugin relay and clean up its task/firewall rule.
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\plugin-slave\stop.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "=== stopping relay ==="
Stop-ScheduledTask -TaskName 'DshRelay' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
schtasks /delete /tn DshRelay /f 2>&1 | Out-Null
schtasks /delete /tn DshStartRelay /f 2>&1 | Out-Null
W "tasks removed"

W "=== firewall ==="
Remove-NetFirewallRule -Name 'dsh-relay-7331' -ErrorAction SilentlyContinue
W ("rule present: " + [bool](Get-NetFirewallRule -Name 'dsh-relay-7331' -ErrorAction SilentlyContinue))

W "=== test artefacts (keep the deployment, drop the evidence files) ==="
Remove-Item 'C:\Users\worker\plugin-escape-attempt.txt' -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\dsh-remote\p0work\plugin-proof.txt' -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\dsh-remote\p0work\remote-proof.txt' -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\Users\worker\p0-relay-test.txt' -Force -ErrorAction SilentlyContinue

W "=== final state ==="
W ("port 7331 listening: " + $(if (Get-NetTCPConnection -LocalPort 7331 -State Listen -ErrorAction SilentlyContinue) { 'YES' } else { 'no (clean)' }))
W ("node processes     : " + (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count)
W ("escape file        : " + (Test-Path 'C:\Users\worker\plugin-escape-attempt.txt'))
W "remaining Dsh tasks:"
W ((schtasks /query /fo table /nh 2>&1 | Select-String 'Dsh') -join "`n")
W "selfcheck verdict (from the plugin RPC's last run):"
W (Get-Content 'C:\dsh-remote\plugin-slave\selfcheck.txt' -TotalCount 1 -ErrorAction SilentlyContinue)
W "deployment kept at C:\dsh-remote\plugin-slave"
W "DONE"
