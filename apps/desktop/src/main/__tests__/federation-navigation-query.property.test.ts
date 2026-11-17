import fc from "fast-check";
import { expect, it } from "vitest";
import {
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationSnapshot,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { NavigationQueryStore } from "@pwragent/owner-core/navigation-query-store";
import {
  navigationRequestForOwner,
  readRemoteNavigationPageWithinBudget,
  stampRemoteNavigationQueryPage,
} from "../federation/federation-navigation-query";

const target = { scope: "remote" as const, instanceId: "pwr_00000000-0000-4000-8000-000000000000" };
const request: NavigationQueryRequest = {
  protocol: 2, consumer: "main-sidebar", federationTarget: target, query: { kind: "lens", lens: "recents" },
};
const bytes = (page: NavigationQueryPage): number => Buffer.byteLength(JSON.stringify(page), "utf8");

function snapshot(titleLengths: number[]): NavigationSnapshot {
  const threads = titleLengths.map((length, index): NavigationThreadSummary => ({
    id: `thread-${index}`, source: "codex", title: "t".repeat(length), titleSource: "derived",
    createdAt: index + 1, updatedAt: index + 1, linkedDirectories: [], inbox: { inInbox: false },
  }));
  return { backend: "all", fetchedAt: 1, unchanged: false, threads, inboxThreadKeys: [], directories: [],
    launchpadDefaults: { backend: "codex", executionMode: "default" } };
}

/** The real owner store fills each page; the viewer stamps what arrives. */
function ownerAndViewer(titleLengths: number[]) {
  const store = new NavigationQueryStore();
  const index = snapshot(titleLengths);
  const owner = (sent: NavigationQueryRequest) => store.readPage({
    scopeKey: "owner", loadIndex: async () => index, request: navigationRequestForOwner(sent, target),
  });
  const stamped = async (sent: NavigationQueryRequest) => stampRemoteNavigationQueryPage({
    page: await owner(sent), target, instanceLabel: "Owner / default",
    capabilities: ["thread_navigation", "turn_control"], peerStatus: "connected",
  });
  return { owner, stamped };
}

async function readAll(read: (request: NavigationQueryRequest) => Promise<NavigationQueryPage>): Promise<{ ids: string[]; largest: number }> {
  const ids: string[] = [];
  let largest = 0;
  let cursor: string | undefined;
  do {
    const page = await read({ ...request, cursor });
    largest = Math.max(largest, bytes(page));
    ids.push(...page.entries.map(({ row }) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  return { ids, largest };
}

it("serves every owner row, in owner order, in pages that fit the budget after stamping", async () => {
  // A page holds at most 100 rows, so rows under about 2.5 KB never reach
  // the byte budget. These rows make the owner cut every full page by bytes,
  // which is where stamping overflows.
  let overflowed = 0;
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer({ min: 2_600, max: 9_000 }), { minLength: 110, maxLength: 150, size: "max" }),
    async (titleLengths) => {
      const { owner, stamped } = ownerAndViewer(titleLengths);
      const expected = await readAll(owner);
      if ((await readAll(stamped)).largest > NAVIGATION_QUERY_MAX_RESULT_BYTES) overflowed += 1;
      const served = await readAll((sent) => readRemoteNavigationPageWithinBudget({ request: sent, read: stamped }));
      expect(served.largest).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
      expect(served.ids).toEqual(expected.ids);
    },
  // Every run pages a real owner store at the real 252 KiB budget.
  ), { numRuns: 8 });
  // The generator must reach the bound, or the property holds vacuously.
  expect(overflowed).toBeGreaterThan(0);
});

it("refits a page its owner filled to the budget", async () => {
  // Rows of about 3 KB: the owner cuts its first page at the byte budget, and
  // stamping then adds to every row it kept.
  const { owner, stamped } = ownerAndViewer(Array.from({ length: 200 }, () => 2_800));
  const ownerPage = await owner(request);
  expect(bytes(ownerPage)).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
  expect(bytes(await stamped(request))).toBeGreaterThan(NAVIGATION_QUERY_MAX_RESULT_BYTES);
  const page = await readRemoteNavigationPageWithinBudget({ request, read: stamped });
  expect(bytes(page)).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
  expect(page.entries.length).toBeGreaterThan(0);
  expect(page.entries.map(({ row }) => row.id)).toEqual(ownerPage.entries.slice(0, page.entries.length).map(({ row }) => row.id));
  expect(page.nextCursor).toBeDefined();
});

it("reports a single row that cannot fit instead of asking again", async () => {
  let reads = 0;
  const { stamped } = ownerAndViewer([800]);
  await expect(readRemoteNavigationPageWithinBudget({
    request, maxBytes: 64,
    read: async (sent) => { reads += 1; return stamped(sent); },
  })).rejects.toMatchObject({ code: "navigation_item_too_large" });
  expect(reads).toBe(1);
});
