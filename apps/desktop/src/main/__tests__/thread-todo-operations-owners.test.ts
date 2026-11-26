import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";

const fixture = vi.hoisted(() => ({
  cards: [] as ThreadTodo[],
  listThreads: vi.fn(async (_params: Record<string, unknown>): Promise<AppServerThreadSummary[]> => []),
  managed: new Set<string>(),
  loadIndex: vi.fn(),
  raisePlan: vi.fn(async (_registry: unknown, thread: { threadId: string }, plan: { title: string }) => ({
    id: "plan-card", backend: "codex", threadId: thread.threadId, key: "plan", kind: "reminder", status: "open",
    title: `Plan: ${plan.title}`, createdAt: 1, updatedAt: 1,
  })),
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({ listThreads: fixture.listThreads }),
}));
vi.mock("../storage/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({ readManagedSubAgentThreadKeys: () => fixture.managed }),
}));
vi.mock("../app-server/navigation-query-source", () => ({ loadLocalNavigationQueryIndex: fixture.loadIndex }));
vi.mock("../thread-todos/thread-todo-runtime", () => ({
  getThreadTodoService: () => ({
    list: () => fixture.cards,
    withDispatchDefaults: async (todos: ThreadTodo[]) => todos,
    mergeMethodPreferences: () => ({}),
  }),
  listThreadTodoProjects: vi.fn(),
  raiseThreadTodoPlan: fixture.raisePlan,
  setThreadTodoProject: vi.fn(),
}));
vi.mock("../thread-reviews/thread-review-runtime", () => ({ getThreadReviewService: () => ({ list: () => [] }) }));

import { localThreadTodoOperations } from "../thread-todos/thread-todo-operations";

function card(threadId: string, createdAt: number): ThreadTodo {
  return { id: `card-${threadId}`, backend: "codex", threadId, kind: "reminder", status: "open",
    title: `Card for ${threadId}`, createdAt, updatedAt: createdAt };
}

function thread(id: string, overrides: Partial<AppServerThreadSummary> = {}): AppServerThreadSummary {
  return { id, source: "codex", title: `Thread ${id}`, ...overrides } as AppServerThreadSummary;
}

describe("listing To-dos on their owner", () => {
  it("checks cards against the cached provider listing, never the navigation index", async () => {
    fixture.cards = [card("active", 3), card("archived", 2), card("private", 1)];
    fixture.managed = new Set(["codex:private"]);
    fixture.listThreads.mockResolvedValue([
      thread("active", { title: "Active thread" }),
      thread("archived", { archivedAt: 5 }),
      thread("private"),
    ]);

    const response = await localThreadTodoOperations.listTodos({ status: "open" });

    expect(response.todos.map((todo) => [todo.threadId, todo.threadTitle])).toEqual([["active", "Active thread"]]);
    // One listing call, keyed like the sidebar index's so it reuses that cache entry.
    expect(fixture.listThreads).toHaveBeenCalledTimes(1);
    expect(fixture.listThreads.mock.calls[0]![0]).toEqual({ callerReason: "thread-todo-owners", enrichDirectories: true });
    expect(fixture.loadIndex).not.toHaveBeenCalled();
  });

  it("reads no listing when there are no cards", async () => {
    fixture.cards = [];
    fixture.listThreads.mockClear();
    expect((await localThreadTodoOperations.listTodos({ status: "open" })).todos).toEqual([]);
    expect(fixture.listThreads).not.toHaveBeenCalled();
  });

  it("returns a single thread's completed to-dos even if the thread is archived without scanning owners", async () => {
    const archivedDone: ThreadTodo = {
      ...card("archived", 2),
      kind: "handoff",
      status: "done",
      resolvedAt: 4,
      startedThread: { backend: "codex", threadId: "child-1" },
    };
    fixture.cards = [archivedDone];
    fixture.listThreads.mockClear();
    fixture.listThreads.mockResolvedValue([thread("archived", { archivedAt: 5 })]);

    const scoped = await localThreadTodoOperations.listTodos({
      status: "done",
      backend: "codex",
      threadId: "archived",
    });
    expect(scoped.todos).toEqual([archivedDone]);
    expect(fixture.listThreads).not.toHaveBeenCalled();

    // Unscoped completed listing still filters archived threads out of the global panel.
    const globalDone = await localThreadTodoOperations.listTodos({ status: "done" });
    expect(globalDone.todos).toEqual([]);
    expect(fixture.listThreads).toHaveBeenCalledTimes(1);
  });
});

describe("raising a started thread's plan for a peer", () => {
  const valid = { backend: "codex" as const, threadId: "peer-child", title: "Smoke test", items: [" Run lint ", "Ship"] };

  it("raises the trimmed steps on the named thread", async () => {
    await expect(localThreadTodoOperations.raisePlan(valid)).resolves.toMatchObject({ todo: { key: "plan" } });
    expect(fixture.raisePlan).toHaveBeenLastCalledWith(expect.anything(), { backend: "codex", threadId: "peer-child" },
      { title: "Smoke test", items: ["Run lint", "Ship"] });
  });

  it("clips an overlong title instead of refusing a plan the thread was already told about", async () => {
    await localThreadTodoOperations.raisePlan({ ...valid, title: "x".repeat(200) });
    expect(fixture.raisePlan.mock.lastCall?.[2]).toMatchObject({ title: "x".repeat(120) });
  });

  it.each([
    ["an unknown backend", { backend: "other" }],
    ["no thread", { threadId: " " }],
    ["no title", { title: "" }],
    ["no steps", { items: [] }],
    ["a blank step", { items: ["Run lint", " "] }],
    ["too many steps", { items: Array.from({ length: 21 }, (_, index) => `Step ${index}`) }],
  ])("refuses %s", async (_name, change) => {
    fixture.raisePlan.mockClear();
    await expect(localThreadTodoOperations.raisePlan({ ...valid, ...change } as never)).rejects.toThrow();
    expect(fixture.raisePlan).not.toHaveBeenCalled();
  });
});
