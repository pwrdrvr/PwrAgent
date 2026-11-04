import { describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared";
import {
  THREAD_TODO_ITEM_TEXT_MAX_LENGTH,
  THREAD_TODO_MAX_ITEMS,
  THREAD_TODO_MAX_PREREQUISITES,
} from "@pwragent/shared";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import {
  buildPwrAgentThreadTodoToolDefinitions,
  normalizeAddTodoArgs,
  normalizePullRequestReference,
  normalizeUpdateTodoArgs,
  type PwrAgentThreadTodoHandler,
} from "../agent-tools/pwragent-thread-todo-agent-tools";
import { ThreadTodoError, ThreadTodoService } from "../thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../thread-todos/thread-todo-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

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
  name: "add_todo" | "update_todo" | "list_todos" | "resolve_todo",
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
    update: vi.fn(async () => TODO),
    list: vi.fn(() => [TODO]),
    resolve: vi.fn(() => ({ ...TODO, status: "done" as const })),
  };
}

describe("normalizePullRequestReference", () => {
  it("accepts an existing thread request and rejects invalid destinations", () => {
    const action = { type: "send_message", prompt: "Refresh #42", target: { backend: "codex", threadId: "owner", title: "PR owner" } };
    expect(normalizeAddTodoArgs({ title: "Refresh the PR", action })).toMatchObject({ ok: true, value: { action } });
    for (const target of [null, {}, { backend: "unknown", threadId: "owner" }, { backend: "codex", threadId: " " }]) {
      expect(normalizeAddTodoArgs({ title: "Refresh", action: { ...action, target } }).ok).toBe(false);
    }
  });
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

  it("leaves the merge method to the operator", () => {
    expect(normalizeAddTodoArgs({
      title: "Merge",
      action: { type: "merge_pull_request", pullRequest: 12, method: "rebase" },
    })).toEqual({
      ok: true,
      value: {
        title: "Merge",
        action: { type: "merge_pull_request", pullRequest: "12" },
      },
    });
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

  it("passes a named project through for the runtime to resolve", () => {
    expect(normalizeAddTodoArgs({ title: "Build it", project: " PwrSnap " })).toEqual({
      ok: true,
      value: { title: "Build it", project: "PwrSnap" },
    });
    expect(normalizeAddTodoArgs({ title: "Build it", project: "x".repeat(1_001) }))
      .toMatchObject({ ok: false });
  });

  it("keeps a handoff's permissions and refuses an unknown one", () => {
    expect(normalizeAddTodoArgs({
      title: "Hand off",
      action: { type: "start_thread", prompt: "Go", executionMode: "auto" },
    })).toMatchObject({
      ok: true,
      value: { action: { type: "start_thread", prompt: "Go", executionMode: "auto" } },
    });
    expect(normalizeAddTodoArgs({
      title: "Hand off",
      action: { type: "start_thread", prompt: "Go", executionMode: "yolo" },
    })).toMatchObject({ ok: false });
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

describe("checklist arguments", () => {
  it("takes steps as trimmed strings within the limits", () => {
    expect(normalizeAddTodoArgs({ title: "Ship", items: ["  Run the tests ", "Docs"] }))
      .toEqual({ ok: true, value: { title: "Ship", items: ["Run the tests", "Docs"] } });
    expect(normalizeAddTodoArgs({ title: "Ship", items: [] }))
      .toEqual({ ok: true, value: { title: "Ship", items: [] } });
    for (const items of [
      "Run the tests",
      ["Run the tests", ""],
      [{ text: "Run the tests" }],
      ["x".repeat(THREAD_TODO_ITEM_TEXT_MAX_LENGTH + 1)],
      Array.from({ length: THREAD_TODO_MAX_ITEMS + 1 }, (_, index) => `Step ${index}`),
    ]) {
      expect(normalizeAddTodoArgs({ title: "Ship", items })).toMatchObject({ ok: false });
    }
  });

  it("takes prerequisites beside the steps", () => {
    expect(normalizeAddTodoArgs({ title: "Build", items: ["Implement"], prerequisites: [" Clone "] }))
      .toEqual({ ok: true, value: { title: "Build", items: ["Implement"], prerequisites: ["Clone"] } });
    expect(normalizeAddTodoArgs({ title: "Build", prerequisites: "Clone" })).toMatchObject({ ok: false });
    // They show in full on a resting card, so they have a smaller cap.
    const tooMany = Array.from({ length: THREAD_TODO_MAX_PREREQUISITES + 1 }, (_, index) => `P${index}`);
    expect(normalizeAddTodoArgs({ title: "Build", prerequisites: tooMany })).toMatchObject({
      ok: false,
      message: `add_todo prerequisites may hold at most ${THREAD_TODO_MAX_PREREQUISITES} steps.`,
    });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", prerequisites: [] }))
      .toEqual({ ok: true, target: { id: "todo-1" }, value: { prerequisites: [] } });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", prerequisites: [""] })).toMatchObject({ ok: false });
  });

  it("reads restated steps and step ids to tick on update", () => {
    expect(normalizeUpdateTodoArgs({ key: "ship", items: ["A"], check: ["s-1", "s-1"], uncheck: [] }))
      .toEqual({ ok: true, target: { key: "ship" }, value: { items: ["A"], check: ["s-1"] } });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", uncheck: ["s-2"] }))
      .toEqual({ ok: true, target: { id: "todo-1" }, value: { uncheck: ["s-2"] } });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", check: "s-1" })).toMatchObject({ ok: false });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", check: [""] })).toMatchObject({ ok: false });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", check: [] })).toMatchObject({ ok: false });
  });

  it("describes steps, ticking and the override in the schemas", () => {
    const add = tool("add_todo", undefined).inputSchema as {
      properties: { items: { type: string; maxItems: number; description: string } };
    };
    expect(add.properties.items).toMatchObject({ type: "array", maxItems: THREAD_TODO_MAX_ITEMS });
    expect(add.properties.items.description).toContain("keeps its id and checked state");
    const update = tool("update_todo", undefined).inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(update.properties)).toEqual(
      expect.arrayContaining(["items", "prerequisites", "check", "uncheck"]),
    );
    expect(Object.keys(add.properties)).toContain("prerequisites");
    // Steps on a handoff are the new thread's work; only prerequisites block.
    expect(tool("add_todo", undefined).description)
      .toContain("items are the new thread's plan and never block starting it");
    const resolve = tool("resolve_todo", undefined).inputSchema as {
      properties: Record<string, { type: string }>;
    };
    expect(resolve.properties.allowOpenItems).toMatchObject({ type: "boolean" });
    expect(tool("resolve_todo", undefined).description).toContain("unchecked");
  });
});

describe("normalizeUpdateTodoArgs", () => {
  it("reads only the fields given, as a patch", () => {
    expect(normalizeUpdateTodoArgs({
      id: "todo-1",
      model: "GPT-6.1-Sol",
      reasoningEffort: "xhigh",
      executionMode: "auto",
    })).toEqual({
      ok: true,
      target: { id: "todo-1" },
      value: { action: { model: "GPT-6.1-Sol", reasoningEffort: "xhigh", executionMode: "auto" } },
    });
  });

  it("clears an optional field with an empty string", () => {
    expect(normalizeUpdateTodoArgs({
      key: "handoff",
      detail: "",
      project: "",
      model: "",
      executionMode: "",
    })).toEqual({
      ok: true,
      target: { key: "handoff" },
      value: { detail: null, project: null, action: { model: null, executionMode: null } },
    });
  });

  it("needs a target and something to change, and refuses bad values", () => {
    expect(normalizeUpdateTodoArgs({ model: "x" })).toMatchObject({ ok: false });
    expect(normalizeUpdateTodoArgs({ id: "todo-1" })).toMatchObject({ ok: false });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", title: " " })).toMatchObject({ ok: false });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", prompt: "" })).toMatchObject({ ok: false });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", executionMode: "yolo" }))
      .toMatchObject({ ok: false });
    expect(normalizeUpdateTodoArgs({ id: "todo-1", pullRequest: "main" }))
      .toMatchObject({ ok: false });
  });
});

describe("thread to-do tool dispatch", () => {
  it("updates one of the calling thread's cards", async () => {
    const handler = createHandler();
    const result = await tool("update_todo", handler).dispatch(
      { id: "todo-1", executionMode: "auto", threadId: "someone-else" },
      CONTEXT,
    );

    expect(result).toMatchObject({ ok: true, data: { todo: { id: "todo-1" } } });
    expect(handler.update).toHaveBeenCalledWith(
      { backend: "codex", threadId: "thread-a" },
      { id: "todo-1" },
      { action: { executionMode: "auto" } },
    );
  });

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

  it("points a card's project at list_instance_projects", () => {
    const add = tool("add_todo", undefined);
    expect(add.description).toContain("list_instance_projects");
    for (const name of ["add_todo", "update_todo"] as const) {
      const schema = tool(name, undefined).inputSchema as {
        properties: { project: { description: string } };
      };
      expect(schema.properties.project.description).toContain("list_instance_projects");
    }
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

  it("passes the open-steps override through, and only as true", async () => {
    const handler = createHandler();
    await tool("resolve_todo", handler).dispatch({ id: "todo-1", allowOpenItems: true }, CONTEXT);
    expect(handler.resolve).toHaveBeenLastCalledWith(
      { backend: "codex", threadId: "thread-a" },
      { id: "todo-1", status: "done", allowOpenItems: true },
    );
    await tool("resolve_todo", handler).dispatch({ id: "todo-1", allowOpenItems: false }, CONTEXT);
    expect(handler.resolve).toHaveBeenLastCalledWith(
      { backend: "codex", threadId: "thread-a" },
      { id: "todo-1", status: "done" },
    );
    expect(await tool("resolve_todo", handler).dispatch({ id: "todo-1", allowOpenItems: "yes" }, CONTEXT))
      .toMatchObject({ ok: false, code: "invalid_arguments" });
  });

  it("lets a thread claim a card it was asked to do here", async () => {
    const handler = createHandler();
    await tool("resolve_todo", handler).dispatch({ id: "todo-1", resolution: "sent_here" }, CONTEXT);
    expect(handler.resolve).toHaveBeenLastCalledWith(
      { backend: "codex", threadId: "thread-a" },
      { id: "todo-1", status: "done", resolution: "sent_here" },
    );
    expect(await tool("resolve_todo", handler).dispatch({ id: "todo-1", resolution: "handled_elsewhere" }, CONTEXT))
      .toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(await tool("resolve_todo", handler).dispatch(
      { id: "todo-1", status: "dismissed", resolution: "sent_here" },
      CONTEXT,
    )).toMatchObject({ ok: false, code: "invalid_arguments" });
    // Read before resolve_todo, on a backend that loads schemas on demand.
    for (const operation of ["add_todo", "list_todos", "resolve_todo"] as const) {
      expect(tool(operation, handler).description).toContain("resolution sent_here");
    }
  });

  it("raises, ticks, re-raises and resolves a checklist card end to end", async () => {
    const db = openInMemoryStateDb();
    try {
      let ids = 0;
      const service = new ThreadTodoService({
        store: new ThreadTodoStore(db),
        newId: () => `id-${++ids}`,
      });
      const handler: PwrAgentThreadTodoHandler = {
        add: async (context, input) => service.add({ ...context, input }),
        update: async (context, target, input) =>
          service.update({ id: service.findForThread({ ...context, ...target }).id, ...input }),
        list: (context, status) => service.list({ ...context, status }),
        resolve: (context, target) => service.resolveFromThread({ ...context, ...target }),
      };
      const raised = await tool("add_todo", handler).dispatch({
        key: "ship",
        title: "Ship the release",
        items: ["Run the tests", "Update the docs", "Tag the release"],
      }, CONTEXT);
      expect(raised).toMatchObject({
        ok: true,
        data: {
          created: true,
          todo: {
            items: [
              { id: "id-2", text: "Run the tests", checked: false },
              { id: "id-3", text: "Update the docs", checked: false },
              { id: "id-4", text: "Tag the release", checked: false },
            ],
          },
        },
      });

      await tool("update_todo", handler).dispatch({ key: "ship", check: ["id-2", "id-3"] }, CONTEXT);
      const refused = await tool("resolve_todo", handler).dispatch({ key: "ship" }, CONTEXT);
      expect(refused).toMatchObject({ ok: false, code: "open_items" });
      expect(refused.ok ? "" : refused.message).toContain('"Tag the release" (id-4)');

      // Restating the list keeps the ticks of unchanged steps.
      const reraised = await tool("add_todo", handler).dispatch({
        key: "ship",
        title: "Ship the release",
        items: ["Run the tests", "Update the docs", "Tag v2", "Announce it"],
      }, CONTEXT);
      expect(reraised).toMatchObject({
        ok: true,
        data: {
          created: false,
          todo: {
            items: [
              { id: "id-2", checked: true },
              { id: "id-3", checked: true },
              { id: "id-5", text: "Tag v2", checked: false },
              { id: "id-6", text: "Announce it", checked: false },
            ],
          },
        },
      });

      await tool("update_todo", handler).dispatch({ key: "ship", check: ["id-5", "id-6"] }, CONTEXT);
      expect(await tool("resolve_todo", handler).dispatch({ key: "ship" }, CONTEXT))
        .toMatchObject({ ok: true, data: { todo: { status: "done" } } });
    } finally {
      db.close();
    }
  });

  it("returns a handoff's prerequisites apart from its steps", async () => {
    const db = openInMemoryStateDb();
    try {
      let ids = 0;
      const service = new ThreadTodoService({
        store: new ThreadTodoStore(db),
        newId: () => `id-${++ids}`,
      });
      const handler: PwrAgentThreadTodoHandler = {
        add: async (context, input) => service.add({ ...context, input }),
        update: async (context, target, input) =>
          service.update({ id: service.findForThread({ ...context, ...target }).id, ...input }),
        list: (context, status) => service.list({ ...context, status }),
        resolve: (context, target) => service.resolveFromThread({ ...context, ...target }),
      };
      const raised = await tool("add_todo", handler).dispatch({
        key: "build",
        title: "Build it in PwrSnap",
        items: ["Implement", "Test"],
        prerequisites: ["Clone PwrSnap"],
        action: { type: "start_thread", prompt: "Build it" },
      }, CONTEXT);
      expect(raised).toMatchObject({
        ok: true,
        data: {
          todo: {
            items: [
              { id: "id-3", text: "Implement", checked: false },
              { id: "id-4", text: "Test", checked: false },
            ],
            prerequisites: [{ id: "id-2", text: "Clone PwrSnap", checked: false }],
          },
        },
      });
      const refused = await tool("resolve_todo", handler).dispatch({ key: "build" }, CONTEXT);
      expect(refused.ok ? "" : refused.message).toContain('1 unchecked prerequisite: "Clone PwrSnap"');
      await tool("update_todo", handler).dispatch({ key: "build", check: ["id-2"] }, CONTEXT);
      // The new thread's steps do not hold the card open.
      expect(await tool("resolve_todo", handler).dispatch({ key: "build" }, CONTEXT))
        .toMatchObject({ ok: true, data: { todo: { status: "done" } } });
    } finally {
      db.close();
    }
  });

  it("fails cleanly before the runtime installs a handler", async () => {
    const result = await tool("list_todos", undefined).dispatch({}, CONTEXT);
    expect(result).toMatchObject({ ok: false, code: "internal_error" });
  });
});
