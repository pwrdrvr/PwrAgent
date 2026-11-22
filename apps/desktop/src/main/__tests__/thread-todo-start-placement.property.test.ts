import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_TODO_PLACEMENTS,
  resolveThreadTodoPlacement,
  threadTodoPlacementParent,
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
 * The rule: a started thread is filed beside the raising thread (under its
 * parent, or top-level when it has none) unless the operator or the agent
 * names another placement. A sub-thread goes under the raising thread and
 * top-level under nothing. A start for another project or on another
 * machine is always top-level, and an explicit sub-thread there is refused,
 * never quietly made top-level. Before siblings, an unnamed placement nested
 * the thread under the raising one, so a child's follow-up became a
 * grandchild.
 */
type Outcome = "under-source" | "under-group-root" | "top-level" | "refused";

function oracle(params: {
  proposed?: ThreadTodoPlacement;
  requested?: ThreadTodoPlacement;
  crossProject: boolean;
  onPeer: boolean;
  sourceHasParent: boolean;
}): Outcome {
  if (params.crossProject || params.onPeer) {
    return params.requested === "sub_thread" ? "refused" : "top-level";
  }
  const placement = params.requested ?? params.proposed ?? "sibling";
  if (placement === "sub_thread") return "under-source";
  if (placement === "sibling" && params.sourceHasParent) return "under-group-root";
  return "top-level";
}

const CHOICES: (ThreadTodoPlacement | undefined)[] = [undefined, ...THREAD_TODO_PLACEMENTS];
const CASES = CHOICES.flatMap((proposed) => CHOICES.flatMap((requested) =>
  [false, true].flatMap((crossProject) => [false, true].flatMap((onPeer) =>
    [false, true].map((sourceHasParent) => ({ proposed, requested, crossProject, onPeer, sourceHasParent }))))));

const GROUP_ROOT = { backend: "codex" as const, threadId: "group-root" };

function outcomeOf(parent: { threadId: string } | undefined): Outcome {
  return parent?.threadId === "source-thread" ? "under-source"
    : parent?.threadId === "group-root" ? "under-group-root"
    : "top-level";
}

const THREAD = { backend: "codex" as const, threadId: "source-thread" };
const ATLAS: ThreadTodoProject = { key: "directory:/src/atlas", label: "atlas", path: "/src/atlas" };
const SNAP: ThreadTodoProject = { key: "directory:/src/pwrsnap", label: "PwrSnap", path: "/src/pwrsnap" };
const SOURCE: HandoffSourceSettings = { executionMode: "default", model: "gpt-6.1-sol", reasoningEffort: "high" };

describe("resolveThreadTodoPlacement", () => {
  it("matches the oracle for every proposal, pick, project, machine and parent", () => {
    for (const entry of CASES) {
      const resolved = resolveThreadTodoPlacement({
        ...(entry.proposed ? { proposed: entry.proposed } : {}),
        ...(entry.requested ? { requested: entry.requested } : {}),
        crossProject: entry.crossProject,
        otherMachine: entry.onPeer,
      });
      const outcome: Outcome = resolved.refused ? "refused" : outcomeOf(threadTodoPlacementParent(
        resolved.placement, THREAD, entry.sourceHasParent ? GROUP_ROOT : undefined));
      expect({ entry, outcome }).toEqual({ entry, outcome: oracle(entry) });
    }
  });

  it("keeps an older owner's unnamed placement a sub-thread", () => {
    expect(resolveThreadTodoPlacement({ crossProject: false, otherMachine: false, legacyDefault: true }).placement)
      .toBe("sub_thread");
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

  it("files the thread beside, under, or apart from the raising thread for every combination", async () => {
    const registry = {
      readThreadHandoffSettings: vi.fn(async (): Promise<HandoffSourceSettings> => SOURCE),
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
      registry.readThreadHandoffSettings.mockResolvedValue(entry.sourceHasParent ? { ...SOURCE, parentThread: GROUP_ROOT } : SOURCE);
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
        // A refused card stays open; close it so the thread stays under its cap.
        service.resolve({ id: todo.id, status: "dismissed" });
        continue;
      }
      await expect(run, label).resolves.toMatchObject({ status: "done" });
      if (entry.onPeer) {
        expect(startThreadOnInstance, label).toHaveBeenCalledTimes(1);
        continue;
      }
      const started = registry.startThread.mock.calls[0]?.[0] as { parentThreadId?: string } | undefined;
      expect(outcomeOf(started?.parentThreadId ? { threadId: started.parentThreadId } : undefined), label).toBe(expected);
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
