import path from "node:path";
import {
  shortenDerivedThreadTitle,
} from "@pwragnt/shared";
import type {
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadActivityStatus,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessagePart,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerThreadPlanStep,
  AppServerThreadPlanStepStatus,
  AppServerThreadTurnMetadata,
  AppServerThreadTurnStatus,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadReplayPagination,
  AppServerThreadTitleSource,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  AppServerCollaborationModeRequest,
  BackendModelOption,
  LinkedDirectorySummary,
} from "@pwragnt/shared";
import { getMainLogger } from "../log";
import type {
  ClientRequest as CodexClientRequest,
  CollaborationMode as CodexCollaborationMode,
  InitializeParams as CodexInitializeParams,
  ReasoningEffort as CodexReasoningEffort,
  ServerNotification as CodexServerNotification,
  ServerRequest as CodexServerRequest,
  ServiceTier as CodexServiceTier,
} from "@pwragnt/shared/codex-app-server-protocol";
import type {
  AskForApproval as CodexAskForApproval,
  ModelListParams as CodexModelListParams,
  SandboxMode as CodexSandboxMode,
  SkillsListParams as CodexSkillsListParams,
  ThreadListParams as CodexThreadListParams,
  ThreadReadParams as CodexThreadReadParams,
  ThreadResumeParams as CodexThreadResumeParams,
  ThreadStartParams as CodexThreadStartParams,
  TurnInterruptParams as CodexTurnInterruptParams,
  TurnStartParams as CodexTurnStartParams,
  UserInput as CodexUserInput,
} from "@pwragnt/shared/codex-app-server-protocol/v2";
import {
  JsonRpcConnection,
  type JsonRpcId,
  type JsonRpcObserver,
} from "./json-rpc";
import {
  createThreadDirectoryEnricher,
  type ThreadDirectoryEnrichment,
} from "./thread-directory-enricher";
import { StdioJsonRpcTransport } from "./stdio-transport";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CODEX_COLLABORATION_MODEL = "gpt-5.5";
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
};

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

type SkillCatalogEntry = {
  cwd?: string;
  skills: AppServerSkillSummary[];
};

type CodexClientRequestMethod = CodexClientRequest["method"];
type CodexServerNotificationMethod = CodexServerNotification["method"];
type CodexServerRequestMethod = CodexServerRequest["method"];

const KNOWN_NOTIFICATION_METHODS = new Set<string>([
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
  "thread/compacted",
  "thread/archived",
  "thread/unarchived",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/requestApproval",
  "review/requestApproval",
  "account/rateLimits/updated",
  "item/commandExecution/outputDelta",
  "mcpServer/startupStatus/updated",
]);
const GENERATED_CODEX_NOTIFICATION_METHODS = new Set<CodexServerNotificationMethod>([
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
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
  "item/commandExecution/outputDelta",
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
const codexClientLog = getMainLogger("pwragnt:codex-client");

function isApprovalLikeMethod(method: string): boolean {
  return method.endsWith("/requestApproval");
}

function isHandledServerRequestMethod(method: string): boolean {
  return isApprovalLikeMethod(method) || method === "item/tool/requestUserInput";
}

function isKnownCodexNotificationMethod(
  method: string
): method is CodexServerNotificationMethod {
  return GENERATED_CODEX_NOTIFICATION_METHODS.has(
    method as CodexServerNotificationMethod
  );
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
      pickString(record, ["requestId", "request_id", "serverRequestId"]) ??
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

  return {
    method: method as AppServerNotification["method"],
    params: {
      ...record,
      ...(normalizedItem ? { item: normalizedItem } : {}),
      ...(metadata.threadId ? { threadId: metadata.threadId } : {}),
      ...(metadata.turnId ? { turnId: metadata.turnId } : {}),
      ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
    } as AppServerNotification["params"],
  } as AppServerNotification;
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

function getThreadTitleInfo(record: Record<string, unknown>): {
  title: string;
  titleSource: AppServerThreadTitleSource;
} {
  const sessionRecord = asRecord(record.session);
  const explicitTitle =
    pickString(record, ["title", "name", "headline"]) ??
    pickString(sessionRecord ?? {}, ["title", "name", "headline"]);

  if (explicitTitle) {
    return {
      title: explicitTitle,
      titleSource: "explicit",
    };
  }

  const derivedTitle =
    pickString(record, ["preview", "snippet", "firstUserMessage", "first_user_message"]) ??
    pickString(sessionRecord ?? {}, [
      "preview",
      "snippet",
      "firstUserMessage",
      "first_user_message",
    ]);

  if (derivedTitle) {
    return {
      title: shortenDerivedThreadTitle(derivedTitle) ?? derivedTitle,
      titleSource: "derived",
    };
  }

  return {
    title: "Untitled thread",
    titleSource: "fallback",
  };
}

async function resolveThreadProjectKey(
  thread: RawCodexThreadSummary
): Promise<string | undefined> {
  const projectKey = thread.projectKey?.trim();
  return projectKey || undefined;
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

function extractConversationMessages(
  value: unknown
): AppServerThreadReplay["messages"] {
  const output: AppServerThreadReplay["messages"] = [];

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
    const content = buildMessageContent(record);
    if (role && (content.text || content.parts?.length)) {
      output.push({
        id:
          pickString(record, ["id", "messageId", "message_id", "itemId", "item_id"]) ??
          `message-${output.length + 1}`,
        role,
        text: content.text,
        ...(content.parts ? { parts: content.parts } : {}),
        createdAt: normalizeEpochTimestamp(
          pickNumber(record, ["createdAt", "created_at", "timestamp", "time"])
        )
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

function formatActivitySummary(parts: string[]): string {
  return parts.join(", ");
}

function normalizeItemType(value: string | undefined): string | undefined {
  return value?.replace(/[-_\s]/g, "").toLowerCase();
}

function isActivityItemType(itemType: string | undefined): boolean {
  const normalized = normalizeItemType(itemType);
  return (
    normalized === "commandexecution" ||
    normalized === "filechange" ||
    normalized === "mcptoolcall" ||
    normalized === "dynamictoolcall" ||
    normalized === "websearch" ||
    normalized === "imageview" ||
    normalized === "imagegeneration"
  );
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
  let toolCalls = 0;
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
          label: formatCommandLabel(command),
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
            label: `Read ${path.basename(actionPath) || actionPath}`,
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
            label: `Searched ${path.basename(actionPath) || actionPath}`,
            path: actionPath,
            status: itemStatus
          });
          continue;
        }

        commandsRun += 1;
        const label =
          actionType === "listFiles"
            ? "Listed files"
            : actionType === "search"
              ? "Ran search"
              : fallbackName?.trim() || formatCommandLabel(command);
        pushActivityDetail(details, {
          id: detailId,
          kind: "command",
          label,
          ...(actionPath ? { path: actionPath } : {}),
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
        const diff = extractDiffText(change);
        const diffSummary = diff ? summarizeDiff(diff) : undefined;
        changedFiles += 1;
        pushActivityDetail(details, {
          id: `${itemId}-${index + 1}`,
          kind: "write",
          label: `${changeType[0]?.toUpperCase() ?? "U"}${changeType.slice(1)} ${
            changePath ? path.basename(changePath) || changePath : "file"
          }`,
          path: changePath,
          status: itemStatus,
          ...(diff && diffSummary
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
        label: [toolName ?? "Used tool", query ? `: ${query}` : ""].join(""),
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
    summaryParts.push(`Edited ${changedFiles} file${changedFiles === 1 ? "" : "s"}`);
  }
  if (toolCalls > 0) {
    summaryParts.push(`Used ${toolCalls} tool${toolCalls === 1 ? "" : "s"}`);
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

      if (isActivityItemType(itemType)) {
        pendingActivityItems.push(item);
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

  return {
    entries,
    messages,
    lastUserMessage,
    lastAssistantMessage,
    pagination: extractReplayPagination(value)
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

function buildThreadDiscoveryPayloads(
  filter?: string,
  archived?: boolean
): CodexThreadListParams[] {
  const searchTerm = filter?.trim() || undefined;
  const baseParams: CodexThreadListParams = {
    archived,
    limit: 50,
    sortKey: "updated_at",
    sourceKinds: ["cli", "vscode"],
  };

  return [
    {
      ...baseParams,
      searchTerm,
    },
    {
      ...baseParams,
    },
    {}
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

function resolveDisplayGitBranch(params: {
  gitBranch?: string;
  observedGitBranch?: string;
}): string | undefined {
  if (params.observedGitBranch === "HEAD") {
    return "HEAD";
  }

  return params.gitBranch ?? params.observedGitBranch;
}

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
    persistExtendedHistory: false
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

function buildCollaborationModePayload(params: {
  collaborationMode?: AppServerCollaborationModeRequest;
  fallbackModel?: string;
  fallbackReasoningEffort?: string;
}): CodexCollaborationMode | undefined {
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
  const developerInstructions = Object.hasOwn(settings, "developerInstructions")
    ? settings.developerInstructions
    : params.collaborationMode.mode === "plan"
      ? null
      : undefined;

  return {
    mode: params.collaborationMode.mode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: developerInstructions ?? null,
    },
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
  model?: string;
  reasoningEffort?: string;
  collaborationMode?: AppServerCollaborationModeRequest;
  collaborationFallbackModel?: string;
  collaborationFallbackReasoningEffort?: string;
}): CodexTurnStartParams {
  const base: CodexTurnStartParams = {
    threadId: params.threadId,
    input: params.input.map(toCodexUserInput),
  };

  if (params.model?.trim()) {
    base.model = params.model.trim();
  }

  const reasoningEffort = normalizeCodexReasoningEffort(params.reasoningEffort);
  if (reasoningEffort) {
    base.effort = reasoningEffort;
  }

  const collaborationMode = buildCollaborationModePayload({
    collaborationMode: params.collaborationMode,
    fallbackModel: params.collaborationFallbackModel ?? params.model,
    fallbackReasoningEffort:
      params.collaborationFallbackReasoningEffort ?? params.reasoningEffort,
  });
  if (collaborationMode) {
    base.collaborationMode = collaborationMode;
  }

  return base;
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
  methods: Array<CodexClientRequestMethod | (string & {})>;
  payloads: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  let lastError: unknown;

  for (const method of params.methods) {
    for (const payload of params.payloads) {
      try {
        return await params.client.request(method, payload, params.timeoutMs);
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

export class CodexAppServerClient {
  private readonly connection: JsonRpcConnection;
  private readonly threadDirectoryEnricher: (
    projectKey?: string
  ) => Promise<ThreadDirectoryEnrichment>;
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private initializeResult: InitializeResult | null = null;
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  private readonly requestListeners = new Set<
    (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  >();

  constructor(private readonly options: CodexClientOptions = {}) {
    this.connection = new JsonRpcConnection(
      new StdioJsonRpcTransport({
        command: options.command?.trim() || "codex",
        args: options.args ?? [],
        env: options.env
      }),
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.connectionObserver
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

      for (const listener of this.notificationListeners) {
        const wireNotification = isKnownCodexMethod
          ? ({
              method,
              params: params ?? {},
            } as CodexServerNotification)
          : undefined;
        await listener(
          normalizeServerNotification(
            wireNotification?.method ?? method,
            wireNotification?.params ?? params,
          )
        );
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

  async listThreads(params?: {
    archived?: boolean;
    filter?: string;
  }): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();

    const requestParams = {
      client: this.connection,
      methods: ["thread/list"] as CodexClientRequestMethod[],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    };
    if (params?.archived === true) {
      const archivedResult = await requestWithFallbacks({
        ...requestParams,
        payloads: buildThreadDiscoveryPayloads(params?.filter, true),
      });
      return await this.enrichThreads(extractThreadsFromValue(archivedResult));
    }

    const [activeResult, archivedResult] = await Promise.all([
      requestWithFallbacks({
        ...requestParams,
        payloads: buildThreadDiscoveryPayloads(params?.filter, false),
      }),
      requestWithFallbacks({
        ...requestParams,
        payloads: buildThreadDiscoveryPayloads(params?.filter, true),
      }).catch(() => undefined),
    ]);
    const threads = mergeArchivedThreadMetadata({
      activeThreads: extractThreadsFromValue(activeResult),
      archivedThreads: extractThreadsFromValue(archivedResult),
    });

    return await this.enrichThreads(threads);
  }

  private async enrichThreads(
    threads: RawCodexThreadSummary[],
  ): Promise<AppServerThreadSummary[]> {
    const enrichedThreads = await Promise.all(
      threads.map(async (thread) => {
        const projectKey = await resolveThreadProjectKey(thread);
        const enrichment = await this.threadDirectoryEnricher(projectKey);
        return {
          ...thread,
          projectKey,
          gitBranch: resolveDisplayGitBranch({
            gitBranch: thread.gitBranch,
            observedGitBranch: enrichment.observedGitBranch,
          }),
          linkedDirectories: enrichment.linkedDirectories,
          observedGitBranch: enrichment.observedGitBranch,
          source: "codex" as const
        };
      })
    );

    return hydrateMissingLinkedDirectoriesFromSiblingRepos(enrichedThreads);
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

  async listModels(): Promise<BackendModelOption[]> {
    await this.ensureInitialized();

    const payload: CodexModelListParams = {};
    const result = await requestWithFallbacks({
      client: this.connection,
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
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
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

    return { threadId };
  }

  async startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; turnId: string }> {
    await this.ensureInitialized();

    const resumeResult = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/resume"],
      payloads: buildThreadResumePayloads({
        threadId: params.threadId,
        model: params.model,
        serviceTier: params.serviceTier,
        reasoningEffort: params.reasoningEffort,
        fastMode: params.fastMode
      }),
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    }).catch(() => undefined);

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["turn/start"],
      payloads: [
        buildTurnStartPayload({
          threadId: params.threadId,
          input: params.input,
          model: params.model,
          reasoningEffort: params.reasoningEffort,
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

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/name/set"],
      payloads: [{ threadId: params.threadId, name: params.name }],
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

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = (async () => {
      await this.connection.connect();

      try {
        const initializeParams: CodexInitializeParams = {
          clientInfo: { name: "pwragnt-desktop", title: "PwrAgnt", version: "0.1.0" },
          capabilities: { experimentalApi: false }
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
