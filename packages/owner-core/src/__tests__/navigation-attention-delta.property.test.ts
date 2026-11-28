import fc from "fast-check";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationAttentionScope, NavigationQueryPage, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { expect, it, vi } from "vitest";
import { nextNavigationObservation } from "../navigation-observation-clock";
import { createNavigationQuerySnapshot, replaceNavigationQueryRows, type NavigationQueryIndex } from "../navigation-query-projection";
import { NavigationQueryStore } from "../navigation-query-store";

it("does not filter the inventory after eight status changes to a retained Attention page", async () => {
  const threads: NavigationThreadSummary[] = Array.from({ length: 100 }, (_, i) => ({
    id: `thread-${i}`, source: "codex", title: `Thread ${i}`, titleSource: "explicit", updatedAt: i + 1,
    linkedDirectories: [], threadStatus: "active", inbox: { inInbox: true },
  }));
  const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 3,
    attentionView: { id: "window", promoteOnTurnEnd: true }, query: { kind: "lens", lens: "attention", attention: "active" } };
  const store = new NavigationQueryStore();
  let index = createNavigationQuerySnapshot({ threads, directories: [], observedAt: nextNavigationObservation() });
  const read = () => store.readPage({ request, incremental: true, scopeKey: "test", loadIndex: async () => index });
  const first = await read();
  expect(first.nextCursor).toBeDefined();
  index = replaceNavigationQueryRows(index, new Map(threads.slice(0, 8).map((row, i) => [i, { ...row, threadStatus: "idle" }])),
    new Set(), nextNavigationObservation(), new Map());
  const original = Array.prototype.filter;
  let fullFilters = 0;
  const filter = vi.spyOn(Array.prototype, "filter").mockImplementation(function (this: unknown[], predicate, thisArg) {
    if (this === index.threads) fullFilters++;
    return original.call(this, predicate, thisArg);
  });
  try {
    expect((await read()).counts.active).toBe(92);
  } finally { filter.mockRestore(); }
  expect(fullFilters).toBe(0);
});

const viewRequest = (id: string, promoteOnTurnEnd: boolean, attention?: NavigationAttentionScope): NavigationQueryRequest => ({
  protocol: 2, consumer: "main-sidebar", inventory: "viewer", pageSize: 2, attentionView: { id, promoteOnTurnEnd },
  query: { kind: "lens", lens: "attention", ...(attention ? { attention } : {}) },
});

function activeEvent(threadId: string, active: boolean, owner?: string): AgentEvent {
  return { backend: "codex", ...(owner ? { federationTarget: { scope: "remote", instanceId: owner } } : {}),
    notification: { method: "thread/status/changed", params: { threadId, status: { type: active ? "active" : "idle" } } } };
}

function summary(id: string, updatedAt: number, active: boolean, unread: boolean): NavigationThreadSummary {
  return { id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [],
    updatedAt, threadStatus: active ? "active" : "idle", inbox: { inInbox: unread } };
}

const visible = (page: NavigationQueryPage) => ({
  entries: page.entries, counts: page.counts, coverage: page.coverage, complete: page.complete,
  directories: page.directories, directoryGitProof: page.directoryGitProof, rangeStart: page.rangeStart,
  cursor: Boolean(page.nextCursor),
});

it("keeps child placement on old cursors while a parent leaves the active scope", async () => {
  const parent = summary("parent", 1, true, true);
  const child = { ...summary("child", 2, true, true), parentThreadId: parent.id, parentThreadBackend: parent.source };
  const threads = [parent, child, summary("other", 3, true, true), summary("tail", 0, true, true)];
  let index = createNavigationQuerySnapshot({ threads, directories: [], coverage: { state: "complete" }, observedAt: nextNavigationObservation() });
  const store = new NavigationQueryStore();
  const request = viewRequest("window", true, "active");
  const read = (patch?: Partial<NavigationQueryRequest>) => store.readPage({
    incremental: true, request: { ...request, ...patch }, scopeKey: "viewer", loadIndex: async () => index,
  });
  const first = await read({ pageSize: 1 });
  expect(first.entries[0]?.row.id).toBe("other");
  index = replaceNavigationQueryRows(index, new Map([[0, { ...parent, threadStatus: "idle" }]]),
    new Set(), nextNavigationObservation(), new Map());
  const changed = await read({ pageSize: 1 });
  expect(changed.generation).not.toBe(first.generation);
  expect(changed.entries).toEqual(first.entries);
  expect((await read({ cursor: first.nextCursor, pageSize: 1 })).entries[0]?.placement)
    .toEqual({ kind: "child", parent: { backend: "codex", threadId: parent.id } });
  expect((await read({ cursor: changed.nextCursor, pageSize: 1 })).entries[0]?.placement).toEqual({ kind: "root" });
  expect((await read({ anchor: { kind: "thread", ref: { backend: "codex", threadId: child.id } } })).rangeStart).toBe(1);
  const ack = await read({ retainedRange: { ownerEpoch: changed.ownerEpoch, revision: changed.countsRevision, start: 0, count: 1 } });
  expect(ack.rangeUnchanged).toEqual({ start: 0, count: 1 });
});

const edit = fc.record({
  kind: fc.constantFrom("status", "silent", "seen", "duplicate", "stale", "gap", "lifetime", "remote", "skip"),
  slot: fc.integer({ min: 0, max: 5 }), value: fc.boolean(),
});

it("matches full owner reconciliation and projection through independent view lifetimes", async () => {
  await fc.assert(fc.asyncProperty(fc.array(edit, { minLength: 12, maxLength: 32, size: "max" }), async (ops) => {
    const actual = new NavigationQueryStore();
    const oracle = new NavigationQueryStore();
    let threads = Array.from({ length: 6 }, (_, i) => summary("thread-" + i, i, i % 2 === 0, true));
    threads[1] = { ...threads[1]!, parentThreadId: threads[0]!.id, parentThreadBackend: "codex" };
    threads[5] = { ...threads[5]!, federation: { ref: { backend: "codex", threadId: threads[5]!.id,
      target: { scope: "remote", instanceId: "peer" } }, instanceLabel: "Peer" } };
    let coverage: NavigationQueryIndex["coverage"] = { state: "complete" };
    let observedAt = nextNavigationObservation();
    let index = createNavigationQuerySnapshot({ threads, directories: [], coverage, observedAt });
    let reference = createNavigationQuerySnapshot({ threads, directories: [], coverage, observedAt });
    const history: { index: NavigationQueryIndex; reference: NavigationQueryIndex }[] = [];
    let windowNumber = 0;
    const emit = (event: AgentEvent) => {
      actual.observeAttentionEvent(event);
      oracle.observeAttentionEvent(event);
    };
    const check = async (request: NavigationQueryRequest, observation = { index, reference }) => {
      const read = (store: NavigationQueryStore, snapshot: NavigationQueryIndex, incremental: boolean, cursor?: string) =>
        store.readPage({ request: { ...request, cursor }, incremental, scopeKey: "viewer", loadIndex: async () => snapshot });
      let left = await read(actual, observation.index, true);
      let right = await read(oracle, observation.reference, false);
      while (true) {
        expect(visible(left)).toEqual(visible(right));
        if (!left.nextCursor) break;
        left = await read(actual, observation.index, true, left.nextCursor);
        right = await read(oracle, observation.reference, false, right.nextCursor);
      }
    };
    await check(viewRequest("always", true));
    for (const [step, { kind, slot, value }] of ops.entries()) {
      const old = threads[slot]!;
      const owner = old.federation?.ref.target.scope === "remote" ? old.federation.ref.target.instanceId : undefined;
      if (kind === "stale" && history.length) {
        await check(viewRequest("always", true), history[step % history.length]!);
        continue;
      }
      if (kind === "lifetime") {
        for (const store of [actual, oracle]) store.releaseAttentionView("viewer", "optional-" + windowNumber);
        windowNumber++;
      } else if (kind !== "skip") {
        const next = { ...old };
        if (kind === "status" || kind === "duplicate") {
          emit(activeEvent(old.id, value, owner));
          if (kind === "duplicate") emit(activeEvent(old.id, value, owner));
          next.threadStatus = value ? "active" : "idle";
        } else if (kind === "silent") {
          next.threadStatus = "idle";
          next.updatedAt = 20 + step;
        } else if (kind === "seen") {
          emit({ backend: "codex", notification: { method: "navigation/thread/seen", params: { threadId: old.id, seenUpdatedAt: old.updatedAt ?? 0 } } });
          next.inbox = { inInbox: false };
        } else if (kind === "remote") {
          emit(activeEvent(threads[5]!.id, value, "peer"));
          next.hasBackgroundTasks = value;
        } else if (kind === "gap") coverage = value ? { state: "complete" } : { state: "checking" };
        history.push({ index, reference });
        threads = threads.map((row, i) => i === slot ? next : row);
        observedAt = nextNavigationObservation();
        reference = createNavigationQuerySnapshot({ threads, directories: [], coverage, observedAt });
        index = kind === "gap" || kind === "remote" || owner ? reference
          : replaceNavigationQueryRows(index, new Map([[slot, next]]), new Set(), observedAt, new Map());
      }
      if (kind === "skip") continue;
      await check(viewRequest("always", true));
      if (step % 2 === 0) {
        const request = viewRequest("optional-" + windowNumber, false, "active");
        await check(request);
        await check(viewRequest("optional-" + windowNumber, false, "review"));
      }
    }
  }), { numRuns: Number(process.env.MBT_ATTENTION_DELTA_RUNS ?? 5) });
});

it("updates a complete active page without retaining cursor authority", async () => {
  const work = vi.fn();
  const threads = [summary("first", 1, true, true), summary("second", 2, false, true)];
  let index = createNavigationQuerySnapshot({ threads, directories: [], observedAt: nextNavigationObservation() });
  const store = new NavigationQueryStore({ onAttentionWork: work });
  const request = viewRequest("window", true, "active");
  const read = () => store.readPage({ request, incremental: true, scopeKey: "viewer", loadIndex: async () => index });
  expect((await read()).nextCursor).toBeUndefined();
  work.mockClear();
  index = replaceNavigationQueryRows(index, new Map([[1, { ...threads[1]!, threadStatus: "active" }]]),
    new Set(), nextNavigationObservation(), new Map());
  const page = await read();
  expect(page.nextCursor).toBeUndefined();
  expect(page.entries.map(({ row }) => row.id)).toEqual(["second", "first"]);
  expect(work.mock.calls).toEqual([["rank", 1], ["membership", 1]]);
});

it("preserves the rank of a missing peer member across incomplete listings and local status changes", async () => {
  const local = summary("local", 1, true, true);
  const peer: NavigationThreadSummary = { ...summary("peer", 2, true, true), federation: {
    ref: { backend: "codex", threadId: "peer", target: { scope: "remote", instanceId: "peer-owner" } }, instanceLabel: "Peer",
  } };
  const request = viewRequest("window", true);
  const store = new NavigationQueryStore();
  const oracle = new NavigationQueryStore();
  const snapshot = (threads: NavigationThreadSummary[], state: "complete" | "checking") =>
    createNavigationQuerySnapshot({ threads, directories: [], coverage: { state }, observedAt: nextNavigationObservation() });
  let index = snapshot([local, peer], "complete");
  let reference = index;
  const read = (store: NavigationQueryStore, index: NavigationQueryIndex, incremental: boolean) =>
    store.readPage({ request, incremental, scopeKey: "viewer", loadIndex: async () => index });
  const compare = async () => {
    const page = await read(store, index, true);
    expect(visible(page)).toEqual(visible(await read(oracle, reference, false)));
    return page;
  };
  await compare();
  index = reference = snapshot([local], "checking");
  await compare();
  const idle = { ...local, threadStatus: "idle" } as const;
  index = replaceNavigationQueryRows(index, new Map([[0, idle]]), new Set(), nextNavigationObservation(), new Map());
  reference = createNavigationQuerySnapshot({ ...index, threads: [idle] });
  await compare();
  for (const target of [store, oracle]) target.observeAttentionEvent(activeEvent("peer", false, "peer-owner"));
  index = reference = snapshot([idle, { ...peer, threadStatus: "idle" }], "complete");
  expect((await compare()).entries.map(({ row }) => row.id)).toEqual(["peer", "local"]);
});

it("retains the first attachment observation per cursor after a sparse Attention edit", async () => {
  const pr = (number: number) => ({ provider: "github.com", org: "fixture", repo: "project", number,
    url: "https://github.com/fixture/project/pull/" + number, state: "passing" as const, lifecycleState: "open" as const });
  const threads = [summary("first", 4, true, true), { ...summary("with-pr", 3, true, true), prs: [pr(1)] },
    summary("affected", 2, true, true), summary("tail", 1, true, true)];
  let index = createNavigationQuerySnapshot({ threads, directories: [], observedAt: nextNavigationObservation() });
  let attachment = 1;
  const store = new NavigationQueryStore();
  const request = viewRequest("window", true, "active");
  const read = (cursor?: string) => store.readPage({
    incremental: true, request: { ...request, pageSize: 1, cursor }, scopeKey: "viewer", loadIndex: async () => index,
    pullRequests: { read: async (refs) => refs.map(() => [pr(attachment)]), verify: async () => [] },
  });
  const first = await read();
  expect((await read(first.nextCursor)).entries[0]?.row.prs?.[0]?.number).toBe(1);
  index = replaceNavigationQueryRows(index, new Map([[2, { ...threads[2]!, threadStatus: "idle" }]]),
    new Set(), nextNavigationObservation(), new Map());
  attachment = 2;
  const changed = await read();
  expect((await read(changed.nextCursor)).entries[0]?.row.prs?.[0]?.number).toBe(2);
  expect((await read(first.nextCursor)).entries[0]?.row.prs?.[0]?.number).toBe(1);
});
