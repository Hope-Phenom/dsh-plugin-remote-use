# fix-vdd2.ps1 -- restart the VDD device with the CORRECT devcon path.
$log = 'C:\dsh-remote\evidence\fix-vdd2.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

# hard-coded to the build user's profile: SYSTEM's LOCALAPPDATA points at systemprofile
$base   = 'C:\Users\worker\AppData\Local\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe'
$devcon = Join-Path $base 'Dependencies\devcon.exe'
W ("devcon = " + $devcon + "  exists=" + (Test-Path $devcon))
W ("inf dir = " + (Join-Path $base 'SignedDrivers\x86\VDD') + "  exists=" + (Test-Path (Join-Path $base 'SignedDrivers\x86\VDD')))
W "--- vdd_settings.xml (what the driver reads) ---"
$cfg = 'C:\VirtualDisplayDriver\vdd_settings.xml'
if (Test-Path $cfg) { W (Get-Content $cfg -Raw) } else { W "  MISSING $cfg" }
W "--- backup xml (what WORKED before) ---"
if (Test-Path ($cfg + '.bak')) { W (Get-Content ($cfg + '.bak') -Raw) } else { W "  no backup" }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
function Screens($tag) {
  W ("--- screens [" + $tag + "] ---")
  [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
}
Screens 'before'

if (Test-Path $devcon) {
  W "=== devcon status ==="
  W ((& $devcon status 'ROOT\DISPLAY\0000' 2>&1 | Out-String))
  W "=== devcon restart ==="
  W ((& $devcon restart 'ROOT\DISPLAY\0000' 2>&1 | Out-String))
  Start-Sleep -Seconds 8
  Screens 'after restart'
  W "=== devcon disable ==="
  W ((& $devcon disable 'ROOT\DISPLAY\0000' 2>&1 | Out-String))
  Start-Sleep -Seconds 4
  W "=== devcon enable ==="
  W ((& $devcon enable 'ROOT\DISPLAY\0000' 2>&1 | Out-String))
  Start-Sleep -Seconds 10
  Screens 'after disable/enable'
  W "=== enumerate VDD class devices ==="
  W ((& $devcon find 'ROOT\MttVDD' 2>&1 | Out-String))
  W ((& $devcon findall 'Root\MttVDD' 2>&1 | Out-String))
}
W "DONE"
