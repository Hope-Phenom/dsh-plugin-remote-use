# repair-workspace-integrity.ps1 -- reset a workspace's stale Low mandatory label to Medium.
#
# WHY: DSH's workspace-write sandbox labels the workspace Low. The label survives the session and is
# inherited by files copied into the tree, and Windows launches a Low-labelled image at Low
# integrity. Under danger-full-access that leftover is what makes a GUI app unable to write
# %LOCALAPPDATA% even though the agent shell is High (PITFALLS F41).
#
# The relay repairs the tree automatically on start when it runs at danger-full-access with an
# explicit --task-dir. This script is the manual equivalent, and the repair path for a hand-managed
# relay whose task directory is not passed as a flag.
#
# ASCII-only, param() first: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
  Write-Host "REFUSING: not a directory: $Path" -ForegroundColor Red
  exit 2
}
$full = (Resolve-Path -LiteralPath $Path).Path
if ($full -match '^[A-Za-z]:\\?$') {
  Write-Host "REFUSING: $full is a drive root, not a workspace." -ForegroundColor Red
  exit 2
}

$protected = @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData) |
  Where-Object { $_ -and $_.Trim() -ne '' } |
  ForEach-Object { $_.TrimEnd('\').ToLowerInvariant() }
$target = $full.TrimEnd('\').ToLowerInvariant()
foreach ($root in $protected) {
  if ($target -eq $root -or $target.StartsWith($root + '\')) {
    Write-Host "REFUSING: $full is a protected system location." -ForegroundColor Red
    exit 2
  }
}

$command = "icacls `"$full`" /setintegritylevel (OI)(CI)Medium /T /C /Q"
Write-Host "workspace : $full"
Write-Host "command   : $command"
if ($WhatIf) {
  Write-Host 'WHATIF: nothing changed.'
  exit 0
}

# Show the label lines this tree carries BEFORE the reset, so the operator can see whether there was
# anything to fix. The label name is localized on some Windows installs, so the decision is still the
# unconditional idempotent set below rather than a text match.
Write-Host '--- labels before (matching lines only) ---'
$before = @(& icacls $full 2>&1)
@($before | Where-Object { $_ -match 'Mandatory|Label|S-1-16' }) | ForEach-Object { Write-Host $_ }

& icacls $full /setintegritylevel '(OI)(CI)Medium' /T /C /Q | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: icacls exited $LASTEXITCODE" -ForegroundColor Red
  exit 1
}

Write-Host '--- labels after (top level) ---'
$after = @(& icacls $full 2>&1)
@($after | Where-Object { $_ -match 'Mandatory|Label|S-1-16' }) | ForEach-Object { Write-Host $_ }

# Re-measure with the same probe the self-check uses. This is the difference between "the command
# returned 0" and "a process launched from here is no longer Low".
$probe = Join-Path $PSScriptRoot 'integrity-probe.ps1'
if (Test-Path -LiteralPath $probe) {
  Write-Host '--- probe ---'
  & $probe -Workspace $full
}

Write-Host 'RESULT: OK -- the workspace tree was relabeled to Medium.' -ForegroundColor Green
exit 0
