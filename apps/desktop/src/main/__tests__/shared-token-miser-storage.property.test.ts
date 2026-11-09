import fc from "fast-check";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteTokenMiserStorage as SharedStore } from "@pwragent/sqlite-storage/token-miser-storage-sqlite";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteTokenMiserStorage as DesktopStore } from "../storage/token-miser-storage-sqlite";
import { createTokenMiserStorage } from "../storage/desktop-runtime-storage";
import { TokenMiserStore } from "../token-miser/token-miser-store";
import type { TokenMiserCodeModeObservation, TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => {
  if (!active.db) throw new Error("No invented profile selected");
  return active.db;
} }));
afterEach(() => { active.db = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const bindings = [SharedStore, DesktopStore];
const owners = ["same", "other", "owner'); DROP TABLE meta; -- 雪"];
type Metadata = { objectId: string; threadId: string; createdAt: number; counters: { count: number } };
type Observation = { observationId: string; threadId: string; createdAt: number; calls: number };
type Indexed<T> = { payload: T; owner: string; at: number };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const accepted = (threadId: string, count: number) => ({
  threadId, turnId: "turn", toolUseId: `tool-${count}`, toolName: "Code Mode",
  output: `PRIVATE_ORIGINAL_${count}`, replacementCharacters: 10,
  summary: { summary: `PRIVATE_SUMMARY_${count}`, usefulDetails: ["PRIVATE_DETAIL"] },
});

it("binds generated concrete choices and the actual desktop service factory to the portable implementation", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), fc.nat({ max: 100 }), async (host, count) => {
    const db = openInMemoryStateDb();
    try {
      const adapter = new bindings[host]!<Metadata, Observation>(db);
      expect(Object.getPrototypeOf(adapter)).toBe(SharedStore.prototype);
      active.db = db;
      const write = vi.spyOn(SharedStore.prototype, "writeMetadata");
      const notify = vi.fn();
      const service = createTokenMiserStorage("invented-unused-directory", { onMetadataUpdated: notify });
      expect(Object.getPrototypeOf(service)).toBe(TokenMiserStore.prototype);
      active.db = undefined;
      const metadata = await service.store(accepted("same", count));
      expect(write).toHaveBeenCalledWith(metadata);
      expect(notify).toHaveBeenCalledWith(metadata, "stored");
      expect(new SharedStore(db).readMetadata(metadata.objectId, "same")).toEqual(metadata);
      write.mockRestore();
    } finally { db.close(); }
  }), { numRuns: 25 });
});

// The model keeps immutable index ownership/order separately from the JSON
// payload. Updating an existing ID changes exactly the columns the port owns;
// it must not silently move an existing row to another thread's index.
it("matches independent object, observation and generation models across WAL hosts and reopens", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    host: fc.integer({ min: 0, max: 1 }), slot: fc.integer({ min: 0, max: 4 }),
    owner: fc.constantFrom(...owners), count: fc.integer({ min: 0, max: 100 }),
    kind: fc.constantFrom("object", "sameObject", "remove", "observation", "sameObservation", "archive", "restore", "read"),
    reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async commands => {
    const fixture = createTempStateDb("shared-miser-model-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new bindings[index]!<Metadata, Observation>(db));
    const objects = new Map<string, Indexed<Metadata>>();
    const observations = new Map<string, Indexed<Observation>>();
    const retention = new Map<string, { generation: string; archived: boolean }>();
    let at = 0;
    try {
      for (const command of commands) {
        at++;
        const store = stores[command.host]!;
        const id = `object-${command.slot}`;
        const observationId = `observation-${command.slot}`;
        const commits = Number(command.kind !== "read");
        let rows = 0;
        const metadata = command.kind === "sameObject" && objects.has(id)
          ? clone(objects.get(id)!.payload)
          : { objectId: id, threadId: command.owner, createdAt: at, counters: { count: command.count } };
        const observation = command.kind === "sameObservation" && observations.has(observationId)
          ? clone(observations.get(observationId)!.payload)
          : { observationId, threadId: command.owner, createdAt: at, calls: command.count };
        if (command.kind === "object" || command.kind === "sameObject") {
          const previous = objects.get(id);
          rows = Number(!previous || JSON.stringify(previous.payload) !== JSON.stringify(metadata));
          objects.set(id, { payload: clone(metadata), owner: previous?.owner ?? metadata.threadId, at: previous?.at ?? at });
        } else if (command.kind === "observation" || command.kind === "sameObservation") {
          const previous = observations.get(observationId);
          rows = Number(!previous || JSON.stringify(previous.payload) !== JSON.stringify(observation));
          observations.set(observationId, { payload: clone(observation), owner: previous?.owner ?? observation.threadId, at: observation.createdAt });
        } else if (command.kind === "remove") {
          rows = Number(objects.delete(id));
        } else if (command.kind === "archive") {
          if (!retention.get(command.owner)?.archived) {
            retention.set(command.owner, { generation: String(at), archived: true }); rows = 1;
          }
        } else if (command.kind === "restore" && retention.get(command.owner)?.archived) {
          retention.get(command.owner)!.archived = false; rows = 1;
        }
        const measured = await measureSqliteWrites(() => {
          if (command.kind === "object" || command.kind === "sameObject") store.writeMetadata(metadata);
          if (command.kind === "observation" || command.kind === "sameObservation") store.recordObservation(observation);
          if (command.kind === "remove") store.removeMetadata(id);
          if (command.kind === "archive") store.archiveThread(command.owner, String(at));
          if (command.kind === "restore") store.restoreThread(command.owner);
        });
        expect({ commits: measured.writes.commits, rows: measured.writes.rowsChanged }).toEqual({ commits, rows });
        if (command.reopen) {
          dbs[command.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0);
          dbs[command.host] = reopened.result;
          stores[command.host] = new bindings[command.host]!<Metadata, Observation>(reopened.result);
        }
        const reads = await measureSqliteWrites(() => {
          for (const reader of stores) for (const owner of [undefined, ...owners]) {
            expect(reader.listMetadata(owner)).toEqual([...objects.values()].filter(entry => owner === undefined || entry.owner === owner)
              .sort((a, b) => b.at - a.at).map(entry => entry.payload));
            expect(reader.listObservations(owner)).toEqual([...observations.values()].filter(entry => owner === undefined || entry.owner === owner)
              .sort((a, b) => a.at - b.at).map(entry => entry.payload));
            for (const [id, entry] of objects) expect(reader.readMetadata(id, owner))
              .toEqual(owner === undefined || entry.owner === owner ? entry.payload : undefined);
            if (owner !== undefined) {
              expect(reader.isArchived(owner)).toBe(retention.get(owner)?.archived ?? false);
              expect(reader.readRetentionGeneration(owner)).toBe(retention.get(owner)?.generation ?? "");
            }
          }
          const detached = stores[0]!.listMetadata()[0];
          if (detached) { detached.counters.count = -1; expect(stores[1]!.readMetadata(detached.objectId)?.counters.count).toBeGreaterThanOrEqual(0); }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("imports generated duplicate records once with archive precedence and independent migration markers", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), fc.boolean(), fc.array(fc.nat({ max: 100 }), { minLength: 1, maxLength: 6 }), async (host, reversed, counts) => {
    const fixture = createTempStateDb("shared-miser-import-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const store = new bindings[host]!<Metadata, Observation>(dbs[host]!);
    const reader = new SharedStore<Metadata, Observation>(dbs[1 - host]!);
    try {
      const metadata = counts.map((count, index) => ({ objectId: `id-${index}`, threadId: owners[index % owners.length]!, createdAt: index, counters: { count } }));
      const observations = counts.map((count, index) => ({ observationId: `obs-${index}`, threadId: owners[index % owners.length]!, createdAt: index, calls: count }));
      const retention = [{ key: "same", generation: "restored", archived: 0 }, { key: "same", generation: "archived", archived: 1 }];
      if (reversed) retention.reverse();
      const records = { metadata: [...metadata, ...metadata.map(entry => ({ ...entry, counters: { count: -1 } }))],
        observations: [...observations, ...observations.map(entry => ({ ...entry, calls: -1 }))], retention };
      const imported = await measureSqliteWrites(() => store.importLegacyRecords(records));
      expect(imported.writes.commits).toBe(1);
      expect(reader.listMetadata()).toEqual([...metadata].reverse());
      expect(reader.listObservations()).toEqual(observations);
      expect(reader.isArchived("same")).toBe(true);
      expect(reader.readRetentionGeneration("same")).toBe("archived");
      store.writeMetadata({ ...metadata[0]!, counters: { count: 777 } });
      store.recordObservation({ ...observations[0]!, calls: 888 });
      store.restoreThread("same");
      store.importLegacyRecords(records);
      expect(reader.readMetadata("id-0")?.counters.count).toBe(777);
      expect(reader.listObservations()[0]?.calls).toBe(888);
      expect(reader.isArchived("same")).toBe(false);
      expect(store.hasLegacyMigration("migration-a")).toBe(false);
      const completion = await measureSqliteWrites(() => {
        store.completeLegacyMigration("migration-a"); store.completeLegacyMigration("migration-a");
      });
      expect({ commits: completion.writes.commits, rows: completion.writes.rowsChanged }).toEqual({ commits: 2, rows: 1 });
      expect(reader.hasLegacyMigration("migration-a")).toBe(true);
      expect(reader.hasLegacyMigration("migration-b")).toBe(false);
      dbs[host]!.raw.exec("CREATE TEMP TRIGGER refuse_observation BEFORE INSERT ON token_miser_observations BEGIN SELECT RAISE(ABORT, 'invented refusal'); END");
      const failed = await measureSqliteWrites(() => {
        expect(() => store.importLegacyRecords({ metadata: [{ ...metadata[0]!, objectId: "rollback" }], observations, retention: [] })).toThrow("invented refusal");
      });
      expect(failed.writes.commits).toBe(0);
      expect(reader.readMetadata("rollback")).toBeUndefined();
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("keeps generated exclusive batches atomic, immediately locked and rollback-safe across hosts", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), fc.array(fc.nat({ max: 100 }), { minLength: 1, maxLength: 8 }), async (host, counts) => {
    const fixture = createTempStateDb("shared-miser-lock-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new bindings[index]!<Metadata, Observation>(db));
    const writer = stores[host]!;
    const observer = stores[1 - host]!;
    const record = (count: number, index: number) => ({ objectId: `id-${index}`, threadId: "same", createdAt: index, counters: { count } });
    try {
      dbs[1 - host]!.raw.pragma("busy_timeout = 0");
      const failed = await measureSqliteWrites(() => expect(() => writer.runExclusive(() => {
        // An empty batch has already obtained the write lock before the first
        // read; a second host cannot race a read/modify/write into that gap.
        expect(() => observer.writeMetadata(record(0, 999))).toThrow(/locked/);
        counts.forEach((count, index) => writer.writeMetadata(record(count, index)));
        expect(observer.listMetadata()).toEqual([]);
        writer.archiveThread("same", "rollback");
        writer.completeLegacyMigration("rollback");
        throw new Error("rollback");
      })).toThrow("rollback"));
      expect(failed.writes.commits).toBe(0);
      expect(observer.listMetadata()).toEqual([]);
      expect(observer.isArchived("same")).toBe(false);
      expect(observer.hasLegacyMigration("rollback")).toBe(false);
      const committed = await measureSqliteWrites(() => writer.runExclusive(() => {
        counts.forEach((count, index) => writer.writeMetadata(record(count, index)));
        writer.runExclusive(() => writer.archiveThread("same", "committed"));
        return "result";
      }));
      expect(committed.result).toBe("result");
      expect(committed.writes.commits).toBe(1);
      expect(observer.listMetadata()).toEqual(counts.map(record).reverse());
      expect(observer.readRetentionGeneration("same")).toBe("committed");
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("reports generated malformed payloads without repairing them or writing on reads", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), fc.string({ maxLength: 30 }), async (host, suffix) => {
    const db = openInMemoryStateDb();
    const store = new bindings[host]!<Metadata, Observation>(db);
    try {
      const invalid = `{invalid${suffix}`;
      db.raw.prepare("INSERT INTO token_miser_objects(object_id, thread_id, created_at, payload) VALUES ('bad', 'same', 0, ?)").run(invalid);
      db.raw.prepare("INSERT INTO token_miser_observations(observation_id, thread_id, created_at, payload) VALUES ('bad', 'same', 0, ?)").run(invalid);
      const reads = await measureSqliteWrites(() => {
        expect(() => store.readMetadata("bad")).toThrow();
        expect(() => store.listMetadata("same")).toThrow();
        expect(() => store.listObservations("same")).toThrow();
        expect(store.readMetadata("bad", "other")).toBeUndefined();
        expect(store.listMetadata("other")).toEqual([]);
        expect(store.listObservations("other")).toEqual([]);
      });
      expect(reads.writes.commits).toBe(0);
      expect(db.raw.prepare("SELECT payload FROM token_miser_objects").pluck().get()).toBe(invalid);
      expect(db.raw.prepare("SELECT payload FROM token_miser_observations").pluck().get()).toBe(invalid);
    } finally { db.close(); }
  }), { numRuns: 25 });
});

it("retains generated service privacy and replay ownership through the real factory, migration and restart", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async count => {
    const fixture = createTempStateDb("shared-miser-service-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const directory = path.join(fixture.tempDir, "objects");
    const portable = new SharedStore<TokenMiserObjectMetadata, TokenMiserCodeModeObservation>(dbs[0]!);
    const reader = new TokenMiserStore(directory, { storage: portable });
    try {
      active.db = dbs[1]!;
      const service = createTokenMiserStorage(directory, {});
      active.db = undefined;
      const entries: TokenMiserObjectMetadata[] = [];
      for (let index = 0; index < count; index++) entries.push(await service.store(accepted("same", index)));
      const buffered = await measureSqliteWrites(async () => {
        for (const entry of entries) for (let request = 1; request <= 4; request++) {
          await service.recordParentModelRequest({ objectId: entry.objectId, cumulativeInputTokens: request * 100 });
        }
      });
      expect(buffered.writes.commits).toBe(0);
      expect((await reader.listMetadata("same")).every(entry => entry.cachedReplayCount === 0)).toBe(true);
      dbs[1]!.raw.exec("CREATE TEMP TRIGGER refuse_flush BEFORE UPDATE ON token_miser_objects BEGIN SELECT RAISE(ABORT, 'invented flush refusal'); END");
      const failedFlush = await measureSqliteWrites(async () => {
        await expect(service.flushThread("same")).rejects.toThrow("invented flush refusal");
      });
      expect(failedFlush.writes.commits).toBe(0);
      expect((await reader.listMetadata("same")).every(entry => entry.cachedReplayCount === 0)).toBe(true);
      expect((await service.listMetadata("same")).every(entry => entry.cachedReplayCount === 2)).toBe(true);
      dbs[1]!.raw.exec("DROP TRIGGER refuse_flush");
      const flushed = await measureSqliteWrites(() => service.flushThread("same"));
      expect(flushed.writes.commits).toBe(1);
      expect((await reader.listMetadata("same")).every(entry => entry.cachedReplayCount === 2)).toBe(true);
      expect(await reader.readAll({ threadId: "same", objectId: entries[0]!.objectId })).toBeUndefined();
      await service.recordCodeModeObservation({ threadId: "same", turnId: "turn", callId: "call", cellId: "cell", outputCharacters: 10,
        maxOutputTokens: 100, scriptStatus: "completed", retrieval: false, capturedNestedInvocationCount: 1,
        script: "PRIVATE_SCRIPT", outputPreview: "PRIVATE_PREVIEW" });
      const key = createHash("sha256").update("same").digest("hex");
      const thread = path.join(directory, "threads", key);
      await fs.mkdir(thread, { recursive: true });
      await fs.writeFile(path.join(thread, `${entries[0]!.objectId}.json`), JSON.stringify({ ...entries[0], retrievedCharacters: 999, summary: accepted("same", 0).summary }));
      await fs.writeFile(path.join(thread, "archived"), "legacy-archive");
      await fs.writeFile(path.join(thread, "retention-generation"), "older-generation");
      await fs.writeFile(path.join(directory, `${entries[0]!.objectId}.txt`), "PRIVATE_LEGACY_OUTPUT");
      await service.prune({ maxAgeMs: 0, maxBytes: 0 });
      expect((await reader.readMetadata(entries[0]!.objectId))?.retrievedCharacters).toBe(0);
      expect(portable.readRetentionGeneration(key)).toBe("legacy-archive");
      expect(await service.readAll({ threadId: "same", objectId: entries[0]!.objectId })).toBeUndefined();
      await service.restoreThread("same");
      expect(await service.readAll({ threadId: "same", objectId: entries[0]!.objectId })).toBeUndefined();
      expect(JSON.stringify(dbs[0]!.raw.prepare("SELECT payload FROM token_miser_objects UNION ALL SELECT payload FROM token_miser_observations").all())).not.toContain("PRIVATE_");
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      const replayed = await measureSqliteWrites(() => service.prune({ maxAgeMs: 0, maxBytes: 0 }));
      expect(replayed.writes.commits).toBe(0);
      const emptyFlush = await measureSqliteWrites(() => service.flushAll());
      expect(emptyFlush.writes.commits).toBe(0);
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});
