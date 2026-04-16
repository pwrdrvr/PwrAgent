import type { AppServerNotification } from "./protocol.js";
import { AppServerSessionState } from "./session-state.js";
import { PendingInputCoordinator } from "./pending-input.js";
import type { ProviderActiveTurn, ProviderTurnEvent } from "../providers/provider-contract.js";

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
  }): void {
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
        await this.emit({
          method: event.type === "item_started" ? "item/started" : "item/completed",
          params: {
            threadId: execution.threadId,
            runId: execution.runId,
            item: {
              id: event.item.id,
              type: event.item.type,
              text: event.item.text,
              review: event.item.review,
            },
          },
        });
        return;
      case "item_plan_delta":
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
    },
    execution: ActiveExecution,
  ): Promise<void> {
    try {
      const result = await params.handle.result;
      const run = this.state.getRun(params.runId);
      if (!run || run.status !== "active") {
        return;
      }
      await execution.pendingInput.waitForIdle();
      this.state.completeRun(params.runId);
      this.state.appendAssistant(params.threadId, result.assistantText ?? "");
      this.state.setPreviousResponseId(params.threadId, result.providerResponseId);
      await this.emit({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
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
          threadId: params.threadId,
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
    } finally {
      execution.unsubscribe?.();
      this.executions.delete(params.runId);
    }
  }
}
