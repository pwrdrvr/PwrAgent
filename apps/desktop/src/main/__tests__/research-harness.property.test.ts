import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { RESEARCH_HARNESS_REVISION, projectResearchRun, type ResearchHarnessRequest } from "@pwragent/shared";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { ResearchHarnessService, type ResearchHarnessConnection, type ResearchHarnessPorts } from "@pwragent/owner-core/research-harness-service";
import { ResearchService } from "@pwragent/owner-core/research-service";
import { normalizeHarnessRecords } from "@pwragent/owner-core/research-harness-records";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { harnessRecords } from "./fixtures/research-harness-records";
import { createTempStateDb } from "./sqlite-test-utils";

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
const services: ResearchHarnessService[] = [];
const actor = { backend: "codex", threadId: "coordinator", kind: "operator" } as const;
const request = (mode: "execute" | "import" = "execute"): ResearchHarnessRequest => ({ ...actor, requestId: randomUUID(), mode,
  objective: "Compare invented queue hypotheses", project: "fixture-project", session: "fixture-session", swarm: "fixture-swarm", workers: 2, minutes: 10, budgetAcknowledged: true });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

beforeEach(() => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1"); fixture = createTempStateDb("pwragent-harness-"); db = StateDb.open(fixture.dbPath); resetSqliteWriteMetrics();
});
afterEach(async () => { for (const service of services.splice(0)) await service.close(); db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function setup(options: { records?: unknown[]; execute?: () => Promise<unknown>; cancel?: (params: Record<string, unknown>) => Promise<unknown>; probe?: ResearchHarnessPorts["probe"] } = {}) {
  const store = new ResearchStore(db);
  let delivered = false;
  const connection: ResearchHarnessConnection = { close: vi.fn(), request: vi.fn(async (method, params) => {
    if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, execute: true, import: true, cancel: true, researchFunctions: true };
    if (method === "execute") return await (options.execute?.() ?? Promise.resolve({ admitted: true }));
    if (method === "cancel") return await (options.cancel?.(params) ?? Promise.resolve({ stopped: true, runId: params.runId, swarm: params.swarm }));
    if (method === "records") { const records = delivered ? [] : options.records ?? harnessRecords().slice(0, 4); delivered = true; return { swarm: "fixture-swarm", records }; }
    throw new Error("Unexpected request");
  }) };
  const ports: ResearchHarnessPorts = { ownerId: "owner", ownerPid: 42, ownerStartedAt: 100, changed: vi.fn(), now: () => 1000,
    schedule: () => () => {}, onError: vi.fn(), open: vi.fn(() => connection), probe: options.probe ?? vi.fn(async () => {}) };
  const service = new ResearchHarnessService(store, ports); services.push(service);
  return { service, store, connection, ports };
}

describe("Harness lifecycle and real SQLite oracle", () => {
  it.each(["import", "execute"] as const)("retains resumed source history without replaying %s work", async (mode) => {
    const records: unknown[] = [...harnessRecords(),
      { event: "resumed", swarm: "fixture-swarm", seq: 12, at_ms: 2000, calls: 12, members: ["m1"], deadline_at_ms: 2_000_000 },
      { event: "member", swarm: "fixture-swarm", seq: 13, at_ms: 2001, member: "m1", state: "running" }];
    const { service, connection } = setup({ records });
    const run = await service.start(request(mode), fixture.tempDir);
    expect(run.harness?.cursor).toBe(13);
    expect(run.harness?.state).toBe(mode === "import" ? "imported" : "unknown");
    expect(run.status).toBe("interrupted");
    expect(vi.mocked(connection.request).mock.calls.filter(([m]) => m === "execute")).toHaveLength(mode === "import" ? 0 : 1);
  });
  it("imports real-shaped records without dispatch or inherited source reviews, retaining unknown variants and provenance", async () => {
    const { service, store, connection, ports } = setup({ records: harnessRecords() });
    const measured = await measureSqliteWrites(() => service.start(request("import"), fixture.tempDir));
    const run = measured.result;
    expect(run.status).toBe("exhausted");
    expect(run.findings).toHaveLength(2);
    expect(run.submissions[0]?.review).toBeUndefined();
    expect(run.events.some((e) => e.data.type === "harness_observation" && e.data.event === "future_observation")).toBe(true);
    expect(run.events.find((e) => e.data.type === "finding")?.provenance).toMatchObject({ version: 1, project: "fixture-project", session: "fixture-session", swarm: "fixture-swarm", seq: 4, member: "m1" });
    expect(run).toEqual(projectResearchRun(run.id, run.events));
    expect(store.readItem(run.id, "h:7")?.record).toMatchObject({ text: "Release retained replies in insertion order." });
    expect(ports.probe).not.toHaveBeenCalled();
    expect(connection.request).not.toHaveBeenCalledWith("execute", expect.anything());
    expectSqliteWriteBudget({ scenario: "research-harness-import", note: "One intent, bridge admission, atomic source page/cursor and execution boundary; source verdict never creates a local review.", writes: measured.writes });
  });

  it("models admission, duplicate requests, lost cancellation, shutdown and recovery without replay", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("duplicate", "poll", "stop", "close"), { minLength: 1, maxLength: 12, size: "max" }), fc.boolean(), async (commands, confirmsStop) => {
      const { service, store, connection } = setup({ cancel: async (p) => confirmsStop ? { stopped: true, runId: p.runId, swarm: p.swarm } : { stopped: false } });
      const input = request();
      const run = await service.start(input, fixture.tempDir);
      const model = { execute: 1, cancels: 0, active: true, closed: false, status: "running" };
      for (const command of commands) {
        if (command === "duplicate") await service.start(input, fixture.tempDir);
        if (command === "poll") await service.poll(run.id);
        if (command === "stop" && !model.closed) {
          await service.stop(run.id, actor, "stopped", "Operator stop");
          if (model.active) { model.cancels++; model.active = false; model.status = confirmsStop ? "stopped" : "stopping"; }
        }
        if (command === "close") {
          await service.close(); model.closed = true;
          if (model.active) { model.active = false; model.status = "interrupted"; }
        }
        const methods = vi.mocked(connection.request).mock.calls.map(([method]) => method);
        expect(methods.filter((m) => m === "execute")).toHaveLength(model.execute);
        expect(methods.filter((m) => m === "cancel")).toHaveLength(model.cancels);
        expect(store.get(run.id)?.status).toBe(model.status);
      }
      // A new owner recovers the real journal, never the external model request.
      const native = new ResearchService(store, { ownerId: `recovery-${randomUUID()}`, ownerPid: 2, ownerStartedAt: 100, isOwnerAlive: () => false,
        spawn: vi.fn(async () => { throw new Error("Recovery must not dispatch"); }), stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}), changed: () => {}, schedule: () => () => {}, onError: () => {} });
      native.initialize(); native.close();
      expect(vi.mocked(connection.request).mock.calls.filter(([m]) => m === "execute")).toHaveLength(1);
      await service.close();
    }), { numRuns: 25 });
  });

  it("never retries a possibly admitted execution, including after process restart", async () => {
    const { service, store, connection } = setup({ execute: async () => { throw new Error("response lost after admission"); } });
    const input = request();
    const admitted = await measureSqliteWrites(() => service.start(input, fixture.tempDir));
    const run = admitted.result;
    expectSqliteWriteBudget({ scenario: "research-harness-unknown-start", note: "Persist intent before dispatch, then retain the ambiguous outcome without replay.", writes: admitted.writes });
    expect(run).toMatchObject({ status: "interrupted", harness: { state: "unknown" } });
    const duplicate = await measureSqliteWrites(() => service.start(input, fixture.tempDir));
    expect(duplicate.result.id).toBe(run.id);
    expectSqliteWriteBudget({ scenario: "research-harness-redelivery", note: "An ambiguous execution intent is read back without replay or writes.", writes: duplicate.writes });
    expect(vi.mocked(connection.request).mock.calls.filter(([m]) => m === "execute")).toHaveLength(1);
    expect(store.get(run.id)?.harness?.cursor).toBe(0);
  });

  it("fences a late successful compatibility probe after operator cancellation", async () => {
    const gate = deferred<void>();
    const { service, store, connection, ports } = setup({ probe: async () => await gate.promise });
    const starting = service.start(request(), fixture.tempDir);
    await vi.waitFor(() => expect(ports.open).toHaveBeenCalled());
    const id = store.list()[0]!.id;
    const stopped = await service.stop(id, actor, "stopped", "Stop while probing");
    expect(stopped.status).toBe("stopped");
    gate.resolve(); await starting;
    expect(vi.mocked(connection.request).mock.calls.map(([m]) => m)).not.toContain("execute");
    expect(store.get(id)?.status).toBe("stopped");
  });

  it("budgets probe refusal, unknown shutdown and recovery without idle persistence", async () => {
    const refused = setup({ probe: async () => { throw new Error("ordinary functions unavailable"); } });
    const failure = await measureSqliteWrites(() => refused.service.start(request(), fixture.tempDir));
    expect(failure.result.status).toBe("interrupted");
    expectSqliteWriteBudget({ scenario: "research-harness-probe-refusal", note: "Intent and unsupported/unknown capability boundary; no research execution is dispatched.", writes: failure.writes });
    const active = setup();
    const run = await active.service.start(request(), fixture.tempDir);
    const shutdown = await measureSqliteWrites(() => active.service.close());
    expectSqliteWriteBudget({ scenario: "research-harness-shutdown", note: "One durable unknown-outcome boundary before owned process cleanup; no remote stop is inferred.", writes: shutdown.writes });
    expect(active.store.get(run.id)?.status).toBe("interrupted");
  });

  it("a late records response cannot resurrect a confirmed stop", async () => {
    const { service, store, connection } = setup();
    const run = await service.start(request(), fixture.tempDir);
    const gate = deferred<unknown>();
    const original = connection.request;
    connection.request = vi.fn((method, params) => method === "records" ? gate.promise : original(method, params));
    const polling = service.poll(run.id);
    await service.stop(run.id, actor, "stopped", "Stop before records arrive");
    gate.resolve({ swarm: "fixture-swarm", records: harnessRecords().slice(4) }); await polling;
    expect(store.get(run.id)?.status).toBe("stopped");
    expect(store.get(run.id)?.harness?.cursor).toBe(4);
  });

  it("budgets one source page, empty polling, duplicate pages and confirmed cancellation", async () => {
    const { service, store, connection } = setup();
    const run = await service.start(request(), fixture.tempDir);
    const original = connection.request;
    connection.request = vi.fn((method, params) => method === "records" ? Promise.resolve({ swarm: "fixture-swarm", records: harnessRecords().slice(4, 10) }) : original(method, params));
    const page = await measureSqliteWrites(() => service.poll(run.id));
    expectSqliteWriteBudget({ scenario: "research-harness-page", note: "Six structured source records and the durable cursor share one commit; no per-token writes.", writes: page.writes });
    const idle = await measureSqliteWrites(async () => { for (let i = 0; i < 50; i++) await service.poll(run.id); });
    expectSqliteWriteBudget({ scenario: "research-harness-idle-and-duplicates", note: "Fifty repeated service pages add no writes and cannot replace local review records.", writes: idle.writes });
    const stopped = await measureSqliteWrites(() => service.stop(run.id, actor, "stopped", "Operator stop"));
    expect(stopped.result.status).toBe("stopped");
    expectSqliteWriteBudget({ scenario: "research-harness-cancel", note: "One cancellation intent and one scoped terminal acknowledgement, with member settlement.", writes: stopped.writes });
    expect(store.get(run.id)?.harness?.cursor).toBe(10);
  });

  it("rejects reordered, conflicting, foreign and escaping evidence pages atomically", async () => {
    const { service, store } = setup();
    const run = await service.start(request(), fixture.tempDir);
    await fc.assert(fc.asyncProperty(fc.constantFrom("gap", "conflict", "foreign", "escape"), fc.string({ minLength: 1, maxLength: 20 }), async (kind, suffix) => {
      const next = harnessRecords()[5]!;
      const records = kind === "gap" ? [next] : kind === "conflict" ? [{ ...harnessRecords()[3], text: `changed-${suffix}` }]
        : kind === "foreign" ? [{ ...next, seq: 5, swarm: `foreign-${suffix}` }]
          : [{ ...next, seq: 5, paths: [`../${suffix}`] }];
      const before = store.get(run.id)!;
      expect(() => normalizeHarnessRecords(before, records)).toThrow();
      expect(store.get(run.id)).toEqual(before);
    }), { numRuns: 25 });
    expect(normalizeHarnessRecords(run, harnessRecords().slice(0, 4)).events).toEqual([]);
  });

  it("does not commit a page whose continuation cursor lies about the observed prefix", async () => {
    const { service, store, connection } = setup();
    const run = await service.start(request(), fixture.tempDir);
    connection.request = async () => ({ swarm: "fixture-swarm", records: harnessRecords().slice(4, 10), next: 999 });
    await service.poll(run.id);
    expect(store.get(run.id)).toMatchObject({ status: "interrupted", harness: { cursor: 4, state: "unknown" } });
    expect(store.get(run.id)?.findings).toHaveLength(1);
  });
});
