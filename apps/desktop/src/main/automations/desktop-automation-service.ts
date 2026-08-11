import type {
  AgentEvent,
  AppServerNotification,
  AutomationDetail,
  AutomationInspectionFailure,
  AutomationInspectionErrorCode,
  AutomationInspectionResponse,
  AutomationIdRequest,
  AutomationLoadIssue,
  AutomationMutationResponse,
  AutomationRunSummary,
  AutomationRunStatus,
  AutomationRunUsage,
  AutomationRunTranscriptEvent,
  AutomationTimelineCard,
  AutomationTriggerDefinition,
  CreateAutomationRequest,
  GetAutomationRunArtifactRequest,
  GetAutomationRunArtifactResponse,
  ListAutomationCardsRequest,
  ListAutomationCardsResponse,
  ListAutomationRunsRequest,
  ListAutomationRunsResponse,
  ListAutomationReplayCandidatesRequest,
  ListAutomationReplayCandidatesResponse,
  ListAutomationsRequest,
  ListAutomationsResponse,
  InboundPreviewMessage,
  MessagingChannelKind,
  MessagingSenderSuggestion,
  ReplayAutomationInboundRequest,
  RunAutomationNowResponse,
  SearchMessagingSendersRequest,
  SearchMessagingSendersResponse,
  UpdateAutomationRequest,
} from "@pwragent/shared";
import type {
  MessagingDirectoryActor,
  MessagingInboundEvent,
} from "@pwragent/messaging-interface";
import {
  automationSuppressesBindingBroadcast,
  validateAutomationScheduleDefinition,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getDesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getMainLogger } from "../log.js";
import { resolveRuntimeAutomationsOverride } from "../runtime-flags.js";
import { getAppAutomationStore } from "../state/app-state.js";
import { AutomationInspectionBus } from "./automation-inspection-bus.js";
import {
  buildPendingDeliveryActionResults,
  executeAutomationOutputActions,
} from "./automation-action-executor.js";
import { computeNextAutomationRunAt } from "./automation-schedule.js";
import { ShellAutomationGateRunner } from "./automation-gate-runner.js";
import { parseAutomationOutputDecision } from "./automation-output-decision.js";
import { HeadlessAutomationRunner } from "./automation-runner.js";
import { AutomationScheduler } from "./automation-scheduler.js";
import type { AutomationRecord, AutomationStore } from "./automation-store.js";
import {
  anyAutomationInboundMatch,
  buildAutomationReplayCandidates,
  buildReplayRunSourceMetadata,
  matchAutomationInboundEvent,
} from "./automation-trigger-matcher.js";
import { mergeTranscriptEvents } from "./transcript-merge.js";

const automationServiceLog = getMainLogger("pwragent:automations");

/**
 * How long past-run sender actors stay cached. `searchSenders` runs per
 * debounced keystroke, so re-reading run rows per character is wasted work for
 * a set that only changes when a run completes.
 */
const RUN_ACTOR_CACHE_TTL_MS = 30_000;
/** Runs scanned for distinct actors. Bounds the read on a long-lived automation. */
const RUN_ACTOR_SCAN_LIMIT = 200;

/**
 * How long a changed usage snapshot may sit in memory before its sqlite
 * write. One second matches the registry's live token-usage flush window:
 * pricing stays responsive while a streaming turn's repeated updates share
 * one payload rewrite instead of taking one commit each.
 */
const RUN_USAGE_FLUSH_INTERVAL_MS = 1_000;

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
    const runtimeOverride = resolveRuntimeAutomationsOverride();
    service = new DesktopAutomationService({
      registry,
      runtime: {
        disabled: runtimeOverride.disabled,
        disabledReason: runtimeOverride.reason,
      },
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
  private readonly inspectionBus: AutomationInspectionBus;
  private unsubscribeRegistryEvents?: () => void;
  private readonly runActorCache = new Map<
    string,
    { actors: MessagingDirectoryActor[]; readAt: number }
  >();
  private readonly automationsChangedListeners = new Set<() => void>();
  /**
   * Latest usage snapshot per run, waiting for one sqlite write. Pricing
   * events carry cumulative totals, so repeated observations for a run
   * replace each other in memory and only the newest needs to be durable —
   * the same shape as the registry's live token-usage batching (PR #1417),
   * at automation scale. Best-effort, not banking: a crash inside the flush
   * window loses at most the last in-flight snapshot of a cost estimate.
   */
  private readonly pendingRunUsage = new Map<string, AutomationRunUsage>();
  private pendingRunUsageTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      registry: DesktopBackendRegistry;
      runtime?: {
        disabled?: boolean;
        disabledReason?: string;
      };
      store: AutomationStore;
    },
  ) {
    this.scheduler = new AutomationScheduler({
      store: options.store,
      runner: new HeadlessAutomationRunner(options.registry),
      gateRunner: new ShellAutomationGateRunner(),
    });
    this.inspectionBus = new AutomationInspectionBus(options.store);
  }

  start(): void {
    this.options.registry.setAutomationInspectionHandler?.(async (request) => {
      const agent = await this.options.registry.getThreadAgentMetadata({
        backend: request.context.backend,
        threadId: request.context.threadId,
      });
      if (!agent) {
        const response = automationInspectionFailure(
          request.operation,
          "forbidden",
          "Automation inspection is only available to Agent threads.",
        );
        automationServiceLog.info("automation inspection request denied", {
          backend: request.context.backend,
          errorCode: "forbidden",
          ok: response.ok,
          operation: request.operation,
          threadId: request.context.threadId,
        });
        return response;
      }
      const response = this.inspectionBus.inspect(request);
      const payload = response.ok ? response.data : response.error;
      automationServiceLog.info("automation inspection request handled", {
        backend: request.context.backend,
        errorCode: response.ok ? undefined : response.error.code,
        ok: response.ok,
        operation: request.operation,
        resultBytes: JSON.stringify(payload).length,
        threadId: request.context.threadId,
      });
      return response;
    });
    if (this.options.runtime?.disabled) {
      automationServiceLog.info("automation scheduler disabled for this app instance", {
        reason: this.options.runtime.disabledReason,
      });
      return;
    }
    if (!this.unsubscribeRegistryEvents) {
      this.unsubscribeRegistryEvents = this.options.registry.onEvent((event) =>
        this.handleRegistryEvent(event),
      );
    }
    this.reconcileStartupRuns();
    this.scheduler.start();
  }

  dispose(): void {
    this.scheduler.stop();
    this.unsubscribeRegistryEvents?.();
    this.unsubscribeRegistryEvents = undefined;
    if (this.pendingRunUsageTimer) {
      clearTimeout(this.pendingRunUsageTimer);
      this.pendingRunUsageTimer = undefined;
    }
    this.flushPendingRunUsage();
    this.options.registry.setAutomationInspectionHandler?.(null);
  }

  /**
   * Automations the store couldn't load this process lifetime (corrupt payload,
   * or a schedule/trigger shape this build predates). Surfaced to the renderer
   * so the user sees a warning instead of silently missing automations.
   */
  /**
   * Fires after any mutation that can change which conversations inbound
   * automations watch (create/update/pause/resume/delete). The messaging
   * runtime subscribes to keep adapters' observed-conversation sets current.
   */
  onAutomationsChanged(listener: () => void): () => void {
    this.automationsChangedListeners.add(listener);
    return () => {
      this.automationsChangedListeners.delete(listener);
    };
  }

  private notifyAutomationsChanged(): void {
    for (const listener of [...this.automationsChangedListeners]) {
      try {
        listener();
      } catch {
        // A broken listener must not break the mutation that fired it.
      }
    }
  }

  getLoadIssues(): AutomationLoadIssue[] {
    return this.options.store.getAutomationLoadIssues();
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
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    return {
      automations: automations.map((automation) =>
        toAutomationDetail(
          automation,
          this.options.store.getLatestRunForAutomation(automation.id),
          this.sumRunCostSince(automation.id, todayMs),
        ),
      ),
    };
  }

  /**
   * Summed run cost since `sinceMs`, from retained runs. This is honest only
   * within the run-history window — a lifetime total needs a denormalized
   * counter that survives pruning, which is a schema change deferred on
   * purpose.
   */
  private sumRunCostSince(automationId: string, sinceMs: number): number | undefined {
    let total = 0;
    let sawCost = false;
    for (const run of this.options.store.listRunsForAutomation(automationId, 200)) {
      const at = run.completedAt ?? run.startedAt;
      if (at === undefined || at < sinceMs) continue;
      if (typeof run.usage?.totalCostMicros === "number") {
        total += run.usage.totalCostMicros;
        sawCost = true;
      }
    }
    return sawCost ? total : undefined;
  }

  /**
   * Candidate senders for the inbound filter picker, merged from every source
   * we have: actors seen in past runs of this automation, and the provider's
   * own directory.
   *
   * Ordering is deliberate — observed senders first, directory last. Someone
   * who has actually posted in the conversation is far more likely to be the
   * intended target than a name that merely exists in the workspace, and the
   * whole point of this control is that an operator should never have to go
   * hunting for a platform id.
   */
  async searchSenders(
    request: SearchMessagingSendersRequest,
    deps: {
      searchDirectory: (params: {
        provider: MessagingChannelKind;
        conversationId?: string;
        query: string;
        limit?: number;
      }) => Promise<{
        actors: MessagingDirectoryActor[];
        label?: string;
        supported: boolean;
        truncated?: boolean;
      }>;
    },
  ): Promise<SearchMessagingSendersResponse> {
    const limit = Math.max(1, Math.min(request.limit ?? 20, 50));
    const query = request.query.trim().toLowerCase();
    const matches = (actor: {
      platformUserId: string;
      displayName?: string;
      username?: string;
    }): boolean =>
      query.length === 0
      || actor.displayName?.toLowerCase().includes(query) === true
      || actor.username?.toLowerCase().includes(query) === true
      || actor.platformUserId.toLowerCase() === query;

    const suggestions: MessagingSenderSuggestion[] = [];
    const seen = new Set<string>();
    const add = (
      actor: {
        platformUserId: string;
        displayName?: string;
        username?: string;
        isBot?: boolean;
      },
      source: MessagingSenderSuggestion["source"],
    ): void => {
      if (seen.has(actor.platformUserId)) return;
      if (!matches(actor)) return;
      seen.add(actor.platformUserId);
      suggestions.push({
        platformUserId: actor.platformUserId,
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
        ...(actor.username ? { username: actor.username } : {}),
        ...(actor.isBot ? { isBot: true } : {}),
        source,
      });
    };

    for (const actor of this.readRunActors(request)) {
      add(actor, "automation_runs");
    }

    const directory = await deps.searchDirectory({
      provider: request.provider,
      query: request.query,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      limit,
    });
    for (const actor of directory.actors) {
      add(actor, "directory");
    }

    return {
      suggestions: suggestions.slice(0, limit),
      directorySupported: directory.supported,
      ...(directory.label ? { directoryLabel: directory.label } : {}),
      ...(directory.truncated ? { directoryTruncated: true } : {}),
    };
  }

  /**
   * Distinct actors seen in this automation's past runs.
   *
   * Cached because `searchSenders` runs per debounced keystroke, and reading
   * plus deserializing 200 run rows on every character is a lot of work for a
   * set that changes only when a run completes. The window is short enough
   * that a run finishing mid-search shows up on the next search.
   */
  private readRunActors(
    request: SearchMessagingSendersRequest,
  ): MessagingDirectoryActor[] {
    if (!request.automationId) return [];
    const key = `${request.automationId}:${request.provider}`;
    const cached = this.runActorCache.get(key);
    const now = Date.now();
    if (cached && now - cached.readAt < RUN_ACTOR_CACHE_TTL_MS) {
      return cached.actors;
    }

    const byId = new Map<string, MessagingDirectoryActor>();
    for (const run of this.options.store.listRunsForAutomation(
      request.automationId,
      RUN_ACTOR_SCAN_LIMIT,
    )) {
      const actor = run.source?.actor;
      if (!actor) continue;
      if (run.source?.conversation.channel !== request.provider) continue;
      if (byId.has(actor.platformUserId)) continue;
      byId.set(actor.platformUserId, {
        platformUserId: actor.platformUserId,
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
        ...(actor.username ? { username: actor.username } : {}),
        ...(actor.isBot ? { isBot: true } : {}),
      });
    }
    const actors = [...byId.values()];
    this.runActorCache.set(key, { actors, readAt: now });
    return actors;
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
    const schedule = request.schedule ?? scheduleFromTriggers(request.triggers);
    if (schedule) {
      this.assertValidSchedule(schedule);
    }
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
      triggers: request.triggers,
      schedule,
      backlogPolicy: request.backlogPolicy,
      executionProfile: request.executionProfile,
      priorRunLookback: request.priorRunLookback,
      outputActions: request.outputActions,
      inboundCoalesceWindowMs: request.inboundCoalesceWindowMs,
      maxRunsPerHour: request.maxRunsPerHour,
      status: request.enabled === false ? "paused" : "enabled",
      nextRunAt:
        request.nextRunAt ??
        (request.enabled === false || !schedule
          ? undefined
          : computeNextAutomationRunAt(schedule, now)),
      now,
    });
    await this.notifyThreadAutomationsUpdated(automation);
    this.startSchedulerIfEnabled();
    this.notifyAutomationsChanged();
    return { automation: toAutomationDetail(automation) };
  }

  async update(request: UpdateAutomationRequest): Promise<AutomationMutationResponse> {
    const current = this.options.store.getAutomation(request.automationId);
    if (!current) {
      throw new Error("Automation not found.");
    }
    const requestedSchedule = request.schedule ?? scheduleFromTriggers(request.triggers);
    if (requestedSchedule) {
      this.assertValidSchedule(requestedSchedule);
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
    const schedule = requestedSchedule ?? current.schedule;
    const enablingFromPaused = request.enabled === true && current.status !== "enabled";
    const disabling = request.enabled === false;
    const shouldRecomputeNextRun =
      request.nextRunAt === undefined &&
      !disabling &&
      Boolean(schedule) &&
      (enablingFromPaused ||
        ((request.schedule !== undefined || request.triggers !== undefined) &&
          current.status === "enabled"));
    const updated = this.options.store.updateAutomation(request.automationId, {
      backend: reassignment?.backend,
      threadId: reassignment?.threadId,
      name: request.name,
      taskPrompt: request.taskPrompt,
      gate: request.gate,
      triggers: request.triggers,
      schedule: request.schedule,
      backlogPolicy: request.backlogPolicy,
      executionProfile: request.executionProfile,
      priorRunLookback: request.priorRunLookback,
      outputActions: request.outputActions,
      inboundCoalesceWindowMs: request.inboundCoalesceWindowMs,
      maxRunsPerHour: request.maxRunsPerHour,
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
            ? computeNextAutomationRunAt(schedule!, now)
            : undefined,
      now,
    });
    if (!updated) throw new Error("Automation not found.");
    if (disabling) {
      await this.cancelPendingRunsForAutomation(
        request.automationId,
        now,
        "Automation paused before this run started.",
      );
    }
    if (assignmentChanged) {
      await this.notifyThreadAutomationsUpdated(current);
    }
    await this.notifyThreadAutomationsUpdated(updated);
    this.startSchedulerIfEnabled();
    this.notifyAutomationsChanged();
    return { automation: toAutomationDetail(updated) };
  }

  async pause(request: AutomationIdRequest): Promise<AutomationMutationResponse> {
    const now = Date.now();
    const automation = this.options.store.updateAutomation(request.automationId, {
      status: "paused",
      nextRunAt: null,
      now,
    });
    if (!automation) throw new Error("Automation not found.");
    await this.cancelPendingRunsForAutomation(
      request.automationId,
      now,
      "Automation paused before this run started.",
    );
    await this.notifyThreadAutomationsUpdated(automation);
    this.startSchedulerIfEnabled();
    this.notifyAutomationsChanged();
    return { automation: toAutomationDetail(automation) };
  }

  async resume(request: AutomationIdRequest): Promise<AutomationMutationResponse> {
    const current = this.options.store.getAutomation(request.automationId);
    if (!current) throw new Error("Automation not found.");
    const automation = this.options.store.resumeAutomation(request.automationId, {
      nextRunAt: current.schedule
        ? computeNextAutomationRunAt(current.schedule, Date.now())
        : undefined,
    });
    if (!automation) throw new Error("Automation not found.");
    await this.notifyThreadAutomationsUpdated(automation);
    this.startSchedulerIfEnabled();
    this.notifyAutomationsChanged();
    return { automation: toAutomationDetail(automation) };
  }

  async delete(request: AutomationIdRequest): Promise<AutomationMutationResponse> {
    this.cancelQueuedTurnsForAutomation(
      request.automationId,
      "Automation deleted before the run started.",
    );
    const automation = this.options.store.deleteAutomation(request.automationId);
    if (!automation) throw new Error("Automation not found.");
    await this.notifyThreadAutomationsUpdated(automation);
    this.startSchedulerIfEnabled();
    this.notifyAutomationsChanged();
    return { automation: toAutomationDetail(automation) };
  }

  /**
   * Recent messages from an inbound automation's trigger conversation, each
   * pre-judged against the trigger's filter so the Replay picker can offer
   * both positive tests (replay a matching message) and negative ones (see
   * that a message would NOT have fired the automation).
   */
  async listReplayCandidates(
    request: ListAutomationReplayCandidatesRequest,
    deps: {
      fetchRecent: (params: {
        provider: MessagingChannelKind;
        conversationId: string;
        parentId?: string;
        limit?: number;
      }) => Promise<InboundPreviewMessage[]>;
      supportsHistory: (provider: MessagingChannelKind) => boolean;
    },
  ): Promise<ListAutomationReplayCandidatesResponse> {
    const automation = this.options.store.getAutomation(request.automationId);
    if (!automation) {
      throw new Error("Automation not found.");
    }
    const trigger = automation.triggers.find(
      (candidate) => candidate.kind === "inbound_message",
    );
    if (trigger?.kind !== "inbound_message") {
      return { candidates: [], supported: false };
    }
    if (!deps.supportsHistory(trigger.conversation.channel)) {
      return { candidates: [], supported: false };
    }
    const messages = await deps.fetchRecent({
      provider: trigger.conversation.channel,
      conversationId: trigger.conversation.conversationId,
      ...(trigger.conversation.parentId
        ? { parentId: trigger.conversation.parentId }
        : {}),
      limit: 15,
    });
    return {
      candidates: buildAutomationReplayCandidates(trigger, messages),
      supported: true,
    };
  }

  async replayInbound(
    request: ReplayAutomationInboundRequest,
  ): Promise<RunAutomationNowResponse> {
    this.assertAutomationsEnabled();
    const automation = this.options.store.getAutomation(request.automationId);
    if (!automation) {
      throw new Error("Automation not found.");
    }
    const trigger = automation.triggers.find(
      (candidate) => candidate.kind === "inbound_message",
    );
    if (trigger?.kind !== "inbound_message") {
      throw new Error("This automation has no inbound trigger to replay.");
    }
    const result = await this.scheduler.replayInboundRun({
      automation,
      source: buildReplayRunSourceMetadata({
        trigger,
        message: request.message,
      }),
    });
    const [run] = this.options.store.listRunsForAutomation(request.automationId, 1);
    if (!run) {
      throw new Error("Automation not found.");
    }
    await this.notifyThreadAutomationsUpdated(automation);
    return {
      run,
      queueStatus: result?.status ?? "failed",
      queueEntryId: result?.entry.id,
      turnId: result?.status === "started" ? result.turnId : undefined,
    };
  }

  async runNow(request: AutomationIdRequest): Promise<RunAutomationNowResponse> {
    this.assertAutomationsEnabled();
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

  async handleMessagingInboundEvent(event: MessagingInboundEvent): Promise<boolean> {
    const matches = matchAutomationInboundEvent({
      automations: this.enabledInboundAutomations(),
      event,
    });
    if (matches.length === 0) {
      return false;
    }
    for (const match of matches) {
      await this.scheduler.runFromInboundEvent({
        automation: match.automation,
        source: match.source,
      });
      await this.notifyThreadAutomationsUpdated(match.automation);
    }
    this.startSchedulerIfEnabled();
    return true;
  }

  /**
   * Pure predicate: would any enabled inbound automation's filter (conversation
   * / sender / text) match this event? Used by the messaging runtime to decide
   * whether a message the @mention response mode would otherwise drop must still
   * be delivered so the automation can run. No side effects — the actual run
   * happens in {@link handleMessagingInboundEvent}, which shares the same
   * candidate set via {@link enabledInboundAutomations} so the two cannot drift.
   */
  matchesInboundEvent(event: MessagingInboundEvent): boolean {
    return anyAutomationInboundMatch({
      automations: this.enabledInboundAutomations(),
      event,
    });
  }

  /**
   * The candidate set for inbound matching: enabled automations that carry an
   * inbound trigger, or none when automations are disabled at runtime. Kept as a
   * single source of truth so the delivery-gate predicate (matchesInboundEvent)
   * and the run path (handleMessagingInboundEvent) always agree. The per-event
   * kind guard lives in the matcher functions.
   */
  private enabledInboundAutomations(): AutomationRecord[] {
    if (this.options.runtime?.disabled) {
      return [];
    }
    return this.options.store.listEnabledInboundAutomations();
  }

  buildThreadSummaries() {
    return this.options.store.buildThreadSummaries();
  }

  /**
   * Distill the pricing pipeline's turn-scope usage lines onto their runs.
   *
   * The registry already computes tokens AND list-price cost for every
   * headless automation turn (recordLiveThreadUsage) — this just correlates
   * the line to a run by backend turn id and freezes the numbers on the run
   * payload. Lookup is any-status, not running-only: the final line can land
   * after the turn-completion event has marked the run completed, and that
   * final line is the one carrying the turn's full totals.
   */
  private captureRunUsageFromPricingEvent(event: AgentEvent): void {
    // Event shape is `{ threadId, pricing: { lines, summaries } }` — the
    // registry's emitThreadPricingUpdated nests readThreadPricing's result
    // under `pricing`, it does not spread it.
    const params = event.notification.params as
      | { pricing?: { lines?: Array<Record<string, unknown>> } }
      | undefined;
    const lines = params?.pricing?.lines;
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      if (line.scope !== "turn" || typeof line.turnId !== "string") continue;
      const run =
        this.options.store.findRunningRunByBackendTurnId({
          backend: event.backend,
          backendTurnId: line.turnId,
        })
        ?? this.options.store.findRunByBackendTurnId?.({
          backend: event.backend,
          backendTurnId: line.turnId,
        });
      if (!run) continue;
      const usage: AutomationRunUsage = {
        ...(typeof line.model === "string" ? { model: line.model } : {}),
        ...(typeof line.reasoningEffort === "string"
          ? { reasoningEffort: line.reasoningEffort }
          : {}),
        ...(typeof line.uncachedInputTokens === "number"
          ? { uncachedInputTokens: line.uncachedInputTokens }
          : {}),
        ...(typeof line.cachedInputTokens === "number"
          ? { cachedInputTokens: line.cachedInputTokens }
          : {}),
        ...(typeof line.outputTokens === "number"
          ? { outputTokens: line.outputTokens }
          : {}),
        ...(typeof line.reasoningOutputTokens === "number"
          ? { reasoningOutputTokens: line.reasoningOutputTokens }
          : {}),
        ...(typeof line.totalTokens === "number"
          ? { totalTokens: line.totalTokens }
          : {}),
        ...(typeof line.totalCostMicros === "number"
          ? { totalCostMicros: line.totalCostMicros }
          : {}),
        ...(typeof line.currency === "string" ? { currency: line.currency } : {}),
      };
      this.bufferRunUsage(run, usage);
    }
  }

  /**
   * Debounced write path for run usage. A streaming turn emits pricing
   * updates repeatedly, and each setRunUsage rewrites the whole run payload
   * row — so identical snapshots are dropped, changed ones wait out one flush
   * window, and terminal events drain their run immediately.
   */
  private bufferRunUsage(run: AutomationRunSummary, usage: AutomationRunUsage): void {
    const current = this.pendingRunUsage.get(run.id) ?? run.usage;
    if (current && automationRunUsageEquals(current, usage)) return;
    this.pendingRunUsage.set(run.id, usage);
    if (this.pendingRunUsageTimer) return;
    const timer = setTimeout(() => {
      this.pendingRunUsageTimer = undefined;
      this.flushPendingRunUsage();
    }, RUN_USAGE_FLUSH_INTERVAL_MS);
    timer.unref?.();
    this.pendingRunUsageTimer = timer;
  }

  private flushPendingRunUsage(runId?: string): void {
    if (runId !== undefined) {
      const usage = this.pendingRunUsage.get(runId);
      if (!usage) return;
      this.pendingRunUsage.delete(runId);
      this.options.store.setRunUsage({ runId, usage });
      return;
    }
    const entries = [...this.pendingRunUsage.entries()];
    this.pendingRunUsage.clear();
    for (const [id, usage] of entries) {
      this.options.store.setRunUsage({ runId: id, usage });
    }
  }

  private async handleRegistryEvent(event: AgentEvent): Promise<void> {
    if (event.notification.method === "thread/pricing/updated") {
      this.captureRunUsageFromPricingEvent(event);
      return;
    }
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
      if (
        params.status === "failed"
        || params.status === "cancelled"
        || params.status === "terminal"
      ) {
        // The run just ended — make whatever usage we have durable now. A
        // final pricing line landing after this still flushes on the timer.
        this.flushPendingRunUsage(params.automationRunId);
      }
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
      automationServiceLog.debug("terminal backend turn was not an automation", {
        backend: event.backend,
        method: event.notification.method,
        threadId: event.notification.params.threadId,
        turnId,
      });
      return;
    }

    const finalText = finalTextFromTerminalTurnNotification(event.notification);
    const errorMessage = errorMessageFromTerminalTurnNotification(event.notification);
    // Turn end is a durability boundary for the debounced usage snapshot. A
    // final pricing line arriving afterwards still flushes on the timer.
    this.flushPendingRunUsage(activeRun.id);
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
      const artifact = this.options.store.upsertRunArtifact({
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
      if (artifact && automation) {
        // Persist in-flight markers for delivery actions BEFORE posting, so a
        // crash mid-delivery leaves a "pending" marker that prevents a
        // duplicate post on restart. We still execute with `artifact` (which
        // does not carry these just-written markers) so the first attempt
        // posts normally; only a re-entry sees the persisted "pending".
        const pendingResults = buildPendingDeliveryActionResults(
          automation.outputActions,
          artifact.actionResults ?? [],
        );
        if (pendingResults.length > 0) {
          const pendingIds = new Set(
            pendingResults.map((result) => result.actionId),
          );
          this.options.store.upsertRunArtifact({
            runId: run.id,
            status: run.status,
            finalText: artifact.finalText,
            errorMessage: artifact.errorMessage,
            outputDecision: artifact.outputDecision,
            actionResults: [
              ...(artifact.actionResults ?? []).filter(
                (result) => !pendingIds.has(result.actionId),
              ),
              ...pendingResults,
            ],
            transcriptEvents: artifact.transcriptEvents,
          });
        }
        const actionResults = await executeAutomationOutputActions({
          actions: automation.outputActions,
          artifact,
          source: run.source,
        });
        this.options.store.upsertRunArtifact({
          runId: run.id,
          status: run.status,
          finalText: artifact.finalText,
          errorMessage: artifact.errorMessage,
          outputDecision: artifact.outputDecision,
          actionResults,
          transcriptEvents: artifact.transcriptEvents,
        });
      }
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
          suppressBindingBroadcast: automation
            ? automationSuppressesBindingBroadcast(automation)
            : false,
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
        // `listAutomations` already skips rows whose schedule this build can't
        // load; the explicit `schedule` guard is belt-and-suspenders so a
        // schedule-less record can never reach computeNextAutomationRunAt and
        // abort the whole startup reconcile.
        .filter((automation) => automation.status === "enabled" && automation.schedule)
        .map((automation) => [
          automation.id,
          computeNextAutomationRunAt(automation.schedule!, now),
        ]),
    );
    this.options.store.reconcileStartup({ now, nextRunAtByAutomationId });
  }

  private startSchedulerIfEnabled(): void {
    if (!this.options.runtime?.disabled) {
      this.scheduler.start();
    }
  }

  private async cancelPendingRunsForAutomation(
    automationId: string,
    now: number,
    reason: string,
  ): Promise<void> {
    const automation = this.options.store.getAutomation(automationId, {
      includeDeleted: true,
    });
    const pendingRuns = this.options.store.listPendingOrQueuedRunsForAutomation(
      automationId,
    );
    this.cancelQueuedTurns(pendingRuns, reason);
    this.options.store.cancelPendingRunsForAutomation({
      automationId,
      errorMessage: reason,
      now,
    });
    if (!automation) {
      return;
    }
    for (const run of pendingRuns) {
      await this.publishAutomationRunUpdate({
        backend: automation.backend,
        runId: run.id,
        status: "cancelled",
        threadId: automation.threadId,
        errorMessage: reason,
      });
    }
  }

  private cancelQueuedTurnsForAutomation(automationId: string, reason: string): void {
    this.cancelQueuedTurns(
      this.options.store.listPendingOrQueuedRunsForAutomation(automationId),
      reason,
    );
  }

  private cancelQueuedTurns(runs: AutomationRunSummary[], reason: string): void {
    const pendingQueueEntryIds = runs
      .map((run) => run.queueEntryId)
      .filter((entryId): entryId is string => Boolean(entryId));
    for (const entryId of pendingQueueEntryIds) {
      this.options.registry.cancelQueuedTurn(entryId, reason);
    }
  }

  private assertAutomationsEnabled(): void {
    if (!this.options.runtime?.disabled) return;
    throw new Error(
      this.options.runtime.disabledReason
        ? `Automations are disabled for this app instance: ${this.options.runtime.disabledReason}`
        : "Automations are disabled for this app instance.",
    );
  }

  private assertValidSchedule(schedule: NonNullable<CreateAutomationRequest["schedule"]>): void {
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

function automationInspectionFailure(
  operation: AutomationInspectionResponse["operation"],
  code: AutomationInspectionErrorCode,
  message: string,
): AutomationInspectionFailure {
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
  costTodayMicros?: number,
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
    triggers: record.triggers,
    scheduleSummary: record.scheduleSummary,
    backlogPolicy: record.backlogPolicy,
    executionProfile: record.executionProfile,
    priorRunLookback: record.priorRunLookback,
    ...(costTodayMicros !== undefined ? { costTodayMicros } : {}),
    outputActions: record.outputActions,
    inboundCoalesceWindowMs: record.inboundCoalesceWindowMs,
    maxRunsPerHour: record.maxRunsPerHour,
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

function scheduleFromTriggers(
  triggers: AutomationTriggerDefinition[] | undefined,
) {
  return triggers?.find((trigger) => trigger.kind === "schedule")?.schedule;
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
  // Streaming agent-message deltas are intentionally NOT persisted to the run
  // transcript: each is a partial chunk of the same content captured in full by
  // item/completed (assistant_final), and recording them rendered fragment
  // "lifecycle" lines (e.g. "]}") in the run-detail view.
  if (notification.method === "item/agentMessage/delta") {
    return undefined;
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

/** Field-wise equality so unchanged pricing snapshots never schedule a write. */
function automationRunUsageEquals(
  a: AutomationRunUsage,
  b: AutomationRunUsage,
): boolean {
  return (
    a.model === b.model
    && a.reasoningEffort === b.reasoningEffort
    && a.uncachedInputTokens === b.uncachedInputTokens
    && a.cachedInputTokens === b.cachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.reasoningOutputTokens === b.reasoningOutputTokens
    && a.totalTokens === b.totalTokens
    && a.totalCostMicros === b.totalCostMicros
    && a.currency === b.currency
  );
}
