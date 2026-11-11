import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPullRequestStatusKey,
  type PrAutoDispatchBudgetConfig,
  type PrSummary,
  type ThreadPrAutoDispatchEventKind,
  type ThreadPrAutoDispatchPending,
} from "@pwragent/shared";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import {
  MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
  PR_AUTO_DISPATCH_LEASE_MS,
  PrAutoDispatchCoordinator,
} from "../pr-status/pr-auto-dispatch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { CountingBackendClient } from "./fixtures/thread-read-harness";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/*
 * The limits Auto-fix promises (`pr-auto-dispatch.ts`, the storage comments
 * in `overlay-store-sqlite.ts`, and the "Automatic attempt: n/max" line the
 * repair prompt carries):
 *
 *   1. Reading Auto-fix state is pure. The attempt count, the pending
 *      repair, the pending list, the candidates and the repair-budget peek
 *      commit nothing, and no read changes what a later write answers. The
 *      one documented exception is the renderer's budget-status read, which
 *      applies refill durably; it must still not change any later answer.
 *   2. An incident starts at most MAX attempts. Its count resets only when a
 *      kind the spent attempts never targeted arrives, or when every kind it
 *      tracked definitively resolves. A new head SHA (a repair push), a
 *      non-definitive observation, and a read never reset it.
 *   3. The profile repair budget never admits more than its capacity plus
 *      the refill elapsed time has earned. Only a reservation that exists is
 *      refunded, and only once.
 *
 * The oracle is a second database that receives the same writes and no
 * reads (a differential model), plus the bounds above computed from the
 * promise.
 */
afterEach(() => vi.unstubAllEnvs());

const THREAD = { backend: "codex" as const, threadId: "thread-1" };
const PR_URL = "https://github.com/example/project/pull/1";
const PR_KEY = buildPullRequestStatusKey({ provider: "github.com", org: "example", repo: "project", number: 1, url: PR_URL });
const MAX = MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT;
const budget: PrAutoDispatchBudgetConfig = { capacity: 3, refillPerMinute: 1, pauseWhenEmpty: true };

/** The repair events one PR can produce: a head, and the kinds it shows. */
const EVENTS: ReadonlyArray<{ headSha: string; eventKinds: ThreadPrAutoDispatchEventKind[] }> = [
  { headSha: "a".repeat(40), eventKinds: ["ci-failure"] },
  { headSha: "b".repeat(40), eventKinds: ["ci-failure"] },
  { headSha: "b".repeat(40), eventKinds: ["ci-failure", "merge-conflict"] },
  { headSha: "c".repeat(40), eventKinds: ["merge-conflict"] },
];
const pending = (slot: number, now: number): ThreadPrAutoDispatchPending => ({
  fingerprint: `fingerprint-${slot}`, prKey: PR_KEY, prNumber: 1,
  prUrl: "https://github.com/example/project/pull/1", ...EVENTS[slot]!,
  eventKinds: [...EVENTS[slot]!.eventKinds], createdAt: now, scheduledAt: now,
});

const READS = ["attempts", "pending", "list", "peek", "status", "candidates", "winner"] as const;
type Read = (typeof READS)[number];

const operation = fc.record({
  // "dispatch" is the coordinator's own sequence for the thread's pending
  // claim: begin, reserve, then finish or restore by the same owner. The
  // single steps cover interleavings across owners and expired leases.
  kind: fc.constantFrom("schedule", "schedule", "dispatch", "dispatch", "dispatch", "begin", "reserve",
    "finish", "restore", "reject", "cancel", "resolve", "recover", "resume"),
  slot: fc.integer({ min: 0, max: EVENTS.length - 1 }),
  // One coordinator does nearly all the work; a second owner's steps are
  // the rarer cross-instance interleaving.
  ownerId: fc.constantFrom("first", "first", "first", "second"),
  // Short gaps keep the 3-token budget below capacity long enough for a
  // spend or a refund to show; long ones cover refill to the cap. Gaps are
  // whole 3,750 ms steps (1/16 token), so every balance is exact in binary:
  // the reader saves refill at each status read and the oracle adds it in
  // one step, and float rounding must not flip an admission between them.
  advance: fc.oneof(
    { arbitrary: fc.constant(0), weight: 2 },
    { arbitrary: fc.integer({ min: 0, max: 5 }), weight: 2 },
    { arbitrary: fc.integer({ min: 0, max: 53 }), weight: 1 },
  ).map((steps) => steps * 3_750),
  // Where the coordinator stops: after begin when the gate closes, or after
  // the reservation when submission returns.
  stopAfterBegin: fc.boolean(),
  success: fc.boolean(),
  resolved: fc.subarray(["ci-failure", "merge-conflict"] as ThreadPrAutoDispatchEventKind[]),
  reads: fc.subarray([...READS]),
});
type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never;
/*
 * One repair as the coordinator runs it: a failure is scheduled and
 * dispatched within seconds, sometimes after a repair push turned the last
 * incident's checks green, or after the operator resumed a paused budget.
 * The third repair in a row empties the 3-token budget and pauses it, so
 * only a resume followed by a fourth repair reaches the reservation's own
 * empty check. The single steps above almost never line that up.
 */
const repair = fc.record({
  op: operation,
  before: fc.constantFrom("none", "resolve", "resume", "resume"),
  pause: fc.integer({ min: 0, max: 2 }),
}).map(({ op, before, pause }): Operation[] => {
  const at: Operation = { ...op, ownerId: "first", advance: pause * 3_750, stopAfterBegin: false, success: true };
  const first: Operation[] = before === "resume" ? [{ ...at, kind: "resume" }]
    : before === "resolve" ? [{ ...at, kind: "resolve", resolved: ["ci-failure", "merge-conflict"] }]
    : [];
  return [...first, { ...at, kind: "schedule" }, { ...at, kind: "dispatch", advance: 0 }];
});
const operations = fc.array(fc.oneof({ arbitrary: operation.map((op) => [op]), weight: 1 }, { arbitrary: repair, weight: 1 }),
  { minLength: 1, maxLength: 12 }).map((chunks) => chunks.flat());

async function runWrite(store: SqliteOverlayStore, op: Operation, now: number): Promise<unknown> {
  const claim = { ...THREAD, fingerprint: `fingerprint-${op.slot}`, ownerId: op.ownerId, now };
  switch (op.kind) {
    case "dispatch": {
      // The coordinator dispatches whatever claim the thread has pending.
      const record = await store.getThreadPrAutoDispatchPending(THREAD);
      if (!record) return [];
      const slot = Number(record.pending.fingerprint.replace("fingerprint-", ""));
      const step = async (kind: Operation["kind"]) => await runWrite(store, { ...op, slot, kind, success: true }, now);
      const begin = await step("begin");
      if ((begin as { status: string }).status !== "ready") return [begin];
      if (op.stopAfterBegin) return [begin, await step("restore")];
      const reserve = await step("reserve");
      if ((reserve as { status: string }).status !== "reserved") return [begin, reserve, await step("reject")];
      return [begin, reserve, await step(op.success ? "finish" : "restore")];
    }
    case "schedule": return await store.scheduleThreadPrAutoDispatch({ ...THREAD,
      pending: pending(op.slot, now), prompt: "Repair the fixture PR.", maxAttempts: MAX });
    case "begin": return await store.beginThreadPrAutoDispatch({ ...claim,
      leaseExpiresAt: now + PR_AUTO_DISPATCH_LEASE_MS, maxAttempts: MAX });
    case "reserve": return await store.reserveThreadPrAutoDispatchBudget({ ...claim, config: budget });
    case "finish": return await store.finishThreadPrAutoDispatch({ ...claim, budgetConfig: budget,
      status: op.success ? "dispatched" : "failed", refundBudgetReservation: !op.success });
    case "restore": return await store.restoreThreadPrAutoDispatchAfterBusy({ ...claim,
      budgetConfig: budget, scheduledAt: now });
    case "reject": return await store.rejectThreadPrAutoDispatchForBudget(claim);
    case "cancel": return await store.cancelThreadPrAutoDispatch(claim);
    case "resolve": return await store.resolveThreadPrAutoDispatchIncident({ ...THREAD,
      prKey: PR_KEY, resolvedKinds: op.resolved, now });
    case "recover": return await store.recoverOrphanedThreadPrAutoDispatches({
      budgetConfig: budget, now, scheduledAt: now });
    case "resume": return await store.resumePrAutoDispatchBudget({ config: budget, now });
  }
}

async function runRead(store: SqliteOverlayStore, read: Read, now: number): Promise<unknown> {
  switch (read) {
    case "attempts": return await store.getThreadPrAutoDispatchAttemptCount({ ...THREAD, prKey: PR_KEY });
    case "pending": return await store.getThreadPrAutoDispatchPending(THREAD);
    case "list": return await store.listPendingThreadPrAutoDispatches();
    case "peek": return await store.peekPrAutoDispatchBudgetStatus({ config: budget, now });
    case "status": return await store.getPrAutoDispatchBudgetStatus({ config: budget, now });
    case "candidates": return await store.listPrAutoDispatchCandidates(THREAD);
    case "winner": return await store.getPrAutoDispatchCandidateWinner({ prKey: PR_KEY });
  }
}

/** What the promise says one incident and the budget may do. */
type Model = {
  activeKinds: Set<ThreadPrAutoDispatchEventKind>;
  /** Repairs started since the count last legitimately reset. */
  startedThisEpoch: number;
  reserved: Set<string>;
  /** Claims mid-dispatch, by fingerprint, with their lease expiry. */
  dispatching: Map<string, number>;
  netSpent: number;
  /** The budget as the promise defines it: refill to the cap, -1, +1. */
  tokens: number;
  tokensAt: number;
};

function modelTokens(model: Model, now: number): number {
  return Math.min(budget.capacity, model.tokens + ((now - model.tokensAt) * budget.refillPerMinute) / 60_000);
}

function moveTokens(model: Model, now: number, delta: number): void {
  model.tokens = Math.min(budget.capacity, modelTokens(model, now) + delta);
  model.tokensAt = now;
  model.netSpent -= delta;
}

function observeWrite(model: Model, op: Operation, result: unknown, now: number): void {
  if (op.kind === "dispatch") {
    const steps = result as unknown[];
    if (steps.length === 0) return;
    const slot = Number(((steps[0] as { record?: { pending: { fingerprint: string } } }).record?.pending.fingerprint
      ?? `fingerprint-${op.slot}`).replace("fingerprint-", ""));
    const last = (steps[1] as { status?: string } | undefined)?.status === "reserved"
      ? op.success ? "finish" : "restore"
      : "reject";
    const kinds = op.stopAfterBegin ? ["begin", "restore"] as const : ["begin", "reserve", last] as const;
    steps.forEach((step, index) => observeWrite(model, { ...op, slot, kind: kinds[index]!, success: true }, step, now));
    return;
  }
  const fingerprint = `fingerprint-${op.slot}`;
  const status = (result as { status?: string } | undefined)?.status;
  if (op.kind === "schedule" && status === "scheduled") {
    const kinds = EVENTS[op.slot]!.eventKinds;
    if (kinds.some((kind) => !model.activeKinds.has(kind))) model.startedThisEpoch = 0;
    for (const kind of kinds) model.activeKinds.add(kind);
  }
  if (op.kind === "resolve" && model.activeKinds.size > 0) {
    for (const kind of op.resolved) model.activeKinds.delete(kind);
    if (model.activeKinds.size === 0) model.startedThisEpoch = 0;
  }
  if (op.kind === "begin" && status === "ready") {
    model.dispatching.set(fingerprint, now + PR_AUTO_DISPATCH_LEASE_MS);
  }
  const ended = op.kind === "reject" ? result === true
    : (op.kind === "finish" || op.kind === "restore") && result !== undefined;
  if (ended) model.dispatching.delete(fingerprint);
  if (op.kind === "reserve" && status === "reserved") {
    model.reserved.add(fingerprint);
    moveTokens(model, now, -1);
  }
  const settled = (op.kind === "finish" || op.kind === "restore") && result !== undefined;
  if (op.kind === "finish" && result !== undefined && op.success) {
    model.startedThisEpoch += 1;
    model.reserved.delete(fingerprint);
  } else if (settled && model.reserved.delete(fingerprint)) {
    moveTokens(model, now, 1);
  }
  if (op.kind === "recover") {
    // A claim whose lease expired mid-dispatch goes back to pending, and its
    // reservation, if it made one, is refunded once.
    let recovered = 0;
    for (const [claim, expiresAt] of [...model.dispatching]) {
      if (expiresAt > now) continue;
      model.dispatching.delete(claim);
      recovered += 1;
      if (model.reserved.delete(claim)) moveTokens(model, now, 1);
    }
    expect((result as { recoveredCount: number }).recoveredCount).toBe(recovered);
  }
}

const step = (partial: Partial<Operation> & Pick<Operation, "kind">): Operation => ({
  slot: 0, ownerId: "first", advance: 0, stopAfterBegin: false, success: true, resolved: [], reads: [],
  ...partial,
});
/*
 * Two production shapes the random walk reaches only rarely, kept as fixed
 * examples:
 *  - the gate closes between begin and the reservation, so the claim is
 *    restored before any token was reserved: nothing may be refunded;
 *  - the renderer's budget-status read lands while a token is part refilled,
 *    then the budget drains: the durable refill must keep the fraction;
 *  - three repairs drain and pause the budget, the operator resumes it, and
 *    a fourth repair arrives before any refill: the reservation must refuse.
 */
const STORE_EXAMPLES: Array<[Operation[]]> = [
  [[
    step({ kind: "schedule" }),
    step({ kind: "dispatch" }),
    step({ kind: "schedule", slot: 1 }),
    step({ kind: "dispatch", stopAfterBegin: true }),
  ]],
  [[
    step({ kind: "schedule" }),
    step({ kind: "dispatch" }),
    step({ kind: "schedule", slot: 1 }),
    step({ kind: "dispatch" }),
    step({ kind: "resolve", resolved: ["ci-failure", "merge-conflict"], advance: 30_000, reads: ["status"] }),
    step({ kind: "schedule", slot: 3 }),
    step({ kind: "dispatch" }),
    step({ kind: "schedule", slot: 2, advance: 30_000 }),
    step({ kind: "dispatch" }),
  ]],
  [[
    step({ kind: "schedule", slot: 1 }),
    step({ kind: "dispatch" }),
    step({ kind: "schedule", slot: 0 }),
    step({ kind: "dispatch" }),
    step({ kind: "schedule", slot: 2 }),
    step({ kind: "dispatch" }),
    step({ kind: "resume" }),
    step({ kind: "schedule", slot: 3 }),
    step({ kind: "dispatch" }),
  ]],
];

describe("Auto-fix PR repair limits (model, oracle: the same writes without reads)", () => {
  it("reads are pure and the incident and budget limits hold", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    await fc.assert(fc.asyncProperty(operations, async (operations) => {
      const readDb = openInMemoryStateDb();
      const oracleDb = openInMemoryStateDb();
      const reader = new SqliteOverlayStore(readDb);
      const oracle = new SqliteOverlayStore(oracleDb);
      const start = 1_000;
      let now = start;
      const model: Model = { activeKinds: new Set(), startedThisEpoch: 0, reserved: new Set(), dispatching: new Map(), netSpent: 0,
        tokens: budget.capacity, tokensAt: start };
      try {
        for (const store of [reader, oracle]) {
          await store.setThreadPrAutoDispatchEnabled({ ...THREAD, enabled: true });
          await store.syncThreadPrAutoDispatchCandidates({ ...THREAD, prKeys: [PR_KEY], now });
        }
        for (const op of operations) {
          now += op.advance;
          const actual = await runWrite(reader, op, now);
          const expected = await runWrite(oracle, op, now);
          expect(actual, `${op.kind}: a read changed this answer`).toEqual(expected);
          observeWrite(model, op, actual, now);

          for (const read of op.reads) {
            const { writes } = await measureSqliteWrites(() => runRead(reader, read, now));
            // The renderer's budget-status read applies refill durably by
            // design (one commit); every other read commits nothing.
            expect(writes.commits, `${read} wrote`).toBe(read === "status" ? 1 : 0);
          }

          const attempts = await oracle.getThreadPrAutoDispatchAttemptCount({ ...THREAD, prKey: PR_KEY });
          expect(attempts).toBeGreaterThanOrEqual(0);
          expect(attempts).toBeLessThanOrEqual(MAX);
          expect(model.startedThisEpoch, "an incident started more than MAX repairs").toBeLessThanOrEqual(MAX);

          const earned = Math.floor(((now - start) * budget.refillPerMinute) / 60_000);
          expect(model.netSpent, "the budget admitted more than capacity + refill").toBeLessThanOrEqual(budget.capacity + earned);
          const peek = await oracle.peekPrAutoDispatchBudgetStatus({ config: budget, now });
          expect(peek.availableTokens).toBeLessThanOrEqual(budget.capacity);
          const expectedTokens = modelTokens(model, now);
          expect(peek.availableTokens, "the budget holds more than spends and refunds left")
            .toBeLessThanOrEqual(Math.floor(expectedTokens + 1e-9));
          expect(peek.availableTokens, "the budget holds less than spends and refunds left")
            .toBeGreaterThanOrEqual(Math.floor(expectedTokens - 1e-9));
        }
        for (const read of READS) {
          expect(await runRead(reader, read, now), `final ${read}`).toEqual(await runRead(oracle, read, now));
        }
      } finally { readDb.close(); oracleDb.close(); }
    }), { numRuns: 60, examples: STORE_EXAMPLES });
  });
});

/*
 * The same rule 2 through the coordinator, fed what the poller and the
 * agent status tools feed it: a stream of PR observations, some with checks
 * still running, some with a new head after a repair push, interleaved with
 * every read an agent or the Activity window makes. A repair turn counts
 * when `submitTurnIfIdle` starts one.
 */
const HEADS = ["a", "b", "c", "d", "e", "f"].map((digit) => digit.repeat(40));
const observation = fc.record({
  head: fc.constantFrom(...HEADS),
  checkState: fc.constantFrom("failing", "failing", "failing", "pending", "unknown", "passing"),
  mergeState: fc.constantFrom("conflicting", "unknown", "unknown", "unknown", "mergeable"),
  checksStillRunning: fc.boolean(),
  submission: fc.constantFrom("started", "started", "started", "busy", "throws"),
  advance: fc.integer({ min: 0, max: 120_000 }),
  reads: fc.subarray([...READS]),
});

type Observation = typeof observation extends fc.Arbitrary<infer T> ? T : never;

/*
 * Kept as a fixed example: two repairs spend the incident, then the repair
 * push's checks are pending. Pending is not healthy, so the next failing
 * heads must hit the limit rather than start a fresh incident.
 */
const failing = (head: string): Observation => ({
  head, checkState: "failing", mergeState: "unknown", checksStillRunning: false,
  submission: "started", advance: 60_000, reads: ["attempts"],
});
const PENDING_IS_NOT_HEALTHY: Observation[] = [
  failing(HEADS[0]!),
  failing(HEADS[1]!),
  { ...failing(HEADS[2]!), checkState: "pending", checksStillRunning: true },
  failing(HEADS[3]!),
  failing(HEADS[4]!),
];

function observedPr(step: Observation): PrSummary {
  return {
    provider: "github.com", number: 1, org: "example", repo: "project",
    title: "Fixture PR", state: "failing", lifecycleState: "open", reviewState: "ready_for_review",
    checkState: step.checkState as PrSummary["checkState"],
    mergeState: step.mergeState as PrSummary["mergeState"],
    checksStillRunning: step.checksStillRunning,
    headSha: step.head, commitShas: [step.head],
    url: "https://github.com/example/project/pull/1",
  };
}

describe("Auto-fix repair turns over a PR stream (model)", () => {
  it("never starts more than MAX repairs between legitimate resets", async () => {
    await fc.assert(fc.asyncProperty(fc.array(observation, { minLength: 1, maxLength: 40 }), async (steps) => {
      const db = openInMemoryStateDb();
      const store = new SqliteOverlayStore(db);
      let now = 1_000;
      let currentPr: PrSummary | undefined;
      let submission: (typeof steps)[number]["submission"] = "started";
      let started = 0;
      const coordinator = new PrAutoDispatchCoordinator({
        store,
        registry: {
          submitTurnIfIdle: async () => {
            if (submission === "throws") throw new Error("submission rejected");
            if (submission === "busy") return { status: "busy" as const };
            started += 1;
            return { status: "started" as const, turnId: `turn-${started}` };
          },
        },
        getCurrentPr: () => currentPr,
        isPrAttached: () => true,
        isBackgroundPollingEnabled: () => true,
        getBudgetConfig: () => ({ capacity: 1_000, refillPerMinute: 1_000, pauseWhenEmpty: false }),
        now: () => now,
      });
      // The promise, computed from the observations: the kinds a scheduled
      // repair targeted, minus kinds a definitive observation resolves. A
      // kind that only reappears as a duplicate of an earlier repair was
      // never targeted again, so it joins nothing.
      const active = new Set<ThreadPrAutoDispatchEventKind>();
      let epochStart = 0;
      try {
        await store.setThreadPrAutoDispatchEnabled({ ...THREAD, enabled: true });
        for (const step of steps) {
          now += step.advance;
          submission = step.submission;
          const pr = observedPr(step);
          currentPr = pr;
          const resolved: ThreadPrAutoDispatchEventKind[] = [];
          if (pr.checkState === "passing") resolved.push("ci-failure");
          if (pr.mergeState === "mergeable") resolved.push("merge-conflict");
          const hadKinds = active.size > 0;
          for (const kind of resolved) active.delete(kind);
          if (hadKinds && active.size === 0) epochStart = started;
          const kinds: ThreadPrAutoDispatchEventKind[] = [];
          if (pr.checkState === "failing" && !pr.checksStillRunning) kinds.push("ci-failure");
          if (pr.mergeState === "conflicting") kinds.push("merge-conflict");

          const [outcome] = await coordinator.handleStatusSnapshot({
            pr, threadKeys: ["codex:thread-1"], observedAt: now, backgroundPollingEnabled: true,
          });
          if (outcome?.status === "scheduled") {
            if (kinds.some((kind) => !active.has(kind))) epochStart = started;
            for (const kind of kinds) active.add(kind);
          }
          for (const read of step.reads) await runRead(store, read, now);
          const record = await store.getThreadPrAutoDispatchPending(THREAD);
          if (record) await coordinator.sendPendingNow({ ...THREAD, fingerprint: record.pending.fingerprint });
          for (const read of step.reads) await runRead(store, read, now);

          expect(started - epochStart, "an incident started more than MAX repair turns").toBeLessThanOrEqual(MAX);
        }
      } finally {
        coordinator.close();
        db.close();
      }
    }), { numRuns: 120, examples: [[PENDING_IS_NOT_HEALTHY]] });
  });
});

/*
 * Rule 2 again, with the operator's preference in the stream. Only an
 * off -> on change is a legitimate reset. A thread that is already on can
 * receive `enabled: true` again: a stale viewer's composer toggle sends
 * `!thread.prAutoDispatchEnabled`, and a peer can forward the same request.
 * Each repeat once cleared the incident, so every repeat bought MAX more
 * repair turns for the same failure.
 *
 * The registry is real, so the value the request replaced comes from the
 * production store read. The handler forwards to the coordinator the way
 * `applyThreadPrAutoDispatchPreferences` does.
 */
const enableStep = fc.record({
  observation,
  /** Repeated `enabled: true` requests around this observation. */
  reenables: fc.integer({ min: 0, max: 3 }),
  beforeSnapshot: fc.boolean(),
  /** An operator turning Auto-fix off and back on: a legitimate reset. */
  toggle: fc.constantFrom(false, false, false, false, true),
});
type EnableStep = typeof enableStep extends fc.Arbitrary<infer T> ? T : never;

async function runPreferenceStream(steps: EnableStep[]): Promise<{ started: number; maxPerEpoch: number }> {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const registry = createDesktopBackendRegistry({
    codexClient: new CountingBackendClient([]) as never, overlayStore: store, threadTitleGenerationService: null,
  });
  let now = 1_000;
  let currentPr: PrSummary | undefined;
  let submission: Observation["submission"] = "started";
  let started = 0;
  const coordinator = new PrAutoDispatchCoordinator({
    store,
    registry: {
      submitTurnIfIdle: async () => {
        if (submission === "throws") throw new Error("submission rejected");
        if (submission === "busy") return { status: "busy" as const };
        started += 1;
        return { status: "started" as const, turnId: `turn-${started}` };
      },
    },
    getCurrentPr: () => currentPr,
    isPrAttached: () => true,
    isBackgroundPollingEnabled: () => true,
    getBudgetConfig: () => ({ capacity: 1_000, refillPerMinute: 1_000, pauseWhenEmpty: false }),
    now: () => now,
  });
  registry.setThreadPrAutoDispatchHandler({
    preferenceChanged: async (change) => {
      if (change.enabled) await coordinator.resetIfTurnedOn(change);
      else await coordinator.cancelAllPendingForThread(change);
    },
    cancelPending: async () => false,
    sendPendingNow: async () => false,
  });
  const setEnabled = async (enabled: boolean) =>
    await registry.setThreadPrAutoDispatch({ ...THREAD, enabled });
  const reenable = async (count: number) => {
    for (let i = 0; i < count; i += 1) await setEnabled(true);
  };
  // Same oracle as above, plus: an off -> on toggle starts a new epoch.
  const active = new Set<ThreadPrAutoDispatchEventKind>();
  let epochStart = 0;
  let maxPerEpoch = 0;
  try {
    await setEnabled(true);
    for (const { observation: step, reenables, beforeSnapshot, toggle } of steps) {
      now += step.advance;
      submission = step.submission;
      if (toggle) {
        await setEnabled(false);
        await setEnabled(true);
        active.clear();
        epochStart = started;
      }
      const pr = observedPr(step);
      currentPr = pr;
      const resolved: ThreadPrAutoDispatchEventKind[] = [];
      if (pr.checkState === "passing") resolved.push("ci-failure");
      if (pr.mergeState === "mergeable") resolved.push("merge-conflict");
      const hadKinds = active.size > 0;
      for (const kind of resolved) active.delete(kind);
      if (hadKinds && active.size === 0) epochStart = started;
      const kinds: ThreadPrAutoDispatchEventKind[] = [];
      if (pr.checkState === "failing" && !pr.checksStillRunning) kinds.push("ci-failure");
      if (pr.mergeState === "conflicting") kinds.push("merge-conflict");

      if (beforeSnapshot) await reenable(reenables);
      const [outcome] = await coordinator.handleStatusSnapshot({
        pr, threadKeys: ["codex:thread-1"], observedAt: now, backgroundPollingEnabled: true,
      });
      if (outcome?.status === "scheduled") {
        if (kinds.some((kind) => !active.has(kind))) epochStart = started;
        for (const kind of kinds) active.add(kind);
      }
      const record = await store.getThreadPrAutoDispatchPending(THREAD);
      if (record) await coordinator.sendPendingNow({ ...THREAD, fingerprint: record.pending.fingerprint });
      if (!beforeSnapshot) await reenable(reenables);
      maxPerEpoch = Math.max(maxPerEpoch, started - epochStart);
    }
    return { started, maxPerEpoch };
  } finally {
    coordinator.close();
    await registry.close();
    db.close();
  }
}

const failingStep = (head: string, reenables: number, toggle = false): EnableStep => ({
  observation: failing(head), reenables, beforeSnapshot: false, toggle,
});

describe("Auto-fix repair turns with repeated enable requests (model)", () => {
  it("never lets repeated `enabled: true` start more than MAX repairs for one incident", async () => {
    await fc.assert(fc.asyncProperty(fc.array(enableStep, { minLength: 1, maxLength: 30 }), async (steps) => {
      const { maxPerEpoch } = await runPreferenceStream(steps);
      expect(maxPerEpoch, "an incident started more than MAX repair turns").toBeLessThanOrEqual(MAX);
    }), {
      numRuns: 100,
      // A failing PR with a repeat after every repair: the shortest refill.
      examples: [[HEADS.slice(0, 5).map((head) => failingStep(head, 1))]],
    });
  });

  it("still gives the operator a fresh start when Auto-fix turns off and back on", async () => {
    const spent = await runPreferenceStream(HEADS.slice(0, 4).map((head) => failingStep(head, 0)));
    expect(spent.started).toBe(MAX);
    const restarted = await runPreferenceStream([
      ...HEADS.slice(0, 3).map((head) => failingStep(head, 0)),
      failingStep(HEADS[3]!, 0, true),
    ]);
    expect(restarted.started).toBe(MAX + 1);
  });
});
