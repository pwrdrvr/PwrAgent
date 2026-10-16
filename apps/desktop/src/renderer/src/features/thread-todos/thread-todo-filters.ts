import type { ThreadTodo } from "@pwragent/shared";
import type { OperatorWait } from "../operator-requests/operator-waits";

export type ThreadTodoCategory = "questions" | "approvals" | "reviews" | "todos";
export type ThreadTodoFilter = Readonly<Partial<Record<ThreadTodoCategory, boolean>>>;

/** Missing categories default to visible; an explicit false hides one. */
export function threadTodoMatchesFilter(todo: ThreadTodo, filter: ThreadTodoFilter = {}): boolean {
  return filter[todo.reviewId ? "reviews" : "todos"] !== false;
}

export function operatorWaitMatchesFilter(wait: OperatorWait, filter: ThreadTodoFilter = {}): boolean {
  const category = wait.kind === "approval" || wait.kind === "mcp-approval" ? "approvals" : "questions";
  return filter[category] !== false;
}
