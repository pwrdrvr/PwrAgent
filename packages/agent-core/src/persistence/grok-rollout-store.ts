import fs from "node:fs";
import path from "node:path";
import type {
  AppServerRole,
  ThreadReplayItem,
  ThreadState,
} from "../app-server/protocol.js";
import { parseFlatToml, stringifyFlatToml } from "../config/simple-toml.js";

export type StoredMessage = {
  role: AppServerRole;
  text: string;
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
    }
  | {
      type: "item";
      item: ThreadReplayItem;
    };

export class GrokRolloutStore implements AppServerSessionStore {
  constructor(private readonly stateRoot: string) {}

  load(): HydratedSessionState {
    const threads: ThreadState[] = [];
    const messagesByThread: Record<string, StoredMessage[]> = {};
    const itemsByThread: Record<string, ThreadReplayItem[]> = {};
    const responseIds: Record<string, string> = {};
    let itemSequence = 0;
    let lastTimestamp = 0;

    for (const threadDir of this.listThreadDirectories()) {
      const threadPath = path.join(threadDir, "thread.toml");
      if (!fs.existsSync(threadPath)) {
        continue;
      }
      const thread = readThreadToml(threadPath);
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
    const threadDir = this.ensureThreadDirectory(params.thread.threadId);
    const threadPath = path.join(threadDir, "thread.toml");
    writeAtomicFile(
      threadPath,
      stringifyFlatToml({
        approval_policy: params.thread.approvalPolicy,
        created_at: params.thread.createdAt,
        cwd: params.thread.cwd,
        model: params.thread.model,
        model_provider: params.thread.modelProvider,
        previous_response_id: params.previousResponseId,
        reasoning_effort: params.thread.reasoningEffort,
        sandbox: params.thread.sandbox,
        service_tier: params.thread.serviceTier,
        thread_id: params.thread.threadId,
        thread_name: params.thread.threadName,
        updated_at: params.thread.updatedAt,
      }),
    );
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

  private listThreadDirectories(): string[] {
    const threadsRoot = path.join(this.stateRoot, "threads");
    if (!fs.existsSync(threadsRoot)) {
      return [];
    }

    return fs
      .readdirSync(threadsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(threadsRoot, entry.name));
  }

  private ensureThreadDirectory(threadId: string): string {
    const threadDir = path.join(this.stateRoot, "threads", threadId);
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
    sandbox: asOptionalString(values.sandbox),
    serviceTier: asOptionalString(values.service_tier),
    reasoningEffort: asOptionalString(values.reasoning_effort),
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
