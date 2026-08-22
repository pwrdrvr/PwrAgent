import type { ElectronApplication, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import {
  closeElectronApplication,
  requestElectronQuitWithRendererFallback,
} from "../../../e2e/fixtures/electron-app";

describe("closeElectronApplication", () => {
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

  it("uses the main-process quit route while Playwright can reach it", async () => {
    const evaluate = vi.fn(async () => undefined);
    const rendererEvaluate = vi.fn(async () => undefined);

    await requestElectronQuitWithRendererFallback({
      electronApp: { evaluate } as unknown as ElectronApplication,
      launchId: "healthy-launch",
      window: { evaluate: rendererEvaluate } as unknown as Page,
    });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(rendererEvaluate).not.toHaveBeenCalled();
  });

  it("falls back to the renderer quit IPC when main-process evaluation rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const evaluate = vi.fn(async () => {
      throw new Error("Playwright main-process channel closed");
    });
    const rendererEvaluate = vi.fn(async () => undefined);

    await requestElectronQuitWithRendererFallback({
      electronApp: { evaluate } as unknown as ElectronApplication,
      launchId: "stale-main-channel",
      window: { evaluate: rendererEvaluate } as unknown as Page,
    });

    expect(rendererEvaluate).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '"reason":"main-process-evaluation-rejected","route":"renderer-ipc"',
      ),
    );
  });
});
