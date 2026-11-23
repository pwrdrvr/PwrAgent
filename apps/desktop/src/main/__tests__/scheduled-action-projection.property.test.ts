import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { ScheduledThreadAction } from "@pwragent/shared/contracts/scheduled-thread-actions";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import { FileScheduledThreadActionPayloadStore, MemoryScheduledThreadActionPayloadStore } from "../storage/scheduled-thread-action-payload-store";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const scope = { backend: "codex" as const, threadId: "fixture" };
const history = { projectionProtocol: 2 as const, includeTerminal: true };
const lease = { ownerId: "fixture-scheduler", leaseExpiresAt: 2_000 };
const active = new Set(["held", "scheduled", "dispatching", "queued"]);

function schedule(id: string, now: number, threadId = scope.threadId) {
  return { ...scope, id, threadId, kind: "turn" as const, origin: "desktop" as const,
    scheduledFor: now, displayText: id, now };
}

it("projects the same clock-window and history model through local and peer mutations", () => {
  fc.assert(fc.property(fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
    ([createOnPeer, editOnPeer, claimOnPeer, renewOnPeer, cancelOnPeer]) => {
      const { dbPath, tempDir } = createTempStateDb("scheduled-projection-model-");
      const ownerDb = StateDb.open(dbPath);
      const peerDb = StateDb.open(dbPath);
      const payloads = new MemoryScheduledThreadActionPayloadStore();
      const owner = new ScheduledThreadActionStore(ownerDb, payloads);
      const peer = new ScheduledThreadActionStore(peerDb, payloads);
      const writer = (external: boolean) => external ? peer : owner;
      try {
        const model: ScheduledThreadAction[] = [];
        ownerDb.raw.transaction(() => {
          for (let i = 0; i < 100; i++) {
            const id = `fixture-${String(i).padStart(3, "0")}`;
            const input = schedule(id, 10);
            owner.create(input);
            model.push({ ...scope, id, kind: "turn", origin: "desktop", status: "scheduled",
              scheduledFor: 10, displayText: id, createdAt: 10, updatedAt: 10 });
          }
        })();
        const selectedHistory = { ...history, ...scope };
        const cursor = (store: ScheduledThreadActionStore) => store.listProjectionPage(selectedHistory).nextCursor;
        const expected = (cutoff: number) => model.filter(row => active.has(row.status) || row.updatedAt >= cutoff);
        const checkWindow = (cutoff: number) => {
          for (const store of [owner, peer]) {
            let next: string | undefined;
            const actions = [];
            do {
              const page = store.listProjectionPage({ ...selectedHistory, terminalUpdatedAfter: cutoff, cursor: next });
              actions.push(...page.actions);
              next = page.nextCursor;
            } while (next);
            expect(actions).toEqual(expected(cutoff));
          }
        };
        const id = "target";
        writer(createOnPeer).create(schedule(id, 10));
        model.push({ ...scope, id, kind: "turn", origin: "desktop", status: "scheduled",
          scheduledFor: 10, displayText: id, createdAt: 10, updatedAt: 10 });
        checkWindow(11);

        const checkChange = (external: boolean, mutate: (store: ScheduledThreadActionStore) => void) => {
          const first = cursor(owner);
          expect(first).toBeDefined();
          const global = owner.listProjectionPage(history).nextCursor;
          expect(global).toBeDefined();
          const reader = external ? owner : peer;
          reader.observeExternalProjectionChange();
          mutate(writer(external));
          expect(reader.observeExternalProjectionChange()).toBe(true);
          expect(reader.observeExternalProjectionChange()).toBe(false);
          for (const [request, oldCursor] of [[selectedHistory, first], [history, global]] as const) {
            expect(() => owner.listProjectionPage({ ...request, cursor: oldCursor })).toThrow("navigation_cursor_expired");
          }
        };

        // A same-timestamp edit changes only the immutable payload reference.
        checkChange(editOnPeer, store => { store.update(id, { displayText: "Edited", now: 10 }); });
        Object.assign(model.at(-1)!, { displayText: "Edited" });
        checkWindow(11);
        checkChange(claimOnPeer, store => { store.claim(id, { ...lease, now: 11 }); });
        Object.assign(model.at(-1)!, { status: "dispatching", updatedAt: 11 });
        checkWindow(12);
        checkChange(renewOnPeer, store => { store.renewClaims(lease.ownerId, 12, 3_000); });
        Object.assign(model.at(-1)!, { updatedAt: 12 });
        checkWindow(13);
        checkChange(cancelOnPeer, store => { store.markCancelled(id, 13, lease.ownerId); });
        Object.assign(model.at(-1)!, { status: "cancelled", updatedAt: 13 });
        checkWindow(13);
        checkWindow(14);

        const scoped = cursor(owner);
        const window = { ...selectedHistory, terminalUpdatedAfter: 14 };
        const windowCursor = owner.listProjectionPage(window).revision;
        peer.create(schedule("elsewhere", 10, "other"));
        expect(owner.listProjectionPage({ ...selectedHistory, cursor: scoped }).actions.map(a => a.id)).toEqual([id]);
        expect(owner.listProjectionPage(window).revision).toBe(windowCursor);
      } finally {
        peerDb.close();
        ownerDb.close();
        removeTempStateDbDir(tempDir);
      }
    }), { numRuns: 12 });
});

it("expires a page when a peer replaces a payload during hydration", () => {
  const { dbPath, tempDir } = createTempStateDb("scheduled-projection-race-");
  const db = StateDb.open(dbPath);
  const peerDb = StateDb.open(dbPath);
  const payloads = new FileScheduledThreadActionPayloadStore(tempDir);
  const store = new ScheduledThreadActionStore(db, payloads);
  const peer = new ScheduledThreadActionStore(peerDb, payloads);
  try {
    store.create(schedule("race", 1));
    const read = payloads.read.bind(payloads);
    const spy = vi.spyOn(payloads, "read").mockImplementationOnce((ref, maxBytes) => {
      const previous = read(ref, maxBytes);
      peer.update("race", { displayText: "New payload", now: 1 });
      return previous;
    });
    expect(() => store.listProjectionPage(history)).toThrow("navigation_cursor_expired");
    spy.mockRestore();
    expect(store.listProjectionPage(history).actions[0]?.displayText).toBe("New payload");
  } finally {
    peerDb.close();
    db.close();
    removeTempStateDbDir(tempDir);
  }
});

it.each([
  ["raw index budget", "x".repeat(8 * 1024 * 1024)],
  ["JSON escaping budget", "\u0001".repeat(1_400_000)],
])("keeps dispatch independent of the %s", (_name, errorMessage) => {
  const db = openInMemoryStateDb();
  const store = new ScheduledThreadActionStore(db);
  try {
    store.create(schedule("terminal", 1));
    store.cancel("terminal", 2);
    db.raw.prepare("UPDATE scheduled_thread_actions SET error_message = ? WHERE action_id = ?").run(errorMessage, "terminal");
    store.create(schedule("due", 3));
    expect(() => store.listProjectionPage(history)).toThrow("index exceeds its byte budget");
    expect(store.observeExternalProjectionChange()).toBe(false);
    expect(store.claimNextDue({ ...lease, now: 3 })).toMatchObject({ id: "due", status: "dispatching" });
    expect(store.listProjectionPage({ ...history, terminalUpdatedAfter: 3 }).actions.map(a => a.id)).toEqual(["due"]);
    store.cleanupTerminalBefore(3);
    expect(store.listProjectionPage(history).actions.map(a => a.id)).toEqual(["due"]);
  } finally {
    db.close();
  }
});

it("admits owner history when the conservative JSON bound alone exceeds the limit", () => {
  const db = openInMemoryStateDb();
  const store = new ScheduledThreadActionStore(db);
  try {
    const errorMessage = "a".repeat(100_000);
    for (let i = 0; i < 15; i++) {
      store.create(schedule(`moderate-${i}`, i));
      store.cancel(`moderate-${i}`, 20);
    }
    db.raw.prepare("UPDATE scheduled_thread_actions SET error_message = ?").run(errorMessage);
    const page = store.listProjectionPage(history);
    expect(page.actions.map(a => a.id)).toEqual(["moderate-0", "moderate-1"]);
    expect(page.complete).toBe(false);
  } finally {
    db.close();
  }
});

it.each([
  { version: 85, missingTriggerOnly: false },
  { version: 86, missingTriggerOnly: false },
  { version: 87, missingTriggerOnly: false },
  { version: 87, missingTriggerOnly: true },
])("repairs scheduled projections at v$version (only update trigger absent: $missingTriggerOnly)", ({ version, missingTriggerOnly }) => {
  const { dbPath, tempDir } = createTempStateDb("scheduled-projection-migration-");
  let db = StateDb.open(dbPath);
  try {
    const store = new ScheduledThreadActionStore(db);
    store.create(schedule("retained", 1));
    const retained = store.cancel("retained", 2);
    const { payload_ref } = db.raw.prepare("SELECT payload_ref FROM scheduled_thread_actions").get() as { payload_ref: string };
    const errorMessage = missingTriggerOnly ? "A writer ran before the projection trigger was installed" : undefined;
    db.raw.exec("DROP TRIGGER scheduled_action_projection_update");
    if (missingTriggerOnly) {
      db.raw.prepare("UPDATE scheduled_thread_actions SET error_message = ?").run(errorMessage);
    } else {
      db.raw.exec(`
        DROP TRIGGER scheduled_action_projection_insert;
        DROP TRIGGER scheduled_action_projection_delete;
        DROP TABLE scheduled_action_projection_state;
        DROP INDEX idx_scheduled_thread_actions_projection_order;
        DROP INDEX idx_scheduled_thread_actions_terminal_updated;
      `);
    }
    db.raw.pragma("user_version = " + version);
    db.close();

    db = StateDb.open(dbPath);
    expect(db.raw.pragma("user_version", { simple: true })).toBe(Math.max(version, CURRENT_STATE_DB_USER_VERSION));
    const reopened = new ScheduledThreadActionStore(db);
    const expected = [{ ...retained, errorMessage }];
    expect(reopened.listProjectionPage({ ...history, terminalUpdatedAfter: 2 }).actions).toEqual(expected);
    expect(reopened.listProjectionPage(history).actions).toEqual(expected);
    const state = () => db.raw.prepare("SELECT * FROM scheduled_action_projection_state").get();
    const migrated = state();
    expect(migrated).toMatchObject({ admission_bytes: 512 + "retained".length + scope.threadId.length
      + Buffer.byteLength(payload_ref) + Buffer.byteLength(errorMessage ?? "") });
    db.close();

    db = StateDb.open(dbPath);
    expect(state()).toEqual(migrated);
  } finally {
    if (db.raw.open) db.close();
    removeTempStateDbDir(tempDir);
  }
});
