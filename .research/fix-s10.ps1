# fix-s10.ps1 -- screensaver off in the USER's hive (SYSTEM's HKCU is a different hive).
$log = 'C:\dsh-remote\evidence\fix-s10.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W ("running session = " + (Get-Process -Id $PID).SessionId)
W ("UserInteractive  = " + [Environment]::UserInteractive)

W "=== BEFORE (current user's hive) ==="
foreach ($n in 'ScreenSaveActive','ScreenSaveTimeOut','ScreenSaverIsSecure') {
  W ("  " + $n + " = '" + (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name $n -ErrorAction SilentlyContinue).$n + "'")
}
W "--- current SID ---"
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
W ("  " + $sid + "  user=" + [Environment]::UserName)

W "=== apply in this hive ==="
foreach ($n in 'ScreenSaveActive','ScreenSaveTimeOut','ScreenSaverIsSecure') {
  New-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name $n -Value '0' -PropertyType String -Force | Out-Null
}
foreach ($n in 'ScreenSaveActive','ScreenSaveTimeOut','ScreenSaverIsSecure') {
  W ("  " + $n + " = '" + (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name $n).$n + "'")
}

W "=== also fix the loaded sheng hive explicitly (if a different SID is mounted) ==="
$shengSid = (Get-CimInstance Win32_UserAccount -Filter "Name='sheng'" -ErrorAction SilentlyContinue | Select-Object -First 1).SID
W ("  sheng SID = " + $shengSid)
if ($shengSid) {
  $path = "Registry::HKEY_USERS\$shengSid\Control Panel\Desktop"
  if (Test-Path $path) {
    foreach ($n in 'ScreenSaveActive','ScreenSaveTimeOut','ScreenSaverIsSecure') {
      New-ItemProperty -Path $path -Name $n -Value '0' -PropertyType String -Force | Out-Null
    }
    W ("  HKU\$shengSid updated: ScreenSaveActive=" + (Get-ItemProperty $path -Name ScreenSaveActive).ScreenSaveActive)
  } else { W "  HKU\$shengSid\Control Panel\Desktop not mounted" }
}
W "DONE"
