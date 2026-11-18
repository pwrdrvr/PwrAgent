import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentFollowUpProtection,
  AppServerThreadMessageOrigin,
  CreateScheduledThreadActionRequest,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  ScheduledThreadAction,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  UpdateScheduledThreadActionRequest,
} from "@pwragent/shared";
import {
  AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD,
  AGENT_FOLLOW_UP_MAX_DELAY_MS,
  AGENT_FOLLOW_UP_MIN_DELAY_MS,
  AGENT_FOLLOW_UP_PROMPT_MAX_CHARS,
  isThreadLockRefusal,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getDesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getMainLogger } from "../log.js";
import { getAppScheduledThreadActionStore } from "../storage/desktop-runtime-storage.js";
import type {
  ScheduledThreadActionHold,
  ScheduledThreadActionStorage,
} from "@pwragent/owner-core/scheduled-thread-action-storage";
import { AgentFollowUpRefusal } from "./agent-follow-up-refusal.js";
import { buildAgentFollowUpToolHandler, type FollowUpThread } from "./agent-follow-up-tool.js";

const scheduledActionLog = getMainLogger("pwragent:scheduled-actions");
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_CLAIM_HEARTBEAT_MS = 10_000;
const HISTORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// A wall-clock lease can expire while macOS suspends every app instance. Keep
// exact same-process ownership available so a sibling service cannot recover
// work from a scheduler that is still active after resume.
const activeSchedulerOwnerIds = new Set<string>();

export type ScheduledThreadActionServiceOptions = {
  registry: DesktopBackendRegistry;
  store: ScheduledThreadActionStorage;
  now?: () => number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  ownerId?: string;
  claimLeaseMs?: number;
  isOwnerAlive?: (ownerId: string) => boolean;
  setLeaseTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>;
  clearLeaseTimer?: (timer: ReturnType<typeof setInterval>) => void;
};

let service: ScheduledThreadActionService | null = null;
let serviceRegistry: DesktopBackendRegistry | null = null;

export function initializeScheduledThreadActionService(
  registry = getDesktopBackendRegistry(),
): ScheduledThreadActionService {
  if (!service) {
    const nextService = new ScheduledThreadActionService({
      registry,
      store: getAppScheduledThreadActionStore(),
    });
    registry.setScheduledThreadActionCreator((request, options) =>
      nextService.create(request, options),
    );
    registry.setAgentFollowUpToolHandler(buildAgentFollowUpToolHandler(nextService));
    service = nextService;
    serviceRegistry = registry;
  }
  return service;
}

export function disposeScheduledThreadActionService(): void {
  service?.dispose();
  serviceRegistry?.setScheduledThreadActionCreator(undefined);
  serviceRegistry?.setAgentFollowUpToolHandler(undefined);
  service = null;
  serviceRegistry = null;
}

export class ScheduledThreadActionService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private evaluating = false;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ownerId: string;
  private lastHistoryCleanupAt = 0;
  private projectionObservationError?: string;
  private unsubscribeRegistryEvents?: () => void;
  private unsubscribeRestartGate?: () => void;

  constructor(private readonly options: ScheduledThreadActionServiceOptions) {
    this.ownerId = options.ownerId ?? `scheduler:${process.pid}:${randomUUID()}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.observeExternalScheduledChanges();
    activeSchedulerOwnerIds.add(this.ownerId);
    this.cleanupExpiredHistory();
    this.recoverExpiredClaims(this.now());
    this.unsubscribeRegistryEvents = this.options.registry.onEvent((event) =>
      this.handleRegistryEvent(event),
    );
    // Due actions wait while a quiet restart's continuations go first.
    this.unsubscribeRestartGate = this.options.registry.onRestartGateChanged?.((closed) => {
      if (!closed && this.running) void this.evaluateDueActions();
    });
    this.startLeaseHeartbeat();
    this.scheduleNextTimer();
    void this.evaluateDueActions();
  }

  dispose(): void {
    this.running = false;
    activeSchedulerOwnerIds.delete(this.ownerId);
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.leaseTimer) {
      this.clearLeaseTimer(this.leaseTimer);
      this.leaseTimer = null;
    }
    this.unsubscribeRegistryEvents?.();
    this.unsubscribeRegistryEvents = undefined;
    this.unsubscribeRestartGate?.();
    this.unsubscribeRestartGate = undefined;
    // Claims intentionally expire through their lease. Releasing a queued
    // claim here is unsafe unless the registry is already quiescent, because
    // its in-memory FIFO may still start the same action during shutdown.
  }

  list(
    request: ListScheduledThreadActionsRequest = {},
  ): ListScheduledThreadActionsResponse {
    const observedAt = this.now();
    if (request.projectionProtocol === 2) return {
      ...this.options.store.listProjectionPage(request), observedAt,
    };
    return {
      actions: this.options.store.list(request),
      observedAt,
    };
  }

  /** Read an admitted action without changing its dispatch or hold policy. */
  get(id: string): ScheduledThreadAction | undefined {
    return this.options.store.get(id);
  }

  /**
   * An agent's one-shot wake for its own thread. The caller supplies the
   * thread from the tool call's trusted context, never from tool arguments.
   * `provenance` carries the messaging source of the turn that asked, so the
   * woken turn stays under that contact's permissions.
   */
  async createAgentFollowUp(request: FollowUpThread & {
    scheduledFor: number;
    prompt: string;
    provenance?: Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">;
  }): Promise<ScheduledThreadAction> {
    const now = this.now();
    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new AgentFollowUpRefusal("invalid_arguments", "Provide prompt: what this thread should do when the follow-up fires, written so a reader without this conversation can act on it.");
    }
    if (prompt.length > AGENT_FOLLOW_UP_PROMPT_MAX_CHARS) {
      throw new AgentFollowUpRefusal("invalid_arguments", `The follow-up prompt is limited to ${AGENT_FOLLOW_UP_PROMPT_MAX_CHARS} characters.`);
    }
    if (!Number.isFinite(request.scheduledFor)) {
      throw new AgentFollowUpRefusal("invalid_arguments", "Provide delayMinutes or an ISO 8601 time in at.");
    }
    if (request.scheduledFor < now + AGENT_FOLLOW_UP_MIN_DELAY_MS) {
      throw new AgentFollowUpRefusal("invalid_arguments", "A follow-up fires at least one minute from now. Do work that is ready now in this turn.");
    }
    if (request.scheduledFor > now + AGENT_FOLLOW_UP_MAX_DELAY_MS) {
      throw new AgentFollowUpRefusal("invalid_arguments", "A follow-up fires within a year. Ask the operator for an automation for a longer or recurring schedule.");
    }
    const created = this.options.store.createAgentFollowUp({
      id: `scheduled-action:${randomUUID()}`,
      backend: request.backend,
      threadId: request.threadId,
      kind: "turn",
      origin: "agent",
      scheduledFor: request.scheduledFor,
      displayText: prompt,
      turn: {
        input: [{ type: "text", text: prompt }],
        messageOrigin: { kind: "pwragent", ...request.provenance },
      },
      now,
    }, AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD);
    if ("refused" in created) {
      throw new AgentFollowUpRefusal("forbidden", `This thread already has ${created.active} follow-ups waiting; the limit is ${AGENT_FOLLOW_UP_MAX_ACTIVE_PER_THREAD}. Cancel one first, or let one fire.`);
    }
    await this.publish(created.action);
    this.scheduleNextTimer();
    return created.action;
  }

  /**
   * An agent cancels only a follow-up an agent set on this same thread, and
   * only before it is dispatched. Everything else is the operator's.
   */
  async cancelAgentFollowUp(thread: FollowUpThread, id: string): Promise<ScheduledThreadAction> {
    const current = this.options.store.get(id);
    if (!current || current.backend !== thread.backend || current.threadId !== thread.threadId) {
      throw new AgentFollowUpRefusal("not_found", "No follow-up with that id waits on this thread. Use action list.");
    }
    if (current.origin !== "agent") {
      throw new AgentFollowUpRefusal("forbidden", current.origin === "messaging"
        ? "A messaging contact scheduled that action. The contact or the operator cancels it."
        : "The operator scheduled that action. Only the operator can cancel it.");
    }
    if (current.status !== "scheduled" && current.status !== "held" && current.status !== "queued") {
      throw new AgentFollowUpRefusal("not_found", `That follow-up is already ${current.status}. Cancel cannot undo a turn that started.`);
    }
    return (await this.cancel({ id })).action;
  }

  agentFollowUpProtection(thread: FollowUpThread): AgentFollowUpProtection {
    return this.options.store.agentFollowUpProtection(thread, this.now());
  }

  countActiveAgentFollowUps(thread: FollowUpThread): number {
    return this.options.store.countActiveAgentFollowUps(thread);
  }

  /**
   * Clears a tripped loop guard. Callers must have established that the
   * request came from the local operator; no agent or peer path reaches this.
   */
  async rearmAgentFollowUps(thread: FollowUpThread): Promise<void> {
    this.options.store.rearmAgentFollowUps(thread);
    await this.publishFollowUpGuardChange(thread);
    this.scheduleNextTimer();
    await this.evaluateDueActions();
  }

  async create(
    request: CreateScheduledThreadActionRequest,
    options?: { id?: string },
  ): Promise<ScheduledThreadActionMutationResponse> {
    validateScheduledActionRequest(request);
    // The desktop, messaging and peer surfaces share this path. Only
    // createAgentFollowUp, which applies the agent limits, writes this origin.
    if (request.origin === "agent") {
      throw new Error("Agent follow-ups are created with schedule_follow_up.");
    }
    const now = this.now();
    const id = options?.id ?? `scheduled-action:${randomUUID()}`;
    const existing = this.options.store.get(id);
    if (existing) {
      if (!matchesCreateRequest(existing, request)) {
        throw new Error(`Scheduled action id ${id} was reused with different input.`);
      }
      return mutationResponseForAction(existing);
    }
    if (request.review?.target.type === "pullRequest") {
      const prepared = await this.options.registry.prepareReviewRequest({
        ...request.review, backend: request.backend, threadId: request.threadId,
      });
      request = {
        ...request,
        displayText: `Review ${prepared.target.type === "pullRequest" ? prepared.target.url : "pull request"} at ${prepared.target.type === "pullRequest" ? prepared.target.snapshot!.headCommit.slice(0, 10) : ""}`,
        review: { ...request.review, target: prepared.target, cwd: prepared.cwd },
      };
    }
    const action = this.options.store.create({
      ...request,
      id,
      origin: request.origin ?? "desktop",
      now,
    });
    await this.publish(action);
    this.scheduleNextTimer();
    if (action.scheduledFor <= now) {
      await this.evaluateDueActions();
    }
    return mutationResponseForAction(
      this.options.store.get(action.id) ?? action,
    );
  }

  async update(
    request: UpdateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const current = this.requireAction(request.id);
    const candidate = {
      ...current,
      ...request,
    };
    validateScheduledActionRequest(candidate);
    if (request.review?.target.type === "pullRequest") {
      const samePullRequest = current.review?.target.type === "pullRequest"
        && current.review.target.url === request.review.target.url
        && (!request.review.cwd || request.review.cwd === current.review.cwd);
      const review = samePullRequest
        ? { ...current.review, ...request.review, runMode: request.review.runMode ?? current.review?.runMode }
        : request.review;
      const prepared = await this.options.registry.prepareReviewRequest({
        ...review, backend: current.backend, threadId: current.threadId,
        ...(samePullRequest ? { target: current.review!.target, cwd: current.review!.cwd } : {}),
      }, samePullRequest);
      request = {
        ...request,
        displayText: `Review ${request.review.target.url} at ${prepared.target.type === "pullRequest" ? prepared.target.snapshot!.headCommit.slice(0, 10) : ""}`,
        review: { ...review, target: prepared.target, cwd: prepared.cwd },
      };
    }
    const updated = this.options.store.update(request.id, {
      scheduledFor: request.scheduledFor,
      displayText: request.displayText,
      imageAttachments: request.imageAttachments,
      fileAttachments: request.fileAttachments,
      turn: request.turn,
      review: request.review,
      now: this.now(),
    });
    if (!updated) {
      throw new Error("The scheduled action is already being dispatched.");
    }
    await this.options.registry.updateScheduledThreadStartTime?.({
      actionId: updated.id,
      backend: updated.backend,
      scheduledFor: updated.scheduledFor,
      threadId: updated.threadId,
    });
    await this.publish(updated);
    this.scheduleNextTimer();
    if (updated.scheduledFor <= this.now()) {
      await this.evaluateDueActions();
    }
    return mutationResponseForAction(
      this.options.store.get(updated.id) ?? updated,
    );
  }

  async cancel(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const current = this.requireAction(request.id);
    // A repeated cancel, such as a second window deleting the same failed
    // row, changes nothing. The first cancel already settled everything.
    if (current.status === "cancelled") return { action: current };
    if (current.status === "failed") {
      // Dismissing a failure only takes its row out of the queue. A thread
      // born from this action keeps its failed scheduled start.
      const dismissed = this.options.store.dismissFailed(current.id, this.now());
      if (!dismissed) {
        throw new Error("The scheduled action can no longer be cancelled.");
      }
      await this.publish(dismissed);
      return { action: dismissed };
    }
    let cancelled: ScheduledThreadAction | undefined;
    if (current.status === "held" && current.queueEntryId) {
      const cancelledInRegistry = this.options.registry.cancelQueuedTurn(
        current.queueEntryId,
        "Scheduled action cancelled.",
      );
      // The durable action can outlive the process-local FIFO. A missing
      // queue entry after restart must not make the held action undeletable.
      cancelled = cancelledInRegistry
        ? this.options.store.markCancelled(current.id, this.now())
        : this.options.store.cancel(current.id, this.now());
    } else if (current.status === "held" || current.status === "scheduled") {
      cancelled = this.options.store.cancel(current.id, this.now());
    } else if (current.status === "queued" && current.queueEntryId) {
      const cancelledInRegistry = current.kind === "review"
        ? this.options.registry.cancelPendingReview(
            current.queueEntryId,
            "Scheduled review cancelled.",
          )
        : this.options.registry.cancelQueuedTurn(
            current.queueEntryId,
            "Scheduled action cancelled.",
          );
      if (!cancelledInRegistry) {
        throw new Error("The scheduled action is no longer waiting.");
      }
      cancelled = this.options.store.markCancelled(current.id, this.now());
    }
    if (!cancelled) {
      const latest = this.options.store.get(current.id);
      cancelled = latest?.status === "cancelled" ? latest : undefined;
    }
    if (!cancelled) {
      throw new Error("The scheduled action can no longer be cancelled.");
    }
    await this.clearScheduledStartIfBorn(cancelled);
    await this.publish(cancelled);
    this.scheduleNextTimer();
    return { action: cancelled };
  }

  async sendNow(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const claimed = this.claimForSendNow(request.id);
    await this.publishSuspendedFollowUpThreads();
    if (!claimed) {
      const current = this.options.store.get(request.id);
      if (
        current?.origin === "agent"
        && (current.status === "scheduled" || current.status === "held")
        && this.options.store.agentFollowUpProtection(current, this.now()).suspendedAt !== undefined
      ) {
        throw new Error("Agent follow-ups are suspended on this thread. Rearm them in Waiting for first.");
      }
      throw new Error("The scheduled action is no longer scheduled.");
    }
    await this.publish(claimed);
    await this.dispatch(claimed);
    this.scheduleNextTimer();
    return mutationResponseForAction(
      this.options.store.get(claimed.id) ?? claimed,
    );
  }

  async evaluateDueActions(): Promise<void> {
    if (this.evaluating) return;
    // The gate opening evaluates again.
    if (this.options.registry.isRestartGateClosed?.()) return;
    this.evaluating = true;
    try {
      // No await without an orphan: a create that evaluates while this pass
      // runs is dropped by the guard above, so the pass must stay short.
      for (const hold of this.orphanedLockHolds()) await this.readmitOrphanedLockHold(hold);
      while (true) {
        const action = this.options.store.claimNextDue(this.claimParams());
        await this.publishSuspendedFollowUpThreads();
        if (!action) break;
        await this.publish(action);
        await this.dispatch(action);
      }
    } finally {
      this.evaluating = false;
      this.scheduleNextTimer();
    }
  }

  /**
   * A held action's queue entry lives in its holder's memory. Send Now from
   * the holder releases that entry. When the holder has died, the entry is
   * gone, so the claim forgets it and the action is admitted again.
   */
  private claimForSendNow(id: string): ScheduledThreadAction | undefined {
    const params = this.claimParams();
    const hold = this.options.store.listHeldHolds().find((candidate) => candidate.id === id);
    if (!hold || hold.holderId === this.ownerId) return this.options.store.claim(id, params);
    if (hold.holderId && this.isOwnerAlive(hold.holderId)) {
      throw new Error("Another PwrAgent instance on this profile holds this action. Send it from there.");
    }
    return this.options.store.claimHeld(id, hold.holderId, params, {
      readmit: hold.errorMessage !== undefined && isThreadLockRefusal(hold.errorMessage),
    });
  }

  /**
   * A lock's hold lives in the holder's in-memory queue, which dies with its
   * process. Admit such an action again here, as when it came due: a locked
   * thread holds it in this queue, and an unlocked one starts it. Nothing was
   * started from a dead holder's queue without first moving the action out of
   * `held` (see `markHeldQueued`), so this cannot run a turn twice.
   */
  private orphanedLockHolds(): ScheduledThreadActionHold[] {
    return this.options.store.listHeldHolds().filter((hold) =>
      hold.errorMessage !== undefined
      && isThreadLockRefusal(hold.errorMessage)
      && hold.holderId !== this.ownerId
      && !(hold.holderId && this.isOwnerAlive(hold.holderId)));
  }

  private async readmitOrphanedLockHold(hold: ScheduledThreadActionHold): Promise<void> {
    const claimed = this.options.store.claimHeld(hold.id, hold.holderId, this.claimParams(), { readmit: true });
    await this.publishSuspendedFollowUpThreads();
    if (!claimed) return;
    await this.publish(claimed);
    await this.dispatch(claimed);
  }

  private async dispatch(action: ScheduledThreadAction): Promise<void> {
    try {
      if (action.kind === "review") {
        if (!action.review) {
          throw new Error("Scheduled review payload is missing.");
        }
        const response = await this.options.registry.submitReview({
          backend: action.backend,
          threadId: action.threadId,
          idempotencyKey: action.id,
          target: action.review.target,
          delivery: action.review.delivery ?? "inline",
          runMode: action.review.runMode,
          afterReview: action.review.afterReview,
          cwd: action.review.cwd,
          reviewBackend: action.review.reviewBackend,
          model: action.review.model,
          reasoningEffort: action.review.reasoningEffort,
          serviceTier: action.review.serviceTier,
          fastMode: action.review.fastMode,
        }, true);
        const updated = response.status === "started"
          ? this.options.store.markStarted(
              action.id,
              response.response.turnId,
              this.now(),
              this.ownerId,
            )
          : this.options.store.markQueued(
              action.id,
              response.pendingReviewId,
              this.now(),
              this.ownerId,
            );
        if (updated) {
          await this.clearScheduledStartIfBorn(updated);
          await this.publish(updated);
        }
        return;
      }
      if (!action.turn) {
        throw new Error("Scheduled turn payload is missing.");
      }
      const queueEntryId =
        action.queueEntryId ?? queueEntryIdForAction(action.id);
      const turn = {
        ...action.turn,
        backend: action.backend,
        threadId: action.threadId,
        origin: "scheduled" as const,
        queueEntryId,
      };
      if (action.manualReleaseRequired) {
        // Once admitted, the queue owns the input and its changing hold
        // causes. Retry validates that acceptance instead of admitting it again.
        if (!action.queueEntryId) await this.options.registry.submitHeldTurn({
          ...turn,
          holdReason:
            "This steering message was held after its target turn ended. Retry it when the provider is ready.",
        });
        const queued = this.options.store.markQueued(
          action.id,
          queueEntryId,
          this.now(),
          this.ownerId,
        );
        if (queued) await this.publish(queued);
        const released = await this.options.registry
          .releaseQueuedTurnWithDisposition(queueEntryId, turn);
        if (released.disposition === "started") {
          const started = this.options.store.markStarted(
            action.id,
            released.turnId,
            this.now(),
            this.ownerId,
          );
          if (started) {
            await this.clearScheduledStartIfBorn(started);
            await this.publish(started);
          }
        } else if (released.disposition !== "not_held") {
          const reason = released.errorMessage
            ?? (released.disposition === "busy"
              ? "Wait for the active turn to finish before retrying this message."
              : released.disposition === "not_head"
                ? "Retry the first held message before this one."
                : "This steering message remains held for retry.");
          const stillHeld = this.options.store.markHeld(
            action.id,
            queueEntryId,
            reason,
            this.now(),
            this.ownerId,
            this.ownerId,
          );
          if (stillHeld) await this.publish(stillHeld);
        }
        return;
      }
      const response = await this.options.registry.submitTurn(turn)
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!isThreadLockRefusal(message)) throw error;
          // A lock pauses the message rather than failing it: held in the
          // thread's queue, it starts when the thread is unlocked.
          return await this.options.registry.submitHeldTurn({ ...turn, holdReason: message });
        });
      const updated = response.status === "queued" && response.entry.holdReason
        ? this.options.store.markHeld(
            action.id,
            response.entry.id,
            response.entry.holdReason,
            this.now(),
            this.ownerId,
            this.ownerId,
          )
        : response.status === "queued"
        ? this.options.store.markQueued(
            action.id,
            response.entry.id,
            this.now(),
            this.ownerId,
          )
        : this.options.store.markStarted(
            action.id,
            response.turnId,
            this.now(),
            this.ownerId,
          );
      if (updated) {
        await this.clearScheduledStartIfBorn(updated);
        await this.publish(updated);
      }
    } catch (error) {
      const failed = this.options.store.markFailed(
        action.id,
        error instanceof Error ? error.message : String(error),
        this.now(),
        this.ownerId,
      );
      if (failed) {
        await this.clearScheduledStartIfBorn(failed);
        await this.publish(failed);
      }
      scheduledActionLog.error("scheduled action dispatch failed", {
        actionId: action.id,
        backend: action.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: action.threadId,
      });
    }
  }

  private async handleRegistryEvent(event: AgentEvent): Promise<void> {
    if (event.notification.method === "thread/reviewStart/updated") {
      await this.handleReviewRegistryEvent(event);
      return;
    }
    if (event.notification.method !== "thread/turnQueue/updated") return;
    const params = event.notification.params as {
      queueEntryId?: unknown;
      status?: unknown;
      turnId?: unknown;
      errorMessage?: unknown;
    };
    if (typeof params.queueEntryId !== "string") return;
    const actionId = actionIdFromQueueEntryId(params.queueEntryId);
    if (!actionId) return;
    let updated: ScheduledThreadAction | undefined;
    if (params.status === "queued") {
      updated = this.options.store.markQueued(
        actionId,
        params.queueEntryId,
        this.now(),
      )
        // An unlock announces each entry it releases before the queue starts
        // it. The lease taken here is what a crash before the start leaves.
        ?? this.options.store.markHeldQueued(actionId, params.queueEntryId, this.claimParams());
      if (!updated && this.options.store.get(actionId)?.status === "cancelled") {
        // Cancelled where this queue could not reach the entry, such as from
        // another instance on the profile. It must not start here.
        this.options.registry.cancelQueuedTurn(params.queueEntryId, "Scheduled action cancelled.");
      }
    } else if (params.status === "held") {
      updated = this.options.store.markHeld(
        actionId,
        params.queueEntryId,
        typeof params.errorMessage === "string"
          ? params.errorMessage
          : "The queued turn is held for manual retry.",
        this.now(),
        undefined,
        this.ownerId,
      );
    } else if (params.status === "started") {
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      updated = this.options.store.markStarted(actionId, turnId, this.now())
        // An unlock starts what the lock held without a new claim. Without
        // this the action stays held after its turn has started.
        ?? this.options.store.markHeldStarted(actionId, params.queueEntryId, turnId, this.now());
    } else if (params.status === "failed") {
      updated = this.options.store.markFailed(
        actionId,
        typeof params.errorMessage === "string"
          ? params.errorMessage
          : "Scheduled turn failed to start.",
        this.now(),
      );
    } else if (params.status === "cancelled") {
      updated = this.options.store.markCancelled(actionId, this.now());
    }
    if (updated) {
      await this.clearScheduledStartIfBorn(updated);
      await this.publish(updated);
    }
  }

  private async handleReviewRegistryEvent(event: AgentEvent): Promise<void> {
    const params = event.notification.params as {
      pendingReviewId?: unknown;
      status?: unknown;
      reviewTurnId?: unknown;
      error?: unknown;
    };
    if (typeof params.pendingReviewId !== "string") return;
    const action = this.options.store.getByQueueEntryId(params.pendingReviewId);
    if (!action || action.kind !== "review") return;
    let updated: ScheduledThreadAction | undefined;
    if (params.status === "started") {
      updated = this.options.store.markStarted(
        action.id,
        typeof params.reviewTurnId === "string"
          ? params.reviewTurnId
          : undefined,
        this.now(),
      );
    } else if (params.status === "failed") {
      updated = this.options.store.markFailed(
        action.id,
        typeof params.error === "string"
          ? params.error
          : "Scheduled review failed to start.",
        this.now(),
      );
    } else if (params.status === "cancelled") {
      updated = this.options.store.markCancelled(action.id, this.now());
    }
    if (updated) {
      await this.clearScheduledStartIfBorn(updated);
      await this.publish(updated);
    }
  }

  private async clearScheduledStartIfBorn(
    action: ScheduledThreadAction,
  ): Promise<void> {
    if (action.status === "started") {
      await this.options.registry.markScheduledThreadBorn?.({
        actionId: action.id,
        backend: action.backend,
        threadId: action.threadId,
      });
      return;
    }
    if (action.status === "cancelled" || action.status === "failed") {
      await this.options.registry.markScheduledThreadStartTerminal?.({
        actionId: action.id,
        backend: action.backend,
        state: action.status,
        threadId: action.threadId,
      });
    }
  }

  private async publish(action: ScheduledThreadAction): Promise<void> {
    await this.options.registry.publishLocalEvent({
      backend: action.backend,
      notification: {
        method: "thread/scheduledAction/updated",
        params: { action },
      },
    });
  }

  /** Waiting for redraws when a claim trips a thread's loop guard. */
  private async publishSuspendedFollowUpThreads(): Promise<void> {
    for (const thread of this.options.store.takeSuspendedAgentFollowUpThreads()) {
      scheduledActionLog.warn("agent follow-ups suspended by loop protection", {
        backend: thread.backend,
        threadId: thread.threadId,
      });
      await this.publishFollowUpGuardChange(thread);
    }
  }

  private async publishFollowUpGuardChange(thread: FollowUpThread): Promise<void> {
    await this.options.registry.publishLocalEvent({
      backend: thread.backend,
      notification: {
        method: "navigation/invalidated",
        params: { sourceMethod: "thread/scheduledAction/updated", threadId: thread.threadId },
      },
    });
  }

  private scheduleNextTimer(): void {
    if (!this.running) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const next = this.options.store.nextScheduledAt();
    if (next === undefined) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, next - this.now()),
    );
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.evaluateDueActions();
    }, delay);
  }

  private requireAction(id: string): ScheduledThreadAction {
    const action = this.options.store.get(id);
    if (!action) throw new Error("Scheduled action not found.");
    return action;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private claimParams(): {
    now: number;
    ownerId: string;
    leaseExpiresAt: number;
  } {
    const now = this.now();
    return {
      now,
      ownerId: this.ownerId,
      leaseExpiresAt: now + (this.options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS),
    };
  }

  private observeExternalScheduledChanges(): void {
    try {
      if (this.options.store.observeExternalProjectionChange()) {
        void this.options.registry.publishLocalEvent({ backend: "codex", notification: {
          method: "navigation/invalidated", params: { sourceMethod: "thread/scheduledAction/updated" },
        } });
      }
      this.projectionObservationError = undefined;
    } catch (error) {
      // A viewer's projection budget must never stop accepted scheduled work.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.projectionObservationError) {
        this.projectionObservationError = message;
        scheduledActionLog.warn("Scheduled projection observation unavailable", { error: message });
      }
    }
  }

  private startLeaseHeartbeat(): void {
    const callback = (): void => {
      if (!this.running) return;
      this.observeExternalScheduledChanges();
      const params = this.claimParams();
      this.options.store.renewClaims(
        params.ownerId,
        params.now,
        params.leaseExpiresAt,
      );
      this.recoverExpiredClaims(params.now);
      this.cleanupExpiredHistory();
      void this.evaluateDueActions();
    };
    this.leaseTimer = this.options.setLeaseTimer?.(
      callback,
      DEFAULT_CLAIM_HEARTBEAT_MS,
    ) ?? setInterval(callback, DEFAULT_CLAIM_HEARTBEAT_MS);
    this.leaseTimer.unref?.();
  }

  private isOwnerAlive(ownerId: string): boolean {
    return this.options.isOwnerAlive?.(ownerId) ?? isSchedulerOwnerAlive(ownerId);
  }

  private recoverExpiredClaims(now: number): void {
    const protectedOwnerIds = new Set(
      this.options.store.expiredClaimOwnerIds(now).filter((ownerId) => this.isOwnerAlive(ownerId)),
    );
    const recovered = this.options.store.recoverExpiredClaims(
      now,
      protectedOwnerIds,
    );
    for (const action of recovered) void this.publish(action);
  }

  private cleanupExpiredHistory(): void {
    const now = this.now();
    if (
      this.lastHistoryCleanupAt !== 0
      && now - this.lastHistoryCleanupAt < HISTORY_CLEANUP_INTERVAL_MS
    ) return;
    this.options.store.cleanupTerminalBefore(now - HISTORY_RETENTION_MS);
    this.lastHistoryCleanupAt = now;
  }

  private setTimer(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    return this.options.setTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    if (this.options.clearTimer) {
      this.options.clearTimer(timer);
    } else {
      clearTimeout(timer);
    }
  }

  private clearLeaseTimer(timer: ReturnType<typeof setInterval>): void {
    if (this.options.clearLeaseTimer) {
      this.options.clearLeaseTimer(timer);
    } else {
      clearInterval(timer);
    }
  }
}

function validateScheduledActionRequest(
  request: Pick<
    CreateScheduledThreadActionRequest,
    "displayText" | "kind" | "review" | "scheduledFor" | "turn"
  >,
): void {
  if (!Number.isFinite(request.scheduledFor) || request.scheduledFor < 0) {
    throw new Error("Scheduled time must be a finite Unix timestamp.");
  }
  if (request.kind === "turn" && !request.turn?.input.length) {
    throw new Error("Scheduled turns require non-empty input.");
  }
  if (request.kind === "review" && !request.review) {
    throw new Error("Scheduled reviews require review configuration.");
  }
  if (request.kind === "review" && !request.displayText.trim()) {
    throw new Error("Scheduled review display text is required.");
  }
}

function mutationResponseForAction(
  action: ScheduledThreadAction,
): ScheduledThreadActionMutationResponse {
  if (action.status === "failed") {
    throw new Error(
      action.errorMessage ?? "The scheduled action could not be dispatched.",
    );
  }
  return { action };
}

function isSchedulerOwnerAlive(ownerId: string): boolean {
  const match = /^scheduler:(\d+):/.exec(ownerId);
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // A process can create a replacement scheduler without exiting. For the
  // current process, require the exact owner token instead of PID alone.
  if (pid === process.pid) return activeSchedulerOwnerIds.has(ownerId);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function queueEntryIdForAction(actionId: string): string {
  return `scheduled-turn:${actionId}`;
}

function matchesCreateRequest(
  action: ScheduledThreadAction,
  request: CreateScheduledThreadActionRequest,
): boolean {
  return action.backend === request.backend
    && action.threadId === request.threadId
    && action.kind === request.kind
    && action.origin === (request.origin ?? "desktop")
    && action.manualReleaseRequired === request.manualReleaseRequired
    && (action.displayText === request.displayText
      || (action.review?.target.type === "pullRequest" && request.review?.target.type === "pullRequest"))
    && JSON.stringify(action.imageAttachments)
      === JSON.stringify(request.imageAttachments)
    && JSON.stringify(action.fileAttachments)
      === JSON.stringify(request.fileAttachments)
    && JSON.stringify(action.turn) === JSON.stringify(request.turn)
    && JSON.stringify(reviewAdmissionIdentity(action.review, request.review))
      === JSON.stringify(reviewAdmissionIdentity(request.review, request.review));
}

function reviewAdmissionIdentity(
  review: ScheduledThreadAction["review"],
  incoming: ScheduledThreadAction["review"],
): ScheduledThreadAction["review"] {
  if (review?.target.type !== "pullRequest") return review;
  return {
    ...review,
    cwd: incoming?.cwd ? review.cwd : undefined,
    target: { type: "pullRequest", url: review.target.url },
  };
}

function actionIdFromQueueEntryId(queueEntryId: string): string | undefined {
  const prefix = "scheduled-turn:";
  return queueEntryId.startsWith(prefix)
    ? queueEntryId.slice(prefix.length)
    : undefined;
}

export function getScheduledThreadActionService(): ScheduledThreadActionService {
  if (!service) throw new Error("getScheduledThreadActionService is unavailable before startOwnerServices().");
  return service;
}
