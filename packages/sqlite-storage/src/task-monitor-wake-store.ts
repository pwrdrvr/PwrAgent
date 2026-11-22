import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { JOB_MONITOR_WAKE_LIMIT, JOB_MONITOR_WAKE_WINDOW_MINUTES } from "@pwragent/shared/contracts/task-monitor-tools";

type Parent = { backend: AppServerBackendKind; threadId: string };
type Wake = Parent & { monitorId: string };
type Decision = "admitted" | "suppressed" | "review";
type ReviewVerdict = "loop" | "continue" | "unavailable";
type ReviewClaim = { id: string; generation: number };
type Review = {
  claim_id: string | null;
  claim_until: number;
  allowance: number;
  allowance_until: number;
  retry_after: number;
  acknowledged_at: number | null;
};
type Guard = { generation: number; tripped_at: number | null };
type Admission = { generation: number; admitted_at: number; dispatch_owner: string | null };

const KIND = "job_monitor";
const WINDOW_MS = JOB_MONITOR_WAKE_WINDOW_MINUTES * 60_000;
const JOB_MONITOR_REVIEW_LEASE_MS = 60_000;

/** One database per owning profile. Replay receipts outlive the rolling window and rearm. */
export class TaskMonitorWakeStore {
  constructor(private readonly db: Database.Database, private readonly now = Date.now) {}

  read(parent: Parent): { generation: number; tripped: boolean } {
    const guard = this.guard(parent);
    return { generation: guard.generation, tripped: guard.tripped_at !== null };
  }

  reserve(wake: Wake, generation: number): Decision {
    return this.db.transaction((): Decision => {
      const guard = this.guard(wake);
      if (guard.tripped_at !== null || guard.generation !== generation || this.admission(wake)) return "suppressed";
      return this.admit(wake, guard, undefined, null);
    }).immediate();
  }

  /** Recheck at FIFO dispatch, including entries restored from disk. A new
   * owner cannot replay a delivery an earlier owner may already have sent. */
  dispatch(wake: Wake, owner: string, legacy: boolean): Decision {
    return this.db.transaction((): Decision => {
      const guard = this.guard(wake);
      if (guard.tripped_at !== null) return "suppressed";
      const receipt = this.admission(wake);
      if (!this.matchesGeneration(guard, receipt, owner, legacy)) return "suppressed";
      return this.admit(wake, guard, receipt, owner);
    }).immediate();
  }

  /** Checks an operator release without spending or extending a dispatch slot. */
  canRelease(wake: Wake, owner: string, legacy: boolean): boolean {
    return this.db.transaction(() => {
      const guard = this.guard(wake);
      const receipt = this.admission(wake);
      return guard.tripped_at === null && this.matchesGeneration(guard, receipt, owner, legacy)
        && this.admissionBudget(wake, guard, receipt).decision !== "suppressed";
    }).deferred();
  }

  /** The provider definitively did not receive this steer. Keep its slot and make its receipt portable. */
  releaseUnsent(parent: Parent, monitorIds: readonly string[], owner: string): void {
    this.db.transaction(() => {
      const clear = this.db.prepare(`UPDATE thread_automatic_wake_admissions SET dispatch_owner = NULL
        WHERE backend = ? AND thread_id = ? AND kind = ? AND wake_id = ? AND dispatch_owner = ?`);
      for (const monitorId of monitorIds) clear.run(parent.backend, parent.threadId, KIND, monitorId, owner);
    }).immediate();
  }

  private matchesGeneration(guard: Guard, receipt: Admission | undefined, owner: string, legacy: boolean): boolean {
    return receipt
      ? receipt.generation === guard.generation && (receipt.dispatch_owner === null || receipt.dispatch_owner === owner)
      : legacy && guard.generation === 0;
  }

  rearm(parent: Parent, generation?: number): boolean {
    return this.db.transaction(() => {
      const guard = this.guard(parent);
      if (guard.tripped_at === null || (generation !== undefined && guard.generation !== generation)) return false;
      this.db.prepare(`UPDATE thread_automatic_wake_guards SET generation = generation + 1, tripped_at = NULL
        WHERE backend = ? AND thread_id = ? AND kind = ?`).run(parent.backend, parent.threadId, KIND);
      this.db.prepare(`DELETE FROM thread_automatic_wake_reviews WHERE backend = ? AND thread_id = ? AND kind = ?`)
        .run(parent.backend, parent.threadId, KIND);
      return true;
    }).immediate();
  }

  /** A read-only preview for FIFO drains. Dispatch still claims atomically. */
  dispatchNeedsReview(wake: Wake, owner: string, legacy: boolean): boolean {
    const guard = this.guard(wake);
    const receipt = this.admission(wake);
    return guard.tripped_at === null && this.matchesGeneration(guard, receipt, owner, legacy)
      && this.admissionBudget(wake, guard, receipt).decision === "review";
  }

  dispatchSpendsSlot(wake: Wake): boolean {
    const receipt = this.admission(wake);
    return !receipt || receipt.admitted_at <= this.now() - WINDOW_MS;
  }

  claimReview(parent: Parent): ReviewClaim | "pending" | "settled" {
    // Contenders waiting for an existing lease need no SQLite write lock.
    if ((this.review(parent)?.claim_until ?? 0) > this.now()) return "pending";
    return this.db.transaction(() => {
      const guard = this.guard(parent);
      const now = this.now();
      if (guard.tripped_at !== null || this.admissionBudget(parent, guard).decision !== "review") return "settled";
      if ((this.review(parent)?.claim_until ?? 0) > now) return "pending";
      const id = randomUUID();
      this.db.prepare(`INSERT INTO thread_automatic_wake_reviews (backend, thread_id, kind, claim_id, claim_until)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (backend, thread_id, kind) DO UPDATE SET
        claim_id = excluded.claim_id, claim_until = excluded.claim_until`)
        .run(parent.backend, parent.threadId, KIND, id, now + JOB_MONITOR_REVIEW_LEASE_MS);
      return { id, generation: guard.generation };
    }).immediate();
  }

  settleReview(parent: Parent, claim: ReviewClaim, verdict: ReviewVerdict): boolean {
    return this.db.transaction(() => {
      const guard = this.guard(parent);
      const now = this.now();
      if (guard.generation !== claim.generation || guard.tripped_at !== null) return false;
      const review = this.review(parent);
      if (review?.claim_id !== claim.id || review.claim_until <= now) return false;
      const budget = this.admissionBudget(parent, guard);
      this.db.prepare(`UPDATE thread_automatic_wake_reviews SET claim_id = NULL, claim_until = 0,
        allowance = ?, allowance_until = ?, retry_after = ?, acknowledged_at = NULL
        WHERE backend = ? AND thread_id = ? AND kind = ?`)
        .run(verdict === "continue" ? budget.count + JOB_MONITOR_WAKE_LIMIT : 0,
          budget.now + WINDOW_MS, verdict === "unavailable" ? budget.now + WINDOW_MS : 0,
          parent.backend, parent.threadId, KIND);
      if (verdict === "loop") {
        this.db.prepare(`INSERT INTO thread_automatic_wake_guards (backend, thread_id, kind, generation, tripped_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (backend, thread_id, kind) DO UPDATE SET tripped_at = excluded.tripped_at`)
          .run(parent.backend, parent.threadId, KIND, guard.generation, budget.now);
      }
      return true;
    }).immediate();
  }

  listAlerts(): Array<Parent & { generation: number; trippedAt: number }> {
    return this.db.prepare(`SELECT g.backend, g.thread_id AS threadId, g.generation, g.tripped_at AS trippedAt
      FROM thread_automatic_wake_guards g LEFT JOIN thread_automatic_wake_reviews r
      ON g.backend = r.backend AND g.thread_id = r.thread_id AND g.kind = r.kind
      WHERE g.kind = ? AND g.tripped_at IS NOT NULL AND r.acknowledged_at IS NULL
      ORDER BY g.tripped_at DESC, g.backend, g.thread_id LIMIT 100`).all(KIND) as Array<Parent & { generation: number; trippedAt: number }>;
  }

  acknowledge(parent: Parent, generation: number): boolean {
    return this.db.transaction(() => {
      const guard = this.guard(parent);
      if (guard.generation !== generation || guard.tripped_at === null) return false;
      if (this.review(parent)?.acknowledged_at != null) return false;
      this.db.prepare(`INSERT INTO thread_automatic_wake_reviews (backend, thread_id, kind, acknowledged_at)
        VALUES (?, ?, ?, ?) ON CONFLICT (backend, thread_id, kind) DO UPDATE SET acknowledged_at = excluded.acknowledged_at`)
        .run(parent.backend, parent.threadId, KIND, this.now());
      return true;
    }).immediate();
  }

  private guard(parent: Parent): Guard {
    return this.db.prepare(`SELECT generation, tripped_at FROM thread_automatic_wake_guards
      WHERE backend = ? AND thread_id = ? AND kind = ?`)
      .get(parent.backend, parent.threadId, KIND) as Guard | undefined ?? { generation: 0, tripped_at: null };
  }

  private admission(wake: Wake): Admission | undefined {
    return this.db.prepare(`SELECT generation, admitted_at, dispatch_owner FROM thread_automatic_wake_admissions
      WHERE backend = ? AND thread_id = ? AND kind = ? AND wake_id = ?`)
      .get(wake.backend, wake.threadId, KIND, wake.monitorId) as Admission | undefined;
  }

  private review(parent: Parent): Review | undefined {
    return this.db.prepare(`SELECT claim_id, claim_until, allowance, allowance_until, retry_after, acknowledged_at
      FROM thread_automatic_wake_reviews WHERE backend = ? AND thread_id = ? AND kind = ?`)
      .get(parent.backend, parent.threadId, KIND) as Review | undefined;
  }

  private admissionBudget(parent: Parent, guard: Guard, receipt?: Admission): { now: number; count: number; decision: Decision } {
    const scope = [parent.backend, parent.threadId, KIND, guard.generation] as const;
    const latest = this.db.prepare(`SELECT MAX(admitted_at) AS latest FROM thread_automatic_wake_admissions
      WHERE backend = ? AND thread_id = ? AND kind = ? AND generation = ?`).get(...scope) as { latest: number | null };
    const now = Math.max(this.now(), latest.latest ?? 0);
    const cutoff = now - WINDOW_MS;
    if (receipt && receipt.admitted_at > cutoff) return { now, count: 0, decision: "admitted" };
    const { count } = this.db.prepare(`SELECT COUNT(*) AS count FROM thread_automatic_wake_admissions
      WHERE backend = ? AND thread_id = ? AND kind = ? AND generation = ? AND admitted_at > ?`)
      .get(...scope, cutoff) as { count: number };
    if (count < JOB_MONITOR_WAKE_LIMIT) return { now, count, decision: "admitted" };
    const review = this.review(parent);
    if (review && now < review.allowance_until && count < review.allowance) return { now, count, decision: "admitted" };
    return { now, count, decision: review && now < review.retry_after ? "suppressed" : "review" };
  }

  /** Called inside the claim's immediate transaction, as with agent follow-ups.
   * An entry spends one slot. Dispatch renews that slot, so old holds cannot
   * combine with fresh reservations to release a burst above the budget. */
  private admit(wake: Wake, guard: Guard, receipt: Admission | undefined, owner: string | null): Decision {
    const scope = [wake.backend, wake.threadId, KIND, guard.generation] as const;
    const { now, decision } = this.admissionBudget(wake, guard, receipt);
    if (decision !== "admitted") return decision;
    if (receipt) {
      if (receipt.admitted_at !== now || receipt.dispatch_owner !== owner) {
        this.db.prepare(`UPDATE thread_automatic_wake_admissions SET admitted_at = ?, dispatch_owner = ?
          WHERE backend = ? AND thread_id = ? AND kind = ? AND wake_id = ?`)
          .run(now, owner, wake.backend, wake.threadId, KIND, wake.monitorId);
      }
    } else {
      this.db.prepare(`INSERT INTO thread_automatic_wake_admissions
        (backend, thread_id, kind, generation, wake_id, admitted_at, dispatch_owner) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(...scope, wake.monitorId, now, owner);
    }
    return "admitted";
  }
}
