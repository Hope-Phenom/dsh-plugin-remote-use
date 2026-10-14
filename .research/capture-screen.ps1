# capture-screen.ps1 -- grab the console session's screen to a PNG.
#
# WHY NOT THE RELAY'S screenshot.ps1: the relay is stopped on this worker (its scheduled task is
# disabled), so the plugin's capture path is unavailable. This does the same thing directly, from the
# console session, where the display APIs actually answer.
#
# The whole virtual desktop is captured, not one monitor, so nothing on a second display is missed.
#
# ASCII-ONLY, param() first.
param(
  [string]$Path = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ($Path -eq '') { $Path = Join-Path $env:TEMP 'worker-screen.png' }

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line); Write-Output $line }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Say "session = $((Get-Process -Id $PID).SessionId)"
Say "interactive = $([Environment]::UserInteractive)"
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  Say ("  screen {0} {1}x{2} at {3},{4} primary={5}" -f $s.DeviceName, $s.Bounds.Width, $s.Bounds.Height, $s.Bounds.X, $s.Bounds.Y, $s.Primary)
}

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
Say ("virtual screen {0}x{1} at {2},{3}" -f $vs.Width, $vs.Height, $vs.X, $vs.Y)
if ($vs.Width -le 0 -or $vs.Height -le 0) { Say 'FATAL: virtual screen has no size (no desktop in this session)'; exit 2 }

$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$gfx.Dispose()
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$f = Get-Item -LiteralPath $Path
Say "saved = $Path  ($($f.Length) bytes)"

$text = ($report -join [Environment]::NewLine)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
