import { describe, expect, it } from "vitest";

import { handoffPreloadedCodesignIdentity } from "./release-signing-environment.mjs";

describe("preloaded macOS signing identity handoff", () => {
  it("removes electron-builder keychain and import credentials", () => {
    const env = {
      APPLE_API_KEY: "/tmp/AuthKey_ABC123.p8",
      CSC_KEYCHAIN: "/tmp/pwragent-codesign.keychain-db",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "/tmp/PwrAgent_Developer_ID_Application.p12",
      CSC_NAME: "PwrDrvr LLC (T44CNHC4UH)",
      PWRAGENT_DOCK_PLUGIN_SIGN_IDENTITY:
        "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)",
    };

    handoffPreloadedCodesignIdentity(env);

    expect(env).toEqual({
      APPLE_API_KEY: "/tmp/AuthKey_ABC123.p8",
      CSC_NAME: "PwrDrvr LLC (T44CNHC4UH)",
      PWRAGENT_DOCK_PLUGIN_SIGN_IDENTITY:
        "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)",
    });
  });
});
