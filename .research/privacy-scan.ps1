<#
.SYNOPSIS
  Scan the repository for values that must never be public.

.WHY THIS SHAPE

  The list of things to look for is NOT in this file: it is read at run time from
  `.research/privacy-replacements.txt`, which is gitignored precisely because it holds the REAL
  values. A scanner that hardcoded them would leak exactly what it is meant to protect. This way
  the check is repeatable and the repository stays clean.

  Every hit is reported as file:line with the value REPLACED BY «REDACTED», so the output can be
  pasted into a report without re-leaking anything.

.TWO CHECKS, BOTH NEEDED

  1. THE CURRENT TREE. Tracked text files only (`git ls-files`), so a match is something that would
     be published if you pushed right now.
  2. THE WHOLE HISTORY. `git log --all -S<value>`: a value that was committed and later removed is
     still public in the old commits. Rewriting history is a separate decision, but you cannot make
     it without knowing this.

.EXAMPLE
  pwsh -File .research/privacy-scan.ps1
#>
[CmdletBinding()]
param(
  [string]$Keys = '.research\privacy-replacements.txt',
  [string]$Settings = "$env:USERPROFILE\.dsh\storages\dsh-plugin-remote-use\settings.json",
  [int]$MaxHitsPerKey = 8
)

$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path

# --- the key list: real values, never printed -----------------------------------------
if (-not (Test-Path $Keys)) { throw "no key file at $Keys (it is gitignored: that is expected on a fresh clone, but then this scan cannot run)" }
$pairs = @()
$skipped = 0
foreach ($line in Get-Content $Keys) {
  $t = $line.Trim()
  if ($t -eq '' -or $t.StartsWith('#')) { continue }
  # THE SEPARATOR IS `==>`. Splitting on `=>` (or on the first `=`) leaves a trailing `=` on the key,
  # and a key with one extra character matches NOTHING -- which reads as "clean". That is exactly how
  # the first rewrite of this history became a no-op while the check that followed it reported success.
  $parts = $t -split '==>', 2
  if ($parts.Count -lt 2) { $skipped += 1; continue }
  $old = $parts[0].Trim()
  if ($old -match '[=<>]') { $skipped += 1; continue }
  $pairs += @{ old = $old; new = $parts[1].Trim() }
}
if ($pairs.Count -eq 0) { throw "no usable entries in $Keys -- check that the separator is ==>" }
Write-Host "key file : $Keys  ($($pairs.Count) values$(if ($skipped -gt 0) { ", $skipped unparseable" }))"
"           （值一律掩码；本文件不含任何真实值）"

# The LIVE credential, read from the operator's settings, is the highest-value check of all.
if (Test-Path $Settings) {
  try {
    $cfg = Get-Content $Settings -Raw | ConvertFrom-Json
    foreach ($w in @($cfg.workers)) { if ($w.token) { $pairs += @{ old = [string]$w.token; new = '<live worker token>' } } }
    if ($cfg.workerRole.token) { $pairs += @{ old = [string]$cfg.workerRole.token; new = '<live worker-role token>' } }
  } catch { Write-Host "  (could not read the settings file: $($_.Exception.Message))" }
}

# --- generic shapes that no replacement table would list -------------------------------
#
# DELIBERATELY DEPLOYMENT-AGNOSTIC. The first version hardcoded this deployment's LAN prefix as a
# "shape" -- and the history rewrite then replaced that literal inside this very file, because it was
# one of the values being scrubbed. A scanner that embeds the thing it looks for is both a leak and a
# tool that rewrites itself. Anything specific belongs in the gitignored key file; a shape here must
# be true of every deployment.
$patterns = @(
  @{ name = 'any private IPv4 address (informational)'; re = '\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b' },
  @{ name = 'any e-mail address'; re = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' },
  @{ name = 'a Windows user profile path'; re = '[Cc]:\\Users\\[A-Za-z0-9._-]+' },
  @{ name = 'a long hex string (possible key/token)'; re = '\b[0-9a-fA-F]{32,}\b' }
)

function Mask([string]$s) {
  if ($s.Length -le 6) { return '«REDACTED»' }
  return $s.Substring(0, 2) + '«REDACTED»' + $s.Substring($s.Length - 2)
}

# --- 1. the current tree ---------------------------------------------------------------
$files = @(git ls-files | Where-Object {
  $_ -match '\.(md|mjs|js|cjs|json|txt|ya?ml|xml|ps1|psm1|cmd|bat|ts|svg)$' -and
  $_ -notmatch '(^|/)node_modules/' -and $_ -notmatch '^\.research/(asar|asar-root|asar-third|sdk|stage)/'
})
Write-Host "`ntree     : $($files.Count) tracked text files scanned"

$contents = @{}
foreach ($f in $files) {
  $full = Join-Path $root $f
  if (-not (Test-Path -LiteralPath $full)) { continue }
  try { $contents[$f] = [System.IO.File]::ReadAllText($full) } catch { }
}

$treeHits = 0
foreach ($p in $pairs) {
  $hits = @()
  foreach ($f in $contents.Keys) {
    if (-not $contents[$f].Contains($p.old)) { continue }
    $n = 1
    foreach ($line in ($contents[$f] -split "`r?`n")) {
      if ($line.Contains($p.old)) { $hits += ('{0}:{1}' -f $f, $n) }
      $n++
    }
  }
  if ($hits.Count -gt 0) {
    $treeHits += $hits.Count
    Write-Host ("  [HIT] «{0}» -> {1}   {2} 处" -f (Mask $p.old), (Mask $p.new), $hits.Count)
    $hits | Select-Object -First $MaxHitsPerKey | ForEach-Object { Write-Host "        $_" }
  }
}
Write-Host ("tree      : {0}" -f $(if ($treeHits -eq 0) { 'CLEAN — 没有任何待查值出现在当前代码里' } else { "$treeHits 处命中，见上" }))

# --- 2. generic shapes in the tree -----------------------------------------------------
# The table's own SANITIZED values are subtracted first. Without that, "any private IPv4 address"
# reports 180 hits -- every documentation example the table itself created -- and the one hit that
# would matter is invisible in the noise. What this section is for is the thing NO table knows about.
$sanitized = @{}
foreach ($p in $pairs) { if ($p.new -ne '') { $sanitized[$p.new] = $true } }
foreach ($extra in @('C:\Users\you', 'C:\Users\worker', 'C:\\Users\\you', 'C:\\Users\\worker', '<user>', '<worker>')) { $sanitized[$extra] = $true }

Write-Host "`nshapes    : 按形状扫描当前树（已扣除替换表产生的脱敏值）"
foreach ($pat in $patterns) {
  $shown = 0; $total = 0; $known = 0
  foreach ($f in $contents.Keys) {
    $n = 1
    foreach ($line in ($contents[$f] -split "`r?`n")) {
      $m = [regex]::Match($line, $pat.re)
      if ($m.Success) {
        if ($sanitized.ContainsKey($m.Value)) { $known++ } else {
          $total++
          if ($shown -lt $MaxHitsPerKey) {
            $shown++
            Write-Host ("  [{0}] {1}:{2}  {3}" -f $pat.name, $f, $n, (Mask $m.Value))
          }
        }
      }
      $n++
    }
  }
  if ($total -eq 0) { Write-Host ("  [{0}] 无（另有 {1} 处是替换表自己的脱敏值，已扣除）" -f $pat.name, $known) }
  else { Write-Host ("  [{0}] 共 {1} 处" -f $pat.name, $total) }
}

# --- 3. the whole history --------------------------------------------------------------
Write-Host "`nhistory   : 对每个值跑一次 git 历史检索（-S）"
$histHits = 0
foreach ($p in $pairs) {
  $out = @(git log --all --oneline -S"$($p.old)" 2>$null)
  if ($out.Count -gt 0) {
    $histHits++
    Write-Host ("  [HISTORY] «{0}» 出现在 {1} 个提交里：{2}" -f (Mask $p.old), $out.Count, (($out | Select-Object -First 3) -join ' | '))
  }
}
Write-Host ("history   : {0}" -f $(if ($histHits -eq 0) { 'CLEAN — 没有任何待查值进过历史' } else { "$histHits 个值在历史里出现过（见上；当前树是否仍有要用上面的结果判断）" }))

Write-Host ""
if ($treeHits -eq 0 -and $histHits -eq 0) { Write-Host '===== PRIVACY SCAN CLEAN =====' } else { Write-Host '===== REVIEW NEEDED =====' }
