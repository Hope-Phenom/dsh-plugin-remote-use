# diag-relay-down.ps1 -- why is the relay not listening, when SSH still works?
#
# Order matters: the FIRST question is whether an interactive session exists at all. The
# relay is registered AtLogOn and must run as the credential-owning user, so "machine up,
# SSH fine, relay absent" is the expected shape of a reboot with nobody logged in -- which
# the design treats as an operational state, not a fault.
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $PSScriptRoot 'diag-relay-down.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { [Console]::WriteLine($m); Add-Content -Path $log -Value $m -Encoding UTF8 }

W "=== boot / uptime ==="
$os = Get-CimInstance Win32_OperatingSystem -EA SilentlyContinue
if ($null -ne $os) {
  W ("  last boot : " + $os.LastBootUpTime)
  W ("  uptime    : " + [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalMinutes, 1) + " minutes")
}

W ""
W "=== logged-on / interactive sessions ==="
$sessions = query session 2>&1
$sessions | ForEach-Object { W ("  " + $_) }

W ""
W "=== explorer.exe (an interactive desktop exists only if this runs) ==="
$explorer = @(Get-Process explorer -EA SilentlyContinue)
W ("  explorer processes: " + $explorer.Count)
$explorer | ForEach-Object { W ("    pid=" + $_.Id + " session=" + $_.SessionId) }

W ""
W "=== relay-related processes ==="
foreach ($n in 'node', 'DeepSeek Harness') {
  $p = @(Get-Process -Name $n -EA SilentlyContinue)
  W ("  " + $n + ": " + $p.Count)
  $p | Select-Object -First 4 | ForEach-Object { W ("    pid=" + $_.Id + " session=" + $_.SessionId + " started=" + $_.StartTime) }
}

W ""
W "=== port 7331 ==="
$conn = @(Get-NetTCPConnection -LocalPort 7331 -EA SilentlyContinue)
W ("  listeners/connections: " + $conn.Count)
$conn | Select-Object -First 5 | ForEach-Object { W ("    " + $_.State + " " + $_.LocalAddress + ":" + $_.LocalPort + " pid=" + $_.OwningProcess) }

W ""
W "=== scheduled tasks ==="
foreach ($t in 'DshRelay', 'DshSelfCheckBoot', 'DshSelfCheckLogon') {
  $out = schtasks /query /tn $t /fo list 2>&1
  if ($LASTEXITCODE -ne 0) { W ("  " + $t + ": NOT FOUND") ; continue }
  $status = ($out | Select-String -Pattern 'Status|Next Run|Last Run|Last Result' | ForEach-Object { $_.Line.Trim() }) -join ' | '
  W ("  " + $t + ": " + $status)
}

W ""
W "=== relay log tail ==="
$rl = 'C:\dsh-remote\plugin-slave\relay.log'
if (Test-Path $rl) {
  $info = Get-Item $rl
  W ("  size=" + $info.Length + " modified=" + $info.LastWriteTime)
  Get-Content $rl -Tail 12 -EA SilentlyContinue | ForEach-Object { W ("    " + $_) }
} else {
  W "  (no relay.log)"
}

W ""
W "=== last 20 system events in the System log (shutdown/restart causes) ==="
Get-EventLog -LogName System -Newest 40 -EA SilentlyContinue |
  Where-Object { $_.EventID -in 6005, 6006, 6008, 1074, 41, 1076 } |
  Select-Object -First 8 |
  ForEach-Object { W ("  " + $_.TimeGenerated + "  id=" + $_.EventID + "  " + ($_.Message -split "`n")[0]) }

W "RESULT: DONE"
