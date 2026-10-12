# probe-display2.ps1 -- (a) does SendInput work while the monitor is powered off?
#                       (b) can we actually CHANGE the resolution (and restore it)?
$log = 'C:\dsh-remote\evidence\display2.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class D2 {
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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string d, int m, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] a, int cb);

  static DEVMODE Cur(string dev) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    EnumDisplaySettings(dev, -1, ref dm); return dm;
  }
  public static string Now(string dev) { var d = Cur(dev); return d.dmPelsWidth + "x" + d.dmPelsHeight; }
  // CDS_UPDATEREGISTRY=1 | CDS_GLOBAL=8 ... use 0 = dynamic only, not persisted
  public static int SetRes(string dev, int w, int h) {
    var dm = Cur(dev);
    dm.dmPelsWidth = w; dm.dmPelsHeight = h;
    dm.dmFields = 0x80000 /*DM_PELSWIDTH*/ | 0x100000 /*DM_PELSHEIGHT*/;
    return ChangeDisplaySettings(ref dm, 0);
  }
  public static int Jiggle(int x, int y) {
    SetCursorPos(x-3, y-3); SetCursorPos(x, y);
    var p = new POINT(); GetCursorPos(out p);
    return (p.X == x && p.Y == y) ? 1 : 0;
  }
  public static uint Click(int x, int y) {
    INPUT[] a = new INPUT[2];
    a[0].type=0; a[0].mi.dwFlags=0x0001; a[1].type=0; a[1].mi.dwFlags=0x0002;
    uint r1 = SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    INPUT[] b = new INPUT[1]; b[0].type=0; b[0].mi.dwFlags=0x0004;
    uint r2 = SendInput(1, b, Marshal.SizeOf(typeof(INPUT)));
    return r1 + r2;
  }
  public static void MonitorOff() {
    const int WM_SYSCOMMAND = 0x0112, SC_MONITORPOWER = 0xF170;
    IntPtr h = GetConsoleWindow();
    SendMessage(h, WM_SYSCOMMAND, (IntPtr)SC_MONITORPOWER, (IntPtr)2); // 2 = off
  }
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
}
'@ -ErrorAction SilentlyContinue

$dev = (([System.Windows.Forms.Screen]::AllScreens)[0]).DeviceName
W ("device          = " + $dev)
W ("current         = " + [D2]::Now($dev))

# also read the shell's device name (WinDisc vs real monitor)
W "--- monitor identity ---"
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object {
  $nm = -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
  W ("  " + $_.InstanceName + "  name='" + $nm + "'  Active=" + $_.Active)
}

# ---------- (a) SendInput with monitor OFF ----------
W "===== (a) SendInput while monitor is powered off ====="
W ("  cursor before = " + ([D2]::Jiggle(700, 500)) + " (1 = cursor really moved)")
[D2]::MonitorOff()
Start-Sleep -Seconds 4
$clicked = [D2]::Click(700, 500)
W ("  monitor told to power off; SendInput returned = " + $clicked + " / 3")
W ("  cursor jiggle after off = " + ([D2]::Jiggle(700, 500)))
# wake the monitor back up (any input wakes it)
[void][D2]::Jiggle(701, 501)
W ("  cursor now = " + [D2]::Now($dev))

# ---------- (b) change resolution and restore ----------
W "===== (b) can resolution be changed? ====="
$orig = [D2]::Now($dev)
W ("  original = " + $orig)
$rc = [D2]::SetRes($dev, 1280, 720)
Start-Sleep -Seconds 2
W ("  ChangeDisplaySettings(1280x720) rc=" + $rc + "  (0 = success)  now = " + [D2]::Now($dev))
Start-Sleep -Seconds 1
$rc2 = [D2]::SetRes($dev, 1920, 1080)
Start-Sleep -Seconds 2
W ("  ChangeDisplaySettings(1920x1080) rc=" + $rc2 + "  now = " + [D2]::Now($dev))
W ("  restored to original? " + ([D2]::Now($dev) -eq $orig))

# ---------- (c) SendInput still fine after mode churn? ----------
W "===== (c) SendInput after resolution round-trip ====="
W ("  jiggle = " + ([D2]::Jiggle(700, 500)) + "   SendInput = " + ([D2]::Click(700, 500)) + " / 3")
W "DONE"
