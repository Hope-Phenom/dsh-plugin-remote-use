# arrange-vdd.ps1 -- put the VDD at the origin (1920x1080) and move the physical monitor to its right.
$log = 'C:\dsh-remote\evidence\vdd-arrange.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class A {
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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string d, ref DEVMODE dm, IntPtr h, int flags, IntPtr p);
  public static string Cur(string dev) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return "<none>";
    return d.dmPelsWidth+"x"+d.dmPelsHeight+"@"+d.dmDisplayFrequency+" pos="+d.dmPositionX+","+d.dmPositionY;
  }
  // CDS_NORESET=0x10000000 : stage the change; call with flags=0 afterwards to commit
  public static int Stage(string dev, int x, int y, int w, int h, int hz, bool primary) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return -99;
    d.dmPositionX=x; d.dmPositionY=y;
    d.dmPelsWidth=w; d.dmPelsHeight=h;
    if(hz!=0) d.dmDisplayFrequency=hz;
    d.dmFields = 0x20|0x40|0x80000|0x100000|(hz!=0?0x400000:0);
    int f = 0x10000000 | 0x1 | (primary ? 0x10 : 0);
    return ChangeDisplaySettingsEx(dev, ref d, IntPtr.Zero, f, IntPtr.Zero);
  }
  public static int Commit() {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    return ChangeDisplaySettingsEx(null, ref d, IntPtr.Zero, 0, IntPtr.Zero);
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static string Jig(int x,int y){ SetCursorPos(x-3,y-3); SetCursorPos(x,y); var p=new POINT(); GetCursorPos(out p); return p.X+","+p.Y; }
}
'@ -ErrorAction SilentlyContinue

W ("DEVMODE size = " + [System.Runtime.InteropServices.Marshal]::SizeOf([type]'A+DEVMODE'))
W "=== BEFORE ==="
W ("  DISPLAY1: " + [A]::Cur('\\.\DISPLAY1'))
W ("  DISPLAY4: " + [A]::Cur('\\.\DISPLAY4'))
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  screen " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }

W "=== stage: DISPLAY4 primary 1920x1080@60 at 0,0 ==="
W ("  rc1 = " + [A]::Stage('\\.\DISPLAY4', 0, 0, 1920, 1080, 60, $true))
W "=== stage: DISPLAY1 at 1920,0 (keeps its own mode) ==="
$c = [A]::Cur('\\.\DISPLAY1')   # e.g. 1080x1920@60 pos=0,0
W ("  DISPLAY1 pre = " + $c)
W ("  rc2 = " + [A]::Stage('\\.\DISPLAY1', 1920, 0, 1080, 1920, 60, $false))
W "=== commit ==="
W ("  rc3 = " + [A]::Commit())
Start-Sleep -Seconds 4

W "=== AFTER ==="
W ("  DISPLAY1: " + [A]::Cur('\\.\DISPLAY1'))
W ("  DISPLAY4: " + [A]::Cur('\\.\DISPLAY4'))
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  screen " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W ("  VirtualScreen = " + $vs.X + "," + $vs.Y + " " + $vs.Width + "x" + $vs.Height)
W ("  cursor (960,540) -> " + [A]::Jig(960,540))
W "DONE"
