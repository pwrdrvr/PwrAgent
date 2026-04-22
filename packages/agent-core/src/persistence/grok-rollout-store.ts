import fs from "node:fs";
import path from "node:path";
import type {
  AppServerRole,
  AppServerTurnInputItem,
  ThreadReplayItem,
  ThreadState,
} from "../app-server/internal-contract.js";
import { parseFlatToml, stringifyFlatToml } from "../config/simple-toml.js";

export type StoredMessage = {
  role: AppServerRole;
  text: string;
  parts?: AppServerTurnInputItem[];
};

export type HydratedSessionState = {
  threads: ThreadState[];
  messagesByThread: Record<string, StoredMessage[]>;
  itemsByThread: Record<string, ThreadReplayItem[]>;
  responseIds: Record<string, string>;
  itemSequence: number;
  lastTimestamp: number;
};

export interface AppServerSessionStore {
  load(): HydratedSessionState;
  persistThread(params: {
    thread: ThreadState;
    previousResponseId?: string;
  }): void;
  archiveThread(params: {
    thread: ThreadState;
    previousResponseId?: string;
  }): void;
  unarchiveThread(params: {
    thread: ThreadState;
    previousResponseId?: string;
  }): void;
  appendMessage(params: {
    threadId: string;
    message: StoredMessage;
    item: ThreadReplayItem;
  }): void;
  appendItem(params: {
    threadId: string;
    item: ThreadReplayItem;
  }): void;
}

type RolloutRecord =
  | {
      type: "message";
      role: AppServerRole;
      text: string;
      parts?: AppServerTurnInputItem[];
    }
  | {
      type: "item";
      item: ThreadReplayItem;
    };

export class GrokRolloutStore implements AppServerSessionStore {
  constructor(private readonly stateRoot: string) {}

  load(): HydratedSessionState {
    this.migrateArchivedActiveThreads();

    const threads: ThreadState[] = [];
    const messagesByThread: Record<string, StoredMessage[]> = {};
    const itemsByThread: Record<string, ThreadReplayItem[]> = {};
    const responseIds: Record<string, string> = {};
    let itemSequence = 0;
    let lastTimestamp = 0;

    for (const { archived, threadDir } of this.listThreadDirectories()) {
      const threadPath = path.join(threadDir, "thread.toml");
      if (!fs.existsSync(threadPath)) {
        continue;
      }
      const thread = {
        ...readThreadToml(threadPath),
        ...(archived ? { archived: true } : {}),
      };
      threads.push(thread);
      lastTimestamp = Math.max(lastTimestamp, thread.createdAt ?? 0, thread.updatedAt ?? 0);

      const previousResponseId = readPreviousResponseId(threadPath);
      if (previousResponseId) {
        responseIds[thread.threadId] = previousResponseId;
      }

      const rolloutPath = path.join(threadDir, "rollout.jsonl");
      const { messages, items } = readRolloutFile(rolloutPath);
      messagesByThread[thread.threadId] = messages;
      itemsByThread[thread.threadId] = items;
      for (const item of items) {
        itemSequence = Math.max(itemSequence, trailingSequence(item.id));
      }
    }

    return {
      threads,
      messagesByThread,
      itemsByThread,
      responseIds,
      itemSequence,
      lastTimestamp,
    };
  }

  persistThread(params: {
    thread: ThreadState;
    previousResponseId?: string;
  }): void {
    this.writeThreadToml(params);
  }

  archiveThread(params: {
    thread: ThreadState;
    previousResponseId?: string;
  }): void {
    this.moveThreadDirectory({
      threadId: params.thread.threadId,
      from: this.activeThreadDirectory(params.thread.threadId),
      to: this.archivedThreadDirectory(params.thread.threadId),
    });
    this.writeThreadToml(params);
  }

  unarchiveThread(params: {
    thread: ThreadState;
    previousResponseId?: string;
  }): void {
    this.moveThreadDirectory({
      threadId: params.thread.threadId,
      from: this.archivedThreadDirectory(params.thread.threadId),
      to: this.activeThreadDirectory(params.thread.threadId),
    });
    this.writeThreadToml(params);
  }

  appendMessage(params: {
    threadId: string;
    message: StoredMessage;
    item: ThreadReplayItem;
  }): void {
    this.appendRecord(params.threadId, {
      type: "message",
      role: params.message.role,
      text: params.message.text,
      parts: params.message.parts,
    });
    this.appendRecord(params.threadId, {
      type: "item",
      item: params.item,
    });
  }

  appendItem(params: {
    threadId: string;
    item: ThreadReplayItem;
  }): void {
    this.appendRecord(params.threadId, {
      type: "item",
      item: params.item,
    });
  }

  private listThreadDirectories(): Array<{ archived: boolean; threadDir: string }> {
    return [
      ...this.listThreadDirectoriesInRoot(this.activeThreadsRoot(), false),
      ...this.listThreadDirectoriesInRoot(this.archivedThreadsRoot(), true),
    ];
  }

  private listThreadDirectoriesInRoot(
    root: string,
    archived: boolean,
  ): Array<{ archived: boolean; threadDir: string }> {
    if (!fs.existsSync(root)) {
      return [];
    }

    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        archived,
        threadDir: path.join(root, entry.name),
      }));
  }

  private ensureThreadDirectory(threadId: string): string {
    const threadDir = this.activeThreadDirectory(threadId);
    fs.mkdirSync(threadDir, { recursive: true });
    return threadDir;
  }

  private appendRecord(threadId: string, record: RolloutRecord): void {
    const threadDir = this.ensureThreadDirectory(threadId);
    fs.appendFileSync(
      path.join(threadDir, "rollout.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  }

  private writeThreadToml(params: {
    thread: ThreadState;
    previousResponseId?: string;
  }): void {
    const threadDir = params.thread.archived
      ? this.archivedThreadDirectory(params.thread.threadId)
      : this.activeThreadDirectory(params.thread.threadId);
    fs.mkdirSync(threadDir, { recursive: true });
    const threadPath = path.join(threadDir, "thread.toml");
    writeAtomicFile(
      threadPath,
      stringifyFlatToml({
        approval_policy: params.thread.approvalPolicy,
        archived: params.thread.archived,
        created_at: params.thread.createdAt,
        cwd: params.thread.cwd,
        model: params.thread.model,
        model_provider: params.thread.modelProvider,
        previous_response_id: params.previousResponseId,
        reasoning_effort: params.thread.reasoningEffort,
        sandbox: params.thread.sandbox,
        service_tier: params.thread.serviceTier,
        fast_mode:
          typeof params.thread.fastMode === "boolean"
            ? params.thread.fastMode
            : undefined,
        thread_id: params.thread.threadId,
        thread_name: params.thread.threadName,
        updated_at: params.thread.updatedAt,
      }),
    );
  }

  private migrateArchivedActiveThreads(): void {
    for (const { threadDir } of this.listThreadDirectoriesInRoot(
      this.activeThreadsRoot(),
      false,
    )) {
      const threadPath = path.join(threadDir, "thread.toml");
      if (!fs.existsSync(threadPath)) {
        continue;
      }
      const thread = readThreadToml(threadPath);
      if (!thread.archived) {
        continue;
      }
      this.moveThreadDirectory({
        threadId: thread.threadId,
        from: threadDir,
        to: this.archivedThreadDirectory(thread.threadId),
      });
    }
  }

  private moveThreadDirectory(params: {
    threadId: string;
    from: string;
    to: string;
  }): void {
    if (!fs.existsSync(params.from)) {
      fs.mkdirSync(params.to, { recursive: true });
      return;
    }
    if (fs.existsSync(params.to)) {
      throw new Error(
        `Cannot move Grok thread ${params.threadId}: ${params.to} already exists`,
      );
    }
    fs.mkdirSync(path.dirname(params.to), { recursive: true });
    fs.renameSync(params.from, params.to);
  }

  private activeThreadsRoot(): string {
    return path.join(this.stateRoot, "threads");
  }

  private archivedThreadsRoot(): string {
    return path.join(this.stateRoot, "archived_threads");
  }

  private activeThreadDirectory(threadId: string): string {
    return path.join(this.activeThreadsRoot(), threadId);
  }

  private archivedThreadDirectory(threadId: string): string {
    return path.join(this.archivedThreadsRoot(), threadId);
  }
}

function readThreadToml(filePath: string): ThreadState {
  const values = parseFlatToml(fs.readFileSync(filePath, "utf8"), filePath);
  const threadId = asRequiredString(values.thread_id, filePath, "thread_id");

  return {
    threadId,
    threadName: asOptionalString(values.thread_name),
    cwd: asOptionalString(values.cwd),
    model: asOptionalString(values.model),
    modelProvider: asOptionalString(values.model_provider),
    approvalPolicy: asOptionalString(values.approval_policy),
    archived:
      typeof values.archived === "boolean" ? values.archived : undefined,
    sandbox: asOptionalString(values.sandbox),
    serviceTier: asOptionalString(values.service_tier),
    reasoningEffort: asOptionalString(values.reasoning_effort),
    fastMode:
      typeof values.fast_mode === "boolean" ? values.fast_mode : undefined,
    createdAt: asOptionalNumber(values.created_at),
    updatedAt: asOptionalNumber(values.updated_at),
  };
}

function readPreviousResponseId(filePath: string): string | undefined {
  const values = parseFlatToml(fs.readFileSync(filePath, "utf8"), filePath);
  return asOptionalString(values.previous_response_id);
}

function readRolloutFile(filePath: string): {
  messages: StoredMessage[];
  items: ThreadReplayItem[];
} {
  if (!fs.existsSync(filePath)) {
    return { messages: [], items: [] };
  }

  const messages: StoredMessage[] = [];
  const itemOrder: string[] = [];
  const itemMap = new Map<string, ThreadReplayItem>();
  const itemOccurrences = new Map<string, { resolvedId: string; lastMessageCount: number }>();
  let messageCount = 0;

  for (const [index, rawLine] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let record: RolloutRecord;
    try {
      record = JSON.parse(line) as RolloutRecord;
    } catch (error) {
      throw new Error(`Invalid JSONL record ${index + 1} in ${filePath}: ${String(error)}`);
    }

    if (record.type === "message") {
      messages.push({
        role: record.role,
        text: record.text,
        parts: record.parts,
      });
      messageCount += 1;
      continue;
    }

    const item = normalizeReplayItem(record.item);
    const resolvedId = resolveReplayItemOccurrenceId(
      item.id,
      itemOccurrences,
      itemMap,
      messageCount,
    );
    const normalizedItem =
      resolvedId === item.id
        ? item
        : normalizeReplayItem({
            ...item,
            id: resolvedId,
          });
    if (!itemMap.has(normalizedItem.id)) {
      itemOrder.push(normalizedItem.id);
    }
    itemMap.set(normalizedItem.id, normalizedItem);
  }

  return {
    messages,
    items: itemOrder.flatMap((itemId) => {
      const item = itemMap.get(itemId);
      return item ? [item] : [];
    }),
  };
}

function trailingSequence(value: string): number {
  const match = /(\d+)$/.exec(value);
  return match ? Number(match[1]) : 0;
}

function resolveReplayItemOccurrenceId(
  baseId: string,
  occurrences: Map<string, { resolvedId: string; lastMessageCount: number }>,
  itemMap: Map<string, ThreadReplayItem>,
  currentMessageCount: number,
): string {
  const existing = occurrences.get(baseId);
  if (!existing) {
    occurrences.set(baseId, {
      resolvedId: baseId,
      lastMessageCount: currentMessageCount,
    });
    return baseId;
  }

  if (existing.lastMessageCount < currentMessageCount) {
    const resolvedId = nextReplayItemOccurrenceId(baseId, itemMap);
    occurrences.set(baseId, {
      resolvedId,
      lastMessageCount: currentMessageCount,
    });
    return resolvedId;
  }

  existing.lastMessageCount = currentMessageCount;
  return existing.resolvedId;
}

function nextReplayItemOccurrenceId(
  baseId: string,
  itemMap: Map<string, ThreadReplayItem>,
): string {
  for (let index = 2; ; index += 1) {
    const candidate = `${baseId}#${index}`;
    if (!itemMap.has(candidate)) {
      return candidate;
    }
  }
}

function asRequiredString(
  value: string | number | boolean | undefined,
  filePath: string,
  key: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${key} in ${filePath}`);
  }
  return value.trim();
}

function asOptionalString(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalNumber(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function writeAtomicFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, contents, "utf8");
  fs.renameSync(tempPath, filePath);
}

function normalizeReplayItem(item: ThreadReplayItem): ThreadReplayItem {
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined),
  ) as ThreadReplayItem;
}
