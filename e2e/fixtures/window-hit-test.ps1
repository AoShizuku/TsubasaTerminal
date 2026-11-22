param([long]$WindowHandle, [string]$PointsPath)
$ErrorActionPreference = 'Stop'

# Read-only native hit testing. Match the target window's DPI context so a probe
# on a 175% / 200% display does not query a different point after DPI virtualization.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point p);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
  public static long HitTest(long handle, int x, int y) {
    IntPtr hwnd = new IntPtr(handle);
    IntPtr previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd));
    try {
      Point p = new Point { X=x, Y=y };
      if (!ClientToScreen(hwnd, ref p)) throw new Exception("ClientToScreen failed");
      UIntPtr result;
      long packed = (p.X & 0xffff) | ((p.Y & 0xffff) << 16);
      if (SendMessageTimeout(hwnd, 0x84, UIntPtr.Zero, new IntPtr(packed), 2, 2000, out result) == IntPtr.Zero)
        throw new Exception("WM_NCHITTEST timed out");
      return unchecked((long)result.ToUInt64());
    } finally {
      SetThreadDpiAwarenessContext(previous);
    }
  }
}
'@

$points = Get-Content -LiteralPath $PointsPath -Raw | ConvertFrom-Json
$results = foreach ($point in $points) {
  @{ name = $point.name; hit = [WindowHitTest]::HitTest($WindowHandle, $point.x, $point.y) }
}
ConvertTo-Json -InputObject @($results) -Compress
