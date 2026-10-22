import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadTodo, ThreadTodosChangedEvent } from "@pwragent/shared";
import { useThreadTodos } from "../useThreadTodos";

afterEach(() => {
  cleanup();
  delete (window as unknown as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
});

it("restores cards filtered before provider recovery when the global inventory refresh arrives", async () => {
  const card: ThreadTodo = { id: "card", backend: "acp:grok", threadId: "owner", kind: "reminder",
    status: "open", title: "Check the queue", threadTitle: "Recovered owner", createdAt: 1, updatedAt: 1 };
  let changed: (event: ThreadTodosChangedEvent) => void = () => {};
  const api = {
    listThreadTodos: vi.fn().mockResolvedValueOnce({ todos: [] }).mockResolvedValue({ todos: [card] }),
    onThreadTodosChanged: vi.fn((listener: typeof changed) => { changed = listener; return () => {}; }),
  };
  const { result } = renderHook(() => useThreadTodos(api));
  await waitFor(() => expect(api.listThreadTodos).toHaveBeenCalledTimes(1));
  expect(result.current.openTodos).toEqual([]);
  act(() => changed({ at: 2 }));
  await waitFor(() => expect(result.current.openTodos).toEqual([card]));
  expect(result.current.openByThreadKey.get("acp:grok:owner")).toEqual([card]);
  expect(result.current.revision).toBe(1);
});

it("loads owner cards in a remote viewer and groups them by federated navigation identity", async () => {
  const target = { scope: "remote" as const, instanceId: "peer" };
  Object.assign(window, { __pwragentFederationTarget: target });
  const card: ThreadTodo = { id: "remote-card", backend: "codex", threadId: "owner", kind: "reminder",
    status: "open", title: "Check remote queue", federationTarget: target, createdAt: 1, updatedAt: 1 };
  const api = { listThreadTodos: vi.fn(async () => ({ todos: [card] })) };
  const { result } = renderHook(() => useThreadTodos(api));
  await waitFor(() => expect(result.current.openByThreadKey.get("remote:peer:codex:owner")).toEqual([card]));
  expect(api.listThreadTodos).toHaveBeenCalledTimes(1);
});
