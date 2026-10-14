# cds-run.ps1 -- run the CDS_TEST probe in the CONSOLE session, twice: elevated and not.
#
# WHY TWO TASKS: the question is whether a non-elevated process may change the primary display. An
# SSH login cannot answer it -- it lands in session 0 (no desktop, and the display APIs return
# nothing there) and, on this worker, it is already elevated. So both variants are run the same way,
# in the same session, differing only in RunLevel.
#
# The probe itself only ASKS (CDS_TEST); nothing here changes the display.
#
# ASCII-ONLY, param() first.
param(
  [string]$Probe = 'C:\dsh-remote\cds-test.ps1',
  [string]$User = ''
)

$ErrorActionPreference = 'Stop'

if ($User -eq '') { $User = "$env:COMPUTERNAME\$env:USERNAME" }
Write-Output "user=$User"

$variants = @(
  @{ name = 'CdsTestNormal';   level = 'Limited'; out = 'C:\dsh-remote\cds-normal.json' },
  @{ name = 'CdsTestElevated'; level = 'Highest'; out = 'C:\dsh-remote\cds-elevated.json' }
)

foreach ($v in $variants) {
  Unregister-ScheduledTask -TaskName $v.name -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $v.out) { Remove-Item $v.out -Force }

  $action = New-ScheduledTaskAction -Execute 'pwsh.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Probe`" -OutFile `"$($v.out)`""
  # Interactive logon puts the task in the console session, which is the only place the display APIs
  # answer. RunLevel is the single variable between the two runs.
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel $v.level
  Register-ScheduledTask -TaskName $v.name -Action $action -Principal $principal -Force | Out-Null
  Write-Output "registered $($v.name) (RunLevel=$($v.level))"
}

foreach ($v in $variants) { Start-ScheduledTask -TaskName $v.name }

# Wait for BOTH to leave the Running state, with a bounded wait so this cannot hang.
$deadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 2
  $running = @(Get-ScheduledTask -TaskName ($variants | ForEach-Object { $_.name }) |
    Where-Object { $_.State -eq 'Running' })
} while ($running.Count -gt 0 -and (Get-Date) -lt $deadline)

Write-Output ''
foreach ($v in $variants) {
  $state = (Get-ScheduledTask -TaskName $v.name).State
  Write-Output "--- $($v.name) (state=$state) ---"
  if (Test-Path $v.out) { Get-Content $v.out -Raw } else { Write-Output '(no output file)' }
}

foreach ($v in $variants) { Unregister-ScheduledTask -TaskName $v.name -Confirm:$false -ErrorAction SilentlyContinue }
Write-Output ''
Write-Output 'tasks removed'
