import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * Windows pipe-holder probe.
 *
 * Windows Desktop E2E lanes intermittently pass every test and then fail
 * worker teardown in `registered-processes`: Playwright's Electron launcher
 * (`cmd.exe`, because `_electron.launch()` uses `shell: true` on win32) has
 * exited with code 0, but its stdio pipes never close, so the launcher's
 * `gracefullyClose` stays registered until the 30s worker teardown budget runs
 * out. The owning test's fixture close logged `gracefulCloseOutcome: "timeout"`
 * with `forceExitOutcome: "not-needed"`: `hasExited()` saw the exited launcher
 * and skipped the tree kill, while something else still held the pipes.
 *
 * The CI process-tree snapshot cannot name that holder: it walks descendants
 * from live tracked PIDs, and the chain breaks at the dead launcher. This probe
 * watches the launcher's whole descendant tree from before quit, keeps tracking
 * each descendant after its parent exits, and reports which ones outlive the
 * Electron main process, how long the launcher's `close` waits, and whether
 * killing the survivors releases it.
 *
 * - `control` launches spawn one main-process child just before quit. If the
 *   launcher's `close` waits for that child, Electron's children inherit the
 *   harness stdio handles, and any child that outlives quit reproduces the CI
 *   failure.
 * - `natural` launches quit at staggered delays after renderer readiness,
 *   overlapping the app's own startup background work.
 *
 * Results go to `test-results/windows-pipe-holder-probe/*.json` plus one
 * `[pipe-holder-probe]` line per launch. Command lines are truncated and
 * long tokens redacted; the results stay on the machine that ran the probe.
 *
 * Run from `apps/desktop` after `pnpm build` (PowerShell):
 *   $env:PWRAGENT_PIPE_HOLDER_PROBE = "1"
 *   pnpm exec playwright test -c playwright.inspect.config.ts `
 *     e2e/windows-pipe-holder.inspect.spec.ts --repeat-each 25 --retries 0
 */

const specDir = path.dirname(fileURLToPath(import.meta.url));
const PROBE_ENV = "PWRAGENT_PIPE_HOLDER_PROBE";
const NATURAL_QUIT_DELAYS_MS = [0, 250, 750, 1_500, 3_000];
const OBSERVE_AFTER_LAUNCHER_EXIT_MS = 20_000;
const CLOSE_AFTER_CLEANUP_TIMEOUT_MS = 5_000;
const SNAPSHOT_INTERVAL_MS = 100;
const CONTROL_CHILD_LIFETIME_SECONDS = 4;

test.skip(
  process.env[PROBE_ENV] !== "1",
  `Set ${PROBE_ENV}=1 to run the Windows pipe-holder probe.`,
);

type ProcessRow = {
  pid: number;
  ppid: number;
  started: string;
  name: string;
};

type TrackedProcess = ProcessRow & {
  key: string;
  commandLine?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  goneAt?: number;
};

type Snapshot = {
  at: number;
  rows: ProcessRow[];
  commandLines: Map<string, string>;
};

const WINDOWS_WATCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$seen = @{}
while ($true) {
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("S" + [char]9 + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine) {
    $started = 0
    if ($p.CreationDate) { $started = $p.CreationDate.ToUniversalTime().Ticks }
    $lines.Add("P" + [char]9 + $p.ProcessId + [char]9 + $p.ParentProcessId + [char]9 + $started + [char]9 + $p.Name)
    $key = [string]$p.ProcessId + ":" + $started
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      $command = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.CommandLine))
      $lines.Add("C" + [char]9 + $p.ProcessId + [char]9 + $started + [char]9 + $command)
    }
  }
  $lines.Add("E")
  [Console]::Out.Write(($lines -join [char]10) + [char]10)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${SNAPSHOT_INTERVAL_MS}
}
`;

/**
 * Streams whole-system process snapshots. Windows uses one long-lived
 * PowerShell so each snapshot costs a WMI query, not a host launch. POSIX
 * polls `ps`, which lets the probe logic be checked away from Windows.
 */
class ProcessWatcher {
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  start(): void {
    if (process.platform === "win32") {
      this.startWindows();
    } else {
      this.startPosix();
    }
  }

  async nextSnapshot(timeoutMs = 15_000): Promise<Snapshot> {
    return await new Promise<Snapshot>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`no process snapshot within ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (snapshot: Snapshot) => {
        clearTimeout(timeout);
        this.listeners.delete(listener);
        resolve(snapshot);
      };
      this.listeners.add(listener);
    });
  }

  /** The first snapshot whose query began at or after `time`. */
  async snapshotAfter(time: number): Promise<Snapshot> {
    for (;;) {
      const snapshot = await this.nextSnapshot();
      if (snapshot.at >= time) return snapshot;
    }
  }

  onSnapshot(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.child?.kill();
  }

  private emit(snapshot: Snapshot): void {
    for (const listener of [...this.listeners]) {
      listener(snapshot);
    }
  }

  private startWindows(): void {
    const encoded = Buffer.from(WINDOWS_WATCH_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    let buffered = "";
    let current: Snapshot | undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        const fields = line.split("\t");
        if (fields[0] === "S") {
          current = { at: Number(fields[1]), rows: [], commandLines: new Map() };
        } else if (fields[0] === "P" && current) {
          current.rows.push({
            pid: Number(fields[1]),
            ppid: Number(fields[2]),
            started: fields[3] ?? "0",
            name: fields.slice(4).join("\t"),
          });
        } else if (fields[0] === "C" && current) {
          current.commandLines.set(
            `${fields[1]}:${fields[2]}`,
            Buffer.from(fields[3] ?? "", "base64").toString("utf8"),
          );
        } else if (fields[0] === "E" && current) {
          this.emit(current);
          current = undefined;
        }
      }
    });
    child.stderr.resume();
  }

  private startPosix(): void {
    const poll = () => {
      const queryStartedAt = Date.now();
      execFile(
        "ps",
        ["-axo", "pid=,ppid=,lstart=,command="],
        { maxBuffer: 16 * 1024 * 1024 },
        (_error, stdout) => {
          if (this.stopped) return;
          const snapshot: Snapshot = { at: queryStartedAt, rows: [], commandLines: new Map() };
          for (const line of String(stdout ?? "").split("\n")) {
            // lstart is five fields, e.g. "Fri Sep 26 10:00:00 2026".
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
            if (!match) continue;
            const row = {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              started: String(Date.parse(match[3]!) || 0),
              name: path.basename((match[4] ?? "").split(" ")[0] ?? ""),
            };
            snapshot.rows.push(row);
            snapshot.commandLines.set(`${row.pid}:${row.started}`, match[4] ?? "");
          }
          this.emit(snapshot);
          this.timer = setTimeout(poll, SNAPSHOT_INTERVAL_MS);
        },
      );
    };
    poll();
  }
}

/**
 * Follows every descendant of the launcher across snapshots. A process stays
 * owned after its parent exits, which is exactly the orphan the CI snapshot
 * loses. A child must start no earlier than its parent, so a recycled PID
 * cannot adopt unrelated processes into the tree.
 */
class DescendantTracker {
  readonly processes = new Map<string, TrackedProcess>();
  private readonly ownedByPid = new Map<number, TrackedProcess>();

  constructor(private readonly rootPid: number) {}

  observe(snapshot: Snapshot): void {
    const present = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of snapshot.rows) {
        const key = `${row.pid}:${row.started}`;
        if (this.processes.has(key)) continue;
        const parent = this.ownedByPid.get(row.ppid);
        const isRoot = row.pid === this.rootPid && this.processes.size === 0;
        if (!isRoot && !(parent && compareStarted(row.started, parent.started) >= 0)) {
          continue;
        }
        const tracked: TrackedProcess = {
          ...row,
          key,
          commandLine: snapshot.commandLines.get(key),
          firstSeenAt: snapshot.at,
          lastSeenAt: snapshot.at,
        };
        this.processes.set(key, tracked);
        this.ownedByPid.set(row.pid, tracked);
        changed = true;
      }
    }
    for (const row of snapshot.rows) {
      const tracked = this.processes.get(`${row.pid}:${row.started}`);
      if (tracked) {
        tracked.lastSeenAt = snapshot.at;
        tracked.commandLine ??= snapshot.commandLines.get(tracked.key);
        present.add(tracked.key);
      }
    }
    for (const tracked of this.processes.values()) {
      if (tracked.goneAt === undefined && !present.has(tracked.key)) {
        tracked.goneAt = snapshot.at;
      }
    }
  }

  alive(): TrackedProcess[] {
    return [...this.processes.values()].filter((tracked) => tracked.goneAt === undefined);
  }

  ancestry(tracked: TrackedProcess): string[] {
    const chain: string[] = [];
    let current: TrackedProcess | undefined = tracked;
    const visited = new Set<string>();
    while (current && !visited.has(current.key)) {
      visited.add(current.key);
      chain.push(`${describeProcess(current)}#${current.pid}`);
      const parent = [...this.processes.values()].find(
        (candidate) => candidate.pid === current!.ppid
          && compareStarted(current!.started, candidate.started) >= 0,
      );
      current = parent;
    }
    return chain;
  }
}

function compareStarted(left: string, right: string): number {
  const a = BigInt(left || "0");
  const b = BigInt(right || "0");
  return a === b ? 0 : a > b ? 1 : -1;
}

function describeProcess(tracked: TrackedProcess): string {
  const commandLine = tracked.commandLine ?? "";
  const type = commandLine.match(/--type=([\w-]+)/)?.[1];
  if (type) return `${tracked.name}[${type}]`;
  if (/pwragent-windows-job-/i.test(commandLine)) {
    return `${tracked.name}[windows-job-wrapper]`;
  }
  return tracked.name;
}

function sanitizeCommandLine(commandLine: string | undefined): string | undefined {
  if (!commandLine) return undefined;
  return commandLine
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "<redacted>")
    .slice(0, 320);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function killTracked(tracked: TrackedProcess): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/pid", String(tracked.pid), "/T", "/F"],
        { timeout: 5_000, windowsHide: true },
        () => resolve(),
      );
    });
    return;
  }
  try {
    process.kill(tracked.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function probeLaunch(params: {
  mode: "control" | "natural";
  quitDelayMs: number;
}): Promise<void> {
  const watcher = new ProcessWatcher();
  watcher.start();
  // A cold PowerShell host has taken ~17s on hosted Windows runners.
  await watcher.nextSnapshot(45_000);

  const launchStartedAt = Date.now();
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
  });
  const launcher = app.electronApp.process();
  const launcherPid = launcher.pid;
  if (launcherPid === undefined) {
    throw new Error("Electron launcher has no pid");
  }
  let launcherExitAt: number | undefined = launcher.exitCode === null ? undefined : Date.now();
  let launcherCloseAt: number | undefined;
  launcher.once("exit", () => {
    launcherExitAt ??= Date.now();
  });
  launcher.once("close", () => {
    launcherCloseAt = Date.now();
  });

  const tracker = new DescendantTracker(launcherPid);
  const unsubscribe = watcher.onSnapshot((snapshot) => tracker.observe(snapshot));
  const mainPid = await app.electronApp.evaluate(() => process.pid);
  const readyAt = Date.now();

  if (params.mode === "control") {
    await app.electronApp.evaluate((_electron, lifetimeSeconds) => {
      const { spawn: spawnChild } = process.getBuiltinModule("node:child_process");
      const child = process.platform === "win32"
        ? spawnChild(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", `ping -n ${lifetimeSeconds + 1} 127.0.0.1 >NUL`],
          { stdio: "ignore", windowsHide: true },
        )
        : spawnChild("/bin/sleep", [String(lifetimeSeconds)], { stdio: "ignore" });
      child.unref();
    }, CONTROL_CHILD_LIFETIME_SECONDS);
  }
  await new Promise((resolve) => setTimeout(resolve, params.quitDelayMs));
  // Observe everything alive when quit starts. The snapshot must begin after
  // the control spawn: POSIX reparents an orphan before a later query sees it.
  tracker.observe(await watcher.snapshotAfter(Date.now()));

  const quitStartedAt = Date.now();
  let closeError: string | undefined;
  try {
    await app.close();
  } catch (error) {
    closeError = error instanceof Error ? error.message : String(error);
  }
  const fixtureCloseMs = Date.now() - quitStartedAt;

  await waitFor(() => launcherExitAt !== undefined, OBSERVE_AFTER_LAUNCHER_EXIT_MS);
  await waitFor(
    () => launcherCloseAt !== undefined,
    Math.max(0, (launcherExitAt ?? Date.now()) + OBSERVE_AFTER_LAUNCHER_EXIT_MS - Date.now()),
  );
  // Survivors are judged against a snapshot that began after the main exit.
  tracker.observe(await watcher.snapshotAfter(Date.now()));

  const mainProcess = [...tracker.processes.values()].find((tracked) => tracked.pid === mainPid);
  const mainGoneAt = mainProcess?.goneAt ?? launcherExitAt;
  const survivors = [...tracker.processes.values()].filter(
    (tracked) => tracked.pid !== launcherPid
      && tracked.pid !== mainPid
      && mainGoneAt !== undefined
      // Present in a snapshot that no longer has the main process.
      && tracked.lastSeenAt >= mainGoneAt,
  );
  const aliveAtDeadline = tracker.alive().filter(
    (tracked) => tracked.pid !== launcherPid && tracked.pid !== mainPid,
  );

  // Own the leftovers so the probe run itself can finish, and record whether
  // that is what releases the launcher's pipes.
  const closedBeforeCleanup = launcherCloseAt !== undefined;
  for (const tracked of aliveAtDeadline) {
    await killTracked(tracked);
  }
  const closedAfterCleanup = closedBeforeCleanup
    || await waitFor(() => launcherCloseAt !== undefined, CLOSE_AFTER_CLEANUP_TIMEOUT_MS);
  unsubscribe();
  watcher.stop();

  const info = test.info();
  const result = {
    mode: params.mode,
    quitDelayMs: params.quitDelayMs,
    repeatEachIndex: info.repeatEachIndex,
    platform: process.platform,
    launcher: { pid: launcherPid, name: path.basename(launcher.spawnfile) },
    mainPid,
    launchToReadyMs: readyAt - launchStartedAt,
    fixtureCloseMs,
    closeError,
    launcherExitAfterQuitMs: launcherExitAt === undefined ? null : launcherExitAt - quitStartedAt,
    launcherCloseAfterExitMs:
      launcherCloseAt === undefined || launcherExitAt === undefined
        ? null
        : launcherCloseAt - launcherExitAt,
    closedBeforeCleanup,
    closedAfterCleanup,
    survivors: survivors.map((tracked) => ({
      pid: tracked.pid,
      process: describeProcess(tracked),
      ancestry: tracker.ancestry(tracked),
      startedBeforeQuitMs: quitStartedAt - tracked.firstSeenAt,
      outlivedMainMs: mainGoneAt === undefined
        ? null
        : (tracked.goneAt ?? tracked.lastSeenAt) - mainGoneAt,
      aliveAtDeadline: tracked.goneAt === undefined,
      commandLine: sanitizeCommandLine(tracked.commandLine),
    })),
    trackedProcessCount: tracker.processes.size,
    trackedProcesses: [...tracker.processes.values()].slice(0, 80).map((tracked) => ({
      pid: tracked.pid,
      ppid: tracked.ppid,
      process: describeProcess(tracked),
      firstSeenBeforeQuitMs: quitStartedAt - tracked.firstSeenAt,
      goneAfterMainMs: tracked.goneAt === undefined || mainGoneAt === undefined
        ? null
        : tracked.goneAt - mainGoneAt,
    })),
  };
  const outputDir = path.join(specDir, "..", "test-results", "windows-pipe-holder-probe");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    path.join(
      outputDir,
      `${params.mode}-delay${params.quitDelayMs}-repeat${info.repeatEachIndex}-${Date.now()}.json`,
    ),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(`[pipe-holder-probe] ${JSON.stringify({
    mode: result.mode,
    quitDelayMs: result.quitDelayMs,
    launcherCloseAfterExitMs: result.launcherCloseAfterExitMs,
    closedBeforeCleanup,
    closedAfterCleanup,
    survivors: result.survivors.map((survivor) =>
      `${survivor.process}#${survivor.pid} +${survivor.outlivedMainMs}ms${survivor.aliveAtDeadline ? " (alive at deadline)" : ""}`),
  })}`);
}

test("control: a main-process child spawned before quit", async () => {
  test.setTimeout(120_000);
  await probeLaunch({ mode: "control", quitDelayMs: 0 });
});

for (const quitDelayMs of NATURAL_QUIT_DELAYS_MS) {
  test(`natural: quit ${quitDelayMs}ms after renderer readiness`, async () => {
    test.setTimeout(120_000);
    await probeLaunch({ mode: "natural", quitDelayMs });
  });
}
