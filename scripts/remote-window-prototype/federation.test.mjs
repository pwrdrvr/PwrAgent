import { test, expect } from "vitest";
import { FederationRouter } from "../../apps/desktop/src/main/federation/federation-router";
import { FederationRpcEndpoint } from "../../apps/desktop/src/main/federation/federation-rpc";
import { WindowSession } from "./session.mjs";

test("prototype pull passes through actual Federation Router and RPC with authenticated peer", async () => {
  const owner = "pwr_fixture_owner", viewer = "pwr_fixture_viewer";
  const session = new WindowSession({ owner, viewer, scene: "fixture" });
  session.publish(Buffer.from("fixture-only snapshot"));
  const router = new FederationRouter({ localInstanceId: owner });
  const pendingRoutes = [];
  const rpc = new FederationRpcEndpoint({
    localInstanceId: viewer,
    remoteInstanceId: owner,
    sendEnvelope: envelope => {
      pendingRoutes.push(router.routeEnvelope({ envelope, sourcePeerId: viewer }));
    },
  });
  router.registerConnection({ peerId: viewer, capabilities: [], sendEnvelope: envelope => rpc.receiveEnvelope(envelope) });
  router.registerHandler("window.prototype.pull", (envelope, sourcePeerId) => {
    // Direct peer test. A product relay adapter must validate the trusted relay
    // and bind end-to-end origin before using envelope.sourceInstanceId.
    return session.pull(sourcePeerId, envelope.params);
  });
  const frame = await rpc.request({ method: "window.prototype.pull", params: { epoch: 1 } });
  expect(frame.bytes.toString()).toBe("fixture-only snapshot");
  session.revoke();
  await expect(rpc.request({ method: "window.prototype.pull", params: { epoch: 1 } })).rejects.toThrow("stale_or_unauthorized");
  await Promise.all(pendingRoutes);
  rpc.rejectAll(new Error("fixture finished"));
});
