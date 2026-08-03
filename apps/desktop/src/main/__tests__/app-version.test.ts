import { describe, expect, it } from "vitest";
import { resolveApplicationVersion } from "../app-version";

describe("application version", () => {
  it("uses the fixed application version requested by the E2E harness", () => {
    expect(resolveApplicationVersion("41.10.3", {
      PWRAGENT_E2E: "1",
      PWRAGENT_E2E_APP_VERSION: "1.2.3-beta.1",
    })).toBe("1.2.3-beta.1");
  });

  it("ignores the E2E override outside the harness", () => {
    expect(resolveApplicationVersion("1.0.0-beta.50", {
      PWRAGENT_E2E_APP_VERSION: "1.2.3-beta.1",
    })).toBe("1.0.0-beta.50");
  });
});
