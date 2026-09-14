import { execFile } from "node:child_process";
import { DESKTOP_MAIN_ENTRY } from "./electron-app";

/**
 * Terminate PwrAgent instances the wizard's profile graduation spawned.
 *
 * `openDesktopPwrAgentProfile` relaunches the app for the graduated profile
 * with `spawn(..., { detached: true })` and `child.unref()`. Detached is the
 * point — the bootstrap window quits and the new instance outlives it — but it
 * also puts that instance outside the process tree `launchElectronApp` reaps,
 * so nothing in the suite has ever shut one down. Every run of these two specs
 * leaves a real PwrAgent running against a temp home.
 *
 * On macOS and Linux that leak is invisible: the harness unlinks the home tree
 * out from under the still-open sqlite handles and the test passes. Windows
 * refuses to unlink an open file, so the same leak surfaces as
 * `EBUSY: resource busy or locked, unlink '...\state\state.db'` after every
 * assertion has already passed — a cleanup failure reported as a test failure.
 *
 * Matching is on the command line, which carries both this checkout's main
 * entry and the `--profile <name>` pair the relaunch appends, so it cannot
 * reach another checkout's instance or the operator's own app. It cannot reach
 * the Playwright-owned window either: that one is launched without `--profile`
 * (the harness selects a profile through the environment).
 *
 * Best-effort by construction. A process that already exited, a shell that is
 * unavailable, and a kill that is refused are all fine — the caller is on its
 * way to deleting the directory either way, and throwing here would replace one
 * cleanup-shaped failure with another.
 */
export async function killGraduatedProfileInstances(
  profile: string,
): Promise<void> {
  const pids = await listGraduatedProfilePids(profile);
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        await run("taskkill", ["/pid", String(pid), "/T", "/F"]);
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Already gone, or not ours to kill.
    }
  }
  if (pids.length > 0) {
    await waitForProfileInstancesToExit(profile);
  }
}

/**
 * Block until the killed instances are actually gone.
 *
 * Signalling a process is not the same as it having exited, and the caller's
 * very next act is to delete the directory those processes hold open. Windows
 * refuses to unlink an open file, so the gap between `taskkill` returning and
 * the last handle closing surfaced as an intermittent
 * `EBUSY: ... unlink '...\state\state.db-shm'` — every assertion already
 * passed, failing in cleanup.
 *
 * Polling the process table rather than sleeping a fixed interval: the wait is
 * as long as the exit actually takes and no longer, and a stuck process is
 * reported as the deadline expiring instead of being silently raced. Still
 * best-effort — the caller deletes either way, and throwing here would swap one
 * cleanup-shaped failure for another.
 */
async function waitForProfileInstancesToExit(profile: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // A read that FAILED must not end the wait. `readProcessTable` answers
    // `undefined` for "I could not look", which is the one state that is
    // otherwise indistinguishable from "nothing is running" — and taking the
    // empty list at face value would return straight into the `EBUSY: unlink`
    // this wait exists to prevent, now with the wait hiding it.
    const rows = await readProcessTable();
    if (rows && selectGraduatedProfilePids(rows, profile).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function listGraduatedProfilePids(profile: string): Promise<number[]> {
  // Best-effort for the kill path: a failed read there costs one skipped
  // signal, which the caller already tolerates. The WAIT uses
  // `selectGraduatedProfilePids` directly so it can tell a failed read apart.
  return selectGraduatedProfilePids(await readProcessTable() ?? [], profile);
}

function selectGraduatedProfilePids(
  rows: ReadonlyArray<{ pid: number; commandLine: string }>,
  profile: string,
): number[] {
  const pids: number[] = [];
  for (const { pid, commandLine } of rows) {
    if (pid === process.pid || !commandLine.includes(DESKTOP_MAIN_ENTRY)) {
      continue;
    }
    // `replaceProfileLaunchArgs` always appends the flag and its value as two
    // separate argv entries, so the rendered command line contains them in
    // that order with one separator between.
    if (!new RegExp(`--profile[\\s"']+${escapeRegExp(profile)}(\\s|"|'|$)`).test(commandLine)) {
      continue;
    }
    pids.push(pid);
  }
  return pids;
}

/** `undefined` means the table could not be read, never "nothing is running". */
async function readProcessTable(): Promise<
  Array<{ pid: number; commandLine: string }> | undefined
> {
  try {
    if (process.platform === "win32") {
      // CIM rather than `wmic`, which is deprecated and absent from newer
      // Windows images. `-Raw` keeps one record per line.
      const stdout = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process"
          + " | Where-Object { $_.CommandLine }"
          + " | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
      ]);
      return parseProcessTable(stdout, "\t");
    }
    const stdout = await run("ps", ["-axo", "pid=,command="]);
    return parseProcessTable(stdout, " ");
  } catch {
    return undefined;
  }
}

export function parseProcessTable(
  stdout: string,
  separator: string,
): Array<{ pid: number; commandLine: string }> {
  const rows: Array<{ pid: number; commandLine: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const index = trimmed.indexOf(separator);
    if (index <= 0) {
      continue;
    }
    const pid = Number(trimmed.slice(0, index));
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    rows.push({ pid, commandLine: trimmed.slice(index + separator.length).trim() });
  }
  return rows;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function run(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}
