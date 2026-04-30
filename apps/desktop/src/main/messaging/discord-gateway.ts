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

  constructor(
    private readonly options: {
      heartbeatIntervalMs?: number;
      onHeartbeatMiss?: () => void | Promise<void>;
      sendHeartbeat?: (sequence: number | undefined) => void | Promise<void>;
    } = {},
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.startHeartbeat();
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
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

  private startHeartbeat(): void {
    const intervalMs = this.options.heartbeatIntervalMs;
    if (!intervalMs) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.running) {
        return;
      }
      void this.options.sendHeartbeat?.(this.lastSequence);
    }, intervalMs);
  }
}
