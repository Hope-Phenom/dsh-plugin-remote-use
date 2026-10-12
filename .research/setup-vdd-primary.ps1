# setup-vdd-primary.ps1 -- make the VDD the primary 1920x1080 display.
$log = 'C:\dsh-remote\evidence\vdd-setup.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class S {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short a1,a2,dmSize,a3; public int f,x,y,o,fo; public short b1,b2,b3,b4,b5;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int c1,c2,c3,c4,c5,c6,c7,c8;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string d,int m,ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string d, ref DEVMODE dm, IntPtr h, int flags, IntPtr p);

  // CDS_UPDATEREGISTRY=1, CDS_SET_PRIMARY=0x10, CDS_NORESET=0x10000000
  public static int MakePrimary1920(string dev) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(dev, -1, ref dm)) return -99;
    dm.dmPelsWidth = 1920; dm.dmPelsHeight = 1080; dm.dmDisplayFrequency = 60;
    dm.dmFields = 0x80000 | 0x100000 | 0x400000;   // PELSWIDTH | PELSHEIGHT | DISPLAYFREQUENCY
    dm.x = 0; dm.y = 0;
    return ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, 0x1 | 0x10, IntPtr.Zero);
  }
  public static string Cur(string dev) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return "<none>";
    return d.dmPelsWidth+"x"+d.dmPelsHeight+"@"+d.dmDisplayFrequency+" pos="+d.x+","+d.y;
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static string Jig(int x,int y){ SetCursorPos(x-3,y-3); SetCursorPos(x,y); var p=new POINT(); GetCursorPos(out p); return p.X+","+p.Y; }
}
'@ -ErrorAction SilentlyContinue

W "=== BEFORE ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + "  " + $_.Bounds.Width + "x" + $_.Bounds.Height + "  primary=" + $_.Primary) }

# 1) make the VDD the primary 1920x1080 display
W "=== set VDD primary 1920x1080@60 ==="
$rc = [S]::MakePrimary1920('\\.\DISPLAY4')
W ("  ChangeDisplaySettingsEx rc=" + $rc + " (0 = success)")
Start-Sleep -Seconds 3
W ("  DISPLAY4 now: " + [S]::Cur('\\.\DISPLAY4'))
W ("  DISPLAY1 now: " + [S]::Cur('\\.\DISPLAY1'))

W "=== AFTER ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + "  " + $_.Bounds.Width + "x" + $_.Bounds.Height + "  primary=" + $_.Primary) }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W ("  VirtualScreen = " + $vs.X + "," + $vs.Y + " " + $vs.Width + "x" + $vs.Height)

# 2) prove SetCursorPos uses the primary origin
W "=== cursor on the new primary ==="
$b = New-Object S+POINT; [void][S]::GetCursorPos([ref]$b)
W ("  before = " + $b.X + "," + $b.Y)
W ("  jiggle(1000,540) = " + [S]::Jig(1000,540))
[void][S]::SetCursorPos($b.X,$b.Y)
W "DONE"
