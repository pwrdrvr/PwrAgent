import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ListBackgroundTerminalsResponse, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useCodexBackgroundTerminals } from "../useCodexBackgroundTerminals";

const terminal = {
  itemId: "item-1", processId: "session-1", command: "pnpm dev", cwd: "/fixture/project", osPid: 456,
};
const thread = (id = "thread-1"): NavigationThreadSummary => ({
  id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
});
afterEach(cleanup);

describe("useCodexBackgroundTerminals", () => {
  it("recovers live sessions on selection, captures bounded output, and stops the session handle", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const list = vi.fn(async () => ({ supported: true, terminals: [terminal] }));
    const terminate = vi.fn(async () => {
      list.mockResolvedValue({ supported: true, terminals: [] });
      return { terminated: true };
    });
    const desktopApi: DesktopApi = {
      listBackgroundTerminals: list,
      terminateBackgroundTerminal: terminate,
      onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const { result } = renderHook(() => useCodexBackgroundTerminals({ desktopApi, thread: thread() }));
    await waitFor(() => expect(result.current.terminals).toHaveLength(1));
    act(() => {
      for (const listener of listeners) listener({ backend: "codex", notification: {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "x".repeat(40_000) },
      } });
    });
    expect(result.current.terminals[0].output).toHaveLength(32_768);
    await act(async () => { await result.current.stop(terminal); });
    expect(terminate).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1", processId: "session-1" }));
    expect(result.current.terminals).toEqual([]);
  });

  it("does not restore a completed terminal from an older list response", async () => {
    let emit!: (event: AgentEvent) => void;
    let resolveRead!: (response: ListBackgroundTerminalsResponse) => void;
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }))
      .mockResolvedValue({ supported: true, terminals: [] });
    const desktopApi: DesktopApi = {
      listBackgroundTerminals: list,
      onAgentEvent: (listener) => { emit = listener; return () => undefined; },
    };
    const { result } = renderHook(() => useCodexBackgroundTerminals({ desktopApi, thread: thread() }));
    await act(async () => {
      emit({ backend: "codex", notification: { method: "item/completed", params: {
        threadId: "thread-1", turnId: "turn-1",
        item: { id: "item-1", type: "commandExecution", status: "completed" },
      } } });
      resolveRead({ supported: true, terminals: [terminal] });
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.terminals).toEqual([]);
  });

  it("ignores a pending read after selection changes", async () => {
    let resolveRead!: (response: ListBackgroundTerminalsResponse) => void;
    const desktopApi: DesktopApi = {
      listBackgroundTerminals: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }))
        .mockResolvedValue({ supported: true, terminals: [] }),
    };
    const { result, rerender } = renderHook(({ id }) =>
      useCodexBackgroundTerminals({ desktopApi, thread: thread(id) }), { initialProps: { id: "thread-1" } },
    );
    rerender({ id: "thread-2" });
    await act(async () => { resolveRead({ supported: true, terminals: [terminal] }); });
    expect(result.current.terminals).toEqual([]);
    expect(result.current.byThread).toEqual({});
  });

  it("keeps the terminal visible and reports a failed stop", async () => {
    const desktopApi: DesktopApi = {
      listBackgroundTerminals: vi.fn(async () => ({ supported: true, terminals: [terminal] })),
      terminateBackgroundTerminal: vi.fn(async () => { throw new Error("permission denied"); }),
    };
    const { result } = renderHook(() => useCodexBackgroundTerminals({ desktopApi, thread: thread() }));
    await waitFor(() => expect(result.current.terminals).toHaveLength(1));
    await act(async () => { await result.current.stop(terminal); });
    expect(result.current.error).toBe("permission denied");
    expect(result.current.terminals).toHaveLength(1);
    expect(result.current.stopping).toBeUndefined();
  });

  it("keeps a queued Stop click bound to its rendered thread after selection changes", async () => {
    const terminate = vi.fn(async () => ({ terminated: true }));
    const desktopApi: DesktopApi = {
      listBackgroundTerminals: vi.fn(async () => ({ supported: true, terminals: [terminal] })),
      terminateBackgroundTerminal: terminate,
    };
    const { result, rerender } = renderHook(({ id }) =>
      useCodexBackgroundTerminals({ desktopApi, thread: thread(id) }), { initialProps: { id: "thread-1" } },
    );
    await waitFor(() => expect(result.current.terminals).toHaveLength(1));
    const previousStop = result.current.stop;
    rerender({ id: "thread-2" });
    await act(async () => { await previousStop(terminal); });
    expect(terminate).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1", processId: "session-1" }));
    expect(result.current.stopping).toBeUndefined();
  });

  it("settles cached terminals after leaving the Codex thread", async () => {
    let emit!: (event: AgentEvent) => void;
    const desktopApi: DesktopApi = {
      listBackgroundTerminals: vi.fn(async () => ({ supported: true, terminals: [terminal] })),
      onAgentEvent: (listener) => { emit = listener; return () => undefined; },
    };
    const { result, rerender } = renderHook(({ selected }: { selected?: NavigationThreadSummary }) =>
      useCodexBackgroundTerminals({ desktopApi, thread: selected }),
      { initialProps: { selected: thread() as NavigationThreadSummary | undefined } },
    );
    await waitFor(() => expect(result.current.terminals).toHaveLength(1));
    rerender({ selected: undefined });
    act(() => {
      emit({ backend: "codex", notification: { method: "item/completed", params: {
        threadId: "thread-1", turnId: "turn-1", item: { id: "item-1", type: "commandExecution", status: "completed" },
      } } });
    });
    expect(result.current.byThread).toEqual({});
  });
});
