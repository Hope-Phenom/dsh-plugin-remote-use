# deploy-ps1.ps1 -- validate and push a PowerShell script to the worker.
#
# WHY A GATE: a single non-ASCII byte in a BOM-less .ps1 makes Windows PowerShell 5.1 parse
# the file as ANSI and fail with an unrelated syntax error ("TerminatorExpectedAtEndOfString"
# on some innocent line). A local `Parser::ParseFile` check does NOT catch it, because the
# local shell may be PowerShell 7, which reads UTF-8 correctly. The only reliable check is
# the byte scan, so it is enforced here rather than left to discipline.
#
# Usage: deploy-ps1.ps1 -Path <file> [-TargetName <name>]
#        deploy-ps1.ps1 -Path <file> -ValidateOnly
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$TargetName = '',
  [string]$TargetDir = 'C:\dsh-remote',
  [string]$SshKey = 'C:\Users\you\.dsh-remote-ops\id_ed25519_worker-pc',
  [string]$SshHost = 'worker-pc',
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Path)) { throw "not found: $Path" }
$full = (Resolve-Path $Path).Path
$name = if ($TargetName -ne '') { $TargetName } else { Split-Path $full -Leaf }

$problems = @()

# --- 1. byte purity: the check that actually matters -------------------------
$bytes = [System.IO.File]::ReadAllBytes($full)
$nonAscii = @($bytes | Where-Object { $_ -gt 127 })
$hasUtf8Bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$hasUtf16Bom = ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF)))

if ($nonAscii.Count -gt 0 -and -not $hasUtf8Bom -and -not $hasUtf16Bom) {
  $problems += "contains $($nonAscii.Count) non-ASCII byte(s) with no BOM"
  # Show where, so the fix is obvious.
  $text = Get-Content $full
  for ($i = 0; $i -lt $text.Count; $i++) {
    if ($text[$i] -match '[^\x00-\x7F]') { $problems += "  line $($i + 1): $($text[$i].Trim())" }
  }
}

# --- 2. syntax, parsed the way the WORKER will parse it ----------------------
# Decode as ANSI on purpose: that is what PS 5.1 does with a BOM-less file.
if (-not $hasUtf8Bom -and -not $hasUtf16Bom) {
  $ansi = [System.Text.Encoding]::GetEncoding(1252)
  $asAnsi = $ansi.GetString($bytes)
  $tmp = Join-Path $env:TEMP ("ps1check-" + [guid]::NewGuid().ToString('N') + ".ps1")
  [System.IO.File]::WriteAllText($tmp, $asAnsi, $ansi)
  $errs = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($tmp, [ref]$null, [ref]$errs)
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if ($errs -and $errs.Count -gt 0) {
    $problems += "parse errors when decoded as ANSI (what PS 5.1 does):"
    $errs | Select-Object -First 5 | ForEach-Object { $problems += "  line $($_.Extent.StartLineNumber): $($_.Message)" }
  }
}

# --- report ------------------------------------------------------------------
if ($problems.Count -gt 0) {
  Write-Output "VALIDATION FAILED: $name"
  $problems | ForEach-Object { Write-Output "  $_" }
  Write-Output ""
  Write-Output "Fix: keep the file pure ASCII, or write it as UTF-8 WITH a BOM."
  exit 1
}
Write-Output "VALIDATION OK: $name  ($($bytes.Length) bytes, ASCII-only=$(($nonAscii.Count -eq 0)))"
if ($ValidateOnly) { exit 0 }

# --- deploy ------------------------------------------------------------------
Write-Output "copying to ${SshHost}:$TargetDir/$name ..."
& scp -i $SshKey -o BatchMode=yes -o IdentitiesOnly=yes $full "${SshHost}:$TargetDir/$name" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "scp failed with $LASTEXITCODE" }
Write-Output "deployed."
