import { describe, expect, it } from "vitest";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

describe("FederationRpcEndpoint", () => {
  it("rejects and removes a request when its route fails synchronously", async () => {
    const endpoint = new FederationRpcEndpoint({
      localInstanceId: "client_one",
      remoteInstanceId: "gateway_one",
      sendEnvelope: () => {
        throw new Error("Federation peer gateway_one is not connected.");
      },
    });

    await expect(endpoint.request({
      method: "backend.getNavigationSnapshot",
      params: {},
    })).rejects.toThrow("Federation peer gateway_one is not connected.");
    expect(
      (endpoint as unknown as { pending: Map<string, unknown> }).pending.size,
    ).toBe(0);
  });
});
