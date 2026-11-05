import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AgentEvent, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { NavigationWindowQueries } from "../navigation-window-queries";

function page(request: NavigationQueryRequest, revision = "0"): NavigationQueryPage {
  const query = request.query;
  const parent = query.kind === "children" ? query.parent : { backend: "codex" as const, threadId: "root" };
  return { protocol: 2, queryKey: JSON.stringify(query), generation: revision, ownerEpoch: "owner", countsRevision: revision,
    coverage: { state: "complete" }, counts: { total: 1, active: 0, unread: 0, review: 0 }, complete: true,
    entries: [{ orderKey: "0", placement: { kind: "child", parent }, row: {
      id: `${parent.threadId}-child`, source: parent.backend, title: revision, titleSource: "explicit",
      ref: { ...parent, threadId: `${parent.threadId}-child` }, rowRevision: revision,
      linkedDirectories: [{ id: parent.threadId, kind: "local", label: parent.threadId, path: `/${parent.threadId}` }],
      inbox: { inInbox: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
    } }],
  };
}

const request = (index: number): NavigationQueryRequest => ({ protocol: 2, consumer: "main-sidebar",
  query: { kind: "children", parent: { backend: "codex", threadId: `parent-${index}` } } });
const event = (index: number, method = "thread/backgroundTasks/updated"): AgentEvent => ({ backend: "codex", notification: {
  method, params: method === "navigation/threadGitWorkingState/updated"
    ? { worktreePath: `/parent-${index}`, state: "clean" } : { threadId: `parent-${index}-child` },
} } as AgentEvent);

async function until(predicate: () => boolean) {
  // The owner and controller use promises only. Advance microtasks, never a
  // wall clock; an unexpected extra read fails with the unsatisfied invariant.
  for (let step = 0; step < 500 && !predicate(); step++) await Promise.resolve();
  expect(predicate()).toBe(true);
}
const idle = (queries: NavigationWindowQueries) => [...queries.getSnapshot().resources.values()].every((resource) => !resource.loading);

it("row-only bursts obey complete child membership even while metadata is stale or refreshing", async () => {
  // Specification: without a membership change, the owner's complete child
  // set remains the exclusion oracle throughout any ordering of row events.
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ group: fc.integer({ min: 0, max: 7 }), git: fc.boolean() }), { minLength: 2, maxLength: 20 }),
    async (changes) => {
      const read = vi.fn(async (sent: NavigationQueryRequest) => page(sent));
      const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
      queries.setDemand(new Map(Array.from({ length: 8 }, (_, i) => [`group-${i}`, request(i)])));
      try {
        await until(() => idle(queries));
        read.mockClear();
        for (const change of changes) queries.invalidate(undefined, undefined,
          event(change.group, change.git ? "navigation/threadGitWorkingState/updated" : "thread/backgroundTasks/updated"));
        await queries.refresh(undefined, undefined, true);
        const affected = [...new Set(changes.map((change) => change.group))].sort();
        const actual = read.mock.calls.map(([sent]) => sent.query.kind === "children" ? Number(sent.query.parent.threadId.slice(7)) : -1).sort();
        expect(actual).toEqual(affected);
      } finally { queries.dispose(); }
    },
  ), { numRuns: 25 });
});

it("an unrelated row event cannot fence an in-flight metadata-only child read", async () => {
  let finish!: (value: NavigationQueryPage) => void;
  const read = vi.fn(async (sent: NavigationQueryRequest) => page(sent));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["group-0", request(0)]]));
  try {
    await until(() => idle(queries));
    read.mockClear();
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    queries.invalidate(undefined, undefined, event(0));
    const refreshing = queries.refresh(undefined, undefined, true);
    await until(() => read.mock.calls.length === 1);
    queries.invalidate(undefined, undefined, event(1));
    finish(page(request(0), "fresh"));
    await refreshing;
    expect(read).toHaveBeenCalledTimes(1);
    expect(queries.getSnapshot().resources.get("group-0")?.state.page?.countsRevision).toBe("fresh");
  } finally { queries.dispose(); }
});

it("queued demand consumes all events before dispatch without issuing a doomed page first", async () => {
  const finishes: Array<() => void> = [];
  const read = vi.fn((sent: NavigationQueryRequest) => new Promise<NavigationQueryPage>((resolve) => {
    finishes.push(() => resolve(page(sent)));
  }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map(Array.from({ length: 12 }, (_, i) => [`group-${i}`, request(i)])));
  try {
    await until(() => read.mock.calls.length === 4);
    queries.invalidate();
    const refreshed = queries.refresh(undefined, undefined, true);
    for (let wave = 0; wave < 20 && !idle(queries); wave++) {
      const completing = finishes.splice(0);
      completing.forEach((finish) => finish());
      for (let step = 0; step < 30; step++) await Promise.resolve();
    }
    await refreshed;
    expect(read).toHaveBeenCalledTimes(16); // four dispatched reads fenced, eight queued reads already fresh
  } finally { queries.dispose(); finishes.forEach((finish) => finish()); }
});

it("sizes each immutable transport page once and never serializes unrelated retained pages again", async () => {
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  const read = vi.fn(async (sent: NavigationQueryRequest) => page(sent));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  try {
    queries.setDemand(new Map(Array.from({ length: 32 }, (_, i) => [`group-${i}`, request(i)])));
    await until(() => idle(queries));
    const pageSizes = () => encode.mock.calls.filter(([text]) => text?.startsWith('{"protocol":2,"queryKey":')).length;
    expect(pageSizes()).toBe(32);
    encode.mockClear();
    queries.invalidate("group-0");
    await queries.refresh(undefined, undefined, true);
    expect(pageSizes()).toBe(1);
  } finally { queries.dispose(); encode.mockRestore(); }
});
