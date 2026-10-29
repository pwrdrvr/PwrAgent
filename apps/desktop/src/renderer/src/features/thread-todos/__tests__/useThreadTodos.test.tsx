import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadTodo, ThreadTodoFeedDelta, ThreadTodoFeedSnapshot } from "@pwragent/shared";
import { useThreadTodos } from "../useThreadTodos";

afterEach(() => {
  cleanup();
});

function card(id: string, createdAt: number, extra: Partial<ThreadTodo> = {}): ThreadTodo {
  return { id, backend: "codex", threadId: "owner", kind: "reminder", status: "open",
    title: id, createdAt, updatedAt: createdAt, ...extra };
}

/** Each snapshot call takes the next one; the last repeats. */
function feedApi(snapshots: ThreadTodoFeedSnapshot[]) {
  let listener: (delta: ThreadTodoFeedDelta) => void = () => {};
  const api = {
    listThreadTodos: vi.fn(async () => ({ todos: [] })),
    snapshotThreadTodos: vi.fn(async () => snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!),
    onThreadTodosDelta: vi.fn((callback: typeof listener) => {
      listener = callback;
      return () => {};
    }),
  };
  return { api, deliver: (delta: ThreadTodoFeedDelta) => act(() => listener(delta)) };
}

it("applies a burst of card changes as deltas with no list call after the snapshot", async () => {
  const { api, deliver } = feedApi([{ epoch: "e", revision: 0, todos: [card("seed", 0)] }]);
  const { result } = renderHook(() => useThreadTodos(api));
  await waitFor(() => expect(result.current.openTodos.map((todo) => todo.id)).toEqual(["seed"]));
  const before = result.current.revision;
  for (let revision = 1; revision <= 5; revision++) {
    deliver({ epoch: "e", revision, upserts: [card(`card-${revision}`, revision)] });
  }
  expect(result.current.openTodos.map((todo) => todo.id))
    .toEqual(["card-5", "card-4", "card-3", "card-2", "card-1", "seed"]);
  expect(result.current.openByThreadKey.get("codex:owner")).toHaveLength(6);
  expect(result.current.revision).toBe(before + 5);
  expect(api.snapshotThreadTodos).toHaveBeenCalledTimes(1);
  expect(api.listThreadTodos).not.toHaveBeenCalled();
});

it("re-snapshots exactly once for a revision gap", async () => {
  const { api, deliver } = feedApi([
    { epoch: "e", revision: 3, todos: [card("a", 1)] },
    { epoch: "e", revision: 7, todos: [card("b", 2), card("a", 1)] },
  ]);
  const { result } = renderHook(() => useThreadTodos(api));
  await waitFor(() => expect(result.current.openTodos.map((todo) => todo.id)).toEqual(["a"]));
  deliver({ epoch: "e", revision: 5, upserts: [card("skipped", 3)] });
  deliver({ epoch: "e", revision: 6, upserts: [card("held", 4)] });
  await waitFor(() => expect(result.current.openTodos.map((todo) => todo.id)).toEqual(["b", "a"]));
  expect(api.snapshotThreadTodos).toHaveBeenCalledTimes(2);
  deliver({ epoch: "e", revision: 8, removedIds: ["a"] });
  expect(result.current.openTodos.map((todo) => todo.id)).toEqual(["b"]);
  expect(api.snapshotThreadTodos).toHaveBeenCalledTimes(2);
  expect(api.listThreadTodos).not.toHaveBeenCalled();
});

it("groups a remote viewer's cards by federated navigation identity", async () => {
  const target = { scope: "remote" as const, instanceId: "peer" };
  const remote = card("remote-card", 1, { federationTarget: target });
  const { api } = feedApi([{ epoch: "e", revision: 0, todos: [remote] }]);
  const { result } = renderHook(() => useThreadTodos(api));
  await waitFor(() => expect(result.current.openByThreadKey.get("remote:peer:codex:owner")).toEqual([remote]));
  expect(api.snapshotThreadTodos).toHaveBeenCalledTimes(1);
});

it("keeps the quiet coverage note until a delta clears it", async () => {
  const unavailable = { instanceId: "peer", label: "Studio Mac", reason: "disconnected" as const };
  const { api, deliver } = feedApi([{ epoch: "e", revision: 0, todos: [], unavailableInstances: [unavailable] }]);
  const { result } = renderHook(() => useThreadTodos(api));
  await waitFor(() => expect(result.current.unavailableInstances).toEqual([unavailable]));
  expect(result.current.error).toBeUndefined();
  deliver({ epoch: "e", revision: 1, unavailableInstances: [] });
  expect(result.current.unavailableInstances).toEqual([]);
});

it("takes a new snapshot when the mounted remote threads change", async () => {
  const { api } = feedApi([{ epoch: "e", revision: 0, todos: [] }]);
  const { rerender } = renderHook(({ keys }) => useThreadTodos(api, keys), { initialProps: { keys: "" } });
  await waitFor(() => expect(api.snapshotThreadTodos).toHaveBeenCalledTimes(1));
  rerender({ keys: "remote:peer:codex:owner" });
  await waitFor(() => expect(api.snapshotThreadTodos).toHaveBeenCalledTimes(2));
  expect(api.listThreadTodos).not.toHaveBeenCalled();
});
