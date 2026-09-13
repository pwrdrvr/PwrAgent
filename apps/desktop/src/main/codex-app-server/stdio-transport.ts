import path from "node:path";
import { resolveDefaultCodexHome } from "@pwrdrvr/codex-discovery";
import { codexAuthState, isCodexAuthenticationFailure } from "../codex-auth-state";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import readline from "node:readline";
import {
  createCommandInvocation,
  type JsonRpcTransport,
} from "@pwrdrvr/agent-transport";
import { getMainLogger } from "../log";
import { prependBundledToolsToPath } from "../bundled-tools";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { terminateOwnedProcessTree } from "../process-tree";
import {
  compareCodexCliVersions,
  resolveCodexCommand,
  type ResolvedCodexCommandCandidate,
} from "@pwrdrvr/codex-discovery";
import { resolveWindowsCodexLaunchCommand } from "../codex-windows-launch";

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
  authenticationRecovery?: boolean;
  onAuthenticationRejected?: (home: string) => void;

  args?: string[];
  env?: NodeJS.ProcessEnv;
  resolveArgs?: (env: NodeJS.ProcessEnv) => Promise<string[]> | string[];
  resolveCommand?: (params: {
    command: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<ResolvedCodexCommandCandidate>;
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
  /** Test seam for the Windows shim-sibling lookup. */
  commandExists?: (candidate: string) => boolean;
  /** Test seam for the packaged or development bundled-tools directory. */
  bundledToolsDirectory?: string;
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
  private codexHome?: string;
  private requestMethods = new Map<string | number, string>();
  private unsubscribeAuth?: () => void;
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
    this.codexHome = resolvedEnv.CODEX_HOME || resolveDefaultCodexHome();
    if (!this.options.authenticationRecovery) codexAuthState.assertAvailable(this.codexHome);
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = codexAuthState.subscribe((home) => {
      if (this.codexHome && path.resolve(this.codexHome) === home && codexAuthState.isBlocked(home)) {
        this.options.onAuthenticationRejected?.(this.codexHome);
      }
    });
    const env = prependBundledToolsToPath(
      buildPwrAgentChildProcessEnv(resolvedEnv),
      {
        ...(this.options.bundledToolsDirectory
          ? { directory: this.options.bundledToolsDirectory }
          : {}),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
      },
    );
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
    // A `.ps1` can still reach us from config or a stale cache, and routing a
    // long-lived stdio JSON-RPC server through PowerShell never completes the
    // `initialize` handshake. Swap it for the sibling Windows can start.
    const invocation = createCommandInvocation({
      command: resolveWindowsCodexLaunchCommand({
        command: command.command,
        ...(this.options.commandExists
          ? { exists: this.options.commandExists }
          : {}),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
      }),
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
      // Only error envelopes and error notifications are auth evidence;
      // transcript text and tool output must never invalidate a login.
      try {
        const message = JSON.parse(line);
        const requestMethod = message.method === undefined ? this.requestMethods.get(message.id) : undefined;
        if (message.method === undefined && message.id !== undefined) this.requestMethods.delete(message.id);
        const error = message.error
          ?? (message.method === "error" ? message.params : undefined)
          ?? (["turn/completed", "turn/failed"].includes(message.method) ? message.params?.turn?.error : undefined);
        const source = message.error ? requestMethod : message.method;
        // MCP OAuth errors describe that server's credentials, never Codex's.
        if (error && source && /^(?:account|model|thread|turn)\//.test(source)) {
          this.observeAuthenticationError(JSON.stringify(error), source.startsWith("account/"));
        } else if (error && source === "error" && message.params?.threadId) {
          this.observeAuthenticationError(JSON.stringify(error));
        }
      } catch { /* JSON-RPC owns malformed-message reporting. */ }
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
      // Only a diagnostic attributed to Codex's own auth/API modules is
      // credential evidence. Multiline JSON and MCP diagnostics have no such
      // provenance and may describe another OAuth account.
      const diagnostic = line.replace(/\u001b\[[0-9;]*m/g, "").trim()
        .match(/^(?:\S+\s+)?(?:ERROR|WARN)\s+(codex_login::auth(?:::[\w]+)*|codex_models_manager::[\w:]+|codex_api::[\w:]+):\s*(.*)$/);
      if (diagnostic) this.observeAuthenticationError(diagnostic[2], diagnostic[1].startsWith("codex_login::auth"));
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
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = undefined;
    this.closeRequested = true;
    this.requestMethods.clear();
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

  private observeAuthenticationError(message: string, credentialSource = false): void {
    // Generic OAuth codes alone are meaningful only at the Codex account/auth
    // boundary. A turn or model request can also report an MCP failure.
    if (!credentialSource) {
      if (/\bmcp\b|mcpServer|rmcp::/i.test(message)) return;
      message = message.replace(/invalid_refresh_token|refresh_token_(?:expired|reused|invalidated)/gi, "");
    }
    if (!this.closeRequested && this.codexHome && isCodexAuthenticationFailure(message)) {
      const alreadyBlocked = codexAuthState.isBlocked(this.codexHome);
      codexAuthState.reject(this.codexHome);
      // Recovery clients connect while the latch is already set. Their own
      // rejection must still stop verification; cached model data is not proof
      // that refreshed credentials work.
      if (alreadyBlocked) this.options.onAuthenticationRejected?.(this.codexHome);
    }
  }

  send(message: string): void {
    if (this.codexHome && !isJsonRpcResponseEnvelope(message)) {
      if (!this.options.authenticationRecovery) {
        codexAuthState.assertAvailable(this.codexHome);
      } else {
        const method = JSON.parse(message).method;
        if (!["initialize", "initialized", "account/read", "account/rateLimits/read"].includes(method)) {
          throw new Error("Only authentication verification is allowed during Codex recovery.");
        }
      }
    }
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
    const envelope = JSON.parse(message);
    if (envelope.id !== undefined && typeof envelope.method === "string") {
      // Timed-out requests may never receive a response. Eviction fails closed:
      // an uncorrelated response cannot invalidate profile authentication.
      if (this.requestMethods.size >= 1024) {
        this.requestMethods.delete(this.requestMethods.keys().next().value!);
      }
      this.requestMethods.set(envelope.id, envelope.method);
    }
    child.stdin.write(`${message}\n`);
  }
}
