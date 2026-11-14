import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent, NavigationQueryRequest, NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { NavigationWindowQueries } from "../navigation-window-queries";

const pr = (number: number): PrSummary => ({ provider: "github", org: "fixture", repo: "repo", number,
  url: `https://github.com/fixture/repo/pull/${number}`, state: "passing" });
const prKey = (number: number) => buildPullRequestStatusKey(pr(number));
const target = { scope: "remote" as const, instanceId: "peer" };
function population(groups: number): NavigationThreadSummary[] {
  return Array.from({ length: groups }, (_, i) => [false, true].flatMap((remote) => {
    const parent: NavigationThreadSummary = { id: `parent-${i}`, source: "codex", title: "Parent", titleSource: "explicit",
      inbox: { inInbox: false }, linkedDirectories: [], ...(remote ? { federation: {
        ref: { backend: "codex" as const, threadId: `parent-${i}`, target }, instanceLabel: "Peer", peerStatus: "connected" as const,
      } } : {}) };
    return [parent, ...Array.from({ length: 2 }, (_, j): NavigationThreadSummary => ({ ...parent,
      id: `child-${i}-${j}`, title: "Child", parentThreadId: parent.id, parentThreadBackend: "codex",
      prs: [pr(i + 1)], ...(remote ? { federation: { ...parent.federation!,
        ref: { ...parent.federation!.ref, threadId: `child-${i}-${j}` } } } : {}),
    }))];
  })).flat();
}
const demand = (groups: number, partial = false) => new Map(Array.from({ length: groups }, (_, i) => [false, true].map((remote) => {
  const id = `${remote ? "remote" : "local"}-${i}`;
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer", pageSize: partial ? 1 : 100,
    query: { kind: "children", parent: { backend: "codex", threadId: `parent-${i}`, ...(remote ? { ownerInstanceId: "peer" } : {}) } } };
  return [id, request] as const;
})).flat());
const summaryEvent = (group: number, ownerInstanceId = "peer"): AgentEvent => ({ backend: "codex", notification: {
  method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer",
    rowChanges: [{ backend: "codex", threadId: `child-${group}-0`, ownerInstanceId }] },
} } as AgentEvent);
const prEvent = (group: number): AgentEvent => ({ backend: "codex", notification: {
  method: "pullRequest/status/updated", params: { prKey: prKey(group + 1), pr: pr(group + 1) },
} });
async function advance() { for (let i = 0; i < 160; i++) await Promise.resolve(); }
const idle = (queries: NavigationWindowQueries) => [...queries.getSnapshot().resources.values()].every((r) => !r.loading);

it("metadata refresh reads exactly the complete child collections containing the changed owner row or PR", async () => {
  // Oracle: the full viewer population owns identity and PR attachment. Local
  // and remote rows deliberately reuse IDs; PR status applies to both owners.
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 16 }), fc.boolean(), fc.nat(15), fc.boolean(), async (groups, pins, index, nested) => {
    let threads = population(groups);
    threads = [...threads, ...threads.filter((row) => row.federation).map((row) => ({ ...row,
      federation: { ...row.federation!, ref: { ...row.federation!.ref, target: { scope: "remote" as const, instanceId: "nested" } } } }))];
    threads = [...threads, ...threads.map((row): NavigationThreadSummary => ({ ...row, source: "claude",
      ...(row.parentThreadId ? { parentThreadBackend: "claude" } : {}),
      ...(row.federation ? { federation: { ...row.federation, ref: { ...row.federation.ref, backend: "claude" } } } : {}),
    }))];
    const read = vi.fn(async (request: NavigationQueryRequest) => navigationQueryFixture(request, { threads }));
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    const requests = demand(groups);
    for (const [id, request] of [...requests]) {
      if (id.startsWith("remote") && request.query.kind === "children") requests.set(id.replace("remote", "nested"), {
        ...request, query: { ...request.query, parent: { ...request.query.parent, ownerInstanceId: "nested" } },
      });
    }
    for (const [id, request] of [...requests]) {
      if (request.query.kind === "children") requests.set(`claude-${id}`, { ...request,
        query: { ...request.query, parent: { ...request.query.parent, backend: "claude" } } });
    }
    queries.setDemand(requests);
    try {
      await advance(); expect(idle(queries)).toBe(true); read.mockClear();
      const group = index % groups;
      const affected = pins ? [`${nested ? "nested" : "remote"}-${group}`]
        : ["", "claude-"].flatMap((backend) => ["local", "remote", "nested"].map((owner) => `${backend}${owner}-${group}`));
      const before = queries.getSnapshot();
      threads = threads.map((thread) => pins
        ? thread.id === `child-${group}-0` && thread.source === "codex" && thread.federation?.ref.target.scope === "remote"
          && thread.federation.ref.target.instanceId === (nested ? "nested" : "peer") ? { ...thread, title: "Fresh" } : thread
        : { ...thread, prs: thread.prs?.map((attached) => attached.number === group + 1 ? { ...attached, state: "pending" } : attached) });
      queries.invalidate(undefined, undefined, pins ? summaryEvent(group, nested ? "nested" : "peer") : prEvent(group));
      await queries.refresh(undefined, undefined, true);
      expect(read.mock.calls.map(([sent]) => sent.query.kind === "children"
        ? `${sent.query.parent.backend === "claude" ? "claude-" : ""}${sent.query.parent.ownerInstanceId === "nested" ? "nested"
          : sent.query.parent.ownerInstanceId ? "remote" : "local"}-${sent.query.parent.threadId.slice(7)}` : "unexpected").sort()).toEqual(affected.sort());
      for (const [id, resource] of queries.getSnapshot().resources) {
        if (affected.includes(id)) expect(resource.state.page).toEqual(navigationQueryFixture(resource.state.request, { threads }));
        else expect(resource).toBe(before.resources.get(id));
      }
    } finally { queries.dispose(); }
  }), { numRuns: 25 });
});

it.each([4, 16, 48])("budgets one unrelated metadata notification across %i local and mounted child collections", async (groups) => {
  const threads = population(groups);
  const read = vi.fn(async (request: NavigationQueryRequest) => navigationQueryFixture(request, { threads }));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const published = vi.fn();
  const unsubscribe = queries.subscribe(published);
  queries.setDemand(demand(groups));
  try {
    await advance(); expect(idle(queries)).toBe(true);
    for (const event of [summaryEvent(groups), prEvent(groups)]) {
      read.mockClear(); published.mockClear();
      queries.invalidate(undefined, undefined, event);
      await queries.refresh(undefined, undefined, true);
      expect({ calls: read.mock.calls.length, publications: published.mock.calls.length }).toEqual({ calls: 0, publications: 0 });
    }
  } finally { unsubscribe(); queries.dispose(); }
});

it("keeps partial pages and an overlapping membership read conservative for off-page row discovery", async () => {
  for (const pins of [false, true]) {
    let threads = population(2);
    const replies: Array<() => void> = [];
    let gated = false;
    const read = vi.fn(async (request: NavigationQueryRequest) => {
      const page = navigationQueryFixture(request, { threads });
      if (gated) await new Promise<void>((resolve) => replies.push(resolve));
      return page;
    });
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(demand(2, true));
    try {
      await advance(); read.mockClear();
      queries.invalidate(undefined, undefined, pins ? summaryEvent(1) : prEvent(1));
      await queries.refresh(undefined, undefined, true);
      expect(read).toHaveBeenCalledTimes(4);
      // Finish the full baseline, then start a membership observation that
      // adds an unknown child. A later metadata event must fence that read.
      queries.setDemand(demand(2)); await advance();
      gated = true; read.mockClear();
      queries.invalidate(undefined, undefined, pins ? { backend: "codex", notification: {
        method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer" },
      } } : { backend: "codex", notification: {
        method: "thread/parent/set", params: { threadId: "new", parentThreadId: "parent-0" },
      } });
      const refresh = queries.refresh(undefined, undefined, true); await advance();
      threads = [...threads, { ...threads.find((row) => row.id === "child-0-0" && row.federation)!,
        id: "new", title: "Discovered", prs: [pr(2)], federation: { ...threads.find((row) => row.federation)!.federation!,
          ref: { backend: "codex", threadId: "new", target } } }];
      const change = pins ? { ...summaryEvent(0), notification: { method: "navigation/remoteThreadPins/changed",
        params: { instanceId: "peer", rowChanges: [{ backend: "codex", threadId: "new", ownerInstanceId: "peer" }] } } } as AgentEvent : prEvent(1);
      queries.invalidate(undefined, undefined, change);
      for (let i = 0; i < 10 && !idle(queries); i++) { replies.splice(0).forEach((reply) => reply()); await advance(); }
      await refresh; expect(idle(queries)).toBe(true);
      expect(queries.getSnapshot().resources.get("remote-0")?.state.page?.entries.some(({ row }) => row.id === "new")).toBe(true);
      expect([...queries.getSnapshot().resources.values()].every((r) => !r.state.stale)).toBe(true);
    } finally { queries.dispose(); replies.splice(0).forEach((reply) => reply()); }
  }
});

it("fences a PR status update behind an in-flight observation of a newly attached PR", async () => {
  // Model: attachment is owned by thread/pullRequests, status by the PR event.
  // The old complete child set proves identity, but says nothing about a PR
  // attached since that page. Test both ingress routes for the attachment.
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (summary, replyBeforeStatus) => {
    let threads = population(1);
    const replies: Array<() => void> = [];
    let gated = false;
    const read = vi.fn(async (request: NavigationQueryRequest) => {
      const page = navigationQueryFixture(request, { threads });
      if (gated) await new Promise<void>((resolve) => replies.push(resolve));
      return page;
    });
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(demand(1));
    try {
      await advance(); gated = true; read.mockClear();
      threads = threads.map((row) => row.federation && row.id === "child-0-0" ? { ...row, prs: [pr(2)] } : row);
      const attachment: AgentEvent = summary ? summaryEvent(0) : { backend: "codex", federationTarget: target,
        notification: { method: "thread/pullRequests/updated", params: { threadId: "child-0-0", prs: [pr(2)] } } };
      queries.invalidate(undefined, undefined, attachment);
      const pending = queries.refresh(undefined, undefined, true); await advance();
      if (replyBeforeStatus) { replies.splice(0).forEach((reply) => reply()); await pending; }
      threads = threads.map((row) => row.federation && row.id === "child-0-0" ? { ...row, prs: [{ ...pr(2), state: "failing" }] } : row);
      queries.invalidate(undefined, undefined, prEvent(1));
      const statusRefresh = queries.refresh(undefined, undefined, true);
      for (let i = 0; i < 10 && !idle(queries); i++) { replies.splice(0).forEach((reply) => reply()); await advance(); }
      await Promise.all([pending, statusRefresh]);
      expect(read).toHaveBeenCalledTimes(2);
      const row = queries.getSnapshot().resources.get("remote-0")?.state.page?.entries.find(({ row }) => row.id === "child-0-0")?.row;
      expect(row?.prs?.[0]?.state).toBe("failing");
    } finally { queries.dispose(); replies.splice(0).forEach((reply) => reply()); }
  }), { numRuns: 25, examples: [[false, false], [true, false]] });
});
