import { useEffect, useRef, useState } from "react";
import type { ThreadTodo } from "@pwragent/shared";
import { TodoIcon } from "../../icons";
import { ThreadTodoCard } from "./ThreadTodoCard";
import type { ThreadTodosView } from "./thread-todos-view";

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
};

export type ThreadTodoStackProps = {
  threadKey: string;
  /** Open cards for this thread, newest first. */
  todos: ThreadTodo[];
  view: ThreadTodosView;
  onStartReview: (todo: ThreadTodo) => void;
  /** Moves the stack below the find bar while it is open. */
  findOpen?: boolean;
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
  const resolve = (target: ThreadTodo, status: "done" | "dismissed"): void => {
    void view.resolve(target, status).then((resolved) => {
      if (resolved) {
        showNotice({
          todo: resolved,
          text: status === "done" ? "Marked done" : "Dismissed",
        });
      }
    }).catch((error: unknown) => {
      console.warn("Resolving a to-do failed.", error);
    });
  };
  const run = (target: ThreadTodo): void => {
    void view.run(target).then((ended) => {
      if (ended?.status === "done" && ended.result) {
        showNotice({ todo: ended, text: ended.result });
      }
    }).catch((error: unknown) => {
      console.warn("Running a to-do failed.", error);
    });
  };
  const className = `thread-todo-stack${props.findOpen ? " is-below-find" : ""}`;

  if (collapsed && todo) {
    const count = todos.length;
    return (
      <div className={className}>
        <button
          type="button"
          className="thread-todo-stack__chip"
          aria-expanded={false}
          aria-label={`Show to-dos: ${count} open`}
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
            onResolve={resolve}
            onRun={run}
            onStartReview={props.onStartReview}
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
          ) : notice.todo.status !== "open" && !notice.todo.result ? (
            <button
              type="button"
              className="thread-todo-stack__notice-button"
              onClick={() => {
                clearTimeout(noticeTimerRef.current);
                setNotice(undefined);
                setSelectedId(notice.todo.id);
                void view.resolve(notice.todo, "open").catch(
                  (error: unknown) => {
                    console.warn("Reopening a to-do failed.", error);
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
