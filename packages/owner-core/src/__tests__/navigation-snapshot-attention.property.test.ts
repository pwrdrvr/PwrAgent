import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { createNavigationQuerySnapshot, type NavigationQueryIndex } from "../navigation-query-projection";
import { NavigationQueryStore } from "../navigation-query-store";
import { nextNavigationObservation } from "../navigation-observation-clock";

const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
  attentionView: { id: "window", promoteOnTurnEnd: true },
  query: { kind: "exact", identities: [{ backend: "codex", threadId: "thread-0" }] } };
const rows = (n: number): NavigationThreadSummary[] => Array.from({ length: n }, (_, i) => ({
  source: "codex", id: `thread-${i}`, title: `Thread ${i}`, titleSource: "explicit", linkedDirectories: [],
  inbox: { inInbox: true }, threadStatus: "idle", updatedAt: i + 1,
}));

async function assertAttentionBudget(n: number, q: number) {
  for (const size of [n, 2 * n]) {
    const snapshot = createNavigationQuerySnapshot({ threads: rows(size), directories: [], observedAt: nextNavigationObservation() });
    const original = Array.prototype.filter;
    let fullFilters = 0;
    const filter = vi.spyOn(Array.prototype, "filter").mockImplementation(function (this: unknown[], predicate, thisArg) {
      if (this === snapshot.threads) fullFilters++;
      return original.call(this, predicate, thisArg);
    });
    const store = new NavigationQueryStore();
    try {
      for (let i = 0; i < q; i++) await store.readPage({ scopeKey: "viewer", request: { ...request,
        query: { kind: "exact", identities: [{ backend: "codex", threadId: `thread-${i}` }] } }, loadIndex: async () => snapshot });
    } finally { filter.mockRestore(); }
    // Each query still selects its ordinary rows; only the one Attention
    // reconciliation may filter the complete inventory in addition.
    expect(fullFilters).toBe(q + 1);
  }
}

it("reconciles Attention once per certified observation for Q queries at N and 2N", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 20, max: 60 }), fc.integer({ min: 4, max: 12 }),
    assertAttentionBudget), { numRuns: 25 });
});

it("four queries reconcile twenty Attention rows only once", async () => {
  await assertAttentionBudget(20, 4);
});

// An uncached store is the oracle through valid provider histories. Replays
// of the same immutable observation, owner changes, stale reads, and policy
// changes must preserve exactly the same Attention ranks and membership.
it("matches uncached Attention through events, stable replays and owner transitions", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("start", "finish", "seen", "read", "replay", "stale", "owner", "policy"),
    { minLength: 15, maxLength: 35, size: "max" }), async (operations) => {
    const cachedOvertaken = vi.fn();
    const oracleOvertaken = vi.fn();
    const cached = new NavigationQueryStore({ onOvertakenRead: cachedOvertaken });
    const oracle = new NavigationQueryStore({ onOvertakenRead: oracleOvertaken });
    let threads = rows(4);
    let owner = false;
    let promote = true;
    let observation = nextNavigationObservation();
    let raw: NavigationQueryIndex = { threads, directories: [], observedAt: observation, localInstanceId: "viewer" };
    let snapshot = createNavigationQuerySnapshot(raw);
    let active = false;
    let unread = true;
    let turn = 0;
    const history: Array<{ raw: NavigationQueryIndex; snapshot: NavigationQueryIndex }> = [];
    const read = async () => {
      const sent: NavigationQueryRequest = { ...request, attentionView: { id: "window", promoteOnTurnEnd: promote },
        query: { kind: "lens", lens: "attention" } };
      const a = await cached.readPage({ request: sent, scopeKey: "viewer", loadIndex: async () => snapshot });
      const b = await oracle.readPage({ request: sent, scopeKey: "viewer", loadIndex: async () => raw });
      expect(a.entries).toEqual(b.entries);
      expect(a.counts).toEqual(b.counts);
      expect(cachedOvertaken).toHaveBeenCalledTimes(oracleOvertaken.mock.calls.length);
    };
    await read();
    for (const [step, op] of operations.entries()) {
      if (op === "policy") promote = !promote;
      if ((op === "start" && !active) || (op === "finish" && active) || op === "seen") {
        if (op !== "seen") active = op === "start";
        if (op === "start") turn++;
        if (op === "finish") unread = true;
        if (op === "seen") unread = false;
        const event: AgentEvent = { backend: "codex", ...(owner ? { federationTarget: { scope: "remote", instanceId: "peer" } as const } : {}),
          notification: op === "seen" ? { method: "navigation/thread/seen", params: { threadId: "thread-0", seenUpdatedAt: 100 } }
            : active ? { method: "turn/started", params: { threadId: "thread-0", requestId: "request", turn: { id: `turn-${turn}` } } }
            : { method: "turn/completed", params: { threadId: "thread-0", turnId: `turn-${turn}`,
              turn: { id: `turn-${turn}`, status: "completed", output: [] } } } };
        cached.observeAttentionEvent(event); oracle.observeAttentionEvent(event);
      }
      if (op === "stale" && history.length) {
        const previous = history[step % history.length]!;
        raw = previous.raw; snapshot = previous.snapshot;
      }
      if (op === "owner" || op === "read") {
        history.push({ raw, snapshot });
        if (op === "owner") owner = !owner;
        observation = nextNavigationObservation();
        threads = threads.map((thread, i) => ({ ...thread, threadStatus: i === 0 && active ? "active" : "idle",
          inbox: { inInbox: i === 0 ? unread : true }, federation: owner ? { ref: { backend: "codex", threadId: thread.id,
            target: { scope: "remote", instanceId: "peer" } }, instanceLabel: "Peer" } : undefined }));
        raw = { threads, directories: [], observedAt: observation, localInstanceId: "viewer" };
        snapshot = createNavigationQuerySnapshot(raw);
      }
      await read();
    }
    cached.releaseAttentionView("viewer", "window");
    await expect(cached.readPage({ request, scopeKey: "viewer", loadIndex: async () => snapshot })).rejects.toThrow("closed");
  }), { numRuns: 25 });
});
