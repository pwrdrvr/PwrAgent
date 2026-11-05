import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { buildDirectorySummaries, type AgentEvent, type NavigationQueryRequest, type NavigationThreadSummary } from "@pwragent/shared";
import { NavigationDirectoryScope } from "@pwragent/owner-core/navigation-directory-scope";
import { NavigationQueryStore } from "@pwragent/owner-core/navigation-query-store";
import { projectNavigationQuery, type NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";
import { navigationInvalidationForLocalEvent } from "../federation/federation-runtime";
import { navigationRequestForOwner, stampRemoteNavigationQueryPage } from "../federation/federation-navigation-query";

const thread = (id: string, source: NavigationThreadSummary["source"], paths: string[]): NavigationThreadSummary => ({
  id, source, title: id, titleSource: "explicit", inbox: { inInbox: false }, threadStatus: "idle",
  linkedDirectories: paths.map((path) => ({ id: path, path, label: path.split("/").at(-1)!, kind: "local" })),
});
const indexOf = (threads: NavigationThreadSummary[]): NavigationQueryIndex => ({
  threads, directories: buildDirectorySummaries({ threads }), coverage: { state: "complete" },
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

/** Exercise real owner projection, optional compact federation transport and renderer fencing together. */
function windowFor(readIndex: (request: NavigationQueryRequest) => NavigationQueryIndex, request: NavigationQueryRequest, remote: boolean) {
  const target = { scope: "remote" as const, instanceId: "scope-owner" };
  const store = new NavigationQueryStore();
  let gate: { promise: Promise<void>; finish: () => void; started: boolean } | undefined;
  const read = vi.fn(async (sent: NavigationQueryRequest) => {
    const localized = remote ? navigationRequestForOwner(sent, target) : sent;
    const response = await store.readPage({ scopeKey: "scope-oracle", request: localized,
      loadIndex: async () => readIndex(localized) });
    if (gate) {
      const pending = gate; gate = undefined; pending.started = true;
      await pending.promise;
    }
    return remote ? stampRemoteNavigationQueryPage({ page: response, target, instanceLabel: "Owner" }) : response;
  });
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["page", { ...request, ...(remote ? { federationTarget: target } : {}) }]]));
  return { read, queries,
    state: () => queries.getSnapshot().resources.get("page")!.state,
    idle: () => !queries.getSnapshot().resources.get("page")!.loading,
    event: (event: AgentEvent): AgentEvent => remote
      ? { ...navigationInvalidationForLocalEvent(event)!, federationTarget: target } : event,
    hold: () => {
      let finish!: () => void;
      const promise = new Promise<void>((resolve) => { finish = resolve; });
      gate = { promise, finish, started: false };
      return gate;
    },
  };
}

it.each([
  { remote: false, pending: false }, { remote: true, pending: false },
  { remote: false, pending: true }, { remote: true, pending: true },
])("filtered counts follow their owner population when all-provider grouping names another checkout (remote: $remote, pending: $pending)", async ({ remote, pending }) => {
  // Specification: an exclusion proof is valid only for the population that
  // produced it. Rebuild both groupings through the production directory builder.
  await fc.assert(fc.asyncProperty(fc.constantFrom("codex", "claude", "acp:grok"),
    fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), async (backend, changes) => {
      const stable = "/fixture/repos/Repo";
      const worktree = "/fixture/.codex/worktrees/branch/Repo";
      let moving = thread("moving", backend, [worktree]);
      const other = thread("stable", backend === "claude" ? "codex" : "claude", [stable]);
      const population = (request?: NavigationQueryRequest) => indexOf([moving, other].filter((t) =>
        !request?.backend || request.backend === "all" || t.source === request.backend));
      const request: NavigationQueryRequest = { protocol: 2, inventory: "owner", consumer: "main-sidebar", backend,
        query: { kind: "directory", directoryKey: `directory:${worktree}` } };
      const scopes = new NavigationDirectoryScope();
      scopes.remember(population(), scopes.checkpoint());
      const ownerEvent = (): AgentEvent => {
        const event: AgentEvent = { backend, notification: { method: "thread/status/changed", params: {
          threadId: moving.id, status: { type: moving.threadStatus === "active" ? "active" : "idle" },
        } } };
        return { ...event, navigationDirectoryScope: scopes.forEvent(event) };
      };
      expect(population().directories.map((d) => d.key)).toEqual([`directory:${stable}`]);
      expect(population(request).directories.map((d) => d.key)).toEqual([`directory:${worktree}`]);
      const window = windowFor(population, request, remote);
      const finishes: Array<() => void> = [];
      try {
        await until(window.idle);
        for (const active of [true, ...changes, false]) {
          let refreshing: Promise<void> | undefined;
          if (pending) {
            const held = window.hold(); finishes.push(held.finish);
            window.queries.invalidate(undefined, undefined, window.event({ ...ownerEvent(), navigationDirectoryScope: undefined }));
            refreshing = window.queries.refresh(undefined, undefined, true);
            await until(() => held.started);
          }
          window.read.mockClear();
          moving = { ...moving, threadStatus: active ? "active" : "idle" };
          window.queries.invalidate(undefined, undefined, window.event(ownerEvent()));
          finishes.splice(0).forEach((finish) => finish());
          await refreshing;
          await window.queries.refresh(undefined, undefined, true);
          await until(window.idle);
          const oracle = projectNavigationQuery({ index: population(request), request });
          expect(window.state().page?.counts).toEqual(oracle.counts);
          expect(window.state().page?.entries[0]?.row.rowRevision).toBe(oracle.entries[0]!.row.rowRevision);
          expect(window.read).toHaveBeenCalledTimes(1);
        }
      } finally { window.queries.dispose(); finishes.splice(0).forEach((finish) => finish()); }
    }), { numRuns: 25 });
});

it.each([
  { remote: false, pending: false }, { remote: true, pending: false },
  { remote: false, pending: true }, { remote: true, pending: true },
])("directory Git origins refresh secondary-link row revisions (remote: $remote, pending: $pending)", async ({ remote, pending }) => {
  // Oracle: repository metadata comes from every linked path, even when a
  // thread is homed elsewhere and does not contribute to the changed directory.
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.boolean(), async (secondaryLinks, olderScope) => {
      const home = "/fixture/home";
      const paths = Array.from({ length: secondaryLinks }, (_, i) => `/fixture/linked-${i}`);
      const rows = [thread("multi-linked", "codex", [home, ...paths]),
        ...paths.map((path, i) => thread(`link-owner-${i}`, "claude", [path]))];
      let origin: string | undefined = "github.com/fixture/old";
      const index = (): NavigationQueryIndex => {
        const owner = indexOf(rows);
        return { ...owner, directories: owner.directories.map((d) => d.path === paths[0]
          ? { ...d, gitStatus: { originRepository: origin, remoteRepositories: origin ? [origin] : [] } } : d) };
      };
      const scopes = new NavigationDirectoryScope();
      scopes.remember(index(), scopes.checkpoint());
      const request: NavigationQueryRequest = { protocol: 2, inventory: "owner", consumer: "main-sidebar",
        query: { kind: "directory", directoryKey: `directory:${home}` } };
      const window = windowFor(index, request, remote);
      const finishes: Array<() => void> = [];
      try {
        await until(window.idle);
        for (const next of ["github.com/fixture/new", undefined, "github.com/fixture/restored"]) {
          const beforeIndex = index();
          const before = projectNavigationQuery({ index: beforeIndex, request });
          let refreshing: Promise<void> | undefined;
          if (pending) {
            const held = window.hold(); finishes.push(held.finish);
            window.queries.invalidate(undefined, undefined, window.event({ backend: "codex", notification: {
              method: "thread/backgroundTasks/updated", params: { threadId: "multi-linked", tasks: [] },
            } }));
            refreshing = window.queries.refresh(undefined, undefined, true);
            await until(() => held.started);
          }
          window.read.mockClear();
          origin = next;
          const event = { backend: "codex", notification: { method: "navigation/directoryGitStatus/updated",
            params: { directoryKey: `directory:${paths[0]}`, gitStatus: { originRepository: origin }, fetchedAt: 1 },
          } } as AgentEvent;
          const scope = scopes.forEvent(event);
          // Any published proof must cover all changed projections, not just
          // the directory that owns the status cache entry.
          if (scope) {
            for (const directory of beforeIndex.directories) {
              const query = { ...request, query: { kind: "directory" as const, directoryKey: directory.key } };
              const previous = projectNavigationQuery({ index: beforeIndex, request: query });
              const current = projectNavigationQuery({ index: index(), request: query });
              if (JSON.stringify(previous) !== JSON.stringify(current)) expect(scope.directoryKeys).toContain(directory.key);
            }
          }
          // A viewer can still receive the earlier, membership-only v1 proof
          // from a peer. It must refuse that proof for directory Git updates.
          window.queries.invalidate(undefined, undefined, window.event({ ...event, navigationDirectoryScope: olderScope
            ? { version: 1, directoryKeys: [`directory:${paths[0]}`] } : scope }));
          finishes.splice(0).forEach((finish) => finish());
          await refreshing;
          await window.queries.refresh(undefined, undefined, true);
          await until(window.idle);
          const after = projectNavigationQuery({ index: index(), request });
          expect(after.entries[0]!.row.rowRevision).not.toBe(before.entries[0]!.row.rowRevision);
          expect(window.state().page?.entries[0]?.row.rowRevision).toBe(after.entries[0]!.row.rowRevision);
          expect(window.state().page?.entries[0]?.row.linkedDirectories).toEqual(after.entries[0]!.row.linkedDirectories);
          expect(window.read).toHaveBeenCalledTimes(1);
        }
      } finally { window.queries.dispose(); finishes.splice(0).forEach((finish) => finish()); }
    }), { numRuns: 25 });
});
