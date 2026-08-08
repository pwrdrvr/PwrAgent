import { createHash, randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  PrAutoDispatchBudgetConfig,
  PrAutoDispatchBudgetStatus,
  PrSummary,
  ThreadOverlayState,
  ThreadPrAutoDispatchEventKind,
  ThreadPrAutoDispatchPending,
} from "@pwragent/shared";
import {
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  parseThreadIdentityKey,
} from "@pwragent/shared";
import type {
  PrAutoDispatchBudgetCompletionResult,
  PrAutoDispatchBudgetReservationResult,
  PrAutoDispatchPendingRecord,
  PrAutoDispatchRecoveryResult,
  PrAutoDispatchScheduleResult,
} from "../state/overlay-store-sqlite";
import { isTerminalPullRequest } from "./pr-derivations";

export const MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT = 2;
export const PR_AUTO_DISPATCH_DELAY_MS = 30_000;
export const PR_AUTO_DISPATCH_LEASE_MS = 60_000;
const PR_AUTO_DISPATCH_LEASE_HEARTBEAT_MS = 20_000;
const PR_AUTO_DISPATCH_RESUME_RETRY_MS = 15_000;

export type PrAutoDispatchOutcome = {
  threadKey: string;
  status:
    | "scheduled"
    | "dispatched"
    | "gate-off"
    | "not-actionable"
    | "deferred"
    | "missing-head"
    | "disabled"
    | "busy"
    | "pending"
    | "duplicate"
    | "attempt-limit"
    | "cancelled"
    | "stale"
    | "failed";
  fingerprint?: string;
  error?: string;
};

type PrAutoDispatchStore = {
  getThreadOverlayState(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadOverlayState | undefined>;
  scheduleThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    threadId: string;
    pending: ThreadPrAutoDispatchPending;
    prompt: string;
    maxAttempts: number;
    allowCancelledRearm?: boolean;
  }): Promise<PrAutoDispatchScheduleResult>;
  resetThreadPrAutoDispatchForOperator(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<boolean>;
  beginThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
    leaseExpiresAt: number;
    maxAttempts: number;
    now: number;
    ownerId: string;
  }): Promise<
    | { status: "ready"; attemptCount: number; record: PrAutoDispatchPendingRecord }
    | { status: "disabled" | "stale" | "attempt-limit" }
  >;
  reserveThreadPrAutoDispatchBudget(params: {
    backend: AppServerBackendKind;
    config: PrAutoDispatchBudgetConfig;
    fingerprint: string;
    now: number;
    ownerId: string;
    threadId: string;
  }): Promise<PrAutoDispatchBudgetReservationResult>;
  rejectThreadPrAutoDispatchForBudget(params: {
    backend: AppServerBackendKind;
    fingerprint: string;
    now: number;
    ownerId: string;
    threadId: string;
  }): Promise<boolean>;
  restoreThreadPrAutoDispatchAfterBusy(params: {
    backend: AppServerBackendKind;
    budgetConfig: PrAutoDispatchBudgetConfig;
    threadId: string;
    fingerprint: string;
    ownerId: string;
    scheduledAt: number;
    now: number;
  }): Promise<ThreadPrAutoDispatchPending | undefined>;
  renewThreadPrAutoDispatchLease(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
    leaseExpiresAt: number;
    now: number;
    ownerId: string;
  }): Promise<boolean>;
  finishThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    budgetConfig: PrAutoDispatchBudgetConfig;
    threadId: string;
    fingerprint: string;
    ownerId: string;
    refundBudgetReservation?: boolean;
    status: "dispatched" | "failed";
    now: number;
  }): Promise<PrAutoDispatchBudgetCompletionResult | undefined>;
  cancelThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
    now?: number;
    status?: "cancelled" | "deferred" | "resolved" | "superseded";
  }): Promise<boolean>;
  cancelPendingThreadPrAutoDispatchForPr(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
    now: number;
  }): Promise<boolean>;
  resolveThreadPrAutoDispatchIncident(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
    resolvedKinds: ThreadPrAutoDispatchEventKind[];
    now: number;
  }): Promise<void>;
  getThreadPrAutoDispatchPending(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<PrAutoDispatchPendingRecord | undefined>;
  listPendingThreadPrAutoDispatches(): Promise<Array<
    PrAutoDispatchPendingRecord & {
      backend: AppServerBackendKind;
      threadId: string;
    }
  >>;
  recoverOrphanedThreadPrAutoDispatches(params: {
    budgetConfig: PrAutoDispatchBudgetConfig;
    now: number;
    scheduledAt: number;
  }): Promise<PrAutoDispatchRecoveryResult>;
};

type PrAutoDispatchRegistry = {
  submitTurnIfIdle(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin: "automation";
    messageOrigin: AppServerThreadMessageOrigin;
  }): Promise<
    | { status: "started"; turnId: string }
    | { status: "busy" }
  >;
};

export type PrAutoDispatchEvent = {
  eventKinds: ThreadPrAutoDispatchEventKind[];
  fingerprint: string;
  headSha: string;
  prKey: string;
};

export class PrAutoDispatchCoordinator {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ownerId = randomUUID();
  private recoveryTimer: NodeJS.Timeout | undefined;
  private resumePromise: Promise<void> | undefined;
  private resumed = false;

  constructor(
    private readonly options: {
      store: PrAutoDispatchStore;
      registry: PrAutoDispatchRegistry;
      isBackgroundPollingEnabled?: () => boolean;
      isPrAttached?: (params: {
        backend: AppServerBackendKind;
        threadId: string;
        prKey: string;
      }) => boolean;
      getCurrentPr?: (prKey: string) => PrSummary | undefined;
      refreshPendingPrs?: (
        pending: ThreadPrAutoDispatchPending[],
      ) => Promise<ReadonlySet<string>>;
      onPendingChanged?: (params: {
        backend: AppServerBackendKind;
        threadId: string;
        pending: ThreadPrAutoDispatchPending | null;
      }) => void | Promise<void>;
      getBudgetConfig?: () => PrAutoDispatchBudgetConfig;
      onBudgetStatusChanged?: (
        status: PrAutoDispatchBudgetStatus,
      ) => void | Promise<void>;
      now?: () => number;
    },
  ) {}

  async handleStatusSnapshot(params: {
    pr: PrSummary;
    threadKeys: string[];
    observedAt: number;
    backgroundPollingEnabled: boolean;
    operatorInitiated?: boolean;
  }): Promise<PrAutoDispatchOutcome[]> {
    if (!params.backgroundPollingEnabled) {
      return params.threadKeys.map((threadKey) => ({
        threadKey,
        status: "gate-off",
      }));
    }

    const eventKinds = getPrAutoDispatchEventKinds(params.pr);
    const event = buildPrAutoDispatchEvent(params.pr);
    const prKey = buildPullRequestStatusKey(params.pr);
    const resolvedKinds = getDefinitivelyResolvedEventKinds(params.pr);
    const outcomes: PrAutoDispatchOutcome[] = [];

    for (const threadKey of params.threadKeys) {
      const identity = parseThreadIdentityKey(threadKey);
      if (!identity) {
        outcomes.push({ threadKey, status: "disabled" });
        continue;
      }

      await this.options.store.resolveThreadPrAutoDispatchIncident({
        ...identity,
        prKey,
        resolvedKinds,
        now: params.observedAt,
      });

      if (!event) {
        const record = await this.options.store
          .getThreadPrAutoDispatchPending(identity);
        const deferred = Boolean(
          record
          && shouldDeferPendingCiFailure(record.pending, params.pr),
        );
        const cancelled = deferred && record
          ? await this.options.store.cancelThreadPrAutoDispatch({
              ...identity,
              fingerprint: record.pending.fingerprint,
              now: params.observedAt,
              status: "deferred",
            })
          : await this.options.store.cancelPendingThreadPrAutoDispatchForPr({
              ...identity,
              prKey,
              now: params.observedAt,
            });
        if (cancelled) {
          this.clearTimer(threadKey);
          await this.notifyPending(identity, null);
        }
        outcomes.push({
          threadKey,
          status: deferred
            ? "deferred"
            : eventKinds.length > 0 ? "missing-head" : "not-actionable",
        });
        continue;
      }

      const pending: ThreadPrAutoDispatchPending = {
        fingerprint: event.fingerprint,
        prKey: event.prKey,
        prNumber: params.pr.number,
        ...(params.pr.title ? { prTitle: params.pr.title } : {}),
        prUrl: params.pr.url,
        ...(params.pr.failedCheckUrl
          ? { failedCheckUrl: params.pr.failedCheckUrl }
          : {}),
        headSha: event.headSha,
        eventKinds: event.eventKinds,
        createdAt: params.observedAt,
        scheduledAt: params.observedAt + PR_AUTO_DISPATCH_DELAY_MS,
      };
      const result = await this.options.store.scheduleThreadPrAutoDispatch({
        ...identity,
        pending,
        prompt: buildPrAutoDispatchPrompt({
          event,
          observedAt: params.observedAt,
          pr: params.pr,
        }),
        maxAttempts: MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
        allowCancelledRearm: params.operatorInitiated,
      });
      outcomes.push({
        threadKey,
        status: result.status,
        fingerprint: event.fingerprint,
      });
      if (result.pending) {
        this.arm(identity, result.pending);
      }
      if (result.status === "scheduled") {
        await this.notifyPending(identity, pending);
      }
    }
    return outcomes;
  }

  async cancelPending(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
  }): Promise<boolean> {
    const cancelled = await this.options.store.cancelThreadPrAutoDispatch({
      ...params,
      now: this.now(),
    });
    if (cancelled) {
      this.clearTimer(this.threadKey(params));
      await this.notifyPending(params, null);
    }
    return cancelled;
  }

  async resetForOperator(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<boolean> {
    const reset = await this.options.store
      .resetThreadPrAutoDispatchForOperator(params);
    this.clearTimer(this.threadKey(params));
    if (reset) await this.notifyPending(params, null);
    return reset;
  }

  async sendPendingNow(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
  }): Promise<boolean> {
    if (this.options.isBackgroundPollingEnabled?.() === false) return false;
    const record = await this.options.store.getThreadPrAutoDispatchPending(params);
    if (!record || record.pending.fingerprint !== params.fingerprint) return false;
    this.clearTimer(this.threadKey(params));
    await this.dispatchPending(params, params.fingerprint);
    return true;
  }

  async cancelAllPendingForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<boolean> {
    const record = await this.options.store.getThreadPrAutoDispatchPending(params);
    if (!record) return false;
    return await this.cancelPending({
      ...params,
      fingerprint: record.pending.fingerprint,
    });
  }

  async cancelPendingForPr(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
  }): Promise<boolean> {
    const record = await this.options.store.getThreadPrAutoDispatchPending(params);
    if (!record || record.pending.prKey !== params.prKey) return false;
    return await this.cancelPending({
      backend: params.backend,
      threadId: params.threadId,
      fingerprint: record.pending.fingerprint,
    });
  }

  async resume(): Promise<void> {
    if (this.options.isBackgroundPollingEnabled?.() === false) return;
    if (this.resumed) return;
    if (this.resumePromise) return await this.resumePromise;
    this.resumePromise = this.resumeFromStore()
      .finally(() => {
        this.resumePromise = undefined;
      });
    return await this.resumePromise;
  }

  pause(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.resumed = false;
  }

  close(): void {
    this.pause();
  }

  private arm(
    identity: { backend: AppServerBackendKind; threadId: string },
    pending: ThreadPrAutoDispatchPending,
  ): void {
    if (this.options.isBackgroundPollingEnabled?.() === false) return;
    const threadKey = this.threadKey(identity);
    this.clearTimer(threadKey);
    const timer = setTimeout(() => {
      this.timers.delete(threadKey);
      void this.dispatchPending(identity, pending.fingerprint);
    }, Math.max(0, pending.scheduledAt - this.now()));
    timer.unref?.();
    this.timers.set(threadKey, timer);
  }

  private async dispatchPending(
    identity: { backend: AppServerBackendKind; threadId: string },
    fingerprint: string,
  ): Promise<void> {
    if (this.options.isBackgroundPollingEnabled?.() === false) return;
    const record = await this.options.store.getThreadPrAutoDispatchPending(identity);
    if (!record || record.pending.fingerprint !== fingerprint) return;

    const currentPr = this.options.getCurrentPr?.(record.pending.prKey);
    const currentEvent = currentPr
      ? buildPrAutoDispatchEvent(currentPr)
      : undefined;
    const attached = this.options.isPrAttached?.({
      ...identity,
      prKey: record.pending.prKey,
    }) ?? true;
    if (
      attached
      && currentPr
      && shouldDeferPendingCiFailure(record.pending, currentPr)
    ) {
      await this.options.store.cancelThreadPrAutoDispatch({
        ...identity,
        fingerprint,
        now: this.now(),
        status: "deferred",
      });
      await this.notifyPending(identity, null);
      return;
    }
    if (
      !attached
      || !currentEvent
      || currentEvent.fingerprint !== fingerprint
    ) {
      await this.options.store.cancelThreadPrAutoDispatch({
        ...identity,
        fingerprint,
        now: this.now(),
        status: "superseded",
      });
      await this.notifyPending(identity, null);
      return;
    }

    const now = this.now();
    const begin = await this.options.store.beginThreadPrAutoDispatch({
      ...identity,
      fingerprint,
      leaseExpiresAt: now + PR_AUTO_DISPATCH_LEASE_MS,
      maxAttempts: MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
      now,
      ownerId: this.ownerId,
    });
    if (begin.status !== "ready") {
      if (begin.status === "disabled") {
        await this.options.store.cancelThreadPrAutoDispatch({
          ...identity,
          fingerprint,
          now,
        });
      }
      if (begin.status !== "stale") {
        await this.notifyPending(identity, null);
      }
      return;
    }

    if (this.options.isBackgroundPollingEnabled?.() === false) {
      await this.restoreAfterBusy(identity, fingerprint, now);
      return;
    }

    const reservation = await this.options.store.reserveThreadPrAutoDispatchBudget({
      ...identity,
      config: this.budgetConfig(),
      fingerprint,
      now: this.now(),
      ownerId: this.ownerId,
    });
    if (reservation.budget.paused) {
      await this.notifyBudgetStatus(reservation.budget);
    }
    if (reservation.status !== "reserved") {
      if (reservation.status !== "stale") {
        await this.options.store.rejectThreadPrAutoDispatchForBudget({
          ...identity,
          fingerprint,
          now: this.now(),
          ownerId: this.ownerId,
        });
        await this.notifyPending(identity, null);
      }
      return;
    }

    const stopLeaseHeartbeat = this.startLeaseHeartbeat(identity, fingerprint);
    try {
      const submission = await this.options.registry.submitTurnIfIdle({
        ...identity,
        input: [{
          type: "text",
          text: [
            begin.record.prompt,
            `- Automatic attempt: ${begin.attemptCount}/${MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT}`,
          ].join("\n"),
        }],
        origin: "automation",
        messageOrigin: {
          kind: "pwragent",
          prAutomation: {
            kind: "auto-fix",
            prKey: begin.record.pending.prKey,
            prNumber: begin.record.pending.prNumber,
            ...(begin.record.pending.prTitle
              ? { prTitle: begin.record.pending.prTitle }
              : {}),
            ...(begin.record.pending.failedCheckUrl
              ? { failedCheckUrl: begin.record.pending.failedCheckUrl }
              : {}),
            headSha: begin.record.pending.headSha,
            eventKinds: begin.record.pending.eventKinds,
          },
        },
      });
      if (submission.status === "busy") {
        await this.restoreAfterBusy(identity, fingerprint, now);
        return;
      }
      const completion = await this.options.store.finishThreadPrAutoDispatch({
        ...identity,
        budgetConfig: this.budgetConfig(),
        fingerprint,
        ownerId: this.ownerId,
        status: "dispatched",
        now: this.now(),
      });
      if (completion?.budget.paused) {
        await this.notifyBudgetStatus(completion.budget);
      }
      await this.notifyPending(identity, null);
    } catch {
      const completion = await this.options.store.finishThreadPrAutoDispatch({
        ...identity,
        budgetConfig: this.budgetConfig(),
        fingerprint,
        ownerId: this.ownerId,
        refundBudgetReservation: true,
        status: "failed",
        now: this.now(),
      });
      if (completion?.budget.paused) {
        await this.notifyBudgetStatus(completion.budget);
      }
      await this.notifyPending(identity, null);
    } finally {
      stopLeaseHeartbeat();
    }
  }

  private async restoreAfterBusy(
    identity: { backend: AppServerBackendKind; threadId: string },
    fingerprint: string,
    now: number,
  ): Promise<void> {
    const pending = await this.options.store.restoreThreadPrAutoDispatchAfterBusy({
      ...identity,
      budgetConfig: this.budgetConfig(),
      fingerprint,
      ownerId: this.ownerId,
      scheduledAt: now + PR_AUTO_DISPATCH_DELAY_MS,
      now,
    });
    if (!pending) return;
    await this.notifyPending(identity, pending);
    this.arm(identity, pending);
  }

  private async resumeFromStore(): Promise<void> {
    const now = this.now();
    const recovery = await this.options.store.recoverOrphanedThreadPrAutoDispatches({
      budgetConfig: this.budgetConfig(),
      now,
      scheduledAt: now + PR_AUTO_DISPATCH_DELAY_MS,
    });
    let records = await this.options.store.listPendingThreadPrAutoDispatches();
    let refreshedPrKeys: ReadonlySet<string> | undefined;
    if (records.length > 0 && this.options.refreshPendingPrs) {
      try {
        refreshedPrKeys = await this.options.refreshPendingPrs(
          records.map((record) => record.pending),
        );
        records = await this.options.store.listPendingThreadPrAutoDispatches();
      } catch {
        this.armRecovery(this.now() + PR_AUTO_DISPATCH_RESUME_RETRY_MS);
        return;
      }
    }
    if (this.options.isBackgroundPollingEnabled?.() === false) {
      this.resumed = false;
      return;
    }
    for (const record of records) {
      if (refreshedPrKeys && !refreshedPrKeys.has(record.pending.prKey)) {
        continue;
      }
      this.arm(record, record.pending);
    }
    const skippedRefresh =
      refreshedPrKeys
      && records.some((record) => !refreshedPrKeys.has(record.pending.prKey));
    this.resumed = !skippedRefresh;
    this.armRecovery(
      skippedRefresh
        ? this.now() + PR_AUTO_DISPATCH_RESUME_RETRY_MS
        : recovery.nextLeaseExpiresAt
          ?? this.now() + PR_AUTO_DISPATCH_LEASE_MS,
    );
  }

  private armRecovery(at: number | undefined): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    if (at === undefined || this.options.isBackgroundPollingEnabled?.() === false) {
      return;
    }
    const timer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.resumed = false;
      void this.resume();
    }, Math.max(0, at - this.now()));
    timer.unref?.();
    this.recoveryTimer = timer;
  }

  private startLeaseHeartbeat(
    identity: { backend: AppServerBackendKind; threadId: string },
    fingerprint: string,
  ): () => void {
    const timer = setInterval(() => {
      const now = this.now();
      void this.options.store
        .renewThreadPrAutoDispatchLease({
          ...identity,
          fingerprint,
          leaseExpiresAt: now + PR_AUTO_DISPATCH_LEASE_MS,
          now,
          ownerId: this.ownerId,
        })
        .catch(() => undefined);
    }, PR_AUTO_DISPATCH_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async notifyPending(
    identity: { backend: AppServerBackendKind; threadId: string },
    pending: ThreadPrAutoDispatchPending | null,
  ): Promise<void> {
    await this.options.onPendingChanged?.({ ...identity, pending });
  }

  private async notifyBudgetStatus(
    status: PrAutoDispatchBudgetStatus,
  ): Promise<void> {
    await this.options.onBudgetStatusChanged?.(status);
  }

  private clearTimer(threadKey: string): void {
    const timer = this.timers.get(threadKey);
    if (timer) clearTimeout(timer);
    this.timers.delete(threadKey);
  }

  private threadKey(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): string {
    return buildThreadIdentityKey(params.backend, params.threadId);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private budgetConfig(): PrAutoDispatchBudgetConfig {
    return this.options.getBudgetConfig?.() ?? {
      capacity: DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
      refillPerMinute: DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
      pauseWhenEmpty: DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
    };
  }
}

export function getPrAutoDispatchEventKinds(
  pr: PrSummary,
): ThreadPrAutoDispatchEventKind[] {
  if (isTerminalPullRequest(pr)) return [];
  const eventKinds: ThreadPrAutoDispatchEventKind[] = [];
  if (pr.checkState === "failing" && !pr.checksStillRunning) {
    eventKinds.push("ci-failure");
  }
  if (pr.mergeState === "conflicting") eventKinds.push("merge-conflict");
  return eventKinds;
}

export function buildPrRepositoryKey(
  host: string,
  owner: string,
  repo: string,
): string {
  return [host, owner, repo]
    .map((part) => part.trim().toLowerCase())
    .join("/");
}

export function pullRequestMatchesRepositoryKey(
  pr: PrSummary,
  repositoryKey: string | undefined,
): boolean {
  return Boolean(
    repositoryKey
    && buildPrRepositoryKey(pr.provider, pr.org, pr.repo) === repositoryKey,
  );
}

export function buildPrAutoDispatchEvent(
  pr: PrSummary,
): PrAutoDispatchEvent | undefined {
  const eventKinds = getPrAutoDispatchEventKinds(pr);
  if (eventKinds.length === 0 || !pr.headSha) return undefined;
  const prKey = buildPullRequestStatusKey(pr);
  const fingerprintPayload = {
    version: 2,
    prKey,
    headSha: pr.headSha,
    eventKinds,
    checkState: eventKinds.includes("ci-failure") ? pr.checkState : undefined,
    mergeState: eventKinds.includes("merge-conflict") ? pr.mergeState : undefined,
  };
  return {
    eventKinds,
    headSha: pr.headSha,
    prKey,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprintPayload))
      .digest("hex"),
  };
}

function shouldDeferPendingCiFailure(
  pending: ThreadPrAutoDispatchPending,
  pr: PrSummary,
): boolean {
  return (
    !isTerminalPullRequest(pr)
    && pr.checksStillRunning === true
    && pending.prKey === buildPullRequestStatusKey(pr)
    && pending.headSha === pr.headSha
    && pending.eventKinds.includes("ci-failure")
  );
}

function getDefinitivelyResolvedEventKinds(
  pr: PrSummary,
): ThreadPrAutoDispatchEventKind[] {
  const resolved: ThreadPrAutoDispatchEventKind[] = [];
  // Pending/unknown are intentionally not healthy: a repair push normally
  // passes through pending before it can fail, and resetting here would turn
  // the finite attempt budget into an unbounded loop.
  if (pr.checkState === "passing") resolved.push("ci-failure");
  if (pr.mergeState === "mergeable") resolved.push("merge-conflict");
  return resolved;
}

function buildPrAutoDispatchPrompt(params: {
  event: PrAutoDispatchEvent;
  observedAt: number;
  pr: PrSummary;
}): string {
  return [
    "PwrAgent scheduled this bounded repair turn because an attached pull request needs attention.",
    "",
    "Pull request event",
    `- PR: ${params.event.prKey}`,
    `- URL: ${params.pr.url}`,
    `- Title: ${params.pr.title ?? "(untitled)"}`,
    `- Head SHA: ${params.event.headSha}`,
    `- Event kinds: ${params.event.eventKinds.join(", ")}`,
    `- Check state: ${params.pr.checkState ?? "unknown"}`,
    `- Merge state: ${params.pr.mergeState ?? "unknown"}`,
    `- Observed at: ${new Date(params.observedAt).toISOString()}`,
    `- Dedupe fingerprint: ${params.event.fingerprint}`,
    "",
    "Investigate the current PR checks or merge conflict, make only scoped fixes, run relevant validation, and update the attached PR when appropriate. Verify current provider state before changing code. If the condition is external, transient, or no safe fix is available, explain that and stop; do not create another retry loop.",
  ].join("\n");
}
