import type { NavigationQueryPage, NavigationRow } from "@pwragent/shared";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { readThreadInfoRow } from "../thread-info";

// The owner, rather than a viewer's possibly cold peer cache, is the oracle.
it("resolves an owner's thread independently of which window encounters it", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.stringMatching(/^[a-z]{1,20}$/), fc.option(fc.uuid(), { nil: undefined }),
    async (owner, title, viewer) => {
      const target = { backend: "codex" as const, threadId: "unmounted-thread", instanceId: owner };
      const row = { id: target.threadId, source: target.backend, title,
        ref: { backend: target.backend, threadId: target.threadId } } as NavigationRow;
      const api: Pick<DesktopApi, "getNavigationQueryPage"> = {
        getNavigationQueryPage: vi.fn(async (request) => ({
          complete: true, coverage: { state: "complete" },
          entries: request.federationTarget?.scope === "remote" && request.federationTarget.instanceId === owner
            ? [{ row }] : [],
        }) as NavigationQueryPage),
      };
      expect(await readThreadInfoRow(api, target, viewer ? { scope: "remote", instanceId: viewer } : undefined)).toBe(row);
    }), { numRuns: 25 });
});

it("shares one encounter read per owner and backend, including concurrent duplicate chips", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    owner: fc.integer({ min: 0, max: 3 }), backend: fc.constantFrom("codex" as const, "claude" as const),
  }), { minLength: 1, maxLength: 15 }), async (encounters) => {
    const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
      if (request.query.kind !== "exact") throw new Error("Expected exact identities");
      const ref = request.query.identities[0]!;
      const owner = request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : "local";
      return { entries: [{ row: { ref, source: ref.backend, id: ref.threadId, title: `${owner}:${ref.backend}` } }] } as NavigationQueryPage;
    });
    const api = { getNavigationQueryPage: read };
    const targets = encounters.map(({ owner, backend }) => ({ backend, threadId: "colliding-id", instanceId: `peer-${owner}` }));
    const rows = await Promise.all(targets.map((target) => readThreadInfoRow(api, target, undefined)));
    expect(rows.map((row) => row?.title)).toEqual(targets.map((target) => `${target.instanceId}:${target.backend}`));
    await Promise.all(targets.map((target) => readThreadInfoRow(api, target, undefined)));
    expect(read).toHaveBeenCalledTimes(new Set(targets.map((target) => `${target.instanceId}:${target.backend}`)).size);
  }), { numRuns: 25 });
});

it("retries failed reads and then retains the successful owner row", async () => {
  const row = { ref: { backend: "codex", threadId: "t" }, source: "codex", id: "t", title: "Recovered" } as NavigationRow;
  const api = { getNavigationQueryPage: vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ entries: [{ row }] } as NavigationQueryPage) };
  const target = { backend: "codex" as const, threadId: "t", instanceId: "peer" };
  await expect(readThreadInfoRow(api, target, undefined)).rejects.toThrow("offline");
  expect(await readThreadInfoRow(api, target, undefined)).toBe(row);
  expect(await readThreadInfoRow(api, target, undefined)).toBe(row);
  expect(api.getNavigationQueryPage).toHaveBeenCalledTimes(2);
});

it("does not interpret incomplete owner coverage as a missing thread", async () => {
  const api = { getNavigationQueryPage: vi.fn(async () => ({
    entries: [], complete: true, coverage: { state: "checking" },
  }) as unknown as NavigationQueryPage) };
  await expect(readThreadInfoRow(api, { backend: "codex", threadId: "t" }, undefined)).rejects.toThrow();
});
