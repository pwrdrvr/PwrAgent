import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_TODO_MAX_OPEN_PER_THREAD,
  type ThreadTodosChangedEvent,
} from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import {
  ThreadTodoError,
  ThreadTodoService,
  type ThreadTodoActionRunners,
} from "../thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../thread-todos/thread-todo-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const THREAD = { backend: "codex" as const, threadId: "thread-a" };

describe("ThreadTodoService", () => {
  let db: StateDb;
  let tempDir: string;
  let clock: number;
  let ids: number;
  let events: ThreadTodosChangedEvent[];
  let previousMetrics: string | undefined;

  const createService = (runners?: ThreadTodoActionRunners): ThreadTodoService =>
    new ThreadTodoService({
      store: new ThreadTodoStore(db),
      runners,
      onChanged: (event) => events.push(event),
      now: () => clock,
      newId: () => `todo-${++ids}`,
    });

  beforeEach(() => {
    previousMetrics = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const temp = createTempStateDb("pwragent-thread-todos-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    clock = 1_000;
    ids = 0;
    events = [];
  });

  afterEach(() => {
    db.close();
    if (previousMetrics === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
    else process.env[SQLITE_WRITE_METRICS_ENV] = previousMetrics;
    removeTempStateDbDir(tempDir);
  });

  it("adds, lists newest first, and survives a reopen", () => {
    const service = createService();
    service.add({ ...THREAD, cwd: "/repo", input: { title: "Check the docs" } });
    clock = 2_000;
    const { todo, created } = service.add({
      ...THREAD,
      input: {
        title: "Merge it",
        action: { type: "merge_pull_request", pullRequest: "42", method: "squash" },
      },
    });

    expect(created).toBe(true);
    expect(todo).toMatchObject({ kind: "merge", status: "open", createdAt: 2_000 });
    expect(service.list({ status: "open" }).map((entry) => entry.title)).toEqual([
      "Merge it",
      "Check the docs",
    ]);
    expect(events).toHaveLength(2);

    const reopened = new ThreadTodoStore(db).get("todo-1");
    expect(reopened).toMatchObject({ title: "Check the docs", cwd: "/repo", kind: "reminder" });
  });

  it("replaces an open card with the same key instead of stacking it", () => {
    const service = createService();
    service.add({ ...THREAD, input: { key: "review", title: "Ready for review" } });
    clock = 5_000;
    const second = service.add({
      ...THREAD,
      input: {
        key: "review",
        title: "Ready for review again",
        action: { type: "start_review" },
      },
    });

    expect(second.created).toBe(false);
    expect(second.todo).toMatchObject({
      id: "todo-1",
      kind: "review",
      title: "Ready for review again",
      updatedAt: 5_000,
    });
    expect(service.list({ status: "open" })).toHaveLength(1);
  });

  it("refuses a new card past the per-thread limit", () => {
    const service = createService();
    for (let index = 0; index < THREAD_TODO_MAX_OPEN_PER_THREAD; index += 1) {
      service.add({ ...THREAD, input: { title: `Card ${index}` } });
    }
    expect(() => service.add({ ...THREAD, input: { title: "One too many" } }))
      .toThrow(expect.objectContaining({ code: "limit_reached" }));
    // Another thread has its own budget.
    expect(service.add({ backend: "codex", threadId: "thread-b", input: { title: "Elsewhere" } }).created)
      .toBe(true);
  });

  it("resolves, reopens, and refuses a reopen that collides with a newer keyed card", () => {
    const service = createService();
    const first = service.add({ ...THREAD, input: { key: "merge", title: "Merge" } }).todo;
    expect(service.resolve({ id: first.id, status: "done" })).toMatchObject({
      status: "done",
      resolvedAt: 1_000,
    });
    expect(service.resolve({ id: first.id, status: "open" }).resolvedAt).toBeUndefined();

    service.resolve({ id: first.id, status: "dismissed" });
    service.add({ ...THREAD, input: { key: "merge", title: "Merge, again" } });
    expect(() => service.resolve({ id: first.id, status: "open" }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("lets a thread resolve only its own cards", () => {
    const service = createService();
    const todo = service.add({ ...THREAD, input: { key: "k", title: "Mine" } }).todo;

    expect(() => service.resolveFromThread({
      backend: "codex",
      threadId: "thread-b",
      id: todo.id,
      status: "done",
    })).toThrow(ThreadTodoError);
    expect(service.resolveFromThread({ ...THREAD, key: "k", status: "done" }).status)
      .toBe("done");
  });

  it("marks a merge done with its result and keeps a failed handoff open with the error", async () => {
    const runners: ThreadTodoActionRunners = {
      mergePullRequest: vi.fn(async () => ({ summary: "Squash-merged #42" })),
      startThread: vi.fn(async () => {
        throw new Error("backend unavailable");
      }),
    };
    const service = createService(runners);
    const merge = service.add({
      ...THREAD,
      cwd: "/repo",
      input: {
        title: "Merge",
        action: { type: "merge_pull_request", pullRequest: "42", method: "squash" },
      },
    }).todo;
    const handoff = service.add({
      ...THREAD,
      input: {
        title: "Hand off",
        action: { type: "start_thread", prompt: "Carry on", workMode: "worktree" },
      },
    }).todo;

    await expect(service.runAction(merge.id)).resolves.toMatchObject({
      status: "done",
      result: "Squash-merged #42",
    });
    expect(runners.mergePullRequest).toHaveBeenCalledWith({ cwd: "/repo", pullRequest: "42" });

    const failed = await service.runAction(handoff.id);
    expect(failed).toMatchObject({ status: "open", error: "backend unavailable" });
    await expect(service.runAction(merge.id))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("records a handoff's started thread", async () => {
    const service = createService({
      mergePullRequest: vi.fn(),
      startThread: vi.fn(async () => ({ backend: "codex" as const, threadId: "child" })),
    });
    const todo = service.add({
      ...THREAD,
      input: { title: "Hand off", action: { type: "start_thread", prompt: "Go" } },
    }).todo;

    const ended = await service.runAction(todo.id);
    expect(ended).toMatchObject({
      status: "done",
      result: "Started thread",
      startedThread: { backend: "codex", threadId: "child" },
    });
    expect(new ThreadTodoStore(db).get(todo.id)?.startedThread)
      .toEqual({ backend: "codex", threadId: "child" });
  });

  it("refuses to run a review card, which runs in the composer", async () => {
    const service = createService({ mergePullRequest: vi.fn(), startThread: vi.fn() });
    const todo = service.add({
      ...THREAD,
      input: { title: "Review", action: { type: "start_review" } },
    }).todo;
    await expect(service.runAction(todo.id))
      .rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("dismisses a thread's open cards together", () => {
    const service = createService();
    service.add({ ...THREAD, input: { title: "One" } });
    service.add({ ...THREAD, input: { title: "Two" } });
    service.add({ backend: "codex", threadId: "thread-b", input: { title: "Other" } });
    events = [];

    service.dismissOpenForThread(THREAD);

    expect(service.list({ status: "open" }).map((todo) => todo.threadId)).toEqual(["thread-b"]);
    expect(events).toEqual([{ at: 1_000, ...THREAD }]);
  });

  it("costs one commit per card raised or resolved", async () => {
    const service = createService();
    const { writes } = await measureSqliteWrites(() => {
      const todo = service.add({ ...THREAD, input: { key: "review", title: "Ready" } }).todo;
      service.add({ ...THREAD, input: { key: "review", title: "Ready again" } });
      service.resolve({ id: todo.id, status: "done" });
    });
    expectSqliteWriteBudget({
      note: "one card raised, updated in place by key, then resolved: one commit each (~11 KB), none per turn or event; ~0.55 MB/day at 50 card operations",
      scenario: "thread-todo-add-update-resolve",
      writes,
    });
  });
});
