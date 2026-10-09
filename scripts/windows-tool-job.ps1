# Tool descendants enter a KILL_ON_JOB_CLOSE Job before the first instruction.
# Arguments travel as base64 JSON, never interpolated PowerShell source.
$ErrorActionPreference = 'Stop'
$application = [string]$env:PWR_TOOLS_JOB_EXECUTABLE
$argumentsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PWR_TOOLS_JOB_ARGUMENTS))
$arguments = @((ConvertFrom-Json -InputObject $argumentsJson) | ForEach-Object { [string]$_ })
$workingDirectory = [string]$env:PWR_TOOLS_JOB_CWD
$cancelFile = [string]$env:PWR_TOOLS_JOB_CANCEL
$ownerPid = [uint32]$env:PWR_TOOLS_JOB_OWNER
'EXECUTABLE', 'ARGUMENTS', 'CWD', 'CANCEL', 'OWNER' | ForEach-Object {
  Remove-Item ('Env:PWR_TOOLS_JOB_' + $_) -ErrorAction SilentlyContinue
}
$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PwrToolsWindowsJobRunner
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint WAIT_TIMEOUT = 258;

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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    public static int Run(string application, string[] arguments, string workingDirectory,
                          string cancelFile, uint ownerPid)
    {
        // Keeping a native process handle also prevents PID reuse from reviving
        // ownership after the Node wrapper is killed.
        IntPtr owner = OpenProcess(0x00100000, false, ownerPid); // SYNCHRONIZE
        if (owner == IntPtr.Zero) return 130;
        IntPtr job = IntPtr.Zero;
        PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
        bool processCreated = false;
        try
        {
            if (WaitForSingleObject(owner, 0) != WAIT_TIMEOUT || File.Exists(cancelFile)) return 130;
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastWin32Error("CreateJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitsPointer = Marshal.AllocHGlobal(limitsSize);
            try
            {
                Marshal.StructureToPtr(limits, limitsPointer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsPointer, (uint)limitsSize))
                    ThrowLastWin32Error("SetInformationJobObject");
            }
            finally { Marshal.FreeHGlobal(limitsPointer); }

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
            foreach (string argument in arguments) commandLine.Append(' ').Append(QuoteArgument(argument));
            if (!CreateProcess(application, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                               CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, workingDirectory,
                               ref startupInfo, out processInformation)) ThrowLastWin32Error("CreateProcess");
            processCreated = true;
            if (!AssignProcessToJobObject(job, processInformation.hProcess))
            {
                TerminateProcess(processInformation.hProcess, 127);
                WaitForSingleObject(processInformation.hProcess, 0xFFFFFFFF);
                ThrowLastWin32Error("AssignProcessToJobObject");
            }
            if (ResumeThread(processInformation.hThread) == UInt32.MaxValue) ThrowLastWin32Error("ResumeThread");
            uint exitCode = 130;
            while (true)
            {
                uint ownerWait = WaitForSingleObject(owner, 0);
                if (ownerWait == WAIT_FAILED) ThrowLastWin32Error("WaitForSingleObject(owner)");
                if (ownerWait != WAIT_TIMEOUT || File.Exists(cancelFile))
                {
                    if (!TerminateJobObject(job, 130)) ThrowLastWin32Error("TerminateJobObject");
                    break;
                }
                uint bridgeWait = WaitForSingleObject(processInformation.hProcess, 50);
                if (bridgeWait == WAIT_FAILED) ThrowLastWin32Error("WaitForSingleObject(bridge)");
                if (bridgeWait != WAIT_TIMEOUT)
                {
                    // Unreferenced descendants can outlive the completed tool.
                    // Preserve its result before terminating their Job, then
                    // drain every member before the caller releases the lease.
                    if (!GetExitCodeProcess(processInformation.hProcess, out exitCode)) ThrowLastWin32Error("GetExitCodeProcess");
                    if (!TerminateJobObject(job, exitCode)) ThrowLastWin32Error("TerminateJobObject");
                    break;
                }
            }
            while (ReadActiveProcessCount(job) > 0) Thread.Sleep(50);
            return unchecked((int)exitCode);
        }
        finally
        {
            if (job != IntPtr.Zero)
            {
                // Even errors terminate and drain the entire Job before the
                // helper exits and the repository runner releases its lease.
                TerminateJobObject(job, 127);
                while (ReadActiveProcessCount(job) > 0) Thread.Sleep(50);
                CloseHandle(job);
            }
            if (processCreated)
            {
                CloseHandle(processInformation.hThread);
                CloseHandle(processInformation.hProcess);
            }
            CloseHandle(owner);
        }
    }
}
'@
try {
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  exit ([PwrToolsWindowsJobRunner]::Run($application, [string[]]$arguments, $workingDirectory, $cancelFile, $ownerPid))
} catch {
  [Console]::Error.WriteLine('Windows tool Job failed: ' + $_.Exception.Message)
  exit 127
}
