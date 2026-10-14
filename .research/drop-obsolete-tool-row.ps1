# drop-obsolete-tool-row.ps1 -- remove the per-worker dsh-tool-subagent row from the profile patch.
#
# WHY IT IS NOT MERELY TIDINESS. The row names `@deepseek-ai/dsh-tool-subagent` with
# `provider: remote-worker-pc`. `dsh-tool-subagent` validates its own config inside the
# `subagent/provider-added` listener, and Cordis `emit` PROPAGATES listener exceptions -- so a
# rejected config there rolls back the WHOLE provider registration. Since 0.2.0 the plugin's
# `remote_subagent` tool calls that provider directly, which means this stale row is now a way to
# break the new tool. It also never had any effect on what the model sees: a Web session's tool
# catalog is enumerated by the agent preset (PITFALLS F11).
#
# HOW THIS EDIT IS KEPT SAFE (the previous two profile edits corrupted live config):
#   1. content-anchored deletion, not line numbers
#   2. a timestamped backup beside the file
#   3. BOM check on the result
#   4. VALIDATION with the tool the official docs describe: `dsh --profile acp --dump-config
#      --patch <this file>`. A parse error exits nonzero, so a surviving nonzero exit means the
#      edit is bad and the backup is restored automatically.
#      (The `patch: entry ... not found` lines it prints for rows absent from the acp profile are
#      expected and harmless -- exit code 0 is the gate.)
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

$p = Join-Path $Profile 'cordis.patch.yml'
$bak = "$p.bak-droptoolrow-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $p -Destination $bak -Force
Say "backup : $bak"

$lines = [System.IO.File]::ReadAllLines($p)
Say "before : $($lines.Count) lines"

$startAnchor = '# One tool row per worker.'
$endAnchor = '# --- end dsh-plugin-remote-use managed ---'
$start = -1; $end = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($start -lt 0 -and $lines[$i].StartsWith($startAnchor)) { $start = $i }
  if ($lines[$i].Trim() -eq $endAnchor) { $end = $i; break }
}
Say "anchors: start=$start end=$end"
if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
  Say 'FATAL: could not locate the block by content anchors; nothing changed'
  Remove-Item -LiteralPath $bak -Force
  exit 2
}
# NOTE on the operator: `-match` on an ARRAY returns the elements that match, and `-notmatch`
# returns the ones that do NOT -- so `if ($array -notmatch 'x')` is true whenever any line fails to
# match, which is almost always. The first version of this script had that bug and refused a
# correct deletion. The check must be "did ANY line in the span match".
if (-not (@($lines[($start..($end-1))]) -match 'tool-subagent-remote')) {
  Say 'FATAL: the span does not contain the expected row id; refusing to delete'
  Remove-Item -LiteralPath $bak -Force
  exit 2
}

# Keep the blank line that separated the plugin row from the block, drop the rest.
$kept = @($lines[0..($start-1)]) + @($lines[$end..($lines.Count-1)])
$out = ($kept -join "`r`n") + "`r`n"
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($p, $out, $enc)

$b = [System.IO.File]::ReadAllBytes($p)
Say "after  : $($kept.Count) lines  $($b.Length) bytes  hasBOM=$($b[0] -eq 0xEF)"
if ($b[0] -eq 0xEF) { Say 'FATAL: BOM written'; Copy-Item $bak $p -Force; exit 2 }

# ---- validate with the official dump -------------------------------------------------------
$exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
$cli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$env:ELECTRON_RUN_AS_NODE = '1'
$dump = Join-Path $env:TEMP 'validate-droptoolrow.out.txt'
$errf = Join-Path $env:TEMP 'validate-droptoolrow.err.txt'
Say ''
Say 'validating with: dsh --profile acp --dump-config --patch <this file>'
$proc = Start-Process -FilePath $exe -ArgumentList "--expose-internals `"$cli`" --profile acp --dump-config --patch `"$p`"" -NoNewWindow -PassThru -RedirectStandardOutput $dump -RedirectStandardError $errf
$proc.WaitForExit(120000) | Out-Null
if (-not $proc.HasExited) { $proc.Kill(); Say 'FATAL: dump timed out'; Copy-Item $bak $p -Force; exit 2 }
Say "  exit=$($proc.ExitCode)"

if ($proc.ExitCode -ne 0) {
  Say 'VALIDATION FAILED -- restoring the backup'
  Get-Content $errf -EA SilentlyContinue | Select-Object -First 8 | ForEach-Object { Say "    $_" }
  Copy-Item $bak $p -Force
  Say 'restored'
  exit 2
}

$dumpLines = (Get-Content $dump -EA SilentlyContinue | Measure-Object).Count
Say "  dump produced $dumpLines lines"
Say '  no parse error; the profile patch is still valid'

Say ''
Say '--- the managed block now ---'
$nl = Get-Content -LiteralPath $p
$i = ($nl | Select-String -Pattern 'dsh-plugin-remote-use managed' | Select-Object -First 1).LineNumber
$nl[($i-1)..([Math]::Min($i+6, $nl.Count-1))] | ForEach-Object { Say "  $_" }
Say '  ...'
$j = ($nl | Select-String -Pattern 'end dsh-plugin-remote-use managed' | Select-Object -First 1).LineNumber
$nl[([Math]::Max(0,$j-4))..($j-1)] | ForEach-Object { Say "  $_" }

Say ''
Say "rollback if needed: Copy-Item '$bak' '$p' -Force"

$rtext = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $rtext -Encoding UTF8 }
