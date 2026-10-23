import type {
  ResolveThreadTodoRequest,
  RunThreadTodoActionRequest,
  SubmitServerRequestRequest,
  ThreadTodo,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoProject,
  ThreadTodoResolution,
  ThreadTodoStatus,
} from "@pwragent/shared";
import type { OperatorWait } from "../operator-requests/operator-waits";
import type { OperatorQuestionTarget } from "../operator-requests/useOperatorRequests";

/** A connected federation peer that can host a handoff thread. */
export type ThreadTodoInstance = {
  instanceId: string;
  label: string;
};

export type ThreadTodoRunOptions = Omit<RunThreadTodoActionRequest, "id">;

/** `allowOpenItems` completes a card done although steps are unchecked. */
export type ThreadTodoResolveOptions = Pick<ResolveThreadTodoRequest, "allowOpenItems">;
/**
 * "Do it here" on a card: the resolve options, plus the reply a review card
 * sends in place of a hand-off's prompt. A card that sends its own prompt
 * stays open; the reply's work settles it.
 */
export type ThreadTodoDoHereOptions = ThreadTodoResolveOptions & { prompt?: string };

/** What a card's project menu reads and writes. */
export type ThreadTodoProjectMenu = {
  /** The projects a card can be for, fetched as the menu opens. */
  list: (todo: ThreadTodo) => Promise<ThreadTodoProject[]>;
  /** `null` returns the card to its thread's project. */
  set: (todo: ThreadTodo, projectKey: string | null) => Promise<ThreadTodo | undefined>;
};

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
  /** The cards' project menu. Absent where a card's project cannot change. */
  projectMenu?: ThreadTodoProjectMenu;
  /** Name of the thread a card belongs to. */
  threadTitle: (todo: ThreadTodo) => string;
  resolve: (
    todo: ThreadTodo,
    status: ThreadTodoStatus,
    resolution?: ThreadTodoResolution,
    options?: ThreadTodoResolveOptions,
  ) => Promise<ThreadTodo | undefined>;
  /** Ticks or unticks one step of the card's checklist. */
  setItemChecked: (
    todo: ThreadTodo,
    itemId: string,
    checked: boolean,
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
  /** What threads are waiting on the operator for, most urgent first. */
  queueError?: string;
  waits: OperatorWait[];
  waitsByThreadKey: ReadonlyMap<string, OperatorWait[]>;
  /** Item keys the operator has had on screen: waits and cards. */
  seenKeys: ReadonlySet<string>;
  markSeen: (keys: readonly string[]) => void;
  /** Answers a wait's server request from its row. */
  respond: (
    wait: OperatorWait,
    response: SubmitServerRequestRequest["response"],
  ) => Promise<void>;
  dismissQuestion: (target: OperatorQuestionTarget) => Promise<void>;
  /** Question item keys this window dismissed, so open cards fold too. */
  dismissedQuestionKeys: ReadonlySet<string>;
  /** Shows the wait's thread, scrolled to a question's card. */
  openWait: (wait: OperatorWait) => void;
  /**
   * Answers a question in a thread no composer shows. Resolves true once the
   * thread's owner took the reply, and throws the owner's refusal.
   */
  answerQuestion?: (wait: OperatorWait, text: string) => Promise<boolean>;
  /** Answers `answerQuestion` sent, by `backend:threadId` NUL question item id. */
  sentQuestionAnswers?: ReadonlyMap<string, string>;
  /** Name of a thread, by `backend:threadId`. */
  threadTitleForKey: (threadKey: string) => string;
  /** The project a thread belongs to, by `backend:threadId`. */
  threadProjectForKey: (threadKey: string) => { key: string; label: string } | undefined;
};
