#!/usr/bin/env pwsh
# find-slave.ps1 -- locate the worker on the LAN and make `ssh worker-pc` work again.
#
# WHY: the worker's address comes from DHCP and changes, and the operator does not track it. A
# hardcoded IP in ~/.ssh/config therefore rots silently -- the symptom is "the worker is
# unreachable", which looks exactly like the worker being powered off.
#
# HOW IT IDENTIFIES THE WORKER, in order of confidence:
#   1. a host that ACCEPTS THE WORKER'S OWN SSH KEY -- only that machine has the matching public
#      key installed, so this is an identity check rather than a guess. It is what makes this
#      script safe to run against the whole subnet.
#   2. failing that, a host with the relay port open (--port, default 7331).
#
# Then, unless -NoHosts, it writes the answer into the hosts file so the hostname resolves and the
# name-based SSH config keeps working until the next address change.
#
# ASCII-ONLY, and `param()` first: Windows PowerShell reads a BOM-less .ps1 as ANSI, and PS 5.1
# rejects `param()` after any statement (reporting it at the lines that follow, which is confusing).
param(
  [string]$Subnet = '',
  [string]$Name = 'worker-pc',
  [string]$UserName = 'sheng',
  [string]$KeyPath = "$env:USERPROFILE\.dsh-remote-ops\id_ed25519_worker-pc",
  [int]$Port = 7331,
  [switch]$NoHosts,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
function Say($m, $c = 'Gray') { if (-not $Quiet) { Write-Host $m -ForegroundColor $c } }

# Which /24 to sweep: the one this machine is on, unless told otherwise.
if ([string]::IsNullOrEmpty($Subnet)) {
  $local = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixLength -ge 24 } |
    Select-Object -First 1
  if (-not $local) { Write-Host 'no usable IPv4 interface found; pass -Subnet' -ForegroundColor Red; exit 2 }
  $octets = $local.IPAddress.Split('.')
  $Subnet = "$($octets[0]).$($octets[1]).$($octets[2])"
}
Say "sweeping $Subnet.0/24 for the worker ($Name)" 'Cyan'

# --- phase 1: which hosts answer at all ------------------------------------------------------
$alive = New-Object System.Collections.ArrayList
$tasks = @()
foreach ($i in 1..254) {
  $ip = "$Subnet.$i"
  $tasks += [System.Net.Sockets.TcpClient]::new()
}
# Sequential-with-short-timeout is too slow for 254 hosts, so connect asynchronously in one batch.
$pending = @{}
foreach ($i in 1..254) {
  $ip = "$Subnet.$i"
  $client = [System.Net.Sockets.TcpClient]::new()
  $pending[$ip] = $client
  try { $null = $client.BeginConnect($ip, 22, $null, $null) } catch { }
}
Start-Sleep -Milliseconds 1200
foreach ($ip in $pending.Keys) {
  $client = $pending[$ip]
  try { if ($client.Connected) { [void]$alive.Add($ip) } } catch { }
  try { $client.Close() } catch { }
}
Say "  $($alive.Count) host(s) with SSH open: $($alive -join ' ')"

# --- phase 2: identity -- which of them accepts the WORKER's key ------------------------------
$found = ''
$accepted = New-Object System.Collections.ArrayList
if (Test-Path $KeyPath) {
  foreach ($ip in $alive) {
    $out = & ssh -o BatchMode=yes -o ConnectTimeout=4 -o StrictHostKeyChecking=no `
      -o IdentitiesOnly=yes -o UserKnownHostsFile=NUL -i $KeyPath "$UserName@$ip" 'hostname' 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) {
      $h = ($out | Select-Object -First 1).Trim()
      [void]$accepted.Add("$ip -> $h")
      # The hostname is the strongest signal, but the key already proves identity.
      if ($found -eq '') { $found = $ip }
    }
  }
} else {
  Say "  key not found at $KeyPath; falling back to the relay port" 'Yellow'
}
if ($accepted.Count -gt 0) { Say "  key accepted by: $($accepted -join '; ')" 'Green' }

# --- phase 3: fall back to the relay port -----------------------------------------------------
if ($found -eq '') {
  Say "  no host accepted the key; looking for port $Port" 'Yellow'
  foreach ($i in 1..254) {
    $ip = "$Subnet.$i"
    $c = [System.Net.Sockets.TcpClient]::new()
    try {
      $r = $c.BeginConnect($ip, $Port, $null, $null)
      if ($r.AsyncWaitHandle.WaitOne(400) -and $c.Connected) { $found = $ip; break }
    } catch { } finally { try { $c.Close() } catch { } }
  }
}

if ($found -eq '') {
  Write-Host ''
  Write-Host "NOT FOUND: no host on $Subnet.0/24 accepted the worker's key, and none answered on port $Port." -ForegroundColor Red
  Write-Host 'Check, in this order:'
  Write-Host '  1. is the worker actually powered on and on this network?'
  Write-Host "  2. does its relay task run? (it is what listens on $Port)"
  Write-Host '  3. is it on a different subnet? re-run with -Subnet <a.b.c>'
  exit 1
}

Write-Host ''
Write-Host "FOUND: $Name is at $found" -ForegroundColor Green

# --- phase 4: make the NAME resolve, so the next address change is a one-command fix -----------
if (-not $NoHosts) {
  $hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  $lines = @(Get-Content $hosts -ErrorAction SilentlyContinue)
  $kept = $lines | Where-Object { $_ -notmatch "(\s|^)$([regex]::Escape($Name))(\s|$)" }
  $entry = "$found`t$Name"
  Set-Content -Path $hosts -Value ($kept + $entry) -Encoding ASCII
  Write-Host "hosts   : $entry" -ForegroundColor Green
  Write-Host ''
  Write-Host "  ssh $Name    # now resolves to $found"
} else {
  Write-Host "  -NoHosts given; add this yourself:  $found`t$Name"
}
exit 0
