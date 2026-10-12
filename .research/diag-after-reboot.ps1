# diag-after-reboot.ps1
$log = 'C:\dsh-remote\evidence\after-reboot.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class R {
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
  public static string[] Adapters() {
    var l = new List<string>(); var d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); uint i = 0;
    while (EnumDisplayDevices(null, i, ref d, 0)) {
      var mons = new List<string>();
      var m = new DD(); m.cb = Marshal.SizeOf(typeof(DD)); uint j = 0;
      while (EnumDisplayDevices(d.DeviceName, j, ref m, 0)) {
        mons.Add(m.DeviceString + "[flags=" + m.StateFlags + "]"); m = new DD(); m.cb = Marshal.SizeOf(typeof(DD)); j++;
      }
      l.Add(d.DeviceName + " | '" + d.DeviceString + "' | flags=" + d.StateFlags + " | monitors=" + mons.Count + " {" + string.Join(", ", mons) + "}");
      d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); i++;
    }
    return l.ToArray();
  }
}
'@ -ErrorAction SilentlyContinue

W "=== 1. display adapters now ==="
[R]::Adapters() | ForEach-Object { W ("  " + $_) }
W "=== 2. .NET screens ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
W "=== 3. PnP Display devices ==="
Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | ForEach-Object { W ("  " + $_.Status + " | " + $_.FriendlyName + " | " + $_.InstanceId) }
W "=== 4. VDD device detail ==="
$v = Get-PnpDevice -FriendlyName 'Virtual Display Driver' -ErrorAction SilentlyContinue
if ($v) { W ("  Status=" + $v.Status + " Problem=" + $v.Problem + " InstanceId=" + $v.InstanceId) }
W "=== 5. devcon present? ==="
$dc = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe\Dependencies\devcon.exe"
W ("  " + $dc + " exists=" + (Test-Path $dc))
W "=== 6. selfcheck outputs ==="
Get-ChildItem 'C:\dsh-remote' -File | ForEach-Object { W ("  " + $_.Name + " " + $_.Length + " " + $_.LastWriteTime) }
W "=== 7. session ==="
W ((& query.exe session 2>&1 | Out-String))
W "DONE"
