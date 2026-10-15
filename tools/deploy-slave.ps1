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
# TWO MODES, and which one you want matters:
#
#   local   -Destination <dir>                        copy within this machine
#   remote  -Remote <sshHost> -Destination <dir>      scp, then verify ON THE TARGET
#
# WHY THE REMOTE MODE EXISTS: the first version only did `Copy-Item`, so deploying to another machine
# meant a UNC destination -- and its "run the copied relay" check then executed LOCALLY against a
# share. That verifies the module graph of the right bytes on the WRONG machine: a different node
# build, a different OS state, and a different `node_modules` resolution root. The failure this
# script exists to catch (`cannot find package 'ws'`) can differ between the two.
#
# So in remote mode the verification runs over SSH, on the worker, and its EXIT CODES are checked. A
# deployment that cannot prove the target runs the result has not been verified -- and the earlier
# `find-slave.ps1` reported success for a hosts write it had not made, which is the same mistake.
#
#   -Destination <dir>   where the worker keeps its scripts (e.g. C:\dsh-remote\plugin-slave)
#   -Remote <sshHost>    deploy to that host (an ssh config alias is fine)
#   -Source <dir>        defaults to this repository's package
#   -VerifyOnly          do not copy; only check what is already at -Destination
#   -ProbePort <n>       port used for the --print-pairing run (default 7394)
#
# ASCII-ONLY, because Windows PowerShell 5.1 reads BOM-less files as ANSI and a non-ASCII byte
# inside a string literal breaks parsing. `param()` is the first statement for the same reason it is
# everywhere else in this project.
param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [string]$Remote = '',
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
# In remote mode the destination is a path ON THE TARGET, so it must not be resolved locally.
$remoteMode = $Remote -ne ''
if (-not $remoteMode) { $Destination = [System.IO.Path]::GetFullPath($Destination) }

Write-Host "source      : $Source"
Write-Host "destination : $(if ($remoteMode) { "$Remote`:$Destination" } else { $Destination })"
Write-Host "mode        : $(if ($remoteMode) { 'REMOTE (scp, verify on the target)' } elseif ($VerifyOnly) { 'verify only' } else { 'copy and verify (local)' })"
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
  @{ name = 'make-launch-spec.mjs'; why = 'optional: generates the ACP launch spec' },
  @{ name = 'permission-pairing.mjs'; why = 'IMPORTED BY make-launch-spec.mjs (the F34 mode/profile gate)' },
  @{ name = 'acp-profile-approval.patch.yml'; why = 'the approval row a session-mode grant needs, or the worker becomes unreachable (F34)' }
)

# `ws` IS A DEPENDENCY OF THE RELAY, and leaving it out is what this script's run-check caught on
# its first rehearsal: the deployment listed every script, verified every parse, and then the relay
# died with `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`. A bare package import does not show up
# in a file list the way a relative one does, which is exactly why the check is a RUN and not a
# checklist. DESIGN section 19 had the same omission.
$depDirs = @('node_modules')

$failures = 0
# Forward slashes for anything that crosses into the remote SHELL. Defined here rather than inside
# the copy branch, because `-VerifyOnly -Remote` needs it too and would otherwise get $null.
$remotePath = if ($remoteMode) { $Destination -replace '\\', '/' } else { $Destination }
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
  # ACTIONABLE, because the most likely cause has a one-command fix.
  #
  # `.gitignore`'s `node_modules/` rule matches at any depth, so `slave/node_modules` is NOT in git:
  # a fresh clone has the relay but not its dependency. `slave/package.json` exists precisely so the
  # repair is one line rather than "work out what the relay needs and where it goes".
  if (-not (Test-Path -LiteralPath (Join-Path $Source 'node_modules'))) {
    Write-Host ''
    Write-Host '  `slave/node_modules` is not in git (the node_modules rule matches at any depth).' -ForegroundColor Yellow
    Write-Host '  Repair it from the package directory:' -ForegroundColor Yellow
    Write-Host '      npm install --prefix packages/dsh-plugin-remote-use/slave' -ForegroundColor Yellow
  }
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
  if ($remoteMode) {
    # scp rather than a UNC share: the SSH channel is already configured and its key is what proves
    # which machine this is, so no additional share, credential or firewall rule is needed.
    #
    # THE PATH GOES OVER AS FORWARD SLASHES. The remote side of an scp is a SHELL, and the reference
    # worker's shell is bash: a Windows path with backslashes arrives as `C:dsh-remoteplugin-slave`
    # after bash eats them, and scp fails with a bare exit 1 and no useful message. Measured -- the
    # same transfer with forward slashes succeeds. The `cmd /c` checks below keep backslashes,
    # because those go to cmd rather than to bash -- $remotePath (defined above) is what crosses
    # into the remote shell.
    # ...and the directory has to exist first: scp does not create it.
    & ssh -o BatchMode=yes -o ConnectTimeout=15 $Remote "cmd /c if not exist `"$Destination`" mkdir `"$Destination`"" 2>&1 | Out-Null

    $scpArgs = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')
    $ok = $true
    foreach ($f in $files) {
      # NOT piped to Out-Null: a failing transfer has to say why. Swallowing scp's stderr is how the
      # first run of this mode reported seven bare `exit 1` lines with nothing to act on.
      $err = & scp @scpArgs (Join-Path $Source $f.name) "${Remote}:$remotePath/" 2>&1
      if ($LASTEXITCODE -ne 0) { $ok = $false; & $check "scp $($f.name)" $false (($err | Select-Object -First 2) -join ' ') }
      else { Write-Host "  scp $($f.name)" }
    }
    foreach ($d in $depDirs) {
      # -r: a partially copied dependency is exactly what this script exists to prevent.
      $err = & scp @scpArgs -r (Join-Path $Source $d) "${Remote}:$remotePath/" 2>&1
      if ($LASTEXITCODE -ne 0) { $ok = $false; & $check "scp $d\" $false (($err | Select-Object -First 2) -join ' ') }
      else { Write-Host "  scp $d\" }
    }
    if (-not $ok) {
      Write-Host ''
      Write-Host 'Transfer failed; NOT verifying a partial copy.' -ForegroundColor Red
      exit 1
    }
  } else {
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
}

# ---- verification against what is ACTUALLY at the destination -------------------------------
Write-Host ''
Write-Host "--- verify at the destination $(if ($remoteMode) { "(on $Remote)" } else { '(locally)' }) ---"

# `ssh` RESERVES EXIT 255 FOR ITS OWN FAILURES (unresolvable host, refused connection, auth). Any
# other code is the REMOTE COMMAND's answer. Conflating the two is how a network blip turns into
# "the deployment is incomplete": a transient name-resolution failure once reported every single
# file as missing while all of them were present and the relay was running from that directory.
#
# So an unanswered question is tracked separately and reported as its own outcome, never as a
# negative answer. This is the same mistake as `find-slave.ps1` reporting a hosts write it had not
# made -- a check that states something it did not establish.
$script:unreachable = 0
function Invoke-Remote {
  param([string]$Command, [int]$Attempts = 3)
  $out = @()
  for ($i = 1; $i -le $Attempts; $i++) {
    $out = & ssh -o BatchMode=yes -o ConnectTimeout=20 $Remote $Command 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 255) { return @{ answered = $true; code = $code; out = $out } }
    if ($i -lt $Attempts) { Start-Sleep -Seconds 2 }
  }
  return @{ answered = $false; code = 255; out = $out }
}

# In remote mode every existence check runs on the target too. Checking locally that scp "probably"
# worked is the same class of shortcut as running the relay on the wrong machine.
#
# TRI-STATE, because a caller that can only see `true`/`false` cannot tell "the file is absent" from
# "I could not ask" -- and those need opposite messages. Returns 'yes', 'no', or 'unknown'.
$exists = {
  param($relPath)
  if ($remoteMode) {
    # `cmd /c if exist` keeps this to one remote invocation and a real exit code, and avoids
    # depending on which shell the target's ssh hands us (the reference worker uses bash).
    $r = Invoke-Remote "cmd /c if exist `"$Destination\$relPath`" (exit 0) else (exit 1)"
    if (-not $r.answered) { $script:unreachable = $script:unreachable + 1; return 'unknown' }
    if ($r.code -eq 0) { return 'yes' }
    return 'no'
  }
  if (Test-Path -LiteralPath (Join-Path $Destination $relPath)) { return 'yes' }
  return 'no'
}

foreach ($f in $files) {
  $q = & $exists $f.name
  if ($q -eq 'unknown') { Write-Host "  [SKIP] $($f.name) exists at the destination -- could not reach $Remote" -ForegroundColor Yellow }
  else { & $check "$($f.name) exists at the destination" ($q -eq 'yes') }
}
foreach ($d in $depDirs) {
  $q = & $exists "$d\ws\package.json"
  if ($q -eq 'unknown') { Write-Host "  [SKIP] $d\ws is at the destination -- could not reach $Remote" -ForegroundColor Yellow }
  else { & $check "$d\ws is at the destination" ($q -eq 'yes') }
}

# Node parses each module. `node --check` reports only the FIRST unexpected token, so this is a
# syntax gate, not a proof -- the proof is the run below.
$nodeHere = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $remoteMode -and -not $nodeHere) {
  & $check 'node is on PATH (needed to verify and to run the relay)' $false
} else {
  foreach ($name in 'relay.mjs', 'prune-shots.mjs', 'pairing.mjs', 'net-address.mjs', 'make-launch-spec.mjs') {
    if ((& $exists $name) -ne 'yes') { continue }
    if ($remoteMode) {
      $r = Invoke-Remote "node --check $Destination/$name"
      if (-not $r.answered) { $script:unreachable = $script:unreachable + 1; continue }
      & $check "$name parses (on the target)" ($r.code -eq 0)
      continue
    }
    & node --check (Join-Path $Destination $name) 2>&1 | Out-Null
    & $check "$name parses (on the target)" ($LASTEXITCODE -eq 0)
  }

  # THE DECISIVE CHECK: run the deployed relay. `--print-pairing` exits immediately and exercises the
  # whole module graph, which is what a missing relative import -- or a missing bare package -- breaks.
  #
  # In remote mode this runs ON THE WORKER. That is the whole point of the mode: the answer to "does
  # this deployment start" depends on the target's node, its node_modules resolution and its OS, so
  # only the target can answer it.
  Write-Host ''
  Write-Host '--- run the deployed relay (this is the check the file list cannot make) ---'
  $code = -1
  if ($remoteMode) {
    $r = Invoke-Remote "node $Destination/relay.mjs --port $ProbePort --token deploy-verify-token --print-pairing"
    if (-not $r.answered) {
      $script:unreachable = $script:unreachable + 1
      Write-Host '  [SKIP] could not reach the worker to run the relay' -ForegroundColor Yellow
      $out = @()
      $code = -1
    } else { $out = $r.out; $code = $r.code }
  } else {
    $out = & node (Join-Path $Destination 'relay.mjs') --port $ProbePort --token 'deploy-verify-token' --print-pairing 2>&1
    $code = $LASTEXITCODE
  }
  & $check 'the deployed relay starts and prints a pairing string' ($code -eq 0 -and ($out -join "`n") -match 'dshpair1\.') ($out | Select-Object -First 3 | Out-String).Trim()
}

# ---- PowerShell scripts: the deploy gate catches what node cannot ---------------------------
Write-Host ''
Write-Host '--- PowerShell scripts ---'
#
# IN REMOTE MODE THE FILES ARE PULLED BACK AND CHECKED HERE, rather than checked through a remote
# PowerShell one-liner. The first version composed `ssh host "powershell -NoProfile -Command \"...\""`
# with a `$_` and nested quotes inside, and bash on the target mangled it: both checks failed with
# the target's own PARSE error (a position/character offset, not a message about the script).
#
# Pulling the bytes back is not a weaker check. The question is whether the copy ON THE TARGET is
# ASCII-only and starts with `param()`, and scp returns exactly those bytes; what changes is that no
# shell gets to reinterpret the command.
$localForScripts = $Destination
if ($remoteMode) {
  $localForScripts = Join-Path ([System.IO.Path]::GetTempPath()) "deploy-slave-check-$PID"
  New-Item -ItemType Directory -Force -Path $localForScripts | Out-Null
  foreach ($name in 'selfcheck.ps1', 'screenshot.ps1') {
    & scp -q -o BatchMode=yes -o ConnectTimeout=20 "${Remote}:$remotePath/$name" $localForScripts 2>&1 | Out-Null
  }
}
foreach ($name in 'selfcheck.ps1', 'screenshot.ps1') {
  $target = Join-Path $localForScripts $name
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $text = Get-Content -LiteralPath $target -Raw
  $bad = @([System.IO.File]::ReadAllBytes($target) | Where-Object { $_ -gt 127 })
  & $check "$name is ASCII-only (PS 5.1 requirement)" ($bad.Count -eq 0) "$($bad.Count) high byte(s)"
  # param() must be the first statement; PS 5.1 reports a violation at the lines that FOLLOW it.
  $paramAt = $text.IndexOf('param(')
  & $check "$name has param()" ($paramAt -ge 0)
  if ($paramAt -ge 0) {
    $before = $text.Substring(0, $paramAt)
    $offending = @($before -split "`n" | Where-Object { $t = $_.Trim(); $t -ne '' -and -not $t.StartsWith('#') })
    & $check "$name has param() first" ($offending.Count -eq 0) ($offending | Select-Object -First 1)
  }
}
if ($remoteMode -and (Test-Path -LiteralPath $localForScripts)) {
  Remove-Item $localForScripts -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
# AN UNANSWERED CHECK IS NOT A FAILED CHECK. If any check could not be put to the worker at all, the
# honest result is "not verified" -- a distinct outcome with its own exit code -- and never the
# reassuring "OK" nor the alarming "the deployment is incomplete".
if ($script:unreachable -gt 0) {
  Write-Host "RESULT: COULD NOT VERIFY -- $($script:unreachable) check(s) could not reach $Remote." -ForegroundColor Yellow
  Write-Host 'The transfer itself may have succeeded; re-run with -VerifyOnly when the worker is reachable.'
  exit 3
}
if ($failures -eq 0) {
  Write-Host 'RESULT: OK -- the worker-side files are in place and the deployed relay runs.' -ForegroundColor Green
  Write-Host 'Next: restart the worker relay task, then run prototype\host\plugin-live.mjs from the master.'
  exit 0
}
Write-Host "RESULT: $failures CHECK(S) FAILED" -ForegroundColor Red
exit 1
