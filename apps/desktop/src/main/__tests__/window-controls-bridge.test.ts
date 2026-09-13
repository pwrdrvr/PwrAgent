import { describe, expect, it, vi } from "vitest";
import {
  applyWindowControl,
  type ControllableWindow,
} from "../window-controls-bridge";

function windowStub(
  overrides: Partial<{ destroyed: boolean; maximized: boolean }> = {},
) {
  return {
    isDestroyed: () => overrides.destroyed ?? false,
    isMaximized: () => overrides.maximized ?? false,
    minimize: vi.fn<() => void>(),
    maximize: vi.fn<() => void>(),
    unmaximize: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
  } satisfies ControllableWindow;
}

/**
 * The Linux caption buttons' one path to the window. Everything here is pure
 * dispatch over an injected window slice, because the platform that runs it is
 * not the platform this suite runs on.
 */
describe("window controls bridge", () => {
  it("minimizes", () => {
    const window = windowStub();
    applyWindowControl(window, "minimize");

    expect(window.minimize).toHaveBeenCalledTimes(1);
  });

  it("maximizes a restored window and restores a maximized one", () => {
    const restored = windowStub({ maximized: false });
    applyWindowControl(restored, "toggle-maximize");
    expect(restored.maximize).toHaveBeenCalledTimes(1);
    expect(restored.unmaximize).not.toHaveBeenCalled();

    const maximized = windowStub({ maximized: true });
    applyWindowControl(maximized, "toggle-maximize");
    expect(maximized.unmaximize).toHaveBeenCalledTimes(1);
    expect(maximized.maximize).not.toHaveBeenCalled();
  });

  it("closes", () => {
    const window = windowStub();
    applyWindowControl(window, "close");

    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it("ignores an action it does not know", () => {
    // This arrives over IPC. `close()` is not something to reach by falling
    // through a switch, so the default case has to do nothing rather than
    // pick the last branch — including for the shapes a renderer would never
    // send but a compromised one could.
    const window = windowStub();
    for (const action of [
      undefined,
      null,
      "",
      "quit",
      "destroy",
      42,
      { action: "close" },
      ["close"],
    ]) {
      applyWindowControl(window, action);
    }

    expect(window.minimize).not.toHaveBeenCalled();
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.unmaximize).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });

  it("touches nothing on a destroyed window", () => {
    // A click can land after the window is gone — the renderer's frame is
    // still up while main tears the window down.
    const window = windowStub({ destroyed: true });
    for (const action of ["minimize", "toggle-maximize", "close"]) {
      applyWindowControl(window, action);
    }

    expect(window.minimize).not.toHaveBeenCalled();
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });
});
