import path from "node:path";
import {
  type AcpBackendId,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerPendingRequestNotification,
  type AppServerThreadMessagePart,
  type AppServerThreadReplay,
  type AppServerThreadStatus,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type BackendAcpRuntimeCapabilities,
  type BackendAcpSessionRuntimeState,
  type BackendCapabilities,
  type BackendLaunchpadOptions,
  type BackendModelOption,
  type BackendSummary,
  isAcpBackendId,
} from "@pwragent/shared";
import {
  AcpAgentStore,
  type AcpAgentStore as AcpAgentStoreLike,
} from "../acp/acp-agent-store";
import { isBannedAcpRegistryId } from "../acp/acp-agent-allowlist";
import {
  acpAgentCapabilitiesForRegistryId,
  type AcpAgentCapabilities,
} from "../acp/acp-agent-capabilities";
import {
  AcpAgentClient,
  type AcpPromptContentBlock,
} from "../acp/acp-client";
import { discoverLocalAcpAgents } from "../acp/acp-local-discovery";
import { acpToolUpdateNotifications } from "../acp/acp-live-notifications";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import {
  acpRuntimeSupportsSessionLoad,
  acpSessionRuntimeStateFromUpdate,
} from "../acp/acp-runtime-capabilities";
import {
  AcpSessionStore,
  type AcpSessionMetadata,
  type AcpSessionStore as AcpSessionStoreContract,
} from "../acp/acp-session-store";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";
import { getMainLogger } from "../log";
import { getAppStateDb, isAppStateInitialized } from "../state/app-state";
import type { ProtocolCaptureStore } from "../testing/capture-store";
import { createProtocolCaptureFromEnv } from "../testing/protocol-capture";
import {
  createCompositeJsonRpcObserver,
  createProtocolLogObserverFromEnv,
} from "./protocol-log-observer";

export type { AcpSessionMetadata };

export const ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR =
  "This ACP agent cannot hand off a workspace after the first message in a thread. Start a new thread in the target workspace instead.";

const acpBackendAdapterLog = getMainLogger("pwragent:acp-backend-adapter");

export type AcpRuntimeClient = Pick<
  AcpAgentClient,
  | "cancelSession"
  | "dispose"
  | "ensureSession"
  | "initialize"
  | "loadSession"
  | "readReplay"
  | "refreshSession"
  | "startPrompt"
  | "startSession"
> &
  Partial<Pick<AcpAgentClient, "setRuntimeOption">>;

export type AcpClientFactory = (agent: AcpInstalledAgentRecord) => AcpRuntimeClient;
export type LocalAcpDiscovery = () => Promise<AcpInstalledAgentRecord[]>;

export type AcpSessionStoreLike =
  Pick<AcpSessionStoreContract, "getSession" | "listSessions"> &
  Partial<Pick<AcpSessionStoreContract, "upsertSession">>;

export type AcpPromptPayload = {
  prompt: string;
  promptContent: AcpPromptContentBlock[];
  parts: AppServerThreadMessagePart[];
};

export type AcpBackendAdapterOptions = {
  acpAgentStore?: Pick<
    AcpAgentStoreLike,
    "getInstalledAgent" | "listInstalledAgents" | "upsertInstalledAgent"
  > | null;
  acpSessionStore?: AcpSessionStoreLike | null;
  captureStores: ProtocolCaptureStore[];
  createAcpClient?: AcpClientFactory;
  discoverLocalAcpAgents?: LocalAcpDiscovery;
  emit: (event: AgentEvent) => Promise<void>;
  handleServerRequest: (
    backend: AcpBackendId,
    request: AppServerPendingRequestNotification,
  ) => Promise<unknown>;
};

export function readAcpUpdateKind(
  update: Record<string, unknown>,
): string | undefined {
  const kind = update.sessionUpdate ?? update.kind ?? update.type;
  return typeof kind === "string" ? kind : undefined;
}

export function readAcpUpdateText(
  update: Record<string, unknown>,
): string | undefined {
  if (typeof update.text === "string") {
    return update.text;
  }
  if (typeof update.outputText === "string") {
    return update.outputText;
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

export function buildAcpCapabilities(): BackendCapabilities {
  return {
    listThreads: true,
    createThread: true,
    resumeThread: true,
    archiveThread: true,
    restoreThread: true,
    archiveWorktree: false,
    restoreWorktree: false,
    renameThread: true,
    readThread: true,
    startTurn: true,
    startReview: false,
    interruptTurn: true,
    steerTurn: false,
    transcriptPagination: false,
    toolUse: true,
    approvalRequests: true,
    multiDirectoryThreads: true,
  };
}

export function describeInstalledAcpBackend(
  agent: AcpInstalledAgentRecord,
): BackendSummary {
  const available =
    agent.installStatus === "installed" &&
    (agent.authStatus === "not-required" || agent.authStatus === "authenticated");
  const unavailableReason =
    available
      ? undefined
      : agent.lastError ??
        (agent.authStatus === "required"
          ? "ACP agent authentication required"
          : "ACP agent unavailable");

  return {
    kind: agent.backendId,
    source: "acp",
    label: agent.name,
    available,
    acp: {
      registryId: agent.registryId,
      version: agent.version,
      distributionKinds: [agent.distributionKind],
      installStatus: agent.installStatus,
      authStatus: agent.authStatus,
      verificationStatus: agent.verificationStatus,
      installedAt: agent.installedAt,
      updatedAt: agent.updatedAt,
      repositoryUrl: agent.registryAgent?.repositoryUrl,
      websiteUrl: agent.registryAgent?.websiteUrl,
      allowlistRuleId: agent.allowlistRuleId,
      license: agent.registryAgent?.license,
      runtime: agent.runtimeCapabilities,
    },
    methods: [
      "session/new",
      ...(acpRuntimeSupportsSessionLoad(agent.runtimeCapabilities)
        ? ["session/load"]
        : []),
      "session/prompt",
      "session/cancel",
    ],
    capabilities: buildAcpCapabilities(),
    executionModes: [],
    launchpadOptions: buildAcpLaunchpadOptions(agent.runtimeCapabilities),
    unavailableReason,
  };
}

export function buildAcpLaunchpadOptions(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
): BackendLaunchpadOptions | undefined {
  const modelOptions =
    runtimeCapabilities?.models?.availableModels.map(
      (model): BackendModelOption => ({
        id: model.id,
        label: model.label,
        current: runtimeCapabilities.models?.currentModelId === model.id,
      }),
    ) ?? [];
  const configModelOption =
    runtimeCapabilities?.configOptions
      ?.find((option) => option.category === "model")
      ?.values.map(
        (value): BackendModelOption => ({
          id: value.value,
          label: value.label,
          current: runtimeCapabilities.configOptions?.some(
            (option) =>
              option.category === "model" &&
              option.currentValue === value.value,
          ),
        }),
      ) ?? [];
  const models = modelOptions.length > 0 ? modelOptions : configModelOption;
  return models.length > 0 ? { models } : undefined;
}

export function findAcpModelConfigOption(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
) {
  return runtimeCapabilities?.configOptions?.find(
    (option) => option.category === "model",
  );
}

export function withAcpModelRuntimeSelection(params: {
  runtime: BackendAcpSessionRuntimeState | undefined;
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined;
  model: string | undefined;
  now: number;
}): BackendAcpSessionRuntimeState | undefined {
  const model = params.model?.trim();
  if (!model) {
    return params.runtime;
  }

  const modelConfigOption = findAcpModelConfigOption(params.runtimeCapabilities);
  const hasModelList = Array.isArray(params.runtimeCapabilities?.models?.availableModels);
  const hasAdvertisedModel =
    params.runtimeCapabilities?.models?.availableModels.some(
      (option) => option.id === model,
    ) ?? false;
  const shouldSetCurrentModelId =
    hasAdvertisedModel || (!modelConfigOption && !hasModelList);
  const configValues = modelConfigOption
    ? {
        ...(params.runtime?.configValues ?? {}),
        [modelConfigOption.id]: model,
      }
    : params.runtime?.configValues;

  return {
    ...params.runtime,
    ...(shouldSetCurrentModelId ? { currentModelId: model } : {}),
    ...(configValues ? { configValues } : {}),
    updatedAt: Math.max(params.runtime?.updatedAt ?? 0, params.now),
  };
}

export function mergeAcpRuntimeState(
  current: BackendAcpSessionRuntimeState | undefined,
  patch: BackendAcpSessionRuntimeState | undefined,
): BackendAcpSessionRuntimeState | undefined {
  if (!current && !patch) {
    return undefined;
  }
  return {
    ...current,
    ...patch,
    configValues: {
      ...(current?.configValues ?? {}),
      ...(patch?.configValues ?? {}),
    },
  };
}

export function acpRuntimeValueLooksPrivileged(value: string | undefined): boolean {
  return value === "yolo" || value === "autoEdit" || value === "auto_edit";
}

export function formatAcpRuntimeLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (trimmed.toLowerCase() === "yolo") {
    return "Yolo";
  }
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function acpSessionToThreadSummary(
  session: AcpSessionMetadata,
  capabilities?: AcpAgentCapabilities,
): AppServerThreadSummary {
  const workspaceHandoffAvailable =
    !acpSessionHasConversationHistory(session) ||
    capabilities?.liveWorkspaceHandoff === true;
  const acpRuntime = mergeAcpRuntimeState(
    session.acpRuntime,
    deriveAcpRuntimeStateFromTranscript(session),
  );
  return {
    id: session.sessionId,
    title: session.title,
    titleSource:
      session.titleSource ??
      (session.title === "ACP session" ? "fallback" : "derived"),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
    linkedDirectories: session.cwd
      ? [
          {
            id: session.cwd,
            label: path.basename(session.cwd) || session.cwd,
            path: session.cwd,
            kind: "local",
          },
        ]
      : [],
    source: session.backendId,
    executionMode: session.executionMode,
    acpRuntime,
    workspaceHandoff: workspaceHandoffAvailable
      ? { available: true }
      : {
          available: false,
          unavailableReason: ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR,
        },
  };
}

export function acpSessionLoadFallbackReplay(
  session: AcpSessionMetadata,
  error: unknown,
): AppServerThreadReplay {
  const persistedReplay = replayPersistedAcpTranscript(session);
  if (persistedReplay.entries.length > 0 || persistedReplay.messages.length > 0) {
    return persistedReplay;
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    entries: [
      {
        type: "activity",
        id: `acp-load-failed:${session.sessionId}`,
        createdAt: Date.now(),
        summary: "ACP transcript unavailable",
        status: "failed",
        details: [
          {
            id: `acp-load-failed:${session.sessionId}:detail`,
            kind: "read",
            label: message,
          },
        ],
      },
    ],
    messages: [],
    pagination: {
      supportsPagination: false,
      hasPreviousPage: false,
    },
    threadStatus: acpSessionThreadStatus(session.status),
  };
}

export function replayPersistedAcpTranscript(
  session: AcpSessionMetadata,
): AppServerThreadReplay {
  const normalizer = new AcpSessionReplayNormalizer();
  let replay = normalizer.replay();
  for (const item of session.transcriptUpdates ?? []) {
    replay = normalizer.apply({
      sessionId: session.sessionId,
      update: item.update,
      receivedAt: item.receivedAt,
    });
  }
  return {
    ...replay,
    threadStatus: acpSessionThreadStatus(session.status),
  };
}

export function deriveAcpRuntimeStateFromTranscript(
  session: AcpSessionMetadata,
): BackendAcpSessionRuntimeState | undefined {
  let runtimeState: BackendAcpSessionRuntimeState | undefined;
  for (const item of session.transcriptUpdates ?? []) {
    runtimeState = mergeAcpRuntimeState(
      runtimeState,
      acpSessionRuntimeStateFromUpdate(item.update, item.receivedAt),
    );
  }
  return runtimeState;
}

export function acpSessionThreadStatus(
  status: AcpSessionMetadata["status"],
): AppServerThreadStatus {
  return status === "active" || status === "idle" || status === "unknown"
    ? status
    : "unknown";
}

export function isAcpSessionMissingForProjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No previous sessions found for this project");
}

export function acpSessionHasConversationHistory(
  session: AcpSessionMetadata,
): boolean {
  return (session.transcriptUpdates ?? []).some((item) => {
    const kind = item.update.kind ?? item.update.type ?? item.update.sessionUpdate;
    return (
      kind === "pwragent_user_prompt" ||
      kind === "user_message_chunk" ||
      kind === "agent_message_chunk"
    );
  });
}

export function inputToAcpPrompt(
  input: AppServerTurnInputItem[],
): AcpPromptPayload | undefined {
  const promptContent: AcpPromptContentBlock[] = [];
  const parts: AppServerThreadMessagePart[] = [];

  for (const item of input) {
    if (item.type === "text") {
      const text = item.text.trim();
      if (text) {
        promptContent.push({ type: "text", text });
        parts.push({ type: "text", text });
      }
      continue;
    }

    if (item.type === "image") {
      parts.push({ type: "image", url: item.url });
      const image = parseImageDataUrl(item.url);
      if (image) {
        promptContent.push({
          type: "image",
          mimeType: image.mimeType,
          data: image.data,
        });
      } else {
        promptContent.push({ type: "text", text: "[Image attachment]" });
      }
      continue;
    }

    const fileName = path.basename(item.path);
    const text = `[Local image: ${fileName}]`;
    promptContent.push({ type: "text", text });
    parts.push({ type: "text", text });
  }

  if (promptContent.length === 0 && parts.length === 0) {
    return undefined;
  }

  return {
    prompt: parts
      .filter((part): part is Extract<AppServerThreadMessagePart, { type: "text" }> =>
        part.type === "text",
      )
      .map((part) => part.text)
      .join("\n"),
    promptContent,
    parts,
  };
}

function parseImageDataUrl(
  url: string,
): { mimeType: string; data: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/iu.exec(
    url,
  );
  if (!match) {
    return undefined;
  }
  return {
    mimeType: match[1],
    data: match[2],
  };
}

export class AcpBackendAdapter {
  private readonly acpAgentStore?: Pick<
    AcpAgentStoreLike,
    "getInstalledAgent" | "listInstalledAgents" | "upsertInstalledAgent"
  >;
  private readonly acpSessionStore?: AcpSessionStoreLike;
  private readonly captureStores: ProtocolCaptureStore[];
  private readonly createAcpClient: AcpClientFactory;
  private readonly discoverLocalAcpAgents: LocalAcpDiscovery;
  private readonly emit: (event: AgentEvent) => Promise<void>;
  private readonly handleServerRequest: (
    backend: AcpBackendId,
    request: AppServerPendingRequestNotification,
  ) => Promise<unknown>;
  private readonly acpClients = new Map<AcpBackendId, Promise<AcpRuntimeClient>>();
  private localAcpAgentsPromise?: Promise<AcpInstalledAgentRecord[]>;

  constructor(options: AcpBackendAdapterOptions) {
    this.captureStores = options.captureStores;
    this.emit = options.emit;
    this.handleServerRequest = options.handleServerRequest;
    this.acpAgentStore =
      options.acpAgentStore === null
        ? undefined
        : options.acpAgentStore ??
          (isAppStateInitialized()
            ? new AcpAgentStore(getAppStateDb())
            : undefined);
    this.acpSessionStore =
      options.acpSessionStore === null
        ? undefined
        : options.acpSessionStore ??
          (isAppStateInitialized()
            ? new AcpSessionStore(getAppStateDb())
            : undefined);
    this.discoverLocalAcpAgents =
      options.discoverLocalAcpAgents ?? discoverLocalAcpAgents;
    this.createAcpClient =
      options.createAcpClient ?? ((agent) => this.createDefaultClient(agent));
  }

  describeInstalledBackends(): Promise<BackendSummary[]> {
    return this.listAvailableAgents().then((installedAgents) =>
      installedAgents.map((agent) => describeInstalledAcpBackend(agent)),
    );
  }

  listSessions(
    backendId: AcpBackendId,
    options?: { archived?: boolean },
  ): AcpSessionMetadata[] {
    return this.acpSessionStore?.listSessions(backendId, options) ?? [];
  }

  getSession(
    backendId: AcpBackendId,
    sessionId: string,
  ): AcpSessionMetadata | undefined {
    return this.acpSessionStore?.getSession(backendId, sessionId);
  }

  upsertSession(session: AcpSessionMetadata): void {
    this.acpSessionStore?.upsertSession?.(session);
  }

  getInstalledAgent(backendId: AcpBackendId): AcpInstalledAgentRecord | undefined {
    return this.acpAgentStore?.getInstalledAgent(backendId);
  }

  sessionToThreadSummary(session: AcpSessionMetadata): AppServerThreadSummary {
    const agent = this.getInstalledAgent(session.backendId);
    const capabilities =
      agent?.capabilities ??
      (agent ? acpAgentCapabilitiesForRegistryId(agent.registryId) : undefined);
    return acpSessionToThreadSummary(session, capabilities);
  }

  getLaunchpadOptions(
    backend: AppServerBackendKind,
  ): BackendLaunchpadOptions | undefined {
    if (!isAcpBackendId(backend)) {
      return undefined;
    }
    return buildAcpLaunchpadOptions(
      this.acpAgentStore?.getInstalledAgent(backend)?.runtimeCapabilities,
    );
  }

  async readReplay(
    backend: AcpBackendId,
    sessionId: string,
  ): Promise<AppServerThreadReplay> {
    const cachedClient = await this.acpClients.get(backend)?.catch(() => undefined);
    if (cachedClient) {
      return cachedClient.readReplay(sessionId);
    }

    const session = this.getSession(backend, sessionId);
    if (!session) {
      return new AcpSessionReplayNormalizer().replay();
    }

    if (
      !acpRuntimeSupportsSessionLoad(
        this.getInstalledAgent(backend)?.runtimeCapabilities,
      )
    ) {
      return replayPersistedAcpTranscript(session);
    }
    const client = await this.getClient(backend);
    try {
      const replay = await client.loadSession(session);
      void client.refreshSession(session).catch((error) => {
        acpBackendAdapterLog.warn("acp_session_load_failed", {
          backend,
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
      return replay;
    } catch (error) {
      acpBackendAdapterLog.warn("acp_session_load_failed", {
        backend,
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
      return acpSessionLoadFallbackReplay(session, error);
    }
  }

  async getClient(backend: AcpBackendId): Promise<AcpRuntimeClient> {
    const cached = this.acpClients.get(backend);
    if (cached) {
      return await cached;
    }

    const agent = await this.resolveInstalledAgent(backend);
    const clientPromise = (async () => {
      const client = this.createAcpClient(agent);
      await client.initialize();
      return client;
    })();
    this.acpClients.set(backend, clientPromise);
    clientPromise.catch(() => {
      if (this.acpClients.get(backend) === clientPromise) {
        this.acpClients.delete(backend);
      }
    });
    return await clientPromise;
  }

  async resolveInstalledAgent(
    backend: AcpBackendId,
  ): Promise<AcpInstalledAgentRecord> {
    const agent = (await this.listAvailableAgents()).find(
      (candidate) => candidate.backendId === backend,
    );
    if (!agent) {
      throw new Error(`ACP backend is not installed: ${backend}`);
    }
    if (agent.installStatus !== "installed") {
      throw new Error(`ACP backend is not installed: ${backend}`);
    }
    if (agent.authStatus !== "not-required" && agent.authStatus !== "authenticated") {
      throw new Error(`ACP backend authentication required: ${backend}`);
    }
    return agent;
  }

  async supportsLiveWorkspaceHandoff(backend: AcpBackendId): Promise<boolean> {
    const agent = await this.resolveInstalledAgent(backend);
    return (
      agent.capabilities ??
      acpAgentCapabilitiesForRegistryId(agent.registryId)
    ).liveWorkspaceHandoff;
  }

  async listAvailableAgents(): Promise<AcpInstalledAgentRecord[]> {
    const installedAgents = (this.acpAgentStore?.listInstalledAgents() ?? []).filter(
      (agent) => !isBannedAcpRegistryId(agent.registryId),
    );
    const installedBackendIds = new Set(
      installedAgents.map((agent) => agent.backendId),
    );
    const discoveredAgents = (await this.readLocalAgentsOnce()).filter(
      (agent) => !isBannedAcpRegistryId(agent.registryId),
    );
    for (const agent of discoveredAgents) {
      if (!installedBackendIds.has(agent.backendId)) {
        this.acpAgentStore?.upsertInstalledAgent(agent);
      }
    }
    return [
      ...installedAgents,
      ...discoveredAgents.filter(
        (agent) => !installedBackendIds.has(agent.backendId),
      ),
    ];
  }

  async close(): Promise<void> {
    const acpClients = [...this.acpClients.values()];
    this.acpClients.clear();
    await Promise.all(
      acpClients.map(async (clientPromise) => {
        const client = await clientPromise.catch(() => undefined);
        await client?.dispose();
      }),
    );
  }

  private async readLocalAgentsOnce(): Promise<AcpInstalledAgentRecord[]> {
    this.localAcpAgentsPromise ??= this.discoverLocalAcpAgents().catch((error) => {
      acpBackendAdapterLog.debug("local_acp_discovery_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    return await this.localAcpAgentsPromise;
  }

  private createDefaultClient(agent: AcpInstalledAgentRecord): AcpRuntimeClient {
    if (!agent.launchDescriptor) {
      throw new Error(`ACP backend ${agent.backendId} has no launch descriptor`);
    }
    if (!this.acpSessionStore?.upsertSession) {
      throw new Error("ACP session store is unavailable");
    }
    const acpCapture = createProtocolCaptureFromEnv({
      backend: agent.backendId,
      backendInstance: "default",
    });
    if (acpCapture) {
      this.captureStores.push(acpCapture.store);
    }
    return new AcpAgentClient({
      backendId: agent.backendId,
      initialRuntimeCapabilities: agent.runtimeCapabilities,
      store: this.acpSessionStore as AcpSessionStoreContract,
      transport: new AcpStdioJsonRpcTransport({
        launchDescriptor: agent.launchDescriptor,
        observer: createCompositeJsonRpcObserver([
          acpCapture?.observer,
          createProtocolLogObserverFromEnv({
            backend: agent.backendId,
          }),
        ]),
      }),
      onSessionUpdate: async ({ sessionId, replay, title, turnId, update }) => {
        const updateKind = readAcpUpdateKind(update);
        if (title) {
          await this.emit({
            backend: agent.backendId,
            notification: {
              method: "thread/name/updated",
              params: {
                threadId: sessionId,
                threadName: title,
              },
            },
          });
        }
        if (updateKind === "agent_message_chunk") {
          const delta = readAcpUpdateText(update);
          if (delta) {
            await this.emit({
              backend: agent.backendId,
              notification: {
                method: "item/agentMessage/delta",
                params: {
                  threadId: sessionId,
                  turnId,
                  itemId: `assistant:${turnId ?? sessionId}`,
                  delta,
                },
              },
            });
          }
        }
        for (const notification of acpToolUpdateNotifications({
          threadId: sessionId,
          turnId,
          update,
        })) {
          await this.emit({
            backend: agent.backendId,
            notification,
          });
        }
        if (updateKind === "turn_finished" && turnId) {
          const outputText = readAcpUpdateText(update);
          await this.emit({
            backend: agent.backendId,
            notification: {
              method: "turn/completed",
              params: {
                threadId: sessionId,
                turnId,
                turn: {
                  id: turnId,
                  status: "completed",
                  completedAt: Date.now(),
                  output: outputText ? [{ type: "text", text: outputText }] : [],
                },
              },
            },
          });
        }
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: sessionId,
              status: {
                type: replay.threadStatus ?? "unknown",
              },
            },
          },
        });
      },
      onPromptError: async ({ sessionId, turnId, error }) => {
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "turn/failed",
            params: {
              threadId: sessionId,
              turnId,
              turn: {
                id: turnId,
                status: "failed",
                completedAt: Date.now(),
                error: {
                  message: error instanceof Error ? error.message : String(error),
                },
              },
            },
          },
        });
      },
      onRuntimeCapabilities: async ({
        runtimeCapabilities,
        runtimeState,
        sessionId,
      }) => {
        const now = Date.now();
        const current = this.getInstalledAgent(agent.backendId) ?? agent;
        this.acpAgentStore?.upsertInstalledAgent({
          ...current,
          runtimeCapabilities,
          lastDiscoveredAt: runtimeCapabilities.discoveredAt ?? now,
          lastDiscoveryError: runtimeCapabilities.lastError,
          updatedAt: Math.max(current.updatedAt, now),
        });
        if (sessionId && runtimeState && this.acpSessionStore?.upsertSession) {
          const metadata = this.getSession(agent.backendId, sessionId);
          if (metadata) {
            this.acpSessionStore.upsertSession({
              ...metadata,
              acpRuntime: {
                ...metadata.acpRuntime,
                ...runtimeState,
                configValues: {
                  ...(metadata.acpRuntime?.configValues ?? {}),
                  ...(runtimeState.configValues ?? {}),
                },
              },
              updatedAt: Math.max(
                metadata.updatedAt,
                runtimeState.updatedAt ?? now,
              ),
            });
          }
        }
      },
      onSessionRuntimeStateChange: async ({ sessionId, runtimeState }) => {
        if (!this.acpSessionStore?.upsertSession) {
          return;
        }
        const metadata = this.getSession(agent.backendId, sessionId);
        if (!metadata) {
          return;
        }
        const acpRuntime = {
          ...metadata.acpRuntime,
          ...runtimeState,
          configValues: {
            ...(metadata.acpRuntime?.configValues ?? {}),
            ...(runtimeState.configValues ?? {}),
          },
        };
        this.acpSessionStore.upsertSession({
          ...metadata,
          acpRuntime,
          updatedAt: Math.max(
            metadata.updatedAt,
            runtimeState.updatedAt ?? Date.now(),
          ),
        });
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "thread/acpRuntime/updated",
            params: {
              threadId: sessionId,
              acpRuntime,
            },
          },
        });
      },
      onRequest: async (request) =>
        await this.handleServerRequest(agent.backendId, request),
    });
  }
}
