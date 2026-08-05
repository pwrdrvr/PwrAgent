import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  APP_WINDOW_TITLE,
  lockMainWindowTitle,
  mainWindowTitle,
} from "../main-window-title";

type TestBrowserWindow = BrowserWindow & {
  emitPageTitleUpdated: (title: string) => { defaultPrevented: boolean };
  setTitleMock: ReturnType<typeof vi.fn>;
};

function createWindow(): TestBrowserWindow {
  const windowListeners = new Map<
    string,
    Array<(event: { preventDefault: () => void }, title: string) => void>
  >();
  const setTitleMock = vi.fn();

  const window = {
    emitPageTitleUpdated: (title: string) => {
      let defaultPrevented = false;
      const event = {
        preventDefault: () => {
          defaultPrevented = true;
        },
      };
      for (const listener of windowListeners.get("page-title-updated") ?? []) {
        listener(event, title);
      }

      return { defaultPrevented };
    },
    setTitleMock,
    on: vi.fn(
      (
        event: string,
        listener: (
          event: { preventDefault: () => void },
          title: string,
        ) => void,
      ) => {
        windowListeners.set(event, [
          ...(windowListeners.get(event) ?? []),
          listener,
        ]);
      },
    ),
    setTitle: setTitleMock,
  };

  return window as unknown as TestBrowserWindow;
}

describe("mainWindowTitle", () => {
  it("titles the local window with the product name", () => {
    expect(mainWindowTitle()).toBe("PwrAgent");
    expect(APP_WINDOW_TITLE).toBe("PwrAgent");
  });

  it("appends the peer label for a remote window", () => {
    expect(mainWindowTitle("Harold-MBP-2018")).toBe(
      "PwrAgent - Harold-MBP-2018",
    );
  });

  it("falls back to the bare product name for a blank label", () => {
    expect(mainWindowTitle("")).toBe("PwrAgent");
    expect(mainWindowTitle("   ")).toBe("PwrAgent");
  });
});

describe("lockMainWindowTitle", () => {
  it("applies the title immediately", () => {
    const window = createWindow();

    lockMainWindowTitle(window, "PwrAgent");

    expect(window.setTitleMock).toHaveBeenCalledWith("PwrAgent");
  });

  it("refuses the renderer document title on the local window", () => {
    // Regression: index.html shipped a stale <title>PwrAgnt</title> that
    // Electron mirrored onto the window on load, so every local window
    // read the pre-rename spelling no matter what main passed at
    // construction.
    const window = createWindow();

    lockMainWindowTitle(window, "PwrAgent");
    const { defaultPrevented } = window.emitPageTitleUpdated("PwrAgnt");

    expect(defaultPrevented).toBe(true);
    expect(window.setTitleMock).toHaveBeenLastCalledWith("PwrAgent");
    expect(window.setTitleMock).not.toHaveBeenCalledWith("PwrAgnt");
  });

  it("keeps a remote window's peer label", () => {
    const window = createWindow();

    lockMainWindowTitle(window, mainWindowTitle("Harold-MBP-2018"));
    const { defaultPrevented } = window.emitPageTitleUpdated("PwrAgent");

    expect(defaultPrevented).toBe(true);
    expect(window.setTitleMock).toHaveBeenLastCalledWith(
      "PwrAgent - Harold-MBP-2018",
    );
  });
});
