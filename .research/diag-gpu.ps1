# diag-gpu.ps1 -- does the "default" GPU friendly name resolve? VDD needs a render GPU.
$log = 'C:\dsh-remote\evidence\gpu.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "=== GPU friendly names as VDD's config expects ('friendlyname') ==="
Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {
  W ("  Name        = '" + $_.Name + "'")
  W ("    PNPDeviceID = " + $_.PNPDeviceID)
  W ("    DriverVer   = " + $_.DriverVersion)
  W ("    VideoMode   = " + $_.VideoModeDescription)
  W ("    Availability= " + $_.Availability)
  W ("    Status      = " + $_.Status)
}
W ""
W "=== registry: DXGI adapters as the driver would see them ==="
$k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\VideoSettingsGPUPreference'
if (Test-Path $k) { Get-ItemProperty $k | Format-List | Out-String | ForEach-Object { W $_ } } else { W "  (no GPU preference key)" }

W ""
W "=== VDD driver service state ==="
$svc = Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'mttvdd|vdd' }
if ($svc) { $svc | Select-Object Name,State,Status,PathName | Format-List | Out-String | ForEach-Object { W $_ } } else { W "  (VDD is UMDF -> look under WUDF)" }
Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue | Where-Object { $_.PathName -match 'MttVDD|UMDF' } |
  Select-Object Name,State,PathName | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }

W ""
W "=== device problem code + install state ==="
W ((& pnputil /enum-devices /instanceid 'ROOT\DISPLAY\0000' /drivers 2>&1 | Out-String))

W ""
W "=== is there a monitor child device under the VDD adapter? ==="
$m = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'MTT1337|DISPLAY\\MTT' }
if ($m) { $m | Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ } } else { W "  NO monitor device with MTT1337 hardware id (it existed before the reboot!)" }
W "  --- all monitor-class devices ---"
Get-PnpDevice -Class Monitor -ErrorAction SilentlyContinue | Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }

W ""
W "=== vdd_settings.xml content hash vs backup ==="
$cfg='C:\VirtualDisplayDriver\vdd_settings.xml'; $bak=$cfg+'.bak'
foreach ($f in @($cfg,$bak)) { if (Test-Path $f) { W ("  " + $f + "  sha256=" + (Get-FileHash $f -Algorithm SHA256).Hash.Substring(0,16) + "  size=" + (Get-Item $f).Length) } }
W "DONE"
