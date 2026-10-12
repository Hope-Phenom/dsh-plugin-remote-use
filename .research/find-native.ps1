# find-native.ps1 -- locate koffi's native binaries for the sandbox mediator.
#
# Electron auto-unpacks `.node` files to `app.asar.unpacked`, because a native library
# cannot be loaded from inside an asar. The extraction step copies only what is inside the
# asar, so the binary has to be found separately and placed where Node's loader expects it.
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $PSScriptRoot 'find-native.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { Write-Output $m; Add-Content -Path $log -Value $m -Encoding UTF8 }

$res = 'C:\Users\worker\AppData\Local\Programs\DeepSeek Harness\resources'
$un = Join-Path $res 'app.asar.unpacked'

W "=== every .node under app.asar.unpacked ==="
Get-ChildItem $un -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -eq '.node' } |
  ForEach-Object { W ("  " + $_.FullName.Replace($un + '\', '') + "  " + [math]::Round($_.Length / 1KB, 1) + " KB") }

W ""
W "=== anything whose path mentions koffi ==="
Get-ChildItem $un -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'koffi' } |
  Select-Object -First 30 |
  ForEach-Object { W ("  " + $_.FullName.Replace($un + '\', '') + "  " + $(if ($_.PSIsContainer) { '<dir>' } else { [string]$_.Length })) }

W ""
W "=== unpacked top-level layout ==="
Get-ChildItem $un -Recurse -Directory -Depth 2 -ErrorAction SilentlyContinue |
  Select-Object -First 25 |
  ForEach-Object { W ("  dir  " + $_.FullName.Replace($un + '\', '')) }

W ""
W "=== what the extracted koffi package contains ==="
$ko = 'C:\dsh-remote\sandbox-mediator\node_modules\koffi'
if (Test-Path $ko) {
  Get-ChildItem $ko -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 30 |
    ForEach-Object { W ("  " + $_.FullName.Replace($ko + '\', '') + "  " + $_.Length) }
} else {
  W "  (not extracted)"
}

W ""
W "=== koffi entry points (how it locates its binary) ==="
foreach ($f in 'index.cjs', 'index.js', 'src\koffi\index.cjs') {
  $p = Join-Path $ko $f
  if (Test-Path $p) {
    W "  --- $f ---"
    Get-Content $p -TotalCount 25 | ForEach-Object { W ("      " + $_) }
  }
}
W "RESULT: DONE"
