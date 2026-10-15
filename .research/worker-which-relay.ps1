# worker-which-relay.ps1 -- which spec does the LIVE relay actually consume, and what mode is in it?
#
# WHY: the launch spec is read once, at relay startup, from the --cmd-file argument. Editing a spec
# file that the running relay never read changes nothing -- and that failure is invisible: every
# check of "the file says X" passes while the session keeps running at Y. So identify the process
# that owns the port, read ITS command line, and only then believe a spec.
#
# ASCII-ONLY: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
param(
  [int]$Port = 7331,
  [string]$OutFile = 'C:\dsh-remote\worker-which-relay.json'
)

$ErrorActionPreference = 'Continue'
$out = [ordered]@{}

# 1) who owns the listening port
$listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listen -ne $null) {
  $pid2 = [int]$listen.OwningProcess
  $out.listenerPid = $pid2
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $pid2" -ErrorAction SilentlyContinue
  if ($p -ne $null) {
    $out.listenerName = $p.Name
    $out.listenerCmd = [string]$p.CommandLine
    $out.listenerStarted = ([Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate)).ToString('s')
    $out.listenerParentPid = [int]$p.ParentProcessId
    $pp = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($pp -ne $null) {
      $out.listenerParentName = $pp.Name
      $out.listenerParentCmd = [string]$pp.CommandLine
      $out.listenerParentStarted = ([Management.ManagementDateTimeConverter]::ToDateTime($pp.CreationDate)).ToString('s')
    }
  } else {
    $out.listenerName = '(CIM could not read the process)'
  }
} else {
  $out.listenerPid = -1
}

# 2) every agent-spec.json on the box, with its mode and mtime
$specs = @()
foreach ($f in (Get-ChildItem -Path 'C:\dsh-remote' -Recurse -Filter 'agent-spec.json' -ErrorAction SilentlyContinue)) {
  $mode = '(unreadable)'
  try {
    $j = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
    $mode = [string]$j.env.DSH_PERMISSION_MODE
  } catch { }
  $specs += [ordered]@{ path = $f.FullName; mode = $mode; modified = $f.LastWriteTime.ToString('s') }
}
$out.specFiles = $specs

# 3) the spec the LIVE listener names, if its command line says so
$out.liveSpecPath = ''
if ($out.listenerCmd -ne $null -and $out.listenerCmd -match '--cmd-file\s+"?([^"]+\.json)"?') {
  $out.liveSpecPath = $Matches[1].Trim()
  if (Test-Path $out.liveSpecPath) {
    try {
      $j = Get-Content -LiteralPath $out.liveSpecPath -Raw | ConvertFrom-Json
      $out.liveSpecMode = [string]$j.env.DSH_PERMISSION_MODE
      $out.liveSpecModified = (Get-Item $out.liveSpecPath).LastWriteTime.ToString('s')
    } catch { $out.liveSpecMode = '(unreadable)' }
  } else {
    $out.liveSpecMode = '(named spec does not exist)'
  }
}

$json = $out | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $OutFile -Value $json -Encoding UTF8
Write-Output $json
