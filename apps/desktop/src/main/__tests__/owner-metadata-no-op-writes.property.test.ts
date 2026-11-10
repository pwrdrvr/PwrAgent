import fc from "fast-check";
import { isDeepStrictEqual } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { OwnerThreadMetadataPatch, OwnerThreadRecord } from "@pwragent/owner-core/thread-storage";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const identity = { backend: "codex" as const, threadId: "fixture" };
const budgetFile = "owner-metadata-no-op-write-budgets.json";
afterEach(() => vi.unstubAllEnvs());

// Node's structural oracle ignores object key order and preserves array order.
// Normalize through JSON first, as persistence omits undefined object members.
function structurallyEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

function mergeModel(current: OwnerThreadRecord, patch: OwnerThreadMetadataPatch): OwnerThreadRecord {
  const next = structuredClone(current);
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) Reflect.deleteProperty(next, field);
    else if (value !== undefined) Reflect.set(next, field, JSON.parse(JSON.stringify(value)));
  }
  next.executionMode ??= "default";
  return next;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
  }
  return value;
}

it("does not rewrite a repeated null execution-mode reset after Token Miser creates the overlay", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("owner-metadata-null-reset-");
  const db = StateDb.open(fixture.dbPath);
  const store = new SqliteOverlayStore(db);
  const patch: OwnerThreadMetadataPatch = {
    title: null, seenAt: null, executionMode: null, subthreadOrder: [], archived: false,
  };
  try {
    await store.setThreadTokenMiser({ ...identity, enabled: true });
    const before = await store.updateThreadMetadata(identity, patch);
    const repeated = await measureSqliteWrites(() => store.updateThreadMetadata(identity, patch));
    expect(repeated.result).toEqual(before);
    expect(repeated.writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
    const batch = await measureSqliteWrites(async () => {
      for (let index = 0; index < 100; index++) await store.updateThreadMetadata(identity, patch);
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "repeated-null-reset", writes: batch.writes,
      note: "100 repeated owner metadata patches after Token Miser setup; null executionMode restores default without a durable change; 0 MB/day" });
    expect((await store.getThreadOverlayState(identity))?.tokenMiserEnabled).toBe(true);
  } finally {
    db.close();
    removeTempStateDbDir(fixture.tempDir);
  }
});

// Every generated command must commit exactly when the independently merged
// public record changes structurally, including nested objects and array order.
it("matches a structural-equality write model for generated metadata patches and reordered reassertions", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const optional = <T>(value: fc.Arbitrary<T>) => fc.oneof(fc.constant(undefined), fc.constant(null), value);
  const patches: fc.Arbitrary<OwnerThreadMetadataPatch> = fc.record({
    title: optional(fc.record({
      text: fc.string({ maxLength: 12 }), source: fc.constantFrom("explicit" as const, "derived" as const),
      nativeName: fc.oneof(fc.constant(undefined), fc.string({ maxLength: 12 })),
    })),
    parent: optional(fc.record({
      backend: fc.constantFrom("codex" as const, "claude" as const), threadId: fc.string({ maxLength: 12 }),
      instanceId: fc.oneof(fc.constant(undefined), fc.string({ maxLength: 12 })),
    })),
    executionMode: optional(fc.constantFrom("default" as const, "auto" as const)),
    seenAt: optional(fc.nat({ max: 100 })), model: optional(fc.string({ maxLength: 12 })),
    reasoningEffortsByModel: optional(fc.dictionary(fc.constantFrom("model-a", "model-b", "model-c"), fc.string({ maxLength: 8 }))),
    subthreadOrder: optional(fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 })),
    archived: optional(fc.boolean()), fastMode: optional(fc.boolean()),
  }, { requiredKeys: [], noNullPrototype: true });
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("codex" as const, "claude" as const, "acp:kimi" as const),
    fc.array(patches, { minLength: 1, maxLength: 12 }),
    async (backend, commands) => {
      const fixture = createTempStateDb("owner-metadata-structural-model-");
      const db = StateDb.open(fixture.dbPath);
      const observerDb = StateDb.open(fixture.dbPath);
      const stores = [new SqliteOverlayStore(db), new SqliteOverlayStore(observerDb)];
      const target = { ...identity, backend };
      let model: OwnerThreadRecord = { ...target, executionMode: "default" };
      try {
        await stores[0]!.setThreadTokenMiser({ ...target, enabled: true });
        for (const [index, patch] of commands.entries()) {
          const next = mergeModel(model, patch);
          const expectedCommits = structurallyEqual(model, next) ? 0 : 1;
          const store = stores[index % stores.length]!;
          const applied = await measureSqliteWrites(() => store.updateThreadMetadata(target, patch));
          expect(applied.result).toEqual(next);
          expect(applied.writes.commits).toBe(expectedCommits);
          model = next;
          const reordered = reverseObjectKeys(patch) as OwnerThreadMetadataPatch;
          const repeated = await measureSqliteWrites(() => store.updateThreadMetadata(target, reordered));
          expect(repeated.result).toEqual(model);
          expect([repeated.writes.commits, repeated.writes.statements, repeated.writes.rowsChanged]).toEqual([0, 0, 0]);
          for (const observer of stores) {
            expect(await observer.getThreadMetadata(target)).toEqual(model);
            expect((await observer.getThreadOverlayState(target))?.tokenMiserEnabled).toBe(true);
          }
        }
      } finally {
        observerDb.close();
        db.close();
        removeTempStateDbDir(fixture.tempDir);
      }
    },
  ), { numRuns: 25 });
});

it("keeps one commit for real nested, ordered-array and null-reset mutations and rolls back atomically", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("owner-metadata-mutation-budget-");
  const db = StateDb.open(fixture.dbPath);
  const observerDb = StateDb.open(fixture.dbPath);
  const store = new SqliteOverlayStore(db);
  const observer = new SqliteOverlayStore(observerDb);
  try {
    await store.setThreadTokenMiser({ ...identity, enabled: true });
    const patches: OwnerThreadMetadataPatch[] = [
      { title: { text: "Fixture", source: "explicit" }, executionMode: "auto", subthreadOrder: ["a", "b"] },
      { title: { text: "Changed", source: "explicit" } },
      { subthreadOrder: ["b", "a"] },
      { executionMode: null },
    ];
    for (const patch of patches) {
      const mutation = await measureSqliteWrites(() => store.updateThreadMetadata(identity, patch));
      expect(mutation.writes.commits).toBe(1);
      expectSqliteWriteBudget({ budgetFile, scenario: "real-metadata-mutation", writes: mutation.writes,
        note: "One real owner metadata change retains its original transaction and write sites; setup excluded" });
      expect(await observer.getThreadMetadata(identity)).toEqual(mutation.result);
    }
    const before = await observer.getThreadMetadata(identity);
    expect(() => db.raw.transaction(() => {
      store.mergeOwnerThreadMetadata(identity, { title: null, archived: true });
      expect(observer.readOwnerThreadMetadata(identity)).toEqual(before);
      throw new Error("fixture rollback");
    }).immediate()).toThrow("fixture rollback");
    expect(await store.getThreadMetadata(identity)).toEqual(before);
    expect(await observer.getThreadMetadata(identity)).toEqual(before);
  } finally {
    observerDb.close();
    db.close();
    removeTempStateDbDir(fixture.tempDir);
  }
});
