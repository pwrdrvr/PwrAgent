// The in-memory registry of published Star Map views.
//
// The behavior that matters here is what happens when a map surface goes
// away: a stale entry would answer an Agent's "what is on screen" with a
// window the operator closed, and the capture would target the wrong one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { StarMapViewSnapshot } from "@pwragent/shared";

const { fromWebContentsMock } = vi.hoisted(() => ({
  fromWebContentsMock: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: fromWebContentsMock },
}));

import {
  captureStarMapView,
  publishStarMapView,
  readStarMapView,
  resetStarMapViewRegistry,
} from "../star-map/star-map-view-registry";

function snapshot(surface: "window" | "in-app" = "window"): StarMapViewSnapshot {
  return {
    capturedAt: 1,
    surface,
    layout: "orbit",
    camera: { x: 0, y: 0, scale: 1 },
    viewport: { width: 100, height: 100 },
    filters: [],
    hideOfflineInstances: false,
    hiddenInstanceCount: 0,
    instances: [],
    clouds: [],
    threads: [],
    selectedThreadKeys: [],
    openChatCardThreadKeys: [],
    matchedThreadCount: 0,
  };
}

type FakeWebContents = WebContents & {
  destroy: () => void;
  capturePageMock: ReturnType<typeof vi.fn>;
};

function fakeWebContents(id: number): FakeWebContents {
  let destroyed = false;
  const listeners: Array<() => void> = [];
  const capturePageMock = vi.fn(async () => ({
    isEmpty: () => false,
    getSize: () => ({ width: 2_000, height: 1_000 }),
    resize: ({ width }: { width: number }) => ({
      isEmpty: () => false,
      getSize: () => ({ width, height: width / 2 }),
      toPNG: () => Buffer.from("resized"),
    }),
    toPNG: () => Buffer.from("full"),
  }));
  return {
    id,
    isDestroyed: () => destroyed,
    once: (_event: string, listener: () => void) => listeners.push(listener),
    capturePage: capturePageMock,
    capturePageMock,
    destroy: () => {
      destroyed = true;
      for (const listener of listeners) listener();
    },
  } as unknown as FakeWebContents;
}

beforeEach(() => {
  resetStarMapViewRegistry();
  fromWebContentsMock.mockReset();
});

describe("star map view registry", () => {
  it("serves the most recently published view", () => {
    const first = fakeWebContents(1);
    const second = fakeWebContents(2);
    publishStarMapView({
      snapshot: snapshot("window"),
      webContents: first,
      now: 10,
    });
    publishStarMapView({
      snapshot: snapshot("in-app"),
      webContents: second,
      now: 20,
    });
    expect(readStarMapView()?.surface).toBe("in-app");
  });

  it("forgets a surface once its renderer is gone", () => {
    const contents = fakeWebContents(1);
    publishStarMapView({ snapshot: snapshot(), webContents: contents, now: 10 });
    expect(readStarMapView()).toBeDefined();
    contents.destroy();
    // A closed map has no on-screen state, and reporting its last frame
    // would be indistinguishable from reporting a live one.
    expect(readStarMapView()).toBeUndefined();
  });

  it("falls back to an older live surface when the newest one closed", () => {
    const older = fakeWebContents(1);
    const newer = fakeWebContents(2);
    publishStarMapView({ snapshot: snapshot("window"), webContents: older, now: 10 });
    publishStarMapView({ snapshot: snapshot("in-app"), webContents: newer, now: 20 });
    newer.destroy();
    expect(readStarMapView()?.surface).toBe("window");
  });

  it("ignores a publish from an already destroyed renderer", () => {
    const contents = fakeWebContents(1);
    contents.destroy();
    publishStarMapView({ snapshot: snapshot(), webContents: contents, now: 10 });
    expect(readStarMapView()).toBeUndefined();
  });

  it("captures the surface that published, and downscales it", async () => {
    const contents = fakeWebContents(1);
    publishStarMapView({ snapshot: snapshot(), webContents: contents, now: 10 });
    fromWebContentsMock.mockReturnValue({ isDestroyed: () => false });
    const capture = await captureStarMapView({ maxWidth: 800 });
    expect(capture?.width).toBe(800);
    expect(capture?.png.toString()).toBe("resized");
  });

  it("captures at full size when it is already under the cap", async () => {
    const contents = fakeWebContents(1);
    publishStarMapView({ snapshot: snapshot(), webContents: contents, now: 10 });
    fromWebContentsMock.mockReturnValue({ isDestroyed: () => false });
    const capture = await captureStarMapView({ maxWidth: 4_000 });
    expect(capture?.width).toBe(2_000);
    expect(capture?.png.toString()).toBe("full");
  });

  it("returns nothing rather than throwing when the capture fails", async () => {
    const contents = fakeWebContents(1);
    contents.capturePageMock.mockRejectedValueOnce(new Error("no display"));
    publishStarMapView({ snapshot: snapshot(), webContents: contents, now: 10 });
    fromWebContentsMock.mockReturnValue({ isDestroyed: () => false });
    await expect(captureStarMapView()).resolves.toBeUndefined();
  });

  it("captures nothing when no map has published", async () => {
    await expect(captureStarMapView()).resolves.toBeUndefined();
  });
});
