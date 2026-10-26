# 논리 프로세서마다 "번호:코어:효율 등급"을 한 칸씩 띄워 쓴다. 효율 등급이 높을수록 성능 코어다(P코어).
# 부하 실행기가 API는 P코어에, k6는 나머지에 묶을 때 쓴다(DESIGN 6.6 "한 PC라는 조건").
$code = @'
using System;
using System.Runtime.InteropServices;
public static class CpuSets {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetSystemCpuSetInformation(IntPtr info, uint length, out uint returned, IntPtr process, uint flags);
  public static string Describe() {
    uint length;
    GetSystemCpuSetInformation(IntPtr.Zero, 0, out length, IntPtr.Zero, 0);
    IntPtr buffer = Marshal.AllocHGlobal((int)length);
    try {
      if (!GetSystemCpuSetInformation(buffer, length, out length, IntPtr.Zero, 0)) throw new Exception("GetSystemCpuSetInformation 실패");
      var sb = new System.Text.StringBuilder();
      for (int offset = 0; offset < length; ) {
        int size = Marshal.ReadInt32(buffer, offset);
        // SYSTEM_CPU_SET_INFORMATION.CpuSet: LogicalProcessorIndex(14), CoreIndex(15), EfficiencyClass(18)
        sb.Append(Marshal.ReadByte(buffer, offset + 14) + ":" + Marshal.ReadByte(buffer, offset + 15) + ":" + Marshal.ReadByte(buffer, offset + 18) + " ");
        offset += size;
      }
      return sb.ToString().Trim();
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }
}
'@
Add-Type -TypeDefinition $code
[CpuSets]::Describe()
