import { describe, expect, it, vi } from "vitest";
import type { ComposerThreadOwner, NavigationQueueProjection } from "@pwragent/shared";
import type { ComposerQueuedTurnSnapshot } from "../../features/composer/useComposerDraftStore";
import { NAVIGATION_QUEUE_MAX_PAGES, readCompleteNavigationQueue, reconcileCompleteNavigationQueue } from "../navigation-queue-projection";

const owner: ComposerThreadOwner = {
  backend: "codex", threadId: "thread", target: { scope: "remote", instanceId: "owner" },
};
function projection(patch: Partial<NavigationQueueProjection> = {}): NavigationQueueProjection {
  return {
    protocol: 2,
    ref: { backend: "codex", threadId: "thread", ownerInstanceId: "owner" },
    revision: "queue-revision",
    readiness: "ready",
    complete: true,
    entries: [],
    ...patch,
  };
}
function queued(id: string): ComposerQueuedTurnSnapshot {
  return { id, queueEntryId: id, threadOwner: owner, text: id, imageAttachments: [], fileAttachments: [] };
}

describe("independent complete FIFO projection", () => {
  it("rejects a complete page that arrives after the original deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const read = vi.fn(async () => { now.mockReturnValue(11_000); return projection(); });
      await expect(readCompleteNavigationQueue({ owner, read, isCancelled: () => false })).rejects.toThrow("deadline expired");
    } finally { now.mockRestore(); }
  });

  it("bounds an endless sequence of advancing cursors", async () => {
    let count = 0;
    const read = vi.fn(async () => projection({ complete: false, nextCursor: `cursor-${++count}` }));
    await expect(readCompleteNavigationQueue({ owner, read, isCancelled: () => false })).rejects.toThrow("page budget");
    expect(read).toHaveBeenCalledTimes(NAVIGATION_QUEUE_MAX_PAGES);
  });

  it("rejects oversized wire pages and complete baselines before publishing either", async () => {
    const entry = { queueEntryId: "large", createdAt: 1, displayText: "x".repeat(260_000), origin: "manual" as const, position: 0 };
    await expect(readCompleteNavigationQueue({ owner, read: async () => projection({ entries: [entry] }), isCancelled: () => false }))
      .rejects.toThrow("protocol budget");
    let index = 0;
    const read = vi.fn(async () => projection({ complete: false, nextCursor: `cursor-${++index}`,
      entries: [{ ...entry, queueEntryId: `entry-${index}`, displayText: "x".repeat(200_000), position: index }] }));
    await expect(readCompleteNavigationQueue({ owner, read, isCancelled: () => false })).rejects.toThrow("memory budget");
    expect(read.mock.calls.length).toBeLessThan(NAVIGATION_QUEUE_MAX_PAGES);
  });

  it("rejects duplicate entries across pages and another owner's unchanged baseline", async () => {
    const entries = [{ queueEntryId: "same", createdAt: 1, displayText: "reply", origin: "manual" as const, position: 0 }];
    const read = vi.fn().mockResolvedValueOnce(projection({ complete: false, nextCursor: "next", entries }))
      .mockResolvedValueOnce(projection({ entries }));
    await expect(readCompleteNavigationQueue({ owner, read, isCancelled: () => false })).rejects.toThrow("duplicate entry");
    await expect(readCompleteNavigationQueue({ owner, read: async () => projection({ unchanged: true }),
      previous: projection({ ref: { backend: "codex", threadId: "thread", ownerInstanceId: "other" } }),
      isCancelled: () => false })).rejects.toThrow("no complete matching baseline");
  });

  it("never prunes from an incomplete FIFO or a concurrent acknowledgement", () => {
    const before = queued("before");
    const newEntry = queued("new");
    expect(reconcileCompleteNavigationQueue({
      owner, projection: projection({ complete: false }), atReadStart: [before], current: [before, newEntry],
    })).toEqual([before, newEntry]);
    expect(reconcileCompleteNavigationQueue({
      owner, projection: projection(), atReadStart: [before], current: [before, newEntry],
    })).toEqual([newEntry]);
    const acknowledged = { ...before, queueEntryCreatedAt: 10 };
    expect(reconcileCompleteNavigationQueue({
      owner, projection: projection(), atReadStart: [before], current: [acknowledged],
    })).toEqual([acknowledged]);
  });

  it("holds an unanswered move in place until the owner's order catches up", () => {
    const entry = (queueEntryId: string, position: number) => ({
      queueEntryId, createdAt: 1, displayText: queueEntryId, origin: "manual" as const, position,
    });
    const ownerOrder = projection({ entries: [entry("a", 0), entry("b", 1), entry("c", 2)] });
    const moved = { ...queued("c"), pendingMove: { beforeQueueEntryId: "a" } };
    const current = [moved, queued("a"), queued("b")];
    // The read left before the move reached the owner, so it reports the old order.
    expect(reconcileCompleteNavigationQueue({ owner, projection: ownerOrder, atReadStart: current, current })
      .map((turn) => turn.id)).toEqual(["c", "a", "b"]);
    const toEnd = [queued("b"), queued("c"), { ...queued("a"), pendingMove: {} }];
    expect(reconcileCompleteNavigationQueue({ owner, projection: ownerOrder, atReadStart: toEnd, current: toEnd })
      .map((turn) => turn.id)).toEqual(["b", "c", "a"]);
    // Settled (the marker dropped), the owner's order is the order.
    const settled = [queued("c"), queued("a"), queued("b")];
    expect(reconcileCompleteNavigationQueue({ owner, projection: ownerOrder, atReadStart: settled, current: settled })
      .map((turn) => turn.id)).toEqual(["a", "b", "c"]);
    // An anchor that left the owner's FIFO leaves the row where the owner has it.
    const stale = [{ ...queued("c"), pendingMove: { beforeQueueEntryId: "started" } }, queued("a"), queued("b")];
    expect(reconcileCompleteNavigationQueue({ owner, projection: ownerOrder, atReadStart: stale, current: stale })
      .map((turn) => turn.id)).toEqual(["a", "b", "c"]);
  });

  it("takes each entry's pause from the owner's queue", () => {
    const entry = (queueEntryId: string, position: number, paused?: boolean) => ({
      queueEntryId, createdAt: 1, displayText: queueEntryId, origin: "manual" as const, position,
      ...(paused ? { paused } : {}),
    });
    const current = [queued("a"), { ...queued("b"), paused: true }];

    const reconciled = reconcileCompleteNavigationQueue({
      owner,
      projection: projection({ entries: [entry("a", 0, true), entry("b", 1)] }),
      atReadStart: current,
      current,
    });

    expect(reconciled.map((turn) => [turn.id, Boolean(turn.paused)])).toEqual([["a", true], ["b", false]]);
  });

  it("keeps a pause the owner announced against a queue read that left before it", () => {
    const entry = (paused?: boolean, pauseRevision?: number) => ({
      queueEntryId: "a", createdAt: 1, displayText: "a", origin: "manual" as const, position: 0,
      ...(paused ? { paused } : {}), ...(pauseRevision ? { pauseRevision } : {}),
    });
    const current = [{ ...queued("a"), paused: true, pauseRevision: 1 }];
    const reconcile = (projected: ReturnType<typeof entry>) => reconcileCompleteNavigationQueue({
      owner, projection: projection({ entries: [projected] }), atReadStart: current, current,
    })[0];

    expect(reconcile(entry())).toMatchObject({ paused: true, pauseRevision: 1 });
    expect(reconcile(entry(false, 2))).not.toHaveProperty("paused");
  });

  it("keeps a scheduled review that waits outside the turn FIFO", () => {
    const review: ComposerQueuedTurnSnapshot = {
      ...queued("pending-review:1"),
      id: "scheduled-projection:review",
      scheduledActionId: "review",
      reviewCommand: {
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    };
    const turn = { ...queued("turn"), id: "scheduled-projection:turn", scheduledActionId: "turn" };
    const followUp = queued("follow-up");
    const current = [review, turn, followUp];
    const reconciled = reconcileCompleteNavigationQueue({
      owner,
      projection: projection({
        entries: [{ queueEntryId: "follow-up", createdAt: 1, displayText: "follow-up", origin: "manual", position: 0 }],
      }),
      atReadStart: current,
      current,
    });
    // The FIFO never reports a pending review, but it does report every
    // scheduled turn it holds, so the turn that left it is gone.
    expect(reconciled.map((entry) => entry.id)).toEqual([review.id, followUp.id]);
    expect(reconciled[0]).toBe(review);
  });

  it("keeps a held scheduled steer whose FIFO entry did not survive a restart", () => {
    // The durable held action outlives the owner's process-local FIFO. Only
    // the scheduled-action projection may remove it: once it is retried,
    // cancelled, or fails.
    const held: ComposerQueuedTurnSnapshot = {
      ...queued("scheduled-turn:held"),
      id: "scheduled-projection:held",
      scheduledActionId: "held",
      manualReleaseRequired: true,
      holdReason: "This steering message was held after its target turn ended.",
    };
    const dispatched = { ...queued("scheduled-turn:sent"), id: "scheduled-projection:sent", scheduledActionId: "sent" };
    const current = [held, dispatched];
    const reconciled = reconcileCompleteNavigationQueue({
      owner, projection: projection(), atReadStart: current, current,
    });
    expect(reconciled.map((entry) => entry.id)).toEqual([held.id]);
    expect(reconciled[0]).toBe(held);
  });

  it("does not infer an owner from legacy scope or remove another owner's entry", () => {
    const legacy = { ...queued("legacy"), threadOwner: undefined };
    const foreign = { ...queued("foreign"), threadOwner: { ...owner, target: { scope: "local" as const } } };
    const current = [legacy, foreign];
    expect(reconcileCompleteNavigationQueue({
      owner, projection: projection(), atReadStart: current, current,
    })).toEqual(current);
  });

  it("publishes one complete revision across multiple pages", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(projection({
        complete: false,
        nextCursor: "next",
        entries: [{ queueEntryId: "first", createdAt: 1, displayText: "first", origin: "manual", position: 0 }],
      }))
      .mockResolvedValueOnce(projection({
        entries: [{ queueEntryId: "second", createdAt: 2, displayText: "second", origin: "manual", position: 1 }],
      }));
    const complete = await readCompleteNavigationQueue({ owner, read, isCancelled: () => false });
    expect(complete.complete).toBe(true);
    expect(complete.entries.map((entry) => entry.queueEntryId)).toEqual(["first", "second"]);
    expect(read.mock.calls[0]![0].deadlineAt).toBe(read.mock.calls[1]![0].deadlineAt);
  });

  it.each([false, true])("restarts once without publishing partial queue data (IPC=%s)", async (ipc) => {
    const read = vi.fn()
      .mockResolvedValueOnce(projection({ complete: false, nextCursor: "expired" }))
      .mockRejectedValueOnce(ipc ? new Error("Error invoking remote method: [navigation_cursor_expired] Queue changed while paging")
        : Object.assign(new Error("expired"), { code: "navigation_cursor_expired" }))
      .mockResolvedValueOnce(projection({ revision: "new" }));
    expect((await readCompleteNavigationQueue({ owner, read, isCancelled: () => false })).revision).toBe("new");
    expect(read.mock.calls[2]![0].cursor).toBeUndefined();
    expect(read.mock.calls[2]![0].deadlineAt).toBe(read.mock.calls[0]![0].deadlineAt);
  });
});
