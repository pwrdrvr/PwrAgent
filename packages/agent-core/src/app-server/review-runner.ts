import type { AppServerNotification, ThreadState } from "./protocol.js";
import { AppServerSessionState } from "./session-state.js";
import { TurnRunner } from "./turn-runner.js";
import type { AppServerProvider } from "../providers/provider-contract.js";
import type { ToolExecutor } from "../tools/tool-contract.js";

type ReviewRunnerOptions = {
  provider: AppServerProvider;
  state: AppServerSessionState;
  emit: (notification: AppServerNotification) => Promise<void>;
  turnRunner: TurnRunner;
  tools: ToolExecutor;
};

export class ReviewRunner {
  private readonly provider: AppServerProvider;
  private readonly state: AppServerSessionState;
  private readonly emit: (notification: AppServerNotification) => Promise<void>;
  private readonly turnRunner: TurnRunner;
  private readonly tools: ToolExecutor;

  constructor(options: ReviewRunnerOptions) {
    this.provider = options.provider;
    this.state = options.state;
    this.emit = options.emit;
    this.turnRunner = options.turnRunner;
    this.tools = options.tools;
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
      tools: this.tools,
    });
    this.state.createRun({
      runId: params.runId,
      threadId: params.thread.threadId,
      handle,
    });
    this.turnRunner.attach({
      threadId: params.thread.threadId,
      runId: params.runId,
      handle,
      onSuccess: async (result) => {
        this.state.completeRun(params.runId);
        this.state.upsertItem(params.thread.threadId, {
          id: params.itemId,
          type: "exitedReviewMode",
          status: "completed",
          review: result.assistantText,
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
      },
    });
    return {
      reviewThreadId: params.thread.threadId,
      runId: params.runId,
    };
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
