import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_TODO_MAX_OPEN_PER_THREAD,
  THREAD_TODO_TITLE_MAX_LENGTH,
  type ThreadTodoProject,
  type ThreadTodosChangedEvent,
} from "@pwragent/shared";
import { listModelSettingsRecents } from "../state/model-settings-recents-store";
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

  it("refuses to resolve a card while its action runs", async () => {
    let finishStart: () => void = () => undefined;
    const service = createService({
      mergePullRequest: vi.fn(),
      startThread: vi.fn(() => new Promise<{ backend: "codex"; threadId: string }>((resolve) => {
        finishStart = () => resolve({ backend: "codex", threadId: "child" });
      })),
    });
    const todo = service.add({
      ...THREAD,
      input: { title: "Hand off", action: { type: "start_thread", prompt: "Go" } },
    }).todo;

    const run = service.runAction(todo.id);
    expect(() => service.resolve({ id: todo.id, status: "dismissed" }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
    finishStart();
    await expect(run).resolves.toMatchObject({ status: "done", result: "Started thread" });
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

  it("records a card the thread claimed to do here", () => {
    const service = createService();
    service.add({ ...THREAD, input: { key: "k", title: "Mine" } });
    expect(service.resolveFromThread({ ...THREAD, key: "k", status: "done", resolution: "sent_here" }))
      .toMatchObject({ status: "done", result: "Sent to this thread" });
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

  it("raises a card with steps and keeps them, with their ticks, in the row", () => {
    const service = createService();
    const { todo } = service.add({
      ...THREAD,
      input: { title: "Land the release", items: ["Run the tests", "Update the docs"] },
    });
    expect(todo.items).toEqual([
      { id: "todo-2", text: "Run the tests", checked: false },
      { id: "todo-3", text: "Update the docs", checked: false },
    ]);

    clock = 2_000;
    const ticked = service.setItemsChecked({ id: todo.id, check: ["todo-3"], uncheck: [] });
    expect(ticked.items?.map((item) => item.checked)).toEqual([false, true]);
    expect(ticked.updatedAt).toBe(2_000);
    expect(events).toHaveLength(2);

    expect(new ThreadTodoStore(db).get(todo.id)?.items).toEqual([
      { id: "todo-2", text: "Run the tests", checked: false },
      { id: "todo-3", text: "Update the docs", checked: true },
    ]);
    // A card without steps carries no items field at all.
    expect(service.add({ ...THREAD, input: { title: "Plain" } }).todo).not.toHaveProperty("items");
  });

  it("reads malformed stored steps as no steps", () => {
    const service = createService();
    const { todo } = service.add({ ...THREAD, input: { title: "Steps", items: ["One"] } });
    db.raw.prepare("UPDATE thread_todos SET items_json = ? WHERE todo_id = ?")
      .run('[{"id":"x","text":"Bad"},"nope"', todo.id);
    expect(new ThreadTodoStore(db).get(todo.id)).not.toHaveProperty("items");
    db.raw.prepare("UPDATE thread_todos SET items_json = ? WHERE todo_id = ?")
      .run('[{"id":"x","text":"Bad"},{"id":"y","text":"Good","checked":true}]', todo.id);
    expect(new ThreadTodoStore(db).get(todo.id)?.items).toEqual([
      { id: "y", text: "Good", checked: true },
    ]);
  });

  it("merges re-added steps by text, keeping each unchanged step's id and tick", () => {
    const service = createService();
    const { todo } = service.add({
      ...THREAD,
      input: { key: "release", title: "Release", items: ["Tests", "Docs", "Notes"] },
    });
    service.setItemsChecked({ id: todo.id, check: ["todo-2", "todo-4"], uncheck: [] });

    const reraised = service.add({
      ...THREAD,
      input: { key: "release", title: "Release v2", items: ["Notes", "Tests", "Screenshots"] },
    });
    expect(reraised.created).toBe(false);
    expect(reraised.todo.items).toEqual([
      { id: "todo-4", text: "Notes", checked: true },
      { id: "todo-2", text: "Tests", checked: true },
      { id: "todo-5", text: "Screenshots", checked: false },
    ]);

    // Leaving items out keeps the steps; an empty list clears them.
    const kept = service.add({ ...THREAD, input: { key: "release", title: "Release v3" } });
    expect(kept.todo.items).toHaveLength(3);
    const cleared = service.add({
      ...THREAD,
      input: { key: "release", title: "Release v4", items: [] },
    });
    expect(cleared.todo).not.toHaveProperty("items");
  });

  it("refuses Done while steps are open, naming them, unless the override is given", () => {
    const service = createService();
    const { todo } = service.add({
      ...THREAD,
      input: { key: "ship", title: "Ship", items: ["Tests", "Docs", "Notes"] },
    });
    service.setItemsChecked({ id: todo.id, check: ["todo-2"], uncheck: [] });

    const refusal = (() => {
      try {
        service.resolveFromThread({ ...THREAD, key: "ship", status: "done" });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(ThreadTodoError);
    expect(refusal).toMatchObject({ code: "open_items" });
    expect((refusal as Error).message).toContain('2 unchecked steps: "Docs" (todo-3), "Notes" (todo-4)');
    expect(service.list({ status: "open" })).toHaveLength(1);

    expect(service.resolve({ id: todo.id, status: "done", allowOpenItems: true }))
      .toMatchObject({ status: "done" });
    // Undo reopens it with its steps as they were.
    expect(service.resolve({ id: todo.id, status: "open" }).items?.map((item) => item.checked))
      .toEqual([true, false, false]);
    // Dismiss never asks.
    expect(service.resolve({ id: todo.id, status: "dismissed" }).status).toBe("dismissed");
  });

  it("marks a card done once its last step is checked, and only when asked", () => {
    const service = createService();
    const { todo } = service.add({ ...THREAD, input: { title: "Two steps", items: ["A", "B"] } });
    const allChecked = service.setItemsChecked({
      id: todo.id,
      check: ["todo-2", "todo-3"],
      uncheck: [],
    });
    expect(allChecked.status).toBe("open");
    expect(service.resolve({ id: todo.id, status: "done" }).status).toBe("done");
  });

  it("refuses to run an action while steps are open, unless the override is given", async () => {
    const mergePullRequest = vi.fn(async () => ({ summary: "Merged #42" }));
    const service = createService({ mergePullRequest, startThread: vi.fn() });
    const { todo } = service.add({
      ...THREAD,
      input: {
        title: "Merge",
        items: ["CI green"],
        action: { type: "merge_pull_request", pullRequest: "42" },
      },
    });

    await expect(service.runAction(todo.id)).rejects.toMatchObject({ code: "open_items" });
    expect(mergePullRequest).not.toHaveBeenCalled();
    // A card with nothing to run says so first, not that its steps are open.
    const reminder = service.add({ ...THREAD, input: { title: "Steps", items: ["A"] } }).todo;
    await expect(service.runAction(reminder.id)).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(service.runAction(todo.id, { allowOpenItems: true }))
      .resolves.toMatchObject({ status: "done", result: "Merged #42" });
  });

  it("starts a thread past its own open steps, but not past an open prerequisite", async () => {
    const startThread = vi.fn(async () => ({ backend: "codex" as const, threadId: "child" }));
    const service = createService({ mergePullRequest: vi.fn(), startThread });
    const { todo } = service.add({
      ...THREAD,
      input: {
        title: "Build it",
        items: ["Implement", "Test"],
        prerequisites: ["Clone the repository"],
        action: { type: "start_thread", prompt: "Go" },
      },
    });
    // Prerequisites come first, and are stored as such.
    expect(service.list({ status: "open" })[0]?.items).toEqual([
      { id: "todo-2", text: "Clone the repository", checked: false, prerequisite: true },
      { id: "todo-3", text: "Implement", checked: false },
      { id: "todo-4", text: "Test", checked: false },
    ]);

    const refusal = await service.runAction(todo.id).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "open_items" });
    expect((refusal as Error).message)
      .toContain('1 unchecked prerequisite: "Clone the repository" (todo-2)');
    expect(startThread).not.toHaveBeenCalled();

    service.setItemsChecked({ id: todo.id, check: ["todo-2"], uncheck: [] });
    // The steps are the new thread's plan: they go along unchecked.
    await expect(service.runAction(todo.id))
      .resolves.toMatchObject({ status: "done", startedThread: { threadId: "child" } });
  });

  it("marks a start_thread card done with only its own steps open", () => {
    const service = createService();
    const { todo } = service.add({
      ...THREAD,
      input: {
        title: "Build it",
        items: ["Implement"],
        action: { type: "start_thread", prompt: "Go" },
      },
    });
    expect(service.resolve({ id: todo.id, status: "done", resolution: "sent_here" }).status)
      .toBe("done");
  });

  it("merges prerequisites and steps separately when a card is restated", () => {
    const service = createService();
    const { todo } = service.add({
      ...THREAD,
      input: {
        key: "build",
        title: "Build it",
        items: ["Implement"],
        prerequisites: ["Clone"],
        action: { type: "start_thread", prompt: "Go" },
      },
    });
    service.setItemsChecked({ id: todo.id, check: ["todo-2", "todo-3"], uncheck: [] });

    // Restating only the steps keeps the ticked prerequisite.
    const restated = service.add({
      ...THREAD,
      input: {
        key: "build",
        title: "Build it",
        items: ["Implement", "Document"],
        action: { type: "start_thread", prompt: "Go" },
      },
    }).todo;
    expect(restated.items).toEqual([
      { id: "todo-2", text: "Clone", checked: true, prerequisite: true },
      { id: "todo-3", text: "Implement", checked: true },
      { id: "todo-4", text: "Document", checked: false },
    ]);

    // A step text moved to the prerequisites is a new prerequisite.
    const updated = service.update({ id: todo.id, prerequisites: ["Clone", "Implement"] });
    expect(updated.items).toEqual([
      { id: "todo-2", text: "Clone", checked: true, prerequisite: true },
      { id: "todo-5", text: "Implement", checked: false, prerequisite: true },
      { id: "todo-3", text: "Implement", checked: true },
      { id: "todo-4", text: "Document", checked: false },
    ]);
    expect(service.update({ id: todo.id, prerequisites: [] }).items?.map((item) => item.text))
      .toEqual(["Implement", "Document"]);
  });

  it("restates and ticks steps through update, and refuses ids it does not have", () => {
    const service = createService();
    const { todo } = service.add({ ...THREAD, input: { title: "Steps", items: ["A", "B"] } });

    const updated = service.update({ id: todo.id, items: ["B", "C"], check: ["todo-3"] });
    expect(updated.items).toEqual([
      { id: "todo-3", text: "B", checked: true },
      { id: "todo-4", text: "C", checked: false },
    ]);
    expect(updated.title).toBe("Steps");

    expect(() => service.update({ id: todo.id, check: ["todo-2"] }))
      .toThrow(expect.objectContaining({ code: "invalid_arguments" }));
    expect(() => service.setItemsChecked({ id: todo.id, check: ["todo-4"], uncheck: ["todo-4"] }))
      .toThrow(expect.objectContaining({ code: "invalid_arguments" }));
    expect(service.update({ id: todo.id, uncheck: ["todo-3"] }).items?.[0]?.checked).toBe(false);

    service.resolve({ id: todo.id, status: "dismissed" });
    expect(() => service.setItemsChecked({ id: todo.id, check: ["todo-3"], uncheck: [] }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("lets a step be ticked while the card's action runs", async () => {
    let finish: (value: { summary: string }) => void = () => undefined;
    const mergePullRequest = vi.fn(() => new Promise<{ summary: string }>((resolve) => {
      finish = resolve;
    }));
    const service = createService({ mergePullRequest, startThread: vi.fn() });
    const { todo } = service.add({
      ...THREAD,
      input: {
        title: "Merge",
        items: ["Announce it"],
        action: { type: "merge_pull_request", pullRequest: "42" },
      },
    });
    const run = service.runAction(todo.id, { allowOpenItems: true });
    expect(service.update({ id: todo.id, check: ["todo-2"] }).items?.[0]?.checked).toBe(true);
    expect(() => service.update({ id: todo.id, title: "Renamed" }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
    finish({ summary: "Merged #42" });
    await expect(run).resolves.toMatchObject({ status: "done", items: [{ checked: true }] });
  });

  it("costs one commit to tick a step and none to tick it again", async () => {
    const service = createService();
    const { todo } = service.add({
      ...THREAD,
      input: { title: "Steps", items: ["Run the tests", "Update the docs", "Attach screenshots"] },
    });
    const { writes } = await measureSqliteWrites(() => {
      service.setItemsChecked({ id: todo.id, check: ["todo-2"], uncheck: [] });
      service.setItemsChecked({ id: todo.id, check: ["todo-2"], uncheck: [] });
    });
    expectSqliteWriteBudget({
      note: "one checklist step ticked, then ticked again: one commit rewriting the card's "
        + "unindexed items_json (~4 KB), and the unchanged repeat opens no transaction; only "
        + "on an operator click or an agent's update_todo check, ~0.2 MB/day at 50 ticks, "
        + "~0.8 MB/day at 200",
      scenario: "thread-todo-check-step",
      writes,
    });
  });
  it("remembers successful dispatches per raising thread and records separate dispatch recents", async () => {
    const source = { backend: "codex" as const, model: "sol", reasoningEffort: "high" };
    const picked = { backend: "claude" as const, model: "opus", reasoningEffort: "high" };
    const startThread = vi.fn(async (request: Parameters<ThreadTodoActionRunners["startThread"]>[0]) => ({
      backend: request.modelSettings?.backend ?? "codex", threadId: "child",
      dispatchSettings: { settings: request.modelSettings ?? source, source },
    }));
    const service = createService({ startThread, mergePullRequest: vi.fn() });
    service.setDispatchSettingsReader(async (identity) => ({ thread: { ...source, backend: identity.backend } }));
    const add = (threadId = THREAD.threadId) => service.add({ ...THREAD, threadId,
      input: { title: "Build it", action: { type: "start_thread", prompt: "Build it" } },
    }).todo;
    await service.runAction(add().id);
    expect(new ThreadTodoStore(db).getThreadModelSettings(THREAD.backend, THREAD.threadId)).toBeUndefined();
    expect(listModelSettingsRecents(db, "todo-dispatch")).toEqual([]);
    await service.runAction(add().id, { modelSettings: picked });
    const following = add();
    const other = add("thread-b");
    const projected = await service.withDispatchDefaults([following, other]);
    expect(projected[0]?.dispatchDefaults).toEqual({ thread: source, lastDispatch: picked });
    expect(projected[1]?.dispatchDefaults?.lastDispatch).toBeUndefined();
    await service.runAction(following.id);
    expect(startThread).toHaveBeenLastCalledWith(expect.objectContaining({ modelSettings: picked }));
    expect(listModelSettingsRecents(db, "todo-dispatch")).toEqual([picked]);
    expect(listModelSettingsRecents(db, "review")).toEqual([]);
    // Resetting to the source is remembered too, so the old override stays gone.
    await service.runAction(add().id, { modelSettings: source });
    expect(new ThreadTodoStore(db).getThreadModelSettings(THREAD.backend, THREAD.threadId)).toEqual(source);
  });

  it("leaves memory and recents unchanged on failure and on a peer start", async () => {
    const picked = { backend: "claude" as const, model: "opus" };
    const startThread = vi.fn(async () => { throw new Error("Unavailable"); });
    const startThreadOnInstance = vi.fn(async (_request: unknown) => ({ backend: "codex" as const, threadId: "peer-child" }));
    const service = createService({ startThread, startThreadOnInstance, mergePullRequest: vi.fn() });
    const { todo } = service.add({ ...THREAD, input: { title: "Build it", action: { type: "start_thread", prompt: "Build it" } } });
    expect((await service.runAction(todo.id, { modelSettings: picked })).error).toBe("Unavailable");
    expect(new ThreadTodoStore(db).getThreadModelSettings(THREAD.backend, THREAD.threadId)).toBeUndefined();
    expect(listModelSettingsRecents(db, "todo-dispatch")).toEqual([]);
    await service.runAction(todo.id, { startOnInstanceId: "peer", modelSettings: picked });
    // The pick was made against the peer's catalog, so it goes along; it
    // does not become this thread's memory, which is for starts here.
    expect(startThreadOnInstance.mock.calls[0]?.[0]).toMatchObject({ modelSettings: picked });
    expect(new ThreadTodoStore(db).getThreadModelSettings(THREAD.backend, THREAD.threadId)).toBeUndefined();
    expect(listModelSettingsRecents(db, "todo-dispatch")).toEqual([]);
  });

  it("passes the operator's Where, environment and speed to either start, and no remembered model to a peer", async () => {
    const remembered = { backend: "claude" as const, model: "opus" };
    const startThread = vi.fn(async (request: Parameters<ThreadTodoActionRunners["startThread"]>[0]) => ({
      backend: "codex" as const, threadId: "child",
      dispatchSettings: { settings: request.modelSettings ?? remembered, source: { backend: "codex" as const } },
    }));
    const startThreadOnInstance = vi.fn(async (_request: unknown) => ({ backend: "codex" as const, threadId: "peer-child" }));
    const service = createService({ startThread, startThreadOnInstance, mergePullRequest: vi.fn() });
    const add = () => service.add({ ...THREAD, input: { title: "Build it", action: { type: "start_thread", prompt: "Build it" } } }).todo;
    await service.runAction(add().id, { modelSettings: remembered });
    const choices = { workMode: "worktree" as const, environment: "ci", speed: "fast" as const };
    await service.runAction(add().id, choices);
    expect(startThread).toHaveBeenLastCalledWith(expect.objectContaining({ ...choices, modelSettings: remembered }));
    await service.runAction(add().id, { startOnInstanceId: "peer", ...choices });
    expect(startThreadOnInstance).toHaveBeenLastCalledWith(expect.objectContaining({ instanceId: "peer", ...choices }));
    expect(startThreadOnInstance.mock.lastCall?.[0]).not.toHaveProperty("modelSettings");
  });

  it("budgets one changed preference and recent with no repeat preference writes", async () => {
    const store = new ThreadTodoStore(db);
    const source = { backend: "codex" as const, model: "sol", reasoningEffort: "high" };
    const settings = { backend: "claude" as const, model: "opus", reasoningEffort: "high" };
    const { writes } = await measureSqliteWrites(async () => {
      store.rememberDispatch(THREAD.backend, THREAD.threadId, source, source);
      store.rememberDispatch(THREAD.backend, THREAD.threadId, settings, source);
      for (let i = 0; i < 100; i++) store.setThreadModelSettings(THREAD.backend, THREAD.threadId, settings);
    });
    expectSqliteWriteBudget({ scenario: "todo-dispatch-model-preference",
      note: "One changed dispatch: preference and recent in one commit; default start and 100 identical preference writes cost zero.", writes });
    expect(writes.commits).toBe(1);
  });

  describe("plan cards for started threads", () => {
    const CHILD = { backend: "codex" as const, threadId: "child" };
    const addHandoff = (service: ThreadTodoService, overrides: { title?: string; items?: string[] } = {}) =>
      service.add({
        ...THREAD,
        input: {
          title: "Finish the smoke test",
          prerequisites: ["Clone atlas"],
          ...(overrides.items ? { items: overrides.items } : {}),
          action: { type: "start_thread", prompt: "Finish it", ...(overrides.title ? { title: overrides.title } : {}) },
        },
      }).todo;

    it("sends the start card's plain steps, not its prerequisites, to the start", async () => {
      const startThread = vi.fn(async (_request: Parameters<ThreadTodoActionRunners["startThread"]>[0]) => CHILD);
      const service = createService({ startThread, mergePullRequest: vi.fn() });
      const todo = addHandoff(service, { title: "Windows smoke test", items: ["Run lint", "Capture screenshots"] });
      await service.runAction(todo.id, { allowOpenItems: true });
      expect(startThread.mock.lastCall?.[0].plan).toEqual({
        title: "Windows smoke test",
        items: ["Run lint", "Capture screenshots"],
      });
      // Without a thread title, the card's own names the plan.
      const untitled = addHandoff(service, { items: ["Run lint"] });
      await service.runAction(untitled.id, { allowOpenItems: true });
      expect(startThread.mock.lastCall?.[0].plan?.title).toBe("Finish the smoke test");
    });

    it("sends no plan for a card without plain steps, on either start", async () => {
      const startThread = vi.fn(async (_request: Parameters<ThreadTodoActionRunners["startThread"]>[0]) => CHILD);
      const startThreadOnInstance = vi.fn(async (_request: Parameters<NonNullable<ThreadTodoActionRunners["startThreadOnInstance"]>>[0]) => CHILD);
      const service = createService({ startThread, startThreadOnInstance, mergePullRequest: vi.fn() });
      await service.runAction(addHandoff(service).id, { allowOpenItems: true });
      expect(startThread.mock.lastCall?.[0]).not.toHaveProperty("plan");
      await service.runAction(addHandoff(service, { items: ["Run lint"] }).id,
        { allowOpenItems: true, startOnInstanceId: "peer" });
      expect(startThreadOnInstance.mock.lastCall?.[0].plan).toEqual({ title: "Finish the smoke test", items: ["Run lint"] });
    });

    it("raises the plan as the new thread's own unchecked reminder, keyed plan", () => {
      const service = createService();
      const todo = service.raisePlan({
        ...CHILD,
        cwd: "/worktrees/atlas",
        sourceProject: AGENT,
        plan: { title: "Windows smoke test", items: ["Run lint", "Capture screenshots"] },
      });
      expect(todo).toMatchObject({
        ...CHILD,
        key: "plan",
        kind: "reminder",
        status: "open",
        title: "Plan: Windows smoke test",
        cwd: "/worktrees/atlas",
        sourceProject: AGENT,
        items: [
          { text: "Run lint", checked: false },
          { text: "Capture screenshots", checked: false },
        ],
      });
      expect(todo.detail).toBeTruthy();
      expect(todo).not.toHaveProperty("action");
      expect(events.at(-1)).toMatchObject(CHILD);
      // The thread owns it: it ticks the steps by key, as update_todo does.
      const step = todo.items![0]!.id;
      expect(service.findForThread({ ...CHILD, key: "plan" }).id).toBe(todo.id);
      expect(service.update({ id: todo.id, check: [step] }).items?.[0]?.checked).toBe(true);
    });

    it("merges a repeated plan into the open card, keeping ticks", () => {
      const service = createService();
      const plan = { title: "Smoke test", items: ["Run lint", "Capture screenshots"] };
      const first = service.raisePlan({ ...CHILD, plan });
      service.update({ id: first.id, check: [first.items![0]!.id] });
      const again = service.raisePlan({ ...CHILD, plan });
      expect(again.id).toBe(first.id);
      expect(again.items?.map((item) => item.checked)).toEqual([true, false]);
      expect(service.list({ ...CHILD, status: "open" })).toHaveLength(1);
    });

    it("keeps a long title within the card's limit", () => {
      const service = createService();
      const todo = service.raisePlan({ ...CHILD, plan: { title: "x".repeat(THREAD_TODO_TITLE_MAX_LENGTH), items: ["Go"] } });
      expect(todo.title).toHaveLength(THREAD_TODO_TITLE_MAX_LENGTH);
      expect(todo.title.startsWith("Plan: x")).toBe(true);
      expect(todo.title.endsWith("…")).toBe(true);
    });

    it("costs one commit for the plan card beside the start's own", async () => {
      const service = createService();
      service.setRunners({
        mergePullRequest: vi.fn(),
        // As the runtime's runner does: the plan card goes up before the
        // new thread's first turn.
        startThread: async (request) => {
          if (request.plan) service.raisePlan({ ...CHILD, plan: request.plan });
          return CHILD;
        },
      });
      const todo = addHandoff(service, {
        items: ["Run Windows lint, tests and a build", "Capture screenshots", "Attach the evidence"],
      });
      const { writes } = await measureSqliteWrites(async () => {
        await service.runAction(todo.id, { allowOpenItems: true });
      });
      expectSqliteWriteBudget({
        note: "one Start thread from a card with a 3-step plan: one commit for the new thread's "
          + "plan card and one for marking the start card done; only on an operator's Start click, "
          + "never per turn or event, ~0.4 MB/day at 50 starts",
        scenario: "thread-todo-start-with-plan",
        writes,
      });
      expect(service.list({ ...CHILD, status: "open" })).toHaveLength(1);
    });
  });
});
