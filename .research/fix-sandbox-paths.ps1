# fix-sandbox-paths.ps1 -- correct the over-escaped backslashes in the profile's sandbox entry.
#
# THE MISTAKE: the entry was generated with `$path -replace '\\', '\\\\'`. PowerShell's -replace uses
# a REGEX, and the replacement string has its own backslash handling, so each single backslash came
# out as FOUR:
#
#   - "C:\\\\Program Files\\\\nodejs\\\\node.exe"      (wrong)
#   - "C:\\Program Files\\nodejs\\node.exe"            (what YAML needs for a single backslash)
#
# profileNamesShim() normalises by collapsing TWO backslashes into one before comparing against the
# expected shim path, so the four-backslash form normalises to two and never matches -- the probe
# would still say "not materialized" even with the directory in place.
#
# This rewrites just those lines, using literal string operations rather than -replace.
#
# ASCII-ONLY, param() first.
param(
  [string]$Profile = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$p = Join-Path $Profile 'cordis.patch.yml'
Copy-Item -LiteralPath $p -Destination "$p.bak-paths-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force

$text = [System.IO.File]::ReadAllText($p)
Say "before: $($text.Length) chars"

# Literal replacement (String.Replace), NOT -replace: no regex, no backslash interpretation.
$quad = [string][char]92 + [string][char]92 + [string][char]92 + [string][char]92
$duo = [string][char]92 + [string][char]92
$before4 = ([regex]::Matches($text, [regex]::Escape($quad))).Count
$text = $text.Replace($quad, $duo)
$after4 = ([regex]::Matches($text, [regex]::Escape($quad))).Count
Say "  four-backslash runs: $before4 -> $after4"

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($p, $text, $enc)

$b = [System.IO.File]::ReadAllBytes($p)
Say "after : $($b.Length) bytes  hasBOM=$($b[0] -eq 0xEF)"
if ($b[0] -eq 0xEF) { Say 'FATAL: BOM written'; exit 2 }

Say ''
Say '--- sandbox entry now ---'
$lines = Get-Content -LiteralPath $p
$i = ($lines | Select-String -Pattern '^\s*-\s*id:\s*sandbox\s*$' | Select-Object -First 1).LineNumber
if ($i) { $lines[($i-1)..([Math]::Min($i+7, $lines.Count-1))] | ForEach-Object { Say "  $_" } } else { Say '  (not found)' }

# Show the two normalisations side by side, so the match is provable rather than hoped for.
Say ''
Say '--- profileNamesShim normalisation (collapse two backslashes to one, strip quotes) ---'
$m = [regex]::Match($text, '(?s)-\s*id:\s*sandbox\b.{0,600}?runnerCommand:(.{0,400}?)(?=\n\S|\n-|$)')
if ($m.Success) {
  $norm = $m.Groups[1].Value.Replace($duo, [string][char]92).Replace('"', '').Replace("'", '')
  $want = 'C:' + [string][char]92 + 'dsh-sandbox-mediator' + [string][char]92 + 'shim.mjs'
  Say "  normalised contains expected shim: $($norm.Contains($want))"
  Say "  expected: $want"
} else { Say '  runnerCommand not matched by the plugin''s regex' }

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
