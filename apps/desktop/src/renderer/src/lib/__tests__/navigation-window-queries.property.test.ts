import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type {
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationRow,
} from "@pwragent/shared/contracts/navigation";
import { navigationIdentityKey } from "../navigation-query-state";
import { NavigationWindowQueries, navigationResumeQueryKey } from "../navigation-window-queries";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("publishes one loading snapshot when a pin refresh queues the admitted directory sections", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(6, 12), async (size) => {
    const read = vi.fn(async (request: NavigationQueryRequest): Promise<NavigationQueryPage> => {
      const key = JSON.stringify(request.query);
      const ref = { backend: "codex", threadId: key } as const;
      const row: NavigationRow = { id: key, source: ref.backend, ref, rowRevision: key, title: key, titleSource: "explicit",
        linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
        queueCount: 0, queueState: "unknown" };
      return { protocol: 2, queryKey: key, generation: key, ownerEpoch: "viewer", countsRevision: key,
        counts: { total: 1, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: true,
        entries: [{ row, orderKey: navigationIdentityKey(ref), placement: { kind: "root" } }] };
    });
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    try {
      const keys = Array.from({ length: size }, (_, i) => `project-${i}`);
      queries.setDemand(new Map(keys.map((key) => [key, { protocol: 2, inventory: "viewer", consumer: "main-sidebar",
        query: { kind: "directory", directoryKey: key, roots: "unpinned" } } satisfies NavigationQueryRequest])));
      await queries.refresh();
      const population = () => [...queries.getSnapshot().resources.values()].map(({ state }) => state.page?.entries[0]?.row.id);
      const before = population();
      queries.invalidate(undefined, [{ scope: "local" }], { backend: "codex", notification: {
        method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer", threadId: "mount", pinned: true, publicationId: "mount-1" },
      } });
      const loadingSnapshots: number[] = [];
      const populations: ReturnType<typeof population>[] = [];
      const unsubscribe = queries.subscribe(() => {
        loadingSnapshots.push([...queries.getSnapshot().resources.values()].filter(({ loading }) => loading).length);
        populations.push(population());
      });
      read.mockClear();
      const refresh = queries.refresh(undefined, [{ scope: "local" }], true);
      const initialLoading = [...loadingSnapshots];
      await refresh;
      unsubscribe();
      expect(initialLoading).toEqual([size]);
      expect(read).toHaveBeenCalledTimes(size);
      expect(populations.every((published) => JSON.stringify(published) === JSON.stringify(before))).toBe(true);
    } finally { queries.dispose(); }
  }), { numRuns: 12 });
});

it("lets a pin reply join its dispatched replacement without delaying other scoped refreshes", async () => {
  const owners = [{ scope: "local" }] as const;
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
    query: { kind: "directory", directoryKey: "project", roots: "unpinned" } };
  const before: NavigationQueryPage = { protocol: 2, queryKey: "project", generation: "old", ownerEpoch: "viewer",
    countsRevision: "old", counts: { total: 0, active: 0, unread: 0, review: 0 },
    coverage: { state: "complete" }, complete: true, entries: [] };
  const dispatched = deferred<void>();
  const replacement = deferred<NavigationQueryPage>();
  const read = vi.fn(async () => before);
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  try {
    queries.setDemand(new Map([["project", request]]));
    await queries.refresh();
    read.mockClear();
    read.mockImplementationOnce(() => {
      dispatched.resolve();
      return replacement.promise;
    });
    queries.invalidate(undefined, owners, { backend: "codex", notification: {
      method: "navigation/remoteThreadPins/changed",
      params: { instanceId: "peer", threadId: "mount", pinned: true, publicationId: "mount-1" },
    } });
    const fromBroadcast = queries.refresh(undefined, owners, true);
    await dispatched.promise;

    let pinCompleted = false;
    const fromReply = queries.refresh(undefined, owners, true, undefined, "action/remote-pin-add")
      .then(() => { pinCompleted = true; });
    await queries.refresh(undefined, owners, true);
    expect(pinCompleted).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);

    replacement.resolve({ ...before, countsRevision: "new" });
    await Promise.all([fromBroadcast, fromReply]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(queries.getSnapshot().resources.get("project")?.state.page?.countsRevision).toBe("new");
  } finally {
    replacement.resolve(before);
    queries.dispose();
  }
});

it("lets the pin reply recover a failed broadcast read, including a failure while it waits", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async (replyBeforeFailure) => {
    const owners = [{ scope: "local" }] as const;
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
      query: { kind: "directory", directoryKey: "project", roots: "unpinned" } };
    const initial: NavigationQueryPage = { protocol: 2, queryKey: "project", generation: "old", ownerEpoch: "viewer",
      countsRevision: "old", counts: { total: 0, active: 0, unread: 0, review: 0 },
      coverage: { state: "complete" }, complete: true, entries: [] };
    const dispatched = deferred<void>();
    const fail = deferred<void>();
    const read = vi.fn(async () => initial);
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    const pin = { backend: "codex", notification: { method: "navigation/remoteThreadPins/changed", params: {
      instanceId: "peer", threadId: "mounted", pinned: true, publicationId: "mount-1",
    } } } as const;
    const reply = () => {
      queries.invalidate(undefined, owners, pin);
      return queries.refresh(undefined, owners, true, undefined, "action/remote-pin-add");
    };
    try {
      queries.setDemand(new Map([["directory", request]]));
      await queries.refresh();
      read.mockClear().mockImplementationOnce(async () => {
        dispatched.resolve();
        await fail.promise;
        throw new Error("[navigation_busy] Read admission is occupied");
      }).mockResolvedValueOnce({ ...initial, generation: "new", countsRevision: "new" });

      queries.invalidate(undefined, owners, pin);
      const broadcast = queries.refresh(undefined, owners, true);
      await dispatched.promise;
      const earlyReply = replyBeforeFailure ? reply() : undefined;
      fail.resolve();
      await broadcast;
      await (earlyReply ?? reply());
      expect(read).toHaveBeenCalledTimes(2);
      expect(queries.getSnapshot().resources.get("directory")?.state).toMatchObject({
        stale: false, error: undefined, page: { countsRevision: "new" },
      });
    } finally {
      fail.resolve();
      queries.dispose();
    }
  }), { numRuns: 2, examples: [[false], [true]] });
});

it("retires either root anchor named by one companion mount before the first request", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 0, max: 4 }), async (childAnchor, survivors) => {
    const parent = { backend: "codex", threadId: "parent", ownerInstanceId: "peer-parent" } as const;
    const child = { backend: "codex", threadId: "child", ownerInstanceId: "peer-child" } as const;
    const remaining = Array.from({ length: survivors }, (_, index) => ({ backend: "codex" as const, threadId: `survivor-${index}` }));
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
      query: { kind: "directory", directoryKey: "project", roots: "unpinned" } };
    let mounted = false;
    const read = vi.fn(async (sent: NavigationQueryRequest): Promise<NavigationQueryPage> => {
      const roots = mounted ? remaining : [child, parent, ...remaining];
      const anchor = sent.anchor;
      if (anchor?.kind === "thread" && !roots.some((ref) => navigationIdentityKey(ref) === navigationIdentityKey(anchor.ref))) {
        throw new Error("[navigation_anchor_missing] The anchor has left the viewer's unpinned roots");
      }
      return { protocol: 2, queryKey: "project", generation: mounted ? "new" : "old", ownerEpoch: "viewer",
        countsRevision: mounted ? "new" : "old", counts: { total: roots.length, active: 0, unread: 0, review: 0 },
        coverage: { state: "complete" }, complete: true, entries: roots.map((ref) => ({
          row: { ref, id: ref.threadId, source: ref.backend, title: ref.threadId, titleSource: "explicit", rowRevision: "r",
            linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
            queueCount: 0, queueState: "unknown" }, placement: { kind: "root" }, orderKey: ref.threadId,
        })) };
    });
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    try {
      queries.setDemand(new Map([["directory", request]]));
      await queries.refresh();
      queries.setVisibleAnchor("directory", { kind: "thread", ref: childAnchor ? child : parent });
      read.mockClear();
      mounted = true;
      const publication = { instanceId: parent.ownerInstanceId, threadId: parent.threadId, pinned: true,
        publicationId: "mount-1", anchorChanges: [parent, child] };
      queries.invalidate(undefined, [{ scope: "local" }], { backend: parent.backend,
        notification: { method: "navigation/remoteThreadPins/changed", params: publication } });
      await queries.refresh(undefined, undefined, true);
      expect(read.mock.calls.map(([sent]) => sent.anchor)).toEqual([remaining[0]
        ? { kind: "thread", ref: remaining[0] } : undefined]);
      expect(queries.getSnapshot().resources.get("directory")?.state.page?.entries.map(({ row }) => row.ref)).toEqual(remaining);
    } finally { queries.dispose(); }
  }), { numRuns: 12, examples: [[true, 1], [false, 1]] });
});

// The owner is a fixed ordered list. A metadata event can fence a read but
// cannot revoke the operator's saved Load more demand for that list.
async function interruptedResume(firstPage: number, extraRows: number, interruptedPage: number) {
  const total = firstPage + extraRows;
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
    pageSize: firstPage, query: { kind: "directory", directoryKey: "project", roots: "unpinned" } };
  const rows: NavigationRow[] = Array.from({ length: total }, (_, index) => ({
    id: `thread-${index}`, source: "codex", ref: { backend: "codex", threadId: `thread-${index}` },
    title: `Thread ${index}`, titleSource: "explicit", rowRevision: "row", linkedDirectories: [],
    inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    queueCount: 0, queueState: "unknown",
  }));
  const dispatched = deferred<void>();
  const delivery = deferred<void>();
  const read = vi.fn(async (sent: NavigationQueryRequest): Promise<NavigationQueryPage> => {
    if (read.mock.calls.length === interruptedPage + 1) {
      dispatched.resolve();
      await delivery.promise;
    }
    const start = Number(sent.cursor ?? 0);
    const end = Math.min(total, start + (sent.pageSize ?? firstPage));
    return { protocol: 2, queryKey: "project", generation: "generation", ownerEpoch: "owner", countsRevision: "revision",
      counts: { total, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" },
      entries: rows.slice(start, end).map((row) => ({ row, placement: { kind: "root" }, orderKey: row.id })),
      rangeStart: start, complete: end === total, nextCursor: end < total ? String(end) : undefined };
  });
  const onRangeReset = vi.fn();
  const onLoadMore = vi.fn();
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read }, undefined, {
    loadedRowsByQuery: { [navigationResumeQueryKey(request)]: firstPage + 100 }, onRangeReset, onLoadMore,
  });
  try {
    queries.setDemand(new Map([["project", request]]));
    await dispatched.promise;
    queries.invalidate();
    const refresh = queries.refresh();
    delivery.resolve();
    await refresh;
    expect(queries.getSnapshot().resources.get("project")?.state.page?.entries.map(({ row }) => row.id))
      .toEqual(rows.map((row) => row.id));
    expect(onRangeReset).not.toHaveBeenCalled();
    expect(onLoadMore).not.toHaveBeenCalled();
  } finally { queries.dispose(); }
}

it("restores saved rows after metadata fences the opening read", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 1, max: 40 }),
    fc.integer({ min: 0, max: 1 }), interruptedResume));
});

it("keeps a second row when the one-row opening page is invalidated before delivery", async () => {
  await interruptedResume(1, 1, 0);
});

it("shares one continuation budget across metadata replacements", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async (interruptions) => {
      const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 1,
        query: { kind: "directory-index" } };
      let cursors = 0;
      const read = vi.fn(async (sent: NavigationQueryRequest): Promise<NavigationQueryPage> => {
        if (sent.cursor && ++cursors <= interruptions) queries.invalidate();
        const start = Number(sent.cursor ?? 0);
        return { protocol: 2, queryKey: "project", generation: "generation", ownerEpoch: "owner", countsRevision: "revision",
          counts: { total: 1000, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: false,
          entries: [], nextCursor: String(start + 1), directories: [{ key: String(start), label: String(start), kind: "directory",
            counts: { total: 0, active: 0, unread: 0, review: 0 }, pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false }] };
      });
      const queries = new NavigationWindowQueries({ getNavigationQueryPage: read }, undefined,
        { loadedRowsByQuery: { [navigationResumeQueryKey(request)]: 110 } });
      try {
        queries.setDemand(new Map([["project", request]]));
        await queries.refresh();
        expect(cursors).toBe(8);
        expect(read.mock.calls.filter(([sent]) => sent.cursor).map(([sent]) => sent.deadlineAt)).toEqual(Array(8).fill(10_000));
        expect(queries.getSnapshot().resources.get("project")).toMatchObject({ loading: false, state: { error: undefined } });
      } finally { queries.dispose(); }
    }));
  } finally { clock.mockRestore(); }
});

it("reads only PR-bearing rows and never list counts on a PR-only change", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 5, max: 18 }), fc.boolean(), fc.boolean(), async (size, remote, renamed) => {
    const target = remote ? { scope: "remote" as const, instanceId: "peer" } : undefined;
    const pr = { provider: "github.com", org: "fixture", repo: "changes", number: 71,
      state: "pending", url: "https://github.com/fixture/changes/pull/71" } as const;
    const prKey = "github.com/fixture/changes#71";
    const aliasKey = "github.com/fixture/old-name#71";
    const parent = { backend: "codex", threadId: "parent", ownerInstanceId: target?.instanceId } as const;
    const child = { ...parent, threadId: "child" };
    const demand = new Map<string, NavigationQueryRequest>();
    const request = (query: NavigationQueryRequest["query"]): NavigationQueryRequest => ({
      protocol: 2, consumer: "main-sidebar", inventory: remote ? "owner" : "viewer", federationTarget: target, query,
    });
    demand.set("directory-index", request({ kind: "directory-index" }));
    demand.set("children", request({ kind: "children", parent }));
    demand.set("exact", request({ kind: "exact", identities: [child] }));
    for (let index = 0; index < size; index += 1) {
      demand.set(`project-${index}`, request({ kind: "directory", directoryKey: `project-${index}` }));
    }
    const read = vi.fn(async (request: NavigationQueryRequest): Promise<NavigationQueryPage> => {
      const key = JSON.stringify(request.query);
      const carriesChange = request.query.kind === "children" || request.query.kind === "exact";
      const prKeys = carriesChange ? [renamed && !remote ? aliasKey : prKey]
        : !remote && request.query.kind === "directory" ? [`github.com/fixture/${request.query.directoryKey}#71`] : [];
      const ref = carriesChange ? child : { ...parent, threadId: key };
      const row: NavigationRow = { id: ref.threadId, source: ref.backend, ref, rowRevision: key, title: key,
        titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 0,
        nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown", ...(carriesChange ? { prs: [pr] } : {}) };
      return { protocol: 2, queryKey: key, generation: key, ownerEpoch: "fixture", countsRevision: key,
        counts: { total: 1, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: true,
        metadataDependencies: { version: 1, threadKeys: [], prKeys, prKeysComplete: true },
        entries: request.query.kind === "directory-index" ? [] : [{ row, orderKey: key, placement: { kind: "root" } }] };
    });
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    try {
      queries.setDemand(demand);
      await queries.refresh();
      read.mockClear();
      queries.invalidate(undefined, [target ?? { scope: "local" }], { backend: "codex", federationTarget: target,
        ...(renamed && !remote ? { navigationPullRequestKeyAliases: [aliasKey] } : {}),
        notification: target ? { method: "navigation/invalidated", params: { sourceMethod: "pullRequest/status/updated" } }
          : { method: "pullRequest/status/updated", params: { prKey, pr } } });
      await queries.refresh(undefined, undefined, true);
      expect(read.mock.calls.map(([sent]) => sent.query.kind).sort()).toEqual(["children", "exact"]);
    } finally {
      queries.dispose();
    }
  }), { numRuns: 12, examples: [[5, false, false], [5, false, true]] });
});

it("keeps PR recovery live through an attachment race, legacy notices and stream gaps", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (certified, partial) => {
    const target = { scope: "remote", instanceId: "peer" } as const;
    const ref = { backend: "codex", threadId: "visible", ownerInstanceId: target.instanceId } as const;
    const key = "github.com/fixture/changes#71";
    const page = (value: number): NavigationQueryPage => ({
      protocol: 2, queryKey: "project", generation: String(value), ownerEpoch: "peer", countsRevision: String(value),
      counts: { total: 2, active: 0, unread: 0, review: 0 }, coverage: { state: "complete" }, complete: !partial,
      ...(partial ? { nextCursor: `cursor-${value}` } : {}),
      ...(certified ? { metadataDependencies: { version: 1, threadKeys: [navigationIdentityKey({ ...ref, ownerInstanceId: undefined })],
        workingStatePaths: [], prKeys: value ? [key] : [], prKeysComplete: true } } : {}),
      entries: [{ orderKey: "visible", placement: { kind: "root" }, row: { ref, id: ref.threadId, source: ref.backend,
        title: "Visible", rowRevision: String(value), titleSource: "explicit", linkedDirectories: [],
        inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
        queueCount: 0, queueState: "unknown", ...(value ? { prs: [{ provider: "github.com", org: "fixture",
          repo: "changes", number: 71, url: "https://github.com/fixture/changes/pull/71",
          state: value === 1 ? "pending" : value === 2 ? "passing" : "merged" }] } : {}) } }],
    });
    let value = 0;
    const started = deferred<void>();
    const delayed = deferred<NavigationQueryPage>();
    const api = vi.fn(async () => page(value));
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: api });
    const invalidate = (sourceMethod: string) => queries.invalidate(undefined, [target], {
      backend: "codex", federationTarget: target, notification: { method: "navigation/invalidated",
        params: { sourceMethod, ...(sourceMethod === "thread/pullRequests/updated" ? { threadId: ref.threadId } : {}) } },
    });
    const current = () => queries.getSnapshot().resources.get("project")?.state.page?.entries[0]?.row;
    try {
      queries.setDemand(new Map([["project", { protocol: 2, consumer: "main-sidebar", inventory: "owner", federationTarget: target,
        query: { kind: "directory", directoryKey: "project" } }]]));
      await queries.refresh();
      expect(current()?.rowRevision).toBe("0");

      api.mockImplementationOnce(() => { started.resolve(); return delayed.promise; });
      invalidate("thread/pullRequests/updated");
      const attachmentRead = queries.refresh(undefined, undefined, true);
      await started.promise;
      value = 2;
      invalidate("pullRequest/status/updated");
      delayed.resolve(page(1));
      await attachmentRead;
      expect(current()?.prs?.[0]?.state).toBe("passing");

      value = 3;
      invalidate("pullRequest/status/updated");
      await queries.refresh(undefined, undefined, true);
      expect(current()?.prs?.[0]?.state).toBe("merged");

      value = 2; // A missed status update is recovered by the stream gap.
      queries.invalidate(undefined, [target], { backend: "codex", federationTarget: target,
        notification: { method: "federation/eventStream/changed", params: { instanceId: target.instanceId, epoch: "recovered" } } });
      await queries.refresh(undefined, undefined, true);
      expect(current()?.prs?.[0]?.state).toBe("passing");
    } finally {
      delayed.resolve(page(1));
      queries.dispose();
    }
  }), { numRuns: 12 });
});
