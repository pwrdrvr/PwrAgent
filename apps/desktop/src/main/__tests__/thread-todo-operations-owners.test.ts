import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary, ThreadTodo } from "@pwragent/shared";

const fixture = vi.hoisted(() => ({
  cards: [] as ThreadTodo[],
  listThreads: vi.fn(async (_params: Record<string, unknown>): Promise<AppServerThreadSummary[]> => []),
  managed: new Set<string>(),
  loadIndex: vi.fn(),
}));

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({ listThreads: fixture.listThreads }),
}));
vi.mock("../app-server/desktop-overlay-store", () => ({
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
});
