import path from "node:path";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { FederationStore } from "@pwragent/sqlite-storage/federation-store";
import { decodeFederationInvite } from "@pwragent/federation/federation-enrollment";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("desktop consumes portable federation trust and audit facts and hands revocation and invite mutations back to Node", async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Expected an isolated loopback port");
  await new Promise<void>((resolve, reject) => { probe.close(error => error ? reject(error) : resolve()); });
  const port = address.port;
  const at = Date.now();
  let portableEnrollmentId = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    secretStorage: "memory",
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new FederationStore(db);
        store.upsertPeer({ peer: { id: "invented_portable", label: "Invented portable peer", role: "client",
          status: "disconnected", capabilities: ["remote_window"], pinnedPublicKeyPem: "Invented retained public key",
          receiverPermissions: { remoteShells: false, filePush: false }, profileName: "invented-profile" }, updatedAt: at });
        portableEnrollmentId = store.createEnrollment({ token: "invented-unused-token", generatedAt: at,
          expiresAt: at + 3_600_000, label: "Invented portable invitation", role: "client" }).id;
        store.appendAudit({ peerId: "invented_portable", sessionId: "invented-session", kind: "error", createdAt: at,
          detail: "Invented portable diagnostic" });
        store.appendAudit({ peerId: "invented_portable", sessionId: "invented-session", kind: "error", createdAt: at + 1,
          detail: "Invented portable diagnostic" });
      } finally { db.close(); }
      // Only the isolated profile's loopback listener runs; no remote target
      // or messaging adapter is configured by this fixture.
      await writeFile(configTomlPathForHomeRoot(homeRoot), `[federation]\nmode = "gateway"\nlisten_host = "127.0.0.1"\nlisten_port = ${port}\npublic_url = "ws://127.0.0.1:${port}"\n`);
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const before = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.readFederationDiagnostics!({ peerId: "invented_portable" });
    });
    expect(before.health.enabled).toBe(true);
    expect(before.health.peers).toContainEqual(expect.objectContaining({ id: "invented_portable", label: "Invented portable peer",
      status: "disconnected", receiverPermissions: { remoteShells: false, filePush: false } }));
    expect(before.health.peers[0]).not.toHaveProperty("pinnedPublicKeyPem");
    expect(before.events).toContainEqual(expect.objectContaining({ peerId: "invented_portable", kind: "error",
      detail: "Invented portable diagnostic", repeatCount: 2, firstSeenAt: at, createdAt: at + 1 }));

    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new FederationStore(db);
      store.appendAudit({ peerId: "invented_portable", sessionId: "invented-session", kind: "error", createdAt: at + 2,
        detail: "Invented portable diagnostic" });
      store.upsertPeer({ peer: { ...store.getPeer("invented_portable")!, label: "Invented later WAL label" }, updatedAt: at + 2 });
    } finally { db.close(); }
    const result = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const later = await api.readFederationDiagnostics!({ peerId: "invented_portable", limit: 1 });
      const revoked = await api.revokeFederationPeer!({ peerId: "invented_portable" });
      const generated = await api.generateFederationInvite!({ label: "Invented desktop invitation", ttlMs: 60_000 });
      return { later, revoked, generated };
    });
    expect(result.later.events).toHaveLength(1);
    expect(result.later.events[0]).toMatchObject({ repeatCount: 3, firstSeenAt: at, createdAt: at + 2 });
    expect(result.later.health.peers).toContainEqual(expect.objectContaining({ id: "invented_portable", label: "Invented later WAL label" }));
    expect(result.revoked.peer).toMatchObject({ id: "invented_portable", status: "revoked", label: "Invented later WAL label" });
    expect(result.revoked.peer).not.toHaveProperty("pinnedPublicKeyPem");
    const generated = decodeFederationInvite(result.generated.invite);
    expect(generated.expiresAt).toBe(result.generated.expiresAt);
    await app.closeApplication();

    const reopened = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new FederationStore(reopened);
      expect(store.getPeer("invented_portable")).toMatchObject({ status: "revoked", revokedAt: result.revoked.peer.revokedAt,
        pinnedPublicKeyPem: "Invented retained public key", profileName: "invented-profile" });
      expect(store.getEnrollment(portableEnrollmentId)).toMatchObject({ status: "pending", label: "Invented portable invitation" });
      const enrollment = store.findMatchingPendingEnrollment({ token: generated.token, now: generated.expiresAt - 1 });
      expect(enrollment).toMatchObject({ label: "Invented desktop invitation", status: "pending", expiresAt: result.generated.expiresAt });
      const rows = reopened.raw.prepare("SELECT token_hmac, payload FROM federation_enrollment_tokens").all();
      expect(JSON.stringify(rows)).not.toContain(generated.token);
      expect(JSON.stringify(rows)).not.toContain("invented-unused-token");
      expect(store.listAudit({ peerId: "invented_portable", limit: 1 })[0]).toMatchObject({ repeatCount: 3, firstSeenAt: at });
      // A later portable refresh cannot silently restore desktop-revoked trust.
      store.upsertPeer({ peer: { id: "invented_portable", label: "Invented refresh", role: "client", status: "connected", capabilities: [] }, updatedAt: at + 3 });
      expect(store.getPeer("invented_portable")).toMatchObject({ status: "revoked", revokedAt: result.revoked.peer.revokedAt });
    } finally { reopened.close(); }
  } finally { await app.close(); }
});
