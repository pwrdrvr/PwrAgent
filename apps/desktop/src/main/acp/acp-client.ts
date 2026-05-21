import type {
  AcpBackendId,
  AppServerThreadReplay,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  AcpSessionReplayNormalizer,
  type AcpSessionUpdate,
} from "./acp-session-normalizer.js";
import type { AcpSessionMetadata, AcpSessionStore } from "./acp-session-store.js";

export type AcpJsonRpcTransport = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify?(method: string, params?: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
};

const ACP_PROTOCOL_VERSION = 1;

export type AcpAgentClientOptions = {
  backendId: AcpBackendId;
  store: AcpSessionStore;
  transport: AcpJsonRpcTransport;
  now?: () => number;
  onSessionUpdate?: (event: {
    sessionId: string;
    replay: AppServerThreadReplay;
    update: Record<string, unknown>;
  }) => Promise<void> | void;
  onPromptError?: (event: {
    sessionId: string;
    turnId: string;
    error: unknown;
  }) => Promise<void> | void;
};

export class AcpAgentClient {
  private readonly normalizers = new Map<string, AcpSessionReplayNormalizer>();
  private readonly now: () => number;
  private unsubscribe?: () => void;

  constructor(private readonly options: AcpAgentClientOptions) {
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    this.unsubscribe = this.options.transport.onNotification((method, params) => {
      if (method === "session/update") {
        this.applySessionUpdate(params);
      }
    });
    await this.options.transport.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        auth: {
          terminal: false,
        },
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
      clientInfo: {
        name: "pwragent",
        title: "PwrAgent",
        version: "0.0.0",
      },
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.options.transport.close?.();
  }

  async startSession(params: {
    cwd?: string;
    executionMode: ThreadExecutionMode;
    title?: string;
  }): Promise<AcpSessionMetadata> {
    const cwd = params.cwd ?? process.cwd();
    const result = await this.options.transport.request("session/new", {
      cwd,
      mcpServers: [],
    });
    const record = asRecord(result);
    const sessionId =
      typeof record?.sessionId === "string"
        ? record.sessionId
        : typeof record?.session_id === "string"
          ? record.session_id
          : undefined;
    if (!sessionId) {
      throw new Error("ACP session/new did not return a session id");
    }

    const now = this.now();
    const metadata: AcpSessionMetadata = {
      backendId: this.options.backendId,
      sessionId,
      title: params.title ?? "ACP session",
      cwd,
      createdAt: now,
      updatedAt: now,
      executionMode: params.executionMode,
      status: "idle",
    };
    this.options.store.upsertSession(metadata);
    return metadata;
  }

  async prompt(params: {
    sessionId: string;
    prompt: string;
  }): Promise<{ sessionId: string; turnId: string }> {
    const result = await this.options.transport.request("session/prompt", {
      sessionId: params.sessionId,
      prompt: params.prompt,
    });
    const record = asRecord(result);
    return {
      sessionId: params.sessionId,
      turnId:
        typeof record?.turnId === "string"
          ? record.turnId
          : `pending:${params.sessionId}`,
    };
  }

  async loadSession(metadata: AcpSessionMetadata): Promise<AppServerThreadReplay> {
    this.options.store.upsertSession(metadata);
    const result = await this.options.transport.request("session/load", {
      cwd: metadata.cwd ?? process.cwd(),
      mcpServers: [],
      sessionId: metadata.sessionId,
    });
    const updates = readSessionUpdates(result);
    const normalizer = this.normalizerFor(metadata.sessionId);
    let replay = normalizer.replay();
    for (const update of updates) {
      replay = normalizer.apply({
        sessionId: metadata.sessionId,
        update,
        receivedAt: this.now(),
      });
    }
    return replay;
  }

  startPrompt(params: {
    sessionId: string;
    prompt: string;
    turnId?: string;
  }): { sessionId: string; turnId: string } {
    const turnId = params.turnId ?? `pending:${params.sessionId}:${this.now()}`;
    void this.options.transport
      .request("session/prompt", {
        sessionId: params.sessionId,
        prompt: params.prompt,
      })
      .catch((error) =>
        Promise.resolve(
          this.options.onPromptError?.({
            sessionId: params.sessionId,
            turnId,
            error,
          }),
        ).catch(() => undefined),
      );
    return {
      sessionId: params.sessionId,
      turnId,
    };
  }

  async cancelSession(sessionId: string): Promise<void> {
    if (!this.options.transport.notify) {
      throw new Error("ACP transport does not support notifications");
    }
    await this.options.transport.notify("session/cancel", { sessionId });
  }

  readReplay(sessionId: string): AppServerThreadReplay {
    return this.normalizerFor(sessionId).replay();
  }

  private applySessionUpdate(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const update = asRecord(params.update);
    if (!sessionId || !update) {
      return;
    }
    const replay = this.normalizerFor(sessionId).apply({
      sessionId,
      update,
      receivedAt: this.now(),
    } satisfies AcpSessionUpdate);
    void Promise.resolve(
      this.options.onSessionUpdate?.({
        sessionId,
        replay,
        update,
      }),
    ).catch(() => undefined);
  }

  private normalizerFor(sessionId: string): AcpSessionReplayNormalizer {
    let normalizer = this.normalizers.get(sessionId);
    if (!normalizer) {
      normalizer = new AcpSessionReplayNormalizer();
      this.normalizers.set(sessionId, normalizer);
    }
    return normalizer;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSessionUpdates(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  const updates = Array.isArray(record?.updates)
    ? record.updates
    : Array.isArray(record?.sessionUpdates)
      ? record.sessionUpdates
      : [];
  return updates.flatMap((update) => {
    const updateRecord = asRecord(update);
    return updateRecord ? [updateRecord] : [];
  });
}
