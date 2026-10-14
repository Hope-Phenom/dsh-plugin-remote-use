# reinstall-plugin.ps1 -- reinstall the plugin onto a CLEAN resolution.
#
# STATE THIS FIXES: node_modules no longer contains the package (the uninstall worked), but
# `pnpm-lock.yaml` still holds the poisoned entry from the first install:
#
#   '@hope_phenom/dsh-plugin-remote-use@0.1.0':
#     tarball: https://registry.npmjs.org/...     <-- npmjs
#
# while the active registry is https://registry.npmmirror.com. pnpm's supply-chain policy compares
# the two and refuses EVERY install and uninstall ([ERR_PNPM_TARBALL_URL_MISMATCH]), so the plugin
# could not be put back at all. It also pins 0.1.0, so even a successful install reused the store
# copy instead of resolving 0.1.1.
#
# The cause was a propagation race: the package was published to npmjs minutes earlier, the mirror
# had not caught up at install time, so pnpm resolved against npmjs and recorded that URL.
#
# WHY THE BUNDLED PNPM: the pnpm on PATH ships a .ps1 shim that tries to launch `...\pnpm\pnpm` with
# no extension, which Windows cannot start ("ResourceUnavailable"). DSH carries a working copy under
# its own runtime directory; that is what DSH itself uses.
#
# ASCII-ONLY, param() first.
param(
  [string]$Pkg = '@hope_phenom/dsh-plugin-remote-use',
  [string]$Version = '0.1.1',
  [string]$Registry = 'https://registry.npmmirror.com',
  [string]$Profile = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'

if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

# The bundled pnpm, addressed as a FILE so the space in "DeepSeek Harness" never splits an argument.
$pnpmJs = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.cjs'
Say "pnpm    : $pnpmJs"
Say "profile : $Profile"
Say "package : $Pkg@$Version"
Say "registry: $Registry"
if (-not (Test-Path -LiteralPath $pnpmJs)) { Say 'FATAL: bundled pnpm not found'; exit 2 }
Say ''

function Run-Pnpm([string[]]$argv) {
  $all = @($pnpmJs) + $argv
  $o = & node $all 2>&1 | Out-String
  $o.Trim() -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 14 | ForEach-Object { Say "    $($_.TrimEnd())" }
  return $LASTEXITCODE
}

Say '--- version ---'
Run-Pnpm @('--version') | Out-Null

Push-Location $Profile

Say ''
Say '--- add, pinned, against the mirror (rewrites the poisoned lock entry) ---'
$code = Run-Pnpm @('add', "$Pkg@$Version", '--registry', $Registry)
Say "    exit=$code"

Pop-Location

Say ''
Say '--- result ---'
$pkgJson = Join-Path $Profile ('node_modules\' + ($Pkg -replace '/', '\') + '\package.json')
if (Test-Path -LiteralPath $pkgJson) {
  $j = Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json
  Say "  installed version = $($j.version)"
} else {
  Say '  installed = (still not present)'
}
$lock = Join-Path $Profile 'pnpm-lock.yaml'
if (Test-Path -LiteralPath $lock) {
  $e = Select-String -Path $lock -Pattern ([regex]::Escape($Pkg) + '@') | ForEach-Object { $_.Line.Trim() } | Select-Object -Unique
  Say "  lockfile entries  = $($e -join ' | ')"
  $t = Select-String -Path $lock -Pattern 'registry\.npmjs\.org' | ForEach-Object { $_.Line.Trim() } | Select-Object -First 3
  Say "  npmjs URLs left   = $(if ($t) { ($t -join ' | ') } else { 'none' })"
}

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
