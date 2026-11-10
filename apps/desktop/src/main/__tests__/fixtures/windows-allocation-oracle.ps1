# MIT, Copyright (c) 2026 PwrDrvr LLC.
# Independent OS oracle for an explicit list of test-owned paths. No walking,
# deduplication, production helper code, or operator files are used here.
param([Parameter(Mandatory = $true)][string]$Manifest)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AllocationOracle {
  [StructLayout(LayoutKind.Sequential)]
  struct StandardInfo {
    public long AllocationSize, EndOfFile;
    public uint NumberOfLinks;
    public byte DeletePending, Directory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind,
    out StandardInfo info, uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetCompressedFileSizeW(string path, out uint high);
  public static long Bytes(string path, bool compressedOrSparse) {
    if (compressedOrSparse) {
      uint high;
      uint low = GetCompressedFileSizeW(path, out high);
      if (low == uint.MaxValue && Marshal.GetLastWin32Error() != 0)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return (long)(((ulong)high << 32) | low);
    }
    using (var file = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      StandardInfo info;
      if (file.IsInvalid || !GetFileInformationByHandleEx(file, 1, out info, (uint)Marshal.SizeOf(typeof(StandardInfo))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return info.AllocationSize;
    }
  }
}
'@
$paths = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$bytes = @($paths | ForEach-Object {
  $entry = Get-Item -LiteralPath $_ -Force
  $special = ($entry.Attributes -band ([IO.FileAttributes]::Compressed -bor [IO.FileAttributes]::SparseFile)) -ne 0
  [AllocationOracle]::Bytes($_, ($special -and !$entry.PSIsContainer))
})
ConvertTo-Json -InputObject $bytes -Compress
