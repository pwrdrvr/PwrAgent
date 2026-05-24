import path from "node:path";
import {
  type AcpBackendId,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerNotification,
  type AppServerPendingRequestNotification,
  type AppServerThreadMessagePart,
  type AppServerThreadReplay,
  type AppServerThreadStatus,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type BackendAcpSessionRuntimeState,
  type BackendAcpRuntimeCapabilities,
  type BackendCapabilities,
  type BackendLaunchpadOptions,
  type BackendModelOption,
  type BackendSummary,
  type ThreadExecutionMode,
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
  type AcpJsonRpcTransport,
  type AcpPromptContentBlock,
} from "../acp/acp-client";
import { discoverLocalAcpAgents } from "../acp/acp-local-discovery";
import { acpToolUpdateNotifications } from "../acp/acp-live-notifications";
import { AcpRolloutStore } from "../acp/acp-rollout-store";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import { acpRuntimeSupportsSessionLoad } from "../acp/acp-runtime-capabilities";
import {
  AcpSessionStore,
  type AcpSessionMetadata,
  type AcpSessionStore as AcpSessionStoreContract,
} from "../acp/acp-session-store";
import {
  AcpSessionReplayNormalizer,
  readAcpContentText,
} from "../acp/acp-session-normalizer";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";
import { getMainLogger } from "../log";
import {
  getAppStateDb,
  getAppStateMode,
  isAppStateInitialized,
} from "../state/app-state";
import {
  resolveActiveProfilePath,
  resolveBootstrapProfilePath,
} from "../profile";
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
  Partial<Pick<AcpAgentClient, "sendControlPrompt" | "setRuntimeOption">>;

export type AcpClientFactory = (agent: AcpInstalledAgentRecord) => AcpRuntimeClient;
export type AcpTransportFactory = (
  agent: AcpInstalledAgentRecord,
) => AcpJsonRpcTransport;
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
  acpRolloutStore?: Pick<AcpRolloutStore, "appendUpdate" | "readReplay" | "readUpdates"> | null;
  acpSessionStore?: AcpSessionStoreLike | null;
  captureStores: ProtocolCaptureStore[];
  createAcpClient?: AcpClientFactory;
  createAcpTransport?: AcpTransportFactory;
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
  const kind =
    update.sessionUpdate ?? update.session_update ?? update.kind ?? update.type;
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
  if (typeof update.output_text === "string") {
    return update.output_text;
  }
  return readAcpContentText(update.content);
}

export function readKimiYoloExecutionModeFromText(
  text: string,
): ThreadExecutionMode | undefined {
  const normalized = text.toLowerCase();
  if (normalized.includes("all actions will be auto-approved")) {
    return "full-access";
  }
  if (normalized.includes("tool calls remain auto-approved")) {
    return "full-access";
  }
  if (normalized.includes("actions will require approval")) {
    return "default";
  }
  return undefined;
}

function liveToolNotificationKey(
  backend: AcpBackendId,
  notification: AppServerNotification,
): string | undefined {
  const params = asPlainRecord(notification.params);
  const item = asPlainRecord(params?.item);
  const threadId = readNonEmptyString(params, "threadId");
  const turnId = readNonEmptyString(params, "turnId") ?? "no-turn";
  const itemId = readNonEmptyString(item, "id");
  return threadId && itemId
    ? `${backend}:${threadId}:${turnId}:${itemId}`
    : undefined;
}

function liveToolNotificationFingerprint(
  notification: AppServerNotification,
): string | undefined {
  const params = asPlainRecord(notification.params);
  const item = asPlainRecord(params?.item);
  if (!item) {
    return undefined;
  }
  const data = asPlainRecord(item.data);
  const output = readNonEmptyString(data, "output") ?? "";
  return JSON.stringify({
    method: notification.method,
    type: item.type,
    toolName: item.toolName,
    status: item.status,
    command: item.command,
    commandActions: item.commandActions,
    outputHash: hashString(output),
    outputLength: output.length,
  });
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash.toString(16);
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
  const runtimeCapabilities = acpRuntimeCapabilitiesForAgent(agent);
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
    label: formatAcpAgentDisplayName(agent),
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
      runtime: runtimeCapabilities,
    },
    methods: [
      "session/new",
      ...(acpRuntimeSupportsSessionLoad(runtimeCapabilities)
        ? ["session/load"]
        : []),
      "session/prompt",
      "session/cancel",
    ],
    capabilities: buildAcpCapabilities(),
    executionModes: buildAcpExecutionModes(agent, available, unavailableReason),
    launchpadOptions: buildAcpLaunchpadOptions(runtimeCapabilities),
    unavailableReason,
  };
}

function formatAcpAgentDisplayName(agent: AcpInstalledAgentRecord): string {
  if (agent.registryId === "gemini") {
    return "Gemini";
  }
  if (agent.registryId === "kimi") {
    return "Kimi";
  }
  return agent.name;
}

function acpRuntimeCapabilitiesForAgent(
  agent: AcpInstalledAgentRecord,
): BackendAcpRuntimeCapabilities | undefined {
  return agent.runtimeCapabilities;
}

function normalizeInstalledAcpAgent(
  agent: AcpInstalledAgentRecord,
): AcpInstalledAgentRecord {
  const runtimeCapabilities = acpRuntimeCapabilitiesForAgent(agent);
  return runtimeCapabilities === agent.runtimeCapabilities
    ? agent
    : { ...agent, runtimeCapabilities };
}

function resolveDefaultAcpRolloutRoot(): string {
  return getAppStateMode() === "bootstrap"
    ? resolveBootstrapProfilePath("state/acp-rollouts")
    : resolveActiveProfilePath("state/acp-rollouts");
}

function buildAcpExecutionModes(
  agent: AcpInstalledAgentRecord,
  available: boolean,
  unavailableReason: string | undefined,
): BackendSummary["executionModes"] {
  if (agent.registryId !== "kimi") {
    return [];
  }
  return [
    {
      mode: "default",
      label: "Default Access",
      available,
      isDefault: true,
      unavailableReason,
    },
    {
      mode: "full-access",
      label: "Full Access",
      available,
      unavailableReason,
    },
  ];
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
    acpRuntime: session.acpRuntime,
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
  return session.hasConversationHistory === true;
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
  private readonly acpRolloutStore?: Pick<
    AcpRolloutStore,
    "appendUpdate" | "readReplay" | "readUpdates"
  >;
  private readonly acpSessionStore?: AcpSessionStoreLike;
  private readonly captureStores: ProtocolCaptureStore[];
  private readonly createAcpClient: AcpClientFactory;
  private readonly createAcpTransport?: AcpTransportFactory;
  private readonly discoverLocalAcpAgents: LocalAcpDiscovery;
  private readonly emit: (event: AgentEvent) => Promise<void>;
  private readonly handleServerRequest: (
    backend: AcpBackendId,
    request: AppServerPendingRequestNotification,
  ) => Promise<unknown>;
  private readonly acpClients = new Map<AcpBackendId, Promise<AcpRuntimeClient>>();
  private readonly liveNotificationFingerprints = new Map<string, string>();
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
    this.acpRolloutStore =
      options.acpRolloutStore === null
        ? undefined
        : options.acpRolloutStore ??
          (isAppStateInitialized()
            ? new AcpRolloutStore(resolveDefaultAcpRolloutRoot())
            : undefined);
    this.discoverLocalAcpAgents =
      options.discoverLocalAcpAgents ?? discoverLocalAcpAgents;
    this.createAcpTransport = options.createAcpTransport;
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
    const agent = this.acpAgentStore?.getInstalledAgent(backendId);
    return agent ? normalizeInstalledAcpAgent(agent) : undefined;
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
    const session = this.getSession(backend, sessionId);
    const cachedClient = await this.acpClients.get(backend)?.catch(() => undefined);
    if (cachedClient) {
      const replay = cachedClient.readReplay(sessionId);
      if (
        session &&
        acpSessionHasConversationHistory(session) &&
        replay.entries.length === 0 &&
        acpRuntimeSupportsSessionLoad(
          this.getInstalledAgent(backend)?.runtimeCapabilities,
        )
      ) {
        try {
          const replay = await cachedClient.loadSession(session);
          return this.providerReplayOrRolloutFallback({
            backend,
            replay,
            session,
          });
        } catch (error) {
          acpBackendAdapterLog.warn("acp_session_load_failed", {
            backend,
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
          return this.loadFailureReplayOrRolloutFallback({
            backend,
            error,
            session,
          });
        }
      }
      if (
        session &&
        replay.entries.length === 0 &&
        !acpRuntimeSupportsSessionLoad(
          this.getInstalledAgent(backend)?.runtimeCapabilities,
        )
      ) {
        return this.readRolloutReplay(session, "rollout-session-load-unsupported");
      }
      this.logSessionReplaySource({
        backend,
        entries: replay.entries.length,
        messages: replay.messages.length,
        sessionId,
        source: "memory",
      });
      return replay;
    }

    if (!session) {
      const replay = new AcpSessionReplayNormalizer().replay();
      this.logSessionReplaySource({
        backend,
        entries: 0,
        messages: 0,
        sessionId,
        source: "empty-no-session",
      });
      return replay;
    }

    if (
      !acpRuntimeSupportsSessionLoad(
        this.getInstalledAgent(backend)?.runtimeCapabilities,
      )
    ) {
      return this.readRolloutReplay(session, "rollout-session-load-unsupported");
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
      return this.providerReplayOrRolloutFallback({
        backend,
        replay,
        session,
      });
    } catch (error) {
      acpBackendAdapterLog.warn("acp_session_load_failed", {
        backend,
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
      return this.loadFailureReplayOrRolloutFallback({
        backend,
        error,
        session,
      });
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

  private readRolloutReplay(
    session: AcpSessionMetadata,
    source: string,
  ): AppServerThreadReplay {
    const replay =
      this.acpRolloutStore?.readReplay({
        backendId: session.backendId,
        sessionId: session.sessionId,
      }) ?? new AcpSessionReplayNormalizer().replay();
    this.logSessionReplaySource({
      backend: session.backendId,
      entries: replay.entries.length,
      messages: replay.messages.length,
      sessionId: session.sessionId,
      source,
    });
    return {
      ...replay,
      threadStatus: acpSessionThreadStatus(session.status),
    };
  }

  private providerReplayOrRolloutFallback(params: {
    backend: AcpBackendId;
    replay: AppServerThreadReplay;
    session: AcpSessionMetadata;
  }): AppServerThreadReplay {
    const { backend, replay, session } = params;
    if (replay.entries.length > 0 || !acpSessionHasConversationHistory(session)) {
      this.logSessionReplaySource({
        backend,
        entries: replay.entries.length,
        messages: replay.messages.length,
        sessionId: session.sessionId,
        source:
          replay.entries.length > 0
            ? "provider-session-load"
            : "provider-session-load-empty",
      });
      return replay;
    }

    const rolloutReplay =
      this.acpRolloutStore?.readReplay({
        backendId: session.backendId,
        sessionId: session.sessionId,
      }) ?? new AcpSessionReplayNormalizer().replay();
    if (rolloutReplay.entries.length === 0) {
      this.logSessionReplaySource({
        backend,
        entries: replay.entries.length,
        messages: replay.messages.length,
        sessionId: session.sessionId,
        source: "provider-session-load-empty-no-rollout",
      });
      return replay;
    }

    this.logSessionReplaySource({
      backend,
      entries: rolloutReplay.entries.length,
      messages: rolloutReplay.messages.length,
      providerEntries: replay.entries.length,
      providerMessages: replay.messages.length,
      sessionId: session.sessionId,
      source: "rollout-provider-empty",
    });
    return {
      ...rolloutReplay,
      threadStatus: acpSessionThreadStatus(session.status),
    };
  }

  private loadFailureReplayOrRolloutFallback(params: {
    backend: AcpBackendId;
    error: unknown;
    session: AcpSessionMetadata;
  }): AppServerThreadReplay {
    const rolloutReplay =
      this.acpRolloutStore?.readReplay({
        backendId: params.session.backendId,
        sessionId: params.session.sessionId,
      }) ?? new AcpSessionReplayNormalizer().replay();
    if (rolloutReplay.entries.length > 0) {
      this.logSessionReplaySource({
        backend: params.backend,
        entries: rolloutReplay.entries.length,
        messages: rolloutReplay.messages.length,
        sessionId: params.session.sessionId,
        source: "rollout-session-load-failed",
      });
      return {
        ...rolloutReplay,
        threadStatus: acpSessionThreadStatus(params.session.status),
      };
    }

    const replay = acpSessionLoadFallbackReplay(params.session, params.error);
    this.logSessionReplaySource({
      backend: params.backend,
      entries: replay.entries.length,
      messages: replay.messages.length,
      sessionId: params.session.sessionId,
      source: "session-load-failed",
    });
    return replay;
  }

  private logSessionReplaySource(params: {
    backend: AcpBackendId;
    entries: number;
    messages: number;
    providerEntries?: number;
    providerMessages?: number;
    sessionId: string;
    source: string;
  }): void {
    acpBackendAdapterLog.info("acp_session_replay_source", params);
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
    const installedAgents = (this.acpAgentStore?.listInstalledAgents() ?? [])
      .map(normalizeInstalledAcpAgent)
      .filter((agent) => !isBannedAcpRegistryId(agent.registryId));
    const installedBackendIds = new Set(
      installedAgents.map((agent) => agent.backendId),
    );
    const discoveredAgents = (await this.readLocalAgentsOnce())
      .map(normalizeInstalledAcpAgent)
      .filter((agent) => !isBannedAcpRegistryId(agent.registryId));
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
    this.liveNotificationFingerprints.clear();
    await Promise.all(
      acpClients.map(async (clientPromise) => {
        const client = await clientPromise.catch(() => undefined);
        await client?.dispose();
      }),
    );
  }

  private shouldEmitLiveToolNotification(
    backend: AcpBackendId,
    notification: AppServerNotification,
  ): boolean {
    const key = liveToolNotificationKey(backend, notification);
    const fingerprint = liveToolNotificationFingerprint(notification);
    if (!key || !fingerprint) {
      return true;
    }
    const previous = this.liveNotificationFingerprints.get(key);
    if (previous === fingerprint) {
      return false;
    }
    this.liveNotificationFingerprints.set(key, fingerprint);
    return true;
  }

  private clearLiveToolNotificationFingerprints(params: {
    backend: AcpBackendId;
    threadId: string;
    turnId: string;
  }): void {
    const prefix = `${params.backend}:${params.threadId}:${params.turnId}:`;
    for (const key of this.liveNotificationFingerprints.keys()) {
      if (key.startsWith(prefix)) {
        this.liveNotificationFingerprints.delete(key);
      }
    }
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
      agentDisplayName: agent.name,
      initialRuntimeCapabilities: acpRuntimeCapabilitiesForAgent(agent),
      rolloutStore: this.acpRolloutStore,
      store: this.acpSessionStore as AcpSessionStoreContract,
      transport:
        this.createAcpTransport?.(agent) ??
        new AcpStdioJsonRpcTransport({
          launchDescriptor: agent.launchDescriptor,
          observer: createCompositeJsonRpcObserver([
            acpCapture?.observer,
            createProtocolLogObserverFromEnv({
              backend: agent.backendId,
            }),
          ]),
        }),
      onSessionUpdate: async ({
        assistantMessageItemId,
        sessionId,
        replay,
        title,
        turnId,
        update,
      }) => {
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
        const kimiYoloExecutionMode =
          agent.registryId === "kimi"
            ? readKimiYoloExecutionModeFromText(readAcpUpdateText(update) ?? "")
            : undefined;
        if (kimiYoloExecutionMode) {
          const metadata = this.getSession(agent.backendId, sessionId);
          if (
            metadata &&
            (metadata.executionMode ?? "default") !== kimiYoloExecutionMode
          ) {
            this.acpSessionStore?.upsertSession?.({
              ...metadata,
              executionMode: kimiYoloExecutionMode,
              updatedAt: Math.max(metadata.updatedAt, Date.now()),
            });
            await this.emit({
              backend: agent.backendId,
              notification: {
                method: "thread/executionMode/updated",
                params: {
                  threadId: sessionId,
                  executionMode: kimiYoloExecutionMode,
                },
              },
            });
          }
        }
        if (
          updateKind === "agent_message_chunk" ||
          updateKind === "agent_thought_chunk"
        ) {
          const delta = readAcpUpdateText(update);
          if (delta) {
            await this.emit({
              backend: agent.backendId,
              notification: {
                method: "item/agentMessage/delta",
                params: {
                  threadId: sessionId,
                  turnId,
                  itemId:
                    assistantMessageItemId ?? `assistant:${turnId ?? sessionId}`,
                  delta,
                },
              },
            });
          }
        }
        const toolNotifications = acpToolUpdateNotifications({
          threadId: sessionId,
          turnId,
          update,
        }).filter((notification) =>
          this.shouldEmitLiveToolNotification(agent.backendId, notification),
        );
        for (const notification of toolNotifications) {
          await this.emit({
            backend: agent.backendId,
            notification,
          });
        }
        if (updateKind === "turn_finished" && turnId) {
          this.clearLiveToolNotificationFingerprints({
            backend: agent.backendId,
            threadId: sessionId,
            turnId,
          });
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
        await this.emit({
          backend: agent.backendId,
          notification: {
            method: "backend/acpRuntimeCapabilities/updated",
            params: {
              backend: agent.backendId,
            },
          },
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
