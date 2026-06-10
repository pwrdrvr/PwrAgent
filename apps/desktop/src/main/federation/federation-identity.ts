import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { DesktopSecretStore } from "../settings/desktop-secret-store";

const FEDERATION_PRIVATE_KEY_SECRET = "federationInstancePrivateKey";

export type FederationIdentity = {
  publicKeyPem: string;
};

export type FederationIdentityKeyPair = {
  publicKeyPem: string;
  privateKeyPem: string;
};

export async function getOrCreateFederationIdentity(
  secretStore: DesktopSecretStore,
): Promise<FederationIdentity> {
  const existing = await secretStore.getSecret(FEDERATION_PRIVATE_KEY_SECRET);
  const privateKeyPem = existing ?? generateFederationIdentityKeyPair().privateKeyPem;
  if (!existing) {
    await secretStore.setSecret(FEDERATION_PRIVATE_KEY_SECRET, privateKeyPem);
  }
  return {
    publicKeyPem: publicKeyPemFromPrivateKey(privateKeyPem),
  };
}

export function generateFederationIdentityKeyPair(): FederationIdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signFederationMessage(params: {
  privateKeyPem: string;
  message: string;
}): string {
  const signature = sign(
    null,
    Buffer.from(params.message, "utf8"),
    createPrivateKey(params.privateKeyPem),
  );
  return signature.toString("base64");
}

export function verifyFederationMessageSignature(params: {
  publicKeyPem: string;
  message: string;
  signatureBase64: string;
}): boolean {
  try {
    return verify(
      null,
      Buffer.from(params.message, "utf8"),
      createPublicKey(params.publicKeyPem),
      Buffer.from(params.signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

export function publicKeyPemFromPrivateKey(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: "spki", format: "pem" })
    .toString();
}
