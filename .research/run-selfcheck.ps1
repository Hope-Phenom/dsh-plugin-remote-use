# run-selfcheck.ps1 -- wrapper for the boot-time self-check (SYSTEM session).
& 'C:\dsh-remote\slave-selfcheck.ps1' *>&1 | Out-File -FilePath 'C:\dsh-remote\selfcheck-boot.log' -Encoding utf8
