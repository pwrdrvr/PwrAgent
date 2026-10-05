import { useEffect, useRef, useState, type ComponentType } from "react";
import type {
  ThreadTodo,
  ThreadTodoKind,
  ThreadTodoMergeMethod,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoResolution,
} from "@pwragent/shared";
import {
  THREAD_TODO_MERGE_METHODS,
  resolveThreadTodoMergeMethod,
} from "@pwragent/shared";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  CopyIcon,
  FolderIcon,
  HandoffIcon,
  MergeIcon,
  ReviewIcon,
  type IconProps,
} from "../../icons";
import { copyText } from "../../lib/copy-text";
import { TodoSplitButton, type TodoSplitMenuEntry } from "./TodoSplitButton";
import type { ThreadTodoInstance, ThreadTodoRunOptions } from "./thread-todos-view";

const KIND_ICONS: Record<ThreadTodoKind, ComponentType<IconProps> | undefined> = {
  reminder: undefined,
  review: ReviewIcon,
  merge: MergeIcon,
  handoff: HandoffIcon,
};

/** The button says what it will do; the menu says it as GitHub does. */
const MERGE_METHOD_LABELS: Record<
  ThreadTodoMergeMethod,
  { button: string; menu: string; verb: string }
> = {
  squash: { button: "Squash merge", menu: "Squash and merge", verb: "Squash merge" },
  rebase: { button: "Rebase merge", menu: "Rebase and merge", verb: "Rebase and merge" },
  merge: { button: "Merge", menu: "Create a merge commit", verb: "Merge" },
};

const COPIED_MS = 1_500;

export type ThreadTodoCardHandlers = {
  /** Merge or start-thread, in the main process. */
  onRun: (todo: ThreadTodo, options?: ThreadTodoRunOptions) => void;
  /** Opens the composer's `/review` flow; the card resolves once it starts. */
  onStartReview: (todo: ThreadTodo) => void;
  onResolve: (
    todo: ThreadTodo,
    status: "done" | "dismissed",
    resolution?: ThreadTodoResolution,
  ) => void;
  /**
   * Sends a handoff's prompt to the card's own thread as a reply. Only the
   * thread on screen can take one, so other surfaces leave it out.
   */
  onDoHere?: (todo: ThreadTodo) => void;
};

export type ThreadTodoCardProps = ThreadTodoCardHandlers & {
  todo: ThreadTodo;
  running: boolean;
  mergeMethods?: ThreadTodoMergeMethodPreferences;
  instances?: ThreadTodoInstance[];
  pager?: {
    position: number;
    total: number;
    onPrevious: () => void;
    onNext: () => void;
  };
  onCollapse?: () => void;
  now?: number;
};

type MergeConfirmation = {
  method: ThreadTodoMergeMethod;
  /** A pick from the menu, remembered for the card's project. */
  remember: boolean;
};

/**
 * One to-do. Its anatomy is the notice toast's: the title row carries the
 * kind glyph, age and the icon tools; the pager leads the footer and the
 * card's own action trails it, the way out last.
 */
export function ThreadTodoCard(props: ThreadTodoCardProps) {
  const { todo } = props;
  const [confirmingMerge, setConfirmingMerge] = useState<MergeConfirmation>();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);
  const KindIcon = KIND_ICONS[todo.kind];
  const action = todo.action;
  const titleId = `thread-todo-title-${todo.id}`;
  const prompt = action?.type === "start_thread" ? action.prompt : undefined;
  const facts = buildFacts(todo);
  const runningLabel = action?.type === "merge_pull_request" ? "Merging…" : "Starting…";

  const copyPrompt = (): void => {
    if (!prompt) return;
    void copyText(prompt).then(() => {
      clearTimeout(copiedTimerRef.current);
      setCopied(true);
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
    }).catch((error: unknown) => {
      console.warn("Copying the handoff prompt failed.", error);
    });
  };

  const renderAction = () => {
    if (props.running) {
      return (
        <span className="thread-todo-card__button thread-todo-card__button--busy" role="status">
          <span className="pending-spinner pending-spinner--sm" aria-hidden="true" />
          {runningLabel}
        </span>
      );
    }
    const done = (
      <button
        type="button"
        className="button thread-todo-card__button thread-todo-card__button--quiet"
        onClick={() => props.onResolve(todo, "done")}
      >
        Done
      </button>
    );
    switch (action?.type) {
      case undefined:
        return (
          <button
            type="button"
            className="button thread-todo-card__button"
            onClick={() => props.onResolve(todo, "done")}
          >
            <CheckIcon size={12} />
            Done
          </button>
        );
      case "start_review":
        return (
          <>
            {done}
            <button
              type="button"
              className="button button--primary thread-todo-card__button"
              onClick={() => props.onStartReview(todo)}
            >
              <ReviewIcon size={12} />
              Start review
            </button>
          </>
        );
      case "merge_pull_request": {
        if (confirmingMerge) {
          return (
            <>
              <button
                type="button"
                className="button thread-todo-card__button thread-todo-card__button--quiet"
                onClick={() => setConfirmingMerge(undefined)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary thread-todo-card__button"
                onClick={() => {
                  const confirmation = confirmingMerge;
                  setConfirmingMerge(undefined);
                  props.onRun(todo, {
                    mergeMethod: confirmation.method,
                    ...(confirmation.remember ? { rememberMergeMethod: true } : {}),
                  });
                }}
              >
                <MergeIcon size={12} />
                {MERGE_METHOD_LABELS[confirmingMerge.method].verb}
              </button>
            </>
          );
        }
        const method = resolveThreadTodoMergeMethod(todo, props.mergeMethods);
        return (
          <>
            {done}
            <TodoSplitButton
              label={todo.error ? "Retry merge" : MERGE_METHOD_LABELS[method].button}
              Icon={MergeIcon}
              menuLabel="Merge options"
              onClick={() => setConfirmingMerge({ method, remember: false })}
              entries={THREAD_TODO_MERGE_METHODS.map((option) => ({
                kind: "item",
                id: option,
                label: MERGE_METHOD_LABELS[option].menu,
                checked: option === method,
                onSelect: () => setConfirmingMerge({ method: option, remember: true }),
              }))}
            />
          </>
        );
      }
      case "start_thread": {
        const entries: TodoSplitMenuEntry[] = [];
        if (props.onDoHere) {
          const doHere = props.onDoHere;
          entries.push({
            kind: "item",
            id: "here",
            label: "Do it here",
            onSelect: () => doHere(todo),
          });
        }
        const instances = props.instances ?? [];
        if (instances.length > 0) {
          entries.push({
            kind: "submenu",
            id: "instances",
            label: "Start thread on",
            entries: instances.map((instance) => ({
              kind: "item",
              id: instance.instanceId,
              label: instance.label,
              onSelect: () => props.onRun(todo, { startOnInstanceId: instance.instanceId }),
            })),
          });
        }
        if (entries.length > 0) {
          entries.push({ kind: "separator", id: "separator" });
        }
        entries.push({
          kind: "item",
          id: "elsewhere",
          label: "Handled elsewhere",
          onSelect: () => props.onResolve(todo, "done", "handled_elsewhere"),
        });
        return (
          <TodoSplitButton
            label={todo.error ? "Retry" : "Start thread"}
            Icon={HandoffIcon}
            menuLabel="Handoff options"
            onClick={() => props.onRun(todo)}
            entries={entries}
          />
        );
      }
    }
  };

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

      {todo.targetProject ? (
        <p className="thread-todo-card__project">
          <FolderIcon size={11} aria-hidden="true" />
          <span className="thread-todo-card__project-label">For {todo.targetProject.label}</span>
        </p>
      ) : null}

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
            <div className="thread-todo-card__prompt-block">
              <button
                type="button"
                className={`thread-todo-card__prompt${promptExpanded ? " is-expanded" : ""}`}
                aria-expanded={promptExpanded}
                aria-label={promptExpanded ? "Collapse proposed prompt" : "Show the whole proposed prompt"}
                onClick={() => setPromptExpanded((current) => !current)}
              >
                <span className="thread-todo-card__prompt-text">{prompt}</span>
              </button>
              <button
                type="button"
                className="thread-todo-card__icon-button thread-todo-card__copy"
                aria-label={copied ? "Prompt copied" : "Copy prompt"}
                title={copied ? "Copied" : "Copy prompt"}
                onClick={copyPrompt}
              >
                {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              </button>
            </div>
          ) : null}
          {todo.error ? (
            <p className="thread-todo-card__error" role="alert">{todo.error}</p>
          ) : null}
        </div>
      ) : null}

      {confirmingMerge && action?.type === "merge_pull_request" ? (
        <p className="thread-todo-card__confirm">
          {confirmMergeText(action.pullRequest, confirmingMerge.method, todo.targetProject?.label)}
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
        <div className="thread-todo-card__actions">{renderAction()}</div>
      </div>
    </article>
  );
}

function confirmMergeText(
  pullRequest: string,
  method: ThreadTodoMergeMethod,
  projectLabel: string | undefined,
): string {
  const target = /^\d+$/.test(pullRequest) ? `#${pullRequest}` : "this pull request";
  const where = projectLabel ? ` in ${projectLabel}` : "";
  return `${MERGE_METHOD_LABELS[method].verb} ${target}${where}? This cannot be undone here.`;
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
    const directory = todo.targetProject
      ? `${todo.targetProject.label}'s directory`
      : "This thread's directory";
    facts.push(["Where", action.workMode === "worktree" ? "New worktree" : directory]);
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
