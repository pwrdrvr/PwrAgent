import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { RESEARCH_HARNESS_REVISION, type ResearchHarnessRequest } from "@pwragent/shared";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { ResearchHarnessService, type ResearchHarnessConnection, type ResearchHarnessPorts } from "@pwragent/owner-core/research-harness-service";
import { ResearchService } from "@pwragent/owner-core/research-service";
import { harnessRecordDigest } from "@pwragent/owner-core/research-harness-records";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { harnessRecords } from "./fixtures/research-harness-records";
import { createTempStateDb } from "./sqlite-test-utils";

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
const services: ResearchHarnessService[] = [];
const actor = { backend: "codex", threadId: "coordinator", kind: "operator" } as const;
const RECORDS = harnessRecords();
const ENDED = RECORDS.length;
const request = (mode: "execute" | "import" = "execute", source: "swarm" | "discovery" = "swarm"): ResearchHarnessRequest => ({ ...actor, requestId: randomUUID(), mode, source,
  objective: "Compare invented queue hypotheses", project: "fixture-project", session: "fixture-session", swarm: "fixture-swarm", workers: 2, minutes: 10, budgetAcknowledged: mode === "execute" });

beforeEach(() => { vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1"); fixture = createTempStateDb("pwragent-harness-reconcile-"); db = StateDb.open(fixture.dbPath); resetSqliteWriteMetrics(); });
afterEach(async () => { running.clear(); for (const service of services.splice(0)) await service.close(); db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

/**
 * The source as the bridge contract describes it: records after a cursor, at
 * most `page` at a time, with `next` naming the last returned sequence when
 * more remain. `visible` is how far the source has progressed.
 */
function source(options: { page: number; visible: number; cancel?: "confirmed" | "lost"; failRecords?: () => boolean; capabilities?: Record<string, boolean> }) {
  const state = { visible: options.visible };
  const connections: Array<{ mode: string; connection: ResearchHarnessConnection }> = [];
  const methods: string[] = [];
  const open = vi.fn((_workspace: string, _id: string, mode: "import" | "execute") => {
    const connection: ResearchHarnessConnection = { close: vi.fn(), request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      methods.push(method);
      if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, execute: true, cancel: true, researchFunctions: true, discovery: true, ...options.capabilities };
      if (method === "execute") return { admitted: true };
      if (method === "cancel") return options.cancel === "lost" ? { stopped: false } : { stopped: true, runId: params.runId, swarm: params.swarm };
      if (method === "records") {
        if (options.failRecords?.()) throw new Error("bridge exited before replying");
        const after = params.after as number;
        const records = RECORDS.slice(after, Math.min(state.visible, after + options.page));
        const last = records.at(-1)?.seq;
        return { swarm: "fixture-swarm", records, ...(last !== undefined && last < state.visible ? { next: last } : {}) };
      }
      throw new Error(`Unexpected ${method}`);
    }) };
    connections.push({ mode, connection });
    return connection;
  });
  return { state, connections, methods, open };
}

/** Processes on this profile that are still running. A test ends one by removing it. */
const running = new Set<string>();
function setup(oracle: ReturnType<typeof source>, ownerId = "owner") {
  const store = new ResearchStore(db);
  running.add(ownerId);
  const ports: ResearchHarnessPorts = { ownerId, ownerPid: 42, ownerStartedAt: 100, isOwnerAlive: (owner) => running.has(owner.ownerId), changed: vi.fn(), now: () => 1000,
    schedule: () => () => {}, onError: vi.fn(), open: oracle.open, probe: vi.fn(async () => {}) };
  const service = new ResearchHarnessService(store, ports); services.push(service);
  return { service, store, ports };
}

describe("Harness reconcile and bridge check over real SQLite", () => {
  it("reconciles an unknown outcome read-only into the same run, never resending execute or cancel", async () => {
    const scenario = fc.record({ visible: fc.integer({ min: 1, max: ENDED - 1 }), page: fc.integer({ min: 1, max: 6 }), total: fc.integer({ min: 1, max: ENDED }),
      cause: fc.constantFrom<"lost-cancel" | "lost-records">("lost-cancel", "lost-records") }).filter((s) => s.total >= Math.min(s.visible, s.page));
    await fc.assert(fc.asyncProperty(scenario, async ({ visible, page, total, cause }) => {
      let failing = false;
      const oracle = source({ page, visible, cancel: cause === "lost-cancel" ? "lost" : "confirmed", failRecords: () => failing });
      const { service, store } = setup(oracle);
      const run = await service.start(request(), fixture.tempDir);
      const admitted = Math.min(visible, page);
      expect(store.header(run.id)?.harness?.cursor).toBe(admitted);
      if (cause === "lost-cancel") await service.stop(run.id, actor, "stopped", "Operator stop");
      else { failing = true; await service.poll(run.id); failing = false; }
      const before = store.header(run.id)!;
      expect(before.harness?.state).toBe("unknown");
      expect(before.status).toBe(cause === "lost-cancel" ? "stopping" : "interrupted");
      // The pending stop is part of the source state, so it survives a restart rewriting the run's status.
      expect(before.harness?.unresolved).toBe(cause === "lost-cancel" ? "cancel" : undefined);

      oracle.state.visible = Math.max(total, admitted);
      const after = await service.reconcile(run.id, actor);
      const read = Math.max(total, admitted);
      // Every record the source now has arrives once, with its own digest, in order.
      expect(after.harness?.cursor).toBe(read);
      for (const record of RECORDS.slice(0, read)) expect(store.harnessRecord(run.id, record.seq)?.provenance?.digest).toBe(harnessRecordDigest(record));
      expect(store.harnessRecord(run.id, read + 1)).toBeUndefined();
      // Reconciling opens a read-only connection and sends nothing that could start or stop work.
      expect(oracle.connections.at(-1)?.mode).toBe("import");
      expect(oracle.methods.filter((m) => m === "execute")).toHaveLength(1);
      expect(oracle.methods.filter((m) => m === "cancel")).toHaveLength(cause === "lost-cancel" ? 1 : 0);
      // Only the source's own terminal record settles the outcome; a lost reply alone never does.
      const ended = read === ENDED;
      expect(after.harness?.state).toBe(ended ? "ended" : "unknown");
      expect(after.status).toBe(ended && cause === "lost-cancel" ? "stopped" : before.status);
      expect(after.harness?.unresolved).toBe(!ended && cause === "lost-cancel" ? "cancel" : undefined);
      expect(after.harness?.observedAt).toBe(1000);
      if (ended) await expect(service.reconcile(run.id, actor)).rejects.toThrow("no unresolved source outcome");
      await service.close();
    }), { numRuns: 40, examples: [[{ visible: 4, page: 50, total: ENDED, cause: "lost-cancel" }], [{ visible: 3, page: 2, total: 6, cause: "lost-records" }]] });
  });

  /**
   * A process that dies writes no unknown boundary. The next launch retires the run as interrupted, but its
   * last Harness state still says running. That run's outcome is unknown, so the operator must be able to
   * reconcile it, and reconciling still never starts or stops anything.
   */
  it("reconciles a run whose owner died mid-execution, without resending anything", async () => {
    const oracle = source({ page: 50, visible: 4 });
    const dead = setup(oracle, "owner-that-dies");
    const run = await dead.service.start(request(), fixture.tempDir);
    expect(dead.store.header(run.id)).toMatchObject({ status: "running", harness: { state: "running", cursor: 4 } });
    running.delete("owner-that-dies");
    const recovery = new ResearchService(dead.store, { ownerId: "next-launch", ownerPid: 2, ownerStartedAt: 200, isOwnerAlive: (owner) => running.has(owner.ownerId),
      spawn: async () => { throw new Error("Recovery must not dispatch"); }, stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}),
      changed: () => {}, schedule: () => () => {}, onError: () => {} });
    recovery.initialize(); recovery.close();
    expect(dead.store.header(run.id)).toMatchObject({ status: "interrupted", harness: { state: "running" } });

    const next = setup(oracle, "next-launch");
    oracle.state.visible = ENDED;
    const after = await next.service.reconcile(run.id, actor);
    expect(after.harness).toMatchObject({ state: "ended", cursor: ENDED });
    expect(oracle.connections.at(-1)?.mode).toBe("import");
    expect(oracle.methods.filter((m) => m === "execute")).toHaveLength(1);
    expect(oracle.methods).not.toContain("cancel");
  });

  it("budgets one reconcile: intent, one page with its cursor, and the result", async () => {
    let failing = false;
    const oracle = source({ page: 50, visible: 4, failRecords: () => failing });
    const { service, store } = setup(oracle);
    const run = await service.start(request(), fixture.tempDir);
    failing = true; await service.poll(run.id); failing = false;
    oracle.state.visible = ENDED;
    const measured = await measureSqliteWrites(() => service.reconcile(run.id, actor));
    expect(measured.result.harness?.state).toBe("ended");
    expect(store.header(run.id)?.harness?.cursor).toBe(ENDED);
    expectSqliteWriteBudget({ scenario: "research-harness-reconcile", note: "Reconcile intent, one seven-record source page with its cursor, and the settled outcome. Read-only; no execute or cancel.", writes: measured.writes });
  });

  it("imports newer records into a retained import without stopping or owning source work", async () => {
    const oracle = source({ page: 50, visible: 4 });
    const { service, store } = setup(oracle);
    const run = await service.start(request("import"), fixture.tempDir);
    expect(store.header(run.id)?.harness).toMatchObject({ state: "imported", cursor: 4, observedAt: 1000 });
    oracle.state.visible = 8;
    const after = await service.reconcile(run.id, actor);
    expect(after.harness).toMatchObject({ state: "imported", cursor: 8 });
    expect(after.harness?.note).toMatch(/^Imported 4 records \(#5–#8\)\./);
    expect(after.status).toBe("interrupted");
    expect(oracle.methods).not.toContain("execute");
    expect(oracle.methods).not.toContain("cancel");
  });

  it("refuses reconcile where it could race an owner or has nothing to resolve", async () => {
    const oracle = source({ page: 50, visible: 4 });
    const { service, store } = setup(oracle);
    const live = await service.start(request(), fixture.tempDir);
    expect(store.header(live.id)?.harness?.state).toBe("running");
    await expect(service.reconcile(live.id, actor)).rejects.toThrow("no unresolved source outcome");
    const snapshot = await service.start(request("import", "discovery"), fixture.tempDir).catch(() => undefined);
    if (snapshot) await expect(service.reconcile(snapshot.id, actor)).rejects.toThrow("discovery snapshot");
    const imported = await service.start(request("import"), fixture.tempDir);
    await expect(service.reconcile(imported.id, { ...actor, threadId: "someone-else" })).rejects.toThrow("Only the coordinating thread");
    // Another live process's run that it is still stopping.
    const other = setup(source({ page: 50, visible: 4, cancel: "lost" }), "other-owner");
    const foreign = await other.service.start(request(), fixture.tempDir);
    await other.service.stop(foreign.id, actor, "stopped", "Stop");
    expect(store.header(foreign.id)).toMatchObject({ status: "stopping", harness: { state: "unknown" } });
    await expect(service.reconcile(foreign.id, actor)).rejects.toThrow("Another running PwrAgent process owns this run");
    // Once that process is gone and recovery has retired its run, this one may reconcile it.
    running.delete("other-owner");
    await other.service.close();
    // Still marked stopping: only recovery may retire another process's live run.
    expect(store.header(foreign.id)?.status).toBe("stopping");
    await expect(service.reconcile(foreign.id, actor)).rejects.toThrow("Another running PwrAgent process owns this run");
    const recovery = new ResearchService(store, { ownerId: "owner", ownerPid: 42, ownerStartedAt: 100, isOwnerAlive: (owner) => running.has(owner.ownerId),
      spawn: async () => { throw new Error("Recovery must not dispatch"); }, stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}),
      changed: () => {}, schedule: () => () => {}, onError: () => {} });
    recovery.initialize(); recovery.close();
    await expect(service.reconcile(foreign.id, actor)).resolves.toMatchObject({ status: "interrupted", harness: { state: "unknown" } });
  });

  it("restores the prior outcome when the bridge fails mid-reconcile, keeping records already read", async () => {
    let calls = 0;
    const oracle = source({ page: 2, visible: 4, failRecords: () => ++calls > 3 });
    const { service, store, ports } = setup(oracle);
    const run = await service.start(request(), fixture.tempDir);
    calls = 100; await service.poll(run.id);
    expect(store.header(run.id)?.harness?.state).toBe("unknown");
    calls = 1; oracle.state.visible = ENDED;
    const after = await service.reconcile(run.id, actor);
    expect(after.harness?.state).toBe("unknown");
    expect(after.harness?.cursor).toBe(6);
    expect(after.harness?.note).toMatch(/^Reconcile stopped: bridge exited before replying\. Records read before it stopped are kept\./);
    expect(ports.onError).toHaveBeenCalled();
    expect(oracle.methods.filter((m) => m === "execute")).toHaveLength(1);
  });

  it("checks the bridge's capabilities with hello only and writes nothing", async () => {
    const oracle = source({ page: 50, visible: 0, capabilities: { execute: false, discovery: false } });
    const { service, store } = setup(oracle);
    const measured = await measureSqliteWrites(() => service.check(fixture.tempDir));
    expect(measured.result).toEqual({ ok: true, checkedAt: 1000, capabilities: { import: true, execute: false, cancel: true, discovery: false, researchFunctions: true } });
    expect(oracle.methods).toEqual(["hello"]);
    expect(oracle.connections[0]!.mode).toBe("import");
    await vi.waitFor(() => expect(oracle.connections[0]!.connection.close).toHaveBeenCalled());
    expect(store.activeRuns()).toHaveLength(0);
    expectSqliteWriteBudget({ scenario: "research-harness-check", note: "A bridge capability check sends hello only and records nothing.", writes: measured.writes });
    const failing = setup({ ...oracle, open: vi.fn(() => { throw new Error("Configure research.harness in this profile's config.toml"); }) });
    await expect(failing.service.check(fixture.tempDir)).resolves.toEqual({ ok: false, checkedAt: 1000, error: "Configure research.harness in this profile's config.toml" });
  });

  it("admits an import without a budget acknowledgement but never an execution", async () => {
    const oracle = source({ page: 50, visible: 4 });
    const { service } = setup(oracle);
    await expect(service.start({ ...request("import"), budgetAcknowledged: false }, fixture.tempDir)).resolves.toMatchObject({ harness: { state: "imported" } });
    await expect(service.start({ ...request("execute"), budgetAcknowledged: false }, fixture.tempDir)).rejects.toThrow("Acknowledge unknown token/dollar usage");
    expect(oracle.methods.filter((m) => m === "execute")).toHaveLength(0);
  });
});
