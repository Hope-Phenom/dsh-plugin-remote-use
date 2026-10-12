# diag-vdd-logging.ps1 -- enable VDD logging, restart the device, collect its log.
$log = 'C:\dsh-remote\evidence\vdd-logging.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

W "=== 0. auto-logon state (does anyone log in after boot?) ==="
$wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$p = Get-ItemProperty $wl -ErrorAction SilentlyContinue
W ("  AutoAdminLogon     = " + $p.AutoAdminLogon)
W ("  DefaultUserName    = " + $p.DefaultUserName)
W ("  DefaultDomainName  = " + $p.DefaultDomainName)
W ("  DefaultPassword set= " + [bool]$p.DefaultPassword)
$d = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue
W ("  legalnoticecaption = " + $d.legalnoticecaption)
W ""
W "=== 1. is anyone logged in? ==="
W ((& query.exe user 2>&1 | Out-String))
W ((& query.exe session 2>&1 | Out-String))

W "=== 2. enable VDD logging in vdd_settings.xml ==="
$cfg = 'C:\VirtualDisplayDriver\vdd_settings.xml'
$xml = Get-Content $cfg -Raw
$xml2 = $xml -replace '<logging>false</logging>', '<logging>true</logging>'
$xml2 = $xml2 -replace '<debuglogging>false</debuglogging>', '<debuglogging>true</debuglogging>'
Set-Content -Path $cfg -Value $xml2 -Encoding UTF8
W ("  logging enabled: " + ((Select-String -Path $cfg -Pattern '<logging>|<debuglogging>').Line -join ' | '))

W "=== 3. restart the device so it re-reads config ==="
$devcon = 'C:\Users\worker\AppData\Local\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe\Dependencies\devcon.exe'
W ((& $devcon restart 'ROOT\MttVDD' 2>&1 | Out-String))
Start-Sleep -Seconds 12

W "=== 4. screens after restart ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }

W "=== 5. VDD log files (search common locations) ==="
$cands = @(
  'C:\VirtualDisplayDriver',
  "$env:ProgramData\VirtualDisplayDriver",
  "$env:SystemRoot\Temp",
  'C:\Users\worker\AppData\Local\Temp'
)
foreach ($c in $cands) {
  if (Test-Path $c) {
    $f = Get-ChildItem $c -Filter '*vdd*' -File -ErrorAction SilentlyContinue
    foreach ($x in $f) { W ("  " + $x.FullName + "  " + $x.Length + " bytes  " + $x.LastWriteTime) }
  }
}
W "=== 6. driver log via WMI/eventvwr ==="
W ((Get-WinEvent -LogName 'System' -MaxEvents 40 -ErrorAction SilentlyContinue |
   Where-Object { $_.Message -match 'MttVDD|Virtual Display' } |
   Select-Object -First 8 | ForEach-Object { "  " + $_.TimeCreated + " [" + $_.LevelDisplayName + "] " + ($_.Message -replace "`r?`n"," ").Substring(0,[Math]::Min(160,($_.Message -replace "`r?`n"," ").Length)) }) -join "`n")
W "DONE"
