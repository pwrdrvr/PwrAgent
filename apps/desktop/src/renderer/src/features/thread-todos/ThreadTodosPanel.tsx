import {
  useEffect,
  useId,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import type { ThreadTodo, ThreadTodoKind } from "@pwragent/shared";
import {
  THREAD_TODO_RESOLUTION_RESULTS,
  buildThreadIdentityKey,
  operatorTodoItemKey,
} from "@pwragent/shared";
import {
  HandoffIcon,
  MergeIcon,
  ReviewIcon,
  type IconProps,
} from "../../icons";
import { OperatorWaitRow } from "../operator-requests/OperatorWaitRow";
import { isBlockingWait, type OperatorWait } from "../operator-requests/operator-waits";
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

/** Results an operator's own resolve wrote; those can be taken back. */
const RESOLUTION_RESULTS: ReadonlySet<string> = new Set(
  Object.values(THREAD_TODO_RESOLUTION_RESULTS),
);

/**
 * The lens the operator last picked. Module scope, so switching threads
 * keeps it; a reload starts again from Project.
 */
let rememberedScope: ThreadTodoScope = "project";

/** A row in the panel: something a thread waits on, or a to-do card. */
type PanelItem =
  | { type: "wait"; key: string; wait: OperatorWait }
  | { type: "todo"; key: string; todo: ThreadTodo };

type TodoGroup = {
  key: string;
  title: string;
  items: PanelItem[];
  /** A wait in the group pauses a turn. */
  paused: boolean;
};

export type ThreadTodosPanelProps = {
  view: ThreadTodosView;
  /** `backend:threadId` of the thread on screen. */
  threadKey: string;
  /** Directory key of that thread's project, when it has one. */
  projectKey?: string;
  onStartReview: (todo: ThreadTodo) => void;
  onDoHere?: (todo: ThreadTodo) => void | Promise<unknown>;
};

/**
 * To-dos under three lenses: this thread, this project, and every thread.
 * A card for another project shows in both projects' lens. This thread's
 * open cards render whole, with their actions; every other card is a row
 * that opens its thread.
 *
 * What threads are waiting on (approvals, MCP input, questionnaires, async
 * questions) lists first in each group, most urgent first. Each lens counts
 * its open items and, in a filled pill, the ones not yet seen. Rows on screen
 * in a focused window are marked seen; the cookie stays on a row for as long
 * as the panel is open, so the operator can still tell what was new.
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

  const threadProjectForKey = view.threadProjectForKey;
  const todoInScope = (todo: ThreadTodo, lens: ThreadTodoScope): boolean => {
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
  const waitInScope = (wait: OperatorWait, lens: ThreadTodoScope): boolean => {
    switch (lens) {
      case "thread":
        return wait.threadKey === threadKey;
      case "project":
        return projectKey !== undefined
          && threadProjectForKey(wait.threadKey)?.key === projectKey;
      case "all":
        return true;
    }
  };
  const openItemsIn = (lens: ThreadTodoScope): PanelItem[] => [
    ...view.waits
      .filter((wait) => waitInScope(wait, lens))
      .map((wait): PanelItem => ({ type: "wait", key: wait.key, wait })),
    ...view.open
      .filter((todo) => todoInScope(todo, lens))
      .map((todo): PanelItem => ({ type: "todo", key: operatorTodoItemKey(todo.id), todo })),
  ];
  const items: PanelItem[] | undefined = showResolved
    ? resolved
      ?.filter((todo) => todoInScope(todo, activeScope))
      .map((todo) => ({ type: "todo", key: operatorTodoItemKey(todo.id), todo }))
    : openItemsIn(activeScope);
  const groups = items ? groupItems(items, activeScope, props) : undefined;

  // Rows on screen in a focused window are seen. The panel is mounted only
  // while the rail shows it, so being rendered here is being on screen.
  const unseenKeys = showResolved || !items
    ? []
    : items.filter((item) => !view.seenKeys.has(item.key)).map((item) => item.key);
  const unseenSignature = unseenKeys.join("\n");
  const [freshKeys, setFreshKeys] = useState<ReadonlySet<string>>(() => new Set());
  const markSeen = view.markSeen;
  useEffect(() => {
    if (!unseenSignature) return;
    const keys = unseenSignature.split("\n");
    const mark = (): void => {
      if (!document.hasFocus()) return;
      setFreshKeys((current) =>
        keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys]));
      markSeen(keys);
    };
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [unseenSignature, markSeen]);
  const isUnread = (key: string): boolean => !view.seenKeys.has(key) || freshKeys.has(key);

  const handleScopeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = scopes.findIndex((entry) => entry.id === activeScope);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = scopes[(index + step + scopes.length) % scopes.length]!.id;
    setScope(next);
    document.getElementById(`${controlId}-${next}`)?.focus();
  };

  const lensCounts = Object.fromEntries(SCOPES.map((entry) => {
    const lensItems = openItemsIn(entry.id);
    return [entry.id, {
      open: lensItems.length,
      unread: lensItems.filter((item) => !view.seenKeys.has(item.key)).length,
    }];
  })) as Record<ThreadTodoScope, { open: number; unread: number }>;

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
              aria-label={`${entry.label}, ${lensCounts[entry.id].open} open${
                lensCounts[entry.id].unread > 0 ? `, ${lensCounts[entry.id].unread} unread` : ""
              }`}
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
              {/* Filled when something is unread, plain otherwise, as on the
                  rail tab: the rail is too narrow for both counts. */}
              {lensCounts[entry.id].unread > 0 ? (
                <span className="thread-todos-panel__unread-count">
                  {lensCounts[entry.id].unread}
                </span>
              ) : (
                <span className="subagent-lens-switch__count">{lensCounts[entry.id].open}</span>
              )}
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
                <span className="thread-todos-panel__group-count">{group.items.length}</span>
                {group.paused ? (
                  <span className="thread-todos-panel__group-paused">turn paused</span>
                ) : null}
              </h4>
              <ul className="thread-todos-panel__list">
                {group.items.map((item) => {
                  if (item.type === "wait") {
                    const { wait } = item;
                    const mine = wait.threadKey === threadKey;
                    return (
                      <li key={item.key}>
                        <OperatorWaitRow
                          wait={wait}
                          current={mine}
                          unread={isUnread(item.key)}
                          threadName={activeScope === "all" && !mine
                            ? view.threadTitleForKey(wait.threadKey)
                            : undefined}
                          respond={view.respond}
                          dismissQuestion={(target) => {
                            const question = target.question;
                            return question ? view.dismissQuestion(question) : Promise.resolve();
                          }}
                          openWait={view.openWait}
                        />
                      </li>
                    );
                  }
                  const { todo } = item;
                  const mine = buildThreadIdentityKey(todo.backend, todo.threadId) === threadKey;
                  return (
                    <li key={todo.id}>
                      {mine && todo.status === "open" ? (
                        <ThreadTodoCard
                          todo={todo}
                          running={view.runningIds.has(todo.id)}
                          mergeMethods={view.mergeMethods}
                          instances={view.instances}
                          projectMenu={view.projectMenu}
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
                          unread={todo.status === "open" && isUnread(item.key)}
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
  unread?: boolean;
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
    <div
      className="thread-todos-panel__row"
      data-status={todo.status}
      data-unread={props.unread ? "true" : undefined}
    >
      {props.unread ? <span className="thread-todos-panel__unread" aria-hidden="true" /> : null}
      {props.current ? (
        <div className="thread-todos-panel__row-main">{main}</div>
      ) : (
        <button
          type="button"
          className="thread-todos-panel__row-main"
          aria-label={`Open thread: ${todo.title}, in ${view.threadTitle(todo)}${
            props.unread ? ", unread" : ""
          }`}
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
          {/* A merge or a started thread happened; only a resolve can be
              taken back, as the stack's Undo does. */}
          {!todo.startedThread && (!todo.result || RESOLUTION_RESULTS.has(todo.result)) ? (
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

function groupItems(
  items: PanelItem[],
  scope: ThreadTodoScope,
  props: ThreadTodosPanelProps,
): TodoGroup[] {
  const { view } = props;
  const groups = new Map<string, TodoGroup>();
  for (const item of items) {
    // All groups by the project an item came from; the narrower lenses by
    // thread, since one project's threads are what the operator moves between.
    let key: string;
    let title: string;
    if (item.type === "wait") {
      const project = view.threadProjectForKey(item.wait.threadKey);
      key = scope === "all" ? project?.key ?? NO_PROJECT_KEY : item.wait.threadKey;
      title = scope === "all"
        ? project?.label ?? "No project"
        : view.threadTitleForKey(item.wait.threadKey);
    } else {
      key = scope === "all"
        ? item.todo.sourceProject?.key ?? NO_PROJECT_KEY
        : buildThreadIdentityKey(item.todo.backend, item.todo.threadId);
      title = scope === "all"
        ? item.todo.sourceProject?.label ?? "No project"
        : view.threadTitle(item.todo);
    }
    // All groups by project, where one paused thread is not the group's turn.
    const paused = scope !== "all" && item.type === "wait" && isBlockingWait(item.wait);
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      group.paused ||= paused;
    } else {
      groups.set(key, { key, title, items: [item], paused });
    }
  }
  const first = scope === "all" ? props.projectKey : props.threadKey;
  const ordered = [...groups.values()];
  const current = ordered.findIndex((group) => group.key === first);
  if (current > 0) {
    ordered.unshift(...ordered.splice(current, 1));
  }
  return ordered;
}
