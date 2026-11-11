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

type Kind = "removed" | "kept" | "failed" | "absent";
const KINDS: readonly Kind[] = ["removed", "kept", "failed", "absent"];

function cleanupItem(kind: Kind, index: number, reason = `${kind} reason ${index}`, worktreePath = `/contrived/${index}`): ArchiveThreadCleanupResult {
  return { worktreePath, deletedBranch: false, removedWorktree: kind === "removed",
    ...(kind === "kept" ? { skippedReason: reason } : {}),
    ...(kind === "failed" ? { error: reason } : {}),
    ...(kind === "absent" ? { skippedReason: "Worktree directory no longer exists." } : {}),
  };
}

/** Reads what the notice promises back out of it: Copy's retained outcomes
 * (one `\n\n` block each after the title, message and detail), the stated
 * retained total, the per-kind storage omissions and the hidden counts. */
function readNotice(report: BackgroundArchiveCleanupReport) {
  const notice = report.notice()!;
  const blocks = notice.copyText!.split("\n\n").slice(3);
  const retainedByKind = { failed: 0, kept: 0, removed: 0, absent: 0 };
  for (const block of blocks) retainedByKind[block.slice(0, block.indexOf("\n")).toLowerCase() as Kind]++;
  const omittedMatch = /Storage limit: (\d+) failed, (\d+) kept, (\d+) removed and (\d+) absent outcomes omitted/.exec(notice.detail ?? "");
  const [failed, kept, removed, absent] = omittedMatch ? omittedMatch.slice(1).map(Number) : [0, 0, 0, 0];
  const hidden = /^(\d+) failed and (\d+) kept outcomes not shown\./.exec(notice.detail ?? "");
  const visible = renderToStaticMarkup(notice.body);
  return { notice, blocks, retainedByKind, omittedByKind: { failed, kept, removed, absent },
    retained: Number(/Copy includes all (\d+) retained outcomes/.exec(notice.detail ?? "")?.[1]),
    hidden: hidden ? { failed: Number(hidden[1]), kept: Number(hidden[2]) } : { failed: 0, kept: 0 },
    visible: { failed: visible.split('data-kind="failed"').length - 1, kept: visible.split('data-kind="kept"').length - 1 } };
}

it("retains at most 128 outcomes, accounts for every one it drops and never drops a failure for a lower kind", () => {
  // A run draws from a subset of kinds so failure-only and kept-heavy runs
  // also cross the 128-outcome cap, not just evenly mixed ones.
  fc.assert(fc.property(fc.subarray([...KINDS], { minLength: 1 })
    .chain((kinds) => fc.array(fc.constantFrom(...kinds), { minLength: 100, maxLength: 210 })), (kinds) => {
    const report = new BackgroundArchiveCleanupReport();
    const recorded = { failed: 0, kept: 0, removed: 0, absent: 0 };
    kinds.forEach((kind, index) => {
      recorded[kind]++;
      report.record("codex", { threadId: `fixture-${index}`, archivedAt: index, cleanup: [cleanupItem(kind, index)] });
    });
    if (!recorded.failed && !recorded.kept) {
      expect(report.notice()).toBeUndefined();
      return;
    }
    const { blocks, retained, retainedByKind, omittedByKind, hidden, visible } = readNotice(report);
    expect(retained).toBe(Math.min(kinds.length, 128));
    expect(blocks).toHaveLength(retained);
    for (const kind of KINDS) expect(retainedByKind[kind] + omittedByKind[kind]).toBe(recorded[kind]);
    expect(retainedByKind.failed).toBe(Math.min(recorded.failed, 128));
    if (omittedByKind.failed) expect(retainedByKind.failed).toBe(retained);
    // Eviction takes the lowest kind first: a kept outcome, which the compact
    // view can show, goes only once no removed or absent record is left.
    if (omittedByKind.kept) expect(retainedByKind.removed + retainedByKind.absent).toBe(0);
    // The compact view shows five attention outcomes, failures first, and
    // states exactly how many of the rest it left to Copy.
    const attention = retainedByKind.failed + retainedByKind.kept;
    expect(visible).toEqual({ failed: Math.min(retainedByKind.failed, 5), kept: Math.min(attention, 5) - Math.min(retainedByKind.failed, 5) });
    expect(hidden).toEqual({ failed: retainedByKind.failed - visible.failed, kept: retainedByKind.kept - visible.kept });
  }));
});

it("keeps retained outcomes inside 256 KiB and drops one only when it no longer fits", () => {
  const BUDGET = 256 * 1024;
  const clipped = (length: number) => length > 2048 ? 2048 + " [truncated]".length : length;
  // Counts land a few outcomes either side of where the budget runs out, so
  // runs both fill it and stop just short of it without hashing spare text.
  fc.assert(fc.property(fc.integer({ min: 1500, max: 2400 }), fc.integer({ min: 1500, max: 2400 }), fc.integer({ min: -4, max: 4 }),
    (reasonLength, pathLength, offset) => {
      const count = Math.floor(BUDGET / (2 * (clipped(reasonLength) + clipped(pathLength)) + 500)) + offset;
      const report = new BackgroundArchiveCleanupReport();
      for (let index = 0; index < count; index++) {
        report.record("codex", { threadId: `large-${index}`, archivedAt: index,
          cleanup: [cleanupItem("failed", index, "e".repeat(reasonLength), `/${"p".repeat(pathLength - 1)}`)] });
      }
      const { blocks, retained, omittedByKind } = readNotice(report);
      expect(retained + omittedByKind.failed).toBe(count);
      // Each retained outcome costs its Copy text plus its stored form, which
      // holds the clipped reason and path verbatim and a few hundred more.
      const lower = blocks.map((block) => block.length + clipped(reasonLength) + clipped(pathLength));
      const upper = lower.map((cost) => cost + 400);
      expect(lower.reduce((sum, cost) => sum + cost, 0)).toBeLessThanOrEqual(BUDGET);
      if (omittedByKind.failed) expect(upper.reduce((sum, cost) => sum + cost, 0) + Math.max(...upper)).toBeGreaterThan(BUDGET);
    }));
});

it("suppresses exact redelivery within the last 512 completions and forgets older ones", () => {
  fc.assert(fc.property(fc.integer({ min: 520, max: 540 }), fc.integer({ min: 505, max: 520 }), (count, age) => {
    const report = new BackgroundArchiveCleanupReport();
    const completion = (index: number) => ({ threadId: `fixture-${index}`, archivedAt: index, cleanup: [] });
    let accepted = 0;
    for (let index = 0; index < count; index++) if (report.record("codex", completion(index))) accepted++;
    expect(accepted).toBe(count);
    expect(report.record("codex", completion(count - age))).toBe(age > 512);
  }));
});
