# debug-selfcheck.ps1 -- find why slave-selfcheck.ps1 produces nothing.
$log = 'C:\dsh-remote\evidence\debug-selfcheck.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

$sc = 'C:\dsh-remote\slave-selfcheck.ps1'
W ("script exists = " + (Test-Path $sc) + " size=" + (Get-Item $sc).Length)
W ("session=" + (Get-Process -Id $PID).SessionId)

W "=== syntax check: parse the script ==="
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($sc, [ref]$null, [ref]$errs)
if ($errs -and $errs.Count -gt 0) {
  W ("PARSE ERRORS: " + $errs.Count)
  $errs | Select-Object -First 10 | ForEach-Object { W ("  line " + $_.Extent.StartLineNumber + ": " + $_.Message) }
} else { W "  parse OK" }

W "=== run it with full error capture ==="
try {
  $out = & $sc 2>&1
  W ("  returned " + @($out).Count + " objects")
  $out | Select-Object -First 40 | ForEach-Object { W ("  > " + $_) }
} catch {
  W ("EXCEPTION: " + $_.Exception.GetType().FullName)
  W ("  message : " + $_.Exception.Message)
  W ("  at line : " + $_.InvocationInfo.ScriptLineNumber)
  W ("  line    : " + $_.InvocationInfo.Line)
  W ("  stack   : " + $_.ScriptStackTrace)
}

W "=== did it write outputs? ==="
foreach ($f in 'C:\dsh-remote\selfcheck.json','C:\dsh-remote\selfcheck.txt') {
  W ("  " + $f + " exists=" + (Test-Path $f))
}
W "DONE"
