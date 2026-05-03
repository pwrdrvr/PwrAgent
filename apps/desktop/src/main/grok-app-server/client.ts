import {
  AppServerSessionState,
  CodexAppServer,
  GrokRolloutStore,
  GrokProvider,
  loadLocalEnv,
  resolveGrokAppServerRuntimeConfig,
} from "@pwragent/agent-core";
import {
  shortenDerivedThreadTitle,
} from "@pwragent/shared";
import type {
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessagePart,
  AppServerThreadReviewEntry,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadStatus,
  AppServerThreadTitleSource,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  BackendModelOption,
  LinkedDirectorySummary,
} from "@pwragent/shared";
import type {
  JsonRpcObserver,
  JsonRpcObserverDiagnostics,
} from "../codex-app-server/json-rpc";
import { summarizeToolActivityItems } from "../app-server/thread-activity";
import { getMainLogger } from "../log";
import {
  createThreadDirectoryEnricher,
  type ThreadDirectoryEnrichment,
} from "../app-server/thread-directory-enricher";

const DEFAULT_PROTOCOL_VERSION = "1.0";
const grokClientLog = getMainLogger("pwragent:grok-client");

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
  threadDirectoryEnricher?: (
    projectKey?: string
  ) => Promise<ThreadDirectoryEnrichment>;
  server?: GrokServerLike;
  threadIdGenerator?: () => string;
  turnIdGenerator?: () => string;
};

type RawThreadSummary = {
  threadId: string;
  title?: string;
  titleSource?: AppServerThreadTitleSource;
  summary?: string;
  projectKey?: string;
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

type SkillCatalogEntry = {
  cwd?: string;
  skills: AppServerSkillSummary[];
};

type ReplayMessage = {
  id: string;
  parts?: AppServerThreadMessagePart[];
  role: "user" | "assistant";
  text: string;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeThreadStatus(value: string | undefined): AppServerThreadStatus | undefined {
  const normalized = value?.trim().replace(/[-_\s]/g, "").toLowerCase();
  if (normalized === "active") {
    return "active";
  }
  if (normalized === "idle") {
    return "idle";
  }
  if (normalized === "notloaded") {
    return "notLoaded";
  }
  if (normalized === "unknown") {
    return "unknown";
  }
  return undefined;
}

function readThreadStatus(value: unknown): AppServerThreadStatus | undefined {
  if (typeof value === "string") {
    return normalizeThreadStatus(value);
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const status = asRecord(record.status);
  const thread = asRecord(record.thread) ?? asRecord(record.session);
  const threadStatus = asRecord(thread?.status);

  return normalizeThreadStatus(
    readString(status, "type") ??
      readString(status, "status") ??
      readString(status, "state") ??
      readString(threadStatus, "type") ??
      readString(threadStatus, "status") ??
      readString(threadStatus, "state") ??
      readString(record, "status") ??
      readString(record, "state") ??
      readString(thread, "status") ??
      readString(thread, "state")
  );
}

function withThreadStatus(
  replay: AppServerThreadReplay,
  source: unknown
): AppServerThreadReplay {
  const threadStatus = readThreadStatus(source);
  return threadStatus ? { ...replay, threadStatus } : replay;
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
          model: typeof record.model === "string" ? record.model : undefined,
          serviceTier:
            typeof record.serviceTier === "string" ? record.serviceTier : undefined,
          reasoningEffort:
            typeof record.reasoningEffort === "string"
              ? record.reasoningEffort
              : undefined,
          fastMode: typeof record.fastMode === "boolean" ? record.fastMode : undefined,
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
    messages?: Array<{ role?: unknown; text?: unknown; parts?: unknown }>;
    items?: unknown[];
  };

  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  const messages = normalizeRawMessages(rawMessages);
  const rawItems = Array.isArray(record.items)
    ? record.items
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
  const replayFromItems = extractReplayFromItems(rawItems, pagination);
  if (replayFromItems) {
    if (replayFromItems.messages.length > 0 || messages.length === 0) {
      return withThreadStatus(replayFromItems, value);
    }
    return withThreadStatus(
      buildReplayFromMessages(messages, pagination, activityEntries(replayFromItems)),
      value
    );
  }

  if (messages.length > 0) {
    return withThreadStatus(buildReplayFromMessages(messages, pagination), value);
  }

  if (rawMessages.length === 0) {
    const fallbackMessages = fallbackLastMessages(record);
    if (fallbackMessages.length > 0) {
      return withThreadStatus(buildReplayFromMessages(fallbackMessages, pagination), value);
    }
  }

  return withThreadStatus(buildReplayFromMessages([], pagination), value);
}

function fallbackLastMessages(record: {
  lastUserMessage?: unknown;
  lastAssistantMessage?: unknown;
}): ReplayMessage[] {
  return [
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
  ].filter((message): message is ReplayMessage =>
    Boolean(message)
  );
}

function normalizeRenderableImageUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("data:image/")
  ) {
    return trimmed;
  }

  if (trimmed.startsWith("/")) {
    return `file://${trimmed}`;
  }

  return undefined;
}

function extractStructuredMessageParts(value: unknown): AppServerThreadMessagePart[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractStructuredMessageParts(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const normalizedType =
    typeof record.type === "string" ? record.type.trim().toLowerCase() : undefined;

  if (normalizedType === "text" || normalizedType === "input_text") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    return text ? [{ type: "text", text }] : [];
  }

  const imageUrl = normalizeRenderableImageUrl(
    typeof record.url === "string"
      ? record.url
      : typeof record.path === "string"
        ? record.path
        : undefined,
  );
  if (imageUrl && (normalizedType === "image" || normalizedType === "localimage")) {
    const part: AppServerThreadImagePart = {
      type: "image",
      url: imageUrl,
    };
    return [part];
  }

  return [];
}

function normalizeRawMessages(
  rawMessages: Array<{ role?: unknown; text?: unknown; parts?: unknown }>,
): ReplayMessage[] {
  return rawMessages.flatMap((message, index) => {
    if (!message || typeof message !== "object") {
      return [];
    }

    const role: "user" | "assistant" | undefined =
      message.role === "user" || message.role === "assistant"
        ? message.role
        : undefined;
    const text = typeof message.text === "string" ? message.text : undefined;
    const parts = extractStructuredMessageParts(message.parts);
    if (!role || (text === undefined && parts.length === 0)) {
      return [];
    }

    return [
      {
        id: `message-${index + 1}`,
        role,
        text: text ?? "",
        ...(parts.length > 0 ? { parts } : {}),
      },
    ];
  });
}

function buildReplayFromMessages(
  messages: ReplayMessage[],
  pagination: AppServerThreadReplay["pagination"],
  activityEntries: AppServerThreadEntry[] = [],
): AppServerThreadReplay {
  const entries: AppServerThreadEntry[] = [];
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  let insertedActivity = false;

  for (const [index, message] of messages.entries()) {
    entries.push({
      type: "message",
      ...message,
    });
    if (index === lastUserIndex) {
      entries.push(...activityEntries);
      insertedActivity = true;
    }
  }

  if (!insertedActivity) {
    entries.push(...activityEntries);
  }

  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!lastUserMessage && message?.role === "user") {
      lastUserMessage = message.text;
    }
    if (!lastAssistantMessage && message?.role === "assistant") {
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

function activityEntries(replay: AppServerThreadReplay): AppServerThreadEntry[] {
  return replay.entries.filter((entry) => entry.type === "activity");
}

function extractReplayFromItems(
  items: Record<string, unknown>[],
  pagination: AppServerThreadReplay["pagination"],
): AppServerThreadReplay | undefined {
  if (!items.some((item) => isActivityReplayItem(item) || isReviewReplayItem(item))) {
    return undefined;
  }

  const entries: AppServerThreadEntry[] = [];
  const messages: ReplayMessage[] = [];
  let pendingActivity: Record<string, unknown>[] = [];
  let messageIndex = 0;

  const flushActivity = () => {
    const activity = summarizeToolActivityItems(pendingActivity);
    pendingActivity = [];
    if (activity) {
      entries.push(activity);
    }
  };

  for (const item of items) {
    const message = itemToMessage(item, ++messageIndex);
    if (message) {
      flushActivity();
      entries.push({
        type: "message",
        ...message,
      });
      messages.push(message);
      continue;
    }
    messageIndex -= 1;
    if (isActivityReplayItem(item)) {
      pendingActivity.push(item);
      continue;
    }
    const reviewEntry = itemToReviewEntry(item);
    if (reviewEntry) {
      flushActivity();
      entries.push(reviewEntry);
    }
  }
  flushActivity();

  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!lastUserMessage && message?.role === "user") {
      lastUserMessage = message.text;
    }
    if (!lastAssistantMessage && message?.role === "assistant") {
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

function itemToReviewEntry(item: Record<string, unknown>): AppServerThreadReviewEntry | undefined {
  const type = typeof item.type === "string" ? item.type : undefined;
  if (type !== "enteredReviewMode" && type !== "exitedReviewMode") {
    return undefined;
  }
  const review = typeof item.review === "string"
    ? item.review
    : typeof item.text === "string"
      ? item.text
      : "";
  const data = asRecord(item.data);
  const output = asRecord(data?.reviewOutput);
  const findings = Array.isArray(output?.findings) ? output.findings : undefined;
  return {
    type: "review",
    id: typeof item.id === "string" ? item.id : `review-${type}`,
    review,
    displayText: type === "enteredReviewMode" ? review || "Code review started" : undefined,
    ...(output &&
    findings &&
    (output.overall_correctness === "patch is correct" ||
      output.overall_correctness === "patch is incorrect") &&
    typeof output.overall_explanation === "string" &&
    typeof output.overall_confidence_score === "number"
      ? {
          output: {
            findings: findings as NonNullable<AppServerThreadReviewEntry["output"]>["findings"],
            overall_correctness: output.overall_correctness,
            overall_explanation: output.overall_explanation,
            overall_confidence_score: output.overall_confidence_score,
          },
        }
      : {}),
  };
}

function itemToMessage(item: Record<string, unknown>, index: number): ReplayMessage | undefined {
  const type = typeof item.type === "string" ? item.type : undefined;
  const role =
    item.role === "user" || type === "userMessage"
      ? "user"
      : item.role === "assistant" || type === "agentMessage"
        ? "assistant"
        : undefined;
  const text = typeof item.text === "string" ? item.text : undefined;
  const parts = extractStructuredMessageParts(item.parts ?? item.content);
  if (!role || (text === undefined && parts.length === 0)) {
    return undefined;
  }
  return {
    id: `message-${index}`,
    role,
    text: text ?? "",
    ...(parts.length > 0 ? { parts } : {}),
  };
}

function isActivityReplayItem(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type : undefined;
  const toolName = typeof item.toolName === "string" ? item.toolName : undefined;
  return (
    type === "dynamicToolCall" ||
    type === "commandExecution" ||
    Boolean(toolName)
  );
}

function isReviewReplayItem(item: Record<string, unknown>): boolean {
  return item.type === "enteredReviewMode" || item.type === "exitedReviewMode";
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

function extractTurnId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return typeof record.turnId === "string"
    ? record.turnId
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

function extractModelOptions(value: unknown): BackendModelOption[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const data = Array.isArray((value as { data?: unknown }).data)
    ? ((value as { data: unknown[] }).data)
    : [];

  return data.flatMap((entry): BackendModelOption[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      return [];
    }

    return [
      {
        id,
        label: typeof record.label === "string" ? record.label : undefined,
        current: typeof record.current === "boolean" ? record.current : undefined,
        supportsReasoning:
          typeof record.supportsReasoning === "boolean"
            ? record.supportsReasoning
            : undefined,
        supportsFast:
          typeof record.supportsFast === "boolean" ? record.supportsFast : undefined,
        supportsSteering:
          typeof record.supportsSteering === "boolean" ? record.supportsSteering : false,
      },
    ];
  });
}

export class GrokAppServerClient {
  private readonly threadDirectoryEnricher: (
    projectKey?: string
  ) => Promise<ThreadDirectoryEnrichment>;
  private requestCounter = 0;
  private server: GrokServerLike | null;
  private initialized = false;
  private initializePromise?: Promise<void>;
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
    this.threadDirectoryEnricher =
      options.threadDirectoryEnricher ??
      (options.directoryResolver
        ? async (projectKey?: string) => ({
            linkedDirectories: await options.directoryResolver!(projectKey),
          })
        : createThreadDirectoryEnricher());
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
    this.initializePromise = undefined;
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

  async listThreads(params?: {
    archived?: boolean;
    filter?: string;
  }, diagnostics?: JsonRpcObserverDiagnostics): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();

    const result = await this.request("thread/list", {
      archived: params?.archived === true,
      filter: params?.filter,
    }, diagnostics);
    return await Promise.all(
      extractThreadSummaryList(result).map(async (thread) => {
        const normalized = normalizeThreadSummary(thread);
        const enrichment = await this.threadDirectoryEnricher(thread.projectKey);
        return {
          id: thread.threadId,
          title: normalized.title ?? "Untitled thread",
          titleSource: normalized.titleSource ?? "fallback",
          summary: normalized.summary,
          ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          model: thread.model,
          serviceTier: thread.serviceTier,
          reasoningEffort: thread.reasoningEffort,
          fastMode: thread.fastMode,
          linkedDirectories: enrichment.linkedDirectories,
          ...(enrichment.observedGitBranch
            ? { observedGitBranch: enrichment.observedGitBranch }
            : {}),
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

  async listModels(
    diagnostics?: JsonRpcObserverDiagnostics,
  ): Promise<BackendModelOption[]> {
    await this.ensureInitialized();

    const result = await this.request("model/list", {}, diagnostics);
    return extractModelOptions(result);
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
    fastMode?: boolean;
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
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; turnId: string }> {
    await this.ensureInitialized();

    await this.request("thread/resume", {
      threadId: params.threadId,
      model: params.model,
      serviceTier: params.serviceTier,
      reasoningEffort: params.reasoningEffort,
      fastMode: params.fastMode,
    });

    const result = await this.request("turn/start", params);
    const threadId = extractThreadId(result);
    const turnId = extractTurnId(result);
    if (!threadId || !turnId) {
      throw new Error("grok app server turn/start did not return threadId and turnId");
    }

    return { threadId, turnId };
  }

  async startReview(params: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: AppServerReviewDelivery;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> {
    await this.ensureInitialized();

    await this.request("thread/resume", {
      threadId: params.threadId,
    });

    const result = await this.request("review/start", {
      threadId: params.threadId,
      target: params.target,
      delivery: params.delivery ?? "inline",
    });
    const record = asRecord(result);
    const threadId = extractThreadId(result) ?? params.threadId;
    const reviewThreadId =
      typeof record?.reviewThreadId === "string"
        ? record.reviewThreadId
        : typeof record?.review_thread_id === "string"
          ? record.review_thread_id
          : threadId;
    const turnId = extractTurnId(result);
    if (!turnId) {
      throw new Error("grok app server review/start did not return turnId");
    }

    return { threadId, reviewThreadId, turnId };
  }

  async interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    await this.ensureInitialized();

    const result = await this.request("turn/interrupt", {
      threadId: params.threadId,
      turnId: params.turnId,
    });
    const threadId = extractThreadId(result);
    const turnId = extractTurnId(result);
    if (!threadId || !turnId) {
      throw new Error("grok app server turn/interrupt did not return threadId and turnId");
    }

    return { threadId, turnId };
  }

  async setThreadPermissions(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await this.request("thread/resume", params);
    return {
      threadId: extractThreadId(result) ?? params.threadId,
    };
  }

  async archiveThread(params: { threadId: string }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await this.request("thread/archive", {
      threadId: params.threadId,
    });
    return {
      threadId: extractThreadId(result) ?? params.threadId,
    };
  }

  async restoreThread(params: { threadId: string }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await this.request("thread/unarchive", {
      threadId: params.threadId,
    });
    return {
      threadId: extractThreadId(result) ?? params.threadId,
    };
  }

  async renameThread(params: {
    threadId: string;
    name: string;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await this.request("thread/name/set", {
      threadId: params.threadId,
      name: params.name,
    });
    return {
      threadId: extractThreadId(result) ?? params.threadId,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.initializePromise ??= (async () => {
      const result = await this.request("initialize", {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        clientInfo: { name: "pwragent-desktop", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });

      await this.notify("initialized", {});
      this.initializeResult = (result ?? {}) as InitializeResult;
      this.initialized = true;
    })().catch((error) => {
      this.initialized = false;
      this.initializeResult = null;
      this.initializePromise = undefined;
      throw error;
    });

    await this.initializePromise;
  }

  private getServer(): GrokServerLike {
    if (this.server) {
      return this.server;
    }

    loadLocalEnv({ override: false });
    const runtimeConfig = resolveGrokAppServerRuntimeConfig();
    const apiKey = this.options.apiKey?.trim();
    if (!apiKey) {
      throw new Error("grok app server unavailable: Grok API key is not set");
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

    const server = new CodexAppServer({
      provider,
      sessionState,
      threadIdGenerator: this.options.threadIdGenerator,
      turnIdGenerator: this.options.turnIdGenerator,
    });
    this.server = server;
    this.subscribeToServerNotifications(server);
    return server;
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

  private async request(
    method: string,
    params?: unknown,
    diagnostics?: JsonRpcObserverDiagnostics,
  ): Promise<unknown> {
    const id = `rpc-${++this.requestCounter}`;
    const server = this.getServer();

    await this.observe({
      direction: "outbound",
      diagnostics,
      envelope: {
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {},
      },
    });

    try {
      const result = await server.request(method, params);
      await this.observe({
        direction: "inbound",
        diagnostics,
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
        diagnostics,
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
    const server = this.getServer();

    await this.observe({
      direction: "outbound",
      envelope: {
        jsonrpc: "2.0",
        method,
        params: params ?? {},
      },
    });
    await server.notify?.(method, params);
  }

  private async observe(params: {
    direction: "inbound" | "outbound";
    diagnostics?: JsonRpcObserverDiagnostics;
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
        diagnostics: params.diagnostics,
      });
    } catch (error) {
      grokClientLog.error("observer failed", {
        backend: "grok",
        direction: params.direction,
        message: params.envelope.method ?? params.envelope.id ?? "message",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
