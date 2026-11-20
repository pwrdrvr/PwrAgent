import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ResearchService, type ResearchPorts } from "@pwragent/owner-core/research-service";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import {
  RESEARCH_MAX_EVENTS,
  type ResearchActor,
  type ResearchApproach,
  type ResearchEvent,
  type ResearchEventData,
  type ResearchThread,
} from "@pwragent/shared/research";
import { createResearchAgentHandler } from "../research/research-runtime";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";

/**
 * Opt-in cost measurement for the Research read and write paths. It is not a
 * pass/fail test: it prints CPU, SQL statements and payload bytes for one
 * worker command, one turn-end observation and one renderer refresh.
 *
 *   PWRAGENT_RESEARCH_COST=before pnpm test apps/desktop/src/main/__tests__/research-cost.bench.test.ts
 *
 * The label names the output file, `.local/research-cost-<label>.json`.
 */
const LABEL = process.env.PWRAGENT_RESEARCH_COST;
const WORKERS = 8;
const TEXT = "Reordering the terminal event ahead of the queue receipt reproduces the stale reservation on the second attempt; ".repeat(2).trim();

type Counter = { statements: number; rows: number };
type Measurement = { cpuMs: number; statements: number; rows: number; notifications: number; notificationBytes: number; responseBytes: number };

/** Count every statement execution on this connection, reads included. */
function countStatements(db: StateDb): Counter {
  const counter: Counter = { statements: 0, rows: 0 };
  const raw = db.raw as unknown as { prepare: (sql: string) => Record<string, unknown> };
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== "function") return value;
        if (key !== "get" && key !== "all" && key !== "run") return (value as (...args: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          counter.statements++;
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          counter.rows += key === "all" ? (result as unknown[]).length : key === "get" ? (result === undefined ? 0 : 1) : 0;
          return result;
        };
      },
    });
  };
  return counter;
}

function bytes(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const workerThread = (runId: string, index: number): ResearchThread => ({ backend: "codex", threadId: `${runId}-worker-${index}` });
const workerTurn = (runId: string, index: number) => `${runId}-turn-${index}`;

/**
 * A journal of `size` events with every event kind the owner writes: worker
 * admission, findings with relations, candidates, reviews, revision delivery
 * receipts, item progress and direction changes. `finished` settles it.
 */
function seedRun(store: ResearchStore, id: string, coordinator: ResearchThread, size: number, finished: boolean, at: number): void {
  const operator: ResearchActor = { ...coordinator, kind: "operator" };
  const agent: ResearchActor = { ...coordinator, kind: "agent", turnId: "coordinator-turn", callId: "start" };
  let seq = 0;
  const append = (commandId: string, actor: ResearchActor, data: ResearchEventData) => {
    const event: ResearchEvent = { seq: seq + 1, commandId, signature: commandId, at: at + seq, actor, data };
    if (seq === 0) store.create(id, `start:${id}`, event); else store.append(id, seq, event);
    seq++;
  };
  const approaches: ResearchApproach[] = Array.from({ length: WORKERS }, (_, i) => ({ id: `a${i + 1}`, title: `Approach ${i + 1}`, task: `Investigate hypothesis ${i + 1}. ${TEXT}`, state: "pending" }));
  append("start", agent, { type: "created", objective: `Find the ordering defect behind the stale reservation. ${TEXT}`, coordinator, ownerId: "owner", ownerPid: 123, ownerStartedAt: 500, deadlineAt: 10_000_000_000, workspaceMode: "none", approaches });
  for (let i = 1; i <= WORKERS; i++) {
    append(`starting:a${i}`, agent, { type: "worker", approachId: `a${i}`, state: "starting" });
    append(`bound:a${i}`, agent, { type: "worker", approachId: `a${i}`, state: "starting", worker: workerThread(id, i) });
    append(`started:a${i}`, agent, { type: "worker", approachId: `a${i}`, state: "running", worker: { ...workerThread(id, i), turnId: workerTurn(id, i) } });
  }
  const tail = finished ? WORKERS + 2 : 0;
  const findings: string[] = [];
  let step = 0;
  while (seq < size - tail) {
    const approach = (step % WORKERS) + 1;
    const worker: ResearchActor = { ...workerThread(id, approach), kind: "agent", turnId: workerTurn(id, approach), callId: `call-${seq}` };
    const kind = step % 16;
    const left = size - tail - seq;
    if (kind === 9 && left >= 2) {
      const submissionId = `s${seq + 1}`;
      append(`submit:${seq}`, worker, { type: "submission", submission: { id: submissionId, author: workerThread(id, approach), approachId: `a${approach}`, text: `Candidate ${seq}. ${TEXT}`, paths: [`candidates/${seq}.md`] } });
      append(`review:${seq}`, agent, { type: "review", submissionId, decision: step % 32 === 9 ? "accepted" : "rejected", reason: "Reviewed against the retained evidence." });
    } else if (kind === 13 && findings.length) {
      const itemId = findings[(step * 7) % findings.length]!;
      append(`work:${seq}`, agent, { type: "item_work", itemId, work: { state: step % 32 === 13 ? "claimed" : "open", note: "Progress noted by the coordinator." } });
    } else if (kind === 15 && left >= 3 && step % 64 === 15) {
      const delivery = { id: `feedback:${seq}`, target: workerThread(id, approach), approachId: `a${approach}` };
      append(`pending:${seq}`, agent, { type: "delivery", delivery: { ...delivery, state: "pending" } });
      append(`receipt:${seq}`, agent, { type: "delivery", delivery: { ...delivery, state: "started", turnId: workerTurn(id, approach) } });
      append(`terminal:${seq}`, operator, { type: "delivery", delivery: { ...delivery, state: "ended", turnId: workerTurn(id, approach) } });
    } else if (kind === 15) {
      append(`direction:${seq}`, worker, { type: "direction", approachId: `a${approach}`, title: `Approach ${approach}`, task: `Narrowed after step ${step}. ${TEXT}`, reason: "Narrowed after a counterexample." });
    } else {
      const findingId = `f${seq + 1}`;
      const relatesTo = step % 5 === 0 && findings.length ? findings[(step * 3) % findings.length] : undefined;
      append(`finding:${seq}`, worker, { type: "finding", finding: { id: findingId, author: workerThread(id, approach), approachId: `a${approach}`, kind: step % 3 ? "note" : "experiment",
        text: `Finding ${seq}. ${TEXT}`, paths: [`evidence/${seq}.log`], ...(relatesTo ? { relatesTo, relation: "supports" as const } : {}) } });
      findings.push(findingId);
    }
    step++;
  }
  if (finished) {
    append("finish", agent, { type: "status", status: "stopping", reason: "completed: Completed after review" });
    for (let i = 1; i <= WORKERS; i++) append(`stopped:a${i}:${workerTurn(id, i)}`, agent, { type: "worker", approachId: `a${i}`, state: "stopped" });
    append("settled", operator, { type: "status", status: "completed", reason: "completed: Completed after review" });
  }
  expect(seq).toBe(size);
}

describe.skipIf(!LABEL)("research cost", () => {
  function harness(db: StateDb) {
    const store = new ResearchStore(db);
    const published: unknown[] = [];
    const ports: ResearchPorts = {
      ownerId: "owner", ownerPid: 123, ownerStartedAt: 500, isOwnerAlive: () => true, now: () => 5_000_000,
      schedule: () => () => {}, changed: (change) => { published.push(change); }, onError: (error) => { throw error; },
      stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}),
      spawn: async () => { throw new Error("The cost run starts no workers"); },
    };
    const service = new ResearchService(store, ports);
    const counter = countStatements(db);
    const measure = async <T,>(run: () => T | Promise<T>): Promise<Measurement & { result: T }> => {
      published.length = 0;
      const before = { ...counter };
      const cpu = process.cpuUsage();
      const result = await run();
      const used = process.cpuUsage(cpu);
      return { result, cpuMs: (used.user + used.system) / 1000, statements: counter.statements - before.statements, rows: counter.rows - before.rows,
        notifications: published.length, notificationBytes: published.reduce<number>((sum, entry) => sum + bytes(entry), 0), responseBytes: 0 };
    };
    return { store, service, measure };
  }

  /** The median CPU of the samples; statement and byte counts are the last sample's. */
  function summarize(samples: Measurement[]): Measurement {
    return { ...samples.at(-1)!, cpuMs: Math.round(median(samples.map((sample) => sample.cpuMs)) * 100) / 100 };
  }

  /** Each scenario has its own database, so one scenario's runs are not another's history. */
  async function measureScenario(name: string, runs: number, events: number) {
    const fixture = createTempStateDb("pwragent-research-cost-");
    const db = StateDb.open(fixture.dbPath);
    try { return await measureIn(db, name, runs, events); }
    finally { db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); }
  }

  async function measureIn(db: StateDb, name: string, runs: number, events: number) {
    const { store, service, measure } = harness(db);
    const coordinator: ResearchThread = { backend: "codex", threadId: "coordinator" };
    // The newest run is live and four events below the limit: one warm-up command, then three measured.
    db.raw.transaction(() => {
      for (let i = 0; i < runs - 1; i++) seedRun(store, `run-${String(i).padStart(2, "0")}`, coordinator, events, true, 1000 + i);
      seedRun(store, "run-live", coordinator, events - 4, false, 900_000);
    })();
    const runId = "run-live";
    const handler = createResearchAgentHandler(service, () => true, () => true);
    const command = async (index: number) => await handler("research_update", { runId, command: { action: "finding", approachId: "a1", kind: "note", text: `Measured finding ${index}. ${TEXT}`, paths: ["evidence/measured.log"] } },
      { backend: "codex", threadId: workerThread(runId, 1).threadId, turnId: workerTurn(runId, 1), callId: `measured-${index}` } as never);

    await command(0);
    const commands: Measurement[] = [];
    for (let i = 1; i <= 3; i++) { const sample = await measure(() => command(i)); commands.push({ ...sample, responseBytes: bytes(sample.result) }); }
    expect(store.header(runId)?.revision).toBe(events);

    const turnEnds: Measurement[] = [];
    for (let i = 0; i < 5; i++) turnEnds.push(await measure(() => service.observeEnd(coordinator, `unrelated-turn-${i}`)));

    const refreshes: Measurement[] = [];
    for (let i = 0; i < 5; i++) { const sample = await measure(() => refresh(service, coordinator, runId, events)); refreshes.push({ ...sample, responseBytes: bytes(sample.result) }); }

    // A change to a run that is not on screen refreshes that run's summary alone.
    const summaries: Measurement[] = [];
    for (let i = 0; i < 5; i++) { const sample = await measure(() => service.snapshot({ ...coordinator, runId })); summaries.push({ ...sample, responseBytes: bytes(sample.result) }); }
    const opens: Measurement[] = [];
    for (let i = 0; i < 3; i++) { const sample = await measure(() => firstOpen(service, coordinator, runId)); opens.push({ ...sample, responseBytes: sample.result.reduce<number>((sum, page) => sum + bytes(page), 0), notifications: sample.result.length }); }

    const workerEnd = await measure(() => service.observeEnd(workerThread(runId, WORKERS), workerTurn(runId, WORKERS)));
    return { name, runs, events,
      workerCommand: summarize(commands), turnEnd: summarize(turnEnds), refresh: summarize(refreshes), workerTurnEnd: summarize([workerEnd]),
      // `notifications` is the number of IPC responses here: the run list and each page of the run.
      otherRunSummary: summarize(summaries), firstOpen: summarize(opens) };
  }

  it("measures one worker command, one turn-end observation and one refresh", async () => {
    const results = [
      await measureScenario("one 4,096-event run", 1, 4096),
      await measureScenario("one run at the event limit", 1, RESEARCH_MAX_EVENTS),
      await measureScenario("a thread in 50 runs of 256 events", 50, 256),
      await measureScenario("a thread in 50 runs of 4,096 events", 50, 4096),
    ];
    const file = path.resolve(__dirname, "../../../../../.local", `research-cost-${LABEL}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(results));
  }, 600_000);
});

/**
 * What the renderer reads after one `research:changed` for the run it shows:
 * the items changed since the revision its store holds. Before this design it
 * read `service.snapshot({ ...thread, runId })`, every summary and the whole
 * board, which is what the recorded baseline measured.
 */
function refresh(service: ResearchService, thread: ResearchThread, runId: string, revision: number): unknown {
  return service.changes(runId, revision - 1, undefined, { ...thread, kind: "operator" });
}

/** What the renderer reads when the panel first opens on the run: the run list, then every page of the run. */
function firstOpen(service: ResearchService, thread: ResearchThread, runId: string): unknown[] {
  const pages: unknown[] = [service.snapshot({ ...thread })];
  let after: { version: number; id: string } | undefined;
  do {
    const page = service.changes(runId, 0, after, { ...thread, kind: "operator" });
    pages.push(page);
    after = page.next;
  } while (after);
  return pages;
}
