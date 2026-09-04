// Opening the Star Map manager from the map.
//
// The interesting case is the first one: a freshly created manager exists in
// the main process before it exists in this window's navigation snapshot, so
// the card cannot be opened until the refresh lands. Getting that wrong shows
// the operator a button that appears to do nothing.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useStarMapManager } from "../useStarMapManager";

function thread(id: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt: 1,
  } as unknown as NavigationThreadSummary;
}

function api(
  openStarMapManager: DesktopApi["openStarMapManager"],
): DesktopApi {
  return { openStarMapManager } as unknown as DesktopApi;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useStarMapManager", () => {
  it("opens a card on a manager thread this window already knows", async () => {
    const openThread = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useStarMapManager({
        desktopApi: api(async () => ({
          status: "ready",
          backend: "codex",
          threadId: "manager-1",
          created: false,
        })),
        threads: [thread("manager-1")],
        openThread,
        onError,
      }),
    );
    act(() => result.current.open());
    await waitFor(() => expect(openThread).toHaveBeenCalledTimes(1));
    expect(openThread.mock.calls[0][0].id).toBe("manager-1");
    expect(result.current.busy).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("waits for a freshly created thread to arrive before opening its card", async () => {
    const openThread = vi.fn();
    const onRefreshLocalThreads = vi.fn();
    const onError = vi.fn();
    const { rerender, result } = renderHook(
      (props: { threads: NavigationThreadSummary[] }) =>
        useStarMapManager({
          desktopApi: api(async () => ({
            status: "ready",
            backend: "codex",
            threadId: "manager-new",
            created: true,
          })),
          threads: props.threads,
          openThread,
          onRefreshLocalThreads,
          onError,
        }),
      { initialProps: { threads: [] as NavigationThreadSummary[] } },
    );
    act(() => result.current.open());
    await waitFor(() => expect(onRefreshLocalThreads).toHaveBeenCalled());
    // Nothing to open yet: the summary the card needs is still in flight.
    expect(openThread).not.toHaveBeenCalled();

    rerender({ threads: [thread("manager-new")] });
    await waitFor(() => expect(openThread).toHaveBeenCalledTimes(1));
    expect(result.current.busy).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops waiting, and says so, when the thread never arrives", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useStarMapManager({
        desktopApi: api(async () => ({
          status: "ready",
          backend: "codex",
          threadId: "manager-new",
          created: true,
        })),
        threads: [],
        openThread: vi.fn(),
        onError,
      }),
    );
    act(() => result.current.open());
    await waitFor(() => expect(result.current.busy).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(result.current.busy).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/try again/i));
  });

  it("surfaces a main-process failure instead of spinning", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useStarMapManager({
        desktopApi: api(async () => ({
          status: "failed",
          error: "no backend configured",
        })),
        threads: [],
        openThread: vi.fn(),
        onError,
      }),
    );
    act(() => result.current.open());
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("no backend configured"),
    );
    // Reported through the map's single banner, and the button is usable
    // again rather than stuck on "Opening…".
    expect(result.current.busy).toBe(false);
  });

  it("ignores a second click while the first is still resolving", async () => {
    const onError = vi.fn();
    const openStarMapManager = vi.fn(
      async () =>
        await new Promise<never>(() => {
          // Never settles: the point is that the second click is dropped.
        }),
    );
    const { result } = renderHook(() =>
      useStarMapManager({
        desktopApi: api(openStarMapManager as never),
        threads: [],
        openThread: vi.fn(),
        onError,
      }),
    );
    act(() => result.current.open());
    act(() => result.current.open());
    expect(openStarMapManager).toHaveBeenCalledTimes(1);
  });
});
