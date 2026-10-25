import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getAppMetrics: () => [{ pid: 4242, cpu: { percentCPUUsage: 0 } }] },
}));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info: mocks.info, warn: mocks.warn, error: mocks.error }),
}));
import {
  MAIN_WINDOW_APPEAR_TIMEOUT_MS,
  watchMainWindowStartup,
} from "../main-window-startup-watchdog";

class FakeContents extends EventEmitter {
  reload = vi.fn();
  getOSProcessId = () => 4242;
  getURL = () => "file:///index.html";
  isLoading = () => true;
  isWaitingForResponse = () => false;
  isCrashed = () => false;
}
class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  destroyed = false;
  isDestroyed = () => this.destroyed;
}

let window: FakeWindow;
let shown: boolean;
let show: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  window = new FakeWindow();
  shown = false;
  show = vi.fn<() => void>(() => { shown = true; });
  watchMainWindowStartup(window as unknown as BrowserWindow, {
    isShown: () => shown,
    show,
  });
});
afterEach(() => {
  vi.useRealTimers();
  mocks.info.mockReset();
  mocks.warn.mockReset();
  mocks.error.mockReset();
});

it("does nothing when the window appears on its own", async () => {
  window.webContents.emit("did-start-loading");
  window.webContents.emit("dom-ready");
  window.emit("ready-to-show");
  shown = true;
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS * 3);
  expect(show).not.toHaveBeenCalled();
  expect(window.webContents.reload).not.toHaveBeenCalled();
  expect(mocks.warn).not.toHaveBeenCalled();
});

// 1.3.2 kept a main window hidden for minutes: its first load never finished,
// so ready-to-show never fired, and nothing was logged.
it("logs, reloads once, and shows a window whose page never parsed", async () => {
  window.webContents.emit("did-start-loading");
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS - 1);
  expect(show).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.warn).toHaveBeenCalledWith(
    "main window has not appeared; showing it",
    expect.objectContaining({
      reloading: true,
      rendererPid: 4242,
      rendererCpuPercent: 0,
      milestones: { "did-start-loading": 0 },
    }),
  );
  expect(window.webContents.reload).toHaveBeenCalledOnce();
  expect(show).toHaveBeenCalledOnce();

  // Still not loaded after the reload: say so, but never reload in a loop.
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS * 3);
  expect(mocks.error).toHaveBeenCalledWith(
    "main window has not loaded after a reload",
    expect.objectContaining({ sinceReloadMs: MAIN_WINDOW_APPEAR_TIMEOUT_MS }),
  );
  expect(window.webContents.reload).toHaveBeenCalledOnce();
});

it("stays quiet when the reload loads", async () => {
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS);
  window.webContents.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS);
  expect(mocks.error).not.toHaveBeenCalled();
});

// macOS can hold back the first paint while the session is locked. A page
// that loaded is shown, not reloaded.
it("shows a loaded page that never painted without reloading it", async () => {
  window.webContents.emit("did-start-loading");
  window.webContents.emit("dom-ready");
  window.webContents.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS);
  expect(show).toHaveBeenCalledOnce();
  expect(window.webContents.reload).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledWith(
    "main window has not appeared; showing it",
    expect.objectContaining({ reloading: false }),
  );
});

it("logs a hung renderer", () => {
  window.webContents.emit("unresponsive");
  expect(mocks.warn).toHaveBeenCalledWith(
    "main window renderer unresponsive",
    expect.objectContaining({ rendererPid: 4242 }),
  );
});

it("stops watching a window that closes", async () => {
  window.destroyed = true;
  window.emit("closed");
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS * 2);
  expect(show).not.toHaveBeenCalled();
  expect(window.webContents.reload).not.toHaveBeenCalled();
});
