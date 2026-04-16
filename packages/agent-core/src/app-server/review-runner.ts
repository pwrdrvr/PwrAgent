import type { AppServerNotification, ThreadState } from "./protocol.js";
import { AppServerSessionState } from "./session-state.js";
import type { AppServerProvider } from "../providers/provider-contract.js";

type ReviewRunnerOptions = {
  provider: AppServerProvider;
  state: AppServerSessionState;
  emit: (notification: AppServerNotification) => Promise<void>;
};

export class ReviewRunner {
  private readonly provider: AppServerProvider;
  private readonly state: AppServerSessionState;
  private readonly emit: (notification: AppServerNotification) => Promise<void>;

  constructor(options: ReviewRunnerOptions) {
    this.provider = options.provider;
    this.state = options.state;
    this.emit = options.emit;
  }

  async start(params: {
    thread: ThreadState;
    runId: string;
    itemId: string;
    target: unknown;
  }): Promise<{ reviewThreadId: string; runId: string }> {
    const handle = await this.provider.startTurn({
      thread: params.thread,
      input: [
        {
          type: "text",
          text: buildReviewPrompt(
            this.state.readThread(params.thread.threadId),
            params.target,
          ),
        },
      ],
      previousResponseId: this.state.getPreviousResponseId(params.thread.threadId),
    });
    this.state.createRun({
      runId: params.runId,
      threadId: params.thread.threadId,
      handle,
    });
    void this.complete(params, handle);
    return {
      reviewThreadId: params.thread.threadId,
      runId: params.runId,
    };
  }

  private async complete(
    params: {
      thread: ThreadState;
      runId: string;
      itemId: string;
      target: unknown;
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
            type: "exitedReviewMode",
            review: result.assistantText,
          },
        },
      });
      await this.emit({
        method: "turn/completed",
        params: {
          threadId: params.thread.threadId,
          runId: params.runId,
          turn: {
            id: params.runId,
            status: "completed",
            output: [
              {
                type: "text",
                text: result.assistantText ?? "",
              },
            ],
          },
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

function buildReviewPrompt(
  replay: ReturnType<AppServerSessionState["readThread"]>,
  target: unknown,
): string {
  const transcript = replay.messages
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
  const serializedTarget = JSON.stringify(target, null, 2);
  return [
    "Review the requested target and respond with inline review feedback.",
    `Target:\n${serializedTarget}`,
    transcript ? `Thread transcript:\n${transcript}` : "No prior transcript is available.",
  ].join("\n\n");
}
