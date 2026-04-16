import type {
  AppServerRole,
  AppServerTurnInputItem,
  ThreadReplay,
  ThreadState,
  ThreadSummary,
} from "./protocol.js";
import type { ProviderActiveTurn } from "../providers/provider-contract.js";

type StoredMessage = {
  role: AppServerRole;
  text: string;
};

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
  private readonly threads = new Map<string, ThreadState>();
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly responseIds = new Map<string, string>();
  private readonly runs = new Map<string, ActiveRunRecord>();
  private lastTimestamp = 0;

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
    this.appendMessage(threadId, { role: "user", text });
  }

  appendAssistant(threadId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.touchThread(threadId);
      return;
    }
    this.appendMessage(threadId, { role: "assistant", text: trimmed });
  }

  private appendMessage(threadId: string, message: StoredMessage): void {
    const messages = this.messages.get(threadId) ?? [];
    messages.push(message);
    this.messages.set(threadId, messages);
    this.touchThread(threadId);
  }

  readThread(threadId: string): ThreadReplay {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    const messages = [...(this.messages.get(threadId) ?? [])];
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
    return { threadId, thread, messages, lastUserMessage, lastAssistantMessage };
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
  }

  private nextTimestamp(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  }
}
