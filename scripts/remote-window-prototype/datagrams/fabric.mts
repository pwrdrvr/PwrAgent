// Real signed/Noise Federation signaling using disposable in-memory fixture peers.
// Never imports a production identity or modifies enrollment/profile settings.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";


export async function createFabric(handler: (params: unknown) => Promise<unknown>) {
  const home = await mkdtemp(`${tmpdir()}/pwrwin-datagrams-`);
  process.env.PWRAGENT_HOME = home;
  const { StateDb } = await import("../../../apps/desktop/src/main/state/state-db.ts");
  const { FederationStore } = await import("../../../apps/desktop/src/main/federation/federation-store.ts");
  const { generateFederationIdentityKeyPair } = await import("../../../apps/desktop/src/main/federation/federation-identity.ts");
  const { generateNoiseStaticKeyPair } = await import("../../../apps/desktop/src/main/federation/federation-noise.ts");
  const { FederationRouter } = await import("../../../apps/desktop/src/main/federation/federation-router.ts");
  const { FederationRpcEndpoint } = await import("../../../apps/desktop/src/main/federation/federation-rpc.ts");
  const { connectFederationClient, FederationGatewayWebSocketServer } = await import("../../../apps/desktop/src/main/federation/federation-transport.ts");
  const db = StateDb.open(":memory:"), store = new FederationStore(db);
  const gatewayId = "pwr_fixture_gateway", ownerId = "pwr_fixture_source", viewerId = "pwr_fixture_viewer";
  const keys = generateFederationIdentityKeyPair(), noise = generateNoiseStaticKeyPair();
  const gatewayRouter = new FederationRouter({ localInstanceId: gatewayId });
  const ownerRouter = new FederationRouter({ localInstanceId: ownerId, trustedRelayPeerId: gatewayId });
  const wire = { messages: 0, bytes: 0 };
  const gateway = new FederationGatewayWebSocketServer({
    gatewayInstanceId: gatewayId, gatewayPrivateKeyPem: keys.privateKeyPem, gatewayPublicKeyPem: keys.publicKeyPem,
    noiseStatic: noise, host: "127.0.0.1", port: 0, store, compressionEnabled: false,
    onConnection: connection => gatewayRouter.registerConnection(connection),
    onDisconnect: connection => gatewayRouter.unregisterConnection(connection.peerId),
    onEnvelope: (envelope, connection) => { void gatewayRouter.routeEnvelope({ envelope, sourcePeerId: connection.peerId }); },
    onEnvelopeTransfer: event => { wire.messages++; wire.bytes += event.byteCount; },
  });
  const { url } = await gateway.start();
  async function connect(id: string, onEnvelope: NonNullable<Parameters<typeof connectFederationClient>[0]["onEnvelope"]>) {
    const identity = generateFederationIdentityKeyPair();
    store.upsertPeer({ peer: { id, label: id, role: "client", status: "disconnected", protocolVersion: 1,
      capabilities: ["gateway_relay"], pinnedPublicKeyPem: identity.publicKeyPem }, updatedAt: Date.now() });
    return connectFederationClient({ url, mode: "reconnect", gatewayInstanceId: gatewayId,
      gatewayPublicKeyPem: keys.publicKeyPem, gatewayNoisePublicKey: noise.publicKeyRaw,
      peerInstanceId: id, privateKeyPem: identity.privateKeyPem, publicKeyPem: identity.publicKeyPem,
      noiseStatic: generateNoiseStaticKeyPair(), capabilities: ["gateway_relay"], onEnvelope });
  }
  let owner: Awaited<ReturnType<typeof connect>> | undefined;
  let viewer: Awaited<ReturnType<typeof connect>> | undefined;
  let rpc: InstanceType<typeof FederationRpcEndpoint>;
  try {
    owner = await connect(ownerId, envelope => { void ownerRouter.routeEnvelope({ envelope, sourcePeerId: gatewayId }); });
    ownerRouter.registerConnection({ peerId: gatewayId, capabilities: ["gateway_relay"],
      sendEnvelope: envelope => owner!.sendEnvelope(envelope) });
    ownerRouter.registerHandler("window.datagram.prototype.v1.signal", (envelope, peer) => {
      if (!peer || envelope.sourceInstanceId !== viewerId) throw new Error("fixture_peer_denied");
      return handler(envelope.params);
    });
    viewer = await connect(viewerId, envelope => rpc.receiveEnvelope(envelope));
    rpc = new FederationRpcEndpoint({ localInstanceId: viewerId, remoteInstanceId: ownerId,
      sendEnvelope: envelope => viewer!.sendEnvelope(envelope), defaultTimeoutMs: 5000 });
    return { wire, signal: (params: unknown) => rpc.request({ method: "window.datagram.prototype.v1.signal", params }),
      async close() { rpc.rejectAll(new Error("fixture_closed")); owner?.close(); viewer?.close(); await gateway.stop(); db.close(); await rm(home, { recursive: true, force: true }); } };
  } catch (error) { owner?.close(); viewer?.close(); await gateway.stop(); db.close(); await rm(home, { recursive: true, force: true }); throw error; }
}
