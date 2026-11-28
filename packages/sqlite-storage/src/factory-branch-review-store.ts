import type { PinnedBranchReviewVerdict } from "@pwragent/shared/contracts/normalized-app-server";
import type { StateDb } from "./state-db";

export type FactoryBranchReviewAttempt = {
  id: string;
  approvalId: string;
  worktree: string;
  mergeBaseOid: string;
  runtimeId: string;
  reviewerThreadId?: string;
  turnId?: string;
  result?: FactoryBranchReviewResult;
};

export type FactoryBranchReviewResult = PinnedBranchReviewVerdict | "failed" | "cancelled" | "refused";

export class SqliteFactoryBranchReviewStore {
  constructor(private readonly state: StateDb) {}

  read(id: string): FactoryBranchReviewAttempt | undefined {
    const row = this.state.raw.prepare(`
      SELECT id, approval_id AS approvalId, worktree, runtime_id AS runtimeId,
        merge_base_oid AS mergeBaseOid, reviewer_thread_id AS reviewerThreadId, turn_id AS turnId, result
      FROM factory_branch_reviews WHERE id = ?
    `).get(id) as FactoryBranchReviewAttempt | undefined;
    return row;
  }

  claim(attempt: FactoryBranchReviewAttempt): boolean {
    return this.durable(() => this.state.raw.prepare(`
      INSERT INTO factory_branch_reviews (id, approval_id, worktree, runtime_id, merge_base_oid)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(attempt.id, attempt.approvalId, attempt.worktree, attempt.runtimeId, attempt.mergeBaseOid).changes === 1);
  }

  observe(id: string, reviewerThreadId: string | null, turnId: string | null, result: FactoryBranchReviewResult | null): void {
    this.durable(() => this.state.raw.prepare(`
      UPDATE factory_branch_reviews SET reviewer_thread_id = ?, turn_id = ?, result = ?
      WHERE id = ? AND result IS NULL
        AND (turn_id IS NULL OR (turn_id = ? AND reviewer_thread_id = ?))
        AND (turn_id IS NULL OR ? IS NOT NULL)
    `).run(reviewerThreadId, turnId, result, id, turnId, reviewerThreadId, result));
  }

  private durable<T>(write: () => T): T {
    const db = this.state.raw;
    const synchronous = db.pragma("synchronous", { simple: true }) as number;
    db.pragma("synchronous = FULL");
    try { return db.transaction(write).immediate(); }
    finally { db.pragma(`synchronous = ${synchronous}`); }
  }
}
