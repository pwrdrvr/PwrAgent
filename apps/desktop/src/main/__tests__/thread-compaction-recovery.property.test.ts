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
const target = { backend: "codex" as const, threadId: "worker" };
const registration = (): ManageThreadDependenciesRequest => ({
  action: "create", ...target,
  conditions: [{ ...target, when: "compaction_completed" }],
  continuation: "Read /workspace/INSTRUCTIONS.md and rediscover recovery tools. Preserve the assigned paragraph.",
  repeat: true,
});

beforeEach(() => {
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
    ...extra,
  });
  return { agent, recover, submit };
}
const event = (itemId: string, turnId = "assignment") => ({ ...target, turnId, itemId });
const register = (agent: ThreadDependencyCoordinator, repeat = true) => agent.manage({ ...registration(), ...target, repeat });
const cycle = async (agent: ThreadDependencyCoordinator, itemId: string, turnId = "assignment") => {
  await agent.handleCompactionItem(event(itemId, turnId), "started");
  await agent.handleCompactionItem(event(itemId, turnId), "completed");
};

// Oracle: the provider's live lifecycle. Only distinct successful completed
// items with an observed start count, once each, even across owner restarts.
it("matches a lifecycle model under redelivery and restart", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    operation: fc.constantFrom("start", "complete", "fail", "restart"),
    id: fc.integer({ min: 0, max: 5 }),
  }), { minLength: 25, maxLength: 45 }), async (commands) => {
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
        await runtime.agent.handleCompactionItem(event(`item-${command.id}`), "started");
      } else if (command.operation === "fail") {
        if (started.size || seenInConnection.size) {
          started.delete(command.id); seenInConnection.add(command.id);
        }
        await runtime.agent.handleCompactionItem(event(`item-${command.id}`), "failed");
      } else {
        if (started.delete(command.id) && !seenInConnection.has(command.id)) {
          seenInConnection.add(command.id);
          if (!consumed.has(command.id)) { consumed.add(command.id); expected++; }
        }
        const before = runtime.recover.mock.calls.length;
        await runtime.agent.handleCompactionItem(event(`item-${command.id}`), "completed");
        actual += runtime.recover.mock.calls.length - before;
      }
      expect(actual).toBe(expected);
      expect(store.active().filter((item) => item.id === id)).toHaveLength(1);
      expect(runtime.submit).not.toHaveBeenCalled();
    }
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
