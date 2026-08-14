import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { IPty, IDisposable } from "node-pty";
import type {
  DesktopIntegratedTerminalWindowsShell,
  FederationRemoteTarget,
} from "@pwragent/shared";
import {
  INTEGRATED_TERMINAL_ERROR_CHANNEL,
  INTEGRATED_TERMINAL_EXIT_CHANNEL,
  INTEGRATED_TERMINAL_OUTPUT_CHANNEL,
} from "../../shared/ipc";
import type {
  IntegratedTerminalCloseRequest,
  IntegratedTerminalCreateRequest,
  IntegratedTerminalCreateResponse,
  IntegratedTerminalResizeRequest,
  IntegratedTerminalSessionSummary,
  IntegratedTerminalSetPanelHiddenRequest,
  IntegratedTerminalWriteRequest,
} from "../../shared/integrated-terminal";
import { getMainLogger } from "../log";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 18;
const MAX_COLUMNS = 500;
const MAX_ROWS = 200;
const OUTPUT_BUFFER_LIMIT = 128 * 1024;
const PTY_SHUTDOWN_FORCE_KILL_MS = 500;

type TerminalSession = {
  sessionId: string;
  threadKey: string;
  pty: IPty;
  cwd: string;
  shell: string;
  buffer: string;
  /** User collapsed the panel; the PTY keeps running. Owned here so the
   *  preference outlives any renderer remount. */
  panelHidden: boolean;
  createdAt: number;
  subscribers: Set<WebContents>;
  disposables: IDisposable[];
};

type NodePtyModule = typeof import("node-pty");

/**
 * node-pty's concrete terminals expose `destroy()` even though its public
 * `IPty` type omits the method. On Unix it closes the PTY master and then
 * sends SIGHUP once the master stream has closed; `kill()` only sends the
 * signal and leaves the master open.
 */
type DestroyablePty = IPty & {
  destroy?: () => void;
};

/**
 * One shell holding up the quit. The owning peer travels with the thread key
 * because a remote shell's thread does not exist in this instance's thread
 * list — resolving its name against that list yields the raw thread id, which
 * is exactly the uuid an operator sees in the quit dialog instead of the name
 * their own sidebar is already showing.
 */
export type IntegratedTerminalQuitThread = {
  threadKey: string;
  /** Absent for a shell running on this machine. */
  target?: FederationRemoteTarget;
  /** Peer display label, when the federation runtime could compose one. */
  instanceLabel?: string;
};

export type IntegratedTerminalQuitSnapshot = {
  count: number;
  sessionIds: string[];
  threads: IntegratedTerminalQuitThread[];
};

/**
 * Code-unit order, matching the plain `.sort()` these keys used before they
 * became objects. `localeCompare` would reorder around the `:` and `-` that
 * fill thread keys depending on the host locale, which is not something a
 * quit dialog's row order should depend on.
 */
export function byThreadKey(
  left: { threadKey: string },
  right: { threadKey: string },
): number {
  if (left.threadKey === right.threadKey) return 0;
  return left.threadKey < right.threadKey ? -1 : 1;
}

type IntegratedTerminalServiceOptions = {
  loadNodePty?: () => Promise<Pick<NodePtyModule, "spawn">>;
  now?: () => number;
  onSessionsChanged?: (sessions: IntegratedTerminalSessionSummary[]) => void;
  platform?: NodeJS.Platform;
  readLinuxProcessStat?: (pid: number) => string;
};

export class IntegratedTerminalService {
  private readonly logger = getMainLogger("pwragent:integrated-terminal");
  private readonly sessionsByThread = new Map<string, TerminalSession>();
  private readonly sessionsById = new Map<string, TerminalSession>();
  private readonly loadNodePty: () => Promise<Pick<NodePtyModule, "spawn">>;
  private readonly now: () => number;
  private readonly onSessionsChanged?: (
    sessions: IntegratedTerminalSessionSummary[],
  ) => void;
  private readonly platform: NodeJS.Platform;
  private readonly readLinuxProcessStat: (pid: number) => string;
  /** Threads whose PTY is mid-spawn — the window in which a close has nothing
   *  to act on yet. */
  private readonly spawningThreadKeys = new Set<string>();
  /** Closes that arrived during that window, to be honored on spawn. */
  private readonly pendingCloseThreadKeys = new Set<string>();
  /** One `destroyed` listener per WebContents, not per session — 10 terminals
   *  in one window used to install 10 and trip Node's max-listeners warning. */
  private readonly subscribedWebContents = new Set<WebContents>();
  private disposing = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: IntegratedTerminalServiceOptions = {}) {
    this.loadNodePty = options.loadNodePty ?? loadNodePty;
    this.now = options.now ?? Date.now;
    this.onSessionsChanged = options.onSessionsChanged;
    this.platform = options.platform ?? process.platform;
    this.readLinuxProcessStat =
      options.readLinuxProcessStat
      ?? ((pid) => readFileSync(`/proc/${pid}/stat`, "utf8"));
  }

  async createOrAttach(
    request: IntegratedTerminalCreateRequest,
    webContents: WebContents,
  ): Promise<IntegratedTerminalCreateResponse> {
    const threadKey = request.threadKey.trim();
    if (!threadKey) {
      throw new Error("A thread key is required to start a terminal.");
    }

    const existing = this.sessionsByThread.get(threadKey);
    if (existing) {
      // Deliberately does NOT touch `panelHidden`. The renderer mounts a pane
      // — and therefore attaches — for every live session, including collapsed
      // ones, so an attach is not evidence that the user wants to see it.
      // Un-hiding here made a collapsed terminal pop back open on every
      // remount. Showing a panel is an explicit act: `setPanelHidden(false)`.
      this.subscribe(existing, webContents);
      return this.toCreateResponse(existing);
    }

    this.spawningThreadKeys.add(threadKey);
    let ptyProcess: IPty;
    let cwd: string;
    let shell: { file: string; args: string[] };
    try {
      const spawned = await spawnTerminalPty({
        cwd: request.cwd,
        cols: request.cols,
        rows: request.rows,
        platform: this.platform,
        loadNodePty: this.loadNodePty,
      });
      ptyProcess = spawned.pty;
      cwd = spawned.cwd;
      shell = spawned.shell;
    } catch (error) {
      const message = terminalStartErrorMessage(error);
      this.logger.warn("start-failed", {
        error: error instanceof Error ? error.message : String(error),
        threadKey,
      });
      // The spawn died, so there is nothing left for a queued close to kill.
      // Leaving the key behind would shoot down the next terminal on this
      // thread.
      this.pendingCloseThreadKeys.delete(threadKey);
      throw new Error(message, { cause: error });
    } finally {
      this.spawningThreadKeys.delete(threadKey);
    }
    const session: TerminalSession = {
      sessionId: randomUUID(),
      threadKey,
      pty: ptyProcess,
      cwd,
      shell: shell.file,
      buffer: "",
      panelHidden: false,
      createdAt: this.now(),
      subscribers: new Set(),
      disposables: [],
    };
    this.sessionsByThread.set(threadKey, session);
    this.sessionsById.set(session.sessionId, session);
    this.subscribe(session, webContents);
    session.disposables.push(
      ptyProcess.onData((data) => this.handleOutput(session, data)),
      ptyProcess.onExit((event) => this.handleExit(session, event.exitCode, event.signal)),
    );
    this.logger.info("started", {
      cwd,
      pid: ptyProcess.pid,
      shell: shell.file,
      threadKey,
    });

    // Spawning is slow (login-shell env capture, then the node-pty load), and a
    // close issued in that window used to find nothing in `sessionsByThread`
    // and silently no-op — leaving a live shell the user had already dismissed,
    // which the renderer then re-adopted from the sessions broadcast. Honor the
    // close now that we finally have something to kill.
    if (this.pendingCloseThreadKeys.delete(threadKey)) {
      this.logger.info("closing-on-spawn", { threadKey });
      this.killSession(session);
      return this.toCreateResponse(session);
    }

    this.emitSessionsChanged();
    return this.toCreateResponse(session);
  }

  /** Every live PTY, oldest first. The renderer's only source of terminal truth. */
  listSessions(): IntegratedTerminalSessionSummary[] {
    return [...this.sessionsById.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((session) => this.toSummary(session));
  }

  setPanelHidden(request: IntegratedTerminalSetPanelHiddenRequest): void {
    const session = this.sessionsByThread.get(request.threadKey);
    if (!session || session.panelHidden === request.hidden) {
      return;
    }
    session.panelHidden = request.hidden;
    this.emitSessionsChanged();
  }

  /** Un-hide a live session's panel. Returns false when there is no session to
   *  reveal, so callers don't ask the renderer to show a shell that has exited. */
  revealSession(threadKey: string): boolean {
    if (!this.sessionsByThread.has(threadKey)) {
      return false;
    }
    this.setPanelHidden({ threadKey, hidden: false });
    return true;
  }

  write(request: IntegratedTerminalWriteRequest): void {
    this.sessionsById.get(request.sessionId)?.pty.write(request.data);
  }

  resize(request: IntegratedTerminalResizeRequest): void {
    const session = this.sessionsById.get(request.sessionId);
    if (!session) return;
    session.pty.resize(
      clampInteger(request.cols, DEFAULT_COLUMNS, 2, MAX_COLUMNS),
      clampInteger(request.rows, DEFAULT_ROWS, 2, MAX_ROWS),
    );
  }

  close(request: IntegratedTerminalCloseRequest): void {
    const session =
      (request.sessionId ? this.sessionsById.get(request.sessionId) : undefined) ??
      (request.threadKey ? this.sessionsByThread.get(request.threadKey) : undefined);
    if (session) {
      this.pendingCloseThreadKeys.delete(session.threadKey);
      this.killSession(session);
      return;
    }
    // Nothing to kill yet. If a spawn for this thread is still in flight, mark
    // it so `createOrAttach` kills the session the moment it exists — otherwise
    // the close is lost and the shell survives the user dismissing it. Gated on
    // an in-flight spawn so a close for an idle thread can't linger and shoot
    // down some unrelated terminal the user opens later.
    if (request.threadKey && this.spawningThreadKeys.has(request.threadKey)) {
      this.pendingCloseThreadKeys.add(request.threadKey);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposing = true;
    this.disposePromise = Promise.all(
      Array.from(this.sessionsById.values()).map((session) =>
        this.disposeSessionForShutdown(session),
      ),
    ).then(() => undefined);
    this.subscribedWebContents.clear();
    return this.disposePromise;
  }

  getQuitSnapshot(): IntegratedTerminalQuitSnapshot {
    const sessions = [...this.sessionsById.values()].filter((session) =>
      this.hasForegroundCommand(session),
    );
    return {
      count: sessions.length,
      sessionIds: sessions.map((session) => session.sessionId).sort(),
      threads: sessions
        .map((session) => ({ threadKey: session.threadKey }))
        .sort(byThreadKey),
    };
  }

  private hasForegroundCommand(session: TerminalSession): boolean {
    if (this.platform === "linux") {
      return this.hasLinuxForegroundCommand(session);
    }

    // node-pty exposes the terminal's foreground process on macOS. Other
    // platforms return only the originally spawned process name, which cannot
    // distinguish an idle prompt from a running command. Keep the existing
    // conservative warning where the signal is unavailable.
    if (this.platform !== "darwin") {
      return true;
    }

    try {
      const activeProcess = normalizeTerminalProcessName(session.pty.process);
      const shellProcess = normalizeTerminalProcessName(session.shell);
      return !activeProcess || !shellProcess || activeProcess !== shellProcess;
    } catch (error) {
      this.logger.warn("foreground-process-check-failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
      return true;
    }
  }

  private hasLinuxForegroundCommand(session: TerminalSession): boolean {
    try {
      const stat = this.readLinuxProcessStat(session.pty.pid);
      const closingParen = stat.lastIndexOf(")");
      const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
      // After pid and the parenthesized command name, Linux stat fields begin
      // at state (field 3); pgrp and tpgid are offsets 2 and 5 from there.
      const processGroupId = Number(fields[2]);
      const foregroundProcessGroupId = Number(fields[5]);
      if (
        closingParen < 0
        || !Number.isInteger(processGroupId)
        || processGroupId <= 0
        || !Number.isInteger(foregroundProcessGroupId)
        || foregroundProcessGroupId <= 0
      ) {
        throw new Error("Malformed Linux process stat");
      }
      return processGroupId !== foregroundProcessGroupId;
    } catch (error) {
      this.logger.warn("foreground-process-check-failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
      return true;
    }
  }

  private toCreateResponse(
    session: TerminalSession,
  ): IntegratedTerminalCreateResponse {
    return {
      sessionId: session.sessionId,
      threadKey: session.threadKey,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pty.pid,
      buffer: session.buffer || undefined,
    };
  }

  private toSummary(session: TerminalSession): IntegratedTerminalSessionSummary {
    return {
      sessionId: session.sessionId,
      threadKey: session.threadKey,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pty.pid,
      panelHidden: session.panelHidden,
      createdAt: session.createdAt,
    };
  }

  private emitSessionsChanged(): void {
    if (this.disposing) return;
    this.onSessionsChanged?.(this.listSessions());
  }

  private subscribe(session: TerminalSession, webContents: WebContents): void {
    if (webContents.isDestroyed()) {
      return;
    }
    if (session.subscribers.has(webContents)) {
      return;
    }
    session.subscribers.add(webContents);

    // One listener per WebContents, cleaning up across ALL sessions. Attaching
    // one per session put 10+ `destroyed` listeners on a single window (that is
    // exactly the load this feature is built for) and tripped Node's
    // max-listeners warning.
    if (!this.subscribedWebContents.has(webContents)) {
      this.subscribedWebContents.add(webContents);
      webContents.once("destroyed", () => {
        this.subscribedWebContents.delete(webContents);
        for (const candidate of this.sessionsById.values()) {
          candidate.subscribers.delete(webContents);
        }
      });
    }
  }

  private handleOutput(session: TerminalSession, data: string): void {
    if (this.disposing || this.sessionsById.get(session.sessionId) !== session) {
      return;
    }
    session.buffer = trimBufferedOutput(session.buffer + data);
    this.send(session, INTEGRATED_TERMINAL_OUTPUT_CHANNEL, {
      sessionId: session.sessionId,
      data,
    });
  }

  private handleExit(
    session: TerminalSession,
    exitCode: number | undefined,
    signal: number | undefined,
  ): void {
    if (this.disposing || this.sessionsById.get(session.sessionId) !== session) {
      return;
    }
    this.send(session, INTEGRATED_TERMINAL_EXIT_CHANNEL, {
      sessionId: session.sessionId,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
    });
    this.deleteSession(session);
  }

  private killSession(session: TerminalSession): void {
    try {
      session.pty.kill();
    } catch (error) {
      this.logger.warn("kill-failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
      this.send(session, INTEGRATED_TERMINAL_ERROR_CHANNEL, {
        sessionId: session.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.deleteSession(session);
    }
  }

  private deleteSession(session: TerminalSession): void {
    this.disposeSessionListeners(session);
    this.sessionsByThread.delete(session.threadKey);
    this.sessionsById.delete(session.sessionId);
    session.subscribers.clear();
    this.emitSessionsChanged();
  }

  private async disposeSessionForShutdown(
    session: TerminalSession,
  ): Promise<void> {
    // Keep a dedicated exit subscription outside `session.disposables`: the
    // renderer-facing listeners must be removed before teardown, but shutdown
    // itself cannot complete until node-pty reports that waitpid finished and
    // its master stream closed.
    let exitDisposable: IDisposable | undefined;
    const exited = new Promise<void>((resolve) => {
      exitDisposable = session.pty.onExit(() => resolve());
    });
    this.deleteSession(session);
    try {
      const destroy = (session.pty as DestroyablePty).destroy;
      if (destroy) {
        destroy.call(session.pty);
      } else {
        // Preserve compatibility with test doubles or a future node-pty
        // implementation that removes the concrete destroy method.
        session.pty.kill();
      }
    } catch (error) {
      this.logger.warn("shutdown-kill-failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
      exitDisposable?.dispose();
      throw error;
    }
    let forceKillTimer: NodeJS.Timeout | undefined;
    if (this.platform !== "win32") {
      forceKillTimer = setTimeout(() => {
        this.logger.warn("shutdown-force-kill", {
          graceMs: PTY_SHUTDOWN_FORCE_KILL_MS,
          sessionId: session.sessionId,
        });
        try {
          session.pty.kill("SIGKILL");
        } catch (error) {
          this.logger.warn("shutdown-force-kill-failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId: session.sessionId,
          });
        }
      }, PTY_SHUTDOWN_FORCE_KILL_MS);
    }
    try {
      await exited;
    } finally {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      exitDisposable?.dispose();
    }
  }

  private disposeSessionListeners(session: TerminalSession): void {
    for (const disposable of session.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch (error) {
        this.logger.warn("listener-dispose-failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: session.sessionId,
        });
      }
    }
  }

  private send(session: TerminalSession, channel: string, payload: unknown): void {
    for (const webContents of Array.from(session.subscribers)) {
      if (webContents.isDestroyed()) {
        session.subscribers.delete(webContents);
        continue;
      }
      webContents.send(channel, payload);
    }
  }
}

function normalizeTerminalProcessName(value: string): string {
  return path.basename(value.trim().replace(/^-+/, ""));
}

async function loadNodePty(): Promise<Pick<NodePtyModule, "spawn">> {
  return await import("node-pty");
}

export type SpawnedTerminalPty = {
  pty: IPty;
  cwd: string;
  shell: { file: string; args: string[] };
};

/**
 * The one PTY spawn core: settings-derived login environment, cwd validation
 * with a home-directory fallback, per-platform shell resolution, and clamped
 * dimensions. Shared by the local integrated-terminal service and the
 * federation remote-PTY service so a remote viewer's shell is spawned with
 * exactly the hardening and environment the local panel gets.
 */
export async function spawnTerminalPty(params: {
  cwd?: string;
  cols: number;
  rows: number;
  platform?: NodeJS.Platform;
  loadNodePty?: () => Promise<Pick<NodePtyModule, "spawn">>;
}): Promise<SpawnedTerminalPty> {
  const platform = params.platform ?? process.platform;
  const settings = getDesktopSettingsService();
  const env = await settings.resolveTerminalSpawnEnvAsync();
  const cwd = resolveTerminalCwd(params.cwd);
  const shell = resolveTerminalShell({
    env,
    platform,
    windowsShell: settings.resolveIntegratedTerminalWindowsShell(),
  });
  const nodePty = await (params.loadNodePty ?? loadNodePty)();
  const pty = nodePty.spawn(shell.file, shell.args, {
    name: "xterm-256color",
    cols: clampTerminalColumns(params.cols),
    rows: clampTerminalRows(params.rows),
    cwd,
    env: buildPwrAgentChildProcessEnv(env, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    }),
  });
  return { pty, cwd, shell };
}

export function clampTerminalColumns(value: number): number {
  return clampInteger(value, DEFAULT_COLUMNS, 2, MAX_COLUMNS);
}

export function clampTerminalRows(value: number): number {
  return clampInteger(value, DEFAULT_ROWS, 2, MAX_ROWS);
}

function terminalStartErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail
    ? `Terminal failed to start: ${detail}`
    : "Terminal failed to start.";
}

function resolveTerminalCwd(requestedCwd: string | undefined): string {
  const candidate = requestedCwd?.trim();
  if (candidate) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Fall through to the user home directory.
    }
  }
  return homedir();
}

export function resolveTerminalShell(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  windowsShell?: DesktopIntegratedTerminalWindowsShell;
}): {
  file: string;
  args: string[];
} {
  if (options.platform === "win32") {
    return resolveWindowsTerminalShell(
      options.env,
      options.windowsShell ?? "auto",
    );
  }
  return {
    file: resolvePosixTerminalShell(options.env, options.platform),
    args: ["-l"],
  };
}

function resolvePosixTerminalShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const configuredShell = env.SHELL?.trim();
  if (configuredShell) {
    return configuredShell;
  }

  const candidates =
    platform === "darwin"
      ? ["/bin/zsh", "/bin/bash", "/bin/sh"]
      : ["/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep scanning fallback shells.
    }
  }
  return "/bin/sh";
}

function resolveWindowsTerminalShell(
  env: NodeJS.ProcessEnv,
  preference: DesktopIntegratedTerminalWindowsShell,
): {
  file: string;
  args: string[];
} {
  if (preference === "pwsh") {
    return { file: "pwsh.exe", args: ["-NoLogo"] };
  }
  if (preference === "powershell") {
    return { file: "powershell.exe", args: ["-NoLogo"] };
  }
  if (preference === "cmd") {
    return { file: env.ComSpec || "cmd.exe", args: [] };
  }

  if (commandExistsOnPath("pwsh.exe", env, "win32")) {
    return { file: "pwsh.exe", args: ["-NoLogo"] };
  }
  if (commandExistsOnPath("powershell.exe", env, "win32")) {
    return { file: "powershell.exe", args: ["-NoLogo"] };
  }
  return { file: env.ComSpec || "cmd.exe", args: [] };
}

function commandExistsOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const pathValue = env.PATH || env.Path || env.path;
  if (!pathValue) return false;
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.trim();
    if (!directory) continue;
    try {
      const candidate = path.join(directory, command);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return true;
      }
    } catch {
      // Keep scanning PATH entries.
    }
  }
  return false;
}

function clampInteger(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function trimBufferedOutput(value: string): string {
  if (value.length <= OUTPUT_BUFFER_LIMIT) {
    return value;
  }
  return value.slice(value.length - OUTPUT_BUFFER_LIMIT);
}
