# diag-relay.ps1 -- why is the relay not running?
$ErrorActionPreference = 'Continue'
$d = 'C:\dsh-remote\plugin-slave'
$out = 'C:\dsh-remote\diag-relay.txt'
Remove-Item $out -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $out -Append | Out-Null; $m }

W "=== DshRelay task ==="
$t = Get-ScheduledTask -TaskName 'DshRelay' -ErrorAction SilentlyContinue
if ($null -ne $t) {
  W "  State: $($t.State)"
  W "  Execute: $($t.Actions[0].Execute)"
  $args0 = $t.Actions[0].Arguments
  W "  Args(first 100): $($args0.Substring(0, [Math]::Min(100, $args0.Length)))"
  $info = Get-ScheduledTaskInfo -TaskName 'DshRelay' -ErrorAction SilentlyContinue
  W "  LastRunTime: $($info.LastRunTime)"
  W "  LastTaskResult: $($info.LastTaskResult)"
} else { W "  task does not exist" }

W "=== port 7331 ==="
if (Get-NetTCPConnection -LocalPort 7331 -State Listen -ErrorAction SilentlyContinue) { W "  LISTENING" } else { W "  not listening" }

W "=== node processes ==="
W ("  count=" + (Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count)

W "=== node on PATH ==="
$n = (Get-Command node -ErrorAction SilentlyContinue).Source
W "  $n"

W "=== relay.log ==="
$rl = Join-Path $d 'relay.log'
if (Test-Path $rl) {
  W "  size = $((Get-Item $rl).Length)"
  W (Get-Content $rl -Tail 15 | Out-String)
} else { W "  missing" }

W "=== try running relay directly on port 7399 ==="
Push-Location $d
$p = Start-Process -FilePath 'node' `
  -ArgumentList @('relay.mjs', '--port', '7399', '--token', 'diag', '--cmd-file', (Join-Path $d 'agent-spec.json'), '--selfcheck-script', (Join-Path $d 'selfcheck.ps1')) `
  -PassThru -RedirectStandardOutput 'C:\dsh-remote\diag-out.txt' -RedirectStandardError 'C:\dsh-remote\diag-err.txt' -WindowStyle Hidden
Start-Sleep -Seconds 5
W "  hasExited = $($p.HasExited)"
if (-not $p.HasExited) {
  W ("  listening 7399 = " + [bool](Get-NetTCPConnection -LocalPort 7399 -State Listen -ErrorAction SilentlyContinue))
  try { $p.Kill() } catch { }
}
W "--- stdout ---"
W (Get-Content 'C:\dsh-remote\diag-out.txt' -ErrorAction SilentlyContinue | Out-String)
W "--- stderr ---"
W (Get-Content 'C:\dsh-remote\diag-err.txt' -ErrorAction SilentlyContinue | Out-String)
Pop-Location

W "=== agent-spec.json ==="
W (Get-Content (Join-Path $d 'agent-spec.json') -Raw -ErrorAction SilentlyContinue)
W "DONE"
