import type { AutomationRunSummary } from "@pwragent/shared";
import type {
  ThreadTurnQueueEntry,
  ThreadTurnQueueSubmissionResult,
} from "../app-server/thread-turn-queue.js";
import { buildAutomationTurnInput } from "./automation-prompt.js";
import type { AutomationRecord } from "./automation-store.js";

export type AutomationTurnQueue = {
  canStartImmediately(params: {
    backend: AutomationRecord["backend"];
    threadId: AutomationRecord["threadId"];
  }): boolean;
  submit(
    entry: Omit<ThreadTurnQueueEntry, "id" | "createdAt"> &
      Partial<Pick<ThreadTurnQueueEntry, "id" | "createdAt">>,
  ): Promise<ThreadTurnQueueSubmissionResult>;
  updateQueuedInput?(entryId: string, input: ThreadTurnQueueEntry["input"]): void;
};

export type AutomationRunner = {
  submitRun(params: {
    automation: AutomationRecord;
    run: AutomationRunSummary;
  }): Promise<ThreadTurnQueueSubmissionResult>;
  updateQueuedRunInput?(params: {
    automation: AutomationRecord;
    queueEntryId: string;
    run: AutomationRunSummary;
  }): void;
};

export class ThreadQueueAutomationRunner implements AutomationRunner {
  constructor(private readonly queue: AutomationTurnQueue) {}

  async submitRun(params: {
    automation: AutomationRecord;
    run: AutomationRunSummary;
  }): Promise<ThreadTurnQueueSubmissionResult> {
    return await this.queue.submit({
      backend: params.automation.backend,
      threadId: params.automation.threadId,
      origin: "automation",
      automationRunId: params.run.id,
      automationName: params.automation.name,
      input: buildAutomationTurnInput(params),
    });
  }

  updateQueuedRunInput(params: {
    automation: AutomationRecord;
    queueEntryId: string;
    run: AutomationRunSummary;
  }): void {
    this.queue.updateQueuedInput?.(
      params.queueEntryId,
      buildAutomationTurnInput({
        automation: params.automation,
        run: params.run,
      }),
    );
  }
}
