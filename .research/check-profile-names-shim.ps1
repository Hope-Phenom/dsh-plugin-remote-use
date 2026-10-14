# check-profile-names-shim.ps1 -- call the plugin's own profile check on the real file.
#
# The arming dialog and a fresh probe disagree: the probe reports ok:true with all six checks green,
# while the dialog says "runnerCommand names a different shim than C:\dsh-sandbox-mediator\shim.mjs".
# Both read the same file through the same function, so one of the two observations is stale.
#
# This calls profileNamesShim() directly -- not the whole probe -- so the answer is about the FILE and
# nothing else (no spawning, no sandbox, no timing).
#
# ASCII-ONLY, param() first.
param(
  [string]$Profile = '',
  [string]$Mediator = 'C:\dsh-sandbox-mediator',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$patch = Join-Path $Profile 'cordis.patch.yml'
$shim = Join-Path $Mediator 'shim.mjs'
Say "profile : $patch"
Say "shim    : $shim"
Say ""

$probe = @'
const path = process.argv[2]
const shim = process.argv[3]
const { profileNamesShim } = await import('./node_modules/@hope_phenom/dsh-plugin-remote-use/lib/core/sandbox-probe.js')
const r = profileNamesShim(path, shim)
console.log('ok     : ' + r.ok)
console.log('reason : ' + (r.reason || '(none)'))
'@
$probePath = Join-Path $Profile 'check-shim.mjs'
[System.IO.File]::WriteAllText($probePath, $probe, (New-Object System.Text.UTF8Encoding($false)))

Push-Location $Profile
$out = & node $probePath $patch $shim 2>&1 | Out-String
Pop-Location
Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
$out.Trim() -split "`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { Say "  $($_.TrimEnd())" }

Say ''
Say '--- the raw bytes of the runnerCommand capturable region ---'
$text = [System.IO.File]::ReadAllText($patch)
$m = [regex]::Match($text, '(?s)-\s*id:\s*sandbox\b')
Say "  '- id: sandbox' found at index: $($m.Index)"
if ($m.Success) {
  $tail = $text.Substring($m.Index, [Math]::Min(500, $text.Length - $m.Index))
  Say '  raw 500 chars from there, with each backslash shown as [BS]:'
  Say ('  ' + $tail.Replace([string][char]92, '[BS]').Replace("`r", '').Replace("`n", "`n  "))
}

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
