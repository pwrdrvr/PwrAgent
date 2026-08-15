import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildPwrAgentChildProcessEnv } from "./child-process-env";

export type OwnedChildProcess = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
};

export type ProcessTreeTerminationOptions = {
  gracefulTimeoutMs: number;
  forceTimeoutMs: number;
};

export type ProcessTreeWaitOptions = {
  knownPids?: Iterable<number>;
  pollIntervalMs?: number;
  rootPid?: number;
  timeoutMs?: number;
};

export function isProcessIdAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Snapshot a process and its current descendants. Call this before kill:
 * Windows reparents grandchildren (sleep.exe) after the PowerShell/Job
 * launcher dies, so later parent walks cannot find them.
 */
export function collectProcessTreeIds(rootPid: number): number[] {
  const tracked = new Set<number>();
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }
  tracked.add(rootPid);
  if (process.platform !== "win32") {
    return [...tracked];
  }

  let added = true;
  while (added) {
    added = false;
    for (const pid of [...tracked]) {
      if (!isProcessIdAlive(pid)) {
        continue;
      }
      for (const childPid of listWindowsChildProcessIds(pid)) {
        if (!tracked.has(childPid)) {
          tracked.add(childPid);
          added = true;
        }
      }
    }
  }
  return [...tracked];
}

/**
 * Wait until the root pid and every previously observed descendant are gone.
 * `taskkill /T /F` returning 0 is not enough: the Windows Job path
 * `child.kill`s the PowerShell launcher and directory handles can linger
 * until powershell/conhost/bash/sleep actually exit.
 */
export async function waitForProcessTreeGone(
  options: ProcessTreeWaitOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const tracked = new Set<number>(
    [...(options.knownPids ?? [])].filter(
      (pid) => Number.isInteger(pid) && pid > 0,
    ),
  );
  if (options.rootPid) {
    for (const pid of collectProcessTreeIds(options.rootPid)) {
      tracked.add(pid);
    }
  }

  const startedAt = Date.now();
  while (true) {
    for (const pid of [...tracked]) {
      if (isProcessIdAlive(pid)) {
        for (const childPid of collectProcessTreeIds(pid)) {
          tracked.add(childPid);
        }
      }
    }
    const alive = [...tracked].filter((pid) => isProcessIdAlive(pid));
    if (alive.length === 0) {
      return true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function isExited(child: OwnedChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isOwnedProcessTreeAlive(child: OwnedChildProcess): boolean {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  return !isExited(child);
}

function waitForExit(
  child: OwnedChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (isExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(exited);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(isExited(child)), timeoutMs);
    child.once("close", onClose);
    if (isExited(child)) {
      finish(true);
    }
  });
}

function waitForOwnedProcessTreeExit(
  child: OwnedChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (process.platform === "win32" || !child.pid) {
    return waitForExit(child, timeoutMs);
  }
  if (!isOwnedProcessTreeAlive(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(deadlineTimer);
      resolve(exited);
    };
    const pollTimer = setInterval(() => {
      if (!isOwnedProcessTreeAlive(child)) {
        finish(true);
      }
    }, Math.max(1, Math.min(25, timeoutMs)));
    const deadlineTimer = setTimeout(
      () => finish(!isOwnedProcessTreeAlive(child)),
      timeoutMs,
    );
  });
}

function resolveWindowsPowerShell(): string {
  const childEnv = buildPwrAgentChildProcessEnv(process.env);
  const systemRoot = Object.entries(childEnv).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  return systemRoot
    ? path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
}

function listWindowsChildProcessIds(pid: number): number[] {
  if (!Number.isInteger(pid) || pid <= 0) {
    return [];
  }
  const result = spawnSync(
    resolveWindowsPowerShell(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`,
    ],
    {
      encoding: "utf8",
      env: buildPwrAgentChildProcessEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((childPid) => Number.isInteger(childPid) && childPid > 0);
}

function terminateWindowsTree(
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  const childEnv = buildPwrAgentChildProcessEnv(process.env);
  const systemRoot = Object.entries(childEnv).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  const taskkill = systemRoot
    ? path.join(systemRoot, "System32", "taskkill.exe")
    : "taskkill";
  const args = ["/pid", String(pid), "/t"];
  if (signal === "SIGKILL") {
    args.push("/f");
  }
  return spawnSync(taskkill, args, {
    env: childEnv,
    stdio: "ignore",
  }).status === 0;
}

function signalProcessTree(
  child: OwnedChildProcess,
  signal: NodeJS.Signals,
): boolean {
  if (child.pid) {
    if (process.platform === "win32") {
      if (terminateWindowsTree(child.pid, signal)) {
        return true;
      }
    } else {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        // Fall back to the immediate child when the process group is already
        // gone or could not be addressed. This also keeps mocked children
        // useful in unit tests.
      }
    }
  }
  return child.kill(signal);
}

/**
 * Stop a child that PwrAgent launched as the leader of its own POSIX process
 * group (or a Windows process tree), wait for a graceful exit, then escalate.
 */
export async function terminateOwnedProcessTree(
  child: OwnedChildProcess,
  options: ProcessTreeTerminationOptions,
): Promise<void> {
  if (!isOwnedProcessTreeAlive(child)) {
    return;
  }
  let lastError: Error | undefined;
  const onError = (error: Error): void => {
    lastError = error;
  };
  child.on("error", onError);
  try {
    try {
      if (!signalProcessTree(child, "SIGTERM")) {
        lastError = new Error("child process tree did not accept SIGTERM");
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (await waitForOwnedProcessTreeExit(child, options.gracefulTimeoutMs)) {
      return;
    }
    try {
      if (!signalProcessTree(child, "SIGKILL")) {
        lastError = new Error("child process tree did not accept SIGKILL");
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (await waitForOwnedProcessTreeExit(child, options.forceTimeoutMs)) {
      return;
    }
    throw lastError ?? new Error("child process tree did not exit after SIGKILL");
  } finally {
    child.removeListener("error", onError);
  }
}
