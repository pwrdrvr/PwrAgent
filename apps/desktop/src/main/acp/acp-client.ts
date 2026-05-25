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
  readAcpContentText,
  readAcpTopicTitle,
  type AcpSessionUpdate,
} from "./acp-session-normalizer.js";
import {
  acpRuntimeSupportsSessionHistoryReplay,
  acpRuntimeSupportsSessionLoad,
  acpSessionRuntimeStateFromCapabilities,
  acpSessionRuntimeStateFromUpdate,
  normalizeAcpRuntimeCapabilities,
} from "./acp-runtime-capabilities.js";
import type {
  AcpSessionMetadata,
  AcpSessionStore,
} from "./acp-session-store.js";
import type {
  AcpRolloutRecord,
  AcpRolloutStoreAppendParams,
} from "./acp-rollout-store.js";
import type { JsonRpcId } from "../codex-app-server/json-rpc.js";

export type AcpJsonRpcTransport = {
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
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
const ACP_PROMPT_REQUEST_TIMEOUT_MS = 60 * 60_000;

export type AcpMcpServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

type AcpSessionStoreLike = Pick<
  AcpSessionStore,
  "getSession" | "listSessions" | "upsertSession"
>;

type AcpRolloutStoreLike = {
  appendUpdate(params: AcpRolloutStoreAppendParams): void;
  flushAll?(): void;
  readUpdates(params: {
    backendId: AcpBackendId;
    sessionId: string;
  }): AcpRolloutRecord[];
};

type AcpActiveTurn = {
  activeAssistantMessageItemId?: string;
  assistantText: string;
  assistantMessageSequence: number;
  turnId: string;
};

export type AcpAgentClientOptions = {
  backendId: AcpBackendId;
  agentDisplayName?: string;
  initialRuntimeCapabilities?: BackendAcpRuntimeCapabilities;
  rolloutStore?: AcpRolloutStoreLike;
  store: AcpSessionStoreLike;
  transport: AcpJsonRpcTransport;
  now?: () => number;
  onSessionUpdate?: (event: {
    assistantMessageItemId?: string;
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
  mcpServers?: (context: {
    backendId: AcpBackendId;
    cwd: string;
    sessionId?: string;
  }) => AcpMcpServerConfig[];
};

export class AcpAgentClient {
  private readonly normalizers = new Map<string, AcpSessionReplayNormalizer>();
  private readonly activeTurns = new Map<string, AcpActiveTurn>();
  private readonly loadedSessionCwds = new Map<string, string | undefined>();
  private readonly suppressedControlPromptSessions = new Map<
    string,
    { textChunks: string[] }
  >();
  private readonly agentSessionIdsByAppSessionId = new Map<string, string>();
  private readonly appSessionIdsByAgentSessionId = new Map<string, string>();
  private readonly now: () => number;
  private readonly approvalRequesterName: string;
  private unsubscribe?: () => void;
  private unsubscribeRequest?: () => void;
  private runtimeCapabilities?: BackendAcpRuntimeCapabilities;

  constructor(private readonly options: AcpAgentClientOptions) {
    this.now = options.now ?? Date.now;
    this.runtimeCapabilities = options.initialRuntimeCapabilities;
    this.approvalRequesterName = approvalRequesterNameForOptions(options);
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
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "initialize",
      result,
    });
    this.notifyRuntimeCapabilities({
      runtimeCapabilities,
    });
  }

  async dispose(): Promise<void> {
    this.options.rolloutStore?.flushAll?.();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeRequest?.();
    this.unsubscribeRequest = undefined;
    this.agentSessionIdsByAppSessionId.clear();
    this.appSessionIdsByAgentSessionId.clear();
    this.loadedSessionCwds.clear();
    await this.options.transport.close?.();
  }

  async startSession(params: {
    sessionId?: string;
    cwd?: string;
    executionMode: ThreadExecutionMode;
    title?: string;
    createdAt?: number;
    acpRuntime?: BackendAcpSessionRuntimeState;
  }): Promise<AcpSessionMetadata> {
    const cwd = params.cwd ?? process.cwd();
    const mcpServers = this.buildMcpServers({
      cwd,
      sessionId: params.sessionId,
    });
    const result = await this.options.transport.request("session/new", {
      cwd,
      mcpServers,
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
    this.appendHistoryUpdate(params.sessionId, receivedAt, {
      kind: "pwragent_user_prompt",
      prompt: params.prompt,
      ...(params.parts?.length ? { parts: params.parts } : {}),
      turnId,
    });
    this.markSessionHasConversationHistory(params.sessionId, receivedAt);
    let result: unknown;
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    try {
      const promptRequest = this.options.transport.request(
        "session/prompt",
        {
          sessionId: protocolSessionId,
          prompt: params.promptContent ?? textPrompt(params.prompt),
        },
        ACP_PROMPT_REQUEST_TIMEOUT_MS,
      );
      result = await promptRequest;
    } catch (error) {
      this.finishTrackedTurn(params.sessionId);
      this.recordPromptFailure(params.sessionId, turnId, error);
      throw error;
    }
    this.finishTrackedTurn(params.sessionId);
    const finishedAt = this.now();
    this.appendHistoryUpdate(params.sessionId, finishedAt, {
      kind: "turn_finished",
      turnId,
    });
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
    if (this.supportsSessionLoad()) {
      await this.ensureSession(metadata);
    } else {
      this.hydrateSessionFromHistory(metadata);
    }
    return this.replayForSessionMetadata(metadata);
  }

  async refreshSession(metadata: AcpSessionMetadata): Promise<void> {
    await this.ensureSession(metadata);
  }

  async ensureSession(metadata: AcpSessionMetadata): Promise<void> {
    this.options.store.upsertSession(metadata);
    this.rememberSessionIds(metadata);
    if (!this.supportsSessionLoad()) {
      return;
    }
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
    this.appendHistoryUpdate(params.sessionId, receivedAt, {
      kind: "pwragent_user_prompt",
      prompt: params.prompt,
      ...(params.parts?.length ? { parts: params.parts } : {}),
      turnId,
    });
    this.markSessionHasConversationHistory(params.sessionId, receivedAt);
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const promptRequest = this.options.transport.request(
      "session/prompt",
      {
        sessionId: protocolSessionId,
        prompt: params.promptContent ?? textPrompt(params.prompt),
      },
      ACP_PROMPT_REQUEST_TIMEOUT_MS,
    );
    void promptRequest
      .then(() => {
        const finished = this.finishTrackedTurn(params.sessionId);
        const receivedAt = this.now();
        this.appendHistoryUpdate(params.sessionId, receivedAt, {
          kind: "turn_finished",
          ...(finished.turnId ? { turnId: finished.turnId } : {}),
          outputText: finished.assistantText,
        });
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
        this.finishTrackedTurn(params.sessionId);
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

  async sendControlPrompt(params: {
    sessionId: string;
    prompt: string;
  }): Promise<{ text: string }> {
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const suppression = { textChunks: [] };
    this.suppressedControlPromptSessions.set(protocolSessionId, suppression);
    try {
      await this.options.transport.request(
        "session/prompt",
        {
          sessionId: protocolSessionId,
          prompt: textPrompt(params.prompt),
        },
        ACP_PROMPT_REQUEST_TIMEOUT_MS,
      );
      return { text: suppression.textChunks.join("\n").trim() };
    } finally {
      this.suppressedControlPromptSessions.delete(protocolSessionId);
    }
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
    return this.normalizerFor(sessionId).replay();
  }

  private applySessionUpdate(params: Record<string, unknown>): void {
    const protocolSessionId =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    const update = asRecord(params.update);
    if (!protocolSessionId || !update) {
      return;
    }
    const suppressedControlPrompt =
      this.suppressedControlPromptSessions.get(protocolSessionId);
    if (suppressedControlPrompt) {
      const text = readUpdateText(update);
      if (text) {
        suppressedControlPrompt.textChunks.push(text);
      }
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
    if (isConversationHistoryUpdate(update)) {
      this.markSessionHasConversationHistory(sessionId, receivedAt);
    }
    this.appendHistoryUpdate(sessionId, receivedAt, update);
    const updateKind = readUpdateKind(update);
    const isAssistantTextUpdate =
      updateKind === "agent_message_chunk" || updateKind === "agent_thought_chunk";
    const text = readUpdateText(update);
    let assistantMessageItemId: string | undefined;
    if (isAssistantTextUpdate && activeTurn && text) {
      assistantMessageItemId = assistantMessageItemIdForUpdate({
        activeTurn,
        update,
      });
      if (updateKind === "agent_message_chunk") {
        activeTurn.assistantText += text;
      }
    } else if (!isAssistantTextUpdate && activeTurn) {
      activeTurn.activeAssistantMessageItemId = undefined;
    }
    const replay = this.normalizerFor(sessionId).apply({
      sessionId,
      update,
      receivedAt,
    } satisfies AcpSessionUpdate);
    void this.notifySessionUpdate({
      assistantMessageItemId,
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
      typeof toolCall.toolCallId === "string"
        ? toolCall.toolCallId
        : typeof toolCall.tool_call_id === "string"
          ? toolCall.tool_call_id
          : undefined;
    const requestId = id == null ? toolCallId ?? `acp:${this.now()}` : String(id);
    const activeTurn = this.activeTurns.get(sessionId);

    return {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: sessionId,
        ...(activeTurn?.turnId ? { turnId: activeTurn.turnId } : {}),
        requestId,
        prompt: permissionPrompt(this.approvalRequesterName, title, toolCall),
        reason: permissionPrompt(this.approvalRequesterName, title, toolCall),
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

  private replayForSessionMetadata(
    metadata: AcpSessionMetadata,
  ): AppServerThreadReplay {
    const normalizer = this.normalizerFor(metadata.sessionId);
    const replay = normalizer.replay();
    return {
      ...replay,
      threadStatus: acpSessionThreadStatus(metadata.status, replay.threadStatus),
    };
  }

  private hydrateSessionFromHistory(metadata: AcpSessionMetadata): void {
    if (!this.options.rolloutStore) {
      return;
    }
    const normalizer = new AcpSessionReplayNormalizer();
    for (const record of this.options.rolloutStore.readUpdates({
      backendId: this.options.backendId,
      sessionId: metadata.sessionId,
    })) {
      normalizer.apply({
        sessionId: metadata.sessionId,
        receivedAt: record.receivedAt,
        update: record.update,
      });
    }
    this.normalizers.set(metadata.sessionId, normalizer);
  }

  private markSessionHasConversationHistory(
    sessionId: string,
    receivedAt: number,
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata || metadata.hasConversationHistory) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      hasConversationHistory: true,
      updatedAt: Math.max(metadata.updatedAt, receivedAt),
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
    assistantMessageItemId?: string;
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
    if (!this.supportsSessionLoad()) {
      return undefined;
    }
    const cwd = metadata.cwd ?? process.cwd();
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    const mcpServers = this.buildMcpServers({
      cwd,
      sessionId: metadata.sessionId,
    });
    const result = await this.options.transport.request("session/load", {
      cwd,
      mcpServers,
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
      void Promise.resolve(
        this.options.onSessionRuntimeStateChange?.({
          sessionId: metadata.sessionId,
          runtimeState,
        }),
      ).catch(() => undefined);
    }
    this.notifyRuntimeCapabilities({
      sessionId: metadata.sessionId,
      runtimeCapabilities,
      runtimeState,
    });
    this.loadedSessionCwds.set(protocolSessionId, cwd);
    return result;
  }

  private supportsSessionLoad(): boolean {
    return acpRuntimeSupportsSessionLoad(this.runtimeCapabilities);
  }

  private buildMcpServers(params: {
    cwd: string;
    sessionId?: string;
  }): AcpMcpServerConfig[] {
    return (
      this.options.mcpServers?.({
        backendId: this.options.backendId,
        cwd: params.cwd,
        sessionId: params.sessionId,
      }) ?? []
    );
  }

  private startTrackedTurn(sessionId: string, turnId: string): void {
    if (this.activeTurns.has(sessionId)) {
      throw new Error("A turn is already active for this ACP session.");
    }
    this.activeTurns.set(sessionId, {
      assistantText: "",
      assistantMessageSequence: 0,
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
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (metadata) {
      this.options.store.upsertSession({
        ...metadata,
        lastError: message,
        status: "idle",
        updatedAt: Math.max(metadata.updatedAt, receivedAt),
      });
    }
    this.appendHistoryUpdate(sessionId, receivedAt, {
      kind: "pwragent_turn_failed",
      turnId,
      error: message,
    });
    return this.normalizerFor(sessionId).recordTurnFailed({
      sessionId,
      turnId,
      error: message,
      receivedAt,
    });
  }

  private appendHistoryUpdate(
    sessionId: string,
    receivedAt: number,
    update: Record<string, unknown>,
  ): void {
    if (acpRuntimeSupportsSessionHistoryReplay(this.runtimeCapabilities)) {
      return;
    }
    this.options.rolloutStore?.appendUpdate({
      backendId: this.options.backendId,
      sessionId,
      receivedAt,
      update,
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
  const kind =
    update.sessionUpdate ?? update.session_update ?? update.kind ?? update.type;
  return typeof kind === "string" ? kind : undefined;
}

function isConversationHistoryUpdate(update: Record<string, unknown>): boolean {
  const kind = readUpdateKind(update);
  return (
    kind === "pwragent_user_prompt" ||
    kind === "user_message_chunk" ||
    kind === "agent_message_chunk"
  );
}

function readUpdateText(update: Record<string, unknown>): string | undefined {
  if (typeof update.text === "string") {
    return update.text;
  }
  if (typeof update.outputText === "string") {
    return update.outputText;
  }
  if (typeof update.output_text === "string") {
    return update.output_text;
  }
  return readAcpContentText(update.content);
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

function approvalRequesterNameForOptions(options: Pick<
  AcpAgentClientOptions,
  "agentDisplayName" | "backendId"
>): string {
  const configured = options.agentDisplayName?.trim();
  if (configured) {
    return configured;
  }
  const backendName = options.backendId
    .replace(/^acp:/, "")
    .split(/[-_:]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
    .trim();
  return backendName || "ACP agent";
}

function permissionPrompt(
  requesterName: string,
  title: string,
  toolCall: Record<string, unknown>,
): string {
  const contentText = readToolCallText(toolCall.content);
  if (contentText) {
    return contentText;
  }
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : undefined;
  return kind
    ? `${requesterName} wants to run ${kind}: ${title}`
    : `${requesterName} wants to run ${title}`;
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

function assistantMessageItemIdForUpdate(params: {
  activeTurn: AcpActiveTurn;
  update: Record<string, unknown>;
}): string {
  const explicitId =
    typeof params.update.messageId === "string"
      ? params.update.messageId
      : typeof params.update.message_id === "string"
        ? params.update.message_id
        : undefined;
  if (explicitId) {
    params.activeTurn.activeAssistantMessageItemId = explicitId;
    return explicitId;
  }

  if (!params.activeTurn.activeAssistantMessageItemId) {
    params.activeTurn.activeAssistantMessageItemId =
      `assistant:${params.activeTurn.turnId}:${params.activeTurn.assistantMessageSequence++}`;
  }
  return params.activeTurn.activeAssistantMessageItemId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
