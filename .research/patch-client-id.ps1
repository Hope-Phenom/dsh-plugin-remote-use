# patch-client-id.ps1 -- make the installed client bundle register under the SCOPED package name.
#
# THE CONTRACT, read off every working client plugin on this machine:
#
#   package name  ==  the id its client bundle registers with
#   @smalltailqwq/dsh-client-ui-skin-maid-atelier   ->  id: '@smalltailqwq/dsh-client-ui-skin-maid-atelier'
#
# Ours broke that when the package was renamed. lib/client.js still says:
#
#   id: 'dsh-plugin-remote-use'
#
# while the loader's graph rows are keyed by '@hope_phenom/dsh-plugin-remote-use'. The loader's
# "already loaded" bookkeeping is per row id, so it does not recognise the client's self-chosen id,
# the bundle is executed a second time, and dsh-client-modules throws:
#
#   client-modules: duplicate factory registration for "dsh-plugin-remote-use"
#
# Both the client id and the host's exported plugin name have to follow the package name -- the same
# class of miss as the bundled patch's `name:`.
#
# ASCII-ONLY, param() first.
param(
  [string]$Profile = '',
  [string]$NewId = '@hope_phenom/dsh-plugin-remote-use',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$root = Join-Path $Profile 'node_modules\@hope_phenom\dsh-plugin-remote-use'
$enc = New-Object System.Text.UTF8Encoding($false)

foreach ($rel in 'lib\client.js', 'lib\index.js') {
  $p = Join-Path $root $rel
  $t = [System.IO.File]::ReadAllText($p)
  Copy-Item -LiteralPath $p -Destination "$p.bak-id" -Force

  $before = ([regex]::Matches($t, "dsh-plugin-remote-use")).Count

  # Only the IDENTIFIER positions. A blind replace would also rewrite prose in comments and the
  # @module tags, which is noise -- but harmless, so this stays deliberately narrow and explicit.
  $t = $t.Replace("id: 'dsh-plugin-remote-use'", "id: '$NewId'")
  $t = $t.Replace("export const name = 'dsh-plugin-remote-use'", "export const name = '$NewId'")

  $after = ([regex]::Matches($t, "dsh-plugin-remote-use")).Count
  [System.IO.File]::WriteAllText($p, $t, $enc)

  $b = [System.IO.File]::ReadAllBytes($p)
  Say "$rel : occurrences $before -> $after   bytes=$($b.Length)  hasBOM=$($b[0] -eq 0xEF)"
  if ($b[0] -eq 0xEF) { Say 'FATAL: BOM written'; exit 2 }
}

Say ''
Say '--- the identifier lines now ---'
foreach ($rel in 'lib\client.js', 'lib\index.js') {
  $p = Join-Path $root $rel
  Select-String -Path $p -Pattern "^\s*id: '|^export const name" | Select-Object -First 3 | ForEach-Object {
    Say ("  {0}:{1}  {2}" -f $rel, $_.LineNumber, $_.Line.Trim())
  }
}

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
