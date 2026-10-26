import type { ThreadReviewItem, ThreadTodo, ThreadTodoItem } from "@pwragent/shared";
import { threadTodoPrerequisites, threadTodoSteps } from "@pwragent/shared";

/**
 * What a card puts on the clipboard: Markdown a new thread's composer takes
 * as-is. Every copy reads the stored card, never what is on screen, so a
 * resting card's step window and its clamped description do not cut it.
 */
export function threadTodoMarkdown(
  todo: ThreadTodo,
  reviewItems?: readonly ThreadReviewItem[],
): string {
  const sections = [`## ${todo.title}`];
  if (todo.detail?.trim()) sections.push(todo.detail.trim());
  const prerequisites = threadTodoPrerequisites(todo);
  if (prerequisites.length > 0) {
    sections.push(`### Before you start\n\n${threadTodoStepsMarkdown(prerequisites)}`);
  }
  const steps = threadTodoSteps(todo);
  if (steps.length > 0) {
    // Headed only beside prerequisites; a card with steps alone copies as it always did.
    sections.push(prerequisites.length > 0
      ? `### Steps\n\n${threadTodoStepsMarkdown(steps)}`
      : threadTodoStepsMarkdown(steps));
  }
  if (reviewItems && reviewItems.length > 0) {
    sections.push(reviewItems.map(reviewItemMarkdown).join("\n"));
  }
  const action = todo.action;
  if (action?.type === "start_thread" && action.prompt.trim()) {
    sections.push(`### Prompt\n\n${action.prompt.trim()}`);
  }
  return sections.join("\n\n");
}

/** Steps as a task list; ticked steps keep their tick. */
export function threadTodoStepsMarkdown(items: readonly ThreadTodoItem[]): string {
  return items.map((item) => `- [${item.checked ? "x" : " "}] ${item.text}`).join("\n");
}

/** Every card, in the order given, one blank line apart. */
export function threadTodosMarkdown(todos: readonly ThreadTodo[]): string {
  return todos.map((todo) => threadTodoMarkdown(todo)).join("\n\n");
}

function reviewItemMarkdown(item: ThreadReviewItem): string {
  const priority = typeof item.priority === "number" ? `P${item.priority} ` : "";
  if (item.status === "dismissed") return `- [x] ~~${priority}${item.title}~~ (declined)`;
  return `- [${item.status === "addressed" ? "x" : " "}] ${priority}${item.title}`;
}
