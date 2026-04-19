import path from "node:path";
import {
  AppServerSessionState,
  CodexAppServer,
  GrokRolloutStore,
  GrokProvider,
  loadLocalEnv,
  resolveGrokAppServerRuntimeConfig,
} from "@pwragnt/agent-core";
import {
  shortenDerivedThreadTitle,
} from "@pwragnt/shared";
import type {
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerThreadEntry,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadTitleSource,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  LinkedDirectorySummary,
} from "@pwragnt/shared";
import type { JsonRpcObserver } from "../codex-app-server/json-rpc";

const DEFAULT_PROTOCOL_VERSION = "1.0";

type InitializeResult = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  methods?: string[];
};

type GrokServerLike = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify?(method: string, params?: unknown): Promise<void>;
  onNotification(
    handler: (notification: AppServerNotification) => void | Promise<void>
  ): () => void;
  onRequest?(
    handler: (
      method: string,
      params?: Record<string, unknown>
    ) => Promise<unknown> | unknown
  ): () => void;
};

type GrokClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  connectionObserver?: JsonRpcObserver;
  model?: string;
  stateRoot?: string;
  directoryResolver?: (
    projectKey?: string
  ) => Promise<LinkedDirectorySummary[]>;
  server?: GrokServerLike;
  threadIdGenerator?: () => string;
  runIdGenerator?: () => string;
};

type RawThreadSummary = {
  threadId: string;
  title?: string;
  titleSource?: AppServerThreadTitleSource;
  summary?: string;
  projectKey?: string;
  createdAt?: number;
  updatedAt?: number;
};

type SkillCatalogEntry = {
  cwd?: string;
  skills: AppServerSkillSummary[];
};

function normalizeThreadSummary(thread: RawThreadSummary): RawThreadSummary {
  const normalizedTitleSource = normalizeTitleSource(thread.titleSource);
  const normalizedRawTitle = thread.title?.trim();
  const normalizedTitle =
    normalizedTitleSource === "derived"
      ? shortenDerivedThreadTitle(normalizedRawTitle) ?? "Untitled thread"
      : normalizedRawTitle || "Untitled thread";
  const normalizedSummary = thread.summary?.trim() || undefined;

  return {
    ...thread,
    title: normalizedTitle,
    titleSource:
      normalizedTitleSource ??
      (normalizedTitle === "Untitled thread" ? "fallback" : "explicit"),
    summary:
      normalizedSummary === normalizedTitle ||
      (normalizedTitleSource === "derived" && normalizedSummary === normalizedRawTitle)
        ? undefined
        : normalizedSummary,
  };
}

function normalizeTitleSource(
  value: unknown
): AppServerThreadTitleSource | undefined {
  return value === "explicit" || value === "derived" || value === "fallback"
    ? value
    : undefined;
}

async function resolveLinkedDirectories(
  projectKey?: string
): Promise<LinkedDirectorySummary[]> {
  if (!projectKey?.trim()) {
    return [];
  }

  const resolvedPath = path.resolve(projectKey);
  return [
    {
      id: resolvedPath,
      label: path.basename(resolvedPath) || resolvedPath,
      path: resolvedPath,
      kind: "local",
    },
  ];
}

function extractThreadSummaryList(value: unknown): RawThreadSummary[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as { threads?: unknown };
  if (!Array.isArray(record.threads)) {
    return [];
  }

  return record.threads
    .flatMap((thread): RawThreadSummary[] => {
      if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
        return [];
      }

      const record = thread as Record<string, unknown>;
      const threadId =
        typeof record.threadId === "string"
          ? record.threadId.trim()
          : typeof record.id === "string"
            ? record.id.trim()
            : "";

      if (!threadId) {
        return [];
      }

      return [
        {
          threadId,
          title: typeof record.title === "string" ? record.title : undefined,
          titleSource: normalizeTitleSource(record.titleSource),
          summary: typeof record.summary === "string" ? record.summary : undefined,
          projectKey:
            typeof record.projectKey === "string"
              ? record.projectKey
              : typeof record.cwd === "string"
                ? record.cwd
                : undefined,
          createdAt:
            typeof record.createdAt === "number" ? record.createdAt : undefined,
          updatedAt:
            typeof record.updatedAt === "number" ? record.updatedAt : undefined,
        },
      ];
    })
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function extractThreadReplay(value: unknown): AppServerThreadReplay {
  const pagination = {
    supportsPagination: false,
    hasPreviousPage: false,
  } as const;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      entries: [],
      messages: [],
      pagination,
    };
  }

  const record = value as {
    lastUserMessage?: unknown;
    lastAssistantMessage?: unknown;
    messages?: Array<{ role?: unknown; text?: unknown }>;
  };

  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  if (rawMessages.length === 0) {
    const fallbackMessages = [
      typeof record.lastUserMessage === "string"
        ? {
            id: "message-1",
            role: "user" as const,
            text: record.lastUserMessage,
          }
        : undefined,
      typeof record.lastAssistantMessage === "string"
        ? {
            id:
              typeof record.lastUserMessage === "string"
                ? "message-2"
                : "message-1",
            role: "assistant" as const,
            text: record.lastAssistantMessage,
          }
        : undefined,
    ].filter((message): message is { id: string; role: "user" | "assistant"; text: string } =>
      Boolean(message)
    );

    if (fallbackMessages.length > 0) {
      return {
        entries: fallbackMessages.map((message) => ({
          type: "message" as const,
          ...message,
        })),
        messages: fallbackMessages,
        lastUserMessage:
          typeof record.lastUserMessage === "string"
            ? record.lastUserMessage
            : undefined,
        lastAssistantMessage:
          typeof record.lastAssistantMessage === "string"
            ? record.lastAssistantMessage
            : undefined,
        pagination,
      };
    }
  }

  const messages = rawMessages.flatMap((message, index) => {
    if (!message || typeof message !== "object") {
      return [];
    }

    const role: "user" | "assistant" | undefined =
      message.role === "user" || message.role === "assistant"
        ? message.role
        : undefined;
    const text = typeof message.text === "string" ? message.text : undefined;
    if (!role || !text) {
      return [];
    }

    return [
      {
        id: `message-${index + 1}`,
        role,
        text,
      },
    ];
  });
  const entries: AppServerThreadEntry[] = messages.map((message) => ({
    type: "message",
    ...message,
  }));

  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;

  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = rawMessages[index];
    if (!lastUserMessage && message?.role === "user" && typeof message.text === "string") {
      lastUserMessage = message.text;
    }
    if (
      !lastAssistantMessage &&
      message?.role === "assistant" &&
      typeof message.text === "string"
    ) {
      lastAssistantMessage = message.text;
    }
    if (lastUserMessage && lastAssistantMessage) {
      break;
    }
  }

  return {
    entries,
    messages,
    lastUserMessage,
    lastAssistantMessage,
    pagination,
  };
}

function extractThreadId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return typeof record.threadId === "string"
    ? record.threadId
    : typeof record.id === "string"
      ? record.id
      : undefined;
}

function extractRunId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return typeof record.runId === "string"
    ? record.runId
    : typeof record.id === "string"
      ? record.id
      : undefined;
}

function extractSkillsList(value: unknown): SkillCatalogEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const data = Array.isArray((value as { data?: unknown }).data)
    ? ((value as { data: unknown[] }).data)
    : [];

  return data.flatMap((entry): SkillCatalogEntry[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const rawSkills = Array.isArray(record.skills) ? record.skills : [];
    const skills = rawSkills.flatMap((skill): AppServerSkillSummary[] => {
      if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
        return [];
      }

      const item = skill as Record<string, unknown>;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) {
        return [];
      }

      return [
        {
          name,
          description:
            typeof item.description === "string" ? item.description : undefined,
          shortDescription:
            typeof item.shortDescription === "string"
              ? item.shortDescription
              : typeof item.short_description === "string"
                ? item.short_description
                : undefined,
          path: typeof item.path === "string" ? item.path : undefined,
          scope: typeof item.scope === "string" ? item.scope : undefined,
          enabled: typeof item.enabled === "boolean" ? item.enabled : undefined,
        },
      ];
    });

    return [
      {
        cwd: typeof record.cwd === "string" ? record.cwd : undefined,
        skills,
      },
    ];
  });
}

export class GrokAppServerClient {
  private readonly directoryResolver: (
    projectKey?: string
  ) => Promise<LinkedDirectorySummary[]>;
  private requestCounter = 0;
  private server: GrokServerLike | null;
  private initialized = false;
  private initializeResult: InitializeResult | null = null;
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  private readonly requestListeners = new Set<
    (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  >();
  private unsubscribeNotification?: () => void;
  private unsubscribeRequest?: () => void;

  constructor(private readonly options: GrokClientOptions = {}) {
    this.directoryResolver = options.directoryResolver ?? resolveLinkedDirectories;
    this.server = options.server ?? null;
    if (this.server) {
      this.subscribeToServerNotifications(this.server);
    }
  }

  async close(): Promise<void> {
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = undefined;
    this.unsubscribeRequest?.();
    this.unsubscribeRequest = undefined;
    this.initialized = false;
    this.initializeResult = null;
  }

  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onRequest(
    listener: (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  ): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  async getInitializeResult(): Promise<InitializeResult> {
    await this.ensureInitialized();
    return this.initializeResult ?? {};
  }

  async listThreads(_params?: { filter?: string }): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();

    const result = await this.request("thread/list", {});
    return await Promise.all(
      extractThreadSummaryList(result).map(async (thread) => {
        const normalized = normalizeThreadSummary(thread);
        return {
          id: thread.threadId,
          title: normalized.title ?? "Untitled thread",
          titleSource: normalized.titleSource ?? "fallback",
          summary: normalized.summary,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          linkedDirectories: await this.directoryResolver(thread.projectKey),
          source: "grok" as const,
        };
      })
    );
  }

  async listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<SkillCatalogEntry[]> {
    await this.ensureInitialized();

    const cwds = [...new Set([...(params?.cwds ?? []), params?.cwd].filter(Boolean))];
    const result = await this.request("skills/list", { cwds });
    return extractSkillsList(result);
  }

  async readThread(params: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerThreadReplay> {
    await this.ensureInitialized();

    const result = await this.request("thread/read", {
      threadId: params.threadId,
      includeTurns: true,
      before: params.before,
      limit: params.limit,
    });

    return extractThreadReplay(result);
  }

  async startThread(params: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await this.request("thread/start", params);
    const threadId = extractThreadId(result);
    if (!threadId) {
      throw new Error("grok app server thread/start did not return threadId");
    }

    return { threadId };
  }

  async startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
  }): Promise<{ threadId: string; runId: string }> {
    await this.ensureInitialized();

    const result = await this.request("turn/start", params);
    const threadId = extractThreadId(result);
    const runId = extractRunId(result);
    if (!threadId || !runId) {
      throw new Error("grok app server turn/start did not return threadId and runId");
    }

    return { threadId, runId };
  }

  async interruptTurn(params: {
    threadId: string;
    runId: string;
  }): Promise<{ threadId: string; runId: string }> {
    await this.ensureInitialized();

    const result = await this.request("turn/interrupt", {
      threadId: params.threadId,
      turnId: params.runId,
    });
    const threadId = extractThreadId(result);
    const runId = extractRunId(result);
    if (!threadId || !runId) {
      throw new Error("grok app server turn/interrupt did not return threadId and runId");
    }

    return { threadId, runId };
  }

  async setThreadPermissions(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await this.request("thread/resume", params);
    return {
      threadId: extractThreadId(result) ?? params.threadId,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const result = await this.request("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      clientInfo: { name: "pwragnt-desktop", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });

    this.initializeResult = (result ?? {}) as InitializeResult;
    await this.notify("initialized", {});
    this.initialized = true;
  }

  private getServer(): GrokServerLike {
    if (this.server) {
      return this.server;
    }

    loadLocalEnv({ override: false });
    const runtimeConfig = resolveGrokAppServerRuntimeConfig();
    const apiKey = this.options.apiKey?.trim() || runtimeConfig.apiKey;
    if (!apiKey) {
      throw new Error("grok app server unavailable: XAI_API_KEY is not set");
    }

    const provider = new GrokProvider({
      apiKey,
      baseUrl: this.options.baseUrl?.trim() || runtimeConfig.baseUrl,
      model: this.options.model?.trim() || runtimeConfig.model,
    });
    const sessionState = new AppServerSessionState({
      store: new GrokRolloutStore(
        this.options.stateRoot?.trim() || runtimeConfig.stateRoot,
      ),
    });

    this.server = new CodexAppServer({
      provider,
      sessionState,
      threadIdGenerator: this.options.threadIdGenerator,
      runIdGenerator: this.options.runIdGenerator,
    });
    this.subscribeToServerNotifications(this.server);
    return this.server;
  }

  private subscribeToServerNotifications(server: GrokServerLike): void {
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = server.onNotification(async (notification) => {
      await this.observe({
        direction: "inbound",
        envelope: {
          jsonrpc: "2.0",
          method: notification.method,
          params: notification.params ?? {},
        },
      });
      for (const listener of this.notificationListeners) {
        await listener(notification);
      }
    });
    this.unsubscribeRequest?.();
    this.unsubscribeRequest = server.onRequest?.(async (method, params) => {
      const requestId =
        typeof params?.requestId === "string" && params.requestId.trim()
          ? params.requestId.trim()
          : `grok-request-${++this.requestCounter}`;
      await this.observe({
        direction: "inbound",
        envelope: {
          jsonrpc: "2.0",
          id: requestId,
          method,
          params: params ?? {},
        },
      });
      const request = {
        method,
        params: (params ?? {}) as AppServerPendingRequestNotification["params"],
      } satisfies AppServerPendingRequestNotification;

      const listeners = [...this.requestListeners];
      if (listeners.length === 0) {
        throw new Error(`No desktop request handler registered for ${method}`);
      }

      for (const listener of listeners) {
        try {
          const response = await listener(request);
          await this.observe({
            direction: "outbound",
            envelope: {
              jsonrpc: "2.0",
              id: requestId,
              result: response ?? {},
            },
          });
          return response;
        } catch (error) {
          await this.observe({
            direction: "outbound",
            envelope: {
              jsonrpc: "2.0",
              id: requestId,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            },
          });
          throw error;
        }
      }

      throw new Error(`No desktop request handler registered for ${method}`);
    });
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = `rpc-${++this.requestCounter}`;
    await this.observe({
      direction: "outbound",
      envelope: {
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {},
      },
    });

    try {
      const result = await this.getServer().request(method, params);
      await this.observe({
        direction: "inbound",
        envelope: {
          jsonrpc: "2.0",
          id,
          result: result ?? {},
        },
      });
      return result;
    } catch (error) {
      await this.observe({
        direction: "inbound",
        envelope: {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
      throw error;
    }
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.observe({
      direction: "outbound",
      envelope: {
        jsonrpc: "2.0",
        method,
        params: params ?? {},
      },
    });
    await this.getServer().notify?.(method, params);
  }

  private async observe(params: {
    direction: "inbound" | "outbound";
    envelope: {
      jsonrpc: "2.0";
      id?: string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: {
        code?: number;
        message?: string;
      };
    };
  }): Promise<void> {
    if (!this.options.connectionObserver) {
      return;
    }

    try {
      await this.options.connectionObserver.onMessage({
        direction: params.direction,
        raw: JSON.stringify(params.envelope),
        envelope: params.envelope,
      });
    } catch (error) {
      console.error(
        `[pwragnt:grok-client] observer failed for ${params.direction} ${
          params.envelope.method ?? params.envelope.id ?? "message"
        }: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
