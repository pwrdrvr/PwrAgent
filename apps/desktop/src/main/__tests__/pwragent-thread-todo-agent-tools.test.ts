import { describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import {
  buildPwrAgentThreadTodoToolDefinitions,
  normalizeAddTodoArgs,
  normalizePullRequestReference,
  type PwrAgentThreadTodoHandler,
} from "../agent-tools/pwragent-thread-todo-agent-tools";
import { ThreadTodoError } from "../thread-todos/thread-todo-service";

const CONTEXT: AgentToolCallContext = {
  backend: "codex",
  threadId: "thread-a",
  transport: "codex_dynamic_tool",
};

const TODO: ThreadTodo = {
  id: "todo-1",
  backend: "codex",
  threadId: "thread-a",
  kind: "reminder",
  status: "open",
  title: "Check the docs",
  createdAt: 1,
  updatedAt: 1,
};

function tool(
  name: "add_todo" | "list_todos" | "resolve_todo",
  handler: PwrAgentThreadTodoHandler | undefined,
) {
  const definition = buildPwrAgentThreadTodoToolDefinitions(handler)
    .find((entry) => entry.name === name);
  if (!definition) throw new Error(`missing ${name}`);
  return definition;
}

function createHandler(): PwrAgentThreadTodoHandler {
  return {
    add: vi.fn(async () => ({ todo: TODO, created: true })),
    list: vi.fn(() => [TODO]),
    resolve: vi.fn(() => ({ ...TODO, status: "done" as const })),
  };
}

describe("normalizePullRequestReference", () => {
  it.each([
    [42, "42"],
    ["42", "42"],
    ["#42", "42"],
    [" #7 ", "7"],
    ["https://github.com/acme/widgets/pull/42", "https://github.com/acme/widgets/pull/42"],
    ["https://github.com/acme/widgets/pull/42/", "https://github.com/acme/widgets/pull/42"],
  ])("accepts %j", (input, expected) => {
    expect(normalizePullRequestReference(input)).toBe(expected);
  });

  it.each([
    0,
    -3,
    1.5,
    "",
    "feature/branch",
    "042",
    "https://gitlab.com/acme/widgets/-/merge_requests/4",
    "https://github.com/acme/widgets/issues/42",
    "https://github.com/acme/widgets/pull/42/files",
  ])("refuses %j", (input) => {
    expect(normalizePullRequestReference(input)).toBeUndefined();
  });
});

describe("normalizeAddTodoArgs", () => {
  it("requires a title", () => {
    expect(normalizeAddTodoArgs({ title: "   " })).toMatchObject({ ok: false });
  });

  it("forces squash and refuses other merge methods", () => {
    expect(normalizeAddTodoArgs({
      title: "Merge",
      action: { type: "merge_pull_request", pullRequest: 12 },
    })).toEqual({
      ok: true,
      value: {
        title: "Merge",
        action: { type: "merge_pull_request", pullRequest: "12", method: "squash" },
      },
    });
    expect(normalizeAddTodoArgs({
      title: "Merge",
      action: { type: "merge_pull_request", pullRequest: 12, method: "rebase" },
    })).toMatchObject({ ok: false });
  });

  it("keeps a handoff's optional fields and drops blank ones", () => {
    expect(normalizeAddTodoArgs({
      title: "Hand off",
      detail: "  ",
      key: "handoff",
      action: {
        type: "start_thread",
        prompt: "Write the tests",
        model: "",
        workMode: "worktree",
      },
    })).toEqual({
      ok: true,
      value: {
        title: "Hand off",
        key: "handoff",
        action: { type: "start_thread", prompt: "Write the tests", workMode: "worktree" },
      },
    });
  });

  it("refuses an unknown action type and a bad work mode", () => {
    expect(normalizeAddTodoArgs({ title: "x", action: { type: "deploy" } }))
      .toMatchObject({ ok: false });
    expect(normalizeAddTodoArgs({
      title: "x",
      action: { type: "start_thread", prompt: "go", workMode: "cloud" },
    })).toMatchObject({ ok: false });
  });
});

describe("thread to-do tool dispatch", () => {
  it("raises a card for the calling thread, never one named in arguments", async () => {
    const handler = createHandler();
    const result = await tool("add_todo", handler).dispatch(
      { title: "Check the docs", threadId: "someone-else" },
      CONTEXT,
    );

    expect(result).toMatchObject({ ok: true, data: { created: true, todo: { id: "todo-1" } } });
    expect(handler.add).toHaveBeenCalledWith(
      { backend: "codex", threadId: "thread-a" },
      { title: "Check the docs" },
    );
  });

  it("defaults list to open and resolve to done", async () => {
    const handler = createHandler();
    await tool("list_todos", handler).dispatch({}, CONTEXT);
    expect(handler.list).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-a" }, "open");

    await tool("resolve_todo", handler).dispatch({ key: "review" }, CONTEXT);
    expect(handler.resolve).toHaveBeenCalledWith(
      { backend: "codex", threadId: "thread-a" },
      { key: "review", status: "done" },
    );
  });

  it("refuses to reopen through the tool", async () => {
    const result = await tool("resolve_todo", createHandler())
      .dispatch({ id: "todo-1", status: "open" }, CONTEXT);
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });

  it("reports the service's error code", async () => {
    const handler = createHandler();
    handler.add = vi.fn(async () => {
      throw new ThreadTodoError("limit_reached", "Too many.");
    });
    const result = await tool("add_todo", handler).dispatch({ title: "One more" }, CONTEXT);
    expect(result).toEqual({ ok: false, code: "limit_reached", message: "Too many." });
  });

  it("fails cleanly before the runtime installs a handler", async () => {
    const result = await tool("list_todos", undefined).dispatch({}, CONTEXT);
    expect(result).toMatchObject({ ok: false, code: "internal_error" });
  });
});
