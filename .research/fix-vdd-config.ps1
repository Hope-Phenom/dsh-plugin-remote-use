# fix-vdd-config.ps1 -- set the Virtual Display Driver's own configuration right.
#
# WHAT IT FIXES, and why each one:
#
#   1. <count>2</count> -> 1. The config asked for two virtual monitors, so the desktop grew to
#      3520x1080: the physical 1920x1080 plus two 800x600 panels nobody asked for. One is enough --
#      it is the INSURANCE that a display still exists if the physical monitor is ever switched away
#      in a way that drops its EDID. Two is not more insurance, it is a wider coordinate space for
#      absolute-coordinate automation to land in by accident.
#
#   2. Put 1920x1080 first, at 60 Hz. The driver uses the FIRST resolution in the list as the
#      monitor's mode, and the list began at 800x600@30 -- which is why both virtual displays came up
#      800x600. DESIGN already prescribed this exact fix in S3's "fix" hint.
#
#   3. Leave logging/debuglogging alone. The config already has them false, which DESIGN requires
#      (debug logging produces thousands of lines).
#
# Writes back with the SAME UTF-8 BOM the file had, because the driver's parser is not ours to
# assume things about. A backup is taken first unless -SkipBackup is given.
#
# ASCII-ONLY, param() first.
param(
  [string]$Path = 'C:\VirtualDisplayDriver\vdd_settings.xml',
  [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) { throw "not found: $Path" }

if (-not $SkipBackup) {
  $bak = "$Path.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $Path -Destination $bak -Force
  Write-Output "backup: $bak"
}

$bytes = [System.IO.File]::ReadAllBytes($Path)
$hadBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$text = [System.IO.File]::ReadAllText($Path)
$before = $text

# --- 1. one monitor, not two -----------------------------------------------------------------
$text = $text -replace '(?s)(<monitors>\s*<count>)\d+(</count>)', '${1}1${2}'

# --- 2. the 1920x1080 entry moves to the front, at 60 Hz -------------------------------------
$block = @"
      <resolution>
        <width>1920</width>
        <height>1080</height>
        <refresh_rate>60</refresh_rate>
      </resolution>
"@
# Drop the existing 1920x1080 block wherever it is (with any refresh rate and any indentation).
$text = $text -replace '(?s)\s*<resolution>\s*<width>1920</width>\s*<height>1080</height>\s*<refresh_rate>\d+</refresh_rate>\s*</resolution>', ''
# Then put one, at 60 Hz, immediately after the opening tag.
$text = $text -replace '(?s)(<resolutions>)', "`$1`r`n$block"

if ($text -eq $before) {
  Write-Output 'NOTHING CHANGED -- the expected patterns were not found; refusing to write.'
  exit 2
}

$enc = New-Object System.Text.UTF8Encoding($hadBom)
[System.IO.File]::WriteAllText($Path, $text, $enc)
Write-Output "wrote: $Path (bom=$hadBom)"
Write-Output '--- new content ---'
Get-Content -LiteralPath $Path -Raw
