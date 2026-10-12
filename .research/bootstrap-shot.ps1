# bootstrap-shot.ps1 -- run screenshot.ps1 as the interactive user.
#
# Same reason as bootstrap-relay.ps1: an SSH session lands in session 0, where there is no
# desktop to capture. schtasks is used rather than the Cmdlet (see relay-ctl.ps1), and the
# command goes in a launcher file because schtasks caps /tr at 261 characters.
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\bootstrap-shot.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

$who = "$env:COMPUTERNAME\$env:USERNAME"
W "bootstrap-shot user=$who"

$launcher = 'C:\dsh-remote\run-shot.ps1'
Set-Content -Path $launcher -Encoding ASCII -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\dsh-remote\screenshot.ps1 -Out C:\dsh-remote\shot.png"

schtasks /delete /tn 'DshShot' /f 2>&1 | Out-Null
$tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher"
W "/tr length = $($tr.Length) (limit 261)"
$rc = (schtasks /create /tn 'DshShot' /tr $tr /sc once /st 23:59 /ru $who /rl highest /f 2>&1 | Out-String)
W "create rc=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { W "create failed: $($rc.Trim())"; W 'DONE'; exit 1 }

$rr = (schtasks /run /tn 'DshShot' 2>&1 | Out-String)
W "run rc=$LASTEXITCODE"

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  schtasks /query /tn 'DshShot' 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { break }
}
# The scheduler leaves the task present; delete it explicitly and rely on the report file.
schtasks /delete /tn 'DshShot' /f 2>&1 | Out-Null
Remove-Item $launcher -Force -ErrorAction SilentlyContinue

W "--- screenshot-report.txt ---"
W (Get-Content 'C:\dsh-remote\screenshot-report.txt' -ErrorAction SilentlyContinue | Out-String)
if (Test-Path 'C:\dsh-remote\shot.png') { W "shot.png size = $((Get-Item 'C:\dsh-remote\shot.png').Length)" }
else { W "shot.png MISSING" }
W "DONE"
