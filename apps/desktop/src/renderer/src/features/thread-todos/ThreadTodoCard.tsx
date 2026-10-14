import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import type {
  ThreadTodo,
  ThreadTodoItem,
  ThreadTodoKind,
  ThreadTodoMergeMethod,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoResolution,
} from "@pwragent/shared";
import {
  THREAD_TODO_MERGE_METHODS,
  resolveThreadTodoMergeMethod,
  threadTodoItemProgress,
  threadTodoOpenItems,
} from "@pwragent/shared";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  CopyIcon,
  HandoffIcon,
  MergeIcon,
  ReviewIcon,
  type IconProps,
} from "../../icons";
import { copyText } from "../../lib/copy-text";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { TodoProjectPicker } from "./TodoProjectPicker";
import { TodoSplitButton, type TodoSplitMenuEntry } from "./TodoSplitButton";
import type {
  ThreadTodoInstance,
  ThreadTodoProjectMenu,
  ThreadTodoResolveOptions,
  ThreadTodoRunOptions,
} from "./thread-todos-view";

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
  /**
   * Opens the composer's `/review` flow; the card resolves once it starts,
   * with `options` as the card's open-steps answer.
   */
  onStartReview: (todo: ThreadTodo, options?: ThreadTodoResolveOptions) => void;
  onResolve: (
    todo: ThreadTodo,
    status: "done" | "dismissed",
    resolution?: ThreadTodoResolution,
    options?: ThreadTodoResolveOptions,
  ) => void;
  /**
   * Sends a handoff's prompt to the card's own thread as a reply. Only the
   * thread on screen can take one, so other surfaces leave it out.
   */
  onDoHere?: (
    todo: ThreadTodo,
    options?: ThreadTodoResolveOptions,
  ) => void | Promise<unknown>;
  /** Ticks or unticks one step. */
  onSetItemChecked: (todo: ThreadTodo, item: ThreadTodoItem, checked: boolean) => void;
};

export type ThreadTodoCardProps = ThreadTodoCardHandlers & {
  todo: ThreadTodo;
  running: boolean;
  mergeMethods?: ThreadTodoMergeMethodPreferences;
  instances?: ThreadTodoInstance[];
  /** Changes the project the card's action runs in. */
  projectMenu?: ThreadTodoProjectMenu;
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

/** Something that would complete the card while steps are still open. */
type OpenStepsConfirmation = {
  /** "Mark done anyway?" */
  question: string;
  /** The confirming button: what goes ahead. */
  label: string;
  proceed: () => void;
};

/**
 * One to-do. Its anatomy is the notice toast's: the title row carries the
 * kind glyph, age and the icon tools; the pager leads the footer and the
 * card's own action trails it, the way out last.
 *
 * A card with steps is done when every step is checked. Checking the last
 * step never resolves the card by itself: Done, or the card's action, stays
 * the operator's click. Anything that would complete the card while steps
 * are open asks first ("2 steps still open"), and only a confirmed click
 * sends `allowOpenItems`. Dismiss never asks.
 */
export function ThreadTodoCard(props: ThreadTodoCardProps) {
  const { todo } = props;
  const [confirmingMerge, setConfirmingMerge] = useState<MergeConfirmation>();
  const [confirmingSteps, setConfirmingSteps] = useState<OpenStepsConfirmation>();
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const wasConfirmingRef = useRef(false);
  const confirmTextId = useId();
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
  const progress = threadTodoItemProgress(todo);
  const openSteps = threadTodoOpenItems(todo).length;
  const openStepsText = `${openSteps} ${openSteps === 1 ? "step" : "steps"} still open.`;
  // Ticking the last step while the question is up answers it: the card
  // goes back to its buttons instead of asking about "0 steps".
  const stepsConfirmation = openSteps > 0 ? confirmingSteps : undefined;
  useEffect(() => {
    if (openSteps === 0) setConfirmingSteps(undefined);
  }, [openSteps]);

  // The click that asked unmounts with the buttons it sat among, so focus
  // moves to Cancel; when the question goes away and took focus with it,
  // focus returns to the card's buttons rather than the document.
  useEffect(() => {
    if (stepsConfirmation) {
      wasConfirmingRef.current = true;
      confirmCancelRef.current?.focus();
    } else if (wasConfirmingRef.current) {
      wasConfirmingRef.current = false;
      if (!document.activeElement || document.activeElement === document.body) {
        // Not a split button's menu chevron, which comes first in the DOM.
        actionsRef.current
          ?.querySelector<HTMLButtonElement>("button:not([aria-haspopup])")
          ?.focus();
      }
    }
  }, [stepsConfirmation]);

  /**
   * Runs `complete` now when every step is checked; otherwise asks first and
   * runs it with `allowOpenItems` once the operator confirms.
   */
  const completeCard = (
    confirmation: Omit<OpenStepsConfirmation, "proceed">,
    complete: (allowOpenItems: boolean) => void,
  ): void => {
    if (openSteps === 0) {
      complete(false);
      return;
    }
    setConfirmingSteps({ ...confirmation, proceed: () => complete(true) });
  };
  const markDone = (resolution?: ThreadTodoResolution): void =>
    completeCard(
      { question: "Mark it done anyway?", label: "Done anyway" },
      (allowOpenItems) => props.onResolve(todo, "done", resolution, resolveOptions(allowOpenItems)),
    );
  const runAction = (options?: ThreadTodoRunOptions): void =>
    completeCard(
      { question: "Start the thread anyway?", label: "Start thread" },
      (allowOpenItems) => props.onRun(todo, {
        ...options,
        ...(allowOpenItems ? { allowOpenItems } : {}),
      }),
    );

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
    if (stepsConfirmation) {
      return (
        <>
          <button
            ref={confirmCancelRef}
            type="button"
            className="button thread-todo-card__button thread-todo-card__button--quiet"
            aria-describedby={confirmTextId}
            onClick={() => setConfirmingSteps(undefined)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary thread-todo-card__button"
            aria-describedby={confirmTextId}
            onClick={() => {
              const confirmation = stepsConfirmation;
              setConfirmingSteps(undefined);
              confirmation.proceed();
            }}
          >
            {stepsConfirmation.label}
          </button>
        </>
      );
    }
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
        onClick={() => markDone()}
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
            onClick={() => markDone()}
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
              onClick={() => completeCard(
                { question: "Start the review anyway?", label: "Start review" },
                (allowOpenItems) => props.onStartReview(todo, resolveOptions(allowOpenItems)),
              )}
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
                  // The confirmation text already says how many steps are
                  // open, so this one click is the override too.
                  props.onRun(todo, {
                    mergeMethod: confirmation.method,
                    ...(confirmation.remember ? { rememberMergeMethod: true } : {}),
                    ...(openSteps > 0 ? { allowOpenItems: true } : {}),
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
            onSelect: () => completeCard(
              { question: "Send it here anyway?", label: "Do it here" },
              (allowOpenItems) => void doHere(todo, resolveOptions(allowOpenItems)),
            ),
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
              onSelect: () => runAction({ startOnInstanceId: instance.instanceId }),
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
          onSelect: () => markDone("handled_elsewhere"),
        });
        return (
          <TodoSplitButton
            label={todo.error ? "Retry" : "Start thread"}
            Icon={HandoffIcon}
            menuLabel="Handoff options"
            onClick={() => runAction()}
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
        {progress ? (
          <span className="thread-todo-card__progress">
            {progress.checked} of {progress.total}
          </span>
        ) : null}
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

      {/* A review starts on the card's own thread, so it has no project to change. */}
      <TodoProjectPicker
        todo={todo}
        menu={todo.kind === "review" ? undefined : props.projectMenu}
        disabled={props.running}
      />

      {todo.detail || progress || facts.length > 0 || prompt || todo.error ? (
        <div className="thread-todo-card__body">
          {todo.detail ? <p className="thread-todo-card__detail">{todo.detail}</p> : null}
          {todo.items && progress ? (
            <ThreadTodoChecklist
              todo={todo}
              items={todo.items}
              progress={progress}
              onSetItemChecked={props.onSetItemChecked}
            />
          ) : null}
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
          {openSteps > 0 ? `${openStepsText} ` : ""}
          {confirmMergeText(action.pullRequest, confirmingMerge.method, todo.targetProject?.label)}
        </p>
      ) : null}
      {stepsConfirmation ? (
        <p id={confirmTextId} className="thread-todo-card__confirm">
          {openStepsText} {stepsConfirmation.question}
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
        <div ref={actionsRef} className="thread-todo-card__actions">{renderAction()}</div>
      </div>
    </article>
  );
}

/** The override only when the operator confirmed it; nothing otherwise. */
function resolveOptions(allowOpenItems: boolean): ThreadTodoResolveOptions | undefined {
  return allowOpenItems ? { allowOpenItems } : undefined;
}

/**
 * The card's steps. Each is a real checkbox, drawn over: the hidden input
 * keeps the native name, state and Space key, and the box beside it is what
 * shows. A tick is not optimistic; the box follows the stored card.
 */
function ThreadTodoChecklist(props: {
  todo: ThreadTodo;
  items: ThreadTodoItem[];
  progress: { checked: number; total: number };
  onSetItemChecked: ThreadTodoCardHandlers["onSetItemChecked"];
}) {
  const { todo, onSetItemChecked } = props;
  return (
    <ul
      className="thread-todo-checklist"
      aria-label={`Steps, ${props.progress.checked} of ${props.progress.total} checked`}
    >
      {props.items.map((item) => (
        <li key={item.id} className="thread-todo-checklist__item">
          <label
            className={`thread-todo-checklist__label${item.checked ? " is-checked" : ""}`}
          >
            <input
              type="checkbox"
              className="thread-todo-checklist__input"
              checked={item.checked}
              onChange={(event) => {
                onSetItemChecked(todo, item, event.currentTarget.checked);
              }}
            />
            <span
              aria-hidden="true"
              className={`thread-todo-checklist__box${item.checked ? " is-checked" : ""}`}
            />
            <span className="thread-todo-checklist__text">{item.text}</span>
          </label>
        </li>
      ))}
    </ul>
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
    if (action.executionMode) {
      facts.push(["Access", formatExecutionModeLabel(action.executionMode)]);
    }
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
