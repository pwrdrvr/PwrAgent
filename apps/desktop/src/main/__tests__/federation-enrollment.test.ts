import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEDERATION_INVITE_VERSION } from "@pwragent/shared";
import {
  buildFederationProofMessage,
  completeFederationEnrollment,
  createFederationEnrollmentInvite,
  decodeFederationInvite,
  encodeFederationInvite,
  authenticateFederationReconnect,
} from "../federation/federation-enrollment";
import {
  generateFederationIdentityKeyPair,
  signFederationMessage,
} from "../federation/federation-identity";
import { FederationStore } from "../federation/federation-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: FederationStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-federation-auth-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new FederationStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("federation enrollment", () => {
  it("carries the pinned gateway signing and Noise keys in a one-time invite", () => {
    const gatewayKeyPair = generateFederationIdentityKeyPair();
    const gatewayNoisePublicKey = "gateway-noise-public-key";
    const invite = encodeFederationInvite({
      version: FEDERATION_INVITE_VERSION,
      token: "invite-token-1234567890",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      gatewayNoisePublicKey,
      gatewayUrl: "ws://127.0.0.1:47830",
      expiresAt: 2_000,
    });

    expect(decodeFederationInvite(invite, 1_000)).toEqual({
      version: FEDERATION_INVITE_VERSION,
      token: "invite-token-1234567890",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      gatewayNoisePublicKey,
      gatewayUrl: "ws://127.0.0.1:47830",
      expiresAt: 2_000,
    });
    expect(() => decodeFederationInvite(invite, 2_000)).toThrow(
      "Federation invite has expired.",
    );
  });

  it("round-trips an ordered multi-endpoint invite at the same version", () => {
    const gatewayKeyPair = generateFederationIdentityKeyPair();
    const gatewayEndpoints = [
      "ws://192.168.1.20:47830",
      "wss://studio.example.ts.net/pwragent-federation",
      "wss://federation.example.com",
    ];
    const invite = encodeFederationInvite({
      version: FEDERATION_INVITE_VERSION,
      token: "invite-token-multipath",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      gatewayNoisePublicKey: "gateway-noise-public-key",
      gatewayUrl: gatewayEndpoints[0],
      gatewayEndpoints,
      expiresAt: 2_000,
    });

    const decoded = decodeFederationInvite(invite, 1_000);
    expect(decoded.version).toBe(FEDERATION_INVITE_VERSION);
    expect(decoded.gatewayUrl).toBe(gatewayEndpoints[0]);
    expect(decoded.gatewayEndpoints).toEqual(gatewayEndpoints);
  });

  it("rejects invites with a malformed endpoint list", () => {
    const base = {
      version: FEDERATION_INVITE_VERSION,
      token: "invite-token-bad-endpoints",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: "gateway-key",
      gatewayNoisePublicKey: "gateway-noise-key",
      gatewayUrl: "ws://127.0.0.1:47830",
      expiresAt: 2_000,
    };
    for (const gatewayEndpoints of [
      [],
      ["ws://ok.example", 7],
      "not-a-list",
      // An invite is unsigned, attacker-authored input that never passes
      // through the renderer, so the scheme allowlist is enforced on decode.
      ["https://evil.example"],
      ["ws://ok.example", "https://evil.example"],
      ["ssh://user:secret@host"],
      ["ssh://-oProxyCommand=touch%20pwned"],
    ]) {
      const invite = `pwragent-federation:${Buffer.from(
        JSON.stringify({ ...base, gatewayEndpoints }),
        "utf8",
      ).toString("base64url")}`;
      expect(() => decodeFederationInvite(invite, 1_000)).toThrow(
        /Invalid federation invite\.|must all be ws:\/\//,
      );
    }
  });

  it("rejects an invite whose gateway URL is not a supported endpoint", () => {
    const invite = `pwragent-federation:${Buffer.from(
      JSON.stringify({
        version: FEDERATION_INVITE_VERSION,
        token: "invite-token-bad-url",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: "gateway-key",
        gatewayNoisePublicKey: "gateway-noise-key",
        gatewayUrl: "https://evil.example",
        expiresAt: 2_000,
      }),
      "utf8",
    ).toString("base64url")}`;

    expect(() => decodeFederationInvite(invite, 1_000)).toThrow(
      /must be a ws:\/\/, wss:\/\/, or ssh:\/\/ endpoint/,
    );
  });

  it("rejects unsupported invite versions before attempting enrollment", () => {
    const unsupportedInvite = `pwragent-federation:${Buffer.from(JSON.stringify({
      version: FEDERATION_INVITE_VERSION + 1,
      token: "unsupported-token",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: "unsupported-key",
      gatewayNoisePublicKey: "unsupported-noise-key",
      gatewayUrl: "ws://127.0.0.1:47830",
      expiresAt: 2_000,
    }), "utf8").toString("base64url")}`;

    expect(() => decodeFederationInvite(unsupportedInvite, 1_000)).toThrow(
      `Unsupported federation invite version. Expected version ${FEDERATION_INVITE_VERSION}.`,
    );
  });

  it("enrolls a peer with a valid invite and signed key proof", () => {
    const keyPair = generateFederationIdentityKeyPair();
    const capabilities = ["remote_window", "federated_search"] as const;
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-1234567890",
      gatewayInstanceId: "gateway_one",
      generatedAt: 1_000,
      expiresAt: 2_000,
    });
    const message = buildFederationProofMessage({
      purpose: "enroll",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      publicKeyPem: keyPair.publicKeyPem,
      protocolVersion: 1,
      nonce: "nonce-1",
      capabilities,
    });

    const decision = completeFederationEnrollment({
      store,
      gatewayInstanceId: "gateway_one",
      inviteToken: invite.token,
      now: 1_500,
      peer: {
        instanceId: "client_one",
        label: "Client",
        role: "client",
        publicKeyPem: keyPair.publicKeyPem,
        capabilities,
        protocolVersion: 1,
        nonce: "nonce-1",
        signatureBase64: signFederationMessage({
          privateKeyPem: keyPair.privateKeyPem,
          message,
        }),
      },
    });

    expect(decision).toMatchObject({
      accepted: true,
      peer: {
        id: "client_one",
        label: "Client",
        status: "connected",
        capabilities,
      },
    });
    expect(store.getPeer("client_one")).toMatchObject({
      pinnedPublicKeyPem: keyPair.publicKeyPem,
    });
    expect(store.getEnrollment(invite.id)).toMatchObject({
      status: "used",
      peerId: "client_one",
    });
  });

  it("restores a revoked peer through a fresh one-time enrollment", () => {
    const keyPair = generateFederationIdentityKeyPair();
    store.upsertPeer({
      updatedAt: 1_000,
      peer: {
        id: "client_one",
        label: "Client",
        role: "client",
        status: "connected",
        capabilities: ["remote_window"],
        protocolVersion: 1,
        pinnedPublicKeyPem: keyPair.publicKeyPem,
      },
    });
    store.revokePeer("client_one", 1_100);

    const invite = createFederationEnrollmentInvite({
      store,
      token: "fresh-invite-token-1234567890",
      gatewayInstanceId: "gateway_one",
      generatedAt: 1_200,
      expiresAt: 2_000,
    });
    const capabilities = ["remote_window"] as const;
    const enrollMessage = buildFederationProofMessage({
      purpose: "enroll",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      publicKeyPem: keyPair.publicKeyPem,
      protocolVersion: 1,
      nonce: "nonce-reenroll",
      capabilities,
    });

    expect(
      completeFederationEnrollment({
        store,
        gatewayInstanceId: "gateway_one",
        inviteToken: invite.token,
        now: 1_500,
        peer: {
          instanceId: "client_one",
          label: "Client",
          role: "client",
          publicKeyPem: keyPair.publicKeyPem,
          capabilities,
          protocolVersion: 1,
          nonce: "nonce-reenroll",
          signatureBase64: signFederationMessage({
            privateKeyPem: keyPair.privateKeyPem,
            message: enrollMessage,
          }),
        },
      }),
    ).toMatchObject({
      accepted: true,
      peer: { id: "client_one", status: "connected" },
    });
    expect(store.getPeer("client_one")?.revokedAt).toBeUndefined();

    const reconnectMessage = buildFederationProofMessage({
      purpose: "reconnect",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      publicKeyPem: keyPair.publicKeyPem,
      protocolVersion: 1,
      nonce: "nonce-after-restart",
      capabilities,
    });
    expect(
      authenticateFederationReconnect({
        store,
        gatewayInstanceId: "gateway_one",
        peerInstanceId: "client_one",
        protocolVersion: 1,
        nonce: "nonce-after-restart",
        requestedCapabilities: capabilities,
        signatureBase64: signFederationMessage({
          privateKeyPem: keyPair.privateKeyPem,
          message: reconnectMessage,
        }),
        now: 1_600,
      }),
    ).toMatchObject({
      accepted: true,
      peer: { id: "client_one", status: "connected" },
    });
  });

  it("rejects bad signatures, wrong gateway invites, and reused invites", () => {
    const keyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-1234567890",
      gatewayInstanceId: "gateway_one",
      generatedAt: 1_000,
      expiresAt: 2_000,
    });
    const message = buildFederationProofMessage({
      purpose: "enroll",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      publicKeyPem: keyPair.publicKeyPem,
      protocolVersion: 1,
      nonce: "nonce-1",
      capabilities: ["remote_window"],
    });

    expect(
      completeFederationEnrollment({
        store,
        gatewayInstanceId: "gateway_two",
        inviteToken: invite.token,
        now: 1_500,
        peer: {
          instanceId: "client_one",
          label: "Client",
          role: "client",
          publicKeyPem: keyPair.publicKeyPem,
          capabilities: ["remote_window"],
          protocolVersion: 1,
          nonce: "nonce-1",
          signatureBase64: signFederationMessage({
            privateKeyPem: keyPair.privateKeyPem,
            message,
          }),
        },
      }),
    ).toMatchObject({
      accepted: false,
      failure: { code: "wrong_gateway" },
    });

    expect(
      completeFederationEnrollment({
        store,
        gatewayInstanceId: "gateway_one",
        inviteToken: invite.token,
        now: 1_500,
        peer: {
          instanceId: "client_one",
          label: "Client",
          role: "client",
          publicKeyPem: keyPair.publicKeyPem,
          capabilities: ["remote_window"],
          protocolVersion: 1,
          nonce: "nonce-1",
          signatureBase64: signFederationMessage({
            privateKeyPem: keyPair.privateKeyPem,
            message: "tampered",
          }),
        },
      }),
    ).toMatchObject({
      accepted: false,
      failure: { code: "bad_signature" },
    });

    const accepted = completeFederationEnrollment({
      store,
      gatewayInstanceId: "gateway_one",
      inviteToken: invite.token,
      now: 1_500,
      peer: {
        instanceId: "client_one",
        label: "Client",
        role: "client",
        publicKeyPem: keyPair.publicKeyPem,
        capabilities: ["remote_window"],
        protocolVersion: 1,
        nonce: "nonce-1",
        signatureBase64: signFederationMessage({
          privateKeyPem: keyPair.privateKeyPem,
          message,
        }),
      },
    });
    expect(accepted.accepted).toBe(true);
    expect(
      completeFederationEnrollment({
        store,
        gatewayInstanceId: "gateway_one",
        inviteToken: invite.token,
        now: 1_600,
        peer: {
          instanceId: "client_two",
          label: "Client 2",
          role: "client",
          publicKeyPem: keyPair.publicKeyPem,
          capabilities: ["remote_window"],
          protocolVersion: 1,
          nonce: "nonce-2",
          signatureBase64: signFederationMessage({
            privateKeyPem: keyPair.privateKeyPem,
            message,
          }),
        },
      }),
    ).toMatchObject({
      accepted: false,
      failure: { code: "missing_invite" },
    });
  });

  it("authenticates enrolled reconnects and grants newly advertised capabilities", () => {
    const keyPair = generateFederationIdentityKeyPair();
    store.upsertPeer({
      updatedAt: 1_000,
      peer: {
        id: "client_one",
        label: "Client",
        role: "client",
        status: "disconnected",
        capabilities: ["remote_window"],
        protocolVersion: 1,
        pinnedPublicKeyPem: keyPair.publicKeyPem,
      },
    });
    const message = buildFederationProofMessage({
      purpose: "reconnect",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      publicKeyPem: keyPair.publicKeyPem,
      protocolVersion: 1,
      nonce: "nonce-3",
      capabilities: ["remote_window"],
    });

    expect(
      authenticateFederationReconnect({
        store,
        gatewayInstanceId: "gateway_one",
        peerInstanceId: "client_one",
        protocolVersion: 1,
        nonce: "nonce-3",
        requestedCapabilities: ["remote_window"],
        signatureBase64: signFederationMessage({
          privateKeyPem: keyPair.privateKeyPem,
          message,
        }),
        now: 2_000,
      }),
    ).toMatchObject({
      accepted: true,
      peer: { id: "client_one", status: "connected" },
    });

    // Enrollment is identity trust, not a capability allowlist: a
    // capability the stored row has never seen (e.g. added by a newer
    // build) is granted, not rejected — rejecting would break every
    // pairing on upgrade. Note the proof must sign the actual request.
    const relayMessage = buildFederationProofMessage({
      purpose: "reconnect",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      publicKeyPem: keyPair.publicKeyPem,
      protocolVersion: 1,
      nonce: "nonce-4",
      capabilities: ["gateway_relay"],
    });
    expect(
      authenticateFederationReconnect({
        store,
        gatewayInstanceId: "gateway_one",
        peerInstanceId: "client_one",
        protocolVersion: 1,
        nonce: "nonce-4",
        requestedCapabilities: ["gateway_relay"],
        signatureBase64: signFederationMessage({
          privateKeyPem: keyPair.privateKeyPem,
          message: relayMessage,
        }),
        now: 2_100,
      }),
    ).toMatchObject({
      accepted: true,
      capabilities: ["gateway_relay"],
    });
  });

  it("refreshes the stored profile name on reconnect", () => {
    const keyPair = generateFederationIdentityKeyPair();
    // Enrolled before profiles were advertised: no stored profileName.
    store.upsertPeer({
      updatedAt: 1_000,
      peer: {
        id: "client_one",
        label: "Mac-Mini-M4",
        role: "client",
        status: "disconnected",
        capabilities: ["remote_window"],
        protocolVersion: 1,
        pinnedPublicKeyPem: keyPair.publicKeyPem,
      },
    });
    const message = buildFederationProofMessage({
      purpose: "reconnect",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      publicKeyPem: keyPair.publicKeyPem,
      protocolVersion: 1,
      nonce: "nonce-profile",
      capabilities: ["remote_window"],
    });

    expect(
      authenticateFederationReconnect({
        store,
        gatewayInstanceId: "gateway_one",
        peerInstanceId: "client_one",
        protocolVersion: 1,
        nonce: "nonce-profile",
        requestedCapabilities: ["remote_window"],
        signatureBase64: signFederationMessage({
          privateKeyPem: keyPair.privateKeyPem,
          message,
        }),
        now: 2_000,
        label: "Mac-Mini-M4",
        profileName: "dev",
      }),
    ).toMatchObject({
      accepted: true,
      peer: { id: "client_one", profileName: "dev" },
    });
    expect(store.getPeer("client_one")?.profileName).toBe("dev");
  });

  it("refreshes stored capabilities to the peer's current advertisement", () => {
    const keyPair = generateFederationIdentityKeyPair();
    store.upsertPeer({
      updatedAt: 1_000,
      peer: {
        id: "client_one",
        label: "Client",
        role: "client",
        status: "disconnected",
        capabilities: ["remote_window", "federated_search"],
        protocolVersion: 1,
        pinnedPublicKeyPem: keyPair.publicKeyPem,
      },
    });
    const message = buildFederationProofMessage({
      purpose: "reconnect",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      publicKeyPem: keyPair.publicKeyPem,
      protocolVersion: 1,
      nonce: "nonce-subset",
      capabilities: ["remote_window"],
    });

    const result = authenticateFederationReconnect({
      store,
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      protocolVersion: 1,
      nonce: "nonce-subset",
      requestedCapabilities: ["remote_window"],
      signatureBase64: signFederationMessage({
        privateKeyPem: keyPair.privateKeyPem,
        message,
      }),
      now: 2_000,
    });

    expect(result).toMatchObject({
      accepted: true,
      capabilities: ["remote_window"],
    });
    // The stored row tracks what the peer's current build advertises —
    // it is informational, not an allowlist, so the dropped capability
    // disappears rather than being preserved.
    expect(store.getPeer("client_one")?.capabilities).toEqual([
      "remote_window",
    ]);
  });
});
