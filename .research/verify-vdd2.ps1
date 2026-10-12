# verify-vdd2.ps1 -- is the virtual display now live? NO clicks, only SetCursorPos.
$log = 'C:\dsh-remote\evidence\vdd-live.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class X {
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
        mons.Add("'" + m.DeviceString + "' flags=" + m.StateFlags + " id=" + m.DeviceID);
        m = new DD(); m.cb = Marshal.SizeOf(typeof(DD)); j++;
      }
      l.Add(d.DeviceName + " | adapter='" + d.DeviceString + "' | flags=" + d.StateFlags
            + " | id=" + d.DeviceID + " | monitors(" + mons.Count + "): " + string.Join(" ; ", mons));
      d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); i++;
    }
    return l.ToArray();
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short a1,a2,dmSize,a3; public int f,x,y,o,fo; public short b1,b2,b3,b4,b5;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int c1,c2,c3,c4,c5,c6,c7,c8;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string d,int m,ref DEVMODE dm);
  public static string Cur(string dev) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return "<none>";
    return d.dmPelsWidth+"x"+d.dmPelsHeight+"@"+d.dmDisplayFrequency+" "+d.dmBitsPerPel+"bpp";
  }
  public static string[] Modes(string dev) {
    var l=new List<string>(); var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    int i=0,lw=-1,lh=-1;
    while(EnumDisplaySettings(dev,i,ref d)){ if(d.dmPelsWidth!=lw||d.dmPelsHeight!=lh){ l.Add(d.dmPelsWidth+"x"+d.dmPelsHeight); lw=d.dmPelsWidth; lh=d.dmPelsHeight; } i++; }
    return l.ToArray();
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static string Jig(int x,int y){ SetCursorPos(x-3,y-3); SetCursorPos(x,y); var p=new POINT(); GetCursorPos(out p); return p.X+","+p.Y; }
}

'@ -ErrorAction SilentlyContinue

W "########## 1. EnumDisplayDevices (all adapters) ##########"
[X]::Adapters() | ForEach-Object { W ("  " + $_) }

W ""
W "########## 2. modes per device ##########"
foreach ($n in 1..24) {
  $dev = "\\.\DISPLAY$n"
  $cur = [X]::Cur($dev)
  if ($cur -eq '<none>') { continue }
  $m = [X]::Modes($dev)
  W ("  " + $dev + "  current=" + $cur + "  modes=" + $m.Count)
  W ("      " + (($m | Select-Object -First 20) -join ', '))
}

W ""
W "########## 3. .NET screens ##########"
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + "  " + $_.Bounds.Width + "x" + $_.Bounds.Height + "  primary=" + $_.Primary) }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W ("  VirtualScreen = " + $vs.X + "," + $vs.Y + " " + $vs.Width + "x" + $vs.Height)

W ""
W "########## 4. EDID monitors ##########"
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
  $n = -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  $mf = -join ($_.ManufacturerName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  W ("  " + $_.InstanceName + "  mfr='" + $mf + "' name='" + $n + "' Active=" + $_.Active)
}

W ""
W "########## 5. vdd_settings.xml ##########"
foreach ($c in 'C:\VirtualDisplayDriver\vdd_settings.xml', "$env:ProgramData\VirtualDisplayDriver\vdd_settings.xml") {
  if (Test-Path $c) { W ("  FOUND " + $c); W (Get-Content $c -Raw) }
}
$found = Get-ChildItem 'C:\' -Recurse -Depth 4 -Filter 'vdd_settings.xml' -File -ErrorAction SilentlyContinue | Select-Object -First 3 -ExpandProperty FullName
W ("  searched: " + ($found -join ' ; '))

W ""
W "########## 6. PnP display devices ##########"
Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }

W ""
W "########## 7. SetCursorPos only (NO click) ##########"
$b = New-Object X+POINT; [void][X]::GetCursorPos([ref]$b)
W ("  cursor before = " + $b.X + "," + $b.Y)
W ("  jiggle(5,5)   = " + [X]::Jig(5,5))
[void][X]::SetCursorPos($b.X,$b.Y)
W ("  restored      = " + $b.X + "," + $b.Y)
W "DONE"
