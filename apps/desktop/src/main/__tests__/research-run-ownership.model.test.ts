import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { RESEARCH_HARNESS_REVISION, type ResearchEvent, type ResearchHarnessState, type ResearchRun } from "@pwragent/shared";
import { ResearchService } from "@pwragent/owner-core/research-service";
import { ResearchHarnessService } from "@pwragent/owner-core/research-harness-service";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

beforeEach(() => { vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1"); resetSqliteWriteMetrics(); });
afterEach(() => vi.unstubAllEnvs());

const ME = "this-process";
const thread = { backend: "codex", threadId: "coordinator" } as const;
const operator = { ...thread, kind: "operator" } as const;
type Owner = "me" | "dead" | "live-other";
type Source = "native" | "harness-imported" | "harness-ended";
type Scenario = { source: Source; owner: Owner; retired: boolean };

/**
 * A run with one candidate, as an earlier process left it: still marked running
 * (it never got to say otherwise), or already retired as interrupted.
 */
function seed(store: ResearchStore, id: string, scenario: Scenario) {
  const ownerId = scenario.owner === "me" ? ME : scenario.owner;
  const harness: ResearchHarnessState | undefined = scenario.source === "native" ? undefined : { version: 1, mode: scenario.source === "harness-imported" ? "import" : "execute",
    project: "p", session: "s", swarm: "w", workspace: "/w", upstreamRevision: RESEARCH_HARNESS_REVISION, cursor: 3, members: ["m1"], cancelSupported: true, note: "",
    // A Harness run that is still live has not settled; a retired one here ended or was imported.
    state: scenario.retired ? scenario.source === "harness-imported" ? "imported" : "ended" : "running" };
  const events: ResearchEvent[] = [];
  const add = (data: ResearchEvent["data"]) => events.push({ seq: events.length + 1, at: 1000 + events.length, commandId: `seed:${events.length}`, signature: "seed", actor: operator, data });
  add({ type: "created", objective: "Invented objective", coordinator: thread, ownerId, ownerPid: 7, ownerStartedAt: 100, deadlineAt: 10_000_000_000_000, workspaceMode: "none",
    approaches: [{ id: "a1", title: "Approach", task: "Task", state: "ended" }], ...(harness ? { harness } : {}) });
  add({ type: "submission", submission: { id: "s1", approachId: "a1", text: "Invented candidate", paths: [] } });
  if (scenario.retired) add({ type: "status", status: "interrupted", reason: "The owning process ended." });
  store.create(id, id, events[0]!);
  store.appendBatch(id, 1, events.slice(1));
}

/** This process, started after the runs were written. */
function launch(store: ResearchStore) {
  const identity = { ownerId: ME, ownerPid: 99, ownerStartedAt: 500,
    isOwnerAlive: (owner: Pick<ResearchRun, "ownerId">) => owner.ownerId === ME || owner.ownerId === "live-other" };
  const harness = new ResearchHarnessService(store, { ...identity, changed: () => {}, schedule: () => () => {}, onError: () => {},
    open: () => { throw new Error("A record on a retained run must not start the bridge"); }, probe: async () => { throw new Error("A record must not probe a model"); } });
  const service = new ResearchService(store, { ...identity, spawn: async () => { throw new Error("A record must not dispatch a worker"); }, stop: async () => {},
    notify: async () => ({}), cancelQueued: async () => ({}), changed: () => {}, schedule: () => () => {}, onError: () => {},
    stopHarness: (id, actor, outcome, reason) => harness.stop(id, actor, outcome, reason) });
  service.initialize();
  return { service, close: async () => { service.close(); await harness.close(); } };
}

/**
 * Who may record a decision on a run is a rule about processes, and a restart
 * changes the process. The run's own process may always record. So may a later
 * process once the run is no longer live and the process that started it is
 * gone: nobody else can, and the operator and coordinating thread are the same.
 * A different process that is still running keeps its runs.
 */
it("lets this process review and finish a retained run once its owner is gone, and never a live owner's", async () => {
  const db = openInMemoryStateDb();
  try {
    const scenario = fc.record<Scenario>({ source: fc.constantFrom("native", "harness-imported", "harness-ended"), owner: fc.constantFrom("me", "dead", "live-other"), retired: fc.boolean() });
    await fc.assert(fc.asyncProperty(scenario, async (given) => {
      db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
      const store = new ResearchStore(db);
      seed(store, "run", given);
      const { service, close } = launch(store);
      try {
        // Recovery retires a run whose owner is gone. A run nobody retired still belongs to a live process.
        const status = store.header("run")!.status;
        expect(status).toBe(given.retired || given.owner === "dead" ? "interrupted" : "running");
        const held = given.owner === "me" || (given.owner === "dead" && status !== "running");
        // Every read that tells a window what it may do agrees with what the owner then allows.
        expect(service.snapshot(thread).writableRunIds).toEqual(held ? ["run"] : []);
        expect(service.changes("run", 0, undefined, operator).writable).toBe(held);
        expect(service.profileRuns({}).writableRunIds).toEqual(held ? ["run"] : []);

        const before = store.header("run")!.revision;
        const review = service.update("run", "request:review", { action: "review", submissionId: "s1", decision: "accepted", reason: "Independent review" }, operator);
        if (!held) {
          await expect(review).rejects.toThrow("Another running PwrAgent process owns this run");
          await expect(service.update("run", "request:finish", { action: "finish", reason: "Done" }, operator)).rejects.toThrow();
          expect(store.header("run")!.revision).toBe(before);
          return;
        }
        await review;
        const candidate = store.readItem("run", "s1");
        expect(candidate?.type === "submission" && candidate.record.review).toMatchObject({ decision: "accepted", reason: "Independent review" });
        // A run this process still runs finishes the usual way; only a retired one is the case under test.
        if (status === "running") return;
        // A Harness run completes only once its source outcome settled; an unsettled one stays for reconcile.
        const settled = given.source === "native" || given.retired;
        const finished = await service.update("run", "request:finish", { action: "finish", reason: "Completed after operator review" }, operator);
        expect(finished.status).toBe(settled ? "completed" : "interrupted");
      } finally { await close(); }
    }), { numRuns: 60 });
  } finally { db.close(); }
});

it("budgets a decision and a finish on a retained run after a restart", async () => {
  // File-backed, so the recorded WAL size is what the two commits cost on disk.
  const fixture = createTempStateDb("pwragent-research-ownership-");
  const db = StateDb.open(fixture.dbPath);
  try {
    const store = new ResearchStore(db);
    seed(store, "run", { source: "native", owner: "dead", retired: true });
    const { service, close } = launch(store);
    try {
      const measured = await measureSqliteWrites(async () => {
        await service.update("run", "request:review", { action: "review", submissionId: "s1", decision: "accepted", reason: "Independent review" }, operator);
        return await service.update("run", "request:finish", { action: "finish", reason: "Completed after operator review" }, operator);
      });
      expect(measured.result.status).toBe("completed");
      expectSqliteWriteBudget({ scenario: "research-retained-review-and-finish", note: "After a restart: one accepted decision and one completion on a retained run. No worker, bridge or model effect.", writes: measured.writes });
    } finally { await close(); }
  } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
});
