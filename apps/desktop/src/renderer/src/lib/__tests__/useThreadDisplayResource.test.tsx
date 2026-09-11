import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildThreadPricingDisplay, type AgentEvent, type AppServerReadThreadResponse, type NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadDisplayResource } from "../useThreadDisplayResource";

const target = { scope: "remote" as const, instanceId: "owner" };
function thread(subscribe = true, updatedAt = 1): NavigationThreadSummary {
  return {
    source: "codex", id: "thread", title: "Thread", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false }, updatedAt,
    federation: { ref: { backend: "codex", threadId: "thread", target }, instanceLabel: "Owner", capabilities: subscribe ? ["thread_detail", "event_subscriptions"] : ["thread_detail"] },
  };
}
function page(id: string, cursor?: string, revision = "revision"): AppServerReadThreadResponse {
  return {
    backend: "codex", threadId: "thread", fetchedAt: 1, replay: { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
    display: { pricing: buildThreadPricingDisplay({}), revision, nextCursor: cursor,
      subAgents: [{ monitorId: id, createdAt: 1, updatedAt: 1, status: "success", task: id }] },
  };
}
function harness() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const readThread = vi.fn<NonNullable<DesktopApi["readThread"]>>().mockResolvedValue(page("first"));
  const api: DesktopApi = { readThread, onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const emit = (event: AgentEvent) => act(() => { for (const listener of listeners) listener(event); });
  const invalidate = (instanceId = "owner") => emit({ backend: "codex", federationTarget: { scope: "remote", instanceId },
    notification: { method: "thread/subAgents/updated", params: { threadId: "thread", displayInvalidated: true, subAgents: [] } } });
  return { api, readThread, emit, invalidate };
}
afterEach(() => vi.useRealTimers());

it("reads a resource only while its panel is open and stops refreshes when it closes", async () => {
  const h = harness();
  const { result, rerender, unmount } = renderHook(({ open }) => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: open ? "subagents" : undefined }), { initialProps: { open: false } });
  expect(h.readThread).not.toHaveBeenCalled();
  rerender({ open: true });
  await waitFor(() => expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("first"));
  expect(h.readThread).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", federationTarget: target, display: { resource: "subagents", cursor: undefined, limit: 20 }, includeTurns: false, viewOnly: true });
  rerender({ open: false });
  vi.useFakeTimers(); h.invalidate();
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(h.readThread).toHaveBeenCalledTimes(1);
  expect(result.current.data).toBeUndefined();
  unmount();
});

it("preserves requested history pages across coalesced live updates and isolates other owners", async () => {
  const h = harness();
  h.readThread.mockResolvedValueOnce(page("first", "revision:20")).mockResolvedValueOnce(page("second"));
  const { result, unmount } = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  await waitFor(() => expect(result.current.data?.nextCursor).toBe("revision:20"));
  await act(async () => { await result.current.loadMore(); });
  expect(result.current.data?.subAgents?.map((agent) => agent.monitorId)).toEqual(["first", "second"]);
  expect(h.readThread.mock.calls[1]?.[0].display?.cursor).toBe("revision:20");
  vi.useFakeTimers(); h.invalidate("another-owner");
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(h.readThread).toHaveBeenCalledTimes(2);
  h.readThread.mockResolvedValueOnce(page("new-first", "new:20", "new")).mockResolvedValueOnce(page("new-second", undefined, "new"));
  h.invalidate(); h.invalidate();
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(h.readThread).toHaveBeenCalledTimes(4);
  expect(result.current.data?.subAgents?.map((agent) => agent.monitorId)).toEqual(["new-first", "new-second"]);
  unmount();
});

it("refreshes snapshot-only peers on a changed navigation version without duplicating the initial read", async () => {
  const h = harness();
  const { result, rerender, unmount } = renderHook(({ updatedAt }) => useThreadDisplayResource({ desktopApi: h.api, thread: thread(false, updatedAt), resource: "subagents" }), { initialProps: { updatedAt: 1 } });
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(h.readThread).toHaveBeenCalledTimes(1);
  h.readThread.mockResolvedValue(page("updated")); rerender({ updatedAt: 2 });
  await waitFor(() => expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("updated"));
  expect(h.readThread).toHaveBeenCalledTimes(2);
  unmount();
});

it("refreshes open resources after reconnection even without a thread event", async () => {
  const h = harness();
  const { result, unmount } = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  await waitFor(() => expect(result.current.data).toBeDefined());
  vi.useFakeTimers(); h.readThread.mockResolvedValue(page("reconnected"));
  h.emit({ backend: "codex", notification: { method: "federation/peerStatus/changed", params: { instanceId: "owner", status: "connected" } } });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("reconnected");
  unmount();
});

it("rejects a stale in-flight page after the selected owner changes", async () => {
  const h = harness();
  let resolve!: (response: AppServerReadThreadResponse) => void;
  h.readThread.mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValue(page("new-owner"));
  const { result, rerender, unmount } = renderHook(({ instanceId }) => useThreadDisplayResource({ desktopApi: h.api, thread: { ...thread(), federation: { ...thread().federation!, ref: { backend: "codex", threadId: "thread", target: { scope: "remote", instanceId } } } }, resource: "subagents" }), { initialProps: { instanceId: "owner" } });
  rerender({ instanceId: "new-owner" });
  await waitFor(() => expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("new-owner"));
  await act(async () => resolve(page("old-owner")));
  expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("new-owner");
  unmount();
});
