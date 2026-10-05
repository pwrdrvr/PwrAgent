import {
  useEffect,
  useId,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
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

export type ThreadTodoScope = "thread" | "project" | "all";

const SCOPES: Array<{ id: ThreadTodoScope; label: string }> = [
  { id: "thread", label: "Thread" },
  { id: "project", label: "Project" },
  { id: "all", label: "All" },
];

const KIND_ICONS: Record<ThreadTodoKind, ComponentType<IconProps> | undefined> = {
  reminder: undefined,
  review: ReviewIcon,
  merge: MergeIcon,
  handoff: HandoffIcon,
};

const NO_PROJECT_KEY = "";

/**
 * The lens the operator last picked. Module scope, so switching threads
 * keeps it; a reload starts again from Project.
 */
let rememberedScope: ThreadTodoScope = "project";

type TodoGroup = {
  key: string;
  title: string;
  todos: ThreadTodo[];
};

export type ThreadTodosPanelProps = {
  view: ThreadTodosView;
  /** `backend:threadId` of the thread on screen. */
  threadKey: string;
  /** Directory key of that thread's project, when it has one. */
  projectKey?: string;
  onStartReview: (todo: ThreadTodo) => void;
  onDoHere?: (todo: ThreadTodo) => void;
};

/**
 * To-dos under three lenses: this thread, this project, and every thread.
 * A card for another project shows in both projects' lens. This thread's
 * open cards render whole, with their actions; every other card is a row
 * that opens its thread.
 */
export function ThreadTodosPanel(props: ThreadTodosPanelProps) {
  const { view, threadKey, projectKey } = props;
  const [scope, setScopeState] = useState<ThreadTodoScope>(rememberedScope);
  const [showResolved, setShowResolved] = useState(false);
  const [resolved, setResolved] = useState<ThreadTodo[]>();
  const controlId = useId();
  const listResolved = view.listResolved;
  const scopes = projectKey ? SCOPES : SCOPES.filter((entry) => entry.id !== "project");
  const activeScope = scope === "project" && !projectKey ? "thread" : scope;
  const setScope = (next: ThreadTodoScope): void => {
    rememberedScope = next;
    setScopeState(next);
  };

  useEffect(() => {
    if (!showResolved || !listResolved) return;
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
  }, [showResolved, listResolved, view.revision]);

  const inScope = (todo: ThreadTodo, lens: ThreadTodoScope): boolean => {
    switch (lens) {
      case "thread":
        return buildThreadIdentityKey(todo.backend, todo.threadId) === threadKey;
      case "project":
        return projectKey !== undefined
          && (todo.sourceProject?.key === projectKey
            || todo.targetProject?.key === projectKey);
      case "all":
        return true;
    }
  };
  const source = showResolved ? resolved : view.open;
  const todos = source?.filter((todo) => inScope(todo, activeScope));
  const groups = todos ? groupTodos(todos, activeScope, props) : undefined;

  const handleScopeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = scopes.findIndex((entry) => entry.id === activeScope);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = scopes[(index + step + scopes.length) % scopes.length]!.id;
    setScope(next);
    document.getElementById(`${controlId}-${next}`)?.focus();
  };

  const emptyText = showResolved
    ? "No resolved to-dos."
    : activeScope === "thread"
      ? "No to-dos for this thread."
      : activeScope === "project"
        ? "No to-dos for this project."
        : "Nothing to do.";

  return (
    <section className="context-panel__section thread-todos-panel">
      <h3>To-dos</h3>
      <div className="thread-todos-panel__controls">
        <div
          aria-label="To-do scope"
          aria-orientation="horizontal"
          className="subagent-lens-switch"
          role="tablist"
          onKeyDown={handleScopeKeyDown}
        >
          {scopes.map((entry) => (
            <button
              aria-controls={`${controlId}-panel`}
              aria-selected={activeScope === entry.id}
              className="subagent-lens-switch__button"
              id={`${controlId}-${entry.id}`}
              key={entry.id}
              role="tab"
              tabIndex={activeScope === entry.id ? 0 : -1}
              type="button"
              onClick={() => setScope(entry.id)}
            >
              <span>{entry.label}</span>
              <span className="subagent-lens-switch__count">
                {view.open.filter((todo) => inScope(todo, entry.id)).length}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`thread-todos-panel__resolved-toggle${showResolved ? " is-active" : ""}`}
          aria-pressed={showResolved}
          onClick={() => setShowResolved((current) => !current)}
        >
          Resolved
        </button>
      </div>
      <div
        aria-labelledby={`${controlId}-${activeScope}`}
        id={`${controlId}-panel`}
        role="tabpanel"
      >
        {!groups ? (
          <p className="context-empty">Loading to-dos…</p>
        ) : groups.length === 0 ? (
          <p className="context-empty">{emptyText}</p>
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
                {group.todos.map((todo) => {
                  const mine = buildThreadIdentityKey(todo.backend, todo.threadId) === threadKey;
                  return (
                    <li key={todo.id}>
                      {mine && todo.status === "open" ? (
                        <ThreadTodoCard
                          todo={todo}
                          running={view.runningIds.has(todo.id)}
                          mergeMethods={view.mergeMethods}
                          instances={view.instances}
                          onResolve={(target, status, resolution) => {
                            void view.resolve(target, status, resolution).catch((error: unknown) => {
                              console.warn("Resolving a to-do failed.", error);
                            });
                          }}
                          onRun={(target, options) => {
                            void view.run(target, options).catch((error: unknown) => {
                              console.warn("Running a to-do failed.", error);
                            });
                          }}
                          onStartReview={props.onStartReview}
                          onDoHere={props.onDoHere}
                        />
                      ) : (
                        <TodoRow
                          todo={todo}
                          current={mine}
                          scope={activeScope}
                          projectKey={projectKey}
                          view={view}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </section>
  );
}

function TodoRow(props: {
  todo: ThreadTodo;
  current: boolean;
  scope: ThreadTodoScope;
  projectKey?: string;
  view: ThreadTodosView;
}) {
  const { todo, view } = props;
  const KindIcon = KIND_ICONS[todo.kind];
  const resolution = todo.status === "open"
    ? undefined
    : todo.result ?? (todo.status === "done" ? "Done" : "Dismissed");
  const route = describeRoute(todo, props.scope, props.projectKey);
  // Grouped by project, the thread is not in the heading: say it here.
  const threadName = props.scope === "all" && !props.current ? view.threadTitle(todo) : undefined;
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
  const meta = [threadName, route].filter(Boolean).join(" · ");
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
      {meta ? <p className="thread-todos-panel__row-route">{meta}</p> : null}
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
          {!todo.startedThread && !todo.result ? (
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

/**
 * Where a card came from and where it points, in the words of the lens it
 * shows in. In Project, the project is given, so only the other end is
 * named. In All, both ends are.
 */
function describeRoute(
  todo: ThreadTodo,
  scope: ThreadTodoScope,
  projectKey: string | undefined,
): string | undefined {
  const target = todo.targetProject;
  if (!target) return undefined;
  const source = todo.sourceProject;
  if (scope === "project") {
    return target.key === projectKey
      ? source ? `From ${source.label}` : undefined
      : `For ${target.label}`;
  }
  return source ? `${source.label} → ${target.label}` : `For ${target.label}`;
}

function groupTodos(
  todos: ThreadTodo[],
  scope: ThreadTodoScope,
  props: ThreadTodosPanelProps,
): TodoGroup[] {
  const groups = new Map<string, TodoGroup>();
  for (const todo of todos) {
    // All groups by the project a card came from; the narrower lenses by
    // thread, since one project's threads are what the operator moves between.
    const key = scope === "all"
      ? todo.sourceProject?.key ?? NO_PROJECT_KEY
      : buildThreadIdentityKey(todo.backend, todo.threadId);
    const title = scope === "all"
      ? todo.sourceProject?.label ?? "No project"
      : props.view.threadTitle(todo);
    const group = groups.get(key);
    if (group) group.todos.push(todo);
    else groups.set(key, { key, title, todos: [todo] });
  }
  const first = scope === "all" ? props.projectKey : props.threadKey;
  const ordered = [...groups.values()];
  const current = ordered.findIndex((group) => group.key === first);
  if (current > 0) {
    ordered.unshift(...ordered.splice(current, 1));
  }
  return ordered;
}
