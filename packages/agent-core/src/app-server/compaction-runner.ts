import type { AppServerNotification, ThreadState } from "./protocol.js";
import { AppServerSessionState } from "./session-state.js";
import type { AppServerProvider } from "../providers/provider-contract.js";

type CompactionRunnerOptions = {
  provider: AppServerProvider;
  state: AppServerSessionState;
  emit: (notification: AppServerNotification) => Promise<void>;
};

export class CompactionRunner {
  private readonly provider: AppServerProvider;
  private readonly state: AppServerSessionState;
  private readonly emit: (notification: AppServerNotification) => Promise<void>;

  constructor(options: CompactionRunnerOptions) {
    this.provider = options.provider;
    this.state = options.state;
    this.emit = options.emit;
  }

  async start(params: {
    thread: ThreadState;
    runId: string;
    itemId: string;
  }): Promise<{ threadId: string; runId: string; itemId: string }> {
    const handle = await this.provider.startTurn({
      thread: params.thread,
      input: [
        {
          type: "text",
          text: buildCompactionPrompt(this.state.readThread(params.thread.threadId)),
        },
      ],
      previousResponseId: this.state.getPreviousResponseId(params.thread.threadId),
    });
    this.state.createRun({
      runId: params.runId,
      threadId: params.thread.threadId,
      handle,
    });
    await this.emit({
      method: "item/started",
      params: {
        threadId: params.thread.threadId,
        runId: params.runId,
        item: {
          id: params.itemId,
          type: "contextCompaction",
        },
      },
    });
    void this.complete(params, handle);
    return {
      threadId: params.thread.threadId,
      runId: params.runId,
      itemId: params.itemId,
    };
  }

  private async complete(
    params: {
      thread: ThreadState;
      runId: string;
      itemId: string;
    },
    handle: Awaited<ReturnType<AppServerProvider["startTurn"]>>,
  ): Promise<void> {
    try {
      const result = await handle.result;
      const run = this.state.getRun(params.runId);
      if (!run || run.status !== "active") {
        return;
      }
      this.state.completeRun(params.runId);
      this.state.setPreviousResponseId(params.thread.threadId, result.providerResponseId);
      await this.emit({
        method: "item/completed",
        params: {
          threadId: params.thread.threadId,
          runId: params.runId,
          item: {
            id: params.itemId,
            type: "contextCompaction",
            text: result.assistantText,
          },
        },
      });
      await this.emit({
        method: "thread/compacted",
        params: {
          threadId: params.thread.threadId,
          itemId: params.itemId,
        },
      });
    } catch (error) {
      const run = this.state.getRun(params.runId);
      if (!run || run.status !== "active") {
        return;
      }
      this.state.failRun(params.runId);
      await this.emit({
        method: "turn/failed",
        params: {
          threadId: params.thread.threadId,
          runId: params.runId,
          turn: {
            id: params.runId,
            status: "failed",
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
        },
      });
    }
  }
}

function buildCompactionPrompt(replay: ReturnType<AppServerSessionState["readThread"]>): string {
  const transcript = replay.messages
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
  return [
    "Summarize this thread so it can be compacted and resumed later.",
    "Keep the summary concise and preserve any active task state.",
    transcript || "No prior transcript is available.",
  ].join("\n\n");
}
