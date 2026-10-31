import { ChildProcess, execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { onTestFailed, onTestFinished } from "vitest";

type SpawnOptions = { args?: string[]; file?: string };
type SpawnableChildProcess = ChildProcess & {
  spawn(options: SpawnOptions): unknown;
};

/** Observe the real launch path, including calls from modules imported before
 * this test. Do not collect environment variables or subprocess output. */
export function traceUnbornWorkspace() {
  const startedAt = performance.now();
  const events: object[] = [];
  const active = new Map<number, object>();
  const prototype = ChildProcess.prototype as SpawnableChildProcess;
  const original = prototype.spawn;
  let phase = "mkdtemp";
  let root = "";
  let nextId = 0;
  const record = (event: string, detail: object = {}) => {
    events.push({ ms: Math.round(performance.now() - startedAt), phase, event, ...detail });
  };
  const system = () => ({
    cpu: os.cpus().map(({ times }) => times),
    processCpu: process.cpuUsage(),
    freeMemory: os.freemem(),
  });
  record("started", system());
  const redact = (value: string) => root ? value.split(root).join("<fixture>") : value;
  prototype.spawn = function tracedSpawn(this: SpawnableChildProcess, options: SpawnOptions) {
    const id = ++nextId;
    const file = path.basename(options.file ?? "");
    const command = {
      id,
      file,
      // Wrapper scripts can include source and environment lookups. Only Git
      // arguments are needed to identify this test's individual operations.
      args: /^git(?:\.exe)?$/i.test(file) ? options.args?.map(redact) : undefined,
    };
    record("spawn-request", command);
    try {
      const result = original.call(this, options);
      active.set(id, { ...command, pid: this.pid });
      this.once("spawn", () => record("spawn", { id, pid: this.pid }));
      this.once("error", (error) => record("error", { id, code: (error as NodeJS.ErrnoException).code }));
      this.once("exit", (code, signal) => record("exit", { id, code, signal }));
      this.once("close", (code, signal) => {
        record("close", { id, code, signal });
        active.delete(id);
      });
      for (const [name, stream] of [["stdout", this.stdout], ["stderr", this.stderr]] as const) {
        stream?.once("end", () => record(`${name}-end`, { id }));
        stream?.once("close", () => record(`${name}-close`, { id }));
      }
      return result;
    } catch (error) {
      record("spawn-threw", { id });
      throw error;
    }
  };
  let failed = false;
  onTestFailed(async () => {
    failed = true;
    record("test-failed", { active: [...active.values()], ...system() });
    if (process.platform === "win32") {
      // One snapshot after failure avoids adding a sampling process to the
      // measured body. Preserve parent identity without command lines.
      const script = [
        "$names = @('git.exe','bash.exe','sh.exe','node.exe','powershell.exe','pwsh.exe','conhost.exe')",
        "$rows = @(Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | Select-Object Name,ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime)",
        "$rows | ConvertTo-Json -Compress",
      ].join("; ");
      await new Promise<void>((resolve) => {
        execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
          timeout: 5_000,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        }, (error, stdout) => {
          record("windows-process-snapshot", {
            error: error ? String(error.code) : undefined,
            processes: error ? undefined : stdout.trim(),
          });
          resolve();
        });
      });
    }
  });
  onTestFinished(() => {
    prototype.spawn = original;
    record("test-finished", { active: [...active.values()], ...system() });
    if (failed || process.env.PWRAGENT_UNBORN_WORKSPACE_TRACE === "1") {
      console.error("unborn-workspace-trace", JSON.stringify({
        platform: process.platform,
        pid: process.pid,
        parallelism: os.availableParallelism(),
        freeMemory: os.freemem(),
        events,
      }));
    }
  });
  return {
    phase(next: string) {
      phase = next;
      record("phase");
    },
    setRoot(value: string) { root = value; },
  };
}
