import type { DesktopSecretStore } from "../settings/desktop-secret-store";
import { generateFederationIdentityKeyPair, publicKeyPemFromPrivateKey, type FederationIdentity } from "@pwragent/federation/federation-identity";
export * from "@pwragent/federation/federation-identity";

const FEDERATION_PRIVATE_KEY_SECRET = "federationInstancePrivateKey";

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
