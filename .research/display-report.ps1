# display-report.ps1 -- what displays exist, and which of them are actually part of the desktop.
#
# WHY BOTH LISTS: `EnumDisplayDevices(null, ...)` enumerates every display ADAPTER the graphics stack
# knows about, including ones with no monitor and ones that are not part of the current desktop. The
# Windows display settings UI shows something else: the displays that are ACTIVE. Reporting only the
# first makes a machine look like it has five monitors when it has one.
#
# Must run in the console session: display enumeration returns nothing from session 0.
#
# ASCII-ONLY, param() first.
param(
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DR {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DD {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string dev, uint n, ref DD d, uint flags);

  // One line per ADAPTER: device name | adapter name | flags | primary | monitors
  public static string[] Adapters() {
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
      // 0x1 = ATTACHED_TO_DESKTOP, 0x8 = MIRRORING_DRIVER, 0x20 = DISPLAY_DEVICE_REMOVABLE
      bool attached = (d.StateFlags & 0x1) != 0;
      l.Add(d.DeviceName + "|" + d.DeviceString + "|" + d.StateFlags + "|" + (primary ? "1" : "0") + "|" + (attached ? "1" : "0") + "|" + string.Join(", ", mons));
      d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); i++;
    }
    return l.ToArray();
  }
}
'@

Add-Type -AssemblyName System.Windows.Forms

$r = [ordered]@{
  ok = $true
  sessionId = (Get-Process -Id $PID).SessionId
  userInteractive = [Environment]::UserInteractive
  adapters = @()
  activeScreens = @()
  virtualScreen = ''
  edids = @()
  error = ''
}

try {
  foreach ($line in [DR]::Adapters()) {
    $p = $line -split '\|'
    $r.adapters += [ordered]@{
      device = $p[0]
      adapter = $p[1]
      stateFlags = $p[2]
      primary = ($p[3] -eq '1')
      attachedToDesktop = ($p[4] -eq '1')
      monitors = $p[5]
    }
  }
  # The ACTIVE desktop: what the display settings UI is showing.
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $r.activeScreens += [ordered]@{
      device = $s.DeviceName
      bounds = "$($s.Bounds.Width)x$($s.Bounds.Height) at $($s.Bounds.X),$($s.Bounds.Y)"
      primary = $s.Primary
    }
  }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $r.virtualScreen = "$($vs.Width)x$($vs.Height) at $($vs.X),$($vs.Y)"
  foreach ($e in (Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue)) {
    $name = -join ($e.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
    $r.edids += $name
  }
} catch {
  $r.ok = $false
  $r.error = $_.Exception.Message
}

$json = ($r | ConvertTo-Json -Depth 6 -Compress)
if ($OutFile -ne '') { Set-Content -LiteralPath $OutFile -Value $json -Encoding UTF8 }
Write-Output $json
