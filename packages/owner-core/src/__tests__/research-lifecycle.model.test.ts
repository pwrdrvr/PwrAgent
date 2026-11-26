import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  projectResearchRun,
  researchApproachOccupiesSlot,
  researchApproachResumable,
  RESEARCH_MAX_WORKERS,
  type ResearchActor,
  type ResearchFindingKind,
  type ResearchThread,
  type StartResearchRequest,
} from "@pwragent/shared/research";
import {
  ResearchAdmissionRefused,
  ResearchService,
  type ResearchExecutionContext,
  type ResearchPorts,
} from "../research-service";
import { MemoryResearchStorage } from "./fixtures/research-memory-storage";

const MINUTE = 60_000;
const START_TIME = 10_000_000;
const COORD: ResearchThread = { backend: "codex", threadId: "coordinator" };
const OP: ResearchActor = { ...COORD, kind: "operator" };
const COORD_AGENT: ResearchExecutionContext = { ...COORD, kind: "agent", turnId: "coord-turn", callId: "start" };

type SpawnOutcome = "ok" | "refused" | "unknown_error" | "no_turn";
type NotifyOutcome = "turn" | "queued" | "unknown" | "throw";
type CancelQueuedOutcome = "cancelled" | "admitted" | "throw";

type Op =
  | { kind: "prepare"; workers: number; minutes?: number; turnMinutes?: number; totalWorkerMinutes?: number }
  | { kind: "withdraw" }
  | { kind: "start_without_intent"; workers: number; minutes?: number; turnMinutes?: number; totalWorkerMinutes?: number }
  | { kind: "start_with_intent" }
  | { kind: "finding"; actorSlot: number; findingKind: ResearchFindingKind; useRel: boolean }
  | { kind: "submit"; actorSlot: number }
  | { kind: "review"; subIndex: number; decision: "accepted" | "rejected" | "revision_requested"; notifyOutcome: NotifyOutcome }
  | { kind: "assign"; targetKind: "approach" | "finding" | "submission"; targetIndex: number; spawnOutcome: SpawnOutcome }
  | { kind: "work"; targetKind: "approach" | "finding" | "submission"; targetIndex: number; state: "open" | "claimed" | "in_progress" | "blocked" | "completed" | "cancelled"; asCoordinator: boolean }
  | { kind: "direction"; approachIndex: number; abandon: boolean }
  | { kind: "bounds"; workers?: number; minutes?: number | null; turnMinutes?: number | null; totalWorkerMinutes?: number | null; asAgent: boolean }
  | { kind: "observe_start"; approachIndex: number; placeholder: boolean }
  | { kind: "observe_end"; approachIndex: number; failed: boolean; wrongTurn: boolean }
  | { kind: "observe_queue"; deliveryIndex: number; status: "started" | "terminal" | "cancelled" | "failed" | "blocked" }
  | { kind: "advance"; minutes: number }
  | { kind: "stop"; outcome: "stopped" | "finish" }
  | { kind: "restart"; crash: boolean; eagerInit: boolean }
  | { kind: "resume"; all: boolean; approachIndex: number; notifyOutcome: NotifyOutcome }
  | { kind: "crash_during_revision_notify" }
  | { kind: "cancel_queued_resume_via_work" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("prepare" as const),
      workers: fc.integer({ min: 1, max: 3 }),
      minutes: fc.option(fc.integer({ min: 5, max: 60 }), { nil: undefined }),
      turnMinutes: fc.option(fc.integer({ min: 2, max: 30 }), { nil: undefined }),
      totalWorkerMinutes: fc.option(fc.integer({ min: 5, max: 60 }), { nil: undefined }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "withdraw" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("start_without_intent" as const),
      workers: fc.integer({ min: 1, max: 3 }),
      minutes: fc.option(fc.integer({ min: 5, max: 60 }), { nil: undefined }),
      turnMinutes: fc.option(fc.integer({ min: 2, max: 30 }), { nil: undefined }),
      totalWorkerMinutes: fc.option(fc.integer({ min: 5, max: 60 }), { nil: undefined }),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "start_with_intent" as const }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("finding" as const),
      actorSlot: fc.integer({ min: 0, max: 3 }),
      findingKind: fc.constantFrom<ResearchFindingKind>("lemma", "partial", "counterexample", "dead_end", "experiment", "file", "note"),
      useRel: fc.boolean(),
    }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("submit" as const), actorSlot: fc.integer({ min: 0, max: 3 }) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("review" as const),
      subIndex: fc.integer({ min: 0, max: 3 }),
      decision: fc.constantFrom<"accepted" | "rejected" | "revision_requested">("accepted", "rejected", "revision_requested"),
      notifyOutcome: fc.constantFrom<NotifyOutcome>("turn", "queued", "unknown", "throw"),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("assign" as const),
      targetKind: fc.constantFrom<"approach" | "finding" | "submission">("approach", "finding", "submission"),
      targetIndex: fc.integer({ min: 0, max: 3 }),
      spawnOutcome: fc.constantFrom<SpawnOutcome>("ok", "refused", "unknown_error", "no_turn"),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("work" as const),
      targetKind: fc.constantFrom<"approach" | "finding" | "submission">("approach", "finding", "submission"),
      targetIndex: fc.integer({ min: 0, max: 3 }),
      state: fc.constantFrom<"open" | "claimed" | "in_progress" | "blocked" | "completed" | "cancelled">("open", "claimed", "in_progress", "blocked", "completed", "cancelled"),
      asCoordinator: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("direction" as const),
      approachIndex: fc.integer({ min: 0, max: 3 }),
      abandon: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("bounds" as const),
      workers: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
      minutes: fc.option(fc.option(fc.integer({ min: 1, max: 90 }), { nil: null }), { nil: undefined }),
      turnMinutes: fc.option(fc.option(fc.integer({ min: 1, max: 40 }), { nil: null }), { nil: undefined }),
      totalWorkerMinutes: fc.option(fc.option(fc.integer({ min: 1, max: 90 }), { nil: null }), { nil: undefined }),
      asAgent: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("observe_start" as const),
      approachIndex: fc.integer({ min: 0, max: 3 }),
      placeholder: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("observe_end" as const),
      approachIndex: fc.integer({ min: 0, max: 3 }),
      failed: fc.boolean(),
      wrongTurn: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("observe_queue" as const),
      deliveryIndex: fc.integer({ min: 0, max: 3 }),
      status: fc.constantFrom<"started" | "terminal" | "cancelled" | "failed" | "blocked">("started", "terminal", "cancelled", "failed", "blocked"),
    }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("advance" as const), minutes: fc.integer({ min: 1, max: 20 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("stop" as const), outcome: fc.constantFrom<"stopped" | "finish">("stopped", "finish") }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("restart" as const), crash: fc.boolean(), eagerInit: fc.boolean() }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("resume" as const),
      all: fc.boolean(),
      approachIndex: fc.integer({ min: 0, max: 3 }),
      notifyOutcome: fc.constantFrom<NotifyOutcome>("turn", "queued", "unknown", "throw"),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "crash_during_revision_notify" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "cancel_queued_resume_via_work" as const }) },
);

describe("native research run lifecycle model", () => {
  it("preserves ownership, capacity, intent, bounds, cancellation, and restart invariants", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 5, maxLength: 35, size: "max" }),
        fc.constantFrom<CancelQueuedOutcome>("cancelled", "admitted", "throw"),
        fc.boolean(),
        async (ops, cancelQueuedBehavior, stopThrows) => {
          const storage = new MemoryResearchStorage();
          let now = START_TIME;
          let generation = 0;
          let workerSeq = 0;
          let turnSeq = 0;
          let queueSeq = 0;
          let cmdSeq = 0;
          let nextSpawnOutcome: SpawnOutcome = "ok";
          let nextNotifyOutcome: NotifyOutcome = "turn";
          const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
          const errors: unknown[] = [];
          const stoppedTurns: Array<{ threadId: string; turnId?: string }> = [];
          const cancelledQueues: string[] = [];

          const spawn: ResearchPorts["spawn"] = async (_ctx, _task, _title, _mode, onCreated) => {
            const id = ++workerSeq;
            const thread: ResearchThread = { backend: "codex", threadId: `w-${id}` };
            if (nextSpawnOutcome === "refused") throw new ResearchAdmissionRefused("Refused by test");
            onCreated(thread);
            if (nextSpawnOutcome === "unknown_error") throw new Error("Lost response");
            if (nextSpawnOutcome === "no_turn") return thread;
            return { ...thread, turnId: `t-${++turnSeq}` };
          };

          const notify: ResearchPorts["notify"] = async () => {
            if (nextNotifyOutcome === "throw") throw new Error("Notify failed");
            if (nextNotifyOutcome === "queued") return { queueEntryId: `q-${++queueSeq}` };
            if (nextNotifyOutcome === "turn") return { turnId: `t-${++turnSeq}` };
            return {};
          };

          const cancelQueued: ResearchPorts["cancelQueued"] = async (entryId) => {
            cancelledQueues.push(entryId);
            if (cancelQueuedBehavior === "throw") throw new Error("Queue cancel unknown");
            if (cancelQueuedBehavior === "admitted") return { turnId: `t-${++turnSeq}` };
            return {};
          };

          const stopPort: ResearchPorts["stop"] = async (worker) => {
            stoppedTurns.push({ threadId: worker.threadId, turnId: worker.turnId });
            if (stopThrows) throw new Error("Stop lost");
          };

          const launch = (eagerInit: boolean): ResearchService => {
            const gen = ++generation;
            const svc = new ResearchService(storage, {
              ownerId: `owner-${gen}`,
              ownerPid: 100 + gen,
              ownerStartedAt: now,
              isOwnerAlive: (o) => o.ownerId === `owner-${generation}`,
              now: () => now,
              schedule: (fn, delay) => {
                const t = { at: now + delay, fn, live: true };
                timers.push(t);
                return () => { t.live = false; };
              },
              spawn,
              stop: stopPort,
              notify,
              cancelQueued,
              changed: () => {},
              onError: (e) => { errors.push(e); },
            });
            if (eagerInit) svc.initialize();
            return svc;
          };

          const flush = async () => {
            for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
          };

          const advanceTo = async (target: number) => {
            for (;;) {
              const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
              if (!due) break;
              due.live = false;
              now = Math.max(now, due.at);
              due.fn();
              await flush();
            }
            now = target;
            await flush();
          };

          let service = launch(true);
          let runId: string | undefined;
          let preparedIntent: { intentId: string; workers: number; minutes?: number; turnMinutes?: number; totalWorkerMinutes?: number; expiresAt: number } | undefined;

          const makeRequest = (workers: number, minutes?: number, turnMinutes?: number, totalWorkerMinutes?: number, intentId?: string): StartResearchRequest => ({
            ...(intentId ? { intentId } : {}),
            objective: "Model test objective",
            ...(minutes !== undefined ? { minutes } : {}),
            ...(turnMinutes !== undefined ? { turnMinutes } : {}),
            ...(totalWorkerMinutes !== undefined ? { totalWorkerMinutes } : {}),
            workspaceMode: "none",
            approaches: Array.from({ length: workers }, (_, i) => ({ title: `Approach ${i + 1}`, task: `Task ${i + 1}` })),
          });

          const checkInvariants = () => {
            expect(errors).toEqual([]);
            const snap = service.snapshot(COORD);
            // Pending intent visibility must match expiry model
            if (preparedIntent && now < preparedIntent.expiresAt) {
              expect(snap.pending?.workers).toBe(preparedIntent.workers);
            } else {
              expect(snap.pending).toBeUndefined();
            }
            if (!runId) return;
            const rawEvents = storage.records.get(runId)!;
            const projected = projectResearchRun(runId, rawEvents);
            const live = service.read(runId, OP);
            expect(live).toEqual(projected);
            const header = storage.header(runId)!;
            expect(header.revision).toBe(projected.revision);
            expect(header.status).toBe(projected.status);
            expect(header.activeWorkers).toBe(projected.activeWorkers);
            expect(header.workerLimit).toBe(projected.workerLimit);
            expect(header.deadlineAt).toBe(projected.deadlineAt);
            expect(header.turnMinutes).toBe(projected.turnMinutes);
            expect(header.totalWorkerMinutes).toBe(projected.totalWorkerMinutes);
            // Active workers count must always match exact slot occupancy formula
            const occupied = projected.approaches.filter(researchApproachOccupiesSlot).length;
            expect(projected.activeWorkers).toBe(occupied);
            expect(projected.workerLimit).toBeGreaterThanOrEqual(1);
            expect(projected.workerLimit).toBeLessThanOrEqual(RESEARCH_MAX_WORKERS);
            // Command IDs in the journal must be strictly unique
            expect(new Set(rawEvents.map((e) => e.commandId)).size).toBe(rawEvents.length);
            // A terminal run (stopped/deadline/completed) must not leave open deliveries or running approaches
            if (["stopped", "deadline", "completed"].includes(projected.status)) {
              expect(projected.approaches.every((a) => !researchApproachOccupiesSlot(a))).toBe(true);
              expect(projected.deliveries.every((d) => ["cancelled", "ended"].includes(d.state))).toBe(true);
            }
            // No approach may ever carry a placeholder turnId
            for (const a of projected.approaches) {
              if (a.worker?.turnId) {
                expect(a.worker.turnId).not.toBe(`pending:${a.worker.threadId}`);
              }
            }
            // An approach reassigned to a focused child is never resumable and cannot stay
            // pending/starting/running (only an unsolicited turn whose stop threw may remain "unknown").
            const itemById = new Map(projected.items.map((item) => [item.id, item]));
            for (const item of projected.items) {
              if (item.type === "approach" && item.work.assignmentId && item.work.assignmentId !== item.id) {
                expect(researchApproachResumable(item.record, (id) => itemById.get(id))).toBe(false);
                expect(["pending", "starting", "running"]).not.toContain(item.record.state);
              }
            }
          };

          for (const op of ops) {
            cmdSeq++;
            if (op.kind === "prepare") {
              const res = service.prepare({
                ...COORD,
                objective: "Model test objective",
                workers: op.workers,
                ...(op.minutes !== undefined ? { minutes: op.minutes } : {}),
                ...(op.turnMinutes !== undefined ? { turnMinutes: op.turnMinutes } : {}),
                ...(op.totalWorkerMinutes !== undefined ? { totalWorkerMinutes: op.totalWorkerMinutes } : {}),
                workspaceMode: "none",
              });
              preparedIntent = {
                intentId: res.intentId,
                workers: op.workers,
                minutes: op.minutes,
                turnMinutes: op.turnMinutes,
                totalWorkerMinutes: op.totalWorkerMinutes,
                expiresAt: now + 5 * MINUTE,
              };
            } else if (op.kind === "withdraw") {
              service.withdraw(COORD);
              preparedIntent = undefined;
            } else if (op.kind === "start_without_intent") {
              const req = makeRequest(op.workers, op.minutes, op.turnMinutes, op.totalWorkerMinutes);
              nextSpawnOutcome = "ok";
              const intentActive = Boolean(preparedIntent && now < preparedIntent.expiresAt);
              const attempt = service.start(req, { ...COORD_AGENT, callId: `start-${cmdSeq}` });
              if (intentActive) {
                // Active prepared intent must block un-bound starts
                await expect(attempt).rejects.toThrow(/expired or was replaced/);
              } else {
                // No active pending intent (none prepared, withdrawn, OR EXPIRED!):
                // snapshot().pending is undefined, so starting without intentId MUST succeed!
                const started = await attempt;
                runId = started.id;
                preparedIntent = undefined;
              }
            } else if (op.kind === "start_with_intent") {
              if (preparedIntent) {
                const req = makeRequest(
                  preparedIntent.workers,
                  preparedIntent.minutes,
                  preparedIntent.turnMinutes,
                  preparedIntent.totalWorkerMinutes,
                  preparedIntent.intentId,
                );
                nextSpawnOutcome = "ok";
                const attempt = service.start(req, { ...COORD_AGENT, callId: `start-${cmdSeq}` });
                if (now >= preparedIntent.expiresAt) {
                  await expect(attempt).rejects.toThrow(/expired or was replaced/);
                } else {
                  const started = await attempt;
                  runId = started.id;
                  preparedIntent = undefined;
                }
              }
            } else if (!runId) {
              // Ensure we have a run for run-scoped ops
              const req = makeRequest(2, 30, 10, 40);
              nextSpawnOutcome = "ok";
              if (!preparedIntent || now >= preparedIntent.expiresAt) {
                try {
                  const started = await service.start(req, { ...COORD_AGENT, callId: `auto-${cmdSeq}` });
                  runId = started.id;
                  preparedIntent = undefined;
                } catch {
                  // Will be caught if expired intent blocks start!
                  throw new Error("Auto-start failed when no active intent existed");
                }
              }
            } else if (op.kind === "finding") {
              const run = service.read(runId, OP);
              const approach = run.approaches[op.actorSlot % run.approaches.length]!;
              const actor: ResearchActor = approach.worker ? { ...approach.worker, kind: "agent" } : COORD_AGENT;
              const rel = op.useRel && run.findings.length ? run.findings[0]!.id : undefined;
              await service.update(
                runId,
                `find-${cmdSeq}`,
                {
                  action: "finding",
                  approachId: approach.id,
                  kind: op.findingKind,
                  text: `Finding ${cmdSeq}`,
                  paths: ["src/a.ts"],
                  ...(rel ? { relatesTo: rel, relation: "supports" as const } : {}),
                },
                actor,
              ).catch(() => {});
            } else if (op.kind === "submit") {
              const run = service.read(runId, OP);
              const approach = run.approaches[op.actorSlot % run.approaches.length]!;
              const actor: ResearchActor = approach.worker ? { ...approach.worker, kind: "agent", turnId: approach.worker.turnId, callId: `sub-${cmdSeq}` } : COORD_AGENT;
              nextNotifyOutcome = "turn";
              await service.update(
                runId,
                `sub-${cmdSeq}`,
                { action: "submit", approachId: approach.id, text: `Submission ${cmdSeq}`, paths: ["src/sol.ts"] },
                actor,
              ).catch(() => {});
            } else if (op.kind === "review") {
              const run = service.read(runId, OP);
              if (run.submissions.length) {
                const sub = run.submissions[op.subIndex % run.submissions.length]!;
                nextNotifyOutcome = op.notifyOutcome;
                await service.update(
                  runId,
                  `rev-${cmdSeq}`,
                  { action: "review", submissionId: sub.id, decision: op.decision, reason: `Review ${cmdSeq}` },
                  OP,
                ).catch(() => {});
              }
            } else if (op.kind === "assign") {
              const run = service.read(runId, OP);
              const pool = run.items.filter((i) => i.type === op.targetKind);
              if (pool.length) {
                const target = pool[op.targetIndex % pool.length]!;
                nextSpawnOutcome = op.spawnOutcome;
                await service.assign(
                  { runId, itemId: target.id, expectedVersion: target.version, task: `Focus ${cmdSeq}` },
                  { ...COORD_AGENT, callId: `assign-${cmdSeq}` },
                ).catch(() => {});
              }
            } else if (op.kind === "work") {
              const run = service.read(runId, OP);
              const pool = run.items.filter((i) => i.type === op.targetKind);
              if (pool.length) {
                const target = pool[op.targetIndex % pool.length]!;
                const approach = run.approaches.find((a) => a.id === target.approachId);
                const actor: ResearchActor = op.asCoordinator || !approach?.worker ? OP : { ...approach.worker, kind: "agent" };
                await service.work(
                  runId,
                  `work-${cmdSeq}`,
                  { action: "work", itemId: target.id, expectedVersion: target.version, state: op.state, reason: `Work ${cmdSeq}` },
                  actor,
                ).catch(() => {});
              }
            } else if (op.kind === "direction") {
              const run = service.read(runId, OP);
              const approach = run.approaches[op.approachIndex % run.approaches.length]!;
              await service.update(
                runId,
                `dir-${cmdSeq}`,
                op.abandon
                  ? { action: "abandon", approachId: approach.id, reason: `Abandon ${cmdSeq}` }
                  : { action: "direction", approachId: approach.id, title: `Dir ${cmdSeq}`, task: `Task ${cmdSeq}`, reason: `Revise ${cmdSeq}` },
                OP,
              ).catch(() => {});
            } else if (op.kind === "bounds") {
              const actor = op.asAgent ? { ...COORD_AGENT, callId: `b-${cmdSeq}` } : OP;
              const cmd: Record<string, unknown> = { action: "bounds" };
              if (op.workers !== undefined) cmd.workers = op.workers;
              if (op.minutes !== undefined) cmd.minutes = op.minutes;
              if (op.turnMinutes !== undefined) cmd.turnMinutes = op.turnMinutes;
              if (op.totalWorkerMinutes !== undefined) cmd.totalWorkerMinutes = op.totalWorkerMinutes;
              const res = service.update(runId, `bounds-${cmdSeq}`, cmd as never, actor);
              if (op.asAgent) await expect(res).rejects.toThrow();
              else await res.catch(() => {});
            } else if (op.kind === "observe_start") {
              const run = service.read(runId, OP);
              const approach = run.approaches[op.approachIndex % run.approaches.length]!;
              if (approach.worker) {
                const tid = op.placeholder ? `pending:${approach.worker.threadId}` : `t-${++turnSeq}`;
                await service.observeStart(approach.worker, tid);
              }
            } else if (op.kind === "observe_end") {
              const run = service.read(runId, OP);
              const approach = run.approaches[op.approachIndex % run.approaches.length]!;
              if (approach.worker) {
                const tid = op.wrongTurn ? `wrong-${cmdSeq}` : (approach.worker.turnId ?? `t-${++turnSeq}`);
                service.observeEnd(approach.worker, tid, { failed: op.failed });
              }
            } else if (op.kind === "observe_queue") {
              const run = service.read(runId, OP);
              if (run.deliveries.length) {
                const d = run.deliveries[op.deliveryIndex % run.deliveries.length]!;
                if (d.queueEntryId) {
                  await service.observeQueue(d.target, d.queueEntryId, op.status, d.turnId ?? `t-${++turnSeq}`);
                }
              }
            } else if (op.kind === "advance") {
              await advanceTo(now + op.minutes * MINUTE);
            } else if (op.kind === "stop") {
              const run = service.read(runId, OP);
              const hasAccepted = run.submissions.some((s) => s.review?.decision === "accepted");
              const res = service.update(
                runId,
                `stop-${cmdSeq}`,
                { action: op.outcome === "finish" ? "finish" : "stop", reason: `Stop ${cmdSeq}` },
                OP,
              );
              if (op.outcome === "finish" && !hasAccepted) {
                await expect(res).rejects.toThrow(/Accept a submission/);
              } else {
                await res.catch(() => {});
              }
            } else if (op.kind === "restart") {
              if (!op.crash) service.close();
              for (const t of timers) t.live = false;
              preparedIntent = undefined;
              service = launch(op.eagerInit);
              await flush();
            } else if (op.kind === "resume") {
              const run = service.read(runId, OP);
              nextNotifyOutcome = op.notifyOutcome;
              const approach = run.approaches[op.approachIndex % run.approaches.length]!;
              await service.update(
                runId,
                `resume-${cmdSeq}`,
                op.all ? { action: "resume" } : { action: "resume", approachIds: [approach.id] },
                OP,
              ).catch(() => {});
            } else if (op.kind === "crash_during_revision_notify") {
              const run = service.read(runId, OP);
              if (run.status === "running" && run.submissions.length) {
                const sub = run.submissions[0]!;
                const approach = run.approaches.find((a) => a.id === sub.approachId);
                if (approach?.worker && !approach.revisionDeliveryIds?.length) {
                  // Simulate process crashing while notify() is still in flight (delivery is "pending")
                  const neverResolves = new Promise<{ queueEntryId?: string; turnId?: string }>(() => {});
                  const origNotify = notify;
                  void origNotify;
                  // Launch a dedicated crashing instance on the same storage
                  const crashGen = ++generation;
                  const crashing = new ResearchService(storage, {
                    ownerId: `owner-${crashGen}`,
                    ownerPid: 100 + crashGen,
                    ownerStartedAt: now,
                    isOwnerAlive: (o) => o.ownerId === `owner-${generation}`,
                    now: () => now,
                    schedule: () => () => {},
                    spawn,
                    stop: stopPort,
                    notify: () => neverResolves,
                    cancelQueued,
                    changed: () => {},
                    onError: () => {},
                  });
                  crashing.initialize();
                  // Kick off revision without awaiting (process dies mid-notify!)
                  void crashing.update(runId, `crash-rev-${cmdSeq}`, { action: "review", submissionId: sub.id, decision: "revision_requested", reason: "Revise" }, OP).catch(() => {});
                  // Now process dies and a replacement starts up and adopts the run!
                  for (const t of timers) t.live = false;
                  preparedIntent = undefined;
                  service = launch(true);
                  await flush();
                  // A pending delivery from a dead process MUST NOT stay open forever and wedge stop()!
                  const adopted = service.read(runId, OP);
                  expect(adopted.deliveries.filter((d) => d.state === "pending")).toEqual([]);
                }
              }
            } else if (op.kind === "cancel_queued_resume_via_work") {
              const run = service.read(runId, OP);
              const itemById = new Map(run.items.map((entry) => [entry.id, entry]));
              const reassignedCutOff = run.approaches.find((a) => {
                const own = itemById.get(a.id);
                return Boolean(a.interrupted && a.worker && own?.work.assignmentId && own.work.assignmentId !== a.id);
              });
              if (run.status === "running" && reassignedCutOff) {
                await expect(
                  service.update(runId, `qres-reassigned-${cmdSeq}`, { action: "resume", approachIds: [reassignedCutOff.id] }, OP),
                ).rejects.toThrow(/cannot be resumed/);
              }
              const cutOff = run.approaches.find((a) => researchApproachResumable(a, (id) => itemById.get(id)));
              if (run.status === "running" && cutOff && !stopThrows && cancelQueuedBehavior === "cancelled") {
                nextNotifyOutcome = "queued";
                const resumed = await service.update(runId, `qres-${cmdSeq}`, { action: "resume", approachIds: [cutOff.id] }, OP).catch(() => undefined);
                if (resumed) {
                  const item = service.readItem(runId, cutOff.id, OP).item;
                  if (["open", "assigned", "claimed", "in_progress", "blocked"].includes(item.work.state)) {
                    const cancelledBefore = cancelledQueues.length;
                    const stoppedBefore = stoppedTurns.length;
                    await service.work(runId, `cancel-qres-${cmdSeq}`, { action: "work", itemId: cutOff.id, expectedVersion: item.version, state: "cancelled", reason: "Cancel queued resume" }, OP);
                    // Cancelling an approach whose resume is queued MUST withdraw the queued resume,
                    // NOT try to stop the dead pre-restart turn!
                    expect(cancelledQueues.length).toBe(cancelledBefore + 1);
                    expect(stoppedTurns.length).toBe(stoppedBefore);
                  }
                }
              }
            }

            checkInvariants();
          }

          service.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Shrunk counterexample from 1,000-run model (seed -1007480912):
  // prepare(1) -> advance(5m) -> start_without_intent(1) failed forever because the
  // expired entry remained in `intents` even though `snapshot().pending` was undefined.
  it("allows direct start without intentId once a prepared intent has expired, while still refusing the expired intentId", async () => {
    const storage = new MemoryResearchStorage();
    let now = START_TIME;
    const service = new ResearchService(storage, {
      ownerId: "owner-1",
      ownerPid: 1,
      ownerStartedAt: now,
      isOwnerAlive: () => true,
      now: () => now,
      schedule: () => () => {},
      spawn: async (_c, _t, _title, _mode, onCreated) => {
        const w = { backend: "codex" as const, threadId: "w-1", turnId: "t-1" };
        onCreated(w);
        return w;
      },
      stop: async () => {},
      notify: async () => ({}),
      cancelQueued: async () => ({}),
      changed: () => {},
      onError: () => {},
    });
    const { intentId } = service.prepare({ ...COORD, objective: "Obj", workers: 1, workspaceMode: "none" });
    now += 5 * MINUTE;
    expect(service.snapshot(COORD).pending).toBeUndefined();
    const req: StartResearchRequest = { objective: "Obj", workspaceMode: "none", approaches: [{ title: "A1", task: "T1" }] };
    await expect(service.start({ ...req, intentId }, { ...COORD_AGENT, callId: "expired-id" })).rejects.toThrow(/expired or was replaced/);
    const started = await service.start(req, { ...COORD_AGENT, callId: "direct-start" });
    expect(started.status).toBe("running");
    service.close();
  });

  // Shrunk counterexample from 1,000-run model (seed -1043864587):
  // Crash while revision notify() is in flight left a "pending" delivery open after
  // adopt(), leaking a worker slot and wedging stop() in "stopping" forever.
  it("settles an in-flight pending revision delivery when a replacement owner adopts the run", async () => {
    const storage = new MemoryResearchStorage();
    let liveOwner = "owner-1";
    const makePorts = (ownerId: string, notify: ResearchPorts["notify"]): ResearchPorts => ({
      ownerId,
      ownerPid: 1,
      ownerStartedAt: START_TIME,
      isOwnerAlive: (o) => o.ownerId === liveOwner,
      now: () => START_TIME,
      schedule: () => () => {},
      spawn: async (_c, _t, _title, _mode, onCreated) => {
        const w = { backend: "codex" as const, threadId: "w-1", turnId: "t-1" };
        onCreated(w);
        return w;
      },
      stop: async () => {},
      notify,
      cancelQueued: async () => ({}),
      changed: () => {},
      onError: () => {},
    });
    const first = new ResearchService(storage, makePorts("owner-1", () => new Promise(() => {})));
    const started = await first.start({ objective: "Obj", workspaceMode: "none", approaches: [{ title: "A1", task: "T1" }] }, COORD_AGENT);
    await first.update(started.id, "sub-1", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, COORD_AGENT);
    const subId = first.read(started.id, OP).submissions[0]!.id;
    void first.update(started.id, "rev-1", { action: "review", submissionId: subId, decision: "revision_requested", reason: "Revise" }, OP).catch(() => {});
    expect(first.read(started.id, OP).deliveries[0]?.state).toBe("pending");
    liveOwner = "owner-2";
    const second = new ResearchService(storage, makePorts("owner-2", async () => ({})));
    second.initialize();
    const adopted = second.read(started.id, OP);
    expect(adopted.deliveries[0]?.state).toBe("ended");
    expect(adopted.activeWorkers).toBe(0);
    const stopped = await second.update(started.id, "stop-1", { action: "stop", reason: "Stop" }, OP);
    expect(stopped.status).toBe("stopped");
    second.close();
  });

  // Shrunk counterexample from 1,000-run model (seed 2110435440):
  // work(state: "cancelled") on an approach whose resume is queued called ports.stop
  // on the dead pre-restart turn instead of withdrawing the queued resume message.
  it("withdraws a queued resume instead of stopping the pre-restart turn when work cancels an approach", async () => {
    const storage = new MemoryResearchStorage();
    let liveOwner = "owner-1";
    const stopped: Array<{ threadId: string; turnId?: string }> = [];
    const cancelledQueues: string[] = [];
    const makePorts = (ownerId: string): ResearchPorts => ({
      ownerId,
      ownerPid: 1,
      ownerStartedAt: START_TIME,
      isOwnerAlive: (o) => o.ownerId === liveOwner,
      now: () => START_TIME,
      schedule: () => () => {},
      spawn: async (_c, _t, _title, _mode, onCreated) => {
        const w = { backend: "codex" as const, threadId: "w-1", turnId: "t-old" };
        onCreated(w);
        return w;
      },
      stop: async (w) => { stopped.push({ threadId: w.threadId, turnId: w.turnId }); },
      notify: async () => ({ queueEntryId: "q-resume-1" }),
      cancelQueued: async (entry) => { cancelledQueues.push(entry); return {}; },
      changed: () => {},
      onError: () => {},
    });
    const first = new ResearchService(storage, makePorts("owner-1"));
    const started = await first.start({ objective: "Obj", workspaceMode: "none", approaches: [{ title: "A1", task: "T1" }] }, COORD_AGENT);
    first.close();
    liveOwner = "owner-2";
    const second = new ResearchService(storage, makePorts("owner-2"));
    second.initialize();
    await second.update(started.id, "resume-1", { action: "resume", approachIds: ["a1"] }, OP);
    const item = second.readItem(started.id, "a1", OP).item;
    const cancelled = await second.work(started.id, "cancel-1", { action: "work", itemId: "a1", expectedVersion: item.version, state: "cancelled", reason: "Cancel" }, OP);
    expect(cancelled.work.state).toBe("cancelled");
    expect(cancelledQueues).toEqual(["q-resume-1"]);
    expect(stopped).toEqual([]);
    second.close();
  });

  // Cancelling an approach while resume() is awaiting ports.notify() must wait for
  // the in-flight resume receipt instead of stopping the stale pre-restart turn, then
  // withdraw the new queued resume or stop the new resumed turn and settle cancellation.
  it.each(["turn", "queued"] as const)("defers work cancellation while resume() notify is in flight (%s receipt)", async (receiptKind) => {
    const storage = new MemoryResearchStorage();
    let liveOwner = "owner-1";
    const stopped: Array<{ threadId: string; turnId?: string }> = [];
    const cancelledQueues: string[] = [];
    let resolveNotify!: (receipt: { queueEntryId?: string; turnId?: string }) => void;
    const notifyPromise = new Promise<{ queueEntryId?: string; turnId?: string }>((resolve) => {
      resolveNotify = resolve;
    });
    let notifyStarted = false;
    const makePorts = (ownerId: string): ResearchPorts => ({
      ownerId,
      ownerPid: 1,
      ownerStartedAt: START_TIME,
      isOwnerAlive: (o) => o.ownerId === liveOwner,
      now: () => START_TIME,
      schedule: () => () => {},
      spawn: async (_c, _t, _title, _mode, onCreated) => {
        const w = { backend: "codex" as const, threadId: "w-1", turnId: "t-old" };
        onCreated(w);
        return w;
      },
      stop: async (w) => { stopped.push({ threadId: w.threadId, turnId: w.turnId }); },
      notify: async () => {
        notifyStarted = true;
        return await notifyPromise;
      },
      cancelQueued: async (entry) => { cancelledQueues.push(entry); return {}; },
      changed: () => {},
      onError: () => {},
    });
    const first = new ResearchService(storage, makePorts("owner-1"));
    const started = await first.start({ objective: "Obj", workspaceMode: "none", approaches: [{ title: "A1", task: "T1" }] }, COORD_AGENT);
    first.close();
    liveOwner = "owner-2";
    const second = new ResearchService(storage, makePorts("owner-2"));
    second.initialize();

    const resumePromise = second.update(started.id, "resume-1", { action: "resume", approachIds: ["a1"] }, OP);
    expect(notifyStarted).toBe(true);

    const item = second.readItem(started.id, "a1", OP).item;
    const cancelDuringResume = await second.work(
      started.id,
      "cancel-inflight-1",
      { action: "work", itemId: "a1", expectedVersion: item.version, state: "cancelled", reason: "Cancel during resume" },
      OP,
    );
    // Must stay cancel_requested while resume is in flight and never stop the stale pre-restart turn.
    expect(cancelDuringResume.work.state).toBe("cancel_requested");
    expect(stopped).toEqual([]);

    resolveNotify(receiptKind === "turn" ? { turnId: "t-new" } : { queueEntryId: "q-new" });
    await resumePromise;

    const settled = second.readItem(started.id, "a1", OP).item;
    expect(settled.work.state).toBe("cancelled");
    if (receiptKind === "turn") {
      expect(stopped).toEqual([{ threadId: "w-1", turnId: "t-new" }]);
      expect(cancelledQueues).toEqual([]);
    } else {
      expect(cancelledQueues).toEqual(["q-new"]);
      expect(stopped).toEqual([]);
    }
    expect(second.read(started.id, OP).activeWorkers).toBe(0);
    second.close();
  });

  // Property/model test for stale queued coordinator review notices:
  // Any queued coordinator submission notice must be withdrawn once its submission
  // is reviewed or the run stops/finishes/deadlines (unless observeQueue already
  // retired it with a non-blocked status), never stopping the coordinator thread
  // or wedging stop on errors. A "blocked" queue event keeps the entry held at
  // the head of the FIFO so it must still be withdrawn on review or run end.
  it("withdraws queued coordinator review notices on review, finish, stop, or deadline across generated interleavings", async () => {
    const stepArb = fc.oneof(
      fc.record({ kind: fc.constant("submit" as const), workerIndex: fc.integer({ min: 0, max: 3 }) }),
      fc.record({
        kind: fc.constant("review" as const),
        subIndex: fc.integer({ min: 0, max: 7 }),
        decision: fc.constantFrom<"accepted" | "rejected" | "revision_requested">("accepted", "rejected", "revision_requested"),
      }),
      fc.record({
        kind: fc.constant("observe_queue" as const),
        queueIndex: fc.integer({ min: 0, max: 7 }),
        status: fc.constantFrom<"started" | "cancelled" | "terminal" | "failed" | "blocked">("started", "cancelled", "terminal", "failed", "blocked"),
      }),
      fc.record({
        kind: fc.constant("end" as const),
        outcome: fc.constantFrom<"finish" | "stop" | "deadline">("finish", "stop", "deadline"),
      }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 4, maxLength: 18 }),
        fc.constantFrom<"cancelled" | "admitted" | "throw">("cancelled", "admitted", "throw"),
        async (steps, cancelBehavior) => {
          const storage = new MemoryResearchStorage();
          let workerSeq = 0;
          let queueSeq = 0;
          let turnSeq = 0;
          const queuedOnCoordinator = new Map<string, string>(); // submissionId -> queueEntryId (model)
          const pendingNoticeByQueue = new Map<string, string>(); // queueEntryId -> submissionId (model)
          const retiredByObserveQueue = new Set<string>(); // coordinator notices retired by observeQueue
          const cancelledIds: string[] = [];
          const stoppedThreads: string[] = [];

          const service = new ResearchService(storage, {
            ownerId: "owner-1",
            ownerPid: 1,
            ownerStartedAt: START_TIME,
            isOwnerAlive: () => true,
            now: () => START_TIME,
            schedule: () => () => {},
            spawn: async (_c, _t, _title, _mode, onCreated) => {
              const id = ++workerSeq;
              const w = { backend: "codex" as const, threadId: `w-${id}`, turnId: `t-${id}` };
              onCreated(w);
              return w;
            },
            stop: async (w) => { stoppedThreads.push(w.threadId); },
            notify: async (_actor, target) => {
              if (target.threadId === COORD.threadId) {
                return { queueEntryId: `q-coord-${++queueSeq}` };
              }
              return { turnId: `t-rev-${++turnSeq}` };
            },
            cancelQueued: async (entryId) => {
              cancelledIds.push(entryId);
              if (cancelBehavior === "throw") throw new Error("Queue cancel error");
              if (cancelBehavior === "admitted") return { turnId: `t-admitted-${++turnSeq}` };
              return {};
            },
            changed: () => {},
            onError: () => {},
          });

          const started = await service.start(
            {
              objective: "Coord queue model",
              workspaceMode: "none",
              approaches: [
                { title: "A1", task: "T1" },
                { title: "A2", task: "T2" },
                { title: "A3", task: "T3" },
                { title: "A4", task: "T4" },
              ],
            },
            COORD_AGENT,
          );
          const runId = started.id;
          let seq = 0;

          for (const step of steps) {
            seq++;
            const run = service.read(runId, OP);
            if (step.kind === "submit") {
              if (run.status !== "running") continue;
              const approach = run.approaches[step.workerIndex % run.approaches.length]!;
              if (!approach.worker) continue;
              const beforeSubIds = new Set(run.submissions.map((s) => s.id));
              const beforeQueue = queueSeq;
              await service.update(
                runId,
                `sub-${seq}`,
                { action: "submit", approachId: approach.id, text: `Cand ${seq}`, paths: [] },
                { ...approach.worker, kind: "agent", turnId: approach.worker.turnId, callId: `call-${seq}` },
              );
              const after = service.read(runId, OP);
              const created = after.submissions.find((s) => !beforeSubIds.has(s.id));
              if (created && queueSeq > beforeQueue) {
                const qid = `q-coord-${queueSeq}`;
                queuedOnCoordinator.set(created.id, qid);
                pendingNoticeByQueue.set(qid, created.id);
              }
            } else if (step.kind === "review") {
              if (!run.submissions.length) continue;
              const sub = run.submissions[step.subIndex % run.submissions.length]!;
              if (step.decision === "revision_requested") {
                const approach = run.approaches.find((a) => a.id === sub.approachId);
                const eligible = run.status === "running"
                  && Boolean(approach?.worker)
                  && !approach?.revisionDeliveryIds?.length
                  && (approach ? researchApproachOccupiesSlot(approach) || run.activeWorkers < run.workerLimit : false);
                if (!eligible) continue;
              }
              await service.update(
                runId,
                `rev-${seq}`,
                { action: "review", submissionId: sub.id, decision: step.decision, reason: `Review ${seq}` },
                OP,
              );
              const expectedCancel = queuedOnCoordinator.get(sub.id);
              if (expectedCancel) {
                expect(cancelledIds).toContain(expectedCancel);
                queuedOnCoordinator.delete(sub.id);
                pendingNoticeByQueue.delete(expectedCancel);
              }
            } else if (step.kind === "observe_queue") {
              const entries = [...pendingNoticeByQueue.keys()];
              if (!entries.length) continue;
              const qid = entries[step.queueIndex % entries.length]!;
              const turnId = step.status === "started" || step.status === "terminal" ? `t-coord-${++turnSeq}` : undefined;
              await service.observeQueue(COORD, qid, step.status, turnId);
              if (step.status !== "blocked") {
                const subId = pendingNoticeByQueue.get(qid)!;
                pendingNoticeByQueue.delete(qid);
                queuedOnCoordinator.delete(subId);
                retiredByObserveQueue.add(qid);
              }
            } else if (step.kind === "end") {
              if (run.status !== "running") continue;
              const hasAccepted = run.submissions.some((s) => s.review?.decision === "accepted");
              if (step.outcome === "finish" && !hasAccepted) continue;
              const ended = step.outcome === "deadline"
                ? await service.stop(runId, OP, "deadline", "Deadline")
                : await service.update(runId, `end-${seq}`, { action: step.outcome, reason: "End" }, OP);
              // Stop/finish/deadline must settle cleanly (never wedged in "stopping" by coordinator notice cancel errors).
              expect(ended.status).toBe(step.outcome === "finish" ? "completed" : step.outcome === "deadline" ? "deadline" : "stopped");
              for (const qid of queuedOnCoordinator.values()) {
                expect(cancelledIds).toContain(qid);
              }
              queuedOnCoordinator.clear();
              pendingNoticeByQueue.clear();
            }

            // Coordinator thread must NEVER be stopped by review-notice cleanup.
            expect(stoppedThreads).not.toContain(COORD.threadId);
            // Each queued coordinator notice is cancelled at most once.
            expect(new Set(cancelledIds).size).toBe(cancelledIds.length);
            // Notices already retired by observeQueue (non-blocked) must never be passed to cancelQueued later.
            for (const retiredId of retiredByObserveQueue) {
              expect(cancelledIds).not.toContain(retiredId);
            }
          }

          service.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Cancellation fence for revision_requested: review must dispatch worker notify()
  // before awaiting coordinator notice cancellation, so no async window opens between
  // canAdmitApproach() and ports.notify() for stop()/close() to interleave.
  it("dispatches revision notify() before cancelling the stale coordinator review notice and does not double-cancel on concurrent stop", async () => {
    const storage = new MemoryResearchStorage();
    const events: string[] = [];
    let releaseWorkerNotify!: (receipt: { turnId?: string }) => void;
    const workerNotifyPromise = new Promise<{ turnId?: string }>((resolve) => { releaseWorkerNotify = resolve; });
    const service = new ResearchService(storage, {
      ownerId: "owner-1",
      ownerPid: 1,
      ownerStartedAt: START_TIME,
      isOwnerAlive: () => true,
      now: () => START_TIME,
      schedule: () => () => {},
      spawn: async (_c, _t, _title, _mode, onCreated) => {
        const w = { backend: "codex" as const, threadId: "w-1", turnId: "t-1" };
        onCreated(w);
        return w;
      },
      stop: async () => {},
      notify: async (_actor, target) => {
        if (target.threadId === COORD.threadId) return { queueEntryId: "q-coord-1" };
        events.push("notify:worker");
        return await workerNotifyPromise;
      },
      cancelQueued: async (entryId) => {
        events.push(`cancel:${entryId}`);
        return {};
      },
      changed: () => {},
      onError: () => {},
    });

    const started = await service.start({ objective: "Obj", workspaceMode: "none", approaches: [{ title: "A1", task: "T1" }] }, COORD_AGENT);
    const worker = service.read(started.id, OP).approaches[0]!.worker!;
    await service.update(
      started.id,
      "sub-1",
      { action: "submit", approachId: "a1", text: "Candidate", paths: [] },
      { ...worker, kind: "agent", turnId: worker.turnId, callId: "c-1" },
    );
    const subId = service.read(started.id, OP).submissions[0]!.id;

    // Starting a revision_requested review must invoke ports.notify(worker) synchronously
    // before any cancelQueued(q-coord-1) await can open a cancellation-fence gap.
    const reviewPromise = service.update(
      started.id,
      "rev-1",
      { action: "review", submissionId: subId, decision: "revision_requested", reason: "Fix it" },
      OP,
    );
    expect(events).toEqual(["notify:worker"]);

    // Concurrent stop while revision notify() is in flight cancels the queued coordinator
    // notice immediately; once notify() resolves, review does not double-cancel it.
    const stopPromise = service.stop(started.id, OP, "stopped", "Operator stop");
    releaseWorkerNotify({ turnId: "t-rev-1" });
    await Promise.all([reviewPromise, stopPromise]);

    expect(events.filter((e) => e === "cancel:q-coord-1")).toHaveLength(1);
    expect(service.read(started.id, OP).status).toBe("stopped");
    service.close();
  });

  // Late notify() race: a worker submission's notify() resolves with a queueEntryId
  // after the submission was reviewed, or while the submission is STILL UNREVIEWED
  // after the run finished (via another accepted submission), stopped, or closed.
  it.each(["reviewed", "finished", "stopped", "closed"] as const)(
    "cancels a late coordinator review notice queued after %s",
    async (race) => {
      const storage = new MemoryResearchStorage();
      let resolveLateNotify!: (receipt: { queueEntryId?: string; turnId?: string }) => void;
      const lateNotifyPromise = new Promise<{ queueEntryId?: string; turnId?: string }>((resolve) => { resolveLateNotify = resolve; });
      const cancelled: string[] = [];
      const stopped: string[] = [];
      let notifyCount = 0;
      const service = new ResearchService(storage, {
        ownerId: "owner-1",
        ownerPid: 1,
        ownerStartedAt: START_TIME,
        isOwnerAlive: () => true,
        now: () => START_TIME,
        schedule: () => () => {},
        spawn: async (_c, _t, title, _mode, onCreated) => {
          const idx = title === "A1" ? 1 : 2;
          const w = { backend: "codex" as const, threadId: `w-${idx}`, turnId: `t-${idx}` };
          onCreated(w);
          return w;
        },
        stop: async (w) => { stopped.push(w.threadId); },
        notify: async () => {
          notifyCount++;
          if (race === "finished" && notifyCount === 1) return { queueEntryId: "q-accepted-coord" };
          return await lateNotifyPromise;
        },
        cancelQueued: async (entryId) => { cancelled.push(entryId); return {}; },
        changed: () => {},
        onError: () => {},
      });

      const approaches = race === "finished"
        ? [{ title: "A1", task: "T1" }, { title: "A2", task: "T2" }]
        : [{ title: "A1", task: "T1" }];
      const started = await service.start({ objective: "Obj", workspaceMode: "none", approaches }, COORD_AGENT);
      const run = service.read(started.id, OP);

      if (race === "finished") {
        // Accept A1's submission so finish succeeds, while A2's submission remains UNREVIEWED.
        const w1 = run.approaches[0]!.worker!;
        await service.update(
          started.id,
          "sub-a1",
          { action: "submit", approachId: "a1", text: "Accepted candidate", paths: [] },
          { ...w1, kind: "agent", turnId: w1.turnId, callId: "c-a1" },
        );
        const subA1 = service.read(started.id, OP).submissions[0]!.id;
        await service.update(started.id, "rev-a1", { action: "review", submissionId: subA1, decision: "accepted", reason: "Good" }, OP);
        cancelled.length = 0;

        const w2 = run.approaches[1]!.worker!;
        const lateSubmit = service.update(
          started.id,
          "sub-a2",
          { action: "submit", approachId: "a2", text: "Unreviewed candidate", paths: [] },
          { ...w2, kind: "agent", turnId: w2.turnId, callId: "c-a2" },
        );
        await service.update(started.id, "fin-1", { action: "finish", reason: "Done" }, OP);
        // Confirm A2's submission is genuinely unreviewed so only current.status !== "running" triggers cancellation.
        const subA2 = service.read(started.id, OP).submissions.find((s) => s.approachId === "a2")!;
        expect(subA2.review).toBeUndefined();
        resolveLateNotify({ queueEntryId: "q-late-coord" });
        await lateSubmit;
      } else {
        const w1 = run.approaches[0]!.worker!;
        const lateSubmit = service.update(
          started.id,
          "sub-1",
          { action: "submit", approachId: "a1", text: "Candidate", paths: [] },
          { ...w1, kind: "agent", turnId: w1.turnId, callId: "c-1" },
        );
        const subId = service.read(started.id, OP).submissions[0]!.id;
        if (race === "reviewed") {
          await service.update(started.id, "rev-1", { action: "review", submissionId: subId, decision: "accepted", reason: "Good" }, OP);
        } else if (race === "stopped") {
          await service.stop(started.id, OP, "stopped", "Stopped");
          expect(service.read(started.id, OP).submissions[0]!.review).toBeUndefined();
        } else {
          service.close();
        }
        resolveLateNotify({ queueEntryId: "q-late-coord" });
        await lateSubmit;
      }

      expect(cancelled).toEqual(["q-late-coord"]);
      expect(stopped).not.toContain(COORD.threadId);
      service.close();
    },
  );

  // Shrunk counterexample from model seed -1110052618:
  // restart (leaves a1 interrupted) -> assign focused child onto a1 ->
  // update(resume, [a1]) -> work(itemId: a1, state: "cancelled").
  // Resuming an interrupted approach that already has a focused child must be
  // refused (and skipped by resume-all), so a1 never holds both a focused child
  // and its own queued resume. Reopening a1 after cancelling the child restores
  // resumability cleanly.
  it("refuses resuming an interrupted approach that has a focused assignment, and allows resuming again only after reopening", async () => {
    const storage = new MemoryResearchStorage();
    let liveOwner = "owner-1";
    let workerSeq = 0;
    let queueSeq = 0;
    const notified: string[] = [];
    const stopped: Array<{ threadId: string; turnId?: string }> = [];
    const cancelledQueues: string[] = [];
    const makePorts = (ownerId: string): ResearchPorts => ({
      ownerId,
      ownerPid: 1,
      ownerStartedAt: START_TIME,
      isOwnerAlive: (o) => o.ownerId === liveOwner,
      now: () => START_TIME,
      schedule: () => () => {},
      spawn: async (_c, _t, _title, _mode, onCreated) => {
        const id = ++workerSeq;
        const w = { backend: "codex" as const, threadId: `w-${id}`, turnId: `t-${id}` };
        onCreated(w);
        return w;
      },
      stop: async (w) => { stopped.push({ threadId: w.threadId, turnId: w.turnId }); },
      notify: async (_actor, target) => {
        notified.push(target.threadId);
        return { queueEntryId: `q-${++queueSeq}` };
      },
      cancelQueued: async (entry) => { cancelledQueues.push(entry); return {}; },
      changed: () => {},
      onError: () => {},
    });

    const first = new ResearchService(storage, makePorts("owner-1"));
    const started = await first.start(
      {
        objective: "Obj",
        workspaceMode: "none",
        approaches: [
          { title: "A1", task: "T1" },
          { title: "A2", task: "T2" },
        ],
      },
      COORD_AGENT,
    );
    first.close();

    liveOwner = "owner-2";
    const second = new ResearchService(storage, makePorts("owner-2"));
    second.initialize();

    const a1Before = second.readItem(started.id, "a1", OP).item;
    const child = await second.assign(
      { runId: started.id, itemId: "a1", expectedVersion: a1Before.version, task: "Focus on A1" },
      { ...COORD_AGENT, callId: "assign-a1" },
    );

    await expect(
      second.update(started.id, "resume-a1-reassigned", { action: "resume", approachIds: ["a1"] }, OP),
    ).rejects.toThrow(/cannot be resumed/);
    expect(notified).toEqual([]);

    // Resume-all must skip reassigned a1 and resume only a2.
    await second.update(started.id, "resume-all-1", { action: "resume" }, OP);
    expect(notified).toEqual(["w-2"]);

    // Another restart cuts off the focused child too; resume-all must resume the
    // child and a2, never the replaced a1.
    second.close();
    liveOwner = "owner-3";
    const third = new ResearchService(storage, makePorts("owner-3"));
    third.initialize();
    notified.length = 0;
    await third.update(started.id, "resume-all-2", { action: "resume" }, OP);
    expect(notified.sort()).toEqual(["w-2", child.worker!.threadId].sort());

    // Cancelling a1 withdraws the focused child's queued resume, then reopening
    // a1 clears the focused assignment so a1 itself can be resumed and cancelled cleanly.
    const a1Assigned = third.readItem(started.id, "a1", OP).item;
    const a1Cancelled = await third.work(
      started.id,
      "cancel-a1-child",
      { action: "work", itemId: "a1", expectedVersion: a1Assigned.version, state: "cancelled", reason: "Cancel focused child" },
      OP,
    );
    expect(a1Cancelled.work.state).toBe("cancelled");
    expect(cancelledQueues).toHaveLength(1);
    expect(stopped).toEqual([]);

    const a1Reopened = await third.work(
      started.id,
      "reopen-a1",
      { action: "work", itemId: "a1", expectedVersion: a1Cancelled.version, state: "open", reason: "Reopen A1" },
      OP,
    );
    expect(a1Reopened.work.state).toBe("open");

    notified.length = 0;
    await third.update(started.id, "resume-a1-reopened", { action: "resume", approachIds: ["a1"] }, OP);
    expect(notified).toEqual(["w-1"]);

    const a1Resumed = third.readItem(started.id, "a1", OP).item;
    const cancelledBefore = cancelledQueues.length;
    const a1CancelledOwn = await third.work(
      started.id,
      "cancel-a1-own",
      { action: "work", itemId: "a1", expectedVersion: a1Resumed.version, state: "cancelled", reason: "Cancel A1 queued resume" },
      OP,
    );
    expect(a1CancelledOwn.work.state).toBe("cancelled");
    expect(cancelledQueues).toHaveLength(cancelledBefore + 1);
    expect(stopped).toEqual([]);
    third.close();
  });

  // Assigning a focused child onto an approach whose own worker still occupies a
  // slot (running or queued resume) must be refused even when workerLimit has room.
  it("refuses assigning a focused child to an approach whose own worker is active or has a queued resume", async () => {
    const storage = new MemoryResearchStorage();
    let liveOwner = "owner-1";
    let workerSeq = 0;
    const cancelledQueues: string[] = [];
    const makePorts = (ownerId: string): ResearchPorts => ({
      ownerId,
      ownerPid: 1,
      ownerStartedAt: START_TIME,
      isOwnerAlive: (o) => o.ownerId === liveOwner,
      now: () => START_TIME,
      schedule: () => () => {},
      spawn: async (_c, _t, _title, _mode, onCreated) => {
        const id = ++workerSeq;
        const w = { backend: "codex" as const, threadId: `w-${id}`, turnId: `t-${id}` };
        onCreated(w);
        return w;
      },
      stop: async () => {},
      notify: async () => ({ queueEntryId: "q-resume-a1" }),
      cancelQueued: async (entry) => { cancelledQueues.push(entry); return {}; },
      changed: () => {},
      onError: () => {},
    });

    const first = new ResearchService(storage, makePorts("owner-1"));
    const started = await first.start(
      {
        objective: "Obj",
        workspaceMode: "none",
        approaches: [
          { title: "A1", task: "T1" },
          { title: "A2", task: "T2" },
        ],
      },
      COORD_AGENT,
    );
    // Free a slot by ending a2 so workerLimit (2) is not the reason assign rejects.
    const w2 = first.read(started.id, OP).approaches[1]!.worker!;
    first.observeEnd(w2, w2.turnId!);
    const a1Running = first.readItem(started.id, "a1", OP).item;
    await expect(
      first.assign({ runId: started.id, itemId: "a1", expectedVersion: a1Running.version, task: "Focus while running" }, { ...COORD_AGENT, callId: "assign-running" }),
    ).rejects.toThrow(/prior assignment is still active/);

    first.close();
    liveOwner = "owner-2";
    const second = new ResearchService(storage, makePorts("owner-2"));
    second.initialize();
    await second.update(started.id, "resume-a1", { action: "resume", approachIds: ["a1"] }, OP);
    const a1Queued = second.readItem(started.id, "a1", OP).item;
    await expect(
      second.assign({ runId: started.id, itemId: "a1", expectedVersion: a1Queued.version, task: "Focus while resume queued" }, { ...COORD_AGENT, callId: "assign-queued" }),
    ).rejects.toThrow(/prior assignment is still active/);

    const cancelled = await second.work(
      started.id,
      "cancel-a1",
      { action: "work", itemId: "a1", expectedVersion: a1Queued.version, state: "cancelled", reason: "Cancel queued resume" },
      OP,
    );
    expect(cancelled.work.state).toBe("cancelled");
    expect(cancelledQueues).toEqual(["q-resume-a1"]);
    expect(second.read(started.id, OP).activeWorkers).toBe(0);
    second.close();
  });

  // Defense-in-depth: if an unsolicited turn on a reassigned approach's old thread
  // failed to stop (leaving it "unknown" alongside the focused child), cancelling
  // the approach item via work() stops both before settling to "cancelled".
  it("cancels both the focused child and an unresolved own-approach turn before settling item cancellation", async () => {
    const storage = new MemoryResearchStorage();
    let liveOwner = "owner-1";
    let workerSeq = 0;
    let failStop = false;
    const stopped: Array<{ threadId: string; turnId?: string }> = [];
    const makePorts = (ownerId: string): ResearchPorts => ({
      ownerId,
      ownerPid: 1,
      ownerStartedAt: START_TIME,
      isOwnerAlive: (o) => o.ownerId === liveOwner,
      now: () => START_TIME,
      schedule: () => () => {},
      spawn: async (_c, _t, _title, _mode, onCreated) => {
        const id = ++workerSeq;
        const w = { backend: "codex" as const, threadId: `w-${id}`, turnId: `t-${id}` };
        onCreated(w);
        return w;
      },
      stop: async (w) => {
        stopped.push({ threadId: w.threadId, turnId: w.turnId });
        if (failStop) throw new Error("Stop lost");
      },
      notify: async () => ({}),
      cancelQueued: async () => ({}),
      changed: () => {},
      onError: () => {},
    });

    const first = new ResearchService(storage, makePorts("owner-1"));
    const started = await first.start(
      {
        objective: "Obj",
        workspaceMode: "none",
        approaches: [
          { title: "A1", task: "T1" },
          { title: "A2", task: "T2" },
        ],
      },
      COORD_AGENT,
    );
    first.close();

    liveOwner = "owner-2";
    const second = new ResearchService(storage, makePorts("owner-2"));
    second.initialize();
    const a1Before = second.readItem(started.id, "a1", OP).item;
    const child = await second.assign(
      { runId: started.id, itemId: "a1", expectedVersion: a1Before.version, task: "Focus on A1" },
      { ...COORD_AGENT, callId: "assign-a1" },
    );

    // Unsolicited start on a1's old worker fails to stop, leaving a1 "unknown" alongside child.
    failStop = true;
    await second.observeStart({ backend: "codex", threadId: "w-1" }, "t-stray");
    expect(second.read(started.id, OP).approaches.find((a) => a.id === "a1")?.state).toBe("unknown");

    // Now stop succeeds: work(cancelled) on a1 must stop both the focused child and a1's stray turn.
    failStop = false;
    stopped.length = 0;
    const a1Current = second.readItem(started.id, "a1", OP).item;
    const cancelled = await second.work(
      started.id,
      "cancel-both",
      { action: "work", itemId: "a1", expectedVersion: a1Current.version, state: "cancelled", reason: "Cancel A1 and child" },
      OP,
    );
    expect(cancelled.work.state).toBe("cancelled");
    expect(stopped).toEqual([
      { threadId: child.worker!.threadId, turnId: child.worker!.turnId },
      { threadId: "w-1", turnId: "t-stray" },
    ]);
    expect(second.read(started.id, OP).activeWorkers).toBe(0);
    second.close();
  });
});
