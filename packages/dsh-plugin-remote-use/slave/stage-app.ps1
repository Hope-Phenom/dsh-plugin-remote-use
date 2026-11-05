# stage-app.ps1 -- copy a GUI app OUTSIDE the workspace before launching it.
#
# WHY: a workspace that a workspace-write session has ever used carries an inheritable Low mandatory
# label. Windows launches a Low-labelled image at Low integrity, and a Low process cannot write
# %LOCALAPPDATA% even when the account's ACL grants it. Copying the app to a normal user location
# (%LOCALAPPDATA%\dsh-remote-use\staging by default) removes the inherited label, which is the
# reliable alternative to repairing the workspace itself (PITFALLS F41).
#
# The relay repairs an explicitly armed workspace automatically under danger-full-access. This helper
# is for the other two cases: a hand-managed relay with no --task-dir, and an operator who prefers to
# keep GUI payloads out of the workspace entirely.
#
# ASCII-only, param() first: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Destination = '',
  [string]$ExeName = '',
  [switch]$Force,
  [switch]$Launch,
  [string]$Arguments = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source)) {
  Write-Host "REFUSING: source does not exist: $Source" -ForegroundColor Red
  exit 2
}
$sourceFull = (Resolve-Path -LiteralPath $Source).Path
$sourceItem = Get-Item -LiteralPath $sourceFull
$leaf = [System.IO.Path]::GetFileNameWithoutExtension($sourceItem.Name)
if ([string]::IsNullOrEmpty($leaf)) { $leaf = 'app' }

if ([string]::IsNullOrEmpty($Destination)) {
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $Destination = Join-Path $env:LOCALAPPDATA ("dsh-remote-use\staging\" + $leaf + '-' + $stamp)
}

$targetItem = $null
if ($sourceItem.PSIsContainer) {
  $targetDir = $Destination
  if ((Test-Path -LiteralPath $targetDir) -and -not $Force) {
    Write-Host "REFUSING: destination exists: $targetDir (pass -Force to replace it)" -ForegroundColor Red
    exit 2
  }
  if ((Test-Path -LiteralPath $targetDir) -and $Force) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  Copy-Item -Path (Join-Path $sourceFull '*') -Destination $targetDir -Recurse -Force
  $targetItem = Get-Item -LiteralPath $targetDir
} else {
  $targetDir = $Destination
  if (Test-Path -LiteralPath $targetDir -PathType Leaf) {
    $targetDir = Split-Path -Parent $targetDir
  }
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  $targetFile = Join-Path $targetDir $sourceItem.Name
  if ((Test-Path -LiteralPath $targetFile) -and -not $Force) {
    Write-Host "REFUSING: destination exists: $targetFile (pass -Force to replace it)" -ForegroundColor Red
    exit 2
  }
  Copy-Item -LiteralPath $sourceFull -Destination $targetFile -Force
  $targetItem = Get-Item -LiteralPath $targetFile
}

# Make the staged copy's label explicit instead of inherited. The destination is normally Medium
# already, but %LOCALAPPDATA% can itself be inside a tree that a sandbox has labelled.
$stagedPath = $targetItem.FullName
Write-Host "staged: $stagedPath"
if ($targetItem.PSIsContainer) {
  & icacls $stagedPath /setintegritylevel '(OI)(CI)Medium' /T /C /Q | Out-Null
} else {
  & icacls $stagedPath /setintegritylevel Medium | Out-Null
}
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARNING: could not set the staged copy's integrity label (icacls exit $LASTEXITCODE)" -ForegroundColor Yellow
}

$probe = Join-Path $PSScriptRoot 'integrity-probe.ps1'
if (Test-Path -LiteralPath $probe) {
  $probeDir = if ($targetItem.PSIsContainer) { $stagedPath } else { $targetDir }
  & $probe -Workspace $probeDir
}

if ($Launch) {
  if ($targetItem.PSIsContainer) {
    $exe = $null
    if (-not [string]::IsNullOrEmpty($ExeName)) {
      $candidate = Join-Path $stagedPath $ExeName
      if (Test-Path -LiteralPath $candidate) { $exe = $candidate }
    } else {
      $exe = @(Get-ChildItem -LiteralPath $stagedPath -Filter '*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1)[0].FullName
    }
    if ([string]::IsNullOrEmpty($exe)) {
      Write-Host 'REFUSING to launch: no .exe in the staged directory (pass -ExeName)' -ForegroundColor Red
      exit 3
    }
    if ([string]::IsNullOrEmpty($Arguments)) {
      Start-Process -FilePath $exe -WorkingDirectory $stagedPath
    } else {
      Start-Process -FilePath $exe -ArgumentList $Arguments -WorkingDirectory $stagedPath
    }
    Write-Host "launched: $exe"
  } else {
    if ([string]::IsNullOrEmpty($Arguments)) {
      Start-Process -FilePath $stagedPath -WorkingDirectory $targetDir
    } else {
      Start-Process -FilePath $stagedPath -ArgumentList $Arguments -WorkingDirectory $targetDir
    }
    Write-Host "launched: $stagedPath"
  }
}

Write-Host 'RESULT: OK -- the app is staged outside the workspace.' -ForegroundColor Green
exit 0
