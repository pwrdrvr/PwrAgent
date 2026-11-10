import type { NavigationQueryPage, NavigationRow } from "@pwragent/shared";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { readThreadInfoRow } from "../thread-info";
import { observeThreadLinkRows } from "../../../lib/thread-link-rows";

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
    .mockResolvedValueOnce({ entries: [], complete: true, coverage: { state: "complete" } } as unknown as NavigationQueryPage)
    .mockResolvedValue({ entries: [{ row }] } as NavigationQueryPage) };
  const target = { backend: "codex" as const, threadId: "t", instanceId: "peer" };
  await expect(readThreadInfoRow(api, target, undefined)).rejects.toThrow("offline");
  expect(await readThreadInfoRow(api, target, undefined)).toBe(row);
  expect(await readThreadInfoRow(api, target, undefined)).toBe(row);
  expect(api.getNavigationQueryPage).toHaveBeenCalledTimes(3);
});

it("does not interpret incomplete owner coverage as a missing thread", async () => {
  const api = { getNavigationQueryPage: vi.fn(async () => ({
    entries: [], complete: true, coverage: { state: "checking" },
  }) as unknown as NavigationQueryPage) };
  await expect(readThreadInfoRow(api, { backend: "codex", threadId: "t" }, undefined)).rejects.toThrow();
});

it("refreshes mutable facts on demand after their freshness window", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 30_001, max: 100_000 }), async (elapsed) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const target = { backend: "codex" as const, threadId: "t" };
    let owner = { ref: target, id: "t", source: "codex", title: "Thread", threadStatus: "active",
      model: "old-model", executionMode: "full-access" } as NavigationRow;
    const api = { getNavigationQueryPage: vi.fn(async () => ({ entries: [{ row: owner }] }) as NavigationQueryPage) };
    try {
      expect(await readThreadInfoRow(api, target, undefined)).toBe(owner);
      owner = { ...owner, threadStatus: "idle", model: "new-model", executionMode: "default" };
      clock.mockReturnValue(1_000 + elapsed);
      expect(await readThreadInfoRow(api, target, undefined)).toBe(owner);
      expect(api.getNavigationQueryPage).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  }), { numRuns: 25 });
});

it("preserves the named owner's cached viewer facts when the owner cannot be reached", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.stringMatching(/^[a-z]{1,20}$/), async (owner, title) => {
    const target = { backend: "codex" as const, threadId: "t", instanceId: owner };
    const row = { ref: { backend: "codex", threadId: "t", ownerInstanceId: owner }, id: "t", source: "codex", title,
      model: "cached-model", executionMode: "default", federation: {
        ref: { backend: "codex", threadId: "t", target: { scope: "remote", instanceId: owner } },
        instanceLabel: "Offline peer", peerStatus: "disconnected",
      } } as NavigationRow;
    const api = { getNavigationQueryPage: vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
      if (request.federationTarget) throw new Error("Peer unavailable");
      expect(request.inventory).toBe("viewer");
      expect(request.query).toMatchObject({ kind: "exact", resolveFromOwners: true,
        identities: [{ backend: target.backend, threadId: target.threadId, ownerInstanceId: owner }] });
      return { entries: [{ row }] } as NavigationQueryPage;
    }) };
    expect(await readThreadInfoRow(api, target, undefined)).toBe(row);
    expect(api.getNavigationQueryPage).toHaveBeenCalledTimes(2);
  }), { numRuns: 25 });
});

it("uses the latest navigation observation even when an earlier encounter finishes last", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(fc.record({
    title: fc.stringMatching(/^[a-z]{1,20}$/),
    threadStatus: fc.constantFrom("active" as const, "idle" as const),
    model: fc.stringMatching(/^[a-z]{1,12}$/),
    executionMode: fc.constantFrom("full-access" as const, "default" as const),
  }), { minLength: 1, maxLength: 5 }), async (pending, observations) => {
    const target = { backend: "codex" as const, threadId: "t" };
    const row = { id: "t", source: "codex", ref: target, title: "Old title" } as NavigationRow;
    let finish!: (page: NavigationQueryPage) => void;
    const api = { getNavigationQueryPage: vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(() =>
      pending ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ entries: [{ row }] } as NavigationQueryPage)) };
    const encountered = readThreadInfoRow(api, target, undefined);
    if (!pending) await encountered;
    const snapshots = observations.map((facts) => ({ ...row, ...facts }));
    for (const snapshot of snapshots) observeThreadLinkRows(api, [snapshot], undefined);
    if (pending) finish({ entries: [{ row }] } as NavigationQueryPage);
    if (pending) expect(await encountered).toBe(snapshots.at(-1));
    expect(await readThreadInfoRow(api, target, undefined)).toBe(snapshots.at(-1));
    expect(api.getNavigationQueryPage).toHaveBeenCalledTimes(1);
  }), { numRuns: 25 });
});
