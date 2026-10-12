# screenshot.ps1 -- capture the worker's desktop.
#
# MUST RUN IN THE INTERACTIVE SESSION. In session 0 (SSH/services) there is no desktop,
# `CopyFromScreen` throws or returns black, and `VirtualScreen` reports a stub size -- the
# same session-0 false negative documented for the display checks.
#
# ASCII-ONLY: Windows PowerShell 5.1 reads a BOM-less file as ANSI, so a single non-ASCII
# byte corrupts parsing (see the note in relay-ctl.ps1).
#
# Usage: screenshot.ps1 -Out C:\dsh-remote\shot.png
param([Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = 'Stop'
$report = 'C:\dsh-remote\screenshot-report.txt'
function W($m) { $m | Tee-Object -FilePath $report -Append | Out-Null; $m }

Remove-Item $report -Force -ErrorAction SilentlyContinue
Remove-Item $Out -Force -ErrorAction SilentlyContinue

W "session=$((Get-Process -Id $PID).SessionId) interactive=$([Environment]::UserInteractive) user=$env:USERNAME"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Report the layout first: a useful screenshot is only meaningful next to the geometry it
# was taken from, and this is also how a wrong-session capture gets caught.
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W "virtualscreen x=$($vs.X) y=$($vs.Y) w=$($vs.Width) h=$($vs.Height)"
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  W ("screen {0} primary={1} bounds={2} bpp={3}" -f $s.DeviceName, $s.Primary, $s.Bounds, $s.BitsPerPixel)
}

if ($vs.Width -le 0 -or $vs.Height -le 0) {
  W "FAIL: virtual screen is empty -- almost certainly session 0"
  W "RESULT: FAILED"
  exit 1
}

$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $gfx.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
} finally {
  $gfx.Dispose()
}

# PNG, not JPEG: the point is often to read UI text back.
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

if (-not (Test-Path $Out)) { W "FAIL: no file written"; W "RESULT: FAILED"; exit 1 }
$len = (Get-Item $Out).Length
W "wrote $Out ($len bytes)"

# A pure-black frame is the classic session-0 / no-desktop symptom, so check rather than
# hand back something that looks like a successful capture.
$probe = New-Object System.Drawing.Bitmap($Out)
try {
  $distinct = @{}
  for ($x = 0; $x -lt $probe.Width; $x += [Math]::Max(1, [int]($probe.Width / 40))) {
    for ($y = 0; $y -lt $probe.Height; $y += [Math]::Max(1, [int]($probe.Height / 30))) {
      $distinct[$probe.GetPixel($x, $y).ToArgb()] = $true
    }
  }
  W "distinct sampled colors: $($distinct.Count)"
  if ($distinct.Count -le 1) { W "WARN: the frame is a single flat color -- capture may be blank" }
} finally {
  $probe.Dispose()
}

W "RESULT: OK"
