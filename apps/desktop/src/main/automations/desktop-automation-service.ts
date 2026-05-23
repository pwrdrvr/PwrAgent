import type {
  AgentEvent,
  AutomationDetail,
  AutomationIdRequest,
  AutomationMutationResponse,
  AutomationRunSummary,
  AutomationRunOutputDecision,
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
import { getAppAutomationStore } from "../state/app-state.js";
import { computeNextAutomationRunAt } from "./automation-schedule.js";
import { ShellAutomationGateRunner } from "./automation-gate-runner.js";
import { HeadlessAutomationRunner } from "./automation-runner.js";
import { AutomationScheduler } from "./automation-scheduler.js";
import type { AutomationRecord, AutomationStore } from "./automation-store.js";

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
    this.scheduler.start();
  }

  dispose(): void {
    this.scheduler.stop();
    this.unsubscribeRegistryEvents?.();
    this.unsubscribeRegistryEvents = undefined;
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
      automations: automations.map(toAutomationDetail),
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

  getRunArtifact(
    request: GetAutomationRunArtifactRequest,
  ): GetAutomationRunArtifactResponse {
    return {
      artifact: this.options.store.getRunArtifact(request.runId),
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
    const now = Date.now();
    const schedule = request.schedule ?? current.schedule;
    const enablingFromPaused = request.enabled === true && current.status !== "enabled";
    const disabling = request.enabled === false;
    const shouldRecomputeNextRun =
      request.nextRunAt === undefined &&
      !disabling &&
      (enablingFromPaused || (request.schedule !== undefined && current.status === "enabled"));
    const updated = this.options.store.updateAutomation(request.automationId, {
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
    if (event.notification.method !== "thread/turnQueue/updated") return;
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
    };
    await this.scheduler.handleTurnQueueUpdate({
      automationRunId: params.automationRunId,
      status: params.status,
      terminalStatus: params.terminalStatus,
      turnId: params.turnId,
      errorMessage: params.errorMessage,
    });
    if (params.automationRunId) {
      const run = this.options.store.getRun(params.automationRunId);
      if (!run) return;
      const automation = run
        ? this.options.store.getAutomation(run.automationId, { includeDeleted: true })
        : undefined;
      if (shouldRecordRunArtifact(params.status)) {
        this.options.store.upsertRunArtifact({
          runId: run.id,
          status: run.status,
          finalText: params.finalText,
          errorMessage: params.errorMessage ?? run.errorMessage,
          outputDecision: parseAutomationOutputDecision(params.finalText),
          transcriptEvents: buildRunArtifactTranscript({
            run,
            finalText: params.finalText,
            errorMessage: params.errorMessage ?? run.errorMessage,
          }),
        });
      }
      await this.options.registry.publishLocalEvent({
        backend: event.backend,
        notification: {
          method: "automation/run/updated",
          params: {
            threadId: params.threadId,
            automationId: run.automationId,
            runId: params.automationRunId,
            status: run.status,
          },
        },
      });
      if (automation) {
        await this.notifyThreadAutomationsUpdated(automation);
      }
    }
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

function toAutomationDetail(record: AutomationRecord): AutomationDetail {
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
    lastRunAt: record.lastRunAt,
    lastRunStatus: record.lastRunStatus,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    deletedAt: record.deletedAt,
  };
}

function shouldRecordRunArtifact(
  status: "queued" | "started" | "failed" | "cancelled" | "terminal",
): boolean {
  return status === "terminal" || status === "failed" || status === "cancelled";
}

function buildRunArtifactTranscript(params: {
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
      metadata: {
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
  events.push({
    id: `${params.run.id}:terminal`,
    at,
    kind: "lifecycle",
    metadata: {
      status: params.run.status,
      backendTurnId: params.run.backendTurnId,
    },
  });
  return events;
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

function parseAutomationOutputDecision(
  finalText: string | undefined,
): AutomationRunOutputDecision | undefined {
  if (!finalText?.trim()) return undefined;
  const candidate = extractJsonObject(finalText);
  if (!candidate) {
    return {
      kind: "parse_failed",
      summary: firstLine(finalText),
    };
  }
  try {
    const parsed = JSON.parse(candidate) as {
      decision?: unknown;
      post_card?: unknown;
      summary?: unknown;
    };
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : firstLine(finalText);
    if (parsed.decision === "quiet" || parsed.post_card === false) {
      return { kind: "quiet", summary };
    }
    if (parsed.decision === "post_card" || parsed.post_card === true) {
      return { kind: "post_card", summary: summary ?? "Automation completed." };
    }
    return {
      kind: "parse_failed",
      summary,
    };
  } catch {
    return {
      kind: "parse_failed",
      summary: firstLine(finalText),
    };
  }
}

function extractJsonObject(value: string): string | undefined {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) {
    return fenced;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return undefined;
}
