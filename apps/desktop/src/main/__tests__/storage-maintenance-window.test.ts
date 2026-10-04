import type { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { StateDb } from "../state/state-db";
import type { StorageMaintenanceCommand, StorageMaintenanceStatus } from "../../shared/storage-maintenance";
import { STORAGE_MAINTENANCE_CHANNEL } from "../../shared/storage-maintenance";
import { app } from "electron";
import * as storage from "../state/storage-maintenance";

type FakeWindow = EventEmitter & {
  webContents: { send: (...args: unknown[]) => void };
  close: () => void;
  setAlwaysOnTop: (value: boolean) => void;
};
type FakeWorker = EventEmitter & { kill: () => void; postMessage: (request: unknown) => void };
const fixture = vi.hoisted(() => ({
  windows: [] as FakeWindow[], workers: [] as FakeWorker[],
  handlers: new Map<string, (event: { sender: unknown }, command: StorageMaintenanceCommand) => Promise<StorageMaintenanceStatus>>(),
  otherInstance: false,
  record: { historyEnabled: true } as Record<string, unknown>,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    webContents = { send: vi.fn() };
    destroyed = false;
    setAlwaysOnTop = vi.fn();
    show = vi.fn();
    close = vi.fn(() => { this.destroyed = true; this.emit("closed"); });
    isDestroyed = () => this.destroyed;
    loadFile = async () => {};
    loadURL = async () => {};
    constructor() { super(); fixture.windows.push(this); }
  }
  return {
    app: new EventEmitter(),
    BrowserWindow: Window,
    ipcMain: { handle: (channel: string, handler: (event: { sender: unknown }, command: StorageMaintenanceCommand) => Promise<StorageMaintenanceStatus>) => fixture.handlers.set(channel, handler), removeHandler: (channel: string) => fixture.handlers.delete(channel) },
    utilityProcess: { fork: () => {
      const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
      worker.kill.mockImplementation(() => worker.emit("exit", 0));
      fixture.workers.push(worker);
      return worker;
    } },
  };
});
vi.mock("../profile", () => ({
  findLiveProfileRuntimeMarkers: () => fixture.otherInstance ? [{ processId: -1 }] : [],
  resolveActiveProfileName: () => "fixture",
  resolveActiveProfilePath: () => "/synthetic/state.db",
}));
vi.mock("../settings/appearance-bootstrap", () => ({ readBootstrapAppearance: () => ({ theme: "dark" }), themedWindowAdditionalArguments: () => [] }));
vi.mock("../native-appearance", () => ({ themedWindowBackgroundColor: () => "black", themedTitleBarOverlay: () => ({}) }));
import { runStartupStorageMaintenance } from "../storage-maintenance";

const write = vi.fn((_key: string, value: string) => { fixture.record = JSON.parse(value); });
const state = { raw: {
  pragma: (name: string) => name === "page_count" ? 40000 : 4096,
  prepare: () => ({ get: () => ({ value: JSON.stringify(fixture.record) }), all: () => [], run: write }),
} } as unknown as StateDb;
const run = (discover = async () => ({ archived: [], active: [] })) => runStartupStorageMaintenance({ state, existingDatabase: true, onboardingCompleted: true, discover });
const command = (value: StorageMaintenanceCommand) => fixture.handlers.get(STORAGE_MAINTENANCE_CHANNEL)!({ sender: fixture.windows[0].webContents }, value);
async function started() {
  vi.useFakeTimers();
  const done = run();
  await vi.waitFor(() => expect(fixture.workers).toHaveLength(1));
  return { done, window: fixture.windows[0], worker: fixture.workers[0] };
}
afterEach(() => {
  for (const window of fixture.windows) window.close();
  fixture.windows.length = 0; fixture.workers.length = 0; fixture.handlers.clear();
  fixture.otherInstance = false; fixture.record = { historyEnabled: true }; write.mockClear(); vi.restoreAllMocks(); vi.useRealTimers();
});

it("releases startup on completion but preserves a hovered window and its settings", async () => {
  const { done, window, worker } = await started();
  await command({ action: "hold" });
  worker.emit("message", { phase: "complete", afterBytes: 100 });
  worker.emit("exit", 0);
  await done;
  await vi.advanceTimersByTimeAsync(10000);
  expect(window.close).not.toHaveBeenCalled();
  expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true);
  await command({ action: "preference", historyEnabled: false });
  expect(write).toHaveBeenCalled();
  await command({ action: "dismiss" });
  expect(window.close).toHaveBeenCalledOnce();
});

it("allows hover during the completion grace period to cancel auto-dismiss", async () => {
  const { done, window, worker } = await started();
  worker.emit("message", { phase: "complete" }); worker.emit("exit", 0);
  await done;
  await vi.advanceTimersByTimeAsync(3000);
  await command({ action: "hold" });
  await vi.advanceTimersByTimeAsync(10000);
  expect(window.close).not.toHaveBeenCalled();
});

it("auto-dismisses an untouched completion window after startup is released", async () => {
  const { done, window, worker } = await started();
  worker.emit("message", { phase: "complete" }); worker.emit("exit", 0);
  await done;
  expect(window.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4000);
  expect(window.close).toHaveBeenCalledOnce();
});

it("cancellation stops the child and releases startup", async () => {
  const { done, worker } = await started();
  await command({ action: "cancel" });
  await done;
  expect(worker.kill).toHaveBeenCalledOnce();
});

it("ignores queued progress while waiting for a cancelled worker to exit", async () => {
  const { done, worker } = await started();
  vi.mocked(worker.kill).mockImplementation(() => {});
  await command({ action: "cancel" });
  worker.emit("message", { phase: "cleanup" });
  worker.emit("exit", 1);
  await done;
  expect((await command({ action: "status" })).phase).toBe("cancelled");
});

it("defers without opening a window when another profile instance is alive", async () => {
  fixture.otherInstance = true;
  await run();
  expect(fixture.windows).toHaveLength(0);
  expect(write).not.toHaveBeenCalled();
});

it("stops maintenance when another instance appears during the job", async () => {
  const { done, worker } = await started();
  fixture.otherInstance = true;
  await vi.advanceTimersByTimeAsync(250);
  await done;
  expect(worker.kill).toHaveBeenCalledOnce();
  expect((await command({ action: "status" })).phase).toBe("deferred");
});

it("kills the worker when the application quits", async () => {
  const { done, worker } = await started();
  app.emit("before-quit", {});
  await done;
  expect(worker.kill).toHaveBeenCalledOnce();
});

it("rejects commands from another renderer", async () => {
  const { worker, done } = await started();
  await expect(fixture.handlers.get(STORAGE_MAINTENANCE_CHANNEL)!({ sender: {} }, { action: "cancel" })).rejects.toThrow("Invalid storage maintenance sender");
  expect(worker.kill).not.toHaveBeenCalled();
  await command({ action: "cancel" });
  await done;
});

it("Optimize with an untouched checkbox uses the default without saving an override", async () => {
  fixture.record = {};
  vi.useFakeTimers();
  const done = run();
  await vi.waitFor(() => expect(fixture.windows).toHaveLength(1));
  await command({ action: "start" });
  expect(fixture.workers[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ historyEnabled: false }));
  fixture.workers[0].emit("message", { phase: "complete" });
  fixture.workers[0].emit("exit", 0);
  await done;
  expect(fixture.record.historyEnabled).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

it("persists an explicit on-then-off choice even when it matches the default", async () => {
  fixture.record = {};
  vi.useFakeTimers();
  const done = run();
  await vi.waitFor(() => expect(fixture.windows).toHaveLength(1));
  await command({ action: "preference", historyEnabled: true });
  await command({ action: "preference", historyEnabled: false });
  await command({ action: "cancel" });
  await done;
  expect(fixture.record.historyEnabled).toBe(false);
});

it.each([undefined, false, true])("a future default applies only without an explicit override (%s)", async (override) => {
  fixture.record = override === undefined ? {} : { historyEnabled: override };
  const policy = storage.storageHistoryPolicy;
  vi.spyOn(storage, "storageHistoryPolicy").mockImplementation((record) => policy(record, true));
  const { done, worker } = await started();
  expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ historyEnabled: override ?? true }));
  await command({ action: "cancel" });
  await done;
  expect(fixture.record.historyEnabled).toBe(override);
});

it("Not now writes attempt bookkeeping without materializing the default", async () => {
  fixture.record = {};
  vi.useFakeTimers();
  const done = run();
  await vi.waitFor(() => expect(fixture.windows).toHaveLength(1));
  await command({ action: "cancel" });
  await done;
  expect(fixture.record.historyEnabled).toBeUndefined();
  expect(fixture.record.attemptedAt).toEqual(expect.any(Number));
});

it("failed automatic discovery does not save the effective default as a preference", async () => {
  fixture.record = {};
  const policy = storage.storageHistoryPolicy;
  vi.spyOn(storage, "storageHistoryPolicy").mockImplementation((record) => policy(record, true));
  vi.useFakeTimers();
  await run(async () => { throw new Error("Unavailable"); });
  expect((await command({ action: "status" })).phase).toBe("error");
  expect(fixture.record.historyEnabled).toBeUndefined();
  expect(fixture.record.attemptedAt).toEqual(expect.any(Number));
});
