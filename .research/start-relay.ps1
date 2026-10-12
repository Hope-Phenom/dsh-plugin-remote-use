# start-relay.ps1 -- start the plugin relay as the credential-owning user in the interactive session.
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\plugin-slave\start.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

$d = 'C:\dsh-remote\plugin-slave'
W ("session=$((Get-Process -Id $PID).SessionId) interactive=$([Environment]::UserInteractive)")
W ("USERPROFILE=$env:USERPROFILE")
W ("credentials present: " + (Test-Path "$env:USERPROFILE\.dsh\.credentials.yaml"))
W ("agent-spec present : " + (Test-Path "$d\agent-spec.json"))
W ("selfcheck present  : " + (Test-Path "$d\selfcheck.ps1"))

# stop any previous instance
Stop-ScheduledTask -TaskName 'DshRelay' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
schtasks /delete /tn DshRelay /f 2>&1 | Out-Null
Remove-Item "$d\relay.log" -Force -ErrorAction SilentlyContinue

$inner = "& node $d\relay.mjs --port 7331 --token p0test --cmd-file $d\agent-spec.json --selfcheck-script $d\selfcheck.ps1 --verbose *> $d\relay.log"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + $enc)
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'DshRelay' -Action $action -Principal $principal -Settings $settings -Force | Out-Null

if (-not (Get-NetFirewallRule -Name 'dsh-relay-7331' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'dsh-relay-7331' -DisplayName 'DSH relay 7331' -Direction Inbound -Protocol TCP -LocalPort 7331 -Action Allow -Profile Any | Out-Null
  W "firewall rule added"
}

Start-ScheduledTask -TaskName 'DshRelay'
Start-Sleep -Seconds 8
W ("task state: " + (Get-ScheduledTask -TaskName 'DshRelay').State)
$l = Get-NetTCPConnection -LocalPort 7331 -State Listen -ErrorAction SilentlyContinue
W ("listening: " + $(if ($l) { ($l | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }) -join ',' } else { 'NO' }))
W "--- relay.log ---"
W (Get-Content "$d\relay.log" -ErrorAction SilentlyContinue | Out-String)
W "DONE"
