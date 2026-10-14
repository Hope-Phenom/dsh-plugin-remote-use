# set-profile-bundle.ps1 -- add or remove a package from the profile's dsh.profile.bundles.
#
# THE BOM IS THE WHOLE POINT. The profile's package.json is parsed by `readProfileManifest` with a
# bare `JSON.parse`, which rejects a leading BOM:
#
#   DesktopHostFatalError: Unexpected token '', "{ "n"... is not valid JSON
#
# `Set-Content -Encoding UTF8` on Windows PowerShell 5.1 WRITES a BOM, so using it here bricks the
# app. `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)` does not, and this script checks
# the first bytes afterwards rather than trusting that.
#
# ASCII-ONLY, param() first.
param(
  [Parameter(Mandatory = $true)][ValidateSet('Enable', 'Disable')][string]$Action,
  [string]$Package = '@hope_phenom/dsh-plugin-remote-use',
  [string]$Profile = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$p = Join-Path $Profile 'package.json'
Copy-Item -LiteralPath $p -Destination "$p.bak-$Action-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force

$before = [System.IO.File]::ReadAllBytes($p)
Say "before: $($before.Length) bytes, BOM=$($before[0] -eq 0xEF -and $before[1] -eq 0xBB -and $before[2] -eq 0xBF)"

$j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
$bundles = @($j.dsh.profile.bundles)
$has = $bundles -contains $Package

if ($Action -eq 'Enable') {
  if (-not $has) { $bundles += $Package }
} else {
  $bundles = @($bundles | Where-Object { $_ -ne $Package })
}
$j.dsh.profile.bundles = $bundles

Say "$Action $Package  (was present: $has)"
Say "bundles now: $($bundles -join ', ')"

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($p, ($j | ConvertTo-Json -Depth 12), $enc)

$after = [System.IO.File]::ReadAllBytes($p)
Say "after : $($after.Length) bytes, first3=$($after[0..2] -join ',')"
$bom = ($after[0] -eq 0xEF -and $after[1] -eq 0xBB -and $after[2] -eq 0xBF)
Say "  has BOM: $bom"
if ($bom) { Say 'FATAL: a BOM was written; DSH will refuse to boot'; exit 2 }

try {
  $null = [System.Text.Json.JsonDocument]::Parse([System.IO.File]::ReadAllText($p))
  Say '  strict JSON parse: OK'
} catch {
  Say "  strict JSON parse: FAILED -- $($_.Exception.Message)"
  exit 2
}

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
