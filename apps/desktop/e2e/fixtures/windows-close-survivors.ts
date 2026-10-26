import { execFile, type ChildProcess } from "node:child_process";

/**
 * Names the processes that keep a Windows Electron close from completing.
 *
 * Playwright launches Electron through `cmd.exe` and resolves
 * `electronApp.close()` on that launcher's `close` event, which waits until
 * every holder of its stdio pipes is gone. Electron's Node children inherit
 * those pipes, so a child that outlives quit holds the close open. The
 * shutdown summary reports only that the close timed out. A snapshot runs on
 * that timeout path, before the force-kill, and records which processes were
 * still alive and how they relate to the launch.
 *
 * A fatal timeout is rare, but the same holder also delays the launcher's
 * `close` without failing the test. A healthy launcher closes within about
 * 50 ms of its `exit`, so a longer gap also takes a snapshot.
 */

export type WindowsProcessRow = {
  pid: number;
  parentPid: number;
  startedAt: number;
  name: string;
  commandLine: string;
};

export type WindowsCloseSurvivorRelation =
  | "launcher"
  | "main"
  | "descendant"
  | "orphan";

export type WindowsCloseSurvivor = {
  pid: number;
  parentPid: number;
  name: string;
  relation: WindowsCloseSurvivorRelation;
  /** Negative when the process started before the quit request. */
  startedAfterQuitMs: number;
  command: string;
};

export type WindowsCloseSurvivorReason =
  | "graceful-close-timeout"
  | "launcher-close-gap";

export type WindowsCloseSurvivorReport = {
  launchId: string;
  reason: WindowsCloseSurvivorReason;
  launcherAlive: boolean;
  mainAlive: boolean;
  snapshotAfterQuitMs: number;
  survivors: WindowsCloseSurvivor[];
  omittedSurvivors: number;
};

const PROCESS_START_TOLERANCE_MS = 2_000;
const MAX_REPORTED_SURVIVORS = 24;
const MAX_COMMAND_CHARS = 240;
const SNAPSHOT_TIMEOUT_MS = 5_000;
export const LAUNCHER_CLOSE_GAP_SNAPSHOT_MS = 1_000;

/**
 * Select the launch's processes from one whole-system snapshot.
 *
 * Ownership walks parent links from the launcher and the identified main
 * process. A child must be younger than its parent, so a recycled parent PID
 * cannot adopt an unrelated process. A process whose parent has exited loses
 * that link, so a row with no live parent that started during this launch is
 * reported separately as an orphan, together with its own descendants.
 * Playwright runs one worker, so one Electron tree exists at a time.
 */
export function selectWindowsCloseSurvivors(
  rows: WindowsProcessRow[],
  launch: {
    launcherPid?: number;
    mainProcess?: { pid: number; startedAt: number };
    quitStartedAt: number;
  },
): Array<WindowsProcessRow & { relation: WindowsCloseSurvivorRelation }> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const relations = new Map<number, WindowsCloseSurvivorRelation>();
  const launcher = launch.launcherPid === undefined
    ? undefined
    : byPid.get(launch.launcherPid);
  if (launcher && launcher.startedAt <= launch.quitStartedAt) {
    relations.set(launcher.pid, "launcher");
  }
  const main = launch.mainProcess
    ? byPid.get(launch.mainProcess.pid)
    : undefined;
  if (
    main
    && launch.mainProcess
    && Math.abs(main.startedAt - launch.mainProcess.startedAt)
      < PROCESS_START_TOLERANCE_MS
  ) {
    relations.set(main.pid, "main");
  }
  if (launch.mainProcess) {
    const launchStartedAt =
      launch.mainProcess.startedAt - PROCESS_START_TOLERANCE_MS;
    for (const row of rows) {
      if (relations.has(row.pid) || row.startedAt < launchStartedAt) {
        continue;
      }
      const parent = byPid.get(row.parentPid);
      if (!parent || parent.startedAt > row.startedAt) {
        relations.set(row.pid, "orphan");
      }
    }
  }
  let changed = relations.size > 0;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (relations.has(row.pid)) {
        continue;
      }
      const parent = byPid.get(row.parentPid);
      if (
        parent
        && relations.has(parent.pid)
        && parent.startedAt <= row.startedAt
      ) {
        relations.set(
          row.pid,
          relations.get(parent.pid) === "orphan" ? "orphan" : "descendant",
        );
        changed = true;
      }
    }
  }
  return rows
    .flatMap((row) => {
      const relation = relations.get(row.pid);
      return relation ? [{ ...row, relation }] : [];
    })
    .sort((left, right) => left.startedAt - right.startedAt);
}

/**
 * Keep enough of a command line to name the feature that started it.
 * Long opaque runs, such as encoded PowerShell commands, are redacted.
 */
export function summarizeWindowsCommandLine(commandLine: string): string {
  const redacted = commandLine
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "<redacted>");
  return redacted.length > MAX_COMMAND_CHARS
    ? `${redacted.slice(0, MAX_COMMAND_CHARS)}…`
    : redacted;
}

export function buildWindowsCloseSurvivorReport(params: {
  launchId: string;
  reason: WindowsCloseSurvivorReason;
  rows: WindowsProcessRow[];
  launcherPid?: number;
  mainProcess?: { pid: number; startedAt: number };
  quitStartedAt: number;
  snapshotAt: number;
}): WindowsCloseSurvivorReport {
  const selected = selectWindowsCloseSurvivors(params.rows, params);
  return {
    launchId: params.launchId,
    reason: params.reason,
    launcherAlive: selected.some((row) => row.relation === "launcher"),
    mainAlive: selected.some((row) => row.relation === "main"),
    snapshotAfterQuitMs: params.snapshotAt - params.quitStartedAt,
    survivors: selected.slice(0, MAX_REPORTED_SURVIVORS).map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      name: row.name,
      relation: row.relation,
      startedAfterQuitMs: row.startedAt - params.quitStartedAt,
      command: summarizeWindowsCommandLine(row.commandLine),
    })),
    omittedSurvivors: Math.max(0, selected.length - MAX_REPORTED_SURVIVORS),
  };
}

export function parseWindowsProcessSnapshot(stdout: string): WindowsProcessRow[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const [pid, parentPid, startedAt, name, command] = line.split("\t");
    const row = {
      pid: Number(pid),
      parentPid: Number(parentPid),
      startedAt: Number(startedAt),
      name: name ?? "",
      commandLine: Buffer.from(command ?? "", "base64").toString("utf8"),
    };
    return Number.isInteger(row.pid) && row.pid > 0
      && Number.isInteger(row.parentPid) && row.parentPid >= 0
      && Number.isFinite(row.startedAt)
      ? [row]
      : [];
  });
}

async function queryWindowsProcesses(): Promise<WindowsProcessRow[]> {
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process"
          + " -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine"
          + " | ForEach-Object {"
          + " $started = 0;"
          + " if ($_.CreationDate) { $started = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() };"
          + " $command = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine));"
          + ' "$($_.ProcessId)`t$($_.ParentProcessId)`t$started`t$($_.Name)`t$command" }',
      ],
      { timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (_error, output) => resolve(output ?? ""),
    );
  });
  return parseWindowsProcessSnapshot(stdout);
}

/**
 * Print the survivors of a timed-out Windows close. Reporting never throws:
 * the force-kill that follows must run whatever this observes.
 */
export async function reportWindowsCloseSurvivors(params: {
  launchId?: string;
  reason: WindowsCloseSurvivorReason;
  launcherPid?: number;
  mainProcess?: { pid: number; startedAt: number };
  quitStartedAt: number;
}): Promise<void> {
  try {
    const rows = await queryWindowsProcesses();
    const report = buildWindowsCloseSurvivorReport({
      ...params,
      launchId: params.launchId ?? "untracked",
      rows,
      snapshotAt: Date.now(),
    });
    console.log(`[pwragent-e2e-close-survivors] ${JSON.stringify(report)}`);
  } catch {
    // Diagnostics must not replace the close result with their own failure.
  }
}

/**
 * Snapshot once if the launcher exits but its pipes stay open past the gap.
 * `settled()` resolves after any snapshot it started has printed.
 */
export function watchWindowsLauncherCloseGap(
  launcher: ChildProcess,
  params: {
    launchId?: string;
    mainProcess?: { pid: number; startedAt: number };
    quitStartedAt: number;
  },
): { settled(): Promise<void> } {
  let report: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const onExit = () => {
    timer = setTimeout(() => {
      report = reportWindowsCloseSurvivors({
        ...params,
        reason: "launcher-close-gap",
        launcherPid: launcher.pid,
      });
    }, LAUNCHER_CLOSE_GAP_SNAPSHOT_MS);
  };
  const onClose = () => clearTimeout(timer);
  const stop = () => {
    clearTimeout(timer);
    launcher.removeListener("exit", onExit);
    launcher.removeListener("close", onClose);
  };
  launcher.once("exit", onExit);
  launcher.once("close", onClose);
  return {
    async settled() {
      stop();
      await report;
    },
  };
}
