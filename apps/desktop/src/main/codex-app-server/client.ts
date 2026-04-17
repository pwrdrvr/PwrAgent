import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppServerNotification,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadActivityStatus,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
  AppServerSkillSummary,
  AppServerThreadReplay,
  AppServerThreadReplayPagination,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  LinkedDirectorySummary
} from "@pwragnt/shared";
import { JsonRpcConnection } from "./json-rpc";
import { StdioJsonRpcTransport } from "./stdio-transport";

const DEFAULT_PROTOCOL_VERSION = "1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const execFile = promisify(execFileCallback);

type CodexClientOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  directoryResolver?: (
    projectKey?: string
  ) => Promise<LinkedDirectorySummary[]>;
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
};

type SkillCatalogEntry = {
  cwd?: string;
  skills: AppServerSkillSummary[];
};

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

function collectMessageText(record: Record<string, unknown>): string {
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
    const text = collectMessageText(record);
    if (role && text) {
      output.push({
        id:
          pickString(record, ["id", "messageId", "message_id", "itemId", "item_id"]) ??
          `message-${output.length + 1}`,
        role,
        text,
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
        const text = collectMessageText(item);
        if (!text) {
          continue;
        }
        entries.push({
          type: "message",
          id:
            pickString(item, ["id", "messageId", "message_id", "itemId", "item_id"]) ??
            `message-${entries.length + 1}`,
          role,
          text,
          createdAt,
          ...(pickString(item, ["phase"]) === "commentary"
            ? { phase: "commentary" as const }
            : {})
        });
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

async function runGit(projectKey: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", projectKey, ...args], {
    env: process.env
  });
  return result.stdout.trim();
}

function parseGitWorktrees(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

function findContainingWorktree(
  currentPath: string,
  worktreePaths: string[]
): string | undefined {
  const matches = worktreePaths
    .map((worktreePath) => path.resolve(worktreePath))
    .filter(
      (worktreePath) =>
        currentPath === worktreePath || currentPath.startsWith(`${worktreePath}${path.sep}`)
    )
    .sort((left, right) => right.length - left.length);

  return matches[0];
}

async function resolveLinkedDirectories(
  projectKey?: string
): Promise<LinkedDirectorySummary[]> {
  if (!projectKey) {
    return [];
  }

  const normalizedPath = projectKey.trim();
  if (!normalizedPath) {
    return [];
  }

  try {
    const currentPath = path.resolve(normalizedPath);
    const repoRoot = await runGit(normalizedPath, ["rev-parse", "--show-toplevel"]);
    const worktreeList = await runGit(normalizedPath, ["worktree", "list", "--porcelain"]);
    const worktreePaths = parseGitWorktrees(worktreeList);
    const primaryPath = path.resolve(worktreePaths[0] || repoRoot);
    const currentWorktreePath = findContainingWorktree(currentPath, worktreePaths)
      ?? path.resolve(repoRoot);
    const isWorktree = currentWorktreePath !== primaryPath;

    return [
      {
        id: primaryPath,
        path: primaryPath,
        worktreePath: isWorktree ? currentWorktreePath : undefined,
        label: path.basename(primaryPath) || primaryPath,
        kind: isWorktree ? "worktree" : "local"
      }
    ];
  } catch {
    const fallbackPath = path.resolve(normalizedPath);
    return [
      {
        id: fallbackPath,
        path: fallbackPath,
        label: path.basename(fallbackPath) || fallbackPath,
        kind: "local"
      }
    ];
  }
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
    const projectKey =
      pickString(record, ["projectKey", "project_key", "cwd"]) ??
      pickString(sessionRecord ?? {}, ["cwd", "projectKey", "project_key"]);

    summaries.set(threadId, {
      id: threadId,
      title:
        pickString(record, ["title", "name", "headline"]) ??
        pickString(sessionRecord ?? {}, ["title", "name"]) ??
        "Untitled thread",
      summary: normalizeThreadSummary(
        pickString(record, ["summary", "preview", "snippet"]) ??
          pickString(sessionRecord ?? {}, ["summary", "preview", "snippet"])
      ),
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
        pickString(asRecord(record.gitInfo) ?? {}, ["branch"]) ??
        pickString(asRecord(record.git_info) ?? {}, ["branch"]) ??
        pickString(asRecord(sessionRecord?.gitInfo) ?? {}, ["branch"]) ??
        pickString(asRecord(sessionRecord?.git_info) ?? {}, ["branch"])
    });
  }

  return [...summaries.values()].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  );
}

function buildThreadDiscoveryPayloads(filter?: string): unknown[] {
  return [
    {
      query: filter?.trim() || undefined,
      limit: 100
    },
    {
      filter: filter?.trim() || undefined,
      limit: 100
    },
    {}
  ];
}

function buildThreadResumePayloads(params: {
  threadId: string;
  model?: string;
}): Array<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    threadId: params.threadId,
    persistExtendedHistory: false
  };

  if (params.model?.trim()) {
    base.model = params.model.trim();
  }

  return [base];
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
  private readonly directoryResolver: (
    projectKey?: string
  ) => Promise<LinkedDirectorySummary[]>;
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private initializeResult: InitializeResult | null = null;
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();

  constructor(private readonly options: CodexClientOptions = {}) {
    this.connection = new JsonRpcConnection(
      new StdioJsonRpcTransport({
        command: options.command?.trim() || "codex",
        args: options.args ?? [],
        env: options.env
      }),
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );
    this.directoryResolver = options.directoryResolver ?? resolveLinkedDirectories;
    this.connection.setNotificationHandler(async (method, params) => {
      for (const listener of this.notificationListeners) {
        await listener({
          method: method as AppServerNotification["method"],
          params: (params ?? {}) as AppServerNotification["params"],
        } as AppServerNotification);
      }
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

  async getInitializeResult(): Promise<InitializeResult> {
    await this.ensureInitialized();
    return this.initializeResult ?? {};
  }

  async listThreads(params?: { filter?: string }): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/list", "thread/loaded/list"],
      payloads: buildThreadDiscoveryPayloads(params?.filter),
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    });

    return await Promise.all(
      extractThreadsFromValue(result).map(async (thread) => ({
        ...thread,
        linkedDirectories: await this.directoryResolver(thread.projectKey),
        source: "codex"
      }))
    );
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

    const result = await requestWithFallbacks({
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
  }): Promise<{ threadId: string; runId: string }> {
    await this.ensureInitialized();

    await requestWithFallbacks({
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
      payloads: [params],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    const threadId = extractThreadIdFromValue(result) ?? params.threadId;
    const runId = extractRunIdFromValue(result) ?? `pending:${threadId}`;

    return { threadId, runId };
  }

  async interruptTurn(params: {
    threadId: string;
    runId: string;
  }): Promise<{ threadId: string; runId: string }> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["turn/interrupt"],
      payloads: [{ threadId: params.threadId, turnId: params.runId }],
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    const threadId = extractThreadIdFromValue(result);
    const runId = extractRunIdFromValue(result);
    if (!threadId || !runId) {
      throw new Error("codex app server turn/interrupt did not return threadId and runId");
    }

    return { threadId, runId };
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
