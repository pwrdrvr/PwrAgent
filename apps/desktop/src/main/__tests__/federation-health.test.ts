import { describe, expect, it } from "vitest";
import type {
  DesktopFederationMode,
  DesktopSettingsSnapshot,
  FederationPeerSummary,
} from "@pwragent/shared";
import {
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
