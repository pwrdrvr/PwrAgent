import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const EXECUTABLE_ENV = "PWRAGENT_JOB_WRAPPER_EXECUTABLE";
const ARGUMENT_0_ENV = "PWRAGENT_JOB_WRAPPER_ARGUMENT_0";
const ARGUMENT_1_ENV = "PWRAGENT_JOB_WRAPPER_ARGUMENT_1";
const WORKING_DIRECTORY_ENV = "PWRAGENT_JOB_WRAPPER_CWD";
const READY_FILE_ENV = "PWRAGENT_JOB_WRAPPER_READY_FILE";
const EXIT_FILE_ENV = "PWRAGENT_JOB_WRAPPER_EXIT_FILE";
const STARTED_AT_ENV = "PWRAGENT_JOB_WRAPPER_STARTED_AT";
const STARTUP_STATUS_FILE_ENV = "PWRAGENT_JOB_WRAPPER_STARTUP_STATUS_FILE";
const BASH_EXIT_TRAP =
  "trap 'pwragent_exit=$?; trap - EXIT; set +e; pwragent_exit_file=$(/usr/bin/cygpath.exe -u \"$PWRAGENT_JOB_WRAPPER_EXIT_FILE\"); if [ -n \"$pwragent_exit_file\" ]; then printf \"%s\" \"$pwragent_exit\" > \"$pwragent_exit_file\"; fi; exit \"$pwragent_exit\"' EXIT";

/**
 * PowerShell hosts this small native launcher because Node does not expose the
 * Windows Job Object APIs. The target starts suspended, enters a
 * KILL_ON_JOB_CLOSE job, and only then resumes, so even MSYS fork descendants
 * cannot escape between process creation and ownership assignment.
 */
const WINDOWS_JOB_WRAPPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$application = [string]$env:PWRAGENT_JOB_WRAPPER_EXECUTABLE
$argument0 = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:PWRAGENT_JOB_WRAPPER_ARGUMENT_0))
$argument1 = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:PWRAGENT_JOB_WRAPPER_ARGUMENT_1))
$workingDirectory = [string]$env:PWRAGENT_JOB_WRAPPER_CWD
$readyFile = [string]$env:PWRAGENT_JOB_WRAPPER_READY_FILE
$exitFile = [string]$env:PWRAGENT_JOB_WRAPPER_EXIT_FILE
$startupStartedAt = [long]$env:PWRAGENT_JOB_WRAPPER_STARTED_AT
$startupStatusFile = [string]$env:PWRAGENT_JOB_WRAPPER_STARTUP_STATUS_FILE
Remove-Item Env:PWRAGENT_JOB_WRAPPER_EXECUTABLE -ErrorAction SilentlyContinue
Remove-Item Env:PWRAGENT_JOB_WRAPPER_ARGUMENT_0 -ErrorAction SilentlyContinue
Remove-Item Env:PWRAGENT_JOB_WRAPPER_ARGUMENT_1 -ErrorAction SilentlyContinue
Remove-Item Env:PWRAGENT_JOB_WRAPPER_CWD -ErrorAction SilentlyContinue
Remove-Item Env:PWRAGENT_JOB_WRAPPER_READY_FILE -ErrorAction SilentlyContinue
Remove-Item Env:PWRAGENT_JOB_WRAPPER_STARTED_AT -ErrorAction SilentlyContinue
Remove-Item Env:PWRAGENT_JOB_WRAPPER_STARTUP_STATUS_FILE -ErrorAction SilentlyContinue

function Write-StartupPhase {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [string]$Detail = ''
  )
  try {
    $elapsedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startupStartedAt
    $encodedDetail = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Detail))
    [IO.File]::AppendAllText(
      $startupStatusFile,
      ([string]$elapsedMs + [char]9 + $Phase + [char]9 + $encodedDetail + [Environment]::NewLine))
  } catch {
    # Startup telemetry is best-effort and must never weaken Job ownership.
  }
}

Write-StartupPhase -Phase 'powershell-started'

$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PwrAgentWindowsJobRunner
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_FAILED = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags);

    private static void ThrowLastWin32Error(string operation)
    {
        throw new Win32Exception(
            Marshal.GetLastWin32Error(),
            operation + " failed");
    }

    private static void WriteStartupPhase(
        string startupStatusFile,
        long startupStartedAt,
        string phase)
    {
        try
        {
            long elapsedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startupStartedAt;
            File.AppendAllText(
                startupStatusFile,
                elapsedMs.ToString() + "\t" + phase + "\t" + Environment.NewLine);
        }
        catch
        {
            // Startup telemetry is best-effort and must never weaken Job ownership.
        }
    }

    private static void MakeInheritable(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
        {
            return;
        }
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
        {
            ThrowLastWin32Error("SetHandleInformation");
        }
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static uint ReadActiveProcessCount(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        uint returnLength;
        if (!QueryInformationJobObject(
            job,
            1,
            out accounting,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
            out returnLength))
        {
            ThrowLastWin32Error("QueryInformationJobObject");
        }
        return accounting.ActiveProcesses;
    }

    public static int Run(
        string application,
        string[] arguments,
        string workingDirectory,
        string readyFile,
        string startupStatusFile,
        long startupStartedAt)
    {
        WriteStartupPhase(startupStatusFile, startupStartedAt, "native-job-started");
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            ThrowLastWin32Error("CreateJobObject");
        }

        PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
        bool processCreated = false;
        try
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitsPointer = Marshal.AllocHGlobal(limitsSize);
            try
            {
                Marshal.StructureToPtr(limits, limitsPointer, false);
                if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    limitsPointer,
                    (uint)limitsSize))
                {
                    ThrowLastWin32Error("SetInformationJobObject");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(limitsPointer);
            }
            WriteStartupPhase(startupStatusFile, startupStartedAt, "job-configured");

            STARTUPINFO startupInfo = new STARTUPINFO();
            startupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startupInfo.dwFlags = STARTF_USESTDHANDLES;
            startupInfo.hStdInput = GetStdHandle(-10);
            startupInfo.hStdOutput = GetStdHandle(-11);
            startupInfo.hStdError = GetStdHandle(-12);
            MakeInheritable(startupInfo.hStdInput);
            MakeInheritable(startupInfo.hStdOutput);
            MakeInheritable(startupInfo.hStdError);

            StringBuilder commandLine = new StringBuilder(QuoteArgument(application));
            foreach (string argument in arguments)
            {
                commandLine.Append(' ');
                commandLine.Append(QuoteArgument(argument));
            }
            if (!CreateProcess(
                application,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                IntPtr.Zero,
                workingDirectory,
                ref startupInfo,
                out processInformation))
            {
                ThrowLastWin32Error("CreateProcess");
            }
            processCreated = true;
            WriteStartupPhase(
                startupStatusFile,
                startupStartedAt,
                "target-created-suspended");

            if (!AssignProcessToJobObject(job, processInformation.hProcess))
            {
                TerminateProcess(processInformation.hProcess, 127);
                ThrowLastWin32Error("AssignProcessToJobObject");
            }
            WriteStartupPhase(startupStatusFile, startupStartedAt, "target-assigned");
            if (ResumeThread(processInformation.hThread) == UInt32.MaxValue)
            {
                TerminateProcess(processInformation.hProcess, 127);
                ThrowLastWin32Error("ResumeThread");
            }
            WriteStartupPhase(startupStatusFile, startupStartedAt, "target-resumed");
            File.WriteAllText(readyFile, "ready");
            WriteStartupPhase(startupStatusFile, startupStartedAt, "ready");
            if (WaitForSingleObject(processInformation.hProcess, INFINITE) == WAIT_FAILED)
            {
                ThrowLastWin32Error("WaitForSingleObject");
            }
            while (ReadActiveProcessCount(job) > 0)
            {
                Thread.Sleep(10);
            }
            uint exitCode;
            if (!GetExitCodeProcess(processInformation.hProcess, out exitCode))
            {
                ThrowLastWin32Error("GetExitCodeProcess");
            }
            return unchecked((int)exitCode);
        }
        finally
        {
            if (processCreated)
            {
                CloseHandle(processInformation.hThread);
                CloseHandle(processInformation.hProcess);
            }
            CloseHandle(job);
        }
    }
}
'@

try {
  Write-StartupPhase -Phase 'helper-compile-started'
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  Write-StartupPhase -Phase 'helper-ready'
  $exitCode = [PwrAgentWindowsJobRunner]::Run(
    $application,
    [string[]]@($argument0, $argument1),
    $workingDirectory,
    $readyFile,
    $startupStatusFile,
    $startupStartedAt)
  if (Test-Path -LiteralPath $exitFile) {
    $reportedExitCode = 0
    if ([int]::TryParse(
      (Get-Content -Raw -LiteralPath $exitFile),
      [ref]$reportedExitCode)) {
      $exitCode = $reportedExitCode
    }
  }
  exit $exitCode
} catch {
  Write-StartupPhase -Phase 'failed' -Detail $_.Exception.Message
  [Console]::Error.WriteLine('PwrAgent Windows job wrapper failed: ' + $_.Exception.Message)
  exit 127
}
`;

export type WindowsJobWrappedCommand = {
  args: string[];
  cleanup: () => void;
  command: string;
  env: NodeJS.ProcessEnv;
  readyFilePath: string;
  startupStatusFilePath: string;
};

export type WindowsJobStartupPhase = {
  detail?: string;
  elapsedMs: number;
  phase: string;
};

export type WindowsJobStartupTelemetry = {
  phases: WindowsJobStartupPhase[];
};

export type WindowsJobReadyPoll = {
  cancel: () => void;
};

// Public Windows CI placed cold startup on both sides of the former 10-second
// edge while warm launches completed much sooner. Doubling that observed edge
// gives helper compilation bounded headroom without approaching the existing
// 30-second Windows test contract or weakening atomic Job ownership.
export const WINDOWS_JOB_READY_TIMEOUT_MS = 20_000;
const WINDOWS_JOB_READY_POLL_INTERVAL_MS = 25;

export function readWindowsJobStartupTelemetry(
  launch: Pick<WindowsJobWrappedCommand, "startupStatusFilePath">,
): WindowsJobStartupTelemetry {
  let content: string;
  try {
    content = readFileSync(launch.startupStatusFilePath, "utf8");
  } catch {
    return { phases: [] };
  }
  const phases: WindowsJobStartupPhase[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    const [elapsedValue, phase, encodedDetail = ""] = line.split("\t", 3);
    const elapsedMs = Number(elapsedValue);
    if (!phase || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
      continue;
    }
    let detail: string | undefined;
    if (encodedDetail) {
      try {
        detail = Buffer.from(encodedDetail, "base64").toString("utf8");
      } catch {
        // Ignore a partial final telemetry line while the wrapper is appending.
      }
    }
    phases.push({ detail, elapsedMs, phase });
  }
  return { phases };
}

export function formatWindowsJobStartupTelemetry(
  telemetry: WindowsJobStartupTelemetry,
): string {
  if (telemetry.phases.length === 0) {
    return "startup phases unavailable";
  }
  return telemetry.phases
    .map(({ detail, elapsedMs, phase }) =>
      `${phase}@${elapsedMs}ms${detail ? ` (${detail})` : ""}`,
    )
    .join(" -> ");
}

export function startWindowsJobReadyPoll(params: {
  launch: Pick<
    WindowsJobWrappedCommand,
    "readyFilePath" | "startupStatusFilePath"
  >;
  onReady: (telemetry: WindowsJobStartupTelemetry) => void;
  onTimeout: (telemetry: WindowsJobStartupTelemetry) => void;
  timeoutMs?: number;
}): WindowsJobReadyPoll {
  const timeoutMs = params.timeoutMs ?? WINDOWS_JOB_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  const cancel = () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const poll = () => {
    timer = undefined;
    if (cancelled) return;
    if (existsSync(params.launch.readyFilePath)) {
      cancelled = true;
      params.onReady(readWindowsJobStartupTelemetry(params.launch));
      return;
    }
    if (Date.now() >= deadline) {
      cancelled = true;
      params.onTimeout(readWindowsJobStartupTelemetry(params.launch));
      return;
    }
    timer = setTimeout(poll, WINDOWS_JOB_READY_POLL_INTERVAL_MS);
  };
  poll();
  return { cancel };
}

function encodeArgument(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function wrapCommandInWindowsJob(params: {
  args: [string, string];
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}): WindowsJobWrappedCommand {
  const stateDirectory = mkdtempSync(
    path.join(os.tmpdir(), "pwragent-windows-job-"),
  );
  const readyFilePath = path.join(stateDirectory, "ready");
  const exitFilePath = path.join(stateDirectory, "exit");
  const startupStatusFilePath = path.join(stateDirectory, "startup-status.tsv");
  const scriptPath = path.join(stateDirectory, "wrapper.ps1");
  const startupStartedAt = Date.now();
  writeFileSync(startupStatusFilePath, "0\twrapper-created\t\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(scriptPath, WINDOWS_JOB_WRAPPER_SCRIPT, {
    encoding: "utf8",
    mode: 0o600,
  });
  const systemRoot = Object.entries(params.env).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  const powershell = systemRoot
    ? path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
  // Git-for-Windows can hand execution between multiple MSYS processes. The
  // native process created above is therefore not always the process whose
  // exit code represents the shell script. Have every POSIX `-lc` invocation
  // report its own exact status for the wrapper to return.
  const argument1 =
    params.args[0] === "-lc"
      ? `${BASH_EXIT_TRAP}\n${params.args[1]}`
      : params.args[1];
  return {
    command: powershell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ],
    cleanup: () => {
      rmSync(stateDirectory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
    },
    env: {
      ...params.env,
      [EXECUTABLE_ENV]: params.command,
      [ARGUMENT_0_ENV]: encodeArgument(params.args[0]),
      [ARGUMENT_1_ENV]: encodeArgument(argument1),
      [WORKING_DIRECTORY_ENV]: params.cwd ?? process.cwd(),
      [READY_FILE_ENV]: readyFilePath,
      [EXIT_FILE_ENV]: exitFilePath,
      [STARTED_AT_ENV]: String(startupStartedAt),
      [STARTUP_STATUS_FILE_ENV]: startupStatusFilePath,
    },
    readyFilePath,
    startupStatusFilePath,
  };
}
