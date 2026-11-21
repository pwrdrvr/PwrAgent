import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_TODO_PLACEMENTS,
  resolveThreadTodoPlacement,
  type ThreadTodoPlacement,
  type ThreadTodoProject,
} from "@pwragent/shared/contracts/thread-todos";
import type { HandoffSourceSettings } from "../app-server/backend-registry-types";
import {
  normalizeAddTodoArgs,
  normalizeUpdateTodoArgs,
} from "../agent-tools/pwragent-thread-todo-agent-tools";
import { createThreadTodoRunners, type ThreadTodoRunnerRegistry } from "../thread-todos/thread-todo-runtime";
import { ThreadTodoError, ThreadTodoService } from "../thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../storage/thread-todo-store";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

/**
 * The rule: a start-thread card's thread is a sub-thread of the raising
 * thread exactly when it starts on the card's own machine, in the same
 * project, and neither the operator's pick nor the agent's proposal says
 * top-level. A sub-thread asked for where none can exist is refused, never
 * quietly made top-level. Before placement, every same-project local start
 * was nested, whatever the work was.
 */
function oracle(params: {
  proposed?: ThreadTodoPlacement;
  requested?: ThreadTodoPlacement;
  crossProject: boolean;
  onPeer: boolean;
}): "nested" | "top_level" | "refused" {
  if (params.crossProject || params.onPeer) {
    return params.requested === "sub_thread" ? "refused" : "top_level";
  }
  return (params.requested ?? params.proposed ?? "sub_thread") === "sub_thread" ? "nested" : "top_level";
}

const CHOICES: (ThreadTodoPlacement | undefined)[] = [undefined, ...THREAD_TODO_PLACEMENTS];
const CASES = CHOICES.flatMap((proposed) => CHOICES.flatMap((requested) =>
  [false, true].flatMap((crossProject) => [false, true].map((onPeer) => ({ proposed, requested, crossProject, onPeer })))));

const THREAD = { backend: "codex" as const, threadId: "source-thread" };
const ATLAS: ThreadTodoProject = { key: "directory:/src/atlas", label: "atlas", path: "/src/atlas" };
const SNAP: ThreadTodoProject = { key: "directory:/src/pwrsnap", label: "PwrSnap", path: "/src/pwrsnap" };
const SOURCE: HandoffSourceSettings = { executionMode: "default", model: "gpt-6.1-sol", reasoningEffort: "high" };

describe("resolveThreadTodoPlacement", () => {
  it("matches the oracle for every proposal, pick, project and machine", () => {
    for (const entry of CASES) {
      const resolved = resolveThreadTodoPlacement({
        ...(entry.proposed ? { proposed: entry.proposed } : {}),
        ...(entry.requested ? { requested: entry.requested } : {}),
        crossProject: entry.crossProject,
        otherMachine: entry.onPeer,
      });
      const expected = oracle(entry);
      expect({ entry, outcome: resolved.refused ? "refused" : resolved.placement === "sub_thread" ? "nested" : "top_level" })
        .toEqual({ entry, outcome: expected });
    }
  });
});

describe("a to-do card's Start thread files the thread where the rule says", () => {
  let db: StateDb;
  let tempDir: string;
  let ids = 0;

  beforeEach(() => {
    const temp = createTempStateDb("pwragent-thread-todo-placement-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
  });

  afterEach(() => {
    db.close();
    removeTempStateDbDir(tempDir);
  });

  it("nests, starts top-level, or refuses for every combination", async () => {
    const registry = {
      readThreadHandoffSettings: vi.fn(async () => SOURCE),
      readBackendModelOptions: vi.fn(async () => undefined),
      listBackends: vi.fn(async () => ({ fetchedAt: 0, backends: [] })),
      startThread: vi.fn(async (_params: Record<string, unknown>) => ({ backend: "codex" as const, threadId: "child" })),
      renameThread: vi.fn(async () => undefined),
      startTurn: vi.fn(async () => ({ turnId: "turn" })),
      buildThreadTodoMessageOrigin: vi.fn(async () => ({ kind: "agent" as const })),
    };
    const local = createThreadTodoRunners({ registry: registry as unknown as ThreadTodoRunnerRegistry });
    const startThreadOnInstance = vi.fn(async () => ({ backend: "codex" as const, threadId: "remote", instanceId: "peer" }));
    const service = new ThreadTodoService({
      store: new ThreadTodoStore(db),
      runners: { ...local, startThreadOnInstance },
      newId: () => `todo-${++ids}`,
    });

    for (const entry of CASES) {
      registry.startThread.mockClear();
      startThreadOnInstance.mockClear();
      const expected = oracle(entry);
      // add_todo refuses a sub-thread proposed for another project, so such
      // a card holds a proposal only when it moved there afterwards.
      const proposedHere = entry.crossProject && entry.proposed === "sub_thread" ? undefined : entry.proposed;
      const { todo } = service.add({
        ...THREAD,
        cwd: "/src/atlas",
        sourceProject: ATLAS,
        ...(entry.crossProject ? { targetProject: SNAP } : {}),
        input: {
          title: "Follow-up",
          action: { type: "start_thread", prompt: "Do the follow-up", ...(proposedHere ? { placement: proposedHere } : {}) },
        },
      });
      const run = service.runAction(todo.id, {
        ...(entry.requested ? { placement: entry.requested } : {}),
        ...(entry.onPeer ? { startOnInstanceId: "peer" } : {}),
      });
      const label = JSON.stringify({ ...entry, proposed: proposedHere });
      if (expected === "refused") {
        await expect(run, label).rejects.toBeInstanceOf(ThreadTodoError);
        expect(registry.startThread, label).not.toHaveBeenCalled();
        expect(startThreadOnInstance, label).not.toHaveBeenCalled();
        continue;
      }
      await expect(run, label).resolves.toMatchObject({ status: "done" });
      if (entry.onPeer) {
        expect(startThreadOnInstance, label).toHaveBeenCalledTimes(1);
        continue;
      }
      const started = registry.startThread.mock.calls[0]?.[0];
      expect(started?.parentThreadId, label).toBe(expected === "nested" ? "source-thread" : undefined);
    }
  });

  it("refuses a sub-thread proposed for another project, and keeps an older proposal when the card moves", () => {
    const service = new ThreadTodoService({ store: new ThreadTodoStore(db), newId: () => `todo-${++ids}` });
    expect(() => service.add({
      ...THREAD, sourceProject: ATLAS, targetProject: SNAP,
      input: { title: "Build", action: { type: "start_thread", prompt: "Build", placement: "sub_thread" } },
    })).toThrow("placement cannot be sub_thread");
    const { todo } = service.add({
      ...THREAD, sourceProject: ATLAS,
      input: { title: "Build", action: { type: "start_thread", prompt: "Build", placement: "sub_thread" } },
    });
    expect(() => service.update({ id: todo.id, targetProject: SNAP, action: { placement: "sub_thread" } }))
      .toThrow("placement cannot be sub_thread");
    expect(service.update({ id: todo.id, targetProject: SNAP }).targetProject).toEqual(SNAP);
    expect(service.update({ id: todo.id, action: { placement: null } }).action).not.toHaveProperty("placement");
  });
});

describe("add_todo and update_todo placement", () => {
  it("accepts sub_thread and top_level, clears with empty, and refuses anything else", () => {
    for (const placement of THREAD_TODO_PLACEMENTS) {
      expect(normalizeAddTodoArgs({ title: "Go", action: { type: "start_thread", prompt: "go", placement } }))
        .toMatchObject({ ok: true, value: { action: { placement } } });
      expect(normalizeUpdateTodoArgs({ id: "todo-1", placement }))
        .toMatchObject({ ok: true, value: { action: { placement } } });
    }
    expect(normalizeAddTodoArgs({ title: "Go", action: { type: "start_thread", prompt: "go" } }))
      .toMatchObject({ ok: true, value: { action: expect.not.objectContaining({ placement: expect.anything() }) } });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", placement: "" }))
      .toMatchObject({ ok: true, value: { action: { placement: null } } });
    expect(normalizeAddTodoArgs({ title: "Go", action: { type: "start_thread", prompt: "go", placement: "child" } }))
      .toMatchObject({ ok: false });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", placement: "nested" })).toMatchObject({ ok: false });
  });
});
