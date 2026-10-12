# probe-lock.ps1 -- is this session locked? what is the auto-lock / screensaver policy?
$log = 'C:\dsh-remote\evidence\lock.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class S {
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder p, int n, out int needed);
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  public static string InputDesktopName() {
    IntPtr h = OpenInputDesktop(0, false, 0x0001);
    if (h == IntPtr.Zero) return "<cannot open input desktop err=" + Marshal.GetLastWin32Error() + ">";
    try {
      var sb = new StringBuilder(256); int need;
      if (GetUserObjectInformation(h, 2 /*UOI_NAME*/, sb, 512, out need)) return sb.ToString();
      return "<query failed>";
    } finally { CloseDesktop(h); }
  }
}
'@ -ErrorAction SilentlyContinue

W ("sessionId            = " + (Get-Process -Id $PID).SessionId)
W ("interactive          = " + [Environment]::UserInteractive)
W ("active console sess  = " + [S]::WTSGetActiveConsoleSessionId())
W ("input desktop name   = " + [S]::InputDesktopName() + "   (Default = unlocked; Winlogon = locked)")

W "--- session table ---"
W ((& query.exe session 2>&1 | Out-String))

W "--- monitor power / state ---"
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue |
  ForEach-Object { W ("  " + $_.InstanceName + " Active=" + $_.Active) }
Get-CimInstance Win32_DesktopMonitor -ErrorAction SilentlyContinue |
  ForEach-Object { W ("  " + $_.Name + " Availability=" + $_.Availability) }
W ("  current screen = " + ([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width) + "x" + ([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height))

W "--- screensaver policy (HKCU) ---"
Get-ItemProperty 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue |
  Select-Object ScreenSaveActive,ScreenSaveTimeOut,ScreenSaverIsSecure,SCRNSAVE.EXE | Format-List | Out-String | ForEach-Object { W $_ }

W "--- screensaver policy (HKLM, machine-wide) ---"
Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' -ErrorAction SilentlyContinue |
  Format-List | Out-String | ForEach-Object { W $_ }

W "--- machine inactivity limit (auto-lock), HKLM ---"
$ml = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name InactivityTimeoutSecs -ErrorAction SilentlyContinue
if ($ml) { W ("  InactivityTimeoutSecs = " + $ml.InactivityTimeoutSecs) } else { W "  InactivityTimeoutSecs = (not set)" }

W "--- lock screen timeout (HKCU) ---"
Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name DelayLockInterval -ErrorAction SilentlyContinue | Format-List | Out-String | ForEach-Object { W $_ }

W "--- power plan: monitor / sleep / disk timeouts (AC) ---"
$scheme = (& powercfg /getactivescheme 2>&1 | Out-String)
W $scheme
W ((& powercfg /q SCHEME_CURRENT SUB_VIDEO 2>&1 | Select-String -Pattern 'GUID Alias|AC Power Setting Index|当前交流' | Out-String))
W "--- sleep timeout ---"
W ((& powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Out-String))

W "--- RDP listener: any client connected? ---"
W ((Get-NetTCPConnection -LocalPort 3389 -State Established -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String))
W "DONE"
