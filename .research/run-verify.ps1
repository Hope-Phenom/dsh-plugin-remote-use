# run-verify.ps1 -- run verify-criteria.ps1 and capture EVERYTHING including terminating errors.
$log = 'C:\dsh-remote\avalonia-demo\evidence\verify-capture.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue

Start-Transcript -Path $log -Force | Out-Null
try {
    Set-Location 'C:\dsh-remote\avalonia-demo\tools'
    Write-Host "PWD = $((Get-Location).Path)"
    Write-Host "diagPath will be $env:TEMP\asdemo-diag.txt"
    Write-Host "TEMP = $env:TEMP"
    & '.\verify-criteria.ps1'
    Write-Host "SCRIPT COMPLETED NORMALLY"
} catch {
    Write-Host "=== TERMINATING ERROR ==="
    Write-Host ("Exception type : " + $_.Exception.GetType().FullName)
    Write-Host ("Message        : " + $_.Exception.Message)
    Write-Host ("CategoryInfo   : " + $_.CategoryInfo)
    Write-Host ("FullyQualified : " + $_.FullyQualifiedErrorId)
    Write-Host ("InvocationName : " + $_.InvocationInfo.MyCommand)
    Write-Host ("At line        : " + $_.InvocationInfo.ScriptLineNumber)
    Write-Host ("ScriptName     : " + $_.InvocationInfo.ScriptName)
    Write-Host ("Line text      : " + $_.InvocationInfo.Line)
    Write-Host "--- ScriptStackTrace ---"
    Write-Host ($_.ScriptStackTrace)
    Write-Host "--- InnerException ---"
    Write-Host ($_.Exception.InnerException)
} finally {
    Write-Host "--- diag file present? ---"
    $d = Join-Path $env:TEMP 'asdemo-diag.txt'
    Write-Host ("$d exists = " + (Test-Path $d))
    if (Test-Path $d) { Write-Host (Get-Content $d -Raw) }
    Write-Host "--- evidence dir ---"
    Get-ChildItem 'C:\dsh-remote\avalonia-demo\evidence' | Select-Object Name,Length | Format-Table -AutoSize | Out-String | Write-Host
    Stop-Transcript | Out-Null
}
