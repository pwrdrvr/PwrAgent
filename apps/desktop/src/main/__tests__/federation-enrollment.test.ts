import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFederationProofMessage,
  completeFederationEnrollment,
  createFederationEnrollmentInvite,
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

  it("authenticates enrolled reconnects and rejects denied capabilities", () => {
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
          message,
        }),
        now: 2_100,
      }),
    ).toMatchObject({
      accepted: false,
      failure: { code: "capability_denied" },
    });
  });
});
