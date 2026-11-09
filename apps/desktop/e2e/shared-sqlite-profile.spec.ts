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
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { ThreadSearchStore } from "@pwragent/sqlite-storage/thread-search-store";
import { AutomationStore } from "@pwragent/sqlite-storage/automation-store";
import { ScheduledThreadActionStore } from "@pwragent/sqlite-storage/scheduled-thread-action-store";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("desktop recovers portable scheduled claims and hands payload edits and cancellations back to portable storage", async () => {
  const scheduledFor = Date.now() + 2 * 86_400_000;
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new ScheduledThreadActionStore(db);
        const now = Date.now();
        for (const id of ["portable-edit", "portable-cancel", "portable-dispatch", "portable-held"]) store.create({
          id, backend: "codex", threadId: "thread-smoke", kind: "turn", origin: "desktop", scheduledFor,
          displayText: `Invented portable wake ${id}`, turn: { input: [{ type: "text", text: `Invented input ${id}` }] },
          manualReleaseRequired: id === "portable-held", now,
        });
        for (const id of ["portable-dispatch", "portable-held"]) store.claim(id, {
          ownerId: "scheduler:99999999:retired-portable-fixture", now, leaseExpiresAt: now - 1,
        });
        store.markQueued("portable-held", "portable-queue", now, "scheduler:99999999:retired-portable-fixture");
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.window.evaluate(async scheduledFor => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = await api.listScheduledThreadActions!({ backend: "codex", threadId: "thread-smoke", includeTerminal: true, projectionProtocol: 2 });
      const updated = await api.updateScheduledThreadAction!({ id: "portable-edit", scheduledFor: scheduledFor + 1_000,
        displayText: "Invented desktop edited wake", turn: { input: [{ type: "text", text: "Invented desktop edited input" }] } });
      const cancelled = await api.cancelScheduledThreadAction!({ id: "portable-cancel" });
      const created = await api.createScheduledThreadAction!({ backend: "codex", threadId: "thread-smoke", kind: "turn", origin: "desktop",
        scheduledFor, displayText: "Invented desktop created wake", turn: { input: [{ type: "text", text: "Invented desktop created input" }] } });
      return { before, updated, cancelled, created };
    }, scheduledFor);
    expect(result.before.projectionProtocol).toBe(2);
    expect(result.before.actions).toHaveLength(4);
    expect(result.before.actions).toContainEqual(expect.objectContaining({ id: "portable-edit", status: "scheduled",
      turn: { input: [{ type: "text", text: "Invented input portable-edit" }] } }));
    expect(result.before.actions).toContainEqual(expect.objectContaining({ id: "portable-dispatch", status: "failed",
      errorMessage: "The scheduler lease expired while this action was being dispatched. Check the thread before scheduling it again." }));
    expect(result.before.actions).toContainEqual(expect.objectContaining({ id: "portable-held", status: "held", manualReleaseRequired: true }));
    expect(result.cancelled.action.status).toBe("cancelled");
    expect(result.updated.action).toMatchObject({ displayText: "Invented desktop edited wake", scheduledFor: scheduledFor + 1_000 });
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new ScheduledThreadActionStore(db);
      expect(store.get("portable-edit")).toEqual(result.updated.action);
      expect(store.get("portable-cancel")).toEqual(result.cancelled.action);
      expect(store.get(result.created.action.id)).toEqual(result.created.action);
      expect(store.get("portable-dispatch")?.status).toBe("failed");
      expect(store.get("portable-held")).toMatchObject({ status: "held", manualReleaseRequired: true, queueEntryId: undefined });
      expect(JSON.stringify(db.raw.prepare("SELECT * FROM scheduled_thread_actions").all())).not.toContain("Invented");
    } finally { db.close(); }
  } finally { await app.close(); }
});

test("desktop reads portable automations and hands lifecycle and editor mutations back to portable storage", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new AutomationStore(db);
        for (const id of ["portable-automation", "portable-delete"]) store.createAutomation({
          id, backend: "codex", threadId: "thread-smoke", name: "Portable automation",
          taskPrompt: "Invented portable automation task", status: "paused",
          schedule: { kind: "interval", every: 1, unit: "hours" }, now: 1,
        });
        store.createRun({ id: "portable-interrupted-run", automationId: "portable-automation", trigger: "manual", now: 2 });
        store.markRunStarted({ runId: "portable-interrupted-run", backendTurnId: "portable-old-turn", now: 3 });
        store.createRun({ id: "portable-completed-run", automationId: "portable-automation", trigger: "manual", now: 4 });
        store.markRunTerminal({ runId: "portable-completed-run", status: "completed", now: 5 });
        store.appendRunTranscriptEvents({ runId: "portable-completed-run", now: 5, events: [
          { id: "portable-final", kind: "assistant_final", text: "Invented portable result", at: 5 },
          { id: "portable-final-copy", kind: "assistant_final", text: " Invented portable result ", at: 6 },
        ] });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = await api.listAutomations!({ backend: "codex", threadId: "thread-smoke" });
      const runs = await api.listAutomationRuns!({ automationId: "portable-automation" });
      const artifact = await api.getAutomationRunArtifact!({ runId: "portable-completed-run" });
      const updated = await api.updateAutomation!({ automationId: "portable-automation",
        name: "Desktop edited automation", taskPrompt: "Invented desktop edited task", enabled: false });
      await api.deleteAutomation!({ automationId: "portable-delete" });
      return { before, runs, artifact, updated };
    });
    expect(result.before.automations).toHaveLength(2);
    expect(result.before.automations).toContainEqual(expect.objectContaining({ id: "portable-automation", name: "Portable automation", status: "paused" }));
    expect(result.runs.runs).toContainEqual(expect.objectContaining({ id: "portable-interrupted-run", status: "cancelled",
      backendTurnId: "portable-old-turn", errorMessage: "PwrAgent restarted before this local automation run completed." }));
    expect(result.runs.runs).toContainEqual(expect.objectContaining({ id: "portable-completed-run", status: "completed", completedAt: 5 }));
    expect(result.artifact.artifact?.transcriptEvents).toEqual([
      { id: "portable-final", kind: "assistant_final", text: "Invented portable result", at: 5 },
    ]);
    expect(result.updated.automation).toMatchObject({ name: "Desktop edited automation", status: "paused" });
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new AutomationStore(db);
      expect(store.getAutomation("portable-automation")).toMatchObject({ name: "Desktop edited automation",
        taskPrompt: "Invented desktop edited task", status: "paused" });
      expect(store.getAutomation("portable-delete")).toBeUndefined();
      expect(store.getAutomation("portable-delete", { includeDeleted: true })?.status).toBe("deleted");
      expect(store.getRun("portable-interrupted-run")?.status).toBe("cancelled");
      expect(store.getRunArtifact("portable-completed-run")?.transcriptEvents).toEqual(result.artifact.artifact?.transcriptEvents);
    } finally { db.close(); }
  } finally { await app.close(); }
});

test("desktop refreshes portable inventory and search projections for the next portable owner", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const portable = { id: "thread-smoke", source: "codex" as const,
          title: "Obsoleteportableprojection", titleSource: "explicit" as const,
          linkedDirectories: [], updatedAt: 1 };
        const inventory = new ProviderThreadSnapshotStore(db);
        inventory.replace({ backend: "codex", observedAt: 1, threads: [portable] });
        inventory.replace({ backend: "acp:fixture-offline", observedAt: 1,
          threads: [{ ...portable, source: "acp:fixture-offline", id: "portable-offline",
            title: "Portable offline inventory" }] });
        // An old PwrAgent-owned inventory row needs scrubbing on desktop's
        // startup read. Inspect it raw afterward so Node cannot repair it.
        db.raw.prepare("UPDATE provider_thread_snapshots SET payload = json_set(payload, '$[0].summary', ?) WHERE backend = ?")
          .run("Invented legacy prompt that must be scrubbed", "acp:fixture-offline");
        const search = new ThreadSearchStore(db);
        search.upsertThreads([portable, { ...portable, id: "portable-retained-archive",
          title: "Portablearchivetoken", archivedAt: 2 }]);
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const results = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const current = await api.searchThreads!({ query: "Replay", contentMode: "metadata",
        filters: { backend: "codex" } });
      const obsolete = await api.searchThreads!({ query: "Obsoleteportableprojection",
        contentMode: "metadata", filters: { backend: "codex" } });
      return { current, obsolete };
    });
    expect(results.current.results).toMatchObject([{ backend: "codex", threadId: "thread-smoke", title: "Replay smoke thread" }]);
    expect(results.obsolete.results).toEqual([]);
    const raw = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      const payload = raw.prepare("SELECT payload FROM provider_thread_snapshots WHERE backend = ?")
        .pluck().get("acp:fixture-offline") as string;
      expect(JSON.parse(payload)).toMatchObject([{ id: "portable-offline", title: "Portable offline inventory" }]);
      expect(payload).not.toContain("Invented legacy prompt");
      expect(JSON.parse(payload)[0]).not.toHaveProperty("summary");
      // Transcript/search reads can finish while startup executable discovery
      // still holds the separate provider-inventory refresh. Observe its
      // persisted result before closing the owner; reads cannot refresh it.
      await expect.poll(() => JSON.parse(raw.prepare("SELECT payload FROM provider_thread_snapshots WHERE backend = 'codex'").pluck().get() as string))
        .toMatchObject([{ id: "thread-smoke", title: "Replay smoke thread" }]);
    } finally { raw.close(); }
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const search = new ThreadSearchStore(db);
      expect(search.search({ query: "Replay", limit: 10 })).toMatchObject([{ threadId: "thread-smoke", title: "Replay smoke thread" }]);
      expect(search.search({ query: "Obsoleteportableprojection", includeArchived: true, limit: 10 })).toEqual([]);
      expect(search.search({ query: "Portablearchivetoken", includeArchived: true, limit: 10 }))
        .toMatchObject([{ threadId: "portable-retained-archive", archivedAt: 2 }]);
      expect(new ProviderThreadSnapshotStore(db).list()).toContainEqual(expect.objectContaining({
        backend: "codex", threads: [expect.objectContaining({ id: "thread-smoke", title: "Replay smoke thread" })],
      }));
    } finally { db.close(); }
  } finally { await app.close(); }
});

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
    await app.window.getByRole("button", { name: /Portable owner metadata/i }).first().click();
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
    // Imported owner names remain visible until they are acknowledged by the provider.
    expect(result.before).toMatchObject({ title: "Portable owner metadata", titleSource: "explicit", pinnedRank: "1024", parentThreadId: "portable-parent", tokenMiserEnabled: true });
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
      expect(reader.pragma("user_version", { simple: true })).toBe(81);
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
