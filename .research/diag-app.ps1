# diag-app.ps1 -- why does the demo fail to start on the slave?
$ErrorActionPreference = 'Continue'
$log = 'C:\dsh-remote\avalonia-demo\evidence\diag-app.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

$root = 'C:\dsh-remote\avalonia-demo'
$exe  = Join-Path $root 'avalonia-demo\bin\Debug\net10.0\avalonia-demo.exe'

W ("session id   = " + (Get-Process -Id $PID).SessionId)
W ("interactive  = " + [Environment]::UserInteractive)
W ("exe exists   = " + (Test-Path $exe))
W "--- dotnet runtimes ---"
W (& dotnet --list-runtimes 2>&1 | Out-String)

W "--- launching (no redirection) ---"
try {
    $p = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
    W ("started pid = " + $p.Id)
    for ($i = 1; $i -le 8; $i++) {
        Start-Sleep -Seconds 2
        $p.Refresh()
        W ("  t=" + ($i*2) + "s hasExited=" + $p.HasExited)
        if ($p.HasExited) { W ("  exitCode=" + $p.ExitCode); break }
    }
    if (-not $p.HasExited) { W "  still alive (good) -- killing"; $p.Kill() }
} catch { W ("launch exception: " + $_.Exception.Message) }

W "--- hidden-window launch (console app?) ---"
try {
    $p2 = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 5
    $p2.Refresh()
    W ("pid=" + $p2.Id + " hasExited=" + $p2.HasExited + $(if ($p2.HasExited) { " exitCode=" + $p2.ExitCode } else { "" }))
    if (-not $p2.HasExited) { $p2.Kill() }
} catch { W ("hidden launch exception: " + $_.Exception.Message) }

W "--- 直接跑 exe 并捕获输出（cmd 重定向）---"
$cmd = 'cd /d "C:\dsh-remote\avalonia-demo\avalonia-demo\bin\Debug\net10.0" & avalonia-demo.exe > "C:\dsh-remote\avalonia-demo\evidence\direct-out.txt" 2>&1 & echo EXITCODE=%ERRORLEVEL%'
W (& cmd.exe /c $cmd 2>&1 | Out-String)
W "--- direct-out.txt ---"
if (Test-Path "$root\evidence\direct-out.txt") { W (Get-Content "$root\evidence\direct-out.txt" -Raw) } else { W '(none)' }
W "DONE"
