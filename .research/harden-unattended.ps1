# harden-unattended.ps1 -- make the slave safe for unattended GUI test runs.
# NOTE: this CHANGES machine settings. Run deliberately.
$log = 'C:\dsh-remote\evidence\harden.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
function W($m) { $m | Tee-Object -FilePath $log -Append | Out-Null; $m }

W "===== BEFORE ====="
W ((& powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Select-String -Pattern '0x|GUID' | Out-String))

# 1) never sleep / never hibernate / never turn off disk (AC and DC)
W "--- applying: sleep & hibernate off ---"
& powercfg /change standby-timeout-ac 0    2>&1 | ForEach-Object { W $_ }
& powercfg /change standby-timeout-dc 0    2>&1 | ForEach-Object { W $_ }
& powercfg /change hibernate-timeout-ac 0  2>&1 | ForEach-Object { W $_ }
& powercfg /change hibernate-timeout-dc 0  2>&1 | ForEach-Object { W $_ }
& powercfg /change disk-timeout-ac 0       2>&1 | ForEach-Object { W $_ }

# 2) monitor may turn off (that is HARMLESS -- proven). Keep it off for power saving.
W "--- applying: monitor off after 10 min (harmless) ---"
& powercfg /change monitor-timeout-ac 10 2>&1 | ForEach-Object { W $_ }

# 3) disable hibernation entirely (removes a whole class of failure)
W "--- powercfg /hibernate off ---"
& powercfg /hibernate off 2>&1 | ForEach-Object { W $_ }

# 4) screensaver off (currently ScreenSaveActive=1 with empty timeout -- make it explicit)
W "--- screensaver off ---"
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -Value '0' -ErrorAction SilentlyContinue
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveTimeOut -Value '0' -ErrorAction SilentlyContinue
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaverIsSecure -Value '0' -ErrorAction SilentlyContinue
W ("  ScreenSaveActive = " + (Get-ItemProperty 'HKCU:\Control Panel\Desktop').ScreenSaveActive)

# 5) make sure no machine-wide inactivity auto-lock policy exists
W "--- auto-lock policy ---"
$p = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$v = (Get-ItemProperty $p -Name InactivityTimeoutSecs -ErrorAction SilentlyContinue).InactivityTimeoutSecs
W ("  InactivityTimeoutSecs = " + $(if ($null -eq $v) { '(not set -- good)' } else { $v }))

W "===== AFTER ====="
W ((& powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Select-String -Pattern '0x|GUID' | Out-String))
W "--- sleep/hibernate tokens ---"
W ((& powercfg /a 2>&1 | Out-String))
W "--- current session / lock state ---"
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class S2 {
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder p, int n, out int needed);
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  public static string D() {
    IntPtr h = OpenInputDesktop(0,false,0x0001);
    if (h == IntPtr.Zero) return "<err " + Marshal.GetLastWin32Error() + ">";
    try { var sb=new StringBuilder(256); int n; return GetUserObjectInformation(h,2,sb,512,out n)?sb.ToString():"<q failed>"; }
    finally { CloseDesktop(h); }
  }
}
'@ -ErrorAction SilentlyContinue
W ("  console session = " + [S2]::WTSGetActiveConsoleSessionId())
W ("  input desktop   = " + [S2]::D() + "  (Default = unlocked)")
W "DONE"
