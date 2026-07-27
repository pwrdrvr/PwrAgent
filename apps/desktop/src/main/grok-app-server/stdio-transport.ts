import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { app } from "electron";
import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import {
  resolveActiveProfileDir,
  resolveActiveProfileName,
  resolvePwragentRoot,
} from "../profile";
import { getMainLogger } from "../log";

const grokTransportLog = getMainLogger("pwragent:grok-transport");
const STDERR_LOG_MAX_LINES_PER_WINDOW = 100;
const STDERR_LOG_WINDOW_MS = 10_000;
const STDERR_LOG_MAX_LINE_LENGTH = 4000;
const PROFILE_STATE_ROOT_ENV = "PWRAGENT_GROK_PROFILE_STATE_ROOT";

export type GrokStdioJsonRpcTransportOptions = {
  apiKey?: string;
  resolveApiKey?: () => string | undefined;
  command?: string;
  args?: string[];
  entryPath?: string;
  env?: NodeJS.ProcessEnv;
  isAvailable?: () => boolean;
};

export class GrokStdioJsonRpcTransport implements JsonRpcTransport {
  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  private closeRequested = false;

  constructor(private readonly options: GrokStdioJsonRpcTransportOptions = {}) {}

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.childProcess) {
      return;
    }
    if (this.options.isAvailable && !this.options.isAvailable()) {
      throw new Error("grok app server unavailable: Grok backend is disabled");
    }

    this.closeRequested = false;
    const command = this.options.command?.trim() || process.execPath;
    const entryPath =
      this.options.entryPath?.trim() || resolveGrokAppServerEntryPath();
    const env = buildGrokAppServerEnv({
      baseEnv: this.options.env ?? process.env,
      apiKey:
        this.options.apiKey?.trim()
        || this.options.resolveApiKey?.()?.trim()
        || undefined,
    });
    grokTransportLog.info("launch app-server", {
      command,
      entryPath,
      packaged: app?.isPackaged === true,
    });

    const child = spawn(command, [...(this.options.args ?? []), entryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      throw new Error("grok app server stdio pipes unavailable");
    }
    this.childProcess = child;

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      this.messageHandler(line);
    });
    mirrorStderr(child);
    child.on("error", (error) => {
      if (this.childProcess === child) {
        this.childProcess = null;
      }
      this.closeHandler(error);
    });
    child.on("close", (code, signal) => {
      if (this.childProcess === child) {
        this.childProcess = null;
      }
      if (this.closeRequested || code === 0) {
        this.closeHandler();
        return;
      }
      this.closeHandler(
        new Error(
          `grok app server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    const child = this.childProcess;
    this.childProcess = null;
    if (!child) {
      return;
    }
    child.kill();
  }

  send(message: string): void {
    const child = this.childProcess;
    if (!child?.stdin) {
      throw new Error("grok app server stdio not connected");
    }
    child.stdin.write(`${message}\n`);
  }
}

export function resolveGrokAppServerEntryPath(): string {
  if (app?.isPackaged === true) {
    return path.join(app.getAppPath(), "out", "grok-app-server", "index.mjs");
  }

  const appPath = app?.getAppPath?.() ?? process.cwd();
  const candidates = [
    path.resolve(appPath, "..", "grok-app-server", "dist", "index.mjs"),
    path.resolve(process.cwd(), "apps", "grok-app-server", "dist", "index.mjs"),
  ];
  const entryPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!entryPath) {
    throw new Error(
      `grok app server entrypoint is missing; run pnpm --filter @pwragent/grok-app-server build`,
    );
  }
  return entryPath;
}

function buildGrokAppServerEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  apiKey?: string;
}): NodeJS.ProcessEnv {
  const profileName = resolveActiveProfileName({ env: params.baseEnv });
  const activeProfileDir = resolveActiveProfileDir({ env: params.baseEnv });
  const legacyStateRoot = path.join(
    resolvePwragentRoot({ env: params.baseEnv }),
    "grok-app-server",
  );
  const legacyThreadsRoot = path.join(legacyStateRoot, "threads");
  const profileStateRoot =
    profileName === "default" && fs.existsSync(legacyThreadsRoot)
      ? legacyStateRoot
      : path.join(activeProfileDir, "state", "grok-app-server");

  return {
    ...params.baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    [PROFILE_STATE_ROOT_ENV]: profileStateRoot,
    ...(params.apiKey ? { XAI_API_KEY: params.apiKey } : {}),
  };
}

function mirrorStderr(child: ChildProcessWithoutNullStreams): void {
  const stderrReader = readline.createInterface({ input: child.stderr });
  let windowStartedAt = Date.now();
  let linesThisWindow = 0;
  let suppressedThisWindow = 0;

  stderrReader.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const now = Date.now();
    if (now - windowStartedAt > STDERR_LOG_WINDOW_MS) {
      if (suppressedThisWindow > 0) {
        grokTransportLog.warn("app-server stderr rate-limited", {
          suppressedLines: suppressedThisWindow,
          windowMs: STDERR_LOG_WINDOW_MS,
        });
      }
      windowStartedAt = now;
      linesThisWindow = 0;
      suppressedThisWindow = 0;
    }
    linesThisWindow += 1;
    if (linesThisWindow > STDERR_LOG_MAX_LINES_PER_WINDOW) {
      suppressedThisWindow += 1;
      return;
    }
    grokTransportLog.info("app-server stderr", {
      line:
        trimmed.length > STDERR_LOG_MAX_LINE_LENGTH
          ? `${trimmed.slice(0, STDERR_LOG_MAX_LINE_LENGTH)}…[truncated]`
          : trimmed,
    });
  });
}
