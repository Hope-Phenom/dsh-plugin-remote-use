<#
.SYNOPSIS
  Remove the dead `- id: dsh-plugin-remote-use` config block from a profile patch.

.WHY THIS EXISTS

  The block was written before the Settings page managed workers. It names an old worker id
  (`worker-pc`) and an OLD 40-character bearer token, and it does nothing: the plugin merges
  `~/.dsh/storages/dsh-plugin-remote-use/settings.json` OVER its Cordis config at runtime, and that
  file supplies `workers`, `approvalTimeoutMs` and `requiredTier`. `injectTaskSummary: true` is
  already the schema default. So the block is dead config that carries a stale credential and
  misleads whoever reads the patch next.

  NOTE ON PRECEDENCE, because it is easy to get wrong: the settings file is NOT a Cordis layer.
  `--dump-config` shows the block's values, while the RUNNING plugin shows the settings file's.
  That is why the dump cannot prove the worker list survives -- the settings file has to be checked
  directly, and this script does both.

.DESIGN OF THE EDIT (why it is safe to run)

  * CONTENT-ANCHORED: it finds the managed block by its comment banner, never by line number.
  * REFUSES WHAT IT DOES NOT UNDERSTAND: lone LFs, no block, two blocks, or a block without the row
    id all abort before anything is written.
  * PROVES THE REST IS UNTOUCHED: the sandbox section (its banner to EOF) must be byte-identical.
    That row MUST survive -- it is what keeps a GUI-subsystem DSH from breaking every shell command.
  * VERIFIED BY THE OFFICIAL READ-ONLY CLI: `dsh --profile acp --dump-config --patch <bundle patch>
    --patch <file>`. Layer in the plugin's own bundle patch so the plugin ROW composes on the `acp`
    stand-in (per PITFALLS F12; `desktop` itself cannot be dumped -- the CLI rejects the reserved
    profile). Then:
      - every patch entry must still resolve exactly as before (no notice appears or disappears);
      - the composed row must still exist, now carrying the bundle's default (`workers: []`), and the
        old worker id must be gone from the tree.
  * THE RUNTIME SOURCE OF TRUTH IS CHECKED TOO: the settings file must still name a worker whose
    `cwd` is usable -- that is what the plugin will actually use after this edit.
  * BACKED UP AND AUTO-ROLLED-BACK on any failed post-write check.

  Dry run by default. Pass -Apply to write.

.EXAMPLE
  pwsh -File .research\drop-dead-plugin-config.ps1
  pwsh -File .research\drop-dead-plugin-config.ps1 -Apply
#>
[CmdletBinding()]
param(
  [string]$Patch = "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml",
  [string]$Settings = "$env:USERPROFILE\.dsh\storages\dsh-plugin-remote-use\settings.json",
  [string]$BundlePatch = '',
  [string]$DumpProfile = 'acp',
  [string]$OldWorkerId = 'worker-pc',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$rowId = 'dsh-plugin-remote-use'
$fail = 0
function Say($ok, $label, $detail = '') {
  $tag = if ($ok) { 'ok  ' } else { 'FAIL' }
  Write-Host ("  [{0}] {1}{2}" -f $tag, $label, $(if ($detail -eq '') { '' } else { " -- $detail" }))
  if (-not $ok) { $script:fail += 1 }
}
function Note($label) { Write-Host ("  [note] " + $label) }

if (-not (Test-Path -LiteralPath $Patch)) { throw "no patch at $Patch" }
$Patch = (Resolve-Path -LiteralPath $Patch).Path
if ($BundlePatch -eq '') {
  # `$PSScriptRoot` is <repo>\.research, so the repo root is ONE level up.
  $candidate = Join-Path (Split-Path -Parent $PSScriptRoot) 'packages\dsh-plugin-remote-use\cordis.patch.yml'
  if (Test-Path -LiteralPath $candidate) { $BundlePatch = (Resolve-Path -LiteralPath $candidate).Path }
}
Write-Host "patch  : $Patch"
Write-Host "bundle : $(if ($BundlePatch -eq '') { '(not found -- the composed-row checks will be reported as NOT VERIFIED)' } else { $BundlePatch })"
Write-Host "mode   : $(if ($Apply) { 'APPLY' } else { 'DRY RUN (nothing is written)' })"

# --- read, refusing anything we cannot edit losslessly ------------------------------
$bytes = [System.IO.File]::ReadAllBytes($Patch)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  throw 'the patch has a UTF-8 BOM; DSH parses profile files with a bare reader and a BOM has broken an install before (PITFALLS E8). Fix that first.'
}
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$crlf = ([regex]::Matches($text, "`r`n")).Count
$loneLf = ([regex]::Matches($text, "(?<!`r)`n")).Count
Say ($loneLf -eq 0) 'line endings are uniform' "CRLF=$crlf loneLF=$loneLf"
if ($loneLf -ne 0) { Write-Host 'refusing: mixed line endings would make a line-based edit lossy'; exit 2 }

$lines = $text -split "`r`n"

# --- locate the block by content ----------------------------------------------------
$starts = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match ('^# --- ' + [regex]::Escape($rowId) + ' managed') })
$ends = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match ('^# --- end ' + [regex]::Escape($rowId) + ' managed ---\s*$') })
Say ($starts.Count -eq 1) 'exactly one start banner' "found $($starts.Count)"
Say ($ends.Count -eq 1) 'exactly one end banner' "found $($ends.Count)"
if ($starts.Count -ne 1 -or $ends.Count -ne 1) { exit 2 }
$s = $starts[0]
$e = $ends[0]
Say ($s -lt $e) 'the banners are in order' "start=$($s + 1) end=$($e + 1)"

$block = $lines[$s..$e]
Say ([bool]($block -match ('^\s*- id: ' + [regex]::Escape($rowId) + '\s*$'))) 'the block holds the row it claims to'
Say ([bool]($block -match '^\s*token:')) 'the block holds the stale credential being removed'
Say ([bool]($block -match [regex]::Escape($OldWorkerId))) 'the block holds the old worker id' $OldWorkerId

# --- the part that must survive -----------------------------------------------------
$sandboxAt = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match '^\s*- id: sandbox\s*$' })
Say ($sandboxAt.Count -ge 1) 'a `- id: sandbox` row is present and must be kept' "at line $($sandboxAt[0] + 1)"
if ($sandboxAt.Count -lt 1) { exit 2 }
$bannerAt = $sandboxAt[0]
for ($i = $sandboxAt[0]; $i -ge 0; $i--) { if ($lines[$i] -match '^# -{5,}') { $bannerAt = $i; break } }
if ($bannerAt -le $e) { $bannerAt = $sandboxAt[0] }
$tailBefore = ($lines[$bannerAt..($lines.Count - 1)] -join "`r`n")
Write-Host "  keeping from line $($bannerAt + 1) to EOF ($($lines.Count - $bannerAt) lines)"

# --- build the new content -----------------------------------------------------------
$removeEnd = $e
if (($removeEnd + 1) -lt $lines.Count -and $lines[$removeEnd + 1].Trim() -eq '') { $removeEnd = $removeEnd + 1 }
Write-Host "`n  would remove lines $($s + 1)..$($removeEnd + 1):"
$lines[$s..$removeEnd] | ForEach-Object { Write-Host ("    | " + $_) }
Write-Host ''

$newLines = @()
if ($s -gt 0) { $newLines += $lines[0..($s - 1)] }
if (($removeEnd + 1) -le ($lines.Count - 1)) { $newLines += $lines[($removeEnd + 1)..($lines.Count - 1)] }
$newText = ($newLines -join "`r`n")

$newBannerAt = $bannerAt - ($removeEnd - $s + 1)
Say (($newLines[$newBannerAt..($newLines.Count - 1)] -join "`r`n") -ceq $tailBefore) 'the sandbox section is byte-identical afterwards'
Say (-not ($newText -match [regex]::Escape($rowId))) 'the dead block is gone from the candidate'
Say ($newText -match '(?m)^\s*- id: sandbox\s*$') 'the sandbox row is still in the candidate'

# --- what the OFFICIAL CLI says ------------------------------------------------------
# Notices are reduced to the ENTRY NAME: the raw line carries the file path, which differs between
# the real patch and the temp candidate, so comparing raw lines makes every notice look changed.
function Get-Dump([string]$Path) {
  $argv = @('--profile', $DumpProfile, '--dump-config')
  if ($BundlePatch -ne '') { $argv += @('--patch', $BundlePatch) }
  $argv += @('--patch', $Path)
  $raw = & dsh @argv 2>&1 | Out-String
  $code = $LASTEXITCODE
  $entries = @($raw -split "`r?`n" | ForEach-Object { if ($_ -match 'entry "([^"]+)" not found') { $matches[1] } } | Sort-Object)
  return @{ code = $code; missing = $entries; raw = $raw }
}

$before = Get-Dump $Patch
Say ($before.code -eq 0) 'the CLI parses the CURRENT patch' "exit=$($before.code)"
if ($before.code -ne 0) { exit 2 }

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("cordis-patch-candidate-{0}.yml" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
[System.IO.File]::WriteAllText($temp, $newText, (New-Object System.Text.UTF8Encoding($false)))
try {
  $after = Get-Dump $temp
  Say ($after.code -eq 0) 'the CLI parses the CANDIDATE patch' "exit=$($after.code)"
  $appeared = @($after.missing | Where-Object { $before.missing -notcontains $_ })
  $gone = @($before.missing | Where-Object { $after.missing -notcontains $_ })
  Say ($appeared.Count -eq 0) 'no patch entry stopped resolving' ($appeared -join ',')
  Say ($gone.Count -eq 0) 'and none started resolving differently' ($gone -join ',')

  if ($BundlePatch -ne '') {
    $rowLines = @($after.raw -split "`r?`n")
    $at = ($rowLines | Select-String -Pattern ('^- id: ' + [regex]::Escape($rowId) + '\s*$') | Select-Object -First 1).LineNumber
    Say ($at -ne $null) 'the composed tree still holds the plugin row (it comes from the bundle patch)'
    if ($at -ne $null) {
      $rowBlock = ($rowLines[($at - 1)..([Math]::Min($at + 8, $rowLines.Count - 1))] -join "`n")
      Say ([bool]($rowBlock -match 'workers: \[\]')) 'the row now carries the bundle default (workers: [])' ''
      Say (-not ($after.raw -match [regex]::Escape($OldWorkerId))) 'the old worker id is gone from the composed tree'
    }
  } else {
    Note 'the composed-row checks are NOT VERIFIED (no bundle patch was found to layer in)'
  }
} finally {
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}

# --- the runtime source of truth -----------------------------------------------------
if (Test-Path -LiteralPath $Settings) {
  $cfg = Get-Content -LiteralPath $Settings -Raw | ConvertFrom-Json
  $workers = @($cfg.workers)
  Say ($workers.Count -ge 1) 'the settings file still names at least one worker' "count=$($workers.Count)"
  $usable = @($workers | Where-Object { $_.cwd -match '^([a-zA-Z]:[\\/]|/)' })
  Say ($usable.Count -eq $workers.Count -and $workers.Count -ge 1) 'every configured worker has an absolute task directory' `
    (($workers | ForEach-Object { "$($_.id)=$($_.cwd)" }) -join ' ')
  Note 'the plugin merges this file over its Cordis config at runtime, so this -- not the patch -- is what the running master will use.'
} else {
  Say $false 'the settings file exists' $Settings
}

Write-Host ''
if ($fail -gt 0) { Write-Host "  $fail CHECK(S) FAILED -- nothing was written."; exit 1 }
if (-not $Apply) { Write-Host '  all checks passed. Re-run with -Apply to write.'; exit 0 }

# --- write, then re-verify the real file ---------------------------------------------
$backup = '{0}.bak-{1}' -f $Patch, (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $Patch -Destination $backup -Force
Write-Host "  backup: $backup"
[System.IO.File]::WriteAllText($Patch, $newText, (New-Object System.Text.UTF8Encoding($false)))

$verify = Get-Dump $Patch
$written = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($Patch))
$bad = @()
if ($verify.code -ne 0) { $bad += 'the CLI no longer parses the written file' }
if ($written -match [regex]::Escape($rowId)) { $bad += 'the dead block is still present' }
if (-not ($written -match '(?m)^\s*- id: sandbox\s*$')) { $bad += 'the sandbox row is missing' }
if ($verify.missing.Count -ne $before.missing.Count) { $bad += 'the set of unmatched patch entries changed' }

if ($bad.Count -gt 0) {
  Write-Host ('  ROLLING BACK: ' + ($bad -join '; '))
  Copy-Item -LiteralPath $backup -Destination $Patch -Force
  Write-Host '  restored from the backup.'
  exit 1
}
Write-Host "  written and re-verified. Backup kept at:`n    $backup"
exit 0
