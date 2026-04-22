import type { AppServerNotification, ThreadState } from "./internal-contract.js";
import { AppServerSessionState } from "./session-state.js";
import { TurnRunner } from "./turn-runner.js";
import type { AppServerProvider } from "../providers/provider-contract.js";
import type { ToolExecutor } from "../tools/tool-contract.js";

type CompactionRunnerOptions = {
  provider: AppServerProvider;
  state: AppServerSessionState;
  emit: (notification: AppServerNotification) => Promise<void>;
  turnRunner: TurnRunner;
  tools: ToolExecutor;
};

export class CompactionRunner {
  private readonly provider: AppServerProvider;
  private readonly state: AppServerSessionState;
  private readonly emit: (notification: AppServerNotification) => Promise<void>;
  private readonly turnRunner: TurnRunner;
  private readonly tools: ToolExecutor;

  constructor(options: CompactionRunnerOptions) {
    this.provider = options.provider;
    this.state = options.state;
    this.emit = options.emit;
    this.turnRunner = options.turnRunner;
    this.tools = options.tools;
  }

  async start(params: {
    thread: ThreadState;
    turnId: string;
    itemId: string;
  }): Promise<{ threadId: string; turnId: string; itemId: string }> {
    const handle = await this.provider.startTurn({
      thread: params.thread,
      input: [
        {
          type: "text",
          text: buildCompactionPrompt(this.state.readThread(params.thread.threadId)),
        },
      ],
      previousResponseId: this.state.getPreviousResponseId(params.thread.threadId),
      tools: this.tools,
    });
    this.state.createRun({
      turnId: params.turnId,
      threadId: params.thread.threadId,
      handle,
    });
    this.state.upsertItem(params.thread.threadId, {
      id: params.itemId,
      type: "contextCompaction",
      status: "in_progress",
    });
    await this.emit({
      method: "item/started",
      params: {
        threadId: params.thread.threadId,
        turnId: params.turnId,
        item: {
          id: params.itemId,
          type: "contextCompaction",
        },
      },
    });
    this.turnRunner.attach({
      threadId: params.thread.threadId,
      turnId: params.turnId,
      handle,
      onSuccess: async (result) => {
        this.state.completeRun(params.turnId);
        this.state.upsertItem(params.thread.threadId, {
          id: params.itemId,
          type: "contextCompaction",
          status: "completed",
          text: result.assistantText,
        });
        this.state.appendAssistant(params.thread.threadId, result.assistantText ?? "");
        this.state.setPreviousResponseId(
          params.thread.threadId,
          result.providerResponseId,
        );
        await this.emit({
          method: "item/completed",
          params: {
            threadId: params.thread.threadId,
            turnId: params.turnId,
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
      },
      onError: async (error) => {
        this.state.failRun(params.turnId);
        this.state.upsertItem(params.thread.threadId, {
          id: params.itemId,
          type: "contextCompaction",
          status: "failed",
        });
        await this.emit({
          method: "turn/failed",
          params: {
            threadId: params.thread.threadId,
            turnId: params.turnId,
            turn: {
              id: params.turnId,
              status: "failed",
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          },
        });
      },
    });
    return {
      threadId: params.thread.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
    };
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
