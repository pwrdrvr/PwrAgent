import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadSearchStorage } from "@pwragent/owner-core/thread-search-storage";
import type { TokenMiserStorage } from "@pwragent/owner-core/token-miser-storage";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { SqliteTokenMiserStorage } from "../storage/token-miser-storage-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("keeps search projections equal to the latest provider rows across replacements and deletions", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    remove: fc.boolean(), slot: fc.integer({ min: 0, max: 4 }),
    source: fc.constantFrom("codex" as const, "claude" as const),
    archived: fc.boolean(), word: fc.constantFrom("Alpha", "Beta"),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 30 }), async (operations) => {
    const db = openInMemoryStateDb();
    const storage: ThreadSearchStorage = new ThreadSearchStore(db);
    const provider = new Map<string, AppServerThreadSummary>();
    try {
      for (const op of operations) {
        const id = `thread-${op.slot}`;
        const key = `${op.source}/${id}`;
        if (op.remove) {
          provider.delete(key);
          storage.deleteThread({ backend: op.source, threadId: id });
        } else {
          // Providers may change metadata without advancing their timestamp.
          const thread: AppServerThreadSummary = {
            id, source: op.source, title: `${op.word} ${id}`, titleSource: "derived",
            createdAt: 1_000, updatedAt: 1_000, linkedDirectories: [],
            archivedAt: op.archived ? 2_000 : undefined,
          };
          provider.set(key, thread);
          storage.upsertThreads([thread]);
          const repeated = await measureSqliteWrites(() => storage.upsertThreads([thread]));
          expect(repeated.writes.commits).toBe(0);
        }
        const reads = await measureSqliteWrites(() => {
          for (const backend of [undefined, "codex", "claude"] as const) {
            for (const includeArchived of [true, false]) {
              for (const query of [undefined, "Alpha", "Beta"]) {
                const expected = [...provider.values()]
                  .filter(row => (!backend || row.source === backend)
                    && (includeArchived || row.archivedAt === undefined)
                    && (!query || row.title.startsWith(query)))
                  .map(row => `${row.source}/${row.id}: ${row.title}`).sort();
                const actual = storage.search({ backend, includeArchived, query, limit: 100 })
                  .map(row => `${row.backend}/${row.threadId}: ${row.title}`).sort();
                expect(actual).toEqual(expected);
              }
            }
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { db.close(); }
  }), { numRuns: 50 });
});

type Metadata = { objectId: string; threadId: string; createdAt: number; count: number };
type Observation = { observationId: string; threadId: string; createdAt: number };

it("keeps Token Miser metadata updates atomic and retention generations stable across retries", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    kind: fc.constantFrom("write", "remove", "rollback", "archive", "restore"),
    slot: fc.integer({ min: 0, max: 3 }), count: fc.nat({ max: 100 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 40 }), async (operations) => {
    const db = openInMemoryStateDb();
    const storage: TokenMiserStorage<Metadata, Observation> = new SqliteTokenMiserStorage(db);
    const metadata = new Map<string, Metadata>();
    let archived = false;
    let generation = "";
    try {
      for (const [index, op] of operations.entries()) {
        const entry: Metadata = { objectId: `object-${op.slot}`, threadId: "owner", createdAt: op.slot, count: op.count };
        switch (op.kind) {
          case "write":
            storage.runExclusive(() => storage.writeMetadata(entry));
            metadata.set(entry.objectId, entry);
            break;
          case "remove":
            storage.removeMetadata(entry.objectId);
            metadata.delete(entry.objectId);
            break;
          case "rollback":
            expect(() => storage.runExclusive(() => {
              storage.writeMetadata(entry);
              storage.removeMetadata(`object-${(op.slot + 1) % 4}`);
              throw new Error("Model rollback");
            })).toThrow("Model rollback");
            break;
          case "archive":
            storage.archiveThread("owner-key", `generation-${index}`);
            if (!archived) generation = `generation-${index}`;
            archived = true;
            break;
          case "restore":
            storage.restoreThread("owner-key");
            archived = false;
            break;
        }
        const reads = await measureSqliteWrites(() => {
          expect(storage.listMetadata("owner")).toEqual([...metadata.values()].sort((a, b) => b.createdAt - a.createdAt));
          for (const id of [0, 1, 2, 3]) {
            expect(storage.readMetadata(`object-${id}`, "owner")).toEqual(metadata.get(`object-${id}`));
            expect(storage.readMetadata(`object-${id}`, "other")).toBeUndefined();
          }
          expect(storage.isArchived("owner-key")).toBe(archived);
          expect(storage.readRetentionGeneration("owner-key")).toBe(generation);
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { db.close(); }
  }), { numRuns: 100 });
});
