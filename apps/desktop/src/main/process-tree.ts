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
