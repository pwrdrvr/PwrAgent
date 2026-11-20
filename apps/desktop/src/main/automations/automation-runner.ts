import type {
  AppServerTurnInputItem,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { AutomationPriorRunContext, AutomationRunSummary } from "@pwragent/shared/contracts/automations";
import type { AutomationGateRunResult } from "@pwragent/shared/contracts/automations";
import { automationSuppressesBindingBroadcast } from "@pwragent/shared/contracts/automations";
import { getMainLogger } from "../log.js";
import { buildAutomationTurnInput } from "./automation-prompt.js";
import type { AutomationRecord } from "@pwragent/owner-core/automation-storage";

const automationRunnerLog = getMainLogger("pwragent:automation-runner");

export type AutomationRunner = {
  submitRun(params: {
    automation: AutomationRecord;
    gateResult?: AutomationGateRunResult;
    priorRuns?: AutomationPriorRunContext[];
    run: AutomationRunSummary;
  }): Promise<AutomationRunStartResult>;
  /** Stop a started run's turn, as the operator's Stop would. */
  interruptRun?(params: {
    automation: AutomationRecord;
    run: AutomationRunSummary;
  }): Promise<void>;
};

/**
 * A runner starts the run or throws. Waiting is the scheduler's concern: a
 * run that cannot start yet is held in its automation's own lane.
 */
export type AutomationRunStartResult = {
  status: "started";
  queueEntryId: string;
  turnId: string;
  backendThreadId?: string;
};

/** What the scheduler reports for a run: started, or queued in its lane. */
export type AutomationRunSubmissionResult =
  | AutomationRunStartResult
  | { status: "queued"; queueEntryId: string; position: number };

export type HeadlessAutomationLauncher = {
  startAutomationHeadlessTurn(params: {
    backend: AutomationRecord["backend"];
    agentThreadId: AutomationRecord["threadId"];
    automationName?: string;
    automationRunId: string;
    cwd?: string;
    executionMode?: ThreadExecutionMode;
    fastMode?: boolean;
    input: AppServerTurnInputItem[];
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    mcpAllowlist?: string[];
    toolAllowlist?: string[];
    /**
     * When true, the run delivers via explicit messaging actions, so the
     * messaging controller must NOT broadcast the result/start notice to the
     * Agent thread's bindings (which would double-post the source conversation).
     */
    suppressBindingBroadcast?: boolean;
  }): Promise<{
    headlessThreadId?: string;
    queueEntryId: string;
    threadId: string;
    turnId: string;
  }>;
  interruptTurn(params: {
    backend: AutomationRecord["backend"];
    threadId: string;
    turnId: string;
  }): Promise<unknown>;
};

export class HeadlessAutomationRunner implements AutomationRunner {
  constructor(private readonly launcher: HeadlessAutomationLauncher) {}

  async submitRun(params: {
    automation: AutomationRecord;
    gateResult?: AutomationGateRunResult;
    priorRuns?: AutomationPriorRunContext[];
    run: AutomationRunSummary;
  }): Promise<AutomationRunStartResult> {
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
      cwd: params.automation.executionProfile?.cwd,
      executionMode: params.automation.executionProfile?.executionMode,
      fastMode: params.automation.executionProfile?.fastMode,
      input,
      model: params.automation.executionProfile?.model,
      reasoningEffort: params.automation.executionProfile?.reasoningEffort,
      serviceTier: params.automation.executionProfile?.serviceTier,
      mcpAllowlist: params.automation.executionProfile?.mcpAllowlist,
      toolAllowlist: params.automation.executionProfile?.toolAllowlist,
      suppressBindingBroadcast: automationSuppressesBindingBroadcast(
        params.automation,
      ),
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
      queueEntryId: result.queueEntryId,
      turnId: result.turnId,
    };
  }

  async interruptRun(params: {
    automation: AutomationRecord;
    run: AutomationRunSummary;
  }): Promise<void> {
    const threadId = params.run.backendThreadId;
    const turnId = params.run.backendTurnId;
    if (!threadId || !turnId) return;
    await this.launcher.interruptTurn({
      backend: params.automation.backend,
      threadId,
      turnId,
    });
  }
}
