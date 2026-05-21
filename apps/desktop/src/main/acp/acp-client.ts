import type {
  AcpBackendId,
  AppServerThreadReplay,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  AcpSessionReplayNormalizer,
  readAcpTopicTitle,
  type AcpSessionUpdate,
} from "./acp-session-normalizer.js";
import type {
  AcpPersistedTranscriptUpdate,
  AcpSessionMetadata,
  AcpSessionStore,
} from "./acp-session-store.js";

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
    title?: string;
    turnId?: string;
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
  private readonly activeTurns = new Map<
    string,
    {
      assistantText: string;
      turnId: string;
    }
  >();
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
    const turnId = `pending:${params.sessionId}:${this.now()}`;
    const receivedAt = this.now();
    this.startTrackedTurn(params.sessionId, turnId);
    this.normalizerFor(params.sessionId).recordUserPrompt({
      sessionId: params.sessionId,
      prompt: params.prompt,
      turnId,
      receivedAt,
    });
    this.persistTranscriptUpdate(params.sessionId, {
      receivedAt,
      update: {
        kind: "pwragent_user_prompt",
        prompt: params.prompt,
        turnId,
      },
    });
    let result: unknown;
    try {
      result = await this.options.transport.request("session/prompt", {
        sessionId: params.sessionId,
        prompt: textPrompt(params.prompt),
      });
    } catch (error) {
      this.finishTrackedTurn(params.sessionId);
      throw error;
    }
    this.finishTrackedTurn(params.sessionId);
    const record = asRecord(result);
    return {
      sessionId: params.sessionId,
      turnId:
        typeof record?.turnId === "string"
          ? record.turnId
          : turnId,
    };
  }

  async loadSession(metadata: AcpSessionMetadata): Promise<AppServerThreadReplay> {
    this.options.store.upsertSession(metadata);
    const normalizer = this.normalizerFor(metadata.sessionId);
    let replay = this.applyPersistedTranscriptUpdates(normalizer, metadata);
    if (hasPersistedAssistantUpdate(metadata)) {
      return replay;
    }
    const result = await this.options.transport.request("session/load", {
      cwd: metadata.cwd ?? process.cwd(),
      mcpServers: [],
      sessionId: metadata.sessionId,
    });
    const updates = readSessionUpdates(result);
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
    const receivedAt = this.now();
    this.startTrackedTurn(params.sessionId, turnId);
    this.normalizerFor(params.sessionId).recordUserPrompt({
      sessionId: params.sessionId,
      prompt: params.prompt,
      turnId,
      receivedAt,
    });
    this.persistTranscriptUpdate(params.sessionId, {
      receivedAt,
      update: {
        kind: "pwragent_user_prompt",
        prompt: params.prompt,
        turnId,
      },
    });
    void this.options.transport
      .request("session/prompt", {
        sessionId: params.sessionId,
        prompt: textPrompt(params.prompt),
      })
      .then(() => {
        const finished = this.finishTrackedTurn(params.sessionId);
        void this.notifySessionUpdate({
          sessionId: params.sessionId,
          replay: finished.replay,
          turnId: finished.turnId,
          update: {
            kind: "turn_finished",
            outputText: finished.assistantText,
          },
        });
      })
      .catch((error) => {
        const finished = this.finishTrackedTurn(params.sessionId);
        void this.notifySessionUpdate({
          sessionId: params.sessionId,
          replay: finished.replay,
          turnId: finished.turnId,
          update: {
            kind: "turn_finished",
            outputText: finished.assistantText,
          },
        });
        return Promise.resolve(
          this.options.onPromptError?.({
            sessionId: params.sessionId,
            turnId,
            error,
          }),
        ).catch(() => undefined);
      });
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
    const receivedAt = this.now();
    const activeTurn = this.activeTurns.get(sessionId);
    if (readUpdateKind(update) === "agent_message_chunk" && activeTurn) {
      activeTurn.assistantText += readUpdateText(update) ?? "";
    }
    const title = this.updateSessionTitleFromAcpUpdate(sessionId, update, receivedAt);
    const replay = this.normalizerFor(sessionId).apply({
      sessionId,
      update,
      receivedAt,
    } satisfies AcpSessionUpdate);
    this.persistTranscriptUpdate(sessionId, {
      receivedAt,
      update,
    });
    void this.notifySessionUpdate({
      sessionId,
      replay,
      title,
      turnId: activeTurn?.turnId,
      update,
    });
  }

  private normalizerFor(sessionId: string): AcpSessionReplayNormalizer {
    let normalizer = this.normalizers.get(sessionId);
    if (!normalizer) {
      normalizer = new AcpSessionReplayNormalizer();
      this.normalizers.set(sessionId, normalizer);
    }
    return normalizer;
  }

  private applyPersistedTranscriptUpdates(
    normalizer: AcpSessionReplayNormalizer,
    metadata: AcpSessionMetadata,
  ): AppServerThreadReplay {
    let replay = normalizer.replay();
    for (const item of metadata.transcriptUpdates ?? []) {
      this.updateSessionTitleFromAcpUpdate(
        metadata.sessionId,
        item.update,
        item.receivedAt,
      );
      replay = normalizer.apply({
        sessionId: metadata.sessionId,
        update: item.update,
        receivedAt: item.receivedAt,
      });
    }
    return {
      ...replay,
      threadStatus: acpSessionThreadStatus(metadata.status, replay.threadStatus),
    };
  }

  private persistTranscriptUpdate(
    sessionId: string,
    update: AcpPersistedTranscriptUpdate,
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      updatedAt: Math.max(metadata.updatedAt, update.receivedAt),
      transcriptUpdates: [...(metadata.transcriptUpdates ?? []), update],
    });
  }

  private async notifySessionUpdate(event: {
    sessionId: string;
    replay: AppServerThreadReplay;
    title?: string;
    turnId?: string;
    update: Record<string, unknown>;
  }): Promise<void> {
    await Promise.resolve(this.options.onSessionUpdate?.(event)).catch(
      () => undefined,
    );
  }

  private startTrackedTurn(sessionId: string, turnId: string): void {
    this.activeTurns.set(sessionId, {
      assistantText: "",
      turnId,
    });
    this.updateSessionStatus(sessionId, "active");
  }

  private finishTrackedTurn(sessionId: string): {
    assistantText: string;
    replay: AppServerThreadReplay;
    turnId?: string;
  } {
    const activeTurn = this.activeTurns.get(sessionId);
    this.activeTurns.delete(sessionId);
    const replay = this.normalizerFor(sessionId).recordTurnFinished(
      activeTurn?.turnId,
    );
    this.updateSessionStatus(sessionId, "idle");
    if (activeTurn) {
      this.persistTranscriptUpdate(sessionId, {
        receivedAt: this.now(),
        update: {
          kind: "turn_finished",
          outputText: activeTurn.assistantText,
          turnId: activeTurn.turnId,
        },
      });
    }
    return {
      assistantText: activeTurn?.assistantText ?? "",
      replay,
      turnId: activeTurn?.turnId,
    };
  }

  private updateSessionStatus(
    sessionId: string,
    status: AcpSessionMetadata["status"],
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      status,
      updatedAt: Math.max(metadata.updatedAt, this.now()),
    });
  }

  private updateSessionTitleFromAcpUpdate(
    sessionId: string,
    update: Record<string, unknown>,
    receivedAt: number,
  ): string | undefined {
    const title = readAcpTopicTitle(update);
    if (!title) {
      return undefined;
    }
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata || metadata.title === title) {
      return undefined;
    }
    this.options.store.upsertSession({
      ...metadata,
      title,
      updatedAt: Math.max(metadata.updatedAt, receivedAt),
    });
    return title;
  }
}

function hasPersistedAssistantUpdate(metadata: AcpSessionMetadata): boolean {
  return (metadata.transcriptUpdates ?? []).some(
    (item) => readUpdateKind(item.update) === "agent_message_chunk",
  );
}

function readUpdateKind(update: Record<string, unknown>): string | undefined {
  const kind = update.sessionUpdate ?? update.kind ?? update.type;
  return typeof kind === "string" ? kind : undefined;
}

function readUpdateText(update: Record<string, unknown>): string | undefined {
  if (typeof update.text === "string") {
    return update.text;
  }
  const content = update.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return undefined;
  }
  const contentRecord = content as Record<string, unknown>;
  return contentRecord.type === "text" && typeof contentRecord.text === "string"
    ? contentRecord.text
    : undefined;
}

function acpSessionThreadStatus(
  status: AcpSessionMetadata["status"],
  fallback: AppServerThreadReplay["threadStatus"],
): AppServerThreadReplay["threadStatus"] {
  return status === "active" || status === "idle" || status === "unknown"
    ? status
    : fallback;
}

function textPrompt(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
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
