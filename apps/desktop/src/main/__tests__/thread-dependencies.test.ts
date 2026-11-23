import { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ManageThreadDependenciesRequest,
  ThreadDependency,
  ThreadDependencyCondition,
} from "@pwragent/shared/contracts/thread-dependencies";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadTodosChangedEvent } from "@pwragent/shared/contracts/thread-todos";
import { summarizeThreadDependencyPrompt } from "@pwragent/shared/contracts/thread-system-messages";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import {
  ThreadDependencyCoordinator, buildDependencyPrompt, buildDependencyTodo,
  type DependencyThreadSnapshot, type OperatorTodoDelivery,
} from "../app-server/thread-dependency-coordinator";
import { ThreadTodoService } from "../thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../storage/thread-todo-store";
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
// A consumer with a running turn takes the wake into its queue, as the
// registry's joinRunningTurn admission does; an idle one starts a turn.
const submit = vi.fn(async (_params: { threadId: string }): Promise<{ status: "started" | "queued" | "busy"; turnId?: string }> =>
  busy ? { status: "queued" } : { status: "started", turnId: "continuation-turn" });
const condition = (threadId: string, when: ThreadDependencyCondition["when"] = "ci_passed"): ThreadDependencyCondition => ({ backend: "codex", threadId, when });
const pr = (overrides: Partial<PrSummary> = {}): PrSummary => ({
  provider: "github.com", org: "example", repo: "fixture", number: 1,
  url: "https://github.com/example/fixture/pull/1", state: "pending",
  checkState: "pending", lifecycleState: "open", reviewState: "ready_for_review",
  headSha: "head-one", ...overrides,
});

type CoordinatorOptions = ConstructorParameters<typeof ThreadDependencyCoordinator>[0];

function coordinator(dependencyStore = store, changed: (item: ThreadDependency) => Promise<void> = async () => undefined, extra: Partial<CoordinatorOptions> = {}): ThreadDependencyCoordinator {
  return new ThreadDependencyCoordinator({
    store: dependencyStore,
    readThread: async (target) => {
      const snapshot = snapshots.get(target.threadId);
      if (!snapshot) throw new Error("Thread not found");
      return snapshot;
    },
    submit,
    changed,
    now: () => now,
    hasDeliveryReceipt: (item) => dependencyStore.hasDeliveryReceipt(item),
    ...extra,
  });
}

let todoEvents: ThreadTodosChangedEvent[];
let todoIds: number;

/** Operator delivery through the real to-do service, on this connection. */
function operatorTodos(stateDb = db, prepare: OperatorTodoDelivery["prepare"] = async () => ({ cwd: "/repo" })): OperatorTodoDelivery {
  const todos = new ThreadTodoService({
    store: new ThreadTodoStore(stateDb), now: () => now,
    newId: () => `todo-${++todoIds}`, onChanged: (event) => todoEvents.push(event),
  });
  return {
    prepare,
    raise: (card, placement) => todos.raiseForDependency({ ...card, ...placement }).todo,
    publish: (todo) => todos.publish(todo),
  };
}

const cards = () => new ThreadTodoStore(db).list({ status: "all" });

function create(agent: ThreadDependencyCoordinator, conditions = [condition("foundation")], extra: Partial<Pick<ManageThreadDependenciesRequest, "mode" | "onFailure" | "threadId" | "continuation" | "deliver" | "handoff" | "steps" | "holdMerge" | "wakeOn">> = {}) {
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
  todoEvents = []; todoIds = 0;
});

afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); });

describe("durable thread dependencies", () => {
  it("keeps a failure-only wait live through held green CI from another thread", async () => {
    let held = true;
    const agent = coordinator(store, undefined, {
      stackHold: async (item) => {
        expect(item.evidence[0]?.prUrl).toBe(pr().url);
        expect(item.evidence[0]?.condition.threadId).toBe("foundation");
        return held ? "Held by #41: needs restack" : undefined;
      },
    });
    snapshots.get("foundation")!.prs = [{ pr: pr(), fetchedAt: now }];
    await create(agent, [condition("foundation")], { wakeOn: "failure" });
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 0; index < 10; index++) await agent.handlePrEvent(pr().url);
    });
    expectSqliteWriteBudget({ scenario: "stack-held-failure-only-continue-after", writes,
      note: "One commit records held CI evidence from the prerequisite; repeat polls write nothing. About 0.8 MB/day at 100 waits/day and 8 KB/commit." });
    expect(store.active()).toMatchObject([{ status: "ready" }]);
    expect(submit).not.toHaveBeenCalled();
    held = false;
    snapshots.get("foundation")!.prs = [{ pr: pr({ headSha: "restacked", checkState: "failing", state: "failing" }), fetchedAt: now }];
    await agent.handlePrEvent(pr().url);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.active()).toEqual([]);
  });

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

  it("leads the continuation prompt with the registered plan, and holds it back on failure", () => {
    const plan = "Retarget this PR to main and replay our commits onto fetched main.";
    const base: ThreadDependency = {
      id: "planned", backend: "codex", threadId: "consumer", status: "dispatching", mode: "all", onFailure: "notify",
      conditions: [{ ...condition("foundation"), when: "pr_merged", title: "Bump driver" }],
      evidence: [{ condition: { ...condition("foundation"), when: "pr_merged", title: "Bump driver" }, state: "satisfied", reason: "PR merged", observedAt: 1 }],
      continuation: plan, outcome: "success", createdAt: 1, updatedAt: 1,
    };
    const success = buildDependencyPrompt(base);
    expect(success).toContain(`Do what was planned when this dependency was registered:\n${plan}`);
    expect(success).not.toContain("Continue the previously authorized work");
    const failure = buildDependencyPrompt({ ...base, outcome: "failure" });
    expect(failure).toContain("Report the prerequisite failure.");
    expect(failure).toContain(`The work planned for success, not to start now:\n${plan}`);
    expect(buildDependencyPrompt({ ...base, continuation: undefined })).toContain("Continue the previously authorized work");
  });

  it("builds prompts the transcript can summarize back", () => {
    const plan = "Retarget this PR to main.\nThen replay our commits.";
    const evidence = (threadId: string, title: string, state: "satisfied" | "failed" | "waiting", reason: string) => ({
      condition: { ...condition(threadId), title }, state, reason, observedAt: 1,
      prUrl: "https://github.com/example/fixture/pull/1",
    });
    const base: ThreadDependency = {
      id: "summarized", backend: "codex", threadId: "consumer", status: "dispatching", mode: "all", onFailure: "notify",
      conditions: [{ ...condition("foundation"), title: "Bump driver" }],
      evidence: [evidence("foundation", "Bump driver", "satisfied", "CI passed for the current head")],
      continuation: plan, outcome: "success", createdAt: 1, updatedAt: 1,
    };
    expect(summarizeThreadDependencyPrompt(buildDependencyPrompt(base))).toEqual({
      outcome: "success", summary: "\"Bump driver\" passes CI", plan: "Retarget this PR to main.",
    });
    expect(summarizeThreadDependencyPrompt(buildDependencyPrompt({
      ...base, outcome: "failure", evidence: [evidence("foundation", "Bump driver", "failed", "CI failed")],
    }))).toEqual({
      outcome: "failure", summary: "\"Bump driver\" passes CI — CI failed", plan: "Retarget this PR to main.",
    });
    const two = {
      ...base,
      conditions: [...base.conditions, { ...condition("second"), title: "Docs" }],
      evidence: [...base.evidence, evidence("second", "Docs", "waiting", "Waiting for CI to pass")],
      continuation: undefined,
    };
    expect(summarizeThreadDependencyPrompt(buildDependencyPrompt(two))).toEqual({
      outcome: "success", summary: "2 prerequisites met",
    });
    expect(summarizeThreadDependencyPrompt(buildDependencyPrompt({ ...two, mode: "any" }))).toEqual({
      outcome: "success", summary: "One of 2 prerequisites met",
    });
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
    // A second continuation does not wait for the first one's turn to end:
    // the consumer's queue takes it at once and shares that delivery.
    await create(agent, [condition("security", "turn_completed")]);
    expect(submit).toHaveBeenCalledTimes(2);
    await agent.handleThreadEvent(condition("dependencies"), { id: "continuation-turn", status: "completed" });
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
    await agent.handleThreadEvent(condition("dependencies"), { id: "continuation-turn", status: "completed" });
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

  it("queues a ready notification into a busy consumer's turn and delivers it on the wake's own started event", async () => {
    const agent = coordinator(); busy = true;
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    await create(agent);
    expect(submit).toHaveBeenCalledTimes(1);
    const item = store.active()[0]!;
    expect(item).toMatchObject({ status: "dispatching" });
    expect(item.error).toBeUndefined();
    // Waiting in this process's queue is not an interrupted claim.
    await agent.reconcile();
    expect(store.active()[0]).toMatchObject({ status: "dispatching" });
    expect(store.active()[0]!.error).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
    await agent.handleDeliveryProgress({ backend: "codex", threadId: "dependencies", dependencyId: item.id, status: "started", turnId: "consumer-turn" });
    expect(store.list("codex", "dependencies")[0]).toMatchObject({ status: "delivered", turnId: "consumer-turn" });
  });

  it("ends a queued wake the operator cancelled without waking the thread or holding other waits", async () => {
    const agent = coordinator(); busy = true;
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    snapshots.get("security")!.prs = [{ pr: pr({ number: 2, url: "https://github.com/example/fixture/pull/2", checkState: "passing", state: "passing" }), fetchedAt: now }];
    await create(agent);
    const item = store.active()[0]!;
    await agent.handleDeliveryProgress({ backend: "codex", threadId: "dependencies", dependencyId: item.id, status: "cancelled" });
    expect(store.list("codex", "dependencies").find((entry) => entry.id === item.id)).toMatchObject({ status: "cancelled" });
    busy = false;
    await agent.handleThreadEvent(condition("dependencies"), { id: "consumer-turn", status: "completed" }, true);
    await agent.handlePrEvent();
    expect(submit).toHaveBeenCalledTimes(1);
    // A later wait for the same thread is not held behind a review.
    await create(agent, [condition("security")]);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("settles a wake restored by a quiet restart when its own started event arrives", async () => {
    busy = true;
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    await create(coordinator());
    const item = store.active()[0]!;
    expect(item.status).toBe("dispatching");
    // A new process: it did not admit the wake, and reconcile flags the claim.
    const restarted = coordinator();
    await restarted.reconcile();
    expect(store.active()[0]!.error).toMatch(/interrupted/);
    // The restored queue entry then reaches the thread.
    await restarted.handleDeliveryProgress({ backend: "codex", threadId: "dependencies", dependencyId: item.id, status: "started", turnId: "restored-turn" });
    expect(store.list("codex", "dependencies").find((entry) => entry.id === item.id)).toMatchObject({ status: "delivered", turnId: "restored-turn" });
    expect(store.list("codex", "dependencies").find((entry) => entry.id === item.id)!.error).toBeUndefined();
  });

  it("queues every ready wait for one busy consumer instead of admitting one per turn", async () => {
    const agent = coordinator(); busy = true;
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    snapshots.get("security")!.prs = [{ pr: pr({ number: 2, url: "https://github.com/example/fixture/pull/2", checkState: "passing", state: "passing" }), fetchedAt: now }];
    await create(agent);
    await create(agent, [condition("security")]);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(store.active().map((item) => item.status)).toEqual(["dispatching", "dispatching"]);
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

  it("finds the receipt of a wake delivered inside a combined delivery", async () => {
    const agent = coordinator(); await create(agent);
    const original = store.active()[0];
    store.replace(original, { ...original, status: "dispatching", dispatchOwnerPid: 2_000_000_000 });
    db.raw.prepare("INSERT INTO thread_message_origins(backend, thread_id, message_id, created_at, payload) VALUES (?, ?, ?, ?, ?)").run(
      "codex", "dependencies", "combined", now, JSON.stringify({ kind: "agent", deliveredMessages: [
        { origin: { kind: "agent", sourceThread: { backend: "codex", threadId: "lane-a" } }, receivedAt: now, inputItemCount: 1 },
        { origin: { kind: "pwragent", dependencyId: original.id }, receivedAt: now, inputItemCount: 1 },
      ] }));
    await coordinator().reconcile();
    expect(store.list("codex", "dependencies")[0]).toMatchObject({ status: "delivered" });
    expect(store.list("codex", "dependencies")[0].error).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not trust a reused or stale dispatch owner PID", async () => {
    const agent = coordinator(); await create(agent);
    const original = store.active()[0];
    // A live owner mid-admission keeps its claim.
    const live = { ...original, status: "dispatching" as const, dispatchOwnerPid: process.ppid, updatedAt: now };
    store.replace(original, live);
    await coordinator().reconcile();
    expect(store.active()[0].error).toBeUndefined();
    // The same live PID long after admission must have been reused.
    now += 10 * 60_000;
    await coordinator().reconcile();
    expect(store.active()[0].error).toContain("interrupted");
    // This process never holds a claim while nothing here is dispatching.
    const own = store.active()[0];
    store.replace(own, { ...own, error: undefined, dispatchOwnerPid: process.pid, updatedAt: now });
    await coordinator().reconcile();
    expect(store.active()[0].error).toContain("interrupted");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to rewrite a dismissed delivery as cancelled", async () => {
    const agent = coordinator(); await create(agent);
    const original = store.active()[0];
    store.replace(original, { ...original, status: "dismissed" });
    await expect(agent.manage({ action: "cancel", backend: "codex", threadId: "dependencies", dependencyId: original.id }))
      .rejects.toThrow("already dismissed");
    expect(store.list("codex", "dependencies")[0].status).toBe("dismissed");
  });

  it("announces a registration once when evaluation already published it", async () => {
    const changed = vi.fn(async (_item: ThreadDependency) => undefined);
    snapshots.get("foundation")!.prs = [{ pr: pr(), fetchedAt: now }];
    await create(coordinator(store, changed));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]![0].evidence).toHaveLength(1);
  });

  it("lists active registrations for sidebar status without their continuations", async () => {
    const agent = coordinator();
    await agent.manage({ action: "create", backend: "codex", threadId: "dependencies", conditions: [condition("foundation")], continuation: "Rebase onto main" });
    const listed = (await create(agent, [condition("foundation", "pr_merged")])).dependencies
      .find((item) => item.conditions[0]!.when === "pr_merged");
    await agent.manage({ action: "cancel", backend: "codex", threadId: "dependencies", dependencyId: listed!.id });
    const active = agent.active();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ threadId: "dependencies", status: "waiting" });
    expect(active[0]).not.toHaveProperty("continuation");
    expect(store.active()[0]!.continuation).toBe("Rebase onto main");
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

describe("operator delivery", () => {
  const merged = () => [{ pr: pr({ number: 2999, url: "https://github.com/example/fixture/pull/2999", lifecycleState: "merged", state: "merged" }), fetchedAt: now }];
  const remind = (extra: Parameters<typeof create>[2] = {}) => ({ deliver: "operator" as const, continuation: "Call mom and tell her I'm her hero again", ...extra });

  it("raises one reminder card instead of a turn, keyed by the dependency", async () => {
    const changed = vi.fn(async (_item: ThreadDependency) => undefined);
    const agent = coordinator(store, changed, { operatorTodos: operatorTodos() });
    busy = true; // A card needs no idle consumer.
    const { dependencies: [item] } = await create(agent, [condition("foundation", "pr_merged")], remind());
    expect(item).toMatchObject({ deliver: "operator", status: "waiting" });
    snapshots.get("foundation")!.prs = merged();
    await agent.handlePrEvent();
    expect(submit).not.toHaveBeenCalled();
    const [card] = cards();
    expect(cards()).toHaveLength(1);
    expect(card).toMatchObject({
      backend: "codex", threadId: "dependencies", kind: "reminder", status: "open",
      key: `dependency:${item!.id}`, dependencyId: item!.id, cwd: "/repo",
      title: "#2999 merged: Call mom and tell her I'm her hero again",
    });
    expect(card!.action).toBeUndefined();
    expect(card!.detail).toContain("#2999 (met): PR merged https://github.com/example/fixture/pull/2999");
    expect(store.get("codex", "dependencies", item!.id)).toMatchObject({ status: "delivered", outcome: "success", todoId: card!.id });
    expect(todoEvents).toEqual([expect.objectContaining({ backend: "codex", threadId: "dependencies" })]);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: "delivered", todoId: card!.id }));
  });

  it("raises the failure with its reason and holds the plan back", async () => {
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    await create(agent, [condition("foundation", "pr_merged")], remind({ handoff: true }));
    snapshots.get("foundation")!.prs = [{ pr: pr({ number: 2999, url: "https://github.com/example/fixture/pull/2999", lifecycleState: "closed", state: "closed" }), fetchedAt: now }];
    await agent.handlePrEvent();
    const [card] = cards();
    expect(card).toMatchObject({ kind: "reminder", title: "#2999 failed: PR closed without merging" });
    // No one-click start of work whose prerequisite failed.
    expect(card!.action).toBeUndefined();
    expect(card!.detail).toMatch(/^Not started: Call mom and tell her I'm her hero again\n\n/);
    expect(store.list("codex", "dependencies")[0]).toMatchObject({ status: "delivered", outcome: "failure" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps waiting through a repairable CI failure, as agent delivery does", async () => {
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "failing", state: "failing" }), fetchedAt: now }];
    await create(agent, [condition("foundation")], remind({ onFailure: "wait" }));
    await agent.handlePrEvent();
    expect(cards()).toEqual([]);
    snapshots.get("foundation")!.prs = [{ pr: pr({ checkState: "passing", state: "passing" }), fetchedAt: now }];
    await agent.handlePrEvent();
    expect(cards().map((card) => card.title)).toEqual(["#1 passed CI: Call mom and tell her I'm her hero again"]);
  });

  it("offers Start thread with the continuation when asked", async () => {
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    await create(agent, [condition("foundation", "pr_merged")], remind({ handoff: true, continuation: "Write the release notes for #2999" }));
    snapshots.get("foundation")!.prs = merged();
    await agent.handlePrEvent();
    expect(cards()[0]).toMatchObject({
      kind: "handoff", title: "#2999 merged: Write the release notes for #2999",
      action: { type: "start_thread", prompt: "Write the release notes for #2999" },
    });
  });

  it("never raises a second card on repeated events, a restart, or a resolved card", async () => {
    const delivery = operatorTodos();
    const agent = coordinator(store, undefined, { operatorTodos: delivery });
    const { dependencies: [item] } = await create(agent, [condition("foundation", "pr_merged")], remind());
    snapshots.get("foundation")!.prs = merged();
    await Promise.all([agent.handlePrEvent(), agent.handlePrEvent(), agent.handleThreadEvent(condition("foundation"))]);
    for (let tick = 0; tick < 5; tick++) await agent.handlePrEvent();
    db.close(); db = StateDb.open(dbPath); store = new ThreadDependencyStore(db.raw);
    await coordinator(store, undefined, { operatorTodos: operatorTodos() }).reconcile();
    expect(cards()).toHaveLength(1);
    const todos = new ThreadTodoService({ store: new ThreadTodoStore(db), now: () => now });
    todos.resolve({ id: cards()[0]!.id, status: "done" });
    // A re-raise for the same dependency returns the resolved card as it stands.
    const again = todos.raiseForDependency(buildDependencyTodo(store.get("codex", "dependencies", item!.id)!));
    expect(again).toMatchObject({ created: false, todo: { status: "done" } });
    expect(cards()).toHaveLength(1);
  });

  it("arbitrates concurrent claims across two processes' connections to one card", async () => {
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    await create(agent, [condition("foundation", "pr_merged")], remind());
    const otherDb = StateDb.open(dbPath);
    try {
      const other = coordinator(new ThreadDependencyStore(otherDb.raw), undefined, { operatorTodos: operatorTodos(otherDb) });
      snapshots.get("foundation")!.prs = merged();
      await Promise.all([agent.handlePrEvent(), other.handlePrEvent()]);
    } finally { otherDb.close(); }
    expect(cards()).toHaveLength(1);
    expect(store.active()).toEqual([]);
  });

  it("rolls the card back with a claim lost while the card was being placed", async () => {
    let race: (() => void) | undefined;
    const agent = coordinator(store, undefined, {
      operatorTodos: operatorTodos(db, async () => { race?.(); return {}; }),
    });
    const { dependencies: [item] } = await create(agent, [condition("foundation", "pr_merged")], remind());
    // Another process cancels while this one reads the workspace.
    race = () => { store.cancel("codex", "dependencies", item!.id, now); };
    snapshots.get("foundation")!.prs = merged();
    await agent.handlePrEvent();
    expect(cards()).toEqual([]);
    expect(todoEvents).toEqual([]);
    expect(store.get("codex", "dependencies", item!.id)?.status).toBe("cancelled");
  });

  it("refuses operator delivery without a to-do service and validates handoff", async () => {
    await expect(create(coordinator(), [condition("foundation")], remind())).rejects.toThrow("Operator reminders are not available");
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    await expect(create(agent, [condition("foundation")], { handoff: true, continuation: "x" })).rejects.toThrow("handoff requires deliver: operator");
    await expect(create(agent, [condition("foundation")], { deliver: "operator", handoff: true })).rejects.toThrow("handoff requires continuation");
    await expect(create(agent, [condition("foundation")], { deliver: "human" as never })).rejects.toThrow("deliver must be agent or operator");
    // The target is part of identity: the same prerequisites may both resume and remind.
    await create(agent, [condition("foundation")], { continuation: "Same plan" });
    await create(agent, [condition("foundation")], { continuation: "Same plan", deliver: "operator" });
    expect(store.active().map((item) => item.deliver).sort()).toEqual(["agent", "operator"]);
  });

  it("names prerequisites and clips the card to the to-do limits", () => {
    const base: ThreadDependency = {
      id: "clipped", backend: "codex", threadId: "consumer", status: "ready", mode: "all", onFailure: "notify",
      deliver: "operator", outcome: "success", createdAt: 1, updatedAt: 1, continuation: "x".repeat(2000),
      conditions: [condition("foundation", "turn_completed")],
      evidence: [{ condition: { ...condition("foundation", "turn_completed"), title: "Extract retry helper" }, state: "satisfied", reason: "Turn t1 completed", observedAt: 1 }],
    };
    const card = buildDependencyTodo(base);
    expect(card.title).toHaveLength(120);
    expect(card.title.startsWith("Extract retry helper finished its turn: xxx")).toBe(true);
    expect(card.title.endsWith("…")).toBe(true);
    // A clipped title leaves the whole plan in the detail, up to its limit.
    expect(card.detail).toHaveLength(1000);
    const many = buildDependencyTodo({
      ...base, continuation: undefined,
      evidence: ["a", "b", "c"].map((threadId) => ({ condition: condition(threadId, "ci_passed"), state: "satisfied" as const, reason: "CI passed", observedAt: 1 })),
    });
    expect(many.title).toBe("3 prerequisites met");
    expect(many.detail?.split("\n")).toEqual(["• Thread a (met): CI passed", "• Thread b (met): CI passed", "• Thread c (met): CI passed"]);
  });

  it("budgets one registration and one reminder at readiness boundaries", async () => {
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    const { writes } = await measureSqliteWrites(async () => {
      await create(agent, [condition("foundation", "pr_merged")], remind());
      snapshots.get("foundation")!.prs = merged();
      await agent.handlePrEvent();
      for (let tick = 0; tick < 10; tick++) await agent.handlePrEvent();
    });
    expect(cards()).toHaveLength(1);
    expectSqliteWriteBudget({ scenario: "thread-dependency-operator-reminder", note: "One operator dependency registration and its reminder card; the card and the delivered claim share one commit, and later PR events write nothing. ~62 KB per reminder: ~6.2 MB/day at 100 reminders, 0 MB/day idle.", writes });
  });
});

describe("marked-done prerequisites", () => {
  const peerThread = (threadId: string): ThreadDependencyCondition => ({
    backend: "codex", threadId, when: "marked_done", target: { scope: "remote", instanceId: "windows-lab" },
  });
  const outside: ThreadDependencyCondition = { backend: "codex", threadId: "", when: "marked_done", subject: "Legal signs off on the license change" };
  const hold = (extra: Parameters<typeof create>[2] = {}) => ({
    deliver: "operator" as const, continuation: "Validation is done: rebase and merge.", ...extra,
  });

  it("is met only by mark_done, never by the prerequisite's turns", async () => {
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    const { dependencies: [item] } = await create(agent, [condition("foundation", "marked_done")], hold());
    snapshots.get("foundation")!.turns = [{ id: "foundation-turn", status: "completed" }];
    snapshots.get("foundation")!.activeTurnId = undefined;
    await agent.handleThreadEvent(condition("foundation"));
    await agent.handlePrEvent();
    expect(store.get("codex", "dependencies", item!.id)).toMatchObject({ status: "waiting" });
    expect(cards()).toEqual([]);
    await agent.manage({ action: "mark_done", backend: "codex", threadId: "dependencies", dependencyId: item!.id, note: "Windows run clean" }, undefined, "agent:codex:foundation");
    const done = store.get("codex", "dependencies", item!.id)!;
    expect(done.status).toBe("delivered");
    expect(done.evidence[0]).toMatchObject({ state: "satisfied", reason: "Windows run clean", markedDoneBy: "agent:codex:foundation" });
    expect(cards()).toHaveLength(1);
  });

  it("registers peer and outside prerequisites without reading them, and turns steps into a checklist", async () => {
    // Only the waiting thread is this machine's to read.
    const readThread = vi.fn(async (target: { threadId: string }) => {
      if (target.threadId !== "dependencies") throw new Error("Thread not found");
      return { turns: [], prs: [] };
    });
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos(), readThread });
    const { dependencies: [item] } = await create(agent, [peerThread("lab-run"), outside], {
      ...hold(), steps: ["Rebase onto #3291", "Merge #17"], holdMerge: true,
    });
    expect(readThread.mock.calls.map(([target]) => target.threadId)).toEqual(["dependencies"]);
    expect(item).toMatchObject({ status: "waiting", holdMerge: true, steps: ["Rebase onto #3291", "Merge #17"] });
    // Marking one of two leaves the wait waiting; the second releases it.
    await agent.manage({ action: "mark_done", backend: "codex", threadId: "dependencies", dependencyId: item!.id, conditionIndex: 1 });
    expect(store.get("codex", "dependencies", item!.id)).toMatchObject({ status: "waiting" });
    expect(store.get("codex", "dependencies", item!.id)!.evidence.find((entry) => entry.condition.subject)).toMatchObject({ reason: "Marked done", markedDoneBy: "operator" });
    await agent.manage({ action: "mark_done", backend: "codex", threadId: "dependencies", dependencyId: item!.id });
    const [card] = cards();
    expect(card).toMatchObject({ kind: "reminder", items: [
      { id: "step-1", text: "Rebase onto #3291", checked: false },
      { id: "step-2", text: "Merge #17", checked: false },
    ] });
    expect(card!.title.endsWith(": Rebase onto #3291 (+1 more)")).toBe(true);
  });

  it("refuses shapes the owner could not keep", async () => {
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    // A peer's thread has no turns or PRs here to watch.
    await expect(create(agent, [{ ...peerThread("lab-run"), when: "pr_merged" }], hold())).rejects.toThrow();
    await expect(create(agent, [{ ...outside, when: "ci_passed" }], hold())).rejects.toThrow();
    await expect(create(agent, [outside], { continuation: "x", steps: ["Merge"] })).rejects.toThrow();
    await expect(create(agent, [outside], { ...hold(), steps: Array.from({ length: 13 }, (_, index) => `Step ${index}`) })).rejects.toThrow();
    const { dependencies: [item] } = await create(agent, [outside], hold());
    await expect(agent.manage({ action: "mark_done", backend: "codex", threadId: "dependencies", dependencyId: item!.id, note: "x".repeat(2001) })).rejects.toThrow("at most");
    await agent.manage({ action: "cancel", backend: "codex", threadId: "dependencies", dependencyId: item!.id });
    await expect(agent.manage({ action: "mark_done", backend: "codex", threadId: "dependencies", dependencyId: item!.id })).rejects.toThrow("no longer active");
  });

  it("budgets one marked-done wait from registration through its reminder", async () => {
    const agent = coordinator(store, undefined, { operatorTodos: operatorTodos() });
    const { writes } = await measureSqliteWrites(async () => {
      const { dependencies: [item] } = await create(agent, [peerThread("lab-run")], { ...hold(), holdMerge: true });
      for (let tick = 0; tick < 10; tick++) await agent.handlePrEvent();
      await agent.manage({ action: "mark_done", backend: "codex", threadId: "dependencies", dependencyId: item!.id, note: "Done" });
    });
    expect(cards()).toHaveLength(1);
    expectSqliteWriteBudget({ scenario: "thread-dependency-marked-done", note: "One marked-done wait: registration, mark done, and its reminder card; PR events in between write nothing. Operator-paced, so ~0 MB/day idle.", writes });
  });
});

describe("resource checkout continuations", () => {
  const checkout: ThreadDependencyCondition = {
    backend: "codex", threadId: "", when: "resource_checkout",
    resourceCheckout: { resourceId: "fixture-lab", requestKey: "request-one" },
  };
  const registration = {
    action: "create", backend: "codex", threadId: "dependencies",
    conditions: [checkout], continuation: "Run the previously authorized work.",
  } as const;
  const register = (owner: ThreadDependencyCoordinator) =>
    owner.manage({ ...registration, conditions: [checkout] }, undefined, "owner:resource-checkout");

  it("wakes at most once and only from a fresh terminal observation across restarts", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("queued", "partition", "restart", "granted", "ended"), {
      minLength: 1, maxLength: 10,
    }), async (operations) => {
      const suffix = crypto.randomUUID();
      const threadId = "checkout-" + suffix;
      snapshots.set(threadId, { turns: [], prs: [] });
      const wake = vi.fn<CoordinatorOptions["submit"]>().mockResolvedValue({ status: "started", turnId: "continued" });
      let observation: "granted" | "ended" | undefined;
      const makeOwner = () => coordinator(store, async () => {}, {
        submit: wake,
        observeResourceCheckout: async (item) => item.threadId !== threadId ? undefined
          : observation === "granted" ? { state: "satisfied", reason: "Promoted" }
            : observation === "ended" ? { state: "failed", reason: "Ended" } : undefined,
      });
      let owner = makeOwner();
      const input = { ...registration, conditions: [checkout], threadId };
      await expect(owner.manage(input, undefined, "agent:codex")).rejects.toThrow(/resource wait tool/);
      await owner.manage(input, undefined, "owner:resource-checkout");
      let expected = 0;
      for (const operation of operations) {
        if (operation === "restart") {
          owner = makeOwner();
          await owner.reconcile();
        } else {
          observation = operation === "granted" || operation === "ended" ? operation : undefined;
          if (observation) expected = 1;
          await owner.checkResourceCheckouts();
        }
        expect(wake).toHaveBeenCalledTimes(expected);
        await owner.manage(input, undefined, "owner:resource-checkout");
      }
      snapshots.delete(threadId);
      const item = store.list("codex", threadId)[0];
      if (item?.status === "waiting") store.cancel("codex", threadId, item.id, now);
    }), { numRuns: 25 });
  });

  it.each((["start", "steer"] as const).flatMap((route) =>
    (["granted", "expired", "unreachable"] as const).map((state) => ({ route, state })),
  ))("checks the authority again before queued $route with a $state grant", async ({ route, state }) => {
    let occupied = true;
    let observation: "granted" | "expired" | "unreachable" = "unreachable";
    const provider = vi.fn(async (entry) => ({ backend: entry.backend, threadId: entry.threadId, turnId: "continued" }));
    const queue = new ThreadTurnQueue({
      isThreadActive: () => occupied || route === "steer",
      canSteerThread: () => !occupied && route === "steer",
      steerTurn: provider,
      prepareInput: (entry) => entry.messageOrigin?.dependencyId
        ? owner.resourceCheckoutDeliveryText(entry, entry.messageOrigin.dependencyId).then((text) => text ? [{ type: "text", text }] : entry.input)
        : undefined,
      startTurn: provider,
    });
    const owner = coordinator(store, async () => {}, {
      submit: (entry) => queue.submitSteer(entry),
      observeResourceCheckout: async () => observation === "granted" ? { state: "satisfied", reason: "Promoted" }
        : observation === "expired" ? { state: "failed", reason: "Checkout expired" } : undefined,
    });
    await register(owner);
    observation = "granted";
    await owner.checkResourceCheckouts();
    expect(queue.getQueuedEntries(registration)).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();

    occupied = false;
    observation = state;
    await queue.releaseThread(registration);
    expect(provider).toHaveBeenCalledOnce();
    const [{ input }] = provider.mock.calls[0]!;
    if (state === "granted") expect(input[0].text).toContain(registration.continuation);
    else {
      expect(input[0].text).not.toContain(registration.continuation);
      expect(input[0].text).toContain("Do not bypass the dependency or begin dependent work");
    }
    queue.close();
  });

  it("writes only on registration, fresh promotion, admission claim, and delivery", async () => {
    let granted = false;
    const owner = coordinator(store, async () => {}, {
      observeResourceCheckout: async () => granted ? { state: "satisfied", reason: "Promoted" } : undefined,
    });
    const lifecycle = await measureSqliteWrites(async () => {
      await register(owner);
      granted = true;
      await owner.checkResourceCheckouts();
    });
    expectSqliteWriteBudget({
      scenario: "resource-checkout-continuation",
      note: "One durable wait registration, promotion observation, admission claim, and delivery; 100 such waits per day produce about 4.1 MB of WAL.",
      writes: lifecycle.writes,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    granted = false;
    const pending = { ...checkout, resourceCheckout: { resourceId: "fixture-lab", requestKey: "request-two" } };
    const input = { ...registration, conditions: [pending] };
    await owner.manage(input, undefined, "owner:resource-checkout");
    const idle = await measureSqliteWrites(async () => {
      for (let i = 0; i < 100; i++) await owner.checkResourceCheckouts();
      await owner.manage(input, undefined, "owner:resource-checkout");
    });
    expectSqliteWriteBudget({
      scenario: "resource-checkout-continuation-idle",
      note: "100 queued or unreachable observations and an identical registration produce zero writes.",
      writes: idle.writes,
    });
  });
});
