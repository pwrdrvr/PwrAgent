import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_TODO_MAX_OPEN_PER_THREAD,
  type ThreadTodoProject,
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
const AGENT: ThreadTodoProject = { key: "directory:/src/pwragent", label: "PwrAgent", path: "/src/pwragent" };
const SNAP: ThreadTodoProject = { key: "directory:/src/pwrsnap", label: "PwrSnap", path: "/src/pwrsnap" };

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
        action: { type: "merge_pull_request", pullRequest: "42" },
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

  it("records work handled outside PwrAgent and clears it on reopen", () => {
    const service = createService();
    const todo = service.add({
      ...THREAD,
      input: { title: "Hand off", action: { type: "start_thread", prompt: "Go" } },
    }).todo;

    expect(service.resolve({ id: todo.id, status: "done", resolution: "handled_elsewhere" }))
      .toMatchObject({ status: "done", result: "Handled elsewhere" });
    expect(service.resolve({ id: todo.id, status: "open" }).result).toBeUndefined();
  });

  it("merges with the method the operator picked", async () => {
    const mergePullRequest = vi.fn(async () => ({ summary: "Rebased and merged #9" }));
    const service = createService({ mergePullRequest, startThread: vi.fn() });
    const todo = service.add({
      ...THREAD,
      input: { title: "Merge", action: { type: "merge_pull_request", pullRequest: "9" } },
    }).todo;

    await service.runAction(todo.id, { mergeMethod: "rebase" });
    expect(mergePullRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "rebase" }));
  });

  it("keeps a card's target project and drops one that is its own", () => {
    const service = createService();
    const own = service.add({
      ...THREAD,
      sourceProject: AGENT,
      targetProject: AGENT,
      input: { title: "Here" },
    }).todo;
    const cross = service.add({
      ...THREAD,
      sourceProject: AGENT,
      targetProject: SNAP,
      input: { title: "There" },
    }).todo;

    expect(own.targetProject).toBeUndefined();
    const store = new ThreadTodoStore(db);
    expect(store.get(own.id)).toMatchObject({ sourceProject: AGENT });
    expect(store.get(cross.id)).toMatchObject({ sourceProject: AGENT, targetProject: SNAP });
  });

  it("merges a target project's card in that project with its remembered method", async () => {
    const mergePullRequest = vi.fn(async () => ({ summary: "Merged #3" }));
    const service = createService({ mergePullRequest, startThread: vi.fn() });
    const add = (title: string) => service.add({
      ...THREAD,
      cwd: "/src/pwragent",
      sourceProject: AGENT,
      targetProject: SNAP,
      input: { title, action: { type: "merge_pull_request", pullRequest: "3" } },
    }).todo;

    await service.runAction(add("First").id, { mergeMethod: "merge", rememberMergeMethod: true });
    expect(mergePullRequest).toHaveBeenLastCalledWith({
      cwd: "/src/pwrsnap",
      pullRequest: "3",
      method: "merge",
    });
    expect(service.mergeMethodPreferences()).toEqual({
      defaultMethod: "squash",
      byProject: { [SNAP.key]: "merge" },
    });

    // The next card in that project merges the remembered way.
    await service.runAction(add("Second").id);
    expect(mergePullRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "merge" }),
    );

    // A one-off pick does not change what is remembered.
    await service.runAction(add("Third").id, { mergeMethod: "rebase" });
    expect(service.mergeMethodPreferences().byProject).toEqual({ [SNAP.key]: "merge" });
  });

  it("starts a handoff on a peer and names the peer in the result", async () => {
    const startThread = vi.fn();
    const startThreadOnInstance = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "remote-1",
      instanceId: "peer-1",
      instanceLabel: "Studio Mac",
    }));
    const service = createService({ mergePullRequest: vi.fn(), startThread, startThreadOnInstance });
    const todo = service.add({
      ...THREAD,
      sourceProject: AGENT,
      targetProject: SNAP,
      input: { title: "Build", action: { type: "start_thread", prompt: "Build it" } },
    }).todo;

    const ended = await service.runAction(todo.id, { startOnInstanceId: "peer-1" });
    expect(startThread).not.toHaveBeenCalled();
    expect(startThreadOnInstance).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: "peer-1",
      project: SNAP,
      crossProject: true,
    }));
    expect(ended).toMatchObject({
      status: "done",
      result: "Started thread on Studio Mac",
      startedThread: { threadId: "remote-1", instanceId: "peer-1" },
    });
  });

  it("refuses a peer start without federation", async () => {
    const service = createService({ mergePullRequest: vi.fn(), startThread: vi.fn() });
    const todo = service.add({
      ...THREAD,
      input: { title: "Build", action: { type: "start_thread", prompt: "Build it" } },
    }).todo;

    await expect(service.runAction(todo.id, { startOnInstanceId: "peer-1" }))
      .rejects.toThrow("Starting a thread on another PwrAgent is not available.");
    expect(service.list({ status: "open" })).toHaveLength(1);
  });

  it("updates only the fields given and keeps the rest", () => {
    const service = createService();
    const todo = service.add({
      ...THREAD,
      sourceProject: AGENT,
      targetProject: SNAP,
      input: {
        title: "Build it",
        detail: "In PwrSnap",
        action: {
          type: "start_thread",
          prompt: "Build the hook",
          model: "gpt-6.1",
          reasoningEffort: "medium",
          workMode: "worktree",
        },
      },
    }).todo;
    events = [];
    clock = 5_000;

    const updated = service.update({
      id: todo.id,
      action: { model: "gpt-6.1-sol", reasoningEffort: "xhigh", executionMode: "auto" },
    });

    expect(updated).toMatchObject({
      title: "Build it",
      detail: "In PwrSnap",
      targetProject: SNAP,
      updatedAt: 5_000,
      action: {
        type: "start_thread",
        prompt: "Build the hook",
        model: "gpt-6.1-sol",
        reasoningEffort: "xhigh",
        executionMode: "auto",
        workMode: "worktree",
      },
    });
    expect(events).toHaveLength(1);
    expect(new ThreadTodoStore(db).get(todo.id)?.action).toEqual(updated.action);
  });

  it("clears optional fields with null and returns a card to its own project", () => {
    const service = createService();
    const todo = service.add({
      ...THREAD,
      sourceProject: AGENT,
      targetProject: SNAP,
      input: {
        title: "Build it",
        detail: "Context",
        action: { type: "start_thread", prompt: "Go", model: "gpt-6.1", executionMode: "auto" },
      },
    }).todo;

    const updated = service.update({
      id: todo.id,
      detail: null,
      targetProject: null,
      action: { model: null, executionMode: null },
    });
    expect(updated.detail).toBeUndefined();
    expect(updated.targetProject).toBeUndefined();
    expect(updated.sourceProject).toEqual(AGENT);
    expect(updated.action).toEqual({ type: "start_thread", prompt: "Go" });
  });

  it("clears a failed run's error when the card changes", async () => {
    const service = createService({
      mergePullRequest: vi.fn(),
      startThread: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
    });
    const todo = service.add({
      ...THREAD,
      input: { title: "Hand off", action: { type: "start_thread", prompt: "Go" } },
    }).todo;
    await service.runAction(todo.id);

    expect(service.update({ id: todo.id, action: { model: "gpt-6.1" } }).error).toBeUndefined();
  });

  it("refuses fields the card's action does not have, and a resolved card", () => {
    const service = createService();
    const merge = service.add({
      ...THREAD,
      input: { title: "Merge", action: { type: "merge_pull_request", pullRequest: "1" } },
    }).todo;
    const reminder = service.add({ ...THREAD, input: { title: "Remember" } }).todo;

    expect(() => service.update({ id: merge.id, action: { model: "gpt-6.1" } }))
      .toThrow("A merge card takes only pullRequest, not model.");
    expect(service.update({ id: merge.id, action: { pullRequest: "2" } }).action)
      .toEqual({ type: "merge_pull_request", pullRequest: "2" });
    expect(() => service.update({ id: reminder.id, action: { prompt: "x" } }))
      .toThrow(ThreadTodoError);
    service.resolve({ id: reminder.id, status: "done" });
    expect(() => service.update({ id: reminder.id, title: "Again" }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("finds only the calling thread's cards to update", () => {
    const service = createService();
    const todo = service.add({ ...THREAD, input: { key: "k", title: "Mine" } }).todo;

    expect(service.findForThread({ ...THREAD, key: "k" }).id).toBe(todo.id);
    expect(() => service.findForThread({ backend: "codex", threadId: "thread-b", id: todo.id }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
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
        action: { type: "merge_pull_request", pullRequest: "42" },
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
    expect(runners.mergePullRequest).toHaveBeenCalledWith({
      cwd: "/repo",
      pullRequest: "42",
      method: "squash",
    });

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

  it("costs one commit to remember a merge method and none to repeat it", async () => {
    const store = new ThreadTodoStore(db);
    const { writes } = await measureSqliteWrites(() => {
      store.setProjectMergeMethod({ directoryKey: SNAP.key, method: "rebase", now: 1 });
      store.setProjectMergeMethod({ directoryKey: SNAP.key, method: "rebase", now: 2 });
    });
    expectSqliteWriteBudget({
      note: "a merge method picked on a card, then picked again: one upsert, and the unchanged repeat writes nothing; only on an explicit menu pick",
      scenario: "thread-todo-remember-merge-method",
      writes,
    });
  });

  it("costs one commit to edit a card", async () => {
    const service = createService();
    const todo = service.add({
      ...THREAD,
      input: { title: "Hand off", action: { type: "start_thread", prompt: "Go" } },
    }).todo;
    const { writes } = await measureSqliteWrites(() => {
      service.update({
        id: todo.id,
        action: { model: "gpt-6.1-sol", reasoningEffort: "xhigh", executionMode: "auto" },
      });
    });
    expectSqliteWriteBudget({
      note: "one card edited by update_todo: one commit, only when a thread is asked to change a card",
      scenario: "thread-todo-edit",
      writes,
    });
  });
});
