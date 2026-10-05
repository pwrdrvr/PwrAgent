import type { ThreadTodo, ThreadTodoStatus } from "@pwragent/shared";

/**
 * Everything ThreadView's to-do surfaces read, built once in App. The stack
 * and the rail panel share it, so both resolve and run cards the same way.
 */
export type ThreadTodosView = {
  /** Open cards across every thread, newest first. */
  open: ThreadTodo[];
  /** Open cards per `backend:threadId`, newest first. */
  openByThreadKey: ReadonlyMap<string, ThreadTodo[]>;
  /** Bumps on every change, so a resolved list can refetch. */
  revision: number;
  runningIds: ReadonlySet<string>;
  /** Name of the thread a card belongs to. */
  threadTitle: (todo: ThreadTodo) => string;
  resolve: (
    todo: ThreadTodo,
    status: ThreadTodoStatus,
  ) => Promise<ThreadTodo | undefined>;
  /** Runs a merge or handoff; resolves to the card as it ended. */
  run: (todo: ThreadTodo) => Promise<ThreadTodo | undefined>;
  /** Shows the card's own thread. */
  openThread: (todo: ThreadTodo) => void;
  /** Shows a thread a handoff card started. */
  openStartedThread: (todo: ThreadTodo) => void;
  /** Resolved cards, newest first. */
  listResolved?: () => Promise<ThreadTodo[]>;
};
