# bootstrap-pwsh-probe.ps1 -- run pwsh-probe-loop.ps1 as the interactive user.
#
# Same reason as bootstrap-relay.ps1: an SSH session lands in session 0, where pwsh works
# and the failure does not reproduce. schtasks rather than the Cmdlet (see relay-ctl.ps1),
# and the command goes in a launcher file because schtasks caps /tr at 261 characters.
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\bootstrap-pwsh.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

$who = "$env:COMPUTERNAME\$env:USERNAME"
W "bootstrap-pwsh user=$who at $(Get-Date -Format 'HH:mm:ss.fff')"

$launcher = 'C:\dsh-remote\run-pwsh-probe.ps1'
Set-Content -Path $launcher -Encoding ASCII -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\dsh-remote\pwsh-probe-loop.ps1"

schtasks /delete /tn 'DshPwshProbe' /f 2>&1 | Out-Null
$tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher"
W "/tr length = $($tr.Length)"
$rc = (schtasks /create /tn 'DshPwshProbe' /tr $tr /sc once /st 23:59 /ru $who /rl highest /f 2>&1 | Out-String)
W "create rc=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { W "create failed: $($rc.Trim())"; W 'DONE'; exit 1 }

$rr = (schtasks /run /tn 'DshPwshProbe' 2>&1 | Out-String)
W "run rc=$LASTEXITCODE at $(Get-Date -Format 'HH:mm:ss.fff')"

# Do NOT wait: the host captures screenshots while the loop runs. It prints the window so
# the caller knows when to start capturing.
W "WINDOW_START=$(Get-Date -Format 'HH:mm:ss.fff')"
W "expected duration: about 25 seconds"
W 'DONE'
