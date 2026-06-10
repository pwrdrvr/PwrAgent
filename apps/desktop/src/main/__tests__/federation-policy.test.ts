import { describe, expect, it } from "vitest";
import { evaluateFederationSessionPolicy } from "../federation/federation-policy";
import { redactFederationDiagnostic } from "../federation/federation-redaction";
import { FederationSessionRegistry } from "../federation/federation-session-state";

describe("federation policy", () => {
  it("fails closed for unknown, revoked, version-mismatched, and denied peers", () => {
    expect(
      evaluateFederationSessionPolicy({
        peer: undefined,
        protocolVersion: 1,
        requestedCapabilities: ["remote_window"],
      }),
    ).toMatchObject({
      accepted: false,
      failure: { code: "unknown_peer" },
    });

    expect(
      evaluateFederationSessionPolicy({
        peer: {
          id: "child_one",
          label: "Child",
          role: "child",
          status: "revoked",
          revokedAt: 1_000,
          capabilities: ["remote_window"],
        },
        protocolVersion: 1,
        requestedCapabilities: ["remote_window"],
      }),
    ).toMatchObject({
      accepted: false,
      failure: { code: "revoked_peer" },
    });

    expect(
      evaluateFederationSessionPolicy({
        peer: {
          id: "child_one",
          label: "Child",
          role: "child",
          status: "connected",
          capabilities: ["remote_window"],
        },
        protocolVersion: 99,
        requestedCapabilities: ["remote_window"],
      }),
    ).toMatchObject({
      accepted: false,
      failure: { code: "invalid_protocol_version" },
    });

    expect(
      evaluateFederationSessionPolicy({
        peer: {
          id: "child_one",
          label: "Child",
          role: "child",
          status: "connected",
          capabilities: ["remote_window"],
        },
        protocolVersion: 1,
        requestedCapabilities: ["gateway_relay"],
      }),
    ).toMatchObject({
      accepted: false,
      failure: { code: "capability_denied" },
    });
  });

  it("redacts PEM blocks and token-like diagnostics", () => {
    expect(
      redactFederationDiagnostic(
        [
          "bad token abcdefghijklmnopqrstuvwxyz1234567890",
          "-----BEGIN PRIVATE KEY-----",
          "secret",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
      ),
    ).toBe("bad token [redacted-token]\n[redacted-pem]");
  });
});

describe("FederationSessionRegistry", () => {
  it("replaces duplicate sessions and closes revoked or stale sessions", () => {
    const registry = new FederationSessionRegistry();

    registry.openSession({
      sessionId: "session-1",
      peerId: "child_one",
      connectedAt: 1_000,
      capabilities: ["remote_window"],
    });
    registry.openSession({
      sessionId: "session-2",
      peerId: "child_one",
      connectedAt: 1_100,
      capabilities: ["remote_window"],
    });

    expect(registry.getSession("session-1")).toMatchObject({
      status: "closed",
      closeReason: "replaced",
    });
    expect(registry.listActiveSessions()).toMatchObject([
      { sessionId: "session-2", status: "active" },
    ]);

    expect(
      registry.closePeerSessions({
        peerId: "child_one",
        closedAt: 1_200,
        reason: "revoked",
      }),
    ).toHaveLength(1);
    expect(registry.listActiveSessions()).toEqual([]);

    registry.openSession({
      sessionId: "session-3",
      peerId: "child_two",
      connectedAt: 2_000,
      capabilities: ["federated_search"],
    });
    expect(
      registry.expireStaleSessions({
        now: 2_500,
        heartbeatTimeoutMs: 400,
      }),
    ).toMatchObject([{ sessionId: "session-3", closeReason: "timeout" }]);
  });
});
