import type { NavigationThreadSummary } from "@pwragent/shared";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider, useThreadLinks, type ThreadLinkContextValue } from "../thread-links";

const noop = () => {};

function thread(index: number): NavigationThreadSummary {
  return {
    id: `thread-${index}`,
    source: "codex",
    title: `Thread ${index}`,
    titleSource: "explicit",
    inbox: { inInbox: false, unread: false },
    gitBranch: "main",
    linkedDirectories: [{ id: "project", kind: "local", label: "Project", path: "/fixture/project" }],
    federation: {
      ref: { backend: "codex", threadId: `thread-${index}`, target: { scope: "remote", instanceId: "peer" } },
      instanceLabel: "Peer",
      capabilities: ["event_subscriptions", "thread_navigation", "thread_detail"],
    },
  } as NavigationThreadSummary;
}

function serializationBudget() {
  let signatures = 0;
  let directories = 0;
  const stringify = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
    if (Array.isArray(value) && Array.isArray(value[0])) {
      if (value[0].length === 8) signatures++;
      if (value[0].length === 5) directories++;
    }
    return stringify(value, ...args);
  });
  return () => ({ signatures, directories });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("thread-link metadata projection", () => {
  it("does not serialize unchanged metadata after generated status updates", () => {
    fc.assert(fc.property(
      fc.array(fc.integer(), { minLength: 1, maxLength: 20 }),
      (updates) => {
        let threads = [thread(0), thread(1)];
        const view = render(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
        const budget = serializationBudget();
        try {
          for (const updatedAt of updates) {
            threads = threads.map((item) => ({ ...item, updatedAt, inbox: { inInbox: false, unread: true } }));
            view.rerender(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
            expect(budget()).toEqual({ signatures: 0, directories: 0 });
          }
        } finally {
          view.unmount();
          vi.restoreAllMocks();
        }
      },
    ), { numRuns: 25 });
  });

  for (const count of [32, 64]) {
    it(`budgets one and twenty unchanged actions over ${count} loaded threads`, () => {
      let threads = Array.from({ length: count }, (_, index) => thread(index));
      const view = render(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
      const budget = serializationBudget();
      for (let action = 0; action < 20; action++) {
        // Fresh arrays, summaries and directories must not defeat the projection.
        threads = threads.map((item) => ({
          ...item,
          updatedAt: action,
          linkedDirectories: item.linkedDirectories.map((directory) => ({ ...directory })),
        }));
        view.rerender(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
        expect(budget()).toEqual({ signatures: 0, directories: 0 });
      }
    });

    it(`rebuilds once for one relevant action over ${count} loaded threads`, () => {
      const threads = Array.from({ length: count }, (_, index) => thread(index));
      const view = render(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
      const budget = serializationBudget();
      // Mutating the last row also ensures the comparison reaches the N/2N bound.
      threads[count - 1]!.title = "New title";
      view.rerender(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
      expect(budget().signatures).toBe(1);
      view.rerender(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
      expect(budget().signatures).toBe(1);
    });
  }

  it("keeps the shrunk one-status-update regression free of serialization", () => {
    const threads = [thread(0), thread(1)];
    const view = render(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
    const budget = serializationBudget();
    view.rerender(<ThreadLinkProvider threads={threads.map((item) => ({ ...item, updatedAt: 0 }))} onShowThread={noop}>{null}</ThreadLinkProvider>);
    expect(budget()).toEqual({ signatures: 0, directories: 0 });
  });

  it("rechecks every scalar even when the caller mutates existing objects", () => {
    const threads = [thread(0)];
    const view = render(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
    const budget = serializationBudget();
    const item = threads[0]!;
    const directory = item.linkedDirectories[0]!;
    const changes = [
      () => { item.title = "Renamed"; },
      () => { item.titleSource = "derived"; },
      () => { item.gitBranch = "feature/new"; },
      () => { item.federation!.instanceLabel = "Renamed peer"; },
      () => { directory.id = "new-id"; },
      () => { directory.label = "New label"; },
      () => { directory.kind = "worktree"; },
      () => { directory.path = "/fixture/new-path"; },
      () => { directory.worktreePath = "/fixture/worktree"; },
      () => { item.linkedDirectories.push({ ...directory, id: "second" }); },
      () => { item.linkedDirectories.reverse(); },
      () => { item.federation!.ref.target = { scope: "remote", instanceId: "new-peer" }; },
      () => { item.federation = undefined; },
      () => { item.source = "acp:fixture"; },
      () => { item.id = "new-thread"; },
    ];
    for (const [index, change] of changes.entries()) {
      change();
      view.rerender(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
      expect(budget().signatures).toBe(index + 1);
    }
    view.rerender(<ThreadLinkProvider threads={threads} onShowThread={noop}>{null}</ThreadLinkProvider>);
    expect(budget().signatures).toBe(changes.length);
  });

  it("publishes generated relevant metadata changes against the owner rows", () => {
    const operation = fc.record({
      field: fc.constantFrom("title", "titleSource", "branch", "label", "directory", "directoryOrder", "membership", "owner", "backend", "reverse", "remove", "append"),
      index: fc.integer({ min: 0, max: 3 }),
      text: fc.string({ maxLength: 12 }),
    });
    fc.assert(fc.property(fc.array(operation, { minLength: 20, maxLength: 30 }), (operations) => {
      let threads = Array.from({ length: 4 }, (_, index) => thread(index));
      // Same id across two providers and two owners must remain distinct.
      for (const item of threads) {
        item.id = "shared-id";
        item.federation!.ref.threadId = item.id;
      }
      threads[1]!.source = "acp:fixture";
      threads[1]!.federation!.ref.backend = "acp:fixture";
      threads[2]!.federation!.ref.target = { scope: "remote", instanceId: "other-peer" };
      threads[3]!.federation = undefined;
      let links: ThreadLinkContextValue;
      function Reader() {
        links = useThreadLinks()!;
        return null;
      }
      const children = <Reader />;
      const view = render(<ThreadLinkProvider threads={threads} onShowThread={noop}>{children}</ThreadLinkProvider>);
      try {
        for (const op of operations) {
          threads = threads.map((item) => ({ ...item }));
          const item = threads[op.index % threads.length]!;
          if (op.field === "title") item.title = op.text;
          if (op.field === "titleSource") item.titleSource = item.titleSource === "explicit" ? "derived" : "explicit";
          if (op.field === "branch") item.gitBranch = op.text;
          if (op.field === "label" && item.federation) item.federation = { ...item.federation, instanceLabel: op.text };
          if (op.field === "directory") item.linkedDirectories = [{ id: op.text, label: op.text, kind: "worktree", path: `/fixture/${op.text}`, worktreePath: `/fixture/worktree/${op.text}` }];
          if (op.field === "directoryOrder") item.linkedDirectories = [
            { id: "extra", label: "Extra", kind: "local" as const, path: "/fixture/extra" },
            ...item.linkedDirectories,
          ].slice(0, 3).reverse();
          if (op.field === "membership") item.id = item.id === "shared-id" ? `new-${op.index}` : "shared-id";
          if (op.field === "owner") item.federation = item.federation ? undefined : {
            ref: { backend: item.source, threadId: item.id, target: { scope: "remote", instanceId: `peer-${op.index}` } },
            instanceLabel: op.text,
          };
          if (op.field === "backend") item.source = item.source === "codex" ? "acp:fixture" : "codex";
          if (item.federation) item.federation = { ...item.federation, ref: { ...item.federation.ref, backend: item.source, threadId: item.id } };
          if (op.field === "reverse") threads.reverse();
          if (op.field === "remove" && threads.length > 1) threads.splice(op.index % threads.length, 1);
          if (op.field === "append" && threads.length < 8) threads.push(thread(threads.length));
          view.rerender(<ThreadLinkProvider threads={threads} onShowThread={noop}>{children}</ThreadLinkProvider>);
          for (const query of threads) {
            const instanceId = query.federation?.ref.target.scope === "remote" ? query.federation.ref.target.instanceId : undefined;
            // The owner's ordered rows are the oracle: the last duplicate wins.
            const owner = [...threads].reverse().find((candidate) => {
              const target = candidate.federation?.ref.target;
              return candidate.source === query.source && candidate.id === query.id
                && (target?.scope === "remote" ? target.instanceId : undefined) === instanceId;
            })!;
            const resolved = links!.resolve({ backend: query.source, threadId: query.id, ...(instanceId ? { instanceId } : {}) });
            expect(resolved).toMatchObject({
              backend: owner.source, threadId: owner.id, title: owner.title,
              titleSource: owner.titleSource, gitBranch: owner.gitBranch, linkedDirectories: owner.linkedDirectories,
            });
            expect(resolved?.instanceLabel).toBe(owner.federation?.instanceLabel || undefined);
          }
        }
      } finally {
        view.unmount();
      }
    }), { numRuns: 25 });
  });
});
