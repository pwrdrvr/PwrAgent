import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { MessagingPairingStore } from "@pwragent/sqlite-storage/messaging-pairing-store";
import { MessagingActivityLog } from "@pwragent/sqlite-storage/messaging-activity-log";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("desktop reads portable pairing and activity and hands local service mutations back to Node", async () => {
  const now = Date.now();
  let pendingId = "";
  let observedId = "";
  let expiredId = "";
  let profileSecret = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const pairs = new MessagingPairingStore(db);
        pendingId = pairs.create({ token: "invented-portable-pending-token", platform: "telegram", instanceId: "portable-fixture",
          scope: "user_dm", generatedAt: now, expiresAt: now + 3_600_000 }).id;
        observedId = pairs.create({ token: "invented-portable-observed-token", platform: "slack", instanceId: "portable-fixture",
          scope: "observed", generatedAt: now + 1, expiresAt: now + 3_600_000 }).id;
        pairs.markObserved({ entryId: observedId, observedAt: now + 2,
          actor: { id: "UINVENTED", displayName: "Invented actor" },
          chat: { id: "CINVENTED", kind: "channel", title: "Invented conversation", bucketId: "TINVENTED" } });
        pairs.recordApproval({ entryId: observedId, target: "actor" });
        expiredId = pairs.create({ token: "invented-portable-expired-token", platform: "discord", instanceId: "portable-fixture",
          scope: "bucket", generatedAt: now - 2_000, expiresAt: now - 1_000 }).id;
        profileSecret = db.getMeta("messaging_pairing_secret_v1")!;
        const activity = new MessagingActivityLog(db);
        activity.record({ platform: "telegram", kind: "inbound-routed", backend: "codex", threadId: "thread-smoke",
          summary: "Invented portable request", createdAt: now - 1_000, payload: { fixture: "portable" } });
        activity.record({ platform: "telegram", kind: "outbound", summary: "Invented portable outbound audit", createdAt: now - 900 });
        activity.recordPlatformResponseActivity({ platform: "telegram", createdAt: now - 800 });
        activity.record({ platform: "desktop", kind: "policy", summary: "Invented local policy", createdAt: now - 700 });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.window.evaluate(async ({ pendingId, observedId }) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = await api.listMessagingPairingRequests!({ includeResolved: true });
      const activity = await api.listMessagingActivity!({ limit: 500 });
      const summary = await api.getMessagingActivitySummary!();
      const generated = await api.generateMessagingPairingToken!({ platform: "telegram", instanceId: "electron-fixture", scope: "user_dm" });
      // Dismissing a partially approved request mutates storage without
      // contacting an adapter. This profile has no messaging credentials.
      const dismissed = await api.rejectMessagingPairing!({ entryId: observedId });
      const rejected = await api.rejectMessagingPairing!({ entryId: pendingId });
      const after = await api.listMessagingPairingRequests!({ includeResolved: true });
      const audit = await api.listMessagingActivity!({ limit: 500 });
      return { before, activity, summary, generated, dismissed, rejected, after, audit };
    }, { pendingId, observedId });
    expect(result.before.entries).toContainEqual(expect.objectContaining({ id: pendingId, status: "pending" }));
    expect(result.before.entries).toContainEqual(expect.objectContaining({ id: observedId, status: "observed", approvedTargets: ["actor"],
      observedActor: { id: "UINVENTED", displayName: "Invented actor" } }));
    expect(result.before.entries).toContainEqual(expect.objectContaining({ id: expiredId, status: "expired" }));
    expect(result.activity.entries).toContainEqual(expect.objectContaining({ summary: "Invented portable request", backend: "codex",
      payload: { fixture: "portable" } }));
    expect(result.activity.entries).toContainEqual(expect.objectContaining({ platform: "desktop", kind: "policy", summary: "Invented local policy" }));
    expect(result.summary.summaries).toContainEqual({ platform: "telegram", lastRequestAt: now - 1_000, lastResponseAt: now - 800 });
    expect(result.dismissed.entry).toMatchObject({ id: observedId, status: "consumed", approvedTargets: ["actor"] });
    expect(result.rejected.entry).toMatchObject({ id: pendingId, status: "rejected" });
    expect(result.generated.entry).toMatchObject({ platform: "telegram", instanceId: "electron-fixture", scope: "user_dm", status: "pending" });
    expect(result.generated.token.length).toBeGreaterThan(20);
    for (const summary of ["Generated pairing token", "Dismissed pairing request after partial approval", "Rejected pairing request"]) {
      expect(result.audit.entries).toContainEqual(expect.objectContaining({ kind: "pairing", summary }));
    }
    // Observe the real Electron writes before a Node store can repair anything.
    const raw = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      expect(raw.prepare("SELECT value FROM meta WHERE key = ?").pluck().get("messaging_pairing_secret_v1")).toBe(profileSecret);
      expect(raw.prepare("SELECT status FROM messaging_pairing_tokens WHERE entry_id = ?").pluck().get(observedId)).toBe("consumed");
      expect(raw.prepare("SELECT status FROM messaging_pairing_tokens WHERE entry_id = ?").pluck().get(pendingId)).toBe("rejected");
      const rows = JSON.stringify(raw.prepare("SELECT * FROM messaging_pairing_tokens").all());
      expect(rows).not.toContain(result.generated.token);
      expect(rows).not.toContain("invented-portable-pending-token");
      expect(rows).not.toContain("invented-portable-observed-token");
    } finally { raw.close(); }
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const pairs = new MessagingPairingStore(db);
      expect(pairs.get(pendingId)).toEqual(result.rejected.entry);
      expect(pairs.get(observedId)).toEqual(result.dismissed.entry);
      expect(pairs.findMatchingPending({ token: result.generated.token, platform: "telegram", instanceId: "electron-fixture", now: Date.now() }))
        .toEqual(result.generated.entry);
      expect(pairs.findMatchingPending({ token: result.generated.token, platform: "telegram", instanceId: "portable-fixture", now: Date.now() }))
        .toBeUndefined();
      const activity = new MessagingActivityLog(db);
      expect(activity.list({ limit: 500 })).toEqual(result.audit.entries);
      expect(activity.getPlatformActivitySummary()).toEqual(result.summary);
      expect(db.getMeta("messaging_pairing_secret_v1")).toBe(profileSecret);
    } finally { db.close(); }
  } finally { await app.close(); }
});
