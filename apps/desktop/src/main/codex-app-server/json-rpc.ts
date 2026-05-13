import { getMainLogger } from "../log";

export type JsonRpcId = string | number;

const jsonRpcLog = getMainLogger("pwragent:json-rpc");

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type JsonRpcNotificationHandler = (
  method: string,
  params: unknown
) => Promise<void> | void;

export type JsonRpcRequestHandler = (
  method: string,
  params: unknown,
  id?: JsonRpcId,
) => Promise<unknown>;

export interface JsonRpcTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: string): void;
  setMessageHandler(handler: (message: string) => void): void;
  setCloseHandler(handler: (error?: Error) => void): void;
}

export type JsonRpcObserverEvent = {
  direction: "inbound" | "outbound";
  raw: string;
  envelope: JsonRpcEnvelope;
  diagnostics?: JsonRpcObserverDiagnostics;
};

export type JsonRpcObserverDiagnostics = {
  callerReason?: string;
  ownerId?: string;
};

export interface JsonRpcObserver {
  onMessage(event: JsonRpcObserverEvent): void | Promise<void>;
}

type JsonRpcConnectionOptions = {
  logContext?: Record<string, string>;
};

function parseJsonRpcEnvelope(raw: string): JsonRpcEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

export class JsonRpcConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private notificationHandler: JsonRpcNotificationHandler = () => undefined;
  private requestHandler: JsonRpcRequestHandler = async () => ({});
  private connected = false;

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly requestTimeoutMs: number,
    private readonly observer?: JsonRpcObserver,
    private readonly options: JsonRpcConnectionOptions = {},
  ) {
    this.transport.setMessageHandler((message) => {
      void this.handleMessage(message);
    });
    this.transport.setCloseHandler((error) => {
      this.connected = false;
      this.flushPending(error ?? new Error("json-rpc transport closed"));
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.transport.connect();
    this.connected = true;
  }

  async close(): Promise<void> {
    this.flushPending(new Error("json-rpc transport closed"));
    this.connected = false;
    await this.transport.close();
  }

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.requestHandler = handler;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.sendEnvelope({
      jsonrpc: "2.0",
      method,
      params: params ?? {}
    });
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    diagnostics?: JsonRpcObserverDiagnostics,
  ): Promise<unknown> {
    const id = `rpc-${++this.requestCounter}`;
    const requestPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`json-rpc timeout: ${method}`));
      }, Math.max(100, timeoutMs ?? this.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
    });

    try {
      await this.sendEnvelope({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {}
      }, diagnostics);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }

    return await requestPromise;
  }

  private async handleMessage(rawMessage: string): Promise<void> {
    const envelope = parseJsonRpcEnvelope(rawMessage);
    if (!envelope) {
      return;
    }

    await this.notifyObserver({
      direction: "inbound",
      raw: rawMessage,
      envelope
    });

    if (
      envelope.id != null &&
      (Object.hasOwn(envelope, "result") || Object.hasOwn(envelope, "error"))
    ) {
      const key = String(envelope.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(key);

      if (envelope.error) {
        pending.reject(
          new Error(
            `json-rpc error (${envelope.error.code ?? "unknown"}): ${
              envelope.error.message ?? "unknown error"
            }`
          )
        );
        return;
      }

      pending.resolve(envelope.result);
      return;
    }

    const method = envelope.method?.trim();
    if (!method) {
      return;
    }

    if (envelope.id == null) {
      await this.notificationHandler(method, envelope.params);
      return;
    }

    try {
      const result = await this.requestHandler(method, envelope.params, envelope.id);
      await this.sendEnvelope({
        jsonrpc: "2.0",
        id: envelope.id,
        result: result ?? {}
      });
    } catch (error) {
      await this.sendEnvelope({
        jsonrpc: "2.0",
        id: envelope.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async sendEnvelope(
    envelope: JsonRpcEnvelope,
    diagnostics?: JsonRpcObserverDiagnostics,
  ): Promise<void> {
    const raw = JSON.stringify(envelope);
    await this.notifyObserver({
      direction: "outbound",
      raw,
      envelope,
      diagnostics,
    });
    this.transport.send(raw);
  }

  private async notifyObserver(event: JsonRpcObserverEvent): Promise<void> {
    if (!this.observer) {
      return;
    }

    try {
      await this.observer.onMessage(event);
    } catch (error) {
      jsonRpcLog.error("observer failed", {
        ...this.options.logContext,
        direction: event.direction,
        message: event.envelope.method ?? event.envelope.id ?? "message",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private flushPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
