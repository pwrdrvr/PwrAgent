import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { RESEARCH_HARNESS_REVISION, type ResearchHarnessRequest } from "@pwragent/shared/research-harness";
import { projectResearchRun } from "@pwragent/shared/research";
import { ResearchHarnessService, type ResearchHarnessConnection } from "@pwragent/owner-core/research-harness-service";
import { normalizeHarnessDiscovery } from "@pwragent/owner-core/research-harness-discovery";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { discoveryRecords } from "./fixtures/research-discovery-records";
import { createTempStateDb } from "./sqlite-test-utils";

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
let service: ResearchHarnessService;
const actor = { backend: "codex", threadId: "coordinator", kind: "operator" } as const;
const request = (): ResearchHarnessRequest => ({ ...actor, source: "discovery", mode: "import", requestId: randomUUID(), objective: "Inspect an invented discovery run",
  project: "fixture-project", session: "", swarm: "fixture-run", problem: "fixture_problem", workers: 1, minutes: 10, budgetAcknowledged: true });
beforeEach(() => { vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1"); fixture = createTempStateDb("discovery-"); db = StateDb.open(fixture.dbPath); });
afterEach(async () => { await service?.close(); db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function setup(input = discoveryRecords(), override?: ResearchHarnessConnection["request"]) {
  const store = new ResearchStore(db);
  const connection = { close: vi.fn(), request: vi.fn(override ?? (async (method: string) => {
    if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, execute: false, cancel: false, discovery: true };
    const value = input[method.slice("discovery.".length) as keyof typeof input];
    if (!value) throw new Error("Unexpected mutation or model request");
    return value;
  })) };
  const probe = vi.fn(async () => {});
  service = new ResearchHarnessService(store, { ownerId: "owner", ownerPid: 1, ownerStartedAt: 100, isOwnerAlive: () => true, now: () => 1000,
    changed: () => {}, schedule: () => () => {}, onError: () => {}, open: () => connection, probe });
  return { store, connection, probe };
}

it("retains source snapshots with provenance atomically, without model calls or local verification", async () => {
  const { store, connection, probe } = setup();
  const input = request();
  const result = await measureSqliteWrites(() => service.start(input, fixture.tempDir));
  const run = store.get(result.result.id)!;
  expect(run.harness?.discovery?.tree?.nodes.at(-1)?.sourceVerified).toBe(true);
  expect(run.submissions).toEqual([]);
  expect(run.status).toBe("interrupted");
  expect(run.harness?.cursor).toBe(0);
  expect(run.events.filter((e) => e.provenance).map((e) => e.provenance)).toEqual(expect.arrayContaining([expect.objectContaining({ source: "discovery", sequenceKind: "observation", problem: "fixture_problem" })]));
  expect(run.events.some((e) => e.data.type === "harness_observation" && e.data.text.includes("future_field"))).toBe(true);
  expect(run).toEqual(projectResearchRun(run.id, run.events));
  expect(store.get(run.id)).toEqual(run);
  expect(probe).not.toHaveBeenCalled();
  expect(connection.request.mock.calls.map(([method]) => method)).toEqual(["hello", "discovery.status", "discovery.problems", "discovery.tree"]);
  expectSqliteWriteBudget({ scenario: "research-harness-discovery-import", note: "Intent, read-only bridge admission and one atomic bounded discovery snapshot including raw observations; no per-node writes", writes: result.writes });
  const repeated = await measureSqliteWrites(() => service.start(input, fixture.tempDir));
  expectSqliteWriteBudget({ scenario: "research-harness-discovery-repeat", note: "Repeated request identity returns retained discovery without service calls or persistence", writes: repeated.writes });
});

it("preserves recorded parent identities across generated coherent trees and rejects foreign, cyclic or absent parents", async () => {
  setup();
  const run = await service.start(request(), fixture.tempDir);
  fc.assert(fc.property(fc.integer({ min: 2, max: 150 }), (count) => {
    const input = discoveryRecords(count);
    const normalized = normalizeHarnessDiscovery(run, input, 1000);
    expect(normalized.snapshot.tree?.nodes.map((node) => [node.id, node.parent])).toEqual(input.tree.nodes.map((node) => [node.id, node.parent]));
    input.tree.nodes[1]!.parent = count + 1;
    expect(() => normalizeHarnessDiscovery(run, input, 1000)).toThrow("ancestry");
    input.tree.nodes[1]!.parent = 1;
    expect(() => normalizeHarnessDiscovery(run, input, 1000)).toThrow("ancestry");
    input.tree.run = "foreign";
    expect(() => normalizeHarnessDiscovery(run, input, 1000)).toThrow("origin");
  }), { numRuns: 50 });
});

it("does not revive an observation cancelled while the tree response is outstanding", async () => {
  const records = discoveryRecords();
  const tree = Promise.withResolvers<unknown>();
  const waiting = Promise.withResolvers<void>();
  const { store } = setup(records, async (method) => {
    if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, discovery: true };
    if (method === "discovery.tree") { waiting.resolve(); return await tree.promise; }
    return records[method.slice("discovery.".length) as keyof typeof records];
  });
  const start = service.start(request(), fixture.tempDir);
  await waiting.promise;
  const run = store.activeRuns(actor)[0]!;
  await service.stop(run.id, actor, "stopped", "Detach observation");
  tree.resolve(records.tree);
  expect((await start).status).toBe("stopped");
  expect(store.get(run.id)?.harness?.discovery).toBeUndefined();
});

it("refuses discovery execution before creating an intent or opening a process", async () => {
  const { store, connection } = setup();
  await expect(service.start({ ...request(), mode: "execute" }, fixture.tempDir)).rejects.toThrow("read-only");
  expect(store.activeRuns(actor)).toHaveLength(0);
  expect(connection.request).not.toHaveBeenCalled();
});
