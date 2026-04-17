import type {
  AgentEvent,
  AppServerListSkillsResponse,
  BackendCapabilities,
  BackendSummary,
  ListBackendsRequest,
  ListBackendsResponse,
  AppServerBackendKind,
  AppServerNotification,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AppServerTurnInputItem,
} from "@pwragnt/shared";
import { CodexAppServerClient } from "../codex-app-server/client";
import { GrokAppServerClient } from "../grok-app-server/client";

type BackendClient = {
  close(): Promise<void>;
  getInitializeResult(): Promise<{
    serverInfo?: {
      name?: string;
      version?: string;
    };
    methods?: string[];
  }>;
  listThreads(params?: { filter?: string }): Promise<AppServerThreadSummary[]>;
  listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<AppServerListSkillsResponse["data"]>;
  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
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
};

const BACKEND_LABELS: Record<AppServerBackendKind, string> = {
  codex: "Codex app server",
  grok: "Grok app server",
};

function buildCapabilities(methods: string[], backend: AppServerBackendKind): BackendCapabilities {
  const supported = new Set(methods);

  return {
    listThreads:
      supported.has("thread/list") || supported.has("thread/loaded/list"),
    createThread: supported.has("thread/start") || supported.has("thread/new"),
    resumeThread: supported.has("thread/resume"),
    readThread: supported.has("thread/read"),
    startTurn: supported.has("turn/start"),
    interruptTurn: supported.has("turn/interrupt"),
    steerTurn: supported.has("turn/steer"),
    transcriptPagination: false,
    toolUse: false,
    approvalRequests: false,
    multiDirectoryThreads: backend === "codex",
  };
}

export class DesktopBackendRegistry {
  private readonly codexClient: BackendClient;
  private readonly grokClient: BackendClient;
  private readonly eventListeners = new Set<
    (event: AgentEvent) => void | Promise<void>
  >();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options?: {
    codexClient?: BackendClient;
    grokClient?: BackendClient;
  }) {
    this.codexClient = options?.codexClient ?? new CodexAppServerClient();
    this.grokClient = options?.grokClient ?? new GrokAppServerClient();

    this.unsubscribers.push(
      this.codexClient.onNotification(async (notification) => {
        await this.emit({ backend: "codex", notification });
      }),
    );
    this.unsubscribers.push(
      this.grokClient.onNotification(async (notification) => {
        await this.emit({ backend: "grok", notification });
      }),
    );
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
      this.describeBackend("codex", this.codexClient),
      this.describeBackend("grok", this.grokClient),
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
    if (params.backend) {
      return await this.getClient(params.backend).listThreads({
        filter: params.filter,
      });
    }

    const availableBackends = (await this.listBackends()).backends.map(
      (backend) => backend.kind,
    );
    const threadLists = await Promise.all(
      availableBackends.map(async (backend) =>
        await this.getClient(backend).listThreads({ filter: params.filter }),
      ),
    );

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
    const replay = await this.getClient(backend).readThread({
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
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string }> {
    const result = await this.getClient(params.backend).startThread(params);
    return {
      backend: params.backend,
      threadId: result.threadId,
    };
  }

  async startTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; runId: string }> {
    const result = await this.getClient(params.backend).startTurn(params);
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
    const result = await this.getClient(params.backend).interruptTurn(params);
    return {
      backend: params.backend,
      threadId: result.threadId,
      runId: result.runId,
    };
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    await this.codexClient.close();
    await this.grokClient.close();
  }

  private getClient(backend: AppServerBackendKind): BackendClient {
    return backend === "grok" ? this.grokClient : this.codexClient;
  }

  private async describeBackend(
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
      };
    } catch (error) {
      return {
        kind,
        label: BACKEND_LABELS[kind],
        available: false,
        methods: [],
        capabilities: buildCapabilities([], kind),
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async emit(event: AgentEvent): Promise<void> {
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
