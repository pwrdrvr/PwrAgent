import fc from "fast-check";
import {
  FEDERATION_BACKEND_METHODS,
  FEDERATION_PEER_ROLE_CHANGED_METHOD,
  FEDERATION_PEER_ROLE_METHOD,
} from "@pwragent/federation/federation-backend-methods";
import { FEDERATION_CAPABILITIES, FEDERATION_INVITE_VERSION, type FederationPeerRole, type FederationProtocolEnvelope } from "@pwragent/shared";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { encodeFederationInvite } from "@pwragent/federation/federation-enrollment";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import type { FederationRouter } from "../federation/federation-router";
import { installOwnerEgressPolicy } from "../federation/owner-egress-policy";
import {
  clearGatewayAssignedMemberRole,
  configuredMemberRole,
  forgetCachedGatewayAssignedMemberRole,
  localMemberContainment,
  localMemberRole,
} from "../member-containment";
import { getOwnerHostServices, installOwnerHostServices } from "../owner-host";
import { createOutpostRuntimePolicy } from "../owner-runtime-policy";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { disposeAppState, getAppStateDb, initializeAppState } from "../state/app-state";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { desktopFederationState } from "../storage/desktop-federation-storage";
import { FederationStore } from "../storage/federation-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

// Rule: one answer to "am I contained", owned by the member's upstream
// gateway. A member is contained when its own setting or its gateway says so.
// What any other peer assigns is shown, never acted on, so a member never
// believes it is full toward one peer while its gateway refuses it to all.
// Only a peer's own word over its direct connection counts, the gateway's
// assignment survives a restart, and a member declares its own setting,
// never the role its gateway gave it.

vi.mock("../settings/desktop-settings-singleton", () => ({ getDesktopSettingsService: vi.fn() }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({}) }));
vi.mock("@pwragent/federation/federation-refusal-audit", () => ({ appendFederationRefusalAudit: vi.fn() }));

const GATEWAY = "gateway";
const PEER = "peer";

type Step =
  | { kind: "reply"; from: typeof GATEWAY | typeof PEER; role: FederationPeerRole }
  | { kind: "push"; from: typeof GATEWAY | typeof PEER; role: FederationPeerRole; relayed: boolean }
  | { kind: "configure"; role: FederationPeerRole }
  | { kind: "restart" }
  | { kind: "forget" };

const role = fc.constantFrom<FederationPeerRole>("full", "contained");
const from = fc.constantFrom<typeof GATEWAY | typeof PEER>(GATEWAY, PEER);
const step: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("reply" as const), from, role }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("push" as const), from, role, relayed: fc.boolean() }), weight: 3 },
  fc.record({ kind: fc.constant("configure" as const), role }),
  fc.constant({ kind: "restart" as const }),
  fc.constant({ kind: "forget" as const }),
);

afterEach(() => {
  disposeAppState();
  vi.unstubAllEnvs();
});

function configure(memberRole: FederationPeerRole): void {
  installOwnerHostServices({ ...getOwnerHostServices(),
    runtimePolicy: createOutpostRuntimePolicy({ PWRAGENT_OUTPOST_FEDERATION_ROLE: memberRole }) });
}

/** A member enrolled with GATEWAY, directly connected to GATEWAY and PEER. */
async function member() {
  const store = new FederationStore(getAppStateDb());
  desktopFederationState.write("gatewayInstanceId", GATEWAY);
  const stop = new Error("Router constructed; no listener needed");
  vi.mocked(getDesktopSettingsService).mockReturnValue({ readFederationConfig: () => ({}),
    getOrCreateFederationNoiseStaticKeyPair: async () => { throw stop; },
  } as unknown as ReturnType<typeof getDesktopSettingsService>);
  const declared: unknown[] = [];
  let nextReply: FederationPeerRole = "full";
  const instance = Object.assign(new DesktopFederationRuntime(), {
    localInstanceId: "member", gatewayInstanceId: GATEWAY, store: () => store,
    durableTurnRequestService: () => ({}), subscribeLocalBackendEvents: () => {},
    broadcastPeerDirectory: () => {}, sendEnvelopeToTarget: () => {}, publishPeerStatus: () => {},
    rpcFor: () => ({ request: async (request: { method: string; params: unknown }) => {
      declared.push(request);
      return { role: nextReply };
    } }),
  });
  const runtime = instance as unknown as { router?: FederationRouter; filePushReceiver?: { dispose(): Promise<void> };
    assignedRoles: Map<string, FederationPeerRole>;
    startAfterLeaseAcquired(mode: string, config: object): Promise<void>;
    declareMemberRole(peerId: string, capabilities: readonly string[]): void };
  await expect(runtime.startAfterLeaseAcquired("disabled", {})).rejects.toBe(stop);
  // Startup ran without a gateway connection; the member is a client of GATEWAY.
  Object.assign(instance, { gatewayInstanceId: GATEWAY });
  const router = runtime.router!;
  for (const peerId of [GATEWAY, PEER]) {
    router.registerConnection({ peerId, capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
  }
  return {
    runtime, declared, store,
    reply: async (peerId: string, assigned: FederationPeerRole, capabilities = [...FEDERATION_CAPABILITIES]) => {
      nextReply = assigned;
      runtime.declareMemberRole(peerId, capabilities);
      await new Promise(resolve => setImmediate(resolve));
    },
    push: async (claimed: string, sourcePeerId: string, assigned: FederationPeerRole) => {
      await router.routeEnvelope({ sourcePeerId, envelope: { id: `push-${Math.random()}`, kind: "notification",
        method: FEDERATION_PEER_ROLE_CHANGED_METHOD, params: { role: assigned }, protocolVersion: 1,
        sourceInstanceId: claimed, targetInstanceId: "member", createdAt: 1,
        // A relayed envelope carries a hop; through the gateway it is let in.
        ...(claimed === sourcePeerId ? {} : { hopCount: 1 }) } });
    },
    close: async () => { await runtime.filePushReceiver?.dispose(); },
  };
}

async function openAppState(): Promise<void> {
  const fixture = createTempStateDb("assigned-member-role-");
  vi.stubEnv("PWRAGENT_HOME", fixture.tempDir);
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  initializeAppState("bootstrap");
  onTestFinished(() => { disposeAppState(); removeTempStateDbDir(fixture.tempDir); });
  // The state DB's first expiry sweep runs on the next timer tick; let it
  // finish before anything is measured.
  await new Promise(resolve => setTimeout(resolve, 0));
}

it("follows the gateway's assignment and only the gateway's, across pushes, restarts and pairings", async () => {
  const previous = getOwnerHostServices();
  onTestFinished(() => installOwnerHostServices(previous));
  await openAppState();
  await fc.assert(fc.asyncProperty(role, fc.array(step, { minLength: 1, maxLength: 16 }), async (initial, steps) => {
    configure(initial);
    clearGatewayAssignedMemberRole();
    const host = await member();
    // The guard on a connection to the non-gateway peer: it must follow the
    // gateway's assignment too, or the member has a per-peer split brain.
    const sent: FederationProtocolEnvelope[] = [];
    const transport = { sendEnvelope: (envelope: FederationProtocolEnvelope) => { sent.push(envelope); } };
    installOwnerEgressPolicy(transport, localMemberRole, "member", () => {});
    let configured = initial;
    let gatewayRole: FederationPeerRole | undefined;
    const shown = new Map<string, FederationPeerRole>();
    const enforced = () => configured === "contained" || gatewayRole === "contained" ? "contained" : "full";
    try {
      for (const next of steps) {
        const enforcedBefore = enforced();
        const gatewayBefore = gatewayRole;
        const declaredBefore = host.declared.length;
        const { writes } = await measureSqliteWrites(async () => {
          switch (next.kind) {
            case "reply":
              await host.reply(next.from, next.role);
              shown.set(next.from, next.role);
              if (next.from === GATEWAY) gatewayRole = next.role;
              break;
            case "push":
              // A relayed push names one peer and arrives over the other's connection.
              await host.push(next.from, next.relayed ? (next.from === GATEWAY ? PEER : GATEWAY) : next.from, next.role);
              if (!next.relayed) {
                shown.set(next.from, next.role);
                if (next.from === GATEWAY) gatewayRole = next.role;
              }
              break;
            case "configure":
              configure(next.role);
              configured = next.role;
              break;
            case "restart":
              // A new process: nothing in memory, the state DB as it was.
              forgetCachedGatewayAssignedMemberRole();
              host.runtime.assignedRoles.clear();
              shown.clear();
              break;
            case "forget":
              clearGatewayAssignedMemberRole();
              gatewayRole = undefined;
              break;
          }
        });
        if (next.kind === "reply") {
          // The member declares its own setting, never what its gateway gave it.
          expect(host.declared.slice(declaredBefore)).toEqual([
            { method: "federation.memberRole.declare.v1", params: { role: configured }, timeoutMs: 10_000 },
          ]);
        }
        expect(configuredMemberRole()).toBe(configured);
        expect(localMemberRole()).toBe(enforced());
        expect(localMemberContainment()).toEqual({ configuredRole: configured,
          ...(gatewayRole ? { gatewayAssignedRole: gatewayRole } : {}), effectiveRole: enforced() });
        expect(Object.fromEntries(host.runtime.assignedRoles)).toEqual(Object.fromEntries(shown));
        const request: FederationProtocolEnvelope = { id: `r-${Math.random()}`, kind: "request",
          method: FEDERATION_BACKEND_METHODS.listThreads, params: {}, protocolVersion: 1,
          sourceInstanceId: "member", targetInstanceId: PEER, createdAt: 1 };
        if (enforced() === "contained") expect(() => transport.sendEnvelope(request)).toThrow(/capability_denied/);
        else expect(() => transport.sendEnvelope(request)).not.toThrow();
        // Writes: one commit when the gateway's assignment changes, one more
        // to audit a change in what the member enforces, and none otherwise.
        const assignmentChanged = gatewayRole !== gatewayBefore;
        const audited = assignmentChanged && next.kind !== "forget" && enforced() !== enforcedBefore;
        expect(writes.commits, JSON.stringify(next)).toBe((assignmentChanged ? 1 : 0) + (audited ? 1 : 0));
      }
    } finally { await host.close(); }
  }), { numRuns: 80 });
});

it("reads the gateway's assignment from a peer that predates declarations", async () => {
  const previous = getOwnerHostServices();
  onTestFinished(() => installOwnerHostServices(previous));
  await openAppState();
  configure("full");
  clearGatewayAssignedMemberRole();
  const host = await member();
  try {
    await host.reply(GATEWAY, "contained", FEDERATION_CAPABILITIES.filter(value => value !== "member_role_declaration_v1"));
    expect(host.declared).toEqual([{ method: FEDERATION_PEER_ROLE_METHOD, params: {}, timeoutMs: 10_000 }]);
    expect(localMemberRole()).toBe("contained");
  } finally { await host.close(); }
});

it("costs no state DB commit to reconnect to a gateway whose assignment did not change", async () => {
  const previous = getOwnerHostServices();
  onTestFinished(() => installOwnerHostServices(previous));
  await openAppState();
  configure("full");
  clearGatewayAssignedMemberRole();
  const host = await member();
  try {
    const { writes: first } = await measureSqliteWrites(() => host.reply(GATEWAY, "contained"));
    expectSqliteWriteBudget({
      note: "A member first hears its gateway assign contained: the assignment and its audit row. Only a gateway operator's role change causes it: about 0.02 MB/day at one change/day.",
      scenario: "gateway-assigned-member-role-change",
      writes: first,
    });
    const { writes: reconnects } = await measureSqliteWrites(async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) await host.reply(GATEWAY, "contained");
    });
    expectSqliteWriteBudget({
      note: "20 reconnects that hear the same gateway assignment: 0 commits, 0 MB/day.",
      scenario: "gateway-assigned-member-role-reconnects",
      writes: reconnects,
    });
  } finally { await host.close(); }
});

it("drops the gateway's assignment with its pairing, and ignores a report from a forgotten gateway", async () => {
  const previous = getOwnerHostServices();
  onTestFinished(() => installOwnerHostServices(previous));
  await openAppState();
  configure("full");
  clearGatewayAssignedMemberRole();
  const host = await member();
  // Federation's own restart and config writes are not under test here.
  vi.mocked(getDesktopSettingsService).mockReturnValue({ readFederationConfig: () => ({}),
    writeConfigPatchTargeted: async () => {}, clearSecret: async () => {},
  } as unknown as ReturnType<typeof getDesktopSettingsService>);
  const runtime = Object.assign(host.runtime, { restart: async () => {}, readRuntimeConfig: () => ({ mode: "gateway" }),
    celestialAssignmentMap: () => new Map(), enrollmentScopedPinInstanceIds: () => [] }) as unknown as typeof host.runtime & {
      resetEnrollment(): Promise<unknown>; importInvite(invite: string): Promise<unknown> };
  const afterRestart = () => { forgetCachedGatewayAssignedMemberRole(); return localMemberRole(); };
  try {
    await host.reply(GATEWAY, "contained");
    expect(afterRestart()).toBe("contained");

    // Forget pairing. The runtime still holds the old gateway connection
    // until its restart runs, and that gateway may still speak.
    await runtime.resetEnrollment();
    expect(localMemberRole()).toBe("full");
    await host.push(GATEWAY, GATEWAY, "contained");
    expect(localMemberRole()).toBe("full");
    expect(afterRestart()).toBe("full");

    // A row stored for some other gateway goes with the next pairing too, so
    // pairing with that gateway later does not inherit it.
    desktopFederationState.write("gatewayAssignedRole", JSON.stringify({ gatewayInstanceId: "gateway-later", role: "contained" }));
    await runtime.importInvite(encodeFederationInvite({ version: FEDERATION_INVITE_VERSION, token: "fixture-token",
      gatewayInstanceId: "gateway-later", gatewayPublicKeyPem: "fixture-pem", gatewayNoisePublicKey: "fixture-noise",
      gatewayUrl: "ws://gateway.example:47833", expiresAt: Date.now() + 60_000 }));
    expect(desktopFederationState.read("gatewayInstanceId")).toBe("gateway-later");
    expect(afterRestart()).toBe("full");
  } finally { await host.close(); }
});

it("sees an assignment another instance on this profile recorded, within seconds", async () => {
  const previous = getOwnerHostServices();
  onTestFinished(() => installOwnerHostServices(previous));
  await openAppState();
  configure("full");
  clearGatewayAssignedMemberRole();
  desktopFederationState.write("gatewayInstanceId", GATEWAY);
  expect(localMemberRole()).toBe("full");
  // The instance holding this profile's federation lease hears its gateway.
  desktopFederationState.write("gatewayAssignedRole", JSON.stringify({ gatewayInstanceId: GATEWAY, role: "contained" }));
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => { vi.useRealTimers(); });
  vi.setSystemTime(Date.now() + 5_001);
  expect(localMemberRole()).toBe("contained");
});
