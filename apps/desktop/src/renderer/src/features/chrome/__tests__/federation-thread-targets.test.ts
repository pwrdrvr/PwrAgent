import { describe, expect, it } from "vitest";
import type {
  FederationCapability,
  FederationHealthStatus,
} from "@pwragent/shared";
import { buildFederationThreadTargets } from "../federation-thread-targets";

const ALL_CAPABILITIES: FederationCapability[] = [
  "remote_window",
  "thread_navigation",
  "environment_actions",
];

function peer(
  overrides: Partial<FederationHealthStatus["peers"][number]> & { id: string },
): FederationHealthStatus["peers"][number] {
  return {
    capabilities: ALL_CAPABILITIES,
    label: overrides.id,
    role: "client",
    status: "connected",
    ...overrides,
  } as FederationHealthStatus["peers"][number];
}

function health(
  peers: FederationHealthStatus["peers"],
  overrides: Partial<FederationHealthStatus> = {},
): FederationHealthStatus {
  return {
    enabled: true,
    role: "gateway",
    status: "connected",
    peers,
    ...overrides,
  } as FederationHealthStatus;
}

describe("buildFederationThreadTargets", () => {
  it("returns nothing before health has been read", () => {
    expect(buildFederationThreadTargets(undefined)).toEqual([]);
  });

  it("sorts by display label so hover-menu rows do not move under the pointer", () => {
    const targets = buildFederationThreadTargets(
      health([
        peer({ id: "c", label: "Studio Mac" }),
        peer({ id: "a", label: "Attic Mini" }),
        peer({ id: "b", label: "Loft Laptop" }),
      ]),
    );

    expect(targets.map((target) => target.label)).toEqual([
      "Attic Mini",
      "Loft Laptop",
      "Studio Mac",
    ]);
  });

  it("marks a disconnected peer offline instead of dropping it", () => {
    const targets = buildFederationThreadTargets(
      health([peer({ id: "a", label: "Studio Mac", status: "disconnected" })]),
    );

    expect(targets).toEqual([
      { availability: "offline", instanceId: "a", label: "Studio Mac" },
    ]);
  });

  it("marks a peer missing any required capability unsupported", () => {
    const targets = buildFederationThreadTargets(
      health([
        peer({
          id: "a",
          label: "Attic Mini",
          capabilities: ["remote_window", "thread_navigation"],
        }),
      ]),
    );

    expect(targets[0]?.availability).toBe("unsupported");
  });

  it("drops revoked peers, which are dead entries rather than offline ones", () => {
    const targets = buildFederationThreadTargets(
      health([
        peer({ id: "a", label: "Studio Mac", revokedAt: 1 }),
        peer({ id: "b", label: "Loft Laptop" }),
      ]),
    );

    expect(targets.map((target) => target.instanceId)).toEqual(["b"]);
  });

  it("breaks label ties by instance id so health order cannot reshuffle rows", () => {
    // Same machine label, neither advertising a profile: the labels are equal,
    // so without a tiebreak the order would follow health order and could flip
    // between reads while the menu is open.
    const forward = buildFederationThreadTargets(
      health([
        peer({ id: "b", label: "Studio Mac" }),
        peer({ id: "a", label: "Studio Mac" }),
      ]),
    );
    const reversed = buildFederationThreadTargets(
      health([
        peer({ id: "a", label: "Studio Mac" }),
        peer({ id: "b", label: "Studio Mac" }),
      ]),
    );

    expect(forward.map((target) => target.instanceId)).toEqual(["a", "b"]);
    expect(reversed.map((target) => target.instanceId)).toEqual(["a", "b"]);
  });

  it("keeps the profile suffix when a peer shares this machine's label", () => {
    const targets = buildFederationThreadTargets(
      health([peer({ id: "a", label: "Studio Mac", profileName: "default" })], {
        localLabel: "Studio Mac",
        localProfileName: "work",
      }),
    );

    expect(targets[0]?.label).toBe("Studio Mac / default");
  });
});
