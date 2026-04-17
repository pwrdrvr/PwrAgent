import { OverlayStore } from "@pwragnt/agent-core";
import type {
  AgentEvent,
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  AppServerBackendKind,
  BackendCapabilities,
  BackendSummary,
  ListBackendsRequest,
  ListBackendsResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  StartThreadResponse,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { CodexAppServerClient } from "../codex-app-server/client";
import { GrokAppServerClient } from "../grok-app-server/client";
import { createScratchProjectDirectory } from "./scratch-projects";
import { getDesktopOverlayStore } from "./desktop-overlay-store";

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
  listThreads(params?: { filter?: string }): Promise<AppServerThreadSummary[]>;
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
  }): Promise<{ threadId: string }>;
  startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
  }): Promise<{ threadId: string; runId: string }>;
  interruptTurn(params: {
    threadId: string;
    runId: string;
  }): Promise<{ threadId: string; runId: string }>;
  setThreadPermissions?(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string }>;
};

type PendingServerRequest = {
  resolve: (response: SubmitServerRequestRequest["response"]) => void;
  reject: (error: Error) => void;
};

const BACKEND_LABELS: Record<AppServerBackendKind, string> = {
  codex: "Codex app server",
  grok: "Grok app server",
};

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

export class DesktopBackendRegistry {
  private readonly codexDefaultClient: BackendClient;
  private readonly codexFullAccessClient: BackendClient;
  private readonly grokClient: BackendClient;
  private readonly overlayStore: OverlayStore;
  private readonly createScratchProjectDirectory: () => Promise<string>;
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
    createScratchProjectDirectory?: () => Promise<string>;
  }) {
    this.codexDefaultClient = options?.codexClient ?? new CodexAppServerClient();
    this.codexFullAccessClient =
      options?.codexFullAccessClient ??
      new CodexAppServerClient({
        args: buildCodexClientArgs("full-access"),
      });
    this.grokClient = options?.grokClient ?? new GrokAppServerClient();
    this.overlayStore = options?.overlayStore ?? getDesktopOverlayStore();
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
    backend?: AppServerBackendKind;
    filter?: string;
  } = {}): Promise<AppServerThreadSummary[]> {
    if (params.backend === "codex") {
      return await this.listCodexThreads(params.filter);
    }

    if (params.backend === "grok") {
      return await this.grokClient.listThreads({ filter: params.filter });
    }

    const threadLists = await Promise.all([
      this.listCodexThreads(params.filter),
      this.grokClient.listThreads({ filter: params.filter }).catch(() => []),
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
  }): Promise<StartThreadResponse> {
    const { backend, executionMode = "default", ...request } = params;
    const modeSettings = EXECUTION_MODE_SUMMARIES[executionMode];
    const cwd =
      backend === "codex" && !request.cwd?.trim()
        ? await this.createScratchProjectDirectory()
        : request.cwd;

    const result = await this.getClient(backend, executionMode).startThread({
      ...request,
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
  }): Promise<{ backend: AppServerBackendKind; threadId: string; runId: string }> {
    const result =
      params.backend === "codex"
        ? await this.withCodexThreadClient(params.threadId, async (client) =>
            await client.startTurn(params),
          )
        : await this.grokClient.startTurn(params);

    return {
      backend: params.backend,
      threadId: result.threadId,
      runId: result.runId,
    };
  }

  async interruptTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    runId: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; runId: string }> {
    const result =
      params.backend === "codex"
        ? await this.withCodexThreadClient(params.threadId, async (client) =>
            await client.interruptTurn(params),
          )
        : await this.grokClient.interruptTurn(params);

    return {
      backend: params.backend,
      threadId: result.threadId,
      runId: result.runId,
    };
  }

  async setThreadExecutionMode(
    params: SetThreadExecutionModeRequest
  ): Promise<SetThreadExecutionModeResponse> {
    if (params.backend !== "codex") {
      return params;
    }

    const modeSettings = EXECUTION_MODE_SUMMARIES[params.executionMode];
    const client = this.getClient("codex", params.executionMode);
    if (!client.setThreadPermissions) {
      throw new Error("Selected backend does not support execution mode updates");
    }

    await client.setThreadPermissions({
      threadId: params.threadId,
      approvalPolicy: modeSettings.approvalPolicy,
      sandbox: modeSettings.sandbox,
    });

    await this.overlayStore.setThreadExecutionMode({
      backend: "codex",
      threadId: params.threadId,
      executionMode: params.executionMode,
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: params.executionMode,
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
      runId: params.runId,
      requestId: params.requestId,
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

  private async listCodexThreads(filter?: string): Promise<AppServerThreadSummary[]> {
    const [defaultThreads, fullAccessThreads] = await Promise.all([
      this.codexDefaultClient.listThreads({ filter }).catch(() => []),
      this.codexFullAccessClient.listThreads({ filter }).catch(() => []),
    ]);

    const threadsById = new Map<string, AppServerThreadSummary>();
    const allThreads = [
      ...defaultThreads.map((thread) => ({
        ...thread,
        executionMode: "default" as const,
      })),
      ...fullAccessThreads.map((thread) => ({
        ...thread,
        executionMode: "full-access" as const,
      })),
    ];

    for (const thread of allThreads) {
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: thread.id,
      });
      const preferredMode = overlay?.executionMode;
      const existing = threadsById.get(thread.id);
      const normalizedThread = {
        ...thread,
        executionMode: preferredMode ?? thread.executionMode,
      };

      if (!existing) {
        threadsById.set(thread.id, normalizedThread);
        continue;
      }

      if (
        preferredMode
          ? normalizedThread.executionMode === preferredMode
          : normalizedThread.executionMode === "default"
      ) {
        threadsById.set(thread.id, normalizedThread);
      }
    }

    return [...threadsById.values()].sort(
      (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
  }

  private async describeCodexBackend(): Promise<BackendSummary> {
    const [defaultResult, fullAccessResult] = await Promise.allSettled([
      this.codexDefaultClient.getInitializeResult(),
      this.codexFullAccessClient.getInitializeResult(),
    ]);
    const successful = [defaultResult, fullAccessResult].flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const methods = mergeMethods(successful);
    const available = successful.length > 0;
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
