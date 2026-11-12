import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { generateFederationIdentityKeyPair } from "@pwragent/federation/federation-identity";
import { generateFederationNoiseStaticKeyPair } from "@pwragent/federation/federation-noise";
import { adoptLiveDockerOutpost } from "../../../scripts/adopt-live-docker-identity";
import { StateDb } from "../state/state-db";
import { createFileKeyEncryption } from "../headless/file-key-encryption";
import { acquireHeadlessOwnerLock, HEADLESS_OWNER_LOCK_MARKER } from "../headless/owner-lock";

const liveId = "4f9b407d-2bb9-4893-9b98-28b88952a3de";
const gatewayId = "pwr_3d822fab-1b7c-4f8e-9d5a-c765d818ad97";
function fixture(root: string, instanceId: string) {
  const identity = generateFederationIdentityKeyPair(), noise = generateFederationNoiseStaticKeyPair();
  const saved = { version: 1, instanceId, label: "Docker smoke outpost", identity, noise,
    gateway: { gatewayInstanceId: gatewayId, gatewayPublicKeyPem: "fixture gateway", gatewayNoisePublicKey: "fixture noise",
      endpoint: "ws://127.0.0.1:47833/", gatewayEndpoints: ["ws://mini.huntharo.com:47830"] } };
  const source = path.join(root, "federation.json");
  fs.writeFileSync(source, JSON.stringify(saved), { mode: 0o600 });
  return { source, saved };
}
it("adopts only the pinned live identity, retaining its private keys and enrollment without importing jobs or invites", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), async otherId => {
    fc.pre(otherId !== liveId);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-adoption-"));
    const profile = path.join(root, "docker");
    try {
      const wrong = fixture(root, otherId);
      await expect(adoptLiveDockerOutpost(wrong.source, profile)).rejects.toThrow("only the live Docker Outpost");
      expect(fs.existsSync(profile)).toBe(false);
      const { source, saved } = fixture(root, liveId);
      await adoptLiveDockerOutpost(source, profile);
      const state = path.join(profile, "state"), db = StateDb.open(path.join(state, "state.db"));
      const encryption = createFileKeyEncryption(state);
      let before: Buffer;
      try {
        expect(db.getMeta("federation_instance_id")).toBe(liveId);
        expect(db.getMeta("federation_gateway_instance_id")).toBe(gatewayId);
        before = db.getSecret("federationInstancePrivateKey")!;
        expect(encryption.decryptString(before)).toBe(saved.identity.privateKeyPem);
        expect(encryption.decryptString(db.getSecret("federationNoiseStaticPrivateKey")!)).toBe(saved.noise.privateKeyBase64);
        expect(db.getMeta("federation_pending_invite_token")).toBeUndefined();
      } finally { db.close(); }
      await adoptLiveDockerOutpost(source, profile);
      const reopened = StateDb.open(path.join(state, "state.db"));
      try {
        expect(reopened.getSecret("federationInstancePrivateKey")).toEqual(before);
        reopened.setMeta("federation_instance_id", otherId);
      } finally { reopened.close(); }
      await expect(adoptLiveDockerOutpost(source, profile)).rejects.toThrow("different identity");
      expect(fs.readFileSync(source, "utf8")).toContain(saved.identity.privateKeyPem.replaceAll("\n", "\\n"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 8 });
});

it("adopts after a crashed owner and refuses while an owner holds the headless lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-adoption-lock-"));
  const profile = path.join(root, "docker");
  const headless = path.join(profile, "state", "headless");
  const marker = path.join(headless, HEADLESS_OWNER_LOCK_MARKER);
  try {
    const { source } = fixture(root, liveId);
    fs.mkdirSync(headless, { recursive: true });
    const live = acquireHeadlessOwnerLock(headless);
    try {
      await expect(adoptLiveDockerOutpost(source, profile)).rejects.toThrow(/Stop the live owner.*Another headless owner is running/);
    } finally { live.release(); }

    // A crash leaves this version's owner.lock but frees the kernel lock.
    fs.writeFileSync(marker, `${JSON.stringify({ pid: 1, lock: "sqlite-exclusive" })}\n`, { mode: 0o600 });
    await adoptLiveDockerOutpost(source, profile);
    expect(fs.existsSync(marker)).toBe(false);

    // An older version's owner.lock may belong to a live owner of that version.
    fs.writeFileSync(marker, `${JSON.stringify({ pid: 1 })}\n`, { mode: 0o600 });
    await expect(adoptLiveDockerOutpost(source, profile)).rejects.toThrow(/Stop the live owner.*older PwrAgent/);
    expect(fs.existsSync(marker)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
