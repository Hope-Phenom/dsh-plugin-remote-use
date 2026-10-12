# check-quickedit-and-vdd.ps1 -- NO mouse injection in this script.
$log = 'C:\dsh-remote\evidence\qe-vdd.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "########## 1. console QuickEdit / InsertMode (HKCU\Console) ##########"
$c = Get-ItemProperty 'HKCU:\Console' -ErrorAction SilentlyContinue
if ($c) {
  W ("  QuickEdit  = " + $(if ($null -eq $c.QuickEdit)  { '(not set -> defaults to ON)' } else { $c.QuickEdit }))
  W ("  InsertMode = " + $(if ($null -eq $c.InsertMode) { '(not set -> defaults to ON)' } else { $c.InsertMode }))
} else { W "  HKCU:\Console missing" }
W "--- per-console subkeys (cmd / powershell) ---"
Get-ChildItem 'HKCU:\Console' -ErrorAction SilentlyContinue | ForEach-Object { W ("  subkey: " + $_.PSChildName) }
foreach ($k in 'HKCU:\Console\%SystemRoot%_System32_cmd.exe','HKCU:\Console\%SystemRoot%_System32_WindowsPowerShell_v1.0_powershell.exe') {
  $v = Get-ItemProperty $k -ErrorAction SilentlyContinue
  if ($v) { W ("  " + $k + " -> QuickEdit=" + $(if ($null -eq $v.QuickEdit) { '(on)' } else { $v.QuickEdit })) }
}

W ""
W "########## 2. winget list --verbose (install location) ##########"
W ((& winget list --id VirtualDrivers.Virtual-Display-Driver -e --verbose --accept-source-agreements 2>&1 | Out-String))

W "########## 3. winget show (what does the package contain?) ##########"
W ((& winget show --id VirtualDrivers.Virtual-Display-Driver -e --accept-source-agreements 2>&1 | Out-String))

W "########## 4. uninstall registry entry ##########"
$paths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
           'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
           'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
$found = Get-ItemProperty $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'Virtual Display|VirtualDrivers|VDD' }
if ($found) { foreach ($f in $found) {
  W ("  DisplayName     = " + $f.DisplayName)
  W ("  DisplayVersion  = " + $f.DisplayVersion)
  W ("  InstallLocation = " + $f.InstallLocation)
  W ("  InstallSource   = " + $f.InstallSource)
  W ("  UninstallString = " + $f.UninstallString)
  W ("  RegKey          = " + $f.PSPath); W ""
} } else { W "  no matching uninstall entry" }

W "########## 5. WinGet\Packages contents ##########"
$wgp = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
if (Test-Path $wgp) { Get-ChildItem $wgp -ErrorAction SilentlyContinue | ForEach-Object { W ("  " + $_.Name) } } else { W "  none" }

W "########## 6. search for vdd / IddCx artefacts (depth<=5) ##########"
W ((Get-ChildItem 'C:\' -Recurse -Depth 5 -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'vdd|IddCx|IddSample|VirtualDisplayDriver|VirtualDisplay' } |
    Select-Object -First 25 -ExpandProperty FullName) -join "`n")

W "########## 7. winget diagnostic log (tail) ##########"
$wl = "$env:LOCALAPPDATA\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir"
if (Test-Path $wl) {
  Get-ChildItem $wl -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2 |
    ForEach-Object { W ("=== " + $_.Name + " ==="); W ((Get-Content $_.FullName -Tail 40 -ErrorAction SilentlyContinue) -join "`n") }
} else { W "  no diag dir" }
W "DONE"
