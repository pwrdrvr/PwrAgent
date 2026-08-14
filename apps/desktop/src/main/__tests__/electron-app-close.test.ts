import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { closeElectronApplication } from "../../../e2e/fixtures/electron-app";

describe("closeElectronApplication", () => {
  it("is a no-op when Playwright throws for an exited Electron handle", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const process = vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    const electronApp = { process } as unknown as ElectronApplication;

    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy",
      forceExitOutcome: "not-needed",
    });
    expect(process).toHaveBeenCalledOnce();
  });

  it("is a no-op when Playwright returns no process for an exited handle", async () => {
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
