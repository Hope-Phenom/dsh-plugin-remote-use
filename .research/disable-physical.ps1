# disable-physical.ps1 -- detach the physical display so Windows promotes the VDD to primary.
$log = 'C:\dsh-remote\evidence\vdd-disable.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class B {
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
  // disable a display: pass the CURRENT mode with dmFields = 0 and CDS_UPDATEREGISTRY
  public static int Disable(string dev) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return -99;
    d.dmFields = 0;
    return ChangeDisplaySettingsEx(dev, ref d, IntPtr.Zero, 0x1, IntPtr.Zero);
  }
  // enable + position a display
  public static int Enable(string dev, int x, int y) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return -99;
    d.dmPositionX=x; d.dmPositionY=y;
    d.dmFields = 0x20|0x40|0x80000|0x100000|0x400000;
    return ChangeDisplaySettingsEx(dev, ref d, IntPtr.Zero, 0x1, IntPtr.Zero);
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static string Jig(int x,int y){ SetCursorPos(x-3,y-3); SetCursorPos(x,y); var p=new POINT(); GetCursorPos(out p); return p.X+","+p.Y; }
}
'@ -ErrorAction SilentlyContinue

W "=== BEFORE ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary + " at " + $_.Bounds.X + "," + $_.Bounds.Y) }
W ("  DISPLAY4 = " + [B]::Cur('\\.\DISPLAY4'))

W "=== 1) disable physical DISPLAY1 ==="
W ("  rc = " + [B]::Disable('\\.\DISPLAY1'))
Start-Sleep -Seconds 4
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
W ("  DISPLAY1 = " + [B]::Cur('\\.\DISPLAY1'))
W ("  DISPLAY4 = " + [B]::Cur('\\.\DISPLAY4'))

W "=== 2) ensure VDD is at 1920x1080 origin ==="
W ("  rc = " + [B]::Enable('\\.\DISPLAY4', 0, 0))
Start-Sleep -Seconds 3
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W ("  VirtualScreen = " + $vs.X + "," + $vs.Y + " " + $vs.Width + "x" + $vs.Height)
W ("  cursor (960,540) -> " + [B]::Jig(960,540))
W "DONE"
