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
  return { protocol: 2, queryKey: JSON.stringify(sent.query), ownerEpoch: "owner", generation: String(active),
    countsRevision: String(active), coverage: { state: "complete" }, counts: { total: 200, active, unread: 0, review: 0 },
    // No loaded row or linked path can establish where the hidden descendant belongs.
    entries: [], complete: false, nextCursor: `cursor-${active}` };
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
    queries.setDemand(new Map(counts.map((_, i) => [String(i), request(i)])));
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
