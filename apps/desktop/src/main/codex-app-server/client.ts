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
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadReplayPagination,
  AppServerThreadTitleSource,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  AppServerCollaborationModeRequest,
  LinkedDirectorySummary,
} from "@pwragnt/shared";
import { getMainLogger } from "../log";
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

const DEFAULT_PROTOCOL_VERSION = "1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CODEX_COLLABORATION_MODEL = "gpt-5.4";

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
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/requestApproval",
  "review/requestApproval",
  "account/rateLimits/updated",
  "item/commandExecution/outputDelta",
  "mcpServer/startupStatus/updated",
]);
const codexClientLog = getMainLogger("pwragnt:codex-client");

function isApprovalLikeMethod(method: string): boolean {
  return method.endsWith("/requestApproval");
}

function isHandledServerRequestMethod(method: string): boolean {
  return isApprovalLikeMethod(method) || method === "item/tool/requestUserInput";
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
  runId?: string;
  requestId?: string;
} {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  const turnRecord = asRecord(record.turn) ?? asRecord(record.run);

  return {
    threadId:
      pickString(record, ["threadId", "thread_id", "conversationId", "conversation_id"]) ??
      pickString(threadRecord ?? {}, ["id", "threadId", "thread_id", "conversationId"]),
    runId:
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
      ...(metadata.runId ? { runId: metadata.runId } : {}),
      requestId: metadata.requestId ?? String(rpcId ?? `${method}-request`),
    } as AppServerPendingRequestNotification["params"],
  };
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

function normalizePlanStepStatus(
  value: string | undefined
): AppServerThreadPlanStepStatus | undefined {
  const normalized = value?.trim().toLowerCase();
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
  createdAt?: number
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
      createdAt
    );
    if (nestedPlanEntry) {
      return nestedPlanEntry;
    }
  }

  return undefined;
}

function extractPlanEntryFromItem(
  item: Record<string, unknown>,
  createdAt?: number
): AppServerThreadPlanEntry | undefined {
  const itemType = pickString(item, ["type"]);
  const normalizedItemType = itemType?.trim().toLowerCase();
  const itemId =
    pickString(item, ["id", "itemId", "item_id", "call_id"]) ?? `plan-${createdAt ?? 0}`;
  const nestedPlanEntry = extractNestedPlanEntryFromItem(item, createdAt);
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

function summarizeActivityItems(
  items: Record<string, unknown>[],
  createdAt?: number
): AppServerThreadActivityEntry | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const details: AppServerThreadActivityDetail[] = [];
  let inspectedFiles = 0;
  let commandsRun = 0;
  let changedFiles = 0;
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
    if (itemType === "commandExecution") {
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

    if (itemType === "fileChange") {
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
    details
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
      const activity = summarizeActivityItems(pendingActivityItems, createdAt);
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
        entries.push({
          type: "message",
          id:
            pickString(item, ["id", "messageId", "message_id", "itemId", "item_id"]) ??
            `message-${entries.length + 1}`,
          role,
          text: content.text,
          ...(content.parts ? { parts: content.parts } : {}),
          createdAt,
          ...(pickString(item, ["phase"]) === "commentary"
            ? { phase: "commentary" as const }
            : {})
        });
        continue;
      }

      const planEntry = extractPlanEntryFromItem(item, createdAt);
      if (planEntry) {
        flushActivityItems();
        entries.push(planEntry);
        continue;
      }

      if (itemType === "commandExecution" || itemType === "fileChange") {
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

function extractRunIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const turnRecord = asRecord(record.turn) ?? asRecord(record.run);
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
): unknown[] {
  const searchTerm = filter?.trim() || undefined;
  const baseParams = {
    archived,
    limit: 50,
    sortKey: "updated_at",
    sourceKinds: ["cli", "vscode"],
  } as const;

  return [
    {
      ...baseParams,
      searchTerm,
    },
    {
      ...baseParams,
      query: searchTerm,
    },
    {
      ...baseParams,
      filter: searchTerm,
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

function buildThreadResumePayloads(params: {
  threadId: string;
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
}): Array<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    threadId: params.threadId,
    persistExtendedHistory: false
  };

  if (params.cwd?.trim()) {
    base.cwd = params.cwd.trim();
  }
  if (params.model?.trim()) {
    base.model = params.model.trim();
  }
  if (params.approvalPolicy?.trim()) {
    base.approvalPolicy = params.approvalPolicy.trim();
  }
  if (params.sandbox?.trim()) {
    base.sandbox = params.sandbox.trim();
  }
  if (params.serviceTier?.trim()) {
    base.serviceTier = params.serviceTier.trim();
  }
  if (params.reasoningEffort?.trim()) {
    base.reasoningEffort = params.reasoningEffort.trim();
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
}): Record<string, unknown> | undefined {
  if (!params.collaborationMode) {
    return undefined;
  }

  const settings = params.collaborationMode.settings ?? {};
  const model =
    settings.model?.trim() ||
    params.fallbackModel?.trim() ||
    DEFAULT_CODEX_COLLABORATION_MODEL;
  const reasoningEffort =
    settings.reasoningEffort?.trim() || params.fallbackReasoningEffort?.trim();
  const developerInstructions = Object.hasOwn(settings, "developerInstructions")
    ? settings.developerInstructions
    : params.collaborationMode.mode === "plan"
      ? null
      : undefined;

  return {
    mode: params.collaborationMode.mode,
    settings: {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(developerInstructions !== undefined
        ? { developerInstructions }
        : {}),
    },
  };
}

function buildTurnStartPayload(params: {
  threadId: string;
  input: AppServerTurnInputItem[];
  model?: string;
  collaborationMode?: AppServerCollaborationModeRequest;
  collaborationFallbackModel?: string;
  collaborationFallbackReasoningEffort?: string;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    threadId: params.threadId,
    input: params.input,
  };

  if (params.model?.trim()) {
    base.model = params.model.trim();
  }

  const collaborationMode = buildCollaborationModePayload({
    collaborationMode: params.collaborationMode,
    fallbackModel: params.collaborationFallbackModel ?? params.model,
    fallbackReasoningEffort: params.collaborationFallbackReasoningEffort,
  });
  if (collaborationMode) {
    base.collaborationMode = collaborationMode;
  }

  return base;
}

async function requestWithFallbacks(params: {
  client: JsonRpcConnection;
  methods: string[];
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
      if (!KNOWN_NOTIFICATION_METHODS.has(method)) {
        logUnhandledCodexMessage({
          kind: "notification",
          method,
          payload: params,
        });
      }

      for (const listener of this.notificationListeners) {
        await listener({
          method: method as AppServerNotification["method"],
          params: (params ?? {}) as AppServerNotification["params"],
        } as AppServerNotification);
      }
    });
    this.connection.setRequestHandler(async (method, params, rpcId) => {
      const request = normalizePendingRequestNotification(method, params, rpcId);

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

  async listThreads(params?: { filter?: string }): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();

    const requestParams = {
      client: this.connection,
      methods: ["thread/list", "thread/loaded/list"] as string[],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    };
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

    const enrichedThreads = await Promise.all(
      threads.map(async (thread) => {
        const projectKey = await resolveThreadProjectKey(thread);
        const enrichment = await this.threadDirectoryEnricher(projectKey);
        return {
          ...thread,
          projectKey,
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

    const cwds = [...new Set([...(params?.cwds ?? []), params?.cwd].filter(Boolean))];
    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["skills/list"],
      payloads: [{ cwds }],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    });

    return extractSkillCatalog(result);
  }

  async readThread(params: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerThreadReplay> {
    await this.ensureInitialized();

    let result: unknown;
    try {
      result = await requestWithFallbacks({
        client: this.connection,
        methods: ["thread/read"],
        payloads: [
          {
            threadId: params.threadId,
            includeTurns: true,
            before: params.before,
            limit: params.limit
          }
        ],
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
  }): Promise<{ threadId: string }> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/start", "thread/new"],
      payloads: [params],
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
  }): Promise<{ threadId: string; runId: string }> {
    await this.ensureInitialized();

    const resumeResult = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/resume"],
      payloads: buildThreadResumePayloads({
        threadId: params.threadId,
        model: params.model
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
    const runId = extractRunIdFromValue(result) ?? `pending:${threadId}`;

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

  async interruptTurn(params: {
    threadId: string;
    runId: string;
  }): Promise<{ threadId: string; runId: string }> {
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
      const result = await requestWithFallbacks({
        client: this.connection,
        methods: ["turn/interrupt"],
        payloads: [{ threadId: params.threadId, turnId: params.runId }],
        timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      });

      return {
        threadId: extractThreadIdFromValue(result) ?? params.threadId,
        runId: extractRunIdFromValue(result) ?? params.runId,
      };
    } catch (error) {
      if (!isRequestTimeoutError(error, "turn/interrupt")) {
        throw error;
      }

      codexClientLog.warn(
        "turn/interrupt timed out; waiting for later status updates",
        {
          threadId: params.threadId,
          runId: params.runId,
        }
      );

      return {
        threadId: params.threadId,
        runId: params.runId,
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
        const result = await this.connection.request("initialize", {
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          clientInfo: { name: "pwragnt-desktop", version: "0.1.0" },
          capabilities: { experimentalApi: true }
        });
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
