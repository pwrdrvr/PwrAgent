import type {
  AgentEvent,
  AutomationDetail,
  AutomationIdRequest,
  AutomationMutationResponse,
  CreateAutomationRequest,
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
