import { expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { RemoteNavigationPageBaselines } from "../federation/remote-navigation-page-baselines";
const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", federationTarget: { scope: "remote", instanceId: "a" }, query: { kind: "directory-index" } };
const page: NavigationQueryPage = { protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "o", countsRevision: "r",
  counts: { total: 0, active: 0, unread: 0, review: 0 }, entries: [], coverage: { state: "complete" }, complete: true };

it("scopes owner baselines and never trusts viewer revisions or incomplete inventory", async () => {
  const cache = new RemoteNavigationPageBaselines();
  const read = vi.fn(async (_request: NavigationQueryRequest) => page);
  await cache.read({ ...request, completeBaselineRevision: "forged" }, read);
  expect(read.mock.lastCall?.[0].completeBaselineRevision).toBeUndefined();
  await cache.read({ ...request, federationTarget: { scope: "remote", instanceId: "b" } }, read);
  expect(read.mock.lastCall?.[0].completeBaselineRevision).toBeUndefined();
  read.mockResolvedValueOnce({ ...page, coverage: { state: "checking" }, countsRevision: "partial" });
  expect((await cache.read(request, read)).coverage.state).toBe("checking");
  read.mockResolvedValueOnce({ ...page, unchanged: true });
  expect(await cache.read(request, read)).toEqual({ ...page, unchanged: false });
  expect(read.mock.lastCall?.[0].completeBaselineRevision).toBe("r");
  read.mockRejectedValueOnce(new Error("offline"));
  await expect(cache.read(request, read)).rejects.toThrow("offline");
  read.mockResolvedValueOnce({ ...page, unchanged: true });
  await expect(cache.read(request, read)).resolves.toEqual({ ...page, unchanged: false });
});

it("bounds retention and refuses unowned unchanged or range acknowledgments", async () => {
  const cache = new RemoteNavigationPageBaselines(4096, 1);
  const read = vi.fn(async (_request: NavigationQueryRequest) => page);
  await cache.read(request, read);
  await cache.read({ ...request, federationTarget: { scope: "remote", instanceId: "b" } }, read);
  await cache.read(request, read);
  expect(read.mock.lastCall?.[0].completeBaselineRevision).toBeUndefined();
  read.mockResolvedValueOnce({ ...page, rangeUnchanged: { start: 0, count: 1 } });
  await expect(cache.read({ ...request, retainedRange: { revision: "r", ownerEpoch: "o", start: 0, count: 1 } }, read)).rejects.toThrow("invalid owner baseline");
  expect(read.mock.lastCall?.[0].retainedRange).toBeUndefined();
  read.mockResolvedValueOnce({ ...page, unchanged: true, countsRevision: "wrong" });
  await expect(cache.read(request, read)).rejects.toThrow("invalid owner baseline");
});
