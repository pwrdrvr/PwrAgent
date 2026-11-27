using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static partial class PwrAgentWindowsJobRunner
{
    private const uint DETACHED_PROCESS = 0x00000008;
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode,
        ExactSpelling = true, SetLastError = true)]
    private static extern bool CreateDetachedProcess(
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

    private static int LaunchDetachedProfile(string[] arguments)
    {
        if (arguments.Length < 2)
        {
            throw new ArgumentException("A detached profile launch requires an executable.");
        }
        string executable = arguments[1];
        string[] profileArguments = new string[arguments.Length - 2];
        Array.Copy(arguments, 2, profileArguments, 0, profileArguments.Length);
        STARTUPINFO startupInfo = new STARTUPINFO();
        startupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION processInformation;
        // Electron's libuv can pass auxiliary inheritable handles to this helper.
        // The replacement must receive none of them, even when it outlives the helper.
        if (!CreateDetachedProcess(executable, BuildCommandLine(executable, profileArguments),
            IntPtr.Zero, IntPtr.Zero, false, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            IntPtr.Zero, null, ref startupInfo, out processInformation))
        {
            ThrowLastWin32Error("CreateProcess for the detached profile");
        }
        CloseHandle(processInformation.hThread);
        CloseHandle(processInformation.hProcess);
        return 0;
    }

    private static string TakeSetting(string name)
    {
        string key = "PWRAGENT_JOB_WRAPPER_" + name;
        string value = Environment.GetEnvironmentVariable(key);
        Environment.SetEnvironmentVariable(key, null);
        return value;
    }

    public static int Main(string[] arguments)
    {
        // An existing Job invocation supplies its executable in the environment.
        // Its target arguments can begin with any value, including this switch.
        if (arguments.Length > 0 && arguments[0] == "--detached-profile"
            && Environment.GetEnvironmentVariable("PWRAGENT_JOB_WRAPPER_EXECUTABLE") == null)
        {
            try
            {
                return LaunchDetachedProfile(arguments);
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine("PwrAgent detached profile launcher failed: " + exception.Message);
                return 127;
            }
        }
        string status = null;
        long startedAt = 0;
        bool invokingJob = false;
        try
        {
            status = TakeSetting("STARTUP_STATUS_FILE");
            startedAt = Int64.Parse(TakeSetting("STARTED_AT"), CultureInfo.InvariantCulture);
            string executable = TakeSetting("EXECUTABLE");
            string cwd = TakeSetting("CWD");
            string ready = TakeSetting("READY_FILE");
            string stop = TakeSetting("STOP_FILE");
            bool terminate = TakeSetting("TERMINATE_DESCENDANTS") == "1";
            // Bash's handoff protocol retains the exit marker in the child environment.
            string exit = Environment.GetEnvironmentVariable("PWRAGENT_JOB_WRAPPER_EXIT_FILE");
            invokingJob = true;
            int code = Run(executable, arguments, cwd, ready, status, startedAt, terminate, stop);
            int reported;
            return File.Exists(exit) && Int32.TryParse(File.ReadAllText(exit), out reported) ? reported : code;
        }
        catch (Exception exception)
        {
            if (!invokingJob) WriteStartupPhase(status, startedAt, "target-not-created");
            WriteStartupPhase(status, startedAt, "failed");
            Console.Error.WriteLine("PwrAgent Windows Job launcher failed: " + exception.Message);
            return 127;
        }
    }
}
