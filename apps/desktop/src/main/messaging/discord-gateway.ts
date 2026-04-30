export type DiscordGatewayDispatch =
  | {
      d: DiscordMessageCreateDispatch;
      op: 0;
      s?: number;
      t: "MESSAGE_CREATE";
    }
  | {
      d: DiscordInteractionCreateDispatch;
      op: 0;
      s?: number;
      t: "INTERACTION_CREATE";
    };

export type DiscordGatewayEvent = DiscordGatewayDispatch;

export type DiscordUser = {
  bot?: boolean;
  discriminator?: string;
  global_name?: string | null;
  id: string;
  username: string;
};

export type DiscordMessageCreateDispatch = {
  attachments?: Array<{
    content_type?: string;
    filename: string;
    id: string;
    size?: number;
    url: string;
  }>;
  author: DiscordUser;
  channel_id: string;
  content?: string;
  guild_id?: string;
  id: string;
};

export type DiscordInteractionCreateDispatch = {
  channel_id: string;
  data?: {
    custom_id?: string;
  };
  guild_id?: string;
  id: string;
  member?: {
    nick?: string | null;
    user?: DiscordUser;
  };
  message?: {
    id: string;
  };
  token: string;
  type: number;
  user?: DiscordUser;
};

export type DiscordGatewayListener = (event: DiscordGatewayEvent) => void | Promise<void>;

type DiscordGatewayWebSocket = {
  close(code?: number, reason?: string): void;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  send(data: string): void;
};

type DiscordGatewayWebSocketFactory = (url: string) => DiscordGatewayWebSocket;

export type DiscordGatewayConnection = {
  close(): Promise<void>;
  onEvent(listener: DiscordGatewayListener): () => void;
  start(): Promise<void>;
};

export class DiscordGateway implements DiscordGatewayConnection {
  private listeners = new Set<DiscordGatewayListener>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lastSequence: number | undefined;
  private running = false;
  private socket?: DiscordGatewayWebSocket;

  constructor(
    private readonly options: {
      botToken?: string;
      gatewayUrl?: string;
      heartbeatIntervalMs?: number;
      onHeartbeatMiss?: () => void | Promise<void>;
      sendHeartbeat?: (sequence: number | undefined) => void | Promise<void>;
      websocketFactory?: DiscordGatewayWebSocketFactory;
    } = {},
  ) {}

  async start(): Promise<void> {
    this.running = true;
    if (this.options.botToken) {
      this.connect();
    } else {
      this.startHeartbeat(this.options.heartbeatIntervalMs);
    }
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.socket?.close(1000, "PwrAgnt shutdown");
    this.socket = undefined;
  }

  onEvent(listener: DiscordGatewayListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emitForTests(event: DiscordGatewayEvent): Promise<void> {
    this.lastSequence = event.s ?? this.lastSequence;
    await Promise.all([...this.listeners].map(async (listener) => listener(event)));
  }

  async notifyHeartbeatMissForTests(): Promise<void> {
    await this.options.onHeartbeatMiss?.();
  }

  private connect(): void {
    const socket = this.createWebSocket(
      this.options.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json",
    );
    this.socket = socket;
    socket.onmessage = (event) => {
      void this.handleGatewayPayload(event.data);
    };
    socket.onclose = () => {
      if (!this.running) {
        return;
      }
      void this.options.onHeartbeatMiss?.();
      setTimeout(() => {
        if (this.running) {
          this.connect();
        }
      }, 1000);
    };
    socket.onerror = () => {
      void this.options.onHeartbeatMiss?.();
    };
  }

  private async handleGatewayPayload(data: unknown): Promise<void> {
    const payload = parseGatewayPayload(data);
    if (!payload) {
      return;
    }

    this.lastSequence =
      typeof payload.s === "number" ? payload.s : this.lastSequence;
    if (payload.op === 10) {
      const hello = payload.d as { heartbeat_interval?: unknown } | undefined;
      const intervalMs =
        hello && typeof hello.heartbeat_interval === "number"
          ? hello.heartbeat_interval
          : this.options.heartbeatIntervalMs;
      this.startHeartbeat(intervalMs);
      this.identify();
      return;
    }

    if (payload.op === 0 && isDiscordGatewayEvent(payload)) {
      await this.emitForTests(payload);
      return;
    }

    if (payload.op === 7 || payload.op === 9) {
      this.socket?.close(4000, "Discord requested reconnect");
    }
  }

  private identify(): void {
    if (!this.options.botToken) {
      return;
    }

    this.socket?.send(
      JSON.stringify({
        d: {
          intents: 1 | 512 | 4096 | 32768,
          properties: {
            browser: "pwragnt",
            device: "pwragnt",
            os: process.platform,
          },
          token: this.options.botToken,
        },
        op: 2,
      }),
    );
  }

  private startHeartbeat(intervalMs: number | undefined): void {
    if (!intervalMs) {
      return;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.running) {
        return;
      }
      if (this.options.sendHeartbeat) {
        void this.options.sendHeartbeat(this.lastSequence);
        return;
      }
      this.socket?.send(
        JSON.stringify({
          d: this.lastSequence ?? null,
          op: 1,
        }),
      );
    }, intervalMs);
  }

  private createWebSocket(url: string): DiscordGatewayWebSocket {
    if (this.options.websocketFactory) {
      return this.options.websocketFactory(url);
    }

    const WebSocketConstructor = (
      globalThis as unknown as {
        WebSocket?: new (url: string) => DiscordGatewayWebSocket;
      }
    ).WebSocket;
    if (!WebSocketConstructor) {
      throw new Error("Discord Gateway requires a WebSocket implementation.");
    }

    return new WebSocketConstructor(url);
  }
}

function parseGatewayPayload(data: unknown): Record<string, unknown> | undefined {
  if (typeof data === "string") {
    return JSON.parse(data) as Record<string, unknown>;
  }
  if (data instanceof Buffer) {
    return JSON.parse(data.toString("utf8")) as Record<string, unknown>;
  }
  return undefined;
}

function isDiscordGatewayEvent(payload: Record<string, unknown>): payload is DiscordGatewayEvent {
  return (
    (payload.t === "MESSAGE_CREATE" || payload.t === "INTERACTION_CREATE") &&
    typeof payload.d === "object" &&
    payload.d !== null
  );
}
