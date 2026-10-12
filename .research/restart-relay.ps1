# restart-relay.ps1 -- (re)register and start the P0 relay with the restricted-sandbox spec.
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\restart-relay.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

# 1) make sure the sandbox is restricted so approval requests are produced
W "=== generating launch spec (workspace-write) ==="
W (& node C:\dsh-remote\relay\make-launch-spec.mjs --profile acp --permission-mode workspace-write --out C:\dsh-remote\relay\agent-spec.json 2>&1 | Out-String)

# 2) re-register + start the relay task
W "=== (re)registering relay task ==="
Stop-ScheduledTask -TaskName 'DshRelayP0' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
schtasks /delete /tn DshRelayP0 /f 2>&1 | Out-Null
Remove-Item 'C:\dsh-remote\relay.log' -Force -ErrorAction SilentlyContinue

$inner = "& node C:\dsh-remote\relay\relay.mjs --port 7331 --token p0test --cmd-file C:\dsh-remote\relay\agent-spec.json --verbose *> C:\dsh-remote\relay.log"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + $enc)
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'DshRelayP0' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
W "registered"

if (-not (Get-NetFirewallRule -Name 'dsh-relay-7331' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'dsh-relay-7331' -DisplayName 'DSH relay P0' -Direction Inbound -Protocol TCP -LocalPort 7331 -Action Allow -Profile Any | Out-Null
  W "firewall rule added"
} else { W "firewall rule present" }

Start-ScheduledTask -TaskName 'DshRelayP0'
W "started"
Start-Sleep -Seconds 8

W "=== state ==="
W ("task state      = " + (Get-ScheduledTask -TaskName 'DshRelayP0').State)
W ("lastTaskResult  = " + (Get-ScheduledTaskInfo -TaskName 'DshRelayP0').LastTaskResult)
$l = Get-NetTCPConnection -LocalPort 7331 -State Listen -ErrorAction SilentlyContinue
W ("listening       = " + $(if ($l) { ($l | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }) -join ',' } else { 'NO' }))
W ("node procs      = " + ((Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count))
W "=== relay.log ==="
W (Get-Content 'C:\dsh-remote\relay.log' -ErrorAction SilentlyContinue | Out-String)
W "=== healthz (localhost) ==="
try { W (Invoke-WebRequest 'http://127.0.0.1:7331/healthz' -UseBasicParsing -TimeoutSec 5).Content } catch { W ("health failed: " + $_.Exception.Message) }
W "DONE"
