import fc from "fast-check";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import type { MessagingPairingStorage } from "@pwragent/owner-core/messaging-pairing-storage";
import type { DesktopMessagingStorage, MessagingRequestStore } from "../messaging/core/messaging-storage";
import { getDesktopMessagingActivityLog, setDesktopMessagingActivityLogForTests } from "../messaging/desktop-messaging-activity-log";
import { getDesktopMessagingPairingStore, setDesktopMessagingPairingStoreForTests } from "../messaging/desktop-messaging-pairing-store";
import { getDesktopMessagingStore, resetDesktopMessagingStoreForTests, setDesktopMessagingStoreForTests } from "../messaging/desktop-messaging-store";
import { createMessagingRequestStorage } from "../storage/desktop-messaging-storage";
import { MessagingActivityLog } from "../storage/messaging-activity-log";
import { MessagingPairingStore } from "../storage/messaging-pairing-store";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { SqliteMessagingRequestStore } from "../state/messaging-request-store";
import type { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined, store: undefined as DesktopMessagingStorage | undefined }));
vi.mock("../state/app-state", () => ({
  getAppStateDb: () => {
    if (!active.db) throw new Error("App state not initialized");
    return active.db;
  },
  getAppMessagingStore: () => {
    if (!active.store) throw new Error("App state not initialized");
    return active.store;
  },
}));

function resetOverrides(): void {
  setDesktopMessagingActivityLogForTests(null);
  setDesktopMessagingPairingStoreForTests(null);
  resetDesktopMessagingStoreForTests();
}

afterEach(() => {
  resetOverrides();
  active.db = undefined;
  active.store = undefined;
  vi.unstubAllEnvs();
});

it("retains every public SQLite method signature through the storage ports", () => {
  expectTypeOf<DesktopMessagingStorage>().toEqualTypeOf<Pick<SqliteMessagingStore, keyof DesktopMessagingStorage>>();
  expectTypeOf<MessagingRequestStore>().toEqualTypeOf<Pick<SqliteMessagingRequestStore, keyof MessagingRequestStore>>();
  expectTypeOf<MessagingActivityStorage>().toEqualTypeOf<Pick<MessagingActivityLog, keyof MessagingActivityStorage>>();
  expectTypeOf<MessagingPairingStorage>().toEqualTypeOf<Pick<MessagingPairingStore, keyof MessagingPairingStorage>>();
});

it("binds each accessor to the current profile or override while already returned stores keep their database", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({ profile: fc.integer({ min: 0, max: 1 }), override: fc.boolean() });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 25 }), async (operations) => {
    resetOverrides();
    const profiles = [0, 1].map(() => {
      const db = openInMemoryStateDb();
      return { db, store: new SqliteMessagingStore(db) };
    });
    const model: Array<{ summaries: string[]; pairings: string[] }> = [0, 1].map(() => ({ summaries: [], pairings: [] }));
    try {
      const bound: Array<{ activity: MessagingActivityStorage; pairing: MessagingPairingStorage;
        store: DesktopMessagingStorage; requests: MessagingRequestStore }> = [];
      for (const profile of profiles) {
        active.db = profile.db;
        active.store = profile.store;
        const bindings = await measureSqliteWrites(() => ({ activity: getDesktopMessagingActivityLog(),
          pairing: getDesktopMessagingPairingStore(), store: getDesktopMessagingStore() }));
        expect(bindings.writes.commits).toBe(0);
        // Request owner initialization remains eager at the existing controller construction site.
        const requests = await measureSqliteWrites(() => createMessagingRequestStorage());
        expect(requests.writes.commits).toBe(1);
        bound.push({ ...bindings.result, requests: requests.result });
      }
      for (const [index, op] of operations.entries()) {
        active.db = profiles[op.profile]!.db;
        active.store = profiles[op.profile]!.store;
        const target = op.override ? 1 - op.profile : op.profile;
        if (op.override) {
          setDesktopMessagingActivityLogForTests(bound[target]!.activity);
          setDesktopMessagingPairingStoreForTests(bound[target]!.pairing);
          setDesktopMessagingStoreForTests(bound[target]!.store);
          // Overrides must continue to work without initialized app state.
          active.db = undefined;
          active.store = undefined;
        }
        expect(getDesktopMessagingStore()).toBe(profiles[target]!.store);
        const activity = getDesktopMessagingActivityLog();
        const pairing = getDesktopMessagingPairingStore();
        if (op.override) {
          expect(activity).toBe(bound[target]!.activity);
          expect(pairing).toBe(bound[target]!.pairing);
        } else {
          expect(activity).not.toBe(bound[target]!.activity);
          expect(pairing).not.toBe(bound[target]!.pairing);
        }
        activity.record({ platform: "slack", kind: "outbound", summary: `Fixture ${index}`, createdAt: index });
        const entry = pairing.create({ token: `fixture-${index}`, platform: "slack", instanceId: "fixture",
          scope: "observed", generatedAt: index, expiresAt: 10_000 });
        model[target]!.summaries.unshift(`Fixture ${index}`);
        model[target]!.pairings.push(entry.id);
        // A constructed request store remains bound even after active state switches or disappears.
        const source = bound[op.profile]!.requests.remember({ agent: { backend: "codex", threadId: "owner" },
          event: { id: `fixture-${index}`, kind: "text", text: "Private fixture", receivedAt: index,
            actor: { platformUserId: "fixture" },
            channel: { channel: "slack", conversation: { id: "fixture", kind: "channel" } } } })!;
        expect(bound[op.profile]!.requests.get(source.ref)).toEqual(source);
        expect(bound[1 - op.profile]!.requests.get(source.ref)).toBeUndefined();
        const reads = await measureSqliteWrites(() => {
          for (const [slot, storage] of bound.entries()) {
            expect(storage.activity.list().map(row => row.summary)).toEqual(model[slot]!.summaries);
            for (const id of model[slot]!.pairings) expect(storage.pairing.get(id)?.id).toBe(id);
            for (const id of model[1 - slot]!.pairings) expect(storage.pairing.get(id)).toBeUndefined();
          }
        });
        expect(reads.writes.commits).toBe(0);
        resetOverrides();
      }
      active.db = undefined;
      active.store = undefined;
      for (const accessor of [getDesktopMessagingActivityLog, getDesktopMessagingPairingStore, getDesktopMessagingStore,
        createMessagingRequestStorage]) expect(() => accessor()).toThrow("App state not initialized");
    } finally {
      resetOverrides();
      active.db = undefined;
      active.store = undefined;
      for (const profile of profiles) profile.db.close();
    }
  }), { numRuns: 50 });
});
