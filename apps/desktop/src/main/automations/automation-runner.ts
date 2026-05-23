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

export type HeadlessAutomationLauncher = {
  startAutomationHeadlessTurn(params: {
    backend: AutomationRecord["backend"];
    agentThreadId: AutomationRecord["threadId"];
    automationName?: string;
    automationRunId: string;
    input: ThreadTurnQueueEntry["input"];
  }): Promise<{
    queueEntryId: string;
    threadId: string;
    turnId: string;
  }>;
};

export class HeadlessAutomationRunner implements AutomationRunner {
  constructor(private readonly launcher: HeadlessAutomationLauncher) {}

  async submitRun(params: {
    automation: AutomationRecord;
    run: AutomationRunSummary;
  }): Promise<ThreadTurnQueueSubmissionResult> {
    const input = buildAutomationTurnInput(params);
    const result = await this.launcher.startAutomationHeadlessTurn({
      backend: params.automation.backend,
      agentThreadId: params.automation.threadId,
      automationName: params.automation.name,
      automationRunId: params.run.id,
      input,
    });
    return {
      status: "started",
      entry: {
        id: result.queueEntryId,
        backend: params.automation.backend,
        threadId: params.automation.threadId,
        origin: "automation",
        automationRunId: params.run.id,
        automationName: params.automation.name,
        input,
        createdAt: Date.now(),
      },
      turnId: result.turnId,
    };
  }
}

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
