# find-vdd.ps1 -- locate exactly what winget installed for VirtualDrivers.Virtual-Display-Driver
$log = 'C:\dsh-remote\evidence\findvdd.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "########## 1. winget: is the package recorded as installed? ##########"
$wg = Get-Command winget -ErrorAction SilentlyContinue
if ($wg) {
  W ("  winget = " + $wg.Source)
  W "--- winget list (virtual/display rows) ---"
  W ((& winget list --accept-source-agreements 2>&1 | Select-String -Pattern 'Virtual|Display|VDD' | Out-String))
  W "--- winget list exact id ---"
  W ((& winget list --id VirtualDrivers.Virtual-Display-Driver -e --accept-source-agreements 2>&1 | Out-String))
} else { W "  winget NOT FOUND on PATH" }

W ""
W "########## 2. where did it go? (filesystem hunt) ##########"
W "--- C:\VirtualDisplayDriver ---"
if (Test-Path 'C:\VirtualDisplayDriver') {
  Get-ChildItem 'C:\VirtualDisplayDriver' -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object -First 40 | ForEach-Object { W ("  " + $_.FullName + "  " + $(if ($_.PSIsContainer) { '<DIR>' } else { $_.Length })) }
} else { W "  NOT PRESENT" }

W "--- search C: (depth<=6) for vdd_settings.xml / *.inf mentioning vdd / VDD exe ---"
$hits = Get-ChildItem 'C:\' -Recurse -Depth 6 -File -ErrorAction SilentlyContinue -Include 'vdd_settings.xml','*vdd*.inf','*vdd*.sys','*vdd*.dll','*Virtual*Display*' |
  Select-Object -First 30 -ExpandProperty FullName
if ($hits) { $hits | ForEach-Object { W ("  " + $_) } } else { W "  none" }

W ""
W "########## 3. pnputil: list OEM drivers, print anything Display-ish ##########"
$raw = & pnputil /enum-drivers 2>&1 | Out-String
# print in blocks so we can see Class Name + Provider + Version for non-Microsoft ones
$blocks = $raw -split "(`r?`n){2,}"
$i = 0
foreach ($b in $blocks) {
  if ($b -match 'Class Name\s*:\s*Display' -or $b -match '[Vv]irtual' -or $b -match '[Vv][Dd][Dd]') { $i++; W ("--- block " + $i + " ---"); W $b.Trim() }
}
if ($i -eq 0) { W "  no Display/Virtual blocks found in pnputil output" }
W ("  total pnputil blocks = " + $blocks.Count)

W ""
W "########## 4. registry: display class UpperFilters / services ##########"
W "--- services whose ImagePath mentions vdd ---"
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Services' -ErrorAction SilentlyContinue | ForEach-Object {
  $ip = (Get-ItemProperty $_.PSPath -Name ImagePath -ErrorAction SilentlyContinue).ImagePath
  if ($ip -match 'vdd|idd|Virtual') { W ("  " + $_.PSChildName + " -> " + $ip) }
}
W "--- Display class upper filters ---"
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue |
  Select-Object UpperFilters,LowerFilters | Format-List | Out-String | ForEach-Object { W $_ }

W ""
W "########## 5. any VDD-ish event log / setupapi entries ##########"
W ((& pnputil /enum-devices /class Display 2>&1 | Out-String))
W "DONE"
