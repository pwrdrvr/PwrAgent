import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown) => void>();
  const resized = { isEmpty: () => false };
  return {
    listeners,
    resized,
    resize: vi.fn(() => resized),
    createFromPath: vi.fn(),
  };
});

const logMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn((channel: string, listener: (event: unknown) => void) => {
      electronMocks.listeners.set(channel, listener);
    }),
    removeAllListeners: vi.fn((channel: string) => {
      electronMocks.listeners.delete(channel);
    }),
  },
  nativeImage: {
    createFromPath: electronMocks.createFromPath,
  },
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => logMocks),
}));

describe("app icon drag", () => {
  let resourcesDir: string;

  beforeEach(() => {
    resourcesDir = mkdtempSync(join(tmpdir(), "pwragent-icon-drag-"));
    electronMocks.listeners.clear();
    electronMocks.createFromPath.mockReset();
    electronMocks.createFromPath.mockReturnValue({ resize: electronMocks.resize });
    electronMocks.resize.mockClear();
    logMocks.warn.mockClear();
  });

  afterEach(() => {
    rmSync(resourcesDir, { recursive: true, force: true });
    // Only Electron defines it; Node's process has none to restore.
    delete (process as { resourcesPath?: string }).resourcesPath;
  });

  it("prefers the packaged icon, and falls back to the checkout's master", async () => {
    const { resolvePwragentAppIconPath } = await import("../ipc/app-icon-drag");
    const packaged = join(resourcesDir, "pwragent-app-icon.png");
    writeFileSync(packaged, "png");

    expect(resolvePwragentAppIconPath(resourcesDir)).toBe(packaged);
    // No packaged copy: the dev build's `build/icon.png`, which this
    // checkout has.
    rmSync(packaged);
    expect(resolvePwragentAppIconPath(resourcesDir)).toMatch(/build[/\\]icon\.png$/u);
    // Outside Electron there is no resourcesPath at all.
    expect(resolvePwragentAppIconPath(undefined)).toMatch(/build[/\\]icon\.png$/u);
  });

  it("starts an OS file drag of the icon from the sender", async () => {
    const { registerAppIconDragIpcHandlers, disposeAppIconDragIpcHandlers } = await import(
      "../ipc/app-icon-drag"
    );
    const { SETTINGS_START_APP_ICON_DRAG_CHANNEL } = await import("../../shared/ipc");
    const packaged = join(resourcesDir, "pwragent-app-icon.png");
    writeFileSync(packaged, "png");
    (process as { resourcesPath?: string }).resourcesPath = resourcesDir;

    registerAppIconDragIpcHandlers();
    const startDrag = vi.fn();
    electronMocks.listeners.get(SETTINGS_START_APP_ICON_DRAG_CHANNEL)?.({
      sender: { startDrag },
    });

    expect(electronMocks.createFromPath).toHaveBeenCalledWith(packaged);
    // macOS refuses a drag with an empty image.
    expect(electronMocks.resize).toHaveBeenCalledWith({ width: 64, height: 64 });
    expect(startDrag).toHaveBeenCalledExactlyOnceWith({
      file: packaged,
      icon: electronMocks.resized,
    });

    disposeAppIconDragIpcHandlers();
    expect(electronMocks.listeners.has(SETTINGS_START_APP_ICON_DRAG_CHANNEL)).toBe(false);
  });
});
