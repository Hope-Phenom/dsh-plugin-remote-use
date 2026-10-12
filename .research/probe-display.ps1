# probe-display.ps1 -- what is the "WinDisc" display, and can its resolution change?
$log = 'C:\dsh-remote\evidence\display.txt'
New-Item -ItemType Directory -Force 'C:\dsh-remote\evidence' | Out-Null
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "===== 1) monitors (incl. non-active), EDID-published names ====="
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
  $name = -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  $man  = -join ($_.ManufacturerName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  W ("  InstanceName=" + $_.InstanceName + "  Manufacturer='" + $man + "'  Name='" + $name + "'  Active=" + $_.Active)
}

W "===== 2) PnP display devices ====="
Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
  Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }

W "===== 3) 'WinDisc' - what owns that device name? ====="
Get-CimInstance Win32_DesktopMonitor -ErrorAction SilentlyContinue |
  Select-Object Name,DeviceID,ScreenWidth,ScreenHeight,Availability,PNPDeviceID | Format-List | Out-String | ForEach-Object { W $_ }

W "===== 4) all display modes enumerated by the OS (Win32_VideoController) ====="
Get-CimInstance Win32_VideoController | ForEach-Object {
  W ("  Adapter: " + $_.Name + "  VideoModeDescription=" + $_.VideoModeDescription + "  avail=" + $_.Availability)
}

W "===== 5) .NET screen list (what apps see) ====="
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  W ("  " + $_.DeviceName + "  " + $_.Bounds.Width + "x" + $_.Bounds.Height + "  primary=" + $_.Primary + "  bpp=" + $_.BitsPerPixel)
}

W "===== 6) monitor capabilities: supported resolutions ====="
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Disp {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields;
    public int dmPositionX, dmPositionY;
    public int dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  public static string[] Modes(string dev) {
    var list = new System.Collections.Generic.List<string>();
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    int i = 0;
    int lastW = -1, lastH = -1;
    while (EnumDisplaySettings(dev, i, ref dm)) {
      if (dm.dmPelsWidth != lastW || dm.dmPelsHeight != lastH) {
        list.Add(dm.dmPelsWidth + "x" + dm.dmPelsHeight + "@" + dm.dmDisplayFrequency + " " + dm.dmBitsPerPel + "bpp");
        lastW = dm.dmPelsWidth; lastH = dm.dmPelsHeight;
      }
      i++;
    }
    return list.ToArray();
  }
  public static string Current(string dev) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(dev, -1, ref dm)) return "<none>";
    return dm.dmPelsWidth + "x" + dm.dmPelsHeight + "@" + dm.dmDisplayFrequency + " " + dm.dmBitsPerPel + "bpp";
  }
}
'@ -ErrorAction SilentlyContinue
foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
  W ("  Device " + $scr.DeviceName + " current=" + [Disp]::Current($scr.DeviceName))
  $modes = [Disp]::Modes($scr.DeviceName)
  W ("    supported modes (" + $modes.Count + "):")
  $modes | Select-Object -First 40 | ForEach-Object { W ("      " + $_) }
}
W "===== 7) modes on the null/default device (\\\\.\\DISPLAY1..4) ====="
foreach ($n in 1..4) {
  $dev = "\\.\DISPLAY$n"
  $modes = [Disp]::Modes($dev)
  if ($modes.Count -gt 0) {
    W ("  " + $dev + " has " + $modes.Count + " modes; current=" + [Disp]::Current($dev))
    $modes | Select-Object -First 12 | ForEach-Object { W ("      " + $_) }
  } else { W ("  " + $dev + " -> no modes") }
}
W "DONE"
