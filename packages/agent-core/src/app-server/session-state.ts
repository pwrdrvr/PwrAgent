import type { AppServerRole, AppServerTurnInputItem, ThreadReplay, ThreadState } from "./protocol.js";
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
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
  reasoningEffort?: string;
};

export class AppServerSessionState {
  private readonly threads = new Map<string, ThreadState>();
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly responseIds = new Map<string, string>();
  private readonly runs = new Map<string, ActiveRunRecord>();

  createThread(params: CreateThreadParams): ThreadState {
    const thread: ThreadState = {
      threadId: params.threadId,
      cwd: params.cwd,
      model: params.model,
      approvalPolicy: params.approvalPolicy ?? "on-request",
      sandbox: params.sandbox ?? "workspace-write",
      serviceTier: params.serviceTier,
      reasoningEffort: params.reasoningEffort,
    };
    this.threads.set(thread.threadId, thread);
    this.messages.set(thread.threadId, []);
    return thread;
  }

  getThread(threadId: string): ThreadState | undefined {
    return this.threads.get(threadId);
  }

  updateThread(
    threadId: string,
    patch: Partial<Omit<ThreadState, "threadId">>,
  ): ThreadState | undefined {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return undefined;
    }
    const next = {
      ...thread,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
    };
    this.threads.set(threadId, next);
    return next;
  }

  appendInput(threadId: string, input: AppServerTurnInputItem[]): void {
    const text = input
      .filter((item): item is Extract<AppServerTurnInputItem, { type: "text" }> => item.type === "text")
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) {
      return;
    }
    this.appendMessage(threadId, { role: "user", text });
  }

  appendAssistant(threadId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.appendMessage(threadId, { role: "assistant", text: trimmed });
  }

  private appendMessage(threadId: string, message: StoredMessage): void {
    const messages = this.messages.get(threadId) ?? [];
    messages.push(message);
    this.messages.set(threadId, messages);
  }

  readThread(threadId: string): ThreadReplay {
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
    return { threadId, messages, lastUserMessage, lastAssistantMessage };
  }

  setPreviousResponseId(threadId: string, responseId: string | undefined): void {
    if (!responseId?.trim()) {
      return;
    }
    this.responseIds.set(threadId, responseId.trim());
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
    return run;
  }

  failRun(runId: string): ActiveRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    run.status = "failed";
    return run;
  }

  cancelRun(runId: string): ActiveRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    run.status = "cancelled";
    return run;
  }
}
