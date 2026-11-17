import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { MessagingStore } from "../messaging/core/messaging-store";
import { StateDb } from "../state/state-db";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { messagingBindingHarness } from "./fixtures/messaging-binding-harness";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("admits active retirement at its existing cost and rejects stale snapshots across WAL connections without writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), async (channel, rebind) => {
    const fixture = createTempStateDb("binding-retirement-admission-");
    const db = StateDb.open(fixture.dbPath);
    const peerDb = StateDb.open(fixture.dbPath);
    const store = new SqliteMessagingStore(db);
    const peer = new SqliteMessagingStore(peerDb);
    const f = await messagingBindingHarness({ channel, store });
    try {
      const binding = await f.bind("thread-a");
      const retired = { ...binding, statusSurface: undefined, pinnedStatusSurface: undefined };
      const admitted = await measureSqliteWrites(() => peer.upsertBinding(retired, {
        expectedActiveBinding: binding,
      }));
      expect(admitted.writes.commits).toBe(2);
      expect(admitted.result.statusSurface).toBeUndefined();
      expect(await f.revoke(binding)).toBe(true);
      expect(await f.active()).toBeUndefined();
      if (rebind) await f.bind("thread-a");
      const canonical = await store.getBinding(binding.id);
      const observations = await store.findObservedSurfaces();
      // Simulate an old status completion which carries old status metadata
      // and an unset revokedAt. Wall-clock freshness grants no authority.
      const rejected = await measureSqliteWrites(() => peer.upsertBinding({
        ...binding, updatedAt: binding.updatedAt + 1_000_000,
      }, { expectedActiveBinding: binding }));
      expect(rejected.result).toEqual(canonical);
      expect(await store.getBinding(binding.id)).toEqual(canonical);
      expect(await store.findObservedSurfaces()).toEqual(observations);
      expect(rejected.writes.commits).toBe(0);

      const legacy = new MessagingStore(path.join(fixture.tempDir, "messaging.json"));
      await legacy.upsertBinding(binding);
      await legacy.revokeBinding({ bindingId: binding.id });
      if (rebind) await legacy.upsertBinding(canonical!);
      const legacyCanonical = await legacy.getBinding(binding.id);
      expect(await legacy.upsertBinding(binding, { expectedActiveBinding: binding })).toEqual(legacyCanonical);
      expect(await legacy.getBinding(binding.id)).toEqual(legacyCanonical);
    } finally {
      await f.close();
      peerDb.close();
      db.close();
      removeTempStateDbDir(fixture.tempDir);
    }
  }), { numRuns: 25 });
});
