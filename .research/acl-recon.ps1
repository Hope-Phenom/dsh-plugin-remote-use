# acl-recon.ps1 -- READ-ONLY inspection of the permission chain the Windows sandbox uses.
#
# No changes are made. This is reconnaissance to decide whether the bundled
# diagnose-windows-sandbox-acl skill is even applicable: that skill repairs (a) directories
# on the path chain that lack effective WRITE_DAC/WRITE_OWNER for the signed-in user, and
# (b) stray package entries. If neither is present here, the skill is not the answer.
#
# ASCII-only and PowerShell 5.1 syntax only: the worker runs 5.1 and reads a BOM-less file
# as ANSI, so one non-ASCII byte would break parsing.
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $PSScriptRoot 'acl-recon.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { Write-Output $m; Add-Content -Path $log -Value $m -Encoding UTF8 }

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
W "user = $($me.Name)"
W "sid  = $($me.User.Value)"
W ""

# The chain that matters: the sandbox's workspaceRoot is the ACP agent's process.cwd()
# (the relay's directory), and each session's cwd is the task workspace.
$chain = @(
  'C:\',
  'C:\dsh-remote',
  'C:\dsh-remote\plugin-slave',
  'C:\dsh-remote\p0work',
  $env:TEMP
)
W "=== ancestors: does the user hold the rights the sandbox must use? ==="
foreach ($p in $chain) {
  if (-not (Test-Path $p)) { W "  $p  (missing)"; continue }
  $acl = Get-Acl $p
  $mine = @($acl.Access | Where-Object { $_.IdentityReference.Value -eq $me.Name -or $_.IdentityReference.Value -eq $me.User.Value })
  $rights = ($mine | ForEach-Object { $_.FileSystemRights }) -join ', '
  $owner = $acl.Owner
  # EffectiveAccess answers the question that matters rather than guessing from ACEs.
  $eff = ''
  try {
    $eff = (Get-Acl $p).AccessToString.Length
  } catch { }
  W "  $p"
  W "      owner       = $owner"
  W "      my ACEs     = $($mine.Count)  rights=[$rights]"
  W "      inherited   = $((@($acl.Access | Where-Object { $_.IsInherited }).Count))"
  W "      explicit    = $((@($acl.Access | Where-Object { -not $_.IsInherited }).Count))"
}

W ""
W "=== stray package entries (S-1-15-2-*) anywhere on the chain ==="
foreach ($p in $chain) {
  if (-not (Test-Path $p)) { continue }
  $acl = Get-Acl $p
  $pkg = @($acl.Access | Where-Object { $_.IdentityReference.Value -match '^S-1-15-2-' })
  if ($pkg.Count -gt 0) {
    W "  $p : $($pkg.Count) package entries"
    $pkg | ForEach-Object { W "      $($_.IdentityReference.Value)  $($_.FileSystemRights)  $($_.AccessControlType)" }
  } else {
    W "  $p : none"
  }
}

W ""
W "=== deny entries (the skill never removes these, but they explain failures) ==="
foreach ($p in $chain) {
  if (-not (Test-Path $p)) { continue }
  $den = @((Get-Acl $p).Access | Where-Object { $_.AccessControlType -eq 'Deny' })
  if ($den.Count -gt 0) {
    $den | ForEach-Object { W "  $p : DENY $($_.IdentityReference.Value) $($_.FileSystemRights)" }
  } else {
    W "  $p : no deny entries"
  }
}

W ""
W "=== package entries inside the workspace subtree (bounded, depth 3) ==="
$root = 'C:\dsh-remote'
$found = 0
$scanned = 0
Get-ChildItem $root -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object {
  $scanned += 1
  $d = $_
  $a = Get-Acl $d.FullName -ErrorAction SilentlyContinue
  if ($null -eq $a) { return }
  $pkg = @($a.Access | Where-Object { $_.IdentityReference.Value -match '^S-1-15-2-' })
  if ($pkg.Count -gt 0) {
    $found += 1
    W "  $($d.FullName) : $($pkg.Count) package entries"
    $pkg | Select-Object -First 4 | ForEach-Object { W "      $($_.IdentityReference.Value)  $($_.FileSystemRights)" }
  }
}
W "  scanned $scanned directories under $root; $found with package entries"

W ""
W "=== verdict hint ==="
W "  If no directory above lacks the user's rights and no S-1-15-2-* entry exists,"
W "  the diagnose-windows-sandbox-acl skill has nothing to repair for this failure,"
W "  and the 0xC0000142 must be something else."
W "RESULT: DONE"
