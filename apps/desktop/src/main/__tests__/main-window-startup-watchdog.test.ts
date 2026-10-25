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
  isDestroyed = () => false;
  getOSProcessId = () => 4242;
  getURL = () => "file:///index.html";
  isLoading = () => true;
  isWaitingForResponse = () => false;
  isCrashed = () => false;
}
class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  destroyed = false;
  visible = false;
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
}

let window: FakeWindow;
let show: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  window = new FakeWindow();
  show = vi.fn<() => void>(() => { window.visible = true; });
  watchMainWindowStartup(window as unknown as BrowserWindow, { show });
});
afterEach(() => {
  vi.useRealTimers();
  mocks.info.mockReset();
  mocks.warn.mockReset();
  mocks.error.mockReset();
});

it("stays quiet about a window that appeared on its own", async () => {
  window.webContents.emit("did-start-loading");
  window.webContents.emit("dom-ready");
  window.emit("ready-to-show");
  window.visible = true;
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS * 3);
  expect(window.webContents.reload).not.toHaveBeenCalled();
  expect(mocks.warn).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
});

// 1.3.2 kept a main window hidden for minutes: its first load never finished,
// so ready-to-show never fired, and nothing was logged.
it("reloads a page that never parsed and shows it once the reload loads", async () => {
  window.webContents.emit("did-start-loading");
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS - 1);
  expect(window.webContents.reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.warn).toHaveBeenCalledWith(
    "main window page has not loaded; reloading it",
    expect.objectContaining({
      visible: false,
      rendererPid: 4242,
      rendererCpuPercent: 0,
      milestones: { "did-start-loading": 0 },
    }),
  );
  expect(window.webContents.reload).toHaveBeenCalledOnce();
  // Federation viewers treat `show` as "the renderer is ready", so the window
  // waits for the reload rather than appearing over a page that is reloading.
  expect(show).not.toHaveBeenCalled();

  window.webContents.emit("did-finish-load");
  expect(show).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS * 3);
  expect(mocks.error).not.toHaveBeenCalled();
  expect(window.webContents.reload).toHaveBeenCalledOnce();
});

it("shows the window anyway, once, when the reload stalls too", async () => {
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS);
  expect(show).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS);
  expect(mocks.error).toHaveBeenCalledWith(
    "main window has not loaded after a reload; showing it",
    expect.objectContaining({ timeoutMs: MAIN_WINDOW_APPEAR_TIMEOUT_MS }),
  );
  expect(show).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS * 3);
  expect(window.webContents.reload).toHaveBeenCalledOnce();
});

// Settings shows the main window directly. A stalled page on screen still
// needs the reload, and the log must not say the window is hidden.
it("reloads a stalled page that something else already showed", async () => {
  window.visible = true;
  await vi.advanceTimersByTimeAsync(MAIN_WINDOW_APPEAR_TIMEOUT_MS);
  expect(window.webContents.reload).toHaveBeenCalledOnce();
  expect(mocks.warn).toHaveBeenCalledWith(
    "main window page has not loaded; reloading it",
    expect.objectContaining({ visible: true }),
  );
  window.webContents.emit("did-finish-load");
  // window.ts's show is idempotent and delivers the initial thread.
  expect(show).toHaveBeenCalledOnce();
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
    expect.objectContaining({ visible: false }),
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
