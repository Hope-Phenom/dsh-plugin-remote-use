# setup-vdd2.ps1 -- proper DEVMODE (fully expanded) to set the VDD as primary 1920x1080.
$log = 'C:\dsh-remote\evidence\vdd-setup2.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class T {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr h, int flags, IntPtr p);

  public static string Cur(string dev) {
    var d = new DEVMODE(); d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(dev, -1, ref d)) return "<none>";
    return d.dmPelsWidth + "x" + d.dmPelsHeight + "@" + d.dmDisplayFrequency + " pos=" + d.dmPositionX + "," + d.dmPositionY;
  }
  public static bool Has(string dev, int w, int h, int hz) {
    var d = new DEVMODE(); d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); int i = 0;
    while (EnumDisplaySettings(dev, i, ref d)) {
      if (d.dmPelsWidth == w && d.dmPelsHeight == h && (hz == 0 || d.dmDisplayFrequency == hz)) return true;
      i++;
    }
    return false;
  }
  // CDS_UPDATEREGISTRY = 1 ; CDS_SET_PRIMARY = 0x10
  public static int SetPrimary(string dev, int w, int h, int hz) {
    var d = new DEVMODE(); d.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(dev, -1, ref d)) return -99;
    d.dmPelsWidth = w; d.dmPelsHeight = h;
    if (hz != 0) d.dmDisplayFrequency = hz;
    d.dmPositionX = 0; d.dmPositionY = 0;
    d.dmFields = 0x80000 | 0x100000 | (hz != 0 ? 0x400000 : 0) | 0x20 | 0x40; // WIDTH|HEIGHT|FREQ|POSX|POSY
    return ChangeDisplaySettingsEx(dev, ref d, IntPtr.Zero, 1 | 0x10, IntPtr.Zero);
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static string Jig(int x, int y) { SetCursorPos(x-3,y-3); SetCursorPos(x,y); var p = new POINT(); GetCursorPos(out p); return p.X + "," + p.Y; }
}
'@ -ErrorAction SilentlyContinue

W ("DEVMODE size = " + [System.Runtime.InteropServices.Marshal]::SizeOf([type]'T+DEVMODE') + " (Windows x64 expects 220)")

W "=== BEFORE ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + "  " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
W ("  DISPLAY4: " + [T]::Cur('\\.\DISPLAY4'))
W ("  has 1920x1080@60 ? " + [T]::Has('\\.\DISPLAY4', 1920, 1080, 60))
W ("  has 1920x1080@30 ? " + [T]::Has('\\.\DISPLAY4', 1920, 1080, 30))

W "=== set DISPLAY4 primary 1920x1080@60 ==="
$rc = [T]::SetPrimary('\\.\DISPLAY4', 1920, 1080, 60)
W ("  rc = " + $rc)
Start-Sleep -Seconds 4
W ("  DISPLAY4: " + [T]::Cur('\\.\DISPLAY4'))
W ("  DISPLAY1: " + [T]::Cur('\\.\DISPLAY1'))

W "=== AFTER ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + "  " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary) }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
W ("  VirtualScreen = " + $vs.X + "," + $vs.Y + " " + $vs.Width + "x" + $vs.Height)
W ("  cursor jiggle(960,540) = " + [T]::Jig(960, 540))
W "DONE"
