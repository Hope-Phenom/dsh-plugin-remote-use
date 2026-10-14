# probe-client-half.ps1 -- import BOTH halves of the plugin the way DSH does.
#
# The startup error says "web boot: 1 entry did not activate" and names this plugin, which means the
# CLIENT half (`dsh.client` -> "./client" -> lib/client.js) is what failed. The earlier probe only
# imported the package root, which is the HOST half -- so it reported IMPORT-OK while the half that
# actually breaks was never touched. Import both, separately, and keep the raw errors.
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

$probe = Join-Path $Profile 'probe-halves.mjs'
$targets = @(
  @{ label = 'HOST  (package root)'; spec = $Pkg },
  @{ label = 'CLIENT (./client)';     spec = "$Pkg/client" },
  @{ label = 'package.json';          spec = "$Pkg/package.json" }
)

$specs = ($targets | ForEach-Object { '"' + $_.spec + '"' }) -join ', '
$body = "const targets = [$specs]`n"
$body += @'
for (const t of targets) {
  try {
    const m = await import(t)
    console.log('OK    ' + t + '  exports=' + Object.keys(m).join(','))
  } catch (e) {
    console.log('FAIL  ' + t)
    console.log('      ' + String(e.code || '') + ' ' + String(e.message).split('\n')[0])
    if (e.stack) console.log('      ' + String(e.stack).split('\n').slice(1, 4).join('\n      '))
  }
}
'@
Set-Content -LiteralPath $probe -Value $body -Encoding UTF8 -NoNewline

Push-Location $Profile
$out = & node $probe 2>&1 | Out-String
Pop-Location
$out.Trim() -split "`n" | ForEach-Object { if ($_.Trim() -ne '') { Say "  $($_.TrimEnd())" } }

Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
