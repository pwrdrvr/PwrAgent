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
  JsonRpcConnection,
  type JsonRpcId,
  type JsonRpcObserver,
  type JsonRpcTransport,
} from "../codex-app-server/json-rpc.js";
import { getMainLogger } from "../log.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

const acpTransportLog = getMainLogger("pwragent:acp-transport");

type AcpStdioChildProcess = {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
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
};

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

  constructor(options: AcpStdioJsonRpcTransportOptions) {
    this.lineTransport = new AcpLineStdioTransport({
      launchDescriptor: options.launchDescriptor,
      spawn: options.spawn,
    });
    this.connection = new JsonRpcConnection(
      this.lineTransport,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.observer,
      { logContext: { backend: options.launchDescriptor.backendId } },
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
    await this.connection.connect();
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    await this.connection.connect();
    return await this.connection.request(method, params, timeoutMs);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
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
}

class AcpLineStdioTransport implements JsonRpcTransport {
  private childProcess: AcpStdioChildProcess | null = null;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  constructor(
    private readonly options: {
      launchDescriptor: AcpLaunchDescriptor;
      spawn?: AcpStdioSpawn;
    },
  ) {}

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

    const descriptor = normalizeAcpLaunchDescriptor(this.options.launchDescriptor);
    const env = { ...process.env, ...descriptor.env };
    const spawnProcess = this.options.spawn ?? spawn;
    acpTransportLog.info("launch ACP agent", {
      backendId: descriptor.backendId,
      command: descriptor.command,
      distributionKind: descriptor.distributionKind,
      registryId: descriptor.registryId,
    });

    const child = spawnProcess(descriptor.command, descriptor.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: descriptor.cwd,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("ACP stdio pipes unavailable");
    }

    this.childProcess = child;

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      this.messageHandler(line);
    });

    child.stderr.on("data", () => undefined);
    child.on("error", (error: Error) => {
      this.closeHandler(error);
    });
    child.on("close", () => {
      this.childProcess = null;
      this.closeHandler();
    });
  }

  async close(): Promise<void> {
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
      throw new Error("ACP stdio transport not connected");
    }
    child.stdin.write(`${message}\n`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
