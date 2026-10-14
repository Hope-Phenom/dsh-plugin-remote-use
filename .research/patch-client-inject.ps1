# patch-client-inject.ps1 -- add dsh.client.inject to an INSTALLED copy of the plugin, to test the fix.
#
# THE EVIDENCE, from the worker's own boot blob (fetched from http://127.0.0.1:19387/):
#
#   <script src="plugins/??...@hope_phenom/dsh-plugin-remote-use/client.js,...&rev=c48fe2a85fae">
#   {"id":"@hope_phenom/dsh-plugin-remote-use","url":"plugins/??@hope_phenom/.../client.js&rev=2658942bd4fe",
#    "rev":"2658942bd4fe"}
#
# The same client is emitted TWICE, at two different URLs (one swept into a batch/group, one standalone).
# dsh-client-modules' loadShared only de-duplicates per IN-FLIGHT arrival, so two URLs mean two
# executions, and register() throws:
#
#   client-modules: duplicate factory registration for "dsh-plugin-remote-use"
#
# Note the standalone entry has no "inject" key. Every working client plugin on this machine declares
# one -- including the empty list:
#
#   "dsh": { "bundle": {...}, "client": { "inject": [], "platform": "web" } }
#
# Ours declares only "platform". This script adds "inject": [] to the INSTALLED manifest so the
# hypothesis can be tested before republishing. The real fix belongs in the package source.
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

$p = Join-Path $Profile 'node_modules\@hope_phenom\dsh-plugin-remote-use\package.json'
Copy-Item -LiteralPath $p -Destination "$p.bak-inject" -Force

$j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
Say "before: dsh.client = $($j.dsh.client | ConvertTo-Json -Compress)"

if ($null -eq $j.dsh.client.PSObject.Properties['inject']) {
  $j.dsh.client | Add-Member -NotePropertyName 'inject' -NotePropertyValue @() -Force
  Say 'added inject = []'
} else {
  Say "already has inject = $($j.dsh.client.inject | ConvertTo-Json -Compress)"
}
Say "after : dsh.client = $($j.dsh.client | ConvertTo-Json -Compress)"

# Same BOM trap as the profile manifest: this file is parsed by DSH too.
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($p, ($j | ConvertTo-Json -Depth 12), $enc)
$b = [System.IO.File]::ReadAllBytes($p)
Say "bytes: $($b.Length)  hasBOM=$($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)"
if ($b[0] -eq 0xEF) { Say 'FATAL: BOM written'; exit 2 }

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
