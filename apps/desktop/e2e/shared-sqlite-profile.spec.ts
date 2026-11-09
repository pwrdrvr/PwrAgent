import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { ThreadTodoStore } from "@pwragent/sqlite-storage/thread-todo-store";
import { SqliteThreadReviewStorage } from "@pwragent/sqlite-storage/thread-review-storage-sqlite";
import { listModelSettingsRecents, recordModelSettingsRecent } from "@pwragent/sqlite-storage/model-settings-recents-store";
import { RUNTIME_LEASE_DEAD_OWNER_GRACE_MS } from "@pwragent/owner-core/runtime-lease-storage";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("desktop reads portable owner metadata and hands its mutations back to the portable store", async () => {
  const identity = { backend: "codex" as const, threadId: "thread-smoke" };
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new SqliteOverlayStore(db);
        await store.updateThreadMetadata(identity, {
          title: { text: "Portable owner metadata", source: "explicit" }, pinnedRank: "1024",
          parent: { backend: "claude", threadId: "portable-parent", instanceId: "portable-instance" },
          subthreadOrder: ["portable-child"], subthreadsCollapsed: true,
        });
        await store.setThreadTokenMiser({ ...identity, enabled: true });
      } finally { db.close(); }
    },
  });
  try {
    const reader = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      expect((await new SqliteOverlayStore(reader).getThreadMetadata(identity))?.title)
        .toEqual({ text: "Portable owner metadata", source: "explicit" });
    } finally { reader.close(); }
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.window.evaluate(async identity => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = (await api.getNavigationSelectedDetail!({ protocol: 2, ref: identity })).thread;
      await api.setThreadPin!({ ...identity, pinnedRank: "8192" });
      await api.setThreadParent!({ ...identity, parentThreadId: null });
      await api.setThreadTokenMiser!({ ...identity, enabled: false });
      const seenAt = Date.now() + 60_000;
      await api.markThreadSeen!({ ...identity, seenAt, seenUpdatedAt: before!.updatedAt });
      const after = (await api.getNavigationSelectedDetail!({ protocol: 2, ref: identity })).thread;
      return { before, after, seenAt };
    }, identity);
    // Codex owns its displayed title through the protocol. The portable
    // title remains metadata; desktop mutates its own pin and relationship.
    expect(result.before).toMatchObject({ pinnedRank: "1024", parentThreadId: "portable-parent", tokenMiserEnabled: true });
    expect(result.after).toMatchObject({ pinnedRank: "8192", tokenMiserEnabled: false });
    expect(result.after?.parentThreadId).toBeUndefined();
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new SqliteOverlayStore(db);
      const metadata = await store.getThreadMetadata(identity);
      expect(metadata).toMatchObject({ ...identity, title: { text: "Portable owner metadata", source: "explicit" },
        pinnedRank: "8192", seenAt: result.seenAt, subthreadOrder: ["portable-child"], subthreadsCollapsed: true });
      expect(metadata?.seenUpdatedAt).toBeGreaterThanOrEqual(result.before!.updatedAt!);
      expect(metadata?.parent).toBeUndefined();
      expect((await store.getThreadOverlayState(identity))?.tokenMiserEnabled).toBe(false);
    } finally { db.close(); }
  } finally { await app.close(); }
});

test("desktop upgrades a profile opened by portable SQLite and retains its owner metadata", async () => {
  const identity = { backend: "codex" as const, threadId: "portable-fixture-thread" };
  const metadata = {
    title: { text: "Portable profile title", source: "explicit" as const },
    pinnedRank: "a0", seenAt: 123, seenUpdatedAt: 100,
    parent: { backend: "claude" as const, threadId: "portable-fixture-parent", instanceId: "fixture-instance" },
  };
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
      try {
        await new SqliteOverlayStore(db).updateThreadMetadata(identity, metadata);
        db.setMeta("portable-fixture", "created outside Electron");
        // A supported old profile shape. Electron must run the same ladder
        // before its stores open; no test-only migration hook is involved.
        db.raw.exec("DROP TABLE durable_turn_requests");
        db.raw.pragma("user_version = 73");
      } finally { db.close(); }
    },
  });
  try {
    // Inspect through a raw WAL reader first: reopening with StateDb would
    // repair the profile itself and could conceal a missing Electron upgrade.
    const reader = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      expect(reader.pragma("user_version", { simple: true })).toBe(80);
      expect(reader.prepare("SELECT name FROM pragma_table_info('durable_turn_requests')").all())
        .toContainEqual({ name: "receipt_json" });
    } finally { reader.close(); }
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      expect(db.getMeta("portable-fixture")).toBe("created outside Electron");
      expect(await new SqliteOverlayStore(db).getThreadMetadata(identity))
        .toMatchObject({ ...identity, ...metadata });
    } finally { db.close(); }
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    await app.window.getByRole("textbox", { name: "Reply", exact: true }).fill("The upgraded profile remains usable.");
    await expect(app.window.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally { await app.close(); }
});


test("desktop takes over a retired portable profile lease and releases it for the next portable owner", async () => {
  const retiredAt = Date.now() - RUNTIME_LEASE_DEAD_OWNER_GRACE_MS - 1;
  const app = await launchElectronApp({
    secretStorage: "memory",
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
      try {
        const store = new AppRuntimeInstanceStore(db);
        store.recordInstanceStart({ instanceId: "portable-owner", processId: process.pid,
          profileName: "default", startedAt: retiredAt - 1, desiredMessagingEnabled: false });
        expect(store.acquireFederationLease({ instanceId: "portable-owner", now: retiredAt - 1 }).acquired).toBe(true);
        store.markInstanceExited({ instanceId: "portable-owner", now: retiredAt });
      } finally { db.close(); }
      // Client mode acquires the profile owner lease without opening a listener.
      await writeFile(configTomlPathForHomeRoot(homeRoot), '[federation]\nmode = "client"\n');
    },
  });
  const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
  const store = new AppRuntimeInstanceStore(db);
  try {
    const health = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      await api.setFederationEnabled!(true);
      return await api.readFederationHealth!();
    });
    expect(health.health.enabled, JSON.stringify(health)).toBe(true);
    expect(store.getFederationLease()?.ownerInstanceId, JSON.stringify({
      enabled: health.health.enabled, role: health.health.role, status: health.health.status,
      reason: health.health.unavailableReason, holder: health.health.leaseHolder,
    })).not.toBe("portable-owner");
    const lease = store.getFederationLease()!;
    expect(lease.status).toBe("active");
    expect(store.getInstance(lease.ownerInstanceId)?.processId).toBe(app.electronApp.process().pid);
    expect(store.getInstance("portable-owner")?.exitedAt).toBe(retiredAt);
    store.recordInstanceStart({ instanceId: "portable-challenger", processId: process.pid,
      profileName: "default", startedAt: Date.now(), desiredMessagingEnabled: false });
    expect(store.acquireFederationLease({ instanceId: "portable-challenger", now: Date.now(),
      isOwnerAlive: () => true })).toMatchObject({ acquired: false, holder: { ownerInstanceId: lease.ownerInstanceId } });
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    // Keep the WAL reader open while the supported harness quits Electron.
    await app.closeApplication();
    expect(store.getFederationLease()).toMatchObject({ ownerInstanceId: lease.ownerInstanceId, status: "released" });
    expect(store.acquireFederationLease({ instanceId: "portable-challenger", now: Date.now() }).acquired).toBe(true);
  } finally { db.close(); await app.close(); }
});

test("desktop consumes portable cards, findings and recents and preserves its mutations for the next host", async () => {
  const identity = { backend: "codex" as const, threadId: "thread-smoke" };
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        new ThreadTodoStore(db).insert({ ...identity, id: "portable-card", kind: "reminder",
          title: "Check the portable profile", items: [{ id: "step", text: "Verify the handover", checked: false }], now: 100 });
        const reviews = new SqliteThreadReviewStorage(db);
        reviews.trackingStartedAt(() => 99);
        reviews.insert({ ...identity, id: "portable-review", sourceKey: "portable-artifact", origin: "explicit",
          title: "Portable review", status: "open", createdAt: 100, updatedAt: 100,
          items: [{ id: "finding", title: "Retain the recorded outcome", status: "open", createdAt: 100, updatedAt: 100 }] });
        recordModelSettingsRecent(db, "todo-dispatch", { backend: "codex", model: "portable-model", reasoningEffort: "high" });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    const stack = app.window.getByRole("region", { name: "To-dos for this thread" });
    await expect(stack).toContainText("Portable review");
    await stack.getByRole("button", { name: "Next to-do", exact: true }).click();
    await expect(stack).toContainText("Check the portable profile");
    const results = await app.window.evaluate(async identity => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const cards = await api.listThreadTodos!({ ...identity, status: "all" });
      const reviews = await api.listThreadReviews!({ ...identity, status: "all" });
      const recents = await api.listModelSettingsRecents!({ scope: "todo-dispatch" });
      await api.setThreadTodoItemChecked!({ id: "portable-card", itemId: "step", checked: true });
      await api.resolveThreadTodo!({ id: "portable-card", status: "done" });
      await api.updateThreadReview!({ id: "portable-review", itemId: "finding", status: "addressed", note: "Verified in Electron." });
      return { cards, reviews, recents };
    }, identity);
    expect(results.cards.todos).toContainEqual(expect.objectContaining({ id: "portable-card", status: "open" }));
    expect(results.reviews.reviews).toContainEqual(expect.objectContaining({ id: "portable-review", status: "open" }));
    expect(results.recents.recents).toEqual([{ backend: "codex", model: "portable-model", reasoningEffort: "high" }]);
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      expect(new ThreadTodoStore(db).get("portable-card")).toMatchObject({ status: "done", items: [{ id: "step", checked: true }] });
      expect(new SqliteThreadReviewStorage(db).get("portable-review"))
        .toMatchObject({ status: "handled", items: [{ id: "finding", status: "addressed", resolution: { note: "Verified in Electron." } }] });
      expect(new SqliteThreadReviewStorage(db).trackingStartedAt(() => 999)).toBe(99);
      expect(listModelSettingsRecents(db, "todo-dispatch")).toEqual(results.recents.recents);
    } finally { db.close(); }
  } finally { await app.close(); }
});
