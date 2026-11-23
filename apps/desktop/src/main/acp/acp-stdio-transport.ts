import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  normalizeAcpLaunchDescriptor,
  type AcpLaunchDescriptor,
} from "./acp-launch-descriptor.js";
import type { AcpJsonRpcTransport } from "./acp-client.js";
import {
  createCommandInvocation,
  readJsonRpcLines,
  JsonRpcConnection,
  type JsonRpcId,
  type JsonRpcObserver,
  type JsonRpcObserverEvent,
  type JsonRpcTransport,
} from "@pwrdrvr/agent-transport";
import { buildPwrAgentChildProcessEnv } from "../child-process-env.js";
import { prependBundledToolsToPath } from "../bundled-tools.js";
import { getMainLogger } from "../log.js";
import {
  isOwnedProcessTreeAlive,
  terminateOwnedProcessTree,
  type OwnedChildProcess,
} from "../process-tree.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const PROCESS_CLOSE_TIMEOUT_MS = 5_000;
const PROCESS_FORCE_CLOSE_TIMEOUT_MS = 5_000;
const STDERR_PREVIEW_LIMIT = 4_000;

const acpTransportLog = getMainLogger("pwragent:acp-transport");

type AcpStdioChildProcess = OwnedChildProcess & {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
};

export type AcpStdioSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => AcpStdioChildProcess;

export type AcpStdioJsonRpcTransportOptions = {
  launchDescriptor: AcpLaunchDescriptor;
  /** Replace the inherited environment for isolated runtime verification. */
  baseEnv?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  observer?: JsonRpcObserver;
  spawn?: AcpStdioSpawn;
  platform?: NodeJS.Platform;
  /** Test seam for the packaged or development bundled-tools directory. */
  bundledToolsDirectory?: string;
};

function appendExecutableSearchPaths(env: NodeJS.ProcessEnv, home: string | undefined): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return env;
  }

  const pathKey = "PATH";
  const pathEntries = (env[pathKey] ?? "").split(":").filter(Boolean);
  const pathSet = new Set(pathEntries);
  for (const candidate of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home ?? ""}/.local/bin`,
    `${home ?? ""}/bin`,
  ]) {
    if (candidate && !pathSet.has(candidate)) {
      pathEntries.push(candidate);
      pathSet.add(candidate);
    }
  }

  return {
    ...env,
    [pathKey]: pathEntries.join(":"),
  };
}

type AcpStdioConnection = {
  line: AcpLineStdioTransport;
  rpc: JsonRpcConnection;
  ready: Promise<void>;
};

export class AcpStdioJsonRpcTransport implements AcpJsonRpcTransport {
  private current?: AcpStdioConnection;
  private readonly notificationListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  private requestHandler:
    | ((
        method: string,
        params: Record<string, unknown>,
        id?: JsonRpcId,
      ) => Promise<unknown> | unknown)
    | undefined;
  private closed = false;
  private reconnect = true;

  constructor(private readonly options: AcpStdioJsonRpcTransportOptions) {}

  get disconnected(): boolean {
    return this.current?.line.stopped ?? false;
  }

  disableReconnect(): void {
    this.reconnect = false;
  }

  private startConnection(): AcpStdioConnection {
    const { options } = this;
    const line = new AcpLineStdioTransport(options);
    const observer = options.observer;
    // A response from an asynchronous agent request belongs to the child
    // that sent it, even if a replacement child has already connected.
    const rpc = new JsonRpcConnection(
      line,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      observer && { onMessage: (event) => line.observe(event) },
      {
        logContext: { backend: options.launchDescriptor.backendId },
        logger: getMainLogger("pwragent:json-rpc"),
      },
    );
    rpc.setNotificationHandler((method, params) => {
      if (line.stopped) return;
      const normalizedParams = asRecord(params) ?? {};
      for (const listener of this.notificationListeners) {
        listener(method, normalizedParams);
      }
    });
    rpc.setRequestHandler(async (method, params, id) => {
      line.assertOpen();
      if (!this.requestHandler) {
        throw new Error(`ACP request handler unavailable for ${method}`);
      }
      return await this.requestHandler(method, asRecord(params) ?? {}, id);
    });
    return { line, rpc, ready: Promise.resolve().then(() => rpc.connect()) };
  }

  private async connectToChild(): Promise<AcpStdioConnection> {
    this.assertOpen();
    while (this.current?.line.stopped) {
      const previous = this.current;
      if (!this.reconnect) previous.line.assertOpen();
      await previous.line.close();
      this.assertOpen();
      if (this.current === previous) this.current = undefined;
    }
    const child = this.current ??= this.startConnection();
    await child.ready;
    child.line.assertOpen();
    return child;
  }

  async connect(): Promise<void> {
    await this.connectToChild();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.current?.line.close();
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const { line, rpc } = await this.connectToChild();
    line.assertOpen();
    return await rpc.request(method, params, timeoutMs);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const { line } = await this.connectToChild();
    line.assertOpen();
    await line.notify(method, params);
  }

  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onRequest(
    listener: (
      method: string,
      params: Record<string, unknown>,
      id?: JsonRpcId,
    ) => Promise<unknown> | unknown,
  ): () => void {
    this.requestHandler = listener;
    return () => {
      if (this.requestHandler === listener) {
        this.requestHandler = undefined;
      }
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("ACP stdio transport is closed");
    }
  }
}

class AcpLineStdioTransport implements JsonRpcTransport {
  private childProcess: AcpStdioChildProcess | null = null;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  private failure?: Error;
  private closePromise?: Promise<void>;
  private stopReading?: () => void;
  private readonly outboundObservers = new Set<() => void>();
  private readonly notificationWrites = new Set<(error?: Error | null) => void>();

  constructor(private readonly options: AcpStdioJsonRpcTransportOptions) {}

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  get stopped(): boolean {
    return this.failure !== undefined;
  }

  assertOpen(): void {
    if (this.failure) throw this.failure;
  }

  async connect(): Promise<void> {
    this.assertOpen();
    try {
      this.launchChild();
    } catch (error) {
      this.disconnect(asError(error), true);
      await this.closePromise;
      throw error;
    }
    this.assertOpen();
  }

  private launchChild(): void {
    const descriptor = normalizeAcpLaunchDescriptor(this.options.launchDescriptor);
    const baseEnv = this.options.baseEnv ?? process.env;
    const env = prependBundledToolsToPath(
      buildPwrAgentChildProcessEnv(
        appendExecutableSearchPaths(
          buildPwrAgentChildProcessEnv(baseEnv, descriptor.env),
          baseEnv.HOME,
        ),
      ),
      {
        ...(this.options.bundledToolsDirectory
          ? { directory: this.options.bundledToolsDirectory }
          : {}),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
      },
    );
    const invocation = createCommandInvocation({
      command: descriptor.command,
      args: descriptor.args,
      env,
      platform: this.options.platform,
    });
    const spawnProcess = this.options.spawn ?? spawn;
    acpTransportLog.info("launch ACP agent", {
      backendId: descriptor.backendId,
      command: descriptor.command,
      distributionKind: descriptor.distributionKind,
      registryId: descriptor.registryId,
    });

    const child = spawnProcess(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: descriptor.cwd,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    this.childProcess = child;
    const { stdin, stdout, stderr } = child;
    const failPipe = (error: Error): void => this.disconnect(error, true);
    // Keep error listeners through teardown. Streams can emit independently
    // of the child process and even after its close event.
    stdin?.on("error", failPipe);
    stdout?.on("error", failPipe);
    stderr?.on("error", failPipe);
    child.on("error", (error) => this.disconnect(error, child.pid !== undefined));
    if (!stdin || !stdout || !stderr) {
      throw new Error("ACP stdio pipes unavailable");
    }
    if (this.stopped) return;

    stdin.on("close", () => {
      if (child.exitCode === null && child.signalCode === null) {
        failPipe(new Error("ACP stdio stdin closed"));
      }
    });
    this.stopReading = readJsonRpcLines(stdout, (line) => {
      if (!this.stopped) this.messageHandler(line);
    });
    let stderrPreview = "";
    stderr.on("data", (chunk: Buffer | string) => {
      stderrPreview = appendStderrPreview(stderrPreview, String(chunk));
    });
    child.on("close", () => {
      if (this.stopped) return;
      this.disconnect(
        unexpectedAcpExitError({
          code: child.exitCode,
          descriptor,
          signal: child.signalCode,
          stderr: stderrPreview,
        }),
        false,
      );
    });
  }

  async close(): Promise<void> {
    this.disconnect(new Error("json-rpc transport closed"), true);
    try {
      await this.closePromise;
    } catch (error) {
      // Retain a timed-out child until the same process-tree liveness check
      // used by termination confirms it has gone.
      if (this.childProcess && isOwnedProcessTreeAlive(this.childProcess)) throw error;
      this.childProcess = null;
      this.closePromise = undefined;
    }
  }

  async observe(event: JsonRpcObserverEvent): Promise<void> {
    const observer = this.options.observer;
    if (!observer || this.stopped) return;
    try {
      if (event.direction === "inbound") {
        await observer.onMessage(event);
        return;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      this.outboundObservers.add(resolve);
      try {
        await Promise.race([observer.onMessage(event), promise]);
      } finally {
        this.outboundObservers.delete(resolve);
      }
    } catch (error) {
      getMainLogger("pwragent:json-rpc").error("json-rpc observer failed", {
        backend: this.options.launchDescriptor.backendId,
        direction: event.direction,
        message: event.envelope.method ?? event.envelope.id ?? "message",
        error: asError(error).message,
      });
    }
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const envelope = { jsonrpc: "2.0", method, params: params ?? {} };
    const raw = JSON.stringify(envelope);
    await this.observe({ direction: "outbound", envelope, raw });
    this.assertOpen();
    // The kit's send method is synchronous. Notifications have no reply,
    // so their caller needs the write callback to know if delivery failed.
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const complete = (error?: Error | null): void => {
      if (!this.notificationWrites.delete(complete)) return;
      if (error) reject(error);
      else resolve();
    };
    this.notificationWrites.add(complete);
    this.send(raw, complete);
    await promise;
  }

  private disconnect(error: Error, reap: boolean): void {
    if (this.stopped) return;
    this.failure = error;
    this.stopReading?.();
    this.stopReading = undefined;
    for (const release of this.outboundObservers) release();
    for (const complete of this.notificationWrites) complete(error);
    // JsonRpcConnection awaits send before attaching to its reply promise.
    // Release paused sends and let them reach that await before rejecting them.
    const flush = new Promise<void>((resolve) => setImmediate(() => {
      this.closeHandler(error);
      resolve();
    }));
    const cleanup = Promise.resolve().then(async () => {
      const child = this.childProcess;
      if (reap && child) {
        await terminateOwnedProcessTree(child, {
          gracefulTimeoutMs: PROCESS_CLOSE_TIMEOUT_MS,
          forceTimeoutMs: PROCESS_FORCE_CLOSE_TIMEOUT_MS,
        });
      }
      this.childProcess = null;
    });
    this.closePromise = Promise.all([flush, cleanup]).then(() => undefined);
    void this.closePromise.catch((error: unknown) => {
      acpTransportLog.warn("failed to stop ACP agent", {
        backendId: this.options.launchDescriptor.backendId,
        error: asError(error).message,
      });
    });
  }

  send(message: string, onWrite?: (error?: Error | null) => void): void {
    if (this.stopped) return;
    const complete = (error?: Error | null): void => {
      if (error) this.disconnect(error, true);
      onWrite?.(error);
    };
    const stdin = this.childProcess?.stdin;
    if (!stdin?.writable) {
      complete(new Error("ACP stdio stdin is not writable"));
      return;
    }
    try {
      stdin.write(`${message}\n`, complete);
    } catch (error) {
      complete(asError(error));
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function appendStderrPreview(current: string, chunk: string): string {
  const combined = `${current}${chunk}`;
  return combined.length <= STDERR_PREVIEW_LIMIT
    ? combined
    : combined.slice(combined.length - STDERR_PREVIEW_LIMIT);
}

function unexpectedAcpExitError(params: {
  code: number | null;
  descriptor: AcpLaunchDescriptor;
  signal: NodeJS.Signals | null;
  stderr: string;
}): Error {
  const agent =
    params.descriptor.registryId === "kimi"
      ? "Kimi"
      : params.descriptor.registryId;
  const exit = params.signal
    ? `signal ${params.signal}`
    : `code ${params.code ?? "unknown"}`;
  const stderr = stripAnsiControlSequences(params.stderr).trim();
  return new Error(
    `${agent} ACP agent exited unexpectedly (${exit})${
      stderr ? `: ${stderr}` : "."
    }`,
  );
}

function stripAnsiControlSequences(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== "[") {
      output += value[index];
      continue;
    }

    index += 2;
    while (index < value.length) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        break;
      }
      index += 1;
    }
  }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
