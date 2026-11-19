import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { RESEARCH_HARNESS_REVISION, RESEARCH_MAX_WORKERS, projectResearchRun, type ResearchHarnessRequest, type ResearchRun } from "@pwragent/shared";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { ResearchHarnessService, type ResearchHarnessConnection, type ResearchHarnessPorts } from "@pwragent/owner-core/research-harness-service";
import { normalizeHarnessRecords } from "@pwragent/owner-core/research-harness-records";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";

/**
 * The rule: an import admits the members its source names, whatever their number up to
 * RESEARCH_MAX_WORKERS, and attributes every source record to the member that made it.
 * Execution keeps the operator's member limit. Every other refusal stands at every size.
 */

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
const services: ResearchHarnessService[] = [];
const actor = { backend: "codex", threadId: "coordinator", kind: "operator" } as const;
const SWARM = "fixture-swarm";
const PAGE = 50;

beforeEach(() => { vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1"); fixture = createTempStateDb("pwragent-harness-members-"); db = StateDb.open(fixture.dbPath); resetSqliteWriteMetrics(); });
afterEach(async () => { for (const service of services.splice(0)) await service.close(); db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

type Step = { member: number; kind: "member" | "direction" | "finding" | "submission" | "verdict" };
type Swarm = { names: string[]; steps: Step[]; ended: boolean };
type SourceRecord = Record<string, unknown> & { seq: number };

/** A source swarm as the pinned record contract describes it: one `started` naming every member, then their work. */
function sourceRecords(swarm: Swarm): SourceRecord[] {
  const records: Record<string, unknown>[] = [{ event: "started", swarm: SWARM, project: "fixture-project", session: "fixture-session", task: "Contrived objective",
    dir: `.ultramath/${SWARM}`, members: swarm.names, model: "fixture-model", member_steps: 10, budget: 30, deadline_at_ms: 1_800_000 }];
  swarm.steps.forEach((step, i) => {
    const member = swarm.names[step.member]!;
    if (step.kind === "member") records.push({ event: "member", swarm: SWARM, member, state: "running" });
    else if (step.kind === "direction") records.push({ event: "direction", swarm: SWARM, member, direction: `d${i}`, state: "active", text: `Contrived direction ${i}` });
    else if (step.kind === "finding") records.push({ event: "finding", swarm: SWARM, member, direction: `d${i}`, finding: `f${i}`, label: "note", text: `Contrived finding ${i}`, paths: ["evidence/notes.txt"] });
    else if (step.kind === "submission") records.push({ event: "submission", swarm: SWARM, member, direction: `d${i}`, report: `Contrived report ${i}`, paths: [] });
    else records.push({ event: "verdict", swarm: SWARM, member, direction: `d${i}`, accepted: true, reason: "The source accepted this contrived candidate." });
  });
  if (swarm.ended) records.push({ event: "ended", swarm: SWARM, outcome: "solved", calls: swarm.steps.length, reserved_calls: swarm.steps.length, checks: 0 });
  return records.map((record, i) => ({ ...record, seq: i + 1, at_ms: 1000 + i }));
}

const swarms = fc.integer({ min: 1, max: RESEARCH_MAX_WORKERS }).chain((size) => fc.record({
  // Member names are source identities; generated, never index-shaped, so attribution cannot pass by accident.
  names: fc.uniqueArray(fc.stringMatching(/^m[a-z0-9]{1,8}$/), { minLength: size, maxLength: size }),
  steps: fc.array(fc.record({ member: fc.integer({ min: 0, max: size - 1 }), kind: fc.constantFrom<Step["kind"]>("member", "direction", "finding", "submission", "verdict") }),
    { minLength: 1, maxLength: 120 }),
  ended: fc.boolean(),
}));

/** The bridge: records after a cursor, at most fifty, with `next` naming the last one when more remain. */
function setup(page: (after: number) => { records: unknown[]; next?: number }) {
  const store = new ResearchStore(db);
  const connection: ResearchHarnessConnection = { close: vi.fn(), request: vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, execute: true, import: true, cancel: true, researchFunctions: true };
    if (method === "execute") return { admitted: true };
    if (method === "cancel") return { stopped: true, runId: params.runId, swarm: params.swarm };
    if (method === "records") return { swarm: SWARM, ...page(params.after as number) };
    throw new Error("Unexpected request");
  }) };
  const ports: ResearchHarnessPorts = { ownerId: "owner", ownerPid: 42, ownerStartedAt: 100, isOwnerAlive: () => true, changed: () => {}, now: () => 1000,
    schedule: () => () => {}, onError: () => {}, open: () => connection, probe: async () => {} };
  const service = new ResearchHarnessService(store, ports); services.push(service);
  return { service, store };
}
const cleanPages = (records: SourceRecord[]) => (after: number) => {
  const rest = records.filter((r) => r.seq > after);
  const records_ = rest.slice(0, PAGE);
  return { records: records_, ...(rest.length > PAGE ? { next: records_.at(-1)!.seq } : {}) };
};

function harnessRequest(mode: "import" | "execute", workers: number): ResearchHarnessRequest {
  return { ...actor, requestId: randomUUID(), mode, objective: "Contrived Harness objective", project: "fixture-project", session: "fixture-session", swarm: SWARM,
    // An import's members come from its source; only execution carries the operator's limit.
    ...(mode === "execute" ? { workers, minutes: 10 } : {}), budgetAcknowledged: mode === "execute" };
}

/** Polls the way the scheduled continuation would, until the source has nothing more or the run settles. */
async function drain(service: ResearchHarnessService, store: ResearchStore, id: string, total: number) {
  for (let i = 0; i < 10 && store.header(id)?.status === "running" && store.header(id)!.harness!.cursor < total; i++) await service.poll(id);
}

const approachMember = (run: ResearchRun, approachId: string) => run.harness!.members[Number(approachId.slice(1)) - 1];

describe("Harness members come from the source", () => {
  it("admits every member a source names, up to the maximum, and attributes each record to its member", async () => {
    await fc.assert(fc.asyncProperty(swarms, fc.constantFrom<"import" | "execute">("import", "execute"), fc.integer({ min: 1, max: RESEARCH_MAX_WORKERS }), async (swarm, mode, workers) => {
      const records = sourceRecords(swarm);
      const { service, store } = setup(cleanPages(records));
      const started = await service.start(harnessRequest(mode, workers), fixture.tempDir);
      await drain(service, store, started.id, records.length);
      const run = store.get(started.id)!;
      const header = store.header(started.id)!;
      // The journal and the indexed header describe the same run.
      expect(run).toEqual(projectResearchRun(run.id, run.events));
      expect(header.workerLimit).toBe(run.workerLimit);
      expect(run.activeWorkers).toBeLessThanOrEqual(run.workerLimit);
      // A source verdict is an observation, never a PwrAgent review.
      expect(run.submissions.every((s) => s.review === undefined)).toBe(true);
      if (mode === "execute" && swarm.names.length > workers) {
        // Execution still holds the source to the operator's member limit.
        expect(run.harness).toMatchObject({ state: "unknown", cursor: 0, members: [] });
        expect(run.findings).toEqual([]);
        return;
      }
      expect(run.harness!.members).toEqual(swarm.names);
      expect(run.harness!.cursor).toBe(records.length);
      expect(run.findings).toHaveLength(swarm.steps.filter((s) => s.kind === "finding").length);
      expect(run.submissions).toHaveLength(swarm.steps.filter((s) => s.kind === "submission").length);
      for (const item of run.items) {
        if (item.type !== "approach" && item.provenance?.member) expect(approachMember(run, item.approachId)).toBe(item.provenance.member);
      }
      if (swarm.ended) {
        expect(run.status).toBe("exhausted");
        expect(run.approaches.filter((a) => approachMember(run, a.id) !== undefined).every((a) => a.state === "ended")).toBe(true);
      } else if (mode === "import") expect(run).toMatchObject({ status: "interrupted", harness: { state: "imported" } });
    }), { numRuns: 30 });
  });

  it("refuses gaps, conflicting duplicates, foreign origins, escaping paths and unnamed members at every swarm size", async () => {
    const corruptions = ["gap", "conflict", "foreign", "escape", "unnamed"] as const;
    await fc.assert(fc.asyncProperty(swarms, fc.constantFrom(...corruptions), fc.nat(), async (swarm, corruption, at) => {
      const records = sourceRecords(swarm);
      // Any record after `started`; the page that holds it must be refused whole.
      const target = 2 + at % (records.length - 1);
      // Dropping the source's last record leaves no gap to see: the source just looks shorter. A gap needs a record after it.
      fc.pre(corruption !== "gap" || target < records.length);
      const bad = (after: number) => {
        const page = cleanPages(records)(after);
        const index = page.records.findIndex((r) => (r as SourceRecord).seq === target);
        if (index < 0) return page;
        const list = [...page.records] as SourceRecord[];
        const original = list[index]!;
        const member = swarm.names[0]!;
        if (corruption === "gap") list.splice(index, 1);
        else if (corruption === "conflict") list.splice(index, 0, { ...records[target - 2]!, text: "Changed after delivery", report: "Changed after delivery" });
        else if (corruption === "foreign") list[index] = { ...original, swarm: "foreign-swarm" };
        else if (corruption === "escape") list[index] = { event: "finding", swarm: SWARM, member, direction: "dx", finding: "fx", label: "note", text: "Escaping evidence", paths: ["../outside.txt"], seq: original.seq, at_ms: original.at_ms };
        else list[index] = { event: "finding", swarm: SWARM, member: "x-unnamed", direction: "dx", finding: "fx", label: "note", text: "Unnamed member", paths: [], seq: original.seq, at_ms: original.at_ms };
        return { ...page, records: list };
      };
      const { service, store } = setup(bad);
      const started = await service.start(harnessRequest("import", 0), fixture.tempDir);
      await drain(service, store, started.id, records.length);
      const run = store.get(started.id)!;
      // Every page before the corrupted one committed; that page and everything after it did not.
      const committed = Math.floor((target - 1) / PAGE) * PAGE;
      expect(run.harness).toMatchObject({ state: "unknown", cursor: committed });
      expect(run.status).toBe("interrupted");
      expect(run.findings).toHaveLength(records.filter((r) => r.seq <= committed && r.event === "finding").length);
      expect(run.submissions.every((s) => s.review === undefined)).toBe(true);
      expect(run).toEqual(projectResearchRun(run.id, run.events));
    }), { numRuns: 30 });
  });

  it("declares one slot per named member and no placeholders", async () => {
    const swarm: Swarm = { names: ["mone", "mtwo", "mthree"], steps: [{ member: 2, kind: "finding" }], ended: false };
    const { service, store } = setup(cleanPages(sourceRecords(swarm)));
    const run = await service.start(harnessRequest("import", 0), fixture.tempDir);
    expect(store.get(run.id)!.items.filter((item) => item.type === "approach").map((item) => item.id)).toEqual(["a1", "a2", "a3"]);
    expect(store.get(run.id)!.findings[0]).toMatchObject({ approachId: "a3" });
  });

  it("a stale member count from an older window does not bound an import", async () => {
    const swarm: Swarm = { names: Array.from({ length: 12 }, (_, i) => `m${i}x`), steps: [{ member: 11, kind: "finding" }], ended: true };
    const { service, store } = setup(cleanPages(sourceRecords(swarm)));
    const run = await service.start({ ...harnessRequest("import", 0), workers: 8 }, fixture.tempDir);
    expect(store.get(run.id)).toMatchObject({ status: "exhausted", harness: { members: swarm.names } });
  });

  it.each([0, RESEARCH_MAX_WORKERS + 1, 2.5, "eight"])("refuses a malformed member count %s before any intent, even on an import", async (workers) => {
    const { service, store } = setup(cleanPages([]));
    await expect(service.start({ ...harnessRequest("import", 0), workers: workers as number }, fixture.tempDir)).rejects.toThrow(`Choose 1–${RESEARCH_MAX_WORKERS} members`);
    expect(store.activeRuns()).toEqual([]);
  });

  it("refuses execution without a member limit", async () => {
    const { service } = setup(cleanPages([]));
    const { workers: _omitted, ...request } = harnessRequest("execute", 2);
    await expect(service.start(request, fixture.tempDir)).rejects.toThrow(`Choose 1–${RESEARCH_MAX_WORKERS} members`);
  });

  /** A run that has read nothing yet: `slots` declared at creation, within `workerLimit`. */
  const unread = (workerLimit: number, slots: number) => ({ workerLimit,
    approaches: Array.from({ length: slots }, (_, i) => ({ id: `a${i + 1}`, title: `Harness member ${i + 1}`, task: "Contrived", state: "unknown" as const })),
    harness: { version: 1 as const, mode: "import" as const, project: "fixture-project", session: "fixture-session", swarm: SWARM,
      workspace: fixture.tempDir, upstreamRevision: RESEARCH_HARNESS_REVISION, state: "running" as const, cursor: 0, members: [], cancelSupported: false, note: "" } });
  const named = (count: number) => Array.from({ length: count }, (_, i) => `m${i}x`);

  it("an import created with eight pre-declared slots keeps them", () => {
    // Imports created before this change declared eight slots; reconciling one still fills them, and its unused slots never run.
    const normalized = normalizeHarnessRecords(unread(8, 8), sourceRecords({ names: named(5), steps: [{ member: 4, kind: "finding" }], ended: false }));
    expect(normalized.state.members).toEqual(named(5));
    expect(normalized.events.some((e) => e.data.type === "members")).toBe(false);
    expect(normalized.events.flatMap((e) => e.data.type === "worker" && e.data.state === "stopped" ? [e.data.approachId] : [])).toEqual(["a6", "a7", "a8"]);
    expect(normalized.events.find((e) => e.data.type === "finding")?.data).toMatchObject({ finding: { approachId: "a5" } });
    expect(() => normalizeHarnessRecords(unread(8, 8), sourceRecords({ names: named(9), steps: [{ member: 0, kind: "member" }], ended: false })))
      .toThrow("more than the 8 members an import admits");
  });

  it("refuses a source that names more members than an import admits", () => {
    expect(() => normalizeHarnessRecords(unread(RESEARCH_MAX_WORKERS, 0), sourceRecords({ names: named(RESEARCH_MAX_WORKERS + 1), steps: [{ member: 0, kind: "member" }], ended: false })))
      .toThrow(`more than the ${RESEARCH_MAX_WORKERS} members an import admits`);
    expect(normalizeHarnessRecords(unread(RESEARCH_MAX_WORKERS, 0), sourceRecords({ names: named(RESEARCH_MAX_WORKERS), steps: [{ member: 63, kind: "member" }], ended: false })).state.members)
      .toHaveLength(RESEARCH_MAX_WORKERS);
  });

  it("budgets a sixty-four-member import: one page commit, rows per member", async () => {
    const names = Array.from({ length: RESEARCH_MAX_WORKERS }, (_, i) => `m${i}x`);
    const records = sourceRecords({ names, steps: names.map((_, member) => ({ member, kind: "member" as const })), ended: true });
    const { service } = setup(cleanPages(records));
    const measured = await measureSqliteWrites(async () => {
      const run = await service.start(harnessRequest("import", 0), fixture.tempDir);
      // 66 records arrive as two pages.
      await service.poll(run.id);
      return run;
    });
    expectSqliteWriteBudget({ scenario: "research-harness-import-64-members", note: "Intent, admission, two source pages with their cursors (the first declares all 64 members), and the ended boundary; commits do not scale with members.", writes: measured.writes });
  });
});
