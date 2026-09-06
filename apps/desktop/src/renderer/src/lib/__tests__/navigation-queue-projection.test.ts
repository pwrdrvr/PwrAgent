import { describe, expect, it, vi } from "vitest";
import type { ComposerThreadOwner, NavigationQueueProjection } from "@pwragent/shared";
import type { ComposerQueuedTurnSnapshot } from "../../features/composer/useComposerDraftStore";
import { readCompleteNavigationQueue, reconcileCompleteNavigationQueue } from "../navigation-queue-projection";

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

  it("restarts once without publishing partial queue data", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(projection({ complete: false, nextCursor: "expired" }))
      .mockRejectedValueOnce(Object.assign(new Error("expired"), { code: "navigation_cursor_expired" }))
      .mockResolvedValueOnce(projection({ revision: "new" }));
    expect((await readCompleteNavigationQueue({ owner, read, isCancelled: () => false })).revision).toBe("new");
    expect(read.mock.calls[2]![0].cursor).toBeUndefined();
    expect(read.mock.calls[2]![0].deadlineAt).toBe(read.mock.calls[0]![0].deadlineAt);
  });
});
