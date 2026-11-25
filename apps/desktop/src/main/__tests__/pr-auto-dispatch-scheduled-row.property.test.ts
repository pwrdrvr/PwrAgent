import fc from "fast-check";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  buildThreadIdentityKey,
  isThreadPrAutoDispatchScheduled,
  type NavigationRow,
  type PrSummary,
} from "@pwragent/shared/contracts/navigation";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared/navigation-query-events";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import {
  MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
  PR_AUTO_DISPATCH_DELAY_MS,
  PrAutoDispatchCoordinator,
} from "../pr-status/pr-auto-dispatch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/*
 * The promise: a thread's sidebar row shows "Scheduled" exactly while an
 * Auto-fix repair is pending for it or being tried, and a busy thread's
 * repair (refunded and retried 30 seconds later) keeps the chip on through
 * every retry. The operator saw the opposite: no chip during the countdown,
 * then a one-second flash at each retry. A row carries the cancellable
 * `prAutoDispatchPending` only while the repair is pending: the composer
 * offers Send now and Cancel for it, and both act only on a pending claim.
 *
 * The renderer reads the chip from the thread's loaded row
 * (isThreadPrAutoDispatchScheduled, via useThreadQueuedMessageIndicators).
 * That row is written by two paths, applied here as the renderer applies
 * them:
 *
 *   - `thread/prAutoDispatch/pendingUpdated` patches the loaded row;
 *   - the same event is a navigation row change, so a page refresh then
 *     replaces the row with the owner's projection: the SQLite navigation
 *     index read through the owner-core row projection.
 *
 * The real coordinator and store drive every transition, and the registry's
 * submitTurnIfIdle refreshes the row mid-attempt. The oracle is a model of
 * the repair lifecycle for one PR whose head only moves forward:
 *
 *   - a head seen for the first time schedules a repair (on), superseding
 *     an older one, unless the incident has spent its attempts;
 *   - a head seen before changes nothing: its claim already exists;
 *   - a dispatch of a repair for an older head is superseded (off);
 *   - a dispatch for the current head is tried (on mid-attempt), then a busy
 *     thread refunds and reschedules it (on) or the turn starts (off, one
 *     attempt spent);
 *   - Cancel ends it (off).
 */
const THREAD = { backend: "codex" as const, threadId: "thread-1" };
const THREAD_KEY = buildThreadIdentityKey(THREAD.backend, THREAD.threadId);
const PROVIDER_THREAD: AppServerThreadSummary = {
  id: THREAD.threadId, source: THREAD.backend, title: "Auto-fix fixture", titleSource: "explicit",
  updatedAt: 1, linkedDirectories: [],
};
const HEADS = ["a", "b", "c", "d"].map((letter) => letter.repeat(40));

function conflictingPr(head: string): PrSummary {
  return {
    provider: "github.com", number: 4400, org: "example", repo: "project",
    title: "Contrived merge-conflict fixture", state: "passing", checkState: "passing",
    lifecycleState: "open", reviewState: "ready_for_review", mergeState: "conflicting",
    headSha: head, commitShas: [head], url: "https://github.com/example/project/pull/4400",
  };
}

const command = fc.oneof(
  // A poll sees the current head again, or a push moved it forward.
  { arbitrary: fc.record({ kind: fc.constant("observe" as const), push: fc.boolean() }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("tick" as const), ms: fc.integer({ min: 1_000, max: PR_AUTO_DISPATCH_DELAY_MS }) }), weight: 2 },
  // The countdown timer and Send now both run the coordinator's dispatch.
  { arbitrary: fc.record({ kind: fc.constant("dispatch" as const), via: fc.constantFrom("timer", "send-now"),
    outcome: fc.constantFrom("busy", "busy", "started") }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("cancel" as const) }), weight: 1 },
);
type Command = typeof command extends fc.Arbitrary<infer T> ? T : never;

/** The lifecycle model; `pending` is the head index of the active repair. */
type Model = { head: number; pending: number | null; seen: Set<number>; attempts: number };

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

type PresentedRow = Pick<NavigationRow, "prAutoDispatchPending" | "prAutoDispatchActive">;
type Observation = { step: string; chip: boolean; pendingHead: string | null; expected?: { chip: boolean; pendingHead: string | null } };

async function run(commands: Command[]): Promise<Observation[]> {
  let clock = 1_000;
  let outcome: "busy" | "started" = "busy";
  const model: Model = { head: 0, pending: null, seen: new Set(), attempts: 0 };
  let row: PresentedRow = refreshedRow();
  const observations: Observation[] = [];
  // Recorded, not asserted, here: the coordinator catches what a
  // submitTurnIfIdle throws and reports it as a failed submission.
  const observe = (step: string, expected?: Observation["expected"]) => {
    observations.push({ step, chip: isThreadPrAutoDispatchScheduled(row),
      pendingHead: row.prAutoDispatchPending?.headSha ?? null, ...(expected ? { expected } : {}) });
  };
  const coordinator = new PrAutoDispatchCoordinator({
    store,
    registry: {
      submitTurnIfIdle: async () => {
        // A navigation refresh can land while the attempt is in flight: still
        // Scheduled, but no longer a cancellable pending repair.
        row = refreshedRow();
        observe("mid-attempt refresh", { chip: true, pendingHead: null });
        return outcome === "busy" ? { status: "busy" } : { status: "started", turnId: `turn-${clock}` };
      },
    },
    getCurrentPr: () => conflictingPr(HEADS[model.head]!),
    isPrAttached: () => true,
    isBackgroundPollingEnabled: () => true,
    getBudgetConfig: () => ({ capacity: 1_000, refillPerMinute: 1_000, pauseWhenEmpty: false }),
    now: () => clock,
    onPendingChanged: ({ pending }) => {
      // The patch, and the refresh it causes, agree with what the event says.
      const expected = { chip: pending !== null, pendingHead: pending?.headSha ?? null };
      row = { ...row, prAutoDispatchPending: pending ?? undefined, prAutoDispatchActive: pending ? true : undefined };
      observe("pendingUpdated patch", expected);
      row = refreshedRow();
      observe("refresh after pendingUpdated", expected);
    },
  });
  try {
    for (const step of commands) {
      const firstObservation = observations.length;
      let attempted = false;
      switch (step.kind) {
        case "observe": {
          if (step.push && model.head < HEADS.length - 1) model.head += 1;
          if (!model.seen.has(model.head) && model.attempts < MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT) {
            model.seen.add(model.head);
            model.pending = model.head;
          }
          await coordinator.handleStatusSnapshot({ pr: conflictingPr(HEADS[model.head]!), threadKeys: [THREAD_KEY],
            observedAt: clock, backgroundPollingEnabled: true });
          break;
        }
        case "tick":
          clock += step.ms;
          break;
        case "dispatch": {
          outcome = step.outcome;
          const record = await store.getThreadPrAutoDispatchPending(THREAD);
          expect(record?.pending.headSha ?? null).toBe(model.pending === null ? null : HEADS[model.pending]);
          if (!record) break;
          attempted = model.pending === model.head;
          if (!attempted) model.pending = null;
          else if (outcome === "started") {
            model.pending = null;
            model.attempts += 1;
          }
          if (step.via === "timer") clock = Math.max(clock, record.pending.scheduledAt);
          await coordinator.sendPendingNow({ ...THREAD, fingerprint: record.pending.fingerprint });
          break;
        }
        case "cancel": {
          const record = await store.getThreadPrAutoDispatchPending(THREAD);
          model.pending = null;
          if (record) await coordinator.cancelPending({ ...THREAD, fingerprint: record.pending.fingerprint });
          break;
        }
      }
      row = refreshedRow();
      observe(`refresh after ${step.kind}`, {
        chip: model.pending !== null,
        pendingHead: model.pending === null ? null : HEADS[model.pending]!,
      });
      const added = observations.slice(firstObservation);
      expect(added.filter((entry) => entry.expected
        && (entry.chip !== entry.expected.chip || entry.pendingHead !== entry.expected.pendingHead))).toEqual([]);
      expect(added.some((entry) => entry.step === "mid-attempt refresh")).toBe(attempted);
      // A busy thread refunds the attempt and reschedules it: the chip never
      // goes off from the claim through the retry.
      if (attempted && outcome === "busy") {
        expect(added.filter((entry) => !entry.chip)).toEqual([]);
        busyRetries += 1;
      }
    }
  } finally {
    coordinator.close();
  }
  return observations;
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
    { kind: "observe", push: false },
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
  // Each attempt is Scheduled without a cancellable repair on the row.
  expect(timeline.filter((entry) => entry.step === "mid-attempt refresh"))
    .toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ chip: true, pendingHead: null })));
});

it("keeps the pending repair off a row whose claim is only being tried", async () => {
  await run([{ kind: "observe", push: false }]);
  const pending = (await store.getThreadPrAutoDispatchPending(THREAD))?.pending;
  expect(refreshedRow()).toMatchObject({ prAutoDispatchActive: true, prAutoDispatchPending: pending });
  // The coordinator's claim for dispatch, before its submission returns.
  stateDb.raw.prepare("UPDATE pr_auto_dispatch_claims SET status = 'dispatching'").run();
  const row = refreshedRow();
  expect(row.prAutoDispatchActive).toBe(true);
  expect(row.prAutoDispatchPending).toBeUndefined();
});
