import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationQueueProjection, NavigationThreadSummary } from "@pwragent/shared";
import type { ComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import type { DesktopApi } from "../desktop-api";
import { useIndependentQueueProjection } from "../useIndependentQueueProjection";
import { navigationQueueBaselineBudget } from "../navigation-metadata-budget";

function selected(instanceId = "owner"): NavigationThreadSummary {
  return { source: "codex", id: "same", federation: { ref: {
    backend: "codex", threadId: "same", target: { scope: "remote", instanceId },
  } } } as NavigationThreadSummary;
}
function page(instanceId = "owner", patch: Partial<NavigationQueueProjection> = {}): NavigationQueueProjection {
  return { protocol: 2, ref: { backend: "codex", threadId: "same", ownerInstanceId: instanceId },
    revision: "fifo", readiness: "ready", complete: true, entries: [], ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("selected FIFO readiness", () => {
  it("releases a pending complete FIFO read when its consumer closes", async () => {
    const pending = deferred<NavigationQueueProjection>();
    const read = vi.fn().mockReturnValue(pending.promise);
    const release = vi.fn(async () => {});
    const api: DesktopApi = { getNavigationQueueProjection: read, releaseNavigationQuery: release };
    const hook = renderHook(() => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected() }));
    const consumer = read.mock.calls[0]![1];
    expect(consumer).toMatch(/^queue-projection:/);
    hook.unmount();
    expect(release).toHaveBeenCalledWith(consumer);
    await act(async () => pending.resolve(page()));
  });

  it("waits for the complete FIFO even when no draft store is mounted", async () => {
    const pending = deferred<NavigationQueueProjection>();
    const read = vi.fn().mockResolvedValueOnce(page("owner", { complete: false, nextCursor: "next" }))
      .mockReturnValueOnce(pending.promise);
    const api = { getNavigationQueueProjection: read } as unknown as DesktopApi;
    const hook = renderHook(() => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected() }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(hook.result.current.readiness).toBe("loading");
    await act(async () => pending.resolve(page()));
    expect(hook.result.current.readiness).toBe("ready");
  });

  it("does not carry readiness or late data to a different owner with the same thread ID", async () => {
    const old = deferred<NavigationQueueProjection>();
    const next = deferred<NavigationQueueProjection>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const api = { getNavigationQueueProjection: read } as unknown as DesktopApi;
    const hook = renderHook(({ owner }) => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected(owner) }), {
      initialProps: { owner: "owner" },
    });
    hook.rerender({ owner: "other" });
    await act(async () => old.resolve(page()));
    expect(hook.result.current.readiness).toBe("loading");
    await act(async () => next.resolve(page("other")));
    expect(hook.result.current.projection?.ref.ownerInstanceId).toBe("other");
  });

  it("does not let selection reconcile an ambiguous legacy scope", async () => {
    const store = {
      getQueuedScopeKeys: () => ["thread:codex:same"],
      getScopeOwner: () => ({ backend: "codex", threadId: "same", target: { scope: "remote", instanceId: "owner" } }),
      get: () => ({ threadOwner: { backend: "codex", threadId: "same", target: { scope: "remote", instanceId: "other" } } }),
      getQueuedTurns: () => [], setQueuedTurns: vi.fn(), subscribeQueuedTurns: () => () => {},
    } as unknown as ComposerDraftStore;
    const read = vi.fn().mockResolvedValue(page());
    const api = { getNavigationQueueProjection: read } as unknown as DesktopApi;
    const hook = renderHook(() => useIndependentQueueProjection({ desktopApi: api, composerDraftStore: store, selectedThread: selected() }));
    await waitFor(() => expect(hook.result.current.readiness).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.setQueuedTurns).not.toHaveBeenCalled();
  });

  it("recovers the demanded FIFO on reconnect without waiting for the periodic refresh", async () => {
    vi.useFakeTimers();
    let listener!: (event: AgentEvent) => void;
    const read = vi.fn().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue(page());
    const api: DesktopApi = { getNavigationQueueProjection: read, onAgentEvent: (next) => { listener = next; return () => {}; } };
    const hook = renderHook(() => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected() }));
    try {
      await act(async () => {});
      expect(hook.result.current.readiness).toBe("failed");
      const publish = (instanceId: string, status: string) => listener({ backend: "codex",
        notification: { method: "federation/peerStatus/changed", params: { instanceId, status } },
      } as AgentEvent);
      await act(async () => {
        publish("unrelated", "connected");
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(read).toHaveBeenCalledTimes(1);
      await act(async () => {
        publish("owner", "disconnected");
        publish("owner", "connected");
        publish("owner", "connected");
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(read).toHaveBeenCalledTimes(2);
      expect(hook.result.current.readiness).toBe("ready");
      await act(async () => { publish("owner", "connected"); await vi.advanceTimersByTimeAsync(250); });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      hook.unmount();
      vi.useRealTimers();
    }
  });

  it("keeps independent card consumers subscribed and refreshes on compact queue invalidation", async () => {
    vi.useFakeTimers();
    const listeners = new Set<(event: AgentEvent) => void>();
    const subscribe = vi.fn(async () => ({ subscriptions: [] }));
    const read = vi.fn(async () => page());
    const api: DesktopApi = {
      getNavigationQueueProjection: read, setFederationEventSubscriptions: subscribe,
      onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const first = renderHook(() => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected() }));
    const second = renderHook(() => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected() }));
    try {
      await act(async () => {});
      const requests = subscribe.mock.calls as unknown as Array<[{ consumerInstanceId: string; subscriptions: unknown[] }]>;
      expect(requests[0]![0].consumerInstanceId).not.toBe(requests[1]![0].consumerInstanceId);
      expect(requests[0]![0]).toMatchObject({ consumer: "queue_projection", subscriptions: [{
        sourceInstanceId: "owner", eventClasses: ["navigation"],
        threadSelection: { kind: "threads", threads: [{ backend: "codex", threadId: "same" }] },
      }] });
      first.unmount();
      expect(requests.at(-1)![0]).toMatchObject({ consumerInstanceId: requests[0]![0].consumerInstanceId, subscriptions: [] });
      const before = read.mock.calls.length;
      await act(async () => {
        for (const listener of listeners) listener({ backend: "codex", federationTarget: { scope: "remote", instanceId: "owner" },
          notification: { method: "navigation/invalidated", params: { sourceMethod: "thread/turnQueue/updated", threadId: "same" } },
        });
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(read).toHaveBeenCalledTimes(before + 1);
    } finally {
      first.unmount(); second.unmount(); vi.useRealTimers();
    }
    expect(navigationQueueBaselineBudget.usage()).toEqual({ retainedBytes: 0, transientBytes: 0 });
  });

  it("rejects aggregate FIFO retention without publishing an empty authoritative queue", async () => {
    const occupied = navigationQueueBaselineBudget.begin("another-window");
    occupied.reserve(8 * 1024 * 1024); occupied.commit();
    const api: DesktopApi = { getNavigationQueueProjection: vi.fn(async () => page()) };
    const hook = renderHook(() => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected() }));
    try {
      await waitFor(() => expect(hook.result.current.readiness).toBe("failed"));
      expect(hook.result.current.error).toContain("retained byte budget");
      expect(hook.result.current.projection).toBeUndefined();
      navigationQueueBaselineBudget.release("another-window");
      await act(async () => { await hook.result.current.refresh(); });
      expect(hook.result.current.readiness).toBe("ready");
    } finally { hook.unmount(); navigationQueueBaselineBudget.release("another-window"); }
    expect(navigationQueueBaselineBudget.usage()).toEqual({ retainedBytes: 0, transientBytes: 0 });
  });

  it("reports unavailable owner reads as failed instead of an empty ready FIFO", async () => {
    const api = { getNavigationQueueProjection: vi.fn().mockRejectedValue(new Error("Disconnected")) } as unknown as DesktopApi;
    const hook = renderHook(() => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected() }));
    await waitFor(() => expect(hook.result.current.readiness).toBe("failed"));
    expect(hook.result.current.error).toBe("Disconnected");
    expect(hook.result.current.projection).toBeUndefined();
  });
});
