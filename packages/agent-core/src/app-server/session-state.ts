import type {
  AppServerItemStatus,
  AppServerTurnInputItem,
  ThreadReplay,
  ThreadReplayItem,
  ThreadState,
  ThreadSummary,
} from "./protocol.js";
import type {
  AppServerSessionStore,
  HydratedSessionState,
  StoredMessage,
} from "../persistence/grok-rollout-store.js";
import type { ProviderActiveTurn } from "../providers/provider-contract.js";

type ActiveRunRecord = {
  runId: string;
  threadId: string;
  status: "active" | "completed" | "failed" | "cancelled";
  handle: ProviderActiveTurn;
};

type CreateThreadParams = {
  threadId: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
};

type ThreadMutation = Partial<Omit<ThreadState, "threadId" | "createdAt">>;

export class AppServerSessionState {
  private readonly store?: AppServerSessionStore;
  private readonly threads = new Map<string, ThreadState>();
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly items = new Map<string, ThreadReplayItem[]>();
  private readonly itemOccurrences = new Map<
    string,
    Map<string, { resolvedId: string; lastMessageCount: number }>
  >();
  private readonly responseIds = new Map<string, string>();
  private readonly runs = new Map<string, ActiveRunRecord>();
  private lastTimestamp = 0;
  private itemSequence = 0;

  constructor(options?: { store?: AppServerSessionStore }) {
    this.store = options?.store;
    if (this.store) {
      this.hydrate(this.store.load());
    }
  }

  createThread(params: CreateThreadParams): ThreadState {
    const timestamp = this.nextTimestamp();
    const thread: ThreadState = {
      threadId: params.threadId,
      threadName: undefined,
      cwd: params.cwd,
      model: params.model,
      modelProvider: params.modelProvider ?? "xai",
      approvalPolicy: params.approvalPolicy ?? "on-request",
      sandbox: params.sandbox ?? "workspace-write",
      serviceTier: params.serviceTier,
      reasoningEffort: params.reasoningEffort,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.threads.set(thread.threadId, thread);
    this.messages.set(thread.threadId, []);
    this.items.set(thread.threadId, []);
    this.itemOccurrences.set(thread.threadId, new Map());
    this.persistThread(thread.threadId);
    return thread;
  }

  listThreads(): ThreadSummary[] {
    return [...this.threads.values()]
      .map((thread) => ({
        threadId: thread.threadId,
        title: thread.threadName,
        summary: this.summarizeThread(thread.threadId),
        projectKey: thread.cwd,
        model: thread.model,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      }))
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  getThread(threadId: string): ThreadState | undefined {
    return this.threads.get(threadId);
  }

  setThreadName(threadId: string, threadName: string): ThreadState | undefined {
    const trimmed = threadName.trim();
    if (!trimmed) {
      return this.updateThread(threadId, { threadName: undefined });
    }
    return this.updateThread(threadId, { threadName: trimmed });
  }

  updateThread(threadId: string, patch: ThreadMutation): ThreadState | undefined {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return undefined;
    }
    const next: ThreadState = {
      ...thread,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      updatedAt: this.nextTimestamp(),
    };
    this.threads.set(threadId, next);
    this.persistThread(threadId);
    return next;
  }

  appendInput(threadId: string, input: AppServerTurnInputItem[]): void {
    const text = input
      .filter(
        (item): item is Extract<AppServerTurnInputItem, { type: "text" }> => item.type === "text",
      )
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) {
      this.touchThread(threadId);
      return;
    }
    this.appendMessage(threadId, { role: "user", text }, {
      id: this.nextItemId("user"),
      type: "userMessage",
      status: "completed",
      role: "user",
      text,
    });
  }

  appendAssistant(threadId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.touchThread(threadId);
      return;
    }
    this.appendMessage(threadId, { role: "assistant", text: trimmed }, {
      id: this.nextItemId("assistant"),
      type: "agentMessage",
      status: "completed",
      role: "assistant",
      text: trimmed,
    });
  }

  upsertItem(threadId: string, item: ThreadReplayItem): ThreadReplayItem {
    const items = this.items.get(threadId) ?? [];
    const normalized = normalizeReplayItem(item);
    const resolvedId = this.resolveReplayItemId(threadId, normalized.id);
    const normalizedWithResolvedId =
      resolvedId === normalized.id
        ? normalized
        : normalizeReplayItem({
            ...normalized,
            id: resolvedId,
          });
    const resolvedIndex = items.findIndex((entry) => entry.id === normalizedWithResolvedId.id);
    if (resolvedIndex >= 0) {
      items[resolvedIndex] = {
        ...items[resolvedIndex],
        ...normalizedWithResolvedId,
      };
    } else {
      items.push(normalizedWithResolvedId);
    }
    this.items.set(threadId, items);
    this.touchThread(threadId);
    this.store?.appendItem({
      threadId,
      item: normalizedWithResolvedId,
    });
    return normalizedWithResolvedId;
  }

  appendItemTextDelta(
    threadId: string,
    itemId: string,
    delta: string,
    type = "plan",
    status: AppServerItemStatus = "in_progress",
  ): ThreadReplayItem {
    const existing = (this.items.get(threadId) ?? []).find((item) => item.id === itemId);
    return this.upsertItem(threadId, {
      id: itemId,
      type: existing?.type ?? type,
      status: existing?.status ?? status,
      text: `${existing?.text ?? ""}${delta}`,
      review: existing?.review,
      role: existing?.role,
      command: existing?.command,
      commandAction: existing?.commandAction,
      toolName: existing?.toolName,
      success: existing?.success,
      arguments: existing?.arguments,
    });
  }

  private appendMessage(
    threadId: string,
    message: StoredMessage,
    item: ThreadReplayItem,
  ): void {
    const messages = this.messages.get(threadId) ?? [];
    messages.push(message);
    this.messages.set(threadId, messages);
    const items = this.items.get(threadId) ?? [];
    items.push(item);
    this.items.set(threadId, items);
    this.touchThread(threadId);
    this.store?.appendMessage({
      threadId,
      message,
      item,
    });
  }

  readThread(threadId: string): ThreadReplay {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    const messages = [...(this.messages.get(threadId) ?? [])];
    const items = [...(this.items.get(threadId) ?? [])];
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
      threadId,
      thread,
      messages,
      items,
      lastUserMessage,
      lastAssistantMessage,
    };
  }

  setPreviousResponseId(threadId: string, responseId: string | undefined): void {
    if (!responseId?.trim()) {
      return;
    }
    this.responseIds.set(threadId, responseId.trim());
    this.touchThread(threadId);
  }

  getPreviousResponseId(threadId: string): string | undefined {
    return this.responseIds.get(threadId);
  }

  createRun(params: {
    runId: string;
    threadId: string;
    handle: ProviderActiveTurn;
  }): ActiveRunRecord {
    const run: ActiveRunRecord = {
      runId: params.runId,
      threadId: params.threadId,
      status: "active",
      handle: params.handle,
    };
    this.runs.set(run.runId, run);
    this.touchThread(params.threadId);
    return run;
  }

  getRun(runId: string): ActiveRunRecord | undefined {
    return this.runs.get(runId);
  }

  completeRun(runId: string): ActiveRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    run.status = "completed";
    this.touchThread(run.threadId);
    return run;
  }

  failRun(runId: string): ActiveRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    run.status = "failed";
    this.touchThread(run.threadId);
    return run;
  }

  cancelRun(runId: string): ActiveRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    run.status = "cancelled";
    this.touchThread(run.threadId);
    return run;
  }

  private summarizeThread(threadId: string): string | undefined {
    const messages = this.messages.get(threadId) ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.text.trim()) {
        return message.text;
      }
    }
    return undefined;
  }

  private touchThread(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }
    thread.updatedAt = this.nextTimestamp();
    this.persistThread(threadId);
  }

  private nextTimestamp(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  private nextItemId(prefix: string): string {
    this.itemSequence += 1;
    return `${prefix}-${this.itemSequence}`;
  }

  private persistThread(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }
    this.store?.persistThread({
      thread,
      previousResponseId: this.responseIds.get(threadId),
    });
  }

  private hydrate(data: HydratedSessionState): void {
    for (const thread of data.threads) {
      this.threads.set(thread.threadId, thread);
      this.itemOccurrences.set(thread.threadId, new Map());
    }
    for (const [threadId, messages] of Object.entries(data.messagesByThread)) {
      this.messages.set(threadId, [...messages]);
    }
    for (const [threadId, items] of Object.entries(data.itemsByThread)) {
      this.items.set(threadId, [...items]);
      const occurrences = this.itemOccurrences.get(threadId) ?? new Map();
      const lastMessageCount = this.messages.get(threadId)?.length ?? 0;
      for (const item of items) {
        const baseId = stripReplayItemSuffix(item.id);
        occurrences.set(baseId, {
          resolvedId: item.id,
          lastMessageCount,
        });
      }
      this.itemOccurrences.set(threadId, occurrences);
    }
    for (const [threadId, responseId] of Object.entries(data.responseIds)) {
      this.responseIds.set(threadId, responseId);
    }
    this.itemSequence = data.itemSequence;
    this.lastTimestamp = data.lastTimestamp;
  }

  private resolveReplayItemId(threadId: string, baseId: string): string {
    const currentMessageCount = this.messages.get(threadId)?.length ?? 0;
    const occurrences = this.itemOccurrences.get(threadId) ?? new Map();
    const existing = occurrences.get(baseId);
    if (!existing) {
      occurrences.set(baseId, {
        resolvedId: baseId,
        lastMessageCount: currentMessageCount,
      });
      this.itemOccurrences.set(threadId, occurrences);
      return baseId;
    }

    if (existing.lastMessageCount < currentMessageCount) {
      const resolvedId = nextReplayItemOccurrenceId(baseId, this.items.get(threadId) ?? []);
      occurrences.set(baseId, {
        resolvedId,
        lastMessageCount: currentMessageCount,
      });
      this.itemOccurrences.set(threadId, occurrences);
      return resolvedId;
    }

    existing.lastMessageCount = currentMessageCount;
    return existing.resolvedId;
  }
}

function normalizeReplayItem(item: ThreadReplayItem): ThreadReplayItem {
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined),
  ) as ThreadReplayItem;
}

function nextReplayItemOccurrenceId(baseId: string, items: ThreadReplayItem[]): string {
  const takenIds = new Set(items.map((item) => item.id));
  for (let index = 2; ; index += 1) {
    const candidate = `${baseId}#${index}`;
    if (!takenIds.has(candidate)) {
      return candidate;
    }
  }
}

function stripReplayItemSuffix(id: string): string {
  const match = /^(.*)#\d+$/.exec(id);
  return match?.[1] ?? id;
}
