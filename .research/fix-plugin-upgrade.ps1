# fix-plugin-upgrade.ps1 -- get the worker's profile off the stale lockfile entry.
#
# WHAT WENT WRONG, from the plugin manager's own log:
#
#   [ERR_PNPM_TARBALL_URL_MISMATCH] @hope_phenom/dsh-plugin-remote-use@0.1.0 has a tarball URL
#     (https://registry.npmjs.org/...) that does not match the registry's published metadata
#     (https://registry.npmmirror.com/...)
#
# The package was published minutes earlier; at install time the MIRROR had not caught up, so pnpm
# resolved it against npmjs and wrote that URL into the lockfile. Once the mirror synced, the
# lockfile entry disagreed with the active registry and the supply-chain policy refused every
# install and uninstall. The lockfile also pins 0.1.0, so `pnpm install` kept reusing the store copy
# ("downloaded 0, reused 3") no matter how many times it was reinstalled.
#
# So the fix has to do two things: re-resolve the entry against the ACTIVE registry, and allow the
# version to move. `--latest` is what permits the second, since the spec is `^0.1.0`.
#
# ASCII-ONLY, param() first.
param(
  [string]$Pkg = '@hope_phenom/dsh-plugin-remote-use',
  [string]$Profile = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'

if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

Say "profile : $Profile"
Say "package : $Pkg"
Say ''

Say '--- active registry ---'
$reg = (& pnpm config get registry 2>&1 | Out-String).Trim()
Say "  registry = $reg"

Say ''
Say '--- before ---'
$pkgJson = Join-Path $Profile 'node_modules\' + ($Pkg -replace '/', '\') + '\package.json'
if (Test-Path $pkgJson) { Say "  installed = $((Get-Content $pkgJson -Raw | ConvertFrom-Json).version)" }
else { Say '  installed = (not present)' }
$lock = Join-Path $Profile 'pnpm-lock.yaml'
if (Test-Path $lock) {
  $hit = Select-String -Path $lock -Pattern ([regex]::Escape($Pkg) + '@') | ForEach-Object { $_.Line.Trim() } | Select-Object -Unique
  Say "  lockfile entries: $($hit -join ' | ')"
}

Say ''
Say '--- pnpm update --latest (forces re-resolution against the active registry) ---'
Push-Location $Profile
$out = & pnpm update $Pkg --latest 2>&1 | Out-String
Pop-Location
$out.Trim() -split "`n" | Select-Object -Last 20 | ForEach-Object { Say "  $($_.TrimEnd())" }

Say ''
Say '--- after ---'
if (Test-Path $pkgJson) { Say "  installed = $((Get-Content $pkgJson -Raw | ConvertFrom-Json).version)" }
else { Say '  installed = (not present)' }
if (Test-Path $lock) {
  $hit2 = Select-String -Path $lock -Pattern ([regex]::Escape($Pkg) + '@') | ForEach-Object { $_.Line.Trim() } | Select-Object -Unique
  Say "  lockfile entries: $($hit2 -join ' | ')"
}

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
