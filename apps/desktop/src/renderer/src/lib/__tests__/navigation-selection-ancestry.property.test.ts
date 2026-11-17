import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { NavigationIdentity, NavigationQueryPage, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { createNavigationPageState } from "../navigation-query-state";
import { NavigationWindowQueries, type NavigationWindowResource } from "../navigation-window-queries";
import { projectDisclosedNavigationParents, visibleDisclosedNavigationParents } from "../navigation-window-demand";

const directory = { key: "directory:/viewer", path: "/viewer", label: "Viewer", kind: "directory" as const };
const ref = (threadId: string, ownerInstanceId = "peer"): NavigationIdentity => ({ backend: "codex", threadId, ownerInstanceId });
const thread = (id: string, parent?: string): NavigationThreadSummary => ({ id, source: "codex", title: id, titleSource: "explicit",
  linkedDirectories: [{ id: directory.key, kind: "local", path: directory.path, label: directory.label }], inbox: { inInbox: false },
  ...(parent ? { parentThreadId: parent, parentThreadBackend: "codex" } : { pinnedRank: "11" }),
  federation: { instanceLabel: "Peer", ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId: "peer" } } },
});
const request = (query: NavigationQueryRequest["query"], owner = false): NavigationQueryRequest => ({ protocol: 2,
  consumer: "main-sidebar", inventory: owner ? "owner" : "viewer", query, pageSize: 100,
  ...(owner ? { federationTarget: { scope: "remote", instanceId: "peer" } } : {}),
});
const exact = (id: string, owner = false) => request({ kind: "exact", identities: [ref(id)], includeAncestry: true, ancestryScope: "directory" }, owner);
const resource = (id: string, req: NavigationQueryRequest, page?: NavigationQueryPage, error?: string): NavigationWindowResource => ({
  id, loading: !page && !error, state: { ...createNavigationPageState(req), page, error },
});

// Oracle: only an admitted placement chain can justify borrowing an older
// root. New authoritative absence/errors/relationships override that bridge;
// the pending selected query must never acquire the borrowed page as its reply.
it("models owner outcomes, scope and identity changes during selection turnover", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 24 }), fc.array(fc.record({
    outcome: fc.constantFrom("pending", "present", "qualified", "legacy", "provider-moved", "absent", "error", "reparented"),
    cachedOwner: fc.boolean(), scopeMatches: fc.boolean(), sameOwner: fc.boolean(), admitted: fc.boolean(), viewerReady: fc.boolean(),
  }), { minLength: 8, maxLength: 20 }), (count, observations) => {
    const population = [thread("parent"), ...Array.from({ length: count }, (_, i) => thread(`child-${i}`, "parent"))];
    const prior = navigationQueryFixture(exact("parent"), { directories: [directory], threads: population });
    const childrenRequest = request({ kind: "children", parent: ref("parent"), directoryKey: directory.key });
    const controller = new NavigationWindowQueries({});
    try {
      for (const [i, observation] of observations.entries()) {
        const selection = ref(`child-${i % count}`, observation.sameOwner ? "peer" : "other");
        const childRequest = exact(selection.threadId);
        if (childRequest.query.kind === "exact") childRequest.query.identities = [selection];
        const childPage = navigationQueryFixture(childRequest, { directories: [directory], threads: population });
        const children = navigationQueryFixture(childrenRequest, { directories: [directory], threads: population });
        if (!observation.admitted) children.entries = children.entries.filter(({ row }) => row.id !== selection.threadId);
        const scopedRequest = { ...childrenRequest, query: { ...childrenRequest.query, directoryKey: observation.scopeMatches ? directory.key : "other" } } as NavigationQueryRequest;
        const ownerRequest = { ...childRequest, inventory: "owner" as const, federationTarget: { scope: "remote" as const, instanceId: selection.ownerInstanceId! } };
        const ownerPage = observation.outcome === "pending" || observation.outcome === "error" ? undefined
          : navigationQueryFixture(ownerRequest, { directories: [directory], threads: observation.outcome === "absent" ? []
            : observation.outcome === "legacy" || observation.outcome === "provider-moved" ? population.map((row) => row.id === selection.threadId
              ? { ...row, parentThreadBackend: observation.outcome === "legacy" ? undefined : "claude" as const } : row)
            : observation.outcome === "qualified" ? population.map((row) => row.id === selection.threadId ? { ...row, parentThreadInstanceId: "peer" } : row)
            : observation.outcome === "reparented" ? population.map((row) => row.id === selection.threadId ? { ...row, parentThreadId: "new-parent" } : row) : population });
        const viewer = observation.viewerReady ? resource("selected-viewer-mount", childRequest, childPage)
          : resource("selected-viewer-mount", exact("parent"), prior);
        const resources = new Map([
          [viewer.id, viewer],
          ["selected-context", { ...resource("selected-context", ownerRequest, ownerPage, observation.outcome === "error" ? "Denied" : undefined),
            restoredFromCache: Boolean(ownerPage) && observation.cachedOwner }],
          ["children", resource("children", scopedRequest, children)],
        ]);
        const actual = controller.selectionAncestry(selection, undefined, { resources });
        const bridgeAllowed = observation.scopeMatches && observation.sameOwner && observation.admitted
          && ((Boolean(ownerPage) && observation.cachedOwner) || observation.outcome === "pending" || observation.outcome === "present" || observation.outcome === "qualified" || observation.outcome === "legacy");
        expect(actual).toBe(observation.viewerReady ? childPage : bridgeAllowed ? prior : undefined);
        expect(resources.get("selected-context")?.state.page).toBe(ownerPage);
        expect(resources.get("selected-viewer-mount")?.state.page).toBe(observation.viewerReady ? childPage : prior);
      }
    } finally { controller.dispose(); }
  }));
});

it("keeps the same admitted parent when an owner omits its legacy backend qualifier", () => {
  const population = [thread("parent"), { ...thread("child", "parent"), parentThreadBackend: undefined }];
  const prior = navigationQueryFixture(exact("parent"), { directories: [directory], threads: population });
  const owner = navigationQueryFixture(exact("child", true), { directories: [directory], threads: population });
  const childRequest = request({ kind: "children", parent: ref("parent"), directoryKey: directory.key });
  const children = navigationQueryFixture(childRequest, { directories: [directory], threads: population });
  const resources = new Map([
    ["selected-viewer-mount", resource("selected-viewer-mount", exact("parent"), prior)],
    ["selected-context", resource("selected-context", exact("child", true), owner)],
    ["children", resource("children", childRequest, children)],
  ]);
  const controller = new NavigationWindowQueries({});
  try { expect(controller.selectionAncestry(ref("child"), undefined, { resources })).toBe(prior); }
  finally { controller.dispose(); }
});

it("does not present another owner's current exact page after the window target changes", () => {
  const population = [thread("parent"), thread("child", "parent")];
  const ownerPage = navigationQueryFixture(exact("child", true), { directories: [directory], threads: population });
  const resources = new Map([["selected-context", resource("selected-context", exact("child", true), ownerPage)]]);
  const controller = new NavigationWindowQueries({});
  try { expect(controller.selectionAncestry(ref("child"), { scope: "remote", instanceId: "other" }, { resources })).toBeUndefined(); }
  finally { controller.dispose(); }
});

it.each([6, 12].flatMap((count) => [false, true].map((cachedEmpty) => ({ count, cachedEmpty }))))(
  "borrows bounded ancestry with $count children, cachedEmpty=$cachedEmpty, and zero additional reads", async ({ count, cachedEmpty }) => {
  const population = [thread("parent"), ...Array.from({ length: count }, (_, i) => thread(`child-${i}`, "parent"))];
  let gated = false;
  let obsolete = cachedEmpty;
  const replies: Array<() => void> = [];
  const read = vi.fn(async (req: NavigationQueryRequest) => {
    if (gated) await new Promise<void>((resolve) => replies.push(resolve));
    return navigationQueryFixture(req, { directories: [directory], threads: obsolete ? [] : population });
  });
  const controller = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const childRequest = request({ kind: "children", parent: ref("parent"), directoryKey: directory.key });
  try {
    if (cachedEmpty) {
      controller.setDemand(new Map([["selected-viewer-mount", exact("child-0")]]));
      await controller.refresh();
      obsolete = false;
    }
    controller.setDemand(new Map([["selected-viewer-mount", exact("parent")], ["children", childRequest]]));
    await controller.refresh();
    const prior = controller.getSnapshot().resources.get("selected-viewer-mount")!.state.page;
    const children = controller.getSnapshot().resources.get("children")!.state.page!;
    const entries = children.entries;
    let visits = 0;
    children.entries = new Proxy(entries, { get: (target, key, receiver) => key === Symbol.iterator ? function* () {
      for (const entry of target) { visits++; yield entry; }
    } : Reflect.get(target, key, receiver) });
    gated = true;
    read.mockClear();
    controller.setDemand(new Map([["selected-viewer-mount", exact("child-0")], ["children", childRequest]]));
    const snapshot = controller.getSnapshot();
    expect(snapshot.resources.get("selected-viewer-mount")?.state.page?.entries).toEqual(cachedEmpty ? [] : undefined);
    expect(controller.selectionAncestry(ref("child-0"), { scope: "remote", instanceId: "other" }, snapshot)).toBeUndefined();
    const queries = 7;
    for (let i = 0; i < queries; i++) expect(controller.selectionAncestry(ref(`child-${i % count}`), undefined, snapshot)).toBe(prior);
    expect(visits).toBe(count * queries);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1); // Only the new exact selection; no child reread.
    controller.setDemand(new Map());
    expect(controller.selectionAncestry(ref("child-0"), undefined, controller.getSnapshot())).toBeUndefined();
  } finally {
    controller.dispose(); replies.splice(0).forEach((reply) => reply());
  }
});

// Disclosure is the operator's state. The visible collection's count is the
// membership oracle; an arbitrary owner-directory/global overlay is not.
it("keeps scoped child demand independent of global counts, and respects collapse and owner changes", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), fc.boolean(),
    fc.boolean(), (viewerCount, ownerCount, collapsed, otherOwner) => {
      const row = { ...thread("parent"), ordinaryChildCount: ownerCount, subthreadsCollapsed: collapsed };
      const candidates = projectDisclosedNavigationParents(new Map([["parent", row]]), []);
      const population = [thread("parent"), ...Array.from({ length: viewerCount }, (_, i) => thread(`child-${i}`, "parent"))];
      const page = navigationQueryFixture(request({ kind: "directory", directoryKey: directory.key, roots: "pinned" }),
        { directories: [directory], threads: population });
      if (otherOwner) page.entries = page.entries.map((entry) => ({ ...entry, row: { ...entry.row, ref: ref(entry.row.id, "other") } }));
      expect(visibleDisclosedNavigationParents({ collectionIds: ["directory-pins:directory:/viewer"],
        pages: new Map([["directory-pins:directory:/viewer", page]]), disclosedParents: candidates }))
        .toEqual(viewerCount > 0 && !collapsed && !otherOwner ? [ref("parent")] : []);
    }));
});
