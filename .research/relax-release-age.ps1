# relax-release-age.ps1 -- apply the documented fix for pnpm 11's release-age gate.
#
# THE FAILURE: uninstalling (or installing) anything in a DSH profile fails with
#
#   [ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
#     @hope_phenom/dsh-plugin-remote-use@0.1.3 was published at ..., within the
#     minimumReleaseAge cutoff
#
# WHY THE EXCLUSION LIST DOES NOT HELP: the profile's pnpm-workspace.yaml already lists
#
#   minimumReleaseAgeExclude:
#     - '@hope_phenom/dsh-plugin-remote-use@0.1.3'
#
# and the operation STILL fails. That matches the note in the official plugin guide
# (github.com/PerryLink/dsh-plugin-guide, pnpm-workspace.yaml):
#
#   "this zero-age override keeps fresh installs deterministic when pnpm's lockfile policy
#    re-checks entries the exclusion list above cannot enumerate"
#
# i.e. the exclude list covers RESOLUTION, while the lockfile verification pass re-checks every
# entry and cannot be enumerated away. `minimumReleaseAge: 0` is the setting the guide documents.
#
# NOTE: pnpm 11 defaults `minimumReleaseAge` to 24h and DSH does not set it, so this relaxes a
# PNPM DEFAULT rather than a policy DSH chose. It is a real trade-off: a package published in the
# last 24h is no longer quarantined. Once the version you need is older than 24h, delete this line
# to restore the default. The line is marked so it is easy to find again.
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

$p = Join-Path $Profile 'pnpm-workspace.yaml'
if (-not (Test-Path -LiteralPath $p)) { Say "FATAL: $p not found"; exit 2 }

Copy-Item -LiteralPath $p -Destination "$p.bak-releaseage-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force

$text = [System.IO.File]::ReadAllText($p)
Say "before: $($text.Length) chars"
if ($text -match '(?m)^\s*minimumReleaseAge\s*:') {
  Say "  minimumReleaseAge is already set -- leaving it alone"
  $changed = $false
} else {
  $changed = $true
  $add = @(
    ''
    '# pnpm 11 defaults minimumReleaseAge to 24h, which blocks ANY profile change while the'
    '# installed version is younger than that -- including uninstalling it, because the lockfile'
    '# verification pass re-checks every entry and cannot be covered by minimumReleaseAgeExclude.'
    '# Documented workaround: github.com/PerryLink/dsh-plugin-guide (pnpm-workspace.yaml).'
    '# DELETE THIS LINE once the versions you need are older than 24h.'
    'minimumReleaseAge: 0'
  ) -join "`n"
  $text = $text.TrimEnd() + "`n" + $add + "`n"
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, $text, $enc)
  Say "  appended minimumReleaseAge: 0"
}

$b = [System.IO.File]::ReadAllBytes($p)
$bom = ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
Say "after : $($b.Length) bytes  hasBOM=$bom  changed=$changed"
if ($bom) { Say 'FATAL: BOM written'; exit 2 }

Say ''
Say '--- tail ---'
Get-Content -LiteralPath $p -Tail 8 | ForEach-Object { Say "  $_" }

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
