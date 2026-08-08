import { describe, expect, it } from "vitest";
import type {
  DesktopFederationMode,
  DesktopSettingsSnapshot,
  FederationHealthStatus,
  FederationPeerSummary,
} from "@pwragent/shared";
import type { RuntimeFederationLeaseSnapshot } from "../runtime-federation-lease";
import {
  applyFederationLeaseSnapshot,
  buildFederationHealthStatus,
  publicPeerSummary,
} from "../federation/federation-health";

describe("federation health", () => {
  it("reports the configured listener and peers without exposing key material", () => {
    const peer = {
      id: "client_one",
      label: "Studio Mac",
      role: "client",
      status: "connected",
      capabilities: ["thread_navigation"],
      protocolVersion: 1,
      endpoint: "wss://pwragent.example.com/federation",
      pinnedPublicKeyPem: "secret-public-key",
    } as FederationPeerSummary & { pinnedPublicKeyPem: string };

    const health = buildFederationHealthStatus({
      settings: settingsSnapshot({
        mode: "gateway",
        publicUrl: "wss://pwragent.example.com/federation",
      }),
      peers: [peer],
      instanceId: "master_one",
      listenUrl: "ws://127.0.0.1:8765",
    });

    expect(health).toMatchObject({
      enabled: true,
      role: "gateway",
      status: "listening",
      instanceId: "master_one",
      listenUrl: "ws://127.0.0.1:8765",
      publicUrl: "wss://pwragent.example.com/federation",
    });
    expect(health.peers[0]).toEqual({
      id: "client_one",
      label: "Studio Mac",
      role: "client",
      status: "connected",
      capabilities: ["thread_navigation"],
      canRevoke: undefined,
      protocolVersion: 1,
      endpoint: "wss://pwragent.example.com/federation",
      profileName: undefined,
      lastConnectedAt: undefined,
      lastActivityAt: undefined,
      revokedAt: undefined,
      unavailableReason: undefined,
    });
    expect("pinnedPublicKeyPem" in health.peers[0]).toBe(false);
  });

  it("reports disabled mode without listener or public URL", () => {
    const health = buildFederationHealthStatus({
      settings: settingsSnapshot({ mode: "disabled", publicUrl: "" }),
      peers: [],
    });

    expect(health.enabled).toBe(false);
    expect(health.status).toBe("disabled");
    expect(health.listenUrl).toBeUndefined();
    expect(health.publicUrl).toBeUndefined();
  });

  it("reports a bind failure instead of claiming the configured listener", () => {
    const health = buildFederationHealthStatus({
      settings: settingsSnapshot({ mode: "gateway", publicUrl: "" }),
      peers: [],
      unavailableReason: "listen EADDRINUSE: address already in use 127.0.0.1:8765",
    });

    expect(health.status).toBe("degraded");
    expect(health.listenUrl).toBeUndefined();
    expect(health.unavailableReason).toContain("EADDRINUSE");
  });

  it("copies peer capabilities when normalizing public summaries", () => {
    const peer: FederationPeerSummary = {
      id: "client_one",
      label: "Studio Mac",
      role: "client",
      status: "connected",
      capabilities: ["thread_navigation"],
    };

    const summary = publicPeerSummary(peer);
    summary.capabilities.push("thread_detail");

    expect(peer.capabilities).toEqual(["thread_navigation"]);
  });
});

describe("applyFederationLeaseSnapshot", () => {
  const stoppedHealth = (): FederationHealthStatus => ({
    enabled: true,
    role: "client",
    status: "disconnected",
    peers: [],
  });
  const leaseHeldElsewhere = (
    overrides: Partial<RuntimeFederationLeaseSnapshot> = {},
  ): RuntimeFederationLeaseSnapshot => ({
    instanceId: "instance-b",
    leaseHeld: false,
    disabledReasonKind: "lease_held",
    disabledReason:
      "Federation is already active in another PwrAgent instance for this profile.",
    ...overrides,
  });

  it("reports the live holder as degraded with its identity", () => {
    const health = stoppedHealth();

    applyFederationLeaseSnapshot(
      health,
      leaseHeldElsewhere({
        leaseHolder: {
          instanceId: "instance-a",
          processId: 123,
          cwdHint: "PwrAgnt-a",
          expiresAt: 31_000,
        },
      }),
    );

    expect(health).toMatchObject({
      status: "degraded",
      unavailableReason:
        "Federation is already active in another PwrAgent instance for this profile.",
      leaseHolder: {
        instanceId: "instance-a",
        processId: 123,
        cwdHint: "PwrAgnt-a",
      },
    });
  });

  it("keeps the lease-held reason after the holder's lease record disappears", () => {
    // The holder released or expired, so snapshot() no longer carries
    // leaseHolder — but this instance is still deliberately stopped and
    // health must keep saying why instead of reverting to "disconnected".
    const health = stoppedHealth();

    applyFederationLeaseSnapshot(health, leaseHeldElsewhere());

    expect(health).toMatchObject({
      status: "degraded",
      unavailableReason:
        "Federation is already active in another PwrAgent instance for this profile.",
    });
    expect(health.leaseHolder).toBeUndefined();
  });

  it("leaves health untouched while this instance holds the lease", () => {
    const health = stoppedHealth();

    applyFederationLeaseSnapshot(
      health,
      leaseHeldElsewhere({ leaseHeld: true, disabledReasonKind: undefined }),
    );

    expect(health).toMatchObject({
      status: "disconnected",
    });
    expect(health.unavailableReason).toBeUndefined();
  });

  it("leaves disabled-mode health untouched", () => {
    const health: FederationHealthStatus = {
      enabled: false,
      role: "client",
      status: "disabled",
      peers: [],
    };

    applyFederationLeaseSnapshot(health, leaseHeldElsewhere());

    expect(health).toMatchObject({
      status: "disabled",
    });
    expect(health.unavailableReason).toBeUndefined();
  });
});

function settingsSnapshot(params: {
  mode: DesktopFederationMode;
  publicUrl: string;
}): DesktopSettingsSnapshot {
  return {
    federation: {
      mode: { value: params.mode, source: "config" },
      listenHost: { value: "127.0.0.1", source: "config" },
      listenPort: { value: 8765, source: "config" },
      publicUrl: { value: params.publicUrl, source: "config" },
    },
  } as DesktopSettingsSnapshot;
}
