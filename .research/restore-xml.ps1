# restore-xml.ps1 -- THE controlled experiment: restore the original vdd_settings.xml
# and restart the device. If the monitor returns, my XML change was the cause.
$log = 'C:\dsh-remote\evidence\restore-xml.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$cfg = 'C:\VirtualDisplayDriver\vdd_settings.xml'
$bak = $cfg + '.bak'
$dc  = 'C:\Users\worker\AppData\Local\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe\Dependencies\devcon.exe'

function Screens($tag) {
  W ("--- screens [" + $tag + "] ---")
  [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
}
function Adapters($tag) {
  W ("--- EnumDisplayDevices [" + $tag + "] ---")
  Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { W ("  adapter: " + $_.Name + "  mode=" + $_.VideoModeDescription) }
}

Screens 'before'
Adapters 'before'
W ("backup exists = " + (Test-Path $bak) + "  size=" + $(if (Test-Path $bak) { (Get-Item $bak).Length } else { 0 }))

W "=== restore original XML ==="
if (Test-Path $bak) {
  Copy-Item $bak $cfg -Force
  W ("  restored; new size = " + (Get-Item $cfg).Length)
  W ("  monitors/count line: " + ((Select-String -Path $cfg -Pattern '<count>').Line))
} else { W "  NO BACKUP" }

W "=== restart VDD device ==="
W ((& $dc restart 'ROOT\MttVDD' 2>&1 | Out-String))
Start-Sleep -Seconds 12
Screens 'after xml restore + restart'
Adapters 'after xml restore + restart'

W "=== also try: disable then enable (fresh D0 entry) ==="
W ((& $dc disable 'ROOT\MttVDD' 2>&1 | Out-String))
Start-Sleep -Seconds 4
W ((& $dc enable 'ROOT\MttVDD' 2>&1 | Out-String))
Start-Sleep -Seconds 15
Screens 'after disable/enable'
Adapters 'after disable/enable'

W "=== setupapi errors for this device ==="
W ((Get-Content "$env:SystemRoot\INF\setupapi.dev.log" -Tail 120 -ErrorAction SilentlyContinue |
    Select-String -Pattern 'MttVDD|ROOT\\DISPLAY|vdd' | Select-Object -Last 20 |
    ForEach-Object { "  " + $_.Line }) -join "`n")
W "DONE"
