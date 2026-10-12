# fix-vdd-device.ps1 -- restart the VDD device so it re-creates its monitor.
$log = 'C:\dsh-remote\evidence\fix-vdd-device.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

$devcon = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe\Dependencies\devcon.exe"
$pkg    = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe"
W ("devcon = " + $devcon + "  exists=" + (Test-Path $devcon))

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
function Screens($tag) {
  W ("--- screens [" + $tag + "] ---")
  [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
}
Screens 'before'

W "=== devcon status ==="
W ((& $devcon status 'ROOT\DISPLAY\0000' 2>&1 | Out-String))

W "=== devcon restart ROOT\DISPLAY\0000 ==="
W ((& $devcon restart 'ROOT\DISPLAY\0000' 2>&1 | Out-String))
Start-Sleep -Seconds 8
Screens 'after restart'

W "=== if still nothing: devcon disable + enable ==="
if (-not ([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -ne '' } | Measure-Object).Count -gt 6) { }
W ((& $devcon disable 'ROOT\DISPLAY\0000' 2>&1 | Out-String))
Start-Sleep -Seconds 3
W ((& $devcon enable 'ROOT\DISPLAY\0000' 2>&1 | Out-String))
Start-Sleep -Seconds 8
Screens 'after disable/enable'

W "=== driver store: which inf backs this device? ==="
W ((& pnputil /enum-devices /instanceid 'ROOT\DISPLAY\0000' 2>&1 | Out-String))
W "DONE"
