import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary, ThreadDependency, ThreadDependencyCondition } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ThreadDependencyCoordinator, type DependencyThreadSnapshot } from "../app-server/thread-dependency-coordinator";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

let db: StateDb;
let store: ThreadDependencyStore;
let tempDir: string;
let dbPath: string;
let now: number;
let busy: boolean;
let snapshots: Map<string, DependencyThreadSnapshot>;
const submit = vi.fn(async (_params: { threadId: string }): Promise<{ status: "started" | "busy"; turnId?: string }> => ({ status: "started", turnId: "continuation-turn" }));
const condition = (threadId: string, when: ThreadDependencyCondition["when"] = "ci_passed"): ThreadDependencyCondition => ({ backend: "codex", threadId, when });
const pr = (overrides: Partial<PrSummary> = {}): PrSummary => ({
  provider: "github.com", org: "example", repo: "fixture", number: 1,
  url: "https://github.com/example/fixture/pull/1", state: "pending",
  checkState: "pending", lifecycleState: "open", reviewState: "ready_for_review",
  headSha: "head-one", ...overrides,
});

function coordinator(dependencyStore = store, changed: (item: ThreadDependency) => Promise<void> = async () => undefined): ThreadDependencyCoordinator {
  return new ThreadDependencyCoordinator({
    store: dependencyStore,
    readThread: async (target) => {
      const snapshot = snapshots.get(target.threadId);
      if (!snapshot) throw new Error("Thread not found");
      return snapshot;
    },
    isConsumerBusy: () => busy,
    submit,
    changed,
    now: () => now,
    hasDeliveryReceipt: (item) => dependencyStore.hasDeliveryReceipt(item),
  });
}

function create(agent: ThreadDependencyCoordinator, conditions = [condition("foundation")], extra: { mode?: "all" | "any"; onFailure?: "wait" | "notify"; threadId?: string } = {}) {
  return agent.manage({ action: "create", backend: "codex", threadId: "dependencies", conditions, ...extra });
}

beforeEach(() => {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  const temp = createTempStateDb("pwragent-dependencies-");
  tempDir = temp.tempDir; dbPath = temp.dbPath;
  db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
  now = 100_000; busy = false;
  snapshots = new Map([
    ["dependencies", { turns: [], prs: [] }],
    ["foundation", { activeTurnId: "foundation-turn", turns: [{ id: "foundation-turn", status: "in_progress" }], prs: [] }],
    ["security", { activeTurnId: "security-turn", turns: [{ id: "security-turn", status: "in_progress" }], prs: [] }],
  ]);
  submit.mockClear();
});

afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); });

describe("durable thread dependencies", () => {
  it("waits before a PR exists and follows fresh current-head CI to one continuation", async () => {
    const agent = coordinator();
    await create(agent);
    expect(submit).not.toHaveBeenCalled();
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing", checksStillRunning: true }), fetchedAt: now }];
    await agent.handlePrEvent();
    expect(submit).not.toHaveBeenCalled();
    snapshots.get("foundation")!.prs = [{ pr: pr({ headSha: "head-two", checkState: "passing", state: "passing" }), fetchedAt: now }];
    await Promise.all([agent.handlePrEvent(), agent.handlePrEvent(), agent.handleThreadEvent(condition("foundation"))]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({ threadId: "dependencies", messageOrigin: { kind: "pwragent", dependencyId: expect.any(String) } });
    expect(store.list("codex", "dependencies")[0]).toMatchObject({ status: "delivered", outcome: "success", evidence: [expect.objectContaining({ headSha: "head-two" })] });
  });

  it("names prerequisites by their saved titles in the continuation prompt", async () => {
    const agent = coordinator();
    await create(agent, [{ ...condition("foundation"), title: "Extract retry helper" }]);
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    await agent.handlePrEvent();
    const prompt = (submit.mock.calls[0]![0] as unknown as { input: { text: string }[] }).input[0]!.text;
    expect(prompt).toContain("its prerequisites were met (all of 1)");
    expect(prompt).toContain("- \"Extract retry helper\" passes CI: CI passed for the current head; PR: https://github.com/example/fixture/pull/1");
    expect(prompt).toContain("prerequisites: codex:foundation (ci_passed)");
  });

  it("rechecks every PR observed by one poll in a single pass", async () => {
    snapshots.set("other", { turns: [], prs: [] });
    snapshots.set("second-consumer", { turns: [], prs: [] });
    const agent = coordinator();
    await create(agent, [{ ...condition("foundation"), prUrl: "https://github.com/example/fixture/pull/1" }]);
    await create(agent, [{ ...condition("other"), prUrl: "https://github.com/example/fixture/pull/2" }], { threadId: "second-consumer" });
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    snapshots.get("other")!.prs = [{ pr: pr({ number: 2, url: "https://github.com/example/fixture/pull/2", checkState: "passing", state: "passing" }), fetchedAt: now }];
    await agent.handlePrEvent([]);
    expect(submit).not.toHaveBeenCalled();
    await agent.handlePrEvent(["https://github.com/example/fixture/pull/1", "https://github.com/example/fixture/pull/2"]);
    expect(submit.mock.calls.map(([params]) => params.threadId).sort()).toEqual(["dependencies", "second-consumer"]);
  });

  it("lists active registrations that wait on a prerequisite thread", async () => {
    const agent = coordinator();
    await create(agent, [condition("foundation", "pr_merged")]);
    await expect(agent.manage({ action: "list", backend: "codex", threadId: "foundation" })).resolves.toMatchObject({
      dependencies: [], dependents: [expect.objectContaining({ threadId: "dependencies" })],
    });
    const [registration] = store.list("codex", "dependencies");
    await agent.manage({ action: "cancel", backend: "codex", threadId: "dependencies", dependencyId: registration!.id });
    await expect(agent.manage({ action: "list", backend: "codex", threadId: "foundation" })).resolves.toMatchObject({ dependents: [] });
  });

  it("rejects an oversized prerequisite title and keeps titles out of deduplication", async () => {
    const agent = coordinator();
    await expect(create(agent, [{ ...condition("foundation"), title: "x".repeat(201) }])).rejects.toThrow("at most 200 characters");
    await create(agent, [{ ...condition("foundation"), title: "Old title" }]);
    await create(agent, [{ ...condition("foundation"), title: "Renamed" }]);
    expect(store.active()).toHaveLength(1);
  });

  it("pins a specific turn, catches an already completed turn, and ignores later unrelated turns", async () => {
    const agent = coordinator();
    await create(agent, [condition("foundation", "turn_completed")]);
    expect(store.active()[0].conditions[0].turnId).toBe("foundation-turn");
    await agent.handleThreadEvent(condition("foundation"), { id: "unrelated", status: "completed" });
    expect(submit).not.toHaveBeenCalled();
    await agent.handleThreadEvent(condition("foundation"), { id: "foundation-turn", status: "completed" });
    await agent.handleThreadEvent(condition("foundation"), { id: "foundation-turn", status: "completed" });
    expect(submit).toHaveBeenCalledTimes(1);
    snapshots.get("security")!.activeTurnId = undefined;
    snapshots.get("security")!.turns = [{ id: "done", status: "completed" }];
    await create(agent, [condition("security", "turn_completed")]);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("does not release all prerequisites when CI on an earlier head passed", async () => {
    const agent = coordinator();
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    await create(agent, [condition("foundation"), condition("security", "turn_completed")]);
    snapshots.get("foundation")!.prs = [{ pr: pr({ headSha: "head-two" }), fetchedAt: ++now }];
    await agent.handleThreadEvent(condition("security"), { id: "security-turn", status: "completed" });
    expect(submit).not.toHaveBeenCalled();
    snapshots.get("foundation")!.prs = [{ pr: pr({ headSha: "head-two", checkState: "passing", state: "passing" }), fetchedAt: ++now }];
    await agent.handlePrEvent();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("reads each pinned turn when the provider paginates history by turn", async () => {
    const agent = new ThreadDependencyCoordinator({
      store,
      readThread: async (target) => ({
        turns: target.turnId ? [{ id: target.turnId, status: "completed" }] : [],
        prs: [],
      }),
      submit,
      changed: async () => undefined,
      now: () => now,
    });
    await create(agent, [
      { ...condition("foundation", "turn_completed"), turnId: "older-turn" },
      { ...condition("foundation", "turn_completed"), turnId: "newer-turn" },
    ]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.list("codex", "dependencies")[0].evidence.map((entry) => entry.state)).toEqual(["satisfied", "satisfied"]);
  });

  it("supports any, waits through CI repair, and surfaces terminal prerequisite failures", async () => {
    const agent = coordinator();
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "failing", state: "failing" }), fetchedAt: now }];
    await create(agent, [condition("foundation")], { onFailure: "wait" });
    await agent.handlePrEvent();
    expect(submit).not.toHaveBeenCalled();
    snapshots.get("foundation")!.prs = [{ pr: pr({ lifecycleState: "closed" }), fetchedAt: now }];
    await agent.handlePrEvent();
    expect(store.list("codex", "dependencies")[0]).toMatchObject({ status: "delivered", outcome: "failure" });
    await create(agent, [condition("foundation"), condition("security", "turn_completed")], { mode: "any" });
    expect(submit).toHaveBeenCalledTimes(1);
    await agent.handleThreadEvent(condition("security"), { id: "security-turn", status: "completed" });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("rejects stale CI, draft PRs, superseded pinned heads, and ambiguous PR selectors", async () => {
    const agent = coordinator();
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now - 61_000 }];
    await create(agent);
    expect(submit).not.toHaveBeenCalled();
    snapshots.get("foundation")!.prs = [{ pr: pr({ reviewState: "draft", checkState: "passing", state: "passing" }), fetchedAt: now }];
    await agent.handlePrEvent();
    expect(submit).not.toHaveBeenCalled();
    snapshots.get("foundation")!.prs = [{ pr: pr(), fetchedAt: now }, { pr: pr({ number: 2, url: "https://github.com/example/fixture/pull/2" }), fetchedAt: now }];
    await agent.handlePrEvent();
    // The first unique PR remains selected even after a second attachment.
    expect(store.active()[0].evidence[0].reason).toBe("Waiting for CI to pass");
    await create(agent, [condition("foundation")], { threadId: "security" });
    expect(store.list("codex", "security")[0].evidence[0].reason).toContain("multiple PRs");
    await create(agent, [{ ...condition("foundation"), prUrl: pr().url, headSha: "old-head" }]);
    expect(store.list("codex", "dependencies").find((item) => item.conditions[0].headSha === "old-head")?.outcome).toBe("failure");
  });

  it("rejects self and multi-hop cycles atomically and deduplicates registrations", async () => {
    const agent = coordinator();
    await expect(create(agent, [condition("dependencies")])).rejects.toThrow("cycle");
    const first = await create(agent);
    const second = await create(agent);
    expect(second.dependencies[0].id).toBe(first.dependencies[0].id);
    await create(agent, [condition("security")], { threadId: "foundation" });
    await expect(create(agent, [condition("dependencies")], { threadId: "security" })).rejects.toThrow("cycle");
    expect(store.active()).toHaveLength(2);
  });

  it("cancels pending dependencies and does not let another consumer cancel them", async () => {
    const agent = coordinator();
    const { dependencies: [item] } = await create(agent);
    await expect(agent.manage({ action: "cancel", backend: "codex", threadId: "security", dependencyId: item.id })).rejects.toThrow("not found");
    await agent.manage({ action: "cancel", backend: "codex", threadId: "dependencies", dependencyId: item.id });
    snapshots.get("foundation")!.prs = [{ pr: pr({ lifecycleState: "merged" }), fetchedAt: now }];
    await agent.handlePrEvent();
    expect(submit).not.toHaveBeenCalled();
    expect(store.list("codex", "dependencies")[0].status).toBe("cancelled");
  });

  it.each(["cancel", "dismiss"] as const)("publishes %s for an old dependency outside terminal history", async (action) => {
    const changed = vi.fn(async (item: ThreadDependency) => { expect(item.backend).toBe("codex"); });
    const agent = coordinator(store, changed);
    const { dependencies: [item] } = await create(agent);
    if (action === "dismiss") store.replace(item, { ...item, status: "dispatching", error: "Admission is uncertain" });
    const insert = db.raw.prepare("INSERT INTO thread_dependencies(dependency_id, backend, thread_id, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)");
    db.raw.transaction(() => {
      for (let index = 0; index < 132; index++) {
        const terminal = { ...item, id: `newer-${index}`, status: "delivered", createdAt: item.createdAt + index + 1 };
        insert.run(terminal.id, terminal.backend, terminal.threadId, terminal.status, terminal.createdAt, JSON.stringify(terminal));
      }
    })();
    expect(store.list("codex", "dependencies").some((entry) => entry.id === item.id)).toBe(true);
    changed.mockClear();
    const response = await agent.manage({ action, backend: "codex", threadId: "dependencies", dependencyId: item.id });
    const status = action === "cancel" ? "cancelled" : "dismissed";
    expect(response.dependencies.some((entry) => entry.id === item.id)).toBe(false);
    expect(store.get("codex", "dependencies", item.id)?.status).toBe(status);
    expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: item.id, status }));
    expect(submit).not.toHaveBeenCalled();
    if (action === "cancel") {
      await agent.manage({ action, backend: "codex", threadId: "dependencies", dependencyId: item.id });
      expect(store.get("codex", "dependencies", item.id)?.status).toBe("cancelled");
    }
  });

  it.each(["detached", "unavailable"])("retains the selected PR through a %s observation and restart", async (missing) => {
    const agent = coordinator();
    snapshots.get("foundation")!.prs = [{ pr: pr(), fetchedAt: now }];
    const { dependencies: [item] } = await create(agent);
    if (missing === "detached") snapshots.get("foundation")!.prs = [];
    else snapshots.delete("foundation");
    await agent.handleThreadEvent(condition("foundation"));
    expect(store.get("codex", "dependencies", item.id)?.evidence[0]).toMatchObject({ state: "waiting", prUrl: pr().url });
    db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
    const resumed = coordinator();
    const other = pr({ number: 2, url: "https://github.com/example/fixture/pull/2", state: "passing", checkState: "passing" });
    snapshots.set("foundation", { turns: [], prs: [{ pr: other, fetchedAt: now }] });
    await resumed.reconcile();
    expect(submit).not.toHaveBeenCalled();
    expect(store.get("codex", "dependencies", item.id)?.evidence[0]).toMatchObject({ state: "waiting", prUrl: pr().url });
    snapshots.get("foundation")!.prs.push({ pr: pr({ state: "passing", checkState: "passing" }), fetchedAt: now });
    await resumed.handlePrEvent(pr().url);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.get("codex", "dependencies", item.id)?.evidence[0].prUrl).toBe(pr().url);
  });

  it("holds a ready notification while its consumer is busy and rechecks the PR before admission", async () => {
    const agent = coordinator(); busy = true;
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    await create(agent);
    expect(store.active()[0].status).toBe("ready");
    snapshots.get("foundation")!.prs = [{ pr: pr({ headSha: "new-pending-head" }), fetchedAt: now }];
    busy = false;
    await agent.handleThreadEvent(condition("dependencies"), { id: "consumer-turn", status: "completed" });
    expect(submit).not.toHaveBeenCalled();
    snapshots.get("foundation")!.prs = [{ pr: pr({ headSha: "new-passing-head", checkState: "passing", state: "passing" }), fetchedAt: now }];
    await agent.handlePrEvent();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("recovers waiting prerequisites after reopening the database and never replays delivered ones", async () => {
    await create(coordinator());
    db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    await coordinator().reconcile();
    expect(submit).toHaveBeenCalledTimes(1);
    db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
    await coordinator().reconcile();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("retries queue contention on availability changes without repeatedly claiming on PR polls", async () => {
    const agent = coordinator();
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    submit.mockResolvedValueOnce({ status: "busy" });
    await create(agent);
    expect(store.active()[0].status).toBe("ready");
    for (let tick = 0; tick < 10; tick++) await agent.handlePrEvent();
    expect(submit).toHaveBeenCalledTimes(1);
    await agent.handleThreadEvent(condition("dependencies"), undefined, true);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(store.list("codex", "dependencies")[0].status).toBe("delivered");
  });

  it("arbitrates duplicate events across two processes' database connections", async () => {
    const agent = coordinator(); await create(agent);
    const otherDb = StateDb.open(dbPath);
    try {
      const other = coordinator(new ThreadDependencyStore(otherDb.raw));
      snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
      await Promise.all([agent.handlePrEvent(), other.handlePrEvent()]);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally { otherDb.close(); }
  });

  it("keeps an uncertain crash admission visible and uses a durable receipt to recover it", async () => {
    const agent = coordinator(); await create(agent);
    const original = store.active()[0];
    store.replace(original, { ...original, status: "dispatching", dispatchOwnerPid: 2_000_000_000 });
    await coordinator().reconcile();
    expect(submit).not.toHaveBeenCalled();
    expect(store.active()[0].error).toContain("interrupted");
    db.raw.prepare("INSERT INTO thread_message_origins(backend, thread_id, message_id, created_at, payload) VALUES (?, ?, ?, ?, ?)").run("codex", "dependencies", "receipt", now, JSON.stringify({ kind: "pwragent", dependencyId: original.id }));
    await coordinator().reconcile();
    expect(store.list("codex", "dependencies")[0].status).toBe("delivered");
    expect(submit).not.toHaveBeenCalled();
  });

  it("makes no SQLite writes for unchanged polls or turns, including a busy consumer", async () => {
    const agent = coordinator(); busy = true;
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    await create(agent);
    const { writes } = await measureSqliteWrites(async () => {
      for (let tick = 0; tick < 100; tick++) {
        now += 100;
        snapshots.get("foundation")!.prs[0].fetchedAt = now;
        await agent.handlePrEvent();
        await agent.handleThreadEvent(condition("foundation"));
      }
      for (let tick = 0; tick < 100; tick++) {
        now += 61_000;
        await agent.handleThreadEvent(condition("foundation"));
        snapshots.get("foundation")!.prs[0].fetchedAt = now;
        await agent.handlePrEvent();
      }
    });
    expectSqliteWriteBudget({ scenario: "thread-dependencies-unchanged-events", note: "100 unchanged PR polls plus 100 thread events with a busy consumer: zero commits and 0 MB/day idle.", writes });
  });

  it("lets an operator retire an uncertain delivery without treating it as a cancelled turn", async () => {
    const agent = coordinator(); await create(agent);
    const item = store.active()[0];
    await expect(agent.manage({ action: "dismiss", backend: "codex", threadId: "dependencies", dependencyId: item.id })).rejects.toThrow("uncertain");
    store.replace(item, { ...item, status: "dispatching", error: "Admission is uncertain" });
    await agent.manage({ action: "dismiss", backend: "codex", threadId: "dependencies", dependencyId: item.id });
    expect(store.list("codex", "dependencies")[0].status).toBe("dismissed");
    expect(submit).not.toHaveBeenCalled();
    await create(agent);
    expect(store.active()).toHaveLength(1);
  });

  it("budgets one registration and continuation at readiness boundaries", async () => {
    const agent = coordinator();
    const { writes } = await measureSqliteWrites(async () => {
      await create(agent);
      snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
      await agent.handlePrEvent();
    });
    expectSqliteWriteBudget({ scenario: "thread-dependency-lifecycle", note: "One dependency registration and one successful continuation; no per-poll or per-turn writes when evidence is unchanged.", writes });
  });
});
