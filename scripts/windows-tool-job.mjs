import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function prepareWindowsToolJob(command, args, { env, cwd }) {
  const directory = mkdtempSync(path.join(tmpdir(), "pwr-tools-job-"));
  const cancelFile = path.join(directory, "cancel");
  const systemRoot = Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
  if (!systemRoot) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("SystemRoot is required to launch the native Windows tool Job");
  }
  const bridge = path.join(import.meta.dirname, "windows-tool-child.mjs");
  const task = Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
  return {
    command: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "windows-tool-job.ps1")],
    env: {
      ...env,
      PWR_TOOLS_JOB_EXECUTABLE: process.execPath,
      PWR_TOOLS_JOB_ARGUMENTS: Buffer.from(JSON.stringify([bridge, task]), "utf8").toString("base64"),
      PWR_TOOLS_JOB_CWD: cwd,
      PWR_TOOLS_JOB_CANCEL: cancelFile,
      PWR_TOOLS_JOB_OWNER: String(process.pid),
    },
    // Request cancellation rather than killing PowerShell: it terminates the
    // Job and confirms zero active members before returning to the queue.
    cancel: () => writeFileSync(cancelFile, "cancel", { mode: 0o600 }),
    cleanup: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
