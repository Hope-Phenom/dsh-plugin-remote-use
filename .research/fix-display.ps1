# fix-display.ps1 -- restore the slave desktop to 1920x1080 (DELL P2314H).
$log = 'C:\dsh-remote\evidence\fix-display.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class F {
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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettings(ref DEVMODE dm,int flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);
  public static string Now(string dev) { var d=new DEVMODE(); d.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE)); if(!EnumDisplaySettings(dev,-1,ref d)) return "<none>"; return d.dmPelsWidth+"x"+d.dmPelsHeight; }
  public static int SetRes(string dev,int w,int h) {
    var dm=new DEVMODE(); dm.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE));
    if(!EnumDisplaySettings(dev,-1,ref dm)) return -99;
    dm.dmPelsWidth=w; dm.dmPelsHeight=h; dm.dmFields=0x80000|0x100000;
    return ChangeDisplaySettings(ref dm, 0);
  }
  public static bool Has(string dev,int w,int h) {
    var dm=new DEVMODE(); dm.dmSize=(short)Marshal.SizeOf(typeof(DEVMODE)); int i=0;
    while(EnumDisplaySettings(dev,i,ref dm)) { if(dm.dmPelsWidth==w&&dm.dmPelsHeight==h) return true; i++; }
    return false;
  }
  // jiggle the cursor hard to wake the monitor
  public static void Wake() {
    for (int i=0;i<3;i++) { SetCursorPos(10+i,10+i); System.Threading.Thread.Sleep(60); mouse_event(0x0001,1,1,0,UIntPtr.Zero); }
  }
}
'@ -ErrorAction SilentlyContinue

W ("screens now    : " + (([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.DeviceName + "=" + $_.Bounds.Width + "x" + $_.Bounds.Height }) -join ", "))
W ("DISPLAY1 before: " + [F]::Now('\\.\DISPLAY1'))
W ("has 1920x1080? : " + [F]::Has('\\.\DISPLAY1',1920,1080))

W "--- waking monitor ---"
[F]::Wake()
Start-Sleep -Seconds 3
W ("DISPLAY1 after wake: " + [F]::Now('\\.\DISPLAY1'))

if ([F]::Now('\\.\DISPLAY1') -ne '1920x1080') {
  if ([F]::Has('\\.\DISPLAY1',1920,1080)) {
    $rc = [F]::SetRes('\\.\DISPLAY1',1920,1080)
    Start-Sleep -Seconds 3
    W ("ChangeDisplaySettings(1920x1080) rc=" + $rc + "  now=" + [F]::Now('\\.\DISPLAY1'))
  } else {
    W "1920x1080 NOT in the mode list for DISPLAY1 -- monitor is still detached (WinDisc only)"
  }
}

W "--- final ---"
W ("screens       : " + (([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.DeviceName + "=" + $_.Bounds.Width + "x" + $_.Bounds.Height + "(primary=" + $_.Primary + ")" }) -join ", "))
W ("DISPLAY1      : " + [F]::Now('\\.\DISPLAY1'))
W "--- monitor identity ---"
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
  $nm = -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  W ("  " + $_.InstanceName + " name='" + $nm + "' Active=" + $_.Active)
}
W ("cursor sanity : SetCursorPos then read -> " + [F]::Now('\\.\DISPLAY1'))
W "DONE"
