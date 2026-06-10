import { describe, expect, it } from "vitest";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import {
  generateFederationIdentityKeyPair,
  getOrCreateFederationIdentity,
  signFederationMessage,
  verifyFederationMessageSignature,
} from "../federation/federation-identity";

describe("federation identity", () => {
  it("generates an Ed25519 identity and verifies signatures", () => {
    const keyPair = generateFederationIdentityKeyPair();
    const signatureBase64 = signFederationMessage({
      privateKeyPem: keyPair.privateKeyPem,
      message: "hello",
    });

    expect(
      verifyFederationMessageSignature({
        publicKeyPem: keyPair.publicKeyPem,
        message: "hello",
        signatureBase64,
      }),
    ).toBe(true);
    expect(
      verifyFederationMessageSignature({
        publicKeyPem: keyPair.publicKeyPem,
        message: "tampered",
        signatureBase64,
      }),
    ).toBe(false);
  });

  it("stores the local private key and reuses it", async () => {
    const secretStore = new MemoryDesktopSecretStore();

    const first = await getOrCreateFederationIdentity(secretStore);
    const second = await getOrCreateFederationIdentity(secretStore);

    expect(first.publicKeyPem).toBe(second.publicKeyPem);
    expect(
      await secretStore.getSecret("federationInstancePrivateKey"),
    ).toContain("BEGIN PRIVATE KEY");
  });
});
