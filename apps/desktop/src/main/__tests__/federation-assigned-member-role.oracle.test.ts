import { FEDERATION_BACKEND_METHODS } from "@pwragent/federation/federation-backend-methods";
import { FEDERATION_CAPABILITIES, type FederationPeerRole, type FederationProtocolEnvelope } from "@pwragent/shared";
import { expect, it, onTestFinished, vi } from "vitest";
import { createFederationEnrollmentInvite } from "../federation/federation-enrollment";
import { generateFederationIdentityKeyPair } from "../federation/federation-identity";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import type { FederationRouter } from "../federation/federation-router";
import {
  connectFederationClient,
  FederationGatewayWebSocketServer,
  type FederationClientWebSocketClient,
  type FederationGatewayConnection,
} from "../federation/federation-transport";
import {
  clearGatewayAssignedMemberRole,
  forgetCachedGatewayAssignedMemberRole,
  localMemberRole,
} from "../member-containment";
import { getOwnerHostServices, installOwnerHostServices } from "../owner-host";
import { createOutpostRuntimePolicy } from "../owner-runtime-policy";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { disposeAppState, getAppStateDb, initializeAppState } from "../state/app-state";
import { desktopFederationState } from "../storage/desktop-federation-storage";
import { FederationStore } from "../storage/federation-store";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

// Oracle: the gateway's own store, which is the role the gateway enforces.
// Over a real enrolled Noise connection, a member's containment must match
// what its gateway enforces on it after every operator change, whether the
// member hears it pushed while connected or asks for it on reconnect. A
// member's own declaration must never undo a relaxation its gateway's
// operator made while the member was away.

vi.mock("../settings/desktop-settings-singleton", () => ({ getDesktopSettingsService: vi.fn() }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({}) }));
vi.mock("@pwragent/federation/federation-refusal-audit", () => ({ appendFederationRefusalAudit: vi.fn() }));

const GATEWAY = "gateway_one";
const MEMBER = "member_one";

type RuntimeInternals = {
  router?: FederationRouter;
  filePushReceiver?: { dispose(): Promise<void> };
  assignedRoles: Map<string, FederationPeerRole>;
  startAfterLeaseAcquired(mode: string, config: object): Promise<void>;
  receiveEnvelope(envelope: FederationProtocolEnvelope, sourcePeerId: string): Promise<void>;
  declareMemberRole(peerId: string, capabilities: readonly string[]): void;
  installEgressPolicy(connection: FederationClientWebSocketClient): void;
  setPeerRole(peerId: string, role: FederationPeerRole): Promise<unknown>;
};

/** A runtime with its real router and handlers, and no listener or lease. */
async function runtime(localInstanceId: string, store: FederationStore): Promise<RuntimeInternals> {
  const stop = new Error("Router constructed; the test owns the transport");
  vi.mocked(getDesktopSettingsService).mockReturnValue({ readFederationConfig: () => ({}),
    getOrCreateFederationNoiseStaticKeyPair: async () => { throw stop; },
  } as unknown as ReturnType<typeof getDesktopSettingsService>);
  const instance = Object.assign(new DesktopFederationRuntime(), { localInstanceId, store: () => store,
    durableTurnRequestService: () => ({}), subscribeLocalBackendEvents: () => {},
    broadcastPeerDirectory: () => {}, publishPeerStatus: () => {} }) as unknown as RuntimeInternals;
  await expect(instance.startAfterLeaseAcquired("disabled", {})).rejects.toBe(stop);
  return instance;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

it("keeps a member's containment equal to what its gateway enforces, over a real connection", async () => {
  const previousHost = getOwnerHostServices();
  onTestFinished(() => installOwnerHostServices(previousHost));
  // The member's own setting is full; only its gateway contains it.
  installOwnerHostServices({ ...previousHost,
    runtimePolicy: createOutpostRuntimePolicy({ PWRAGENT_OUTPOST_FEDERATION_ROLE: "full" }) });

  // The member's state DB holds its pairing and the gateway's assignment.
  const fixture = createTempStateDb("assigned-member-role-oracle-");
  vi.stubEnv("PWRAGENT_HOME", fixture.tempDir);
  initializeAppState("bootstrap");
  onTestFinished(() => { disposeAppState(); removeTempStateDbDir(fixture.tempDir); vi.unstubAllEnvs(); });
  desktopFederationState.write("gatewayInstanceId", GATEWAY);
  clearGatewayAssignedMemberRole();

  // The gateway has its own database, as it would on its own machine.
  const gatewayDb = openInMemoryStateDb();
  onTestFinished(() => gatewayDb.close());
  const gatewayStore = new FederationStore(gatewayDb);
  const gatewayKeys = generateFederationIdentityKeyPair();
  const memberKeys = generateFederationIdentityKeyPair();
  const gateway = await runtime(GATEWAY, gatewayStore);
  const member = await runtime(MEMBER, new FederationStore(getAppStateDb()));
  Object.assign(member, { gatewayInstanceId: GATEWAY });
  onTestFinished(async () => { await gateway.filePushReceiver?.dispose(); await member.filePushReceiver?.dispose(); });

  const server = new FederationGatewayWebSocketServer({ gatewayInstanceId: GATEWAY,
    gatewayPrivateKeyPem: gatewayKeys.privateKeyPem, gatewayPublicKeyPem: gatewayKeys.publicKeyPem,
    host: "127.0.0.1", port: 0, store: gatewayStore, supportedCapabilities: [...FEDERATION_CAPABILITIES],
    onConnection: (connection: FederationGatewayConnection) => gateway.router!.registerConnection({
      peerId: connection.peerId, capabilities: connection.capabilities, sendEnvelope: connection.sendEnvelope }),
    onEnvelope: (envelope, connection) => void gateway.receiveEnvelope(envelope, connection.peerId),
  });
  const { url } = await server.start();
  onTestFinished(() => server.stop());

  /** One member session: connect, guard, declare, as the member's client path does. */
  const connect = async (mode: "enroll" | "reconnect", inviteToken?: string) => {
    const client = await connectFederationClient({ url, mode, gatewayInstanceId: GATEWAY,
      gatewayPublicKeyPem: gatewayKeys.publicKeyPem, peerInstanceId: MEMBER, publicKeyPem: memberKeys.publicKeyPem,
      privateKeyPem: memberKeys.privateKeyPem, capabilities: [...FEDERATION_CAPABILITIES], role: "client",
      label: "Fixture member", inviteToken, onEnvelope: (envelope) => void member.receiveEnvelope(envelope, GATEWAY) });
    member.installEgressPolicy(client);
    member.router!.registerConnection({ peerId: GATEWAY, capabilities: client.capabilities,
      sendEnvelope: (envelope) => client.sendEnvelope(envelope) });
    member.declareMemberRole(GATEWAY, client.capabilities);
    return client;
  };
  const enforced = () => gatewayStore.getPeer(MEMBER)?.permissionRole;
  const agrees = () => member.assignedRoles.get(GATEWAY) === enforced() && localMemberRole() === enforced();

  const invite = createFederationEnrollmentInvite({ store: gatewayStore, token: "oracle-invite",
    gatewayInstanceId: GATEWAY, generatedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000, permissionRole: "full" });
  let client = await connect("enroll", invite.token);
  await until(() => member.assignedRoles.has(GATEWAY), "the declaration reply");
  expect(enforced()).toBe("full");
  expect(agrees()).toBe(true);

  // The gateway's operator contains the member; the push arrives over the wire.
  await gateway.setPeerRole(MEMBER, "contained");
  await until(agrees, "the pushed containment");
  expect(localMemberRole()).toBe("contained");
  // The member now refuses its own requests to operate other instances.
  expect(() => client.sendEnvelope({ id: "listing", kind: "request", method: FEDERATION_BACKEND_METHODS.listThreads,
    params: {}, protocolVersion: 1, sourceInstanceId: MEMBER, targetInstanceId: GATEWAY, createdAt: Date.now() }))
    .toThrow(/capability_denied/);

  // The member goes away; while it is gone the operator relaxes it.
  client.close();
  await until(() => !server.activeConnections().some(connection => connection.peerId === MEMBER), "the disconnect");
  member.router!.unregisterConnection(GATEWAY);
  await gateway.setPeerRole(MEMBER, "full");
  // A restarted member is still contained before it reconnects.
  forgetCachedGatewayAssignedMemberRole();
  member.assignedRoles.clear();
  expect(localMemberRole()).toBe("contained");

  // On reconnect it declares its own setting, hears full, and the gateway
  // still enforces full: the member did not re-tighten its own role.
  client = await connect("reconnect");
  onTestFinished(() => client.close());
  await until(() => member.assignedRoles.has(GATEWAY), "the reconnect reply");
  expect(enforced()).toBe("full");
  expect(agrees()).toBe(true);
  expect(localMemberRole()).toBe("full");
});
