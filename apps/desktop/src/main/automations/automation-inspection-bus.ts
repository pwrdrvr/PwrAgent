import type {
  AutomationDetail,
  AutomationInspectionArtifact,
  AutomationInspectionAutomationSummary,
  AutomationInspectionContext,
  AutomationInspectionFailure,
  AutomationInspectionOperationName,
  AutomationInspectionRequest,
  AutomationInspectionResponse,
  AutomationInspectionRunDetail,
  AutomationInspectionRunSummary,
  AutomationInspectionToolArgsByOperation,
  AutomationInspectionToolDataByOperation,
  AutomationInspectionToolData,
  AutomationRunArtifact,
  AutomationRunStatus,
  AutomationRunSummary,
  AutomationTimelineCard,
} from "@pwragent/shared";
import {
  isAutomationInspectionOperationName,
  normalizeAutomationInspectionEventLimit,
  normalizeAutomationInspectionRunLimit,
  normalizeAutomationInspectionTextLimitChars,
} from "@pwragent/shared";
import type { AutomationRecord, AutomationStore } from "./automation-store.js";

export class AutomationInspectionBus {
  constructor(private readonly store: AutomationStore) {}

  inspect(request: AutomationInspectionRequest): AutomationInspectionResponse {
    const operation = request.operation;
    try {
      if (!isAutomationInspectionOperationName(operation)) {
        return failure(operation, "unsupported_operation", "Unsupported automation inspection operation.");
      }
      switch (operation) {
        case "list_automations":
          return success(
            operation,
            this.listAutomations(request.context, request.args),
          );
        case "summarize_automation_status":
          return success(
            operation,
            this.summarizeAutomationStatus(request.context, request.args),
          );
        case "list_automation_runs":
          return success(
            operation,
            this.listAutomationRuns(request.context, request.args),
          );
        case "get_automation_run":
          return success(
            operation,
            this.getAutomationRun(request.context, request.args),
          );
        case "get_automation_run_artifact":
          return success(
            operation,
            this.getAutomationRunArtifact(request.context, request.args),
          );
        default:
          return failure(operation, "unsupported_operation", "Unsupported automation inspection operation.");
      }
    } catch (error) {
      return failure(
        operation,
        error instanceof AutomationInspectionError ? error.code : "internal_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private listAutomations(
    context: AutomationInspectionContext,
    args: AutomationInspectionToolArgsByOperation["list_automations"],
  ): AutomationInspectionToolDataByOperation["list_automations"] {
    const limit = normalizeAutomationInspectionRunLimit(args.limit);
    const automations = this.store
      .listAutomationsForThread({
        backend: context.backend,
        threadId: context.threadId,
      })
      .filter((automation) => args.includePaused !== false || automation.status !== "paused");
    return {
      automations: automations
        .slice(0, limit)
        .map((automation) => this.toAutomationSummary(automation)),
      truncated: automations.length > limit || undefined,
    };
  }

  private summarizeAutomationStatus(
    context: AutomationInspectionContext,
    args: AutomationInspectionToolArgsByOperation["summarize_automation_status"],
  ): AutomationInspectionToolDataByOperation["summarize_automation_status"] {
    const list = this.listAutomations(context, {
      includePaused: true,
      limit: args.limit,
    });
    const runs = this.listAutomationRuns(context, {
      limit: args.limit,
      since: args.since,
    });
    return {
      summary: summarizeStatus(list.automations, runs.runs),
      automations: list.automations,
      recentRuns: runs.runs,
      truncated: list.truncated || runs.truncated || undefined,
    };
  }

  private listAutomationRuns(
    context: AutomationInspectionContext,
    args: AutomationInspectionToolArgsByOperation["list_automation_runs"],
  ): AutomationInspectionToolDataByOperation["list_automation_runs"] {
    const limit = normalizeAutomationInspectionRunLimit(args.limit);
    const requestedAutomation = args.automationId
      ? this.getScopedAutomation(args.automationId, context)
      : undefined;
    const candidateRuns = requestedAutomation
      ? this.store.listRunsForAutomation(requestedAutomation.id, limit * 4)
      : this.store.listRunsForThread({
          backend: context.backend,
          threadId: context.threadId,
          limit: limit * 4,
        });
    const statuses = new Set(args.statuses ?? []);
    const runs = candidateRuns.filter((run) => {
      const activityAt = runActivityAt(run) ?? 0;
      if (args.since !== undefined && activityAt < args.since) {
        return false;
      }
      if (statuses.size > 0 && !statuses.has(run.status)) {
        return false;
      }
      return this.isRunInScope(run, context);
    });
    return {
      runs: runs.slice(0, limit).map((run) => this.toRunSummary(run)),
      truncated: runs.length > limit || undefined,
    };
  }

  private getAutomationRun(
    context: AutomationInspectionContext,
    args: AutomationInspectionToolArgsByOperation["get_automation_run"],
  ): AutomationInspectionToolDataByOperation["get_automation_run"] {
    const run = this.getScopedRun(args.runId, context);
    return {
      run: this.toRunDetail(run),
    };
  }

  private getAutomationRunArtifact(
    context: AutomationInspectionContext,
    args: AutomationInspectionToolArgsByOperation["get_automation_run_artifact"],
  ): AutomationInspectionToolDataByOperation["get_automation_run_artifact"] {
    const run = this.getScopedRun(args.runId, context);
    const artifact = this.store.getRunArtifact(run.id);
    if (!artifact) {
      throw new AutomationInspectionError("not_found", "Automation run artifact not found.");
    }
    const automation = this.getScopedAutomation(run.automationId, context);
    return {
      artifact: this.toArtifact({
        artifact,
        automation,
        eventLimit: normalizeAutomationInspectionEventLimit(args.eventLimit),
        textLimitChars: normalizeAutomationInspectionTextLimitChars(
          args.textLimitChars,
        ),
        run,
      }),
    };
  }

  private getScopedAutomation(
    automationId: string,
    context: AutomationInspectionContext,
    options: { includeDeleted?: boolean } = {},
  ): AutomationRecord {
    const automation = this.store.getAutomation(automationId, {
      includeDeleted: options.includeDeleted,
    });
    if (!automation) {
      throw new AutomationInspectionError("not_found", "Automation not found.");
    }
    if (automation.backend !== context.backend || automation.threadId !== context.threadId) {
      throw new AutomationInspectionError(
        "forbidden",
        "Automation is not attached to this Agent thread.",
      );
    }
    return automation;
  }

  private getScopedRun(
    runId: string,
    context: AutomationInspectionContext,
  ): AutomationRunSummary {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new AutomationInspectionError("not_found", "Automation run not found.");
    }
    if (!this.isRunInScope(run, context)) {
      throw new AutomationInspectionError(
        "forbidden",
        "Automation run is not attached to this Agent thread.",
      );
    }
    return run;
  }

  private isRunInScope(
    run: AutomationRunSummary,
    context: AutomationInspectionContext,
  ): boolean {
    const automation = this.store.getAutomation(run.automationId);
    return Boolean(
      automation &&
        automation.backend === context.backend &&
        automation.threadId === context.threadId,
    );
  }

  private toAutomationSummary(
    automation: AutomationRecord,
  ): AutomationInspectionAutomationSummary {
    const latestRun = this.store.getLatestRunForAutomation(automation.id);
    return {
      ...toAutomationDetail(automation, latestRun),
      latestRun: latestRun ? this.toRunSummary(latestRun) : undefined,
    };
  }

  private toRunSummary(run: AutomationRunSummary): AutomationInspectionRunSummary {
    const automation = this.store.getAutomation(run.automationId);
    const artifact = this.store.getRunArtifact(run.id);
    return {
      ...run,
      automationName: automation?.name,
      automationStatus: automation?.status,
      automationBacklogPolicy: automation?.backlogPolicy,
      outputDecisionKind: artifact?.outputDecision?.kind,
      outputSummary: summarizeRunOutput(run, artifact),
    };
  }

  private toRunDetail(run: AutomationRunSummary): AutomationInspectionRunDetail {
    const automation = this.store.getAutomation(run.automationId);
    return {
      ...this.toRunSummary(run),
      automation: automation ? this.toAutomationSummary(automation) : undefined,
    };
  }

  private toArtifact(params: {
    artifact: AutomationRunArtifact;
    automation: AutomationRecord;
    eventLimit: number;
    textLimitChars: number;
    run: AutomationRunSummary;
  }): AutomationInspectionArtifact {
    const transcriptEvents = params.artifact.transcriptEvents.slice(
      0,
      params.eventLimit,
    );
    const finalText = truncateText(params.artifact.finalText, params.textLimitChars);
    const details = truncateText(
      params.artifact.outputDecision?.details,
      params.textLimitChars,
    );
    const outputDecision = params.artifact.outputDecision
      ? {
          ...params.artifact.outputDecision,
          details: details.value,
        }
      : undefined;
    const boundedArtifact = {
      ...params.artifact,
      finalText: finalText.value,
      outputDecision,
    };
    return {
      ...boundedArtifact,
      transcriptEvents,
      transcriptEventsTruncated:
        params.artifact.transcriptEvents.length > transcriptEvents.length || undefined,
      finalTextTruncated: finalText.truncated || undefined,
      detailsTextTruncated: details.truncated || undefined,
      card: buildAutomationTimelineCard({
        automation: params.automation,
        artifact: boundedArtifact,
        run: params.run,
      }),
    };
  }
}

class AutomationInspectionError extends Error {
  constructor(
    readonly code: AutomationInspectionFailure["error"]["code"],
    message: string,
  ) {
    super(message);
  }
}

function success<TOperation extends AutomationInspectionOperationName>(
  operation: TOperation,
  data: AutomationInspectionToolData<TOperation>,
): AutomationInspectionResponse<TOperation> {
  return {
    ok: true,
    operation,
    data,
  };
}

function failure<TOperation extends AutomationInspectionOperationName>(
  operation: TOperation,
  code: AutomationInspectionFailure["error"]["code"],
  message: string,
): AutomationInspectionFailure<TOperation> {
  return {
    ok: false,
    operation,
    error: {
      code,
      message,
    },
  };
}

function toAutomationDetail(
  record: AutomationRecord,
  latestRun?: AutomationRunSummary,
): AutomationDetail {
  const latestRunAt = latestRun ? runActivityAt(latestRun) : undefined;
  const useLatestRun =
    latestRun !== undefined &&
    latestRunAt !== undefined &&
    (record.lastRunAt === undefined || latestRunAt >= record.lastRunAt);
  return {
    id: record.id,
    backend: record.backend,
    threadId: record.threadId,
    name: record.name,
    taskPrompt: record.taskPrompt,
    gate: record.gate,
    status: record.status,
    schedule: record.schedule,
    scheduleSummary: record.scheduleSummary,
    backlogPolicy: record.backlogPolicy,
    nextRunAt: record.nextRunAt,
    lastRunAt: useLatestRun ? latestRunAt : record.lastRunAt,
    lastRunStatus: useLatestRun ? latestRun.status : record.lastRunStatus,
    pendingRunCount: undefined,
    coalescedWindowCount: undefined,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    deletedAt: record.deletedAt,
  };
}

function summarizeStatus(
  automations: AutomationInspectionAutomationSummary[],
  recentRuns: AutomationInspectionRunSummary[],
): string {
  if (automations.length === 0) {
    return "No automations are attached to this Agent thread.";
  }
  const enabled = automations.filter((automation) => automation.status === "enabled").length;
  const paused = automations.filter((automation) => automation.status === "paused").length;
  const running = recentRuns.filter((run) => run.status === "running").length;
  const latest = recentRuns[0];
  return [
    `${automations.length} automation${automations.length === 1 ? "" : "s"} attached`,
    `${enabled} enabled`,
    `${paused} paused`,
    running > 0 ? `${running} running` : undefined,
    latest
      ? `latest ${latest.automationName ?? "automation"} run ${latest.status}`
      : "no recent runs",
  ]
    .filter((part): part is string => Boolean(part))
    .join("; ");
}

function summarizeRunOutput(
  run: AutomationRunSummary,
  artifact: AutomationRunArtifact | undefined,
): string | undefined {
  return (
    artifact?.outputDecision?.summary ??
    firstLine(artifact?.finalText) ??
    artifact?.errorMessage ??
    run.errorMessage
  );
}

function buildAutomationTimelineCard(params: {
  automation: AutomationRecord;
  artifact?: AutomationRunArtifact;
  run: AutomationRunSummary;
}): AutomationTimelineCard | undefined {
  const notable =
    params.run.trigger === "manual" ||
    params.run.status === "failed" ||
    params.run.status === "cancelled" ||
    params.artifact?.outputDecision?.kind === "post_card" ||
    params.artifact?.outputDecision?.kind === "parse_failed" ||
    (!params.artifact?.outputDecision && Boolean(params.artifact?.finalText));
  if (!notable) return undefined;
  return {
    id: `automation-card:${params.run.id}`,
    backend: params.automation.backend,
    threadId: params.automation.threadId,
    automationId: params.automation.id,
    automationName: params.automation.name,
    runId: params.run.id,
    status: params.run.status,
    summary: summarizeAutomationCard(params),
    details: params.artifact?.outputDecision?.details,
    occurredAt:
      params.run.completedAt ??
      params.run.startedAt ??
      params.run.queuedAt ??
      params.run.scheduledFor ??
      Date.now(),
  };
}

function summarizeAutomationCard(params: {
  automation: AutomationRecord;
  artifact?: AutomationRunArtifact;
  run: AutomationRunSummary;
}): string {
  const summary = summarizeRunOutput(params.run, params.artifact);
  if (summary) {
    return `${params.automation.name}: ${summary}`;
  }
  if (params.run.status === "completed") {
    return `${params.automation.name}: completed`;
  }
  return `${params.automation.name}: ${params.run.status}`;
}

function runActivityAt(run: AutomationRunSummary): number | undefined {
  return run.completedAt ?? run.startedAt ?? run.queuedAt ?? run.scheduledFor;
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split(/\r?\n/).find((candidate) => candidate.trim());
  return line?.trim();
}

function truncateText(
  value: string | undefined,
  limit: number,
): { value?: string; truncated: boolean } {
  if (value === undefined || value.length <= limit) {
    return { value, truncated: false };
  }
  return {
    value: value.slice(0, limit),
    truncated: true,
  };
}
