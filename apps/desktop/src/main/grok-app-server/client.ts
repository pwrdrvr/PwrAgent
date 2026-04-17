import path from "node:path";
import {
  CodexAppServer,
  GrokProvider,
  loadGrokAppServerConfig,
  loadLocalEnv,
} from "@pwragnt/agent-core";
import type {
  AppServerNotification,
  AppServerThreadEntry,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  LinkedDirectorySummary,
} from "@pwragnt/shared";

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
};

type GrokClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
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
  return {
    ...thread,
    title: thread.title?.trim() || "Untitled thread",
    summary: thread.summary?.trim() || undefined,
  };
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

  if (
    typeof record.lastUserMessage === "string" ||
    typeof record.lastAssistantMessage === "string"
  ) {
    return {
      entries: [],
      messages: [],
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

  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
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
  private server: GrokServerLike | null;
  private initialized = false;
  private initializeResult: InitializeResult | null = null;
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  private unsubscribeNotification?: () => void;

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

  async getInitializeResult(): Promise<InitializeResult> {
    await this.ensureInitialized();
    return this.initializeResult ?? {};
  }

  async listThreads(_params?: { filter?: string }): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();

    const result = await this.getServer().request("thread/list", {});
    return await Promise.all(
      extractThreadSummaryList(result).map(async (thread) => ({
        id: thread.threadId,
        title: normalizeThreadSummary(thread).title ?? "Untitled thread",
        summary: normalizeThreadSummary(thread).summary,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        linkedDirectories: await this.directoryResolver(thread.projectKey),
        source: "grok" as const,
      }))
    );
  }

  async listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<SkillCatalogEntry[]> {
    await this.ensureInitialized();

    const cwds = [...new Set([...(params?.cwds ?? []), params?.cwd].filter(Boolean))];
    const result = await this.getServer().request("skills/list", { cwds });
    return extractSkillsList(result);
  }

  async readThread(params: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerThreadReplay> {
    await this.ensureInitialized();

    const result = await this.getServer().request("thread/read", {
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

    const result = await this.getServer().request("thread/start", params);
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

    const result = await this.getServer().request("turn/start", params);
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

    const result = await this.getServer().request("turn/interrupt", {
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

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const server = this.getServer();
    const result = await server.request("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      clientInfo: { name: "pwragnt-desktop", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });

    this.initializeResult = (result ?? {}) as InitializeResult;
    await server.notify?.("initialized", {});
    this.initialized = true;
  }

  private getServer(): GrokServerLike {
    if (this.server) {
      return this.server;
    }

    loadLocalEnv({ override: false });
    loadGrokAppServerConfig({ override: false });
    const apiKey = this.options.apiKey?.trim() || process.env.XAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("grok app server unavailable: XAI_API_KEY is not set");
    }

    const provider = new GrokProvider({
      apiKey,
      baseUrl: this.options.baseUrl?.trim() || process.env.XAI_BASE_URL?.trim(),
      model: this.options.model?.trim() || process.env.GROK_MODEL?.trim(),
    });

    this.server = new CodexAppServer({
      provider,
      threadIdGenerator: this.options.threadIdGenerator,
      runIdGenerator: this.options.runIdGenerator,
    });
    this.subscribeToServerNotifications(this.server);
    return this.server;
  }

  private subscribeToServerNotifications(server: GrokServerLike): void {
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = server.onNotification(async (notification) => {
      for (const listener of this.notificationListeners) {
        await listener(notification);
      }
    });
  }
}
