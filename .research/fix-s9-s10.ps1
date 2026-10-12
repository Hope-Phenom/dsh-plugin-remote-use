# fix-s9-s10.ps1 -- close out the two self-check findings.
$log = 'C:\dsh-remote\evidence\fix-s9-s10.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

function PwrIdx($sub, $set) {
  $o = & powercfg /q SCHEME_CURRENT $sub $set 2>&1 | Out-String
  $m = [regex]::Matches($o, '0x[0-9a-fA-F]{8}')
  if ($m.Count -ge 2) { return @([Convert]::ToInt64($m[$m.Count-2].Value,16), [Convert]::ToInt64($m[$m.Count-1].Value,16)) }
  return @(-1,-1)
}

W "=== BEFORE ==="
W ("  STANDBYIDLE    AC/DC = " + ((PwrIdx 'SUB_SLEEP' 'STANDBYIDLE') -join '/'))
W ("  HIBERNATEIDLE  AC/DC = " + ((PwrIdx 'SUB_SLEEP' 'HIBERNATEIDLE') -join '/'))
W ("  ScreenSaveActive      = " + (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -ErrorAction SilentlyContinue).ScreenSaveActive)

W "=== S9: disable sleep on BOTH AC and DC ==="
& powercfg /change standby-timeout-ac 0
& powercfg /change standby-timeout-dc 0
& powercfg /change hibernate-timeout-ac 0
& powercfg /change hibernate-timeout-dc 0
& powercfg /change disk-timeout-ac 0
& powercfg /change disk-timeout-dc 0
W "  applied all six"

W "=== S10: screensaver off ==="
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -Value '0' -Type String -Force
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveTimeOut -Value '0' -Type String -Force
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaverIsSecure -Value '0' -Type String -Force
W ("  ScreenSaveActive = " + (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive).ScreenSaveActive)

W "=== AFTER ==="
W ("  STANDBYIDLE    AC/DC = " + ((PwrIdx 'SUB_SLEEP' 'STANDBYIDLE') -join '/'))
W ("  HIBERNATEIDLE  AC/DC = " + ((PwrIdx 'SUB_SLEEP' 'HIBERNATEIDLE') -join '/'))
W "DONE"
