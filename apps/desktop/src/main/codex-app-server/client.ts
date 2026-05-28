import path from "node:path";
import {
  isToolManagedWorktreePath,
  shortenDerivedThreadTitle,
} from "@pwragent/shared";
import type {
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerThreadCommandDetail,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadActivityStatus,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessagePart,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerThreadReviewEntry,
  AppServerThreadPlanStep,
  AppServerThreadPlanStepStatus,
  AppServerThreadTurnMetadata,
  AppServerThreadTurnStatus,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadReplayPagination,
  AppServerThreadStatus,
  AppServerThreadTitleSource,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  AppServerCollaborationModeRequest,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  BackendAccountSummary,
  BackendModelOption,
  BackendRateLimitSummary,
  CodexThreadEnvironmentRuntime,
  LinkedDirectorySummary,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import type {
  ClientRequest as CodexClientRequest,
  InitializeParams as CodexInitializeParams,
  ReasoningEffort as CodexReasoningEffort,
  ServerRequest as CodexServerRequest,
  ServiceTier as CodexServiceTier,
} from "@pwragent/codex-app-server-protocol";
import type {
  AskForApproval as CodexAskForApproval,
  ConfigValueWriteParams as CodexConfigValueWriteParams,
  ModelListParams as CodexModelListParams,
  SandboxMode as CodexSandboxMode,
  SandboxPolicy as CodexSandboxPolicy,
  ReviewStartParams as CodexReviewStartParams,
  SkillsListParams as CodexSkillsListParams,
  ThreadListParams as CodexThreadListParams,
  ThreadReadParams as CodexThreadReadParams,
  ThreadResumeParams as CodexThreadResumeParams,
  ThreadStartParams as CodexThreadStartParams,
  TurnInterruptParams as CodexTurnInterruptParams,
  TurnStartParams as CodexTurnStartParams,
  TurnSteerParams as CodexTurnSteerParams,
  DynamicToolSpec as CodexDynamicToolSpec,
  UserInput as CodexUserInput,
} from "@pwragent/codex-app-server-protocol/v2";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import {
  JsonRpcConnection,
  type JsonRpcId,
  type JsonRpcObserver,
  type JsonRpcObserverDiagnostics,
} from "./json-rpc";
import {
  createThreadDirectoryEnricher,
  type ThreadDirectoryEnrichment,
} from "../app-server/thread-directory-enricher";
import { normalizeReviewDisplayText } from "../../shared/review-command";
import { StdioJsonRpcTransport } from "./stdio-transport";
import type {
  ThreadTitleAdapterParams,
  ThreadTitleAdapterResult,
} from "../app-server/thread-title-generation-service";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const ARCHIVED_THREAD_METADATA_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_CODEX_COLLABORATION_MODEL = "gpt-5.5";
const DEFAULT_CODEX_THREAD_TITLE_MODEL = "gpt-5.4-mini";
const DEFAULT_CODEX_THREAD_TITLE_TIMEOUT_MS = 20_000;
const CODEX_THREAD_TITLE_CONFIG: NonNullable<CodexThreadStartParams["config"]> = {
  web_search: "disabled",
};
const SUPPORTED_CODEX_MODEL_ORDER = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
] as const;
const SUPPORTED_CODEX_MODELS = new Set<string>(SUPPORTED_CODEX_MODEL_ORDER);

type CodexClientOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  directoryResolver?: (
    projectKey?: string
  ) => Promise<LinkedDirectorySummary[]>;
  threadDirectoryEnricher?: (
    projectKey?: string
  ) => Promise<ThreadDirectoryEnrichment>;
  connectionObserver?: JsonRpcObserver;
  requestTimeoutMs?: number;
  clientVersion?: string;
  /**
   * Gate predicate consulted on every `ensureInitialized` call. When it
   * returns true, the client refuses to spawn / connect the Codex CLI
   * subprocess and throws {@link CodexBootstrapDeferredError}. The
   * BackendRegistry wires this to `DesktopSettingsService
   * .isCodexBootstrapDeferred()` so a brand-new PwrAgent profile (or
   * one mid-wizard) doesn't slurp threads from an arbitrary Codex
   * identity AND, importantly, doesn't even attempt to spawn the
   * `codex` binary on machines that don't have it installed yet. The
   * gate is the architectural boundary between "we know what backend
   * the operator wants" and "fire it up."
   */
  isCodexBootstrapDeferred?: () => boolean;
};

/**
 * Thrown by `ensureInitialized` when `isCodexBootstrapDeferred` returns
 * true. Callers catch this to surface a clean "backend deferred" state
 * (e.g. `describeCodexBackend` reports `available: false` with a
 * recognizable reason) instead of treating it as a Codex CLI error.
 */
export class CodexBootstrapDeferredError extends Error {
  constructor(message = "codex bootstrap deferred until onboarding completes") {
    super(message);
    this.name = "CodexBootstrapDeferredError";
  }
}

type InitializeResult = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  methods?: string[];
};

type RawCodexThreadSummary = Omit<
  AppServerThreadSummary,
  "source" | "linkedDirectories"
> & {
  projectKey?: string;
  gitOriginUrl?: string;
};

type RawCodexThreadListPage = {
  nextCursor?: string;
  threads: RawCodexThreadSummary[];
};

type SkillCatalogEntry = {
  cwd?: string;
  skills: AppServerSkillSummary[];
};

type CodexThreadNameRecord = {
  id: string;
  threadName: string;
};

type CodexClientRequestMethod = CodexClientRequest["method"];
type CodexServerRequestMethod = CodexServerRequest["method"];

const KNOWN_NOTIFICATION_METHODS = new Set<string>([
  "thread/started",
  "turn/started",
  "turn/completed",
  "turn/failed",
  "turn/cancelled",
  "item/agentMessage/delta",
  "item/started",
  "item/completed",
  "item/plan/delta",
  "turn/plan/updated",
  "turn/diff/updated",
  "serverRequest/resolved",
  "warning",
  "configWarning",
  "thread/compacted",
  "thread/archived",
  "thread/unarchived",
  "skills/changed",
  "thread/name/updated",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/requestApproval",
  "review/requestApproval",
  "account/updated",
  "account/rateLimits/updated",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
]);
const GENERATED_CODEX_NOTIFICATION_METHODS = new Set<string>([
  "warning",
  "configWarning",
  "thread/started",
  "turn/started",
  "turn/completed",
  "item/agentMessage/delta",
  "item/started",
  "item/completed",
  "item/plan/delta",
  "turn/plan/updated",
  "turn/diff/updated",
  "serverRequest/resolved",
  "thread/compacted",
  "thread/archived",
  "thread/unarchived",
  "skills/changed",
  "thread/name/updated",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "account/updated",
  "account/rateLimits/updated",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "mcpServer/startupStatus/updated",
]);
const GENERATED_CODEX_SERVER_REQUEST_METHODS = new Set<CodexServerRequestMethod>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "applyPatchApproval",
  "execCommandApproval",
]);
const codexClientLog = getMainLogger("pwragent:codex-client");

function isApprovalLikeMethod(method: string): boolean {
  return method.endsWith("/requestApproval");
}

function isHandledServerRequestMethod(method: string): boolean {
  return (
    isApprovalLikeMethod(method) ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval" ||
    method === "item/tool/requestUserInput" ||
    method === "mcpServer/elicitation/request" ||
    method === "item/tool/call"
  );
}

function isKnownCodexNotificationMethod(
  method: string
): boolean {
  return GENERATED_CODEX_NOTIFICATION_METHODS.has(method);
}

function isKnownCodexServerRequestMethod(
  method: string
): method is CodexServerRequestMethod {
  return GENERATED_CODEX_SERVER_REQUEST_METHODS.has(
    method as CodexServerRequestMethod
  );
}

function isRequestLikeMethod(method: string): boolean {
  return method.includes("/request");
}

function describePayloadShape(payload: unknown): {
  payloadType: string;
  payloadKeys?: string[];
  payloadLength?: number;
} {
  if (payload === null) {
    return { payloadType: "null" };
  }

  if (payload === undefined) {
    return { payloadType: "undefined" };
  }

  if (Array.isArray(payload)) {
    return {
      payloadType: "array",
      payloadLength: payload.length,
    };
  }

  if (typeof payload === "object") {
    return {
      payloadType: "object",
      payloadKeys: Object.keys(payload as Record<string, unknown>).sort(),
    };
  }

  return { payloadType: typeof payload };
}

function logUnhandledCodexMessage(params: {
  kind: "notification" | "request";
  method: string;
  payload: unknown;
}): void {
  if (params.kind === "request") {
    codexClientLog.error("unhandled inbound codex request", {
      method: params.method,
      payload: params.payload,
    });
    return;
  }

  if (isApprovalLikeMethod(params.method) || isRequestLikeMethod(params.method)) {
    codexClientLog.error("unhandled inbound codex notification", {
      method: params.method,
      payload: params.payload,
    });
    return;
  }

  codexClientLog.warn("unknown codex notification", {
    method: params.method,
    ...describePayloadShape(params.payload),
    payload: params.payload,
  });
}

function logSkillsChangedNotification(params: {
  payload: unknown;
  listenerCount: number;
  initialized: boolean;
  serverAdvertisesSkillsList: boolean;
}): void {
  codexClientLog.warn("codex skills changed notification received", {
    method: "skills/changed",
    ...describePayloadShape(params.payload),
    listenerCount: params.listenerCount,
    initialized: params.initialized,
    serverAdvertisesSkillsList: params.serverAdvertisesSkillsList,
    expectedFollowup: "call skills/list when refreshed skill metadata is needed",
    payload: params.payload,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function readStringFromRecord(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  return record ? pickString(record, [key]) : undefined;
}

function buildHelperTurnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function extractTurnIdFromNotificationParams(params: unknown): string | undefined {
  const directTurnId = readStringFromRecord(params, "turnId");
  if (directTurnId) {
    return directTurnId;
  }

  const turn = asRecord(params)?.turn;
  return readStringFromRecord(turn, "id");
}

function extractThreadIdFromNotification(
  notification: AppServerNotification,
  rawParams: unknown
): string | undefined {
  return (
    readStringFromRecord(notification.params, "threadId") ??
    extractThreadIdFromValue(rawParams)
  );
}

function extractGeneratedTitleObject(value: unknown): unknown | undefined {
  if (typeof value === "string") {
    const parsed = parseStructuredValue(value);
    return isThreadTitleObject(parsed) ? parsed : undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const object = extractGeneratedTitleObject(entry);
      if (object) {
        return object;
      }
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (isThreadTitleObject(record)) {
    return { title: record.title };
  }

  for (const key of [
    "output",
    "content",
    "message",
    "text",
    "item",
    "items",
    "turn",
    "response",
    "result",
    "data",
  ]) {
    const object = extractGeneratedTitleObject(record[key]);
    if (object) {
      return object;
    }
  }

  return undefined;
}

function isThreadTitleObject(value: unknown): value is { title: string } {
  const record = asRecord(value);
  return typeof record?.title === "string" && record.title.trim().length > 0;
}

function pickRawString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function pickStringAllowEmpty(
  record: Record<string, unknown> | null | undefined,
  keys: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickFiniteNumber(
  record: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function pickBoolean(
  record: Record<string, unknown>,
  keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function extractRequestMetadata(value: unknown): {
  threadId?: string;
  turnId?: string;
  requestId?: string;
} {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  const turnRecord = asRecord(record.turn);

  return {
    threadId:
      pickString(record, ["threadId", "thread_id", "conversationId", "conversation_id"]) ??
      pickString(threadRecord ?? {}, ["id", "threadId", "thread_id", "conversationId"]),
    turnId:
      pickString(record, ["turnId", "turn_id", "runId", "run_id"]) ??
      pickString(turnRecord ?? {}, ["id", "turnId", "turn_id", "runId", "run_id"]),
    requestId:
      pickString(record, [
        "requestId",
        "request_id",
        "serverRequestId",
        "approvalId",
        "approval_id",
        "callId",
        "call_id",
        "id",
      ]) ??
      pickString(asRecord(record.serverRequest) ?? {}, ["id", "requestId", "request_id"]),
  };
}

function normalizePendingRequestNotification(
  method: string,
  params: unknown,
  rpcId?: JsonRpcId,
): AppServerPendingRequestNotification {
  const record = asRecord(params) ?? {};
  const metadata = extractRequestMetadata(params);

  return {
    method,
    params: {
      ...record,
      ...(metadata.threadId ? { threadId: metadata.threadId } : {}),
      ...(metadata.turnId ? { turnId: metadata.turnId } : {}),
      requestId: metadata.requestId ?? String(rpcId ?? `${method}-request`),
    } as AppServerPendingRequestNotification["params"],
  };
}

function normalizeServerNotification(
  method: string,
  params: unknown,
): AppServerNotification {
  const record = asRecord(params) ?? {};
  const metadata = extractRequestMetadata(params);
  const itemRecord = asRecord(record.item);
  const normalizedItem =
    itemRecord && (method === "item/started" || method === "item/completed")
      ? normalizeLiveNotificationItem(itemRecord)
      : undefined;

  const configWarningMetadata =
    method === "configWarning"
      ? extractConfigWarningMetadata(record)
      : undefined;

  return {
    method: method as AppServerNotification["method"],
    params: {
      ...record,
      ...(configWarningMetadata ?? {}),
      ...(normalizedItem ? { item: normalizedItem } : {}),
      ...(metadata.threadId ? { threadId: metadata.threadId } : {}),
      ...(metadata.turnId ? { turnId: metadata.turnId } : {}),
      ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
    } as AppServerNotification["params"],
  } as AppServerNotification;
}

function extractConfigWarningMetadata(
  record: Record<string, unknown>,
): { trustedProjectPath?: string; configPath?: string } | undefined {
  const summary = pickString(record, ["summary"]);
  if (!summary) {
    return undefined;
  }

  const trustLine = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /as a trusted project in/i.test(line));
  const trustMatch = trustLine?.match(
    /add\s+(.+?)\s+as a trusted project in\s+(.+?)\s*\.?$/i,
  );
  if (!trustMatch) {
    return undefined;
  }

  const trustedProjectPath = trustMatch[1]?.trim();
  const configPath = trustMatch[2]?.trim();
  return {
    ...(trustedProjectPath ? { trustedProjectPath } : {}),
    ...(configPath ? { configPath } : {}),
  };
}

function normalizeLiveNotificationItem(
  item: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...item };
  const functionName =
    pickString(item, ["toolName", "tool_name", "name"]) ??
    undefined;
  if (functionName && typeof normalized.toolName !== "string") {
    normalized.toolName = functionName;
  }

  const parsedArguments = parseStructuredValue(item.arguments);
  if (parsedArguments && typeof parsedArguments === "object" && !Array.isArray(parsedArguments)) {
    normalized.arguments = parsedArguments;
  }

  return normalized;
}

function normalizeEpochTimestamp(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function findFirstNestedValue(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > 8) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findFirstNestedValue(entry, keys, depth + 1);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  for (const child of Object.values(record)) {
    const nested = findFirstNestedValue(child, keys, depth + 1);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function formatRateLimitWindowName(params: {
  limitId?: string;
  limitName?: string;
  windowKey: "primary" | "secondary";
  windowMinutes?: number;
}): string {
  const rawId = params.limitId?.trim();
  const rawName = params.limitName?.trim();
  let windowLabel: string;
  const minutes = params.windowMinutes;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    if (minutes === 10_080) {
      windowLabel = "Weekly limit";
    } else if (minutes % 1440 === 0) {
      windowLabel = `${Math.round(minutes / 1440)}d limit`;
    } else if (minutes % 60 === 0) {
      windowLabel = `${Math.round(minutes / 60)}h limit`;
    } else {
      windowLabel = `${minutes}m limit`;
    }
  } else {
    windowLabel = params.windowKey === "primary" ? "Primary limit" : "Secondary limit";
  }
  if (!rawId || rawId.toLowerCase() === "codex") {
    return windowLabel;
  }
  return `${rawName ?? rawId} ${windowLabel}`.trim();
}

function extractRateLimitSummaries(value: unknown): BackendRateLimitSummary[] {
  const out = new Map<string, BackendRateLimitSummary>();
  const addWindow = (
    windowValue: unknown,
    params: { limitId?: string; limitName?: string; windowKey: "primary" | "secondary" }
  ): void => {
    const window = asRecord(windowValue);
    if (!window) {
      return;
    }
    const usedPercent = pickFiniteNumber(window, ["usedPercent", "used_percent"]);
    const windowMinutes = pickFiniteNumber(window, [
      "windowDurationMins",
      "window_duration_mins",
      "windowMinutes",
      "window_minutes",
    ]);
    const name = formatRateLimitWindowName({
      limitId: params.limitId,
      limitName: params.limitName,
      windowKey: params.windowKey,
      windowMinutes,
    });
    out.set(name, {
      name,
      limitId: params.limitId,
      usedPercent,
      remaining:
        typeof usedPercent === "number" ? Math.max(0, Math.round(100 - usedPercent)) : undefined,
      resetAt: normalizeEpochTimestamp(
        pickNumber(window, ["resetsAt", "resets_at", "resetAt", "reset_at"])
      ),
      windowSeconds: typeof windowMinutes === "number" ? Math.round(windowMinutes * 60) : undefined,
      windowMinutes,
    });
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    if ("primary" in record || "secondary" in record) {
      const limitId = pickString(record, ["limitId", "limit_id", "id"]);
      const limitName = pickString(record, ["limitName", "limit_name", "name", "label"]);
      addWindow(record.primary, { limitId, limitName, windowKey: "primary" });
      addWindow(record.secondary, { limitId, limitName, windowKey: "secondary" });
    }
    const byLimitId = asRecord(record.rateLimitsByLimitId ?? record.rate_limits_by_limit_id);
    if (byLimitId) {
      for (const [limitId, snapshot] of Object.entries(byLimitId)) {
        const snapshotRecord = asRecord(snapshot);
        if (!snapshotRecord) {
          continue;
        }
        const limitName = pickString(snapshotRecord, ["limitName", "limit_name", "name", "label"]);
        addWindow(snapshotRecord.primary, { limitId, limitName, windowKey: "primary" });
        addWindow(snapshotRecord.secondary, { limitId, limitName, windowKey: "secondary" });
      }
    }
    const remaining = pickFiniteNumber(record, [
      "remaining",
      "remainingCount",
      "remaining_count",
      "available",
    ]);
    const limit = pickFiniteNumber(record, ["limit", "max", "quota", "capacity"]);
    const used = pickFiniteNumber(record, ["used", "consumed", "count"]);
    const resetAt = pickNumber(record, [
      "resetAt",
      "reset_at",
      "resetsAt",
      "resets_at",
      "nextResetAt",
    ]);
    const windowSeconds = pickFiniteNumber(record, [
      "windowSeconds",
      "window_seconds",
      "resetInSeconds",
      "retryAfterSeconds",
    ]);
    const name =
      pickString(record, ["name", "label", "scope", "resource", "model", "id"]) ??
      (typeof remaining === "number" ||
      typeof limit === "number" ||
      typeof used === "number" ||
      typeof resetAt === "number"
        ? `limit-${out.size + 1}`
        : undefined);
    if (name) {
      const existing = out.get(name);
      out.set(name, {
        name,
        limitId: existing?.limitId,
        remaining: remaining ?? existing?.remaining,
        limit: limit ?? existing?.limit,
        used: used ?? existing?.used,
        usedPercent: existing?.usedPercent,
        resetAt: normalizeEpochTimestamp(resetAt) ?? existing?.resetAt,
        windowSeconds: windowSeconds ?? existing?.windowSeconds,
        windowMinutes: existing?.windowMinutes,
      });
    }
    for (const key of [
      "limits",
      "items",
      "data",
      "results",
      "entries",
      "buckets",
      "rateLimits",
      "rate_limits",
      "rateLimitsByLimitId",
      "rate_limits_by_limit_id",
    ]) {
      visit(record[key]);
    }
  };
  visit(value);
  return [...out.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function extractAccountSummary(value: unknown): BackendAccountSummary {
  const root = asRecord(value) ?? {};
  const account =
    asRecord(findFirstNestedValue(value, ["account"])) ?? asRecord(root.account) ?? undefined;
  const type = pickString(account ?? {}, ["type"]);
  return {
    type: type === "apiKey" || type === "chatgpt" ? type : undefined,
    email: pickString(account ?? {}, ["email"]),
    planType: pickString(account ?? {}, ["planType", "plan_type"]),
    requiresOpenaiAuth: pickBoolean(root, ["requiresOpenaiAuth", "requires_openai_auth"]),
  };
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectText(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const directKeys = [
    "text",
    "message",
    "summary",
    "title",
    "content",
    "description",
    "reason"
  ];

  const output = directKeys.flatMap((key) => collectText(record[key]));
  for (const nestedKey of ["item", "thread", "response", "result", "data"]) {
    output.push(...collectText(record[nestedKey]));
  }
  return output;
}

function dedupeJoinedText(parts: string[]): string | undefined {
  const unique = [...new Set(parts.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return undefined;
  }
  return unique.join("\n\n");
}

function normalizeThreadSummary(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    trimmed.length > 160 ||
    trimmed.startsWith("[$") ||
    trimmed.includes("](/") ||
    trimmed.includes("/Users/")
  ) {
    return undefined;
  }

  return trimmed;
}

function isPlaceholderThreadTitle(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "untitled thread";
}

function normalizeTitleForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function getThreadTitleInfo(record: Record<string, unknown>): {
  title: string;
  titleSource: AppServerThreadTitleSource;
} {
  const sessionRecord = asRecord(record.session);
  const explicitTitle = normalizeExplicitThreadName(
    pickString(record, ["title", "name", "headline"]) ??
      pickString(sessionRecord ?? {}, ["title", "name", "headline"])
  );
  const derivedTitle =
    pickString(record, ["preview", "snippet", "firstUserMessage", "first_user_message"]) ??
    pickString(sessionRecord ?? {}, [
      "preview",
      "snippet",
      "firstUserMessage",
      "first_user_message",
    ]);
  const shortenedDerivedTitle = shortenDerivedThreadTitle(derivedTitle) ?? derivedTitle;

  if (explicitTitle && !isPlaceholderThreadTitle(explicitTitle)) {
    if (
      derivedTitle &&
      (normalizeTitleForComparison(explicitTitle) === normalizeTitleForComparison(derivedTitle) ||
        (shortenedDerivedTitle &&
          normalizeTitleForComparison(explicitTitle) ===
            normalizeTitleForComparison(shortenedDerivedTitle)))
    ) {
      return {
        title: shortenedDerivedTitle ?? explicitTitle,
        titleSource: "derived",
      };
    }

    return {
      title: explicitTitle,
      titleSource: "explicit",
    };
  }

  if (derivedTitle) {
    return {
      title: shortenedDerivedTitle ?? derivedTitle,
      titleSource: "derived",
    };
  }

  return {
    title: "Untitled thread",
    titleSource: "fallback",
  };
}

function normalizeExplicitThreadName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || isPlaceholderThreadTitle(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isPlaceholderThreadName(value: string | undefined): boolean {
  return isPlaceholderThreadTitle(value);
}

function deriveThreadNameFromInput(input: AppServerTurnInputItem[]): string | undefined {
  const text = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");

  return (shortenDerivedThreadTitle(text) ?? text) || undefined;
}

async function resolveThreadProjectKey(
  thread: RawCodexThreadSummary
): Promise<string | undefined> {
  const projectKey = thread.projectKey?.trim();
  return projectKey || undefined;
}

function buildProjectKeyLinkedDirectories(
  projectKey: string | undefined
): LinkedDirectorySummary[] {
  const directoryPath = projectKey?.trim();
  if (!directoryPath) {
    return [];
  }

  const resolvedPath = path.isAbsolute(directoryPath)
    ? directoryPath
    : path.resolve(directoryPath);
  const isWorktree = isToolManagedWorktreePath(resolvedPath);

  return [
    {
      id: resolvedPath,
      label: path.basename(resolvedPath) || resolvedPath,
      path: resolvedPath,
      ...(isWorktree ? { worktreePath: resolvedPath } : {}),
      kind: isWorktree ? "worktree" : "local",
    },
  ];
}

function normalizeConversationRole(
  value: string | undefined
): "user" | "assistant" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "user" || normalized === "usermessage") {
    return "user";
  }
  if (
    normalized === "assistant" ||
    normalized === "agentmessage" ||
    normalized === "assistantmessage"
  ) {
    return "assistant";
  }
  return undefined;
}

function normalizeAgentMessagePhase(
  value: string | undefined
): "commentary" | "final" | undefined {
  if (value === "commentary") {
    return "commentary";
  }
  if (value === "final_answer") {
    return "final";
  }
  return undefined;
}

function collectLegacyMessageText(record: Record<string, unknown>): string {
  return (
    dedupeJoinedText([
      ...collectText(record.content),
      ...collectText(record.text),
      ...collectText(record.message),
      ...collectText(record.messages),
      ...collectText(record.input),
      ...collectText(record.output),
      ...collectText(record.parts)
    ]) ?? ""
  );
}

function isReviewActionText(text: string): boolean {
  return text.includes("<user_action>") && text.includes("<action>review</action>");
}

function isPlainReviewFindingText(text: string): boolean {
  return (
    /\b(?:full\s+)?review comments?:/i.test(text) &&
    /(?:^|\n)\s*-\s*\[P[0-3]\]\s+.+(?:\s+—\s+|\s+-\s+).+:\d+/u.test(text)
  );
}

function shouldUseAssistantReviewText(params: {
  assistantText: string;
  reviewText: string;
}): boolean {
  if (!isPlainReviewFindingText(params.assistantText)) {
    return false;
  }

  const normalizedAssistant = normalizeSuppressionText(params.assistantText);
  const normalizedReview = normalizeSuppressionText(params.reviewText);
  return (
    !normalizedReview ||
    normalizedAssistant === normalizedReview ||
    normalizedAssistant.startsWith(normalizedReview) ||
    normalizedAssistant.includes(normalizedReview)
  );
}

function isCodexInternalReviewPrompt(
  record: Record<string, unknown>,
  text: string
): boolean {
  const normalizedType = normalizeItemType(pickString(record, ["type"]));
  const normalizedText = text.trim().toLowerCase();
  return (
    normalizedType === "usermessage" &&
    normalizedText.startsWith("review ") &&
    normalizedText.includes("code changes") &&
    normalizedText.includes("base branch") &&
    normalizedText.includes("prioritized") &&
    normalizedText.includes("findings")
  );
}

function normalizeSuppressionText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function collectReviewSuppressionTexts(value: unknown): Set<string> {
  const output = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }

    const record = asRecord(node);
    if (!record) {
      return;
    }

    const role = normalizeConversationRole(
      pickString(record, ["role", "author", "speaker", "source", "type"])
    );
    if (role === "assistant") {
      const text = collectLegacyMessageText(record);
      if (isPlainReviewFindingText(text)) {
        output.add(normalizeSuppressionText(text));
      }
    }

    const reviewOutput = normalizeReviewOutput(record);
    if (reviewOutput?.overall_explanation) {
      output.add(normalizeSuppressionText(reviewOutput.overall_explanation));
    }
    const reviewEvent = normalizeReviewEventItem(record);
    if (reviewEvent?.event === "exitedreviewmode") {
      const review = pickRawString(reviewEvent.item, ["review", "text"]);
      if (review) {
        output.add(normalizeSuppressionText(review));
      }
    }

    for (const key of [
      "items",
      "messages",
      "content",
      "parts",
      "entries",
      "data",
      "results",
      "turns",
      "events",
      "payload",
      "item",
      "message",
      "thread",
      "response",
      "result"
    ]) {
      visit(record[key]);
    }
  };

  visit(value);
  return output;
}

function collectAssistantReviewTexts(items: Record<string, unknown>[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const role = normalizeConversationRole(
      pickString(item, ["role", "author", "speaker", "source", "type"])
    );
    if (role !== "assistant") {
      continue;
    }

    const text = buildMessageContent(item).text;
    if (!isPlainReviewFindingText(text)) {
      continue;
    }

    const key = normalizeSuppressionText(text);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(text);
    }
  }

  return output;
}

function shouldSuppressConversationMessage(
  record: Record<string, unknown>,
  suppressedAssistantTexts = new Set<string>()
): boolean {
  const text = collectLegacyMessageText(record);
  const role = normalizeConversationRole(
    pickString(record, ["role", "author", "speaker", "source", "type"])
  );
  return (
    isReviewActionText(text) ||
    isCodexInternalReviewPrompt(record, text) ||
    (role === "assistant" && suppressedAssistantTexts.has(normalizeSuppressionText(text)))
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

  const normalizedType = pickString(record, ["type", "contentType", "content_type"])
    ?.trim()
    .toLowerCase();

  if (
    normalizedType === "text" ||
    normalizedType === "input_text" ||
    normalizedType === "output_text"
  ) {
    const text = pickString(record, ["text", "value", "content"]);
    return text ? [{ type: "text", text }] : [];
  }

  const imageUrl = normalizeRenderableImageUrl(
    pickString(record, [
      "image_url",
      "imageUrl",
      "url",
      "src",
      "uri",
      "path",
      "localPath",
      "local_path"
    ])
  );
  if (
    imageUrl &&
    (normalizedType === "image" ||
      normalizedType === "input_image" ||
      normalizedType === "output_image" ||
      normalizedType === "image_url" ||
      "image_url" in record ||
      "imageUrl" in record)
  ) {
    const part: AppServerThreadImagePart = {
      type: "image",
      url: imageUrl
    };
    const alt = pickString(record, ["alt", "altText", "alt_text", "title", "name"]);
    if (alt) {
      part.alt = alt;
    }
    return [part];
  }

  for (const nestedKey of ["content", "parts", "input", "output", "data"]) {
    const nestedParts = extractStructuredMessageParts(record[nestedKey]);
    if (nestedParts.length > 0) {
      return nestedParts;
    }
  }

  return [];
}

function buildMessageContent(record: Record<string, unknown>): {
  parts?: AppServerThreadMessagePart[];
  text: string;
} {
  const structuredParts = [
    ...extractStructuredMessageParts(record.content),
    ...extractStructuredMessageParts(record.parts)
  ];

  if (structuredParts.length > 0) {
    const text = dedupeJoinedText(
      structuredParts.flatMap((part) => (part.type === "text" ? [part.text] : []))
    ) ?? "";

    return {
      parts: structuredParts,
      text
    };
  }

  const text = collectLegacyMessageText(record);
  return { text };
}

function extractConversationMessages(value: unknown): AppServerThreadReplay["messages"] {
  const output: AppServerThreadReplay["messages"] = [];
  const suppressedAssistantTexts = collectReviewSuppressionTexts(value);
  const timestampKeys = ["createdAt", "created_at", "timestamp", "time"];

  const visit = (node: unknown, inheritedCreatedAt?: number): void => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, inheritedCreatedAt));
      return;
    }

    const record = asRecord(node);
    if (!record) {
      return;
    }
    const recordCreatedAt = normalizeEpochTimestamp(
      pickNumber(record, timestampKeys)
    );
    const createdAt = recordCreatedAt ?? inheritedCreatedAt;

    const role = normalizeConversationRole(
      pickString(record, ["role", "author", "speaker", "source", "type"])
    );
    const content = buildMessageContent(record);
    if (
      role &&
      (content.text || content.parts?.length) &&
      !shouldSuppressConversationMessage(record, suppressedAssistantTexts)
    ) {
      output.push({
        id:
          pickString(record, ["id", "messageId", "message_id", "itemId", "item_id"]) ??
          `message-${output.length + 1}`,
        role,
        text: content.text,
        ...(content.parts ? { parts: content.parts } : {}),
        createdAt
      });
    }

    for (const key of [
      "items",
      "messages",
      "content",
      "parts",
      "entries",
      "data",
      "results",
      "turns",
      "events",
      "payload",
      "item",
      "message",
      "thread",
      "response",
      "result"
    ]) {
      visit(record[key], createdAt);
    }
  };

  visit(value);
  return output;
}

function normalizeActivityStatus(
  value: string | undefined
): AppServerThreadActivityStatus | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "inprogress") {
    return "in_progress";
  }
  if (
    normalized === "in_progress" ||
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeTurnStatus(value: string | undefined): AppServerThreadTurnStatus | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "inprogress") {
    return "in_progress";
  }
  if (
    normalized === "in_progress" ||
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "cancelled" ||
    normalized === "interrupted"
  ) {
    return normalized;
  }
  return undefined;
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

  const statusRecord = asRecord(record.status);
  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  const threadStatusRecord = asRecord(threadRecord?.status);

  return normalizeThreadStatus(
    pickString(statusRecord ?? {}, ["type", "status", "state"]) ??
      pickString(threadStatusRecord ?? {}, ["type", "status", "state"]) ??
      pickString(record, ["status", "state"]) ??
      pickString(threadRecord ?? {}, ["status", "state"])
  );
}

function extractTurnMetadata(
  turn: Record<string, unknown>
): AppServerThreadTurnMetadata | undefined {
  const id = pickString(turn, ["id", "turnId", "turn_id", "runId", "run_id"]);
  if (!id) {
    return undefined;
  }

  const startedAt = normalizeEpochTimestamp(
    pickNumber(turn, ["startedAt", "started_at", "createdAt", "timestamp", "time"])
  );
  const completedAt = normalizeEpochTimestamp(
    pickNumber(turn, ["completedAt", "completed_at"])
  );
  const durationMs = pickNumber(turn, ["durationMs", "duration_ms"]);
  const status = normalizeTurnStatus(pickString(turn, ["status"]));

  return {
    id,
    ...(status ? { status } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(typeof durationMs === "number" ? { durationMs } : {}),
  };
}

function normalizePlanStepStatus(
  value: string | undefined
): AppServerThreadPlanStepStatus | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "inprogress") {
    return "in_progress";
  }
  if (
    normalized === "pending" ||
    normalized === "in_progress" ||
    normalized === "completed"
  ) {
    return normalized;
  }
  return undefined;
}

function collectPlanLines(text: string): AppServerThreadPlanStep[] {
  const steps = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): AppServerThreadPlanStep[] => {
      const completedMatch = line.match(/^[-*]\s+\[(x|X)\]\s+(.+)$/);
      if (completedMatch) {
        return [{ step: completedMatch[2].trim(), status: "completed" }];
      }

      const pendingMatch = line.match(/^[-*]\s+\[\s?\]\s+(.+)$/);
      if (pendingMatch) {
        return [{ step: pendingMatch[1].trim(), status: "pending" }];
      }

      const bulletMatch = line.match(/^([-*]|\d+\.)\s+(.+)$/);
      if (bulletMatch) {
        return [{ step: bulletMatch[2].trim(), status: "pending" }];
      }

      return [];
    })
    .filter((step) => step.step.length > 0);

  const deduped = new Map<string, AppServerThreadPlanStep>();
  for (const step of steps) {
    deduped.set(`${step.status}:${step.step}`, step);
  }
  return [...deduped.values()];
}

function normalizePlanSteps(value: unknown): AppServerThreadPlanStep[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): AppServerThreadPlanStep[] => {
    const record = asRecord(entry);
    if (!record) {
      return [];
    }

    const step = pickString(record, ["step", "title", "text", "label"]);
    const status = normalizePlanStepStatus(pickString(record, ["status", "state"]));
    if (!step || !status) {
      return [];
    }

    return [{ step, status }];
  });
}

function normalizePlanPayload(value: unknown): {
  explanation?: string;
  markdown?: string;
  steps: AppServerThreadPlanStep[];
} | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const directSteps = normalizePlanSteps(record.steps);
  const nestedPlanRecord = asRecord(record.plan);
  const nestedPlanSteps = normalizePlanSteps(record.plan);
  const nestedRecordSteps = normalizePlanSteps(nestedPlanRecord?.steps);
  const steps =
    directSteps.length > 0
      ? directSteps
      : nestedPlanSteps.length > 0
        ? nestedPlanSteps
        : nestedRecordSteps;
  const explanation =
    pickString(record, ["explanation", "summary"]) ??
    pickString(nestedPlanRecord ?? {}, ["explanation", "summary"]);
  const markdown =
    pickRawString(record, ["markdown"]) ??
    pickRawString(nestedPlanRecord ?? {}, ["markdown"]) ??
    collectLegacyMessageText(record);

  if (steps.length === 0 && !explanation && !markdown.trim()) {
    return undefined;
  }

  return {
    ...(explanation ? { explanation } : {}),
    ...(markdown.trim() ? { markdown: markdown.trim() } : {}),
    steps,
  };
}

function parseStructuredValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractNestedPlanEntryFromItem(
  item: Record<string, unknown>,
  createdAt?: number,
  turn?: AppServerThreadTurnMetadata
): AppServerThreadPlanEntry | undefined {
  for (const key of ["payload", "item", "responseItem", "response_item"]) {
    const nestedItem = asRecord(item[key]);
    if (!nestedItem) {
      continue;
    }

    const nestedPlanEntry = extractPlanEntryFromItem(
      {
        ...nestedItem,
        id:
          pickString(item, ["id", "itemId", "item_id"]) ??
          pickString(nestedItem, ["id", "itemId", "item_id", "call_id"])
      },
      createdAt,
      turn
    );
    if (nestedPlanEntry) {
      return nestedPlanEntry;
    }
  }

  return undefined;
}

function extractPlanEntryFromItem(
  item: Record<string, unknown>,
  createdAt?: number,
  turn?: AppServerThreadTurnMetadata
): AppServerThreadPlanEntry | undefined {
  const itemType = pickString(item, ["type"]);
  const normalizedItemType = itemType?.trim().toLowerCase();
  const itemId =
    pickString(item, ["id", "itemId", "item_id", "call_id"]) ?? `plan-${createdAt ?? 0}`;
  const nestedPlanEntry = extractNestedPlanEntryFromItem(item, createdAt, turn);
  if (nestedPlanEntry) {
    return nestedPlanEntry;
  }

  if (normalizedItemType === "plan") {
    const normalizedPayload = normalizePlanPayload(item);
    const textSteps = collectPlanLines(collectLegacyMessageText(item));
    const steps = normalizedPayload?.steps.length
      ? normalizedPayload.steps
      : textSteps;
    const explanation = normalizedPayload?.explanation;

    if (steps.length === 0 && !explanation) {
      return undefined;
    }

    return {
      type: "plan",
      id: itemId,
      createdAt,
      ...(turn ? { turn } : {}),
      ...(explanation ? { explanation } : {}),
      ...(normalizedPayload?.markdown ? { markdown: normalizedPayload.markdown } : {}),
      steps,
    };
  }

  const functionLikeTypes = new Set([
    "functioncall",
    "function_call",
    "dynamictoolcall",
    "dynamic_tool_call",
  ]);
  const normalizedCollapsedType = normalizedItemType?.replace(/[-_\s]/g, "");
  if (!normalizedCollapsedType || !functionLikeTypes.has(normalizedCollapsedType)) {
    return undefined;
  }

  const functionName = pickString(item, ["name", "toolName", "tool_name", "text"]);
  if (functionName !== "update_plan") {
    return undefined;
  }

  const payload =
    parseStructuredValue(item.arguments) ??
    parseStructuredValue(item.input) ??
    parseStructuredValue(item.output) ??
    asRecord(item.arguments) ??
    asRecord(item.input) ??
    asRecord(item.output);
  const normalizedPayload = normalizePlanPayload(payload);
  if (!normalizedPayload) {
    return undefined;
  }

  return {
    type: "plan",
    id: itemId,
    createdAt,
    ...(turn ? { turn } : {}),
    ...(normalizedPayload.explanation
      ? { explanation: normalizedPayload.explanation }
      : {}),
    ...(normalizedPayload.markdown ? { markdown: normalizedPayload.markdown } : {}),
    steps: normalizedPayload.steps,
  };
}

function extractReviewEntryFromItem(
  item: Record<string, unknown>,
  createdAt?: number,
  turn?: AppServerThreadTurnMetadata,
): AppServerThreadReviewEntry | undefined {
  const reviewEvent = normalizeReviewEventItem(item);
  if (!reviewEvent) {
    return undefined;
  }

  const { event, item: reviewItem, parent } = reviewEvent;
  const reviewOutput = normalizeReviewOutput(reviewItem);
  const review =
    pickRawString(reviewItem, ["review", "text"]) ??
    (event === "exitedreviewmode" ? reviewOutput?.overall_explanation : undefined) ??
    "";

  return {
    type: "review",
    id:
      pickString(parent, ["id", "itemId", "item_id"]) ??
      pickString(reviewItem, ["id", "itemId", "item_id"]) ??
      `review-${event}`,
    review,
    displayText:
      event === "enteredreviewmode"
        ? reviewDisplayText(reviewItem) || "Code review started"
        : undefined,
    ...(createdAt ? { createdAt } : {}),
    ...(turn ? { turn } : {}),
    ...(reviewOutput ? { output: reviewOutput } : {}),
  };
}

function normalizeReviewEventItem(
  item: Record<string, unknown>
): {
  event: "enteredreviewmode" | "exitedreviewmode";
  item: Record<string, unknown>;
  parent: Record<string, unknown>;
} | undefined {
  if (
    normalizeItemType(pickString(item, ["type"])) === "enteredreviewmode" ||
    normalizeItemType(pickString(item, ["type"])) === "exitedreviewmode"
  ) {
    return {
      event: normalizeItemType(pickString(item, ["type"])) as
        | "enteredreviewmode"
        | "exitedreviewmode",
      item,
      parent: item,
    };
  }

  for (const key of ["payload", "item", "responseItem", "response_item", "data"]) {
    const nested = asRecord(item[key]);
    const nestedType = normalizeItemType(pickString(nested ?? {}, ["type"]));
    if (nested && (nestedType === "enteredreviewmode" || nestedType === "exitedreviewmode")) {
      return {
        event: nestedType,
        item: nested,
        parent: item,
      };
    }
  }

  return undefined;
}

function normalizeReviewOutput(
  item: Record<string, unknown>
): AppServerThreadReviewEntry["output"] | undefined {
  const data = asRecord(item.data);
  const reviewOutput =
    asRecord(data?.reviewOutput) ??
    asRecord(data?.review_output) ??
    asRecord(item.reviewOutput) ??
    asRecord(item.review_output);
  const findings = Array.isArray(reviewOutput?.findings)
    ? reviewOutput.findings
    : undefined;

  if (
    !reviewOutput ||
    !findings ||
    (reviewOutput.overall_correctness !== "patch is correct" &&
      reviewOutput.overall_correctness !== "patch is incorrect") ||
    typeof reviewOutput.overall_explanation !== "string" ||
    typeof reviewOutput.overall_confidence_score !== "number"
  ) {
    return undefined;
  }

  return {
    findings: findings as NonNullable<AppServerThreadReviewEntry["output"]>["findings"],
    overall_correctness: reviewOutput.overall_correctness,
    overall_explanation: reviewOutput.overall_explanation,
    overall_confidence_score: reviewOutput.overall_confidence_score,
  };
}

function reviewDisplayText(item: Record<string, unknown>): string | undefined {
  const direct = pickRawString(item, ["review", "text"]);
  if (direct) {
    return normalizeReviewDisplayText(direct);
  }

  const hint = pickString(item, ["user_facing_hint", "userFacingHint"]);
  if (hint) {
    return normalizeReviewDisplayText(hint);
  }

  const target = asRecord(item.target);
  const targetType = pickString(target ?? {}, ["type"]);
  if (targetType === "uncommittedChanges" || targetType === "uncommitted_changes") {
    return "Review current changes";
  }
  if (targetType === "baseBranch" || targetType === "base_branch") {
    const branch = pickString(target ?? {}, ["branch", "baseBranch", "base_branch"]);
    return branch
      ? normalizeReviewDisplayText(`changes against ${branch}`)
      : "Review changes";
  }
  if (targetType === "commit") {
    const sha = pickString(target ?? {}, ["sha", "commit"]);
    return sha ? `Review commit ${sha}` : "Review commit";
  }

  return undefined;
}

function pushActivityDetail(
  details: AppServerThreadActivityDetail[],
  detail: AppServerThreadActivityDetail
): void {
  const existing = details.find((candidate) => candidate.label === detail.label);
  if (existing) {
    if (!existing.status || existing.status === "completed") {
      existing.status = detail.status ?? existing.status;
    }
    return;
  }
  details.push(detail);
}

function normalizeFileChangeKind(
  value: string | undefined
): "add" | "delete" | "update" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "add" || normalized === "delete" || normalized === "update") {
    return normalized;
  }
  return "update";
}

function extractDiffText(change: Record<string, unknown>): string | undefined {
  const directDiff = pickString(change, ["diff", "patch", "unifiedDiff", "unified_diff"]);
  if (directDiff) {
    return directDiff;
  }

  const diffRecord = asRecord(change.diff);
  if (diffRecord) {
    return pickString(diffRecord, ["text", "patch", "diff", "unifiedDiff", "unified_diff"]);
  }

  return undefined;
}

type FileChangeText = {
  source: "content" | "diff";
  text: string;
};

function extractFileChangeText(params: {
  change: Record<string, unknown>;
  changeKind: Record<string, unknown> | null;
  changeType: "add" | "delete" | "update";
}): FileChangeText | undefined {
  if (params.changeType === "add" || params.changeType === "delete") {
    const content =
      pickStringAllowEmpty(params.changeKind, ["content"]) ??
      pickStringAllowEmpty(params.change, ["content"]);
    if (content !== undefined) {
      return { source: "content", text: content };
    }

    const diff = extractDiffText(params.change);
    return diff !== undefined ? { source: "diff", text: diff } : undefined;
  }

  const diff =
    pickStringAllowEmpty(params.changeKind, ["unified_diff", "unifiedDiff"]) ??
    extractDiffText(params.change);
  return diff !== undefined ? { source: "diff", text: diff } : undefined;
}

function summarizeDiff(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (
      !line ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("\\")
    ) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      removals += 1;
    }
  }

  return { additions, removals };
}

function countContentLines(content: string): number {
  return splitFileContentLines(content).length;
}

function splitFileContentLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function summarizeFileChangeText(params: {
  changeType: "add" | "delete" | "update",
  text: FileChangeText;
}): { additions: number; removals: number } {
  if (params.text.source === "diff") {
    return summarizeDiff(params.text.text);
  }

  if (params.changeType === "add") {
    return { additions: countContentLines(params.text.text), removals: 0 };
  }

  if (params.changeType === "delete") {
    return { additions: 0, removals: countContentLines(params.text.text) };
  }

  return summarizeDiff(params.text.text);
}

function buildContentDiff(params: {
  changeType: "add" | "delete" | "update";
  content: string;
  path?: string;
}): string {
  if (params.changeType === "update") {
    return params.content;
  }

  const lines = splitFileContentLines(params.content);
  const path = params.path?.replace(/^\/+/, "") ?? "file";
  const hunkLineCount = lines.length;
  const header =
    params.changeType === "add"
      ? [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${hunkLineCount} @@`]
      : [`--- a/${path}`, `+++ /dev/null`, `@@ -1,${hunkLineCount} +0,0 @@`];
  const prefix = params.changeType === "add" ? "+" : "-";
  return [...header, ...lines.map((line) => `${prefix}${line}`)].join("\n");
}

function buildFileChangeDiff(params: {
  changeType: "add" | "delete" | "update";
  text: FileChangeText;
  path?: string;
}): string {
  if (params.text.source === "diff") {
    return params.text.text;
  }

  return buildContentDiff({
    changeType: params.changeType,
    content: params.text.text,
    path: params.path
  });
}

function formatCommandLabel(command: string | undefined): string {
  if (!command) {
    return "Ran command";
  }

  const stripped = command
    .replace(/^\/bin\/[a-z]+ -lc /, "")
    .replace(/^['"]|['"]$/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "Ran command";
  }

  return collapsed.length > 72 ? `${collapsed.slice(0, 69)}...` : collapsed;
}

function stripShellWrapper(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }

  const stripped = command
    .replace(/^\/bin\/[a-z]+ -lc /, "")
    .replace(/^['"]|['"]$/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed || undefined;
}

function formatActivitySummary(parts: string[]): string {
  return parts.join(", ");
}

function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs < 1_000) {
    return `${elapsedMs}ms`;
  }
  const seconds = elapsedMs / 1_000;
  return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

function readActivityElapsedMs(item: Record<string, unknown>): number | undefined {
  const data = asRecord(item.data);
  const direct =
    pickNumber(item, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"]) ??
    pickNumber(data ?? {}, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"]);
  if (typeof direct === "number") {
    return direct;
  }

  const startedAt = normalizeEpochTimestamp(
    pickNumber(item, ["startedAt", "started_at"])
  );
  const completedAt = normalizeEpochTimestamp(
    pickNumber(item, ["completedAt", "completed_at"])
  );
  return typeof startedAt === "number" &&
    typeof completedAt === "number" &&
    completedAt >= startedAt
    ? completedAt - startedAt
    : undefined;
}

function appendElapsedLabel(label: string, elapsedMs: number | undefined): string {
  return typeof elapsedMs === "number" ? `${label} (${formatElapsedMs(elapsedMs)})` : label;
}

function normalizeItemType(value: string | undefined): string | undefined {
  return value?.replace(/[-_\s]/g, "").toLowerCase();
}

function isActivityItemType(itemType: string | undefined): boolean {
  const normalized = normalizeItemType(itemType);
  return (
    normalized === "commandexecution" ||
    normalized === "filechange" ||
    normalized === "functioncall" ||
    normalized === "mcptoolcall" ||
    normalized === "dynamictoolcall" ||
    normalized === "collabagenttoolcall" ||
    normalized === "websearch" ||
    normalized === "imageview" ||
    normalized === "imagegeneration"
  );
}

function extractActivityItemFromReplayItem(
  item: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (isActivityItemType(pickString(item, ["type"]))) {
    return item;
  }

  for (const key of ["payload", "item", "responseItem", "response_item"]) {
    const nestedItem = asRecord(item[key]);
    if (!nestedItem || !isActivityItemType(pickString(nestedItem, ["type"]))) {
      continue;
    }

    const normalizedNestedItemType = normalizeItemType(pickString(nestedItem, ["type"]));
    return {
      ...nestedItem,
      id:
        normalizedNestedItemType === "functioncall"
          ? pickString(nestedItem, ["call_id", "callId", "id", "itemId", "item_id"]) ??
            pickString(item, ["id", "itemId", "item_id"])
          : pickString(nestedItem, ["id", "itemId", "item_id", "call_id", "callId"]) ??
            pickString(item, ["id", "itemId", "item_id"])
    };
  }

  return undefined;
}

function extractFunctionCallOutputFromReplayItem(
  item: Record<string, unknown>
): { callId: string; output: string } | undefined {
  const candidates = [item];
  for (const key of ["payload", "item", "responseItem", "response_item"]) {
    const nestedItem = asRecord(item[key]);
    if (nestedItem) {
      candidates.push(nestedItem);
    }
  }

  for (const candidate of candidates) {
    if (normalizeItemType(pickString(candidate, ["type"])) !== "functioncalloutput") {
      continue;
    }
    const callId = pickString(candidate, ["call_id", "callId", "id", "itemId", "item_id"]);
    const output =
      pickString(candidate, ["output", "text", "result"]) ??
      pickString(asRecord(candidate.data) ?? {}, ["output", "text", "result"]);
    if (callId && output !== undefined) {
      return { callId, output };
    }
  }

  return undefined;
}

function attachFunctionCallOutput(
  items: Record<string, unknown>[],
  output: { callId: string; output: string }
): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const itemIds = [
      pickString(item, ["id"]),
      pickString(item, ["itemId"]),
      pickString(item, ["item_id"]),
      pickString(item, ["call_id"]),
      pickString(item, ["callId"]),
    ].filter((value): value is string => Boolean(value));
    if (!itemIds.includes(output.callId)) {
      continue;
    }
    item.functionCallOutput = output.output;
    return true;
  }
  return false;
}

function parseToolArguments(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return (
    asRecord(parseStructuredValue(item.arguments)) ??
    asRecord(parseStructuredValue(item.input)) ??
    asRecord(item.arguments) ??
    asRecord(item.input) ??
    undefined
  );
}

function readActivityOutputText(item: Record<string, unknown>): string | undefined {
  const data = asRecord(item.data);
  return (
    pickString(item, [
      "aggregatedOutput",
      "aggregated_output",
      "functionCallOutput",
      "output",
      "text",
    ]) ??
    pickString(data ?? {}, ["aggregatedOutput", "aggregated_output", "output", "text"])
  );
}

function readActivityExitCode(item: Record<string, unknown>): number | undefined {
  const data = asRecord(item.data);
  return (
    pickNumber(item, ["exitCode", "exit_code"]) ??
    pickNumber(data ?? {}, ["exitCode", "exit_code"])
  );
}

function buildCommandDetail(params: {
  item: Record<string, unknown>;
  command: string | undefined;
  elapsedMs: number | undefined;
}): AppServerThreadCommandDetail | undefined {
  const displayCommand = stripShellWrapper(params.command);
  if (!displayCommand) {
    return undefined;
  }

  const cwd = pickString(params.item, ["cwd", "workingDirectory", "working_directory"]);
  const output = readActivityOutputText(params.item);
  const exitCode = readActivityExitCode(params.item);
  return {
    displayCommand,
    ...(params.command ? { rawCommand: params.command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(output ? { output } : {}),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(typeof params.elapsedMs === "number" ? { durationMs: params.elapsedMs } : {}),
  };
}

function summarizeActivityItems(
  items: Record<string, unknown>[],
  createdAt?: number,
  turn?: AppServerThreadTurnMetadata
): AppServerThreadActivityEntry | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const details: AppServerThreadActivityDetail[] = [];
  let inspectedFiles = 0;
  let commandsRun = 0;
  let changedFiles = 0;
  let changedFileAdditions = 0;
  let changedFileRemovals = 0;
  let toolCalls = 0;
  let spawnedAgents = 0;
  let waitedAgents = 0;
  let failedCollabCalls = 0;
  let status: AppServerThreadActivityStatus | undefined;

  for (const item of items) {
    const itemId =
      pickString(item, ["id", "itemId", "item_id"]) ?? `activity-${details.length + 1}`;
    const itemStatus = normalizeActivityStatus(pickString(item, ["status"]));
    if (itemStatus === "failed") {
      status = "failed";
    } else if (!status) {
      status = itemStatus;
    }

    const itemType = pickString(item, ["type"]);
    const normalizedItemType = normalizeItemType(itemType);
    const elapsedMs = readActivityElapsedMs(item);
    if (normalizedItemType === "commandexecution") {
      const command = pickString(item, ["command"]);
      const actions = Array.isArray(item.commandActions)
        ? item.commandActions
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== null)
        : [];

      if (actions.length === 0) {
        commandsRun += 1;
        pushActivityDetail(details, {
          id: itemId,
          kind: "command",
          label: appendElapsedLabel(formatCommandLabel(command), elapsedMs),
          command: buildCommandDetail({ item, command, elapsedMs }),
          status: itemStatus
        });
        continue;
      }

      for (const [index, action] of actions.entries()) {
        const actionType = pickString(action, ["type"]);
        const actionPath = pickString(action, ["path"]);
        const fallbackName = pickString(action, ["name"]);
        const detailId = `${itemId}-${index + 1}`;

        if (actionType === "read" && actionPath) {
          inspectedFiles += 1;
          pushActivityDetail(details, {
            id: detailId,
            kind: "read",
            label: appendElapsedLabel(
              `Read ${path.basename(actionPath) || actionPath}`,
              elapsedMs
            ),
            path: actionPath,
            status: itemStatus
          });
          continue;
        }

        if (actionType === "search" && actionPath) {
          inspectedFiles += 1;
          pushActivityDetail(details, {
            id: detailId,
            kind: "read",
            label: appendElapsedLabel(
              `Searched ${path.basename(actionPath) || actionPath}`,
              elapsedMs
            ),
            path: actionPath,
            status: itemStatus
          });
          continue;
        }

        if (actionType === "listFiles" || actionType === "search") {
          inspectedFiles += 1;
          const label =
            actionType === "listFiles"
              ? actionPath
                ? `Listed ${path.basename(actionPath) || actionPath}`
                : "Listed files"
              : "Ran search";
          pushActivityDetail(details, {
            id: detailId,
            kind: "read",
            label: appendElapsedLabel(label, elapsedMs),
            ...(actionPath ? { path: actionPath } : {}),
            status: itemStatus
          });
          continue;
        }

        commandsRun += 1;
        const label = fallbackName?.trim() || formatCommandLabel(command);
        pushActivityDetail(details, {
          id: detailId,
          kind: "command",
          label: appendElapsedLabel(label, elapsedMs),
          ...(actionPath ? { path: actionPath } : {}),
          command: buildCommandDetail({ item, command, elapsedMs }),
          status: itemStatus
        });
      }
      continue;
    }

    if (normalizedItemType === "filechange") {
      const changes = Array.isArray(item.changes)
        ? item.changes
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== null)
        : [];

      for (const [index, change] of changes.entries()) {
        const changePath = pickString(change, ["path"]);
        const changeKind = asRecord(change.kind);
        const changeType = normalizeFileChangeKind(
          pickString(changeKind ?? {}, ["type"]) ?? pickString(change, ["kind"])
        );
        const changeText = extractFileChangeText({ change, changeKind, changeType });
        const diffSummary =
          changeText !== undefined
            ? summarizeFileChangeText({ changeType, text: changeText })
            : undefined;
        const diff =
          changeText !== undefined
            ? buildFileChangeDiff({
                changeType,
                text: changeText,
                path: changePath
              })
            : undefined;
        changedFiles += 1;
        changedFileAdditions += diffSummary?.additions ?? 0;
        changedFileRemovals += diffSummary?.removals ?? 0;
        pushActivityDetail(details, {
          id: `${itemId}-${index + 1}`,
          kind: "write",
          label: `${changeType[0]?.toUpperCase() ?? "U"}${changeType.slice(1)} ${
            changePath ? path.basename(changePath) || changePath : "file"
          }`,
          path: changePath,
          status: itemStatus,
          ...(diff !== undefined && diffSummary
            ? {
                fileDiff: {
                  kind: changeType,
                  diff,
                  additions: diffSummary.additions,
                  removals: diffSummary.removals
                }
              }
            : {})
        });
      }
      continue;
    }

    if (normalizedItemType === "functioncall") {
      toolCalls += 1;
      const functionName =
        pickString(item, ["name", "toolName", "tool_name", "tool", "text"]) ?? "Used tool";
      const args = parseToolArguments(item);
      const command = args ? pickString(args, ["cmd", "command", "displayCommand"]) : undefined;
      const commandDetail = functionName === "exec_command"
        ? buildCommandDetail({ item, command, elapsedMs })
        : undefined;
      pushActivityDetail(details, {
        id: itemId,
        kind: "command",
        label: appendElapsedLabel(
          functionName === "exec_command" ? formatCommandLabel(command) : functionName,
          elapsedMs
        ),
        ...(commandDetail ? { command: commandDetail } : {}),
        status: itemStatus
      });
      continue;
    }

    if (normalizedItemType === "collabagenttoolcall") {
      const receiverThreadIds = readStringArray(item.receiverThreadIds);
      const tool = pickString(item, ["tool"]) ?? "collabAgent";
      if (tool === "spawnAgent" && itemStatus !== "failed") {
        spawnedAgents += receiverThreadIds.length || 1;
      } else if (tool === "wait") {
        waitedAgents += receiverThreadIds.length;
      }
      if (itemStatus === "failed") {
        failedCollabCalls += 1;
      }

      const label = formatCollabAgentToolLabel({ tool, receiverThreadIds, status: itemStatus });
      const commandDetail = buildCollabAgentCommandDetail({
        item,
        label,
        receiverThreadIds,
        tool,
      });
      pushActivityDetail(details, {
        id: itemId,
        kind: "command",
        label: appendElapsedLabel(label, elapsedMs),
        command: commandDetail,
        status: itemStatus
      });
      continue;
    }

    if (
      normalizedItemType === "mcptoolcall" ||
      normalizedItemType === "dynamictoolcall" ||
      normalizedItemType === "websearch" ||
      normalizedItemType === "imageview" ||
      normalizedItemType === "imagegeneration"
    ) {
      toolCalls += 1;
      const toolName =
        pickString(item, ["tool", "toolName", "tool_name", "name"]) ??
        (normalizedItemType === "websearch" ? "web search" : undefined);
      const query = pickString(item, ["query"]);
      pushActivityDetail(details, {
        id: itemId,
        kind: normalizedItemType === "websearch" ? "read" : "command",
        label: [
          appendElapsedLabel(toolName ?? "Used tool", elapsedMs),
          query ? `: ${query}` : "",
        ].join(""),
        status: itemStatus
      });
    }
  }

  const summaryParts: string[] = [];
  if (inspectedFiles > 0) {
    summaryParts.push(
      `Explored ${inspectedFiles} file${inspectedFiles === 1 ? "" : "s"}`
    );
  }
  if (commandsRun > 0) {
    summaryParts.push(`Ran ${commandsRun} command${commandsRun === 1 ? "" : "s"}`);
  }
  if (changedFiles > 0) {
    summaryParts.push(
      [
        `Edited ${changedFiles} file${changedFiles === 1 ? "" : "s"}`,
        changedFileAdditions > 0 || changedFileRemovals > 0
          ? `+${changedFileAdditions.toLocaleString()}, -${changedFileRemovals.toLocaleString()}`
          : "",
      ].filter(Boolean).join(", ")
    );
  }
  if (toolCalls > 0) {
    summaryParts.push(`Used ${toolCalls} tool${toolCalls === 1 ? "" : "s"}`);
  }
  if (spawnedAgents > 0) {
    summaryParts.push(`Spawned ${spawnedAgents} agent${spawnedAgents === 1 ? "" : "s"}`);
  }
  if (waitedAgents > 0) {
    summaryParts.push(`Waited on ${waitedAgents} agent${waitedAgents === 1 ? "" : "s"}`);
  }
  if (failedCollabCalls > 0) {
    summaryParts.push(
      `${failedCollabCalls} collaboration tool${failedCollabCalls === 1 ? "" : "s"} failed`
    );
  }

  if (summaryParts.length === 0 && details.length === 0) {
    return undefined;
  }

  return {
    type: "activity",
    id: `activity-${pickString(items[0] ?? {}, ["id", "itemId", "item_id"]) ?? "1"}`,
    summary:
      summaryParts.length > 0
        ? formatActivitySummary(summaryParts)
        : `Recorded ${details.length} activity item${details.length === 1 ? "" : "s"}`,
    createdAt,
    status,
    details,
    ...(turn ? { turn } : {})
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function formatCollabAgentToolLabel(params: {
  tool: string;
  receiverThreadIds: string[];
  status: AppServerThreadActivityStatus | undefined;
}): string {
  const targetCount = params.receiverThreadIds.length;
  const targetLabel =
    targetCount === 1
      ? `agent ${shortAgentId(params.receiverThreadIds[0] ?? "")}`
      : targetCount > 1
        ? `${targetCount} agents`
        : "agent";
  const failedPrefix = params.status === "failed" ? "Failed to " : "";

  if (params.tool === "spawnAgent") {
    if (params.status === "failed") {
      return `${failedPrefix}spawn ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Spawning" : "Spawned"} ${targetLabel}`;
  }
  if (params.tool === "wait") {
    if (params.status === "failed") {
      return `${failedPrefix}wait on ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Waiting on" : "Waited on"} ${targetLabel}`;
  }
  if (params.tool === "sendInput") {
    if (params.status === "failed") {
      return `${failedPrefix}send input to ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Sending input to" : "Sent input to"} ${targetLabel}`;
  }
  if (params.tool === "resumeAgent") {
    if (params.status === "failed") {
      return `${failedPrefix}resume ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Resuming" : "Resumed"} ${targetLabel}`;
  }
  if (params.tool === "closeAgent") {
    if (params.status === "failed") {
      return `${failedPrefix}close ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Closing" : "Closed"} ${targetLabel}`;
  }
  return `${failedPrefix}Used ${params.tool}`;
}

function buildCollabAgentCommandDetail(params: {
  item: Record<string, unknown>;
  label: string;
  receiverThreadIds: string[];
  tool: string;
}): AppServerThreadCommandDetail {
  const prompt = pickString(params.item, ["prompt"]);
  const model = pickString(params.item, ["model"]);
  const reasoningEffort = pickString(params.item, ["reasoningEffort", "reasoning_effort"]);
  const stateSummary = formatCollabAgentStates(asRecord(params.item.agentsStates));
  const output = [
    params.receiverThreadIds.length > 0
      ? `Agents: ${params.receiverThreadIds.join(", ")}`
      : undefined,
    model ? `Model: ${model}` : undefined,
    reasoningEffort ? `Reasoning effort: ${reasoningEffort}` : undefined,
    prompt ? `Prompt: ${truncateActivityText(prompt, 1_000)}` : undefined,
    stateSummary ? `Agent states:\n${stateSummary}` : undefined,
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n");

  const displayCommand =
    params.receiverThreadIds.length > 0
      ? `${params.tool} ${params.receiverThreadIds.map(shortAgentId).join(", ")}`
      : params.tool;
  return {
    displayCommand,
    rawCommand: params.tool,
    ...(output ? { output } : {}),
  };
}

function formatCollabAgentStates(
  states: Record<string, unknown> | null
): string | undefined {
  if (!states) {
    return undefined;
  }
  const lines = Object.entries(states).flatMap(([agentId, value]) => {
    const record = asRecord(value);
    if (!record) {
      return [];
    }
    const status = pickString(record, ["status"]) ?? "unknown";
    const message = pickString(record, ["message"]);
    const header = `${shortAgentId(agentId)}: ${status} (${agentId})`;
    if (!message) {
      return [header];
    }
    return [`${header}\nOutput:\n${indentCollabAgentMessage(message)}`];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function indentCollabAgentMessage(message: string): string {
  return message
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId;
}

function truncateActivityText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function extractThreadEntries(value: unknown): AppServerThreadEntry[] {
  const record = asRecord(value);
  const thread = asRecord(record?.thread);
  const turns = Array.isArray(thread?.turns)
    ? thread.turns
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];

  if (turns.length === 0) {
    return extractConversationMessages(value).map(
      (message): AppServerThreadMessageEntry => ({
        type: "message",
        ...message
      })
    );
  }

  const entries: AppServerThreadEntry[] = [];

  for (const turn of turns) {
    const turnMetadata = extractTurnMetadata(turn);
    const createdAt = normalizeEpochTimestamp(
      pickNumber(turn, ["startedAt", "createdAt", "timestamp", "time"])
    );
    const rawItems = Array.isArray(turn.items)
      ? turn.items
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    const assistantReviewTexts = collectAssistantReviewTexts(rawItems);
    const suppressedAssistantTexts = collectReviewSuppressionTexts(rawItems);
    for (const text of assistantReviewTexts) {
      suppressedAssistantTexts.add(normalizeSuppressionText(text));
    }
    const pendingActivityItems: Record<string, unknown>[] = [];

    const flushActivityItems = (): void => {
      const activity = summarizeActivityItems(
        pendingActivityItems,
        createdAt,
        turnMetadata
      );
      pendingActivityItems.length = 0;
      if (activity) {
        entries.push(activity);
      }
    };

    for (const item of rawItems) {
      const itemType = pickString(item, ["type"]);
      const role = normalizeConversationRole(itemType);
      if (role) {
        flushActivityItems();
        if (shouldSuppressConversationMessage(item, suppressedAssistantTexts)) {
          continue;
        }
        const content = buildMessageContent(item);
        if (!content.text && !content.parts?.length) {
          continue;
        }
        const phase = normalizeAgentMessagePhase(pickString(item, ["phase"]));
        entries.push({
          type: "message",
          id:
            pickString(item, ["id", "messageId", "message_id", "itemId", "item_id"]) ??
            `message-${entries.length + 1}`,
          role,
          text: content.text,
          ...(content.parts ? { parts: content.parts } : {}),
          createdAt,
          ...(turnMetadata ? { turn: turnMetadata } : {}),
          ...(phase ? { phase } : {})
        });
        continue;
      }

      const planEntry = extractPlanEntryFromItem(item, createdAt, turnMetadata);
      if (planEntry) {
        flushActivityItems();
        entries.push(planEntry);
        continue;
      }

      const reviewEntry = extractReviewEntryFromItem(item, createdAt, turnMetadata);
      if (reviewEntry) {
        flushActivityItems();
        const assistantReviewText =
          reviewEntry.displayText === undefined
            ? assistantReviewTexts.find((text) =>
                shouldUseAssistantReviewText({
                  assistantText: text,
                  reviewText: reviewEntry.review,
                })
              )
            : undefined;
        entries.push(
          assistantReviewText
            ? {
                ...reviewEntry,
                review: assistantReviewText,
              }
            : reviewEntry
        );
        continue;
      }

      const activityItem = extractActivityItemFromReplayItem(item);
      if (activityItem) {
        pendingActivityItems.push(activityItem);
        continue;
      }

      const functionCallOutput = extractFunctionCallOutputFromReplayItem(item);
      if (functionCallOutput) {
        attachFunctionCallOutput(pendingActivityItems, functionCallOutput);
      }
    }

    flushActivityItems();
  }

  return entries;
}

function extractReplayPagination(value: unknown): AppServerThreadReplayPagination {
  const record = asRecord(value);
  const supportsPagination = Boolean(
    record &&
      (pickBoolean(record, ["supportsPagination", "supports_pagination"]) ||
        pickString(record, ["previousCursor", "previous_cursor", "before", "cursor"]))
  );
  const hasPreviousPage = Boolean(
    record &&
      (pickBoolean(record, ["hasPreviousPage", "has_previous_page", "hasMore", "has_more"]) ||
        pickString(record, ["previousCursor", "previous_cursor", "before", "cursor"]))
  );
  const previousCursor = record
    ? pickString(record, ["previousCursor", "previous_cursor", "before", "cursor"])
    : undefined;

  return {
    supportsPagination,
    hasPreviousPage,
    previousCursor
  };
}

function extractThreadReplayFromReadResult(value: unknown): AppServerThreadReplay {
  const entries = extractThreadEntries(value);
  const messages = extractConversationMessages(value);
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!lastAssistantMessage && message?.role === "assistant") {
      lastAssistantMessage = message.text;
    }
    if (!lastUserMessage && message?.role === "user") {
      lastUserMessage = message.text;
    }
    if (lastUserMessage && lastAssistantMessage) {
      break;
    }
  }

  const threadStatus = readThreadStatus(value);
  return {
    entries,
    messages,
    lastUserMessage,
    lastAssistantMessage,
    pagination: extractReplayPagination(value),
    ...(threadStatus ? { threadStatus } : {})
  };
}

function extractThreadIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  return (
    pickString(record, ["threadId", "thread_id", "conversationId", "conversation_id"]) ??
    pickString(threadRecord ?? {}, ["id", "threadId", "thread_id", "conversationId"])
  );
}

function extractThreadNameRecordFromValue(
  value: unknown,
): CodexThreadNameRecord | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  const threadId = extractThreadIdFromValue(value);
  if (!threadId || record.ephemeral === true || threadRecord?.ephemeral === true) {
    return undefined;
  }

  const preview =
    pickString(record, ["preview", "snippet", "firstUserMessage", "first_user_message"]) ??
    pickString(threadRecord ?? {}, [
      "preview",
      "snippet",
      "firstUserMessage",
      "first_user_message",
    ]);
  const rawName =
    normalizeExplicitThreadName(
      pickString(record, ["threadName", "thread_name", "name", "title"]) ??
        pickString(threadRecord ?? {}, ["threadName", "thread_name", "name", "title"])
    );
  const indexName =
    rawName ?? (preview ? shortenDerivedThreadTitle(preview) ?? preview : undefined);
  return {
    id: threadId,
    threadName: indexName?.trim() || "Untitled thread",
  };
}

function extractSkillSummary(value: unknown): AppServerSkillSummary | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const name = pickString(record, ["name", "id", "slug"]);
  if (!name) {
    return undefined;
  }

  return {
    name,
    description: pickString(record, ["description", "summary"]),
    shortDescription: pickString(record, ["shortDescription", "short_description"]),
    path: pickString(record, ["path", "skillPath", "skill_path"]),
    enabled: pickBoolean(record, ["enabled"]),
    scope: pickString(record, ["scope"])
  };
}

function extractSkillCatalog(value: unknown): SkillCatalogEntry[] {
  const record = asRecord(value);
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(value)
      ? value
      : [];

  return data.flatMap((entry): SkillCatalogEntry[] => {
    const entryRecord = asRecord(entry);
    if (!entryRecord) {
      return [];
    }

    const rawSkills = Array.isArray(entryRecord.skills)
      ? entryRecord.skills
      : Array.isArray(entryRecord.data)
        ? entryRecord.data
        : [];
    const skills = rawSkills.flatMap((skill) => {
      const normalized = extractSkillSummary(skill);
      return normalized ? [normalized] : [];
    });

    return [
      {
        cwd: pickString(entryRecord, ["cwd"]),
        skills
      }
    ];
  });
}

function extractModelOptions(value: unknown): BackendModelOption[] {
  const record = asRecord(value);
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(value)
      ? value
      : [];

  const models = data.flatMap((entry): BackendModelOption[] => {
    const modelRecord = asRecord(entry);
    if (!modelRecord) {
      return [];
    }
    const id = pickString(modelRecord, ["id", "name", "model"]);
    if (!id || shouldHideCodexModel(id, modelRecord)) {
      return [];
    }

    return [
      {
        id,
        label: formatCodexModelLabel(id),
        current: pickBoolean(modelRecord, ["current", "default"]),
        supportsReasoning: pickBoolean(modelRecord, [
          "supportsReasoning",
          "supports_reasoning",
        ]),
        supportsFast: pickBoolean(modelRecord, ["supportsFast", "supports_fast"]),
        supportsSteering: pickBoolean(modelRecord, [
          "supportsSteering",
          "supports_steering",
        ]),
      },
    ];
  });

  return sortCodexModels(models);
}

function summarizeRawModelList(value: unknown): Array<Record<string, unknown>> {
  const record = asRecord(value);
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(value)
      ? value
      : [];

  return data.flatMap((entry) => {
    const modelRecord = asRecord(entry);
    if (!modelRecord) {
      return [];
    }

    return [
      {
        id: pickString(modelRecord, ["id", "name", "model"]) ?? null,
        displayName:
          pickString(modelRecord, ["displayName", "display_name", "label"]) ?? null,
        current: pickBoolean(modelRecord, ["current", "default"]) ?? null,
        hidden: pickBoolean(modelRecord, ["hidden"]) ?? null,
        supportsReasoning:
          pickBoolean(modelRecord, ["supportsReasoning", "supports_reasoning"]) ?? null,
        supportsFast: pickBoolean(modelRecord, ["supportsFast", "supports_fast"]) ?? null,
      },
    ];
  });
}

function shouldHideCodexModel(
  id: string,
  modelRecord: Record<string, unknown>,
): boolean {
  return (
    pickBoolean(modelRecord, ["hidden"]) === true ||
    !SUPPORTED_CODEX_MODELS.has(id.toLowerCase())
  );
}

function formatCodexModelLabel(id: string): string {
  const match = /^gpt-([^-]+)(?:-(.+))?$/i.exec(id.trim());
  if (!match) {
    return id;
  }

  const version = match[1];
  const suffix = match[2]
    ?.split("-")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join("-");

  return suffix ? `GPT-${version}-${suffix}` : `GPT-${version}`;
}

function sortCodexModels(models: BackendModelOption[]): BackendModelOption[] {
  const order = new Map<string, number>(
    SUPPORTED_CODEX_MODEL_ORDER.map((id, index) => [id, index]),
  );

  return [...models].sort((left, right) => {
    const leftOrder = order.get(left.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

function extractTurnIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const turnRecord = asRecord(record.turn);
  return (
    pickString(record, ["turnId", "turn_id", "runId", "run_id"]) ??
    pickString(turnRecord ?? {}, ["id", "turnId", "turn_id", "runId", "run_id"])
  );
}

function extractThreadRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractThreadRecords(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const directId = pickString(record, ["id", "threadId", "thread_id", "conversationId"]);
  if (directId && !Array.isArray(record.items) && !Array.isArray(record.threads)) {
    return [record];
  }

  const output: Record<string, unknown>[] = [];
  for (const key of ["threads", "items", "data", "results"]) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      output.push(...nested.flatMap((entry) => extractThreadRecords(entry)));
    }
  }
  return output;
}

function isMethodUnavailableError(error: unknown, method?: string): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();

  if (normalized.includes("method not found") || normalized.includes("unknown method")) {
    return true;
  }

  if (!normalized.includes("unknown variant")) {
    return false;
  }

  if (!method) {
    return true;
  }

  return normalized.includes(`unknown variant \`${method.toLowerCase()}\``);
}

function isAlreadyInitializedError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.toLowerCase().includes("already initialized");
}

function isUnmaterializedThreadError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  return (
    normalized.includes("not materialized yet") &&
    normalized.includes("includeturns is unavailable before first user message")
  );
}

function isRequestTimeoutError(error: unknown, method: string): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.toLowerCase().includes(`json-rpc timeout: ${method.toLowerCase()}`);
}

function extractThreadsFromValue(value: unknown): RawCodexThreadSummary[] {
  const items = extractThreadRecords(value);
  const summaries = new Map<string, RawCodexThreadSummary>();

  for (const record of items) {
    const threadId =
      pickString(record, ["threadId", "thread_id", "id", "conversationId", "conversation_id"]) ??
      pickString(asRecord(record.thread) ?? {}, ["id", "threadId", "thread_id"]);

    if (!threadId) {
      continue;
    }

    const sessionRecord = asRecord(record.session);
    const gitInfoRecord =
      asRecord(record.gitInfo) ??
      asRecord(record.git_info) ??
      asRecord(sessionRecord?.gitInfo) ??
      asRecord(sessionRecord?.git_info);
    const projectKey =
      pickString(record, ["projectKey", "project_key", "cwd"]) ??
      pickString(sessionRecord ?? {}, ["cwd", "projectKey", "project_key"]);
    const titleInfo = getThreadTitleInfo(record);
    const rawDerivedTitle =
      pickString(record, ["preview", "snippet", "firstUserMessage", "first_user_message"]) ??
      pickString(sessionRecord ?? {}, [
        "preview",
        "snippet",
        "firstUserMessage",
        "first_user_message",
      ]);
    const summary = normalizeThreadSummary(
      pickString(record, [
        "summary",
        "preview",
        "snippet",
        "firstUserMessage",
        "first_user_message",
      ]) ??
        pickString(sessionRecord ?? {}, [
          "summary",
          "preview",
          "snippet",
          "firstUserMessage",
          "first_user_message",
        ])
    );

    summaries.set(threadId, {
      id: threadId,
      title: titleInfo.title,
      titleSource: titleInfo.titleSource,
      summary:
        summary === titleInfo.title ||
        (titleInfo.titleSource === "derived" &&
          summary === normalizeThreadSummary(rawDerivedTitle))
          ? undefined
          : summary,
      projectKey,
      model:
        pickString(record, ["model"]) ??
        pickString(sessionRecord ?? {}, ["model"]),
      serviceTier:
        pickString(record, ["serviceTier", "service_tier"]) ??
        pickString(sessionRecord ?? {}, ["serviceTier", "service_tier"]),
      reasoningEffort:
        pickString(record, ["reasoningEffort", "reasoning_effort"]) ??
        pickString(sessionRecord ?? {}, ["reasoningEffort", "reasoning_effort"]),
      fastMode:
        pickBoolean(record, ["fastMode", "fast_mode"]) ??
        pickBoolean(sessionRecord ?? {}, ["fastMode", "fast_mode"]),
      createdAt: normalizeEpochTimestamp(
        pickNumber(record, ["createdAt", "created_at"]) ??
          pickNumber(sessionRecord ?? {}, ["createdAt", "created_at"])
      ),
      updatedAt: normalizeEpochTimestamp(
        pickNumber(record, ["updatedAt", "updated_at", "lastActivityAt", "createdAt"]) ??
          pickNumber(sessionRecord ?? {}, ["updatedAt", "updated_at", "lastActivityAt"])
      ),
      archivedAt: normalizeEpochTimestamp(
        pickNumber(record, ["archivedAt", "archived_at"]) ??
          pickNumber(sessionRecord ?? {}, ["archivedAt", "archived_at"])
      ),
      gitBranch:
        pickString(gitInfoRecord ?? {}, ["branch"]) ??
        pickString(asRecord(sessionRecord?.gitInfo) ?? {}, ["branch"]) ??
        pickString(asRecord(sessionRecord?.git_info) ?? {}, ["branch"]),
      gitOriginUrl: pickString(gitInfoRecord ?? {}, [
        "originUrl",
        "origin_url",
        "remoteUrl",
        "remote_url",
      ]),
    });
  }

  return [...summaries.values()].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  );
}

function extractThreadListPage(value: unknown): RawCodexThreadListPage {
  const record = asRecord(value);
  return {
    nextCursor: record
      ? pickString(record, ["nextCursor", "next_cursor", "after"])
      : undefined,
    threads: extractThreadsFromValue(value),
  };
}

function buildThreadDiscoveryPayloads(
  filter?: string,
  archived?: boolean,
  cursor?: string
): CodexThreadListParams[] {
  const searchTerm = filter?.trim() || undefined;
  const baseParams: CodexThreadListParams = {
    archived,
    cursor,
    limit: 50,
    sortKey: "updated_at",
    sourceKinds: ["cli", "vscode"],
    useStateDbOnly: true,
  };

  return [
    {
      ...baseParams,
      searchTerm,
    },
    {
      ...baseParams,
    },
    cursor ? { cursor } : {}
  ];
}

function threadTitleSourcePriority(
  titleSource: AppServerThreadTitleSource
): number {
  switch (titleSource) {
    case "explicit":
      return 2;
    case "derived":
      return 1;
    case "fallback":
    default:
      return 0;
  }
}

function mergeThreadSummaries(
  threads: RawCodexThreadSummary[]
): RawCodexThreadSummary[] {
  const merged = new Map<string, RawCodexThreadSummary>();

  for (const thread of threads) {
    const current = merged.get(thread.id);
    if (!current) {
      merged.set(thread.id, thread);
      continue;
    }

    const currentPriority = threadTitleSourcePriority(current.titleSource);
    const nextPriority = threadTitleSourcePriority(thread.titleSource);
    const preferNext =
      nextPriority > currentPriority ||
      (nextPriority === currentPriority &&
        (thread.updatedAt ?? 0) > (current.updatedAt ?? 0));

    merged.set(thread.id, preferNext ? thread : current);
  }

  return [...merged.values()].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  );
}

function mergeArchivedThreadMetadata(params: {
  activeThreads: RawCodexThreadSummary[];
  archivedThreads: RawCodexThreadSummary[];
}): RawCodexThreadSummary[] {
  const archivedById = new Map(
    params.archivedThreads.map((thread) => [thread.id, thread] as const)
  );

  return params.activeThreads
    .map((thread) => {
      const archived = archivedById.get(thread.id);
      if (!archived) {
        return thread;
      }

      return mergeThreadSummaries([thread, archived])[0] ?? thread;
    })
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function buildThreadMetadataCacheKey(filter?: string): string {
  return filter?.trim() || "";
}

function normalizeGitOriginUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/i);
  const candidate = sshMatch
    ? `${sshMatch[1]}/${sshMatch[2]}`
    : trimmed.replace(/^[a-z]+:\/\//i, "");

  const normalized = candidate
    .replace(/\.git$/i, "")
    .replace(/^ssh\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  return normalized || undefined;
}

type EnrichedCodexThread = AppServerThreadSummary & {
  gitOriginUrl?: string;
};

const THREAD_DIRECTORY_ENRICHMENT_CONCURRENCY = 8;
const THREAD_DIRECTORY_ENRICHMENT_MAX_UNREAD = 16;

function hydrateMissingLinkedDirectoriesFromSiblingRepos(
  threads: EnrichedCodexThread[]
): EnrichedCodexThread[] {
  const donorDirectoriesByOrigin = new Map<string, LinkedDirectorySummary[]>();

  for (const thread of threads) {
    if (thread.linkedDirectories.length === 0) {
      continue;
    }

    const normalizedOrigin = normalizeGitOriginUrl(thread.gitOriginUrl);
    if (!normalizedOrigin || donorDirectoriesByOrigin.has(normalizedOrigin)) {
      continue;
    }

    const rootDirectories = thread.linkedDirectories.filter(
      (directory) => !directory.worktreePath
    );
    donorDirectoriesByOrigin.set(
      normalizedOrigin,
      rootDirectories.length > 0 ? rootDirectories : thread.linkedDirectories
    );
  }

  return threads.map((thread) => {
    if (thread.linkedDirectories.length > 0) {
      return thread;
    }

    const normalizedOrigin = normalizeGitOriginUrl(thread.gitOriginUrl);
    if (!normalizedOrigin) {
      return thread;
    }

    const donorDirectories = donorDirectoriesByOrigin.get(normalizedOrigin);
    if (!donorDirectories || donorDirectories.length === 0) {
      return thread;
    }

    const linkedDirectories = donorDirectories.map((directory) => {
      if (!thread.projectKey || thread.projectKey === directory.path) {
        return directory;
      }

      return {
        ...directory,
        worktreePath: thread.projectKey,
        kind: "worktree" as const,
      };
    });

    return {
      ...thread,
      linkedDirectories,
    };
  });
}

function normalizeCodexApprovalPolicy(
  value?: string
): CodexAskForApproval | undefined {
  const normalized = value?.trim();
  if (
    normalized === "untrusted" ||
    normalized === "on-failure" ||
    normalized === "on-request" ||
    normalized === "never"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeCodexSandboxMode(
  value?: string
): CodexSandboxMode | undefined {
  const normalized = value?.trim();
  if (
    normalized === "read-only" ||
    normalized === "workspace-write" ||
    normalized === "danger-full-access"
  ) {
    return normalized;
  }
  return undefined;
}

function buildCodexSandboxPolicy(
  value?: string
): CodexSandboxPolicy | undefined {
  const mode = normalizeCodexSandboxMode(value);
  if (!mode) {
    return undefined;
  }
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function normalizeCodexServiceTier(
  value?: string
): CodexServiceTier | undefined {
  const normalized = value?.trim();
  if (normalized === "fast" || normalized === "flex") {
    return normalized;
  }
  return undefined;
}

function normalizeCodexReasoningEffort(
  value?: string
): CodexReasoningEffort | undefined {
  const normalized = value?.trim();
  if (
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return undefined;
}

function buildThreadStartPayload(params: {
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  ephemeral?: boolean;
  codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
  config?: CodexThreadStartParams["config"];
  dynamicTools?: CodexDynamicToolSpec[];
}): CodexThreadStartParams {
  const base: CodexThreadStartParams = {
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  };

  if (params.cwd?.trim()) {
    base.cwd = params.cwd.trim();
  }
  if (params.model?.trim()) {
    base.model = params.model.trim();
  }

  const approvalPolicy = normalizeCodexApprovalPolicy(params.approvalPolicy);
  if (approvalPolicy) {
    base.approvalPolicy = approvalPolicy;
  }

  const sandbox = normalizeCodexSandboxMode(params.sandbox);
  if (sandbox) {
    base.sandbox = sandbox;
  }

  const serviceTier = normalizeCodexServiceTier(params.serviceTier);
  if (serviceTier) {
    base.serviceTier = serviceTier;
  }
  if (params.ephemeral !== undefined) {
    base.ephemeral = params.ephemeral;
  }
  if (params.config) {
    base.config = params.config;
  }
  if (params.dynamicTools) {
    base.dynamicTools = params.dynamicTools;
  }
  if (
    params.codexEnvironmentRuntime?.executionTarget === "remote" &&
    params.codexEnvironmentRuntime.environmentId &&
    params.cwd?.trim()
  ) {
    base.environments = [
      {
        environmentId: params.codexEnvironmentRuntime.environmentId,
        cwd: params.cwd.trim(),
      },
    ];
  }

  return base;
}

function buildThreadResumePayloads(params: {
  threadId: string;
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}): CodexThreadResumeParams[] {
  const base: CodexThreadResumeParams = {
    threadId: params.threadId,
    persistExtendedHistory: false,
  };

  if (params.cwd?.trim()) {
    base.cwd = params.cwd.trim();
  }
  if (params.model?.trim()) {
    base.model = params.model.trim();
  }

  const approvalPolicy = normalizeCodexApprovalPolicy(params.approvalPolicy);
  if (approvalPolicy) {
    base.approvalPolicy = approvalPolicy;
  }

  const sandbox = normalizeCodexSandboxMode(params.sandbox);
  if (sandbox) {
    base.sandbox = sandbox;
  }

  const serviceTier = normalizeCodexServiceTier(params.serviceTier);
  if (serviceTier) {
    base.serviceTier = serviceTier;
  }

  if (typeof params.fastMode === "boolean") {
    base.config = {
      fast_mode: params.fastMode,
    };
  }

  return [base];
}

function extractStringProperty(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function buildCollaborationModeOverrides(params: {
  collaborationMode?: AppServerCollaborationModeRequest;
  fallbackModel?: string;
  fallbackReasoningEffort?: string;
}): { model: string; effort: CodexReasoningEffort | null } | undefined {
  if (!params.collaborationMode) {
    return undefined;
  }

  const settings = params.collaborationMode.settings ?? {};
  const model =
    settings.model?.trim() ||
    params.fallbackModel?.trim() ||
    DEFAULT_CODEX_COLLABORATION_MODEL;
  const reasoningEffort =
    normalizeCodexReasoningEffort(settings.reasoningEffort) ??
    normalizeCodexReasoningEffort(params.fallbackReasoningEffort) ??
    null;
  return {
    model,
    effort: reasoningEffort,
  };
}

function toCodexUserInput(input: AppServerTurnInputItem): CodexUserInput {
  if (input.type === "text") {
    return {
      type: "text",
      text: input.text,
      text_elements: [],
    };
  }

  return input;
}

function buildTurnStartPayload(params: {
  threadId: string;
  input: AppServerTurnInputItem[];
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy?: string;
  sandbox?: string;
  outputSchema?: CodexTurnStartParams["outputSchema"];
  collaborationMode?: AppServerCollaborationModeRequest;
  collaborationFallbackModel?: string;
  collaborationFallbackReasoningEffort?: string;
}): CodexTurnStartParams {
  const base: CodexTurnStartParams = {
    threadId: params.threadId,
    input: params.input.map(toCodexUserInput),
  };

  if (params.cwd?.trim()) {
    base.cwd = params.cwd.trim();
  }
  if (params.model?.trim()) {
    base.model = params.model.trim();
  }

  const reasoningEffort = normalizeCodexReasoningEffort(params.reasoningEffort);
  if (reasoningEffort) {
    base.effort = reasoningEffort;
  }
  const serviceTier = normalizeCodexServiceTier(params.serviceTier);
  if (serviceTier) {
    base.serviceTier = serviceTier;
  }
  const approvalPolicy = normalizeCodexApprovalPolicy(params.approvalPolicy);
  if (approvalPolicy) {
    base.approvalPolicy = approvalPolicy;
  }
  const sandboxPolicy = buildCodexSandboxPolicy(params.sandbox);
  if (sandboxPolicy) {
    base.sandboxPolicy = sandboxPolicy;
  }
  if (params.outputSchema) {
    base.outputSchema = params.outputSchema;
  }

  const collaborationOverrides = buildCollaborationModeOverrides({
    collaborationMode: params.collaborationMode,
    fallbackModel: params.collaborationFallbackModel ?? params.model,
    fallbackReasoningEffort:
      params.collaborationFallbackReasoningEffort ?? params.reasoningEffort,
  });
  if (collaborationOverrides) {
    base.model = collaborationOverrides.model;
    base.effort = collaborationOverrides.effort;
  }

  return base;
}

function buildReviewStartPayload(params: {
  threadId: string;
  target: AppServerReviewTarget;
  delivery?: AppServerReviewDelivery;
}): CodexReviewStartParams {
  return {
    threadId: params.threadId,
    target: params.target,
    delivery: params.delivery ?? "inline",
  };
}

type CodexThreadReadPayload = CodexThreadReadParams & {
  before?: string;
  limit?: number;
};

function buildThreadReadPayload(params: {
  threadId: string;
  before?: string;
  limit?: number;
}): CodexThreadReadPayload {
  const payload: CodexThreadReadPayload = {
    threadId: params.threadId,
    includeTurns: true,
  };

  if (params.before) {
    payload.before = params.before;
  }

  if (params.limit !== undefined) {
    payload.limit = params.limit;
  }

  return payload;
}

async function requestWithFallbacks(params: {
  client: JsonRpcConnection;
  diagnostics?: JsonRpcObserverDiagnostics;
  methods: Array<CodexClientRequestMethod | (string & {})>;
  payloads: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  let lastError: unknown;

  for (const method of params.methods) {
    for (const payload of params.payloads) {
      try {
        return await params.client.request(
          method,
          payload,
          params.timeoutMs,
          params.diagnostics,
        );
      } catch (error) {
        lastError = error;
        if (!isMethodUnavailableError(error, method)) {
          continue;
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function requestThreadListPages(params: {
  archived?: boolean;
  client: JsonRpcConnection;
  diagnostics?: JsonRpcObserverDiagnostics;
  filter?: string;
  requestTimeoutMs: number;
}): Promise<RawCodexThreadSummary[]> {
  const pages: RawCodexThreadSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const result = await requestWithFallbacks({
      client: params.client,
      diagnostics: params.diagnostics,
      methods: ["thread/list"] as CodexClientRequestMethod[],
      payloads: buildThreadDiscoveryPayloads(params.filter, params.archived, cursor),
      timeoutMs: params.requestTimeoutMs,
    });
    const page = extractThreadListPage(result);
    pages.push(...page.threads);

    const nextCursor = page.nextCursor?.trim();
    if (!nextCursor || seenCursors.has(nextCursor)) {
      cursor = undefined;
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return mergeThreadSummaries(pages);
}

type HelperTurnResult =
  | {
      status: "ok";
      object: unknown;
    }
  | {
      status: "failed";
      error: Error;
    };

export class CodexAppServerClient {
  private readonly connection: JsonRpcConnection;
  private readonly threadDirectoryEnricher: (
    projectKey?: string
  ) => Promise<ThreadDirectoryEnrichment>;
  private readonly archivedThreadMetadataByFilter = new Map<
    string,
    RawCodexThreadSummary[]
  >();
  private readonly archivedThreadMetadataInFlightByFilter = new Map<
    string,
    Promise<RawCodexThreadSummary[]>
  >();
  private readonly archivedThreadMetadataLastRefreshByFilter = new Map<string, number>();
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private initializeResult: InitializeResult | null = null;
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  private readonly recordedThreadNames = new Map<string, string>();
  private readonly requestListeners = new Set<
    (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  >();
  private readonly pendingFirstTurnThreadResults = new Map<string, unknown>();
  private readonly helperThreadIds = new Set<string>();
  private readonly helperTurnWaiters = new Map<
    string,
    {
      resolve: (object: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly completedHelperTurnResults = new Map<string, HelperTurnResult>();
  private readonly helperTurnTitleObjects = new Map<string, unknown>();

  constructor(private readonly options: CodexClientOptions = {}) {
    this.connection = new JsonRpcConnection(
      new StdioJsonRpcTransport({
        command: options.command?.trim() || "codex",
        args: options.args ?? [],
        env: options.env
      }),
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.connectionObserver,
      { logContext: { backend: "codex" } },
    );
    const directoryResolver = options.directoryResolver;
    this.threadDirectoryEnricher =
      options.threadDirectoryEnricher ??
      (directoryResolver
        ? async (projectKey?: string) => ({
            linkedDirectories: await directoryResolver(projectKey),
          })
        : createThreadDirectoryEnricher());
    this.connection.setNotificationHandler(async (method, params) => {
      const isKnownCodexMethod = isKnownCodexNotificationMethod(method);
      if (!isKnownCodexMethod) {
        logUnhandledCodexMessage({
          kind: "notification",
          method,
          payload: params,
        });
      }
      if (method === "skills/changed") {
        logSkillsChangedNotification({
          payload: params,
          listenerCount: this.notificationListeners.size,
          initialized: this.initialized,
          serverAdvertisesSkillsList:
            this.initializeResult?.methods?.includes("skills/list") ?? false,
        });
      }

      const normalized = normalizeServerNotification(
        method,
        params,
      );
      const helperThreadId = extractThreadIdFromNotification(normalized, params);
      if (helperThreadId && this.helperThreadIds.has(helperThreadId)) {
        this.handleHelperThreadNotification(method, normalized);
        return;
      }

      if (method === "thread/started") {
        await this.recordThreadNameWithCodex(params);
      }

      for (const listener of this.notificationListeners) {
        await listener(normalized);
      }
    });
    this.connection.setRequestHandler(async (method, params, rpcId) => {
      const wireRequest = isKnownCodexServerRequestMethod(method)
        ? ({
            method,
            id: rpcId ?? `${method}-request`,
            params: params ?? {},
          } as CodexServerRequest)
        : undefined;
      const request = normalizePendingRequestNotification(
        wireRequest?.method ?? method,
        wireRequest?.params ?? params,
        rpcId
      );

      const listeners = [...this.requestListeners];
      if (listeners.length === 0) {
        logUnhandledCodexMessage({
          kind: "request",
          method,
          payload: params,
        });
        throw new Error(`No desktop request handler registered for ${method}`);
      }

      if (!isHandledServerRequestMethod(method)) {
        logUnhandledCodexMessage({
          kind: "request",
          method,
          payload: params,
        });
      }

      for (const listener of listeners) {
        return await listener(request);
      }

      throw new Error(`No desktop request handler registered for ${method}`);
    });
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.initializationPromise = null;
    this.initializeResult = null;
    this.rejectHelperTurnWaiters(new Error("codex app server client closed"));
    this.pendingFirstTurnThreadResults.clear();
    this.recordedThreadNames.clear();
    this.helperThreadIds.clear();
    this.completedHelperTurnResults.clear();
    this.helperTurnTitleObjects.clear();
    await this.connection.close();
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

  async trustProject(params: {
    projectPath: string;
    configPath?: string;
  }): Promise<{ projectPath: string; configPath?: string }> {
    const projectPath = params.projectPath.trim();
    if (!projectPath) {
      throw new Error("projectPath is required");
    }
    await this.ensureInitialized();

    const payload: CodexConfigValueWriteParams = {
      keyPath: "projects",
      value: {
        [projectPath]: {
          trust_level: "trusted",
        },
      },
      mergeStrategy: "upsert",
      ...(params.configPath?.trim()
        ? { filePath: params.configPath.trim() }
        : {}),
    };

    await requestWithFallbacks({
      client: this.connection,
      methods: ["config/value/write"],
      payloads: [payload],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    return {
      projectPath,
      ...(params.configPath?.trim()
        ? { configPath: params.configPath.trim() }
        : {}),
    };
  }

  private async recordThreadNameWithCodex(value: unknown): Promise<void> {
    const entry = extractThreadNameRecordFromValue(value);
    const previous = entry ? this.recordedThreadNames.get(entry.id) : undefined;
    if (
      !entry ||
      (previous &&
        (previous === entry.threadName ||
          !isPlaceholderThreadName(previous)))
    ) {
      return;
    }

    try {
      await this.setThreadNameWithCodex({
        threadId: entry.id,
        name: entry.threadName,
      });
      this.recordedThreadNames.set(entry.id, entry.threadName);
    } catch (error) {
      codexClientLog.warn("failed to set codex thread name", {
        threadId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordDerivedThreadNameWithCodex(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
  }): Promise<void> {
    const previous = this.recordedThreadNames.get(params.threadId);
    const threadName = deriveThreadNameFromInput(params.input);
    if (!previous || !threadName || !isPlaceholderThreadName(previous)) {
      return;
    }

    try {
      await this.setThreadNameWithCodex({
        threadId: params.threadId,
        name: threadName,
      });
      this.recordedThreadNames.set(params.threadId, threadName);
    } catch (error) {
      codexClientLog.warn("failed to set derived codex thread name", {
        threadId: params.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async setThreadNameWithCodex(params: {
    threadId: string;
    name: string;
  }): Promise<unknown> {
    return await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/name/set"],
      payloads: [{ threadId: params.threadId, name: params.name }],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  private handleHelperThreadNotification(
    method: string,
    notification: AppServerNotification
  ): void {
    if (
      method !== "item/completed" &&
      method !== "turn/completed" &&
      method !== "turn/failed"
    ) {
      return;
    }

    const threadId = readStringFromRecord(notification.params, "threadId");
    const turnId = extractTurnIdFromNotificationParams(notification.params);
    if (!threadId || !turnId) {
      return;
    }

    const key = buildHelperTurnKey(threadId, turnId);
    if (method === "item/completed") {
      const object = extractGeneratedTitleObject(notification.params);
      if (object) {
        this.helperTurnTitleObjects.set(key, object);
      }
      return;
    }

    const waiter = this.helperTurnWaiters.get(key);
    if (method === "turn/failed") {
      const error = new Error("codex_title_turn_failed");
      this.helperTurnTitleObjects.delete(key);
      if (!waiter) {
        this.completedHelperTurnResults.set(key, {
          status: "failed",
          error,
        });
        return;
      }
      clearTimeout(waiter.timer);
      this.helperTurnWaiters.delete(key);
      waiter.reject(error);
      return;
    }

    const object =
      extractGeneratedTitleObject(notification.params) ??
      this.helperTurnTitleObjects.get(key);
    this.helperTurnTitleObjects.delete(key);
    if (!object) {
      const error = new Error("codex_title_turn_completed_without_title");
      if (!waiter) {
        this.completedHelperTurnResults.set(key, {
          status: "failed",
          error,
        });
        return;
      }
      clearTimeout(waiter.timer);
      this.helperTurnWaiters.delete(key);
      waiter.reject(error);
      return;
    }

    if (!waiter) {
      this.completedHelperTurnResults.set(key, {
        status: "ok",
        object,
      });
      return;
    }

    clearTimeout(waiter.timer);
    this.helperTurnWaiters.delete(key);
    waiter.resolve(object);
  }

  private waitForHelperTurnTitle(params: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
  }): Promise<unknown> {
    const key = buildHelperTurnKey(params.threadId, params.turnId);
    const completed = this.completedHelperTurnResults.get(key);
    if (completed) {
      this.completedHelperTurnResults.delete(key);
      if (completed.status === "failed") {
        return Promise.reject(completed.error);
      }
      return Promise.resolve(completed.object);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helperTurnWaiters.delete(key);
        reject(new Error("codex_title_turn_timeout"));
      }, Math.max(100, params.timeoutMs));
      this.helperTurnWaiters.set(key, {
        resolve,
        reject,
        timer,
      });
    });
  }

  private rejectHelperTurnWaiters(error: Error): void {
    for (const [key, waiter] of this.helperTurnWaiters) {
      clearTimeout(waiter.timer);
      this.helperTurnWaiters.delete(key);
      waiter.reject(error);
    }
  }

  async listThreads(params?: {
    archived?: boolean;
    enrichDirectories?: boolean;
    filter?: string;
  }, diagnostics?: JsonRpcObserverDiagnostics): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();

    const requestParams = {
      client: this.connection,
      diagnostics,
      methods: ["thread/list"] as CodexClientRequestMethod[],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    };
    if (params?.archived === true) {
      const archivedThreads = await requestThreadListPages({
        archived: true,
        client: this.connection,
        diagnostics,
        filter: params?.filter,
        requestTimeoutMs: requestParams.timeoutMs,
      });
      return await this.enrichThreads(archivedThreads, {
        enrichDirectories: params?.enrichDirectories ?? true,
      });
    }

    const activeThreads = await requestThreadListPages({
      archived: false,
      client: this.connection,
      diagnostics,
      filter: params?.filter,
      requestTimeoutMs: requestParams.timeoutMs,
    });
    const threads = mergeArchivedThreadMetadata({
      activeThreads,
      archivedThreads: this.getCachedArchivedThreadMetadata(params?.filter),
    });
    this.scheduleArchivedThreadMetadataRefresh(params?.filter, diagnostics);

    return await this.enrichThreads(threads, {
      enrichDirectories: params?.enrichDirectories ?? true,
    });
  }

  private getCachedArchivedThreadMetadata(filter?: string): RawCodexThreadSummary[] {
    return this.archivedThreadMetadataByFilter.get(buildThreadMetadataCacheKey(filter)) ?? [];
  }

  private scheduleArchivedThreadMetadataRefresh(
    filter?: string,
    diagnostics?: JsonRpcObserverDiagnostics,
  ): void {
    const cacheKey = buildThreadMetadataCacheKey(filter);
    const lastRefreshAt = this.archivedThreadMetadataLastRefreshByFilter.get(cacheKey) ?? 0;
    const hasCachedMetadata = this.archivedThreadMetadataByFilter.has(cacheKey);
    if (
      this.archivedThreadMetadataInFlightByFilter.has(cacheKey) ||
      (hasCachedMetadata &&
        Date.now() - lastRefreshAt < ARCHIVED_THREAD_METADATA_REFRESH_INTERVAL_MS)
    ) {
      return;
    }

    setTimeout(() => {
      void this.refreshArchivedThreadMetadata(filter, diagnostics).catch((error) => {
        codexClientLog.warn("archived thread metadata refresh failed", {
          error: error instanceof Error ? error.message : String(error),
          filter: filter?.trim() || null,
        });
      });
    }, 0);
  }

  private async refreshArchivedThreadMetadata(
    filter?: string,
    diagnostics?: JsonRpcObserverDiagnostics,
  ): Promise<RawCodexThreadSummary[]> {
    const cacheKey = buildThreadMetadataCacheKey(filter);
    const inFlight = this.archivedThreadMetadataInFlightByFilter.get(cacheKey);
    if (inFlight) {
      return await inFlight;
    }

    const requestPromise = requestThreadListPages({
      archived: true,
      client: this.connection,
      diagnostics: diagnostics
        ? {
            ...diagnostics,
            callerReason: `${diagnostics.callerReason ?? "thread-list"}:archived-metadata`,
          }
        : undefined,
      filter,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    })
      .then((threads) => {
        this.archivedThreadMetadataByFilter.set(cacheKey, threads);
        this.archivedThreadMetadataLastRefreshByFilter.set(cacheKey, Date.now());
        return threads;
      })
      .finally(() => {
        this.archivedThreadMetadataInFlightByFilter.delete(cacheKey);
      });

    this.archivedThreadMetadataInFlightByFilter.set(cacheKey, requestPromise);
    return await requestPromise;
  }

  private async enrichThreads(
    threads: RawCodexThreadSummary[],
    options: { enrichDirectories: boolean },
  ): Promise<AppServerThreadSummary[]> {
    if (!options.enrichDirectories) {
      return threads.map((thread) => {
        const projectKey = thread.projectKey?.trim() || undefined;
        return {
          ...thread,
          projectKey,
          gitBranch: thread.gitBranch,
          linkedDirectories: buildProjectKeyLinkedDirectories(projectKey),
          source: "codex" as const,
        };
      });
    }

    const enrichedThreads = await this.enrichRawThreadDirectories(threads);

    return hydrateMissingLinkedDirectoriesFromSiblingRepos(enrichedThreads);
  }

  async enrichThreadDirectories(
    threads: AppServerThreadSummary[],
  ): Promise<AppServerThreadSummary[]> {
    const enrichedThreads = await this.enrichRawThreadDirectories(
      threads as RawCodexThreadSummary[],
    );
    return hydrateMissingLinkedDirectoriesFromSiblingRepos(enrichedThreads);
  }

  private async enrichRawThreadDirectories(
    threads: RawCodexThreadSummary[],
  ): Promise<EnrichedCodexThread[]> {
    const enrichedThreads: Array<EnrichedCodexThread | undefined> = [];

    for await (const enrichedThread of new IterableMapper(
      threads.map((thread, index) => ({ index, thread })),
      async ({ index, thread }): Promise<{
        index: number;
        thread: EnrichedCodexThread;
      }> => {
        const projectKey = await resolveThreadProjectKey(thread);
        const enrichment = await this.threadDirectoryEnricher(projectKey);
        return {
          index,
          thread: {
            ...thread,
            projectKey,
            gitBranch: thread.gitBranch,
            linkedDirectories: enrichment.linkedDirectories,
            observedGitBranch: enrichment.observedGitBranch,
            source: "codex" as const,
          },
        };
      },
      {
        concurrency: THREAD_DIRECTORY_ENRICHMENT_CONCURRENCY,
        maxUnread: THREAD_DIRECTORY_ENRICHMENT_MAX_UNREAD,
      },
    )) {
      enrichedThreads[enrichedThread.index] = enrichedThread.thread;
    }

    return enrichedThreads.filter(
      (thread): thread is EnrichedCodexThread => Boolean(thread),
    );
  }

  async listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<SkillCatalogEntry[]> {
    await this.ensureInitialized();

    const cwds = [
      ...new Set(
        [...(params?.cwds ?? []), params?.cwd].filter(
          (cwd): cwd is string => typeof cwd === "string" && cwd.trim().length > 0
        )
      ),
    ];
    const payload: CodexSkillsListParams = { cwds };
    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["skills/list"],
      payloads: [payload],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    });

    return extractSkillCatalog(result);
  }

  async listModels(
    diagnostics?: JsonRpcObserverDiagnostics,
  ): Promise<BackendModelOption[]> {
    await this.ensureInitialized();

    const payload: CodexModelListParams = {};
    const result = await requestWithFallbacks({
      client: this.connection,
      diagnostics,
      methods: ["model/list"],
      payloads: [payload],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    });

    const models = extractModelOptions(result);
    codexClientLog.info("model/list", {
      rawModels: summarizeRawModelList(result),
      normalizedModelIds: models.map((model) => model.id),
    });

    return models;
  }

  async readAccount(): Promise<BackendAccountSummary> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["account/read"],
      payloads: [{ refreshToken: false }, { refresh_token: false }, {}],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    });

    return extractAccountSummary(result);
  }

  async readRateLimits(): Promise<BackendRateLimitSummary[]> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["account/rateLimits/read"],
      payloads: [{}],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    });

    return extractRateLimitSummaries(result);
  }

  async readThread(params: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerThreadReplay> {
    await this.ensureInitialized();

    let result: unknown;
    try {
      const payload = buildThreadReadPayload(params);
      result = await requestWithFallbacks({
        client: this.connection,
        methods: ["thread/read"],
        payloads: [payload],
        timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      });
    } catch (error) {
      if (!isUnmaterializedThreadError(error)) {
        throw error;
      }

      return {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false
        }
      };
    }

    return extractThreadReplayFromReadResult(result);
  }

  async startThread(params: {
    cwd?: string;
    ephemeral?: boolean;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    dynamicTools?: CodexDynamicToolSpec[];
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/start"],
      payloads: [buildThreadStartPayload(params)],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    const threadId = extractThreadIdFromValue(result);
    if (!threadId) {
      throw new Error("codex app server thread/start did not return threadId");
    }

    this.pendingFirstTurnThreadResults.set(threadId, result);
    await this.recordThreadNameWithCodex(result);

    return {
      threadId,
    };
  }

  async startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{
    threadId: string;
    turnId: string;
  }> {
    await this.ensureInitialized();

    const pendingFirstTurnResult = this.pendingFirstTurnThreadResults.get(params.threadId);
    // thread/resume primes the per-thread permission profile in codex
    // before later turn/start calls. A just-created thread has no rollout
    // yet, so resume is guaranteed to be too early; turn/start already
    // carries the permission/model overrides needed for the first turn.
    const resumeResult =
      pendingFirstTurnResult ??
      (await requestWithFallbacks({
        client: this.connection,
        methods: ["thread/resume"],
        payloads: buildThreadResumePayloads({
          threadId: params.threadId,
          cwd: params.cwd,
          approvalPolicy: params.approvalPolicy,
          sandbox: params.sandbox,
          model: params.model,
          serviceTier: params.serviceTier,
          reasoningEffort: params.reasoningEffort,
          fastMode: params.fastMode
        }),
        timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      }).catch((error: unknown) => {
        codexClientLog.warn("thread/resume failed before turn/start", {
          threadId: params.threadId,
          requestedApprovalPolicy: params.approvalPolicy ?? null,
          requestedSandbox: params.sandbox ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }));

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["turn/start"],
      payloads: [
        buildTurnStartPayload({
          threadId: params.threadId,
          input: params.input,
          cwd: params.cwd,
          model: params.model,
          reasoningEffort: params.reasoningEffort,
          serviceTier: params.serviceTier,
          approvalPolicy: params.approvalPolicy,
          sandbox: params.sandbox,
          collaborationMode: params.collaborationMode,
          collaborationFallbackModel:
            params.model?.trim() || extractStringProperty(resumeResult, "model"),
          collaborationFallbackReasoningEffort: extractStringProperty(
            resumeResult,
            "reasoningEffort",
            "reasoning_effort"
          ),
        }),
      ],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    const threadId = extractThreadIdFromValue(result) ?? params.threadId;
    const turnId = extractTurnIdFromValue(result) ?? `pending:${threadId}`;
    this.pendingFirstTurnThreadResults.delete(params.threadId);
    await this.recordDerivedThreadNameWithCodex({
      threadId: params.threadId,
      input: params.input,
    });

    return { threadId, turnId };
  }

  async generateTitle(params: ThreadTitleAdapterParams): Promise<ThreadTitleAdapterResult> {
    await this.ensureInitialized();

    let helperThreadId: string | undefined;
    const timeoutMs = params.timeoutMs ?? DEFAULT_CODEX_THREAD_TITLE_TIMEOUT_MS;
    try {
      const threadStartResult = await requestWithFallbacks({
        client: this.connection,
        methods: ["thread/start"],
        payloads: [
          buildThreadStartPayload({
            model: DEFAULT_CODEX_THREAD_TITLE_MODEL,
            serviceTier: "fast",
            ephemeral: true,
            config: CODEX_THREAD_TITLE_CONFIG,
          }),
          buildThreadStartPayload({
            model: DEFAULT_CODEX_THREAD_TITLE_MODEL,
            ephemeral: true,
            config: CODEX_THREAD_TITLE_CONFIG,
          }),
        ],
        timeoutMs,
      });
      helperThreadId = extractThreadIdFromValue(threadStartResult);
      if (!helperThreadId) {
        return {
          status: "failed",
          reason: "codex_title_thread_start_missing_thread_id",
        };
      }
      this.helperThreadIds.add(helperThreadId);

      const turnStartResult = await requestWithFallbacks({
        client: this.connection,
        methods: ["turn/start"],
        payloads: [
          buildTurnStartPayload({
            threadId: helperThreadId,
            input: [{ type: "text", text: params.prompt }],
            model: DEFAULT_CODEX_THREAD_TITLE_MODEL,
            serviceTier: "fast",
            reasoningEffort: "low",
            outputSchema: params.schema as CodexTurnStartParams["outputSchema"],
          }),
          buildTurnStartPayload({
            threadId: helperThreadId,
            input: [{ type: "text", text: params.prompt }],
            model: DEFAULT_CODEX_THREAD_TITLE_MODEL,
            reasoningEffort: "low",
            outputSchema: params.schema as CodexTurnStartParams["outputSchema"],
          }),
        ],
        timeoutMs,
      });
      const immediateObject = extractGeneratedTitleObject(turnStartResult);
      if (immediateObject) {
        return {
          status: "ok",
          object: immediateObject,
        };
      }

      const turnId = extractTurnIdFromValue(turnStartResult);
      if (!turnId) {
        return {
          status: "failed",
          reason: "codex_title_turn_start_missing_turn_id",
        };
      }

      return {
        status: "ok",
        object: await this.waitForHelperTurnTitle({
          threadId: helperThreadId,
          turnId,
          timeoutMs,
        }),
      };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async startReview(params: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: AppServerReviewDelivery;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> {
    await this.ensureInitialized();

    if (!this.pendingFirstTurnThreadResults.has(params.threadId)) {
      await requestWithFallbacks({
        client: this.connection,
        methods: ["thread/resume"],
        payloads: buildThreadResumePayloads({
          threadId: params.threadId,
        }),
        timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      }).catch(() => undefined);
    }

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["review/start"],
      payloads: [buildReviewStartPayload(params)],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    const record = asRecord(result);
    const reviewThreadId =
      pickString(record ?? {}, ["reviewThreadId", "review_thread_id"]) ?? params.threadId;
    const turnRecord = asRecord(record?.turn);
    const turnId =
      extractTurnIdFromValue(result) ??
      pickString(turnRecord ?? {}, ["id", "turnId", "turn_id"]) ??
      `pending:${reviewThreadId}`;
    this.pendingFirstTurnThreadResults.delete(params.threadId);

    return {
      threadId: params.threadId,
      reviewThreadId,
      turnId,
    };
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

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/resume"],
      payloads: buildThreadResumePayloads(params),
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    });

    return {
      threadId: extractThreadIdFromValue(result) ?? params.threadId,
    };
  }

  async archiveThread(params: { threadId: string }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/archive"],
      payloads: [{ threadId: params.threadId }],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    return {
      threadId: extractThreadIdFromValue(result) ?? params.threadId,
    };
  }

  async restoreThread(params: { threadId: string }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/unarchive"],
      payloads: [{ threadId: params.threadId }],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    return {
      threadId: extractThreadIdFromValue(result) ?? params.threadId,
    };
  }

  async renameThread(params: {
    threadId: string;
    name: string;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await this.setThreadNameWithCodex(params);
    const threadId = extractThreadIdFromValue(result) ?? params.threadId;
    this.recordedThreadNames.set(threadId, params.name);

    return {
      threadId,
    };
  }

  async updateThreadMetadata(params: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/metadata/update"],
      payloads: [
        {
          threadId: params.threadId,
          gitInfo: params.gitInfo,
        },
      ],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    return {
      threadId: extractThreadIdFromValue(result) ?? params.threadId,
    };
  }

  async interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    await this.ensureInitialized();

    await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/resume"],
      payloads: buildThreadResumePayloads({
        threadId: params.threadId,
      }),
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    }).catch(() => undefined);

    try {
      const payload: CodexTurnInterruptParams = {
        threadId: params.threadId,
        turnId: params.turnId,
      };
      const result = await requestWithFallbacks({
        client: this.connection,
        methods: ["turn/interrupt"],
        payloads: [payload],
        timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      });

      return {
        threadId: extractThreadIdFromValue(result) ?? params.threadId,
        turnId: extractTurnIdFromValue(result) ?? params.turnId,
      };
    } catch (error) {
      if (!isRequestTimeoutError(error, "turn/interrupt")) {
        throw error;
      }

      codexClientLog.warn(
        "turn/interrupt timed out; waiting for later status updates",
        {
          threadId: params.threadId,
          turnId: params.turnId,
        }
      );

      return {
        threadId: params.threadId,
        turnId: params.turnId,
      };
    }
  }

  async compactThread(params: {
    threadId: string;
  }): Promise<{ threadId: string; turnId: string; itemId?: string }> {
    await this.ensureInitialized();

    await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/resume"],
      payloads: buildThreadResumePayloads({
        threadId: params.threadId,
      }),
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    }).catch(() => undefined);

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/compact/start"],
      payloads: [
        {
          threadId: params.threadId,
        },
      ],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    const threadId = extractThreadIdFromValue(result) ?? params.threadId;
    const turnId = extractTurnIdFromValue(result) ?? `compact:${threadId}`;
    return {
      threadId,
      turnId,
      itemId: extractStringProperty(result, "itemId", "item_id"),
    };
  }

  async steerTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    await this.ensureInitialized();

    await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/resume"],
      payloads: buildThreadResumePayloads({
        threadId: params.threadId,
      }),
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    }).catch(() => undefined);

    const payload: CodexTurnSteerParams = {
      threadId: params.threadId,
      input: params.input.map(toCodexUserInput),
      expectedTurnId: params.expectedTurnId,
    };
    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["turn/steer"],
      payloads: [payload],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    return {
      threadId: params.threadId,
      turnId: extractTurnIdFromValue(result) ?? params.expectedTurnId,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Bootstrap gate: when the deferred predicate is set and active,
    // refuse to spawn the Codex CLI subprocess at all. This is the
    // architectural choke point that lets `describeCodexBackend`
    // return a clean "deferred" placeholder for both (a) a fresh
    // PwrAgent profile mid-wizard and (b) a machine where the
    // operator hasn't yet confirmed they have a Codex CLI installed
    // (e.g. Linux without `codex` on PATH).
    if (this.options.isCodexBootstrapDeferred?.()) {
      throw new CodexBootstrapDeferredError();
    }

    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = (async () => {
      await this.connection.connect();

      try {
        const initializeParams: CodexInitializeParams = {
          clientInfo: {
            name: "pwragent-desktop",
            title: "PwrAgent",
            version: this.options.clientVersion ?? "0.0.0",
          },
          capabilities: { experimentalApi: true }
        };
        const result = await this.connection.request("initialize", initializeParams);
        this.initializeResult = (asRecord(result) ?? {}) as InitializeResult;
      } catch (error) {
        if (!isAlreadyInitializedError(error)) {
          throw error;
        }
      }

      await this.connection.notify("initialized", {});
      this.initialized = true;
    })();

    try {
      await this.initializationPromise;
    } finally {
      if (!this.initialized) {
        this.initializationPromise = null;
      }
    }
  }
}
