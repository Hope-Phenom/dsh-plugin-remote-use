# point-acp-sandbox-at-default.ps1 -- repoint the acp profile's sandbox mediator.
#
# WHY THE ARMING GATE FAILED, precisely:
#
#   lib/index.js builds the arming object with `probe: () => probeSandbox({ profile: acpProfile })`
#   -- correctly, because the WORKER runs under the acp profile, so that is the profile whose sandbox
#   must contain. The gate reads the ACP profile's patch.
#
#   sandbox-probe.js then does:
#       const mediator = deps.mediator ?? 'C:\\dsh-sandbox-mediator'   // hardcoded
#       const shim     = join(mediator, 'shim.mjs')
#       ... if (!normalised.includes(shimPath)) -> 'names a different shim than <shimPath>'
#
#   The acp profile named 'C:\dsh-remote\sandbox-mediator\shim.mjs' -- where the mediator has been
#   materialized since this machine was first set up, and where it still works. The machine was
#   correctly configured; the plugin refused it because it insists on a hardcoded location.
#
#   That is a plugin defect, not a configuration error. This script is the WORKAROUND: it repoints
#   the acp profile at the hardcoded location (the mediator has been copied there), so the gate can
#   pass today. The real fix is to derive the shim path FROM THE PROFILE being checked.
#
# ASCII-ONLY, param() first.
param(
  [string]$AcpProfile = '',
  [string]$From = 'C:\dsh-remote\sandbox-mediator\shim.mjs',
  [string]$To = 'C:\dsh-sandbox-mediator\shim.mjs',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ($AcpProfile -eq '') { $AcpProfile = Join-Path $env:USERPROFILE '.dsh\profiles\acp' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

$p = Join-Path $AcpProfile 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $p)) { Say "FATAL: $p not found"; exit 2 }
Copy-Item -LiteralPath $p -Destination "$p.bak-repoint-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force

$text = [System.IO.File]::ReadAllText($p)
Say "before: $($text.Length) chars"

# Literal replacement. Both spellings are handled: the single-quoted form the file uses
# (one backslash per separator, literal in YAML) and a double-quoted form with escaped backslashes.
$bs = [string][char]92
$fromLit = $From
$fromEsc = $From.Replace($bs, $bs + $bs)
$toLit = $To
$toEsc = $To.Replace($bs, $bs + $bs)

$changed = 0
foreach ($pair in @(@($fromLit, $toLit), @($fromEsc, $toEsc))) {
  if ($text.Contains($pair[0])) {
    $text = $text.Replace($pair[0], $pair[1])
    $changed++
    Say "  replaced: $($pair[0])"
  }
}
Say "  replacements performed: $changed"

if ($changed -eq 0) {
  Say '  nothing matched -- the profile may already point at the target'
} else {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, $text, $enc)
}

$b = [System.IO.File]::ReadAllBytes($p)
Say "after : $($b.Length) bytes  hasBOM=$($b[0] -eq 0xEF)"
if ($b[0] -eq 0xEF) { Say 'FATAL: BOM written'; exit 2 }

Say ''
Say '--- the sandbox entry now ---'
$lines = Get-Content -LiteralPath $p
$i = ($lines | Select-String -Pattern '^\s*-?\s*id:\s*sandbox\s*$' | Select-Object -First 1).LineNumber
if ($i) { $lines[($i-1)..([Math]::Min($i+7, $lines.Count-1))] | ForEach-Object { Say "  $_" } }

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
