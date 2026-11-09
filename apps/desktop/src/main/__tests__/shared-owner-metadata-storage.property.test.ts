import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { OwnerThreadMetadataPatch, OwnerThreadRecord } from "@pwragent/owner-core/thread-storage";
import type { ThreadDependency } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore as PortableOverlay } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ThreadDependencyStore as PortableDependencies } from "@pwragent/sqlite-storage/thread-dependency-store";
import { SqliteOverlayStore as DesktopOverlay } from "../storage/overlay-store-sqlite";
import { SqliteOverlayStore as StateOverlay } from "../state/overlay-store-sqlite";
import { ThreadDependencyStore as StateDependencies } from "../state/thread-dependency-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const bindings = [PortableOverlay, DesktopOverlay, StateOverlay];
const backends = ["codex", "claude", "acp:kimi"] as const;
const identity = (index: number) => ({ backend: backends[index % 3]!, threadId: `thread:${index % 2}` });
afterEach(() => vi.unstubAllEnvs());

it("binds every desktop owner metadata entry point to one portable implementation", () => {
  fc.assert(fc.property(fc.constantFrom("desktop", "state", "dependencies"), entry => {
    if (entry === "desktop") expect(DesktopOverlay).toBe(PortableOverlay);
    if (entry === "state") expect(StateOverlay).toBe(PortableOverlay);
    if (entry === "dependencies") expect(StateDependencies).toBe(PortableDependencies);
  }));
});

// Owner facts merge into the latest row. Null removes, absence preserves,
// backend-qualified identities never collide, and host-private data survives.
it("matches an independent metadata model across WAL hosts and arbitrary reopen order", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const nullable = <T>(value: fc.Arbitrary<T>) => fc.oneof(fc.constant(undefined), fc.constant(null), value);
  const patches: fc.Arbitrary<OwnerThreadMetadataPatch> = fc.record({
    title: nullable(fc.record({ text: fc.string({ maxLength: 20 }), source: fc.constantFrom("explicit" as const, "derived" as const) })),
    pinnedRank: nullable(fc.integer({ min: 1, max: 10 }).map(String)),
    seenAt: nullable(fc.nat({ max: 10000 })), seenUpdatedAt: nullable(fc.nat({ max: 10000 })),
    parent: nullable(fc.record({ backend: fc.constantFrom(...backends), threadId: fc.string({ maxLength: 12 }), instanceId: fc.string({ maxLength: 12 }) })),
    model: nullable(fc.string({ maxLength: 20 })), fastMode: nullable(fc.boolean()),
    executionMode: nullable(fc.constantFrom("default" as const, "auto" as const)),
    subthreadOrder: nullable(fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 })),
    archived: nullable(fc.boolean()),
  });
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    actor: fc.integer({ min: 0, max: 5 }), host: fc.integer({ min: 0, max: 2 }), patch: patches, reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 20 }), async commands => {
    const fixture = createTempStateDb("portable-owner-model-");
    const connections = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = connections.map((db, index) => new bindings[index]!(db));
    const model = new Map<number, OwnerThreadRecord>();
    try {
      for (let index = 0; index < 6; index++) {
        await stores[0]!.setThreadTokenMiser({ ...identity(index), enabled: true });
        model.set(index, { ...identity(index), executionMode: "default" });
      }
      for (const command of commands) {
        const expected = structuredClone(model.get(command.actor)!);
        for (const [field, value] of Object.entries(command.patch)) {
          if (value === null) Reflect.deleteProperty(expected, field);
          else if (value !== undefined) Reflect.set(expected, field, structuredClone(value));
        }
        expected.executionMode ??= "default";
        model.set(command.actor, expected);
        const input = structuredClone(command.patch);
        const result = await stores[command.host]!.updateThreadMetadata(identity(command.actor), input);
        expect(result).toEqual(expected);
        if (input.title) input.title.text = "mutated input";
        result.subthreadOrder?.push("mutated result");
        result.title = { text: "mutated result", source: "explicit" };
        const noOp = await measureSqliteWrites(() => stores[command.host]!.updateThreadMetadata(identity(command.actor), expected));
        expect(noOp.writes.commits).toBe(0);
        if (command.reopen) {
          connections[command.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0);
          connections[command.host] = reopened.result;
          stores[command.host] = new bindings[command.host]!(reopened.result);
        }
        const reads = await measureSqliteWrites(async () => {
          const sorted = (rows: OwnerThreadRecord[]) => rows.sort((a, b) => JSON.stringify([a.backend, a.threadId]).localeCompare(JSON.stringify([b.backend, b.threadId])));
          for (const store of stores) {
            expect(sorted(await store.listThreadMetadata())).toEqual(sorted([...model.values()]));
            for (let index = 0; index < 6; index++) {
              expect(await store.getThreadMetadata(identity(index))).toEqual(model.get(index));
              expect((await store.getThreadOverlayState(identity(index)))?.tokenMiserEnabled).toBe(true);
            }
          }
        });
        expect([reads.writes.commits, reads.writes.statements, reads.writes.rowsChanged]).toEqual([0, 0, 0]);
      }
    } finally { connections.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// Pin moves preserve a single global order across providers. Resolve each
// move against the owner's current rows, including a change by another host.
it("matches an ordered-list pin model across alternating owner connections", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    actor: fc.integer({ min: 0, max: 5 }), host: fc.integer({ min: 0, max: 2 }), down: fc.boolean(),
  }), { minLength: 1, maxLength: 30 }), async commands => {
    const fixture = createTempStateDb("portable-pin-model-");
    const connections = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = connections.map((db, index) => new bindings[index]!(db));
    const keys = Array.from({ length: 6 }, (_, index) => `${identity(index).backend}:${identity(index).threadId}`);
    const order = [...keys];
    try {
      await stores[0]!.reorderThreadPins({ threadKeys: keys });
      for (const command of commands) {
        const key = keys[command.actor]!;
        const position = order.indexOf(key);
        const destination = position + (command.down ? 1 : -1);
        if (destination >= 0 && destination < order.length) [order[position], order[destination]] = [order[destination]!, order[position]!];
        await stores[command.host]!.reorderThreadPins({ move: { key, direction: command.down ? "down" : "up" } });
        for (const store of stores) {
          const rows = await store.listThreadMetadata();
          rows.sort((a, b) => Number(a.pinnedRank) - Number(b.pinnedRank));
          expect(rows.map(row => `${row.backend}:${row.threadId}`)).toEqual(order);
        }
      }
    } finally { connections.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// A dependency graph admits only acyclic local edges. Duplicate registration
// is idempotent; compare-and-swap allows only one competing dispatch claim.
it("matches a graph oracle and arbitrates dependency claims across WAL hosts", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 })),
    { minLength: 1, maxLength: 20 }), async edges => {
    const fixture = createTempStateDb("portable-dependency-model-");
    const left = StateDb.open(fixture.dbPath);
    const right = StateDb.open(fixture.dbPath);
    const stores = [new PortableDependencies(left.raw), new StateDependencies(right.raw)];
    const graph = new Map<number, Set<number>>();
    const records = new Map<string, ThreadDependency>();
    try {
      for (const [from, to] of edges) {
        const reaches = (node: number, seen = new Set<number>()): boolean => {
          if (node === from) return true;
          if (seen.has(node)) return false;
          seen.add(node);
          return [...(graph.get(node) ?? [])].some(next => reaches(next, seen));
        };
        const candidate: ThreadDependency = { ...identity(from), id: `edge-${from}-${to}`, status: "waiting", mode: "all",
          onFailure: "notify", createdAt: records.size + 1, updatedAt: 1, evidence: [],
          conditions: [{ ...identity(to), when: "marked_done" }] };
        const store = stores[records.size % 2]!;
        if (reaches(to)) expect(() => store.register(candidate)).toThrow("cycle");
        else {
          if (!records.has(candidate.id)) {
            const targets = graph.get(from) ?? new Set<number>();
            targets.add(to); graph.set(from, targets); records.set(candidate.id, candidate);
          }
          expect(store.register(candidate)).toEqual(records.get(candidate.id));
        }
        for (const observer of stores) expect(observer.active().map(row => row.id).sort()).toEqual([...records.keys()].sort());
      }
      for (const record of records.values()) {
        const next = { ...record, status: "dispatching" as const };
        expect(stores[0]!.replace(record, next)).toBe(true);
        expect(stores[1]!.replace(record, { ...next, error: "competing claim" })).toBe(false);
      }
    } finally { left.close(); right.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// Live output is process-local and read-only until its existing boundary
// flush. The boundary writes once regardless of the number of snapshots.
it("retains live tails without streaming writes and flushes once for the next host", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.string({ maxLength: 30 }), { minLength: 1, maxLength: 40 }), async outputs => {
    const fixture = createTempStateDb("portable-live-tail-");
    const left = StateDb.open(fixture.dbPath);
    const right = StateDb.open(fixture.dbPath);
    const writer = new PortableOverlay(left);
    const reader = new DesktopOverlay(right);
    const target = identity(0);
    const read = async (store: PortableOverlay) => (await store.getThreadOverlayState(target))?.codexEnvironmentRuntime?.actionRuns?.[0]?.output;
    try {
      await writer.setThreadCodexEnvironmentRuntime({ ...target, codexEnvironmentRuntime: { executionTarget: "local", actionRuns: [
        { runId: "run", actionId: "fixture", actionName: "Fixture", command: "fixture", startedAt: 1, status: "started", output: "stored" },
      ] } });
      const streamed = await measureSqliteWrites(async () => {
        for (const output of outputs) {
          writer.setThreadCodexEnvironmentActionLiveOutput({ ...target, runId: "run", output });
          expect(await read(writer)).toBe(output);
          expect(await read(reader)).toBe("stored");
        }
      });
      expect([streamed.writes.commits, streamed.writes.statements, streamed.writes.rowsChanged]).toEqual([0, 0, 0]);
      const flushed = await measureSqliteWrites(() => writer.flushThreadCodexEnvironmentActionLiveOutputs());
      expect(flushed.result).toBe(outputs.at(-1) === "stored" ? 0 : 1);
      expect(flushed.writes.commits).toBe(flushed.result);
      expect(await read(reader)).toBe(outputs.at(-1));
      const again = await measureSqliteWrites(() => writer.flushThreadCodexEnvironmentActionLiveOutputs());
      expect(again.result).toBe(0); expect(again.writes.commits).toBe(0);
    } finally { left.close(); right.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("rolls metadata and dependency changes back together at the original transaction boundary", async () => {
  const fixture = createTempStateDb("portable-owner-rollback-");
  const db = StateDb.open(fixture.dbPath);
  const reader = StateDb.open(fixture.dbPath);
  const store = new PortableOverlay(db);
  try {
    await store.updateThreadMetadata(identity(0), { title: { text: "Before", source: "explicit" } });
    // Async store methods execute their SQLite mutation synchronously, as
    // they do at production caller-owned immediate transaction sites.
    let mutation: Promise<OwnerThreadRecord> | undefined;
    expect(() => db.raw.transaction(() => {
      mutation = store.updateThreadMetadata(identity(0), { title: { text: "Rolled back", source: "derived" } });
      new PortableDependencies(db.raw).register({ ...identity(0), id: "rollback", status: "waiting", mode: "all", onFailure: "notify",
        createdAt: 1, updatedAt: 1, evidence: [], conditions: [{ ...identity(1), when: "marked_done" }] });
      throw new Error("rollback oracle");
    }).immediate()).toThrow("rollback oracle");
    await mutation;
    expect((await new DesktopOverlay(reader).getThreadMetadata(identity(0)))?.title).toEqual({ text: "Before", source: "explicit" });
    expect(new StateDependencies(reader.raw).active()).toEqual([]);
  } finally { db.close(); reader.close(); removeTempStateDbDir(fixture.tempDir); }
});
