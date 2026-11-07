import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadTodo, ThreadTodosChangedEvent } from "@pwragent/shared";
import { useThreadTodos } from "../useThreadTodos";

afterEach(cleanup);

it("shows the selected remote thread's owner cards as they change without requiring a thread pin", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 5 }),
    async (states) => {
      const target = { scope: "remote" as const, instanceId: "owner-instance" };
      const thread = { backend: "codex" as const, threadId: "selected", federationTarget: target };
      const cards = (ids: number[]): ThreadTodo[] => ids.map((id) => ({ id: `review:${id}`, backend: "codex", threadId: "selected",
        federationTarget: target, kind: "reminder", status: "open", title: String(id), createdAt: id, updatedAt: id }));
      let ownerCards = cards(states[0]!);
      let changed: (event: ThreadTodosChangedEvent) => void = () => {};
      const api = {
        snapshotThreadTodos: vi.fn(async () => ({ epoch: "viewer", revision: 0, todos: [] })),
        onThreadTodosDelta: () => () => {},
        listThreadTodos: vi.fn(async () => ({ todos: ownerCards })),
        onThreadTodosChanged: (listener: typeof changed) => { changed = listener; return () => {}; },
      };
      const { result, unmount } = renderHook(() => useThreadTodos(api, "", thread));
      try {
        await waitFor(() => expect(new Set(result.current.openByThreadKey.get("remote:owner-instance:codex:selected")?.map((todo) => todo.id) ?? []))
          .toEqual(new Set(ownerCards.map((todo) => todo.id))));
        expect(api.listThreadTodos).toHaveBeenCalledWith({ ...thread, status: "open" });
        for (const ids of states.slice(1)) {
          ownerCards = cards(ids);
          act(() => changed({ backend: "codex", threadId: "selected", federationTarget: target, at: Date.now() }));
          await waitFor(() => expect(new Set(result.current.openByThreadKey.get("remote:owner-instance:codex:selected")?.map((todo) => todo.id) ?? []))
            .toEqual(new Set(ownerCards.map((todo) => todo.id))));
        }
      } finally {
        unmount();
      }
    },
  ), { numRuns: 25 });
});

it("shows one owner card when the selected thread is also pinned", async () => {
  const target = { scope: "remote" as const, instanceId: "peer" };
  const todo: ThreadTodo = { id: "remote-todo:peer:review", backend: "codex", threadId: "selected",
    federationTarget: target, kind: "reminder", status: "open", title: "Review", createdAt: 1, updatedAt: 1 };
  const api = {
    snapshotThreadTodos: async () => ({ epoch: "viewer", revision: 0, todos: [todo] }),
    listThreadTodos: async () => ({ todos: [todo] }),
  };
  const { result } = renderHook(() => useThreadTodos(api, "", { backend: "codex", threadId: "selected", federationTarget: target }));
  await waitFor(() => expect(result.current.openTodos).toEqual([todo]));
});

it("reads the owner again when a change arrives during a failed read", async () => {
  const target = { scope: "remote" as const, instanceId: "peer" };
  const todo: ThreadTodo = { id: "remote-todo:peer:review", backend: "codex", threadId: "selected",
    federationTarget: target, kind: "reminder", status: "open", title: "Review", createdAt: 1, updatedAt: 1 };
  let rejectRead: (error: Error) => void = () => {};
  let changed: (event: ThreadTodosChangedEvent) => void = () => {};
  const listThreadTodos = vi.fn()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }))
    .mockResolvedValue({ todos: [todo] });
  const api = {
    snapshotThreadTodos: async () => ({ epoch: "viewer", revision: 0, todos: [] }),
    listThreadTodos,
    onThreadTodosChanged: (listener: typeof changed) => { changed = listener; return () => {}; },
  };
  const { result } = renderHook(() => useThreadTodos(api, "", { backend: "codex", threadId: "selected", federationTarget: target }));
  await waitFor(() => expect(listThreadTodos).toHaveBeenCalledTimes(1));
  act(() => {
    changed({ backend: "codex", threadId: "selected", federationTarget: target, at: 1 });
    rejectRead(new Error("owner busy"));
  });
  await waitFor(() => expect(result.current.openTodos).toEqual([todo]));
  expect(result.current.error).toBeUndefined();
  expect(listThreadTodos).toHaveBeenCalledTimes(2);
});

it("ignores a previous thread's owner response after selection changes", async () => {
  const target = { scope: "remote" as const, instanceId: "peer" };
  const card = (threadId: string): ThreadTodo => ({ id: `remote-todo:peer:${threadId}`, backend: "codex", threadId,
    federationTarget: target, kind: "reminder", status: "open", title: threadId, createdAt: 1, updatedAt: 1 });
  let finishFirst: (value: { todos: ThreadTodo[] }) => void = () => {};
  const listThreadTodos = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
    .mockResolvedValue({ todos: [card("second")] });
  const api = { snapshotThreadTodos: async () => ({ epoch: "viewer", revision: 0, todos: [] }), listThreadTodos };
  const { result, rerender } = renderHook(({ threadId }) => useThreadTodos(api, "",
    { backend: "codex", threadId, federationTarget: target }), { initialProps: { threadId: "first" } });
  await waitFor(() => expect(listThreadTodos).toHaveBeenCalledTimes(1));
  rerender({ threadId: "second" });
  await waitFor(() => expect(result.current.openTodos).toEqual([card("second")]));
  await act(async () => { finishFirst({ todos: [card("first")] }); });
  expect(result.current.openTodos).toEqual([card("second")]);
});
