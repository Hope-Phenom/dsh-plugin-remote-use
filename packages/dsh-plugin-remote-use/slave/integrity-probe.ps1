# integrity-probe.ps1 -- report the token integrity a process gets when launched from a workspace.
#
# WHY THIS EXISTS: DSH's workspace-write sandbox writes an inheritable Low mandatory label onto the
# workspace directory. Files copied there inherit it, and Windows launches a Low-labelled image at
# Low integrity even when the caller's token is High. A GUI application then cannot write
# %LOCALAPPDATA% (Medium) while the agent shell around it can -- a failure that looks like an ACL or
# application problem, not like a sandbox leftover (PITFALLS F41).
#
# The probe copies a signed Windows binary (whoami.exe) into the workspace and into %TEMP%, launches
# each copy, and reads the mandatory-label row out of `whoami /groups`. That measures the actual
# result for the same kind of image, without needing a GUI app or a real GUI session.
#
# Output is ONE line of compact JSON on stdout; diagnostics go to stderr. ASCII-only: Windows
# PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [string]$Workspace = ''
)
$ErrorActionPreference = 'Stop'

function Get-LevelNumber([string]$Sid) {
  switch ($Sid) {
    'S-1-16-0' { return 0 }
    'S-1-16-4096' { return 4096 }
    'S-1-16-8192' { return 8192 }
    'S-1-16-12288' { return 12288 }
    'S-1-16-16384' { return 16384 }
    default { return -1 }
  }
}

function Get-LevelName([int]$Number) {
  switch ($Number) {
    0 { return 'Untrusted' }
    4096 { return 'Low' }
    8192 { return 'Medium' }
    12288 { return 'High' }
    16384 { return 'System' }
    default { return 'unknown' }
  }
}

function Read-Integrity([string]$ExePath) {
  if ([string]::IsNullOrEmpty($ExePath) -or -not (Test-Path -LiteralPath $ExePath)) { return $null }
  $rows = @(& $ExePath /groups /fo csv /nh 2>$null)
  if ($rows.Count -eq 0) { return $null }
  $parsed = @($rows | ConvertFrom-Csv -Header Name, Kind, Sid, Attributes)
  $label = $parsed | Where-Object { $_.Sid -match '^S-1-16-' } | Select-Object -First 1
  if ($null -eq $label) { return $null }
  $number = Get-LevelNumber $label.Sid
  return [ordered]@{
    sid = $label.Sid
    name = $label.Name
    level = Get-LevelName $number
    levelNumber = $number
  }
}

$result = [ordered]@{
  probedAt = (Get-Date).ToString('o')
  workspacePath = $Workspace
  self = $null
  workspace = $null
  temp = $null
  degraded = $false
  error = ''
}

$whoamiExe = Join-Path $env:SystemRoot 'System32\whoami.exe'
try {
  if (-not (Test-Path -LiteralPath $whoamiExe)) { throw "whoami.exe not found at $whoamiExe" }
  # The current process's token, measured through a fresh child rather than assumed from $PID.
  $result.self = Read-Integrity $whoamiExe

  $tempCopy = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-il-probe-temp-" + $PID + "-" + [guid]::NewGuid().ToString('N') + ".exe")
  try {
    Copy-Item -LiteralPath $whoamiExe -Destination $tempCopy -Force
    $result.temp = Read-Integrity $tempCopy
  } finally {
    Remove-Item -LiteralPath $tempCopy -Force -ErrorAction SilentlyContinue
  }

  if (-not [string]::IsNullOrEmpty($Workspace) -and (Test-Path -LiteralPath $Workspace -PathType Container)) {
    $workspaceCopy = Join-Path $Workspace ("dsh-il-probe-workspace-" + $PID + "-" + [guid]::NewGuid().ToString('N') + ".exe")
    try {
      Copy-Item -LiteralPath $whoamiExe -Destination $workspaceCopy -Force
      $result.workspace = Read-Integrity $workspaceCopy
    } finally {
      Remove-Item -LiteralPath $workspaceCopy -Force -ErrorAction SilentlyContinue
    }
  }

  if ($null -ne $result.workspace -and $null -ne $result.temp) {
    $result.degraded = [bool]($result.workspace.levelNumber -lt $result.temp.levelNumber)
  }
} catch {
  $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Compress -Depth 6
