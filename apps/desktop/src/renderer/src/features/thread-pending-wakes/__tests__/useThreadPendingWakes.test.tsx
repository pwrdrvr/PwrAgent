import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  NavigationThreadSummary,
  ThreadPendingWake,
  ThreadPendingWakesRequest,
  ThreadPendingWakesResponse,
} from "@pwragent/shared";
import { useThreadPendingWakes } from "../useThreadPendingWakes";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const thread: NavigationThreadSummary = {
  id: "waiting",
  title: "Waiting",
  titleSource: "explicit",
  source: "claude",
  linkedDirectories: [],
  inbox: { inInbox: false },
};

const wake: ThreadPendingWake = {
  kind: "backend_task", key: "backend_task:t1", durable: false, stop: "stop",
  task: { itemId: "tool-1", processId: "t1", command: "pnpm test", cwd: "/repo", background: true },
};

function fakeApi(lists: ThreadPendingWakesResponse[]) {
  let listener: ((event: AgentEvent) => void) | undefined;
  const requests: ThreadPendingWakesRequest[] = [];
  const api = {
    manageThreadPendingWakes: vi.fn(async (request: ThreadPendingWakesRequest): Promise<ThreadPendingWakesResponse> => {
      requests.push(request);
      if (request.action === "stop") return { ok: true, stopped: true };
      return lists.shift() ?? { ok: true, wakes: [], ended: [] };
    }),
    onAgentEvent: vi.fn((callback: (event: AgentEvent) => void) => {
      listener = callback;
      return () => { listener = undefined; };
    }),
  };
  return { api, requests, emit: (event: AgentEvent) => listener?.(event) };
}

describe("useThreadPendingWakes", () => {
  it("serializes invalidations during a slow read and never publishes the invalidated result", async () => {
    let resolve!: (value: ThreadPendingWakesResponse) => void;
    const slow = new Promise<ThreadPendingWakesResponse>((done) => { resolve = done; });
    const { api, emit } = fakeApi([{ ok: true, wakes: [], ended: [] }]);
    api.manageThreadPendingWakes.mockImplementationOnce(() => slow);
    const { result } = renderHook(() => useThreadPendingWakes(thread, api));
    expect(api.manageThreadPendingWakes).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i += 1) act(() => emit({ backend: "claude", notification: {
      method: "thread/backgroundTasks/updated", params: { threadId: thread.id, tasks: [] },
    } } as unknown as AgentEvent));
    expect(api.manageThreadPendingWakes).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true, wakes: [wake], ended: [] }));
    expect(api.manageThreadPendingWakes).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [] }));
    expect(api.manageThreadPendingWakes).toHaveBeenCalledTimes(2);
  });

  it("loads history only on panel demand and ignores accounting-only card events", async () => {
    const { api, emit, requests } = fakeApi([{ ok: true, wakes: [wake], ended: [] }]);
    const { rerender } = renderHook(({ includeEnded }) => useThreadPendingWakes(thread, api, { includeEnded }),
      { initialProps: { includeEnded: false } });
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() => emit({ backend: "claude", notification: { method: "thread/subAgents/updated",
      params: { threadId: thread.id, navigationChanged: false } } } as unknown as AgentEvent));
    expect(requests).toHaveLength(1);
    rerender({ includeEnded: true });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ action: "list", endedLimit: 8 });
  });

  it("fences a late old-thread read and hides its state immediately on selection", async () => {
    let resolve!: (value: ThreadPendingWakesResponse) => void;
    const slow = new Promise<ThreadPendingWakesResponse>((done) => { resolve = done; });
    const { api } = fakeApi([{ ok: true, wakes: [], ended: [] }]);
    api.manageThreadPendingWakes.mockImplementationOnce(() => slow);
    const { result, rerender } = renderHook(({ selected }) => useThreadPendingWakes(selected, api),
      { initialProps: { selected: thread } });
    rerender({ selected: { ...thread, id: "next" } });
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [] }));
    await act(async () => resolve({ ok: true, wakes: [wake], ended: [] }));
    expect(result.current.state).toMatchObject({ status: "ready", wakes: [] });
  });

  it("reads a local thread's list, and reads it again when a wake source changes for the thread", async () => {
    const { api, requests, emit } = fakeApi([
      { ok: true, wakes: [wake], ended: [] },
      { ok: true, wakes: [], ended: [], incomplete: true },
    ]);
    const { result } = renderHook(() => useThreadPendingWakes(thread, api as never));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [wake], peer: false }));
    expect(requests[0]).toEqual({ action: "list", backend: "claude", threadId: "waiting", endedLimit: 0 });

    // Another thread's change, and an unrelated method, read nothing.
    emit({ backend: "claude", notification: { method: "thread/backgroundTasks/updated", params: { threadId: "other", tasks: [] } } } as unknown as AgentEvent);
    emit({ backend: "claude", notification: { method: "turn/started", params: { threadId: "waiting" } } } as unknown as AgentEvent);
    // Scheduled actions name their thread inside the action.
    emit({ backend: "claude", notification: { method: "thread/scheduledAction/updated", params: { action: { threadId: "waiting" } } } } as unknown as AgentEvent);
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [], incomplete: true }));
    expect(requests.filter((request) => request.action === "list")).toHaveLength(2);
  });

  it("stops a wake on the owner and reads the list again", async () => {
    const { api, requests } = fakeApi([{ ok: true, wakes: [wake], ended: [] }]);
    const { result } = renderHook(() => useThreadPendingWakes(thread, api as never));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => {
      await expect(result.current.stop("backend_task:t1")).resolves.toEqual({ ok: true, stopped: true });
    });
    expect(requests).toContainEqual({ action: "stop", backend: "claude", threadId: "waiting", key: "backend_task:t1" });
    expect(requests.filter((request) => request.action === "list")).toHaveLength(2);
  });

  it("uses a peer owner's projection, and knows nothing when the owner sends none", () => {
    const { api } = fakeApi([]);
    const federation = {
      instanceLabel: "studio-mac",
      ref: { backend: "claude", threadId: "waiting", target: { scope: "remote", instanceId: "studio" } },
    } as NavigationThreadSummary["federation"];
    const { result, rerender } = renderHook(
      ({ current }: { current: NavigationThreadSummary }) => useThreadPendingWakes(current, api as never),
      { initialProps: { current: { ...thread, federation } } },
    );
    expect(result.current.state).toEqual({ status: "unknown" });
    rerender({ current: { ...thread, federation, pendingWakes: [wake] } });
    expect(result.current.state).toMatchObject({ status: "ready", wakes: [wake], peer: true });
    expect(api.manageThreadPendingWakes).not.toHaveBeenCalled();
  });

  it("does not stay loading when the first read fails", async () => {
    const { api } = fakeApi([{ ok: false, error: { code: "failed", message: "State is closed." } }]);
    const { result } = renderHook(() => useThreadPendingWakes(thread, api as never));
    await waitFor(() => expect(result.current.state).toEqual({ status: "unknown" }));
  });

  it("reads again when the thread's Auto-fix is turned off, and only for its own backend", async () => {
    const { api, requests, emit } = fakeApi([
      { ok: true, wakes: [wake], ended: [] },
      { ok: true, wakes: [], ended: [] },
    ]);
    const { result } = renderHook(() => useThreadPendingWakes(thread, api as never));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [wake] }));
    emit({ backend: "codex", notification: { method: "thread/prAutoDispatch/updated", params: { threadId: "waiting", enabled: false } } } as unknown as AgentEvent);
    emit({ backend: "claude", notification: { method: "thread/prAutoDispatch/updated", params: { threadId: "waiting", enabled: false } } } as unknown as AgentEvent);
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [] }));
    expect(requests.filter((request) => request.action === "list")).toHaveLength(2);
  });

  it("reads again when a hold changes: the thread's lock, its queue, or any project's pause", async () => {
    const { api, requests, emit } = fakeApi([
      { ok: true, wakes: [], ended: [] },
      { ok: true, wakes: [wake], ended: [] },
      { ok: true, wakes: [], ended: [] },
      { ok: true, wakes: [wake], ended: [] },
    ]);
    const { result } = renderHook(() => useThreadPendingWakes(thread, api as never));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [] }));
    emit({ backend: "claude", notification: { method: "thread/lock/updated", params: { threadId: "waiting" } } } as unknown as AgentEvent);
    await waitFor(() => expect(result.current.state).toMatchObject({ wakes: [wake] }));
    emit({ backend: "claude", notification: { method: "thread/turnQueue/updated", params: { threadId: "waiting", queueEntryId: "q1" } } } as unknown as AgentEvent);
    await waitFor(() => expect(result.current.state).toMatchObject({ wakes: [] }));
    // A project event names no thread, and any backend may stamp it.
    emit({ backend: "codex", notification: { method: "directory/forgeAutomation/updated", params: { directoryKey: "directory:/repo" } } } as unknown as AgentEvent);
    await waitFor(() => expect(result.current.state).toMatchObject({ wakes: [wake] }));
    expect(requests.filter((request) => request.action === "list")).toHaveLength(4);
  });

  it("hides a peer's stopped wake until the owner's next projection, and says when it is incomplete", async () => {
    const { api, requests } = fakeApi([]);
    const federation = {
      instanceLabel: "studio-mac",
      ref: { backend: "claude", threadId: "waiting", target: { scope: "remote", instanceId: "studio" } },
    } as NavigationThreadSummary["federation"];
    const other: ThreadPendingWake = { ...wake, key: "backend_task:t2", task: { ...wake.task, processId: "t2" } };
    const { result, rerender } = renderHook(
      ({ current }: { current: NavigationThreadSummary }) => useThreadPendingWakes(current, api as never),
      { initialProps: { current: { ...thread, federation, pendingWakes: [wake, other], pendingWakesIncomplete: true } } },
    );
    expect(result.current.state).toMatchObject({ status: "ready", incomplete: true });
    await act(async () => {
      await result.current.stop("backend_task:t1");
    });
    expect(requests).toContainEqual({
      action: "stop", backend: "claude", threadId: "waiting", key: "backend_task:t1",
      federationTarget: { scope: "remote", instanceId: "studio" },
    });
    expect(result.current.state).toMatchObject({ status: "ready", wakes: [other] });
    // The owner's next projection is the truth again.
    rerender({ current: { ...thread, federation, pendingWakes: [wake] } });
    expect(result.current.state).toMatchObject({ status: "ready", wakes: [wake], incomplete: false });
  });

  it("hides a peer's wake another control ended, and reads a local list again", async () => {
    const { api, requests } = fakeApi([{ ok: true, wakes: [wake], ended: [] }, { ok: true, wakes: [], ended: [] }]);
    const federation = {
      instanceLabel: "studio-mac",
      ref: { backend: "claude", threadId: "waiting", target: { scope: "remote", instanceId: "studio" } },
    } as NavigationThreadSummary["federation"];
    // The owner's projection keeps its identity until the next one arrives.
    const peerThread: NavigationThreadSummary = { ...thread, federation, pendingWakes: [wake] };
    const peerHook = renderHook(() => useThreadPendingWakes(peerThread, api as never));
    act(() => peerHook.result.current.ended("backend_task:t1"));
    expect(peerHook.result.current.state).toMatchObject({ status: "ready", wakes: [] });
    expect(api.manageThreadPendingWakes).not.toHaveBeenCalled();
    peerHook.unmount();

    const { result } = renderHook(() => useThreadPendingWakes(thread, api as never));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [wake] }));
    act(() => result.current.ended("backend_task:t1"));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", wakes: [] }));
    expect(requests.filter((request) => request.action === "list")).toHaveLength(2);
  });
});
