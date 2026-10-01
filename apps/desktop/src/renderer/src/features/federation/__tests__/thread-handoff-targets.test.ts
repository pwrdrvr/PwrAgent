import { describe, expect, it } from "vitest";
import type { FederationHealthStatus } from "@pwragent/shared";
import {
  buildThreadHandoffTargets,
  describeThreadHandoffTargetAvailability,
} from "../thread-handoff-targets";

const RECEIVER_CAPABILITIES = [
  "thread_navigation",
  "turn_control",
  "environment_actions",
  "file_push",
  "thread_handoff",
] as const;

type Peer = FederationHealthStatus["peers"][number];

function peer(overrides: Partial<Peer> & Pick<Peer, "id" | "label">): Peer {
  return {
    role: "peer",
    status: "connected",
    capabilities: [...RECEIVER_CAPABILITIES],
    receiverPermissions: { filePush: true },
    ...overrides,
  } as Peer;
}

function health(peers: Peer[]): FederationHealthStatus {
  return {
    instanceId: "pwr_local",
    localLabel: "this-mac",
    peers,
  } as unknown as FederationHealthStatus;
}

describe("buildThreadHandoffTargets", () => {
  it("lists every peer with the reason it cannot receive, in label order", () => {
    const targets = buildThreadHandoffTargets(health([
      peer({ id: "pwr_d", label: "win-test", receiverPermissions: { filePush: false } as Peer["receiverPermissions"] }),
      peer({ id: "pwr_a", label: "studio-mac" }),
      peer({ id: "pwr_c", label: "old-mbp", status: "connecting" }),
      peer({
        id: "pwr_b",
        label: "build-linux",
        capabilities: RECEIVER_CAPABILITIES.filter((capability) => capability !== "thread_handoff"),
      }),
    ]));

    expect(targets.map((target) => [target.label, target.availability])).toEqual([
      ["build-linux", "update-required"],
      ["old-mbp", "offline"],
      ["studio-mac", "available"],
      ["win-test", "incoming-off"],
    ]);
  });

  it("treats a peer that does not report its receiver permissions as refusing files", () => {
    const [target] = buildThreadHandoffTargets(health([
      peer({ id: "pwr_a", label: "studio-mac", receiverPermissions: undefined }),
    ]));
    expect(target?.availability).toBe("incoming-off");
  });

  it("names an update before an outage, since an old build stays unable after it reconnects", () => {
    const [target] = buildThreadHandoffTargets(health([
      peer({
        id: "pwr_a",
        label: "old-mbp",
        status: "connecting",
        capabilities: ["thread_navigation"],
      }),
    ]));
    expect(target?.availability).toBe("update-required");
  });

  it("drops revoked peers and this instance", () => {
    const targets = buildThreadHandoffTargets(health([
      peer({ id: "pwr_a", label: "studio-mac", revokedAt: 1 }),
      peer({ id: "pwr_local", label: "this-mac" }),
      peer({ id: "pwr_b", label: "build-linux" }),
    ]));
    expect(targets.map((target) => target.instanceId)).toEqual(["pwr_b"]);
  });

  it("explains each unavailable row and nothing about an available one", () => {
    const base = { instanceId: "pwr_a", label: "studio-mac" };
    expect(describeThreadHandoffTargetAvailability({ ...base, availability: "available" }))
      .toBeUndefined();
    expect(describeThreadHandoffTargetAvailability({ ...base, availability: "incoming-off" }))
      .toBe("Turn on Allow file push in Settings › Federation on studio-mac");
    expect(describeThreadHandoffTargetAvailability({ ...base, availability: "update-required" }))
      .toBe("Update PwrAgent on studio-mac to receive threads");
  });
});
