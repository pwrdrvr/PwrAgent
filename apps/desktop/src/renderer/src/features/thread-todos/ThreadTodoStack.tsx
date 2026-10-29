import { useEffect, useRef, useState } from "react";
import type { ThreadTodo, ThreadTodoResolution } from "@pwragent/shared";
import { threadTodoItemProgress } from "@pwragent/shared";
import { TodoIcon } from "../../icons";
import { ThreadTodoCard } from "./ThreadTodoCard";
import { consumeThreadTodoReveal, type ThreadTodoRevealRequest } from "./thread-todo-reveal";
import type {
  ThreadTodoDoHereOptions,
  ThreadTodoResolveOptions,
  ThreadTodoRunOptions,
  ThreadTodosView,
} from "./thread-todos-view";

const RESOLVED_NOTICE_MS = 4_000;

/**
 * The ids each thread showed when the operator collapsed its stack. The
 * stack stays collapsed for that thread until a card outside the set
 * arrives. Module scope, so switching threads and back keeps the choice;
 * a reload forgets it, which re-expands at most once.
 */
const collapsedIdsByThreadKey = new Map<string, ReadonlySet<string>>();

type ResolvedNotice = {
  todo: ThreadTodo;
  text: string;
  /** False for an action that ran: a merge or a started thread stays done. */
  undoable: boolean;
};

export type ThreadTodoStackProps = {
  threadKey: string;
  /** Open cards for this thread, newest first. */
  todos: ThreadTodo[];
  view: ThreadTodosView;
  threadRunning?: boolean;
  onStartReview: (todo: ThreadTodo, options?: ThreadTodoResolveOptions) => void;
  /**
   * Sends a handoff's prompt, or the given one, to this thread as a reply.
   * Resolves false when the composer would not take it.
   */
  onDoHere?: (todo: ThreadTodo, options?: ThreadTodoDoHereOptions) => Promise<boolean>;
  /** Moves the stack below the find bar while it is open. */
  findOpen?: boolean;
  /** A thread row's to-do chip asked to show this thread's cards. */
  revealRequest?: ThreadTodoRevealRequest;
};

/**
 * The focused thread's open to-dos, as one card with a pager, in the top
 * right of the transcript. It pages like the notice toast; collapsing it
 * leaves a count chip in the same corner.
 */
export function ThreadTodoStack(props: ThreadTodoStackProps) {
  const { todos, threadKey, view } = props;
  const [selectedId, setSelectedId] = useState<string>();
  const [, setCollapseVersion] = useState(0);
  const [notice, setNotice] = useState<ResolvedNotice>();
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(noticeTimerRef.current), []);
  useEffect(() => {
    clearTimeout(noticeTimerRef.current);
    setNotice(undefined);
    setSelectedId(undefined);
  }, [threadKey]);
  // After the thread-change reset above, so the reveal is not undone.
  const revealRequest = props.revealRequest;
  useEffect(() => {
    if (!consumeThreadTodoReveal(revealRequest, threadKey)) return;
    if (collapsedIdsByThreadKey.delete(threadKey)) {
      setCollapseVersion((current) => current + 1);
    }
  }, [revealRequest, threadKey]);

  const collapsedIds = collapsedIdsByThreadKey.get(threadKey);
  const collapsed = collapsedIds !== undefined
    && todos.every((todo) => collapsedIds.has(todo.id));
  // Forget a collapse a new card has overridden, so the next collapse
  // starts from the cards on screen then.
  if (collapsedIds && !collapsed) {
    collapsedIdsByThreadKey.delete(threadKey);
  }

  const selectedIndex = Math.max(
    0,
    todos.findIndex((todo) => todo.id === selectedId),
  );
  const todo = todos[selectedIndex];

  if (!todo && !notice) return null;

  const showNotice = (next: ResolvedNotice): void => {
    clearTimeout(noticeTimerRef.current);
    setNotice(next);
    noticeTimerRef.current = setTimeout(
      () => setNotice(undefined),
      RESOLVED_NOTICE_MS,
    );
  };
  const resolve = (
    target: ThreadTodo,
    status: "done" | "dismissed",
    resolution?: ThreadTodoResolution,
    options?: ThreadTodoResolveOptions,
  ): void => {
    void view.resolve(target, status, resolution, options).then((resolved) => {
      if (resolved) {
        showNotice({
          todo: resolved,
          text: resolved.result ?? (status === "done" ? "Marked done" : "Dismissed"),
          undoable: true,
        });
      }
    }).catch((error: unknown) => {
      showNotice({ todo: target, text: String(error), undoable: false });
    });
  };
  const run = (target: ThreadTodo, options?: ThreadTodoRunOptions): void => {
    void view.run(target, options).then((ended) => {
      if (ended?.status === "done" && ended.result) {
        showNotice({ todo: ended, text: ended.result, undoable: false });
      }
    }).catch((error: unknown) => {
      showNotice({ todo: target, text: String(error), undoable: false });
    });
  };
  const onDoHere = props.onDoHere;
  const doHere = onDoHere
    ? async (target: ThreadTodo, options?: ThreadTodoDoHereOptions): Promise<boolean> => {
        try {
          const sent = await onDoHere(target, options);
          if (!sent) showNotice({ todo: target, text: "The composer is busy. Try again once it is free.", undoable: false });
          return sent;
        } catch (error) {
          showNotice({ todo: target, text: String(error), undoable: false });
          return false;
        }
      }
    : undefined;
  const className = `thread-todo-stack${props.findOpen ? " is-below-find" : ""}`;

  if (collapsed && todo) {
    const count = todos.length;
    // A lone collapsed card keeps its checklist progress in view; across
    // several cards one fraction would not say whose it is.
    const progress = count === 1 ? threadTodoItemProgress(todo) : undefined;
    return (
      <div className={className}>
        <button
          type="button"
          className="thread-todo-stack__chip"
          aria-expanded={false}
          aria-label={`Show to-dos: ${count} open${
            progress ? `, ${progress.checked} of ${progress.total} steps checked` : ""
          }`}
          onClick={() => {
            collapsedIdsByThreadKey.delete(threadKey);
            setCollapseVersion((current) => current + 1);
          }}
        >
          <TodoIcon size={13} />
          <span className="thread-todo-stack__chip-count">{count}</span>
          <span className="thread-todo-stack__chip-label">
            {count === 1 ? "to-do" : "to-dos"}
          </span>
          {progress ? (
            <span className="thread-todo-stack__chip-progress">
              {progress.checked} of {progress.total}
            </span>
          ) : null}
        </button>
      </div>
    );
  }

  return (
    <section className={className} aria-label="To-dos for this thread">
      {todo ? (
        <div
          className="thread-todo-stack__deck"
          data-depth={Math.min(todos.length - 1, 2)}
        >
          <ThreadTodoCard
            key={todo.id}
            todo={todo}
            running={view.runningIds.has(todo.id)}
            threadRunning={props.threadRunning}
            copyAllTodos={todos}
            pager={{
              position: selectedIndex + 1,
              total: todos.length,
              onPrevious: () => setSelectedId(todos[selectedIndex - 1]?.id),
              onNext: () => setSelectedId(todos[selectedIndex + 1]?.id),
            }}
            onCollapse={() => {
              collapsedIdsByThreadKey.set(
                threadKey,
                new Set(todos.map((entry) => entry.id)),
              );
              setCollapseVersion((current) => current + 1);
            }}
            mergeMethods={view.mergeMethods}
            instances={view.instances}
            localMachine={view.localMachine}
            projectMenu={view.projectMenu}
            onResolve={resolve}
            onRun={run}
            onStartReview={props.onStartReview}
            onDoHere={doHere}
            onSetItemChecked={(target, item, checked) => {
              void view.setItemChecked(target, item.id, checked).catch((error: unknown) => {
                showNotice({ todo: target, text: String(error), undoable: false });
              });
            }}
          />
        </div>
      ) : null}
      {notice ? (
        <div className="thread-todo-stack__notice" role="status">
          <span className="thread-todo-stack__notice-text">{notice.text}</span>
          {notice.todo.startedThread ? (
            <button
              type="button"
              className="thread-todo-stack__notice-button"
              onClick={() => view.openStartedThread(notice.todo)}
            >
              Open thread
            </button>
          ) : notice.undoable ? (
            <button
              type="button"
              className="thread-todo-stack__notice-button"
              onClick={() => {
                clearTimeout(noticeTimerRef.current);
                setNotice(undefined);
                setSelectedId(notice.todo.id);
                void view.resolve(notice.todo, "open").catch(
                  (error: unknown) => {
                    showNotice({ todo: notice.todo, text: String(error), undoable: false });
                  },
                );
              }}
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
