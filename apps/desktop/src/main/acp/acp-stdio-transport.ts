import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  normalizeAcpLaunchDescriptor,
  type AcpLaunchDescriptor,
} from "./acp-launch-descriptor.js";
import type { AcpJsonRpcTransport } from "./acp-client.js";
import {
  createCommandInvocation,
  JsonRpcConnection,
  type JsonRpcId,
  type JsonRpcObserver,
  type JsonRpcTransport,
} from "@pwrdrvr/agent-transport";
import { buildPwrAgentChildProcessEnv } from "../child-process-env.js";
import { getMainLogger } from "../log.js";
import {
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
  requestTimeoutMs?: number;
  observer?: JsonRpcObserver;
  spawn?: AcpStdioSpawn;
  platform?: NodeJS.Platform;
};

function appendExecutableSearchPaths(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return env;
  }

  const pathKey = "PATH";
  const pathEntries = (env[pathKey] ?? "").split(":").filter(Boolean);
  const pathSet = new Set(pathEntries);
  for (const candidate of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${process.env.HOME ?? ""}/.local/bin`,
    `${process.env.HOME ?? ""}/bin`,
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

export class AcpStdioJsonRpcTransport implements AcpJsonRpcTransport {
  private readonly lineTransport: AcpLineStdioTransport;
  private readonly connection: JsonRpcConnection;
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

  constructor(options: AcpStdioJsonRpcTransportOptions) {
    this.lineTransport = new AcpLineStdioTransport({
      launchDescriptor: options.launchDescriptor,
      spawn: options.spawn,
      platform: options.platform,
    });
    this.connection = new JsonRpcConnection(
      this.lineTransport,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.observer,
      {
        logContext: { backend: options.launchDescriptor.backendId },
        logger: getMainLogger("pwragent:json-rpc"),
      },
    );
    this.connection.setNotificationHandler((method, params) => {
      const normalizedParams = asRecord(params) ?? {};
      for (const listener of this.notificationListeners) {
        listener(method, normalizedParams);
      }
    });
    this.connection.setRequestHandler(async (method, params, id) => {
      if (!this.requestHandler) {
        throw new Error(`ACP request handler unavailable for ${method}`);
      }
      return await this.requestHandler(method, asRecord(params) ?? {}, id);
    });
  }

  async connect(): Promise<void> {
    this.assertOpen();
    await this.connection.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connection.close();
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    this.assertOpen();
    await this.connection.connect();
    return await this.connection.request(method, params, timeoutMs);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.assertOpen();
    await this.connection.connect();
    await this.connection.notify(method, params);
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
  private closed = false;
  private closePromise?: Promise<void>;
  private lifecycleGeneration = 0;
  private stderrPreview = "";

  constructor(
    private readonly options: {
      launchDescriptor: AcpLaunchDescriptor;
      spawn?: AcpStdioSpawn;
      platform?: NodeJS.Platform;
    },
  ) {}

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("ACP stdio transport is closed");
    }
    if (this.childProcess) {
      return;
    }
    const generation = ++this.lifecycleGeneration;
    this.stderrPreview = "";

    const descriptor = normalizeAcpLaunchDescriptor(this.options.launchDescriptor);
    const env = buildPwrAgentChildProcessEnv(
      appendExecutableSearchPaths(
        buildPwrAgentChildProcessEnv(process.env, descriptor.env),
      ),
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

    if (this.closed || generation !== this.lifecycleGeneration) {
      await terminateOwnedProcessTree(child, {
        gracefulTimeoutMs: PROCESS_CLOSE_TIMEOUT_MS,
        forceTimeoutMs: PROCESS_FORCE_CLOSE_TIMEOUT_MS,
      });
      throw new Error("ACP stdio transport is closed");
    }

    this.childProcess = child;

    if (!child.stdin || !child.stdout || !child.stderr) {
      await terminateOwnedProcessTree(child, {
        gracefulTimeoutMs: PROCESS_CLOSE_TIMEOUT_MS,
        forceTimeoutMs: PROCESS_FORCE_CLOSE_TIMEOUT_MS,
      });
      if (this.childProcess === child) {
        this.childProcess = null;
      }
      throw new Error("ACP stdio pipes unavailable");
    }

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      this.messageHandler(line);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrPreview = appendStderrPreview(this.stderrPreview, String(chunk));
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
      if (this.closed || generation !== this.lifecycleGeneration) {
        this.closeHandler();
        return;
      }
      this.closeHandler(
        unexpectedAcpExitError({
          code: child.exitCode,
          descriptor,
          signal: child.signalCode,
          stderr: this.stderrPreview,
        }),
      );
    });
  }

  async close(): Promise<void> {
    this.closed = true;
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
    }).finally(() => {
      if (this.childProcess === child) {
        this.childProcess = null;
      }
      this.closePromise = undefined;
    });
    return await this.closePromise;
  }

  send(message: string): void {
    const child = this.childProcess;
    if (!child?.stdin) {
      throw new Error("ACP stdio transport not connected");
    }
    child.stdin.write(`${message}\n`);
  }
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
