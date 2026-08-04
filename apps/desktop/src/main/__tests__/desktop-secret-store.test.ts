import { describe, expect, it } from "vitest";
import {
  E2E_MEMORY_SECRET_STORAGE_ENV,
  isE2eMemorySecretStorageEnabled,
} from "../settings/desktop-secret-store";

describe("E2E memory secret storage", () => {
  const enabledEnv = {
    PWRAGENT_E2E: "1",
    [E2E_MEMORY_SECRET_STORAGE_ENV]: "1",
  };

  it("is available only to unpackaged E2E processes", () => {
    expect(isE2eMemorySecretStorageEnabled(enabledEnv, false)).toBe(true);
    expect(isE2eMemorySecretStorageEnabled(enabledEnv, true)).toBe(false);
    expect(
      isE2eMemorySecretStorageEnabled(
        { [E2E_MEMORY_SECRET_STORAGE_ENV]: "1" },
        false,
      ),
    ).toBe(false);
  });
});
