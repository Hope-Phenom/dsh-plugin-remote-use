# run-sandbox-probe.ps1 -- run the plugin's OWN gate against a SPECIFIC profile patch.
#
# TWO DIFFERENT PROFILES, and conflating them is the bug this script exists to avoid:
#
#   PLUGIN profile  -- where the plugin's code lives, i.e. which node_modules can resolve its
#                      internal modules. On a worker that is `desktop` (the profile installed through
#                      the plugin manager; the plugin is NOT installed in `acp`).
#   PATCH  profile  -- whose cordis.patch.yml the gate reads. The arming gate calls
#                      probeSandbox({ profile: acpProfile }) because the WORKER runs tasks under the
#                      acp profile, so THAT is the file whose sandbox must contain.
#
# probeSandbox's own default for the patch is `desktop`, so probing without the argument verifies the
# WRONG FILE and reports ok:true while arming keeps failing. Same shape as pitfall D9: measuring one
# object and drawing a conclusion about another.
#
# ASCII-ONLY, param() first.
param(
  [string]$PluginProfile = '',
  [string]$PatchProfile = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if ($PluginProfile -eq '') { $PluginProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
if ($PatchProfile -eq '') { $PatchProfile = Join-Path $env:USERPROFILE '.dsh\profiles\acp' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$patch = Join-Path $PatchProfile 'cordis.patch.yml'
Say "plugin code from : $PluginProfile"
Say "patch under test : $patch"
Say "  exists         : $(Test-Path -LiteralPath $patch)"
Say ''

$probe = @'
// Imported by RELATIVE FILE PATH, not by package specifier: the package's `exports` map
// (".", "./client", "./package.json", "./locale/*.json") deliberately hides internal subpaths, so a
// specifier import fails with ERR_PACKAGE_PATH_NOT_EXPORTED. A file path bypasses the map.
const { probeSandbox } = await import('./node_modules/@hope_phenom/dsh-plugin-remote-use/lib/core/sandbox-probe.js')
const patchPath = process.argv[2]
const r = probeSandbox({ profile: patchPath })
console.log('ok     : ' + r.ok)
console.log('reason : ' + (r.reason || '(none)'))
console.log('config : ' + JSON.stringify(r.config))
for (const c of r.checks) {
  console.log((c.ok ? '  OK   ' : '  FAIL ') + c.name + (c.detail ? '   [' + c.detail + ']' : ''))
}
'@
$probePath = Join-Path $PluginProfile 'probe-sandbox.mjs'
[System.IO.File]::WriteAllText($probePath, $probe, (New-Object System.Text.UTF8Encoding($false)))

Push-Location $PluginProfile
$out = & node $probePath $patch 2>&1 | Out-String
Pop-Location
Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue

$out.Trim() -split "`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { Say "  $($_.TrimEnd())" }

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
