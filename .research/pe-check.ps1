$p = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe"
$targets = @(
  "$p\SignedDrivers\x86\VDD\MttVDD.dll",
  "$p\SignedDrivers\ARM64\VDD\MttVDD.dll",
  "$p\VDD Control.exe",
  "$p\Dependencies\devcon.exe"
)
foreach ($f in $targets) {
  if (-not (Test-Path $f)) { Write-Output ("MISSING: " + $f); continue }
  $bytes = [System.IO.File]::ReadAllBytes($f)
  $peOff = [BitConverter]::ToInt32($bytes, 0x3C)
  $machine = [BitConverter]::ToUInt16($bytes, $peOff + 4)
  $nm = switch ($machine) { 0x8664 {'x64'} 0x14c {'x86'} 0xaa64 {'ARM64'} default { '0x' + $machine.ToString('x4') } }
  Write-Output ((Split-Path $f -Leaf) + "  ->  " + $nm + "  (0x" + $machine.ToString('x4') + ")  " + $bytes.Length + " bytes")
}
Write-Output "--- host arch ---"
Write-Output ("PROCESSOR_ARCHITECTURE = " + $env:PROCESSOR_ARCHITECTURE)
