import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteMessagingStore } from "@pwragent/sqlite-storage/messaging-store-sqlite";
import { messagingSqlitePolicy } from "../src/main/storage/messaging-sqlite-policy";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("the real desktop messaging accessor reads portable routes, observes WAL updates and retires binding state for the next Node owner", async () => {
  const now = Date.now();
  const channel = { channel: "slack" as const, conversation: { kind: "channel" as const, id: "invented-shared-channel", workspaceId: "invented-workspace", title: "Portable route" } };
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new SqliteMessagingStore(db, messagingSqlitePolicy);
        await store.upsertBinding({ id: "portable-binding", channel, backend: "codex", threadId: "thread-smoke", authorizedActorIds: ["invented-human", "invented-human"],
          createdAt: now, updatedAt: now, routingState: { opaque: { route: "invented-route", token: "invented-private-credential" } },
          preferences: { toolUpdateMode: "show_none", updatedAt: now } });
        await store.upsertDefaultAgentAssignment({ id: "portable-default", scope: { kind: "profile" }, target: { kind: "agent", backend: "codex", threadId: "thread-smoke" }, createdAt: now, updatedAt: now });
        await store.upsertPendingIntent({ id: "portable-intent", bindingId: "portable-binding", channel, allowedActorIds: ["invented-human"], createdAt: now, expiresAt: now + 3_600_000,
          intent: { id: "invented-surface", kind: "single_select", createdAt: now, prompt: "Invented choice", choices: [] } });
        await store.upsertBrowseSession({ id: "portable-browser", bindingId: "portable-binding", channel, allowedActorIds: ["invented-human"], createdAt: now, updatedAt: now,
          expiresAt: now + 3_600_000, launchAction: "resume_thread", mode: "recents", pageIndex: 0, pageSize: 3 });
        await store.upsertCallbackHandle({ id: "portable-callback", handle: "invented-handle", actionId: "invented-action", bindingId: "portable-binding", browseSessionId: "portable-browser",
          channel, allowedActorIds: ["invented-human"], createdAt: now, updatedAt: now, expiresAt: now + 3_600_000, value: { secret: "invented-private-credential", safe: "invented" } });
        await store.recordDelivery({ id: "portable-delivery", bindingId: "portable-binding", channel: "slack", outcome: "presented", deliveredAt: now,
          surface: { channel: "slack", id: "invented-surface", state: { opaque: { password: "invented-private-credential", safe: "invented" } } } });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const before = await app.window.evaluate(async () => (window as unknown as { pwragent: DesktopApi }).pwragent.listMessagingRoutes!());
    expect(before.bindings).toContainEqual(expect.objectContaining({ bindingId: "portable-binding", conversation: expect.objectContaining({ title: "Portable route" }), target: expect.objectContaining({ threadId: "thread-smoke", backend: "codex" }) }));
    expect(before.defaultAgents).toContainEqual(expect.objectContaining({ assignmentId: "portable-default", scope: { kind: "profile" } }));
    expect(before.observedSurfaces).toContainEqual(expect.objectContaining({ conversation: expect.objectContaining({ id: channel.conversation.id }), firstSeenAt: now, lastSeenAt: now }));
    const portable = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      await new SqliteMessagingStore(portable, messagingSqlitePolicy).mergeBindingChannelMetadata({ bindingId: "portable-binding", channel, observedAt: now + 100, title: "Later portable route" });
    } finally { portable.close(); }
    const result = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const updated = await api.listMessagingRoutes!();
      const cleared = await api.clearMessagingDefaultAgent!({ assignmentId: "portable-default" });
      const unbound = await api.unbindMessagingThread!({ bindingId: "portable-binding" });
      const after = await api.listMessagingRoutes!();
      return { updated, cleared, unbound, after };
    });
    expect(result.updated.bindings).toContainEqual(expect.objectContaining({ bindingId: "portable-binding", conversation: expect.objectContaining({ title: "Later portable route" }) }));
    expect(result.cleared).toEqual({ assignmentId: "portable-default", cleared: true });
    expect(result.unbound).toEqual({ bindingId: "portable-binding", revoked: true });
    expect(result.after.bindings).not.toContainEqual(expect.objectContaining({ bindingId: "portable-binding" }));
    expect(result.after.defaultAgents).not.toContainEqual(expect.objectContaining({ assignmentId: "portable-default" }));
    const raw = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      expect(raw.prepare("SELECT status FROM bindings WHERE binding_id = ?").pluck().get("portable-binding")).toBe("revoked");
      expect(raw.prepare("SELECT status FROM messaging_default_agent_assignments WHERE assignment_id = ?").pluck().get("portable-default")).toBe("revoked");
      expect(raw.prepare("SELECT COUNT(*) FROM pending_intents WHERE intent_id = ?").pluck().get("portable-intent")).toBe(0);
      expect(raw.prepare("SELECT COUNT(*) FROM browse_sessions WHERE session_id = ?").pluck().get("portable-browser")).toBe(0);
      expect(raw.prepare("SELECT COUNT(*) FROM callback_handles WHERE handle_id = ?").pluck().get("portable-callback")).toBe(0);
      const rows = JSON.stringify([raw.prepare("SELECT payload FROM bindings").all(), raw.prepare("SELECT payload FROM deliveries").all()]);
      expect(rows).not.toContain("invented-private-credential");
      expect(rows).toContain("[REDACTED]");
    } finally { raw.close(); }
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new SqliteMessagingStore(db, messagingSqlitePolicy);
      expect(await store.findActiveBindings()).toEqual([]);
      expect(await store.findActiveDefaultAgentAssignments()).toEqual([]);
      expect(await store.getBinding("portable-binding")).toMatchObject({ revokedAt: expect.any(Number), authorizedActorIds: ["invented-human"], channel: { conversation: { title: "Later portable route" } } });
      expect(await store.getDefaultAgentAssignment("portable-default")).toMatchObject({ revokedAt: expect.any(Number), target: { threadId: "thread-smoke" } });
      expect(await store.getPendingIntent("portable-intent")).toBeUndefined();
      expect(await store.getBrowseSession("portable-browser")).toBeUndefined();
      expect(await store.getCallbackHandle("portable-callback")).toBeUndefined();
      expect(await store.getDelivery("portable-delivery")).toMatchObject({ surface: { channel: "slack", id: "invented-surface", state: { opaque: { password: "[REDACTED]", safe: "invented" } } } });
    } finally { db.close(); }
  } finally { await app.close(); }
});
