import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const service = vi.hoisted(() => ({ scan: vi.fn(async () => ({ scanId: "s" })),
  start: vi.fn((_request: unknown) => ({ run: {}, done: Promise.resolve() })) }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock("../thread-maintenance-runtime", () => ({
  getThreadMaintenanceService: () => service,
  onThreadMaintenanceRun: vi.fn(() => () => undefined),
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: vi.fn(() => []),
}));

vi.mock("../window", () => ({
  isFederationWindowWebContents: vi.fn(() => false),
}));

import { ipcMain } from "electron";
import { THREAD_MAINTENANCE_SCAN_STEPS } from "@pwragent/shared";
import { APP_SERVER_APPLY_THREAD_MAINTENANCE_CHANNEL, APP_SERVER_SCAN_THREAD_MAINTENANCE_CHANNEL } from "../../shared/ipc";
import { registerThreadMaintenanceIpc } from "../ipc/thread-maintenance-ipc";

function scanHandler(): (event: unknown, request?: unknown) => Promise<unknown> {
  registerThreadMaintenanceIpc();
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === APP_SERVER_SCAN_THREAD_MAINTENANCE_CHANNEL);
  return call![1] as (event: unknown, request?: unknown) => Promise<unknown>;
}

/**
 * Property: a window's steps list reaches the service as exactly the known
 * steps it names, in run order. An empty list asks for no step; only a
 * request without a list asks for every step.
 */
describe("thread maintenance scan request", () => {
  it("passes selected Cargo profiles and preserves absent-field compatibility", async () => {
    registerThreadMaintenanceIpc();
    const call = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === APP_SERVER_APPLY_THREAD_MAINTENANCE_CHANNEL)!;
    const handle = call[1] as (event: unknown, request: unknown) => unknown;
    await fc.assert(fc.asyncProperty(fc.array(fc.string()), async (paths) => {
      service.start.mockClear();
      await handle({}, { scanId: "s", removeBuildOutputs: paths.map((outputPath) => ({ outputPath })) });
      const request = service.start.mock.calls[0]![0] as { removeBuildOutputs?: { outputPath: string }[] };
      if (paths.length) expect(request.removeBuildOutputs).toEqual(paths.map((outputPath) => ({ outputPath })));
      else expect(request).not.toHaveProperty("removeBuildOutputs");
    }));
    service.start.mockClear();
    await handle({}, { scanId: "s" });
    expect(service.start.mock.calls[0]![0]).not.toHaveProperty("removeBuildOutputs");
  });

  it("passes the named steps, and never widens an empty list to every step", async () => {
    const handle = scanHandler();
    const event = { sender: { send: vi.fn(), isDestroyed: () => false } };
    const names = fc.array(fc.oneof(fc.constantFrom(...THREAD_MAINTENANCE_SCAN_STEPS), fc.constantFrom("expired", "bogus", "")));
    await fc.assert(fc.asyncProperty(names, async (steps) => {
      service.scan.mockClear();
      await handle(event, { steps });
      const [request] = service.scan.mock.calls[0] as unknown as [{ steps?: string[] }];
      expect(request.steps).toEqual(THREAD_MAINTENANCE_SCAN_STEPS.filter((step) => steps.includes(step)));
    }));
    service.scan.mockClear();
    await handle(event, {});
    expect((service.scan.mock.calls[0] as unknown as [{ steps?: string[] }])[0].steps).toBeUndefined();
  });
});
