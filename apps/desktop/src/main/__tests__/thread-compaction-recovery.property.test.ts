import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ManageThreadDependenciesRequest } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ThreadDependencyCoordinator } from "../app-server/thread-dependency-coordinator";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let db: StateDb;
let store: ThreadDependencyStore;
let tempDir: string;
let testClock: number;
const target = { backend: "codex" as const, threadId: "worker" };
const registration = (): ManageThreadDependenciesRequest => ({
  action: "create", ...target,
  conditions: [{ ...target, when: "compaction_completed" }],
  continuation: "Read /workspace/INSTRUCTIONS.md and rediscover recovery tools. Preserve the assigned paragraph.",
  repeat: true,
});

beforeEach(() => {
  testClock = 10_000_000;
  const temp = createTempStateDb("pwragent-compaction-recovery-");
  tempDir = temp.tempDir;
  db = StateDb.open(temp.dbPath);
  store = new ThreadDependencyStore(db.raw);
});
afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); });

// Rule: registering the same self event hook any number of times produces
// one durable subscription and never runs a task or creates a wait cycle.
it("self-registration is idempotent and waits only for future events", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (count) => {
    const submit = vi.fn(async () => ({ status: "started" as const }));
    const agent = new ThreadDependencyCoordinator({
      store, readThread: async () => ({ turns: [], prs: [] }), submit,
      changed: async () => undefined,
    });
    const ids = new Set<string>();
    for (let index = 0; index < count; index++) {
      const result = await agent.manage({ ...registration(), ...target });
      ids.add(result.dependencies[0]!.id);
    }
    expect(ids.size).toBe(1);
    expect(store.active()).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
  }), { numRuns: 10 });
});

function harness(extra: Partial<ConstructorParameters<typeof ThreadDependencyCoordinator>[0]> = {}) {
  const recover = vi.fn(async (_item, _prompt, canSubmit) => ({ status: canSubmit() ? "steered" as const : "discarded" as const, turnId: "assignment" }));
  const submit = vi.fn(async () => ({ status: "started" as const }));
  const agent = new ThreadDependencyCoordinator({
    store, readThread: async () => ({ turns: [], prs: [] }), submit,
    recoverCompaction: recover, changed: async () => undefined,
    hasDeliveryReceipt: (item) => store.hasDeliveryReceipt(item),
    now: () => testClock,
    ...extra,
  });
  return { agent, recover, submit };
}
const event = (itemId: string, turnId = "assignment") => ({ ...target, turnId, itemId });
const register = (agent: ThreadDependencyCoordinator, repeat = true) => agent.manage({ ...registration(), ...target, repeat });
const cycle = async (agent: ThreadDependencyCoordinator, itemId: string, turnId = "assignment") => {
  // Lifecycle tests isolate protocol rules from the separately tested loop guard.
  testClock += 31 * 60_000;
  await agent.handleCompactionItem(event(itemId, turnId), "started");
  await agent.handleCompactionItem(event(itemId, turnId), "completed");
};

// Oracle: the provider's live lifecycle. Only distinct successful completed
// items with an observed start count, once each, even across owner restarts.
it("matches a lifecycle model under redelivery and restart", async () => {
  let run = 0;
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    operation: fc.constantFrom("start", "complete", "fail", "restart"),
    id: fc.integer({ min: 0, max: 5 }),
  }), { minLength: 25, maxLength: 45 }), async (commands) => {
    const turnId = `lifecycle-assignment-${run++}`;
    const registered = await register(harness().agent);
    const id = registered.dependencies.find((item) => item.status === "waiting")!.id;
    const started = new Set<number>();
    const seenInConnection = new Set<number>();
    const consumed = new Set<number>();
    let expected = 0;
    let actual = 0;
    let runtime = harness();
    for (const command of commands) {
      if (command.operation === "restart") {
        started.clear(); seenInConnection.clear();
        runtime = harness();
        await runtime.agent.reconcile();
      } else if (command.operation === "start") {
        if (!seenInConnection.has(command.id)) started.add(command.id);
        await runtime.agent.handleCompactionItem(event(`item-${command.id}`, turnId), "started");
      } else if (command.operation === "fail") {
        if (started.size || seenInConnection.size) {
          started.delete(command.id); seenInConnection.add(command.id);
        }
        await runtime.agent.handleCompactionItem(event(`item-${command.id}`, turnId), "failed");
      } else {
        testClock += 31 * 60_000;
        if (started.delete(command.id) && !seenInConnection.has(command.id)) {
          seenInConnection.add(command.id);
          if (!consumed.has(command.id)) { consumed.add(command.id); expected++; }
        }
        const before = runtime.recover.mock.calls.length;
        await runtime.agent.handleCompactionItem(event(`item-${command.id}`, turnId), "completed");
        actual += runtime.recover.mock.calls.length - before;
      }
      expect(actual).toBe(expected);
      expect(store.active().filter((item) => item.id === id)).toHaveLength(1);
      expect(runtime.submit).not.toHaveBeenCalled();
    }
    await runtime.agent.handleThreadEvent(target, { id: turnId, status: "completed" });
    await runtime.agent.manage({ action: "cancel", ...target, dependencyId: id });
  }), { numRuns: 25 });
});

it("ignores starts, legacy notices, failed items and historical reads", async () => {
  const { agent, recover } = harness();
  await register(agent);
  const notify = (method: string, item: Record<string, unknown> = {}) => agent.handleCompactionNotification({
    method, params: { threadId: target.threadId, turnId: "assignment", item: { type: "contextCompaction", id: "compact", ...item } },
  } as Parameters<typeof agent.handleCompactionNotification>[0]);
  await notify("thread/read");
  await notify("thread/compacted");
  await notify("item/completed"); // history-like completion without a live start
  await notify("item/started");
  expect(recover).not.toHaveBeenCalled();
  await notify("item/completed", { success: false });
  await notify("item/completed");
  expect(recover).not.toHaveBeenCalled();
  await cycle(agent, "future");
  await cycle(agent, "future");
  expect(recover).toHaveBeenCalledTimes(1);
  expect(recover.mock.calls[0]![1]).toContain("not paper or session content");
  expect(recover.mock.calls[0]![1]).toContain(registration().continuation);
});

it("keeps one recurring hook across real database reopen and future turns", async () => {
  const first = harness();
  await register(first.agent);
  await cycle(first.agent, "one");
  const dbPath = db.raw.name;
  db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
  const restored = harness();
  await restored.agent.reconcile();
  await restored.agent.handleCompactionItem(event("one"), "completed");
  await cycle(restored.agent, "one");
  expect(restored.recover).not.toHaveBeenCalled();
  await cycle(restored.agent, "two");
  await restored.agent.handleThreadEvent(target, { id: "assignment", status: "completed" });
  await cycle(restored.agent, "three", "next-assignment");
  expect(restored.recover).toHaveBeenCalledTimes(2);
  expect(store.active()).toHaveLength(1);
  expect(store.active()[0]!.compaction?.completedItemIds).toEqual(["three"]);
});

it("defaults to one future completion and cancellation revokes an unclaimed hook", async () => {
  const { agent, recover, submit } = harness();
  const result = await register(agent, false);
  await cycle(agent, "one");
  await cycle(agent, "two");
  expect(recover).toHaveBeenCalledTimes(1);
  expect(store.get("codex", "worker", result.dependencies[0]!.id)?.status).toBe("delivered");
  const repeat = await register(agent);
  const hook = repeat.dependencies.find((item) => item.status === "waiting")!;
  await agent.handleCompactionItem(event("three"), "started");
  await agent.manage({ action: "cancel", ...target, dependencyId: hook.id });
  await agent.handleCompactionItem(event("three"), "completed");
  expect(recover).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

it.each(["completed", "failed", "cancelled", "interrupted"] as const)("a %s turn cannot release deferred recovery", async (status) => {
  let available = false;
  const { agent, recover } = harness({ canDispatch: () => available });
  await register(agent);
  await cycle(agent, "one");
  expect(store.active()[0]?.status).toBe("ready");
  available = true;
  await agent.handleThreadEvent(target, { id: "assignment", status });
  await cycle(agent, "one");
  expect(recover).not.toHaveBeenCalled();
  expect(store.active()[0]?.error).toContain("no longer active");
});

it("archive revokes the claim during publication before steering", async () => {
  const { agent, recover } = harness({ changed: async (item) => {
    if (item.status === "dispatching") store.retireForArchivedThread(target, Date.now());
  } });
  await register(agent);
  await cycle(agent, "one");
  expect(recover).not.toHaveBeenCalled();
  expect(store.list("codex", "worker")[0]?.status).toBe("cancelled");
});

it("does not replay an uncertain steer after restart; per-event receipts rearm only its hook", async () => {
  const first = harness({ recoverCompaction: async () => { throw new Error("lost acknowledgement"); } });
  await register(first.agent);
  await cycle(first.agent, "one");
  const claimed = store.active()[0]!;
  expect(claimed.status).toBe("dispatching");
  const restored = harness();
  await restored.agent.reconcile();
  expect(restored.recover).not.toHaveBeenCalled();
  db.raw.prepare("INSERT INTO thread_message_origins(backend, thread_id, message_id, created_at, payload) VALUES (?, ?, ?, ?, ?)")
    .run("codex", "worker", "receipt", 1, JSON.stringify({ kind: "pwragent", dependencyId: JSON.stringify([claimed.id, "assignment", "one"]) }));
  expect(store.hasDeliveryReceipt({ ...claimed, compaction: { ...claimed.compaction!, turnId: "another-assignment" } })).toBe(false);
  await restored.agent.reconcile();
  expect(store.active()[0]?.status).toBe("waiting");
  await cycle(restored.agent, "two");
  expect(restored.recover).toHaveBeenCalledTimes(1);
});

it("one SQLite claim owns an event observed by two coordinators", async () => {
  const first = harness();
  await register(first.agent);
  const otherDb = StateDb.open(db.raw.name);
  try {
    const otherStore = new ThreadDependencyStore(otherDb.raw);
    const second = harness({ store: otherStore });
    await Promise.all([cycle(first.agent, "shared"), cycle(second.agent, "shared")]);
    expect(first.recover.mock.calls.length + second.recover.mock.calls.length).toBe(1);
    expect(store.active()).toHaveLength(1);
  } finally { otherDb.close(); }
});

it("unrelated PR events cannot retry a locked recovery or add writes", async () => {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  const dbPath = db.raw.name;
  db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
  const recover = vi.fn(async () => ({ status: "busy" as const }));
  const { agent } = harness({ recoverCompaction: recover });
  await register(agent);
  await cycle(agent, "locked");
  expect(store.active()[0]?.status).toBe("ready");
  const { measureSqliteWrites } = await import("../state/sqlite-write-metrics");
  const { expectSqliteWriteBudget } = await import("./fixtures/sqlite-write-budget");
  const { writes } = await measureSqliteWrites(async () => {
    for (let index = 0; index < 100; index++) {
      await agent.handlePrEvent();
      await agent.handleThreadEvent(target);
    }
  });
  expect(recover).toHaveBeenCalledTimes(1);
  expectSqliteWriteBudget({ scenario: "compaction-recovery-unrelated-events",
    note: "One locked pending recovery followed by 100 PR and thread metadata events; no retry or persistence without an availability boundary.", writes });
});

it("budgets completed compactions rather than starts, duplicates or unrelated items", async () => {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  const dbPath = db.raw.name;
  db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
  const { agent } = harness();
  await register(agent);
  const { measureSqliteWrites } = await import("../state/sqlite-write-metrics");
  const { expectSqliteWriteBudget } = await import("./fixtures/sqlite-write-budget");
  const { writes } = await measureSqliteWrites(async () => {
    for (let index = 0; index < 8; index++) {
      await cycle(agent, `budget-${index}`);
      for (let duplicate = 0; duplicate < 20; duplicate++) await cycle(agent, `budget-${index}`);
    }
  });
  expectSqliteWriteBudget({ scenario: "compaction-recovery-eight-completions",
    note: "Eight distinct live compactions, each with twenty duplicate lifecycle pairs; one subscription, ready/claim/rearm per completion, no start/duplicate writes.", writes });
  vi.unstubAllEnvs();
});

// Rule: distinct completion IDs do not bypass the recovery cooldown.
it("distinct compactions inside the cooldown can admit at most one recovery", async () => {
  let run = 0;
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (count) => {
    const runId = run++;
    const now = 10_000_000 + runId * 31 * 60_000;
    const { agent, recover } = harness({ now: () => now });
    const registered = await register(agent);
    const hook = registered.dependencies.find((item) => item.status === "waiting")!;
    for (let index = 0; index < count; index++) await cycle(agent, `rapid-${runId}-${index}`, `rapid-assignment-${runId}`);
    expect(recover).toHaveBeenCalledTimes(1);
    await agent.manage({ action: "cancel", ...target, dependencyId: hook.id });
  }), { numRuns: 10 });
});

it("latches a thread-wide breaker across restart, new hooks and elapsed time", async () => {
  let now = 10_000_000;
  let runtime = harness({ now: () => now });
  await register(runtime.agent);
  for (let index = 0; index < 3; index++) {
    await cycle(runtime.agent, `burst-${index}`);
    now += 5 * 60_000;
  }
  expect(runtime.recover).toHaveBeenCalledTimes(3);
  await cycle(runtime.agent, "trip");
  const response = await runtime.agent.manage({ action: "list", ...target });
  expect(response.recoveryProtection?.suspendedAt).toBe(now);
  expect(runtime.recover).toHaveBeenCalledTimes(3);
  const dbPath = db.raw.name;
  db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
  now += 24 * 60 * 60_000;
  runtime = harness({ now: () => now });
  await runtime.agent.reconcile();
  const hooks = await runtime.agent.manage({ ...registration(), ...target, continuation: "Different authorized recovery instructions." });
  await cycle(runtime.agent, "after-restart", "new-assignment");
  expect(runtime.recover).not.toHaveBeenCalled();
  expect(hooks.recoveryProtection?.suspendedAt).toBeDefined();
  for (const actor of ["agent:codex:worker", "peer:another-instance"]) {
    await expect(runtime.agent.manage({ action: "rearm_compaction", ...target }, undefined, actor)).rejects.toThrow("Only the operator");
  }
  await runtime.agent.manage({ action: "rearm_compaction", ...target }, undefined, "operator");
  await cycle(runtime.agent, "operator-rearmed", "new-assignment");
  // All hooks share the same limiter: only one can use this fresh admission.
  expect(runtime.recover).toHaveBeenCalledTimes(1);
});

it("counts uncertain admissions and refuses wall-clock rollback bypasses", async () => {
  let now = 10_000_000;
  const first = harness({ now: () => now, recoverCompaction: async () => { throw new Error("lost acknowledgement"); } });
  await register(first.agent);
  await cycle(first.agent, "uncertain");
  const second = harness({ now: () => now });
  await second.agent.manage({ ...registration(), ...target, continuation: "Another stable prompt." });
  now -= 60_000;
  await cycle(second.agent, "clock-backward");
  now += 2 * 60_000;
  await cycle(second.agent, "still-cooling");
  expect(second.recover).not.toHaveBeenCalled();
  now += 5 * 60_000;
  await cycle(second.agent, "cooled");
  expect(second.recover).toHaveBeenCalledTimes(1);
});

it("reserves one budget slot when two owners claim different hooks concurrently", async () => {
  const now = 10_000_000;
  const first = harness({ now: () => now });
  await register(first.agent);
  const otherDb = StateDb.open(db.raw.name);
  try {
    const otherStore = new ThreadDependencyStore(otherDb.raw);
    const second = harness({ store: otherStore, now: () => now });
    await second.agent.manage({ ...registration(), ...target, continuation: "Another authorized prompt." });
    await Promise.all([cycle(first.agent, "concurrent-first"), cycle(second.agent, "concurrent-second")]);
    expect(first.recover.mock.calls.length + second.recover.mock.calls.length).toBe(1);
    expect(store.compactionRecoveryProtection(target, now).attemptsInWindow).toBe(1);
  } finally { otherDb.close(); }
});

it("models the durable cooldown and operator-only circuit breaker over generated event sequences", async () => {
  let run = 0;
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    advance: fc.integer({ min: 0, max: 8 * 60_000 }),
    operation: fc.constantFrom("event", "restart", "register", "operator_rearm"),
  }), { minLength: 35, maxLength: 50 }), async (commands) => {
    const runId = run++;
    const identity = { backend: "codex" as const, threadId: `rate-worker-${runId}` };
    let now = 10_000_000;
    let attempts: number[] = [];
    let attemptsInTurn = 0;
    let suspended = false;
    let expected = 0;
    let actual = 0;
    const recover = vi.fn(async () => { actual++; return { status: "steered" as const }; });
    const createRuntime = () => harness({ now: () => now, recoverCompaction: recover }).agent;
    let agent = createRuntime();
    const hook = { ...registration(), ...identity, conditions: [{ ...identity, when: "compaction_completed" as const }] };
    await agent.manage(hook);
    // Reach the limiter on every run, then explore resets/restarts and boundary times.
    const events = [0, 5 * 60_000, 5 * 60_000, 5 * 60_000].map((advance) => ({ operation: "event", advance }));
    let item = 0;
    for (const command of [...events, ...commands]) {
      now += command.advance;
      if (command.operation === "restart") { agent = createRuntime(); await agent.reconcile(); }
      else if (command.operation === "register") await agent.manage(hook);
      else if (command.operation === "operator_rearm") {
        await agent.manage({ action: "rearm_compaction", ...identity }, undefined, "operator");
        attempts = []; attemptsInTurn = 0; suspended = false;
      } else {
        const last = attempts.at(-1);
        if (!suspended && (last === undefined || now - last >= 5 * 60_000)) {
          attempts = attempts.filter((at) => now - at < 30 * 60_000);
          if (attempts.length === 3 || attemptsInTurn === 8) suspended = true;
          else { expected++; attemptsInTurn++; attempts.push(now); }
        }
        const event = { ...identity, turnId: "assignment", itemId: `generated-${item++}` };
        await agent.handleCompactionItem(event, "started");
        await agent.handleCompactionItem(event, "completed");
      }
      expect(actual).toBe(expected);
      expect(store.compactionRecoveryProtection(identity, now).suspendedAt !== undefined).toBe(suspended);
    }
  }), { numRuns: 15 });
});

it("budgets suppressed distinct events and a durable trip plus operator rearm", async () => {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  const dbPath = db.raw.name;
  db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
  let now = 10_000_000;
  const { agent } = harness({ now: () => now });
  await register(agent);
  await cycle(agent, "initial");
  const { measureSqliteWrites } = await import("../state/sqlite-write-metrics");
  const { expectSqliteWriteBudget } = await import("./fixtures/sqlite-write-budget");
  const suppressed = await measureSqliteWrites(async () => {
    for (let index = 0; index < 100; index++) await cycle(agent, `suppressed-${index}`);
  });
  expectSqliteWriteBudget({ scenario: "compaction-recovery-cooldown-suppression",
    note: "100 distinct live compactions during one thread-wide cooldown; no dispatches, timers or writes.", writes: suppressed.writes });
  for (let index = 0; index < 2; index++) { now += 5 * 60_000; await cycle(agent, `limited-${index}`); }
  const tripAndRearm = await measureSqliteWrites(async () => {
    now += 5 * 60_000;
    await cycle(agent, "trip-budget");
    for (let index = 0; index < 100; index++) await cycle(agent, `suspended-${index}`);
    await agent.manage({ action: "rearm_compaction", ...target }, undefined, "operator");
  });
  expectSqliteWriteBudget({ scenario: "compaction-recovery-trip-and-rearm",
    note: "One durable circuit trip, 100 suppressed distinct events, then an explicit operator rearm including clearing the hook's visible error.", writes: tripAndRearm.writes });
});

it("admits at the five-minute boundary and never one millisecond earlier", async () => {
  let now = 10_000_000;
  const { agent, recover } = harness({ now: () => now });
  await register(agent);
  await cycle(agent, "boundary-first");
  now += 5 * 60_000 - 1;
  await cycle(agent, "boundary-early");
  expect(recover).toHaveBeenCalledTimes(1);
  now++;
  await cycle(agent, "boundary-exact");
  expect(recover).toHaveBeenCalledTimes(2);
});

it.each([-1, 0, 1])("uses the rolling window boundary exactly (%s ms)", async (offset) => {
  const startedAt = 10_000_000;
  let now = startedAt;
  const { agent, recover } = harness({ now: () => now });
  await register(agent);
  for (let index = 0; index < 3; index++) { await cycle(agent, `window-${index}`); now += 5 * 60_000; }
  now = startedAt + 30 * 60_000 + offset;
  await cycle(agent, "window-next");
  expect(recover).toHaveBeenCalledTimes(offset < 0 ? 3 : 4);
  expect(store.compactionRecoveryProtection(target, now).suspendedAt !== undefined).toBe(offset < 0);
});

it("stops a slow loop after eight recoveries in one active turn, even across a restart", async () => {
  let now = 10_000_000;
  const recover = vi.fn(async () => ({ status: "steered" as const }));
  let runtime = harness({ now: () => now, recoverCompaction: recover });
  await register(runtime.agent);
  for (let index = 0; index < 8; index++) {
    now += 31 * 60_000;
    await cycle(runtime.agent, `slow-${index}`);
    if (index === 4) runtime = harness({ now: () => now, recoverCompaction: recover });
  }
  expect(recover).toHaveBeenCalledTimes(8);
  now += 31 * 60_000;
  await cycle(runtime.agent, "slow-limit");
  expect(recover).toHaveBeenCalledTimes(8);
  expect(store.compactionRecoveryProtection(target, now).suspendedAt).toBe(now);
  await cycle(runtime.agent, "new-turn-cannot-clear-a-trip", "another-turn");
  expect(recover).toHaveBeenCalledTimes(8);
});
