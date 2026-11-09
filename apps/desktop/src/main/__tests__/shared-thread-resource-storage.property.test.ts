import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadSandboxRecord } from "@pwragent/owner-core/mcp-connection-storage";
import { ThreadSandboxStore as SharedStore } from "@pwragent/sqlite-storage/thread-sandbox-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { ThreadSandboxStore as DesktopStore } from "../storage/thread-sandbox-store";
import { ThreadSandboxStore as CompatibilityStore } from "../state/thread-sandbox-store";
import { createThreadSandboxStorage } from "../storage/desktop-runtime-storage";
import { recordCreatedSandbox } from "../storage/desktop-mcp-connection-storage";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined,
  mode: null as "bootstrap" | "profile" | null, reads: 0 }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => {
  active.reads += 1;
  if (!active.db) throw new Error("No invented resource profile selected");
  return active.db;
}, getAppStateMode: () => active.mode }));
afterEach(() => { active.db = undefined; active.mode = null; active.reads = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const constructors = [SharedStore, DesktopStore, CompatibilityStore];
const host = fc.nat({ max: 2 });
const backend = fc.option(fc.constantFrom("codex", "claude", "fixture-provider"), { nil: undefined });
const names = ["invented", "' OR 1=1 --\0雪", "", "same:id"];
const key = (record: { connectionId: string; sandboxId: string }) => JSON.stringify([record.connectionId, record.sandboxId]);
const order = (records: ThreadSandboxRecord[]) => records.sort((a, b) => a.createdAt - b.createdAt || a.sandboxId.localeCompare(b.sandboxId));

it("routes the guarded gateway event through the shared implementation", () => {
  const db = openInMemoryStateDb();
  const observed = vi.spyOn(SharedStore.prototype, "recordCreated");
  try {
    active.db = db;
    fc.assert(fc.property(fc.constantFrom("bootstrap" as const, "profile" as const), fc.string({ maxLength: 20 }), (mode, name) => {
      active.mode = mode;
      const params = { connectionId: "invented", sandboxId: "event", threadId: name, now: 1 };
      observed.mockClear();
      recordCreatedSandbox(params);
      expect(observed).toHaveBeenCalledExactlyOnceWith(params);
    }));
  } finally { observed.mockRestore(); db.close(); }
});

// Observe the actual exported factories, rather than a parallel test factory.
// A retained cleanup port stays on its profile; the gateway selects at event time.
it("binds both actual construction paths to shared storage with the original guard and profile lifetime", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ selected: fc.nat({ max: 1 }),
    mode: fc.constantFrom("bootstrap" as const, "profile" as const, null),
  }), { minLength: 1, maxLength: 12 }), fc.string({ maxLength: 12 }), async (commands, name) => {
    const dbs = [openInMemoryStateDb(), openInMemoryStateDb()];
    const observed = vi.spyOn(SharedStore.prototype, "recordCreated");
    let calls = 0;
    try {
      active.db = dbs[0];
      const retained = createThreadSandboxStorage();
      expect(retained).toBeInstanceOf(SharedStore);
      expect(createThreadSandboxStorage()).not.toBe(retained);
      expect(DesktopStore).toBe(SharedStore);
      expect(CompatibilityStore).toBe(SharedStore);
      for (const [index, command] of commands.entries()) {
        active.db = dbs[command.selected]; active.mode = command.mode;
        const params = { connectionId: "invented", sandboxId: `resource-${index}`, threadId: "same-thread", name, now: index };
        const reads = active.reads;
        recordCreatedSandbox(params);
        if (command.mode) calls += 1;
        expect(observed).toHaveBeenCalledTimes(calls);
        expect(active.reads - reads).toBe(command.mode ? 1 : 0);
        expect(new SharedStore(dbs[command.selected]!.raw).all().some(row => row.sandboxId === params.sandboxId)).toBe(Boolean(command.mode));
        retained.recordCreated({ ...params, sandboxId: `retained-${index}` }); calls += 1;
        expect(observed).toHaveBeenCalledTimes(calls);
        expect(new SharedStore(dbs[0]!.raw).all().some(row => row.sandboxId === `retained-${index}`)).toBe(true);
        expect(new SharedStore(dbs[1]!.raw).all().some(row => row.sandboxId === `retained-${index}`)).toBe(false);
      }
      active.db = undefined; active.mode = null;
      expect(() => recordCreatedSandbox({ connectionId: "absent", sandboxId: "absent", threadId: "absent", now: 0 })).not.toThrow();
    } finally { observed.mockRestore(); dbs.forEach(db => db.close()); }
  }), { numRuns: 25 });
});

// Independent map model: resource identity is connection + id, its first
// creator owns it, and only an observed new creation can follow deletion.
it("models first ownership, cleanup, native grants, detached reads and exact writes across WAL and reopen", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host, backend,
    connection: fc.nat({ max: 1 }), resource: fc.nat({ max: 3 }), thread: fc.nat({ max: 1 }),
    kind: fc.constantFrom("create", "stop", "delete", "read"), name: fc.constantFrom(...names), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 30 }), async commands => {
    const fixture = createTempStateDb("shared-thread-resources-");
    const dbs = constructors.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new constructors[index]!(db.raw));
    const model = new Map<string, ThreadSandboxRecord>();
    try {
      for (const [index, op] of commands.entries()) {
        const params = { connectionId: names[op.connection]!, sandboxId: `resource-${op.resource}`,
          threadId: `thread-${op.thread}`, backend: op.backend, name: op.name, now: index };
        const id = key(params); const previous = model.get(id);
        const measured = await measureSqliteWrites(() => {
          if (op.kind === "create") {
            expect(stores[op.host]!.recordCreated(params)).toBe(!previous);
            if (!previous) model.set(id, { connectionId: params.connectionId, sandboxId: params.sandboxId,
              threadId: params.threadId, ...(op.backend ? { backend: op.backend } : {}), ...(op.name ? { name: op.name } : {}),
              status: "active", createdAt: index, updatedAt: index });
          } else if (op.kind === "stop") {
            stores[op.host]!.markOutcome({ ...params, status: "stopped", note: op.name });
            if (previous) model.set(id, { ...previous, status: "stopped", note: op.name || undefined, updatedAt: index });
          } else if (op.kind === "delete") {
            stores[op.host]!.markOutcome({ ...params, status: "deleted" }); model.delete(id);
          } else stores[op.host]!.all();
        });
        expect(measured.writes.commits).toBe(op.kind === "read" ? 0 : 1);
        expect(measured.writes.rowsChanged).toBe(op.kind === "read" ? 0 : op.kind === "create" ? Number(!previous) : Number(Boolean(previous)));
        if (op.reopen) {
          dbs[op.host]!.close();
          const opened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(opened.writes.commits).toBe(0);
          dbs[op.host] = opened.result; stores[op.host] = new constructors[op.host]!(opened.result.raw);
        }
        const reads = await measureSqliteWrites(() => {
          const expected = order([...model.values()]);
          for (const store of stores) {
            expect(store.all()).toEqual(expected);
            expect(store.threadIdsWithPending().sort()).toEqual([...new Set(expected.map(row => row.threadId))].sort());
            for (const provider of ["codex", "claude", "fixture-provider"]) for (const threadId of ["thread-0", "thread-1"]) {
              expect(store.pendingForThread({ backend: provider, threadId })).toEqual(expected.filter(row => row.threadId === threadId && (!row.backend || row.backend === provider)));
            }
            const detached = store.all(); if (detached[0]) detached[0].threadId = "must-not-persist";
            expect(store.all()).toEqual(expected);
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("keeps multi-resource changes atomic and invisible to WAL readers until commit, including statement refusal", async () => {
  await fc.assert(fc.asyncProperty(host, fc.constantFrom(...names), fc.boolean(), async (writer, name, refuse) => {
    const fixture = createTempStateDb("shared-thread-resource-rollback-");
    const dbs = constructors.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new constructors[index]!(db.raw));
    const initial = { connectionId: name, sandboxId: "old", threadId: "invented", now: 1 };
    try {
      stores[writer]!.recordCreated(initial);
      const before = stores[writer]!.all();
      const reader = stores[(writer + 1) % stores.length]!;
      if (refuse) dbs[writer]!.raw.exec("CREATE TRIGGER refuse_resource BEFORE INSERT ON thread_sandboxes WHEN NEW.sandbox_id = 'refused' BEGIN SELECT RAISE(ABORT, 'invented refusal'); END");
      expect(() => dbs[writer]!.raw.transaction(() => {
        stores[writer]!.markOutcome({ ...initial, status: "deleted" });
        stores[writer]!.recordCreated({ ...initial, sandboxId: "new" });
        expect(reader.all()).toEqual(before);
        if (refuse) stores[writer]!.recordCreated({ ...initial, sandboxId: "refused" });
        throw new Error("rollback");
      })()).toThrow(refuse ? "invented refusal" : "rollback");
      for (const store of stores) expect(store.all()).toEqual(before);
      dbs[writer]!.raw.transaction(() => {
        stores[writer]!.markOutcome({ ...initial, status: "stopped", now: 2 });
        stores[writer]!.recordCreated({ ...initial, sandboxId: "new", now: 3 });
        expect(reader.all()).toEqual(before);
      })();
      expect(reader.all()).toEqual([{ ...before[0]!, status: "stopped", updatedAt: 2 },
        { ...before[0]!, sandboxId: "new", createdAt: 3, updatedAt: 3 }]);
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// Old/unknown statuses are displayed as active by all(), but must never enter
// pending cleanup or be revived by a stale stop. Reading does not repair rows.
it("preserves legacy decode, pending filters and no-repair reads without granting cleanup ownership", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(host, fc.constantFrom("active", "stopped", "unknown", "deleted", ""),
    fc.option(fc.constantFrom(...names), { nil: null }), fc.option(fc.constantFrom(...names), { nil: null }), async (selected, status, storedBackend, name) => {
      const db = openInMemoryStateDb();
      try {
        db.raw.prepare("INSERT INTO thread_sandboxes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run("invented", "legacy", storedBackend, "thread", name, status, name, 1, 2);
        const store = new constructors[selected]!(db.raw);
        const snapshot = db.raw.prepare("SELECT * FROM thread_sandboxes").all();
        const read = await measureSqliteWrites(() => {
          const row = store.all()[0]!;
          expect(row).toEqual({ connectionId: "invented", sandboxId: "legacy", threadId: "thread",
            ...(storedBackend ? { backend: storedBackend } : {}), ...(name ? { name, note: name } : {}),
            status: status === "stopped" ? "stopped" : "active", createdAt: 1, updatedAt: 2 });
          expect(store.pendingForThread({ backend: "codex", threadId: "thread" })).toEqual(
            ["active", "stopped"].includes(status) && (storedBackend === null || storedBackend === "codex") ? [row] : []);
          expect(store.threadIdsWithPending()).toEqual(["active", "stopped"].includes(status) ? ["thread"] : []);
        });
        expect(read.writes.commits).toBe(0);
        expect(db.raw.prepare("SELECT * FROM thread_sandboxes").all()).toEqual(snapshot);
        const stopped = await measureSqliteWrites(() => store.markOutcome({ connectionId: "invented", sandboxId: "legacy", status: "stopped", now: 3 }));
        expect(stopped.writes.commits).toBe(1);
        expect(stopped.writes.rowsChanged).toBe(Number(["active", "stopped"].includes(status)));
        if (!["active", "stopped"].includes(status)) expect(db.raw.prepare("SELECT * FROM thread_sandboxes").all()).toEqual(snapshot);
        store.markOutcome({ connectionId: "invented", sandboxId: "legacy", status: "deleted", now: 4 });
        store.markOutcome({ connectionId: "invented", sandboxId: "legacy", status: "stopped", now: 5 });
        expect(store.all()).toEqual([]);
      } finally { db.close(); }
    }), { numRuns: 30 });
});
