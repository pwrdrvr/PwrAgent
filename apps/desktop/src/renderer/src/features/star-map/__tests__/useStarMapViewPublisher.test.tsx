// The publish throttle.
//
// This hook sits on the drag path: a card being moved re-renders the map on
// every frame. What has to hold is that the publish rate stays bounded, and
// that the last publish inside a burst carries where the card LANDED, not
// where it was picked up.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StarMapViewSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { StarMapViewSnapshotInput } from "../star-map-view-snapshot";
import {
  STAR_MAP_VIEW_PUBLISH_INTERVAL_MS,
  useStarMapViewPublisher,
} from "../useStarMapViewPublisher";

function input(cameraX: number): StarMapViewSnapshotInput {
  return {
    surface: "window",
    layout: "orbit",
    camera: { x: cameraX, y: 0, scale: 1 },
    viewport: { width: 1280, height: 800 },
    filterSelection: {},
    hideOfflineInstances: false,
    hiddenInstanceCount: 0,
    matchedThreadCount: 0,
    localInstanceId: "local",
    threadsByInstance: new Map(),
    instanceLabels: new Map(),
    cardRects: new Map(),
    selection: new Set(),
    openChatCardThreadKeys: new Set(),
    now: 1,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useStarMapViewPublisher", () => {
  it("publishes the first view straight away", () => {
    const publishStarMapView = vi.fn(
      async (_snapshot: StarMapViewSnapshot) => undefined,
    );
    renderHook(() =>
      useStarMapViewPublisher({
        desktopApi: { publishStarMapView } as unknown as DesktopApi,
        input: input(0),
      }),
    );
    expect(publishStarMapView).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into one trailing publish carrying the last input", () => {
    const publishStarMapView = vi.fn(
      async (_snapshot: StarMapViewSnapshot) => undefined,
    );
    const { rerender } = renderHook(
      (props: { input: StarMapViewSnapshotInput }) =>
        useStarMapViewPublisher({
          desktopApi: { publishStarMapView } as unknown as DesktopApi,
          input: props.input,
        }),
      { initialProps: { input: input(0) } },
    );
    publishStarMapView.mockClear();

    for (let frame = 1; frame <= 30; frame += 1) {
      rerender({ input: input(frame) });
    }
    expect(publishStarMapView).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(STAR_MAP_VIEW_PUBLISH_INTERVAL_MS);
    });
    expect(publishStarMapView).toHaveBeenCalledTimes(1);
    const snapshot = publishStarMapView.mock.calls[0][0];
    // Where the drag ended, not where it started.
    expect(snapshot.camera.x).toBe(30);
  });

  it("does not publish again while the map sits still", () => {
    const publishStarMapView = vi.fn(
      async (_snapshot: StarMapViewSnapshot) => undefined,
    );
    renderHook(() =>
      useStarMapViewPublisher({
        desktopApi: { publishStarMapView } as unknown as DesktopApi,
        input: input(0),
      }),
    );
    publishStarMapView.mockClear();
    act(() => {
      vi.advanceTimersByTime(STAR_MAP_VIEW_PUBLISH_INTERVAL_MS * 10);
    });
    expect(publishStarMapView).not.toHaveBeenCalled();
  });

  it("drops a pending publish when the map unmounts", () => {
    const publishStarMapView = vi.fn(
      async (_snapshot: StarMapViewSnapshot) => undefined,
    );
    const { rerender, unmount } = renderHook(
      (props: { input: StarMapViewSnapshotInput }) =>
        useStarMapViewPublisher({
          desktopApi: { publishStarMapView } as unknown as DesktopApi,
          input: props.input,
        }),
      { initialProps: { input: input(0) } },
    );
    rerender({ input: input(1) });
    publishStarMapView.mockClear();
    unmount();
    act(() => {
      vi.advanceTimersByTime(STAR_MAP_VIEW_PUBLISH_INTERVAL_MS);
    });
    expect(publishStarMapView).not.toHaveBeenCalled();
  });

  it("stays inert when the host exposes no publish channel", () => {
    expect(() =>
      renderHook(() =>
        useStarMapViewPublisher({ desktopApi: {} as DesktopApi, input: input(0) }),
      ),
    ).not.toThrow();
  });

  it("swallows a failed publish rather than surfacing it as an error", async () => {
    const publishStarMapView = vi.fn(async (_snapshot: StarMapViewSnapshot) => {
      throw new Error("no listener");
    });
    expect(() =>
      renderHook(() =>
        useStarMapViewPublisher({
          desktopApi: { publishStarMapView } as unknown as DesktopApi,
          input: input(0),
        }),
      ),
    ).not.toThrow();
    await vi.runAllTimersAsync();
  });
});
