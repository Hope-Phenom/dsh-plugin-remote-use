# fix-profile-json.ps1 -- rewrite the profile's package.json with NO BOM.
#
# WHAT BROKE: the profile package.json was rewritten with `Set-Content -Encoding UTF8`. In Windows
# PowerShell 5.1 that encoding writes a UTF-8 BOM, and DSH's boot parses this file strictly:
#
#   DesktopHostFatalError: Unexpected token '?', "?{ "n"... is not valid JSON
#
# The leading '?' is the BOM. Same family as pitfall E3 (PowerShell writing .ps1 files with the wrong
# encoding) -- and this time the damage was fatal: the app could not boot at all.
#
# This writes with an explicit BOM-less UTF8Encoding, verifies the first bytes, and keeps a backup.
#
# ASCII-ONLY, param() first.
param(
  [string]$Profile = '',
  [string]$RemoveBundle = '@hope_phenom/dsh-plugin-remote-use',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$p = Join-Path $Profile 'package.json'
$bytes = [System.IO.File]::ReadAllBytes($p)
Say "before: $($bytes.Length) bytes, first3 = $($bytes[0..2] -join ',')"
Say "  had BOM: $($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)"

$bak = "$p.bak-bomfix-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $p -Destination $bak -Force
Say "backup : $bak"

# ConvertFrom-Json tolerates the BOM on read, so whatever is there now is parsed correctly.
$j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
if ($RemoveBundle -ne '') {
  $j.dsh.profile.bundles = @($j.dsh.profile.bundles | Where-Object { $_ -ne $RemoveBundle })
}
Say "bundles: $($j.dsh.profile.bundles -join ', ')"
Say "deps   : $(($j.dependencies.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ')"

$json = $j | ConvertTo-Json -Depth 12
# UTF8Encoding($false) = no BOM. This is the whole point of the script.
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($p, $json, $enc)

$after = [System.IO.File]::ReadAllBytes($p)
Say ''
Say "after : $($after.Length) bytes, first3 = $($after[0..2] -join ',')"
Say "  has BOM: $($after[0] -eq 0xEF -and $after[1] -eq 0xBB -and $after[2] -eq 0xBF)"

# Parse it back the way a strict parser would: the BOM must be gone AND the content must be valid.
try {
  $null = [System.Text.Json.JsonDocument]::Parse([System.IO.File]::ReadAllText($p))
  Say '  strict JSON parse: OK'
} catch {
  Say "  strict JSON parse: FAILED -- $($_.Exception.Message)"
}

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
