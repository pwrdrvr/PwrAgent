import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AgentEvent, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { NavigationWindowQueries } from "../navigation-window-queries";

const request = (i: number): NavigationQueryRequest => ({ protocol: 2, consumer: "main-sidebar",
  query: { kind: "directory", directoryKey: `project-${i}` }, pageSize: 1 });
const event = (keys: string[], method = "thread/backgroundTasks/updated", remote?: string): AgentEvent => ({ backend: "codex",
  ...(remote ? { federationTarget: { scope: "remote", instanceId: remote } } : {}),
  navigationDirectoryScope: { version: 1, directoryKeys: keys },
  notification: { method, params: { threadId: "hidden-descendant" } },
} as AgentEvent);
function page(sent: NavigationQueryRequest, active: number): NavigationQueryPage {
  const ref = { backend: "codex" as const, threadId: `visible-${sent.query.kind === "directory" ? sent.query.directoryKey : "root"}`,
    ...(sent.federationTarget?.scope === "remote" ? { ownerInstanceId: sent.federationTarget.instanceId } : {}) };
  return { protocol: 2, queryKey: JSON.stringify(sent.query), ownerEpoch: "owner", generation: String(active),
    countsRevision: String(active), coverage: { state: "complete" }, counts: { total: 200, active, unread: 0, review: 0 },
    // No loaded row or linked path can establish where the hidden descendant belongs.
    entries: [{ orderKey: "0", placement: { kind: "root" }, row: { ref, id: ref.threadId, source: ref.backend,
      title: "Visible root", titleSource: "explicit", rowRevision: "stable", inbox: { inInbox: false }, linkedDirectories: [],
      ordinaryChildCount: 10, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
    } }], complete: false, nextCursor: `cursor-${active}` };
}
const idle = (queries: NavigationWindowQueries) => [...queries.getSnapshot().resources.values()].every((r) => !r.loading);
async function advance() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

it("only reads owner-named directory pages while hidden descendant counts follow the complete population", async () => {
  // Model: each off-page descendant belongs to one or more owner directories.
  // Reorder events, timers and replies; a clean page must match that population,
  // and an unaffected page must keep its exact object and cursor with zero reads.
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ group: fc.integer({ min: 0, max: 7 }),
    second: fc.boolean(), reply: fc.boolean() }), { minLength: 1, maxLength: 12 }), async (ops) => {
    const counts = Array.from({ length: 8 }, () => 0);
    const replies: Array<() => void> = [];
    let gated = false;
    const read = vi.fn(async (sent: NavigationQueryRequest) => {
      const group = Number(sent.query.kind === "directory" && sent.query.directoryKey.slice(8));
      const response = page(sent, counts[group]!);
      if (gated) await new Promise<void>((resolve) => replies.push(resolve));
      return response;
    });
    const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
    queries.setDemand(new Map(counts.map((_, i) => [String(i), { ...request(i), ...(i % 2 ? { backend: "all" as const } : {}) }])));
    const check = () => {
      for (const [id, r] of queries.getSnapshot().resources) {
        if (!r.state.stale) expect(r.state.page?.counts.active).toBe(counts[Number(id)]);
      }
    };
    try {
      await advance(); expect(idle(queries)).toBe(true);
      gated = true;
      for (const op of ops) {
        const affected = new Set([op.group, ...(op.second ? [(op.group + 1) % 8] : [])]);
        const previous = new Map([...queries.getSnapshot().resources].map(([id, r]) => [id, r.state.page]));
        const start = read.mock.calls.length;
        for (const i of affected) counts[i]! += 1;
        queries.invalidate(undefined, undefined, event([...affected].map((i) => `project-${i}`)));
        void queries.refresh(undefined, undefined, true);
        await advance();
        for (const [id, r] of queries.getSnapshot().resources) {
          if (!affected.has(Number(id)) && !r.loading) expect(r.state.page).toBe(previous.get(id));
        }
        // Previously pending affected reads may finish later. At dispatch,
        // every new observation must belong to this event or an earlier fence.
        for (const [sent] of read.mock.calls.slice(start)) {
          expect(sent.query.kind === "directory" && affected.has(Number(sent.query.directoryKey.slice(8)))).toBe(true);
        }
        if (op.reply) { replies.splice(0).forEach((reply) => reply()); await advance(); }
        check();
      }
      for (let i = 0; i < 40 && !idle(queries); i++) { replies.splice(0).forEach((reply) => reply()); await advance(); }
      expect(idle(queries)).toBe(true); check();
      expect([...queries.getSnapshot().resources.values()].every((r) => !r.state.stale)).toBe(true);
    } finally { queries.dispose(); replies.splice(0).forEach((reply) => reply()); }
  }), { numRuns: 25 });
});

it("keeps unknown peers, membership transitions and viewer placements conservative", async () => {
  const read = vi.fn(async (sent: NavigationQueryRequest) => page(sent, 0));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  queries.setDemand(new Map([["a", request(0)], ["b", request(1)]]));
  try {
    await advance();
    for (const change of [
      { ...event([]), navigationDirectoryScope: undefined },
      { ...event([]), navigationDirectoryScope: { version: 2, directoryKeys: [] } },
      { ...event([]), navigationDirectoryScope: { version: 1, directoryKeys: Array.from({ length: 101 }, () => "x") } },
      { ...event([]), navigationDirectoryScope: { version: 1, directoryKeys: [null] } },
      event([], "thread/parent/set"),
      event([], "navigation/threadDirectories/updated"),
      event([], "new/future/membership"),
      event([], "thread/backgroundTasks/updated", "peer"),
    ] as AgentEvent[]) {
      read.mockClear();
      queries.invalidate(undefined, undefined, change);
      await queries.refresh(undefined, undefined, true);
      expect(read).toHaveBeenCalledTimes(2);
    }
    // An unscoped membership read may discover a previously absent member.
    // Even an empty row scope cannot exempt either pending page from its fence.
    let finish!: () => void;
    read.mockImplementationOnce(async (sent) => { await new Promise<void>((resolve) => { finish = resolve; }); return page(sent, 0); });
    queries.invalidate(undefined, undefined, event([], "thread/started"));
    const pending = queries.refresh(undefined, undefined, true);
    await advance();
    read.mockClear();
    queries.invalidate(undefined, undefined, event([]));
    finish(); await pending;
    expect(read.mock.calls.some(([sent]) => sent.query.kind === "directory" && sent.query.directoryKey === "project-0")).toBe(true);
  } finally { queries.dispose(); }
});

it("keeps remote scope owner-local and preserves an unrelated pending page and its cursor", async () => {
  const releases: string[] = [];
  let finish!: (value: NavigationQueryPage) => void;
  const read = vi.fn(async (sent: NavigationQueryRequest) => page(sent, 0));
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read,
    releaseNavigationQuery: async (token) => { releases.push(token); } });
  const remote = (i: number, owner: string) => ({ ...request(i), inventory: "owner" as const,
    federationTarget: { scope: "remote" as const, instanceId: owner } });
  queries.setDemand(new Map([["a0", remote(0, "a")], ["a1", remote(1, "a")], ["b0", remote(0, "b")]]));
  try {
    await advance();
    const baseline = queries.getSnapshot().resources.get("a1")!.state.page;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    queries.invalidate("a1", undefined, event(["project-1"], "thread/backgroundTasks/updated", "a"));
    const pending = queries.refresh("a1", undefined, true);
    await advance(); read.mockClear();
    queries.invalidate(undefined, [{ scope: "remote", instanceId: "a" }], event(["project-0"], "thread/backgroundTasks/updated", "a"));
    await queries.refresh(undefined, [{ scope: "remote", instanceId: "a" }], true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toMatchObject({ federationTarget: { instanceId: "a" }, query: { directoryKey: "project-0" } });
    finish({ ...baseline!, countsRevision: "fresh" }); await pending;
    expect(read).toHaveBeenCalledTimes(1);
    expect(queries.getSnapshot().resources.get("a1")!.state.page).toMatchObject({ countsRevision: "fresh", nextCursor: baseline!.nextCursor });
    // Disposal releases the same transport tokens without another page read.
    queries.dispose(); expect(releases).toHaveLength(3);
  } finally { queries.dispose(); }
});
