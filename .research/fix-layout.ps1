# fix-layout.ps1 -- put the desktop into the agreed shape: physical primary landscape at (0,0),
# virtual display secondary to its right.
#
# WHY IT IS NEEDED: changing the display topology (removing a device) makes Windows apply a REMEMBERED
# configuration for the new topology, which can differ from what was on screen. Observed here: after
# disabling a duplicate virtual display, the physical panel reverted to portrait and the virtual
# display moved to negative X. Orientation is remembered per configuration, so a manual rotation is
# not safe across topology changes.
#
# Uses ChangeDisplaySettingsEx with CDS_UPDATEREGISTRY so the result persists, and CDS_SET_PRIMARY for
# the physical. Runs in the console session; no elevation required (measured first with CDS_TEST:
# DISP_CHANGE_SUCCESSFUL from a Limited token).
#
# The report is BOTH printed and written to -OutFile, because run-in-console.ps1 reads it back from a
# file -- and the first attempt to drive this through that wrapper failed for a dull reason: the
# script had no -OutFile parameter, so PowerShell refused to start it and nothing ran at all.
#
# ASCII-ONLY, param() first.
param(
  [string]$Physical = '',        # device name, e.g. \\.\DISPLAY1; empty = find the non-virtual primary
  [string]$Virtual = '',         # device name of the virtual display; empty = find the first virtual
  [int]$PhysicalWidth = 1920,
  [int]$PhysicalHeight = 1080,
  [string]$OutFile = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$report = New-Object System.Collections.ArrayList
function Say([string]$line) { [void]$report.Add($line) }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FL {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DD {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string dev, uint n, ref DD d, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE mode, IntPtr hwnd, uint flags, IntPtr param);

  // device|adapter|primary|virtual  -- attached displays only
  public static string[] List() {
    var l = new System.Collections.Generic.List<string>();
    var d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); uint i = 0;
    while (EnumDisplayDevices(null, i, ref d, 0)) {
      bool primary = (d.StateFlags & 0x4) != 0;
      bool attached = (d.StateFlags & 0x1) != 0;
      bool virt = System.Text.RegularExpressions.Regex.IsMatch(d.DeviceString, "Virtual Display|MttVDD|VDD");
      if (attached) l.Add(d.DeviceName + "|" + d.DeviceString + "|" + (primary ? "1" : "0") + "|" + (virt ? "1" : "0"));
      d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); i++;
    }
    return l.ToArray();
  }

  public static int SetLandscapePrimaryAtOrigin(string device, int w, int h) {
    var dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    dm.dmFields = 0x20 | 0x80 | 0x00080000 | 0x00100000;   // POSITION | ORIENTATION | WIDTH | HEIGHT
    dm.dmPositionX = 0; dm.dmPositionY = 0;
    dm.dmDisplayOrientation = 0;                            // DMDO_DEFAULT = landscape
    dm.dmPelsWidth = w; dm.dmPelsHeight = h;
    dm.dmDisplayFrequency = 60;
    // CDS_UPDATEREGISTRY (persist) | CDS_SET_PRIMARY
    return ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, 0x01 | 0x10, IntPtr.Zero);
  }

  public static int SetPosition(string device, int x, int y) {
    var dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    dm.dmFields = 0x20;                                     // POSITION
    dm.dmPositionX = x; dm.dmPositionY = y;
    return ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, 0x01, IntPtr.Zero);
  }
}
'@

Add-Type -AssemblyName System.Windows.Forms

function Show-State([string]$label) {
  Say "--- $label ---"
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    Say ("  {0} {1}x{2} at {3},{4} primary={5}" -f $s.DeviceName, $s.Bounds.Width, $s.Bounds.Height, $s.Bounds.X, $s.Bounds.Y, $s.Primary)
  }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  Say ("  virtual screen {0}x{1} at {2},{3}" -f $vs.Width, $vs.Height, $vs.X, $vs.Y)
}

Show-State 'before'

$list = [FL]::List()
foreach ($l in $list) { Say "  device: $l" }

if ($Physical -eq '') {
  $Physical = (($list | Where-Object { ($_ -split '\|')[2] -eq '1' -and ($_ -split '\|')[3] -eq '0' } | Select-Object -First 1) -split '\|')[0]
}
if ($Virtual -eq '') {
  $Virtual = (($list | Where-Object { ($_ -split '\|')[3] -eq '1' } | Select-Object -First 1) -split '\|')[0]
}
Say "physical=$Physical  virtual=$Virtual"

if (-not $DryRun) {
  if ($Physical) {
    $rc = [FL]::SetLandscapePrimaryAtOrigin($Physical, $PhysicalWidth, $PhysicalHeight)
    Say "physical -> landscape ${PhysicalWidth}x${PhysicalHeight} primary at (0,0): rc=$rc"
  }
  Start-Sleep -Seconds 3
  if ($Virtual) {
    # To the RIGHT of the physical panel: positive coordinates only, so absolute-coordinate
    # automation never has to reason about negative space.
    $rc2 = [FL]::SetPosition($Virtual, $PhysicalWidth, 0)
    Say "virtual -> ($PhysicalWidth,0): rc=$rc2"
  }
  Start-Sleep -Seconds 3
  Show-State 'after'
} else {
  Say 'DryRun: nothing changed.'
}

$text = ($report -join [Environment]::NewLine)
Write-Output $text
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $text -Encoding UTF8 }
