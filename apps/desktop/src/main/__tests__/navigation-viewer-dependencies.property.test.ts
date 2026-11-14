import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import { buildPullRequestStatusKey, buildThreadIdentityKey, federatedThreadIdentityKey } from "@pwragent/shared";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { appendViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";

const ref = (thread: NavigationThreadSummary) => ({ backend: thread.source, threadId: thread.id,
  ...(thread.federation?.ref.target.scope === "remote" ? { ownerInstanceId: thread.federation.ref.target.instanceId } : {}) });
const key = (thread: NavigationThreadSummary) => thread.federation ? federatedThreadIdentityKey(thread.federation.ref)
  : buildThreadIdentityKey(thread.source, thread.id);
const pr = (number: number) => ({ provider: "github" as const, org: "fixture", repo: "repo", number,
  url: `https://github.com/fixture/repo/pull/${number}`, state: "passing" as const });
async function settle() { for (let i = 0; i < 300; i++) await Promise.resolve(); }

function population(groups: number, backend?: "claude") {
  const directories = Array.from({ length: groups }, (_, i) => ({ key: `directory:/viewer/project-${i}`, kind: "directory" as const,
    label: `project-${i}`, path: `/viewer/project-${i}`, threadKeys: [] as string[], needsAttentionCount: 0, latestUpdatedAt: 0 }));
  const threads = directories.flatMap((directory, i) => [undefined, "peer", "nested"].flatMap((owner) =>
    ["codex", "claude"].flatMap((source): NavigationThreadSummary[] => {
      const backend = source as "codex" | "claude";
      return Array.from({ length: 4 }, (_, j): NavigationThreadSummary => ({ id: `row-${i}-${j}`, source: backend,
        title: `Row ${j}`, titleSource: "explicit", inbox: { inInbox: false }, prs: [pr(i + 1)], createdAt: 10 - j,
        ...(j === 0 ? { pinnedRank: String(i + 1) } : { parentThreadId: `row-${i}-${j - 1}`, parentThreadBackend: backend }),
        ...(owner === "nested" && j === 3 ? { parentThreadInstanceId: "peer" } : {}),
        linkedDirectories: [{ id: `link-${i}`, kind: "local", label: directory.label,
          path: `${owner ? "/owner" : "/viewer"}/project-${i}` }],
        ...(owner ? { federation: { ref: { backend, threadId: `row-${i}-${j}`, target: { scope: "remote", instanceId: owner } },
          instanceLabel: owner, peerStatus: "connected" } } : {}),
      }));
    })));
  for (const directory of directories) directory.threadKeys = threads.filter((thread) => !thread.federation
    && thread.linkedDirectories[0]!.path === directory.path).map(key);
  const index = () => appendViewerNavigationPins({ coverage: { state: "complete" }, directories,
    threads: threads.filter((thread) => !thread.federation && (!backend || thread.source === backend)) }, threads.filter((thread) => thread.federation));
  return { threads, directories, index };
}

it("includes an off-page relayed descendant in a selected local project's count dependencies", async () => {
  const data = population(2);
  const store = new NavigationQueryStore();
  const request: NavigationQueryRequest = { protocol: 2, inventory: "viewer", consumer: "main-sidebar", pageSize: 1,
    query: { kind: "exact", identities: [{ backend: "codex", threadId: "row-0-0" }], includeAncestry: true, ancestryScope: "directory" } };
  const page = await store.readPage({ request, scopeKey: "viewer", loadIndex: async () => data.index() });
  expect(page.entries.map(({ row }) => row.ref)).toEqual([{ backend: "codex", threadId: "row-0-0" }]);
  expect(page.selectionDirectory?.key).toBe("directory:/viewer/project-0");
  expect(page.metadataDependencies?.threadKeys).toContain(JSON.stringify(["nested", "codex", "row-0-3"]));
  expect(page.metadataDependencies?.threadKeys).not.toContain(JSON.stringify(["nested", "codex", "row-1-3"]));
});

it("refreshes exactly the viewer directories and selected counts whose full population contains the changed row or PR", async () => {
  // Oracle: actual owner projection after viewer regrouping, before pagination.
  // IDs collide across owners/providers; a grandchild is off every loaded page.
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.nat(5), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), async (groups, choice, remote, status, filtered, shared) => {
    const data = population(groups, filtered ? "claude" : undefined);
    const group = choice % groups;
    if (shared) for (const thread of data.threads) {
      if (Number(thread.id.split("-")[1]) % 2 === group % 2) thread.prs = [pr(77)];
    }
    const store = new NavigationQueryStore();
    const requests = new Map<string, NavigationQueryRequest>();
    for (const [i, directory] of data.directories.entries()) {
      const selected = data.threads.find((thread) => thread.id === `row-${i}-0` && Boolean(thread.federation) === remote
        && thread.source === (filtered ? "claude" : "codex"))!;
      for (const roots of ["pinned", "unpinned"] as const) requests.set(`${i}-${roots}`, { protocol: 2, consumer: "main-sidebar",
        inventory: "viewer", ...(filtered ? { backend: "claude" } : {}), pageSize: 1, query: { kind: "directory", directoryKey: directory.key, roots } });
      requests.set(`${i}-selection`, { protocol: 2, consumer: "main-sidebar", inventory: "viewer", pageSize: 1,
        ...(filtered ? { backend: "claude" } : {}),
        query: { kind: "exact", identities: [ref(selected)], includeAncestry: true, ancestryScope: "directory" } });
    }
    const read = vi.fn(async (request: NavigationQueryRequest) => store.readPage({ request, scopeKey: "viewer", loadIndex: async () => data.index() }));
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(requests);
    try {
      await settle(); read.mockClear();
      const changed = data.threads.find((thread) => thread.id === `row-${group}-3` && thread.source === "codex"
        && thread.federation?.ref.target.scope === "remote" && thread.federation.ref.target.instanceId === "nested")!;
      const number = changed.prs![0]!.number;
      if (status) {
        for (const thread of data.threads.filter((thread) => thread.prs?.some((attached) => attached.number === number))) {
          thread.prs = thread.prs!.map((attached) => ({ ...attached, state: "pending" }));
        }
      } else changed.inbox = { inInbox: true };
      const event: AgentEvent = status ? { backend: "codex", notification: { method: "pullRequest/status/updated",
        params: { prKey: buildPullRequestStatusKey(pr(number)), pr: { ...pr(number), state: "pending" } } } }
        : { backend: "codex", notification: { method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer", rowChanges: [ref(changed) as ReturnType<typeof ref> & { ownerInstanceId: string }] } } };
      queries.invalidate(undefined, undefined, event);
      await queries.refresh(undefined, undefined, true);
      const affected = data.directories.filter((_, i) => status && shared ? i % 2 === group % 2 : i === group);
      expect(read.mock.calls.map(([request]) => request.query.kind === "directory" ? request.query.directoryKey
        : request.query.kind === "exact" ? `directory:/viewer/project-${request.query.identities[0]!.threadId.split("-")[1]}` : "unexpected").sort())
        .toEqual(affected.flatMap((directory) => Array(3).fill(directory.key)).sort());
      for (const [id, resource] of queries.getSnapshot().resources) {
        const oracle = await store.readPage({ request: requests.get(id)!, scopeKey: "oracle", loadIndex: async () => data.index() });
        expect(resource.state.page?.selectionDirectory).toEqual(oracle.selectionDirectory);
        expect(resource.state.page?.entries).toEqual(oracle.entries);
        expect(resource.state.stale).toBe(false);
      }
    } finally { queries.dispose(); }
  }), { numRuns: 25 });
});

it("keeps membership and attachment fences until overlapping viewer observations land in either order", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (membership, reverse) => {
    const data = population(2);
    const selected = data.threads[0]!;
    const store = new NavigationQueryStore();
    let gated = false;
    const replies: Array<() => void> = [];
    const read = vi.fn(async (request: NavigationQueryRequest) => {
      const page = await store.readPage({ request, scopeKey: "viewer", loadIndex: async () => data.index() });
      if (gated) await new Promise<void>((resolve) => replies.push(resolve));
      return page;
    });
    const requests = new Map<string, NavigationQueryRequest>([
      ["index", { protocol: 2, inventory: "viewer", consumer: "main-sidebar", query: { kind: "directory-index" } }],
      ["directory", { protocol: 2, inventory: "viewer", consumer: "main-sidebar", pageSize: 1,
        query: { kind: "directory", directoryKey: data.directories[0]!.key, roots: "pinned" } }],
      ["selected", { protocol: 2, inventory: "viewer", consumer: "main-sidebar",
        query: { kind: "exact", identities: [ref(selected)], includeAncestry: true, ancestryScope: "directory" } }],
    ]);
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(requests);
    try {
      await settle(); gated = true; read.mockClear();
      queries.invalidate(undefined, undefined, membership
        ? { backend: "codex", notification: { method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer" } } }
        : { backend: "codex", notification: { method: "thread/pullRequests/updated", params: { threadId: selected.id, prs: [pr(99)] } } });
      const refreshing = queries.refresh(undefined, undefined, true);
      await settle(); expect(replies).toHaveLength(3);
      const changed = membership ? { ...data.threads.find((thread) => thread.federation)!, id: "discovered",
        inbox: { inInbox: true }, federation: { ...data.threads.find((thread) => thread.federation)!.federation!,
          ref: { ...data.threads.find((thread) => thread.federation)!.federation!.ref, threadId: "discovered" } } } : selected;
      if (membership) data.threads.push(changed);
      else changed.prs = [pr(99)];
      const event: AgentEvent = membership
        ? { backend: "codex", notification: { method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer",
          rowChanges: [ref(changed) as ReturnType<typeof ref> & { ownerInstanceId: string }] } } }
        : { backend: "codex", federationTarget: { scope: "remote", instanceId: "peer" },
          notification: { method: "pullRequest/status/updated", params: { prKey: buildPullRequestStatusKey(pr(99)), pr: pr(99) } } };
      // An owner's differently grouped directory scope is never a viewer exclusion.
      event.navigationDirectoryScope = { version: 1, directoryKeys: ["directory:/wrong-owner-project"] };
      queries.invalidate(undefined, undefined, event);
      for (let step = 0; step < 12; step++) {
        (reverse ? replies.reverse() : replies).splice(0).forEach((finish) => finish()); await settle();
        if ([...queries.getSnapshot().resources.values()].every((resource) => !resource.loading)) break;
      }
      await refreshing;
      expect(read).toHaveBeenCalledTimes(6);
      for (const [id, resource] of queries.getSnapshot().resources) {
        const oracle = await store.readPage({ request: requests.get(id)!, scopeKey: "oracle", loadIndex: async () => data.index() });
        expect(resource.state.page?.counts).toEqual(oracle.counts);
        expect(resource.state.page?.selectionDirectory).toEqual(oracle.selectionDirectory);
        expect(resource.state.page?.entries).toEqual(oracle.entries);
        expect(resource.state.stale).toBe(false);
      }
    } finally { queries.dispose(); replies.splice(0).forEach((finish) => finish()); }
  }), { numRuns: 25 });
});

it("withdraws viewer dependencies for incomplete coverage, old pages and excessive complete populations", async () => {
  const data = population(24);
  const store = new NavigationQueryStore();
  const request: NavigationQueryRequest = { protocol: 2, inventory: "viewer", consumer: "main-sidebar", pageSize: 1,
    query: { kind: "directory-index" } };
  const page = await store.readPage({ request, scopeKey: "large", loadIndex: async () => data.index() });
  expect(page.metadataDependencies).toBeUndefined();
  const small = population(2);
  const incomplete = await store.readPage({ request, scopeKey: "degraded", loadIndex: async () => ({ ...small.index(), coverage: { state: "degraded" } }) });
  expect(incomplete.metadataDependencies).toBeUndefined();
  for (const response of [page, incomplete, { ...incomplete, coverage: { state: "complete" as const } }]) {
    const read = vi.fn(async () => response);
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(new Map([["index", request]]));
    try {
      await settle(); read.mockClear();
      queries.invalidate(undefined, undefined, { backend: "codex", notification: { method: "pullRequest/status/updated",
        params: { prKey: buildPullRequestStatusKey(pr(99)), pr: pr(99) } } });
      await queries.refresh(undefined, undefined, true);
      expect(read).toHaveBeenCalledOnce();
    } finally { queries.dispose(); }
  }
});
