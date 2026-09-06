import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationQueueProjection, NavigationThreadSummary } from "@pwragent/shared";
import type { ComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import type { DesktopApi } from "../desktop-api";
import { useIndependentQueueProjection } from "../useIndependentQueueProjection";

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

  it("reports unavailable owner reads as failed instead of an empty ready FIFO", async () => {
    const api = { getNavigationQueueProjection: vi.fn().mockRejectedValue(new Error("Disconnected")) } as unknown as DesktopApi;
    const hook = renderHook(() => useIndependentQueueProjection({ desktopApi: api, selectedThread: selected() }));
    await waitFor(() => expect(hook.result.current.readiness).toBe("failed"));
    expect(hook.result.current.error).toBe("Disconnected");
    expect(hook.result.current.projection).toBeUndefined();
  });
});
