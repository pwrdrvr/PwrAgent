// Test diagnostics only. Compile for x64 with the Windows .NET Framework csc.
// No remote handle duplication. All process handles are non-inheritable.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class WindowsPipeDiagnostics {
  const uint QueryLimited = 0x1000;
  const int LengthMismatch = unchecked((int)0xc0000004);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr buffer, int length, out int needed);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint length);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("dbghelp.dll", SetLastError = true)] static extern bool MiniDumpWriteDump(IntPtr process, uint pid, IntPtr file,
    uint kind, IntPtr exception, IntPtr streams, IntPtr callback);

  static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
  static Dictionary<string, object> D(params object[] fields) {
    var result = new Dictionary<string, object>();
    for (int i = 0; i < fields.Length; i += 2) result.Add((string)fields[i], fields[i + 1]);
    return result;
  }
  static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  static long Created(IntPtr handle, out long exit) {
    long creation, kernel, user;
    if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Exception("GetProcessTimes:" + Marshal.GetLastWin32Error());
    return creation;
  }
  static IntPtr SystemInformation(int kind, out int length) {
    int capacity = 4 * 1024 * 1024;
    for (;;) {
      IntPtr buffer = Marshal.AllocHGlobal(capacity);
      int status = NtQuerySystemInformation(kind, buffer, capacity, out length);
      if (status == 0) return buffer;
      Marshal.FreeHGlobal(buffer);
      if (status != LengthMismatch || capacity >= 64 * 1024 * 1024) throw new Exception("NtQuerySystemInformation:" + status + ":" + length);
      capacity = (int)Math.Min(64L * 1024 * 1024, Math.Max(capacity * 2L, (long)length + 65536));
    }
  }

  // Native FILETIME strings are 100ns since 1601, not DateTime ticks since 0001.
  sealed class ProcessRow { public uint Pid, Parent; public long Created; public string Name; }
  static List<ProcessRow> Processes() {
    int length; IntPtr buffer = SystemInformation(5, out length);
    try {
      var rows = new List<ProcessRow>(); int offset = 0;
      for (;;) {
        if (offset < 0 || offset + 96 > length) throw new Exception("Invalid SYSTEM_PROCESS_INFORMATION offset");
        IntPtr item = IntPtr.Add(buffer, offset);
        uint pid = (uint)Marshal.ReadInt64(item, 80);
        long creation = Marshal.ReadInt64(item, 32);
        if (pid > 0 && creation > 0) {
          var name = (UnicodeString)Marshal.PtrToStructure(IntPtr.Add(item, 56), typeof(UnicodeString));
          long nameOffset = name.Buffer.ToInt64() - buffer.ToInt64();
          if ((name.Length & 1) != 0 || (name.Length > 0 && (nameOffset < 0 || nameOffset + name.Length > length)))
            throw new Exception("Invalid SYSTEM_PROCESS_INFORMATION image name");
          rows.Add(new ProcessRow { Pid = pid, Parent = (uint)Marshal.ReadInt64(item, 88), Created = creation,
            Name = Marshal.PtrToStringUni(name.Buffer, name.Length / 2) ?? "" });
        }
        int next = Marshal.ReadInt32(item);
        if (next == 0) return rows;
        if (next < 96) throw new Exception("Invalid SYSTEM_PROCESS_INFORMATION size");
        offset += next;
      }
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  static void Watch(string stop) {
    var known = new Dictionary<string, ProcessRow>();
    var pinned = new Dictionary<string, IntPtr>();
    int records = 0, samples = 0; double totalMs = 0, maxMs = 0;
    try {
      while (!File.Exists(stop)) {
        var clock = Stopwatch.StartNew(); long started = Now();
        var rows = Processes(); var byPid = rows.ToDictionary(row => row.Pid);
        var live = new Dictionary<string, ProcessRow>();
        foreach (var row in rows) {
          string key = row.Pid + ":" + row.Created; live.Add(key, row);
          if (known.ContainsKey(key)) continue;
          if (++records > 32768) throw new Exception("Process record limit reached; subsequent ancestry is omitted");
          string executable = null, error = null;
          IntPtr handle = OpenProcess(QueryLimited, false, row.Pid);
          if (handle == IntPtr.Zero) error = "OpenProcess:" + Marshal.GetLastWin32Error();
          else {
            try {
              long exit;
              if (Created(handle, out exit) != row.Created) throw new Exception("Creation identity changed before observation");
              pinned.Add(key, handle);
              var name = new StringBuilder(32768); uint count = (uint)name.Capacity;
              if (QueryFullProcessImageNameW(handle, 0, name, ref count)) executable = name.ToString();
              else error = "QueryFullProcessImageName:" + Marshal.GetLastWin32Error();
            } catch (Exception failure) { error = failure.Message; }
            finally { if (!pinned.ContainsKey(key)) CloseHandle(handle); }
          }
          ProcessRow parent;
          string parentCreated = byPid.TryGetValue(row.Parent, out parent) && parent.Created <= row.Created ? parent.Created.ToString() : null;
          Emit(D("kind", "start", "at", Now(), "sampleStarted", started, "pid", row.Pid, "ppid", row.Parent,
            "created", row.Created.ToString(), "parentCreated", parentCreated, "name", row.Name,
            "executable", executable, "commandLineOmitted", true, "error", error));
        }
        foreach (var previous in known) if (!live.ContainsKey(previous.Key)) {
          long exit = 0; string error = null; IntPtr handle;
          if (pinned.TryGetValue(previous.Key, out handle)) {
            try { if (Created(handle, out exit) != previous.Value.Created) throw new Exception("Pinned identity changed"); }
            catch (Exception failure) { error = failure.Message; }
            finally { CloseHandle(handle); pinned.Remove(previous.Key); }
          } else error = "No retained query handle; native exit time unavailable";
          Emit(D("kind", "gone", "at", Now(), "pid", previous.Value.Pid, "created", previous.Value.Created.ToString(),
            "nativeExit", exit.ToString(), "error", error));
        }
        known = live;
        double elapsed = clock.Elapsed.TotalMilliseconds; totalMs += elapsed; maxMs = Math.Max(maxMs, elapsed);
        if (samples++ == 0) Emit(D("kind", "ready", "at", Now(), "baselineMs", elapsed, "pid", GetCurrentProcessId()));
        Thread.Sleep(50);
      }
    } finally {
      foreach (var handle in pinned.Values) CloseHandle(handle);
      Emit(D("kind", "watch-complete", "at", Now(), "samples", samples, "totalSampleMs", totalMs, "maxSampleMs", maxMs));
    }
  }

  static void Identity(uint pid) {
    long started = Now();
    IntPtr process = OpenProcess(QueryLimited, false, pid);
    if (process == IntPtr.Zero) {
      Emit(D("kind", "identity", "started", started, "ended", Now(), "process", D("pid", pid, "error", "OpenProcess:" + Marshal.GetLastWin32Error())));
      return;
    }
    try {
      long exitBefore, created = Created(process, out exitBefore);
      long exitAfter; bool verified = Created(process, out exitAfter) == created;
      Emit(D("kind", "identity", "started", started, "ended", Now(), "process", D("pid", pid,
        "created", created.ToString(), "verified", verified, "liveAfter", exitBefore == 0 && exitAfter == 0,
        "nativeExitAfter", exitAfter.ToString())));
    } finally { CloseHandle(process); }
  }

  static void Dump(uint pid, long expectedCreated, string filename) {
    long started = Now();
    // QUERY_INFORMATION | VM_READ only: never duplicate launcher pipe handles.
    IntPtr process = OpenProcess(0x400 | 0x10, false, pid);
    if (process == IntPtr.Zero) {
      Emit(D("kind", "dump", "started", started, "ended", Now(), "status", "open-failed", "errorCode", Marshal.GetLastWin32Error()));
      return;
    }
    try {
      long exit, created = Created(process, out exit);
      if (created != expectedCreated || exit != 0) {
        Emit(D("kind", "dump", "started", started, "ended", Now(), "status", "identity-not-live",
          "created", created.ToString(), "nativeExit", exit.ToString()));
        return;
      }
      bool written; int error; long bytes;
      using (var file = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        // Filter stack memory to unwind pointers; omit data, heap, handles,
        // environment and tokens. Raw dumps remain private and are deleted.
        written = MiniDumpWriteDump(process, pid, file.SafeFileHandle.DangerousGetHandle(),
          0x8 | 0x80 | 0x1000 | 0x20000, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        error = written ? 0 : Marshal.GetLastWin32Error();
        bytes = file.Length;
      }
      long exitAfter; bool same = Created(process, out exitAfter) == expectedCreated;
      Emit(D("kind", "dump", "started", started, "ended", Now(), "status", written && same ? "written" : "write-failed",
        "created", created.ToString(), "nativeExitAfter", exitAfter.ToString(), "bytes", bytes, "errorCode", error));
    } catch (Exception error) {
      // File/DbgHelp exceptions can embed paths. Publish only the error type/code.
      Emit(D("kind", "dump", "started", started, "ended", Now(), "status", "write-failed",
        "errorType", error.GetType().Name, "errorCode", error.HResult));
    } finally { CloseHandle(process); }
  }

  public static int Main(string[] args) {
    try {
      Console.OutputEncoding = new UTF8Encoding(false);
      if (IntPtr.Size != 8) throw new Exception("Windows pipe diagnostics require x64");
      if (args[0] == "watch") Watch(args[1]);
      else if (args[0] == "identity") Identity(uint.Parse(args[1]));
      else if (args[0] == "dump") Dump(uint.Parse(args[1]), long.Parse(args[2]), args[3]);
      else throw new Exception("Unknown diagnostic mode");
      return 0;
    } catch (Exception error) { Emit(D("kind", "error", "at", Now(), "error", error.Message)); return 1; }
  }
}

