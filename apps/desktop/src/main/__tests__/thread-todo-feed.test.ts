import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ThreadTodo, ThreadTodoFeedDelta } from "@pwragent/shared";
import { ThreadTodoFeed, type ThreadTodoFeedOwner } from "../thread-todos/thread-todo-feed";

function card(id: string, threadId: string, createdAt: number, extra: Partial<ThreadTodo> = {}): ThreadTodo {
  return { id, backend: "codex", threadId, kind: "reminder", status: "open", title: id,
    createdAt, updatedAt: createdAt, ...extra };
}

function owner(id: string, title = `Thread ${id}`): ThreadTodoFeedOwner {
  return { id, source: "codex", title };
}

function harness(initial: ThreadTodo[], owners: ThreadTodoFeedOwner[]) {
  const cards = new Map(initial.map((todo) => [todo.id, todo]));
  let listing = owners;
  const deltas: ThreadTodoFeedDelta[] = [];
  const source = {
    readOpenCards: vi.fn((scope?: { backend: string; threadId: string }) => [...cards.values()]
      .filter((todo) => todo.status === "open"
        && (!scope || (todo.backend === scope.backend && todo.threadId === scope.threadId)))),
    loadOwners: vi.fn(async () => listing),
    managedThreadKeys: vi.fn((): ReadonlySet<string> => new Set()),
    withDispatchDefaults: vi.fn(async (todos: ThreadTodo[]) => todos),
    mergeMethods: vi.fn(() => ({ defaultMethod: "squash" as const, byProject: {} })),
  };
  const feed = new ThreadTodoFeed(source, (delta) => deltas.push(delta), "epoch");
  return { feed, cards, source, deltas, setListing: (next: ThreadTodoFeedOwner[]) => { listing = next; } };
}

function event(method: string, params: Record<string, unknown>): AgentEvent {
  return { backend: "codex", notification: { method, params } } as AgentEvent;
}

describe("ThreadTodoFeed", () => {
  it("does no work before the first snapshot", () => {
    const { feed, source } = harness([], [owner("t")]);
    feed.cardsChanged({ backend: "codex", threadId: "t" });
    feed.handleBackendEvent(event("thread/archived", { threadId: "t" }));
    expect(source.readOpenCards).not.toHaveBeenCalled();
    expect(source.loadOwners).not.toHaveBeenCalled();
  });

  it("seeds from one owner listing and filters cards to available owners", async () => {
    const { feed, source } = harness([card("a", "t", 1), card("gone", "archived", 2)], [owner("t")]);
    const snapshot = await feed.snapshot();
    expect(snapshot).toMatchObject({ epoch: "epoch", revision: 0,
      mergeMethods: { defaultMethod: "squash", byProject: {} } });
    expect(snapshot.todos).toEqual([card("a", "t", 1, { threadTitle: "Thread t" })]);
    expect(source.loadOwners).toHaveBeenCalledTimes(1);
  });

  it("turns a burst of N card changes into N deltas without another listing", async () => {
    const { feed, cards, source, deltas } = harness([], [owner("t")]);
    await feed.snapshot();
    for (let index = 1; index <= 4; index++) {
      cards.set(`c${index}`, card(`c${index}`, "t", index));
      feed.cardsChanged({ backend: "codex", threadId: "t" });
    }
    await feed.idle();
    expect(deltas.map((delta) => delta.revision)).toEqual([1, 2, 3, 4]);
    expect(deltas.flatMap((delta) => delta.upserts ?? []).map((todo) => todo.id).sort())
      .toEqual(["c1", "c2", "c3", "c4"]);
    expect(deltas.every((delta) => delta.backend === "codex" && delta.threadId === "t"
      && delta.epoch === "epoch" && delta.mergeMethods)).toBe(true);
    expect(source.loadOwners).toHaveBeenCalledTimes(1);
    expect(source.readOpenCards).toHaveBeenLastCalledWith({ backend: "codex", threadId: "t" });
    expect((await feed.snapshot()).revision).toBe(4);
  });

  it("removes an archived owner's cards as a delta", async () => {
    const { feed, deltas, source } = harness([card("a", "t", 1), card("b", "other", 2)], [owner("t"), owner("other")]);
    await feed.snapshot();
    feed.handleBackendEvent(event("thread/archived", { threadId: "t" }));
    await feed.idle();
    expect(deltas).toEqual([{ epoch: "epoch", revision: 1, backend: "codex", threadId: "t",
      removedIds: ["a"], mergeMethods: { defaultMethod: "squash", byProject: {} } }]);
    expect((await feed.snapshot()).todos.map((todo) => todo.id)).toEqual(["b"]);
    expect(source.loadOwners).toHaveBeenCalledTimes(1);
  });

  it("retitles cards from a rename without reading the listing or dispatch settings", async () => {
    const { feed, deltas, source } = harness([card("a", "t", 1)], [owner("t")]);
    await feed.snapshot();
    source.withDispatchDefaults.mockClear();
    feed.handleBackendEvent(event("thread/name/updated", { threadId: "t", threadName: "Renamed" }));
    await feed.idle();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.upserts).toEqual([card("a", "t", 1, { threadTitle: "Renamed" })]);
    expect(source.loadOwners).toHaveBeenCalledTimes(1);
    expect(source.withDispatchDefaults).not.toHaveBeenCalled();
    expect((await feed.snapshot()).todos).toEqual([card("a", "t", 1, { threadTitle: "Renamed" })]);
    // The stored title matches, so a later read of the thread publishes nothing.
    feed.cardsChanged({ backend: "codex", threadId: "t" });
    await feed.idle();
    expect(deltas).toHaveLength(1);
  });

  it("reads the listing once for a card on a thread it has not seen", async () => {
    const { feed, cards, source, deltas, setListing } = harness([], []);
    await feed.snapshot();
    setListing([owner("new")]);
    cards.set("a", card("a", "new", 1));
    feed.cardsChanged({ backend: "codex", threadId: "new" });
    await feed.idle();
    expect(source.loadOwners).toHaveBeenCalledTimes(2);
    expect(deltas.map((delta) => delta.upserts?.[0]?.id)).toEqual(["a"]);
    cards.set("b", card("b", "new", 2));
    feed.cardsChanged({ backend: "codex", threadId: "new" });
    await feed.idle();
    expect(source.loadOwners).toHaveBeenCalledTimes(2);
    expect(deltas).toHaveLength(2);
  });

  it("asks the listing again when a card changes on a thread a stale listing lacked", async () => {
    const { feed, cards, source, deltas, setListing } = harness([card("a", "late", 1)], []);
    expect((await feed.snapshot()).todos).toEqual([]);
    setListing([owner("late")]);
    cards.set("b", card("b", "late", 2));
    feed.cardsChanged({ backend: "codex", threadId: "late" });
    await feed.idle();
    expect(source.loadOwners).toHaveBeenCalledTimes(2);
    expect(deltas.flatMap((delta) => delta.upserts ?? []).map((todo) => todo.id)).toEqual(["b", "a"]);
  });

  it("reads merge preferences once per published change", async () => {
    const { feed, cards, source } = harness([], [owner("t")]);
    await feed.snapshot();
    source.mergeMethods.mockClear();
    for (const id of ["a", "b", "c"]) cards.set(id, card(id, "t", 1));
    feed.cardsChanged({ backend: "codex", threadId: "t" });
    await feed.idle();
    expect(source.mergeMethods).toHaveBeenCalledTimes(1);
  });

  it("re-reads owners after unarchive and provider refresh", async () => {
    const { feed, source, deltas, setListing } = harness([card("a", "t", 1)], []);
    expect((await feed.snapshot()).todos).toEqual([]);
    setListing([owner("t")]);
    feed.handleBackendEvent(event("thread/unarchived", { threadId: "t" }));
    await feed.idle();
    expect(deltas.map((delta) => delta.upserts?.[0]?.id)).toEqual(["a"]);
    setListing([]);
    source.readOpenCards.mockClear();
    feed.handleBackendEvent(event("navigation/providerThreads/refreshed", { failedProviders: 0 }));
    await feed.idle();
    // A provider refresh changes owners, not card rows.
    expect(source.readOpenCards).not.toHaveBeenCalled();
    expect(deltas.map((delta) => delta.removedIds?.[0])).toEqual([undefined, "a"]);
    expect(source.loadOwners).toHaveBeenCalledTimes(3);
  });

  it("hides cards from private managed sub-agent threads", async () => {
    const { feed, source } = harness([card("a", "t", 1)], [owner("t")]);
    source.managedThreadKeys.mockReturnValue(new Set(["codex:t"]));
    expect((await feed.snapshot()).todos).toEqual([]);
  });

  it("ignores federated events and emits nothing when a refresh finds no change", async () => {
    const { feed, deltas } = harness([card("a", "t", 1)], [owner("t")]);
    await feed.snapshot();
    feed.handleBackendEvent({ ...event("thread/archived", { threadId: "t" }),
      federationTarget: { scope: "remote", instanceId: "peer" } });
    feed.cardsChanged({ backend: "codex", threadId: "t" });
    await feed.idle();
    expect(deltas).toEqual([]);
  });
});
