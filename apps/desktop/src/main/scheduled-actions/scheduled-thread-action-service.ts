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

export type ScheduledThreadActionServiceOptions = {
  registry: DesktopBackendRegistry;
  store: ScheduledThreadActionStore;
  now?: () => number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

let service: ScheduledThreadActionService | null = null;

export function getScheduledThreadActionService(
  registry = getDesktopBackendRegistry(),
): ScheduledThreadActionService {
  if (!service) {
    service = new ScheduledThreadActionService({
      registry,
      store: getAppScheduledThreadActionStore(),
    });
    service.start();
  }
  return service;
}

export function disposeScheduledThreadActionService(): void {
  service?.dispose();
  service = null;
}

export class ScheduledThreadActionService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private evaluating = false;
  private unsubscribeRegistryEvents?: () => void;

  constructor(private readonly options: ScheduledThreadActionServiceOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const failed = this.options.store.failInterruptedDispatches(this.now());
    for (const action of failed) {
      void this.publish(action);
    }
    const recovered = this.options.store.recoverInterruptedQueues(this.now());
    for (const action of recovered) {
      void this.publish(action);
    }
    this.unsubscribeRegistryEvents = this.options.registry.onEvent((event) =>
      this.handleRegistryEvent(event),
    );
    this.scheduleNextTimer();
    void this.evaluateDueActions();
  }

  dispose(): void {
    this.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.unsubscribeRegistryEvents?.();
    this.unsubscribeRegistryEvents = undefined;
  }

  list(
    request: ListScheduledThreadActionsRequest = {},
  ): ListScheduledThreadActionsResponse {
    return { actions: this.options.store.list(request) };
  }

  async create(
    request: CreateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    validateScheduledActionRequest(request);
    const now = this.now();
    const action = this.options.store.create({
      ...request,
      id: `scheduled-action:${randomUUID()}`,
      origin: request.origin ?? "desktop",
      now,
    });
    await this.publish(action);
    this.scheduleNextTimer();
    if (action.scheduledFor <= now) {
      await this.evaluateDueActions();
    }
    return { action: this.options.store.get(action.id) ?? action };
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
    await this.publish(updated);
    this.scheduleNextTimer();
    if (updated.scheduledFor <= this.now()) {
      await this.evaluateDueActions();
    }
    return { action: this.options.store.get(updated.id) ?? updated };
  }

  async cancel(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const current = this.requireAction(request.id);
    let cancelled: ScheduledThreadAction | undefined;
    if (current.status === "scheduled") {
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
    await this.publish(cancelled);
    this.scheduleNextTimer();
    return { action: cancelled };
  }

  async sendNow(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const claimed = this.options.store.claim(request.id, this.now());
    if (!claimed) {
      throw new Error("The scheduled action is no longer scheduled.");
    }
    await this.publish(claimed);
    await this.dispatch(claimed);
    this.scheduleNextTimer();
    return { action: this.options.store.get(claimed.id) ?? claimed };
  }

  async evaluateDueActions(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const claimed = this.options.store.claimDue({ now: this.now() });
      for (const action of claimed) {
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
            )
          : this.options.store.markQueued(
              action.id,
              response.pendingReviewId,
              this.now(),
            );
        if (updated) await this.publish(updated);
        return;
      }
      if (!action.turn) {
        throw new Error("Scheduled turn payload is missing.");
      }
      const queueEntryId = queueEntryIdForAction(action.id);
      const response = await this.options.registry.submitTurn({
        ...action.turn,
        backend: action.backend,
        threadId: action.threadId,
        origin: "scheduled",
        queueEntryId,
      });
      const updated = response.status === "queued"
        ? this.options.store.markQueued(action.id, response.entry.id, this.now())
        : this.options.store.markStarted(action.id, response.turnId, this.now());
      if (updated) await this.publish(updated);
    } catch (error) {
      const failed = this.options.store.markFailed(
        action.id,
        error instanceof Error ? error.message : String(error),
        this.now(),
      );
      if (failed) await this.publish(failed);
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
    if (updated) await this.publish(updated);
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
    if (updated) await this.publish(updated);
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
  if (!request.displayText.trim()) {
    throw new Error("Scheduled action display text is required.");
  }
  if (request.kind === "turn" && !request.turn?.input.length) {
    throw new Error("Scheduled turns require non-empty input.");
  }
  if (request.kind === "review" && !request.review) {
    throw new Error("Scheduled reviews require review configuration.");
  }
}

function queueEntryIdForAction(actionId: string): string {
  return `scheduled-turn:${actionId}`;
}

function actionIdFromQueueEntryId(queueEntryId: string): string | undefined {
  const prefix = "scheduled-turn:";
  return queueEntryId.startsWith(prefix)
    ? queueEntryId.slice(prefix.length)
    : undefined;
}
