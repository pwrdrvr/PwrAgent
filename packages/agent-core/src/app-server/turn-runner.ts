import type { AppServerNotification, ThreadReplayItem } from "./protocol.js";
import { AppServerSessionState } from "./session-state.js";
import { PendingInputCoordinator } from "./pending-input.js";
import type {
  ProviderActiveTurn,
  ProviderTurnEvent,
  ProviderTurnResult,
} from "../providers/provider-contract.js";

type TurnRunnerOptions = {
  state: AppServerSessionState;
  emit: (notification: AppServerNotification) => Promise<void>;
  requestClient?: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
};

type ActiveExecution = {
  threadId: string;
  runId: string;
  pendingInput: PendingInputCoordinator;
  unsubscribe?: () => void;
};

type TurnRunnerCallbacks = {
  onSuccess?: (result: ProviderTurnResult) => Promise<void>;
  onError?: (error: unknown) => Promise<void>;
};

export class TurnRunner {
  private readonly state: AppServerSessionState;
  private readonly emit: (notification: AppServerNotification) => Promise<void>;
  private readonly requestClient?;
  private readonly executions = new Map<string, ActiveExecution>();

  constructor(options: TurnRunnerOptions) {
    this.state = options.state;
    this.emit = options.emit;
    this.requestClient = options.requestClient;
  }

  attach(params: {
    threadId: string;
    runId: string;
    handle: ProviderActiveTurn;
  } & TurnRunnerCallbacks): void {
    const pendingInput = new PendingInputCoordinator({
      requestClient: this.requestClient,
      onResolved: async (requestId) => {
        await this.emit({
          method: "serverRequest/resolved",
          params: {
            threadId: params.threadId,
            runId: params.runId,
            requestId,
          },
        });
      },
    });
    const execution: ActiveExecution = {
      threadId: params.threadId,
      runId: params.runId,
      pendingInput,
    };
    execution.unsubscribe = params.handle.subscribe?.((event) => this.onProviderEvent(execution, event));
    this.executions.set(params.runId, execution);
    void this.completeTurn(params, execution);
  }

  async cancel(runId: string): Promise<void> {
    const execution = this.executions.get(runId);
    if (!execution) {
      return;
    }
    await execution.pendingInput.cancelPending();
    execution.unsubscribe?.();
    this.executions.delete(runId);
  }

  private async onProviderEvent(
    execution: ActiveExecution,
    event: ProviderTurnEvent,
  ): Promise<void> {
    switch (event.type) {
      case "item_started":
      case "item_completed":
        const item: ThreadReplayItem = stripUndefined({
          id: event.item.id,
          type: event.item.type,
          status: event.type === "item_started" ? "in_progress" : "completed",
          text: event.item.text,
          review: event.item.review,
          command: event.item.command,
          commandAction: event.item.commandAction,
          toolName: event.item.toolName,
          success: event.item.success,
          arguments: event.item.arguments,
          data: event.item.data,
          sources: event.item.sources,
        });
        this.state.upsertItem(execution.threadId, item);
        await this.emit({
          method: event.type === "item_started" ? "item/started" : "item/completed",
          params: {
            threadId: execution.threadId,
            runId: execution.runId,
            item,
          },
        });
        return;
      case "item_command_output_delta":
        await this.emit({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: execution.threadId,
            runId: execution.runId,
            itemId: event.itemId,
            delta: event.delta,
            stream: event.stream,
            bytes: event.bytes,
          },
        });
        return;
      case "item_plan_delta":
        this.state.appendItemTextDelta(
          execution.threadId,
          event.itemId,
          event.delta,
          "plan",
        );
        await this.emit({
          method: "item/plan/delta",
          params: {
            threadId: execution.threadId,
            runId: execution.runId,
            item: {
              id: event.itemId,
              type: "plan",
            },
            delta: event.delta,
          },
        });
        return;
      case "turn_plan_updated":
        await this.emit({
          method: "turn/plan/updated",
          params: {
            threadId: execution.threadId,
            runId: execution.runId,
            plan: {
              explanation: event.explanation,
              steps: event.steps,
            },
          },
        });
        return;
      case "request_input":
        execution.pendingInput.enqueue({
          requestId: event.requestId,
          method: event.method,
          params: {
            threadId: execution.threadId,
            runId: execution.runId,
            requestId: event.requestId,
            ...(event.params ?? {}),
          },
          respond: event.respond,
        });
        return;
    }
  }

  private async completeTurn(
    params: {
      threadId: string;
      runId: string;
      handle: ProviderActiveTurn;
    } & TurnRunnerCallbacks,
    execution: ActiveExecution,
  ): Promise<void> {
    try {
      const result = await params.handle.result;
      const run = this.state.getRun(params.runId);
      if (!run || run.status !== "active") {
        return;
      }
      await execution.pendingInput.waitForIdle();
      if (params.onSuccess) {
        await params.onSuccess(result);
      } else {
        await this.completeDefaultTurn(params.threadId, params.runId, result);
      }
    } catch (error) {
      const run = this.state.getRun(params.runId);
      if (!run || run.status !== "active") {
        return;
      }
      if (params.onError) {
        await params.onError(error);
      } else {
        await this.failDefaultTurn(params.threadId, params.runId, error);
      }
    } finally {
      execution.unsubscribe?.();
      this.executions.delete(params.runId);
    }
  }

  private async completeDefaultTurn(
    threadId: string,
    runId: string,
    result: ProviderTurnResult,
  ): Promise<void> {
    const assistantText = result.assistantText?.trim() ?? "";
    if (!assistantText) {
      await this.failDefaultTurn(
        threadId,
        runId,
        new Error("Provider completed the turn without assistant text."),
      );
      return;
    }

    this.state.completeRun(runId);
    this.state.appendAssistant(threadId, assistantText, {
      sources: result.sources,
      data: result.providerMetadata ? { providerMetadata: result.providerMetadata } : undefined,
    });
    this.state.setPreviousResponseId(threadId, result.providerResponseId);
    await this.emit({
      method: "turn/completed",
      params: {
        threadId,
        runId,
        turn: {
          id: runId,
          status: "completed",
          output: [
            {
              type: "text",
              text: assistantText,
            },
          ],
        },
      },
    });
  }

  private async failDefaultTurn(
    threadId: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    this.state.failRun(runId);
    await this.emit({
      method: "turn/failed",
      params: {
        threadId,
        runId,
        turn: {
          id: runId,
          status: "failed",
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        },
      },
    });
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
