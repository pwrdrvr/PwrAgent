import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  createAttentionOrderState,
  reconcileAttentionOrder,
  type AttentionOrderState,
} from "../attention-order";

function thread(
  id: string,
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    inbox: { inInbox: true },
    linkedDirectories: [],
    source: "codex",
    title: id,
    titleSource: "derived",
    updatedAt: 1,
    ...overrides,
  };
}

function activeThread(id: string): NavigationThreadSummary {
  return thread(id, { threadStatus: "active" });
}

function idleThread(id: string): NavigationThreadSummary {
  return thread(id, { threadStatus: "idle" });
}

/**
 * Push one snapshot through the reducer, mirroring what the Sidebar hook does
 * with its ref. Returns the resulting order as plain ids so assertions read as
 * the list the operator sees.
 */
function step(
  state: AttentionOrderState,
  threads: NavigationThreadSummary[],
  options: { promoteOnTurnEnd?: boolean } = {},
): { ids: string[]; state: AttentionOrderState } {
  const reconciled = reconcileAttentionOrder({
    previous: state,
    promoteOnTurnEnd: options.promoteOnTurnEnd ?? true,
    threads,
  });
  return {
    ids: reconciled.threads.map((entry) => entry.id),
    state: reconciled.state,
  };
}

describe("reconcileAttentionOrder", () => {
  it("adopts the snapshot's most-recently-updated order on first sight", () => {
    const first = step(createAttentionOrderState(), [
      activeThread("a"),
      idleThread("b"),
      idleThread("c"),
    ]);

    expect(first.ids).toEqual(["a", "b", "c"]);
  });

  it("holds position while a live turn keeps updating the thread", () => {
    // The bug this exists to prevent: `updatedAt` moves on every streamed item
    // and sub-agent invocation, so two live turns swapped places under the
    // pointer. Membership order flips between snapshots here; the rendered
    // order must not.
    let run = step(createAttentionOrderState(), [
      activeThread("a"),
      activeThread("b"),
      idleThread("c"),
    ]);
    expect(run.ids).toEqual(["a", "b", "c"]);

    run = step(run.state, [activeThread("b"), activeThread("a"), idleThread("c")]);
    expect(run.ids).toEqual(["a", "b", "c"]);

    run = step(run.state, [idleThread("c"), activeThread("b"), activeThread("a")]);
    expect(run.ids).toEqual(["a", "b", "c"]);
  });

  it("moves a thread to the top exactly once when its turn starts", () => {
    let run = step(createAttentionOrderState(), [
      idleThread("a"),
      idleThread("b"),
      idleThread("c"),
    ]);
    expect(run.ids).toEqual(["a", "b", "c"]);

    run = step(run.state, [activeThread("c"), idleThread("a"), idleThread("b")]);
    expect(run.ids).toEqual(["c", "a", "b"]);

    // Everything the turn goes on to do — more items, sub-agents, tool
    // results — leaves the rank alone.
    run = step(run.state, [activeThread("c"), idleThread("b"), idleThread("a")]);
    expect(run.ids).toEqual(["c", "a", "b"]);
  });

  it("gives a finished turn one last move to the top when promotion is on", () => {
    let run = step(createAttentionOrderState(), [
      activeThread("a"),
      activeThread("b"),
    ]);
    expect(run.ids).toEqual(["a", "b"]);

    run = step(run.state, [idleThread("b"), activeThread("a")]);
    expect(run.ids).toEqual(["b", "a"]);

    // One move, not one per post-turn snapshot.
    run = step(run.state, [idleThread("b"), activeThread("a")]);
    expect(run.ids).toEqual(["b", "a"]);
  });

  it("leaves a finished turn parked at its turn-start rank when promotion is off", () => {
    let run = step(
      createAttentionOrderState(),
      [activeThread("a"), activeThread("b")],
      { promoteOnTurnEnd: false },
    );
    expect(run.ids).toEqual(["a", "b"]);

    run = step(run.state, [idleThread("b"), activeThread("a")], {
      promoteOnTurnEnd: false,
    });
    expect(run.ids).toEqual(["a", "b"]);

    // The next turn on that thread still promotes — only the end-of-turn move
    // is suppressed.
    run = step(run.state, [activeThread("b"), activeThread("a")], {
      promoteOnTurnEnd: false,
    });
    expect(run.ids).toEqual(["b", "a"]);
  });

  it("promotes a thread that has just joined the lens", () => {
    let run = step(createAttentionOrderState(), [
      idleThread("a"),
      idleThread("b"),
    ]);
    expect(run.ids).toEqual(["a", "b"]);

    run = step(run.state, [idleThread("c"), idleThread("a"), idleThread("b")]);
    expect(run.ids).toEqual(["c", "a", "b"]);
  });

  it("re-ranks a thread that left the lens and came back", () => {
    let run = step(createAttentionOrderState(), [
      idleThread("a"),
      idleThread("b"),
      idleThread("c"),
    ]);
    expect(run.ids).toEqual(["a", "b", "c"]);

    // `c` is read, so it drops out of the queue entirely.
    run = step(run.state, [idleThread("a"), idleThread("b")]);
    expect(run.ids).toEqual(["a", "b"]);

    // A new message makes it unread again. It is fresh activity, so it comes
    // back at the top rather than at the bottom it left from.
    run = step(run.state, [idleThread("c"), idleThread("a"), idleThread("b")]);
    expect(run.ids).toEqual(["c", "a", "b"]);
  });

  it("drops entries for threads that leave the lens", () => {
    let run = step(createAttentionOrderState(), [
      idleThread("a"),
      idleThread("b"),
    ]);
    run = step(run.state, [idleThread("a")]);

    expect([...run.state.entries.keys()]).toEqual(["codex:a"]);
  });

  it("is idempotent when the same snapshot is reconciled twice", () => {
    // The Sidebar hook writes its ref during the memo, so a StrictMode double
    // render reconciles the already-reconciled state. No transitions remain,
    // so nothing may move.
    const first = step(createAttentionOrderState(), [
      activeThread("a"),
      idleThread("b"),
    ]);
    const second = step(first.state, [activeThread("a"), idleThread("b")]);

    expect(second.ids).toEqual(first.ids);
    expect(second.state.nextRank).toBe(first.state.nextRank);
  });

  it("keeps the freshest thread on top when one snapshot carries several turn starts", () => {
    let run = step(createAttentionOrderState(), [
      idleThread("a"),
      idleThread("b"),
      idleThread("c"),
    ]);

    run = step(run.state, [activeThread("c"), activeThread("b"), idleThread("a")]);
    expect(run.ids).toEqual(["c", "b", "a"]);
  });

  it("treats an optimistic thinking key as a live turn", () => {
    // The renderer marks a thread thinking the moment it sends, before the
    // backend status round-trips. Turn start has to fire on that, or the
    // promotion would land a beat late and then again on the real status.
    const first = reconcileAttentionOrder({
      previous: createAttentionOrderState(),
      promoteOnTurnEnd: true,
      threads: [idleThread("a"), idleThread("b")],
    });
    const second = reconcileAttentionOrder({
      previous: first.state,
      promoteOnTurnEnd: true,
      threads: [idleThread("a"), idleThread("b")],
      thinkingThreadKeys: { "codex:b": true },
    });
    expect(second.threads.map((entry) => entry.id)).toEqual(["b", "a"]);

    // The backend status catching up is not a second transition.
    const third = reconcileAttentionOrder({
      previous: second.state,
      promoteOnTurnEnd: true,
      threads: [activeThread("b"), idleThread("a")],
      thinkingThreadKeys: { "codex:b": true },
    });
    expect(third.threads.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});
