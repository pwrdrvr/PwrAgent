import { describe, expect, it } from "vitest";
import {
  FEDERATION_PROTOCOL_VERSION,
  buildFederatedThreadRef,
  federatedThreadIdentityKey,
  federationTargetKey,
  isFederationCapability,
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
      "remote:mac-studio_home:acp%3Agemini:thread:with:colon",
    );
  });

  it("validates peer ids and capability names defensively", () => {
    expect(isFederationInstanceId("home-mac_1")).toBe(true);
    expect(isFederationInstanceId("ab")).toBe(false);
    expect(isFederationInstanceId("bad id")).toBe(false);
    expect(isFederationInstanceId("../bad")).toBe(false);
    expect(isFederationInstanceId("x".repeat(121))).toBe(false);

    expect(isFederationCapability("remote_window")).toBe(true);
    expect(isFederationCapability("unknown")).toBe(false);
  });

  it("keeps protocol envelopes correlated and versioned", () => {
    const request = {
      id: "req-1",
      kind: "request",
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "child-1",
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
      targetInstanceId: "child-1",
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
});
