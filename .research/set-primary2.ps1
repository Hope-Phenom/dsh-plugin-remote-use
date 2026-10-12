# set-primary2.ps1 -- DISPLAY4 is at 0,0; now flip the primary flag.
$log = 'C:\dsh-remote\evidence\vdd-primary2.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class C2 {
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
  public static int SetPrimary(string dev) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return -99;
    d.dmFields = 0x80000|0x100000|0x400000|0x20|0x40;
    // CDS_UPDATEREGISTRY|CDS_SET_PRIMARY|CDS_NORESET
    return ChangeDisplaySettingsEx(dev, ref d, IntPtr.Zero, 0x1|0x10|0x10000000, IntPtr.Zero);
  }
  public static int Commit() {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    return ChangeDisplaySettingsEx(null, ref d, IntPtr.Zero, 0, IntPtr.Zero);
  }
  public static string Cur(string dev) {
    var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref d)) return "<none>";
    return d.dmPelsWidth+"x"+d.dmPelsHeight+"@"+d.dmDisplayFrequency+" pos="+d.dmPositionX+","+d.dmPositionY;
  }
}
'@ -ErrorAction SilentlyContinue

W "=== before ==="
W ("  DISPLAY1 = " + [C2]::Cur('\\.\DISPLAY1'))
W ("  DISPLAY4 = " + [C2]::Cur('\\.\DISPLAY4'))

W "=== stage SET_PRIMARY on DISPLAY4 + commit ==="
W ("  stage rc = " + [C2]::SetPrimary('\\.\DISPLAY4'))
W ("  commit rc = " + [C2]::Commit())
Start-Sleep -Seconds 5

W "=== after (fresh Screen enumeration in a NEW process is what counts) ==="
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { W ("  " + $_.DeviceName + " " + $_.Bounds.Width + "x" + $_.Bounds.Height + " primary=" + $_.Primary + " at " + $_.Bounds.X + "," + $_.Bounds.Y) }
W ("  DISPLAY1 = " + [C2]::Cur('\\.\DISPLAY1'))
W ("  DISPLAY4 = " + [C2]::Cur('\\.\DISPLAY4'))
W ("  GetSystemMetrics(0,0) = " + ([System.Windows.Forms.SystemInformation]::VirtualScreen.Width) + "x" + ([System.Windows.Forms.SystemInformation]::VirtualScreen.Height))
W "DONE"
