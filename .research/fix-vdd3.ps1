# fix-vdd3.ps1 -- devcon restart using the HARDWARE ID (ROOT\MttVDD), not the instance id.
$log = 'C:\dsh-remote\evidence\fix-vdd3.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

$devcon = 'C:\Users\worker\AppData\Local\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe\Dependencies\devcon.exe'
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
function Screens($tag) {
  W ("--- screens [" + $tag + "] ---")
  [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
}
Screens 'before'

W "=== devcon status ROOT\MttVDD ==="
W ((& $devcon status 'ROOT\MttVDD' 2>&1 | Out-String))
W "=== devcon restart ROOT\MttVDD ==="
W ((& $devcon restart 'ROOT\MttVDD' 2>&1 | Out-String))
Start-Sleep -Seconds 10
Screens 'after restart'

W "=== devcon disable/enable ROOT\MttVDD ==="
W ((& $devcon disable 'ROOT\MttVDD' 2>&1 | Out-String))
Start-Sleep -Seconds 4
W ((& $devcon enable 'ROOT\MttVDD' 2>&1 | Out-String))
Start-Sleep -Seconds 12
Screens 'after disable/enable'

W "=== if still down: reinstall the INF ==="
$infdir = 'C:\Users\worker\AppData\Local\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe\SignedDrivers\x86\VDD'
if (([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Width -ne 1024 }).Count -eq 0) {
  W "  still WinDisc-only; running devcon update"
  W ((& $devcon update (Join-Path $infdir 'MttVDD.inf') 'ROOT\MttVDD' 2>&1 | Out-String))
  Start-Sleep -Seconds 10
  Screens 'after inf update'
}
W "DONE"
