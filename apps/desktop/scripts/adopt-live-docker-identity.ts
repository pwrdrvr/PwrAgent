import fs from "node:fs";
import path from "node:path";
import { publicKeyPemFromPrivateKey } from "@pwragent/federation/federation-identity";
import { noiseKeyPairFromRawPrivate } from "@pwragent/federation/federation-noise";
import { StateDb } from "../src/main/state/state-db";
import { createFileKeyEncryption } from "../src/main/headless/file-key-encryption";
import { acquireHeadlessOwnerLock, type HeadlessOwnerLock } from "../src/main/headless/owner-lock";
import { DesktopConfigStore } from "../src/main/settings/config-store/desktop-config-store";

const LIVE_INSTANCE = "4f9b407d-2bb9-4893-9b98-28b88952a3de";
const MINI_GATEWAY = "pwr_3d822fab-1b7c-4f8e-9d5a-c765d818ad97";

/** One-off operator migration, while the Docker owner is stopped and backed up.
 * This deliberately cannot import any other identity, job, invite or profile. */
export async function adoptLiveDockerOutpost(source: string, profileDirectory: string): Promise<void> {
  const saved = JSON.parse(fs.readFileSync(source, "utf8")) as {
    version: number; instanceId: string; label: string;
    identity: { privateKeyPem: string; publicKeyPem: string };
    noise: { privateKeyBase64: string; publicKeyBase64: string };
    gateway: { gatewayInstanceId: string; gatewayPublicKeyPem: string; gatewayNoisePublicKey: string;
      endpoint: string; gatewayEndpoints: string[] };
  };
  if (saved.version !== 1 || saved.instanceId !== LIVE_INSTANCE || path.basename(profileDirectory) !== "docker") {
    throw new Error("This step adopts only the live Docker Outpost into its docker profile.");
  }
  if (saved.gateway.gatewayInstanceId !== MINI_GATEWAY) throw new Error("The saved Mac mini enrollment does not match.");
  if (publicKeyPemFromPrivateKey(saved.identity.privateKeyPem) !== saved.identity.publicKeyPem
    || noiseKeyPairFromRawPrivate(Buffer.from(saved.noise.privateKeyBase64, "base64")).publicKeyRaw.toString("base64") !== saved.noise.publicKeyBase64) {
    throw new Error("The saved identity's public and private keys do not match.");
  }
  const endpoints = [...new Set([saved.gateway.endpoint, ...saved.gateway.gatewayEndpoints])];
  for (const endpoint of endpoints) {
    if (!["ws:", "wss:"].includes(new URL(endpoint).protocol)) throw new Error("Invalid saved gateway endpoint.");
  }
  const stateDirectory = path.join(profileDirectory, "state");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDirectory, 0o700);
  fs.chmodSync(stateDirectory, 0o700);
  const headlessDirectory = path.join(stateDirectory, "headless");
  fs.mkdirSync(headlessDirectory, { recursive: true, mode: 0o700 });
  // The owner's own lock: free only when no Outpost is running, including one
  // that crashed and left owner.lock behind. Holding it for the whole adoption
  // keeps an Outpost from starting halfway through.
  let lock: HeadlessOwnerLock;
  try { lock = acquireHeadlessOwnerLock(headlessDirectory); } catch (error) {
    throw new Error(`Stop the live owner before adopting its identity. ${(error as Error).message}`, { cause: error });
  }
  const db = StateDb.open(path.join(stateDirectory, "state.db"), { profileName: "docker" });
  try {
    const existing = db.getMeta("federation_instance_id");
    if (existing && existing !== LIVE_INSTANCE) throw new Error("The destination already has a different identity; restore the backup instead.");
    const encryption = createFileKeyEncryption(stateDirectory);
    const secrets = { federationInstancePrivateKey: saved.identity.privateKeyPem, federationNoiseStaticPrivateKey: saved.noise.privateKeyBase64 };
    for (const [key, value] of Object.entries(secrets)) {
      const ciphertext = db.getSecret(key);
      if (ciphertext && encryption.decryptString(ciphertext) !== value) throw new Error("The destination already has different private keys; restore the backup instead.");
    }
    const config = new DesktopConfigStore({ configPath: path.join(profileDirectory, "config.toml") });
    try {
      await config.write({ federation: { mode: "client", instanceLabel: saved.label,
        gatewayUrl: endpoints[0], gatewayEndpoints: endpoints } }, ["federation"]);
    } finally { config.dispose(); }
    db.raw.transaction(() => {
      for (const [key, value] of Object.entries(secrets)) if (!db.getSecret(key)) db.setSecret(key, encryption.encryptString(value));
      for (const [key, value] of Object.entries({ federation_instance_id: LIVE_INSTANCE,
        federation_gateway_instance_id: MINI_GATEWAY, federation_gateway_public_key_pem: saved.gateway.gatewayPublicKeyPem,
        federation_gateway_noise_public_key: saved.gateway.gatewayNoisePublicKey, profile_name: "docker" })) db.setMeta(key, value);
      if (!db.getMeta("federation_gateway_enrolled_at")) db.setMeta("federation_gateway_enrolled_at", String(Date.now()));
    })();
  } finally {
    try { db.close(); }
    finally { lock.release(); }
  }
}
