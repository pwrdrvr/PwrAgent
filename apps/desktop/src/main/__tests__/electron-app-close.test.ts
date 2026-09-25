import { runInNewContext } from "node:vm";
import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { closeElectronApplication } from "../../../e2e/fixtures/electron-app";

describe("closeElectronApplication", () => {
  it.each([true, false])("uses the owned shutdown signal when installed (%s), without opening a quit dialog", async (installed) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const quit = vi.fn();
    const emit = vi.fn();
    const listenerCount = vi.fn(() => installed ? 1 : 0);
    const child = { exitCode: null as number | null, signalCode: null };
    const close = vi.fn(async () => { child.exitCode = 0; });
    const electronApp = {
      process: () => child,
      evaluate: async (callback: unknown) => runInNewContext(`(${String(callback)})({ app })`, {
        app: { quit }, process: { emit, listenerCount },
      }),
      close,
    } as unknown as ElectronApplication;
    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy", forceExitOutcome: "not-needed",
    });
    expect(emit.mock.calls).toEqual(installed ? [["SIGTERM", "SIGTERM"]] : []);
    expect(quit).toHaveBeenCalledTimes(installed ? 0 : 1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("is a no-op when Playwright throws for an exited Electron handle", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const process = vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined (reading '_object')");
    });
    const electronApp = { process } as unknown as ElectronApplication;

    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy",
      forceExitOutcome: "not-needed",
    });
    expect(process).toHaveBeenCalledOnce();
  });

  it("is a no-op when Playwright returns no process for an exited Electron handle", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const process = vi.fn(() => undefined);
    const electronApp = { process } as unknown as ElectronApplication;

    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy",
      forceExitOutcome: "not-needed",
    });
    expect(process).toHaveBeenCalledOnce();
  });
});
