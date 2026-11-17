import fc from "fast-check";
import { expect, it } from "vitest";
import {
  expandNavigationRemoteOwner,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  navigationQueryPageBudgetBytes,
  type FederationCapability,
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationRemoteOwner,
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
// As many capabilities as a current peer grants: about 1 KB on every row
// when they were copied there.
const capabilities = Array.from({ length: 50 }, (_, index) => `capability_number_${index}`) as FederationCapability[];
const remoteOwner: NavigationRemoteOwner = {
  instanceId: target.instanceId, instanceLabel: "Owner / default", capabilities, peerStatus: "connected",
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

/** The real owner store selects each page. The viewer adds its block and nothing else. */
function ownerAndViewer(titleLengths: number[]) {
  const store = new NavigationQueryStore();
  const index = snapshot(titleLengths);
  let ownerReads = 0;
  const owner = (sent: NavigationQueryRequest) => store.readPage({
    scopeKey: "owner", loadIndex: async () => index, request: navigationRequestForOwner(sent, target),
  });
  const viewer = (sent: NavigationQueryRequest) => readRemoteNavigationPageWithinBudget({
    request: sent,
    read: async (sized) => { ownerReads += 1; return { ...await owner(sized), remoteOwner }; },
  });
  return { owner, viewer, ownerReads: () => ownerReads };
}

async function readAll(read: (request: NavigationQueryRequest) => Promise<NavigationQueryPage>): Promise<NavigationQueryPage[]> {
  const pages: NavigationQueryPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await read({ ...request, cursor });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

it("holds every page its owner selected, on the first read, and fills its rows in", async () => {
  // A page holds at most 100 rows, so rows under about 2.5 KB never reach
  // the byte budget. Rows this size make the owner cut pages by bytes; rows
  // of 300 bytes make it cut them by count. Both overflowed once every row
  // carried the viewer's facts.
  await fc.assert(fc.asyncProperty(
    fc.oneof(fc.integer({ min: 2_600, max: 9_000 }), fc.integer({ min: 300, max: 1_200 }))
      .chain((size) => fc.array(fc.integer({ min: Math.floor(size * 0.8), max: size }), { minLength: 110, maxLength: 150, size: "max" })),
    async (titleLengths) => {
      const { owner, viewer, ownerReads } = ownerAndViewer(titleLengths);
      const selected = await readAll(owner);
      const held = await readAll(viewer);
      // Known in advance: the viewer never asks twice for a page.
      expect(ownerReads()).toBe(selected.length);
      expect(held.length).toBe(selected.length);
      held.forEach((page, index) => {
        // It costs the viewer what it cost the owner, and its rows are the owner's rows.
        expect(navigationQueryPageBudgetBytes(page)).toBe(bytes(selected[index]!));
        expect(navigationQueryPageBudgetBytes(page)).toBeLessThanOrEqual(NAVIGATION_QUERY_MAX_RESULT_BYTES);
        expect(page.entries).toEqual(selected[index]!.entries);
        // Filled in, it is what callers have always read, at the same charge.
        const filled = expandNavigationRemoteOwner(page);
        expect(navigationQueryPageBudgetBytes(filled)).toBe(bytes(selected[index]!));
        const { remoteOwner: _owner, ...rows } = filled;
        expect(rows).toEqual(stampRemoteNavigationQueryPage({ page: selected[index]!, target,
          instanceLabel: remoteOwner.instanceLabel, capabilities, peerStatus: "connected" }));
      });
    },
  // Every run pages a real owner store at the real 252 KiB budget.
  ), { numRuns: 8 });
});

it("holds a full page that outgrew the budget when every row carried the viewer's facts", async () => {
  // 100 rows of about 1.6 KB: 160 KB as selected. With 1 KB of capabilities
  // copied onto each row it was over the 252 KiB budget and was refused.
  const { owner, viewer, ownerReads } = ownerAndViewer(Array.from({ length: 100 }, () => 1_300));
  const selected = await owner(request);
  expect(selected.entries).toHaveLength(100);
  expect(bytes(stampRemoteNavigationQueryPage({ page: selected, target, instanceLabel: "Owner / default", capabilities })))
    .toBeGreaterThan(NAVIGATION_QUERY_MAX_RESULT_BYTES);
  const page = await viewer(request);
  expect(ownerReads()).toBe(1);
  expect(page.entries).toHaveLength(100);
  expect(expandNavigationRemoteOwner(page).entries.every(({ row }) => row.federation?.capabilities === capabilities)).toBe(true);
});

it("asks for fewer rows when an owner sends more than the budget", async () => {
  // An owner that miscounts sends the same page on every request, so a
  // refusal would fail on every refresh.
  const rows = snapshot(Array.from({ length: 40 }, () => 200)).threads;
  const sizes: Array<number | undefined> = [];
  const read = async (sent: NavigationQueryRequest): Promise<NavigationQueryPage> => {
    sizes.push(sent.pageSize);
    const page = await new NavigationQueryStore().readPage({ scopeKey: "owner",
      loadIndex: async () => ({ ...snapshot([]), threads: rows }), request: navigationRequestForOwner(sent, target) });
    return { ...page, remoteOwner };
  };
  const all = await read(request);
  sizes.length = 0;
  const maxBytes = Math.floor(bytes({ ...all, remoteOwner: undefined }) / 3);
  const page = await readRemoteNavigationPageWithinBudget({ request, read, maxBytes });
  expect(navigationQueryPageBudgetBytes(page)).toBeLessThanOrEqual(maxBytes);
  expect(page.entries.length).toBeGreaterThan(0);
  expect(page.entries.map(({ row }) => row.id)).toEqual(all.entries.slice(0, page.entries.length).map(({ row }) => row.id));
  expect(page.nextCursor).toBeDefined();
  expect(sizes).toEqual([undefined, 20, 10]);
});

it("asks for fewer rows when the viewer's block is over its own cap", async () => {
  const { owner } = ownerAndViewer(Array.from({ length: 8 }, () => 200));
  let reads = 0;
  const page = await readRemoteNavigationPageWithinBudget({ request, maxOwnerBytes: 2_000,
    read: async (sent) => {
      reads += 1;
      const selected = await owner(sent);
      // Disclosure for each row served, standing in for a page of directories.
      return { ...selected, remoteOwner: { ...remoteOwner, capabilities: [],
        directoryThreadsCollapsed: Object.fromEntries(selected.entries.map(({ row }) => [`/projects/${row.id}/${"d".repeat(400)}`, true])) } };
    } });
  expect(reads).toBe(2);
  expect(page.entries).toHaveLength(4);
});

it("reports a single row that cannot fit instead of asking again", async () => {
  let reads = 0;
  const { owner } = ownerAndViewer([800]);
  await expect(readRemoteNavigationPageWithinBudget({
    request, maxBytes: 64,
    read: async (sent) => { reads += 1; return { ...await owner(sent), remoteOwner }; },
  })).rejects.toMatchObject({ code: "navigation_item_too_large" });
  expect(reads).toBe(1);
});
