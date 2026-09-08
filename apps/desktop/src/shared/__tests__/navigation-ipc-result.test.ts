import { expect, it } from "vitest";
import { expectedNavigationReadFailure, unwrapNavigationRead } from "../navigation-ipc-result";

it("transports an offline peer without a stack and restores the renderer rejection", () => {
  const error = Object.assign(new Error("Federation peer peer-1 is not connected."), {
    code: "FEDERATION_PEER_UNAVAILABLE", instanceId: "peer-1",
  });
  const payload = expectedNavigationReadFailure(error);
  expect(payload).toEqual({ navigationReadFailure: true, code: error.code, message: error.message, instanceId: "peer-1" });
  expect(JSON.stringify(payload)).not.toContain("stack");
  expect(() => unwrapNavigationRead(structuredClone(payload))).toThrow(expect.objectContaining({
    message: error.message, code: error.code, instanceId: "peer-1", name: "FederationPeerUnavailableError",
  }));
});

it("does not suppress unexpected failures or change successful responses", () => {
  expect(expectedNavigationReadFailure(new Error("broken projection"))).toBeUndefined();
  expect(expectedNavigationReadFailure(Object.assign(new Error("invalid query"), { code: "navigation_invalid_request" }))).toBeUndefined();
  const page = { protocol: 2, entries: [] };
  expect(unwrapNavigationRead(page)).toBe(page);
});

it("carries normal navigation cancellation without an Electron handler exception", () => {
  const error = Object.assign(new Error("Navigation read cancelled or its deadline expired."), { code: "navigation_busy" });
  const result = expectedNavigationReadFailure(error);
  expect(result).toEqual({ navigationReadFailure: true, code: "navigation_busy", message: error.message });
  expect(() => unwrapNavigationRead(result)).toThrow(expect.objectContaining({ name: "NavigationQueryError", code: "navigation_busy" }));
});
