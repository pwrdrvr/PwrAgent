import type { AutomationRunSummary } from "@pwragent/shared";
import type { AutomationGateRunResult } from "@pwragent/shared";
import type {
  ThreadTurnQueueEntry,
  ThreadTurnQueueSubmissionResult,
} from "../app-server/thread-turn-queue.js";
import { getMainLogger } from "../log.js";
import { buildAutomationTurnInput } from "./automation-prompt.js";
import type { AutomationRecord } from "./automation-store.js";

const automationRunnerLog = getMainLogger("pwragent:automation-runner");

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
    gateResult?: AutomationGateRunResult;
    run: AutomationRunSummary;
  }): Promise<AutomationRunSubmissionResult>;
  updateQueuedRunInput?(params: {
    automation: AutomationRecord;
    queueEntryId: string;
    run: AutomationRunSummary;
  }): void;
};

export type AutomationRunSubmissionResult = ThreadTurnQueueSubmissionResult & {
  backendThreadId?: string;
};

export type HeadlessAutomationLauncher = {
  startAutomationHeadlessTurn(params: {
    backend: AutomationRecord["backend"];
    agentThreadId: AutomationRecord["threadId"];
    automationName?: string;
    automationRunId: string;
    input: ThreadTurnQueueEntry["input"];
  }): Promise<{
    headlessThreadId?: string;
    queueEntryId: string;
    threadId: string;
    turnId: string;
  }>;
};

export class HeadlessAutomationRunner implements AutomationRunner {
  constructor(private readonly launcher: HeadlessAutomationLauncher) {}

  async submitRun(params: {
    automation: AutomationRecord;
    gateResult?: AutomationGateRunResult;
    run: AutomationRunSummary;
  }): Promise<AutomationRunSubmissionResult> {
    const input = buildAutomationTurnInput(params);
    automationRunnerLog.info("submitting headless automation run", {
      automationId: params.automation.id,
      automationName: params.automation.name,
      backend: params.automation.backend,
      inputItemCount: input.length,
      promptLength: params.automation.taskPrompt.length,
      runId: params.run.id,
      threadId: params.automation.threadId,
      trigger: params.run.trigger,
      windowCount: params.run.scheduledWindows.length,
    });
    const result = await this.launcher.startAutomationHeadlessTurn({
      backend: params.automation.backend,
      agentThreadId: params.automation.threadId,
      automationName: params.automation.name,
      automationRunId: params.run.id,
      input,
    });
    automationRunnerLog.info("headless automation run accepted", {
      automationId: params.automation.id,
      automationName: params.automation.name,
      backend: params.automation.backend,
      headlessThreadId: result.headlessThreadId,
      queueEntryId: result.queueEntryId,
      runId: params.run.id,
      threadId: params.automation.threadId,
      turnId: result.turnId,
    });
    return {
      status: "started",
      backendThreadId: result.headlessThreadId,
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
    gateResult?: AutomationGateRunResult;
    run: AutomationRunSummary;
  }): Promise<AutomationRunSubmissionResult> {
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
