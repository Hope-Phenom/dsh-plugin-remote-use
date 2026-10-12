# probe-input-session.ps1 -- determine whether synthetic input works from THIS session.
# Pure ASCII on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
$ErrorActionPreference = 'Continue'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class P {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
        public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }

    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] a, int cb);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    public static string ClassOf(IntPtr h) {
        if (h == IntPtr.Zero) return "<null>";
        var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString();
    }
    public static int CountTopLevel() {
        int n = 0;
        EnumWindows((h, p) => { n++; return true; }, IntPtr.Zero);
        return n;
    }
    // Move away and back: SetCursorPos to the SAME point is a no-op and produces no WM_MOUSEMOVE.
    public static bool JiggleMove(int x, int y) {
        bool a = SetCursorPos(x - 3, y - 3);
        bool b = SetCursorPos(x, y);
        return a && b;
    }
    public static uint ClickAt(int x, int y) {
        INPUT[] a = new INPUT[2];
        a[0].type = 0; a[0].mi.dwFlags = 0x0001;
        a[1].type = 0; a[1].mi.dwFlags = 0x0002;
        uint r1 = SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
        INPUT[] b = new INPUT[1];
        b[0].type = 0; b[0].mi.dwFlags = 0x0004;
        uint r2 = SendInput(1, b, Marshal.SizeOf(typeof(INPUT)));
        return r1 + r2;   // 3 means all three events accepted
    }
}
'@

$sid = (Get-Process -Id $PID).SessionId
Write-Output ("SESSION_ID        = {0}" -f $sid)
Write-Output ("INTERACTIVE       = {0}" -f [Environment]::UserInteractive)
Write-Output ("DESKTOP_NAME      = {0}" -f [System.Environment]::GetEnvironmentVariable('SESSIONNAME'))
Write-Output ("USER              = {0}" -f [System.Environment]::UserName)

# Can this session even open the input desktop? Services sessions cannot.
try {
    $hd = [P]::OpenInputDesktop(0, $false, 0x0001)
    Write-Output ("OPEN_INPUT_DESKTOP= {0}" -f $(if ($hd -ne [IntPtr]::Zero) { "OK" } else { "FAILED err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error() }))
    if ($hd -ne [IntPtr]::Zero) { [void][P]::CloseDesktop($hd) }
} catch { Write-Output ("OPEN_INPUT_DESKTOP= EXCEPTION " + $_.Exception.Message) }

$pt = New-Object P+POINT
[void][P]::GetCursorPos([ref]$pt)
Write-Output ("CURSOR_BEFORE     = {0},{1}" -f $pt.X, $pt.Y)
Write-Output ("FOREGROUND_CLASS  = {0}" -f [P]::ClassOf([P]::GetForegroundWindow()))
Write-Output ("SHELL_WINDOW      = {0}" -f [P]::ClassOf([P]::GetShellWindow()))
Write-Output ("DESKTOP_WINDOW    = {0}" -f [P]::ClassOf([P]::GetDesktopWindow()))
Write-Output ("TOPLEVEL_WINDOWS  = {0}" -f [P]::CountTopLevel())

$moved = [P]::JiggleMove(400, 300)
$pt2 = New-Object P+POINT
[void][P]::GetCursorPos([ref]$pt2)
Write-Output ("SETCURSORPOS      = {0}" -f $moved)
Write-Output ("CURSOR_AFTER      = {0},{1}" -f $pt2.X, $pt2.Y)
Write-Output ("CURSOR_MOVED      = {0}" -f (($pt2.X -eq 400) -and ($pt2.Y -eq 300)))

$p3 = New-Object P+POINT
$p3.X = 400; $p3.Y = 300
$hwnd = [P]::WindowFromPoint($p3)
Write-Output ("WINDOWFROMPOINT   = '{0}'" -f [P]::ClassOf($hwnd))

$sent = [P]::ClickAt(400, 300)
Write-Output ("SENDINPUT_RETURN  = {0} / 3" -f $sent)
Write-Output ("SENDINPUT_OK      = {0}" -f ($sent -eq 3))

# restore cursor
[void][P]::SetCursorPos($pt.X, $pt.Y)
Write-Output "DONE"
