import { app } from "electron";
import { OverlayStore } from "@pwragnt/agent-core";
import type {
  AgentEvent,
  ArchiveThreadRequest,
  ArchiveThreadResponse,
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  BackendCapabilities,
  BackendLaunchpadOptions,
  BackendModelOption,
  BackendSummary,
  ListBackendsRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationDirectoryGitStatus,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationLaunchpadDefaults,
  ResetDirectoryLaunchpadRequest,
  ResetDirectoryLaunchpadResponse,
  RenameThreadRequest,
  RenameThreadResponse,
  RestoreThreadRequest,
  RestoreThreadResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  StartThreadResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  ThreadExecutionMode,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
} from "@pwragnt/shared";
import { CodexAppServerClient } from "../codex-app-server/client";
import { GrokAppServerClient } from "../grok-app-server/client";
import { createScratchProjectDirectory } from "./scratch-projects";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { createProtocolCaptureFromEnv } from "../testing/protocol-capture";
import type { ProtocolCaptureStore } from "../testing/capture-store";
import { createReplayClientsFromEnv } from "../testing/replay-runtime";
import { GitDirectoryService } from "./git-directory-service";
import {
  createCompositeJsonRpcObserver,
  createProtocolLogObserverFromEnv,
} from "./protocol-log-observer";

type InitializeResult = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  methods?: string[];
};

type BackendClient = {
  close(): Promise<void>;
  getInitializeResult(): Promise<InitializeResult>;
  listThreads(params?: { archived?: boolean; filter?: string }): Promise<AppServerThreadSummary[]>;
  archiveThread?(params: { threadId: string }): Promise<{ threadId: string }>;
  restoreThread?(params: { threadId: string }): Promise<{ threadId: string }>;
  renameThread?(params: { threadId: string; name: string }): Promise<{ threadId: string }>;
  listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<AppServerListSkillsResponse["data"]>;
  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void;
  onRequest?(
    listener: (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  ): () => void;
  readThread(params: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerReadThreadResponse["replay"]>;
  startThread(params: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }>;
  startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; turnId: string }>;
  listModels?(): Promise<BackendModelOption[]>;
  interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }>;
  setThreadPermissions?(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }>;
};

type PendingServerRequest = {
  resolve: (response: SubmitServerRequestRequest["response"]) => void;
  reject: (error: Error) => void;
};

const BACKEND_LABELS: Record<AppServerBackendKind, string> = {
  codex: "OpenAI",
  grok: "Grok",
};

const OPENAI_FALLBACK_MODELS: BackendModelOption[] = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    current: true,
    supportsReasoning: true,
    supportsFast: true,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    supportsReasoning: true,
    supportsFast: true,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    supportsReasoning: true,
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3-Codex",
    supportsReasoning: true,
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    supportsReasoning: true,
  },
];

const GROK_FALLBACK_MODELS: BackendModelOption[] = [
  {
    id: "grok-4.20-reasoning",
    label: "Grok 4.20 Reasoning",
    current: true,
    supportsReasoning: false,
  },
  {
    id: "grok-4.20-non-reasoning",
    label: "Grok 4.20 Non-Reasoning",
    supportsReasoning: false,
  },
  {
    id: "grok-4-1-fast-reasoning",
    label: "Grok 4.1 Fast Reasoning",
    supportsReasoning: false,
    supportsFast: true,
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    label: "Grok 4.1 Fast Non-Reasoning",
    supportsReasoning: false,
    supportsFast: true,
  },
  {
    id: "grok-4-fast-reasoning",
    label: "Grok 4 Fast Reasoning",
    supportsReasoning: false,
    supportsFast: true,
  },
  {
    id: "grok-4-fast-non-reasoning",
    label: "Grok 4 Fast Non-Reasoning",
    supportsReasoning: false,
    supportsFast: true,
  },
];

const OPENAI_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const GROK_REASONING_EFFORTS = ["low", "medium", "high"];
const DEFAULT_REASONING_EFFORT = "medium";

const EXECUTION_MODE_SUMMARIES: Record<
  ThreadExecutionMode,
  {
    label: string;
    approvalPolicy: string;
    sandbox: string;
  }
> = {
  default: {
    label: "Default Access",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  "full-access": {
    label: "Full Access",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
};

function buildCapabilities(methods: string[], backend: AppServerBackendKind): BackendCapabilities {
  const supported = new Set(methods);
  const assumeCodexAppServerSurface = backend === "codex" && methods.length === 0;

  return {
    listThreads:
      supported.has("thread/list") ||
      supported.has("thread/loaded/list") ||
      assumeCodexAppServerSurface,
    createThread:
      supported.has("thread/start") ||
      supported.has("thread/new") ||
      assumeCodexAppServerSurface,
    resumeThread: supported.has("thread/resume") || assumeCodexAppServerSurface,
    archiveThread: supported.has("thread/archive") || assumeCodexAppServerSurface,
    restoreThread: supported.has("thread/unarchive") || assumeCodexAppServerSurface,
    renameThread: supported.has("thread/name/set") || assumeCodexAppServerSurface,
    readThread: supported.has("thread/read") || assumeCodexAppServerSurface,
    startTurn: supported.has("turn/start") || assumeCodexAppServerSurface,
    interruptTurn: supported.has("turn/interrupt"),
    steerTurn: supported.has("turn/steer"),
    transcriptPagination: false,
    toolUse: false,
    approvalRequests: true,
    multiDirectoryThreads: backend === "codex",
  };
}

function buildCodexClientArgs(mode: ThreadExecutionMode): string[] {
  if (mode !== "full-access") {
    return [];
  }

  return [
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
  ];
}

function buildPendingRequestKey(params: {
  backend: AppServerBackendKind;
  threadId: string;
  requestId: string;
}): string {
  return `${params.backend}:${params.threadId}:${params.requestId}`;
}

function mergeMethods(results: InitializeResult[]): string[] {
  return [...new Set(results.flatMap((result) => result.methods ?? []))];
}

function inferSupportsReasoning(
  backend: AppServerBackendKind,
  model: BackendModelOption,
): boolean {
  if (typeof model.supportsReasoning === "boolean") {
    return model.supportsReasoning;
  }

  const id = model.id.toLowerCase();
  if (backend === "grok") {
    return id.includes("reasoning");
  }

  return id.startsWith("gpt-5") || id.startsWith("o");
}

function inferSupportsFast(
  backend: AppServerBackendKind,
  model: BackendModelOption,
): boolean {
  if (typeof model.supportsFast === "boolean") {
    return model.supportsFast;
  }

  const id = model.id.toLowerCase();
  return backend === "codex" && (id === "gpt-5.5" || id === "gpt-5.4");
}

function getBackendFallbackModels(backend: AppServerBackendKind): BackendModelOption[] {
  return backend === "codex" ? OPENAI_FALLBACK_MODELS : GROK_FALLBACK_MODELS;
}

function getPreferredModelId(backend: AppServerBackendKind): string {
  return backend === "codex" ? "gpt-5.5" : "grok-4.20-reasoning";
}

function dedupeModelOptions(
  backend: AppServerBackendKind,
  models: BackendModelOption[],
): BackendModelOption[] {
  const byId = new Map<string, BackendModelOption>();
  for (const model of models) {
    if (!model.id.trim()) {
      continue;
    }

    const normalizedModel = {
      ...model,
      supportsReasoning: inferSupportsReasoning(backend, model),
      supportsFast: inferSupportsFast(backend, model),
    };
    const current = byId.get(model.id);
    byId.set(model.id, {
      ...current,
      ...normalizedModel,
      current: current?.current || normalizedModel.current,
      supportsReasoning: current?.supportsReasoning || normalizedModel.supportsReasoning,
      supportsFast: current?.supportsFast || normalizedModel.supportsFast,
    });
  }

  const deduped = [...byId.values()];
  if (deduped.some((model) => model.current)) {
    return deduped;
  }

  const preferredModelId = getPreferredModelId(backend);
  return deduped.map((model) => ({
    ...model,
    current: model.id === preferredModelId,
  }));
}

function buildLaunchpadOptions(
  backend: AppServerBackendKind,
  models: BackendModelOption[],
): BackendLaunchpadOptions | undefined {
  const normalizedModels = dedupeModelOptions(
    backend,
    models.length > 0 ? models : getBackendFallbackModels(backend),
  );
  if (normalizedModels.length === 0) {
    return undefined;
  }

  const supportsReasoning = normalizedModels.some((model) => model.supportsReasoning);
  const supportsFastMode =
    backend === "codex" && normalizedModels.some((model) => model.supportsFast);

  return {
    models: normalizedModels,
    reasoningEfforts: supportsReasoning
      ? backend === "codex"
        ? OPENAI_REASONING_EFFORTS
        : GROK_REASONING_EFFORTS
      : undefined,
    supportsFastMode,
  };
}

async function readClientModels(client: BackendClient): Promise<BackendModelOption[]> {
  if (!client.listModels) {
    return [];
  }
  return await client.listModels();
}

type ModelSettings = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
};

function getDefaultModelOption(
  backend: AppServerBackendKind,
  options?: BackendLaunchpadOptions,
): BackendModelOption | undefined {
  const models = options?.models ?? [];
  if (models.length === 0) {
    return undefined;
  }

  const preferredModelId = getPreferredModelId(backend);
  return (
    models.find((model) => model.current) ??
    models.find((model) => model.id === preferredModelId) ??
    models.find((model) => model.supportsReasoning) ??
    models[0]
  );
}

function getDefaultReasoningEffort(options?: BackendLaunchpadOptions): string | undefined {
  const reasoningEfforts = options?.reasoningEfforts ?? [];
  return reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : reasoningEfforts[0];
}

function resolveModelSettingsFromOptions(
  backend: AppServerBackendKind,
  options: BackendLaunchpadOptions | undefined,
  settings: ModelSettings,
): ModelSettings {
  const models = options?.models ?? [];
  const selectedModel =
    models.find((model) => model.id === settings.model) ??
    getDefaultModelOption(backend, options);
  const supportsReasoning = Boolean(selectedModel?.supportsReasoning);
  const reasoningEfforts = options?.reasoningEfforts ?? [];
  const reasoningEffort = supportsReasoning
    ? reasoningEfforts.includes(settings.reasoningEffort ?? "")
      ? settings.reasoningEffort
      : getDefaultReasoningEffort(options)
    : undefined;
  const supportsFast = backend === "codex" && Boolean(selectedModel?.supportsFast);

  return {
    model: selectedModel?.id,
    reasoningEffort,
    serviceTier: settings.serviceTier,
    fastMode: supportsFast ? settings.fastMode : undefined,
  };
}

export class DesktopBackendRegistry {
  private readonly codexDefaultClient: BackendClient;
  private readonly codexFullAccessClient: BackendClient;
  private readonly grokClient: BackendClient;
  private readonly overlayStore: OverlayStore;
  private readonly gitDirectoryService: GitDirectoryService;
  private readonly createScratchProjectDirectory: () => Promise<string>;
  private readonly captureStores: ProtocolCaptureStore[] = [];
  private readonly eventListeners = new Set<
    (event: AgentEvent) => void | Promise<void>
  >();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();

  constructor(options?: {
    codexClient?: BackendClient;
    codexFullAccessClient?: BackendClient;
    grokClient?: BackendClient;
    overlayStore?: OverlayStore;
    gitDirectoryService?: GitDirectoryService;
    createScratchProjectDirectory?: () => Promise<string>;
  }) {
    const replayClients = createReplayClientsFromEnv();
    const codexCapture = options?.codexClient
      || replayClients
      ? undefined
      : createProtocolCaptureFromEnv({
          backend: "codex",
          userDataPath: app.getPath("userData"),
        });
    if (codexCapture) {
      this.captureStores.push(codexCapture.store);
    }
    const codexObserver = createCompositeJsonRpcObserver([
      codexCapture?.observer,
      createProtocolLogObserverFromEnv({
        backend: "codex",
      }),
    ]);
    const grokCapture = options?.grokClient
      || replayClients
      ? undefined
      : createProtocolCaptureFromEnv({
          backend: "grok",
          userDataPath: app.getPath("userData"),
        });
    if (grokCapture) {
      this.captureStores.push(grokCapture.store);
    }
    const grokObserver = createCompositeJsonRpcObserver([
      grokCapture?.observer,
      createProtocolLogObserverFromEnv({
        backend: "grok",
      }),
    ]);

    this.codexDefaultClient =
      options?.codexClient ??
      replayClients?.codexDefaultClient ??
      new CodexAppServerClient({
        connectionObserver: codexObserver,
      });
    this.codexFullAccessClient =
      options?.codexFullAccessClient ??
      replayClients?.codexFullAccessClient ??
      new CodexAppServerClient({
        args: buildCodexClientArgs("full-access"),
        connectionObserver: codexObserver,
      });
    this.grokClient =
      options?.grokClient ??
      replayClients?.grokClient ??
      new GrokAppServerClient({
        connectionObserver: grokObserver,
      });
    this.overlayStore = options?.overlayStore ?? getDesktopOverlayStore();
    this.gitDirectoryService = options?.gitDirectoryService ?? new GitDirectoryService();
    this.createScratchProjectDirectory =
      options?.createScratchProjectDirectory ?? createScratchProjectDirectory;

    this.subscribeClient("codex", this.codexDefaultClient);
    this.subscribeClient("codex", this.codexFullAccessClient);
    this.subscribeClient("grok", this.grokClient);
  }

  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async listBackends(
    request: ListBackendsRequest = {}
  ): Promise<ListBackendsResponse> {
    const summaries = await Promise.all([
      this.describeCodexBackend(),
      this.describeSingleBackend("grok", this.grokClient),
    ]);

    return {
      fetchedAt: Date.now(),
      backends: request.includeUnavailable
        ? summaries
        : summaries.filter((backend) => backend.available),
    };
  }

  async listThreads(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    filter?: string;
  } = {}): Promise<AppServerThreadSummary[]> {
    if (params.backend === "codex") {
      return await this.listCodexThreads({
        archived: params.archived,
        filter: params.filter,
      });
    }

    if (params.backend === "grok") {
      return await this.grokClient.listThreads({
        archived: params.archived,
        filter: params.filter,
      });
    }

    const threadLists = await Promise.all([
      this.listCodexThreads({
        archived: params.archived,
        filter: params.filter,
      }),
      this.grokClient.listThreads({
        archived: params.archived,
        filter: params.filter,
      }).catch(() => []),
    ]);

    return threadLists
      .flat()
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  async listSkills(params: {
    backend?: AppServerBackendKind;
    cwd?: string;
    cwds?: string[];
  } = {}): Promise<Pick<AppServerListSkillsResponse, "data">> {
    const backend = params.backend ?? "codex";
    const data = await this.getClient(backend).listSkills({
      cwd: params.cwd,
      cwds: params.cwds,
    });

    return { data };
  }

  async archiveThread(
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> {
    const backend = request.backend ?? "codex";
    const result =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await this.archiveWithClient(client, request.threadId),
          )
        : await this.archiveWithClient(this.grokClient, request.threadId);

    return {
      backend,
      threadId: result.threadId,
      archivedAt: Date.now(),
      cleanup: [],
    };
  }

  async restoreThread(
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> {
    const backend = request.backend ?? "codex";
    const result =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await this.restoreWithClient(client, request.threadId),
          )
        : await this.restoreWithClient(this.grokClient, request.threadId);

    return {
      backend,
      threadId: result.threadId,
      restoredAt: Date.now(),
    };
  }

  async renameThread(
    request: RenameThreadRequest,
  ): Promise<RenameThreadResponse> {
    const backend = request.backend ?? "codex";
    const result =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await this.renameWithClient(client, request.threadId, request.name),
          )
        : await this.renameWithClient(this.grokClient, request.threadId, request.name);

    return {
      backend,
      threadId: result.threadId,
      renamedAt: Date.now(),
    };
  }

  async readDirectoryStatuses(directories: NavigationDirectorySummary[]): Promise<
    Record<string, NavigationDirectoryGitStatus | undefined>
  > {
    return await this.gitDirectoryService.readDirectoryStatuses(directories);
  }

  async readThread(
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> {
    const backend = request.backend ?? "codex";
    const replay =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await client.readThread({
              threadId: request.threadId,
              before: request.before,
              limit: request.limit,
            }),
          )
        : await this.grokClient.readThread({
            threadId: request.threadId,
            before: request.before,
            limit: request.limit,
          });

    return {
      backend,
      fetchedAt: Date.now(),
      threadId: request.threadId,
      replay,
    };
  }

  async startThread(params: {
    backend: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<StartThreadResponse> {
    const { backend, executionMode = "default", ...request } = params;
    const modeSettings = EXECUTION_MODE_SUMMARIES[executionMode];
    const modelSettings = await this.resolveModelSettings(backend, request);
    const cwd =
      backend === "codex" && !request.cwd?.trim()
        ? await this.createScratchProjectDirectory()
        : request.cwd;

    const result = await this.getClient(backend, executionMode).startThread({
      ...request,
      ...modelSettings,
      cwd,
      approvalPolicy: request.approvalPolicy ?? modeSettings.approvalPolicy,
      sandbox: request.sandbox ?? modeSettings.sandbox,
    });

    if (backend === "codex") {
      await this.overlayStore.setThreadExecutionMode({
        backend,
        threadId: result.threadId,
        executionMode,
      });
    }
    if (
      modelSettings.model !== undefined ||
      modelSettings.reasoningEffort !== undefined ||
      modelSettings.serviceTier !== undefined ||
      modelSettings.fastMode !== undefined
    ) {
      await this.overlayStore.setThreadModelSettings({
        backend,
        threadId: result.threadId,
        ...modelSettings,
      });
    }

    return {
      backend,
      threadId: result.threadId,
      executionMode,
    };
  }

  async startTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const turnParams = await this.resolveModelSettings(params.backend, {
      ...params,
      model: params.model ?? overlay?.model,
      serviceTier: params.serviceTier ?? overlay?.serviceTier,
      reasoningEffort: params.reasoningEffort ?? overlay?.reasoningEffort,
      fastMode: params.backend === "codex" ? params.fastMode ?? overlay?.fastMode : undefined,
    });
    const result =
      params.backend === "codex"
        ? await this.withCodexThreadClient(params.threadId, async (client) =>
            await client.startTurn({
              ...params,
              ...turnParams,
            }),
          )
        : await this.grokClient.startTurn({
            threadId: params.threadId,
            input: params.input,
            model: turnParams.model,
            serviceTier: turnParams.serviceTier,
            reasoningEffort: turnParams.reasoningEffort,
            fastMode: turnParams.fastMode,
          });

    if (
      turnParams.model !== undefined ||
      turnParams.reasoningEffort !== undefined ||
      turnParams.serviceTier !== undefined ||
      turnParams.fastMode !== undefined
    ) {
      await this.overlayStore.setThreadModelSettings({
        backend: params.backend,
        threadId: result.threadId,
        ...turnParams,
      });
    }

    return {
      backend: params.backend,
      threadId: result.threadId,
      turnId: result.turnId,
    };
  }

  async interruptTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    const result =
      params.backend === "codex"
        ? await this.withCodexThreadClient(params.threadId, async (client) =>
            await client.interruptTurn(params),
          )
        : await this.grokClient.interruptTurn(params);

    return {
      backend: params.backend,
      threadId: result.threadId,
      turnId: result.turnId,
    };
  }

  async setThreadExecutionMode(
    params: SetThreadExecutionModeRequest
  ): Promise<SetThreadExecutionModeResponse> {
    if (params.backend !== "codex") {
      return params;
    }

    const modeSettings = EXECUTION_MODE_SUMMARIES[params.executionMode];
    const result = await this.withCodexThreadClient(params.threadId, async (client) => {
      if (!client.setThreadPermissions) {
        throw new Error("Selected backend does not support execution mode updates");
      }

      return await client.setThreadPermissions({
        threadId: params.threadId,
        approvalPolicy: modeSettings.approvalPolicy,
        sandbox: modeSettings.sandbox,
      });
    });

    await this.overlayStore.setThreadExecutionMode({
      backend: "codex",
      threadId: result.threadId,
      executionMode: params.executionMode,
    });

    return {
      backend: params.backend,
      threadId: result.threadId,
      executionMode: params.executionMode,
    };
  }

  async setThreadModelSettings(
    params: SetThreadModelSettingsRequest
  ): Promise<SetThreadModelSettingsResponse> {
    const modelSettings = await this.resolveModelSettings(params.backend, params);
    await this.overlayStore.setThreadModelSettings({
      backend: params.backend,
      threadId: params.threadId,
      ...modelSettings,
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      ...modelSettings,
    };
  }

  async submitServerRequest(
    params: SubmitServerRequestRequest
  ): Promise<SubmitServerRequestResponse> {
    const key = buildPendingRequestKey(params);
    const pending = this.pendingServerRequests.get(key);
    if (!pending) {
      throw new Error(`No pending server request found for ${params.requestId}`);
    }

    this.pendingServerRequests.delete(key);
    pending.resolve(params.response);

    return {
      backend: params.backend,
      threadId: params.threadId,
      turnId: params.turnId,
      requestId: params.requestId,
    };
  }

  async ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    const existing = await this.overlayStore.getDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });
    const defaults = await this.overlayStore.getLaunchpadDefaults();
    if (existing) {
      return {
        launchpad: existing,
        defaults,
      };
    }

    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: request.directoryKey,
      directoryKind: request.directoryKind,
      directoryLabel: request.directoryLabel,
      directoryPath: request.directoryPath,
      backend: request.preferredBackend ?? defaults.backend,
      executionMode: defaults.executionMode,
      model: defaults.model,
      reasoningEffort: defaults.reasoningEffort,
      serviceTier: defaults.serviceTier,
      fastMode: defaults.fastMode,
      prompt: "",
      workMode: "local",
      branchName: request.currentBranch,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const persisted = await this.overlayStore.upsertDirectoryLaunchpad(launchpad);
    return {
      launchpad: persisted,
      defaults,
    };
  }

  async updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    const current =
      (await this.overlayStore.getDirectoryLaunchpad({
        directoryKey: request.directoryKey,
      })) ??
      (await this.ensureDirectoryLaunchpad({
        directoryKey: request.directoryKey,
        directoryKind: "directory",
        directoryLabel: request.directoryKey,
      })).launchpad;

    const nextLaunchpad: NavigationLaunchpadDraft = {
      ...current,
      ...request.patch,
      directoryKey: request.directoryKey,
      updatedAt: Date.now(),
    };
    const persisted = await this.overlayStore.upsertDirectoryLaunchpad(nextLaunchpad);

    const stickyPatch: Partial<NavigationLaunchpadDefaults> = {};
    if (request.patch.backend) {
      stickyPatch.backend = request.patch.backend;
    }
    if (request.patch.executionMode) {
      stickyPatch.executionMode = request.patch.executionMode;
    }
    if ("model" in request.patch) {
      stickyPatch.model = request.patch.model;
    }
    if ("reasoningEffort" in request.patch) {
      stickyPatch.reasoningEffort = request.patch.reasoningEffort;
    }
    if ("serviceTier" in request.patch) {
      stickyPatch.serviceTier = request.patch.serviceTier;
    }
    if ("fastMode" in request.patch) {
      stickyPatch.fastMode = request.patch.fastMode;
    }

    const defaults =
      Object.keys(stickyPatch).length > 0
        ? await this.overlayStore.setLaunchpadDefaults(stickyPatch)
        : await this.overlayStore.getLaunchpadDefaults();

    return {
      launchpad: persisted,
      defaults,
    };
  }

  async resetDirectoryLaunchpad(
    request: ResetDirectoryLaunchpadRequest,
  ): Promise<ResetDirectoryLaunchpadResponse> {
    await this.overlayStore.resetDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });
    return {
      directoryKey: request.directoryKey,
      defaults: await this.overlayStore.getLaunchpadDefaults(),
    };
  }

  async materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    const launchpad = await this.overlayStore.getDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });
    if (!launchpad) {
      throw new Error(`No launchpad found for ${request.directoryKey}`);
    }

    const workspace = await this.gitDirectoryService.prepareLaunchpadWorkspace(launchpad);
    const startThreadResponse = await this.startThread({
      backend: launchpad.backend,
      executionMode: launchpad.executionMode,
      cwd: workspace.cwd,
      model: launchpad.model,
      reasoningEffort: launchpad.reasoningEffort,
      serviceTier: launchpad.serviceTier,
      fastMode: launchpad.backend === "codex" ? launchpad.fastMode : undefined,
    });

    const input =
      request.input ??
      (launchpad.prompt.trim()
        ? [{ type: "text", text: launchpad.prompt } as const]
        : []);
    let turnId: string | undefined;
    if (input.length > 0) {
      const turnResponse = await this.startTurn({
        backend: launchpad.backend,
        threadId: startThreadResponse.threadId,
        input,
        model: launchpad.model,
        reasoningEffort: launchpad.reasoningEffort,
        serviceTier: launchpad.serviceTier,
        fastMode: launchpad.backend === "codex" ? launchpad.fastMode : undefined,
        collaborationMode: request.collaborationMode,
      });
      turnId = turnResponse.turnId;
    }

    await this.overlayStore.resetDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });

    return {
      backend: startThreadResponse.backend,
      threadId: startThreadResponse.threadId,
      turnId,
      executionMode: startThreadResponse.executionMode,
      workMode: workspace.workMode,
    };
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }

    for (const [key, pending] of this.pendingServerRequests) {
      pending.reject(new Error(`Desktop backend registry closed before ${key} resolved`));
      this.pendingServerRequests.delete(key);
    }

    await this.codexDefaultClient.close();
    await this.codexFullAccessClient.close();
    await this.grokClient.close();
    await Promise.all(this.captureStores.splice(0).map(async (store) => await store.close()));
  }

  private async resolveModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings,
  ): Promise<ModelSettings> {
    return resolveModelSettingsFromOptions(
      backend,
      await this.getBackendLaunchpadOptions(backend),
      settings,
    );
  }

  private async getBackendLaunchpadOptions(
    backend: AppServerBackendKind,
  ): Promise<BackendLaunchpadOptions | undefined> {
    if (backend === "codex") {
      const models = (
        await Promise.allSettled([
          readClientModels(this.codexDefaultClient),
          readClientModels(this.codexFullAccessClient),
        ])
      ).flatMap((result) => (result.status === "fulfilled" ? result.value : []));
      return buildLaunchpadOptions(backend, models);
    }

    return buildLaunchpadOptions(
      backend,
      await readClientModels(this.grokClient).catch(() => []),
    );
  }

  private subscribeClient(backend: AppServerBackendKind, client: BackendClient): void {
    this.unsubscribers.push(
      client.onNotification(async (notification) => {
        await this.emit({ backend, notification });
      }),
    );

    if (client.onRequest) {
      this.unsubscribers.push(
        client.onRequest(async (request) => await this.handleServerRequest(backend, request)),
      );
    }
  }

  private getClient(
    backend: AppServerBackendKind,
    executionMode: ThreadExecutionMode = "default",
  ): BackendClient {
    if (backend === "grok") {
      return this.grokClient;
    }

    return executionMode === "full-access"
      ? this.codexFullAccessClient
      : this.codexDefaultClient;
  }

  private async listCodexThreads(params: {
    archived?: boolean;
    filter?: string;
  } = {}): Promise<AppServerThreadSummary[]> {
    const defaultThreads = await this.codexDefaultClient.listThreads(params).catch(() => []);
    const allThreads = defaultThreads.map((thread) => ({
      ...thread,
      executionMode: "default" as const,
    }));

    const overlaysByThreadId = await this.overlayStore.getThreadOverlayStates({
      backend: "codex",
      threadIds: allThreads.map((thread) => thread.id),
    });

    return allThreads
      .map((thread) => {
        const overlay = overlaysByThreadId[thread.id];
        return {
          ...thread,
          executionMode: overlay?.executionMode ?? thread.executionMode,
        };
      })
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  private async describeCodexBackend(): Promise<BackendSummary> {
    const [defaultResult, fullAccessResult, defaultModelsResult, fullAccessModelsResult] = await Promise.allSettled([
      this.codexDefaultClient.getInitializeResult(),
      this.codexFullAccessClient.getInitializeResult(),
      readClientModels(this.codexDefaultClient),
      readClientModels(this.codexFullAccessClient),
    ]);
    const successful = [defaultResult, fullAccessResult].flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const methods = mergeMethods(successful);
    const available = successful.length > 0;
    const discoveredModels = [defaultModelsResult, fullAccessModelsResult].flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const unavailableReason = [defaultResult, fullAccessResult]
      .flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
          : [],
      )
      .join(" ");

    return {
      kind: "codex",
      label: BACKEND_LABELS.codex,
      available,
      serverName: successful[0]?.serverInfo?.name,
      serverVersion: successful[0]?.serverInfo?.version,
      methods,
      capabilities: buildCapabilities(methods, "codex"),
      launchpadOptions: buildLaunchpadOptions(
        "codex",
        discoveredModels.length > 0 ? discoveredModels : OPENAI_FALLBACK_MODELS,
      ),
      executionModes: [
        {
          mode: "default",
          label: EXECUTION_MODE_SUMMARIES.default.label,
          available: defaultResult.status === "fulfilled",
          isDefault: true,
          unavailableReason:
            defaultResult.status === "rejected"
              ? defaultResult.reason instanceof Error
                ? defaultResult.reason.message
                : String(defaultResult.reason)
              : undefined,
        },
        {
          mode: "full-access",
          label: EXECUTION_MODE_SUMMARIES["full-access"].label,
          available: fullAccessResult.status === "fulfilled",
          unavailableReason:
            fullAccessResult.status === "rejected"
              ? fullAccessResult.reason instanceof Error
                ? fullAccessResult.reason.message
                : String(fullAccessResult.reason)
              : undefined,
        },
      ],
      unavailableReason: available ? undefined : unavailableReason || "Codex unavailable",
    };
  }

  private async describeSingleBackend(
    kind: AppServerBackendKind,
    client: BackendClient
  ): Promise<BackendSummary> {
    try {
      const initialize = await client.getInitializeResult();
      const models = await readClientModels(client).catch(() => []);
      const methods = Array.isArray(initialize.methods)
        ? initialize.methods.filter((method): method is string => typeof method === "string")
        : [];

      return {
        kind,
        label: BACKEND_LABELS[kind],
        available: true,
        serverName: initialize.serverInfo?.name,
        serverVersion: initialize.serverInfo?.version,
        methods,
        capabilities: buildCapabilities(methods, kind),
        launchpadOptions: buildLaunchpadOptions(kind, models),
        executionModes: [
          {
            mode: "default",
            label: EXECUTION_MODE_SUMMARIES.default.label,
            available: true,
            isDefault: true,
          },
        ],
      };
    } catch (error) {
      return {
        kind,
        label: BACKEND_LABELS[kind],
        available: false,
        methods: [],
        capabilities: buildCapabilities([], kind),
        executionModes: [
          {
            mode: "default",
            label: EXECUTION_MODE_SUMMARIES.default.label,
            available: false,
            isDefault: true,
            unavailableReason: error instanceof Error ? error.message : String(error),
          },
        ],
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async withCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
  ): Promise<T> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId,
    });
    const preferredMode = overlay?.executionMode;
    const modes: ThreadExecutionMode[] = preferredMode
      ? [preferredMode, preferredMode === "default" ? "full-access" : "default"]
      : ["default", "full-access"];

    let lastError: unknown;
    for (const mode of modes) {
      try {
        return await operation(this.getClient("codex", mode), mode);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async archiveWithClient(
    client: BackendClient,
    threadId: string,
  ): Promise<{ threadId: string }> {
    if (!client.archiveThread) {
      throw new Error("Selected backend does not support thread archiving");
    }

    return await client.archiveThread({ threadId });
  }

  private async restoreWithClient(
    client: BackendClient,
    threadId: string,
  ): Promise<{ threadId: string }> {
    if (!client.restoreThread) {
      throw new Error("Selected backend does not support thread restore");
    }

    return await client.restoreThread({ threadId });
  }

  private async renameWithClient(
    client: BackendClient,
    threadId: string,
    name: string,
  ): Promise<{ threadId: string }> {
    if (!client.renameThread) {
      throw new Error("Selected backend does not support thread renaming");
    }

    return await client.renameThread({ threadId, name });
  }

  private async handleServerRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ): Promise<unknown> {
    const key = buildPendingRequestKey({
      backend,
      threadId: request.params.threadId,
      requestId: request.params.requestId,
    });

    return await new Promise<SubmitServerRequestRequest["response"]>((resolve, reject) => {
      this.pendingServerRequests.set(key, { resolve, reject });

      this.emit({
        backend,
        notification: request as AppServerNotification,
      }).catch((error) => {
        this.pendingServerRequests.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (event.notification.method === "serverRequest/resolved") {
      const key = buildPendingRequestKey({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        requestId: event.notification.params.requestId,
      });
      const pending = this.pendingServerRequests.get(key);
      if (pending) {
        this.pendingServerRequests.delete(key);
        pending.resolve({ decision: "cancel" });
      }
    }

    for (const listener of this.eventListeners) {
      await listener(event);
    }
  }
}

let registry: DesktopBackendRegistry | null = null;

export function getDesktopBackendRegistry(): DesktopBackendRegistry {
  if (!registry) {
    registry = new DesktopBackendRegistry();
  }

  return registry;
}

export async function disposeDesktopBackendRegistry(): Promise<void> {
  if (!registry) {
    return;
  }

  const current = registry;
  registry = null;
  await current.close();
}
