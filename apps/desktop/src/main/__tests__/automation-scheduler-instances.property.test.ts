import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AutomationBacklogPolicy,
  AutomationRunOwner,
  AutomationRunSummary,
} from "@pwragent/shared/contracts/automations";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { DesktopAutomationService } from "../automations/desktop-automation-service";
import { RUNTIME_LEASE_RETRY_MS } from "../runtime-lease-retry";
import { RuntimeLeaseManager } from "../runtime-lease-manager";
import { AppRuntimeInstanceStore } from "../storage/app-runtime-instance-store";
import { AutomationStore } from "../storage/automation-store";
import type { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openFreshStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

/**
 * The rule, from the always-on Agent threads PRD: "One trigger window
 * produces at most one run." It holds however many PwrAgent instances share
 * a profile, and however their work interleaves.
 *
 * Each instance is its own connection to one database file, with its own
 * run owner, runtime lease manager and automation service, as two processes
 * on one profile are. Both read one injected clock, and each fires only the
 * timers its own scheduler armed. `fc.scheduler` orders every timer firing,
 * runner submission and turn completion, which stand in for the work a real
 * process awaits.
 *
 * Before the profile `background` lease, every instance armed a schedule
 * timer. The counterexamples then shrank to one automation and one window:
 * a turn that finished before its submission result left the window due
 * with no active run, so the second instance ran it again; and a
 * `drop_missed` automation whose run was still pending made the second
 * instance's "lane busy" marker hit the one-pending-scheduled-run index,
 * which threw out of its timer callback and stopped its scheduler.
 *
 * A second rule follows from the first: a run owned by an instance that
 * died must not hold its automation's lane. Only the process that sees a
 * turn end starts the lane's next run, so before the holder ended dead
 * owners' runs, a run left `running` by a stopped instance blocked every
 * later window until a restart. A live instance's turn needs nothing more:
 * whichever process sees it end starts the next queued run from the shared
 * database, whoever queued it.
 */

const INSTANCE_COUNT = 2;
const INTERVAL_MS = 5 * 60 * 1_000;
// The interval schedule's first window after the instances start at 0.
const FIRST_DUE_AT = INTERVAL_MS;

let tempDir: string;
let dbPath: string;
let connections: StateDb[];
let template: StateDb;

beforeEach(() => {
  ({ tempDir, dbPath } = createTempStateDb("pwragent-automation-instances-"));
  connections = [];
  // Hold the file open so later connections are second connections.
  template = openFreshStateDb(dbPath);
});

afterEach(() => {
  for (const db of connections) db.close();
  template.close();
  removeTempStateDbDir(tempDir);
});

function ownerOf(index: number): AutomationRunOwner {
  return { instanceId: `runtime-v2-instance-${index}`, processId: 1_000 + index, startedAt: index };
}

function resetProfile(policies: AutomationBacklogPolicy[]): void {
  for (const db of connections.splice(0)) db.close();
  template.raw.exec(
    "DELETE FROM automation_run_artifacts; DELETE FROM automation_runs; DELETE FROM automations;"
    + " DELETE FROM messaging_runtime_lease; DELETE FROM app_runtime_instances;",
  );
  const seed = new AutomationStore(template);
  policies.forEach((backlogPolicy, index) => {
    seed.createAutomation({
      id: `automation-${index}`,
      backend: "codex",
      threadId: `thread-${index}`,
      name: `Automation ${index}`,
      taskPrompt: "Check",
      schedule: { kind: "interval", every: 5, unit: "minutes" },
      backlogPolicy,
      nextRunAt: FIRST_DUE_AT,
      now: 0,
    });
  });
}

function stubRegistry(): DesktopBackendRegistry {
  return {
    onEvent: () => () => undefined,
    publishLocalEvent: async () => undefined,
    setAutomationInspectionHandler: () => undefined,
  } as unknown as DesktopBackendRegistry;
}

type ArmedTimer = { callback: () => void; dueAt: number };

type Instance = {
  service: DesktopAutomationService;
  store: AutomationStore;
  timers: Set<ArmedTimer>;
};

/** One PwrAgent process on the shared profile database. */
function openInstance(params: {
  index: number;
  clock: () => number;
  dead: ReadonlySet<string>;
  /** Whether the next submitted turn finishes on its own. */
  finishes: () => boolean;
  s: fc.Scheduler;
}): Instance {
  const { index, clock, dead, s } = params;
  const db = openFreshStateDb(dbPath);
  connections.push(db);
  const store = new AutomationStore(db, { runOwner: ownerOf(index) });
  const timers = new Set<ArmedTimer>();
  const service = new DesktopAutomationService({
    registry: stubRegistry(),
    store,
    now: clock,
    runOwnerLiveness: (owner) => dead.has(owner.instanceId) ? "dead" : "alive",
    leaseManager: new RuntimeLeaseManager({
      cwd: `/tmp/instance-${index}`,
      instanceId: ownerOf(index).instanceId,
      now: clock,
      processId: ownerOf(index).processId,
      profileName: "default",
      runtimeIdentityIsAlive: (owner) => !dead.has(owner.instanceId),
      startedAt: ownerOf(index).startedAt,
      store: new AppRuntimeInstanceStore(db),
      systemBootedAt: 0,
    }),
    scheduler: {
      setTimer: ((callback: () => void, delayMs: number) => {
        const timer = { callback, dueAt: clock() + delayMs };
        timers.add(timer);
        return timer;
      }) as unknown as typeof setTimeout,
      clearTimer: (timer) => {
        timers.delete(timer as unknown as ArmedTimer);
      },
      runner: {
        async submitRun({ run }) {
          // The turn may finish before or after the submission result.
          if (params.finishes()) {
            void s.schedule(Promise.resolve()).then(() => {
              store.markRunTerminal({ runId: run.id, status: "completed", now: clock() });
            });
          }
          return await s.schedule(Promise.resolve({
            status: "started" as const,
            queueEntryId: `queue-${run.id}`,
            turnId: `turn-${run.id}`,
          }));
        },
      },
    },
  });
  service.start();
  return { service, store, timers };
}

/** Fire every due timer an instance armed, then drain the work it starts. */
async function fireDueTimers(instances: Instance[], now: number, s: fc.Scheduler): Promise<void> {
  for (const { timers } of instances) {
    for (const timer of [...timers]) {
      if (timer.dueAt > now) continue;
      timers.delete(timer);
      void s.schedule(Promise.resolve()).then(() => timer.callback());
    }
  }
  await drain(s);
}

async function drain(s: fc.Scheduler): Promise<void> {
  // Timer callbacks start work the scheduler then awaits, which schedules
  // further tasks.
  for (let round = 0; round < 10; round += 1) {
    await s.waitAll();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const policiesArbitrary = fc.array(
  fc.constantFrom<AutomationBacklogPolicy>("coalesce", "drop_missed"),
  { minLength: 1, maxLength: 3 },
);

it("one trigger window produces at most one run across instances on one profile", async () => {
  await fc.assert(fc.asyncProperty(
    policiesArbitrary,
    // Schedule windows that come due while both instances run.
    fc.integer({ min: 1, max: 3 }),
    // Whether each submitted turn finishes before the next window.
    fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
    fc.scheduler(),
    async (policies, windowCount, finishes, s) => {
      resetProfile(policies);
      let now = 0;
      let submitted = 0;
      // Every instance stays alive: no lease or run is ever reclaimed.
      const dead = new Set<string>();
      const instances = Array.from({ length: INSTANCE_COUNT }, (_, index) => openInstance({
        index,
        clock: () => now,
        dead,
        finishes: () => finishes[submitted++ % finishes.length]!,
        s,
      }));

      try {
        for (let window = 0; window < windowCount; window += 1) {
          now = FIRST_DUE_AT + window * INTERVAL_MS;
          await fireDueTimers(instances, now, s);
        }
      } finally {
        for (const { service } of instances) service.dispose();
      }

      const reader = new AutomationStore(template);
      for (let index = 0; index < policies.length; index += 1) {
        const runsByWindow = new Map<number, string[]>();
        for (const run of reader.listRunsForAutomation(`automation-${index}`, 500)) {
          for (const window of run.scheduledWindows) {
            const runs = runsByWindow.get(window.scheduledFor) ?? [];
            runs.push(`${run.id} ${run.status} owner=${run.owner?.instanceId}`);
            runsByWindow.set(window.scheduledFor, runs);
          }
        }
        for (let window = 0; window < windowCount; window += 1) {
          const scheduledFor = FIRST_DUE_AT + window * INTERVAL_MS;
          // Exactly one: at most one by the rule, and at least one so a
          // scheduler that never runs cannot pass.
          expect(
            runsByWindow.get(scheduledFor) ?? [],
            `automation-${index} window ${scheduledFor}`,
          ).toHaveLength(1);
        }
      }
    },
  ), { numRuns: 40 });
});

function describeRuns(runs: AutomationRunSummary[]): string[] {
  return runs.map((run) => `${run.trigger} ${run.status} owner=${run.owner?.instanceId}`);
}

it("a run owned by an instance that stopped does not hold its automation's lane", async () => {
  await fc.assert(fc.asyncProperty(
    policiesArbitrary,
    fc.integer({ min: 1, max: 3 }),
    // The window before which the second instance stops.
    fc.nat({ max: 2 }),
    fc.scheduler(),
    async (policies, windowCount, stopBefore, s) => {
      fc.pre(stopBefore < windowCount);
      resetProfile(policies);
      let now = 0;
      const dead = new Set<string>();
      // No turn finishes on its own: a lane frees only when a run is ended.
      const [holder, other] = Array.from({ length: INSTANCE_COUNT }, (_, index) => openInstance({
        index,
        clock: () => now,
        dead,
        finishes: () => false,
        s,
      })) as [Instance, Instance];

      try {
        // The instance without the scheduling lease runs each automation now.
        for (let index = 0; index < policies.length; index += 1) {
          void s.schedule(Promise.resolve()).then(() =>
            other.service.runNow({ automationId: `automation-${index}` }));
        }
        await drain(s);

        for (let window = 0; window < windowCount; window += 1) {
          if (window === stopBefore) {
            // It quits or crashes with its runs still in progress.
            other.service.dispose();
            dead.add(ownerOf(1).instanceId);
          }
          now = FIRST_DUE_AT + window * INTERVAL_MS;
          await fireDueTimers([holder], now, s);
          if (window < stopBefore) continue;

          for (let index = 0; index < policies.length; index += 1) {
            const runs = holder.store.listRunsForAutomation(`automation-${index}`, 500);
            const label = `automation-${index} after window ${window}: ${describeRuns(runs).join("; ")}`;
            const open = runs.filter((run) =>
              run.status === "pending" || run.status === "queued" || run.status === "running");
            // Nothing the stopped instance owned is still in progress.
            expect(open.filter((run) => dead.has(run.owner?.instanceId ?? "")), label).toEqual([]);
            // A run is in progress, so this window was not dropped behind a
            // lane nothing will free.
            expect(open.some((run) => run.status === "running"), label).toBe(true);
          }
        }
      } finally {
        holder.service.dispose();
        if (!dead.has(ownerOf(1).instanceId)) other.service.dispose();
      }
    },
  ), { numRuns: 40 });
});

it("an instance without the scheduling lease still ends runs its crashed predecessor left", async () => {
  resetProfile(["coalesce"]);
  const now = 0;
  // Instance 2 crashed with a run in progress; instance 1 replaces it.
  const dead = new Set<string>();
  const crashed = new AutomationStore(template, { runOwner: ownerOf(2) });
  const orphan = crashed.createRun({ automationId: "automation-0", trigger: "manual", now });
  crashed.markRunStarted({ runId: orphan!.id, backendTurnId: "turn-orphan", now });
  // No run is submitted here, so tasks pass straight through.
  const s = { schedule: <T>(task: Promise<T>) => task } as unknown as fc.Scheduler;
  const open = (index: number) => openInstance({ index, clock: () => now, dead, finishes: () => false, s });
  // The lease holder started while instance 2 still looked alive.
  const instances = [open(0)];
  dead.add(ownerOf(2).instanceId);
  instances.push(open(1));
  try {
    const reader = new AutomationStore(template);
    expect(reader.getRun(orphan!.id)).toMatchObject({ status: "failed", failureReason: "interrupted" });
  } finally {
    for (const { service } of instances) service.dispose();
  }
});

it("reports automations paused in the instance without the lease until the holder quits", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    resetProfile(["coalesce"]);
    const now = 0;
    const dead = new Set<string>();
    const s = { schedule: <T>(task: Promise<T>) => task } as unknown as fc.Scheduler;
    const open = (index: number) => openInstance({ index, clock: () => now, dead, finishes: () => false, s });
    const holder = open(0);
    const other = open(1);
    expect(holder.service.getSchedulingStatus()).toEqual({ state: "active" });
    expect(other.service.getSchedulingStatus()).toEqual({
      state: "elsewhere",
      holder: expect.objectContaining({ instanceId: ownerOf(0).instanceId, processId: ownerOf(0).processId }),
    });
    const changes: unknown[] = [];
    other.service.onSchedulingStatusChanged((status) => changes.push(status));

    // The holder quits and releases the lease; the next retry takes it.
    holder.service.dispose();
    vi.advanceTimersByTime(RUNTIME_LEASE_RETRY_MS);

    expect(changes).toEqual([{ state: "active" }]);
    expect(other.service.getSchedulingStatus()).toEqual({ state: "active" });
    other.service.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("reports automations paused when the scheduling lease cannot be read", () => {
  resetProfile(["coalesce"]);
  const db = openFreshStateDb(dbPath);
  connections.push(db);
  const leaseManager = {
    id: ownerOf(0).instanceId,
    acquire: () => {
      throw new Error("database is locked");
    },
    release: () => true,
    shouldRetryAcquisition: () => false,
  } as unknown as RuntimeLeaseManager;
  const service = new DesktopAutomationService({
    registry: stubRegistry(),
    store: new AutomationStore(db, { runOwner: ownerOf(0) }),
    leaseManager,
    runOwnerLiveness: () => "alive",
  });
  try {
    expect(() => service.start()).not.toThrow();
    expect(service.getSchedulingStatus()).toEqual({ state: "elsewhere" });
  } finally {
    service.dispose();
  }
});
