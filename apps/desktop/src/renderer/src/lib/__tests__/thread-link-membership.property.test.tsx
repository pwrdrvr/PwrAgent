import type { NavigationThreadSummary } from "@pwragent/shared";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider, useThreadLinks, type ThreadLinkContextValue } from "../thread-links";

const noop = () => {};

function thread(index: number): NavigationThreadSummary {
  return {
    id: `member-id-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1,
    federation: {
      ref: { backend: "codex", threadId: `member-id-${index}`, target: { scope: "remote", instanceId: "peer" } },
      instanceLabel: "Peer", capabilities: ["thread_navigation", "thread_detail", "event_subscriptions"],
    },
  };
}

/** Count actual canonical membership materialization, excluding metadata work. */
function operationBudget() {
  let sorts = 0;
  let sortedKeys = 0;
  let joins = 0;
  let joinedKeys = 0;
  const sort = Array.prototype.sort;
  const join = Array.prototype.join;
  const isMembership = (items: unknown[]) => items.length > 0
    && items.every((item) => typeof item === "string" && item.includes("member-id-"));
  vi.spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare) {
    if (isMembership(this)) { sorts++; sortedKeys += this.length; }
    return sort.call(this, compare);
  });
  vi.spyOn(Array.prototype, "join").mockImplementation(function (this: unknown[], separator) {
    if (separator === "\u0000" && isMembership(this)) { joins++; joinedKeys += this.length; }
    return join.call(this, separator);
  });
  return {
    read: () => ({ sorts, sortedKeys, joins, joinedKeys }),
    reset: () => { sorts = 0; sortedKeys = 0; joins = 0; joinedKeys = 0; },
  };
}

function mount(initial: NavigationThreadSummary[]) {
  let links: ThreadLinkContextValue;
  function Reader() { links = useThreadLinks()!; return null; }
  const children = <Reader />;
  const view = render(<ThreadLinkProvider threads={initial} onShowThread={noop}>{children}</ThreadLinkProvider>);
  return {
    read: () => links!,
    update: (threads: NavigationThreadSummary[]) => view.rerender(
      <ThreadLinkProvider threads={threads} onShowThread={noop}>{children}</ThreadLinkProvider>,
    ),
    unmount: () => view.unmount(),
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("thread-link membership projection", () => {
  it("does not reconstruct membership for generated metadata-only actions", () => {
    fc.assert(fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 20 }), (updates) => {
      let threads = [thread(0), thread(1)];
      const view = mount(threads);
      const context = view.read();
      const budget = operationBudget();
      try {
        for (const updatedAt of updates) {
          threads = threads.map((row) => ({ ...row, updatedAt, title: `Title ${updatedAt}`, gitBranch: `branch-${updatedAt}` }));
          view.update(threads);
          expect(budget.read()).toEqual({ sorts: 0, sortedKeys: 0, joins: 0, joinedKeys: 0 });
          expect(view.read()).toBe(context);
          expect(context.resolve({ backend: "codex", instanceId: "peer", threadId: threads[0]!.id })?.title).toBe(`Title ${updatedAt}`);
        }
      } finally { view.unmount(); vi.restoreAllMocks(); }
    }), { numRuns: 25 });
  });

  for (const count of [32, 64]) {
    it(`budgets one and twenty unchanged membership actions over ${count} rows`, () => {
      let threads = Array.from({ length: count }, (_, index) => thread(index));
      const view = mount(threads);
      const budget = operationBudget();
      for (let action = 0; action < 20; action++) {
        threads = threads.map((row) => ({ ...row, updatedAt: action, federation: {
          ...row.federation!, ref: { ...row.federation!.ref, target: { ...row.federation!.ref.target } },
        } }));
        view.update(threads);
        expect(budget.read()).toEqual({ sorts: 0, sortedKeys: 0, joins: 0, joinedKeys: 0 });
      }
    });

    it(`publishes one in-place identity change once over ${count} rows`, () => {
      const threads = Array.from({ length: count }, (_, index) => thread(index));
      const view = mount(threads);
      const previous = view.read();
      const budget = operationBudget();
      threads[count - 1]!.id = "member-id-new";
      view.update(threads);
      expect(budget.read()).toEqual({ sorts: 1, sortedKeys: count, joins: 1, joinedKeys: count });
      expect(view.read()).not.toBe(previous);
      expect(view.read().resolve({ backend: "codex", instanceId: "peer", threadId: "member-id-new" })?.title).toBe(`Thread ${count - 1}`);
      budget.reset();
      view.update(threads.map((row) => ({ ...row })));
      expect(budget.read()).toEqual({ sorts: 0, sortedKeys: 0, joins: 0, joinedKeys: 0 });
    });
  }

  it("keeps the shrunk single updatedAt action free of membership reconstruction", () => {
    const view = mount([thread(0), thread(1)]);
    const budget = operationBudget();
    view.update([thread(0), thread(1)].map((row) => ({ ...row, updatedAt: 0 })));
    expect(budget.read()).toEqual({ sorts: 0, sortedKeys: 0, joins: 0, joinedKeys: 0 });
  });

  it("rechecks ordered inputs and keeps last-duplicate metadata current", () => {
    const first = thread(0);
    const last = { ...first, title: "Last duplicate" };
    let threads = [first, last, thread(1)];
    const view = mount(threads);
    const context = view.read();
    const budget = operationBudget();
    threads = [threads[2]!, last, first];
    view.update(threads);
    // The canonical signature remains order-independent; changed input order
    // must still be checked, and metadata keeps its ordered duplicate rule.
    expect(budget.read()).toEqual({ sorts: 1, sortedKeys: 3, joins: 1, joinedKeys: 3 });
    expect(view.read()).toBe(context);
    expect(context.resolve({ backend: "codex", instanceId: "peer", threadId: first.id })?.title).toBe(first.title);
    budget.reset();
    view.update(threads.map((row) => ({ ...row })));
    expect(budget.read()).toEqual({ sorts: 0, sortedKeys: 0, joins: 0, joinedKeys: 0 });
    view.update([threads[0]!, first, last]);
    expect(budget.read()).toEqual({ sorts: 0, sortedKeys: 0, joins: 0, joinedKeys: 0 });
    expect(context.resolve({ backend: "codex", instanceId: "peer", threadId: first.id })?.title).toBe(last.title);
  });

  it("matches owner rows through generated membership, ordering and metadata transitions", () => {
    const operation = fc.record({
      kind: fc.constantFrom("metadata", "owner", "backend", "id", "reverse", "omit", "append", "duplicate", "ref"),
      index: fc.nat({ max: 7 }),
    });
    fc.assert(fc.property(fc.array(operation, { minLength: 25, maxLength: 35, size: "max" }), (operations) => {
      let threads = [thread(0), thread(1), thread(2), thread(3)];
      threads[1]!.source = "acp:fixture";
      threads[2]!.federation!.ref.target = { scope: "remote", instanceId: "other-peer" };
      threads[3]!.federation = undefined;
      const view = mount(threads);
      try {
        for (const [step, op] of operations.entries()) {
          const row = threads[op.index % threads.length]!;
          if (op.kind === "metadata") { row.title = `Title ${step}`; row.gitBranch = `branch-${step}`; }
          if (op.kind === "owner") row.federation = row.federation ? undefined : thread(0).federation;
          if (op.kind === "backend") row.source = row.source === "codex" ? "acp:fixture" : "codex";
          if (op.kind === "id") row.id = `member-id-${op.index}`;
          if (op.kind === "reverse") threads.reverse();
          if (op.kind === "omit" && threads.length > 1) threads.splice(op.index % threads.length, 1);
          if (op.kind === "append" && threads.length < 8) threads.push(thread(step));
          if (op.kind === "duplicate" && threads.length < 8) threads.push({ ...row, title: `Duplicate ${step}` });
          // Link membership follows summary source/id and remote owner, rather
          // than transcript subscription refs' backend/threadId fields.
          if (op.kind === "ref" && row.federation) row.federation.ref = { ...row.federation.ref, backend: "claude", threadId: `ref-${step}` };
          view.update(threads);
          for (const query of threads) {
            const owner = query.federation?.ref.target;
            const instanceId = owner?.scope === "remote" ? owner.instanceId : undefined;
            const expected = [...threads].reverse().find((candidate) => {
              const target = candidate.federation?.ref.target;
              return candidate.source === query.source && candidate.id === query.id
                && (target?.scope === "remote" ? target.instanceId : undefined) === instanceId;
            })!;
            expect(view.read().resolve({ backend: query.source, instanceId, threadId: query.id })).toMatchObject({
              backend: expected.source, threadId: expected.id, title: expected.title, gitBranch: expected.gitBranch,
            });
          }
        }
      } finally { view.unmount(); }
    }), { numRuns: 25 });
  });
});
