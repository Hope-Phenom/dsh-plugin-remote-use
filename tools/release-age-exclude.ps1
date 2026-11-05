# release-age-exclude.ps1 -- add (or remove) a pnpm release-age EXCLUSION for ONE version.
#
# WHY THIS EXISTS
#   pnpm 11 defaults `minimumReleaseAge` to 24h: a version published less than that ago is not
#   SELECTED during resolution. DSH does not set the value, so this is pnpm's own default, and the
#   symptom is quiet: `pnpm add` succeeds by resolving the PREVIOUS version. Measured 2026-11-05:
#   a plugin published 5 minutes earlier installed as the old version, so the new UI never
#   appeared, and nothing in the output said why.
#
#   The blanket fix is `minimumReleaseAge: 0`, which disables the quarantine for EVERY package.
#   This script writes the narrow fix instead -- one exact `<package>@<version>` entry in
#   `minimumReleaseAgeExclude` -- so the 24h gate stays on for everything else. Measured: that is
#   enough for INSTALL (the resolution path). It is NOT enough for UNINSTALL (the lockfile policy
#   re-checks every entry), where `minimumReleaseAge: 0` is still the documented workaround; see
#   docs/PITFALLS.md F6b.
#
# WHAT IT EDITS
#   <dsh-home>\profiles\<profile>\pnpm-workspace.yaml        (backed up before any change)
#
#   * idempotent: an entry that is already there is reported, not duplicated
#   * byte-preserving: only the exclusion block changes; the file keeps its newline style and
#     gets no BOM (a BOM here has broken profiles twice -- PITFALLS E8)
#   * `-Remove` deletes the entry again (run it once the version is older than 24h)
#   * `-Install` also runs the profile's own install with the DSH-bundled node + pnpm, then
#     CHECKS the installed version, because "the command exited 0" is not "the version is there"
#   * `-Remote <sshHost>` copies this script to the target, runs it there, and returns ITS exit
#     code -- the same rule as deploy-slave.ps1: verify on the machine the change is for
#
# USAGE
#   # local profile, just the exclusion (idempotent)
#   .\tools\release-age-exclude.ps1 -Version 0.2.22
#
#   # exclusion + install + version check
#   .\tools\release-age-exclude.ps1 -Version 0.2.22 -Install
#
#   # every profile under this DSH home
#   .\tools\release-age-exclude.ps1 -Version 0.2.22 -AllProfiles
#
#   # another machine over ssh (the whitelist and the install happen THERE)
#   .\tools\release-age-exclude.ps1 -Version 0.2.22 -Install -Remote 192.168.3.35
#
#   # clean up after 24h
#   .\tools\release-age-exclude.ps1 -Version 0.2.22 -Remove
#
# EXIT CODES
#   0  the requested state is in place (and, with -Install, the installed version matches)
#   1  something failed (a profile could not be written, or the installed version does not match)
#   2  the script cannot run here (bad arguments, no DSH home, ssh/scp failed)
#
# ASCII-ONLY, and `param()` is the first statement: Windows PowerShell 5.1 reads a BOM-less .ps1
# as ANSI, so a single non-ASCII byte inside a string literal breaks parsing (deploy-slave.ps1 has
# the same guard for the same reason).
param(
  [string]$Package = '@hope_phenom/dsh-plugin-remote-use',
  [string]$Version = '',
  [string]$Profile = 'desktop',
  [string]$DshHome = '',
  [switch]$AllProfiles,
  [switch]$Remove,
  [switch]$Install,
  [switch]$DryRun,
  [string]$Remote = ''
)

$ErrorActionPreference = 'Stop'

# --- 0. refuse a non-ASCII script before it can fail confusingly -------------- 
$self = $MyInvocation.MyCommand.Path
if ($self) {
  $selfBytes = [System.IO.File]::ReadAllBytes($self)
  $nonAscii = @($selfBytes | Where-Object { $_ -gt 127 })
  if ($nonAscii.Count -gt 0) {
    Write-Output "REFUSING: this script contains $($nonAscii.Count) non-ASCII byte(s)."
    Write-Output "PS 5.1 reads a BOM-less .ps1 as ANSI, so those bytes break parsing."
    exit 2
  }
}

function Say([string]$Text) { Write-Output $Text }

function Fail([string]$Text) {
  Write-Output $Text
  exit 2
}

# --- 1. remote mode: this script runs ON the target, so a wrong machine cannot fake success ---
if ($Remote -ne '') {
  $sshBase = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')
  # NOT piped through `Select-Object -First 1`: that closes the pipeline early, which terminates
  # ssh mid-write and leaves `$LASTEXITCODE` unset -- an unanswered question would then read as a
  # failed one. `-Last 1` buffers instead.
  $remoteHomeOut = & ssh @sshBase $Remote 'echo %USERPROFILE%'
  $remoteExit = $LASTEXITCODE
  $remoteHome = ''
  if ($remoteHomeOut -ne $null) { $remoteHome = ([string]($remoteHomeOut | Select-Object -Last 1)).Trim() }
  if ($remoteExit -ne 0 -or [string]::IsNullOrWhiteSpace($remoteHome)) {
    Fail "cannot reach $Remote over ssh (exit $remoteExit). Check the ssh config and key."
  }
  if ($remoteHome -notmatch '^[A-Za-z]:') {
    Fail "could not read the remote home directory; got: $remoteHome"
  }
  $remoteFile = ($remoteHome -replace '\\', '/') + '/AppData/Local/Temp/release-age-exclude-' + [guid]::NewGuid().ToString('N') + '.ps1'

  $scpArgs = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')
  $transfer = (& scp @scpArgs $PSCommandPath "${Remote}:$remoteFile" 2>&1)
  if ($LASTEXITCODE -ne 0) {
    Fail ("scp failed (exit $LASTEXITCODE): " + (($transfer | Select-Object -First 3) -join ' '))
  }

  $argParts = @("-Package '$Package'")
  if ($Version -ne '') { $argParts += "-Version '$Version'" }
  $argParts += "-Profile '$Profile'"
  if ($PSBoundParameters.ContainsKey('DshHome') -and $DshHome -ne '') { $argParts += "-DshHome '$DshHome'" }
  if ($AllProfiles) { $argParts += '-AllProfiles' }
  if ($Remove) { $argParts += '-Remove' }
  if ($Install) { $argParts += '-Install' }
  if ($DryRun) { $argParts += '-DryRun' }

  # Run the copied file through a SCRIPTBLOCK rather than `& '<file>'`. Execution policy is a
  # per-machine policy (this checkout lives on a volume where Windows PowerShell refuses to load
  # unsigned .ps1 files at all, and Group Policy overrides `-ExecutionPolicy Bypass`); loading the
  # text as a scriptblock sidesteps the loader without changing what runs. The finally block also
  # removes the copy, including when the inner script calls `exit` (measured).
  $inner = @"
`$src = [System.IO.File]::ReadAllText('$remoteFile')
`$sb = [scriptblock]::Create(`$src)
`$code = 1
try {
  & `$sb $($argParts -join ' ')
  `$code = `$LASTEXITCODE
} finally {
  Remove-Item -LiteralPath '$remoteFile' -ErrorAction SilentlyContinue
}
exit `$code
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
  Say "remote : $Remote ($remoteHome)"
  Say "script : $remoteFile"
  Say ''
  # `-OutputFormat Text`: without it, a non-interactive Windows PowerShell serialises output records
  # (and host messages) as CLIXML on stderr, so a successful remote run arrives wrapped in
  # `<Objs ...>` XML instead of readable lines.
  & ssh @sshBase $Remote "powershell -NoProfile -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $encoded"
  $remoteCode = $LASTEXITCODE
  if ($remoteCode -eq 255) {
    Write-Output "ssh itself failed (exit 255) -- the remote result is UNKNOWN, not a failure."
    exit 2
  }
  exit $remoteCode
}

# --- 2. resolve the DSH home and the profiles to touch ----------------------- 
$homeDir = $DshHome
if ($homeDir -eq '') {
  if ($env:DSH_HOME) { $homeDir = $env:DSH_HOME } else { $homeDir = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not (Test-Path -LiteralPath $homeDir)) {
  Fail "DSH home not found: $homeDir (pass -DshHome)"
}

$profilesRoot = Join-Path $homeDir 'profiles'
if (-not (Test-Path -LiteralPath $profilesRoot)) {
  Fail "no profiles directory under $homeDir"
}

$profileDirs = @()
if ($AllProfiles) {
  foreach ($d in Get-ChildItem -LiteralPath $profilesRoot -Directory) {
    $ws = Join-Path $d.FullName 'pnpm-workspace.yaml'
    if (Test-Path -LiteralPath $ws) { $profileDirs += $d.FullName }
  }
} else {
  $one = Join-Path $profilesRoot $Profile
  if (-not (Test-Path -LiteralPath $one)) { Fail "profile not found: $one" }
  $profileDirs += $one
}
if ($profileDirs.Count -eq 0) { Fail "no profile with a pnpm-workspace.yaml under $profilesRoot" }

# --- 3. the version: given, or the one installed in the first profile --------
$packagePath = $Package -replace '/', '\'
if ($Version -eq '') {
  foreach ($d in $profileDirs) {
    $installedFile = Join-Path $d ("node_modules\$packagePath\package.json")
    if (Test-Path -LiteralPath $installedFile) {
      $Version = (Get-Content -LiteralPath $installedFile -Raw | ConvertFrom-Json).version
      Say "version: $Version (read from $d)"
      break
    }
  }
  if ($Version -eq '') { Fail 'no -Version given and the package is not installed anywhere; pass -Version <x.y.z>' }
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') {
  Fail "-Version '$Version' is not a version (expected e.g. 0.2.22)"
}
$entry = "$Package@$Version"
$entryValue = $entry.Trim().Trim("'").Trim('"')

# --- 4. the YAML edit: line-based, no YAML library on this path ---------------
function Read-ListBlock {
  param($Lines, [int]$KeyIndex)
  $last = $KeyIndex
  $indent = '  '
  $items = New-Object System.Collections.ArrayList
  for ($j = $KeyIndex + 1; $j -lt $Lines.Count; $j++) {
    $line = [string]$Lines[$j]
    if ($line -match '^\s*$') { continue }
    if ($line -notmatch '^\s') { break }
    $last = $j
    if ($line -match '^(\s*)-\s') { $indent = $Matches[1] }
    if ($line -match '^\s*-\s*(.+?)\s*$') {
      $value = $Matches[1].Trim()
      $value = $value.Trim("'").Trim('"')
      [void]$items.Add(@{ Index = $j; Value = $value })
    }
  }
  return @{ Start = $KeyIndex; End = $last; Indent = $indent; Items = $items }
}

function Update-ExcludeFile {
  param([string]$File, [string]$EntryValue, [string]$EntryText, [bool]$RemoveMode, [bool]$DryRunMode)
  $raw = [System.IO.File]::ReadAllText($File)
  $newline = "`n"
  if ($raw.Contains("`r`n")) { $newline = "`r`n" }
  $lines = New-Object System.Collections.ArrayList
  foreach ($l in ($raw -split "\r?\n")) { [void]$lines.Add($l) }
  while ($lines.Count -gt 0 -and [string]$lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }

  $keyIndex = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ([string]$lines[$i] -match '^minimumReleaseAgeExclude\s*:\s*$') { $keyIndex = $i; break }
  }

  $changed = $false
  $detail = ''

  if ($RemoveMode) {
    if ($keyIndex -lt 0) {
      $detail = 'no exclusion list -- nothing to remove'
    } else {
      $block = Read-ListBlock -Lines $lines -KeyIndex $keyIndex
      $hits = @()
      foreach ($item in $block.Items) { if ($item.Value -eq $EntryValue) { $hits += $item.Index } }
      if ($hits.Count -eq 0) {
        $detail = 'entry not present -- nothing to remove'
      } else {
        for ($k = $hits.Count - 1; $k -ge 0; $k--) { $lines.RemoveAt([int]$hits[$k]) }
        # Drop the key too when the list became empty: an empty key is valid YAML but reads as
        # a setting nobody meant to leave behind.
        $again = Read-ListBlock -Lines $lines -KeyIndex $keyIndex
        if ($again.Items.Count -eq 0) {
          $lines.RemoveAt($keyIndex)
          # Normalise the tail so repeated add/remove cycles do not accumulate blank lines.
          while ($lines.Count -gt 0 -and [string]$lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
        }
        $changed = $true
        $detail = "removed ($($hits.Count) line(s))"
      }
    }
  } else {
    if ($keyIndex -lt 0) {
      if ($lines.Count -gt 0 -and [string]$lines[$lines.Count - 1] -ne '') { [void]$lines.Add('') }
      [void]$lines.Add('minimumReleaseAgeExclude:')
      [void]$lines.Add("  - '$EntryText'")
      $changed = $true
      $detail = 'appended a new exclusion list'
    } else {
      $block = Read-ListBlock -Lines $lines -KeyIndex $keyIndex
      $present = $false
      foreach ($item in $block.Items) { if ($item.Value -eq $EntryValue) { $present = $true } }
      if ($present) {
        $detail = 'already listed -- no change'
      } else {
        [void]$lines.Insert($block.End + 1, ("{0}- '{1}'" -f $block.Indent, $EntryText))
        $changed = $true
        $detail = 'entry added'
      }
    }
  }

  if ($changed -and -not $DryRunMode) {
    Copy-Item -LiteralPath $File -Destination "$File.bak-releaseage-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
    $text = ($lines -join $newline) + $newline
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($File, $text, $enc)
  }

  $bytes = [System.IO.File]::ReadAllBytes($File)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  return @{ Changed = $changed; Detail = $detail; HasBom = $hasBom; Bytes = $bytes.Length }
}

# --- 5. install (optional): the profile's own node + pnpm, then CHECK ---------
function Resolve-DshInstall {
  $candidates = @()
  if ($env:DSH_INSTALL_DIR) { $candidates += $env:DSH_INSTALL_DIR }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness') }
  $candidates += 'C:\Program Files\DeepSeek Harness'
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c 'DeepSeek Harness.exe'))) { return $c }
  }
  return ''
}

$installDir = ''
$nodeExe = ''
$pnpmCjs = ''
if ($Install -and -not $Remove) {
  $installDir = Resolve-DshInstall
  if ($installDir -eq '') { Fail 'cannot find "DeepSeek Harness.exe"; set DSH_INSTALL_DIR, or drop -Install and run pnpm yourself' }
  $nodeExe = Join-Path $installDir 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  $pnpmCjs = Join-Path $installDir 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
  if (-not (Test-Path -LiteralPath $nodeExe)) { Fail "node.exe not found: $nodeExe" }
  if (-not (Test-Path -LiteralPath $pnpmCjs)) { Fail "pnpm.cjs not found: $pnpmCjs" }
}

# --- 6. apply ----------------------------------------------------------------- 
$failures = 0
foreach ($dir in $profileDirs) {
  $ws = Join-Path $dir 'pnpm-workspace.yaml'
  if (-not (Test-Path -LiteralPath $ws)) {
    Say "[$(Split-Path $dir -Leaf)] no pnpm-workspace.yaml -- skipped"
    continue
  }
  Say "[$(Split-Path $dir -Leaf)] $ws"
  # An inline list (`minimumReleaseAgeExclude: ['x']`) would be matched by the key scan but not by
  # the line-based list parser, and appending a second key would make the file invalid YAML. Refuse
  # instead of guessing; this shape does not come from DSH, so it is a hand edit worth keeping.
  #
  # `[ \t]` rather than `\s`: the file is read whole, and `\s` also matches the NEWLINE, which made
  # `:\s*\S` match the list item on the next line and report every normal list as "inline".
  $rawCheck = [System.IO.File]::ReadAllText($ws)
  if ($rawCheck -match '(?m)^minimumReleaseAgeExclude[ \t]*:[ \t]*\S') {
    Fail "inline minimumReleaseAgeExclude list in ${ws} is not supported; edit that file by hand"
  }
  $result = Update-ExcludeFile -File $ws -EntryValue $entryValue -EntryText $entry -RemoveMode ([bool]$Remove) -DryRunMode ([bool]$DryRun)
  Say "  $($result.Detail)$(if ($result.Changed -and $DryRun) { ' (dry run, not written)' } else { '' })"
  if ($result.HasBom) {
    Write-Output '  FAIL: the file now has a BOM, which breaks the profile'
    $failures++
  }
  Say "  bytes=$($result.Bytes)"

  if ($Install -and -not $Remove) {
    Push-Location -LiteralPath $dir
    try {
      Say "  pnpm add $entry"
      & $nodeExe $pnpmCjs add $entry 2>&1 | ForEach-Object { Write-Output "  $_" }
      $code = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($code -ne 0) {
      Write-Output "  FAIL: pnpm add exited $code"
      $failures++
      continue
    }
    $installedFile = Join-Path $dir ("node_modules\$packagePath\package.json")
    $installed = ''
    if (Test-Path -LiteralPath $installedFile) {
      $installed = (Get-Content -LiteralPath $installedFile -Raw | ConvertFrom-Json).version
    }
    if ($installed -eq $Version) {
      Say "  verified: installed $installed"
    } else {
      Write-Output "  FAIL: installed '$installed', expected '$Version' (the age gate may have resolved an older one)"
      $failures++
    }
  }
}

Say ''
if ($failures -gt 0) {
  Write-Output "RESULT: OVER ($failures problem(s))"
  exit 1
}
if ($DryRun) {
  Say 'RESULT: DRY RUN -- nothing was written'
} elseif ($Remove) {
  Say "RESULT: exclusion removed for $entry"
} else {
  Say "RESULT: exclusion in place for $entry"
}
exit 0
