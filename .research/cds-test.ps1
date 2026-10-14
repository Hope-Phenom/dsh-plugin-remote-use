# cds-test.ps1 -- ask Windows whether the primary display CAN be changed, WITHOUT changing it.
#
# WHY CDS_TEST: the question is about privileges and session identity, and the answer is worth
# nothing if asking it has side effects. `ChangeDisplaySettingsEx` with CDS_TEST reports whether the
# change would be accepted and leaves the desktop exactly as it was.
#
# WHY IT MUST RUN IN THE CONSOLE SESSION: display configuration is PER SESSION. A call from session 0
# (where an SSH login lands) cannot set the primary of another session's desktop, so it fails -- and
# that failure says nothing about privileges. Measuring privileges from the wrong session is exactly
# the mistake recorded as D9 in docs/PITFALLS.md.
#
# Output is one JSON object, so the caller reads a value rather than a sentence.
#
# ASCII-ONLY: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, and a non-ASCII byte inside a
# string literal breaks parsing. param() first, for the same reason.
param(
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class SC {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DD {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
  }

  // Only the prefix that CDS_TEST + CDS_SET_PRIMARY needs, but laid out EXACTLY as the real
  // DEVMODEW: dmSize at offset 68 and dmFields at offset 72 are what the API reads first, and a
  // field at the wrong offset makes it return DISP_CHANGE_BADPARAM for a reason that has nothing
  // to do with privileges.
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string dev, uint n, ref DD d, uint flags);

  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE mode, IntPtr hwnd, uint flags, IntPtr param);

  [DllImport("kernel32.dll")]
  public static extern uint WTSGetActiveConsoleSessionId();

  // THE ENUMERATION LIVES IN C#, and that is not style: the first version of this probe looped in
  // PowerShell over `New-Object 'SC+DD'` with `[ref]`, and `EnumDisplayDevices` returned false on
  // the very first call -- zero displays, on two different machines, elevated or not. The struct was
  // byte-for-byte the one that works; the difference is that the working implementation (in
  // `slave/selfcheck.ps1`) drives the same loop from C#. This is the proven shape, reused.
  public static string[] DisplayLines() {
    var l = new System.Collections.Generic.List<string>();
    var d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); uint i = 0;
    while (EnumDisplayDevices(null, i, ref d, 0)) {
      var mons = new System.Collections.Generic.List<string>();
      var m = new DD(); m.cb = Marshal.SizeOf(typeof(DD)); uint j = 0;
      while (EnumDisplayDevices(d.DeviceName, j, ref m, 0)) {
        mons.Add(m.DeviceString);
        m = new DD(); m.cb = Marshal.SizeOf(typeof(DD)); j++;
      }
      bool primary = (d.StateFlags & 0x4) != 0;
      l.Add(d.DeviceName + "|" + d.DeviceString + "|" + (primary ? "1" : "0") + "|" + string.Join(", ", mons));
      d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); i++;
    }
    return l.ToArray();
  }

  // Ask, without applying, whether this device can become primary at (0,0).
  public static int TestSetPrimaryAtOrigin(string device) {
    var dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    dm.dmFields = 0x20;                 // DM_POSITION
    dm.dmPositionX = 0;
    dm.dmPositionY = 0;
    return ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, 0x02 | 0x10, IntPtr.Zero);
  }
}
'@

$result = [ordered]@{
  ok = $false
  elevated = $false
  sessionId = -1
  userInteractive = $false
  consoleSessionId = -1
  displays = @()
  testReturn = $null
  testMeaning = ''
  error = ''
}

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $result.elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $result.sessionId = (Get-Process -Id $PID).SessionId
  $result.userInteractive = [Environment]::UserInteractive
  try { $result.consoleSessionId = [int][SC]::WTSGetActiveConsoleSessionId() } catch { }

  # ---- enumerate displays -------------------------------------------------------------------
  foreach ($line in [SC]::DisplayLines()) {
    $parts = $line -split '\|'
    $result.displays += [ordered]@{
      device = $parts[0]
      adapter = $parts[1]
      primary = ($parts[2] -eq '1')
      monitors = $parts[3]
      virtual = [bool]($parts[1] -match 'Virtual Display|MttVDD|VDD')
    }
  }

  # ---- CDS_TEST against the virtual display -------------------------------------------------
  $vdd = @($result.displays | Where-Object { $_.virtual } | Select-Object -First 1)
  if ($vdd.Count -eq 0) {
    $result.testMeaning = 'no virtual display enumerated'
  } else {
    $rc = [SC]::TestSetPrimaryAtOrigin($vdd[0].device)
    $result.testReturn = $rc
    switch ($rc) {
      0  { $result.testMeaning = 'DISP_CHANGE_SUCCESSFUL -- allowed' }
      -1 { $result.testMeaning = 'DISP_CHANGE_FAILED -- refused' }
      -2 { $result.testMeaning = 'DISP_CHANGE_BADMODE -- the mode is not supported' }
      -3 { $result.testMeaning = 'DISP_CHANGE_NOTUPDATED -- could not write to the registry' }
      -4 { $result.testMeaning = 'DISP_CHANGE_BADFLAGS -- flags rejected' }
      -5 { $result.testMeaning = 'DISP_CHANGE_BADPARAM -- parameter rejected' }
      -6 { $result.testMeaning = 'DISP_CHANGE_BADDUALVIEW -- dualview restriction' }
      1  { $result.testMeaning = 'DISP_CHANGE_RESTART -- a reboot would be required' }
      default { $result.testMeaning = "unknown code $rc" }
    }
  }
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
}

$json = ($result | ConvertTo-Json -Depth 6 -Compress)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $json -Encoding UTF8 }
Write-Output $json
