import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CreateScheduledThreadActionRequest,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  ScheduledThreadAction,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  UpdateScheduledThreadActionRequest,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getDesktopBackendRegistry } from "../app-server/backend-registry.js";
import { getMainLogger } from "../log.js";
import { getAppScheduledThreadActionStore } from "../state/app-state.js";
import type { ScheduledThreadActionStore } from "./scheduled-thread-action-store.js";

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
  store: ScheduledThreadActionStore;
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

export function getScheduledThreadActionService(
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
    service = nextService;
    serviceRegistry = registry;
    nextService.start();
  }
  return service;
}

export function disposeScheduledThreadActionService(): void {
  service?.dispose();
  serviceRegistry?.setScheduledThreadActionCreator(undefined);
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
  private unsubscribeRegistryEvents?: () => void;

  constructor(private readonly options: ScheduledThreadActionServiceOptions) {
    this.ownerId = options.ownerId ?? `scheduler:${process.pid}:${randomUUID()}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    activeSchedulerOwnerIds.add(this.ownerId);
    this.cleanupExpiredHistory();
    this.recoverExpiredClaims(this.now());
    this.unsubscribeRegistryEvents = this.options.registry.onEvent((event) =>
      this.handleRegistryEvent(event),
    );
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
    // Claims intentionally expire through their lease. Releasing a queued
    // claim here is unsafe unless the registry is already quiescent, because
    // its in-memory FIFO may still start the same action during shutdown.
  }

  list(
    request: ListScheduledThreadActionsRequest = {},
  ): ListScheduledThreadActionsResponse {
    const observedAt = this.now();
    return {
      actions: this.options.store.list(request),
      observedAt,
    };
  }

  async create(
    request: CreateScheduledThreadActionRequest,
    options?: { id?: string },
  ): Promise<ScheduledThreadActionMutationResponse> {
    validateScheduledActionRequest(request);
    const now = this.now();
    const id = options?.id ?? `scheduled-action:${randomUUID()}`;
    const existing = this.options.store.get(id);
    if (existing) {
      if (!matchesCreateRequest(existing, request)) {
        throw new Error(`Scheduled action id ${id} was reused with different input.`);
      }
      return mutationResponseForAction(existing);
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
    let cancelled: ScheduledThreadAction | undefined;
    if (current.status === "held" && current.queueEntryId) {
      const cancelledInRegistry = this.options.registry.cancelQueuedTurn(
        current.queueEntryId,
        "Scheduled action cancelled.",
      );
      if (!cancelledInRegistry) {
        throw new Error("The scheduled action is no longer waiting.");
      }
      cancelled = this.options.store.markCancelled(current.id, this.now());
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
      if (!cancelled) {
        const latest = this.options.store.get(current.id);
        cancelled = latest?.status === "cancelled" ? latest : undefined;
      }
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
    const claimed = this.options.store.claim(request.id, this.claimParams());
    if (!claimed) {
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
    this.evaluating = true;
    try {
      while (true) {
        const action = this.options.store.claimNextDue(this.claimParams());
        if (!action) break;
        await this.publish(action);
        await this.dispatch(action);
      }
    } finally {
      this.evaluating = false;
      this.scheduleNextTimer();
    }
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
          cwd: action.review.cwd,
          reviewBackend: action.review.reviewBackend,
          model: action.review.model,
          reasoningEffort: action.review.reasoningEffort,
          serviceTier: action.review.serviceTier,
          fastMode: action.review.fastMode,
        });
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
      const queueEntryId = queueEntryIdForAction(action.id);
      if (action.manualReleaseRequired) {
        const held = await this.options.registry.submitHeldTurn({
          ...action.turn,
          backend: action.backend,
          threadId: action.threadId,
          queueEntryId,
          holdReason:
            "This steering message was held after its target turn ended. Retry it when the provider is ready.",
          origin: "scheduled",
        });
        const queued = this.options.store.markQueued(
          action.id,
          held.entry.id,
          this.now(),
          this.ownerId,
        );
        if (queued) await this.publish(queued);
        const released = await this.options.registry
          .releaseQueuedTurnWithDisposition(held.entry.id);
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
            held.entry.id,
            reason,
            this.now(),
            this.ownerId,
          );
          if (stillHeld) await this.publish(stillHeld);
        }
        return;
      }
      const response = await this.options.registry.submitTurn({
        ...action.turn,
        backend: action.backend,
        threadId: action.threadId,
        origin: "scheduled",
        queueEntryId,
      });
      const updated = response.status === "queued"
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
      );
    } else if (params.status === "started") {
      updated = this.options.store.markStarted(
        actionId,
        typeof params.turnId === "string" ? params.turnId : undefined,
        this.now(),
      );
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

  private startLeaseHeartbeat(): void {
    const callback = (): void => {
      if (!this.running) return;
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

  private recoverExpiredClaims(now: number): void {
    const protectedOwnerIds = new Set(
      this.options.store.expiredClaimOwnerIds(now).filter((ownerId) =>
        this.options.isOwnerAlive?.(ownerId)
          ?? isSchedulerOwnerAlive(ownerId)
      ),
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
    && action.displayText === request.displayText
    && JSON.stringify(action.imageAttachments)
      === JSON.stringify(request.imageAttachments)
    && JSON.stringify(action.fileAttachments)
      === JSON.stringify(request.fileAttachments)
    && JSON.stringify(action.turn) === JSON.stringify(request.turn)
    && JSON.stringify(action.review) === JSON.stringify(request.review);
}

function actionIdFromQueueEntryId(queueEntryId: string): string | undefined {
  const prefix = "scheduled-turn:";
  return queueEntryId.startsWith(prefix)
    ? queueEntryId.slice(prefix.length)
    : undefined;
}
