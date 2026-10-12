# probe-interactive.ps1 -- run display enumeration in the INTERACTIVE session (not session 0).
$log = 'C:\dsh-remote\evidence\interactive.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W ("sessionId   = " + (Get-Process -Id $PID).SessionId)
W ("interactive = " + [Environment]::UserInteractive)
W ((& query.exe session 2>&1 | Out-String))

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
W "=== .NET screens (interactive) ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W ("  VirtualScreen = " + $vs.X + "," + $vs.Y + " " + $vs.Width + "x" + $vs.Height)

Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public class I {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DD { public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplayDevices(string d, uint n, ref DD dd, uint f);
  public static string[] A() {
    var l=new List<string>(); var d=new DD(); d.cb=Marshal.SizeOf(typeof(DD)); uint i=0;
    while(EnumDisplayDevices(null,i,ref d,0)) {
      var mons=new List<string>(); var m=new DD(); m.cb=Marshal.SizeOf(typeof(DD)); uint j=0;
      while(EnumDisplayDevices(d.DeviceName,j,ref m,0)) { mons.Add(m.DeviceString+" flags="+m.StateFlags+" id="+m.DeviceID); m=new DD(); m.cb=Marshal.SizeOf(typeof(DD)); j++; }
      l.Add(d.DeviceName+" | '"+d.DeviceString+"' | flags="+d.StateFlags+" | monitors="+mons.Count+" {"+string.Join(" ; ",mons)+"}");
      d=new DD(); d.cb=Marshal.SizeOf(typeof(DD)); i++; }
    return l.ToArray(); }
}
'@ -ErrorAction SilentlyContinue
W "=== EnumDisplayDevices (interactive) ==="
[I]::A() | ForEach-Object { W ("  " + $_) }

W "=== ALL monitor-class devices with ConfigFlags ==="
Get-PnpDevice -Class Monitor -ErrorAction SilentlyContinue | ForEach-Object {
  $cs = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_ConfigFlags' -ErrorAction SilentlyContinue).Data
  W ("  " + $_.Status + " | " + $_.FriendlyName + " | ConfigFlags=" + $cs + " | " + $_.InstanceId)
}
W "DONE"
