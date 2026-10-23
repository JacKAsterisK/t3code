param([Parameter(Mandatory=$true)][string]$LiteralPath)
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
public static class T3OfflineWinTrust {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct FileInfo { public uint size; [MarshalAs(UnmanagedType.LPWStr)] public string path; public IntPtr handle; public IntPtr subject; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct TrustData { public uint size; public IntPtr callback; public IntPtr client; public uint ui; public uint revocation; public uint choice; public IntPtr file; public uint stateAction; public IntPtr state; public IntPtr url; public uint flags; public uint context; public IntPtr settings; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ProviderCertificatePrefix { public uint size; public IntPtr certificate; }
  [StructLayout(LayoutKind.Sequential)]
  public struct CertificateContextPrefix { public uint encoding; public IntPtr encoded; public uint length; }
  public sealed class Result { public int Status; public string CertificateSha256; }
  [DllImport("wintrust.dll", ExactSpelling=true, SetLastError=false)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  static extern int WinVerifyTrust(IntPtr window, [In] ref Guid action, [In,Out] ref TrustData data);
  [DllImport("wintrust.dll", ExactSpelling=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
  [DllImport("wintrust.dll", ExactSpelling=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider, uint index, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterIndex);
  [DllImport("wintrust.dll", ExactSpelling=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint index);
  public static Result Verify(string path, IntPtr handle) {
    var info = new FileInfo { size=(uint)Marshal.SizeOf(typeof(FileInfo)), path=path, handle=handle };
    var pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
    try {
      Marshal.StructureToPtr(info,pointer,false);
      var data=new TrustData { size=(uint)Marshal.SizeOf(typeof(TrustData)), ui=2, revocation=1, choice=1, file=pointer, stateAction=1, flags=0x1000 };
      var action=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
      try {
        var status=WinVerifyTrust(IntPtr.Zero,ref action,ref data);
        if (status != 0) return new Result { Status=status };
        var provider=WTHelperProvDataFromStateData(data.state);
        var signer=provider == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(provider,0,false,0);
        var certificate=signer == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvCertFromChain(signer,0);
        var context=certificate == IntPtr.Zero ? IntPtr.Zero : ((ProviderCertificatePrefix)Marshal.PtrToStructure(certificate,typeof(ProviderCertificatePrefix))).certificate;
        if (context == IntPtr.Zero) throw new InvalidOperationException("Verified signer certificate missing.");
        var encoded=(CertificateContextPrefix)Marshal.PtrToStructure(context,typeof(CertificateContextPrefix));
        if (encoded.encoded == IntPtr.Zero || encoded.length == 0 || encoded.length > 1024*1024) throw new InvalidOperationException("Verified signer certificate invalid.");
        var bytes=new byte[encoded.length]; Marshal.Copy(encoded.encoded,bytes,0,bytes.Length);
        using (var digest=System.Security.Cryptography.SHA256.Create()) {
          return new Result { Status=0, CertificateSha256=BitConverter.ToString(digest.ComputeHash(bytes)).Replace("-","").ToLowerInvariant() };
        }
      } finally { data.stateAction=2; WinVerifyTrust(IntPtr.Zero,ref action,ref data); }
    } finally { Marshal.DestroyStructure(pointer,typeof(FileInfo)); Marshal.FreeHGlobal(pointer); }
  }
}
'@
Add-Type -TypeDefinition $source
$full = [System.IO.Path]::GetFullPath($LiteralPath)
if ($full -cne $LiteralPath) { throw 'Native validation requires a canonical absolute path.' }
$item = Get-Item -LiteralPath $full -Force
if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Native validation refuses links.' }
# A read-only sharing handle blocks replacement/write throughout WinVerifyTrust.
$stream = [System.IO.File]::Open($full, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
$algorithm = [System.Security.Cryptography.SHA256]::Create()
try {
  $digest = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
  $stream.Position = 0
  # Use the leaf from the exact successful provider chain, including dual-signed files.
  $verification = [T3OfflineWinTrust]::Verify($full, $stream.SafeFileHandle.DangerousGetHandle())
  $status = $verification.Status
  $certificateDigest = $verification.CertificateSha256
  $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($full).FileVersion
  $product = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($full).ProductName
  if ([string]::IsNullOrEmpty($version)) { $version = $null }
  if ([string]::IsNullOrEmpty($product)) { $product = $null }
  @{ sha256=$digest; trustStatus=$status; certificateSha256=$certificateDigest; fileVersion=$version; productName=$product } | ConvertTo-Json -Compress
} finally { $algorithm.Dispose(); $stream.Dispose() }
