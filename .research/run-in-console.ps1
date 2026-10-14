# run-in-console.ps1 -- run a script in the CONSOLE session as the logged-in user (NOT elevated).
#
# WHY: display enumeration and any display change are per session. From an SSH login they land in
# session 0, where the display APIs return nothing -- so a check run there reports "no displays" for
# a machine with several. The console session is the only place the question has an answer.
#
# Kept separate from the probe so the technique can be reused without copying the P/Invoke.
#
# ASCII-ONLY, param() first.
param(
  [Parameter(Mandatory = $true)][string]$Script,
  [string]$TaskName = 'DshRunInConsole',
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

$User = "$env:COMPUTERNAME\$env:USERNAME"
$out = Join-Path $env:TEMP ($TaskName + '.json')
if (Test-Path $out) { Remove-Item $out -Force }

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'pwsh.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" -OutFile `"$out`""
# Interactive logon puts this in the console session. Limited RunLevel: the SSH account is an
# administrator, so an elevated task would answer a different question than the one being asked.
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Force | Out-Null

try {
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    Start-Sleep -Milliseconds 800
    $state = (Get-ScheduledTask -TaskName $TaskName).State
  } while ($state -eq 'Running' -and (Get-Date) -lt $deadline)

  Write-Output "task state = $state"
  if (Test-Path $out) { Get-Content $out -Raw } else { Write-Output '(no output file)' }
} finally {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output ''
  Write-Output 'task removed'
}
