import type {
  AppServerBackendKind,
  PrSummary,
  PrAutoDispatchBudgetConfig,
  PrAutoDispatchBudgetStatus,
  ThreadOverlayState,
  ThreadPrAutoDispatchEventKind,
  ThreadPrAutoDispatchPending,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";

export type PrAutoDispatchPendingRecord = {
  dispatchLease?: {
    expiresAt: number;
    ownerId: string;
  };
  pending: ThreadPrAutoDispatchPending;
  prompt: string;
};

export type PrAutoDispatchRecoveryResult = {
  nextLeaseExpiresAt?: number;
  recoveredCount: number;
};

export type PrAutoDispatchScheduleResult = {
  status: "scheduled" | "disabled" | "duplicate" | "attempt-limit" | "pending";
  pending?: ThreadPrAutoDispatchPending;
};

export type PrAutoDispatchBudgetReservationResult =
  | {
      budget: PrAutoDispatchBudgetStatus;
      status: "reserved";
    }
  | {
      budget: PrAutoDispatchBudgetStatus;
      status: "empty" | "paused" | "stale";
    };

export type PrAutoDispatchBudgetCompletionResult = {
  budget: PrAutoDispatchBudgetStatus;
  pausedNow: boolean;
};

export type PrStatusWatchClaim = {
  attemptCount: number;
  watch: ThreadPullRequestWatchSummary;
  terminalObservation?: PrTerminalWatchObservation;
};

export type PrTerminalWatchObservation = { pr: PrSummary; observedAt: number };

/** A thread whose PR watches changed, for `thread/prWatches/updated`. */
export type PrStatusWatchThreadRef = {
  backend: ThreadOverlayState["backend"];
  threadId: string;
  prKey: string;
};

export type PrStatusWatchAdvanceResult = {
  /** CI watches copied to the new head; the old rows end as `moved`. */
  moved: number;
  /** CI watches ended because the thread already watched the new head. */
  superseded: number;
  baselinesCleared: number;
  threads: PrStatusWatchThreadRef[];
};

export type PrStatusWatchClaimResult = {
  claims: PrStatusWatchClaim[];
  /**
   * Threads whose watches the claim changed without claiming: a covered
   * failure became a held watch's baseline, or ended a failure-only watch.
   */
  threads: PrStatusWatchThreadRef[];
};

/** Auto-fix persistence, independent of the host store and its database. */
export interface PrAutoDispatchStorage {
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
    | { status: "disabled" | "locked" | "stale" | "attempt-limit" }
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
}

/** PR watch claims and leases. The host retains its existing transaction policy. */
export interface PrStatusWatchStorage {
  claimThreadPrStatusWatches(params: {
    prKey: string;
    headSha: string;
    outcome: "success" | "failure";
    now: number;
    ownerId: string;
    leaseExpiresAt: number;
    maxAttempts: number;
    /**
     * Set when the PR is merged or closed: a thread that also holds a
     * terminal watch gets one terminal wake instead of a CI wake as well.
     */
    skipThreadsWithTerminalWatch?: boolean;
    /**
     * The failing check's link. A watch whose baseline failure has another
     * link is past it: a re-run creates new job ids, so attempt 2's failure
     * fires even when no poll saw the checks running in between.
     */
    failedCheckUrl?: string;
    /**
     * `backend:threadId` keys whose failure something else handles, such as
     * Auto-fix. Their watches are never claimed. One that also waits for
     * success takes the failure as its baseline and keeps waiting for success
     * or another failure. A failure-only watch ends as `covered_by_auto_fix`.
     * Neither ends another thread's watch: the oldest uncovered watch is
     * claimed in the same pass.
     */
    skipThreadKeys?: ReadonlySet<string>;
  }): Promise<PrStatusWatchClaimResult>;
  finishThreadPrStatusWatch(params: {
    watchId: string;
    ownerId: string;
    prKey: string;
    headSha: string;
    outcome: "success" | "failure";
    now: number;
    failedCheckUrl?: string;
    skipThreadKeys?: ReadonlySet<string>;
  }): Promise<PrStatusWatchThreadRef[]>;
  releaseThreadPrStatusWatch(params: {
    watchId: string;
    ownerId: string;
    now: number;
    spendAttempt: boolean;
    maxAttempts: number;
  }): Promise<"watching" | "pending_terminal" | "failed" | undefined>;
  renewThreadPrStatusWatchLease(params: {
    watchId: string;
    ownerId: string;
    now: number;
    leaseExpiresAt: number;
  }): Promise<boolean>;
  advanceThreadPrStatusWatches(params: {
    prKey: string;
    headSha: string;
    /** No CI outcome yet at this head. */
    checksRunning: boolean;
    now: number;
  }): Promise<PrStatusWatchAdvanceResult>;
  claimThreadPrTerminalWatches(params: {
    prKey: string;
    now: number;
    ownerId: string;
    leaseExpiresAt: number;
    maxAttempts: number;
  }): Promise<PrStatusWatchClaim[]>;
  observeThreadPrTerminalWatches(params: {
    pr: PrSummary;
    observedAt: number;
    outcome: "merged" | "closed";
    now: number;
  }): Promise<PrStatusWatchThreadRef[]>;
  finishThreadPrTerminalWatch(params: {
    watchId: string;
    ownerId: string;
    outcome: "merged" | "closed";
    now: number;
  }): Promise<void>;
  isThreadPrStatusWatchClaimActive(params: { watchId: string; ownerId: string }): Promise<boolean>;
}
