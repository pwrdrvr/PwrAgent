import type {
  RunThreadTodoActionRequest,
  ThreadTodo,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoResolution,
  ThreadTodoStatus,
} from "@pwragent/shared";

/** A connected federation peer that can host a handoff thread. */
export type ThreadTodoInstance = {
  instanceId: string;
  label: string;
};

export type ThreadTodoRunOptions = Omit<RunThreadTodoActionRequest, "id">;

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
  /** What a merge card's button does, per project. */
  mergeMethods?: ThreadTodoMergeMethodPreferences;
  /** Peers a handoff can start on. Empty without federation. */
  instances: ThreadTodoInstance[];
  /** Name of the thread a card belongs to. */
  threadTitle: (todo: ThreadTodo) => string;
  resolve: (
    todo: ThreadTodo,
    status: ThreadTodoStatus,
    resolution?: ThreadTodoResolution,
  ) => Promise<ThreadTodo | undefined>;
  /** Runs a merge or handoff; resolves to the card as it ended. */
  run: (
    todo: ThreadTodo,
    options?: ThreadTodoRunOptions,
  ) => Promise<ThreadTodo | undefined>;
  /** Shows the card's own thread. */
  openThread: (todo: ThreadTodo) => void;
  /** Shows a thread a handoff card started. */
  openStartedThread: (todo: ThreadTodo) => void;
  /** Resolved cards, newest first. */
  listResolved?: () => Promise<ThreadTodo[]>;
};
