import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetWindowFrameForTests,
  isWindowMaximized,
  startWindowFrameSync,
  subscribeWindowFrame,
} from "../window-frame";

type Listener = (maximized: boolean) => void;

function stubDesktopApi(): { emit: Listener; unsubscribe: ReturnType<typeof vi.fn> } {
  let emit: Listener = () => {};
  const unsubscribe = vi.fn();
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: {
      platform: "linux",
      onWindowFrameState: (callback: Listener) => {
        emit = callback;
        return unsubscribe;
      },
    },
  });
  return {
    emit: (maximized: boolean) => emit(maximized),
    unsubscribe,
  };
}

afterEach(() => {
  __resetWindowFrameForTests();
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: undefined,
  });
});

describe("window frame state", () => {
  it("stamps the restored default before anything arrives", () => {
    // The hairline paints on the first frame, so the attribute cannot wait
    // for an IPC round trip.
    stubDesktopApi();
    startWindowFrameSync("linux");

    expect(document.documentElement.dataset.windowFrame).toBe("restored");
    expect(isWindowMaximized()).toBe(false);
  });

  it("follows main's pushes in both directions", () => {
    const api = stubDesktopApi();
    startWindowFrameSync("linux");

    api.emit(true);
    expect(document.documentElement.dataset.windowFrame).toBe("maximized");
    expect(isWindowMaximized()).toBe(true);

    api.emit(false);
    expect(document.documentElement.dataset.windowFrame).toBe("restored");
    expect(isWindowMaximized()).toBe(false);
  });

  it("notifies subscribers only when the state actually changes", () => {
    // `did-finish-load` re-sends the state on every load and the window
    // manager can fire a redundant event, so a store that woke React on every
    // push would re-render the strip for nothing.
    const api = stubDesktopApi();
    startWindowFrameSync("linux");
    const listener = vi.fn();
    const unsubscribe = subscribeWindowFrame(listener);

    api.emit(false);
    expect(listener).not.toHaveBeenCalled();

    api.emit(true);
    expect(listener).toHaveBeenCalledTimes(1);

    api.emit(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    api.emit(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("subscribes once per window however often it is started", () => {
    const api = stubDesktopApi();
    startWindowFrameSync("linux");
    startWindowFrameSync("linux");

    api.emit(true);
    expect(isWindowMaximized()).toBe(true);
  });

  it("does nothing off Linux", () => {
    // macOS and Windows paint no hairline and draw no caption glyph from
    // this, so the subscription would be a per-window IPC listener feeding a
    // rule that cannot match. The attribute must stay absent, because the
    // hairline selector is `:not([data-window-frame="maximized"])` — a
    // "restored" stamp on macOS would be a match waiting for a platform typo.
    for (const platform of ["darwin", "win32"]) {
      stubDesktopApi();
      startWindowFrameSync(platform);

      expect(document.documentElement.dataset.windowFrame).toBeUndefined();
      __resetWindowFrameForTests();
    }
  });

  it("does nothing with no bridge at all", () => {
    // `main.tsx` passes the platform it read from the bridge, so an absent
    // bridge arrives here as `undefined` — which takes the default parameter,
    // NOT the linux branch. Worth its own case: the default reads the live
    // bridge, so passing `undefined` while one is present is genuinely not
    // the same as passing nothing.
    expect(() => startWindowFrameSync(undefined)).not.toThrow();

    expect(document.documentElement.dataset.windowFrame).toBeUndefined();
  });
});
