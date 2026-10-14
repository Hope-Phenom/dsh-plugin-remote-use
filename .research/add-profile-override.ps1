# add-profile-override.ps1 -- write the plugin's profile patch entry, the way the plugin manager does.
#
# WHY: the plugin manager, when it installs a bundle, also writes a block into the profile's
# cordis.patch.yml:
#
#   - id: dsh-plugin-remote-use
#     config:
#       workers: [...]
#
#   "In a patch layer, an entry carrying `id` OVERRIDES an existing entry; it does not create one."
#
# The worker's install went through pnpm directly (to get around a supply-chain policy), so that
# block was never written. The package's own bundled patch does `insert:` a row -- which is the
# documented way to create one -- but with the override absent the app ends up loading the same
# client bundle under two different row identities, and dsh-client-modules rejects the second
# registration:
#
#   client-modules: duplicate factory registration for "dsh-plugin-remote-use"
#     (bundle executed twice without invalidate?)
#
# This writes the same override the host has, with no workers (the worker runs none).
#
# ASCII-ONLY, param() first.
param(
  [string]$Profile = '',
  [string]$Id = 'dsh-plugin-remote-use',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$p = Join-Path $Profile 'cordis.patch.yml'
Copy-Item -LiteralPath $p -Destination "$p.bak-override-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force

$text = [System.IO.File]::ReadAllText($p)
Say "before: $($text.Length) chars, existing '$Id' override: $($text -match "(?m)^\s*-\s*id:\s*$([regex]::Escape($Id))\s*$")"

# Text edit, not a re-serialization: the file is hand-written YAML with comments that must survive.
$block = @(
  ''
  '# --- added to match the shape the plugin manager writes on install ---'
  "# In a patch layer, an entry carrying ``id`` OVERRIDES the row the package's own"
  '# cordis.patch.yml inserts; it does not create a second one. Without this entry the'
  '# client bundle was registered twice and web boot reported "import failed".'
  "- id: $Id"
  '  config:'
  '    workers: []'
) -join "`n"

if ($text -match "(?m)^\s*-\s*id:\s*$([regex]::Escape($Id))\s*$") {
  Say "already present -- not appending"
} else {
  $new = $text.TrimEnd() + "`n" + $block + "`n"
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, $new, $enc)
  Say "appended the override block"
}

$after = [System.IO.File]::ReadAllBytes($p)
$bom = ($after[0] -eq 0xEF -and $after[1] -eq 0xBB -and $after[2] -eq 0xBF)
Say "after : $($after.Length) bytes  hasBOM=$bom"
if ($bom) { Say 'FATAL: BOM written'; exit 2 }

Say ''
Say '--- tail of cordis.patch.yml ---'
Get-Content -LiteralPath $p -Tail 10 | ForEach-Object { Say "  $_" }

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
