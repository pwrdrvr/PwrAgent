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
  subscribers: Set<WebContents>;
  disposables: IDisposable[];
};

type NodePtyModule = typeof import("node-pty");

type IntegratedTerminalServiceOptions = {
  loadNodePty?: () => Promise<Pick<NodePtyModule, "spawn">>;
};

export class IntegratedTerminalService {
  private readonly logger = getMainLogger("pwragent:integrated-terminal");
  private readonly sessionsByThread = new Map<string, TerminalSession>();
  private readonly sessionsById = new Map<string, TerminalSession>();
  private readonly loadNodePty: () => Promise<Pick<NodePtyModule, "spawn">>;

  constructor(options: IntegratedTerminalServiceOptions = {}) {
    this.loadNodePty = options.loadNodePty ?? loadNodePty;
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
      this.subscribe(existing, webContents);
      return this.toCreateResponse(existing);
    }

    const settings = getDesktopSettingsService();
    const env = await settings.resolveTerminalSpawnEnvAsync();
    const cwd = resolveTerminalCwd(request.cwd);
    const shell = resolveTerminalShell({
      env,
      platform: process.platform,
      windowsShell: settings.resolveIntegratedTerminalWindowsShell(),
    });
    let ptyProcess: IPty;
    try {
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
        cwd,
        error: error instanceof Error ? error.message : String(error),
        shell: shell.file,
        threadKey,
      });
      throw new Error(message);
    }
    const session: TerminalSession = {
      sessionId: randomUUID(),
      threadKey,
      pty: ptyProcess,
      cwd,
      shell: shell.file,
      buffer: "",
      subscribers: new Set(),
      disposables: [],
    };
    this.sessionsByThread.set(threadKey, session);
    this.sessionsById.set(session.sessionId, session);
    this.subscribe(session, webContents);
    session.disposables.push(
      ptyProcess.onData((data) => this.handleOutput(session, data)),
      ptyProcess.onExit((event) =>
        this.handleExit(session, event.exitCode, event.signal),
      ),
    );
    this.logger.info("started", {
      cwd,
      pid: ptyProcess.pid,
      shell: shell.file,
      threadKey,
    });
    return this.toCreateResponse(session);
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
      (request.sessionId ? this.sessionsById.get(request.sessionId) : undefined)
      ?? (request.threadKey
        ? this.sessionsByThread.get(request.threadKey)
        : undefined);
    if (!session) return;
    this.killSession(session);
  }

  dispose(): void {
    for (const session of Array.from(this.sessionsById.values())) {
      this.killSession(session);
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

  private subscribe(session: TerminalSession, webContents: WebContents): void {
    if (webContents.isDestroyed()) {
      return;
    }
    if (session.subscribers.has(webContents)) {
      return;
    }
    session.subscribers.add(webContents);
    webContents.once("destroyed", () => {
      session.subscribers.delete(webContents);
    });
  }

  private handleOutput(session: TerminalSession, data: string): void {
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
    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    this.sessionsByThread.delete(session.threadKey);
    this.sessionsById.delete(session.sessionId);
    session.subscribers.clear();
  }

  private send(
    session: TerminalSession,
    channel: string,
    payload: unknown,
  ): void {
    for (const webContents of Array.from(session.subscribers)) {
      if (webContents.isDestroyed()) {
        session.subscribers.delete(webContents);
        continue;
      }
      webContents.send(channel, payload);
    }
  }
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
