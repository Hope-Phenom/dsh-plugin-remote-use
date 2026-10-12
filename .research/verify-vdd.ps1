# verify-vdd.ps1 -- validate the newly installed virtual display driver + power policy.
$log = 'C:\dsh-remote\evidence\vdd.txt'
New-Item -ItemType Directory -Force 'C:\dsh-remote\evidence' | Out-Null
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class V {
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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string d,int m,ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string d, ref DEVMODE dm, IntPtr h, int f, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] a, int cb);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);

  public static string Current(string dev) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return "<none>";
    return d.dmPelsWidth+"x"+d.dmPelsHeight+"@"+d.dmDisplayFrequency;
  }
  public static string[] Modes(string dev) {
    var l=new System.Collections.Generic.List<string>();
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    int i=0, lw=-1, lh=-1;
    while(EnumDisplaySettings(dev,i,ref d)) {
      if(d.dmPelsWidth!=lw||d.dmPelsHeight!=lh){ l.Add(d.dmPelsWidth+"x"+d.dmPelsHeight); lw=d.dmPelsWidth; lh=d.dmPelsHeight; }
      i++;
    }
    return l.ToArray();
  }
  public static int SetRes(string dev,int w,int h) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return -99;
    d.dmPelsWidth=w; d.dmPelsHeight=h; d.dmFields=0x80000|0x100000;
    return ChangeDisplaySettingsEx(dev, ref d, IntPtr.Zero, 0, IntPtr.Zero);
  }
  // returns "x,y" after moving, or "<failed>"
  public static string Jiggle(int x,int y) {
    bool a=SetCursorPos(x-4,y-4), b=SetCursorPos(x,y);
    var p=new POINT(); GetCursorPos(out p);
    return (p.X==x&&p.Y==y) ? (p.X+","+p.Y) : ("<failed a="+a+" b="+b+" got="+p.X+","+p.Y+">");
  }
  public static uint Click(int x,int y) {
    INPUT[] a=new INPUT[2];
    a[0].type=0; a[0].mi.dwFlags=0x0001; a[1].type=0; a[1].mi.dwFlags=0x0002;
    uint r1=SendInput(2,a,Marshal.SizeOf(typeof(INPUT)));
    INPUT[] b=new INPUT[1]; b[0].type=0; b[0].mi.dwFlags=0x0004;
    uint r2=SendInput(1,b,Marshal.SizeOf(typeof(INPUT)));
    return r1+r2;
  }
  public static string ClassAt(int x,int y) {
    var p=new POINT{X=x,Y=y}; var h=WindowFromPoint(p);
    var sb=new StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString();
  }
  public static string LockState() {
    IntPtr h=OpenInputDesktop(0,false,0x0001);
    if(h==IntPtr.Zero) return "<err "+Marshal.GetLastWin32Error()+">";
    try { var sb=new StringBuilder(256); int n; return GetUserObjectInformation(h,2,sb,512,out n)?sb.ToString():"<q failed>"; }
    finally { CloseDesktop(h); }
  }
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h,int i,StringBuilder p,int n,out int need);
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
}
'@ -ErrorAction SilentlyContinue

W "########## A. display devices ##########"
W "--- PnP Display class ---"
Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
  Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }

W "--- WmiMonitorID (EDID identity; WinDisc has none) ---"
$any = $false
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
  $any = $true
  $nm = -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  $mn = -join ($_.ManufacturerName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  W ("  " + $_.InstanceName + "  mfr='" + $mn + "'  name='" + $nm + "'  Active=" + $_.Active)
}
if (-not $any) { W "  (none -- no EDID-bearing monitor)" }

W "--- .NET screens (what apps see) ---"
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  W ("  " + $_.DeviceName + "  " + $_.Bounds.Width + "x" + $_.Bounds.Height + "  primary=" + $_.Primary)
}

W "--- per-device: current + mode count ---"
foreach ($n in 1..6) {
  $dev = "\\.\DISPLAY$n"
  $cur = [V]::Current($dev)
  if ($cur -eq '<none>') { continue }
  $m = [V]::Modes($dev)
  W ("  " + $dev + "  current=" + $cur + "  modes=" + $m.Count + "  [" + (($m | Select-Object -First 8) -join ', ') + "]")
}

W "########## B. session / lock ##########"
W ("  console session = " + [V]::WTSGetActiveConsoleSessionId())
W ("  my session      = " + (Get-Process -Id $PID).SessionId)
W ("  input desktop   = " + [V]::LockState() + "   (Default = unlocked / Winlogon = locked)")
W ((& query.exe session 2>&1 | Out-String))

W "########## C. power policy (user says changed) ##########"
$q = & powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Out-String
W "--- STANDBYIDLE (0x0 = never) ---"
W (($q -split "`n" | Where-Object { $_ -match '0x|GUID ' }) -join "`n")
W "--- hibernate/standby tokens ---"
W ((& powercfg /a 2>&1 | Out-String))
W "--- screensaver (HKCU) ---"
$d = Get-ItemProperty 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue
W ("  ScreenSaveActive    = " + $d.ScreenSaveActive)
W ("  ScreenSaveTimeOut   = " + $d.ScreenSaveTimeOut)
W ("  ScreenSaverIsSecure = " + $d.ScreenSaverIsSecure)
W "--- machine inactivity auto-lock ---"
$v2 = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name InactivityTimeoutSecs -ErrorAction SilentlyContinue).InactivityTimeoutSecs
W ("  InactivityTimeoutSecs = " + $(if ($null -eq $v2) { '(not set)' } else { $v2 }))
W "--- monitor timeout ---"
W ((& powercfg /q SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 2>&1 | Out-String) -split "`n" | Where-Object { $_ -match '0x|GUID ' } | Out-String)

W "########## D. SendInput live test ##########"
$before = New-Object V+POINT
[void][V]::GetCursorPos([ref]$before)
W ("  cursor before   = " + $before.X + "," + $before.Y)
W ("  jiggle ->       = " + [V]::Jiggle(500, 400))
W ("  WindowFromPoint = '" + [V]::ClassAt(500,400) + "'")
W ("  SendInput       = " + [V]::Click(500,400) + " / 3")
[void][V]::SetCursorPos($before.X, $before.Y)
W ("  cursor restored = " + $before.X + "," + $before.Y)
W "DONE"
