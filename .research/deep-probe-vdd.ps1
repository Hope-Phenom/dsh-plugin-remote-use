# deep-probe-vdd.ps1 -- find the virtual display properly and re-check policy.
$log = 'C:\dsh-remote\evidence\vdd2.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class D {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string dev, uint n, ref DISPLAY_DEVICE d, uint flags);

  public static string[] AllAdapters() {
    var list = new List<string>();
    var d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
    uint i = 0;
    while (EnumDisplayDevices(null, i, ref d, 0)) {
      var mons = new List<string>();
      var m = new DISPLAY_DEVICE(); m.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      uint j = 0;
      while (EnumDisplayDevices(d.DeviceName, j, ref m, 0)) {
        mons.Add(m.DeviceString + "[" + m.DeviceID + "] flags=" + m.StateFlags);
        m = new DISPLAY_DEVICE(); m.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE)); j++;
      }
      list.Add(d.DeviceName + " | adapter='" + d.DeviceString + "' flags=" + d.StateFlags
               + " | id=" + d.DeviceID
               + " | key=" + d.DeviceKey
               + " | monitors={" + string.Join("; ", mons) + "}");
      d = new DISPLAY_DEVICE(); d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE)); i++;
    }
    return list.ToArray();
  }
}
'@ -ErrorAction SilentlyContinue

W "########## 1. EnumDisplayDevices: EVERY display adapter + monitor ##########"
W "  (flags bit0=ATTACHED_TO_DESKTOP bit1=PRIMARY_DEVICE bit2=MIRRORING bit3=VGA_COMPATIBLE bit4=REMOVABLE bit5=DISCONNECT bit8=ACTIVE)"
[D]::AllAdapters() | ForEach-Object { W ("  " + $_) }

W ""
W "########## 2. .NET screens ##########"
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  W ("  " + $_.DeviceName + "  " + $_.Bounds.Width + "x" + $_.Bounds.Height + "  primary=" + $_.Primary)
}

W ""
W "########## 3. .NET VirtualScreen (the whole desktop bbox) ##########"
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W ("  VirtualScreen = " + $vs.X + "," + $vs.Y + "  " + $vs.Width + "x" + $vs.Height)

W ""
W "########## 4. Is VDD installed? (files / service / registry) ##########"
foreach ($p in 'C:\VirtualDisplayDriver','C:\Virtual Display Driver','C:\Program Files\VirtualDisplayDriver') {
  if (Test-Path $p) { W ("  DIR: " + $p); Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 15 | ForEach-Object { W ("     " + $_.FullName + "  " + $_.Length) } }
}
W "  --- vdd_settings.xml ---"
$s = 'C:\VirtualDisplayDriver\vdd_settings.xml'
if (Test-Path $s) { W (Get-Content $s -Raw) } else { W "  NOT FOUND at $s" }
W "  --- services matching vdd/idd ---"
Get-Service | Where-Object { $_.Name -match 'vdd|idd|virtual' -or $_.DisplayName -match 'Virtual Display' } |
  Select-Object Name,DisplayName,Status,StartType | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
W "  --- PnP devices: ALL, filtered for virtual/idd/display ---"
Get-PnpDevice -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match 'Virtual|IDD|Display' -or $_.InstanceId -match 'IDD|SWD' } |
  Select-Object Status,Class,FriendlyName,InstanceId | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
W "  --- driver store packages matching vdd ---"
W ((& pnputil /enum-drivers 2>&1 | Select-String -Pattern 'vdd|Virtual Display|idd' -Context 2,4 | Out-String))

W ""
W "########## 5. session topology ##########"
W ((& query.exe session 2>&1 | Out-String))
W ("  my session = " + (Get-Process -Id $PID).SessionId)

W ""
W "########## 6. power policy, exact values ##########"
function P($sub, $set) {
  $o = & powercfg /q SCHEME_CURRENT $sub $set 2>&1 | Out-String
  $lines = $o -split "`n" | Where-Object { $_ -match '0x[0-9a-fA-F]+' }
  W ("  " + $set + " -> " + (($lines | ForEach-Object { $_.Trim() }) -join ' | '))
}
P 'SUB_SLEEP' 'STANDBYIDLE'
P 'SUB_SLEEP' 'HIBERNATEIDLE'
P 'SUB_VIDEO' 'VIDEOIDLE'
W "  --- AC/DC index order is: min, max, increment, AC, DC ---"
W "  --- screensaver ---"
$d = Get-ItemProperty 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue
W ("    ScreenSaveActive=" + $d.ScreenSaveActive + " TimeOut='" + $d.ScreenSaveTimeOut + "' Secure='" + $d.ScreenSaverIsSecure + "'")
W "DONE"
