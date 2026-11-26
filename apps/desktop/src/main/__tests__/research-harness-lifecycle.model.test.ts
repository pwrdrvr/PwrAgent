import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  RESEARCH_HARNESS_RECONCILABLE,
  RESEARCH_HARNESS_REVISION,
  type ResearchHarnessRequest,
} from "@pwragent/shared/research-harness";
import {
  projectResearchRun,
  researchHarnessEffectiveState,
  researchRunAttention,
  type ResearchActor,
} from "@pwragent/shared/research";
import {
  ResearchHarnessService,
  type ResearchHarnessConnection,
  type ResearchHarnessPorts,
} from "@pwragent/owner-core/research-harness-service";
import { ResearchService } from "@pwragent/owner-core/research-service";
import { harnessRecordDigest } from "@pwragent/owner-core/research-harness-records";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const COORD: ResearchActor = { backend: "codex", threadId: "coordinator", kind: "operator" };
const WORKSPACE = "/contrived/workspace";
const PROJECT = "model-project";
const SESSION = "model-session";
const SWARM = "model-swarm";

type SourceEventSpec =
  | { kind: "member"; memberIdx: number; state: "running" | "submitted" | "ended" | "stopped" }
  | { kind: "direction"; memberIdx: number; state: "active" | "abandoned" | "dead" | "succeeded" }
  | { kind: "finding"; memberIdx: number; label: "lemma" | "partial" | "counterexample" | "dead_end" | "file" | "note" }
  | { kind: "submission"; memberIdx: number }
  | { kind: "verdict"; memberIdx: number }
  | { kind: "usage"; calls: number }
  | { kind: "unknown_variant" }
  | { kind: "ended"; outcome: "solved" | "budget" | "stopped" }
  | { kind: "resumed"; calls: number };

function buildValidStream(memberCount: number, specs: SourceEventSpec[]): Array<Record<string, unknown>> {
  const members = Array.from({ length: memberCount }, (_, i) => `m${i + 1}`);
  const out: Array<Record<string, unknown>> = [
    {
      event: "started",
      swarm: SWARM,
      project: PROJECT,
      session: SESSION,
      task: "Model objective",
      dir: `.ultramath/${SWARM}`,
      members,
      model: "source-model",
      member_steps: 10,
      budget: 30,
      deadline_at_ms: 1_800_000,
    },
  ];
  let ended = false;
  let calls = 0;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!;
    if (ended && s.kind !== "resumed") continue;
    if (!ended && s.kind === "resumed") continue;
    const member = members[("memberIdx" in s ? s.memberIdx : 0) % members.length]!;
    if (s.kind === "member") {
      out.push({ event: "member", swarm: SWARM, member, state: s.state });
    } else if (s.kind === "direction") {
      out.push({ event: "direction", swarm: SWARM, member, direction: `d${i}`, state: s.state, text: `Direction ${i}`, ...(s.state === "abandoned" ? { reason: "No progress" } : {}) });
    } else if (s.kind === "finding") {
      out.push({ event: "finding", swarm: SWARM, member, direction: `d${i}`, finding: `f${i}`, label: s.label, text: `Finding ${i}`, paths: ["a/b.ts"] });
    } else if (s.kind === "submission") {
      out.push({ event: "submission", swarm: SWARM, member, report: `Candidate ${i}`, paths: ["sol.ts"] });
    } else if (s.kind === "verdict") {
      out.push({ event: "verdict", swarm: SWARM, member, verdict: "accepted", note: "Source says ok" });
    } else if (s.kind === "usage") {
      calls = Math.max(calls, s.calls);
      out.push({ event: "usage", swarm: SWARM, calls });
    } else if (s.kind === "unknown_variant") {
      out.push({ event: "future_additive_record", swarm: SWARM, note: `future-${i}` });
    } else if (s.kind === "ended") {
      out.push({ event: "ended", swarm: SWARM, outcome: s.outcome, calls });
      ended = true;
    } else if (s.kind === "resumed") {
      calls = Math.max(calls, s.calls);
      out.push({ event: "resumed", swarm: SWARM, calls, members: [members[0]!] });
      ended = false;
    }
  }
  return out.map((rec, idx) => ({ ...rec, seq: idx + 1, at_ms: 1000 + idx }));
}

type FaultKind =
  | "none"
  | "duplicate_page"
  | "gap"
  | "conflict"
  | "foreign_swarm"
  | "unknown_member"
  | "escaping_path"
  | "lying_next"
  | "throw"
  | "empty_trailing_page";

type Step =
  | { kind: "advance_source"; by: number }
  | { kind: "poll"; fault: FaultKind }
  | { kind: "stop"; outcome: "stopped" | "deadline" | "completed"; confirmCancel: boolean }
  | { kind: "accept_first_submission" }
  | { kind: "reconcile"; fault: FaultKind; wrongSource: boolean; pageSize: number }
  | { kind: "restart"; crash: boolean; runRecovery: boolean }
  | { kind: "close" };

const eventSpecArb: fc.Arbitrary<SourceEventSpec> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("member" as const), memberIdx: fc.integer({ min: 0, max: 15 }), state: fc.constantFrom("running" as const, "submitted" as const, "ended" as const, "stopped" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("direction" as const), memberIdx: fc.integer({ min: 0, max: 15 }), state: fc.constantFrom("active" as const, "abandoned" as const, "dead" as const, "succeeded" as const) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("finding" as const), memberIdx: fc.integer({ min: 0, max: 15 }), label: fc.constantFrom("lemma" as const, "partial" as const, "counterexample" as const, "dead_end" as const, "file" as const, "note" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("submission" as const), memberIdx: fc.integer({ min: 0, max: 15 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("verdict" as const), memberIdx: fc.integer({ min: 0, max: 15 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("usage" as const), calls: fc.integer({ min: 0, max: 50 }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: "unknown_variant" as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("ended" as const), outcome: fc.constantFrom("solved" as const, "budget" as const, "stopped" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("resumed" as const), calls: fc.integer({ min: 0, max: 50 }) }) },
);

const faultArb = fc.constantFrom<FaultKind>(
  "none", "none", "none", "none",
  "duplicate_page", "gap", "conflict", "foreign_swarm", "unknown_member", "escaping_path", "lying_next", "throw", "empty_trailing_page",
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("advance_source" as const), by: fc.integer({ min: 1, max: 12 }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("poll" as const), fault: faultArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("stop" as const), outcome: fc.constantFrom("stopped" as const, "deadline" as const, "completed" as const), confirmCancel: fc.boolean() }) },
  { weight: 2, arbitrary: fc.constant({ kind: "accept_first_submission" as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("reconcile" as const), fault: faultArb, wrongSource: fc.boolean(), pageSize: fc.integer({ min: 1, max: 8 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("restart" as const), crash: fc.boolean(), runRecovery: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "close" as const }) },
);

describe("Harness import, reconcile and discovery model over real SQLite", () => {
  let db: StateDb;
  beforeAll(() => { db = openInMemoryStateDb(); });
  afterAll(() => { db.close(); });

  const resetDb = () => {
    db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
  };

  it("models swarm import/execute, split/duplicate/gapped/malformed pages, cancel races, reconcile and restart", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"import" | "execute">("import", "execute"),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.array(eventSpecArb, { minLength: 1, maxLength: 18 }),
        fc.array(stepArb, { minLength: 3, maxLength: 16 }),
        fc.boolean(),
        async (mode, memberCount, initialPageSize, specs, steps, failExecute) => {
          resetDb();
          const store = new ResearchStore(db);
          const stream = buildValidStream(memberCount, specs);
          let visible = Math.min(stream.length, Math.max(1, initialPageSize));
          let pageSize = initialPageSize;
          let activeFault: FaultKind = "none";
          let confirmCancel = true;
          let sourceKey = "mathos:https://os.example.test#o-12345678-1234-4123-8123-123456789abc";
          let generation = 0;
          let executeCalls = 0;
          let cancelCalls = 0;
          let emptyTrailingArmed = false;

          const makeConnection = (): ResearchHarnessConnection => ({
            source: sourceKey,
            close: () => {},
            request: async (method, params) => {
              if (method === "hello") {
                return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, execute: true, cancel: true, researchFunctions: true, discovery: true };
              }
              if (method === "execute") {
                executeCalls++;
                if (failExecute) throw new Error("Execute response lost");
                return { admitted: true };
              }
              if (method === "cancel") {
                cancelCalls++;
                return confirmCancel ? { stopped: true, runId: params.runId, swarm: params.swarm } : { stopped: false };
              }
              if (method === "records") {
                const after = params.after as number;
                const fault = activeFault;
                activeFault = "none";
                if (fault === "throw") throw new Error("Bridge dropped mid-page");
                if (fault === "empty_trailing_page") {
                  // First page returns up to visible WITH next pointing to last seq even if no more records remain!
                  const records = stream.slice(after, Math.min(visible, after + pageSize));
                  if (records.length > 0 && !emptyTrailingArmed) {
                    emptyTrailingArmed = true;
                    return { swarm: SWARM, records, next: records.at(-1)!.seq };
                  }
                  emptyTrailingArmed = false;
                  return { swarm: SWARM, records: [] };
                }
                if (fault === "duplicate_page" && after > 0) {
                  return { swarm: SWARM, records: stream.slice(0, Math.min(after, 50)) };
                }
                if (fault === "gap" && after + 2 <= stream.length) {
                  return { swarm: SWARM, records: [stream[after + 1]!] };
                }
                if (fault === "conflict" && after > 0) {
                  return { swarm: SWARM, records: [{ ...stream[after - 1]!, text: "TAMPERED", task: "TAMPERED", outcome: "tampered" }] };
                }
                if (fault === "foreign_swarm" && after < stream.length) {
                  return { swarm: SWARM, records: [{ ...stream[after]!, swarm: "foreign-swarm" }] };
                }
                if (fault === "unknown_member" && after > 0) {
                  return { swarm: SWARM, records: [{ event: "finding", swarm: SWARM, seq: after + 1, at_ms: 9999, member: "m999", label: "note", text: "Ghost", paths: [] }] };
                }
                if (fault === "escaping_path" && after > 0) {
                  return { swarm: SWARM, records: [{ event: "finding", swarm: SWARM, seq: after + 1, at_ms: 9999, member: "m1", label: "note", text: "Escape", paths: ["../secret"] }] };
                }
                if (fault === "lying_next" && after < visible) {
                  const records = stream.slice(after, Math.min(visible, after + pageSize));
                  return { swarm: SWARM, records, next: 99999 };
                }
                const records = stream.slice(after, Math.min(visible, after + pageSize));
                const last = records.at(-1)?.seq as number | undefined;
                return { swarm: SWARM, records, ...(last !== undefined && last < visible ? { next: last } : {}) };
              }
              throw new Error(`Unexpected ${method}`);
            },
          });

          const launchHarness = (): ResearchHarnessService => {
            const gen = ++generation;
            const ports: ResearchHarnessPorts = {
              ownerId: `owner-${gen}`,
              ownerPid: 10 + gen,
              ownerStartedAt: 1000 + gen,
              isOwnerAlive: (o) => o.ownerId === `owner-${generation}`,
              changed: () => {},
              now: () => 2000 + gen,
              schedule: () => () => {},
              onError: () => {},
              open: () => makeConnection(),
              probe: async () => {},
            };
            return new ResearchHarnessService(store, ports);
          };

          let harness = launchHarness();
          let closed = false;
          const req: ResearchHarnessRequest = {
            ...COORD,
            requestId: randomUUID(),
            mode,
            objective: "Model harness run",
            project: PROJECT,
            session: SESSION,
            swarm: SWARM,
            workers: memberCount,
            minutes: 30,
            budgetAcknowledged: mode === "execute",
          };
          const started = await harness.start(req, WORKSPACE);
          const id = started.id;
          let localAccepted = false;

          const checkInvariants = () => {
            const full = store.get(id)!;
            const projected = projectResearchRun(id, full.events);
            expect(full).toEqual(projected);
            const header = store.header(id)!;
            expect(header.revision).toBe(full.revision);
            expect(header.status).toBe(full.status);
            expect(header.harness).toEqual(full.harness);
            // Execute is NEVER called more than once (and never for import)
            expect(executeCalls).toBe(mode === "execute" ? 1 : 0);
            // Cancel is NEVER called more than once (and never for import)
            expect(cancelCalls).toBeLessThanOrEqual(mode === "execute" ? 1 : 0);
            // Every stored record up to cursor matches exact stream digest
            const cursor = header.harness!.cursor;
            for (let seq = 1; seq <= cursor; seq++) {
              const rec = store.harnessRecord(id, seq);
              expect(rec?.provenance?.digest).toBe(harnessRecordDigest(stream[seq - 1]!));
            }
            expect(store.harnessRecord(id, cursor + 1)).toBeUndefined();
            // Source verdicts NEVER create local PwrAgent reviews
            if (!localAccepted) {
              expect(full.submissions.every((s) => s.review === undefined)).toBe(true);
            }
            // SQL profileRuns attention rank matches JS researchRunAttention
            const page = store.profileRuns({}, 10);
            const row = page.runs.find((r) => r.id === id)!;
            expect(row.attention).toBe(researchRunAttention(row));
            // If every record up to cursor ended on `ended` AND stream prefix ends with `ended`
            // and the run settled via import/reconcile cleanly, check consistency:
            const effective = researchHarnessEffectiveState(header.status, header.harness!);
            expect(["pending", "running", "imported", "unknown", "stopping", "stopped", "ended", "reconciling"]).toContain(effective);
          };

          checkInvariants();

          for (const step of steps) {
            if (step.kind === "advance_source") {
              visible = Math.min(stream.length, visible + step.by);
            } else if (step.kind === "poll") {
              activeFault = step.fault;
              emptyTrailingArmed = false;
              await harness.poll(id);
            } else if (step.kind === "accept_first_submission") {
              const full = store.get(id)!;
              if (full.submissions.length && !localAccepted) {
                const subId = full.submissions[0]!.id;
                const data = { type: "review" as const, submissionId: subId, decision: "accepted" as const, reason: "Local check" };
                store.append(id, full.revision, { seq: full.revision + 1, commandId: `local-acc-${subId}`, signature: JSON.stringify(data), at: 3000, actor: COORD, data });
                localAccepted = true;
              }
            } else if (step.kind === "stop") {
              confirmCancel = step.confirmCancel;
              await harness.stop(id, COORD, step.outcome, "Model stop").catch(() => {});
            } else if (step.kind === "reconcile") {
              const before = store.header(id)!;
              const prevSource = sourceKey;
              if (step.wrongSource) sourceKey = "mathos:https://other.example.test#o-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
              pageSize = step.pageSize;
              activeFault = step.fault;
              emptyTrailingArmed = false;
              const execBefore = executeCalls;
              const cancelBefore = cancelCalls;
              const res = await harness.reconcile(id, COORD).catch(() => undefined);
              sourceKey = prevSource;
              // Reconcile NEVER sends execute or cancel
              expect(executeCalls).toBe(execBefore);
              expect(cancelCalls).toBe(cancelBefore);
              if (step.wrongSource && res) {
                expect(res.harness!.cursor).toBe(before.harness!.cursor);
              }
              // Oracle check: if reconcile succeeded cleanly (no fault, right source, not closed, reconcilable)
              // and read all records up to `visible` where the last record at `visible` is `ended`,
              // for import mode the run MUST settle to `ended`, regardless of page splits or prior `resumed`!
              if (
                res
                && !step.wrongSource
                && step.fault === "none"
                && !closed
                && RESEARCH_HARNESS_RECONCILABLE.includes(researchHarnessEffectiveState(before.status, before.harness!))
                && visible > 0
                && res.harness!.cursor === visible
                && stream[visible - 1]!.event === "ended"
                && mode === "import"
              ) {
                expect(res.harness!.state).toBe("ended");
              }
              // Also check empty trailing page bug!
              if (
                res
                && !step.wrongSource
                && step.fault === "empty_trailing_page"
                && !closed
                && RESEARCH_HARNESS_RECONCILABLE.includes(researchHarnessEffectiveState(before.status, before.harness!))
                && visible > 0
                && res.harness!.cursor === visible
                && stream[visible - 1]!.event === "ended"
                && mode === "import"
              ) {
                expect(res.harness!.state).toBe("ended");
              }
            } else if (step.kind === "restart") {
              if (!step.crash) await harness.close();
              closed = false;
              harness = launchHarness();
              if (step.runRecovery) {
                const native = new ResearchService(store, {
                  ownerId: `owner-${generation}`,
                  ownerPid: 10 + generation,
                  ownerStartedAt: 1000 + generation,
                  isOwnerAlive: (o) => o.ownerId === `owner-${generation}`,
                  spawn: async () => { throw new Error("Recovery must not dispatch"); },
                  stop: async () => {},
                  notify: async () => ({}),
                  cancelQueued: async () => ({}),
                  changed: () => {},
                  schedule: () => () => {},
                  onError: () => {},
                });
                native.initialize();
                native.close();
              }
            } else if (step.kind === "close") {
              await harness.close();
              closed = true;
            }

            checkInvariants();
          }

          await harness.close();
        },
      ),
      { numRuns: 5 },
    );
  });

  // Shrunk counterexample from 1,000-run real-SQLite model (seed 248026205):
  // reconcile wrote state="reconciling" after committing the ended page, then a trailing
  // empty page ran `ended = normalized.ended` (false) and left the run "imported".
  it("preserves ended state across a trailing empty or duplicate page during reconcile", async () => {
    resetDb();
    const store = new ResearchStore(db);
    const stream = buildValidStream(1, [{ kind: "ended", outcome: "solved" }]);
    let call = 0;
    const harness = new ResearchHarnessService(store, {
      ownerId: "owner-1",
      ownerPid: 1,
      ownerStartedAt: 1000,
      isOwnerAlive: () => true,
      changed: () => {},
      now: () => 2000,
      schedule: () => () => {},
      onError: () => {},
      probe: async () => {},
      open: () => ({
        source: "mathos:https://os.example.test#o-12345678-1234-4123-8123-123456789abc",
        close: () => {},
        request: async (method) => {
          if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, execute: false, cancel: false };
          if (method === "records") {
            call++;
            if (call === 1) return { swarm: SWARM, records: [stream[0]!] };
            if (call === 2) return { swarm: SWARM, records: [stream[1]!], next: 2 };
            return { swarm: SWARM, records: [] };
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
    });
    const started = await harness.start(
      { ...COORD, requestId: randomUUID(), mode: "import", objective: "Import", project: PROJECT, session: SESSION, swarm: SWARM, budgetAcknowledged: false },
      WORKSPACE,
    );
    expect(started.harness?.state).toBe("imported");
    const reconciled = await harness.reconcile(started.id, COORD);
    expect(reconciled.harness?.state).toBe("ended");
    expect(reconciled.harness?.cursor).toBe(2);
    await harness.close();
  });

  // Page-split invariance: an import that resumed and ended again must settle to "ended"
  // whether resumed and ended arrive on one page or across two pages; an execute run that
  // resumed outside PwrAgent's admission stays "unknown" either way.
  it.each([
    ["import", "single"],
    ["import", "split"],
    ["execute", "single"],
    ["execute", "split"],
  ] as const)("handles resumed-then-ended consistently (%s mode, %s page)", async (mode, paging) => {
    resetDb();
    const store = new ResearchStore(db);
    const stream = buildValidStream(1, [
      { kind: "ended", outcome: "solved" },
      { kind: "resumed", calls: 1 },
      { kind: "finding", memberIdx: 0, label: "note" },
      { kind: "ended", outcome: "solved" },
    ]);
    let page = 0;
    const harness = new ResearchHarnessService(store, {
      ownerId: "owner-1",
      ownerPid: 1,
      ownerStartedAt: 1000,
      isOwnerAlive: () => true,
      changed: () => {},
      now: () => 2000,
      schedule: () => () => {},
      onError: () => {},
      probe: async () => {},
      open: () => ({
        source: "mathos:https://os.example.test#o-12345678-1234-4123-8123-123456789abc",
        close: () => {},
        request: async (method) => {
          if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, execute: true, cancel: true, researchFunctions: true };
          if (method === "execute") return { admitted: true };
          if (method === "records") {
            page++;
            if (page === 1) return { swarm: SWARM, records: [stream[0]!] };
            if (page === 2 && mode === "execute") throw new Error("bridge dropped");
            if (paging === "single") return { swarm: SWARM, records: [stream[1]!, stream[2]!, stream[3]!, stream[4]!] };
            if (page === (mode === "execute" ? 3 : 2)) return { swarm: SWARM, records: [stream[1]!, stream[2]!], next: 3 };
            return { swarm: SWARM, records: [stream[3]!, stream[4]!] };
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
    });
    const started = await harness.start(
      { ...COORD, requestId: randomUUID(), mode, objective: "Obj", project: PROJECT, session: SESSION, swarm: SWARM, workers: 1, minutes: 10, budgetAcknowledged: mode === "execute" },
      WORKSPACE,
    );
    if (mode === "execute") await harness.poll(started.id);
    const reconciled = await harness.reconcile(started.id, COORD);
    expect(reconciled.harness?.cursor).toBe(5);
    expect(reconciled.harness?.state).toBe(mode === "import" ? "ended" : "unknown");
    await harness.close();
  });

  // Multi-page reconcile must preserve ended state across pages so valid post-end
  // observations (verdict, refused, additive events) keep the run ended and forbidden
  // post-end mutations (finding, etc.) without a resume record are still rejected.
  it("preserves ended state across reconcile pages for post-end observations and rejects forbidden post-end mutations", async () => {
    resetDb();
    const store = new ResearchStore(db);
    const base = buildValidStream(1, [{ kind: "ended", outcome: "solved" }]);
    const postEndVerdict = { seq: 3, at_ms: 3000, swarm: SWARM, event: "verdict", member: "m1", verdict: "accepted", note: "confirmed" };
    let page = 0;
    const harness = new ResearchHarnessService(store, {
      ownerId: "owner-1",
      ownerPid: 1,
      ownerStartedAt: 1000,
      isOwnerAlive: () => true,
      changed: () => {},
      now: () => 2000,
      schedule: () => () => {},
      onError: () => {},
      probe: async () => {},
      open: () => ({
        source: "mathos:https://os.example.test#o-12345678-1234-4123-8123-123456789abc",
        close: () => {},
        request: async (method) => {
          if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, execute: false, cancel: false, researchFunctions: false };
          if (method === "records") {
            page++;
            if (page === 1) return { swarm: SWARM, records: [base[0]!] };
            if (page === 2) return { swarm: SWARM, records: [base[1]!], next: 2 };
            return { swarm: SWARM, records: [postEndVerdict] };
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
    });
    const started = await harness.start(
      { ...COORD, requestId: randomUUID(), mode: "import", objective: "Import", project: PROJECT, session: SESSION, swarm: SWARM, budgetAcknowledged: false },
      WORKSPACE,
    );
    const reconciled = await harness.reconcile(started.id, COORD);
    expect(reconciled.harness?.cursor).toBe(3);
    expect(reconciled.harness?.state).toBe("ended");
    await harness.close();

    // Forbidden post-end finding on page 2 without a resume record must be rejected.
    resetDb();
    const store2 = new ResearchStore(db);
    const errors: unknown[] = [];
    const forbiddenFinding = { seq: 3, at_ms: 3000, swarm: SWARM, event: "finding", member: "m1", direction: "d1", finding: "f1", label: "note", text: "late mutation", paths: [] };
    let page2 = 0;
    const harness2 = new ResearchHarnessService(store2, {
      ownerId: "owner-1",
      ownerPid: 1,
      ownerStartedAt: 1000,
      isOwnerAlive: () => true,
      changed: () => {},
      now: () => 2000,
      schedule: () => () => {},
      onError: (err) => errors.push(err),
      probe: async () => {},
      open: () => ({
        source: "mathos:https://os.example.test#o-12345678-1234-4123-8123-123456789abc",
        close: () => {},
        request: async (method) => {
          if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, execute: false, cancel: false, researchFunctions: false };
          if (method === "records") {
            page2++;
            if (page2 === 1) return { swarm: SWARM, records: [base[0]!] };
            if (page2 === 2) return { swarm: SWARM, records: [base[1]!], next: 2 };
            return { swarm: SWARM, records: [forbiddenFinding] };
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
    });
    const started2 = await harness2.start(
      { ...COORD, requestId: randomUUID(), mode: "import", objective: "Import", project: PROJECT, session: SESSION, swarm: SWARM, budgetAcknowledged: false },
      WORKSPACE,
    );
    const reconciled2 = await harness2.reconcile(started2.id, COORD);
    expect(reconciled2.harness?.cursor).toBe(2);
    expect(store2.get(started2.id)?.findings).toHaveLength(0);
    expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([
      expect.stringMatching(/changed after ending without a resume record/),
    ]);
    await harness2.close();
  });

  it("models discovery snapshots with valid/malformed trees and cancellation races over real SQLite", async () => {
    const scenarioArb = fc.record({
      nodeCount: fc.integer({ min: 1, max: 20 }),
      withTree: fc.boolean(),
      truncated: fc.boolean(),
      cancelStage: fc.constantFrom<"none" | "hello" | "status" | "problems" | "tree">("none", "hello", "status", "problems", "tree"),
      malform: fc.constantFrom<"none" | "count_mismatch" | "dup_problem" | "bad_parent" | "cycle" | "bad_verified" | "long_excerpt" | "foreign_run">("none", "none", "count_mismatch", "dup_problem", "bad_parent", "cycle", "bad_verified", "long_excerpt", "foreign_run"),
    });

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ nodeCount, withTree, truncated, cancelStage, malform }) => {
        resetDb();
        const store = new ResearchStore(db);
        const nodes: Array<Record<string, unknown>> = [
          { id: 0, parent: null, round: 0, score: 0.1, verified: null, excerpt: "root", ms_since_start: 0 },
        ];
        for (let i = 1; i < nodeCount; i++) {
          nodes.push({ id: i, parent: Math.floor((i - 1) / 2), round: i, score: i * 0.05, verified: i % 2 === 0 ? true : false, excerpt: `node-${i}`, ms_since_start: i * 10 });
        }
        const statusObj: Record<string, unknown> = { run: SWARM, state: "done", problems: 2, finished: 1, solved: 1, tokens_in: 100, tokens_out: 50, usd: 0.12 };
        const problemsObj: Record<string, unknown> = {
          run: SWARM,
          problems: [
            { problem: "p1", state: "done", nodes: nodeCount, rounds: nodeCount, solved: true },
            { problem: "p2", state: "active", nodes: 1, rounds: 1, solved: false },
          ],
        };
        const treeObj: Record<string, unknown> = { run: SWARM, problem: "p1", state: "done", truncated, rounds: [], nodes };

        if (malform === "count_mismatch") statusObj.finished = 5;
        if (malform === "dup_problem") (problemsObj.problems as Array<Record<string, unknown>>)[1]!.problem = "p1";
        if (malform === "bad_parent" && withTree && nodeCount > 1) nodes[1]!.parent = 999;
        if (malform === "cycle" && withTree && nodeCount > 1) nodes[1]!.parent = 1;
        if (malform === "bad_verified" && withTree) nodes[0]!.verified = "yes";
        if (malform === "long_excerpt" && withTree) nodes[0]!.excerpt = "x".repeat(201);
        if (malform === "foreign_run") statusObj.run = "other-run";

        const gate = Promise.withResolvers<void>();
        const reached = Promise.withResolvers<void>();
        const targetMethod = cancelStage === "hello" ? "hello" : cancelStage === "none" ? "" : `discovery.${cancelStage}`;
        const shouldCancel = cancelStage !== "none" && !(cancelStage === "tree" && !withTree);

        const connection: ResearchHarnessConnection = {
          close: vi.fn(),
          request: async (method) => {
            if (shouldCancel && method === targetMethod) {
              reached.resolve();
              await gate.promise;
            }
            if (method === "hello") return { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION, import: true, execute: false, cancel: false, discovery: true };
            if (method === "discovery.status") return statusObj;
            if (method === "discovery.problems") return problemsObj;
            if (method === "discovery.tree") return treeObj;
            throw new Error(`Unexpected ${method}`);
          },
        };
        const harness = new ResearchHarnessService(store, {
          ownerId: "o1",
          ownerPid: 1,
          ownerStartedAt: 100,
          isOwnerAlive: () => true,
          changed: () => {},
          now: () => 5000,
          schedule: () => () => {},
          onError: () => {},
          open: () => connection,
          probe: async () => { throw new Error("Discovery never probes"); },
        });
        const req: ResearchHarnessRequest = {
          ...COORD,
          requestId: randomUUID(),
          mode: "import",
          source: "discovery",
          objective: "Discovery model",
          project: PROJECT,
          session: "",
          swarm: SWARM,
          ...(withTree ? { problem: "p1" } : {}),
          budgetAcknowledged: false,
        };
        const starting = harness.start(req, WORKSPACE);
        if (shouldCancel) {
          await reached.promise;
          const active = store.activeRuns(COORD)[0]!;
          await harness.stop(active.id, COORD, "stopped", "Cancel discovery");
          gate.resolve();
        }
        const res = await starting;
        const full = store.get(res.id)!;
        expect(full).toEqual(projectResearchRun(res.id, full.events));
        const treeMalformed = withTree && (malform === "bad_verified" || malform === "long_excerpt" || ((malform === "bad_parent" || malform === "cycle") && nodeCount > 1));
        const expectedInvalid = malform === "count_mismatch" || malform === "dup_problem" || malform === "foreign_run" || treeMalformed;
        if (shouldCancel) {
          expect(full.status).toBe("stopped");
          expect(full.harness?.discovery).toBeUndefined();
        } else if (expectedInvalid) {
          expect(full.status).toBe("interrupted");
          expect(full.harness?.state).toBe("unknown");
          expect(full.harness?.discovery).toBeUndefined();
        } else {
          expect(full.status).toBe("interrupted");
          expect(full.harness?.state).toBe("imported");
          expect(full.harness?.discovery?.problems).toHaveLength(2);
          if (withTree) expect(full.harness?.discovery?.tree?.nodes).toHaveLength(nodeCount);
          else expect(full.harness?.discovery?.tree).toBeUndefined();
        }
        // Reconcile is always refused on discovery runs
        await expect(harness.reconcile(res.id, COORD)).rejects.toThrow(/discovery snapshot/);
        await harness.close();
      }),
      { numRuns: 5 },
    );
  });
});
