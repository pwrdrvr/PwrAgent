import { THREAD_TODO_TITLE_MAX_LENGTH } from "@pwragent/shared";

/**
 * A thread started from a to-do card gets that card's plain steps as its own
 * card with this key. The card is the thread's milestone checklist: the
 * operator watches it fill in, and the thread can tick, restate or resolve
 * it, because the card is its own. It does not replace a provider's own plan
 * tool, which the thread may use or not as it likes.
 */
export const THREAD_TODO_PLAN_KEY = "plan";

export const THREAD_TODO_PLAN_DETAIL =
  "The plan this thread was started with. Its steps are ticked as they are finished.";

/** A start_thread card's plain steps, and the title the plan card is named for. */
export type ThreadTodoPlan = {
  title: string;
  items: string[];
};

export function threadTodoPlanTitle(title: string): string {
  const full = `Plan: ${title.trim()}`;
  return full.length <= THREAD_TODO_TITLE_MAX_LENGTH
    ? full
    : `${full.slice(0, THREAD_TODO_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * The one line a started thread's first message gains, and only once its
 * plan card exists. The thread reads the step ids from list_todos.
 */
export const THREAD_TODO_PLAN_PROMPT_NOTE =
  `This task's steps are a to-do card on this thread with the key "${THREAD_TODO_PLAN_KEY}". `
  + `As you finish each step, tick it with update_todo (key "${THREAD_TODO_PLAN_KEY}", check with the step's id from list_todos).`;

export function withThreadTodoPlanNote(prompt: string): string {
  return `${prompt.trimEnd()}\n\n${THREAD_TODO_PLAN_PROMPT_NOTE}`;
}
