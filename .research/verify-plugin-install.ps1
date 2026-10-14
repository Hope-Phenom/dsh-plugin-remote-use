# verify-plugin-install.ps1 -- prove the freshly installed plugin will actually load.
#
# The last failure was invisible from the outside: package.json looked fine, the plugin manager
# listed the plugin, the toggle moved -- and the server half never loaded, because the bundled patch
# asked the loader to import a module name that no longer existed. So "it is installed" is not the
# question; "does the entry point import, and does the patch name agree with the package name" is.
#
# ASCII-ONLY, param() first.
param(
  [string]$Profile = '',
  [string]$Pkg = '@hope_phenom/dsh-plugin-remote-use',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$dir = Join-Path $Profile ('node_modules\' + ($Pkg -replace '/', '\'))
Say "dir = $dir"

$pj = Join-Path $dir 'package.json'
if (-not (Test-Path -LiteralPath $pj)) { Say 'FATAL: not installed'; exit 2 }
$j = Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json
Say "package name    = $($j.name)"
Say "package version = $($j.version)"
Say "main            = $($j.main)"
Say "dsh.bundle      = $($j.dsh.bundle.patch)"

Say ''
Say '--- bundled patch: the module name the loader will import ---'
$patch = Join-Path $dir 'cordis.patch.yml'
$names = @()
if (Test-Path -LiteralPath $patch) {
  $names = Select-String -Path $patch -Pattern '^\s*name:\s*''?([^''\s]+)''?\s*$' |
    ForEach-Object { ($_.Line -replace '^\s*name:\s*', '').Trim("'", ' ') }
  $names | ForEach-Object { Say "  name: $_" }
} else { Say '  (no cordis.patch.yml)' }

$ok = $names -contains $j.name
Say "  matches package name: $(if ($ok) { 'YES' } else { 'NO -- the plugin will not load' })"

Say ''
Say '--- can the entry point import from this profile? ---'
$entry = Join-Path $dir ($j.main -replace '/', '\')
Say "entry = $entry"
Push-Location $Profile
$out = & node -e "import(process.argv[1]).then(m => console.log('IMPORT-OK exports=' + Object.keys(m).join(',')), e => console.log('IMPORT-FAIL ' + e.code + ' ' + e.message))" $entry 2>&1 | Out-String
Pop-Location
$out.Trim() -split "`n" | ForEach-Object { if ($_.Trim() -ne '') { Say "  $($_.Trim())" } }

Say ''
Say '--- the module specifier the patch asks for, resolved from the profile ---'
Push-Location $Profile
$out2 = & node -e "import(process.argv[1]).then(() => console.log('SPECIFIER-OK'), e => console.log('SPECIFIER-FAIL ' + e.code))" $Pkg 2>&1 | Out-String
Pop-Location
$out2.Trim() -split "`n" | ForEach-Object { if ($_.Trim() -ne '') { Say "  $($_.Trim())" } }

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
