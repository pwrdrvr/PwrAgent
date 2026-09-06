import { expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { readNavigationQueryRange } from "../read-navigation-query-range";

const request: NavigationQueryRequest = { protocol: 2, consumer: "star-map", query: { kind: "star-map-geometry" } };
function page(patch: Partial<NavigationQueryPage> = {}): NavigationQueryPage {
  return { protocol: 2, queryKey: "geometry", generation: "generation", ownerEpoch: "epoch", countsRevision: "revision",
    coverage: { state: "complete" }, counts: { total: 101, active: 0, unread: 0, review: 0 }, entries: [],
    directories: [], complete: true, ...patch };
}

it("restarts one expired metadata range under its original deadline", async () => {
  const read = vi.fn().mockResolvedValueOnce(page({ complete: false, nextCursor: "expired" }))
    .mockRejectedValueOnce(Object.assign(new Error("expired"), { code: "navigation_cursor_expired" }))
    .mockResolvedValueOnce(page({ generation: "new" }));
  const result = await readNavigationQueryRange({ request, read, isCancelled: () => false, maxBytes: 8192 });
  expect(result.generation).toBe("new");
  expect(new Set(read.mock.calls.map(([query]) => query.deadlineAt)).size).toBe(1);
  expect(read.mock.calls[2]![0].cursor).toBeUndefined();
});

it("rejects mixed-generation descriptors and oversized retained metadata", async () => {
  const read = vi.fn().mockResolvedValueOnce(page({ complete: false, nextCursor: "next" }))
    .mockResolvedValueOnce(page({ generation: "new" }));
  await expect(readNavigationQueryRange({ request, read, isCancelled: () => false, maxBytes: 8192 }))
    .rejects.toThrow("loaded generation");
  await expect(readNavigationQueryRange({ request, read: async () => page(), isCancelled: () => false, maxBytes: 1 }))
    .rejects.toThrow("byte budget");
});

it("does not allow this helper to drain a full thread collection", async () => {
  const read = vi.fn();
  await expect(readNavigationQueryRange({ request: { ...request, query: { kind: "lens", lens: "inbox" } },
    read, isCancelled: () => false, maxBytes: 8192 })).rejects.toThrow("explicit identities");
  expect(read).not.toHaveBeenCalled();
});
