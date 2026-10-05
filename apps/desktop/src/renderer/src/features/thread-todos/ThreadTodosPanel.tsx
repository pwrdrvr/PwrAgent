import { useEffect, useId, useState, type ComponentType, type KeyboardEvent } from "react";
import type { ThreadTodo, ThreadTodoKind } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import {
  HandoffIcon,
  MergeIcon,
  ReviewIcon,
  type IconProps,
} from "../../icons";
import { ThreadTodoCard, formatTodoAge } from "./ThreadTodoCard";
import type { ThreadTodosView } from "./thread-todos-view";

type TodoFilter = "open" | "resolved";

const FILTERS: Array<{ id: TodoFilter; label: string }> = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
];

const KIND_ICONS: Record<ThreadTodoKind, ComponentType<IconProps> | undefined> = {
  reminder: undefined,
  review: ReviewIcon,
  merge: MergeIcon,
  handoff: HandoffIcon,
};

type TodoGroup = {
  key: string;
  title: string;
  todos: ThreadTodo[];
};

export type ThreadTodosPanelProps = {
  view: ThreadTodosView;
  /** `backend:threadId` of the thread on screen; its group comes first. */
  threadKey: string;
  onStartReview: (todo: ThreadTodo) => void;
};

/**
 * Every thread's to-dos, grouped by thread with this thread first. This
 * thread's cards render whole, with their actions; another thread's are
 * rows that open that thread.
 */
export function ThreadTodosPanel(props: ThreadTodosPanelProps) {
  const { view, threadKey } = props;
  const [filter, setFilter] = useState<TodoFilter>("open");
  const [resolved, setResolved] = useState<ThreadTodo[]>();
  const controlId = useId();
  const listResolved = view.listResolved;

  useEffect(() => {
    if (filter !== "resolved" || !listResolved) return;
    let cancelled = false;
    void listResolved().then((todos) => {
      if (!cancelled) setResolved(todos);
    }).catch((error: unknown) => {
      console.warn("Loading resolved to-dos failed.", error);
      if (!cancelled) setResolved([]);
    });
    return () => {
      cancelled = true;
    };
  }, [filter, listResolved, view.revision]);

  const todos = filter === "open" ? view.open : resolved;
  const groups = todos ? groupByThread(todos, threadKey, view) : undefined;

  const handleFilterKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = filter === "open" ? "resolved" : "open";
    setFilter(next);
    document.getElementById(`${controlId}-${next}`)?.focus();
  };

  return (
    <section className="context-panel__section thread-todos-panel">
      <h3>To-dos</h3>
      <div
        aria-label="To-do status"
        aria-orientation="horizontal"
        className="subagent-lens-switch"
        role="tablist"
        onKeyDown={handleFilterKeyDown}
      >
        {FILTERS.map((entry) => (
          <button
            aria-controls={`${controlId}-panel`}
            aria-selected={filter === entry.id}
            className="subagent-lens-switch__button"
            id={`${controlId}-${entry.id}`}
            key={entry.id}
            role="tab"
            tabIndex={filter === entry.id ? 0 : -1}
            type="button"
            onClick={() => setFilter(entry.id)}
          >
            <span>{entry.label}</span>
            {entry.id === "open" ? (
              <span className="subagent-lens-switch__count">{view.open.length}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${controlId}-${filter}`}
        id={`${controlId}-panel`}
        role="tabpanel"
      >
        {!groups ? (
          <p className="context-empty">Loading to-dos…</p>
        ) : groups.length === 0 ? (
          <p className="context-empty">
            {filter === "open" ? "Nothing to do." : "No resolved to-dos."}
          </p>
        ) : (
          groups.map((group) => (
            <section
              key={group.key}
              className="thread-todos-panel__group"
              aria-label={group.title}
            >
              <h4 className="thread-todos-panel__group-title">
                <span className="thread-todos-panel__group-name">{group.title}</span>
                <span className="thread-todos-panel__group-count">{group.todos.length}</span>
              </h4>
              <ul className="thread-todos-panel__list">
                {group.todos.map((todo) => (
                  <li key={todo.id}>
                    {filter === "open" && group.key === threadKey ? (
                      <ThreadTodoCard
                        todo={todo}
                        running={view.runningIds.has(todo.id)}
                        onResolve={(target, status) => {
                          void view.resolve(target, status).catch((error: unknown) => {
                            console.warn("Resolving a to-do failed.", error);
                          });
                        }}
                        onRun={(target) => {
                          void view.run(target).catch((error: unknown) => {
                            console.warn("Running a to-do failed.", error);
                          });
                        }}
                        onStartReview={props.onStartReview}
                      />
                    ) : (
                      <TodoRow
                        todo={todo}
                        current={group.key === threadKey}
                        view={view}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </section>
  );
}

function TodoRow(props: { todo: ThreadTodo; current: boolean; view: ThreadTodosView }) {
  const { todo, view } = props;
  const KindIcon = KIND_ICONS[todo.kind];
  const resolution = todo.status === "open"
    ? undefined
    : todo.result ?? (todo.status === "done" ? "Done" : "Dismissed");
  const main = (
    <>
      <span className="thread-todo-card__kind" aria-hidden="true">
        {KindIcon ? <KindIcon size={13} /> : <span className="thread-todo-card__ring" />}
      </span>
      <span className="thread-todos-panel__row-title">{todo.title}</span>
      <span className="thread-todo-card__age">
        {formatTodoAge(todo.resolvedAt ?? todo.createdAt)}
      </span>
    </>
  );
  return (
    <div className="thread-todos-panel__row" data-status={todo.status}>
      {props.current ? (
        <div className="thread-todos-panel__row-main">{main}</div>
      ) : (
        <button
          type="button"
          className="thread-todos-panel__row-main"
          aria-label={`Open thread: ${todo.title}, in ${view.threadTitle(todo)}`}
          onClick={() => view.openThread(todo)}
        >
          {main}
        </button>
      )}
      {resolution ? (
        <p className="thread-todos-panel__row-meta">
          <span>{resolution}</span>
          {todo.startedThread ? (
            <button
              type="button"
              className="thread-todos-panel__row-link"
              onClick={() => view.openStartedThread(todo)}
            >
              Open thread
            </button>
          ) : null}
          {!todo.result ? (
            <button
              type="button"
              className="thread-todos-panel__row-link"
              onClick={() => {
                void view.resolve(todo, "open").catch((error: unknown) => {
                  console.warn("Reopening a to-do failed.", error);
                });
              }}
            >
              Reopen
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function groupByThread(
  todos: ThreadTodo[],
  threadKey: string,
  view: ThreadTodosView,
): TodoGroup[] {
  const groups = new Map<string, TodoGroup>();
  for (const todo of todos) {
    const key = buildThreadIdentityKey(todo.backend, todo.threadId);
    const group = groups.get(key);
    if (group) group.todos.push(todo);
    else groups.set(key, { key, title: view.threadTitle(todo), todos: [todo] });
  }
  const ordered = [...groups.values()];
  const current = ordered.findIndex((group) => group.key === threadKey);
  if (current > 0) {
    ordered.unshift(...ordered.splice(current, 1));
  }
  return ordered;
}
