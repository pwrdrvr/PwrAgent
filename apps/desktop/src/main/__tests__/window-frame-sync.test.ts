import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { WINDOW_FRAME_SYNC_CHANNEL } from "../../shared/ipc";
import {
  attachWindowFrameSync,
  installWindowFrameSync,
  type WindowCreatingApp,
} from "../window-frame-sync";

type Handler = () => void;

function windowStub(options: { maximized?: boolean; destroyed?: boolean } = {}) {
  const windowHandlers = new Map<string, Handler[]>();
  const contentsHandlers = new Map<string, Handler[]>();
  const send = vi.fn();
  const register = (map: Map<string, Handler[]>) => (event: string, handler: Handler) => {
    map.set(event, [...(map.get(event) ?? []), handler]);
  };

  const stub = {
    on: register(windowHandlers),
    isDestroyed: () => options.destroyed ?? false,
    isMaximized: () => options.maximized ?? false,
    webContents: { send, on: register(contentsHandlers) },
  };

  return {
    window: stub as unknown as BrowserWindow,
    send,
    fire: (event: string) => {
      for (const handler of windowHandlers.get(event) ?? []) handler();
    },
    fireOnContents: (event: string) => {
      for (const handler of contentsHandlers.get(event) ?? []) handler();
    },
  };
}

/**
 * Main's half of the Linux maximize state. The glyph and the painted window
 * hairline both draw from it, and the events it listens to are the only
 * account that stays honest when the window manager acts on its own.
 */
describe("window frame sync", () => {
  it("pushes the window's state on maximize and unmaximize", () => {
    const maximized = windowStub({ maximized: true });
    attachWindowFrameSync(maximized.window);
    maximized.fire("maximize");

    expect(maximized.send).toHaveBeenCalledWith(WINDOW_FRAME_SYNC_CHANNEL, {
      maximized: true,
    });

    const restored = windowStub({ maximized: false });
    attachWindowFrameSync(restored.window);
    restored.fire("unmaximize");

    expect(restored.send).toHaveBeenCalledWith(WINDOW_FRAME_SYNC_CHANNEL, {
      maximized: false,
    });
  });

  it("reads the window, not the event that woke it", () => {
    // A `maximize()` the window manager declines fires nothing, and Super+Up
    // fires `maximize` all the same — so the payload has to come from
    // `isMaximized()`. A handler that assumed "the maximize event means
    // maximized" would pass the test above and still be wrong here.
    const stub = windowStub({ maximized: false });
    attachWindowFrameSync(stub.window);
    stub.fire("maximize");

    expect(stub.send).toHaveBeenCalledWith(WINDOW_FRAME_SYNC_CHANNEL, {
      maximized: false,
    });
  });

  it("re-sends on every load", () => {
    // The renderer can mount after the transition: a window restored
    // maximized, a dev HMR reload, a renderer-crash reload that keeps the same
    // BrowserWindow. Without this the hairline paints on a maximized window.
    const stub = windowStub({ maximized: true });
    attachWindowFrameSync(stub.window);
    stub.fireOnContents("did-finish-load");

    expect(stub.send).toHaveBeenCalledWith(WINDOW_FRAME_SYNC_CHANNEL, {
      maximized: true,
    });
  });

  it("sends nothing to a destroyed window", () => {
    const stub = windowStub({ destroyed: true });
    attachWindowFrameSync(stub.window);
    stub.fire("maximize");
    stub.fireOnContents("did-finish-load");

    expect(stub.send).not.toHaveBeenCalled();
  });

  it("tolerates a window that cannot subscribe", () => {
    expect(() =>
      attachWindowFrameSync({} as unknown as BrowserWindow),
    ).not.toThrow();
  });

  describe("installing it", () => {
    function appStub(): WindowCreatingApp & { on: ReturnType<typeof vi.fn> } {
      return { on: vi.fn() } as unknown as WindowCreatingApp & {
        on: ReturnType<typeof vi.fn>;
      };
    }

    it("subscribes every window on Linux, wherever it was created", () => {
      // A dozen modules in this directory create windows. The hairline is
      // painted by all of them, including the auxiliary windows that keep the
      // native frame and render no strip of ours, so this hooks the app rather
      // than each creator.
      const app = appStub();
      installWindowFrameSync(app, "linux");

      expect(app.on).toHaveBeenCalledWith(
        "browser-window-created",
        expect.any(Function),
      );

      const stub = windowStub({ maximized: true });
      const created = app.on.mock.calls[0]?.[1] as (
        event: unknown,
        window: BrowserWindow,
      ) => void;
      created({}, stub.window);
      stub.fire("maximize");

      expect(stub.send).toHaveBeenCalledWith(WINDOW_FRAME_SYNC_CHANNEL, {
        maximized: true,
      });
    });

    it("subscribes nothing anywhere else", () => {
      // macOS floats its stoplights and Windows fills a controls overlay, so
      // nothing there reads this: the subscription would be a per-window IPC
      // send feeding a CSS rule that cannot match.
      for (const platform of ["darwin", "win32"] as const) {
        const app = appStub();
        installWindowFrameSync(app, platform);

        expect(app.on).not.toHaveBeenCalled();
      }
    });
  });
});
