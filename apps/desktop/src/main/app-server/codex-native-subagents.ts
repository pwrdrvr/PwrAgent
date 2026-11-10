import { codexNativeSubAgentName, readCodexNativeSubAgentName } from "@pwragent/shared";
import {
  isCodexNativeSubAgentVisibleInNavigation,
  shortenDerivedThreadTitle,
  shortSubAgentThreadId,
  type AppServerNotification,
  type AppServerThreadCommandDetail,
  type AppServerThreadSummary,
  type CodexNativeSubAgentSummary,
  type ThreadSubAgentSummary,
} from "@pwragent/shared";
import { subAgentActivityToolCall } from "../codex-app-server/subagent-activity";
import {
  type CodexNativeSubAgentCall,
  type CodexNativeSubAgentNotification,
  type CodexNativeSubAgentTool,
} from "./backend-registry-types";
import {
  readOptionalString,
  readRecord,
} from "./backend-registry-notification-values";


/**
 * The lifecycle tool a replayed transcript row stands for, the same mapping
 * `subAgentActivityToolCall` applies to a live report: a finish is observed
 * like a wait, an interrupt ends the worker like a close.
 */
export function codexNativeToolForOperation(
  operation: NonNullable<AppServerThreadCommandDetail["subAgent"]>["operation"],
): CodexNativeSubAgentTool {
  switch (operation) {
    case "close":
    case "interrupt":
      return "closeAgent";
    case "wait":
    case "complete":
      return "wait";
    case "send_input":
      return "sendInput";
    case "resume":
      return "resumeAgent";
    default:
      return "spawnAgent";
  }
}

export const CODEX_NATIVE_SUBAGENT_TOOLS = new Set<CodexNativeSubAgentTool>([
  "spawnAgent",
  "sendInput",
  "resumeAgent",
  "wait",
  "closeAgent",
]);

export const CODEX_NATIVE_SUBAGENT_INITIAL_STATUS_DELAY_MS = 10_000;
export const CODEX_NATIVE_SUBAGENT_ACTIVITY_STATUS_DELAY_MS = 2_000;
export const CODEX_NATIVE_SUBAGENT_MAX_RECONCILE_ATTEMPTS = 30;
export const CODEX_NATIVE_SUBAGENT_MAX_RECONCILE_AGE_MS = 30 * 60 * 1000;
export const CODEX_NATIVE_SUBAGENT_FINAL_READ_LIMIT = 12;

export function isCodexNativeSubAgentTool(tool: string): tool is CodexNativeSubAgentTool {
  return CODEX_NATIVE_SUBAGENT_TOOLS.has(tool as CodexNativeSubAgentTool);
}

export const CODEX_NATIVE_MONITOR_ID_PREFIX = "codex-native:";

export function codexNativeSubAgentId(threadId: string): string {
  return `${CODEX_NATIVE_MONITOR_ID_PREFIX}${threadId}`;
}

/**
 * Projects native Codex worker threads into a one-level disclosure owned by
 * their nearest ordinary thread. Nested workers are deliberately flattened:
 * the UI only supports one nesting level, but a worker still immediately
 * follows the worker that spawned it.
 */
export function groupCodexNativeSubAgents(params: {
  nativeThreads: AppServerThreadSummary[];
  now: number;
  parentThreads: AppServerThreadSummary[];
}): AppServerThreadSummary[] {
  const childrenByParentThreadId = new Map<string, AppServerThreadSummary[]>();

  for (const thread of params.nativeThreads) {
    const provenance = thread.codexNativeSubAgent;
    const parentThreadId = provenance?.parentThreadId.trim();
    if (
      thread.source !== "codex"
      || !parentThreadId
      || parentThreadId === thread.id
    ) {
      continue;
    }
    const children = childrenByParentThreadId.get(parentThreadId) ?? [];
    children.push(thread);
    childrenByParentThreadId.set(parentThreadId, children);
  }

  const sortNativeThreads = (
    left: AppServerThreadSummary,
    right: AppServerThreadSummary,
  ): number =>
    (left.createdAt ?? 0) - (right.createdAt ?? 0)
    || (left.updatedAt ?? 0) - (right.updatedAt ?? 0)
    || left.id.localeCompare(right.id);
  for (const children of childrenByParentThreadId.values()) {
    children.sort(sortNativeThreads);
  }

  return params.parentThreads.map((parent) => {
    const nativeSubAgents: CodexNativeSubAgentSummary[] = [];
    const emittedThreadIds = new Set<string>();

    const appendChildren = (parentThreadId: string, inferredDepth: number): void => {
      for (const child of childrenByParentThreadId.get(parentThreadId) ?? []) {
        if (emittedThreadIds.has(child.id)) {
          continue;
        }
        emittedThreadIds.add(child.id);
        const provenance = child.codexNativeSubAgent;
        const summary: CodexNativeSubAgentSummary = {
          threadId: child.id,
          title: child.title,
          createdAt: child.createdAt,
          updatedAt: child.updatedAt,
          threadStatus: child.threadStatus,
          depth: provenance?.depth ?? inferredDepth,
          agentNickname: provenance ? codexNativeSubAgentName(provenance) : undefined,
          agentRole: provenance?.agentRole,
        };
        if (isCodexNativeSubAgentVisibleInNavigation(summary, params.now)) {
          nativeSubAgents.push(summary);
        }
        appendChildren(child.id, inferredDepth + 1);
      }
    };

    appendChildren(parent.id, 1);
    return nativeSubAgents.length > 0
      ? { ...parent, codexNativeSubAgents: nativeSubAgents }
      : parent;
  });
}

export function shortCodexNativeAgentId(threadId: string): string {
  return shortSubAgentThreadId(threadId);
}

export function truncateSubAgentText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function normalizeCodexItemType(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.replace(/[^a-z0-9]/gi, "").toLowerCase()
    : undefined;
}

export function readStringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

export function readStringArrayLike(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string[] {
  if (!record) {
    return [];
  }
  for (const key of keys) {
    const values = readStringArrayValue(record[key]);
    if (values.length > 0) {
      return values;
    }
  }
  return [];
}

export function normalizeCodexNativeAgentName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim().replace(/^@+/, "");
  return normalized ? truncateSubAgentText(normalized, 80) : undefined;
}

export function extractCodexNativeSpawnedAgentNames(text: string): string[] {
  const names: string[] = [];
  const patterns = [
    /Spawned\s+sub-agent\s+(?:`([^`]+)`|@?([A-Za-z][A-Za-z0-9_.-]{0,79}))/gi,
    /\b(?:child|sub[- ]agent)\s+(?:is\s+)?running\s+as\s+(?:`([^`]+)`|@?([A-Za-z][A-Za-z0-9_.-]{0,79}))/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = normalizeCodexNativeAgentName(match[1] ?? match[2]);
      if (name) {
        names.push(name);
      }
    }
  }
  return names;
}

export function codexNativeNotificationMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return truncateSubAgentText(value, 360);
  }
  const record = readRecord(value);
  return record
    ? truncateSubAgentText(
        readOptionalString(record, ["message", "summary", "output", "text"]) ?? "",
        360,
      ) || undefined
    : undefined;
}

export function codexNativeNotificationStatus(
  value: unknown,
): { message?: string; status?: ThreadSubAgentSummary["status"] } {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["completed", "complete", "success", "succeeded"].includes(normalized)) {
      return { status: "success" };
    }
    if (["failed", "failure", "errored", "error"].includes(normalized)) {
      return { status: "failure" };
    }
    if (["cancelled", "canceled", "interrupted"].includes(normalized)) {
      return { status: "cancelled" };
    }
    if (["running", "active", "in_progress", "inprogress"].includes(normalized)) {
      return { status: "running" };
    }
    return {};
  }

  const record = readRecord(value);
  if (!record) {
    return {};
  }
  for (const [key, status] of [
    ["completed", "success"],
    ["complete", "success"],
    ["success", "success"],
    ["succeeded", "success"],
    ["failed", "failure"],
    ["failure", "failure"],
    ["errored", "failure"],
    ["error", "failure"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["interrupted", "cancelled"],
    ["running", "running"],
    ["active", "running"],
  ] as const) {
    if (record[key] !== undefined) {
      return {
        message: codexNativeNotificationMessage(record[key]),
        status,
      };
    }
  }
  return codexNativeNotificationStatus(
    readOptionalString(record, ["status", "state"]) ?? undefined,
  );
}

export function extractCodexNativeSubAgentNotifications(
  text: string,
): CodexNativeSubAgentNotification[] {
  const notifications: CodexNativeSubAgentNotification[] = [];
  const pattern = /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/gi;
  for (const match of text.matchAll(pattern)) {
    const rawJson = match[1]?.trim();
    if (!rawJson) {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawJson);
    } catch {
      continue;
    }
    const record = readRecord(payload);
    if (!record) {
      continue;
    }
    const receiverThreadId = readOptionalString(record, [
      "agent_path",
      "agentPath",
      "threadId",
      "thread_id",
      "receiverThreadId",
      "receiver_thread_id",
    ]);
    if (!receiverThreadId) {
      continue;
    }
    const parsedStatus = codexNativeNotificationStatus(record.status);
    if (!parsedStatus.status) {
      continue;
    }
    notifications.push({
      receiverThreadId,
      status: parsedStatus.status,
      ...(parsedStatus.message ? { lastMessage: parsedStatus.message } : {}),
    });
  }
  return notifications;
}

/**
 * `pathName || nickname` from any of the records, then a `name` field, which
 * on a receiver thread is its title.
 */
export function readCodexNativeAgentName(
  ...records: Array<Record<string, unknown> | undefined>
): string | undefined {
  return (
    normalizeCodexNativeAgentName(readCodexNativeSubAgentName(...records))
    ?? records
      .map((record) => normalizeCodexNativeAgentName(record?.name))
      .find(Boolean)
  );
}

export function readCodexNativeReceiverThreadNames(
  item: Record<string, unknown>,
): Map<string, string> {
  const names = new Map<string, string>();

  const recordName = (threadId: string | undefined, name: string | undefined) => {
    if (threadId && name) {
      names.set(threadId, name);
    }
  };

  const receiverThreads = Array.isArray(item.receiverThreads)
    ? item.receiverThreads
    : Array.isArray(item.receiver_threads)
      ? item.receiver_threads
      : [];
  for (const receiverThread of receiverThreads) {
    const receiver = readRecord(receiverThread);
    if (!receiver) {
      continue;
    }
    const threadId = readOptionalString(receiver, [
      "threadId",
      "thread_id",
      "id",
    ]);
    const thread = readRecord(receiver.thread) ?? receiver;
    recordName(threadId, readCodexNativeAgentName(thread, receiver));
  }

  const states = readRecord(item.agentsStates) ?? readRecord(item.agents_states);
  for (const [threadId, state] of Object.entries(states ?? {})) {
    const stateRecord = readRecord(state);
    recordName(threadId, readCodexNativeAgentName(stateRecord));
  }

  return names;
}

export function readCodexNativeSubAgentCalls(
  notification: AppServerNotification,
): CodexNativeSubAgentCall[] {
  const params = readRecord(notification.params);
  const candidates: Record<string, unknown>[] = [];
  const item = readRecord(params?.item);
  if (item) {
    candidates.push(item);
  }
  const turn = readRecord(params?.turn);
  const notificationTurnId =
    readOptionalString(params, ["turnId", "turn_id"]) ??
    readOptionalString(turn, ["id", "turnId", "turn_id"]);
  const turnItems = Array.isArray(turn?.items) ? turn.items : [];
  for (const turnItem of turnItems) {
    const record = readRecord(turnItem);
    if (record) {
      candidates.push(record);
    }
  }
  const paramItems = Array.isArray(params?.items) ? params.items : [];
  for (const paramItem of paramItems) {
    const record = readRecord(paramItem);
    if (record) {
      candidates.push(record);
    }
  }

  return candidates.flatMap((rawCandidate) => {
    // Interaction reports are message delivery, not worker lifecycle changes.
    // Persist only start/stop boundaries; child status reconciliation owns progress.
    if (rawCandidate.type === "subAgentActivity" && rawCandidate.kind === "interacted") {
      return [];
    }
    const activity = subAgentActivityToolCall(rawCandidate);
    const candidate = activity ?? rawCandidate;
    if (normalizeCodexItemType(candidate.type) !== "collabagenttoolcall") {
      return [];
    }
    const tool = readOptionalString(candidate, ["tool"]) ?? "collabAgent";
    return [
      {
        item: candidate,
        ...(activity ? { activityBoundary: true } : {}),
        itemId: readOptionalString(candidate, ["id", "itemId", "item_id"]),
        parentTurnId:
          readOptionalString(candidate, ["turnId", "turn_id"]) ??
          notificationTurnId,
        receiverThreadIds: readStringArrayLike(candidate, [
          "receiverThreadIds",
          "receiver_thread_ids",
          "receivers",
        ]),
        receiverThreadNames: readCodexNativeReceiverThreadNames(candidate),
        tool,
      },
    ];
  });
}

export function readCodexNativeAgentState(
  item: Record<string, unknown>,
  threadId: string,
): { message?: string; status?: string } {
  const states = readRecord(item.agentsStates) ?? readRecord(item.agents_states);
  const state = states?.[threadId];
  if (typeof state === "string") {
    return { status: state };
  }
  const record = readRecord(state);
  if (!record) {
    return {};
  }
  return {
    message: readOptionalString(record, ["message", "output", "summary"]),
    status: readOptionalString(record, ["status", "state"]),
  };
}

export function mapCodexNativeSubAgentStatus(params: {
  agentState?: string;
  itemStatus?: string;
  tool: string;
}): ThreadSubAgentSummary["status"] {
  const itemStatus = params.itemStatus?.toLowerCase();
  const agentState = params.agentState?.toLowerCase();
  if (itemStatus === "failed") {
    return "failure";
  }
  if (agentState) {
    if (["completed", "complete", "success", "succeeded"].includes(agentState)) {
      return "success";
    }
    if (["failed", "failure", "errored", "error"].includes(agentState)) {
      return "failure";
    }
    if (["cancelled", "canceled", "interrupted"].includes(agentState)) {
      return "cancelled";
    }
    if (["blocked", "pendingapproval", "pendingapprovalrequest"].includes(agentState)) {
      return "blocked";
    }
    if (["pendinginit", "pending", "running", "inprogress", "active"].includes(agentState)) {
      return "running";
    }
    if (agentState === "shutdown") {
      return params.tool === "closeAgent" ? "cancelled" : "success";
    }
    if (agentState === "notfound") {
      return "failure";
    }
  }
  if (itemStatus === "in_progress" || itemStatus === "running") {
    return "running";
  }
  if (params.tool === "closeAgent" && itemStatus === "completed") {
    return "cancelled";
  }
  if (params.tool === "spawnAgent" && itemStatus === "completed") {
    return "running";
  }
  if (itemStatus === "completed" && params.tool === "wait") {
    return "success";
  }
  return "running";
}

export function codexNativeSubAgentOutcome(
  status: ThreadSubAgentSummary["status"],
): ThreadSubAgentSummary["outcome"] | undefined {
  if (status === "success") {
    return "success";
  }
  if (status === "failure") {
    return "failure";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return undefined;
}

/** The thread list's tray row for a stored native sub-agent card. */
export function nativeSubAgentRowFromCard(card: ThreadSubAgentSummary, threadId: string): CodexNativeSubAgentSummary {
  return {
    threadId,
    title: card.task,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    threadStatus: codexNativeSubAgentIsTerminal(card.status) ? "idle" : "active",
    ...(card.agentName ? { agentNickname: card.agentName } : {}),
  };
}

export function codexNativeSubAgentIsTerminal(status: ThreadSubAgentSummary["status"]): boolean {
  return status === "success" || status === "failure" || status === "cancelled";
}

export function reliableSubAgentCompletionBoundary(
  subAgent: ThreadSubAgentSummary,
): number {
  return Number.isFinite(subAgent.updatedAt)
    && subAgent.updatedAt >= subAgent.createdAt
    ? subAgent.updatedAt
    : subAgent.createdAt;
}

export function codexNativeSubAgentNextReconciliationDelayMs(attempts: number): number {
  if (attempts <= 1) {
    return 15_000;
  }
  if (attempts <= 3) {
    return 30_000;
  }
  return 60_000;
}

export function codexNativeSubAgentTask(params: {
  prompt?: string;
  threadId: string;
}): string {
  const promptTitle = params.prompt
    ? shortenDerivedThreadTitle(params.prompt) ?? params.prompt
    : undefined;
  return promptTitle
    ? truncateSubAgentText(promptTitle, 120)
    : codexNativeSubAgentPlaceholderTask(params.threadId);
}

/**
 * What a worker is called before anything better is known. A path-based
 * worker reports no prompt, so every card starts here; discovery replaces it
 * with the worker thread's title.
 */
export function codexNativeSubAgentPlaceholderTask(threadId: string): string {
  return `Codex sub-agent ${shortCodexNativeAgentId(threadId)}`;
}

export function isCodexNativeSubAgentPlaceholderTask(
  task: string,
  threadId: string,
): boolean {
  return (
    task === codexNativeSubAgentPlaceholderTask(threadId)
    // Cards persisted before the placeholder took the id's random tail.
    || task === `Codex subagent ${threadId.slice(0, 8)}`
  );
}
