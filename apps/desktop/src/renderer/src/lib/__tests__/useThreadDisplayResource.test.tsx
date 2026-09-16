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

it("isolates Pricing invalidation by instance, backend, and thread", async () => {
  const h = harness();
  const local = { ...thread(), federation: undefined };
  const localView = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: local, resource: "pricing" }));
  const remoteView = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "pricing" }));
  await waitFor(() => expect(h.readThread).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(remoteView.result.current.data).toBeDefined());
  vi.useFakeTimers();
  h.invalidate("unrelated-owner");
  h.emit({ backend: "codex", federationTarget: target, notification: {
    method: "thread/pricing/updated", params: { threadId: "unknown-remote-thread", pricing: { lines: [], summaries: [] } },
  } });
  h.emit({ backend: "acp:other", federationTarget: target, notification: {
    method: "thread/pricing/updated", params: { threadId: "thread", pricing: { lines: [], summaries: [] } },
  } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(h.readThread).toHaveBeenCalledTimes(2);
  h.invalidate();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(h.readThread).toHaveBeenCalledTimes(3);
  expect(h.readThread.mock.lastCall?.[0].federationTarget).toEqual(target);
  h.emit({ backend: "codex", notification: {
    method: "thread/pricing/updated", params: { threadId: "thread", pricing: { lines: [], summaries: [] } },
  } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(h.readThread).toHaveBeenCalledTimes(4);
  expect(h.readThread.mock.lastCall?.[0].federationTarget).toBeUndefined();
  localView.unmount();
  remoteView.unmount();
});

it("reads a resource only while its panel is open and stops refreshes when it closes", async () => {
  const h = harness();
  const { result, rerender, unmount } = renderHook(({ open }) => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: open ? "subagents" : undefined }), { initialProps: { open: false } });
  expect(h.readThread).not.toHaveBeenCalled();
  rerender({ open: true });
  await waitFor(() => expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("first"));
  expect(h.readThread).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", federationTarget: target, knownRevision: "", display: { resource: "subagents", cursor: undefined, limit: 20 }, includeTurns: false, viewOnly: true });
  rerender({ open: false });
  vi.useFakeTimers(); h.invalidate();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
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
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(h.readThread).toHaveBeenCalledTimes(2);
  h.readThread.mockResolvedValueOnce(page("new-first", "new:20", "new")).mockResolvedValueOnce(page("new-second", undefined, "new"));
  h.invalidate(); h.invalidate();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(h.readThread).toHaveBeenCalledTimes(4);
  expect(result.current.data?.subAgents?.map((agent) => agent.monitorId)).toEqual(["new-first", "new-second"]);
  unmount();
});

it("refreshes snapshot-only peers on a changed navigation version without duplicating the initial read", async () => {
  const h = harness();
  const { result, rerender, unmount } = renderHook(({ updatedAt }) => useThreadDisplayResource({ desktopApi: h.api, thread: thread(false, updatedAt), resource: "subagents" }), { initialProps: { updatedAt: 1 } });
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(h.readThread).toHaveBeenCalledTimes(1);
  // Automatic refreshes are budgeted to one per second. Drive that clock
  // explicitly instead of racing waitFor's default one-second deadline.
  vi.useFakeTimers();
  h.readThread.mockResolvedValue(page("updated")); rerender({ updatedAt: 2 });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("updated");
  expect(h.readThread).toHaveBeenCalledTimes(2);
  unmount();
});

it("refreshes open resources after reconnection even without a thread event", async () => {
  const h = harness();
  const { result, unmount } = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  await waitFor(() => expect(result.current.data).toBeDefined());
  vi.useFakeTimers(); h.readThread.mockResolvedValue(page("reconnected"));
  h.emit({ backend: "codex", notification: { method: "federation/peerStatus/changed", params: { instanceId: "owner", status: "connected" } } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("reconnected");
  unmount();
});

it("rejects a stale in-flight page after the selected owner changes", async () => {
  const h = harness();
  let resolve!: (response: AppServerReadThreadResponse) => void;
  h.readThread.mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValue(page("new-owner"));
  const { result, rerender, unmount } = renderHook(({ instanceId }) => useThreadDisplayResource({ desktopApi: h.api, thread: { ...thread(), federation: { ...thread().federation!, ref: { backend: "codex", threadId: "thread", target: { scope: "remote", instanceId } } } }, resource: "subagents" }), { initialProps: { instanceId: "owner" } });
  await waitFor(() => expect(h.readThread).toHaveBeenCalledTimes(1));
  rerender({ instanceId: "new-owner" });
  await waitFor(() => expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("new-owner"));
  await act(async () => resolve(page("old-owner")));
  expect(result.current.data?.subAgents?.[0]?.monitorId).toBe("new-owner");
  unmount();
});


it("shares conditional baselines and loaded history across simultaneous panels", async () => {
  const h = harness();
  h.readThread.mockResolvedValueOnce({ ...page("first", "revision:20"), replayRevision: "first-page" })
    .mockResolvedValueOnce(page("second"));
  const first = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  const second = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  await waitFor(() => expect(second.result.current.data).toBeDefined());
  expect(h.readThread).toHaveBeenCalledTimes(1);
  await act(async () => { await first.result.current.loadMore(); });
  expect(second.result.current.data?.subAgents).toHaveLength(2);
  h.readThread.mockResolvedValue({ ...page("must-not-replace"), display: undefined, unchanged: true, replayRevision: "first-page" });
  vi.useFakeTimers(); h.invalidate(); h.invalidate();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(h.readThread).toHaveBeenCalledTimes(3);
  expect(h.readThread.mock.lastCall?.[0].knownRevision).toBe("first-page");
  expect(second.result.current.data?.subAgents).toHaveLength(2);
  expect(first.result.current.data).toBe(second.result.current.data);
  first.unmount(); second.unmount();
});

it("ignores unrelated ledger events and bounds a sustained invalidation stream", async () => {
  const h = harness();
  const view = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  await waitFor(() => expect(view.result.current.data).toBeDefined());
  vi.useFakeTimers();
  h.emit({ backend: "codex", federationTarget: target, notification: { method: "thread/pricing/updated", params: { threadId: "thread", pricing: { lines: [], summaries: [] } } } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(h.readThread).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) {
    h.invalidate();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  // One initial load plus at most ten revalidations in ten seconds.
  expect(h.readThread.mock.calls.length).toBeLessThanOrEqual(11);
  expect(h.readThread.mock.calls.length).toBeGreaterThan(1);
  view.unmount();
});

it("keeps one read in flight and follows events arriving during it with one revalidation", async () => {
  const h = harness();
  const view = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  await waitFor(() => expect(view.result.current.data).toBeDefined());
  let resolve!: (response: AppServerReadThreadResponse) => void;
  h.readThread.mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValue(page("latest"));
  vi.useFakeTimers(); h.invalidate();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  for (let i = 0; i < 10; i++) h.invalidate();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(h.readThread).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(page("intermediate")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(h.readThread).toHaveBeenCalledTimes(3);
  expect(view.result.current.data?.subAgents?.[0]?.monitorId).toBe("latest");
  view.unmount();
});


it("adopts a pending resource when the panel closes and reopens", async () => {
  const h = harness();
  let resolve!: (response: AppServerReadThreadResponse) => void;
  h.readThread.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const first = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  await waitFor(() => expect(h.readThread).toHaveBeenCalledTimes(1));
  first.unmount();
  const second = renderHook(() => useThreadDisplayResource({ desktopApi: h.api, thread: thread(), resource: "subagents" }));
  await act(async () => { resolve(page("retained-owner")); });
  expect(h.readThread).toHaveBeenCalledTimes(1);
  expect(second.result.current.data?.subAgents?.[0]?.monitorId).toBe("retained-owner");
  second.unmount();
});
