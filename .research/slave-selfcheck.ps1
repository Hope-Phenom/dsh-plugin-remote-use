# slave-selfcheck.ps1 -- DESIGN.md section 5.10 self-check.
# ASCII-ONLY ON PURPOSE: Windows PowerShell 5.1 reads BOM-less files as ANSI, and a
# non-ASCII byte sequence inside a string literal breaks parsing.
# Dual mode: SYSTEM (boot) checks the system layer; interactive (logon) adds S7/S8.
$ErrorActionPreference = 'Continue'
$outFile = 'C:\dsh-remote\selfcheck.json'
$txtFile = 'C:\dsh-remote\selfcheck.txt'
New-Item -ItemType Directory -Force 'C:\dsh-remote' | Out-Null

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SC {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DD {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string dev, uint n, ref DD d, uint flags);
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
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h,int i,StringBuilder p,int n,out int need);
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();

  public static string[] Adapters() {
    var l = new System.Collections.Generic.List<string>();
    var d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); uint i = 0;
    while (EnumDisplayDevices(null, i, ref d, 0)) {
      var mons = new System.Collections.Generic.List<string>();
      var m = new DD(); m.cb = Marshal.SizeOf(typeof(DD)); uint j = 0;
      while (EnumDisplayDevices(d.DeviceName, j, ref m, 0)) {
        mons.Add(m.DeviceString + " flags=" + m.StateFlags);
        m = new DD(); m.cb = Marshal.SizeOf(typeof(DD)); j++;
      }
      l.Add(d.DeviceName + " | " + d.DeviceString + " | flags=" + d.StateFlags + " | mons=" + mons.Count + " {" + string.Join(", ", mons) + "}");
      d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); i++;
    }
    return l.ToArray();
  }
  public static string InputDesktop() {
    IntPtr h = OpenInputDesktop(0, false, 0x0001);
    if (h == IntPtr.Zero) return "<err " + Marshal.GetLastWin32Error() + ">";
    try { var sb = new StringBuilder(256); int n; return GetUserObjectInformation(h, 2, sb, 512, out n) ? sb.ToString() : "?"; }
    finally { CloseDesktop(h); }
  }
  public static string CursorTest(int x, int y) {
    SetCursorPos(x - 3, y - 3); bool ok = SetCursorPos(x, y);
    var p = new POINT(); GetCursorPos(out p);
    return (p.X == x && p.Y == y) ? "ok" : ("FAIL set=" + ok + " got=" + p.X + "," + p.Y);
  }
  public static string ConsoleId() { return WTSGetActiveConsoleSessionId().ToString(); }
}
'@ -ErrorAction SilentlyContinue

$checks = New-Object System.Collections.ArrayList
function Add-Check($id, $name, $sev, $status, $expected, $actual, $fix) {
  [void]$checks.Add([ordered]@{
    id = $id; name = $name; severity = $sev; status = $status
    expected = $expected; actual = $actual; fix = $fix
  })
}

$sid = (Get-Process -Id $PID).SessionId
$interactive = [Environment]::UserInteractive
$adaps = @()
try { $adaps = [SC]::Adapters() } catch {}
$screens = @()
try { $screens = @([System.Windows.Forms.Screen]::AllScreens) } catch {}
$primary = $screens | Where-Object { $_.Primary } | Select-Object -First 1
$vddAdap = @($adaps | Where-Object { $_ -match 'Virtual Display|MttVDD|VDD' })
$edids = @()
try { $edids = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue) } catch {}
$edidNames = @($edids | ForEach-Object { -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) })

# S1 display device attached to the desktop
Add-Check 'S1' 'display adapter attached' 'blocking' $(if ($adaps.Count -gt 0) { 'pass' } else { 'fail' }) '>=1 adapter' ($adaps.Count.ToString() + ' adapters') 'install/enable a display adapter'
# S2 virtual display present with EDID
Add-Check 'S2' 'virtual display present (not WinDisc fallback)' 'blocking' $(if ($vddAdap.Count -gt 0 -and $edids.Count -gt 0) { 'pass' } else { 'fail' }) 'VDD + EDID' ('vdd=' + $vddAdap.Count + ' edid=[' + ($edidNames -join ',') + ']') 'install/enable Virtual Display Driver'
# S3 resolution
$res = if ($primary) { "$($primary.Bounds.Width)x$($primary.Bounds.Height)" } else { '?' }
Add-Check 'S3' 'primary resolution' 'warning' $(if ($res -eq '1920x1080') { 'pass' } else { 'warn' }) '1920x1080' $res 'put the target resolution first in vdd_settings.xml'
# S4 primary at origin
$okOrigin = $false; $origin = '?'
if ($primary) { $origin = "primary=$($primary.DeviceName) at $($primary.Bounds.X),$($primary.Bounds.Y)"; $okOrigin = ($primary.Bounds.X -eq 0 -and $primary.Bounds.Y -eq 0) }
Add-Check 'S4' 'primary monitor at origin' 'blocking' $(if ($okOrigin) { 'pass' } else { 'fail' }) 'primary at (0,0)' $origin 'ChangeDisplaySettingsEx CDS_SET_PRIMARY|CDS_NORESET then commit'
# S5 DPI
$scale = 1.00
try { $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); if ($g) { $scale = [math]::Round($g.DpiX / 96.0, 2); $g.Dispose() } } catch {}
Add-Check 'S5' 'DPI scale' 'blocking' $(if ($scale -eq 1.0) { 'pass' } else { 'fail' }) '1.00' $scale.ToString() 'set display scaling to 100%'
# S6 console session
$q = (& query.exe session 2>&1 | Out-String)
$cid = [SC]::ConsoleId()
$isConsole = ($q -match ('(?m)^>?console\s+\S*\s*' + $cid + '\s'))
Add-Check 'S6' 'session bound to console' 'blocking' $(if ($isConsole) { 'pass' } else { 'fail' }) ('console id=' + $cid) ('mySession=' + $sid + ' consoleId=' + $cid) 'tscon <id> /dest:console as SYSTEM'
# S7 unlocked (interactive only)
if ($interactive) {
  $dsk = [SC]::InputDesktop()
  Add-Check 'S7' 'session unlocked' 'blocking' $(if ($dsk -eq 'Default') { 'pass' } else { 'fail' }) 'Default' $dsk 'unlock the session; disable auto-lock'
} else {
  Add-Check 'S7' 'session unlocked' 'blocking' 'unchecked' 'Default' 'n/a in system session' 'must be checked in an interactive session'
}
# S8 live input injection (interactive only)
if ($interactive) {
  $r = [SC]::CursorTest(960, 540)
  Add-Check 'S8' 'SendInput / SetCursorPos live' 'blocking' $(if ($r -eq 'ok') { 'pass' } else { 'fail' }) 'cursor moves' $r 'requires S1+S6+S7 to pass'
} else {
  Add-Check 'S8' 'SendInput / SetCursorPos live' 'blocking' 'unchecked' 'cursor moves' 'n/a in system session' 'must be checked in an interactive session'
}
# S9 no sleep
function PwrIdx($sub, $set) {
  $o = & powercfg /q SCHEME_CURRENT $sub $set 2>&1 | Out-String
  $m = [regex]::Matches($o, '0x[0-9a-fA-F]{8}')
  if ($m.Count -ge 2) { return @([Convert]::ToInt64($m[$m.Count - 2].Value, 16), [Convert]::ToInt64($m[$m.Count - 1].Value, 16)) }
  return @(-1, -1)
}
$standby = PwrIdx 'SUB_SLEEP' 'STANDBYIDLE'
$hib = PwrIdx 'SUB_SLEEP' 'HIBERNATEIDLE'
$noSleep = ($standby[0] -eq 0) -and ($standby[1] -eq 0) -and ($hib[0] -eq 0) -and ($hib[1] -eq 0)
Add-Check 'S9' 'sleep/hibernate disabled' 'blocking' $(if ($noSleep) { 'pass' } else { 'fail' }) 'AC=0 DC=0' ('standby=' + ($standby -join '/') + ' hibernate=' + ($hib -join '/')) 'powercfg /change standby-timeout-ac 0 (AC and DC)'
# S10 screensaver
$ss = (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -ErrorAction SilentlyContinue).ScreenSaveActive
Add-Check 'S10' 'screensaver off' 'warning' $(if ("$ss" -eq '0') { 'pass' } else { 'warn' }) '0' "$ss" 'HKCU Control Panel Desktop ScreenSaveActive=0'
# S11 no auto-lock policy
$il = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name InactivityTimeoutSecs -ErrorAction SilentlyContinue).InactivityTimeoutSecs
Add-Check 'S11' 'no auto-lock policy' 'warning' $(if ($null -eq $il) { 'pass' } else { 'warn' }) 'not set' $(if ($null -eq $il) { 'not set' } else { "$il" }) 'remove InactivityTimeoutSecs policy'
# S12 QuickEdit off
$qe = (Get-ItemProperty 'HKCU:\Console' -Name QuickEdit -ErrorAction SilentlyContinue).QuickEdit
Add-Check 'S12' 'console QuickEdit off' 'blocking' $(if ("$qe" -eq '0') { 'pass' } else { 'fail' }) '0' "$qe" 'HKCU Console QuickEdit=0 and InsertMode=0'
# S14 DSH installed
$dsh = 'C:\Users\worker\AppData\Local\Programs\DeepSeek Harness'
$ver = ''
$exe = Get-ChildItem $dsh -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) { $ver = $exe.VersionInfo.FileVersion }
Add-Check 'S14' 'DSH installed' 'blocking' $(if ($ver) { 'pass' } else { 'fail' }) 'installed' $ver 'install DSH and match the master version'
# S15 credentials
$cred = 'C:\Users\worker\.dsh\.credentials.yaml'
$hasCred = Test-Path $cred
Add-Check 'S15' 'model credentials present' 'blocking' $(if ($hasCred) { 'pass' } else { 'fail' }) 'exists' $(if ($hasCred) { 'exists' } else { 'missing' }) 'sign in to DSH on the worker'
# S16 disk space
$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction SilentlyContinue
$freeGB = if ($d) { [math]::Round($d.FreeSpace / 1GB, 1) } else { 0 }
Add-Check 'S16' 'free disk space' 'warning' $(if ($freeGB -ge 50) { 'pass' } else { 'warn' }) '>=50 GB' "$freeGB GB" 'free up disk'
# S17 GPU (informational)
$gpu = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { $_.Name + ' ' + $_.DriverVersion }) -join ' ; '
Add-Check 'S17' 'GPU model/driver (reported)' 'info' 'pass' 'n/a' $gpu '-'
# S18 target app present
$app = 'C:\dsh-remote\avalonia-demo\avalonia-demo\bin\Debug\net10.0\avalonia-demo.exe'
Add-Check 'S18' 'target app present' 'warning' $(if (Test-Path $app) { 'pass' } else { 'warn' }) 'exists' $(if (Test-Path $app) { 'present' } else { 'missing' }) 'sync the app build output'

$blocking = @($checks | Where-Object { $_.severity -eq 'blocking' -and $_.status -eq 'fail' })
$warn = @($checks | Where-Object { $_.severity -in @('blocking', 'warning') -and $_.status -eq 'warn' })
$unchecked = @($checks | Where-Object { $_.status -eq 'unchecked' })
$verdict = if ($blocking.Count -gt 0) { 'blocked' } elseif ($unchecked.Count -gt 0) { 'partial' } elseif ($warn.Count -gt 0) { 'warn' } else { 'ready' }

$payload = [ordered]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToString('o')
  worker = $env:COMPUTERNAME
  sessionId = $sid
  interactive = $interactive
  verdict = $verdict
  blockingFailures = $blocking.Count
  warnings = $warn.Count
  unchecked = $unchecked.Count
  checks = $checks
}
$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $outFile -Encoding UTF8

$lines = @()
$lines += "verdict=$verdict blocking=$($blocking.Count) warn=$($warn.Count) unchecked=$($unchecked.Count) session=$sid interactive=$interactive"
foreach ($c in $checks) {
  $mark = switch ($c.status) { 'pass' { 'OK  ' } 'fail' { 'FAIL' } 'warn' { 'WARN' } 'unchecked' { '??  ' } default { '    ' } }
  $lines += ("  [" + $mark + "] " + $c.id + " " + $c.name + " | expected=" + $c.expected + " | actual=" + $c.actual)
}
$lines += "json: $outFile"
$lines | Set-Content -Path $txtFile -Encoding UTF8
$lines | ForEach-Object { Write-Output $_ }
