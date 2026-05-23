import type {
  AcpBackendId,
  AppServerPendingRequestNotification,
  AppServerThreadReplay,
  AppServerThreadMessagePart,
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  AcpSessionReplayNormalizer,
  readAcpTopicTitle,
  type AcpSessionUpdate,
} from "./acp-session-normalizer.js";
import {
  acpSessionRuntimeStateFromCapabilities,
  acpSessionRuntimeStateFromUpdate,
  normalizeAcpRuntimeCapabilities,
} from "./acp-runtime-capabilities.js";
import type {
  AcpPersistedTranscriptUpdate,
  AcpSessionMetadata,
  AcpSessionStore,
} from "./acp-session-store.js";
import type { JsonRpcId } from "../codex-app-server/json-rpc.js";

export type AcpJsonRpcTransport = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify?(method: string, params?: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
  onRequest?(
    listener: (
      method: string,
      params: Record<string, unknown>,
      id?: JsonRpcId,
    ) => Promise<unknown> | unknown,
  ): () => void;
};

const ACP_PROTOCOL_VERSION = 1;

export type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

type AcpSessionStoreLike = Pick<
  AcpSessionStore,
  "getSession" | "listSessions" | "upsertSession"
>;

export type AcpAgentClientOptions = {
  backendId: AcpBackendId;
  store: AcpSessionStoreLike;
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
  onRuntimeCapabilities?: (event: {
    sessionId?: string;
    runtimeCapabilities: BackendAcpRuntimeCapabilities;
    runtimeState?: BackendAcpSessionRuntimeState;
  }) => Promise<void> | void;
  onSessionRuntimeStateChange?: (event: {
    sessionId: string;
    runtimeState: BackendAcpSessionRuntimeState;
  }) => Promise<void> | void;
  onRequest?: (
    request: AppServerPendingRequestNotification
  ) => Promise<unknown> | unknown;
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
  private readonly loadedSessionCwds = new Map<string, string | undefined>();
  private readonly suppressLoadReplaySessions = new Set<string>();
  private readonly hydratedTranscriptSessions = new Set<string>();
  private readonly agentSessionIdsByAppSessionId = new Map<string, string>();
  private readonly appSessionIdsByAgentSessionId = new Map<string, string>();
  private readonly now: () => number;
  private unsubscribe?: () => void;
  private unsubscribeRequest?: () => void;
  private runtimeCapabilities?: BackendAcpRuntimeCapabilities;

  constructor(private readonly options: AcpAgentClientOptions) {
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    this.unsubscribe = this.options.transport.onNotification((method, params) => {
      if (method === "session/update") {
        this.applySessionUpdate(params);
      }
    });
    this.unsubscribeRequest = this.options.transport.onRequest?.(
      async (method, params, id) => await this.handleAcpRequest(method, params, id),
    );
    const result = await this.options.transport.request("initialize", {
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
    this.captureRuntimeCapabilities({
      source: "initialize",
      result,
    });
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeRequest?.();
    this.unsubscribeRequest = undefined;
    this.agentSessionIdsByAppSessionId.clear();
    this.appSessionIdsByAgentSessionId.clear();
    this.loadedSessionCwds.clear();
    this.suppressLoadReplaySessions.clear();
    this.hydratedTranscriptSessions.clear();
    await this.options.transport.close?.();
  }

  async startSession(params: {
    sessionId?: string;
    cwd?: string;
    executionMode: ThreadExecutionMode;
    title?: string;
    createdAt?: number;
    acpRuntime?: BackendAcpSessionRuntimeState;
    transcriptUpdates?: AcpPersistedTranscriptUpdate[];
  }): Promise<AcpSessionMetadata> {
    const cwd = params.cwd ?? process.cwd();
    const result = await this.options.transport.request("session/new", {
      cwd,
      mcpServers: [],
    });
    const now = this.now();
    const record = asRecord(result);
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "session-new",
      result,
    });
    const runtimeState = acpSessionRuntimeStateFromCapabilities(
      runtimeCapabilities,
      now,
    );
    const combinedRuntimeState =
      params.acpRuntime || runtimeState
        ? mergeAcpRuntimeState(params.acpRuntime, runtimeState ?? {})
        : undefined;
    const sessionId =
      typeof record?.sessionId === "string"
        ? record.sessionId
        : typeof record?.session_id === "string"
          ? record.session_id
          : undefined;
    if (!sessionId) {
      throw new Error("ACP session/new did not return a session id");
    }
    const appSessionId = params.sessionId ?? sessionId;
    const metadata: AcpSessionMetadata = {
      backendId: this.options.backendId,
      sessionId: appSessionId,
      ...(sessionId === appSessionId ? {} : { agentSessionId: sessionId }),
      title: params.title ?? "ACP session",
      titleSource: params.title ? "explicit" : "fallback",
      cwd,
      createdAt: params.createdAt ?? now,
      updatedAt: now,
      executionMode: params.executionMode,
      acpRuntime: combinedRuntimeState,
      status: "idle",
      transcriptUpdates: params.transcriptUpdates,
    };
    this.options.store.upsertSession(metadata);
    this.rememberSessionIds(metadata);
    this.loadedSessionCwds.set(sessionId, cwd);
    this.notifyRuntimeCapabilities({
      sessionId: appSessionId,
      runtimeCapabilities,
      runtimeState,
    });
    return metadata;
  }

  async prompt(params: {
    sessionId: string;
    prompt: string;
    promptContent?: AcpPromptContentBlock[];
    parts?: AppServerThreadMessagePart[];
  }): Promise<{ sessionId: string; turnId: string }> {
    this.hydratePersistedTranscriptForSession(params.sessionId);
    const turnId = `pending:${params.sessionId}:${this.now()}`;
    const receivedAt = this.now();
    this.startTrackedTurn(params.sessionId, turnId);
    this.normalizerFor(params.sessionId).recordUserPrompt({
      sessionId: params.sessionId,
      prompt: params.prompt,
      parts: params.parts,
      turnId,
      receivedAt,
    });
    this.persistTranscriptUpdate(params.sessionId, {
      receivedAt,
      update: {
        kind: "pwragent_user_prompt",
        prompt: params.prompt,
        ...(params.parts?.length ? { parts: params.parts } : {}),
        turnId,
      },
    });
    let result: unknown;
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    try {
      const promptRequest = this.options.transport.request("session/prompt", {
        sessionId: protocolSessionId,
        prompt: params.promptContent ?? textPrompt(params.prompt),
      });
      this.clearLoadReplaySuppression(protocolSessionId);
      result = await promptRequest;
    } catch (error) {
      this.finishTrackedTurn(params.sessionId, { persistFinished: false });
      this.recordPromptFailure(params.sessionId, turnId, error);
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
    this.rememberSessionIds(metadata);
    return this.hydratePersistedTranscript(metadata);
  }

  async refreshSession(metadata: AcpSessionMetadata): Promise<void> {
    this.options.store.upsertSession(metadata);
    this.rememberSessionIds(metadata);
    await this.loadSessionFromAgent(metadata);
  }

  async ensureSession(metadata: AcpSessionMetadata): Promise<void> {
    this.options.store.upsertSession(metadata);
    this.rememberSessionIds(metadata);
    const cwd = metadata.cwd ?? process.cwd();
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    if (
      this.loadedSessionCwds.has(protocolSessionId) &&
      this.loadedSessionCwds.get(protocolSessionId) === cwd
    ) {
      return;
    }
    await this.loadSessionFromAgent(metadata);
  }

  startPrompt(params: {
    sessionId: string;
    prompt: string;
    promptContent?: AcpPromptContentBlock[];
    parts?: AppServerThreadMessagePart[];
    turnId?: string;
  }): { sessionId: string; turnId: string } {
    this.hydratePersistedTranscriptForSession(params.sessionId);
    const turnId = params.turnId ?? `pending:${params.sessionId}:${this.now()}`;
    const receivedAt = this.now();
    this.startTrackedTurn(params.sessionId, turnId);
    this.normalizerFor(params.sessionId).recordUserPrompt({
      sessionId: params.sessionId,
      prompt: params.prompt,
      parts: params.parts,
      turnId,
      receivedAt,
    });
    this.persistTranscriptUpdate(params.sessionId, {
      receivedAt,
      update: {
        kind: "pwragent_user_prompt",
        prompt: params.prompt,
        ...(params.parts?.length ? { parts: params.parts } : {}),
        turnId,
      },
    });
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const promptRequest = this.options.transport.request("session/prompt", {
      sessionId: protocolSessionId,
      prompt: params.promptContent ?? textPrompt(params.prompt),
    });
    this.clearLoadReplaySuppression(protocolSessionId);
    void promptRequest
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
        this.finishTrackedTurn(params.sessionId, { persistFinished: false });
        this.recordPromptFailure(params.sessionId, turnId, error);
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
    await this.options.transport.notify("session/cancel", {
      sessionId: this.protocolSessionIdFor(sessionId),
    });
  }

  async setRuntimeOption(params: {
    sessionId: string;
    source: BackendAcpRuntimeOptionSource;
    optionId: string;
    value: string;
  }): Promise<BackendAcpSessionRuntimeState | undefined> {
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const result = await this.setRuntimeOptionOnTransport({
      protocolSessionId,
      source: params.source,
      optionId: params.optionId,
      value: params.value,
    });
    const now = this.now();
    const responseRuntimeCapabilities = normalizeAcpRuntimeCapabilities({
      value: result,
      now,
      source: "session-load",
    });
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "session-load",
      result,
    });
    const responseRuntimeState = acpSessionRuntimeStateFromCapabilities(
      responseRuntimeCapabilities,
      now,
    );
    const requestedRuntimeState: BackendAcpSessionRuntimeState =
      params.source === "configOption"
        ? {
            configValues: { [params.optionId]: params.value },
            updatedAt: now,
          }
        : params.source === "mode"
          ? {
              currentModeId: params.value,
              updatedAt: now,
            }
          : {
              currentModelId: params.value,
              updatedAt: now,
            };
    const runtimeState = mergeAcpRuntimeState(
      requestedRuntimeState,
      responseRuntimeState ?? { updatedAt: now },
    );
    this.updateSessionRuntimeState(params.sessionId, runtimeState);
    this.notifyRuntimeCapabilities({
      sessionId: params.sessionId,
      runtimeCapabilities,
      runtimeState,
    });
    return runtimeState;
  }

  private async setRuntimeOptionOnTransport(params: {
    protocolSessionId: string;
    source: BackendAcpRuntimeOptionSource;
    optionId: string;
    value: string;
  }): Promise<unknown> {
    if (params.source === "configOption") {
      return await this.options.transport.request("session/set_config_option", {
        sessionId: params.protocolSessionId,
        configId: params.optionId,
        value: params.value,
      });
    }

    if (params.source === "mode") {
      return await this.options.transport.request("session/set_mode", {
        sessionId: params.protocolSessionId,
        modeId: params.value,
      });
    }

    return await this.options.transport.request("session/set_model", {
      sessionId: params.protocolSessionId,
      modelId: params.value,
    });
  }

  readReplay(sessionId: string): AppServerThreadReplay {
    this.hydratePersistedTranscriptForSession(sessionId);
    return this.normalizerFor(sessionId).replay();
  }

  private applySessionUpdate(params: Record<string, unknown>): void {
    const protocolSessionId =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    const update = asRecord(params.update);
    if (!protocolSessionId || !update) {
      return;
    }
    const sessionId = this.appSessionIdFor(protocolSessionId);
    const receivedAt = this.now();
    const activeTurn = this.activeTurns.get(sessionId);
    const runtimeState = acpSessionRuntimeStateFromUpdate(update, receivedAt);
    if (runtimeState) {
      this.updateSessionRuntimeState(sessionId, runtimeState);
      void Promise.resolve(
        this.options.onSessionRuntimeStateChange?.({ sessionId, runtimeState }),
      ).catch(() => undefined);
      return;
    }
    const title = this.updateSessionTitleFromAcpUpdate(sessionId, update, receivedAt);
    if (this.suppressLoadReplaySessions.has(protocolSessionId)) {
      if (title) {
        void this.notifySessionUpdate({
          sessionId,
          replay: this.normalizerFor(sessionId).replay(),
          title,
          turnId: activeTurn?.turnId,
          update,
        });
      }
      return;
    }
    if (readUpdateKind(update) === "agent_message_chunk" && activeTurn) {
      activeTurn.assistantText += readUpdateText(update) ?? "";
    }
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

  private async handleAcpRequest(
    method: string,
    params: Record<string, unknown>,
    id?: JsonRpcId,
  ): Promise<unknown> {
    if (method !== "session/request_permission") {
      throw new Error(`Unsupported ACP request: ${method}`);
    }

    const request = this.normalizePermissionRequest(params, id);
    if (!request || !this.options.onRequest) {
      return cancelledPermissionOutcome();
    }

    const response = await this.options.onRequest(request);
    return permissionOutcomeFromResponse(
      response,
      readPermissionOptions(params.options),
    );
  }

  private normalizePermissionRequest(
    params: Record<string, unknown>,
    id?: JsonRpcId,
  ): AppServerPendingRequestNotification | undefined {
    const protocolSessionId =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!protocolSessionId) {
      return undefined;
    }
    const sessionId = this.appSessionIdFor(protocolSessionId);
    const toolCall = asRecord(params.toolCall) ?? {};
    const title =
      typeof toolCall.title === "string" && toolCall.title.trim()
        ? toolCall.title.trim()
        : "ACP tool call";
    const toolCallId =
      typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined;
    const requestId = id == null ? toolCallId ?? `acp:${this.now()}` : String(id);
    const activeTurn = this.activeTurns.get(sessionId);

    return {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: sessionId,
        ...(activeTurn?.turnId ? { turnId: activeTurn.turnId } : {}),
        requestId,
        prompt: permissionPrompt(title, toolCall),
        reason: permissionPrompt(title, toolCall),
        command: title,
        displayCommand: title,
        acpMethod: "session/request_permission",
        acpToolCallId: toolCallId,
        acpToolKind: typeof toolCall.kind === "string" ? toolCall.kind : undefined,
        acpPermissionOptions: readPermissionOptions(params.options),
      },
    };
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
      const runtimeState = acpSessionRuntimeStateFromUpdate(
        item.update,
        item.receivedAt,
      );
      if (runtimeState) {
        this.updateSessionRuntimeState(metadata.sessionId, runtimeState);
      }
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

  private hydratePersistedTranscriptForSession(sessionId: string): AppServerThreadReplay {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return this.normalizerFor(sessionId).replay();
    }
    return this.hydratePersistedTranscript(metadata);
  }

  private hydratePersistedTranscript(
    metadata: AcpSessionMetadata,
  ): AppServerThreadReplay {
    const normalizer = this.normalizerFor(metadata.sessionId);
    if (!this.hydratedTranscriptSessions.has(metadata.sessionId)) {
      this.applyPersistedTranscriptUpdates(normalizer, metadata);
      this.hydratedTranscriptSessions.add(metadata.sessionId);
    }
    return {
      ...normalizer.replay(),
      threadStatus: acpSessionThreadStatus(metadata.status, normalizer.replay().threadStatus),
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

  private captureRuntimeCapabilities(params: {
    source: BackendAcpRuntimeCapabilities["source"];
    result: unknown;
  }): BackendAcpRuntimeCapabilities | undefined {
    const runtimeCapabilities = normalizeAcpRuntimeCapabilities({
      value: params.result,
      now: this.now(),
      source: params.source,
      initialize: this.runtimeCapabilities,
    });
    if (runtimeCapabilities) {
      this.runtimeCapabilities = runtimeCapabilities;
    }
    return runtimeCapabilities;
  }

  private notifyRuntimeCapabilities(event: {
    sessionId?: string;
    runtimeCapabilities?: BackendAcpRuntimeCapabilities;
    runtimeState?: BackendAcpSessionRuntimeState;
  }): void {
    if (!event.runtimeCapabilities) {
      return;
    }
    void Promise.resolve(
      this.options.onRuntimeCapabilities?.({
        sessionId: event.sessionId,
        runtimeCapabilities: event.runtimeCapabilities,
        runtimeState: event.runtimeState,
      }),
    ).catch(() => undefined);
  }

  private updateSessionRuntimeState(
    sessionId: string,
    runtimeState: BackendAcpSessionRuntimeState,
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      acpRuntime: mergeAcpRuntimeState(metadata.acpRuntime, runtimeState),
      updatedAt: Math.max(metadata.updatedAt, runtimeState.updatedAt ?? this.now()),
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

  private async loadSessionFromAgent(metadata: AcpSessionMetadata): Promise<unknown> {
    const cwd = metadata.cwd ?? process.cwd();
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    this.suppressLoadReplaySessions.add(protocolSessionId);
    const result = await this.options.transport.request("session/load", {
      cwd,
      mcpServers: [],
      sessionId: protocolSessionId,
    });
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "session-load",
      result,
    });
    const runtimeState = acpSessionRuntimeStateFromCapabilities(
      runtimeCapabilities,
      this.now(),
    );
    if (runtimeState) {
      this.updateSessionRuntimeState(metadata.sessionId, runtimeState);
    }
    this.notifyRuntimeCapabilities({
      sessionId: metadata.sessionId,
      runtimeCapabilities,
      runtimeState,
    });
    this.loadedSessionCwds.set(protocolSessionId, cwd);
    return result;
  }

  private clearLoadReplaySuppression(sessionId: string): void {
    this.suppressLoadReplaySessions.delete(sessionId);
  }

  private startTrackedTurn(sessionId: string, turnId: string): void {
    if (this.activeTurns.has(sessionId)) {
      throw new Error("A turn is already active for this ACP session.");
    }
    this.activeTurns.set(sessionId, {
      assistantText: "",
      turnId,
    });
    this.updateSessionStatus(sessionId, "active");
  }

  private finishTrackedTurn(
    sessionId: string,
    options?: { persistFinished?: boolean },
  ): {
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
    if (activeTurn && options?.persistFinished !== false) {
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

  private recordPromptFailure(
    sessionId: string,
    turnId: string,
    error: unknown,
  ): AppServerThreadReplay {
    const message = errorMessage(error);
    const receivedAt = this.now();
    this.persistTranscriptUpdate(sessionId, {
      receivedAt,
      update: {
        kind: "pwragent_turn_failed",
        turnId,
        error: message,
      },
    });
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (metadata) {
      this.options.store.upsertSession({
        ...metadata,
        lastError: message,
        status: "idle",
        updatedAt: Math.max(metadata.updatedAt, receivedAt),
      });
    }
    return this.normalizerFor(sessionId).recordTurnFailed({
      sessionId,
      turnId,
      error: message,
      receivedAt,
    });
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
    const currentTitleSource =
      metadata.titleSource ??
      (metadata.title === "ACP session" || !metadata.title.trim()
        ? "fallback"
        : "derived");
    if (currentTitleSource !== "fallback") {
      return undefined;
    }
    this.options.store.upsertSession({
      ...metadata,
      title,
      titleSource: "derived",
      updatedAt: Math.max(metadata.updatedAt, receivedAt),
    });
    return title;
  }

  private rememberSessionIds(metadata: AcpSessionMetadata): void {
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    this.agentSessionIdsByAppSessionId.set(metadata.sessionId, protocolSessionId);
    this.appSessionIdsByAgentSessionId.set(protocolSessionId, metadata.sessionId);
  }

  private protocolSessionIdFor(sessionId: string): string {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (metadata) {
      this.rememberSessionIds(metadata);
      return protocolSessionIdForMetadata(metadata);
    }
    return this.agentSessionIdsByAppSessionId.get(sessionId) ?? sessionId;
  }

  private appSessionIdFor(protocolSessionId: string): string {
    return this.appSessionIdsByAgentSessionId.get(protocolSessionId) ?? protocolSessionId;
  }
}

function protocolSessionIdForMetadata(metadata: AcpSessionMetadata): string {
  return metadata.agentSessionId ?? metadata.sessionId;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const message = String(error).trim();
  return message || "Turn failed.";
}

function acpSessionThreadStatus(
  status: AcpSessionMetadata["status"],
  fallback: AppServerThreadReplay["threadStatus"],
): AppServerThreadReplay["threadStatus"] {
  return status === "active" || status === "idle" || status === "unknown"
    ? status
    : fallback;
}

function mergeAcpRuntimeState(
  existing: BackendAcpSessionRuntimeState | undefined,
  update: BackendAcpSessionRuntimeState,
): BackendAcpSessionRuntimeState {
  return {
    ...existing,
    ...update,
    configValues: {
      ...(existing?.configValues ?? {}),
      ...(update.configValues ?? {}),
    },
  };
}

type AcpPermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

function readPermissionOptions(value: unknown): AcpPermissionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option) => {
    const record = asRecord(option);
    const optionId = record?.optionId;
    if (!record || typeof optionId !== "string" || !optionId.trim()) {
      return [];
    }
    const normalized: AcpPermissionOption = { optionId };
    if (typeof record.name === "string") {
      normalized.name = record.name;
    }
    if (typeof record.kind === "string") {
      normalized.kind = record.kind;
    }
    return [normalized];
  });
}

function permissionPrompt(title: string, toolCall: Record<string, unknown>): string {
  const contentText = readToolCallText(toolCall.content);
  if (contentText) {
    return contentText;
  }
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : undefined;
  return kind ? `Gemini wants to run ${kind}: ${title}` : `Gemini wants to run ${title}`;
}

function readToolCallText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .flatMap((item) => {
      const record = asRecord(item);
      return record?.type === "text" && typeof record.text === "string"
        ? [record.text.trim()]
        : [];
    })
    .filter(Boolean)
    .join("\n\n");
  return text || undefined;
}

function permissionOutcomeFromResponse(
  response: unknown,
  options: AcpPermissionOption[],
): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const decision = asRecord(response)?.decision;
  if (typeof decision !== "string") {
    return cancelledPermissionOutcome();
  }
  if (decision === "cancel") {
    return cancelledPermissionOutcome();
  }
  const optionId = selectPermissionOptionId(decision, options);
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : cancelledPermissionOutcome();
}

function cancelledPermissionOutcome(): { outcome: { outcome: "cancelled" } } {
  return { outcome: { outcome: "cancelled" } };
}

function selectPermissionOptionId(
  decision: string,
  options: AcpPermissionOption[],
): string | undefined {
  const normalizedDecision = decision.toLowerCase();
  const exact = options.find((option) =>
    [option.optionId, option.name, option.kind]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase() === normalizedDecision),
  );
  if (exact) {
    return exact.optionId;
  }

  if (
    normalizedDecision === "approve" ||
    normalizedDecision === "accept" ||
    normalizedDecision === "allow"
  ) {
    return (
      options.find((option) => option.kind === "allow_once") ??
      options.find((option) => option.kind === "allow_always") ??
      options.find((option) => option.name?.toLowerCase().includes("allow"))
    )?.optionId;
  }

  if (
    normalizedDecision === "decline" ||
    normalizedDecision === "reject" ||
    normalizedDecision === "deny"
  ) {
    return (
      options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.name?.toLowerCase().includes("reject"))
    )?.optionId;
  }

  return undefined;
}

function textPrompt(text: string): AcpPromptContentBlock[] {
  return [{ type: "text", text }];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
