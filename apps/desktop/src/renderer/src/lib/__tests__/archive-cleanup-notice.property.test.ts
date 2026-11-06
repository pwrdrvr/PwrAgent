import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ArchiveThreadCleanupResult } from "@pwragent/shared";
import { formatArchiveCleanupNotice, formatArchiveCleanupProgress } from "../archive-cleanup-notice";

describe("archive cleanup notices", () => {
  it("shows live work until the queue drains, including work that has not completed yet", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), fc.nat({ max: 256 }), fc.nat({ max: 1000 }), (active, queued, completed) => {
      const jobs = Array.from({ length: active }, (_, i) => ({ backend: "codex" as const, threadId: `thread-${i}`, worktreePath: `/contrived/worktree-${i}` }));
      const notice = formatArchiveCleanupProgress({ batchId: "fixture", active: jobs, queued, completed, total: active + queued + completed });
      expect(Boolean(notice)).toBe(active + queued > 0);
      if (notice) {
        expect(notice.autoDismiss).toBe(false);
        expect(notice.message).toContain(`${active} active`);
        expect(notice.message).toContain(`${queued} waiting`);
        expect(notice.facts?.map((fact) => fact.value)).toEqual(jobs.map((job) => job.worktreePath));
      }
    }));
  });

  it("raises a notice exactly when an outcome still needs attention, in outcome order", () => {
    const outcome = fc.record({
      kind: fc.constantFrom("removed", "absent", "shared", "repository-missing", "failed"),
      path: fc.string({ minLength: 1 }),
      hasError: fc.boolean(),
    }).map(({ kind, path, hasError }) => {
      const result: ArchiveThreadCleanupResult = {
        worktreePath: path,
        removedWorktree: kind === "removed",
        deletedBranch: false,
        ...(kind === "absent" ? { skippedReason: "Worktree directory no longer exists." } : {}),
        ...(kind === "shared" ? { skippedReason: "Worktree is still used by another active thread: other." } : {}),
        ...(kind === "repository-missing" ? { skippedReason: "Its repository no longer exists; the checkout was kept." } : {}),
        ...(hasError ? { error: "Snapshot failed." } : {}),
      };
      return { result, needsAttention: hasError || kind === "repository-missing" || kind === "failed" };
    });
    fc.assert(fc.property(fc.array(outcome, { maxLength: 30 }), (outcomes) => {
      const expected = outcomes.find((item) => item.needsAttention)?.result;
      const notice = formatArchiveCleanupNotice(outcomes.map((item) => item.result));
      expect(Boolean(notice)).toBe(Boolean(expected));
      if (expected) expect(notice?.detail).toBe(`${expected.worktreePath}: ${expected.error ?? expected.skippedReason ?? "cleanup was skipped"}`);
    }), { numRuns: 200 });
  });
});
