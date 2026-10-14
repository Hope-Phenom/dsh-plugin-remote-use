# run-sandbox-probe.ps1 -- run the plugin's OWN gate and print every check.
#
# The arming dialog only shows the first blocker. This calls the same probe worker-arming.js calls
# (probeSandbox with no arguments, so it uses the hardcoded default mediator path) and prints the
# individual checks, so a pass or fail is attributable instead of black-box.
#
# ASCII-ONLY, param() first.
param(
  [string]$Profile = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$probe = @'
// Imported by RELATIVE FILE PATH, not by package specifier: the package has an `exports` map
// (".", "./client", "./package.json", "./locale/*.json") so internal subpaths are deliberately not
// importable, and `import('@hope_phenom/.../lib/core/sandbox-probe.js')` fails with
// ERR_PACKAGE_PATH_NOT_EXPORTED. A file URL bypasses that map, which is what a diagnostic wants.
const { probeSandbox } = await import('./node_modules/@hope_phenom/dsh-plugin-remote-use/lib/core/sandbox-probe.js')
const r = probeSandbox()
console.log('ok     : ' + r.ok)
console.log('reason : ' + (r.reason || '(none)'))
console.log('config : ' + JSON.stringify(r.config))
for (const c of r.checks) {
  console.log((c.ok ? '  OK   ' : '  FAIL ') + c.name + (c.detail ? '   [' + c.detail + ']' : ''))
}
'@
$probePath = Join-Path $Profile 'probe-sandbox.mjs'
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($probePath, $probe, $enc)

Push-Location $Profile
$out = & node $probePath 2>&1 | Out-String
Pop-Location
Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue

$out.Trim() -split "`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { Say "  $($_.TrimEnd())" }

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
