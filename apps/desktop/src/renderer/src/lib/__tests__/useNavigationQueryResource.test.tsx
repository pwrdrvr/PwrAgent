import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest, NavigationSelectedDetailResponse } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useNavigationQueryResource } from "../useNavigationQueryResource";
import { useNavigationSelectedDetail } from "../useNavigationSelectedDetail";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
function page(patch: Partial<NavigationQueryPage> = {}): NavigationQueryPage {
  return {
    protocol: 2, queryKey: "query", generation: "generation", ownerEpoch: "epoch",
    countsRevision: "revision", counts: { total: 200, active: 10, unread: 20, review: 10 },
    coverage: { state: "complete" }, entries: [], complete: false, nextCursor: "next", ...patch,
  };
}
const request: NavigationQueryRequest = {
  protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" }, pageSize: 10,
};

describe("bounded resource lifecycle", () => {
  it("leases one resource, coalesces reads, and releases hidden demand", async () => {
    const pending = deferred<NavigationQueryPage>();
    const read = vi.fn().mockReturnValue(pending.promise);
    const release = vi.fn().mockResolvedValue(undefined);
    const api = { getNavigationQueryPage: read, releaseNavigationQuery: release } as unknown as DesktopApi;
    const hook = renderHook(({ demand }) => useNavigationQueryResource({ desktopApi: api, request: demand }), {
      initialProps: { demand: request as NavigationQueryRequest | undefined },
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => { void hook.result.current.refresh(); void hook.result.current.refresh(); });
    expect(read).toHaveBeenCalledTimes(1);
    const token = read.mock.calls[0]![1];
    hook.rerender({ demand: undefined });
    expect(release).toHaveBeenCalledWith(token);
    await act(async () => pending.resolve(page()));
    expect(hook.result.current.state).toBeUndefined();
  });

  it("only sends unchanged revisions after all pages have arrived", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page({ complete: true, nextCursor: undefined }))
      .mockResolvedValueOnce(page({ complete: true, nextCursor: undefined, unchanged: true }));
    const api = { getNavigationQueryPage: read } as unknown as DesktopApi;
    const hook = renderHook(() => useNavigationQueryResource({ desktopApi: api, request }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(() => hook.result.current.loadMore());
    expect(read.mock.calls[1]![0]).toMatchObject({ cursor: "next", completeBaselineRevision: undefined });
    await act(() => hook.result.current.refresh());
    expect(read.mock.calls[2]![0]).toMatchObject({ completeBaselineRevision: "revision" });
    expect(hook.result.current.state?.page?.counts.total).toBe(200);
  });

  it("retains stale rows when a continuation fails instead of accepting another generation", async () => {
    const read = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page({ generation: "other" }));
    const api = { getNavigationQueryPage: read } as unknown as DesktopApi;
    const hook = renderHook(() => useNavigationQueryResource({ desktopApi: api, request }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(() => hook.result.current.loadMore());
    expect(hook.result.current.state?.stale).toBe(true);
    expect(hook.result.current.state?.page?.generation).toBe("generation");
  });

  it("never applies a late selected detail to the next identity", async () => {
    const pending = deferred<NavigationSelectedDetailResponse>();
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      protocol: 2, ref: { backend: "codex", threadId: "second" }, revision: "new", readiness: "ready", identity: "deleted",
    });
    const api = { getNavigationSelectedDetail: read } as unknown as DesktopApi;
    const hook = renderHook(({ threadId }) => useNavigationSelectedDetail({
      desktopApi: api, ref: { backend: "codex", threadId },
    }), { initialProps: { threadId: "first" } });
    hook.rerender({ threadId: "second" });
    await waitFor(() => expect(hook.result.current.state?.readiness).toBe("ready"));
    await act(async () => pending.resolve({
      protocol: 2, ref: { backend: "codex", threadId: "first" }, revision: "old", readiness: "ready", identity: "deleted",
    }));
    expect(hook.result.current.state?.ref.threadId).toBe("second");
    expect(hook.result.current.state?.detail?.revision).toBe("new");
  });

  it("requires authoritative configuration before selected detail becomes ready", async () => {
    const api = { getNavigationSelectedDetail: vi.fn().mockResolvedValue({
      protocol: 2, ref: { backend: "codex", threadId: "thread" }, revision: "revision", readiness: "ready", identity: "present",
    }) } as unknown as DesktopApi;
    const hook = renderHook(() => useNavigationSelectedDetail({ desktopApi: api, ref: { backend: "codex", threadId: "thread" } }));
    await waitFor(() => expect(hook.result.current.state?.readiness).toBe("failed"));
    expect(hook.result.current.state?.error).toContain("configuration is not ready");
  });
});
