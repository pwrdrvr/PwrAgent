import { useState, type ComponentType } from "react";
import type { ThreadTodo, ThreadTodoKind } from "@pwragent/shared";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  HandoffIcon,
  MergeIcon,
  ReviewIcon,
  type IconProps,
} from "../../icons";

const KIND_ICONS: Record<ThreadTodoKind, ComponentType<IconProps> | undefined> = {
  reminder: undefined,
  review: ReviewIcon,
  merge: MergeIcon,
  handoff: HandoffIcon,
};

export type ThreadTodoCardHandlers = {
  /** Merge or start-thread, in the main process. */
  onRun: (todo: ThreadTodo) => void;
  /** Opens the composer's `/review` flow; the card resolves once it starts. */
  onStartReview: (todo: ThreadTodo) => void;
  onResolve: (todo: ThreadTodo, status: "done" | "dismissed") => void;
};

export type ThreadTodoCardProps = ThreadTodoCardHandlers & {
  todo: ThreadTodo;
  running: boolean;
  pager?: {
    position: number;
    total: number;
    onPrevious: () => void;
    onNext: () => void;
  };
  onCollapse?: () => void;
  now?: number;
};

/**
 * One to-do. Its anatomy is the notice toast's: the title row carries the
 * kind glyph, age and the icon tools; the pager leads the footer and the
 * card's own action trails it, the way out last.
 */
export function ThreadTodoCard(props: ThreadTodoCardProps) {
  const { todo } = props;
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const KindIcon = KIND_ICONS[todo.kind];
  const action = todo.action;
  const titleId = `thread-todo-title-${todo.id}`;

  const primary = (() => {
    if (!action) return undefined;
    switch (action.type) {
      case "start_review":
        return {
          label: "Start review",
          Icon: ReviewIcon,
          onClick: () => props.onStartReview(todo),
        };
      case "merge_pull_request":
        return {
          label: confirmingMerge ? "Squash merge" : todo.error ? "Retry merge" : "Squash merge",
          Icon: MergeIcon,
          onClick: () => {
            if (!confirmingMerge) {
              setConfirmingMerge(true);
              return;
            }
            setConfirmingMerge(false);
            props.onRun(todo);
          },
        };
      case "start_thread":
        return {
          label: todo.error ? "Retry" : "Start thread",
          Icon: HandoffIcon,
          onClick: () => props.onRun(todo),
        };
    }
  })();
  const runningLabel = action?.type === "merge_pull_request" ? "Merging…" : "Starting…";
  const prompt = action?.type === "start_thread" ? action.prompt : undefined;
  const facts = buildFacts(todo);

  return (
    <article
      className="thread-todo-card"
      data-kind={todo.kind}
      data-todo-id={todo.id}
      aria-labelledby={titleId}
    >
      <div className="thread-todo-card__head">
        <span className="thread-todo-card__kind" aria-hidden="true">
          {KindIcon ? <KindIcon size={13} /> : <span className="thread-todo-card__ring" />}
        </span>
        <h3 id={titleId} className="thread-todo-card__title">{todo.title}</h3>
        <span className="thread-todo-card__age">
          {formatTodoAge(todo.createdAt, props.now)}
        </span>
        <div className="thread-todo-card__tools">
          {props.onCollapse ? (
            <button
              type="button"
              className="thread-todo-card__icon-button"
              aria-label="Collapse to-dos"
              title="Collapse to-dos"
              onClick={props.onCollapse}
            >
              <ChevronUpIcon size={13} />
            </button>
          ) : null}
          <button
            type="button"
            className="thread-todo-card__icon-button"
            aria-label={`Dismiss to-do: ${todo.title}`}
            title="Dismiss"
            onClick={() => props.onResolve(todo, "dismissed")}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      </div>

      {todo.detail || facts.length > 0 || prompt || todo.error ? (
        <div className="thread-todo-card__body">
          {todo.detail ? <p className="thread-todo-card__detail">{todo.detail}</p> : null}
          {facts.length > 0 ? (
            <dl className="thread-todo-card__facts">
              {facts.map(([label, value]) => (
                <div key={label} className="thread-todo-card__fact">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {prompt ? (
            <button
              type="button"
              className={`thread-todo-card__prompt${promptExpanded ? " is-expanded" : ""}`}
              aria-expanded={promptExpanded}
              aria-label={promptExpanded ? "Collapse proposed prompt" : "Show the whole proposed prompt"}
              onClick={() => setPromptExpanded((current) => !current)}
            >
              <span className="thread-todo-card__prompt-text">{prompt}</span>
            </button>
          ) : null}
          {todo.error ? (
            <p className="thread-todo-card__error" role="alert">{todo.error}</p>
          ) : null}
        </div>
      ) : null}

      {confirmingMerge && action?.type === "merge_pull_request" ? (
        <p className="thread-todo-card__confirm">
          {/^\d+$/.test(action.pullRequest)
            ? `Squash merge #${action.pullRequest}? This cannot be undone here.`
            : "Squash merge this pull request? This cannot be undone here."}
        </p>
      ) : null}

      <div className="thread-todo-card__footer">
        {props.pager && props.pager.total > 1 ? (
          <nav className="thread-todo-card__pager" aria-label="To-do pages">
            <button
              type="button"
              className="thread-todo-card__icon-button"
              aria-label="Previous to-do"
              disabled={props.pager.position <= 1}
              onClick={props.pager.onPrevious}
            >
              <ChevronLeftIcon size={13} />
            </button>
            <span className="thread-todo-card__position">
              {props.pager.position}/{props.pager.total}
            </span>
            <button
              type="button"
              className="thread-todo-card__icon-button"
              aria-label="Next to-do"
              disabled={props.pager.position >= props.pager.total}
              onClick={props.pager.onNext}
            >
              <ChevronRightIcon size={13} />
            </button>
          </nav>
        ) : null}
        <div className="thread-todo-card__actions">
          {props.running ? (
            <span className="thread-todo-card__button thread-todo-card__button--busy" role="status">
              <span className="pending-spinner pending-spinner--sm" aria-hidden="true" />
              {runningLabel}
            </span>
          ) : primary ? (
            <>
              {confirmingMerge ? (
                <button
                  type="button"
                  className="button thread-todo-card__button thread-todo-card__button--quiet"
                  onClick={() => setConfirmingMerge(false)}
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className="button thread-todo-card__button thread-todo-card__button--quiet"
                  onClick={() => props.onResolve(todo, "done")}
                >
                  Done
                </button>
              )}
              <button
                type="button"
                className="button button--primary thread-todo-card__button"
                onClick={primary.onClick}
              >
                <primary.Icon size={12} />
                {primary.label}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button thread-todo-card__button"
              onClick={() => props.onResolve(todo, "done")}
            >
              <CheckIcon size={12} />
              Done
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function buildFacts(todo: ThreadTodo): Array<[string, string]> {
  const action = todo.action;
  if (action?.type === "merge_pull_request") {
    return [["PR", /^\d+$/.test(action.pullRequest) ? `#${action.pullRequest}` : action.pullRequest]];
  }
  if (action?.type === "start_thread") {
    const facts: Array<[string, string]> = [];
    const model = [action.model, action.reasoningEffort].filter(Boolean).join(" · ");
    if (model) facts.push(["Model", model]);
    facts.push(["Where", action.workMode === "worktree" ? "New worktree" : "This thread's directory"]);
    return facts;
  }
  return [];
}

export function formatTodoAge(createdAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
