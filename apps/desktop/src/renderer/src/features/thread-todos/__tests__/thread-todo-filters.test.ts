import { describe, expect, it } from "vitest";
import type { ThreadTodo } from "@pwragent/shared";
import { operatorWaitMatchesFilter, threadTodoMatchesFilter } from "../thread-todo-filters";
import type { OperatorWait } from "../../operator-requests/operator-waits";

const todo: ThreadTodo = { id: "todo", backend: "codex", threadId: "thread", kind: "review", status: "open", title: "Start a review", createdAt: 1, updatedAt: 1 };
const wait: OperatorWait = { key: "wait", kind: "question", backend: "codex", threadId: "thread", threadKey: "codex:thread", title: "Choose a branch", createdAt: 1 };

describe("To-do categories", () => {
  it("separates waiting reviews from cards that propose starting a review", () => {
    expect(threadTodoMatchesFilter(todo, { todos: false, reviews: true })).toBe(false);
    expect(threadTodoMatchesFilter({ ...todo, reviewId: "review" }, { todos: false, reviews: true })).toBe(true);
  });
  it("groups blocking input with questions and MCP approvals with approvals", () => {
    expect(operatorWaitMatchesFilter({ ...wait, kind: "mcp-input" }, { questions: false })).toBe(false);
    expect(operatorWaitMatchesFilter({ ...wait, kind: "questionnaire" }, { approvals: false })).toBe(true);
    expect(operatorWaitMatchesFilter({ ...wait, kind: "mcp-approval" }, { approvals: false })).toBe(false);
  });
  it("keeps every category visible by default", () => {
    expect(threadTodoMatchesFilter(todo)).toBe(true);
    expect(operatorWaitMatchesFilter(wait)).toBe(true);
  });
});
