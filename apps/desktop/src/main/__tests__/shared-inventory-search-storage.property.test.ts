import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import type { ProviderThreadSnapshot } from "@pwragent/owner-core/provider-thread-snapshot-storage";
import type { ThreadSearchProjectionSearchRequest } from "@pwragent/owner-core/thread-search-storage";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { ThreadSearchStore as SharedSearch } from "@pwragent/sqlite-storage/thread-search-store";
import { ProviderThreadSnapshotStore as SharedInventory } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { ThreadSearchStore as DesktopSearch } from "../storage/thread-search-store";
import { ProviderThreadSnapshotStore as DesktopInventory } from "../storage/provider-thread-snapshot-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const backends = ["codex", "acp:kimi"] as const;
const searchBindings = [SharedSearch, DesktopSearch];
const inventoryBindings = [SharedInventory, DesktopInventory];
const key = (thread: AppServerThreadSummary) => JSON.stringify([thread.source, thread.id]);
afterEach(() => vi.unstubAllEnvs());

it("binds desktop inventory and search to the portable implementations", () => {
  fc.assert(fc.property(fc.constantFrom("inventory", "search"), binding => {
    expect(binding === "inventory" ? DesktopInventory : DesktopSearch)
      .toBe(binding === "inventory" ? SharedInventory : SharedSearch);
  }));
});

function summary(backend: number, slot: number, revision: number, archived = false): AppServerThreadSummary {
  return {
    source: backends[backend]!, id: `same-id-${slot}`,
    title: `${revision % 2 ? "Alpha" : "Beta"} task ${slot}`,
    titleSource: "explicit", linkedDirectories: [{ id: `dir-${slot % 2}`, label: "Fixture", kind: "local",
      path: `/fixture/${slot % 2}`, worktreePath: `/fixture/worktree/${slot % 2}` }],
    model: `model-${revision % 2}`, projectKey: `project-${slot % 2}`,
    createdAt: 1, updatedAt: revision + 10,
    ...(archived ? { archivedAt: revision + 20 } : {}),
    fastMode: false, serviceTier: "fast", reasoningEffort: "high",
  };
}

// Inventory replaces only the named provider's complete list. Durable records
// keep metadata, including false/zero values, and exclude prompt/runtime fields.
it("matches independent provider inventories across WAL connections and reopen order", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    backend: fc.integer({ min: 0, max: 1 }), host: fc.integer({ min: 0, max: 1 }),
    slots: fc.uniqueArray(fc.integer({ min: 0, max: 4 })), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 20 }), async commands => {
    const fixture = createTempStateDb("shared-inventory-model-");
    const connections = inventoryBindings.map(() => StateDb.open(fixture.dbPath));
    const stores = connections.map((db, i) => new inventoryBindings[i]!(db));
    const model = new Map<string, ProviderThreadSnapshot>();
    try {
      for (const [revision, command] of commands.entries()) {
        const threads = command.slots.map(slot => summary(command.backend, slot, revision));
        const snapshot = { backend: backends[command.backend]!, observedAt: revision, threads };
        const write = await measureSqliteWrites(() => stores[command.host]!.replace({ ...snapshot,
          threads: threads.map(thread => ({ ...thread, summary: "private prompt", codexNativeSubAgents: [{
            threadId: "private-worker", title: "private prompt task",
          }], codexEnvironmentRuntime: { environmentId: "fixture", environmentName: "Fixture",
            executionTarget: "local", setupOutput: "private output" } })),
        }));
        expect(write.writes.commits).toBe(1);
        model.set(snapshot.backend, snapshot);
        if (command.reopen) {
          connections[command.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0);
          connections[command.host] = reopened.result;
          stores[command.host] = new inventoryBindings[command.host]!(reopened.result);
        }
        const reads = await measureSqliteWrites(() => {
          const expected = [...model.values()].sort((a, b) => a.backend.localeCompare(b.backend));
          for (const store of stores) {
            expect(store.list()).toEqual(expected);
            const detached = store.list();
            if (detached[0]?.threads[0]) detached[0].threads[0].title = "reader mutation";
            expect(store.list()).toEqual(expected);
          }
        });
        expect([reads.writes.commits, reads.writes.statements, reads.writes.rowsChanged]).toEqual([0, 0, 0]);
      }
    } finally { for (const db of connections) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

function matches(row: AppServerThreadSummary, request: ThreadSearchProjectionSearchRequest): boolean {
  const filters = request.filters;
  return (!request.backend || row.source === request.backend)
    && (request.includeArchived || row.archivedAt === undefined)
    && (!request.query || row.title.startsWith(request.query))
    && (!request.identityKeys || request.identityKeys.includes(`${row.source}:${row.id}`))
    && (!filters?.models?.length || filters.models.includes(row.model!))
    && (!filters?.projectKeys?.length || filters.projectKeys.includes(row.projectKey!))
    && (!filters?.directoryIds?.length || row.linkedDirectories.some(d => filters.directoryIds!.includes(d.id)))
    && (!filters?.directoryPaths?.length || row.linkedDirectories.some(d => filters.directoryPaths!.some(p => p === d.path || p === d.worktreePath)))
    && (filters?.dateRange?.from === undefined || row.updatedAt! >= filters.dateRange.from)
    && (filters?.dateRange?.to === undefined || row.updatedAt! <= filters.dateRange.to);
}

// The provider's complete projections are the oracle. Refresh/prune/delete
// commands change that model; searches must report exactly its retained facts.
it("matches provider search facts, filters and pruning across hosts and reopens", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    operation: fc.constantFrom("upsert", "batch", "delete", "prune", "reopen"),
    backend: fc.integer({ min: 0, max: 1 }), host: fc.integer({ min: 0, max: 1 }),
    slot: fc.integer({ min: 0, max: 4 }), archived: fc.boolean(),
  }), { minLength: 1, maxLength: 25 }), async commands => {
    const fixture = createTempStateDb("shared-search-model-");
    const connections = searchBindings.map(() => StateDb.open(fixture.dbPath));
    const stores = connections.map((db, i) => new searchBindings[i]!(db));
    const model = new Map<string, AppServerThreadSummary>();
    try {
      for (const [revision, command] of commands.entries()) {
        const thread = summary(command.backend, command.slot, revision, command.archived);
        const store = stores[command.host]!;
        if (command.operation === "upsert" || command.operation === "batch") {
          const rows = command.operation === "batch"
            ? [thread, summary(1 - command.backend, command.slot, revision + 1, command.archived)] : [thread];
          const changed = rows.some(row => JSON.stringify(model.get(key(row))) !== JSON.stringify(row));
          const write = await measureSqliteWrites(() => store.upsertThreads(rows));
          expect(write.writes.commits).toBe(changed ? 1 : 0);
          for (const row of rows) model.set(key(row), row);
          const noOp = await measureSqliteWrites(() => store.upsertThreads(rows));
          expect(noOp.writes.commits).toBe(0);
        } else if (command.operation === "delete") {
          store.deleteThread({ backend: thread.source, threadId: thread.id });
          model.delete(key(thread));
        } else if (command.operation === "prune") {
          const retained = [...model.values()].filter(row => Number(row.id.slice(-1)) !== command.slot);
          store.pruneMissingThreads({ backend: thread.source, includeArchived: command.archived,
            retainedIdentityKeys: retained.map(row => `${row.source}:${row.id}`) });
          for (const [identity, row] of model) {
            if (row.source === thread.source && row.id === thread.id && (command.archived || row.archivedAt === undefined)) model.delete(identity);
          }
        } else {
          connections[command.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0);
          connections[command.host] = reopened.result;
          stores[command.host] = new searchBindings[command.host]!(reopened.result);
        }
        const reads = await measureSqliteWrites(() => {
          const filters = [undefined, { models: ["model-1"] }, { projectKeys: ["project-0"] },
            { directoryIds: ["dir-1"] }, { directoryPaths: ["/fixture/0", "/fixture/worktree/1"] },
            { dateRange: { from: 12, to: 22 } }];
          for (const observer of stores) {
            for (const filter of filters) {
              for (const query of [undefined, "Alpha", "Beta"]) {
                const request = { query, filters: filter, includeArchived: command.archived,
                  backend: command.backend === 0 ? undefined : backends[1], limit: 100 };
                const expected = [...model.values()].filter(row => matches(row, request));
                const actual = observer.search(request);
                expect(actual.map(row => `${row.backend}/${row.threadId}/${row.title}`).sort())
                  .toEqual(expected.map(row => `${row.source}/${row.id}/${row.title}`).sort());
                for (const row of actual) {
                  const original = model.get(JSON.stringify([row.backend, row.threadId]))!;
                  expect(row).toMatchObject({ title: original.title, titleSource: "explicit",
                    linkedDirectories: original.linkedDirectories, model: original.model,
                    projectKey: original.projectKey, updatedAt: original.updatedAt });
                }
              }
            }
            const identityRequest = { includeArchived: true, identityKeys: [`${thread.source}:${thread.id}`], limit: 100 };
            expect(observer.search(identityRequest).map(row => row.identityKey))
              .toEqual([...model.values()].filter(row => matches(row, identityRequest)).map(row => `${row.source}:${row.id}`));
          }
        });
        expect([reads.writes.commits, reads.writes.statements, reads.writes.rowsChanged]).toEqual([0, 0, 0]);
      }
    } finally { for (const db of connections) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("scrubs legacy inventory once and refuses unsupported or malformed provider rows", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 50 }), async secret => {
    const fixture = createTempStateDb("shared-inventory-legacy-");
    const db = StateDb.open(fixture.dbPath);
    try {
      const expected = summary(0, 0, 0);
      const insert = db.raw.prepare("INSERT INTO provider_thread_snapshots(backend, schema_version, observed_at, payload) VALUES (?, ?, ?, ?)");
      insert.run("codex", 1, 0, JSON.stringify([{ ...expected, summary: secret, privatePayload: secret }]));
      insert.run("unsupported-provider", 1, 0, "[]");
      insert.run("acp:invalid-version", 2, 0, "[]");
      insert.run("acp:invalid-json", 1, 0, "{");
      insert.run("acp:wrong-owner", 1, 0, JSON.stringify([expected]));
      insert.run("acp:not-array", 1, 0, "{}");
      const store = new SharedInventory(db);
      const scrub = await measureSqliteWrites(() => store.list());
      expect(scrub.result).toEqual([{ backend: "codex", observedAt: 0, threads: [expected] }]);
      expect(scrub.writes.commits).toBe(1);
      const repeat = await measureSqliteWrites(() => new DesktopInventory(db).list());
      expect(repeat.result).toEqual(scrub.result);
      expect(repeat.writes.commits).toBe(0);
      expect(JSON.parse(db.raw.prepare("SELECT payload FROM provider_thread_snapshots WHERE backend = 'codex'").pluck().get() as string))
        .toEqual([expected]);
    } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("rolls inventory and document/FTS writes back together on a generated deletion refusal", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 4 }), (backend, slot) => {
    const fixture = createTempStateDb("shared-inventory-rollback-");
    const db = StateDb.open(fixture.dbPath);
    const reader = StateDb.open(fixture.dbPath);
    try {
      const inventory = new SharedInventory(db);
      const search = new SharedSearch(db);
      const original = summary(backend, slot, 0);
      inventory.replace({ backend: original.source, observedAt: 0, threads: [original] });
      search.upsertThread(original);
      db.raw.exec("CREATE TEMP TRIGGER refuse_fixture_delete BEFORE DELETE ON main.thread_search_documents BEGIN SELECT RAISE(ABORT, 'fixture document refusal'); END");
      const changed = { ...original, title: "Rejected change" };
      expect(() => db.raw.transaction(() => {
        inventory.replace({ backend: original.source, observedAt: 1, threads: [changed] });
        search.deleteThread({ backend: original.source, threadId: original.id });
      }).immediate()).toThrow("fixture document refusal");
      expect(new DesktopInventory(reader).list()).toEqual([{ backend: original.source, observedAt: 0, threads: [original] }]);
      expect(new DesktopSearch(reader).search({ query: "Beta", limit: 10 })).toMatchObject([{ title: original.title }]);
      expect(new DesktopSearch(reader).search({ query: "Rejected", limit: 10 })).toEqual([]);
    } finally { reader.close(); db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});
