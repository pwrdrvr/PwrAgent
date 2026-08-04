import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { closeElectronApplication } from "../../../e2e/fixtures/electron-app";

describe("closeElectronApplication", () => {
  it("is a no-op after Playwright releases an exited Electron handle", async () => {
    const process = vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined (reading '_object')");
    });
    const electronApp = { process } as unknown as ElectronApplication;

    await expect(closeElectronApplication(electronApp)).resolves.toBeUndefined();
    expect(process).toHaveBeenCalledOnce();
  });
});
