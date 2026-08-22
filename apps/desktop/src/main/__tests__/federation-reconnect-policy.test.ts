import { describe, expect, it } from "vitest";
import {
  E2E_FAST_FEDERATION_RECONNECT_ENV,
  FEDERATION_RECONNECT_DEFAULT_MAX_DELAY_MS,
  FEDERATION_RECONNECT_E2E_MAX_DELAY_MS,
  resolveFederationReconnectMaxDelayMs,
} from "../federation/federation-reconnect-policy";

describe("federation reconnect policy", () => {
  it("keeps the production reconnect backoff without the E2E guard", () => {
    expect(resolveFederationReconnectMaxDelayMs({
      [E2E_FAST_FEDERATION_RECONNECT_ENV]: "1",
    })).toBe(FEDERATION_RECONNECT_DEFAULT_MAX_DELAY_MS);
  });

  it("caps reconnect backoff at one second for Electron E2E", () => {
    expect(resolveFederationReconnectMaxDelayMs({
      PWRAGENT_E2E: "1",
      [E2E_FAST_FEDERATION_RECONNECT_ENV]: "1",
    })).toBe(FEDERATION_RECONNECT_E2E_MAX_DELAY_MS);
  });
});
