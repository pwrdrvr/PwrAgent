import { describe, expect, it, vi } from "vitest";
import {
  closeElectronApplication,
  configureElectronE2eSecretStorageEnv,
  nextRendererViewportRequest,
} from "../../../e2e/fixtures/electron-app";
import {
  E2E_MEMORY_SECRET_STORAGE_ENV,
  SECRET_STORAGE_DISABLED_ENV,
} from "../settings/desktop-secret-store";

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

  it("keeps keychain access disabled while enabling writable screenshot storage", () => {
    const env: Record<string, string> = {};

    configureElectronE2eSecretStorageEnv(env, "memory");

    expect(env).toMatchObject({
      [E2E_MEMORY_SECRET_STORAGE_ENV]: "1",
      [SECRET_STORAGE_DISABLED_ENV]: "1",
    });

    configureElectronE2eSecretStorageEnv(env);

    expect(env[SECRET_STORAGE_DISABLED_ENV]).toBe("1");
    expect(env[E2E_MEMORY_SECRET_STORAGE_ENV]).toBeUndefined();
  });

  it("compensates a near-target renderer size exactly", () => {
    expect(
      nextRendererViewportRequest({
        attempt: 0,
        observed: { innerWidth: 1439, innerHeight: 901 },
        previousRequest: null,
        target: { width: 1440, height: 900 },
      }),
    ).toEqual({ width: 1441, height: 899 });
  });

  it("nudges stale far-from-target resizes without feeding back a large error", () => {
    expect(
      nextRendererViewportRequest({
        attempt: 1,
        observed: { innerWidth: 1200, innerHeight: 760 },
        previousRequest: { width: 1440, height: 900 },
        target: { width: 1440, height: 900 },
      }),
    ).toEqual({ width: 1440, height: 901 });
  });

  it("forces a real native frame change when compensation repeats", () => {
    expect(
      nextRendererViewportRequest({
        attempt: 1,
        observed: { innerWidth: 1439, innerHeight: 901 },
        previousRequest: { width: 1441, height: 899 },
        target: { width: 1440, height: 900 },
      }),
    ).toEqual({ width: 1441, height: 898 });
  });
});
