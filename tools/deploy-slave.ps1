# deploy-slave.ps1 -- put the worker-side files on a worker and PROVE they load.
#
# WHY THIS IS A SCRIPT AND NOT A LIST IN THE DOCS: the deployment is five to seven files, three of
# which are NEW relative imports of `relay.mjs`. Copy only `relay.mjs` -- the obvious thing to do --
# and the worker's relay dies with ERR_MODULE_NOT_FOUND, whose symptom is "the worker is
# unreachable", indistinguishable from a network fault. That exact failure is called out in
# DESIGN section 19 and it is the reason this script exists rather than a checklist.
#
# It refuses to declare success until the copied relay actually loads out of the destination.
#
#   -Destination <dir>   where the worker keeps its scripts (e.g. C:\dsh-remote\plugin-slave)
#   -Source <dir>        defaults to this repository's package
#   -VerifyOnly          do not copy; only check what is already at -Destination
#   -KeepRunning         leave the relay running for a moment after --print-pairing fails? (diagnostics)
#
# ASCII-ONLY, because Windows PowerShell 5.1 reads BOM-less files as ANSI and a non-ASCII byte
# inside a string literal breaks parsing. `param()` is the first statement for the same reason it is
# everywhere else in this project.
param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [string]$Source = '',
  [switch]$VerifyOnly,
  [int]$ProbePort = 7394
)

$ErrorActionPreference = 'Stop'

# ASCII-only guard on THIS file, run first: a parse failure further down would otherwise be
# reported as a confusing "invalid assignment operator" at whatever line follows the bad byte.
$self = $MyInvocation.MyCommand.Path
if ($self) {
  $bytes = [System.IO.File]::ReadAllBytes($self)
  $nonAscii = @($bytes | Where-Object { $_ -gt 127 })
  if ($nonAscii.Count -gt 0) {
    Write-Host "REFUSING: this script contains $($nonAscii.Count) non-ASCII byte(s)." -ForegroundColor Red
    Write-Host "PS 5.1 reads a BOM-less .ps1 as ANSI, so those bytes break parsing."
    exit 2
  }
}

if ([string]::IsNullOrEmpty($Source)) {
  # Resolve relative to this script: tools\ -> repo root -> packages\dsh-plugin-remote-use\slave
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Source = Join-Path (Split-Path -Parent $here) 'packages\dsh-plugin-remote-use\slave'
}
$Source = (Resolve-Path -LiteralPath $Source).Path
$Destination = [System.IO.Path]::GetFullPath($Destination)

Write-Host "source      : $Source"
Write-Host "destination : $Destination"
Write-Host "mode        : $(if ($VerifyOnly) { 'verify only' } else { 'copy and verify' })"
Write-Host ''

# The files the worker needs, and why each one is here. A file that is not listed is not copied --
# the worker has no use for the host's build outputs, and a partial copy is worse than none.
$files = @(
  @{ name = 'relay.mjs'; why = 'the listener' },
  @{ name = 'prune-shots.mjs'; why = 'IMPORTED BY relay.mjs (new)' },
  @{ name = 'pairing.mjs'; why = 'IMPORTED BY relay.mjs (new)' },
  @{ name = 'net-address.mjs'; why = 'IMPORTED BY relay.mjs (new)' },
  @{ name = 'selfcheck.ps1'; why = 'S14/S15/S18 path fixes' },
  @{ name = 'screenshot.ps1'; why = 'capture' },
  @{ name = 'make-launch-spec.mjs'; why = 'optional: generates the ACP launch spec' }
)

# `ws` IS A DEPENDENCY OF THE RELAY, and leaving it out is what this script's run-check caught on
# its first rehearsal: the deployment listed every script, verified every parse, and then the relay
# died with `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`. A bare package import does not show up
# in a file list the way a relative one does, which is exactly why the check is a RUN and not a
# checklist. DESIGN section 19 had the same omission.
$depDirs = @('node_modules')

$failures = 0
$check = {
  param($label, $ok, $detail)
  $tag = if ($ok) { 'PASS' } else { 'FAIL' }
  $colour = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1}{2}" -f $tag, $label, $(if ($detail) { " -- $detail" } else { '' })) -ForegroundColor $colour
  if (-not $ok) { $script:failures = $script:failures + 1 }
}

Write-Host '--- source files ---'
foreach ($f in $files) {
  $path = Join-Path $Source $f.name
  $ok = Test-Path -LiteralPath $path
  & $check "$($f.name) present in the source" $ok $f.why
}
foreach ($d in $depDirs) {
  & $check "$d present in the source" (Test-Path -LiteralPath (Join-Path $Source $d)) 'the relay imports `ws` from here'
}
if ($failures -gt 0) {
  Write-Host ''
  Write-Host 'The source is incomplete; nothing was copied.' -ForegroundColor Red
  exit 1
}

# The three new relative imports are the failure mode this whole script is about, so they are
# checked explicitly rather than assumed from the file list.
Write-Host ''
Write-Host '--- relay.mjs really imports them ---'
$relayText = Get-Content -LiteralPath (Join-Path $Source 'relay.mjs') -Raw
foreach ($dep in 'prune-shots.mjs', 'pairing.mjs', 'net-address.mjs') {
  & $check "relay.mjs imports $dep" ($relayText -match [regex]::Escape("./$dep"))
}
# ...and the BARE import, which no `./` scan would ever notice.
& $check "relay.mjs imports the bare package 'ws'" ($relayText -match "from 'ws'")
foreach ($d in $depDirs) {
  & $check "$d carries the packages the relay needs" (Test-Path -LiteralPath (Join-Path $Source "$d\ws\package.json"))
}

if (-not $VerifyOnly) {
  Write-Host ''
  Write-Host '--- copy ---'
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Write-Host "  created $Destination"
  }
  foreach ($f in $files) {
    Copy-Item -LiteralPath (Join-Path $Source $f.name) -Destination $Destination -Force
    Write-Host "  copied $($f.name)"
  }
  foreach ($d in $depDirs) {
    # -Recurse and -Force: a partially copied dependency is the failure this script exists to stop.
    Copy-Item -LiteralPath (Join-Path $Source $d) -Destination $Destination -Recurse -Force
    Write-Host "  copied $d\"
  }
}

# ---- verification against what is ACTUALLY at the destination -------------------------------
Write-Host ''
Write-Host '--- verify at the destination ---'
foreach ($f in $files) {
  & $check "$($f.name) exists at the destination" (Test-Path -LiteralPath (Join-Path $Destination $f.name))
}
foreach ($d in $depDirs) {
  & $check "$d\ws is at the destination" (Test-Path -LiteralPath (Join-Path $Destination "$d\ws\package.json"))
}

# Node parses each module. `node --check` reports only the FIRST unexpected token, so this is a
# syntax gate, not a proof -- the proof is the run below.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  & $check 'node is on PATH (needed to verify and to run the relay)' $false
} else {
  foreach ($name in 'relay.mjs', 'prune-shots.mjs', 'pairing.mjs', 'net-address.mjs', 'make-launch-spec.mjs') {
    $target = Join-Path $Destination $name
    if (-not (Test-Path -LiteralPath $target)) { continue }
    & node --check $target 2>&1 | Out-Null
    & $check "$name parses" ($LASTEXITCODE -eq 0)
  }

  # THE DECISIVE CHECK: run the copied relay. `--print-pairing` exits immediately and exercises the
  # whole module graph, which is what a missing relative import breaks.
  Write-Host ''
  Write-Host '--- run the copied relay (this is the check the file list cannot make) ---'
  $relay = Join-Path $Destination 'relay.mjs'
  $out = & node $relay --port $ProbePort --token 'deploy-verify-token' --print-pairing 2>&1
  $code = $LASTEXITCODE
  & $check 'the copied relay starts and prints a pairing string' ($code -eq 0 -and ($out -join "`n") -match 'dshpair1\.') ($out | Select-Object -First 3 | Out-String).Trim()
}

# ---- PowerShell scripts: the deploy gate catches what node cannot ---------------------------
Write-Host ''
Write-Host '--- PowerShell scripts ---'
foreach ($name in 'selfcheck.ps1', 'screenshot.ps1') {
  $target = Join-Path $Destination $name
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $text = Get-Content -LiteralPath $target -Raw
  $bad = @([System.IO.File]::ReadAllBytes($target) | Where-Object { $_ -gt 127 })
  & $check "$name is ASCII-only (PS 5.1 requirement)" ($bad.Count -eq 0) "$($bad.Count) high byte(s)"
  # param() must be the first statement; PS 5.1 reports a violation at the lines that FOLLOW it.
  $paramAt = $text.IndexOf('param(')
  if ($paramAt -ge 0) {
    $before = $text.Substring(0, $paramAt)
    $offending = @($before -split "`n" | Where-Object { $t = $_.Trim(); $t -ne '' -and -not $t.StartsWith('#') })
    & $check "$name has param() first" ($offending.Count -eq 0) ($offending | Select-Object -First 1)
  }
}

Write-Host ''
if ($failures -eq 0) {
  Write-Host 'RESULT: OK -- the worker-side files are in place and the copied relay runs.' -ForegroundColor Green
  Write-Host 'Next: restart the worker relay task, then run prototype\host\plugin-live.mjs from the master.'
  exit 0
}
Write-Host "RESULT: $failures CHECK(S) FAILED" -ForegroundColor Red
exit 1
