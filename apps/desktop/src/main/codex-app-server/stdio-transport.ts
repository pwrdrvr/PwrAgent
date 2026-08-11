import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import readline from "node:readline";
import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import { getMainLogger } from "../log";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { createCommandInvocation } from "../command-invocation";
import { terminateOwnedProcessTree } from "../process-tree";
import {
  compareCodexCliVersions,
  resolveCodexCommand,
  type ResolvedCodexCommandCandidate,
} from "@pwrdrvr/codex-discovery";

const codexTransportLog = getMainLogger("pwragent:codex-transport");

// Codex app-server stderr is normally sparse — PwrAgent does not set
// RUST_LOG, so the app-server emits warnings/errors only — but guard
// against a pathological flood drowning the log file: mirror at most
// STDERR_LOG_MAX_LINES_PER_WINDOW lines per rolling window and summarize
// how many were dropped.
const STDERR_LOG_MAX_LINES_PER_WINDOW = 100;
const STDERR_LOG_WINDOW_MS = 10_000;
const STDERR_LOG_MAX_LINE_LENGTH = 4000;
const PROCESS_CLOSE_TIMEOUT_MS = 5_000;
const PROCESS_FORCE_CLOSE_TIMEOUT_MS = 5_000;

export type StdioJsonRpcTransportOptions = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  resolveArgs?: (env: NodeJS.ProcessEnv) => Promise<string[]> | string[];
  resolveCommand?: (params: {
    command: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<ResolvedCodexCommandCandidate>;
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
};

export { compareCodexCliVersions };

function isJsonRpcResponseEnvelope(message: string): boolean {
  try {
    const envelope = JSON.parse(message) as unknown;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      return false;
    }
    const record = envelope as Record<string, unknown>;
    return (
      record.id !== undefined &&
      typeof record.method !== "string" &&
      ("result" in record || "error" in record)
    );
  } catch {
    return false;
  }
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  private closeRequested = false;
  private closePromise?: Promise<void>;
  private connectPromise?: Promise<void>;
  private lifecycleGeneration = 0;
  private droppedSendAfterCloseLogged = false;

  constructor(private readonly options: StdioJsonRpcTransportOptions) {}

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
    if (this.connectPromise && !this.closeRequested) {
      return await this.connectPromise;
    }
    const generation = ++this.lifecycleGeneration;
    this.closeRequested = false;
    this.droppedSendAfterCloseLogged = false;

    const connectPromise = this.connectForGeneration(generation);
    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (this.closeRequested || generation !== this.lifecycleGeneration) {
      throw new Error("codex app server connection cancelled");
    }
  }

  private async connectForGeneration(generation: number): Promise<void> {
    const resolvedEnv = this.options.resolveEnv
      ? await this.options.resolveEnv()
      : this.options.env ?? process.env;
    this.assertCurrentGeneration(generation);
    const env = buildPwrAgentChildProcessEnv(resolvedEnv);
    const args = this.options.resolveArgs
      ? await this.options.resolveArgs(env)
      : this.options.args ?? [];
    this.assertCurrentGeneration(generation);
    const commandEnv = buildPwrAgentChildProcessEnv(env);
    const command = await (
      this.options.resolveCommand ?? resolveCodexCommand
    )({
      command: this.options.command,
      env: commandEnv,
    });
    this.assertCurrentGeneration(generation);
    const childEnv = buildPwrAgentChildProcessEnv(commandEnv);
    const invocation = createCommandInvocation({
      command: command.command,
      args: ["app-server", ...args],
      env: childEnv,
      platform: this.options.platform,
    });
    codexTransportLog.info("launch app-server", {
      command: command.command,
      source: command.source,
      version: command.version ?? null,
    });

    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    this.childProcess = child;

    if (!child.stdin || !child.stdout || !child.stderr) {
      await terminateOwnedProcessTree(child, {
        gracefulTimeoutMs: PROCESS_CLOSE_TIMEOUT_MS,
        forceTimeoutMs: PROCESS_FORCE_CLOSE_TIMEOUT_MS,
      });
      if (this.childProcess === child) {
        this.childProcess = null;
      }
      throw new Error("codex app server stdio pipes unavailable");
    }

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      this.messageHandler(line);
    });

    // Codex app-server diagnostics — transport fallbacks (e.g. dropping
    // from WebSocket to HTTPS), retries, and upstream errors — are written
    // to stderr, NOT the JSON-RPC stdout stream, so they never reach the
    // transcript or the `agentEvent` log. We used to discard stderr
    // entirely, which made those outages impossible to diagnose after the
    // fact. Line-buffer it and mirror each non-empty line into the
    // codex-transport log. Logged at info (captured without debug
    // collection) since severity isn't parseable from raw passthrough;
    // length-capped so a pathological line can't bloat the log file.
    const stderrReader = readline.createInterface({ input: child.stderr });
    let stderrWindowStartedAt = Date.now();
    let stderrLinesThisWindow = 0;
    let stderrSuppressedThisWindow = 0;
    stderrReader.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }
      const now = Date.now();
      if (now - stderrWindowStartedAt > STDERR_LOG_WINDOW_MS) {
        if (stderrSuppressedThisWindow > 0) {
          codexTransportLog.warn("app-server stderr rate-limited", {
            suppressedLines: stderrSuppressedThisWindow,
            windowMs: STDERR_LOG_WINDOW_MS,
          });
        }
        stderrWindowStartedAt = now;
        stderrLinesThisWindow = 0;
        stderrSuppressedThisWindow = 0;
      }
      stderrLinesThisWindow += 1;
      if (stderrLinesThisWindow > STDERR_LOG_MAX_LINES_PER_WINDOW) {
        stderrSuppressedThisWindow += 1;
        return;
      }
      codexTransportLog.info("app-server stderr", {
        line:
          trimmed.length > STDERR_LOG_MAX_LINE_LENGTH
            ? `${trimmed.slice(0, STDERR_LOG_MAX_LINE_LENGTH)}…[truncated]`
            : trimmed,
      });
    });
    child.on("error", (error: Error) => {
      if (this.childProcess === child && child.pid === undefined) {
        this.childProcess = null;
      }
      this.closeHandler(error);
    });
    child.on("close", () => {
      if (this.childProcess === child) {
        this.childProcess = null;
      }
      this.closeHandler();
    });
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    this.lifecycleGeneration += 1;
    if (this.closePromise) {
      return await this.closePromise;
    }
    const child = this.childProcess;
    if (!child) {
      return;
    }
    this.closePromise = terminateOwnedProcessTree(child, {
      gracefulTimeoutMs: PROCESS_CLOSE_TIMEOUT_MS,
      forceTimeoutMs: PROCESS_FORCE_CLOSE_TIMEOUT_MS,
    })
      .finally(() => {
        if (this.childProcess === child) {
          this.childProcess = null;
        }
        this.closePromise = undefined;
      });
    return await this.closePromise;
  }

  send(message: string): void {
    const child = this.childProcess;
    if (this.closeRequested) {
      if (isJsonRpcResponseEnvelope(message)) {
        if (!this.droppedSendAfterCloseLogged) {
          this.droppedSendAfterCloseLogged = true;
          codexTransportLog.info("dropped app-server send after close");
        }
        return;
      }
      throw new Error("codex app server stdio not connected");
    }
    if (!child?.stdin) {
      throw new Error("codex app server stdio not connected");
    }
    child.stdin.write(`${message}\n`);
  }
}
