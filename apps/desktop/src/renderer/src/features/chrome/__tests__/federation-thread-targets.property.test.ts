import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  FederationCapability,
  FederationConnectionState,
  FederationHealthStatus,
} from "@pwragent/shared";
import {
  buildFederationThreadTargets,
  listedFederationPeerTargets,
} from "../federation-thread-targets";
import { buildThreadHandoffTargets } from "../../federation/thread-handoff-targets";

type Peer = FederationHealthStatus["peers"][number];

const STATES: FederationConnectionState[] = [
  "connecting",
  "handshaking",
  "connected",
  "degraded",
  "disconnected",
];
const CAPABILITY_SETS: FederationCapability[][] = [
  [],
  ["thread_navigation"],
  ["thread_navigation", "launchpad_metadata", "environment_actions"],
  [
    "thread_navigation",
    "launchpad_metadata",
    "environment_actions",
    "thread_handoff",
    "turn_control",
    "file_push",
  ],
];
// Host labels whose order differs from their short names' order, the way
// "Harold-PC" sorts before "Harold-MBP-M2-Max" while the rows read
// "Win PC" and "M2 Max".
const HOSTS = [
  { label: "Host-A", shortLabel: "Zulu" },
  { label: "Host-B", shortLabel: "Alpha" },
  { label: "Host-C", shortLabel: "Mike" },
  { label: "Host-D", shortLabel: undefined },
];

const peerArb = fc.record({
  host: fc.constantFrom(...HOSTS),
  profileName: fc.constantFrom(undefined, "default", "dev"),
  status: fc.constantFrom(...STATES),
  capabilities: fc.constantFrom(...CAPABILITY_SETS),
  revoked: fc.boolean(),
});

const healthArb = fc
  .uniqueArray(peerArb, { maxLength: 8, selector: (peer) => `${peer.host.label}/${peer.profileName}` })
  .map((peers): FederationHealthStatus => ({
    enabled: true,
    role: "gateway",
    status: "connected",
    peers: peers.map((peer, index): Peer => ({
      id: `pwr_${index}`,
      label: peer.host.label,
      role: "client",
      status: peer.status,
      capabilities: peer.capabilities,
      ...(peer.host.shortLabel ? { shortLabel: peer.host.shortLabel } : {}),
      ...(peer.profileName ? { profileName: peer.profileName } : {}),
      ...(peer.revoked ? { revokedAt: 1 } : {}),
    } as Peer)),
  } as FederationHealthStatus));

function connectedIds(health: FederationHealthStatus): string[] {
  return health.peers
    .filter((peer) => !peer.revokedAt && peer.status === "connected")
    .map((peer) => peer.id)
    .sort();
}

describe("machine pickers", () => {
  // The rule Profiles → Remote Instances already follows: a picker lists the
  // connected machines and nothing else, in the order of the name each row
  // shows, so the list cannot look shuffled or offer a machine that is down.
  it("list exactly the connected peers, ordered by the name on the row", () => {
    fc.assert(fc.property(healthArb, (health) => {
      for (const listed of [
        listedFederationPeerTargets(buildFederationThreadTargets(health)),
        listedFederationPeerTargets(buildThreadHandoffTargets(health)),
      ]) {
        expect(listed.map((target) => target.instanceId).sort()).toEqual(connectedIds(health));
        const shown = listed.map((target) => target.shortLabel ?? target.label);
        for (let index = 1; index < shown.length; index += 1) {
          expect(shown[index - 1]!.localeCompare(shown[index]!)).toBeLessThanOrEqual(0);
        }
      }
    }), { numRuns: 300 });
  });

  it("keep the chosen machine while it is offline, and nothing else that is", () => {
    fc.assert(fc.property(healthArb, fc.nat(), (health, pick) => {
      const targets = buildFederationThreadTargets(health);
      if (targets.length === 0) return;
      const chosen = targets[pick % targets.length]!;
      const listed = listedFederationPeerTargets(targets, chosen.instanceId);
      expect(listed.some((target) => target.instanceId === chosen.instanceId)).toBe(true);
      expect(listed.filter((target) =>
        target.availability === "offline" && target.instanceId !== chosen.instanceId)).toEqual([]);
    }), { numRuns: 200 });
  });
});
