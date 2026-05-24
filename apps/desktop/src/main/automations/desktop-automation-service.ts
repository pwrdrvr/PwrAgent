import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerNotification,
  AppServerTurnInputItem,
  AutomationDetail,
  AutomationIdRequest,
  AutomationMutationResponse,
  AutomationRunSummary,
  AutomationRunStatus,
  AutomationRunTranscriptEvent,
  AutomationTimelineCard,
  CreateAutomationRequest,
  GetAutomationRunArtifactRequest,
  GetAutomationRunArtifactResponse,
  ListAutomationCardsRequest,
  ListAutomationCardsResponse,
  ListAutomationRunsRequest,
  ListAutomationRunsResponse,
  ListAutomationsRequest,
  ListAutomationsResponse,
  RunAutomationNowResponse,
  UpdateAutomationRequest,
} from "@pwragent/shared";
import { validateAutomationScheduleDefinition } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getDesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getMainLogger } from "../log.js";
import { getAppAutomationStore } from "../state/app-state.js";
import { computeNextAutomationRunAt } from "./automation-schedule.js";
import { ShellAutomationGateRunner } from "./automation-gate-runner.js";
import { parseAutomationOutputDecision } from "./automation-output-decision.js";
import { HeadlessAutomationRunner } from "./automation-runner.js";
import { AutomationScheduler } from "./automation-scheduler.js";
import type { AutomationRecord, AutomationStore } from "./automation-store.js";

const automationServiceLog = getMainLogger("pwragent:automations");

let service: DesktopAutomationService | null = null;
let storeOverride: AutomationStore | null = null;

export function getDesktopAutomationStore(): AutomationStore {
  return storeOverride ?? getAppAutomationStore();
}

export function setDesktopAutomationStoreForTests(store: AutomationStore | null): void {
  storeOverride = store;
}

export function getDesktopAutomationService(
  registry = getDesktopBackendRegistry(),
): DesktopAutomationService {
  if (!service) {
    service = new DesktopAutomationService({
      registry,
      store: getDesktopAutomationStore(),
    });
    service.start();
  }
  return service;
}

export function disposeDesktopAutomationService(): void {
  service?.dispose();
  service = null;
}

export class DesktopAutomationService {
  private readonly scheduler: AutomationScheduler;
  private unsubscribeRegistryEvents?: () => void;

  constructor(
    private readonly options: {
      registry: DesktopBackendRegistry;
      store: AutomationStore;
    },
  ) {
    this.scheduler = new AutomationScheduler({
      store: options.store,
      runner: new HeadlessAutomationRunner(options.registry),
      gateRunner: new ShellAutomationGateRunner(),
    });
    this.reconcileStartupRuns();
  }

  start(): void {
    if (!this.unsubscribeRegistryEvents) {
      this.unsubscribeRegistryEvents = this.options.registry.onEvent((event) =>
        this.handleRegistryEvent(event),
      );
    }
    this.options.registry.setAutomationTurnContextProvider?.((params) =>
      this.buildThreadAutomationContextInput(params),
    );
    this.scheduler.start();
  }

  dispose(): void {
    this.scheduler.stop();
    this.unsubscribeRegistryEvents?.();
    this.unsubscribeRegistryEvents = undefined;
    this.options.registry.setAutomationTurnContextProvider?.(null);
  }

  list(request: ListAutomationsRequest = {}): ListAutomationsResponse {
    const automations =
      request.backend && request.threadId
        ? this.options.store.listAutomationsForThread({
            backend: request.backend,
            threadId: request.threadId,
          })
        : this.options.store.listAutomations().filter((automation) => {
            if (request.backend && automation.backend !== request.backend) return false;
            if (request.threadId && automation.threadId !== request.threadId) return false;
            return true;
          });
    return {
      automations: automations.map((automation) =>
        toAutomationDetail(
          automation,
          this.options.store.getLatestRunForAutomation(automation.id),
        ),
      ),
    };
  }

  listRuns(request: ListAutomationRunsRequest): ListAutomationRunsResponse {
    if (request.automationId) {
      return {
        runs: this.options.store.listRunsForAutomation(
          request.automationId,
          request.limit,
        ),
      };
    }
    if (request.backend && request.threadId) {
      return {
        runs: this.options.store.listRunsForThread({
          backend: request.backend,
          threadId: request.threadId,
          limit: request.limit,
        }),
      };
    }
    return { runs: [] };
  }

  listCards(request: ListAutomationCardsRequest): ListAutomationCardsResponse {
    const cards = this.options.store
      .listRunsForThread({
        backend: request.backend,
        threadId: request.threadId,
        limit: request.limit ?? 50,
      })
      .map((run) => {
        const automation = this.options.store.getAutomation(run.automationId, {
          includeDeleted: true,
        });
        if (!automation) return undefined;
        const artifact = this.options.store.getRunArtifact(run.id);
        return buildAutomationTimelineCard({ automation, artifact, run });
      })
      .filter((card): card is AutomationTimelineCard => Boolean(card));
    return { cards };
  }

  async getRunArtifact(
    request: GetAutomationRunArtifactRequest,
  ): Promise<GetAutomationRunArtifactResponse> {
    const run = this.options.store.getRun(request.runId);
    const automation = run
      ? this.options.store.getAutomation(run.automationId, { includeDeleted: true })
      : undefined;
    const artifact = this.options.store.getRunArtifact(request.runId);
    const rollout =
      run?.backendThreadId && automation
        ? await this.readAutomationRunRollout({
            automation,
            run,
          })
        : undefined;
    return {
      artifact,
      rollout,
    };
  }

  async create(request: CreateAutomationRequest): Promise<AutomationMutationResponse> {
    this.assertValidSchedule(request.schedule);
    await this.assertAgentThreadTarget({
      backend: request.backend,
      threadId: request.threadId,
    });
    const now = Date.now();
    const automation = this.options.store.createAutomation({
      backend: request.backend,
      threadId: request.threadId,
      name: request.name,
      taskPrompt: request.taskPrompt,
      gate: request.gate,
      schedule: request.schedule,
      backlogPolicy: request.backlogPolicy,
      status: request.enabled === false ? "paused" : "enabled",
      nextRunAt:
        request.nextRunAt ??
        (request.enabled === false
          ? undefined
          : computeNextAutomationRunAt(request.schedule, now)),
      now,
    });
    await this.notifyThreadAutomationsUpdated(automation);
    this.scheduler.start();
    return { automation: toAutomationDetail(automation) };
  }

  async update(request: UpdateAutomationRequest): Promise<AutomationMutationResponse> {
    const current = this.options.store.getAutomation(request.automationId);
    if (!current) {
      throw new Error("Automation not found.");
    }
    if (request.schedule) {
      this.assertValidSchedule(request.schedule);
    }
    if ((request.backend === undefined) !== (request.threadId === undefined)) {
      throw new Error("Automation Agent reassignment requires backend and threadId.");
    }
    const reassignment =
      request.backend !== undefined && request.threadId !== undefined
        ? {
            backend: request.backend,
            threadId: request.threadId,
          }
        : undefined;
    const assignmentChanged = Boolean(
      reassignment &&
        (reassignment.backend !== current.backend ||
          reassignment.threadId !== current.threadId),
    );
    if (assignmentChanged && reassignment) {
      await this.assertAgentThreadTarget(reassignment);
    }
    const now = Date.now();
    const schedule = request.schedule ?? current.schedule;
    const enablingFromPaused = request.enabled === true && current.status !== "enabled";
    const disabling = request.enabled === false;
    const shouldRecomputeNextRun =
      request.nextRunAt === undefined &&
      !disabling &&
      (enablingFromPaused || (request.schedule !== undefined && current.status === "enabled"));
    const updated = this.options.store.updateAutomation(request.automationId, {
      backend: reassignment?.backend,
      threadId: reassignment?.threadId,
      name: request.name,
      taskPrompt: request.taskPrompt,
      gate: request.gate,
      schedule: request.schedule,
      backlogPolicy: request.backlogPolicy,
      status:
        request.enabled === undefined
          ? undefined
          : request.enabled
            ? "enabled"
            : "paused",
      nextRunAt:
        request.nextRunAt !== undefined
          ? request.nextRunAt
          : disabling
            ? null
            : shouldRecomputeNextRun
            ? computeNextAutomationRunAt(schedule, now)
            : undefined,
      now,
    });
    if (!updated) throw new Error("Automation not found.");
    if (assignmentChanged) {
      await this.notifyThreadAutomationsUpdated(current);
    }
    await this.notifyThreadAutomationsUpdated(updated);
    this.scheduler.start();
    return { automation: toAutomationDetail(updated) };
  }

  async pause(request: AutomationIdRequest): Promise<AutomationMutationResponse> {
    const automation = this.options.store.updateAutomation(request.automationId, {
      status: "paused",
      nextRunAt: null,
    });
    if (!automation) throw new Error("Automation not found.");
    await this.notifyThreadAutomationsUpdated(automation);
    this.scheduler.start();
    return { automation: toAutomationDetail(automation) };
  }

  async resume(request: AutomationIdRequest): Promise<AutomationMutationResponse> {
    const current = this.options.store.getAutomation(request.automationId);
    if (!current) throw new Error("Automation not found.");
    const automation = this.options.store.resumeAutomation(request.automationId, {
      nextRunAt: computeNextAutomationRunAt(current.schedule, Date.now()),
    });
    if (!automation) throw new Error("Automation not found.");
    await this.notifyThreadAutomationsUpdated(automation);
    this.scheduler.start();
    return { automation: toAutomationDetail(automation) };
  }

  async delete(request: AutomationIdRequest): Promise<AutomationMutationResponse> {
    const pendingQueueEntryIds = this.options.store
      .listPendingOrQueuedRunsForAutomation(request.automationId)
      .map((run) => run.queueEntryId)
      .filter((entryId): entryId is string => Boolean(entryId));
    const automation = this.options.store.deleteAutomation(request.automationId);
    if (!automation) throw new Error("Automation not found.");
    for (const entryId of pendingQueueEntryIds) {
      this.options.registry.cancelQueuedTurn(
        entryId,
        "Automation deleted before the run started.",
      );
    }
    await this.notifyThreadAutomationsUpdated(automation);
    this.scheduler.start();
    return { automation: toAutomationDetail(automation) };
  }

  async runNow(request: AutomationIdRequest): Promise<RunAutomationNowResponse> {
    const result = await this.scheduler.runNow(request.automationId);
    const [run] = this.options.store.listRunsForAutomation(request.automationId, 1);
    if (!run) {
      throw new Error("Automation not found.");
    }
    const automation = this.options.store.getAutomation(request.automationId);
    if (automation) {
      await this.notifyThreadAutomationsUpdated(automation);
    }
    return {
      run,
      queueStatus: result?.status ?? "failed",
      queueEntryId: result?.entry.id,
      turnId: result?.status === "started" ? result.turnId : undefined,
    };
  }

  buildThreadSummaries() {
    return this.options.store.buildThreadSummaries();
  }

  private async handleRegistryEvent(event: AgentEvent): Promise<void> {
    if (event.notification.method !== "thread/turnQueue/updated") {
      await this.captureAutomationRunTranscriptEvent(event);
      if (isTerminalTurnNotification(event.notification)) {
        await this.handleBackendTerminalTurnEvent(event);
      }
      return;
    }
    const params = event.notification.params as {
      threadId: string;
      queueEntryId: string;
      origin: "manual" | "automation" | "messaging";
      status: "queued" | "started" | "failed" | "cancelled" | "terminal";
      position?: number;
      turnId?: string;
      automationRunId?: string;
      errorMessage?: string;
      finalText?: string;
      terminalStatus?: string;
      backendThreadId?: string;
    };
    await this.scheduler.handleTurnQueueUpdate({
      automationRunId: params.automationRunId,
      status: params.status,
      terminalStatus: params.terminalStatus,
      backendThreadId: params.backendThreadId,
      turnId: params.turnId,
      errorMessage: params.errorMessage,
    });
    if (params.automationRunId) {
      await this.publishAutomationRunUpdate({
        backend: event.backend,
        runId: params.automationRunId,
        status: params.status,
        threadId: params.threadId,
        finalText: params.finalText,
        errorMessage: params.errorMessage,
      });
    }
  }

  private async handleBackendTerminalTurnEvent(event: AgentEvent): Promise<void> {
    if (!isTerminalTurnNotification(event.notification)) return;
    const turnId = event.notification.params.turnId ?? event.notification.params.turn.id;
    if (!turnId) return;
    const activeRun = this.options.store.findRunningRunByBackendTurnId({
      backend: event.backend,
      backendTurnId: turnId,
    });
    if (!activeRun) {
      const resolvedRun = this.options.store.findRunByBackendTurnId({
        backend: event.backend,
        backendTurnId: turnId,
      });
      if (resolvedRun && isTerminalAutomationRunStatus(resolvedRun.status)) {
        automationServiceLog.debug("terminal backend turn already resolved automation", {
          backend: event.backend,
          method: event.notification.method,
          runId: resolvedRun.id,
          runStatus: resolvedRun.status,
          threadId: event.notification.params.threadId,
          turnId,
        });
        return;
      }
      automationServiceLog.warn("terminal backend turn did not match a running automation", {
        backend: event.backend,
        method: event.notification.method,
        threadId: event.notification.params.threadId,
        turnId,
      });
      return;
    }

    const finalText = finalTextFromTerminalTurnNotification(event.notification);
    const errorMessage = errorMessageFromTerminalTurnNotification(event.notification);
    await this.scheduler.handleTurnQueueUpdate({
      automationRunId: activeRun.id,
      status: "terminal",
      terminalStatus: event.notification.method,
      turnId,
      errorMessage,
    });
    const automation = this.options.store.getAutomation(activeRun.automationId, {
      includeDeleted: true,
    });
    await this.publishAutomationRunUpdate({
      backend: event.backend,
      runId: activeRun.id,
      status: "terminal",
      threadId: automation?.threadId ?? event.notification.params.threadId,
      finalText,
      errorMessage,
    });
  }

  private async publishAutomationRunUpdate(params: {
    backend: AutomationRecord["backend"];
    runId: string;
    status: "queued" | "started" | "failed" | "cancelled" | "terminal";
    threadId: string;
    finalText?: string;
    errorMessage?: string;
  }): Promise<void> {
    const run = this.options.store.getRun(params.runId);
    if (!run) {
      automationServiceLog.warn("automation run update skipped because run was missing", {
        backend: params.backend,
        runId: params.runId,
        status: params.status,
        threadId: params.threadId,
      });
      return;
    }
    const automation = this.options.store.getAutomation(run.automationId, {
      includeDeleted: true,
    });
    automationServiceLog.info("publishing automation run update", {
      automationId: run.automationId,
      automationName: automation?.name,
      backend: params.backend,
      backendThreadId: run.backendThreadId,
      backendTurnId: run.backendTurnId,
      eventStatus: params.status,
      finalTextLength: params.finalText?.length ?? 0,
      runId: run.id,
      runStatus: run.status,
      threadId: automation?.threadId ?? params.threadId,
    });
    if (shouldRecordRunArtifact(params.status)) {
      const existingArtifact = this.options.store.getRunArtifact(run.id);
      this.options.store.upsertRunArtifact({
        runId: run.id,
        status: run.status,
        finalText: params.finalText,
        errorMessage: params.errorMessage ?? run.errorMessage,
        outputDecision: parseAutomationOutputDecision(params.finalText),
        transcriptEvents: mergeTranscriptEvents(
          existingArtifact?.transcriptEvents ?? [],
          buildRunArtifactTranscript({
            automation,
            run,
            finalText: params.finalText,
            errorMessage: params.errorMessage ?? run.errorMessage,
          }),
        ),
      });
    }
    const artifact = this.options.store.getRunArtifact(run.id);
    await this.options.registry.publishLocalEvent({
      backend: params.backend,
      notification: {
        method: "automation/run/updated",
        params: {
          threadId: automation?.threadId ?? params.threadId,
          automationId: run.automationId,
          automationName: automation?.name,
          finalText: artifact?.finalText,
          outputDecision: artifact?.outputDecision,
          runId: params.runId,
          status: run.status,
        },
      },
    });
    if (automation) {
      await this.notifyThreadAutomationsUpdated(automation);
    }
  }

  private async readAutomationRunRollout(params: {
    automation: AutomationRecord;
    run: AutomationRunSummary;
  }): Promise<GetAutomationRunArtifactResponse["rollout"]> {
    const threadId = params.run.backendThreadId;
    if (!threadId) return undefined;
    if (params.automation.backend === "codex") {
      return {
        backend: params.automation.backend,
        threadId,
        turnId: params.run.backendTurnId,
      };
    }
    try {
      const response = await this.options.registry.readThread({
        backend: params.automation.backend,
        threadId,
        limit: 200,
      });
      return {
        backend: params.automation.backend,
        threadId,
        turnId: params.run.backendTurnId,
        replay: response.replay,
      };
    } catch (error) {
      return {
        backend: params.automation.backend,
        threadId,
        turnId: params.run.backendTurnId,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async captureAutomationRunTranscriptEvent(event: AgentEvent): Promise<void> {
    const turnId = turnIdFromAutomationNotification(event.notification);
    if (!turnId) return;
    const run = this.options.store.findRunningRunByBackendTurnId({
      backend: event.backend,
      backendTurnId: turnId,
    });
    if (!run) return;
    const transcriptEvent = automationTranscriptEventFromBackendEvent({
      event,
      run,
      turnId,
      now: Date.now(),
    });
    if (!transcriptEvent) return;
    automationServiceLog.info("captured automation run transcript event", {
      backend: event.backend,
      eventKind: transcriptEvent.kind,
      method: event.notification.method,
      runId: run.id,
      textLength: transcriptEvent.text?.length ?? 0,
      threadId: notificationThreadId(event.notification),
      turnId,
    });
    this.options.store.appendRunTranscriptEvent({
      runId: run.id,
      event: transcriptEvent,
      now: transcriptEvent.at,
    });
    if (transcriptEvent.kind !== "assistant_final" || !transcriptEvent.text?.trim()) {
      return;
    }

    const finalText = transcriptEvent.text.trim();
    const outputDecision = parseAutomationOutputDecision(finalText);
    if (
      outputDecision?.kind !== "post_card" &&
      outputDecision?.kind !== "quiet"
    ) {
      return;
    }
    automationServiceLog.info("completing automation run from captured assistant final", {
      backend: event.backend,
      outputDecision: outputDecision.kind,
      runId: run.id,
      textLength: finalText.length,
      threadId: notificationThreadId(event.notification),
      turnId,
    });
    await this.scheduler.handleTurnQueueUpdate({
      automationRunId: run.id,
      status: "terminal",
      terminalStatus: "turn/completed",
      turnId,
    });
    const automation = this.options.store.getAutomation(run.automationId, {
      includeDeleted: true,
    });
    await this.publishAutomationRunUpdate({
      backend: event.backend,
      runId: run.id,
      status: "terminal",
      threadId: automation?.threadId ?? notificationThreadId(event.notification) ?? run.id,
      finalText,
    });
  }

  private reconcileStartupRuns(): void {
    const now = Date.now();
    const nextRunAtByAutomationId = Object.fromEntries(
      this.options.store
        .listAutomations()
        .filter((automation) => automation.status === "enabled")
        .map((automation) => [
          automation.id,
          computeNextAutomationRunAt(automation.schedule, now),
        ]),
    );
    this.options.store.reconcileStartup({ now, nextRunAtByAutomationId });
  }

  private buildThreadAutomationContextInput(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): AppServerTurnInputItem[] {
    const lines = this.options.store
      .listRunsForThread({
        backend: params.backend,
        threadId: params.threadId,
        limit: 10,
      })
      .filter((run) =>
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "skipped"
      )
      .slice(0, 5)
      .map((run) => {
        const automation = this.options.store.getAutomation(run.automationId, {
          includeDeleted: true,
        });
        const artifact = this.options.store.getRunArtifact(run.id);
        const when =
          run.completedAt ??
          run.startedAt ??
          run.queuedAt ??
          run.scheduledFor;
        const summary =
          artifact?.outputDecision?.summary ??
          firstLine(artifact?.finalText) ??
          artifact?.errorMessage ??
          run.errorMessage ??
          run.status;
        const details = artifact?.outputDecision?.details;
        return [
          `- ${automation?.name ?? "Automation"} (${run.status}${when ? ` at ${new Date(when).toISOString()}` : ""}): ${summary}`,
          details ? `  Details: ${details}` : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n");
      });
    if (lines.length === 0) {
      return [];
    }
    return [
      {
        type: "text",
        text: [
          "Recent automation updates for this Agent thread:",
          ...lines,
          "These automation updates were delivered out of band and may not appear in the Codex transcript above. Use them when answering questions about automation runs.",
        ].join("\n"),
      },
    ];
  }

  private assertValidSchedule(schedule: CreateAutomationRequest["schedule"]): void {
    const validation = validateAutomationScheduleDefinition(schedule);
    if (!validation.ok) {
      throw new Error(validation.error);
    }
  }

  private async assertAgentThreadTarget(params: {
    backend: AutomationRecord["backend"];
    threadId: AutomationRecord["threadId"];
  }): Promise<void> {
    const agent = await this.options.registry.getThreadAgentMetadata(params);
    if (!agent) {
      throw new Error("Automations must be attached to an Agent thread.");
    }
  }

  private async notifyThreadAutomationsUpdated(
    automation: Pick<AutomationRecord, "backend" | "threadId">,
  ): Promise<void> {
    await this.options.registry.publishLocalEvent({
      backend: automation.backend,
      notification: {
        method: "thread/automations/updated",
        params: {
          threadId: automation.threadId,
        },
      },
    });
  }
}

function toAutomationDetail(
  record: AutomationRecord,
  latestRun?: AutomationRunSummary,
): AutomationDetail {
  const latestRunAt = latestRun ? automationRunActivityAt(latestRun) : undefined;
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
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    deletedAt: record.deletedAt,
  };
}

function automationRunActivityAt(run: AutomationRunSummary): number | undefined {
  return run.completedAt ?? run.startedAt ?? run.queuedAt ?? run.scheduledFor;
}

function shouldRecordRunArtifact(
  status: "queued" | "started" | "failed" | "cancelled" | "terminal",
): boolean {
  return (
    status === "started" ||
    status === "terminal" ||
    status === "failed" ||
    status === "cancelled"
  );
}

type TerminalTurnNotification = Extract<
  AppServerNotification,
  { method: "turn/completed" | "turn/failed" | "turn/cancelled" }
>;

function isTerminalTurnNotification(
  notification: AppServerNotification,
): notification is TerminalTurnNotification {
  return (
    notification.method === "turn/completed" ||
    notification.method === "turn/failed" ||
    notification.method === "turn/cancelled"
  );
}

function finalTextFromTerminalTurnNotification(
  notification: TerminalTurnNotification,
): string | undefined {
  if (notification.method !== "turn/completed") return undefined;
  const text = notification.params.turn.output
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || undefined;
}

function errorMessageFromTerminalTurnNotification(
  notification: TerminalTurnNotification,
): string | undefined {
  if (notification.method !== "turn/failed") return undefined;
  return notification.params.turn.error.message;
}

function buildRunArtifactTranscript(params: {
  automation?: AutomationRecord;
  run: AutomationRunSummary;
  finalText?: string;
  errorMessage?: string;
}): AutomationRunTranscriptEvent[] {
  const at = params.run.completedAt ?? params.run.startedAt ?? Date.now();
  const events: AutomationRunTranscriptEvent[] = [
    {
      id: `${params.run.id}:invocation`,
      at: params.run.startedAt ?? params.run.queuedAt ?? at,
      kind: "invocation",
      text: params.automation?.taskPrompt
        ? `Submitted automation prompt:\n${params.automation.taskPrompt}`
        : undefined,
      metadata: {
        automationName: params.automation?.name,
        backendThreadId: params.run.backendThreadId,
        backendTurnId: params.run.backendTurnId,
        backlogPolicy: params.automation?.backlogPolicy,
        scheduleSummary: params.automation?.scheduleSummary,
        trigger: params.run.trigger,
        scheduledFor: params.run.scheduledFor,
        scheduledWindows: params.run.scheduledWindows,
      },
    },
  ];
  if (params.finalText) {
    events.push({
      id: `${params.run.id}:assistant-final`,
      at,
      kind: "assistant_final",
      text: params.finalText,
    });
  }
  if (params.errorMessage) {
    events.push({
      id: `${params.run.id}:error`,
      at,
      kind: "error",
      text: params.errorMessage,
    });
  }
  if (isTerminalAutomationRunStatus(params.run.status)) {
    events.push({
      id: `${params.run.id}:terminal`,
      at,
      kind: "lifecycle",
      metadata: {
        status: params.run.status,
        backendTurnId: params.run.backendTurnId,
      },
    });
  }
  return events;
}

function isTerminalAutomationRunStatus(status: AutomationRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function automationTranscriptEventFromBackendEvent(params: {
  event: AgentEvent;
  run: AutomationRunSummary;
  turnId: string;
  now: number;
}): AutomationRunTranscriptEvent | undefined {
  const notification = params.event.notification;
  if (notification.method === "item/agentMessage/delta") {
    const deltaParams = notification.params as {
      delta?: unknown;
      itemId?: unknown;
      phase?: unknown;
    };
    const delta = typeof deltaParams.delta === "string" ? deltaParams.delta.trim() : "";
    if (!delta) return undefined;
    return {
      id: `${params.run.id}:delta:${String(deltaParams.itemId ?? "message")}`,
      at: params.now,
      kind: "lifecycle",
      text: delta,
      metadata: {
        phase: deltaParams.phase,
        source: "item/agentMessage/delta",
        turnId: params.turnId,
      },
    };
  }

  if (notification.method === "item/completed") {
    const completedParams = notification.params as { item?: unknown };
    const item = asAutomationItem(completedParams.item);
    if (!item) return undefined;
    if (item.type === "agentMessage" && item.text?.trim()) {
      return {
        id: `${params.run.id}:assistant:${item.id}`,
        at: params.now,
        kind: "assistant_final",
        text: item.text.trim(),
        metadata: {
          source: "item/completed",
          turnId: params.turnId,
        },
      };
    }

    const toolSummary = automationToolSummary(item);
    if (toolSummary) {
      return {
        id: `${params.run.id}:tool:${item.id}`,
        at: params.now,
        kind: "lifecycle",
        text: toolSummary,
        metadata: {
          item,
          source: "item/completed",
          turnId: params.turnId,
        },
      };
    }
  }

  if (notification.method === "turn/plan/updated") {
    const planParams = notification.params as {
      plan?: {
        steps?: Array<{ status?: string; step?: string }>;
      };
    };
    const markdown = (planParams.plan?.steps ?? [])
      .map((step) => `${step.status}: ${step.step}`)
      .join("\n");
    if (!markdown.trim()) return undefined;
    return {
      id: `${params.run.id}:plan:${params.turnId}`,
      at: params.now,
      kind: "lifecycle",
      text: markdown,
      metadata: {
        source: "turn/plan/updated",
        turnId: params.turnId,
      },
    };
  }

  return undefined;
}

function turnIdFromAutomationNotification(
  notification: AppServerNotification,
): string | undefined {
  const params = notification.params as {
    turn?: { id?: string | null };
    turnId?: string | null;
  };
  return params.turnId ?? params.turn?.id ?? undefined;
}

function notificationThreadId(notification: AppServerNotification): string | undefined {
  const threadId = (notification.params as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

type AutomationNotificationItem = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  success?: boolean;
  toolName?: string;
};

function asAutomationItem(value: unknown): AutomationNotificationItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.type !== "string") {
    return undefined;
  }
  return {
    id: record.id,
    type: record.type,
    command: typeof record.command === "string" ? record.command : undefined,
    success: typeof record.success === "boolean" ? record.success : undefined,
    text: typeof record.text === "string" ? record.text : undefined,
    toolName: typeof record.toolName === "string" ? record.toolName : undefined,
  };
}

function automationToolSummary(
  item: AutomationNotificationItem,
): string | undefined {
  const type = item.type.toLowerCase();
  if (type === "agentmessage") return undefined;
  if (item.command?.trim()) {
    return `${item.success === false ? "Failed" : "Ran"}: ${item.command.trim()}`;
  }
  if (item.toolName?.trim()) {
    return `${item.success === false ? "Failed" : "Used"} tool: ${item.toolName.trim()}`;
  }
  if (item.text?.trim()) {
    return item.text.trim();
  }
  if (
    type.includes("command") ||
    type.includes("tool") ||
    type.includes("search") ||
    type.includes("file")
  ) {
    return `${item.success === false ? "Failed" : "Completed"} ${item.type}`;
  }
  return undefined;
}

function mergeTranscriptEvents(
  existing: AutomationRunTranscriptEvent[],
  incoming: AutomationRunTranscriptEvent[],
): AutomationRunTranscriptEvent[] {
  const byId = new Map<string, AutomationRunTranscriptEvent>();
  for (const event of existing) {
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((left, right) => left.at - right.at);
}

function buildAutomationTimelineCard(params: {
  automation: AutomationRecord;
  artifact?: ReturnType<AutomationStore["getRunArtifact"]>;
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
  artifact?: ReturnType<AutomationStore["getRunArtifact"]>;
  run: AutomationRunSummary;
}): string {
  const summary =
    params.artifact?.outputDecision?.summary ??
    firstLine(params.artifact?.finalText) ??
    params.artifact?.errorMessage ??
    params.run.errorMessage;
  if (summary) {
    return `${params.automation.name}: ${summary}`;
  }
  if (params.run.status === "completed") {
    return `${params.automation.name}: completed`;
  }
  return `${params.automation.name}: ${params.run.status}`;
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split(/\r?\n/).find((candidate) => candidate.trim());
  return line?.trim();
}
