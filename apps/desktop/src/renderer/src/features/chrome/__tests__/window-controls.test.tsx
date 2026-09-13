import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowControls } from "../WindowControls";
import {
  __resetWindowFrameForTests,
  startWindowFrameSync,
} from "../../../lib/window-frame";

type Listener = (maximized: boolean) => void;

function stubBridge(platform: string): {
  runWindowControl: ReturnType<typeof vi.fn>;
  emit: (maximized: boolean) => void;
} {
  let emit: Listener = () => {};
  const runWindowControl = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: {
      platform,
      runWindowControl,
      onWindowFrameState: (callback: Listener) => {
        emit = callback;
        return () => {};
      },
    },
  });
  return {
    runWindowControl,
    emit: (maximized: boolean) => act(() => emit(maximized)),
  };
}

afterEach(() => {
  cleanup();
  __resetWindowFrameForTests();
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: undefined,
  });
});

describe("Linux caption buttons", () => {
  it("sends each action to main", () => {
    const bridge = stubBridge("linux");
    render(<WindowControls />);

    for (const [name, action] of [
      ["Minimize", "minimize"],
      ["Maximize", "toggle-maximize"],
      ["Close", "close"],
    ] as const) {
      screen.getByRole("button", { name }).click();
      expect(bridge.runWindowControl).toHaveBeenCalledWith(action);
    }
    expect(bridge.runWindowControl).toHaveBeenCalledTimes(3);
  });

  it("follows the window rather than its own click", () => {
    // The bug this prevents: a button that flips its own glyph reads
    // "Restore" after a `maximize()` the window manager declined, and stays
    // on "Maximize" after Super+Up. Clicking here changes nothing until main
    // reports back.
    const bridge = stubBridge("linux");
    startWindowFrameSync("linux");
    render(<WindowControls />);

    const button = () =>
      screen.getByRole("button", { name: /^(Maximize|Restore)$/ });

    expect(button()).toHaveAccessibleName("Maximize");

    act(() => button().click());
    expect(button()).toHaveAccessibleName("Maximize");

    // A maximize from anywhere — our button, a double-click on the drag
    // strip, Super+Up, a tiling keybind — arrives the same way.
    bridge.emit(true);
    expect(button()).toHaveAccessibleName("Restore");

    bridge.emit(false);
    expect(button()).toHaveAccessibleName("Maximize");
  });

  it("renders nothing where the OS draws the buttons", () => {
    for (const platform of ["darwin", "win32"]) {
      stubBridge(platform);
      const { container } = render(<WindowControls />);

      expect(container).toBeEmptyDOMElement();
      cleanup();
    }
  });

  it("survives a bridge with no control channel", () => {
    // The fatal app state and a preload that failed to expose the API both
    // reach here. A throwing click handler in the title strip would take the
    // window's only close button down with it.
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: { platform: "linux" },
    });
    render(<WindowControls />);

    expect(() => screen.getByRole("button", { name: "Close" }).click()).not.toThrow();
  });
});
