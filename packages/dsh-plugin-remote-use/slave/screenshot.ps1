# screenshot.ps1 -- capture the worker's desktop.
#
# MUST RUN IN THE INTERACTIVE SESSION. In session 0 (SSH/services) there is no desktop,
# `CopyFromScreen` throws or returns black, and `VirtualScreen` reports a stub size -- the
# same session-0 false negative documented for the display checks.
#
# ASCII-ONLY: Windows PowerShell 5.1 reads a BOM-less file as ANSI, so a single non-ASCII
# byte corrupts parsing (see the note in relay-ctl.ps1).
#
# The geometry report is written NEXT TO THIS SCRIPT ($PSScriptRoot), because the relay
# reads it from the script's own directory. Writing it to a fixed absolute path is exactly
# the mismatch that once made the self-check look like it produced no report, and it would
# silently zero the screenshot's geometry metadata.
#
# Usage: screenshot.ps1 -Out C:\path\shot.png
param([Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrEmpty($PSScriptRoot)) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$report = Join-Path $PSScriptRoot 'screenshot-report.txt'
# Explicit UTF-8 rather than Tee-Object: in Windows PowerShell 5.1 Tee-Object writes
# UTF-16LE, and a UTF-8 reader then sees NUL bytes between characters so every prefix match
# fails -- the relay silently reported 0x0 geometry because of exactly that. The reader in
# relay.mjs also tolerates UTF-16 now, but the writer must not depend on it.
function W($m) {
  Write-Output $m
  Add-Content -Path $report -Value $m -Encoding UTF8
}

Remove-Item $report -Force -ErrorAction SilentlyContinue
Remove-Item $Out -Force -ErrorAction SilentlyContinue

W "session=$((Get-Process -Id $PID).SessionId) interactive=$([Environment]::UserInteractive) user=$env:USERNAME"

# ---------------------------------------------------------------------------
# Hide our own console BEFORE capturing.
#
# This is not redundant with the launcher's `-WindowStyle Hidden` / `windowsHide: true`:
# in practice a console window still reached the desktop and was photographed into the
# frame (an empty one, because this script's output goes to a pipe). Hiding the window we
# actually own is deterministic and independent of how we were started.
#
# It also removes a live focus hazard: a visible console can take foreground, which would
# corrupt the very GUI measurements a screenshot exists to support.
# ---------------------------------------------------------------------------
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleHider {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static bool Hide() {
    IntPtr h = GetConsoleWindow();
    if (h == IntPtr.Zero) return false;          // launched with CREATE_NO_WINDOW
    ShowWindow(h, 0);                            // SW_HIDE
    return !IsWindowVisible(h);
  }
}
'@ -ErrorAction SilentlyContinue
$hidden = $false
try { $hidden = [ConsoleHider]::Hide() } catch { }
W "console hidden=$hidden"

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
