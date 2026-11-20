import type {
  NavigationQueryEntry,
  NavigationQueryRequest,
  NavigationRow,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { readNavigationPresentationOrder } from "../navigation-presentation-order";
import { buildPagedDirectoryChildren } from "../paged-directory-presentation";
import * as childBuilders from "../paged-directory-presentation";
import { projectPagedDirectoryChildren, type PagedDirectoryChildrenProjection } from "../usePagedDirectoryChildren";
import { projectDirectoryTrays, readDirectoryTrays, type DirectoryTrayProjection } from "../useDirectoryTrays";
import { canFoldSubthreads, createSubthreadTrays, ordinaryChildCountOf } from "../subthread-trays";
import * as trayBuilders from "../subthread-trays";

type ModelRow = NavigationRow & Pick<NavigationThreadSummary, "subthreadOrder">;

function population(count = 20): ModelRow[] {
  return Array.from({ length: count }, (_, index) => {
    const backend = index % 2 ? "claude" : "codex";
    const instanceId = `owner-${Math.floor(index / 2) % 2}`;
    return { id: `row-${index}`, source: backend, title: `Title ${index}`, titleSource: "explicit", createdAt: index,
      ref: { backend, threadId: `row-${index}`, ownerInstanceId: instanceId }, rowRevision: "r", linkedDirectories: [],
      inbox: { inInbox: false }, ordinaryChildCount: 1, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
      federation: { ref: { backend, threadId: `row-${index}`, target: { scope: "remote", instanceId } },
        instanceLabel: instanceId, capabilities: ["thread_grouping"], peerStatus: "connected" } };
  });
}

function resource(id: string, query: NavigationQueryRequest["query"], entries: NavigationQueryEntry[]): NavigationWindowResource {
  return { id, loading: false, state: { ...createNavigationPageState({ protocol: 2, inventory: "owner", consumer: "main-sidebar", query }),
    page: { protocol: 2, queryKey: id, generation: "g", ownerEpoch: "owner", countsRevision: "r", coverage: { state: "complete" },
      counts: { total: entries.length, active: 0, unread: 0, review: 0 }, entries, complete: false, nextCursor: "opaque-cursor" } } };
}

const fields = { index: fc.nat({ max: 19 }), value: fc.integer({ min: 0, max: 20 }) };

it("matches uncached owner child pages through generated metadata, placement and ordering transitions", () => {
  const command = fc.record({ ...fields, kind: fc.constantFrom("metadata", "count", "parent", "scope", "order", "duplicate", "omit", "admit", "reverse", "rank", "page") });
  fc.assert(fc.property(fc.boolean(), fc.array(command, { minLength: 30, maxLength: 40, size: "max" }), (supplied, commands) => {
    const rows = population();
    const entries = rows.slice(2).map((row, index): NavigationQueryEntry => ({ row,
      placement: { kind: "child", parent: rows[index % 2]!.ref }, orderKey: String(index) }));
    let resources = new Map([
      ["children-a", resource("children-a", { kind: "children", directoryKey: "a", parent: rows[0]!.ref }, entries)],
      ["children-b", resource("children-b", { kind: "children", directoryKey: "b", parent: rows[1]!.ref }, entries.slice().reverse())],
      ["exact", resource("exact", { kind: "exact", identities: rows.map((row) => row.ref) }, entries.slice(0, 4))],
    ]);
    let threadsByKey = new Map(rows.map((row) => [threadSummaryIdentityKey(row), row]));
    let previous: PagedDirectoryChildrenProjection | undefined;
    for (const [step, command] of commands.entries()) {
      const row = rows[command.index % rows.length]!;
      const page = resources.get("children-a")!.state.page!;
      const entry = entries[command.index % entries.length]!;
      if (command.kind === "metadata") {
        const next = { ...row, title: `Fresh ${step}` };
        threadsByKey.set(threadSummaryIdentityKey(row), next);
      }
      if (command.kind === "count") row.ordinaryChildCount = command.value;
      if (command.kind === "parent") entry.placement = { kind: "child", parent: rows[command.value % 2]!.ref };
      if (command.kind === "scope") {
        const query = resources.get("children-a")!.state.request.query;
        if (query.kind === "children") query.directoryKey = query.directoryKey === "a" ? "b" : "a";
      }
      if (command.kind === "order") page.entries.reverse();
      if (command.kind === "duplicate") page.entries = [...page.entries, { ...entry, row: { ...entry.row, ordinaryChildCount: command.value } }];
      if (command.kind === "omit") threadsByKey.delete(threadSummaryIdentityKey(row));
      if (command.kind === "admit") threadsByKey.set(threadSummaryIdentityKey(row), { ...row, title: `Admitted ${step}` });
      if (command.kind === "reverse") resources = new Map([...resources].reverse());
      if (command.kind === "rank") {
        const exact = resources.get("exact")!;
        exact.state.request.federationTarget = { scope: "remote", instanceId: row.ref.ownerInstanceId! };
        entry.siblingOrder = command.value;
      }
      if (command.kind === "page") resources.get("children-a")!.state.page = { ...page, countsRevision: `r${step}` };
      const params = { resources, threadsByKey,
        ...(supplied ? { presentationOrder: readNavigationPresentationOrder(resources) } : {}) };
      const expected = buildPagedDirectoryChildren(params);
      previous = projectPagedDirectoryChildren(previous, params);
      expect(previous.children).toEqual(expected);
      for (const [key, directory] of expected) {
        expect([...previous.children.get(key)!.childThreadsByParentKey.keys()]).toEqual([...directory.childThreadsByParentKey.keys()]);
      }
      expect(resources.get("children-a")!.state.page!.nextCursor).toBe("opaque-cursor");
    }
  }), { numRuns: 25 });
});

for (const count of [32, 64]) {
  it(`budgets unchanged and one changed membership action over ${count} rows`, () => {
    const rows = population(count);
    const page = resource("children", { kind: "children", directoryKey: "a", parent: rows[0]!.ref }, rows.slice(2).map((row, index) => ({
      row, placement: { kind: "child", parent: rows[0]!.ref }, orderKey: String(index),
    })));
    let resources = new Map([[page.id, page]]);
    let threadsByKey = new Map(rows.map((row) => [threadSummaryIdentityKey(row), row]));
    let cache = projectPagedDirectoryChildren(undefined, { resources, threadsByKey });
    const original = cache.keys;
    const builds = vi.spyOn(childBuilders, "buildPagedDirectoryChildKeys");
    try {
      for (let action = 0; action < 20; action++) {
        // Fresh wrappers and rows retain only their relevant scalar values.
        resources = new Map([[page.id, { ...page, state: { ...page.state, page: { ...page.state.page!, countsRevision: `r${action}` } } }]]);
        threadsByKey = new Map(rows.map((row) => [threadSummaryIdentityKey(row), { ...row, title: `Fresh ${action}` }]));
        cache = projectPagedDirectoryChildren(cache, { resources, threadsByKey });
        expect(cache.keys).toBe(original);
        expect(builds).not.toHaveBeenCalled();
      }
      page.state.page!.entries[count - 3]!.placement = { kind: "child", parent: rows[1]!.ref };
      cache = projectPagedDirectoryChildren(cache, { resources, threadsByKey });
      expect(cache.keys).not.toBe(original);
      expect(builds).toHaveBeenCalledTimes(1);
      cache = projectPagedDirectoryChildren(cache, { resources, threadsByKey });
      expect(builds).toHaveBeenCalledTimes(1);
      expect(cache.children).toEqual(buildPagedDirectoryChildren({ resources, threadsByKey }));
    } finally { vi.restoreAllMocks(); }
  });

  it(`budgets metadata and one changed tray-order action over ${count} rows`, () => {
    let rows = population(count);
    const params = () => ({ children: new Map([[threadSummaryIdentityKey(rows[0]!), rows.slice(2)]]), owners: rows.slice(0, 2),
      ownerChildOrder: new Map<string, string[]>(), options: {}, threadsByKey: new Map(rows.map((row) => [threadSummaryIdentityKey(row), row])) });
    let cache = projectDirectoryTrays(undefined, params());
    const original = cache;
    const builds = vi.spyOn(trayBuilders, "createSubthreadTrays");
    try {
      for (let action = 0; action < 20; action++) {
        rows = rows.map((row) => ({ ...row, title: `Fresh ${action}` }));
        cache = projectDirectoryTrays(cache, params());
        expect(cache).toBe(original);
        expect(builds).not.toHaveBeenCalled();
      }
      rows[count - 1]!.createdAt = count * 2;
      cache = projectDirectoryTrays(cache, params());
      expect(cache).not.toBe(original);
      expect(builds).toHaveBeenCalledTimes(1);
      cache = projectDirectoryTrays(cache, params());
      expect(builds).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); }
  });
}

it("admits a previously missing parent bucket in owner order and releases removed directory scopes", () => {
  const rows = population(4);
  const page = resource("children", { kind: "children", directoryKey: "a", parent: rows[0]!.ref }, [
    { row: rows[2]!, placement: { kind: "child", parent: rows[0]!.ref }, orderKey: "0" },
    { row: rows[3]!, placement: { kind: "child", parent: rows[1]!.ref }, orderKey: "1" },
  ]);
  const resources = new Map([[page.id, page]]);
  const threadsByKey = new Map([[threadSummaryIdentityKey(rows[3]!), rows[3]!]]);
  let cache = projectPagedDirectoryChildren(undefined, { resources, threadsByKey });
  threadsByKey.set(threadSummaryIdentityKey(rows[2]!), rows[2]!);
  cache = projectPagedDirectoryChildren(cache, { resources, threadsByKey });
  const expected = buildPagedDirectoryChildren({ resources, threadsByKey });
  expect([...cache.children.get("a")!.childThreadsByParentKey.keys()]).toEqual([...expected.get("a")!.childThreadsByParentKey.keys()]);
  resources.clear();
  cache = projectPagedDirectoryChildren(cache, { resources, threadsByKey });
  expect(cache.keys.size).toBe(0);
  expect(cache.children.size).toBe(0);
});

it("keeps bucket order when the first available child disappears but its parent still has children", () => {
  const rows = population(6);
  const page = resource("children", { kind: "children", directoryKey: "a", parent: rows[0]!.ref }, [
    { row: rows[5]!, placement: { kind: "child", parent: rows[1]!.ref }, orderKey: "0" },
    { row: rows[4]!, placement: { kind: "child", parent: rows[0]!.ref }, orderKey: "1" },
    { row: rows[3]!, placement: { kind: "child", parent: rows[1]!.ref }, orderKey: "2" },
  ]);
  const resources = new Map([[page.id, page]]);
  const threadsByKey = new Map(rows.map((row) => [threadSummaryIdentityKey(row), row]));
  let cache = projectPagedDirectoryChildren(undefined, { resources, threadsByKey });
  threadsByKey.delete(threadSummaryIdentityKey(rows[5]!));
  cache = projectPagedDirectoryChildren(cache, { resources, threadsByKey });
  expect([...cache.children.get("a")!.childThreadsByParentKey.keys()]).toEqual([
    threadSummaryIdentityKey(rows[0]!), threadSummaryIdentityKey(rows[1]!),
  ]);
});

it("matches uncached descendant trays through generated folds, drafts, capabilities and owner order", () => {
  const command = fc.record({ ...fields, kind: fc.constantFrom("metadata", "created", "order", "collapse", "capability", "draft", "count", "reverse", "owner", "backend", "identity") });
  fc.assert(fc.property(fc.boolean(), fc.array(command, { minLength: 30, maxLength: 40, size: "max" }), (ordered, commands) => {
    let rows = population();
    const parentIndex = rows.map((_, index) => index < 2 ? -1 : Math.floor((index - 2) / 2));
    const drafts = new Set<string>();
    let previous: DirectoryTrayProjection | undefined;
    for (const [step, command] of commands.entries()) {
      const index = command.index % rows.length;
      const row = rows[index]!;
      if (command.kind === "metadata") rows[index] = { ...row, title: `Fresh ${step}`, gitBranch: `branch-${step}` };
      if (command.kind === "created") row.createdAt = command.value;
      if (command.kind === "order") row.subthreadOrder = rows.slice(command.value % 10).map((child) => child.id).reverse();
      if (command.kind === "collapse") row.subthreadsCollapsed = !row.subthreadsCollapsed;
      if (command.kind === "capability") row.federation!.capabilities = row.federation!.capabilities?.length ? [] : ["thread_grouping"];
      if (command.kind === "draft") { drafts.clear(); if (command.value % 2) drafts.add(threadSummaryIdentityKey(row)); }
      if (command.kind === "count") row.ordinaryChildCount = command.value;
      if (command.kind === "owner") row.federation!.ref.target = { scope: "remote", instanceId: `owner-${command.value % 3}` };
      if (command.kind === "backend") { row.source = row.source === "codex" ? "claude" : "codex"; row.federation!.ref.backend = row.source; }
      if (command.kind === "identity") {
        row.federation!.ref.target = { scope: "remote", instanceId: `owner-${command.value % 3}` };
        row.source = row.source === "codex" ? "claude" : "codex";
        row.federation!.ref.backend = row.source;
      }
      const children = new Map<string, NavigationRow[]>();
      for (let child = 2; child < rows.length; child++) {
        const key = threadSummaryIdentityKey(rows[parentIndex[child]!]!);
        const bucket = children.get(key) ?? [];
        bucket.push(rows[child]!);
        children.set(key, bucket);
      }
      if (command.kind === "reverse") for (const bucket of children.values()) bucket.reverse();
      const ownerChildOrder = new Map(ordered ? [...children].map(([key, bucket]) => [key, bucket.map(threadSummaryIdentityKey).reverse()]) : []);
      const owners = rows.slice(0, 2);
      const options = { draftParentKeys: drafts,
        isCollapsed: (candidate: NavigationThreadSummary) => Boolean(candidate.subthreadsCollapsed) && ordinaryChildCountOf(candidate) > 0 && canFoldSubthreads(candidate, true) };
      const expected = createSubthreadTrays(children, owners, ownerChildOrder, options);
      const threadsByKey = new Map(rows.map((item) => [threadSummaryIdentityKey(item), item]));
      previous = projectDirectoryTrays(previous, { children, owners, ownerChildOrder, options, threadsByKey });
      const actual = readDirectoryTrays(previous, threadsByKey);
      for (const owner of owners) {
        const key = threadSummaryIdentityKey(owner);
        expect(actual.subtree(key)).toEqual(expected.subtree(key));
        expect(actual.directChildKeys(key)).toEqual(expected.directChildKeys(key));
      }
      for (const item of rows) {
        const key = threadSummaryIdentityKey(item);
        expect(actual.depth(key)).toBe(expected.depth(key));
        expect(actual.pagesAfter(key)).toEqual(expected.pagesAfter(key));
        expect(actual.folded(key)).toBe(expected.folded(key));
        expect(actual.heldOpen(key)).toBe(expected.heldOpen(key));
      }
      // Fresh metadata is read from this pass's rows, not from the topology's
      // original objects, even when every membership scalar stayed unchanged.
      rows = rows.map((item) => ({ ...item }));
    }
  }), { numRuns: 25 });
});

it("publishes an owner-only identity change without an owner-order hint", () => {
  const rows = population(4);
  for (const row of rows.slice(2)) { row.id = "shared-id"; row.federation!.ref.threadId = row.id; }
  const children = new Map([[threadSummaryIdentityKey(rows[0]!), rows.slice(2)]]);
  const owners = rows.slice(0, 1);
  const ownerChildOrder = new Map<string, string[]>();
  const params = () => ({ children, owners, ownerChildOrder, options: {},
    threadsByKey: new Map(rows.map((row) => [threadSummaryIdentityKey(row), row])) });
  const before = projectDirectoryTrays(undefined, params());
  rows[2]!.federation!.ref.target = { scope: "remote", instanceId: "new-owner" };
  const after = projectDirectoryTrays(before, params());
  const actual = readDirectoryTrays(after, params().threadsByKey);
  expect(after).not.toBe(before);
  expect(actual.subtree(threadSummaryIdentityKey(rows[0]!))).toEqual(
    createSubthreadTrays(children, owners, ownerChildOrder).subtree(threadSummaryIdentityKey(rows[0]!)),
  );
});
