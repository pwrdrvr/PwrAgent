import { expect, it } from "vitest";
import fc from "fast-check";
import type { ArchiveThreadCleanupResult } from "@pwragent/shared";
import { BackgroundArchiveCleanupReport } from "../background-archive-cleanup-report";

it("keeps the thread identity beside each failed checkout in background reports", () => {
  fc.assert(fc.property(fc.uuid(), fc.uuid(), (threadId, path) => {
    const report = new BackgroundArchiveCleanupReport();
    report.record("codex", { threadId, archivedAt: 1,
      cleanup: [{ worktreePath: `/contrived/${path}`, removedWorktree: false, deletedBranch: false, error: "Snapshot failed" }] },
    { threadLink: { backend: "codex", threadId, title: "Repair build caching", instanceId: "fixture-peer" } });
    const diagnostics = report.notice()?.facts?.map((fact) => fact.value).join("\n");
    for (const value of [threadId, "Repair build caching", "fixture-peer", `/contrived/${path}`]) expect(diagnostics).toContain(value);
  }));
});

it("agrees with an outcome tally, ignores redelivery and bounds kept/failure details", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom("removed", "kept", "failed", "absent", "provider-failed"), {
    minLength: 1, maxLength: 150,
  }), (outcomes) => {
    const report = new BackgroundArchiveCleanupReport();
    const tally = { removed: 0, kept: 1, failed: 0, absent: 0 };
    report.record("codex", { threadId: "initial", archivedAt: 1,
      cleanup: [{ removedWorktree: false, deletedBranch: false, skippedReason: "Shared checkout was kept." }] });
    outcomes.forEach((kind, index) => {
      const item: ArchiveThreadCleanupResult = { worktreePath: `/contrived/${index}`, deletedBranch: false,
        removedWorktree: kind === "removed",
        ...(kind === "kept" ? { skippedReason: `Kept reason ${index}` } : {}),
        ...(kind === "failed" ? { error: `Failed reason ${index}` } : {}),
        ...(kind === "absent" ? { skippedReason: "Worktree directory no longer exists." } : {}),
      };
      const completion = { threadId: `fixture-${index}`, archivedAt: index,
        cleanup: kind === "provider-failed" ? [] : [item],
        ...(kind === "provider-failed" ? { error: `Provider failure ${index}` } : {}),
      };
      expect(report.record("codex", completion)).toBe(true);
      expect(report.record("codex", completion)).toBe(false);
      if (kind === "removed") tally.removed += 1;
      if (kind === "kept") tally.kept += 1;
      if (kind === "failed" || kind === "provider-failed") tally.failed += 1;
      if (kind === "absent") tally.absent += 1;
      const notice = report.notice()!;
      expect(notice.message).toContain(`${index + 2} cleanup results`);
      expect(notice.message).toContain(`${tally.removed} worktrees removed`);
      expect(notice.message).toContain(`${tally.kept} kept`);
      expect(notice.message).toContain(`${tally.failed} failed`);
      if (tally.absent) expect(notice.message).toContain(`${tally.absent} already absent`);
      expect(notice.detail?.split("\n").length).toBeLessThanOrEqual(9);
      expect(notice.facts?.length).toBeLessThanOrEqual(5);
      expect(notice.autoDismiss).toBe(false);
      expect(notice.id).toBe("background-archive-cleanup-summary");
    });
    report.dismiss();
    expect(report.notice()).toBeUndefined();
    expect(report.record("codex", { threadId: "later", archivedAt: 1000, error: "Still hidden", cleanup: [] })).toBe(false);
  }));
});
