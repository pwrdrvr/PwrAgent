import fc from "fast-check";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AutomationRunOwner, AutomationRunSummary } from "@pwragent/shared";
import { AutomationStore } from "../storage/automation-store";
import type { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openFreshStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

/**
 * PWR-201. The rules, from the issue and PRD requirement R6:
 *
 * - A process changes the terminal state of an automation run only if it owns
 *   the run or has proved the owner dead.
 * - A run with no recorded owner cannot prove a live owner and is treated as
 *   dead.
 * - After recovery, every run that was not terminal is interrupted exactly
 *   once, and no terminal run changes.
 *
 * Each "instance" is its own connection to one database file with its own
 * owner identity, as two PwrAgent processes on one profile are.
 */

const TERMINAL = ["completed", "failed", "cancelled", "skipped"] as const;
type Terminal = (typeof TERMINAL)[number];
const AUTOMATION_COUNT = 2;

let tempDir: string;
let dbPath: string;
let connections: StateDb[];
let template: StateDb;

beforeEach(() => {
  ({ tempDir, dbPath } = createTempStateDb("pwragent-automation-reconcile-"));
  connections = [];
  // Hold the file open so later connections are second connections.
  template = openFreshStateDb(dbPath);
});

afterEach(() => {
  for (const db of connections) db.close();
  template.close();
  removeTempStateDbDir(tempDir);
});

type Instance = { owner?: AutomationRunOwner; store: AutomationStore };

function openInstance(owner: AutomationRunOwner | undefined): Instance {
  const db = openFreshStateDb(dbPath);
  connections.push(db);
  return { owner, store: new AutomationStore(db, owner ? { runOwner: owner } : {}) };
}

function ownerOf(index: number): AutomationRunOwner {
  return { instanceId: `runtime-v2-instance-${index}`, processId: 1_000 + index, startedAt: index };
}

function resetProfile(): void {
  for (const db of connections.splice(0)) db.close();
  template.raw.exec("DELETE FROM automation_run_artifacts; DELETE FROM automation_runs; DELETE FROM automations;");
  const seed = new AutomationStore(template);
  for (let index = 0; index < AUTOMATION_COUNT; index += 1) {
    seed.createAutomation({
      id: `automation-${index}`,
      backend: "codex",
      threadId: `thread-${index}`,
      name: `Automation ${index}`,
      taskPrompt: "Check",
      schedule: { kind: "interval", every: 5, unit: "minutes" },
      // Far in the future: nothing about the schedule needs reconciling.
      nextRunAt: 10_000_000,
      now: 0,
    });
  }
}

function allRuns(store: AutomationStore): Map<string, AutomationRunSummary> {
  const runs = new Map<string, AutomationRunSummary>();
  for (let index = 0; index < AUTOMATION_COUNT; index += 1) {
    for (const run of store.listRunsForAutomation(`automation-${index}`, 500)) runs.set(run.id, run);
  }
  return runs;
}

function isTerminal(status: string): status is Terminal {
  return (TERMINAL as readonly string[]).includes(status);
}

type RunStep = "queue" | "start" | Terminal;

function advance(store: AutomationStore, runId: string, step: RunStep, now: number): void {
  if (step === "queue") store.markRunQueued({ runId, queueEntryId: `queue-${runId}`, now });
  else if (step === "start") store.markRunStarted({ runId, backendTurnId: `turn-${runId}`, now });
  else store.markRunTerminal({ runId, status: step, errorMessage: `Outcome ${step}`, now });
}

const runStep = fc.constantFrom<RunStep>("queue", "start", ...TERMINAL);

type Op =
  | { kind: "create"; instance: number; automation: number }
  | { kind: "advance"; run: number; step: RunStep }
  | { kind: "launch" };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({
    kind: fc.constant("create" as const),
    instance: fc.nat({ max: 3 }),
    automation: fc.nat({ max: AUTOMATION_COUNT - 1 }),
  }) },
  { weight: 4, arbitrary: fc.record({
    kind: fc.constant("advance" as const),
    run: fc.nat({ max: 20 }),
    step: runStep,
  }) },
  { weight: 2, arbitrary: fc.constant({ kind: "launch" as const }) },
);

it("starting another instance leaves every live instance's runs unchanged", () => {
  fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 30 }), (ops) => {
    resetProfile();
    // Every instance stays alive for the whole run: nothing may be reconciled.
    const instances: Instance[] = [openInstance(ownerOf(0))];
    const live = new Set([ownerOf(0).instanceId]);
    const created: Array<{ id: string; instance: number }> = [];
    let now = 1;

    for (const next of ops) {
      now += 1;
      if (next.kind === "create") {
        const instance = instances[next.instance % instances.length]!;
        const id = `run-${created.length}`;
        // A second pending scheduled run per automation is refused by a
        // unique index, so the model uses manual runs.
        instance.store.createRun({ id, automationId: `automation-${next.automation}`, trigger: "manual", now });
        created.push({ id, instance: instances.indexOf(instance) });
        continue;
      }
      if (next.kind === "advance") {
        if (created.length === 0) continue;
        const run = created[next.run % created.length]!;
        // Only the owner advances its own run.
        advance(instances[run.instance]!.store, run.id, next.step, now);
        continue;
      }
      const before = allRuns(instances[0]!.store);
      const owner = ownerOf(instances.length);
      const launched = openInstance(owner);
      live.add(owner.instanceId);
      const result = launched.store.reconcileStartup({
        now,
        isOwnerAlive: (candidate) => live.has(candidate.instanceId),
      });
      instances.push(launched);
      expect(result?.interruptedRuns ?? []).toEqual([]);
      expect(allRuns(instances[0]!.store)).toEqual(before);
    }

    // The owner's real outcome is still accepted afterwards.
    for (const run of created) {
      const current = instances[0]!.store.getRun(run.id)!;
      if (isTerminal(current.status)) continue;
      advance(instances[run.instance]!.store, run.id, "completed", now + 1);
      expect(instances[0]!.store.getRun(run.id)?.status).toBe("completed");
    }
  }), { numRuns: 30 });
});

/** Where a crash caught one run: after create, queue, start, or a terminal outcome. */
const crashPoint = fc.record({
  automation: fc.nat({ max: AUTOMATION_COUNT - 1 }),
  // Written by a build that recorded no owner.
  legacy: fc.boolean(),
  steps: fc.array(runStep, { maxLength: 4 }),
});

it("after recovery every run that was not terminal is interrupted exactly once and no terminal run changes", () => {
  fc.assert(fc.property(
    fc.array(crashPoint, { minLength: 1, maxLength: 12 }),
    fc.integer({ min: 1, max: 3 }),
    (points, recoveries) => {
      resetProfile();
      const dead = openInstance(ownerOf(0));
      const legacy = openInstance(undefined);
      let now = 1;
      for (const [index, point] of points.entries()) {
        const store = point.legacy ? legacy.store : dead.store;
        const id = `run-${index}`;
        store.createRun({ id, automationId: `automation-${point.automation}`, trigger: "manual", now });
        for (const step of point.steps) {
          now += 1;
          advance(store, id, step, now);
        }
      }
      const before = allRuns(dead.store);
      expect(before.size).toBe(points.length);
      const pendingIds = [...before.values()].filter((run) => !isTerminal(run.status)).map((run) => run.id);

      // The process is gone. Each later launch is a new instance, alive itself.
      const live = new Set<string>();
      const interrupted: string[] = [];
      let firstRecoveryAt: number | undefined;
      let afterFirst: Map<string, AutomationRunSummary> | undefined;
      for (let launch = 1; launch <= recoveries; launch += 1) {
        now += 10;
        const owner = ownerOf(launch);
        live.add(owner.instanceId);
        const instance = openInstance(owner);
        const result = instance.store.reconcileStartup({
          now,
          isOwnerAlive: (candidate) => live.has(candidate.instanceId),
        });
        interrupted.push(...(result?.interruptedRuns ?? []).map((run) => run.id));
        firstRecoveryAt ??= now;
        afterFirst ??= allRuns(instance.store);
        // A later recovery changes nothing at all.
        expect(allRuns(instance.store)).toEqual(afterFirst);
      }

      expect([...interrupted].sort()).toEqual([...pendingIds].sort());
      for (const [id, run] of afterFirst!) {
        const previous = before.get(id)!;
        if (isTerminal(previous.status)) {
          expect(run).toEqual(previous);
          continue;
        }
        expect(run).toMatchObject({
          status: "failed",
          failureReason: "interrupted",
          completedAt: firstRecoveryAt,
        });
        expect(run.errorMessage).toBeTruthy();
      }

      // The dead owner's late outcome cannot replace the interruption.
      for (const id of pendingIds) {
        dead.store.markRunTerminal({ runId: id, status: "completed", now: now + 1 });
        expect(dead.store.getRun(id)).toEqual(afterFirst!.get(id));
      }
    },
  ), { numRuns: 30 });
});

it("names the shrunk case: a second instance on the profile does not cancel the first instance's running run", () => {
  resetProfile();
  const first = openInstance(ownerOf(0));
  first.store.createRun({ id: "run-live", automationId: "automation-0", trigger: "manual", now: 1 });
  first.store.markRunStarted({ runId: "run-live", backendTurnId: "turn-live", now: 2 });
  const before = first.store.getRun("run-live");

  const second = openInstance(ownerOf(1));
  second.store.reconcileStartup({
    now: 3,
    isOwnerAlive: (owner) => owner.instanceId === ownerOf(0).instanceId,
  });

  expect(first.store.getRun("run-live")).toEqual(before);
  first.store.markRunTerminal({ runId: "run-live", status: "completed", now: 4 });
  expect(first.store.getRun("run-live")?.status).toBe("completed");
});
