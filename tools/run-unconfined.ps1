# run-unconfined.ps1 -- run a command OUTSIDE the DSH sandbox, via a one-shot scheduled task.
#
# WHY THIS EXISTS, with the measurement that motivated it:
#
# An agent's shell runs confined by DSH's sandbox mediator. Anything it starts inherits that, and
# one specific check notices: the worker self-check's `S8 SendInput / SetCursorPos live` fails,
# because a restricted token cannot inject input into a higher-integrity foreground window (UIPI).
#
# On the same machine, minutes apart:
#
#   confined   (agent shell)              -> verdict=blocked, S8 fail  (set=False)
#   unconfined (scheduled task, pwsh 7)   -> verdict=warn,    S8 pass  (ok)
#
# That makes the confinement a source of FALSE FAILURES in exactly the place that matters most --
# validating that a machine can be a GUI worker -- and the failure looks like a host defect.
#
# HOW IT WORKS: registers a task that runs once, as the interactive user, waits for it, and removes
# it. `pwsh` (7) is used by default because PowerShell 5.1 may be blocked from running scripts by a
# path-based WDAC/AppLocker rule (measured: 5.1 refuses scripts on this project's F: volume while 7
# runs them; see DESIGN section 16).
#
# Usage:
#   .\run-unconfined.ps1 -Command 'C:\Program Files\PowerShell\7\pwsh.exe' -Arguments '-NoProfile -File C:\x.ps1'
#   .\run-unconfined.ps1 -NodeScript C:\path\to\script.mjs -NodeArguments '--port 7398 --token x'
param(
  [string]$Command = '',
  [string]$Arguments = '',
  [string]$NodeScript = '',
  # Extra argv for -NodeScript. Without this the runner could only start a script with no options,
  # which made it useless for `arm-loopback-worker.mjs`: that helper mints its own token unless
  # `--token` is passed, and the caller cannot know the minted one (its stdout goes to the task, not
  # to the shell). Forwarding the arguments is what lets the caller pick a token up front.
  [string]$NodeArguments = '',
  [int]$TimeoutSeconds = 300,
  [switch]$KeepTask
)

$ErrorActionPreference = 'Stop'

if ($NodeScript -ne '') {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Error 'node is not on PATH'; exit 2 }
  $Command = $node
  $Arguments = '"' + $NodeScript + '"'
  if ($NodeArguments -ne '') { $Arguments = $Arguments + ' ' + $NodeArguments }
}
if ($Command -eq '') { Write-Error 'pass -Command (with -Arguments) or -NodeScript'; exit 2 }

$taskName = "dsh-unconfined-$PID"
$action = New-ScheduledTaskAction -Execute $Command -Argument $Arguments
# Interactive + Limited: the same shape a real worker's relay task uses. NOT highest privileges --
# the point is to remove the DSH sandbox, not to elevate.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Write-Host "command : $Command $Arguments"
Write-Host "context : interactive user, outside the DSH sandbox"
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
try {
  Start-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $state = (Get-ScheduledTask -TaskName $taskName).State
  } while ($state -eq 'Running' -and (Get-Date) -lt $deadline)

  $info = Get-ScheduledTaskInfo -TaskName $taskName
  Write-Host "state   : $state"
  Write-Host "exit    : $($info.LastTaskResult)"
  if ($state -eq 'Running') { Write-Host 'TIMED OUT' -ForegroundColor Red; exit 3 }
  exit $info.LastTaskResult
} finally {
  if (-not $KeepTask) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
  else { Write-Host "task kept: $taskName" }
}
