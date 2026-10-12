# where-vdd.ps1 -- find the winget package payload for Virtual-Display-Driver
$log = 'C:\dsh-remote\evidence\wherevdd.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }
function Wr($m) { $m | Tee-Object -FilePath $log -Append | Out-Null }

W "########## 1. winget show: what IS this package? ##########"
W ((& winget show --id VirtualDrivers.Virtual-Display-Driver -e --accept-source-agreements 2>&1 | Out-String))

W "########## 2. winget list --verbose (install location?) ##########"
W ((& winget list --id VirtualDrivers.Virtual-Display-Driver -e --verbose --accept-source-agreements 2>&1 | Out-String))

W "########## 3. uninstall registry entry (gives InstallLocation + UninstallString) ##########"
$paths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
           'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
           'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
$found = Get-ItemProperty $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'Virtual Display' -or $_.Publisher -match 'VirtualDrivers' -or $_.DisplayName -match 'VDD' }
if ($found) {
  foreach ($f in $found) {
    W ("  DisplayName     = " + $f.DisplayName)
    W ("  DisplayVersion  = " + $f.DisplayVersion)
    W ("  Publisher       = " + $f.Publisher)
    W ("  InstallLocation = " + $f.InstallLocation)
    W ("  InstallSource   = " + $f.InstallSource)
    W ("  UninstallString = " + $f.UninstallString)
    W ("  RegKey          = " + $f.PSPath)
    W ""
  }
} else { W "  no uninstall entry matched" }

W "########## 4. is there a VDC (Virtual Driver Control) app? ##########"
foreach ($p in "$env:LOCALAPPDATA\Programs","$env:LOCALAPPDATA\Microsoft\WinGet\Packages","$env:ProgramFiles","${env:ProgramFiles(x86)}","C:\") {
  if (-not (Test-Path $p)) { continue }
  Get-ChildItem $p -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'Virtual|VDD|VDC|Driver' } |
    ForEach-Object { W ("  DIR: " + $_.FullName) }
}

W "########## 5. WinGet Packages folder contents ##########"
$wgp = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
if (Test-Path $wgp) {
  Get-ChildItem $wgp -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | ForEach-Object { W ("  " + $_) }
} else { W "  no WinGet Packages dir" }

W "########## 6. any file with 'Virtual Display' or IddCx in name, broader search ##########"
W ((Get-ChildItem 'C:\' -Recurse -Depth 5 -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'vdd|IddCx|IddSample|VirtualDisplayDriver' } |
    Select-Object -First 25 -ExpandProperty FullName) -join "`n")

W "########## 7. DriverStore: any display-class third party INF? ##########"
W ((& pnputil /enum-drivers 2>&1 | Out-String) -split "`r?`n" |
   Select-String -Pattern 'oem\d+\.inf|Provider Name|Class Name|Driver Version' |
   Select-Object -First 100 | ForEach-Object { $_.Line }) -join "`n")

W "########## 8. winget logs (installer output) ##########"
$wl = "$env:LOCALAPPDATA\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir"
if (Test-Path $wl) {
  Get-ChildItem $wl -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
    Select-Object -First 3 | ForEach-Object {
      W ("  === " + $_.Name + " (" + $_.LastWriteTime + ") ===")
      W ((Get-Content $_.FullName -Tail 60 -ErrorAction SilentlyContinue) -join "`n")
    }
} else { W "  no winget diag dir at $wl" }
W "DONE"
