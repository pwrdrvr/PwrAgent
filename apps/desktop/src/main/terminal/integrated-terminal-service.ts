import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { IPty, IDisposable } from "node-pty";
import type { DesktopIntegratedTerminalWindowsShell } from "@pwragent/shared";
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

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 18;
const MAX_COLUMNS = 500;
const MAX_ROWS = 200;
const OUTPUT_BUFFER_LIMIT = 128 * 1024;

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

export type IntegratedTerminalQuitSnapshot = {
  count: number;
  sessionIds: string[];
  threadKeys: string[];
};

type IntegratedTerminalServiceOptions = {
  loadNodePty?: () => Promise<Pick<NodePtyModule, "spawn">>;
  now?: () => number;
  onSessionsChanged?: (sessions: IntegratedTerminalSessionSummary[]) => void;
  platform?: NodeJS.Platform;
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
  /** Threads whose PTY is mid-spawn — the window in which a close has nothing
   *  to act on yet. */
  private readonly spawningThreadKeys = new Set<string>();
  /** Closes that arrived during that window, to be honored on spawn. */
  private readonly pendingCloseThreadKeys = new Set<string>();
  /** One `destroyed` listener per WebContents, not per session — 10 terminals
   *  in one window used to install 10 and trip Node's max-listeners warning. */
  private readonly subscribedWebContents = new Set<WebContents>();
  private disposing = false;

  constructor(options: IntegratedTerminalServiceOptions = {}) {
    this.loadNodePty = options.loadNodePty ?? loadNodePty;
    this.now = options.now ?? Date.now;
    this.onSessionsChanged = options.onSessionsChanged;
    this.platform = options.platform ?? process.platform;
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
      const settings = getDesktopSettingsService();
      const env = await settings.resolveTerminalSpawnEnvAsync();
      cwd = resolveTerminalCwd(request.cwd);
      shell = resolveTerminalShell({
        env,
        platform: this.platform,
        windowsShell: settings.resolveIntegratedTerminalWindowsShell(),
      });
      const nodePty = await this.loadNodePty();
      ptyProcess = nodePty.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols: clampInteger(request.cols, DEFAULT_COLUMNS, 2, MAX_COLUMNS),
        rows: clampInteger(request.rows, DEFAULT_ROWS, 2, MAX_ROWS),
        cwd,
        env: {
          ...env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      });
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

  dispose(): void {
    this.disposing = true;
    for (const session of Array.from(this.sessionsById.values())) {
      this.disposeSessionForShutdown(session);
    }
  }

  getQuitSnapshot(): IntegratedTerminalQuitSnapshot {
    const sessions = [...this.sessionsById.values()].filter((session) =>
      this.hasForegroundCommand(session),
    );
    return {
      count: sessions.length,
      sessionIds: sessions.map((session) => session.sessionId).sort(),
      threadKeys: sessions.map((session) => session.threadKey).sort(),
    };
  }

  private hasForegroundCommand(session: TerminalSession): boolean {
    // node-pty exposes the terminal's foreground process on macOS and Linux.
    // Other platforms return only the originally spawned process name, which
    // cannot distinguish an idle prompt from a running command. Keep the
    // existing conservative warning where the signal is unavailable.
    if (this.platform !== "darwin" && this.platform !== "linux") {
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

  private disposeSessionForShutdown(session: TerminalSession): void {
    this.deleteSession(session);
    try {
      session.pty.kill();
    } catch (error) {
      this.logger.warn("shutdown-kill-failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
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
