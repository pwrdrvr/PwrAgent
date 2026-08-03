import type {
  AcpBackendId,
  AppServerAvailableCommandSummary,
  AppServerPendingRequestNotification,
  AppServerTranscriptPhase,
  AppServerThreadReplay,
  AppServerThreadMessagePart,
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendAcpRuntimeOptionSource,
  BackendAcpSessionRuntimeState,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  AcpSessionReplayNormalizer,
  isAcpUserBoilerplateMessage,
  isGrokTransientUpdateKind,
  readAcpContentText,
  readAcpTopicTitle,
  readAcpUpdateTimestamp,
  shouldSurfaceAcpThoughtsAsMessages,
  type AcpSessionUpdate,
} from "./acp-session-normalizer.js";
import {
  acpRuntimeSupportsSessionLoad,
  acpSessionRuntimeStateFromResponse,
  acpSessionRuntimeStateFromUpdate,
  normalizeAcpRuntimeCapabilities,
} from "./acp-runtime-capabilities.js";
import {
  normalizeGrokBillingStatus,
  type AcpProviderStatus,
} from "./acp-provider-status.js";
import {
  readAcpToolCommand,
  readAcpToolContentCommand,
  readAcpToolText,
} from "./acp-command-extraction.js";
import type {
  AcpSessionMetadata,
  AcpSessionStore,
} from "./acp-session-store.js";
import {
  isPwrAgentSyntheticAcpUpdate,
  type AcpRolloutRecord,
  type AcpRolloutStoreAppendParams,
} from "./acp-rollout-store.js";
import {
  foldAcpTurnUsage,
  readAcpSelectedModel,
  readAcpUsageEnvelope,
  type AcpTokenUsage,
} from "./acp-usage.js";
import type { JsonRpcId } from "@pwrdrvr/agent-transport";
import { getMainLogger } from "../log.js";

const acpClientLog = getMainLogger("pwragent:acp-client");

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
const ACP_PROVIDER_STATUS_REQUEST_TIMEOUT_MS = 20_000;

export type AcpMcpServerConfig =
  | {
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      headers: Array<{
        name: string;
        value: string;
      }>;
    };

export type AcpMcpServerRegistration = {
  servers: AcpMcpServerConfig[];
  bindThread?: (threadId: string) => Promise<void> | void;
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
  activeAssistantMessagePhase?: AppServerTranscriptPhase;
  assistantText: string;
  assistantMessageSequence: number;
  turnId: string;
};

type AcpSessionLoadState = {
  lastTimestampedTranscriptAt?: number;
  replayedTranscript: boolean;
  suppressTranscriptReplay: boolean;
};

type AcpSessionLoadReplay = {
  lastTimestampedTranscriptAt?: number;
};

type AcpSessionMetadataUpdateOptions = {
  touchActivity?: boolean;
};

type AcpSuppressedControlPrompt = {
  fallbackOutputText?: string;
  finalTextChunks: string[];
  model?: string;
  tokenUsage?: AcpTokenUsage;
};

type AcpHydratedSessionHistory = {
  isComplete: boolean;
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
    fromSessionLoad?: boolean;
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
    fromSessionLoad?: boolean;
    sessionId?: string;
    runtimeCapabilities: BackendAcpRuntimeCapabilities;
    runtimeState?: BackendAcpSessionRuntimeState;
  }) => Promise<void> | void;
  onSessionRuntimeStateChange?: (event: {
    fromSessionLoad?: boolean;
    sessionId: string;
    runtimeState: BackendAcpSessionRuntimeState;
  }) => Promise<void> | void;
  onRequest?: (
    request: AppServerPendingRequestNotification
  ) => Promise<unknown> | unknown;
  mcpServers?: (context: {
    backendId: AcpBackendId;
    cwd: string;
    runtimeCapabilities?: BackendAcpRuntimeCapabilities;
    sessionId?: string;
  }) =>
    | AcpMcpServerConfig[]
    | AcpMcpServerRegistration
    | Promise<AcpMcpServerConfig[] | AcpMcpServerRegistration>;
};

export class AcpAgentClient {
  private readonly normalizers = new Map<string, AcpSessionReplayNormalizer>();
  private readonly activeTurns = new Map<string, AcpActiveTurn>();
  private readonly loadedSessionCwds = new Map<string, string | undefined>();
  private readonly suppressedControlPromptSessions = new Map<
    string,
    AcpSuppressedControlPrompt
  >();
  private readonly loadingSessions = new Map<string, AcpSessionLoadState>();
  private readonly sessionLoadReplays = new Map<string, AcpSessionLoadReplay>();
  private readonly agentSessionIdsByAppSessionId = new Map<string, string>();
  private readonly appSessionIdsByAgentSessionId = new Map<string, string>();
  private readonly now: () => number;
  private readonly approvalRequesterName: string;
  private unsubscribe?: () => void;
  private unsubscribeRequest?: () => void;
  private runtimeCapabilities?: BackendAcpRuntimeCapabilities;
  private readonly surfaceThoughtsAsMessages: boolean;

  constructor(private readonly options: AcpAgentClientOptions) {
    this.now = options.now ?? Date.now;
    this.runtimeCapabilities = options.initialRuntimeCapabilities;
    this.approvalRequesterName = approvalRequesterNameForOptions(options);
    this.surfaceThoughtsAsMessages = shouldSurfaceAcpThoughtsAsMessages(
      options.backendId,
    );
  }

  async initialize(): Promise<void> {
    this.unsubscribe = this.options.transport.onNotification((method, params) => {
      if (method === "session/update") {
        this.applySessionUpdate(params);
        return;
      }
      // Grok's vendor notification carries the auto-generated session
      // summary at the end of the first turn. Its envelope shape matches
      // session/update (`{ sessionId, update: { sessionUpdate, ... } }`), so
      // the same dispatch path handles it — readAcpTopicTitle picks the
      // title out of the "session_summary_generated" kind, and the
      // normalizer treats the inner update as thread metadata rather than
      // a transcript entry (see acp-session-normalizer.ts:118).
      if (method === "_x.ai/session_notification") {
        // Log the raw shape at debug so a future Grok CLI release that
        // renames the kind or moves the title field surfaces visibly
        // instead of silently degrading to "ACP session" forever. Kept
        // off the info channel because this fires once per turn-end.
        const update = (params as { update?: { sessionUpdate?: string } })
          .update;
        acpClientLog.debug("grok vendor notification", {
          backendId: this.options.backendId,
          sessionUpdate: update?.sessionUpdate,
          hasSummary: Boolean(
            (update as { session_summary?: string } | undefined)
              ?.session_summary?.trim()
              || (update as { sessionSummary?: string } | undefined)
                ?.sessionSummary?.trim(),
          ),
        });
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

  async readProviderStatus(): Promise<AcpProviderStatus | undefined> {
    if (this.options.backendId !== "acp:grok") {
      return undefined;
    }
    // ACP serializes extension methods with a leading underscore on the wire.
    // Grok's internal ExtRequest names this `x.ai/billing`, but stdio clients
    // must send `_x.ai/billing`.
    const result = await this.options.transport.request(
      "_x.ai/billing",
      {},
      ACP_PROVIDER_STATUS_REQUEST_TIMEOUT_MS,
    );
    return normalizeGrokBillingStatus(result);
  }

  async startSession(params: {
    sessionId?: string;
    cwd?: string;
    executionMode: ThreadExecutionMode;
    title?: string;
    createdAt?: number;
    acpRuntime?: BackendAcpSessionRuntimeState;
    hidden?: boolean;
    mcpServers?: "default" | "none";
    sessionMeta?: Record<string, unknown>;
  }): Promise<AcpSessionMetadata> {
    const cwd = params.cwd ?? process.cwd();
    const mcpRegistration =
      params.mcpServers === "none"
        ? { servers: [] }
        : await this.buildMcpServers({
            cwd,
            sessionId: params.sessionId,
          });
    const result = await this.options.transport.request("session/new", {
      cwd,
      mcpServers: mcpRegistration.servers,
      ...(params.sessionMeta ? { _meta: params.sessionMeta } : {}),
    });
    const now = this.now();
    const record = asRecord(result);
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "session-new",
      result,
    });
    const runtimeState = acpSessionRuntimeStateFromResponse(result, now);
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
      ...(params.hidden ? { hidden: true } : {}),
      status: "idle",
    };
    this.options.store.upsertSession(metadata);
    this.rememberSessionIds(metadata);
    this.loadedSessionCwds.set(sessionId, cwd);
    await Promise.resolve(mcpRegistration.bindThread?.(appSessionId));
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
      waitingForAgent: true,
    });
    this.appendHistoryUpdate(params.sessionId, receivedAt, {
      kind: "pwragent_user_prompt",
      prompt: params.prompt,
      ...(params.parts?.length ? { parts: params.parts } : {}),
      turnId,
      waitingForAgent: true,
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
      this.finishTrackedTurn(params.sessionId, this.now());
      this.recordPromptFailure(params.sessionId, turnId, error);
      throw error;
    }
    const finishedAt = this.now();
    this.finishTrackedTurn(params.sessionId, finishedAt);
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
    this.rememberSessionIds(metadata);
    const storedMetadata =
      this.options.store.getSession(this.options.backendId, metadata.sessionId) ??
      metadata;
    if (this.supportsSessionLoad() && this.isSessionLoaded(storedMetadata)) {
      const replay = this.normalizers.get(metadata.sessionId)?.replay();
      if (replay && (replay.entries.length > 0 || replay.messages.length > 0)) {
        return this.replayForSessionMetadata(storedMetadata);
      }
    }
    this.options.store.upsertSession(metadata);
    const localHistory = this.hydrateSessionFromHistory(metadata);
    const fallbackNormalizer = this.normalizers.get(metadata.sessionId);
    const hydratedMetadata =
      this.options.store.getSession(this.options.backendId, metadata.sessionId) ??
      metadata;
    if (this.supportsSessionLoad()) {
      const protocolSessionId = this.protocolSessionIdFor(metadata.sessionId);
      this.sessionLoadReplays.delete(protocolSessionId);
      // Give session/load a clean normalizer only when the fallback already
      // holds a complete transcript. An incomplete fallback still contributes
      // timestamps that providers such as Kimi do not send, so it must merge
      // with the incoming replay instead.
      if (localHistory.isComplete) {
        this.normalizers.delete(metadata.sessionId);
      }
      await this.ensureSession(hydratedMetadata, {
        suppressTranscriptReplay: false,
      });
      const sessionLoadReplay = this.sessionLoadReplays.get(protocolSessionId);
      if (
        sessionLoadReplay?.lastTimestampedTranscriptAt !== undefined ||
        (!localHistory.isComplete && sessionLoadReplay)
      ) {
        return this.replayForSessionMetadata(
          this.options.store.getSession(
            this.options.backendId,
            metadata.sessionId,
          ) ?? metadata,
        );
      }
      if (fallbackNormalizer) {
        this.normalizers.set(metadata.sessionId, fallbackNormalizer);
      }
    }
    return this.replayForSessionMetadata(
      this.options.store.getSession(this.options.backendId, metadata.sessionId) ??
        metadata,
    );
  }

  async refreshSession(metadata: AcpSessionMetadata): Promise<void> {
    await this.ensureSession(metadata);
  }

  async ensureSession(
    metadata: AcpSessionMetadata,
    options: { suppressTranscriptReplay?: boolean } = {},
  ): Promise<void> {
    this.rememberSessionIds(metadata);
    if (this.supportsSessionLoad() && this.isSessionLoaded(metadata)) {
      return;
    }
    this.options.store.upsertSession(metadata);
    if (!this.supportsSessionLoad()) {
      return;
    }
    await this.loadSessionFromAgent(metadata, options);
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
      waitingForAgent: true,
    });
    this.appendHistoryUpdate(params.sessionId, receivedAt, {
      kind: "pwragent_user_prompt",
      prompt: params.prompt,
      ...(params.parts?.length ? { parts: params.parts } : {}),
      turnId,
      waitingForAgent: true,
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
        const receivedAt = this.now();
        const finished = this.finishTrackedTurn(params.sessionId, receivedAt);
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
        this.finishTrackedTurn(params.sessionId, this.now());
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
  }): Promise<{
    text: string;
    model?: string;
    tokenUsage?: AcpSuppressedControlPrompt["tokenUsage"];
  }> {
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const selectedModel = readAcpSelectedModel(
      this.options.store.getSession(this.options.backendId, params.sessionId)
        ?.acpRuntime,
    );
    const suppression: AcpSuppressedControlPrompt = {
      finalTextChunks: [],
      ...(selectedModel ? { model: selectedModel } : {}),
    };
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
      return {
        text:
          suppression.finalTextChunks.join("").trim() ||
          suppression.fallbackOutputText?.trim() ||
          "",
        ...(suppression.model ? { model: suppression.model } : {}),
        ...(suppression.tokenUsage
          ? { tokenUsage: suppression.tokenUsage }
          : {}),
      };
    } finally {
      this.suppressedControlPromptSessions.delete(protocolSessionId);
    }
  }

  async setRuntimeOption(params: {
    sessionId: string;
    source: BackendAcpRuntimeOptionSource;
    optionId: string;
    value: string;
    reasoningEffort?: string;
  }): Promise<BackendAcpSessionRuntimeState | undefined> {
    const protocolSessionId = this.protocolSessionIdFor(params.sessionId);
    const result = await this.setRuntimeOptionOnTransport({
      protocolSessionId,
      source: params.source,
      optionId: params.optionId,
      value: params.value,
      reasoningEffort: params.reasoningEffort,
    });
    const now = this.now();
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "session-load",
      result,
    });
    const responseRuntimeState = acpSessionRuntimeStateFromResponse(result, now);
    const modelConfigOption = this.runtimeConfigOption("model");
    const thoughtLevelConfigOption = this.runtimeConfigOption("thought_level");
    const requestedRuntimeState: BackendAcpSessionRuntimeState =
      params.source === "configOption"
        ? {
            configValues: { [params.optionId]: params.value },
            ...(this.isRuntimeModeConfigOption(params.optionId)
              ? { currentModeId: params.value }
              : {}),
            updatedAt: now,
          }
        : params.source === "mode"
          ? {
              currentModeId: params.value,
              updatedAt: now,
            }
          : {
              currentModelId: params.value,
              ...(modelConfigOption
                ? {
                    configValues: {
                      [modelConfigOption.id]: params.value,
                      ...(params.reasoningEffort && thoughtLevelConfigOption
                        ? {
                            [thoughtLevelConfigOption.id]:
                              params.reasoningEffort,
                          }
                        : {}),
                    },
                  }
                : {}),
              reasoningEffort:
                responseRuntimeState?.reasoningEffort ??
                params.reasoningEffort,
              updatedAt: now,
            };
    const runtimeState = mergeAcpRuntimeState(
      responseRuntimeState ?? { updatedAt: now },
      requestedRuntimeState,
    );
    this.updateSessionRuntimeState(params.sessionId, runtimeState);
    this.notifyRuntimeCapabilities({
      sessionId: params.sessionId,
      runtimeCapabilities,
      runtimeState,
    });
    return runtimeState;
  }

  private isRuntimeModeConfigOption(optionId: string): boolean {
    return (
      this.runtimeConfigOption("mode")?.id === optionId
    );
  }

  private runtimeConfigOption(
    category: string,
  ): BackendAcpRuntimeConfigOption | undefined {
    return this.runtimeCapabilities?.configOptions?.find(
      (option) => option.category === category,
    );
  }

  private async setRuntimeOptionOnTransport(params: {
    protocolSessionId: string;
    source: BackendAcpRuntimeOptionSource;
    optionId: string;
    value: string;
    reasoningEffort?: string;
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

    const modelConfigOption = this.runtimeConfigOption("model");
    if (modelConfigOption) {
      let result = await this.options.transport.request(
        "session/set_config_option",
        {
          sessionId: params.protocolSessionId,
          configId: modelConfigOption.id,
          value: params.value,
        },
      );
      const thoughtLevelConfigOption =
        this.runtimeConfigOption("thought_level");
      if (params.reasoningEffort && thoughtLevelConfigOption) {
        result = await this.options.transport.request(
          "session/set_config_option",
          {
            sessionId: params.protocolSessionId,
            configId: thoughtLevelConfigOption.id,
            value: params.reasoningEffort,
          },
        );
      }
      return result;
    }

    return await this.options.transport.request("session/set_model", {
      sessionId: params.protocolSessionId,
      modelId: params.value,
      ...(params.reasoningEffort
        ? { _meta: { reasoningEffort: params.reasoningEffort } }
        : {}),
    });
  }

  readReplay(sessionId: string): AppServerThreadReplay {
    return this.normalizerFor(sessionId).replay();
  }

  didSessionLoadReplayHistory(sessionId: string): boolean {
    return this.sessionLoadReplays.has(this.protocolSessionIdFor(sessionId));
  }

  private applySessionUpdate(params: Record<string, unknown>): void {
    const protocolSessionId =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    const update = withAcpSessionUpdateEnvelopeMetadata(
      asRecord(params.update),
      asRecord(params._meta),
    );
    if (!protocolSessionId || !update) {
      return;
    }
    const suppressedControlPrompt =
      this.suppressedControlPromptSessions.get(protocolSessionId);
    if (suppressedControlPrompt) {
      const updateKind = readUpdateKind(update);
      if (updateKind === "agent_message_chunk") {
        const text = readUpdateText(update);
        if (text) {
          suppressedControlPrompt.finalTextChunks.push(text);
        }
      } else if (
        updateKind === "turn_finished" &&
        suppressedControlPrompt.finalTextChunks.length === 0
      ) {
        const text = readUpdateText(update);
        if (text) {
          suppressedControlPrompt.fallbackOutputText = text;
        }
      }
      const usage = readAcpUsageEnvelope(update);
      if (usage) {
        suppressedControlPrompt.tokenUsage = foldAcpTurnUsage(
          suppressedControlPrompt.tokenUsage,
          usage,
        );
        suppressedControlPrompt.model =
          usage.model ?? suppressedControlPrompt.model;
      }
      return;
    }
    const sessionId = this.appSessionIdFor(protocolSessionId);
    const receivedAt = this.now();
    const activityAt = readAcpUpdateTimestamp(update) ?? receivedAt;
    const loadState = this.loadingSessions.get(protocolSessionId);
    const isExplicitSessionReplay = isAcpSessionReplayUpdate(update);
    const fromSessionLoad = loadState !== undefined || isExplicitSessionReplay;
    const activeTurn = this.activeTurns.get(sessionId);
    const updateKind = readUpdateKind(update);
    if (isProviderTranscriptReplayUpdate(update)) {
      if (loadState) {
        loadState.replayedTranscript = true;
        if (readAcpUpdateTimestamp(update) !== undefined) {
          loadState.lastTimestampedTranscriptAt = Math.max(
            loadState.lastTimestampedTranscriptAt ?? 0,
            activityAt,
          );
        }
      } else if (isExplicitSessionReplay) {
        const existing = this.sessionLoadReplays.get(protocolSessionId);
        this.sessionLoadReplays.set(protocolSessionId, {
          ...(existing ?? {}),
          ...(readAcpUpdateTimestamp(update) !== undefined
            ? {
                lastTimestampedTranscriptAt: Math.max(
                  existing?.lastTimestampedTranscriptAt ?? 0,
                  activityAt,
                ),
              }
            : {}),
        });
      }
    }
    const runtimeState = acpSessionRuntimeStateFromUpdate(update, activityAt);
    if (runtimeState) {
      this.updateSessionRuntimeState(sessionId, runtimeState, {
        touchActivity: !fromSessionLoad,
      });
      void Promise.resolve(
        this.options.onSessionRuntimeStateChange?.({
          ...(fromSessionLoad ? { fromSessionLoad: true } : {}),
          sessionId,
          runtimeState,
        }),
      ).catch(() => undefined);
      return;
    }
    if (loadState?.suppressTranscriptReplay && isTranscriptReplayUpdate(update)) {
      return;
    }
    if (updateKind === "available_commands_update") {
      this.updateSessionAvailableCommands(sessionId, update, activityAt, {
        // Providers refresh command capabilities during and immediately after
        // session/load. Capability metadata is not conversation activity,
        // even when a late notification no longer carries replay provenance.
        touchActivity: false,
      });
    }
    if (updateKind === "turn_started") {
      this.updateSessionStatus(sessionId, "active", activityAt, {
        touchActivity: !fromSessionLoad,
      });
    } else if (
      updateKind === "turn_finished" ||
      updateKind === "pwragent_turn_failed" ||
      (updateKind === "turn_completed" && activeTurn === undefined)
    ) {
      this.updateSessionStatus(sessionId, "idle", activityAt, {
        touchActivity: !fromSessionLoad,
      });
    }
    const title = this.updateSessionTitleFromAcpUpdate(
      sessionId,
      update,
      activityAt,
      { touchActivity: !fromSessionLoad },
    );
    if (isConversationHistoryUpdate(update)) {
      this.markSessionHasConversationHistory(sessionId, activityAt, {
        touchActivity: !fromSessionLoad,
      });
    }
    if (!fromSessionLoad) {
      this.appendHistoryUpdate(sessionId, receivedAt, update);
    }
    const isAssistantTextUpdate =
      updateKind === "agent_message_chunk" || updateKind === "agent_thought_chunk";
    const shouldTrackAssistantTextUpdate =
      updateKind === "agent_message_chunk" ||
      (updateKind === "agent_thought_chunk" && this.surfaceThoughtsAsMessages);
    const text = readUpdateText(update);
    let assistantMessageItemId: string | undefined;
    if (shouldTrackAssistantTextUpdate && activeTurn && text) {
      const phase: AppServerTranscriptPhase =
        updateKind === "agent_thought_chunk" ? "commentary" : "final";
      assistantMessageItemId = assistantMessageItemIdForUpdate({
        activeTurn,
        phase,
        update,
      });
      if (updateKind === "agent_message_chunk") {
        activeTurn.assistantText += text;
      }
    } else if (
      !isAssistantTextUpdate
      && activeTurn
      && !isGrokTransientUpdateKind(updateKind)
    ) {
      activeTurn.activeAssistantMessageItemId = undefined;
      activeTurn.activeAssistantMessagePhase = undefined;
    }
    const replay = this.normalizerFor(sessionId).apply({
      sessionId,
      update,
      receivedAt,
      deferTurnCompletion:
        updateKind === "turn_completed" && activeTurn !== undefined,
    } satisfies AcpSessionUpdate);
    void this.notifySessionUpdate({
      assistantMessageItemId,
      ...(fromSessionLoad ? { fromSessionLoad: true } : {}),
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
    const command = permissionCommand(title, toolCall);

    return {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: sessionId,
        ...(activeTurn?.turnId ? { turnId: activeTurn.turnId } : {}),
        requestId,
        prompt: permissionPrompt(this.approvalRequesterName, title, toolCall),
        reason: permissionPrompt(this.approvalRequesterName, title, toolCall),
        command,
        displayCommand: command,
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
      normalizer = new AcpSessionReplayNormalizer({
        surfaceThoughtsAsMessages: this.surfaceThoughtsAsMessages,
      });
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

  private hydrateSessionFromHistory(
    metadata: AcpSessionMetadata,
  ): AcpHydratedSessionHistory {
    if (!this.options.rolloutStore) {
      return { isComplete: false };
    }
    const normalizer = new AcpSessionReplayNormalizer({
      surfaceThoughtsAsMessages: this.surfaceThoughtsAsMessages,
    });
    let hasTranscriptHistory = false;
    const records = this.options.rolloutStore.readUpdates({
      backendId: this.options.backendId,
      sessionId: metadata.sessionId,
    });
    for (const record of records) {
      if (isPwrAgentSyntheticAcpUpdate(record.update)) {
        continue;
      }
      if (isTranscriptReplayUpdate(record.update)) {
        hasTranscriptHistory = true;
      }
      normalizer.apply({
        sessionId: metadata.sessionId,
        receivedAt: record.receivedAt,
        update: record.update,
      });
    }
    this.normalizers.set(metadata.sessionId, normalizer);
    const replay = normalizer.replay();
    const hasReplay = replay.messages.length > 0 || replay.entries.length > 0;
    return {
      isComplete: (hasTranscriptHistory || hasReplay) && replay.threadStatus === "idle",
    };
  }

  private markSessionHasConversationHistory(
    sessionId: string,
    receivedAt: number,
    options: AcpSessionMetadataUpdateOptions = {},
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata || metadata.hasConversationHistory) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      hasConversationHistory: true,
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, receivedAt),
    });
  }

  private updateSessionAvailableCommands(
    sessionId: string,
    update: Record<string, unknown>,
    receivedAt: number,
    options: AcpSessionMetadataUpdateOptions = {},
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      availableCommands: normalizeAvailableCommandsUpdate(
        update,
        this.options.backendId,
      ),
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, receivedAt),
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
    fromSessionLoad?: boolean;
    sessionId?: string;
    runtimeCapabilities?: BackendAcpRuntimeCapabilities;
    runtimeState?: BackendAcpSessionRuntimeState;
  }): void {
    if (!event.runtimeCapabilities) {
      return;
    }
    void Promise.resolve(
      this.options.onRuntimeCapabilities?.({
        ...(event.fromSessionLoad ? { fromSessionLoad: true } : {}),
        sessionId: event.sessionId,
        runtimeCapabilities: event.runtimeCapabilities,
        runtimeState: event.runtimeState,
      }),
    ).catch(() => undefined);
  }

  private updateSessionRuntimeState(
    sessionId: string,
    runtimeState: BackendAcpSessionRuntimeState,
    options: AcpSessionMetadataUpdateOptions = {},
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      acpRuntime: mergeAcpRuntimeState(metadata.acpRuntime, runtimeState),
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, runtimeState.updatedAt ?? this.now()),
    });
  }

  private async notifySessionUpdate(event: {
    assistantMessageItemId?: string;
    fromSessionLoad?: boolean;
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

  private async loadSessionFromAgent(
    metadata: AcpSessionMetadata,
    options: { suppressTranscriptReplay?: boolean } = {},
  ): Promise<unknown> {
    if (!this.supportsSessionLoad()) {
      return undefined;
    }
    const cwd = metadata.cwd ?? process.cwd();
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    const mcpRegistration = await this.buildMcpServers({
      cwd,
      sessionId: metadata.sessionId,
    });
    const loadState: AcpSessionLoadState = {
      replayedTranscript: false,
      suppressTranscriptReplay: options.suppressTranscriptReplay === true,
    };
    this.loadingSessions.set(protocolSessionId, loadState);
    let result: unknown;
    try {
      result = await this.options.transport.request("session/load", {
        cwd,
        mcpServers: mcpRegistration.servers,
        sessionId: protocolSessionId,
      });
    } finally {
      this.loadingSessions.delete(protocolSessionId);
      if (loadState.replayedTranscript) {
        this.sessionLoadReplays.set(protocolSessionId, {
          ...(loadState.lastTimestampedTranscriptAt !== undefined
            ? {
                lastTimestampedTranscriptAt:
                  loadState.lastTimestampedTranscriptAt,
              }
            : {}),
        });
      }
    }
    const runtimeCapabilities = this.captureRuntimeCapabilities({
      source: "session-load",
      result,
    });
    await Promise.resolve(mcpRegistration.bindThread?.(metadata.sessionId));
    const runtimeState = acpSessionRuntimeStateFromResponse(result, this.now());
    if (runtimeState) {
      this.updateSessionRuntimeState(metadata.sessionId, runtimeState, {
        touchActivity: false,
      });
      void Promise.resolve(
        this.options.onSessionRuntimeStateChange?.({
          fromSessionLoad: true,
          sessionId: metadata.sessionId,
          runtimeState,
        }),
      ).catch(() => undefined);
    }
    this.notifyRuntimeCapabilities({
      fromSessionLoad: true,
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

  private isSessionLoaded(metadata: AcpSessionMetadata): boolean {
    const cwd = metadata.cwd ?? process.cwd();
    const protocolSessionId = protocolSessionIdForMetadata(metadata);
    return (
      this.loadedSessionCwds.has(protocolSessionId) &&
      this.loadedSessionCwds.get(protocolSessionId) === cwd
    );
  }

  private async buildMcpServers(params: {
    cwd: string;
    sessionId?: string;
  }): Promise<AcpMcpServerRegistration> {
    const registration = await this.options.mcpServers?.({
      backendId: this.options.backendId,
      cwd: params.cwd,
      runtimeCapabilities: this.runtimeCapabilities,
      sessionId: params.sessionId,
    });
    return Array.isArray(registration)
      ? { servers: registration }
      : registration ?? { servers: [] };
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

  private finishTrackedTurn(sessionId: string, completedAt: number): {
    assistantText: string;
    replay: AppServerThreadReplay;
    turnId?: string;
  } {
    const activeTurn = this.activeTurns.get(sessionId);
    this.activeTurns.delete(sessionId);
    const replay = this.normalizerFor(sessionId).recordTurnFinished(
      activeTurn?.turnId,
      completedAt,
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
    const verifiedReplay = this.sessionLoadReplays.get(
      this.protocolSessionIdFor(sessionId),
    );
    // Keep a durable fallback until this exact session has successfully
    // replayed timestamped provider history. An advertised capability alone
    // cannot prove that session/load returned usable transcript history, and
    // providers such as Kimi still need the local timestamps they omit.
    if (verifiedReplay?.lastTimestampedTranscriptAt !== undefined) {
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
    receivedAt = this.now(),
    options: AcpSessionMetadataUpdateOptions = {},
  ): void {
    const metadata = this.options.store.getSession(this.options.backendId, sessionId);
    if (!metadata) {
      return;
    }
    this.options.store.upsertSession({
      ...metadata,
      status,
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, receivedAt),
    });
  }

  private updateSessionTitleFromAcpUpdate(
    sessionId: string,
    update: Record<string, unknown>,
    receivedAt: number,
    options: AcpSessionMetadataUpdateOptions = {},
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
      updatedAt:
        options.touchActivity === false
          ? metadata.updatedAt
          : Math.max(metadata.updatedAt, receivedAt),
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

function withAcpSessionUpdateEnvelopeMetadata(
  update: Record<string, unknown> | undefined,
  envelopeMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!update || !envelopeMeta) {
    return update;
  }
  const updateMeta = asRecord(update._meta);
  return {
    ...update,
    _meta: {
      ...envelopeMeta,
      ...updateMeta,
    },
  };
}

function readUpdateKind(update: Record<string, unknown>): string | undefined {
  const kind =
    update.sessionUpdate ?? update.session_update ?? update.kind ?? update.type;
  return typeof kind === "string" ? kind : undefined;
}

function isAcpSessionReplayUpdate(update: Record<string, unknown>): boolean {
  const meta = asRecord(update._meta);
  return meta?.isReplay === true || meta?.is_replay === true;
}

function isProviderTranscriptReplayUpdate(
  update: Record<string, unknown>,
): boolean {
  if (!isTranscriptReplayUpdate(update)) {
    return false;
  }
  return (
    readUpdateKind(update) !== "user_message_chunk" ||
    !isAcpUserBoilerplateMessage(readUpdateText(update))
  );
}

function isConversationHistoryUpdate(update: Record<string, unknown>): boolean {
  const kind = readUpdateKind(update);
  return (
    kind === "pwragent_user_prompt" ||
    kind === "user_message_chunk" ||
    kind === "agent_message_chunk" ||
    kind === "agent_thought_chunk"
  );
}

function isTranscriptReplayUpdate(update: Record<string, unknown>): boolean {
  const kind = readUpdateKind(update);
  return (
    isConversationHistoryUpdate(update) ||
    kind === "plan" ||
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "file" ||
    kind === "terminal" ||
    kind === "turn_completed" ||
    kind === "turn_finished" ||
    kind === "pwragent_turn_failed"
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

function normalizeAvailableCommandsUpdate(
  update: Record<string, unknown>,
  backend: AcpBackendId,
): AppServerAvailableCommandSummary[] {
  const rawCommands = Array.isArray(update.availableCommands)
    ? update.availableCommands
    : Array.isArray(update.available_commands)
      ? update.available_commands
      : [];
  const commands = new Map<string, AppServerAvailableCommandSummary>();

  for (const rawCommand of rawCommands) {
    const command = asRecord(rawCommand);
    const name = readNonEmptyString(command, "name");
    if (!name) {
      continue;
    }
    const description = readNonEmptyString(command, "description");
    const aliases = readStringArray(command?.aliases);
    commands.set(name, {
      name,
      backend,
      scope: "session",
      source: "provider",
      ...(description ? { description } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
    });
  }

  return [...commands.values()];
}

function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
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
  if (
    contentText &&
    (!readAcpToolContentCommand(toolCall) || isApprovalPromptText(contentText))
  ) {
    return contentText;
  }
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : undefined;
  return kind
    ? `${requesterName} wants to run ${kind}: ${title}`
    : `${requesterName} wants to run ${title}`;
}

function isApprovalPromptText(text: string): boolean {
  return /^Requesting approval to Running:\s*/imu.test(text);
}

function readToolCallText(value: unknown): string | undefined {
  return readAcpToolText(value);
}

function permissionCommand(
  title: string,
  toolCall: Record<string, unknown>,
): string {
  return readAcpToolCommand(toolCall) ?? title;
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
    normalizedDecision === "accept_for_session" ||
    normalizedDecision === "allow_always"
  ) {
    return (
      options.find((option) => option.kind === "allow_always") ??
      options.find((option) =>
        option.name?.toLowerCase().includes("always allow"),
      )
    )?.optionId;
  }

  if (normalizedDecision === "accept_with_execpolicy_amendment") {
    return (
      options.find(
        (option) =>
          option.kind === "allow_always" &&
          option.optionId.toLowerCase().includes("command"),
      ) ??
      options.find((option) => option.kind === "allow_always")
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
  phase: AppServerTranscriptPhase;
  update: Record<string, unknown>;
}): string {
  if (params.activeTurn.activeAssistantMessagePhase !== params.phase) {
    params.activeTurn.activeAssistantMessageItemId = undefined;
    params.activeTurn.activeAssistantMessagePhase = params.phase;
  }
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
