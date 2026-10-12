# bootstrap-relay.ps1 -- run relay-ctl.ps1 as the interactive user.
#
# NEEDED because an SSH session lands in session 0, where there is no desktop and the
# user's credentials are not loaded -- exactly the two things the relay requires.
#
# ASCII-ONLY ON PURPOSE. Windows PowerShell 5.1 reads a BOM-less file as ANSI, so any
# non-ASCII byte (a Chinese comment, a localized string) corrupts parsing and the script
# dies with "TerminatorExpectedAtEndOfString" on an unrelated line. Never put non-ASCII
# text in a .ps1 here, and never match localized cmdlet output -- compare exit codes.
#
# Invoked with: -Action start -Token <secret>   (or -Action status / stop)
param(
  [string]$Action = 'status',
  [string]$Token = ''
)
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\bootstrap.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

$who = "$env:COMPUTERNAME\$env:USERNAME"
W "bootstrap action=$Action user=$who"

# schtasks caps the /tr value at 261 characters, so the (token-bearing) command goes into
# a small launcher file and the task definition stays short. The file holds the shared
# secret, so it is ACL-trimmed and deleted once the run finishes.
$arg = "-NoProfile -ExecutionPolicy Bypass -File C:\dsh-remote\relay-ctl.ps1 -Action $Action"
if ($Token -ne '') { $arg += " -Token `"$Token`"" }
$launcher = 'C:\dsh-remote\run-ctl.ps1'
Set-Content -Path $launcher -Value "powershell.exe $arg" -Encoding ASCII
try { icacls $launcher /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1 | Out-Null } catch { }

schtasks /delete /tn 'DshCtl' /f 2>&1 | Out-Null
# schtasks rather than the Cmdlet: see the note in relay-ctl.ps1.
$tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher"
W "/tr length = $($tr.Length) (limit 261)"
$rc = (schtasks /create /tn 'DshCtl' /tr $tr /sc once /st 23:59 /ru $who /rl highest /f 2>&1 | Out-String)
W "create rc=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { W "create failed: $($rc.Trim())"; Remove-Item $launcher -Force -EA SilentlyContinue; W 'DONE'; exit 1 }

$rr = (schtasks /run /tn 'DshCtl' 2>&1 | Out-String)
W "run rc=$LASTEXITCODE"

# relay-ctl does its own waiting; poll until the bootstrap task is gone. Checking the
# task's existence via schtasks' exit code avoids parsing localized status labels.
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  schtasks /query /tn 'DshCtl' 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { break }
}
schtasks /query /tn 'DshCtl' 2>&1 | Out-Null
W "bootstrap task still present: $($LASTEXITCODE -eq 0)"

W "--- ctl.txt ---"
W (Get-Content 'C:\dsh-remote\plugin-slave\ctl.txt' -ErrorAction SilentlyContinue | Out-String)
schtasks /delete /tn 'DshCtl' /f 2>&1 | Out-Null
Remove-Item $launcher -Force -ErrorAction SilentlyContinue
W "DONE"
