import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type {
  NavigationDirectoryRow,
  NavigationQueryRequest,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { createNavigationPageState, navigationIdentityKey } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { memoRenderObserver } from "../../../test/memo-render-observer";
import * as tooltips from "../../../lib/useViewportTooltip";
import * as status from "../ThreadRowStatus";
import { ThreadRow } from "../ThreadRow";
import { RecentsList } from "../RecentsList";
import { DirectoriesList } from "../DirectoriesList";

const rowRenders = memoRenderObserver<{ thread: NavigationThreadSummary }>(ThreadRow, "ThreadRow");
afterEach(() => { cleanup(); rowRenders.restore(); vi.restoreAllMocks(); });

/** Stable owner pages: changing a viewer's draft must not manufacture new owner rows. */
function fixture(count: number) {
  const threads: NavigationThreadSummary[] = Array.from({ length: count }, (_, i) => ({
    id: i < 3 ? "same-id" : `thread-${i}`, source: "codex", title: `Contrived row ${i}`,
    titleSource: "explicit", inbox: { inInbox: false }, updatedAt: 100 - i,
    linkedDirectories: [{ id: "/fixture", kind: "local", label: "Fixture", path: "/fixture" }],
    ...(i === 0 ? { pinnedRank: "1", subthreadsCollapsed: false } : {}),
    ...(i === 3 ? { parentThreadId: "same-id", subthreadsCollapsed: false } : {}),
    ...(i === 4 ? { parentThreadId: "thread-3" } : {}),
    ...(i === 1 || i === 2 ? { federation: { instanceLabel: `Peer ${i}`, peerStatus: "connected",
      ref: { backend: "codex", threadId: "same-id", target: { scope: "remote", instanceId: `peer-${i}` } } } } : {}),
  }));
  const resources = new Map<string, NavigationWindowResource>();
  const directory: NavigationDirectoryRow = { key: "directory:/fixture", kind: "directory", label: "Fixture", path: "/fixture",
    counts: { total: count, active: 0, unread: 0, review: 0 }, pinnedRootCount: 1, unpinnedRootCount: count - 3, launchpadPresent: false };
  const add = (id: string, query: NavigationQueryRequest["query"]) => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query, pageSize: count };
    const page = navigationQueryFixture(request, { threads, directories: [directory] });
    resources.set(id, { id, loading: false, state: { ...createNavigationPageState(request), page } });
  };
  add("lens", { kind: "lens", lens: "inbox", roots: "unpinned" });
  add("lens-pins", { kind: "lens", lens: "inbox", roots: "pinned" });
  add(`directory:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "unpinned" });
  add(`directory-pins:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "pinned" });
  for (const parent of [threads[0]!, threads[3]!]) {
    const ref = { backend: parent.source, threadId: parent.id };
    add(`children:${navigationIdentityKey(ref)}`, { kind: "children", parent: ref, directoryKey: directory.key });
  }
  // Use exactly the stable row objects on the pages, like the real navigation owner.
  const loaded = [...new Map([...resources.values()].flatMap((resource) => resource.state.page!.entries)
    .map(({ row }) => [threadSummaryIdentityKey(row), row])).values()];
  const navigation = { resources, presentationReady: true, directories: [directory], connected: true,
    selectedDirectoryKeys: [directory.key], invalidate: vi.fn(), refresh: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined), rebaseline: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined), setVisibleAnchor: vi.fn() };
  const common = { threads: loaded, pagedNavigation: navigation, onSelectThread: vi.fn(), onOpenThreadContextMenu: vi.fn() };
  const visitor = { ...threads[0]!, id: "visitor", title: "Contrived visiting thread", pinnedRank: undefined };
  const offscreen = { ...threads[0]!, id: "offscreen", title: "Contrived offscreen thread", pinnedRank: undefined };
  const tree = (lens: "flat" | "directories" | "visiting", draftThreadKeys?: Record<string, boolean>) => lens !== "directories"
    ? <RecentsList {...common} loadedThreads={loaded} pinnedResourceId="lens-pins" draftThreadKeys={draftThreadKeys}
      visitingThread={lens === "visiting" ? visitor : undefined} visitingLabel="Open thread" />
    : <DirectoriesList {...common} directories={[directory]} selectedItemKey="codex:same-id"
      selectedThreadDirectoryKeys={navigation.selectedDirectoryKeys} draftThreadKeys={draftThreadKeys} onOpenLaunchpad={async () => undefined} />;
  return { loaded, tree, visitor, offscreen };
}

it.each(["flat", "directories", "visiting"] as const)("only executes %s rows whose own draft presence changed (owner-key oracle)", (lens) => {
  // The owner-qualified key is the oracle, including duplicate ids on two peers.
  // Exercise roots, pins and two depths of children through the real list/row boundary.
  fc.assert(fc.property(fc.array(fc.record({ index: fc.integer({ min: 0, max: 7 }), present: fc.boolean() }),
    { minLength: 8, maxLength: 16, size: "max" }), (commands) => {
    const f = fixture(6);
    const renders: string[] = [];
    rowRenders.install(({ thread }) => renders.push(threadSummaryIdentityKey(thread)));
    const view = render(f.tree(lens));
    const mounted = [...renders];
    let drafts: Record<string, boolean> = {};
    try {
      expect(new Set(mounted)).toEqual(new Set([...f.loaded, ...(lens === "visiting" ? [f.visitor] : [])].map(threadSummaryIdentityKey)));
      for (const { index, present } of commands) {
        const key = threadSummaryIdentityKey([...f.loaded, f.visitor, f.offscreen][index]!);
        const changed = (drafts[key] === true) !== present;
        renders.length = 0;
        drafts = { ...drafts, [key]: present };
        view.rerender(f.tree(lens, drafts));
        expect(renders).toEqual(changed && mounted.includes(key) ? [key] : []);
        for (const row of view.container.querySelectorAll<HTMLElement>(".thread-row-shell[data-thread-key]")) {
          const rowKey = row.dataset.threadKey!;
          expect(Boolean(row.querySelector('[data-thread-draft="unsent"]'))).toBe(drafts[rowKey] === true);
        }
      }
    } finally { view.unmount(); rowRenders.restore(); }
  }), { numRuns: 25 });
});

it("does not execute a row when a fresh draft map leaves every value absent", () => {
  const f = fixture(6);
  const renders = vi.fn();
  rowRenders.install(renders);
  const view = render(f.tree("flat"));
  expect(renders).toHaveBeenCalledTimes(6);
  renders.mockClear();
  view.rerender(f.tree("flat", { [threadSummaryIdentityKey(f.loaded[0]!)]: false }));
  expect(renders).not.toHaveBeenCalled();
});

it.each([6, 12].flatMap((count) => (["flat", "directories"] as const).map((lens) => ({ count, lens }))))(
  "bounds row renders, status operations and tooltip-controller allocations at $count $lens rows", ({ count, lens }) => {
    const f = fixture(count);
    let renders = 0;
    rowRenders.install(() => { renders++; });
    const view = render(f.tree(lens));
    expect(renders).toBe(count);
    const readStatus = vi.spyOn(status, "getThreadRowStatus");
    // This hook returns one new controller object on every call. Count those
    // allocation-producing operations; sampled heap bytes are deliberately not a CI threshold.
    const controllers = vi.spyOn(tooltips, "useViewportTooltip");
    renders = 0;
    const key = threadSummaryIdentityKey(f.loaded[0]!);
    for (let i = 0; i < 20; i++) view.rerender(f.tree(lens, i % 2 ? {} : { [key]: true }));
    const measured = { rowRenders: renders, statusReads: readStatus.mock.calls.length, tooltipControllers: controllers.mock.calls.length };
    if (process.env.DRAFT_ROW_OPERATION_REPORT) console.info({ count, lens, ...measured });
    // This directory presentation has one additional tooltip controller.
    expect(measured).toEqual({ rowRenders: 20, statusReads: 20, tooltipControllers: lens === "flat" ? 180 : 200 });
  },
);
