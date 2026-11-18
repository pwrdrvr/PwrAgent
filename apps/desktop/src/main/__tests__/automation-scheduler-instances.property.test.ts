import fc from "fast-check";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AutomationBacklogPolicy, AutomationRunOwner } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { DesktopAutomationService } from "../automations/desktop-automation-service";
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
 * Before the profile `automations` lease, every instance armed a schedule
 * timer. The counterexamples then shrank to one automation and one window:
 * a turn that finished before its submission result left the window due
 * with no active run, so the second instance ran it again; and a
 * `drop_missed` automation whose run was still pending made the second
 * instance's "lane busy" marker hit the one-pending-scheduled-run index,
 * which threw out of its timer callback and stopped its scheduler.
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

it("one trigger window produces at most one run across instances on one profile", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom<AutomationBacklogPolicy>("coalesce", "drop_missed"), {
      minLength: 1,
      maxLength: 3,
    }),
    // Schedule windows that come due while both instances run.
    fc.integer({ min: 1, max: 3 }),
    // Whether each submitted turn finishes before the next window.
    fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
    fc.scheduler(),
    async (policies, windowCount, finishes, s) => {
      resetProfile(policies);
      let now = 0;
      let submitted = 0;
      const instances = Array.from({ length: INSTANCE_COUNT }, (_, index) => {
        const db = openFreshStateDb(dbPath);
        connections.push(db);
        const store = new AutomationStore(db, { runOwner: ownerOf(index) });
        const timers = new Set<ArmedTimer>();
        const service = new DesktopAutomationService({
          registry: stubRegistry(),
          store,
          now: () => now,
          leaseManager: new RuntimeLeaseManager({
            cwd: `/tmp/instance-${index}`,
            instanceId: ownerOf(index).instanceId,
            now: () => now,
            processId: ownerOf(index).processId,
            profileName: "default",
            // Every instance stays alive: no lease is ever reclaimed.
            runtimeIdentityIsAlive: () => true,
            startedAt: ownerOf(index).startedAt,
            store: new AppRuntimeInstanceStore(db),
            systemBootedAt: 0,
          }),
          scheduler: {
            setTimer: ((callback: () => void, delayMs: number) => {
              const timer = { callback, dueAt: now + delayMs };
              timers.add(timer);
              return timer;
            }) as unknown as typeof setTimeout,
            clearTimer: (timer) => {
              timers.delete(timer as unknown as ArmedTimer);
            },
            runner: {
              async submitRun({ run }) {
                // The turn may finish before or after the submission result.
                if (finishes[submitted++ % finishes.length]) {
                  void s.schedule(Promise.resolve()).then(() => {
                    store.markRunTerminal({ runId: run.id, status: "completed", now });
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
        return { service, timers };
      });

      try {
        for (let window = 0; window < windowCount; window += 1) {
          now = FIRST_DUE_AT + window * INTERVAL_MS;
          for (const { timers } of instances) {
            for (const timer of [...timers]) {
              if (timer.dueAt > now) continue;
              timers.delete(timer);
              void s.schedule(Promise.resolve()).then(() => timer.callback());
            }
          }
          // Drain this window: timer callbacks start work the scheduler
          // then awaits, which schedules further tasks.
          for (let round = 0; round < 10; round += 1) {
            await s.waitAll();
            await new Promise((resolve) => setImmediate(resolve));
          }
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
