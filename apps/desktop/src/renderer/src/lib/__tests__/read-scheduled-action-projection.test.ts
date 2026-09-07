import { describe, expect, it, vi } from "vitest";
import type { ListScheduledThreadActionsResponse, ScheduledThreadAction } from "@pwragent/shared";
import { NavigationMetadataBudget } from "../navigation-metadata-budget";
import { readScheduledActionProjection } from "../read-scheduled-action-projection";

const action = (id: string): ScheduledThreadAction => ({ id, backend: "codex", threadId: "thread", kind: "turn",
  origin: "desktop", status: "scheduled", scheduledFor: 1, displayText: id, createdAt: 1, updatedAt: 1 });
const page = (actions: ScheduledThreadAction[], nextCursor?: string): ListScheduledThreadActionsResponse => ({
  projectionProtocol: 2, revision: "revision", complete: !nextCursor, actions, nextCursor, observedAt: 1,
});

describe("complete scheduled projections", () => {
  it("rebaselines once after IPC cursor expiry and releases abandoned backing", async () => {
    const budget = new NavigationMetadataBudget(10_000, 10_000);
    const allocation = budget.begin("scheduled");
    const read = vi.fn().mockResolvedValueOnce(page([action("old")], "next"))
      .mockRejectedValueOnce(new Error("Error invoking remote method: [navigation_cursor_expired]"))
      .mockResolvedValueOnce(page([action("new")], "last"))
      .mockResolvedValueOnce(page([action("last")]));
    try {
      const result = await readScheduledActionProjection({ request: {}, read, isCancelled: () => false, allocation });
      expect(result.actions.map((entry) => entry.id)).toEqual(["new", "last"]);
      allocation.commit();
      expect(budget.usage()).toEqual({ transientBytes: 0, retainedBytes:
        new TextEncoder().encode(JSON.stringify(page([action("new")], "last"))).byteLength
        + new TextEncoder().encode(JSON.stringify(page([action("last")]))).byteLength });
    } finally { allocation.dispose(); budget.release("scheduled"); }
  });

  it.each(["legacy", "repeated", "partial", "oversized", "cancelled"])("never publishes a %s baseline", async (kind) => {
    const budget = new NavigationMetadataBudget();
    const allocation = budget.begin("scheduled");
    let cancelled = false;
    const read = vi.fn(async () => {
      if (kind === "legacy") return { actions: [action("legacy")] };
      if (kind === "partial") throw new Error("Disconnected");
      if (kind === "cancelled") cancelled = true;
      if (kind === "oversized") return page([{ ...action("huge"), displayText: "x".repeat(260_000) }]);
      return page([action("repeat")], "same-cursor");
    });
    try {
      await expect(readScheduledActionProjection({ request: {}, read, isCancelled: () => cancelled, allocation })).rejects.toThrow();
      expect(budget.usage().retainedBytes).toBe(0);
    } finally { allocation.dispose(); }
    expect(budget.usage()).toEqual({ retainedBytes: 0, transientBytes: 0 });
  });
});
