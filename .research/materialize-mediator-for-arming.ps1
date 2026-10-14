# materialize-mediator-for-arming.ps1 -- make the sandbox probe pass so arming is allowed.
#
# THE BLOCKER (from the arming dialog):
#
#   cannot arm yet: the sandbox does not contain this machine:
#     the sandbox mediator is not materialized
#
# WHY, from the plugin's own code (lib/core/sandbox-probe.js):
#
#   const mediator = deps.mediator ?? 'C:\\dsh-sandbox-mediator'
#   const shim     = join(mediator, 'shim.mjs')
#   const runner   = join(mediator, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
#   if (!existsSync(shim) || !existsSync(runner)) -> 'the sandbox mediator is not materialized'
#
# and worker-arming.js calls probeSandbox() with NO arguments, so the path is the hardcoded default.
# On this machine the mediator was materialized to C:\dsh-remote\sandbox-mediator instead -- present,
# complete, and invisible to the probe.
#
# profileNamesShim() then requires the profile patch to name THAT EXACT shim:
#   "The exact path matters: a stale mediator from a previous install would still look right by
#    filename while driving an old runner."
# so the profile needs a `sandbox` entry whose runnerCommand is <default>\shim.mjs, plus
# runnerFailureSignatures (sandbox-local rejects a runnerCommand without it).
#
# This copies the materialized mediator to the default location (nothing is moved or deleted) and
# appends the profile entry. The DSH build is unchanged, so the extracted runner still matches it --
# if DSH is ever upgraded, re-run .research/extract-mediator.mjs under Electron-as-node.
#
# ASCII-ONLY, param() first.
param(
  [string]$Source = 'C:\dsh-remote\sandbox-mediator',
  [string]$Target = 'C:\dsh-sandbox-mediator',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$Profile = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ($Profile -eq '') { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

# --- 1. materialize at the path the probe actually looks at -------------------
Say "source: $Source"
Say "target: $Target"
if (-not (Test-Path -LiteralPath $Source)) { Say 'FATAL: source mediator not found'; exit 2 }

if (Test-Path -LiteralPath $Target) {
  Say '  target already exists -- not re-copying'
} else {
  # robocopy exit codes: 0-7 are success, >=8 is failure. Testing for 0 would be wrong.
  $null = robocopy $Source $Target /E /NFL /NDL /NJH /NJS /NP
  $rc = $LASTEXITCODE
  Say "  robocopy exit=$rc (0-7 = success)"
  if ($rc -ge 8) { Say 'FATAL: robocopy failed'; exit 2 }
}

$shim = Join-Path $Target 'shim.mjs'
$runner = Join-Path $Target 'node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js'
Say "  shim.mjs   : $(Test-Path -LiteralPath $shim)"
Say "  runner.js  : $(Test-Path -LiteralPath $runner)"
Say "  node.exe   : $(Test-Path -LiteralPath $NodeExe)"
if (-not (Test-Path -LiteralPath $shim) -or -not (Test-Path -LiteralPath $runner)) {
  Say 'FATAL: mediator incomplete at target'; exit 2
}

# --- 2. name that shim in the profile patch ----------------------------------
$p = Join-Path $Profile 'cordis.patch.yml'
Copy-Item -LiteralPath $p -Destination "$p.bak-sandbox-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force

$text = [System.IO.File]::ReadAllText($p)
if ($text -match '(?m)^\s*-\s*id:\s*sandbox\s*$') {
  Say ''
  Say 'profile already has a sandbox entry -- leaving it alone'
} else {
  $block = @(
    ''
    '# ---------------------------------------------------------------------------'
    '# Windows sandbox: a CONSOLE-subsystem mediator.'
    '#'
    '# dsh-sandbox-local builds the mediator invocation from process.execPath, which in this'
    '# deployment is "DeepSeek Harness.exe" -- a GUI-subsystem image (PE subsystem 2; node.exe is 3).'
    '# Windows never allocates a console to a GUI-subsystem image, so the restricted child dies in'
    '# DLL initialization with 0xC0000142 and EVERY shell command fails with no output at all.'
    '#'
    '# The runner and the shim cannot live inside app.asar (plain node.exe has no asar support), so'
    '# both were materialized to a real directory. The plugin refuses to arm a worker whose sandbox'
    '# cannot be proven, and its probe looks only at C:\dsh-sandbox-mediator and only accepts a'
    '# runnerCommand naming that exact shim.'
    '#'
    '# Re-run .research/extract-mediator.mjs (under Electron-as-node) after a DSH upgrade.'
    '# ---------------------------------------------------------------------------'
    '- id: sandbox'
    '  name: "@deepseek-ai/dsh-sandbox-local"'
    '  config:'
    '    runnerCommand:'
    "      - `"$($NodeExe -replace '\\', '\\\\')`""
    "      - `"$(($shim) -replace '\\', '\\\\')`""
    '    runnerFailureSignatures:'
    '      - "windows-acl-run: "'
  ) -join "`n"
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, $text.TrimEnd() + "`n" + $block + "`n", $enc)
  Say ''
  Say 'appended the sandbox entry to the profile patch'
}

$b = [System.IO.File]::ReadAllBytes($p)
Say "profile: $($b.Length) bytes  hasBOM=$($b[0] -eq 0xEF)"
if ($b[0] -eq 0xEF) { Say 'FATAL: BOM written'; exit 2 }

Say ''
Say '--- profile tail ---'
Get-Content -LiteralPath $p -Tail 9 | ForEach-Object { Say "  $_" }

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
