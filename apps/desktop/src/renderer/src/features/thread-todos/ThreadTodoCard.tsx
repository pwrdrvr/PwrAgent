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
  ArrowUpIcon,
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
  ThreadTodoRunOptions,
} from "./thread-todos-view";
import {
  addressReviewFindingsPrompt,
  openReviewItems,
  orderReviewItems,
  useTrackedReview,
} from "./review-tracking";

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
   * Sends a handoff's prompt, or the review card's `prompt`, to the card's
   * own thread as a reply. Only the thread on screen can take one, so other
   * surfaces leave it out.
   */
  onDoHere?: (todo: ThreadTodo, prompt?: string) => void | Promise<unknown>;
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

/**
 * One to-do. Its anatomy is the notice toast's: the title row carries the
 * kind glyph, age and the icon tools; the pager leads the footer and the
 * card's own action trails it, the way out last.
 */
export function ThreadTodoCard(props: ThreadTodoCardProps) {
  return props.todo.reviewId ? <TrackedReviewCard {...props} /> : <ActionThreadTodoCard {...props} />;
}

/** Rows a review card shows before "Show N more". */
const REVIEW_CARD_ROWS = 4;

/**
 * A completed review still waiting on its findings. The body is a checklist
 * settled in place, one row per finding; the footer hands what is open to
 * the agent in this thread.
 */
function TrackedReviewCard(props: ThreadTodoCardProps) {
  const { todo } = props;
  const tracking = useTrackedReview(todo, { id: todo.reviewId });
  const [expanded, setExpanded] = useState(false);
  const titleId = `thread-todo-title-${todo.id}`;
  const review = tracking.review;
  const items = review ? orderReviewItems(review.items) : [];
  const open = review ? openReviewItems(review).length : 0;
  const shown = expanded ? items : items.slice(0, REVIEW_CARD_ROWS);
  const hidden = items.length - shown.length;
  const onDoHere = props.onDoHere;

  let count: string | undefined;
  if (review) {
    if (items.length === 0) count = "No findings to settle";
    else if (open === 0) count = "No findings left open";
    else count = open === items.length ? `${open} open` : `${open} of ${items.length} open`;
  }
  // The explanation is the transcript's to show; the card repeats it only
  // when there is no list to read instead.
  const summary = items.length === 0 ? review?.summary : undefined;

  const renderAction = () => {
    if (!review || review.status !== "open") return null;
    if (open === 0) {
      return (
        <button
          type="button"
          className="button button--primary thread-todo-card__button"
          disabled={tracking.busy}
          onClick={() => void tracking.update({ status: "handled" })}
        >
          <CheckIcon size={12} />
          Mark handled
        </button>
      );
    }
    return onDoHere ? (
      <button
        type="button"
        className="button button--primary thread-todo-card__button"
        onClick={() => void onDoHere(todo, addressReviewFindingsPrompt(review))}
      >
        <ArrowUpIcon size={12} />
        Address findings
      </button>
    ) : null;
  };

  return (
    <article
      className="thread-todo-card"
      data-kind={todo.kind}
      data-todo-id={todo.id}
      aria-labelledby={titleId}
    >
      <ThreadTodoCardHead
        todo={todo}
        titleId={titleId}
        now={props.now}
        onCollapse={props.onCollapse}
        dismissLabel="Dismiss review"
        onDismiss={() => props.onResolve(todo, "dismissed")}
      />
      <div className="thread-todo-card__body">
        <p className="review-todo__summary">
          <span className="review-todo__count">{count ?? todo.detail ?? "Loading review…"}</span>
          {summary ? <span className="review-todo__explanation">{summary}</span> : null}
        </p>
        {shown.length > 0 && review ? (
          <ul className="review-todo__findings" aria-label="Findings">
            {shown.map((item) => (
              <li key={item.id} className="review-todo__finding" data-status={item.status}>
                <span
                  className={`review-todo__priority${
                    typeof item.priority === "number" && item.priority >= 0 && item.priority <= 3
                      ? ` review-todo__priority--p${item.priority}`
                      : ""
                  }`}
                >
                  {typeof item.priority === "number" ? `P${item.priority}` : "–"}
                </span>
                <span className="review-todo__finding-title tooltip-target" data-tooltip={item.title}>
                  {item.title}
                </span>
                <span className="review-todo__finding-actions">
                  {item.status === "open" ? (
                    <>
                      <button
                        type="button"
                        className="thread-todo-card__icon-button"
                        aria-label={`Mark addressed: ${item.title}`}
                        title="Mark addressed"
                        disabled={tracking.busy}
                        onClick={() => void tracking.update({ itemId: item.id, status: "addressed" })}
                      >
                        <CheckIcon size={13} />
                      </button>
                      <button
                        type="button"
                        className="thread-todo-card__icon-button"
                        aria-label={`Dismiss finding: ${item.title}`}
                        title="Do not address"
                        disabled={tracking.busy}
                        onClick={() => void tracking.update({ itemId: item.id, status: "dismissed" })}
                      >
                        <CloseIcon size={13} />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="review-todo__reopen"
                      aria-label={`Reopen finding: ${item.title}`}
                      disabled={tracking.busy}
                      onClick={() => void tracking.update({ itemId: item.id, status: "open" })}
                    >
                      Reopen
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {hidden > 0 || expanded ? (
          <button
            type="button"
            className="review-todo__more"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        ) : null}
        {tracking.error ? (
          <p className="thread-todo-card__error" role="alert">{tracking.error}</p>
        ) : null}
      </div>
      <div className="thread-todo-card__footer">
        {props.pager ? <ThreadTodoCardPager pager={props.pager} /> : null}
        <div className="thread-todo-card__actions">{renderAction()}</div>
      </div>
    </article>
  );
}

/** The title row every card shares: kind glyph, title, age, then the tools. */
function ThreadTodoCardHead(props: {
  todo: ThreadTodo;
  titleId: string;
  now?: number;
  onCollapse?: () => void;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  const { todo } = props;
  const KindIcon = KIND_ICONS[todo.kind];
  return (
    <div className="thread-todo-card__head">
      <span className="thread-todo-card__kind" aria-hidden="true">
        {KindIcon ? <KindIcon size={13} /> : <span className="thread-todo-card__ring" />}
      </span>
      <h3 id={props.titleId} className="thread-todo-card__title">{todo.title}</h3>
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
          aria-label={props.dismissLabel}
          title="Dismiss"
          onClick={props.onDismiss}
        >
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  );
}

function ThreadTodoCardPager(props: { pager: NonNullable<ThreadTodoCardProps["pager"]> }) {
  const { pager } = props;
  if (pager.total <= 1) return null;
  return (
    <nav className="thread-todo-card__pager" aria-label="To-do pages">
      <button
        type="button"
        className="thread-todo-card__icon-button"
        aria-label="Previous to-do"
        disabled={pager.position <= 1}
        onClick={pager.onPrevious}
      >
        <ChevronLeftIcon size={13} />
      </button>
      <span className="thread-todo-card__position">
        {pager.position}/{pager.total}
      </span>
      <button
        type="button"
        className="thread-todo-card__icon-button"
        aria-label="Next to-do"
        disabled={pager.position >= pager.total}
        onClick={pager.onNext}
      >
        <ChevronRightIcon size={13} />
      </button>
    </nav>
  );
}

function ActionThreadTodoCard(props: ThreadTodoCardProps) {
  const { todo } = props;
  const [confirmingMerge, setConfirmingMerge] = useState<MergeConfirmation>();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);
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
      <ThreadTodoCardHead
        todo={todo}
        titleId={titleId}
        now={props.now}
        onCollapse={props.onCollapse}
        dismissLabel={`Dismiss to-do: ${todo.title}`}
        onDismiss={() => props.onResolve(todo, "dismissed")}
      />

      {/* A review starts on the card's own thread, so it has no project to change. */}
      <TodoProjectPicker
        todo={todo}
        menu={todo.kind === "review" ? undefined : props.projectMenu}
        disabled={props.running}
      />

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
        {props.pager ? <ThreadTodoCardPager pager={props.pager} /> : null}
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
