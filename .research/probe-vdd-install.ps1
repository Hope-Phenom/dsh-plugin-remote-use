# probe-vdd-install.ps1 -- (1) current display state, (2) hunt for any VDD install trace, (3) SendInput sanity
$log = 'C:\dsh-remote\evidence\vdd3.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class E {
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
      while (EnumDisplayDevices(d.DeviceName, j, ref m, 0)) { mons.Add(m.DeviceString + " flags=" + m.StateFlags); m = new DD(); m.cb = Marshal.SizeOf(typeof(DD)); j++; }
      l.Add(d.DeviceName + " | '" + d.DeviceString + "' | flags=" + d.StateFlags + " | monitors=" + mons.Count + " {" + string.Join("; ", mons) + "}");
      d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); i++;
    }
    return l.ToArray();
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx,dy; public uint md,f,t; public IntPtr ex; }
  [StructLayout(LayoutKind.Sequential)] public struct IN { public uint type; public MI mi; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, IN[] a, int cb);
  public static string Jig(int x,int y){ SetCursorPos(x-4,y-4); SetCursorPos(x,y); var p=new POINT(); GetCursorPos(out p); return p.X+","+p.Y; }
  public static uint Click(int x,int y){
    IN[] a=new IN[2]; a[0].type=0;a[0].mi.f=0x0001; a[1].type=0;a[1].mi.f=0x0002;
    uint r1=SendInput(2,a,Marshal.SizeOf(typeof(IN)));
    IN[] b=new IN[1]; b[0].type=0;b[0].mi.f=0x0004;
    uint r2=SendInput(1,b,Marshal.SizeOf(typeof(IN))); return r1+r2;
  }
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h,int i,System.Text.StringBuilder p,int n,out int need);
  public static string Lock(){ IntPtr h=OpenInputDesktop(0,false,0x0001); if(h==IntPtr.Zero) return "<err "+Marshal.GetLastWin32Error()+">";
    try{ var sb=new System.Text.StringBuilder(256); int n; return GetUserObjectInformation(h,2,sb,512,out n)?sb.ToString():"?"; } finally{ CloseDesktop(h);} }
}
'@ -ErrorAction SilentlyContinue

W "########## 1. display adapters (current) ##########"
[E]::Adapters() | ForEach-Object { W ("  " + $_) }
W "--- .NET screens ---"
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W ("  VirtualScreen = " + $vs.X + "," + $vs.Y + " " + $vs.Width + "x" + $vs.Height)
W "--- EDID monitors ---"
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
  $n = -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  W ("  " + $_.InstanceName + " name='" + $n + "' Active=" + $_.Active)
}

W ""
W "########## 2. VDD install traces ##########"
W "--- common install paths ---"
foreach ($p in 'C:\VirtualDisplayDriver','C:\Program Files\VirtualDisplayDriver','C:\Program Files\Virtual Driver Control',
               "$env:LOCALAPPDATA\Programs\Virtual Driver Control","$env:LOCALAPPDATA\VirtualDisplayDriver",
               'C:\Program Files (x86)\Virtual Display Driver') {
  if (Test-Path $p) { W ("  FOUND: " + $p) } 
}
W "--- ALL files named *virtual*driver* or vdd* on C: (depth<=4) ---"
W ((Get-ChildItem 'C:\' -Recurse -Depth 4 -Include 'vdd*.xml','vdd*.dll','vdd*.sys','*Virtual*Display*.exe','*Virtual*Display*.dll' -File -ErrorAction SilentlyContinue | Select-Object -First 20 -ExpandProperty FullName) -join "`n")
W "--- installed programs (registry) matching virtual/display ---"
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'Virtual|Display|IddCx|VDD' } |
  Select-Object DisplayName,DisplayVersion,InstallLocation | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
W "--- pnputil OEM drivers (all, show any non-Microsoft display class) ---"
$oem = & pnputil /enum-drivers 2>&1 | Out-String
W (($oem -split "`r?`n" | Select-String -Pattern 'oem\d+\.inf|Class Name|Provider Name|Device Name|Driver Version' | Select-Object -First 80) -join "`n")
W "--- services (all, look for anything new) ---"
Get-Service | Where-Object { $_.DisplayName -match 'Virtual|IDD|Display' } | Select-Object Name,DisplayName,Status | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
W "--- winget installed list (if winget exists) ---"
$wg = Get-Command winget -ErrorAction SilentlyContinue
if ($wg) { W ((& winget list --accept-source-agreements 2>&1 | Select-String -Pattern 'Virtual|Display' | Out-String)) } else { W "  winget not found" }

W ""
W "########## 3. session + SendInput ##########"
W ((& query.exe session 2>&1 | Out-String))
W ("  my session      = " + (Get-Process -Id $PID).SessionId)
W ("  input desktop   = " + [E]::Lock())
$b = New-Object E+POINT; [void][E]::GetCursorPos([ref]$b)
W ("  cursor before   = " + $b.X + "," + $b.Y)
W ("  jiggle          = " + [E]::Jig(500,400))
W ("  SendInput       = " + [E]::Click(500,400) + " / 3")
[void][E]::SetCursorPos($b.X,$b.Y)
W "DONE"
