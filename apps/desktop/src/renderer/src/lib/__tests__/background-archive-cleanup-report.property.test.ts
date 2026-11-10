import { expect, it } from "vitest";
import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArchiveThreadCleanupResult } from "@pwragent/shared";
import { BackgroundArchiveCleanupReport } from "../background-archive-cleanup-report";

function recordOutcome(report: BackgroundArchiveCleanupReport, index: number, failed = false) {
  const blocker = { backend: "claude" as const, threadId: `blocker-${index}`, title: `Active work ${index}` };
  const reason = failed ? `Snapshot failure ${index}` : `Worktree is still used by another active thread: ${blocker.threadId}.`;
  const cleanup: ArchiveThreadCleanupResult[] = [{
    worktreePath: `/contrived/worktrees/${index}`, removedWorktree: false, deletedBranch: false,
    ...(failed ? { error: reason } : { skippedReason: reason, blockingThreads: [blocker] }),
  }];
  const completion = { threadId: `archived-${index}`, archivedAt: index, cleanup };
  report.record("codex", completion, { threadLink: { backend: "codex", threadId: completion.threadId,
    title: `Archived work ${index}`, instanceId: "fixture-peer" } });
  return { completion, blocker, reason };
}

it("shows the two actual failures after nineteen shared-worktree skips and copies all twenty-one outcomes", () => {
  const report = new BackgroundArchiveCleanupReport();
  const outcomes = Array.from({ length: 21 }, (_, index) => recordOutcome(report, index, index >= 19));
  const notice = report.notice()!;
  const visible = renderToStaticMarkup(notice.body);
  expect(notice.message).toContain("19 kept · 2 failed");
  expect(visible).toContain("Snapshot failure 19");
  expect(visible).toContain("Snapshot failure 20");
  expect(visible.indexOf("Snapshot failure 19")).toBeLessThan(visible.indexOf("Active work"));
  for (const { completion, blocker, reason } of outcomes) {
    expect(notice.copyText).toContain(completion.threadId);
    expect(notice.copyText).toContain(completion.cleanup[0]!.worktreePath);
    expect(notice.copyText).toContain(reason);
    if (completion.cleanup[0]!.skippedReason) {
      expect(notice.copyText).toContain(blocker.threadId);
      expect(notice.copyText).toContain(blocker.title);
      expect(notice.copyText).toContain("Backend: claude");
    }
  }
  expect(notice.copyText).toContain("Instance ID: fixture-peer");
  expect(notice.detail).toMatch(/not shown.*Copy|Copy.*not shown/);
});

it("keeps every failure ahead of skips regardless of completion order, using the owner metadata as oracle", () => {
  fc.assert(fc.property(fc.shuffledSubarray(Array.from({ length: 21 }, (_, index) => index), { minLength: 21, maxLength: 21 }), (order) => {
    const report = new BackgroundArchiveCleanupReport();
    const outcomes = order.map((index) => recordOutcome(report, index, index >= 19));
    const notice = report.notice()!;
    const visible = renderToStaticMarkup(notice.body);
    for (const { completion, blocker, reason } of outcomes) {
      for (const value of [completion.threadId, completion.cleanup[0]!.worktreePath, reason]) expect(notice.copyText).toContain(value);
      if (completion.cleanup[0]!.error) expect(visible).toContain(reason);
      else expect(notice.copyText).toContain(blocker.title);
    }
    expect(visible.indexOf("Snapshot failure")).toBeLessThan(visible.indexOf("Active work"));
  }));
});

it("keeps unknown names readable and never invents the blocker's backend", () => {
  const report = new BackgroundArchiveCleanupReport();
  const completion = { threadId: "archived", archivedAt: 1, cleanup: [{ worktreePath: "/contrived/shared",
    removedWorktree: false, deletedBranch: false,
    skippedReason: "Worktree is still used by another active thread: unknown-blocker.",
  }] };
  report.record("codex", completion, { threadLink: { backend: "codex", threadId: "archived", title: "Archived", instanceId: "peer" } });
  const notice = report.notice()!;
  const visible = renderToStaticMarkup(notice.body);
  expect(visible).toContain("Unknown thread");
  expect(notice.copyText).toContain("Thread ID: unknown-blocker");
  expect(notice.copyText).toContain("Backend: unknown");
  expect(notice.copyText).toContain("Instance ID: peer");
});

it("resolves legacy blocker ids against the same owner and copies the resolved identity", () => {
  const report = new BackgroundArchiveCleanupReport();
  const resolve = (ref: { threadId: string; instanceId?: string }) => ref.instanceId === "peer" && ref.threadId === "legacy"
    ? { backend: "claude" as const, instanceId: "peer", threadId: "legacy", title: "Owner's active work" } : undefined;
  report.record("codex", { threadId: "archived", archivedAt: 1, cleanup: [{ worktreePath: "/contrived/shared",
    removedWorktree: false, deletedBranch: false, skippedReason: "Worktree is still used by another active thread: legacy." }] },
  { threadLink: { backend: "codex", threadId: "archived", title: "Archived", instanceId: "peer" } }, resolve);
  expect(renderToStaticMarkup(report.notice()!.body)).toContain("Owner&#x27;s active work");
  expect(report.notice()?.copyText).toContain("Backend: claude");
});

it("keeps unnamed blockers qualified without accepting a title from another owner", () => {
  fc.assert(fc.property(fc.uuid(), fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 2 }), (threadId, owners) => {
    const report = new BackgroundArchiveCleanupReport();
    report.record("codex", { threadId: "archived", archivedAt: 1, cleanup: [{
      worktreePath: "/contrived/shared", removedWorktree: false, deletedBranch: false,
      skippedReason: `Worktree is still used by another active thread: ${threadId}.`,
      blockingThreads: [{ backend: "claude", threadId }],
    }] }, { threadLink: { backend: "codex", threadId: "archived", title: "Archived", instanceId: owners[0] } },
    () => ({ backend: "claude", threadId, instanceId: owners[1], title: "Wrong owner's title" }));
    const notice = report.notice()!;
    const visible = renderToStaticMarkup(notice.body);
    expect(visible).toContain("Unknown thread");
    expect(visible).not.toContain(threadId);
    expect(visible).not.toContain("Wrong owner");
    expect(notice.copyText).toContain(`Blocking thread 1\nThread: Unknown thread\nThread ID: ${threadId}\nBackend: claude\nInstance ID: ${owners[0]}`);
    expect(notice.copyText).not.toContain(owners[1]);
  }));
});

it("states blocker and display limits while Copy retains every reference inside its budget", () => {
  fc.assert(fc.property(fc.integer({ min: 33, max: 80 }), (count) => {
    const report = new BackgroundArchiveCleanupReport();
    const blockingThreads = Array.from({ length: count }, (_, index) => ({
      backend: "claude" as const, threadId: `blocker-${index}`, title: `Active task ${index}`,
    }));
    report.record("codex", { threadId: "archived", archivedAt: 1, cleanup: [{
      worktreePath: "/contrived/shared", removedWorktree: false, deletedBranch: false,
      skippedReason: `Worktree is still used by other active threads: ${blockingThreads.map((thread) => thread.threadId).join(", ")}.`,
      blockingThreads,
    }] });
    const notice = report.notice()!;
    const visible = renderToStaticMarkup(notice.body);
    expect(visible).toContain(`${count - 3} more blocking threads not shown`);
    expect(visible).toContain("Copy includes 32 retained references");
    expect(visible).not.toContain("Active task 3");
    for (const thread of blockingThreads.slice(0, 32)) {
      expect(notice.copyText).toContain(`Thread: ${thread.title}\nThread ID: ${thread.threadId}\nBackend: claude\nInstance ID: local`);
    }
    expect(notice.copyText).toContain(`Storage limit: ${count - 32} blocking thread references omitted.`);
    expect(notice.detail).toContain("blocking references were truncated");
  }));
});

it("bounds retained data, admits late failures before skips, and states every kind of truncation", () => {
  const report = new BackgroundArchiveCleanupReport();
  for (let index = 0; index < 600; index++) recordOutcome(report, index);
  recordOutcome(report, 601, true);
  report.record("codex", { threadId: "large", archivedAt: 602,
    cleanup: [{ worktreePath: "/contrived/large", removedWorktree: false, deletedBranch: false, error: "large-error ".repeat(100_000) }] });
  const notice = report.notice()!;
  expect(renderToStaticMarkup(notice.body)).toContain("Snapshot failure 601");
  expect(notice.copyText!.length).toBeLessThan(1024 * 1024);
  expect(notice.detail).toMatch(/storage limit/i);
  expect(notice.copyText).toMatch(/omitted|truncated/i);
  expect(notice.copyText).toContain("large-error");
  expect(notice.copyText).toContain("[truncated]");
});

it("keeps the thread identity beside each failed checkout in background reports", () => {
  fc.assert(fc.property(fc.uuid(), fc.uuid(), (threadId, path) => {
    const report = new BackgroundArchiveCleanupReport();
    report.record("codex", { threadId, archivedAt: 1,
      cleanup: [{ worktreePath: `/contrived/${path}`, removedWorktree: false, deletedBranch: false, error: "Snapshot failed" }] },
    { threadLink: { backend: "codex", threadId, title: "Repair build caching", instanceId: "fixture-peer" } });
    const diagnostics = report.notice()?.copyText;
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
      expect(notice.copyText!.length).toBeLessThan(512 * 1024);
      expect(notice.autoDismiss).toBe(false);
      expect(notice.id).toBe("background-archive-cleanup-summary");
    });
    report.dismiss();
    expect(report.notice()).toBeUndefined();
    expect(report.record("codex", { threadId: "later", archivedAt: 1000, error: "Still hidden", cleanup: [] })).toBe(false);
  }));
});

it("keeps same-id results from different owners distinct while suppressing exact redelivery", () => {
  fc.assert(fc.property(fc.uuid(), fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 4 }), (threadId, owners) => {
    const report = new BackgroundArchiveCleanupReport();
    const completion = { threadId, archivedAt: 1, cleanup: [{ worktreePath: "/contrived/shared",
      removedWorktree: false, deletedBranch: false, error: "Snapshot failed" }] };
    for (const instanceId of owners) {
      const context = { threadLink: { backend: "codex" as const, threadId, instanceId, title: "Archived" } };
      expect(report.record("codex", completion, context)).toBe(true);
      expect(report.record("codex", completion, context)).toBe(false);
    }
    expect(report.notice()?.message).toContain(`${owners.length} cleanup results`);
    for (const owner of owners) expect(report.notice()?.copyText).toContain(`Instance ID: ${owner}`);
  }));
});
