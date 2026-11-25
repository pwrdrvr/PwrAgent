import fc from "fast-check";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  buildThreadIdentityKey,
  type NavigationRow,
  type PrSummary,
  type ThreadPrAutoDispatchPending,
} from "@pwragent/shared/contracts/navigation";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared/navigation-query-events";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import { PR_AUTO_DISPATCH_DELAY_MS, PrAutoDispatchCoordinator } from "../pr-status/pr-auto-dispatch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/*
 * The promise: a thread's sidebar row shows "Scheduled" exactly while an
 * Auto-fix repair is pending for it or being tried, and a busy thread's
 * repair (refunded and retried 30 seconds later) keeps the chip on through
 * every retry. The operator saw the opposite: no chip during the countdown,
 * then a one-second flash at each retry.
 *
 * The renderer shows the chip when the thread's loaded row carries
 * `prAutoDispatchPending` (useThreadQueuedMessageIndicators). That row is
 * written by two paths, and both are modelled here as the renderer applies
 * them:
 *
 *   - `thread/prAutoDispatch/pendingUpdated` patches the loaded row
 *     (applyThreadPrAutoDispatchPendingUpdate);
 *   - the same event is a navigation row change, so a page refresh then
 *     replaces the row with the owner's projection: the SQLite navigation
 *     index read through the owner-core row projection.
 *
 * The oracle is the system that owns the data: the thread's claim in
 * `pr_auto_dispatch_claims`, active while 'pending' or 'dispatching'. The
 * real coordinator drives every transition, and the registry's
 * submitTurnIfIdle refreshes the row mid-attempt, while the claim is
 * 'dispatching'.
 */
const THREAD = { backend: "codex" as const, threadId: "thread-1" };
const THREAD_KEY = buildThreadIdentityKey(THREAD.backend, THREAD.threadId);
const PROVIDER_THREAD: AppServerThreadSummary = {
  id: THREAD.threadId, source: THREAD.backend, title: "Auto-fix fixture", titleSource: "explicit",
  updatedAt: 1, linkedDirectories: [],
};
const HEADS = ["a", "b", "c"].map((letter) => letter.repeat(40));

function conflictingPr(head: string): PrSummary {
  return {
    provider: "github.com", number: 4400, org: "example", repo: "project",
    title: "Contrived merge-conflict fixture", state: "passing", checkState: "passing",
    lifecycleState: "open", reviewState: "ready_for_review", mergeState: "conflicting",
    headSha: head, commitShas: [head], url: "https://github.com/example/project/pull/4400",
  };
}

const command = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("observe" as const), head: fc.integer({ min: 0, max: HEADS.length - 1 }) }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("tick" as const), ms: fc.integer({ min: 1_000, max: PR_AUTO_DISPATCH_DELAY_MS }) }), weight: 2 },
  // The countdown timer and Send now both run the coordinator's dispatch.
  { arbitrary: fc.record({ kind: fc.constant("dispatch" as const), via: fc.constantFrom("timer", "send-now"),
    outcome: fc.constantFrom("busy", "busy", "started") }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("cancel" as const) }), weight: 1 },
);
type Command = typeof command extends fc.Arbitrary<infer T> ? T : never;

let stateDb: StateDb;
let store: SqliteOverlayStore;
/** Busy retries the generated runs reached, so the property is not vacuous. */
let busyRetries = 0;
beforeEach(async () => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
  await store.setThreadPrAutoDispatchEnabled({ ...THREAD, enabled: true });
});
afterEach(() => stateDb.close());

/** The owner's answer: an Auto-fix claim is active for the thread. */
function claimActive(): { active: boolean; status?: string } {
  const row = stateDb.raw.prepare(`SELECT status FROM pr_auto_dispatch_claims
    WHERE backend = ? AND thread_id = ? AND status IN ('pending', 'dispatching')`)
    .get(THREAD.backend, THREAD.threadId) as { status: string } | undefined;
  return { active: row !== undefined, status: row?.status };
}

/** One page refresh: the owner's index and row projection for the thread. */
function refreshedRow(): NavigationRow {
  const index = store.readNavigationQueryIndex({ backend: "all", threads: [PROVIDER_THREAD] });
  const page = projectNavigationQuery({
    index: { ...index, coverage: { state: "complete" } },
    request: { protocol: 2, consumer: "main-sidebar", query: { kind: "exact", identities: [THREAD] } },
  });
  const row = page.entries.find((entry) => buildThreadIdentityKey(entry.row.source, entry.row.id) === THREAD_KEY)?.row;
  if (!row) throw new Error("The exact query did not return the fixture thread.");
  return row;
}

/** useThreadQueuedMessageIndicators: a pending repair reads as "scheduled". */
const chipScheduled = (row: { prAutoDispatchPending?: ThreadPrAutoDispatchPending }) =>
  Boolean(row.prAutoDispatchPending);

async function run(commands: Command[]): Promise<Array<{ step: string; chip: boolean }>> {
  let clock = 1_000;
  let head = HEADS[0]!;
  let outcome: "busy" | "started" = "busy";
  let row: { prAutoDispatchPending?: ThreadPrAutoDispatchPending } = refreshedRow();
  const observations: Array<{ step: string; chip: boolean; claim: ReturnType<typeof claimActive> }> = [];
  // Recorded, not asserted, here: the coordinator catches what a
  // submitTurnIfIdle throws and reports it as a failed submission.
  const observe = (step: string) => {
    observations.push({ step, chip: chipScheduled(row), claim: claimActive() });
  };
  const coordinator = new PrAutoDispatchCoordinator({
    store,
    registry: {
      submitTurnIfIdle: async () => {
        // A navigation refresh can land while the attempt is in flight.
        row = refreshedRow();
        observe("mid-attempt refresh");
        return outcome === "busy" ? { status: "busy" } : { status: "started", turnId: `turn-${clock}` };
      },
    },
    getCurrentPr: () => conflictingPr(head),
    isPrAttached: () => true,
    isBackgroundPollingEnabled: () => true,
    getBudgetConfig: () => ({ capacity: 1_000, refillPerMinute: 1_000, pauseWhenEmpty: false }),
    now: () => clock,
    onPendingChanged: ({ pending }) => {
      row = { ...row, prAutoDispatchPending: pending ?? undefined };
      observe("pendingUpdated patch");
      row = refreshedRow();
      observe("refresh after pendingUpdated");
    },
  });
  try {
    for (const step of commands) {
      const before = claimActive();
      const firstObservation = observations.length;
      switch (step.kind) {
        case "observe":
          head = HEADS[step.head]!;
          await coordinator.handleStatusSnapshot({ pr: conflictingPr(head), threadKeys: [THREAD_KEY],
            observedAt: clock, backgroundPollingEnabled: true });
          break;
        case "tick":
          clock += step.ms;
          break;
        case "dispatch": {
          outcome = step.outcome;
          const record = await store.getThreadPrAutoDispatchPending(THREAD);
          if (!record) break;
          if (step.via === "timer") clock = Math.max(clock, record.pending.scheduledAt);
          await coordinator.sendPendingNow({ ...THREAD, fingerprint: record.pending.fingerprint });
          break;
        }
        case "cancel": {
          const record = await store.getThreadPrAutoDispatchPending(THREAD);
          if (record) await coordinator.cancelPending({ ...THREAD, fingerprint: record.pending.fingerprint });
          break;
        }
      }
      row = refreshedRow();
      observe(`refresh after ${step.kind}`);
      const added = observations.slice(firstObservation);
      expect(added.filter((entry) => entry.chip !== entry.claim.active)).toEqual([]);
      // A busy thread refunds the attempt and reschedules it: the chip never
      // goes off. (An attempt can also end before submission, such as a
      // superseded head; the oracle check above covers those.)
      const submitted = added.some((entry) => entry.step === "mid-attempt refresh");
      if (step.kind === "dispatch" && step.outcome === "busy" && before.status === "pending" && submitted) {
        expect(claimActive().status).toBe("pending");
        expect(added.find((entry) => entry.step === "mid-attempt refresh")?.claim.status).toBe("dispatching");
        expect(added.filter((entry) => !entry.chip)).toEqual([]);
        busyRetries += 1;
      }
    }
  } finally {
    coordinator.close();
  }
  return observations.map(({ step, chip }) => ({ step, chip }));
}

it("shows Scheduled exactly while a repair is pending or being tried, through busy retries", async () => {
  busyRetries = 0;
  await fc.assert(fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 16 }), async (commands) => {
    stateDb.raw.exec("DELETE FROM pr_auto_dispatch_claims; DELETE FROM pr_auto_dispatch_incidents;");
    await run(commands);
  }), { numRuns: 40 });
  expect(busyRetries).toBeGreaterThan(0);
});

it("keeps Scheduled on a busy thread across the countdown and two refunded retries", async () => {
  // The renderer re-reads the row after every pendingUpdated event.
  expect(navigationQueryEventRequiresRefresh("thread/prAutoDispatch/pendingUpdated")).toBe(true);
  const timeline = await run([
    { kind: "observe", head: 0 },
    { kind: "tick", ms: 18_000 },
    { kind: "dispatch", via: "timer", outcome: "busy" },
    { kind: "tick", ms: 12_000 },
    { kind: "dispatch", via: "timer", outcome: "busy" },
    { kind: "dispatch", via: "send-now", outcome: "started" },
  ]);
  // On from the first observation until the repair starts, then off.
  const started = timeline.findIndex((entry) => !entry.chip);
  expect(timeline.slice(0, started).every((entry) => entry.chip)).toBe(true);
  expect(timeline.slice(started).map((entry) => entry.chip)).toEqual([false, false, false]);
  expect(timeline.filter((entry) => entry.step === "mid-attempt refresh").map((entry) => entry.chip))
    .toEqual([true, true, true]);
});
