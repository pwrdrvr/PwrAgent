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
  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
};

export type AcpAgentClientOptions = {
  backendId: AcpBackendId;
  store: AcpSessionStore;
  transport: AcpJsonRpcTransport;
  now?: () => number;
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
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminals: true,
      },
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async startSession(params: {
    cwd?: string;
    executionMode: ThreadExecutionMode;
    title?: string;
  }): Promise<AcpSessionMetadata> {
    const result = await this.options.transport.request("session/new", {
      cwd: params.cwd,
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
      cwd: params.cwd,
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

  readReplay(sessionId: string): AppServerThreadReplay {
    return this.normalizerFor(sessionId).replay();
  }

  private applySessionUpdate(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const update = asRecord(params.update);
    if (!sessionId || !update) {
      return;
    }
    this.normalizerFor(sessionId).apply({
      sessionId,
      update,
      receivedAt: this.now(),
    } satisfies AcpSessionUpdate);
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
