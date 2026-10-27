import { describe, expect, it, vi } from "vitest";
import type { ThreadTodo, ThreadTodoFeedDelta, ThreadTodoFeedSnapshot } from "../contracts/thread-todos";
import { applyThreadTodoFeedDelta, ThreadTodoFeedFollower } from "../thread-todo-feed";

function card(id: string, createdAt: number): ThreadTodo {
  return { id, backend: "codex", threadId: "owner", kind: "reminder", status: "open",
    title: id, createdAt, updatedAt: createdAt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function follower(fetch: () => Promise<ThreadTodoFeedSnapshot>) {
  const snapshots: ThreadTodoFeedSnapshot[] = [];
  const deltas: ThreadTodoFeedDelta[] = [];
  const instance = new ThreadTodoFeedFollower({
    fetch,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onDelta: (delta) => deltas.push(delta),
  });
  return { instance, snapshots, deltas };
}

describe("ThreadTodoFeedFollower", () => {
  it("applies consecutive deltas after one snapshot and drops stale ones", async () => {
    const fetch = vi.fn(async () => ({ epoch: "e", revision: 2, todos: [] }));
    const { instance, deltas } = follower(fetch);
    await instance.sync();
    instance.receive({ epoch: "e", revision: 2, upserts: [card("old", 1)] });
    instance.receive({ epoch: "e", revision: 3, upserts: [card("a", 1)] });
    instance.receive({ epoch: "e", revision: 4, removedIds: ["a"] });
    expect(deltas.map((delta) => delta.revision)).toEqual([3, 4]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads once for a revision gap, holding deltas that arrive meanwhile", async () => {
    const second = deferred<ThreadTodoFeedSnapshot>();
    const fetch = vi.fn()
      .mockResolvedValueOnce({ epoch: "e", revision: 1, todos: [] })
      .mockReturnValueOnce(second.promise);
    const { instance, snapshots, deltas } = follower(fetch);
    await instance.sync();
    instance.receive({ epoch: "e", revision: 3, upserts: [card("skipped", 1)] });
    instance.receive({ epoch: "e", revision: 4, upserts: [card("held", 2)] });
    instance.receive({ epoch: "e", revision: 5, upserts: [card("after", 3)] });
    second.resolve({ epoch: "e", revision: 4, todos: [card("skipped", 1), card("held", 2)] });
    await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(deltas.map((delta) => delta.revision)).toEqual([5]);
  });

  it("re-reads for a new epoch and for a resync marker past its revision", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ epoch: "e", revision: 1, todos: [] })
      .mockResolvedValueOnce({ epoch: "f", revision: 0, todos: [] })
      .mockResolvedValueOnce({ epoch: "f", revision: 2, todos: [] });
    const { instance } = follower(fetch);
    await instance.sync();
    instance.receive({ epoch: "f", revision: 1 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    instance.receive({ epoch: "f", revision: 0, resync: true });
    instance.receive({ epoch: "f", revision: 2, resync: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });

  it("ignores deltas before its first snapshot", () => {
    const fetch = vi.fn(async () => ({ epoch: "e", revision: 0, todos: [] }));
    const { instance, deltas } = follower(fetch);
    instance.receive({ epoch: "e", revision: 1, upserts: [card("a", 1)] });
    expect(fetch).not.toHaveBeenCalled();
    expect(deltas).toEqual([]);
  });
});

describe("applyThreadTodoFeedDelta", () => {
  it("replaces, removes and keeps cards newest first", () => {
    const todos = [card("b", 2), card("a", 1)];
    expect(applyThreadTodoFeedDelta(todos, { epoch: "e", revision: 1,
      upserts: [card("c", 3), { ...card("a", 1), title: "edited" }], removedIds: ["b"] }))
      .toEqual([card("c", 3), { ...card("a", 1), title: "edited" }]);
    expect(applyThreadTodoFeedDelta(todos, { epoch: "e", revision: 2 })).toBe(todos);
  });
});
