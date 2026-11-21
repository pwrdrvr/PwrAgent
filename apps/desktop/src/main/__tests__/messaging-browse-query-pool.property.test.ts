import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { MessagingBrowseQueryPool } from "../messaging/core/messaging-browse-query-pool";

type PageStep = { direction: -1 | 1; shortName: string };

async function expectPaginationWithRenames(pageSize: number, steps: PageStep[]) {
  const now = () => 1_000;
  const local = new NavigationQueryStore({ now });
  const remote = new NavigationQueryStore({ now });
  const target = { scope: "remote" as const, instanceId: "studio" };
  const originalLabel = "Studio Tower";
  const threads: NavigationThreadSummary[] = Array.from({ length: 16 }, (_, index) => ({
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    updatedAt: 100 - index, linkedDirectories: [], inbox: { inInbox: false },
  }));
  const pool = new MessagingBrowseQueryPool((request) => {
    const isRemote = request.federationTarget?.scope === "remote";
    return (isRemote ? remote : local).readPage({ scopeKey: "owner", request,
      loadIndex: async () => ({ threads: threads.filter((_, index) => (index % 2 === 0) === isRemote), directories: [] }) });
  }, now);
  const base = { sessionId: "resume", query: { kind: "messaging-threads" as const }, pageSize };
  const read = (pageIndex: number, label: string) => pool.read({ ...base, pageIndex, owners: [
    { label: "This instance" }, { target, label },
  ] });

  // Owner results are immutable during this sequence. The model is an ordered list and a page offset.
  const expectedRows = threads.map(({ id }, index) => ({ id, owner: index % 2 === 0 ? target.instanceId : undefined }));
  const lastPage = Math.ceil(expectedRows.length / pageSize) - 1;
  let pageIndex = (await read(0, originalLabel)).pageIndex;
  expect(pageIndex).toBe(0);
  for (const { direction, shortName } of steps) {
    pageIndex = Math.min(lastPage, Math.max(0, pageIndex + direction));
    const page = await read(pageIndex, shortName);
    expect(page.pageIndex).toBe(pageIndex);
    expect(page.notes).toEqual([]);
    expect(page.threads.map((row) => ({ id: row.id, owner: row.ref.ownerInstanceId })))
      .toEqual(expectedRows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize));
    for (const row of page.threads) {
      expect(row.federation?.instanceLabel).toBe(row.ref.ownerInstanceId ? originalLabel : undefined);
    }
  }

  pool.release(base.sessionId);
  const latestLabel = steps.at(-1)!.shortName;
  const reopened = await read(0, latestLabel);
  expect(reopened.threads[0]?.federation?.instanceLabel).toBe(latestLabel);
}

it("matches the page model across owner renames and forward and back actions", async () => {
  const shortName = fc.stringMatching(/^Mini[A-Z]{0,5}$/);
  const step = fc.record({ direction: fc.constantFrom(-1 as const, 1 as const), shortName });
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), shortName, fc.array(step, { maxLength: 5 }),
    async (pageSize, firstAlias, steps) => {
      await expectPaginationWithRenames(pageSize, [{ direction: 1, shortName: firstAlias }, ...steps]);
    }), { numRuns: 30 });
});

it("keeps Next on page two when Studio Tower gains the short name Mini", async () => {
  await expectPaginationWithRenames(1, [{ direction: 1, shortName: "Mini" }]);
});
