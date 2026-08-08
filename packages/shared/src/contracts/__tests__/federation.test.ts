import { describe, expect, it } from "vitest";
import {
  FEDERATION_PROTOCOL_VERSION,
  buildFederatedThreadRef,
  federatedThreadIdentityKey,
  federationTargetKey,
  formatFederationPeerDisplayLabel,
  isFederationCapability,
  isFederationEventClass,
  isFederationInstanceId,
  isRemoteFederationTarget,
  type FederationCapabilitySet,
  type FederationProtocolEnvelope,
  type NavigationSnapshot,
} from "../..";

describe("federation contracts", () => {
  it("represents local targets without fake peer ids", () => {
    const ref = buildFederatedThreadRef({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(ref).toEqual({
      backend: "codex",
      target: { scope: "local" },
      threadId: "thread-1",
    });
    expect(isRemoteFederationTarget(ref.target)).toBe(false);
    expect(federationTargetKey(ref.target)).toBe("local");
  });

  it("represents remote thread refs without losing backend identity", () => {
    const ref = buildFederatedThreadRef({
      backend: "acp:gemini",
      instanceId: "mac-studio_home",
      threadId: "thread:with:colon",
    });

    expect(ref.target).toEqual({
      scope: "remote",
      instanceId: "mac-studio_home",
    });
    expect(ref.backend).toBe("acp:gemini");
    expect(federationTargetKey(ref.target)).toBe("remote:mac-studio_home");
    expect(federatedThreadIdentityKey(ref)).toBe(
      "remote:mac-studio_home:acp:gemini:thread:with:colon",
    );
  });

  it("validates peer ids and capability names defensively", () => {
    expect(isFederationInstanceId("home-mac_1")).toBe(true);
    expect(isFederationInstanceId("ab")).toBe(false);
    expect(isFederationInstanceId("bad id")).toBe(false);
    expect(isFederationInstanceId("../bad")).toBe(false);
    expect(isFederationInstanceId("x".repeat(121))).toBe(false);

    expect(isFederationCapability("remote_window")).toBe(true);
    expect(isFederationCapability("scheduled_actions")).toBe(true);
    expect(isFederationCapability("launchpad_metadata")).toBe(true);
    expect(isFederationCapability("event_subscriptions")).toBe(true);
    expect(isFederationCapability("unknown")).toBe(false);
    expect(isFederationEventClass("navigation")).toBe(true);
    expect(isFederationEventClass("pending_requests")).toBe(true);
    expect(isFederationEventClass("everything")).toBe(false);
  });

  it("keeps protocol envelopes correlated and versioned", () => {
    const request = {
      id: "req-1",
      kind: "request",
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "client-1",
      targetInstanceId: "gateway-1",
      method: "appServer.getNavigationSnapshot",
      createdAt: 1,
      deadlineAt: 1001,
      params: { backend: "all" },
    } satisfies FederationProtocolEnvelope;

    const response = {
      id: "res-1",
      kind: "response",
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      requestId: request.id,
      sourceInstanceId: "gateway-1",
      targetInstanceId: "client-1",
      createdAt: 2,
      result: { ok: true },
    } satisfies FederationProtocolEnvelope;

    expect(request.kind).toBe("request");
    expect(response.requestId).toBe(request.id);
  });

  it("allows navigation snapshots to carry remote source labels through shared contracts", () => {
    const capabilities = {
      capabilities: ["thread_navigation", "remote_window"],
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
    } satisfies FederationCapabilitySet;
    const snapshot = {
      backend: "all",
      fetchedAt: 123,
      federationTarget: {
        scope: "remote",
        instanceId: "home-mac",
      },
      unchanged: false,
      threads: [],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    } satisfies NavigationSnapshot;

    expect(capabilities.capabilities).toContain("remote_window");
    expect(snapshot.federationTarget?.scope).toBe("remote");
  });

  it("composes peer display labels by profile and machine collisions", () => {
    const lonelyDefault = { label: "Mac-Mini-M4", profileName: "default" };
    expect(
      formatFederationPeerDisplayLabel(lonelyDefault, [lonelyDefault]),
    ).toBe("Mac-Mini-M4");

    const devProfile = { label: "Mac-Mini-M4", profileName: "dev" };
    expect(formatFederationPeerDisplayLabel(devProfile, [devProfile])).toBe(
      "Mac-Mini-M4 / dev",
    );

    // Several profiles of one machine: even "default" shows its profile
    // so the entries stay distinguishable.
    const sameMachine = [
      { label: "Mac-Mini-M4", profileName: "default" },
      { label: "Mac-Mini-M4", profileName: "dev" },
      { label: "Mac-Mini-M4", profileName: "work" },
    ];
    expect(
      formatFederationPeerDisplayLabel(sameMachine[0]!, sameMachine),
    ).toBe("Mac-Mini-M4 / default");
    expect(
      formatFederationPeerDisplayLabel(sameMachine[1]!, sameMachine),
    ).toBe("Mac-Mini-M4 / dev");

    // A different machine in the set doesn't force the profile suffix.
    const otherMachine = { label: "MBP-16", profileName: "default" };
    expect(
      formatFederationPeerDisplayLabel(otherMachine, [
        otherMachine,
        ...sameMachine,
      ]),
    ).toBe("MBP-16");

    // Peers that never advertised a profile keep the bare label.
    const legacyPeer = { label: "Mac-Mini-M4" };
    expect(
      formatFederationPeerDisplayLabel(legacyPeer, [
        legacyPeer,
        devProfile,
      ]),
    ).toBe("Mac-Mini-M4");

    // A revoked sibling enrollment is a dead entry — it must not force
    // "/ default" onto the machine's one live peer.
    expect(
      formatFederationPeerDisplayLabel(lonelyDefault, [
        lonelyDefault,
        { label: "Mac-Mini-M4", profileName: "dev", revokedAt: 5_000 },
      ]),
    ).toBe("Mac-Mini-M4");
  });
});
