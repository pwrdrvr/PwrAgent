using System;
using System.Globalization;
using System.IO;

public static partial class PwrAgentWindowsJobRunner
{
    private static string TakeSetting(string name)
    {
        string key = "PWRAGENT_JOB_WRAPPER_" + name;
        string value = Environment.GetEnvironmentVariable(key);
        Environment.SetEnvironmentVariable(key, null);
        return value;
    }

    public static int Main(string[] arguments)
    {
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
