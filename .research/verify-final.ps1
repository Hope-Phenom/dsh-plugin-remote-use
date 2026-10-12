# verify-final.ps1 -- acceptance test + self-check, run in the INTERACTIVE session after reboot.
$log = 'C:\dsh-remote\evidence\final.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W ("sessionId=" + (Get-Process -Id $PID).SessionId + " interactive=" + [Environment]::UserInteractive)

# B1: self-check, fully expressed, interactive
W "===== B1. self-check (interactive) ====="
& 'C:\dsh-remote\slave-selfcheck.ps1' *>&1 | ForEach-Object { W $_ }

# B2: re-enable logging off (we turned it on for diagnosis)
W ""
W "===== B2. turn VDD logging back OFF ====="
$cfg = 'C:\VirtualDisplayDriver\vdd_settings.xml'
if (Test-Path $cfg) {
  # restore from the pristine backup if it differs (backup is the original, logging=false)
  $content = Get-Content $cfg -Raw
  $content = $content -replace '<logging>true</logging>', '<logging>false</logging>'
  $content = $content -replace '<debuglogging>true</debuglogging>', '<debuglogging>false</debuglogging>'
  Set-Content -Path $cfg -Value $content -Encoding UTF8
  W ("  " + ((Select-String -Path $cfg -Pattern '<logging>|<debuglogging>').Line -join ' | '))
}

# B3: real acceptance test on the rebooted, virtual-only setup
W ""
W "===== B3. verify-criteria.ps1 (real click acceptance) ====="
Remove-Item 'C:\dsh-remote\avalonia-demo\evidence\verify-report.txt' -Force -ErrorAction SilentlyContinue
Set-Location 'C:\dsh-remote\avalonia-demo\tools'
Start-Transcript -Path 'C:\dsh-remote\evidence\final-criteria.txt' -Force | Out-Null
try {
  & '.\verify-criteria.ps1'
} catch {
  W ("TERMINATING ERROR: " + $_.Exception.Message)
  W ($_.ScriptStackTrace)
} finally {
  Stop-Transcript | Out-Null
}
if (Test-Path 'C:\dsh-remote\avalonia-demo\evidence\verify-report.txt') {
  W "--- verify-report.txt ---"
  W (Get-Content 'C:\dsh-remote\avalonia-demo\evidence\verify-report.txt' -Raw)
}
W "DONE"
