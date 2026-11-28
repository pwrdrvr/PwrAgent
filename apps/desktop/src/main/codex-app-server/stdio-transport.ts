import path from "node:path";
import { createResponseFlush } from "../util/response-flush";
import { resolveDefaultCodexHome } from "@pwrdrvr/codex-discovery";
import { codexAuthState, isCodexAuthenticationFailure } from "../codex-auth-state";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import {
  createCommandInvocation,
  readJsonRpcLines,
  type JsonRpcObserver,
  type JsonRpcObserverEvent,
  type JsonRpcTransport,
} from "@pwrdrvr/agent-transport";
import { getMainLogger } from "../log";
import { prependBundledToolsToPath } from "../bundled-tools";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { terminateOwnedProcessTree } from "../process-tree";
import {
  collectDescendants,
  readProcessTable,
  reapSurvivingDescendants,
  type ProcessTableReader,
} from "../process-descendants";
import {
  compareCodexCliVersions,
  resolveCodexCommand,
  type ResolvedCodexCommandCandidate,
} from "@pwrdrvr/codex-discovery";
import type { OwnedCodexProcess } from "../agent-tools/codex-agent-tool-ipc";
import { resolveWindowsCodexLaunchCommand } from "../codex-windows-launch";
import { readCodexExecutableIdentity, type CodexExecutableIdentity } from "./executable-identity";

const codexTransportLog = getMainLogger("pwragent:codex-transport");

// Codex app-server stderr is normally sparse — PwrAgent does not set
// RUST_LOG, so the app-server emits warnings/errors only — but guard
// against a pathological flood drowning the log file: mirror at most
// STDERR_LOG_MAX_LINES_PER_WINDOW lines per rolling window and summarize
// how many were dropped.
const STDERR_LOG_MAX_LINES_PER_WINDOW = 100;
const STDERR_LOG_WINDOW_MS = 10_000;
const STDERR_LOG_MAX_LINE_LENGTH = 4000;
// The last stderr lines are kept regardless of the rate limit above, so an
// unexpected exit can say what the server printed on its way down.
const STDERR_EXIT_PREVIEW_LINES = 20;
const STDERR_EXIT_PREVIEW_LINE_LENGTH = 500;
const PROCESS_CLOSE_TIMEOUT_MS = 5_000;
const PROCESS_FORCE_CLOSE_TIMEOUT_MS = 5_000;

export type CodexAppServerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The last stderr lines, oldest first. */
  stderrPreview: string[];
};

/** The running app-server process, for diagnostics and the idle recycle. */
export type CodexAppServerProcessInfo = {
  pid: number;
  startedAt: number;
  /** The file it was launched from, read just before the spawn. */
  executable?: CodexExecutableIdentity;
};

/** What the last `close()` found below the app server. */
export type CodexAppServerStopReport = {
  /** Descendants alive just before the stop. */
  descendants: number;
  /** Of those, how many outlived the process-group stop and were killed. */
  orphansReaped: number;
};

export type StdioJsonRpcTransportOptions = {
  command: string;
  authenticationRecovery?: boolean;
  onAuthenticationRejected?: (home: string) => void;
  /**
   * The app-server process ended without `close()` asking it to. Any turn it
   * was running ended with it, and no terminal notification will follow.
   */
  onUnexpectedExit?: (exit: CodexAppServerExit) => void;

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
  /** Test seam for the POSIX process table read around a stop. */
  readProcessTable?: ProcessTableReader;
  /** Test seam for signalling surviving descendants and the process group. */
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam for reading the launched executable's identity. */
  readExecutableIdentity?: (command: string, version?: string) => Promise<CodexExecutableIdentity>;
};

export { compareCodexCliVersions };

function isJsonRpcResponseEnvelope(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return false;
  }
  const record = envelope as Record<string, unknown>;
  return (
    record.id !== undefined &&
    typeof record.method !== "string" &&
    ("result" in record || "error" in record)
  );
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private readonly responseFlushes = new Map<string | number, ReturnType<typeof createResponseFlush>>();
  private codexHome?: string;
  private requestMethods = new Map<string | number | null, string>();
  private observesParsedEnvelopes = false;
  private unsubscribeAuth?: () => void;
  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private childStartedAt = 0;
  private childExecutable?: CodexExecutableIdentity;
  private lastStopReport?: CodexAppServerStopReport;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  private closeRequested = false;
  private closePromise?: Promise<void>;
  private connectPromise?: Promise<void>;
  private lifecycleGeneration = 0;
  private droppedSendAfterCloseLogged = false;

  constructor(private readonly options: StdioJsonRpcTransportOptions) {}

  wrapConnectionObserver(observer: JsonRpcObserver): JsonRpcObserver {
    this.observesParsedEnvelopes = true;
    return {
      onMessage: (event) => {
        if (event.direction === "inbound") this.observeInboundAuthentication(event.envelope);
        // Return the original observer's result without adding an await.
        return observer.onMessage(event);
      },
    };
  }

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  waitForResponseFlush(id: string | number): Promise<void> {
    const existing = this.responseFlushes.get(id);
    if (existing) return existing.promise;
    const flush = createResponseFlush();
    this.responseFlushes.set(id, flush);
    void flush.promise.finally(() => {
      if (this.responseFlushes.get(id) === flush) this.responseFlushes.delete(id);
    }).catch(() => undefined);
    return flush.promise;
  }

  private failResponseFlushes(): void {
    for (const flush of this.responseFlushes.values()) flush.finish(new Error("App server transport closed before acknowledgement."));
    this.responseFlushes.clear();
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
    // Read before the spawn: a later read could already see a replacement.
    const executable = await (this.options.readExecutableIdentity ?? readCodexExecutableIdentity)(
      command.command,
      command.version,
    ).catch(() => undefined);
    this.assertCurrentGeneration(generation);
    codexTransportLog.info("launch app-server", {
      command: command.command,
      source: command.source,
      version: command.version ?? null,
      ...(executable?.realPath && executable.realPath !== command.command
        ? { realPath: executable.realPath }
        : {}),
    });

    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    this.childProcess = child;
    this.childStartedAt = Date.now();
    this.childExecutable = executable;

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

    readJsonRpcLines(child.stdout, (line) => {
      if (!this.observesParsedEnvelopes) {
        // Standalone callers keep raw-line authentication without changing RPC dispatch timing.
        try {
          this.observeInboundAuthentication(JSON.parse(line));
        } catch { /* JSON-RPC owns malformed-message reporting. */ }
      }
      this.messageHandler(line);
    });

    // Codex app-server diagnostics — transport fallbacks (e.g. dropping
    // from WebSocket to HTTPS), retries, and upstream errors — are written
    // to stderr, NOT the JSON-RPC stdout stream, so they never reach the
    // transcript or the `agentEvent` log. We used to discard stderr
    // entirely, which made those outages impossible to diagnose after the
    // fact. Line-buffer it and mirror each non-empty line into the
    // codex-transport log. Strip terminal escapes and preserve ERROR/WARN
    // severity from Codex's tracing output; unclassified lines stay at info.
    // Length-cap so a pathological line can't bloat the log file.
    const stderrReader = readline.createInterface({ input: child.stderr });
    const stderrPreview: string[] = [];
    let stderrWindowStartedAt = Date.now();
    let stderrLinesThisWindow = 0;
    let stderrSuppressedThisWindow = 0;
    stderrReader.on("line", (line: string) => {
      const trimmed = stripVTControlCharacters(line).trim();
      // Only a diagnostic attributed to Codex's own auth/API modules is
      // credential evidence. Multiline JSON and MCP diagnostics have no such
      // provenance and may describe another OAuth account.
      const diagnostic = trimmed
        .match(/^(?:\S+\s+)?(?:ERROR|WARN)\s+(codex_login::auth(?:::[\w]+)*|codex_models_manager::[\w:]+|codex_api::[\w:]+):\s*(.*)$/);
      if (diagnostic) this.observeAuthenticationError(diagnostic[2], diagnostic[1].startsWith("codex_login::auth"));
      if (trimmed.length === 0) {
        return;
      }
      stderrPreview.push(
        trimmed.length > STDERR_EXIT_PREVIEW_LINE_LENGTH
          ? `${trimmed.slice(0, STDERR_EXIT_PREVIEW_LINE_LENGTH)}…[truncated]`
          : trimmed,
      );
      if (stderrPreview.length > STDERR_EXIT_PREVIEW_LINES) stderrPreview.shift();
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
      const details = {
        line:
          trimmed.length > STDERR_LOG_MAX_LINE_LENGTH
            ? `${trimmed.slice(0, STDERR_LOG_MAX_LINE_LENGTH)}…[truncated]`
            : trimmed,
      };
      const severity = trimmed.match(/^(?:\S+\s+)?(ERROR|WARN)\s+/)?.[1];
      if (severity === "ERROR") {
        codexTransportLog.error("app-server stderr", details);
      } else if (severity === "WARN") {
        codexTransportLog.warn("app-server stderr", details);
      } else {
        codexTransportLog.info("app-server stderr", details);
      }
    });
    child.on("error", (error: Error) => {
      if (this.childProcess === child && child.pid === undefined) {
        this.childProcess = null;
      }
      this.closeHandler(error);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.childProcess === child) {
        this.childProcess = null;
      }
      if (generation === this.lifecycleGeneration) this.failResponseFlushes();
      this.closeHandler();
      if (!this.closeRequested && generation === this.lifecycleGeneration) {
        const exit: CodexAppServerExit = {
          code: code ?? null,
          signal: signal ?? null,
          stderrPreview: [...stderrPreview],
        };
        codexTransportLog.warn("app-server exited unexpectedly", {
          pid: child.pid ?? null,
          code: exit.code,
          signal: exit.signal,
          stderrPreview: exit.stderrPreview.join("\n"),
        });
        this.stopOrphanedProcessGroup(child.pid);
        this.options.onUnexpectedExit?.(exit);
      }
    });
  }

  async close(): Promise<void> {
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = undefined;
    this.closeRequested = true;
    this.failResponseFlushes();
    this.requestMethods.clear();
    this.lifecycleGeneration += 1;
    if (this.closePromise) {
      return await this.closePromise;
    }
    const child = this.childProcess;
    if (!child) {
      return;
    }
    this.closePromise = this.stopChildProcessTree(child)
      .finally(() => {
        if (this.childProcess === child) {
          this.childProcess = null;
        }
        this.closePromise = undefined;
      });
    return await this.closePromise;
  }

  ownedProcess(): OwnedCodexProcess | undefined {
    const child = this.childProcess;
    if (!child?.pid) return undefined;
    return {
      child,
      isCurrent: () => !this.closeRequested && this.childProcess === child && child.exitCode === null && child.signalCode === null,
    };
  }

  /** The running app server, or `undefined` when none is running. */
  getProcessInfo(): CodexAppServerProcessInfo | undefined {
    const pid = this.childProcess?.pid;
    return pid
      ? {
        pid,
        startedAt: this.childStartedAt,
        ...(this.childExecutable ? { executable: this.childExecutable } : {}),
      }
      : undefined;
  }

  /** What the most recent `close()` found and reaped, once. */
  takeLastStopReport(): CodexAppServerStopReport | undefined {
    const report = this.lastStopReport;
    this.lastStopReport = undefined;
    return report;
  }

  /**
   * Stop the app server and everything it started. The process group signal
   * reaches every member at once and lets Codex stop its MCP servers itself.
   * A descendant that left the group (its own session, `npm exec` wrappers)
   * would outlive it, so the tree is read first and its survivors killed.
   */
  private async stopChildProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
    const pid = child.pid;
    const readTable = this.options.readProcessTable ?? readProcessTable;
    const descendants = pid && process.platform !== "win32"
      ? collectDescendants(await readTable().catch(() => undefined) ?? [], pid)
      : [];
    await terminateOwnedProcessTree(child, {
      gracefulTimeoutMs: PROCESS_CLOSE_TIMEOUT_MS,
      forceTimeoutMs: PROCESS_FORCE_CLOSE_TIMEOUT_MS,
    });
    const orphansReaped = await reapSurvivingDescendants(descendants, {
      readTable,
      ...(this.options.signalProcess ? { signal: this.options.signalProcess } : {}),
    }).catch((error) => {
      codexTransportLog.warn("app-server descendant cleanup failed", { error: String(error) });
      return 0;
    });
    this.lastStopReport = { descendants: descendants.length, orphansReaped };
    if (orphansReaped > 0) {
      codexTransportLog.warn("app-server descendants outlived its stop and were killed", {
        pid: pid ?? null,
        descendants: descendants.length,
        orphansReaped,
      });
    }
  }

  /**
   * An app server that died on its own leaves its children running. Those
   * still in its process group are found by the group id, which the OS keeps
   * reserved while any member lives, so the signal cannot reach a stranger.
   */
  private stopOrphanedProcessGroup(pid: number | undefined): void {
    if (!pid || process.platform === "win32") return;
    const signal = this.options.signalProcess ?? ((target, value) => process.kill(target, value));
    try {
      signal(-pid, "SIGTERM");
    } catch {
      // ESRCH: nothing in the group outlived the server.
      return;
    }
    codexTransportLog.info("stopping the exited app-server's process group", { pid });
    setTimeout(() => {
      try {
        signal(-pid, "SIGKILL");
      } catch {
        // The group stopped on SIGTERM.
      }
    }, PROCESS_CLOSE_TIMEOUT_MS).unref?.();
  }

  private observeInboundAuthentication(message: JsonRpcObserverEvent["envelope"]): void {
    // Only errors are auth evidence. Transcript text and tool output cannot invalidate a login.
    try {
      const { id, method, error: responseError } = message;
      const requestMethod = method === undefined && id !== undefined ? this.requestMethods.get(id) : undefined;
      if (method === undefined && id !== undefined) this.requestMethods.delete(id);
      const params = message.params as { threadId?: unknown; turn?: { error?: unknown } } | undefined;
      const error = responseError
        ?? (method === "error" ? params : undefined)
        ?? (method === "turn/completed" || method === "turn/failed" ? params?.turn?.error : undefined);
      const source = responseError ? requestMethod : method;
      // MCP OAuth errors describe that server's credentials.
      if (error && source && /^(?:account|model|thread|turn)\//.test(source)) {
        this.observeAuthenticationError(JSON.stringify(error), source.startsWith("account/"));
      } else if (error && source === "error" && params?.threadId) {
        this.observeAuthenticationError(JSON.stringify(error));
      }
    } catch { /* Auth inspection must not interrupt delivery. */ }
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
    let envelope;
    let parseFailure: { error: unknown } | undefined;
    if (this.codexHome || this.closeRequested || this.childProcess?.stdin) {
      try {
        envelope = JSON.parse(message);
      } catch (error) {
        // Preserve precedence: auth and pipe checks can take priority over malformed JSON.
        parseFailure = { error };
      }
    }
    const isResponse = isJsonRpcResponseEnvelope(envelope);
    if (this.codexHome && !isResponse) {
      if (!this.options.authenticationRecovery) {
        codexAuthState.assertAvailable(this.codexHome);
      } else {
        if (parseFailure) throw parseFailure.error;
        const method = envelope.method;
        if (!["initialize", "initialized", "account/read", "account/rateLimits/read"].includes(method)) {
          throw new Error("Only authentication verification is allowed during Codex recovery.");
        }
      }
    }
    const child = this.childProcess;
    if (this.closeRequested) {
      if (isResponse) {
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
    if (parseFailure) throw parseFailure.error;
    if (envelope.id !== undefined && typeof envelope.method === "string") {
      // Timed-out requests may never receive a response. Eviction fails closed:
      // an uncorrelated response cannot invalidate profile authentication.
      if (this.requestMethods.size >= 1024) {
        this.requestMethods.delete(this.requestMethods.keys().next().value!);
      }
      this.requestMethods.set(envelope.id, envelope.method);
    }
    const flush = envelope.method === undefined ? this.responseFlushes.get(envelope.id) : undefined;
    if (flush) {
      try {
        child.stdin.write(`${message}\n`, (error) => flush.finish(error ?? undefined));
      } catch (error) {
        flush.finish(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    } else {
      child.stdin.write(`${message}\n`);
    }
  }
}
