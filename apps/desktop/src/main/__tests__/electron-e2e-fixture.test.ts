import { describe, expect, it, vi } from "vitest";
import { closeElectronApplication } from "../../../e2e/fixtures/electron-app";

describe("Electron E2E fixture teardown", () => {
  it("is a no-op after Playwright has already disposed a graduated bootstrap app", async () => {
    const electronApp = {
      process: vi.fn(() => {
        throw new TypeError("Cannot read properties of undefined");
      }),
    };

    await expect(
      closeElectronApplication(electronApp as never),
    ).resolves.toBeUndefined();
  });
});
