import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { cleanup, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as identities from "../federated-thread-events";
import { useRecentRemoteThreads } from "../useRecentRemoteThreads";

const identityKey = identities.threadSummaryIdentityKey;
type Inputs = { selectedThread?: NavigationThreadSummary; threads: NavigationThreadSummary[] };

function remoteThread(index: number): NavigationThreadSummary {
  return {
    id: `budget-id-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1,
    federation: {
      ref: { backend: "codex", threadId: `budget-id-${index}`, target: { scope: "remote", instanceId: "owner" } },
      instanceLabel: "Owner", peerStatus: "connected",
      capabilities: ["event_subscriptions", "thread_detail", "thread_navigation", "pending_request_control"],
    },
  };
}

function warmFive(threads: NavigationThreadSummary[]) {
  const view = renderHook((inputs: Inputs) => useRecentRemoteThreads(inputs), {
    initialProps: { selectedThread: threads[0], threads },
  });
  for (const selectedThread of threads.slice(1, 5)) view.rerender({ selectedThread, threads });
  return view;
}

function operationBudget() {
  let keys = 0;
  let indexWrites = 0;
  vi.spyOn(identities, "threadSummaryIdentityKey").mockImplementation((thread) => {
    keys++;
    return identityKey(thread);
  });
  const set = Map.prototype.set;
  vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
    if (typeof key === "string" && key.includes("budget-id-")) indexWrites++;
    return set.call(this, key, value);
  });
  return {
    read: () => ({ keys, indexWrites }),
    reset: () => { keys = 0; indexWrites = 0; },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("recent remote thread index", () => {
  it("does not rebuild stable identity projections for generated metadata updates", () => {
    fc.assert(fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 20 }), (updates) => {
      let threads = Array.from({ length: 16 }, (_, index) => remoteThread(index));
      const view = warmFive(threads);
      const budget = operationBudget();
      try {
        for (const updatedAt of updates) {
          threads = threads.map((thread) => ({ ...thread, updatedAt, title: `Updated ${updatedAt}` }));
          view.rerender({ selectedThread: threads[4], threads });
          expect(budget.read().indexWrites).toBe(0);
          expect(budget.read().keys).toBeLessThanOrEqual(22);
          expect(view.result.current[0]).toBe(threads[4]);
          budget.reset();
        }
      } finally {
        view.unmount();
        vi.restoreAllMocks();
      }
    }), { numRuns: 25 });
  });

  for (const count of [32, 64]) {
    it(`budgets one and twenty unchanged actions with ${count} loaded rows`, () => {
      let threads = Array.from({ length: count }, (_, index) => remoteThread(index));
      const view = warmFive(threads);
      const budget = operationBudget();
      for (let action = 0; action < 20; action++) {
        threads = threads.map((thread) => ({ ...thread, updatedAt: action, federation: {
          ...thread.federation!, ref: { ...thread.federation!.ref, target: { ...thread.federation!.ref.target } },
        } }));
        view.rerender({ selectedThread: threads[4], threads });
        expect(budget.read().indexWrites).toBe(0);
        expect(budget.read().keys).toBeLessThanOrEqual(22);
        expect(view.result.current.map((thread) => thread.updatedAt)).toEqual([action, action, action, action, action]);
        budget.reset();
      }
    });

    it(`rebuilds once for one relevant action at the end of ${count} loaded rows`, () => {
      const threads = Array.from({ length: count }, (_, index) => remoteThread(index));
      const view = warmFive(threads);
      const budget = operationBudget();
      threads[count - 1]!.federation!.ref.target = { scope: "remote", instanceId: "new-owner" };
      view.rerender({ selectedThread: threads[4], threads });
      expect(budget.read().indexWrites).toBe(count);
      expect(budget.read().keys).toBeLessThanOrEqual(count + 22);
      budget.reset();
      view.rerender({ selectedThread: threads[4], threads });
      expect(budget.read().indexWrites).toBe(0);
      expect(budget.read().keys).toBeLessThanOrEqual(22);
    });
  }

  it("skips the inventory when there are no retained interests", () => {
    const threads = Array.from({ length: 64 }, (_, index) => remoteThread(index));
    const budget = operationBudget();
    const view = renderHook(() => useRecentRemoteThreads({ threads }));
    expect(view.result.current).toEqual([]);
    expect(budget.read()).toEqual({ keys: 0, indexWrites: 0 });
  });

  it("keeps the shrunk single updatedAt=0 action within the stable-index budget", () => {
    const threads = Array.from({ length: 16 }, (_, index) => remoteThread(index));
    const view = warmFive(threads);
    const budget = operationBudget();
    view.rerender({ selectedThread: threads[4], threads: threads.map((thread) => ({ ...thread, updatedAt: 0 })) });
    expect(budget.read().indexWrites).toBe(0);
    expect(budget.read().keys).toBeLessThanOrEqual(22);
  });

  it("keeps last-duplicate precedence, selected overrides, and ordered rechecks", () => {
    const a = remoteThread(0);
    const b = remoteThread(1);
    const first = { ...a, title: "First" };
    const last = { ...a, title: "Last" };
    const view = renderHook((inputs: Inputs) => useRecentRemoteThreads(inputs), {
      initialProps: { selectedThread: a, threads: [first, last, b] },
    });
    view.rerender({ selectedThread: b, threads: [first, last, b] });
    expect(view.result.current[1]).toBe(last);
    view.rerender({ selectedThread: b, threads: [last, first, b] });
    expect(view.result.current[1]).toBe(first);
    view.rerender({ selectedThread: b, threads: [b, last, first] });
    expect(view.result.current[1]).toBe(first);
    view.rerender({ selectedThread: { ...a, title: "Selected" }, threads: [last, first, b] });
    expect(view.result.current[0]!.title).toBe("Selected");
  });

  it("publishes fresh capability revocations without rebuilding the identity index", () => {
    const threads = Array.from({ length: 16 }, (_, index) => remoteThread(index));
    const view = warmFive(threads);
    const budget = operationBudget();
    const revoked = { ...threads[0]!, federation: { ...threads[0]!.federation!, capabilities: [] } };
    view.rerender({ selectedThread: threads[4], threads: [revoked, ...threads.slice(1)] });
    expect(view.result.current.map((thread) => thread.id)).toEqual([4, 3, 2, 1].map((id) => `budget-id-${id}`));
    expect(budget.read().indexWrites).toBe(0);
    view.rerender({ selectedThread: threads[4], threads });
    // Regranting a background row cannot restore a forgotten selection.
    expect(view.result.current.map((thread) => thread.id)).toEqual([4, 3, 2, 1].map((id) => `budget-id-${id}`));
    view.rerender({ selectedThread: threads[0], threads });
    expect(view.result.current.map((thread) => thread.id)).toEqual([0, 4, 3, 2, 1].map((id) => `budget-id-${id}`));
  });

  it("matches a bounded selection-history oracle through generated owner transitions", () => {
    const operation = fc.record({
      kind: fc.constantFrom("select", "local", "page", "duplicate", "reverse", "metadata", "capability", "peer", "owner", "backend", "threadId", "localRef"),
      index: fc.integer({ min: 0, max: 7 }),
    });
    fc.assert(fc.property(fc.array(operation, { minLength: 30, maxLength: 40, size: "max" }), (operations) => {
      const catalog = Array.from({ length: 8 }, (_, index) => {
        const thread = remoteThread(index);
        thread.id = `shared-${index % 2}`;
        thread.source = index % 4 < 2 ? "codex" : "acp:fixture";
        thread.federation!.ref = { backend: thread.source, threadId: thread.id,
          target: { scope: "remote", instanceId: `owner-${Math.floor(index / 4)}` } };
        return thread;
      });
      let threads = [...catalog];
      let selectedThread: NavigationThreadSummary | undefined = catalog[0];
      let history: NavigationThreadSummary[] = [];
      const supported = (row: NavigationThreadSummary) => row.federation?.ref.target.scope === "remote"
        && row.federation.capabilities?.includes("event_subscriptions")
        && row.federation.capabilities.includes("thread_detail");
      const oracle = () => {
        // Only a changed selection history is committed; page omission keeps its saved row.
        for (let pass = 0; pass < 3; pass++) {
          let output = history.map((saved) => {
            const key = identityKey(saved);
            if (selectedThread && identityKey(selectedThread) === key) return selectedThread;
            return [...threads].reverse().find((row) => identityKey(row) === key) ?? saved;
          }).filter(supported);
          if (selectedThread && supported(selectedThread)) {
            output = [selectedThread, ...output.filter((row) => identityKey(row) !== identityKey(selectedThread!))].slice(0, 5);
          }
          if (output.length === history.length && output.every((row, index) => identityKey(row) === identityKey(history[index]!))) return output;
          history = output;
        }
        throw new Error("Selection history did not settle");
      };
      const view = renderHook((inputs: Inputs) => useRecentRemoteThreads(inputs), { initialProps: { selectedThread, threads } });
      try {
        expect(view.result.current).toEqual(oracle());
        // Always cross the five-selection bound before generated transitions.
        for (const row of catalog.slice(1)) {
          selectedThread = row;
          view.rerender({ selectedThread, threads });
          expect(view.result.current).toEqual(oracle());
        }
        for (const op of operations) {
          const row = catalog[op.index]!;
          if (op.kind === "select") selectedThread = row;
          if (op.kind === "local") selectedThread = { ...row, federation: undefined };
          if (op.kind === "page") threads = catalog.filter((_, index) => index % 2 === op.index % 2);
          if (op.kind === "duplicate") threads = [...threads, { ...row, title: `Duplicate ${op.index}` }];
          if (op.kind === "reverse") threads.reverse();
          if (op.kind === "metadata") row.title = `Updated ${op.index}`;
          if (op.kind === "capability") {
            const capabilities = row.federation!.capabilities!;
            if (capabilities.includes("thread_detail")) capabilities.splice(capabilities.indexOf("thread_detail"), 1);
            else capabilities.push("thread_detail");
          }
          if (op.kind === "peer") row.federation!.peerStatus = row.federation!.peerStatus === "connected" ? "disconnected" : "connected";
          if (op.kind === "owner") row.federation!.ref.target = { scope: "remote", instanceId: `moved-${op.index}` };
          if (op.kind === "backend") row.federation!.ref.backend = row.federation!.ref.backend === "codex" ? "acp:fixture" : "codex";
          if (op.kind === "threadId") row.federation!.ref.threadId = row.federation!.ref.threadId === row.id ? `ref-${op.index}` : row.id;
          if (op.kind === "localRef") row.federation!.ref.target = row.federation!.ref.target.scope === "remote"
            ? { scope: "local" } : { scope: "remote", instanceId: `owner-${Math.floor(op.index / 4)}` };
          view.rerender({ selectedThread, threads });
          expect(view.result.current).toEqual(oracle());
          expect(view.result.current.length).toBeLessThanOrEqual(5);
        }
      } finally {
        view.unmount();
      }
    }), { numRuns: 25 });
  });
});
