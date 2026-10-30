import { TodoDispatchFacts, useTodoDispatchTarget } from "./TodoDispatchFacts";
import { TodoPullRequestChip } from "./TodoPullRequestChip";
import { todoDispatchPickKey, useTodoDispatchContext } from "./TodoDispatchProvider";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type {
  ThreadReviewItem,
  ThreadTodo,
  ThreadTodoItem,
  ThreadTodoKind,
  ThreadTodoMergeMethod,
  ThreadTodoMergeMethodPreferences,
  ThreadTodoModelSettings,
  ThreadTodoResolution,
} from "@pwragent/shared";
import {
  THREAD_TODO_MERGE_METHODS,
  resolveThreadTodoMergeMethod,
  resolveThreadTodoModelSettings,
  threadTodoBlockingItems,
  threadTodoItemNoun,
  threadTodoItemProgress,
  threadTodoOpenItems,
  threadTodoPrerequisites,
  threadTodoSteps,
} from "@pwragent/shared";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
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
import {
  ChipContextMenu,
  type ChipContextMenuItem,
  type ChipContextMenuPosition,
} from "../chrome/ChipContextMenu";
import { TodoProjectPicker } from "./TodoProjectPicker";
import { ThreadMarkdown } from "../thread-detail/ThreadMarkdown";
import { TodoSplitButton, type TodoSplitMenuEntry } from "./TodoSplitButton";
import type {
  ThreadTodoDoHereOptions,
  ThreadTodoInstance,
  ThreadTodoLocalMachine,
  ThreadTodoProjectMenu,
  ThreadTodoResolveOptions,
  ThreadTodoRunOptions,
} from "./thread-todos-view";
import {
  SettledFindingLabel,
  fixReviewFindingsPrompt,
  orderReviewItems,
  useTrackedReview,
} from "./review-tracking";
import {
  copyTodoMarkdown,
  threadTodoMarkdown,
  threadTodoStepsMarkdown,
  threadTodosMarkdown,
} from "./thread-todo-copy";

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

/** Steps a resting card shows; the toggle opens the rest. */
const RESTING_STEP_ROWS = 3;

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
   * Sends a handoff's prompt, or the review card's `prompt`, to the card's
   * own thread as a reply. Only the thread on screen can take one, so other
   * surfaces leave it out.
   */
  onDoHere?: (
    todo: ThreadTodo,
    options?: ThreadTodoDoHereOptions,
  ) => void | Promise<unknown>;
  /** Ticks or unticks one step. */
  onSetItemChecked: (todo: ThreadTodo, item: ThreadTodoItem, checked: boolean) => void;
};

export type ThreadTodoCardProps = ThreadTodoCardHandlers & {
  todo: ThreadTodo;
  running: boolean;
  /** The owning thread has an active turn; another repair must wait. */
  threadRunning?: boolean;
  mergeMethods?: ThreadTodoMergeMethodPreferences;
  instances?: ThreadTodoInstance[];
  /** This window's own machine, which a peer's card can start on. */
  localMachine?: ThreadTodoLocalMachine;
  /** Changes the project the card's action runs in. */
  projectMenu?: ThreadTodoProjectMenu;
  pager?: {
    position: number;
    total: number;
    onPrevious: () => void;
    onNext: () => void;
  };
  onCollapse?: () => void;
  /**
   * The cards shown with this one, in order: the right-click menu offers to
   * copy them all when there is more than one.
   */
  copyAllTodos?: readonly ThreadTodo[];
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
 * A card with steps is done when every blocking step is checked
 * (threadTodoBlockingItems). Checking the last step never resolves the card
 * by itself: Done, or the card's action, stays the operator's click.
 * Anything that would complete the card while blocking steps are open asks
 * first ("2 steps still open"), and only a confirmed click sends
 * `allowOpenItems`. Dismiss never asks.
 *
 * A start_thread card's plain steps are the new thread's plan, so only its
 * prerequisites ask; the steps go along with the thread.
 */
export function ThreadTodoCard(props: ThreadTodoCardProps) {
  return props.todo.reviewId ? <TrackedReviewCard {...props} /> : <ActionThreadTodoCard {...props} />;
}

/** Rows a review card shows before "Show N more". */
const REVIEW_CARD_ROWS = 4;

/**
 * A finding's priority and title; the title's tooltip shows it unclipped.
 * A review that ranks nothing has no priority column at all.
 */
function ReviewTodoFindingLabel(props: { item: ThreadReviewItem; ranked: boolean }) {
  const { item } = props;
  const priority = typeof item.priority === "number" && item.priority >= 0 && item.priority <= 3
    ? item.priority
    : undefined;
  return (
    <>
      {props.ranked ? (
        <span
          className={`review-todo__priority${priority === undefined ? "" : ` review-todo__priority--p${priority}`}`}
        >
          {priority === undefined ? "–" : `P${priority}`}
        </span>
      ) : null}
      <span className="review-todo__finding-title tooltip-target" data-tooltip={item.title}>
        {item.title}
      </span>
    </>
  );
}

/**
 * A completed review still waiting on its findings, one row per finding.
 * A row carries no mark at rest, so nothing on it reads as a step's
 * checkbox; its chips appear on hover or focus. Fix sends every open
 * finding, or only the selected ones, to the agent in this thread.
 */
function TrackedReviewCard(props: ThreadTodoCardProps) {
  const { todo } = props;
  const tracking = useTrackedReview(todo, { id: todo.reviewId });
  const [expanded, setExpanded] = useState(false);
  // One hand-off per click: a second click before the send settles would
  // queue the same reply again.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const titleId = `thread-todo-title-${todo.id}`;
  const review = tracking.review;
  const items = review ? orderReviewItems(review.items) : [];
  const copying = useTodoCopy(todo, {
    markdown: () => threadTodoMarkdown(
      review ? { ...todo, detail: todo.detail ?? review.summary } : todo,
      items,
    ),
    copyAllTodos: props.copyAllTodos,
  });
  const openItems = items.filter((item) => item.status === "open");
  // A selection that has since settled no longer counts.
  const selectedItems = openItems.filter((item) => selected.has(item.id));
  const toSend = selectedItems.length > 0 ? selectedItems : openItems;
  const toggleSelected = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const shown = expanded ? items : items.slice(0, REVIEW_CARD_ROWS);
  // A review whose reviewer ranks nothing shows no "–" placeholders.
  const ranked = items.some((item) => typeof item.priority === "number");
  const hidden = items.length - shown.length;
  const onDoHere = props.onDoHere;
  const busy = tracking.busy || sending;
  const working = props.running || props.threadRunning === true;
  const fixDisabled = busy || working;
  const fix = onDoHere
    ? (findings: ThreadReviewItem[]) => {
        if (sendingRef.current || fixDisabled) return;
        sendingRef.current = true;
        setSending(true);
        setSendError(undefined);
        void (async () => {
          try {
            const sent = await onDoHere(todo, { prompt: fixReviewFindingsPrompt(todo.title, findings) });
            if (sent === false) {
              setSendError("The thread did not accept the repair request. Try again.");
              return;
            }
            // Only what was sent leaves the selection; Fix now on one row
            // keeps the others the operator picked.
            setSelected((current) => {
              const next = new Set(current);
              for (const finding of findings) next.delete(finding.id);
              return next;
            });
          } catch (error) {
            setSendError(error instanceof Error ? error.message : String(error));
          } finally {
            sendingRef.current = false;
            setSending(false);
          }
        })();
      }
    : undefined;

  // Settled of total, the way a card with steps counts checked steps.
  const progress = items.length > 0
    ? { checked: items.length - openItems.length, total: items.length }
    : undefined;
  // The explanation is the transcript's to show; the card repeats it only
  // when there is no list to read instead. Until the review loads, the
  // card's own detail stands in, clamped the same way.
  const explanation = review
    ? items.length === 0 ? review.summary : undefined
    : todo.detail;

  const renderAction = () => {
    if (!review || review.status !== "open") return null;
    if (openItems.length === 0) {
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
    return fix ? (
      <button
        type="button"
        className="button button--primary thread-todo-card__button"
        disabled={fixDisabled}
        aria-busy={sending || working}
        onClick={() => fix(toSend)}
      >
        {sending || working
          ? <span className="pending-spinner pending-spinner--sm" aria-hidden="true" />
          : <ArrowUpIcon size={12} />}
        {sending ? "Sending…" : working ? "Working…"
          : selectedItems.length > 0 ? `Fix ${selectedItems.length} selected` : "Fix all"}
      </button>
    ) : null;
  };

  return (
    <article
      className="thread-todo-card"
      data-kind={todo.kind}
      data-todo-id={todo.id}
      aria-labelledby={titleId}
      onMouseDown={copying.onMouseDown}
      onContextMenu={copying.onContextMenu}
    >
      <ThreadTodoCardHead
        todo={todo}
        titleId={titleId}
        copying={copying}
        onCollapse={props.onCollapse}
        dismissLabel="Dismiss review"
        onDismiss={() => props.onResolve(todo, "dismissed")}
      />
      <ThreadTodoCardMeta todo={todo} now={props.now} progress={progress} />
      <div className="thread-todo-card__body">
        {review && items.length === 0 ? (
          <p className="review-todo__summary">
            <span className="review-todo__count">No findings to settle</span>
          </p>
        ) : null}
        {explanation ? (
          <p className="review-todo__summary">
            <span className="review-todo__explanation">{explanation}</span>
          </p>
        ) : null}
        {shown.length > 0 && review ? (
          <ul
            className="review-todo__findings"
            aria-label="Findings"
            data-unranked={ranked ? undefined : "true"}
          >
            {shown.map((item) => {
              const isSelected = item.status === "open" && selected.has(item.id);
              // The card labels each finding by its own outcome.
              const settled = item.status === "open" ? undefined : item.status;
              return (
                <li
                  key={item.id}
                  className="review-todo__finding"
                  data-status={item.status}
                  data-selected={isSelected ? "true" : undefined}
                >
                  <ReviewTodoFindingLabel item={item} ranked={ranked} />
                  <span className="review-todo__state">
                    {isSelected ? "Selected" : null}
                    {settled ? <SettledFindingLabel status={settled} size={11} /> : null}
                  </span>
                  <span className="review-todo__chips">
                    {item.status === "open" ? (
                      <>
                        <button
                          type="button"
                          className="review-todo__chip"
                          aria-pressed={isSelected}
                          aria-label={`Select finding: ${item.title}`}
                          onClick={() => toggleSelected(item.id)}
                        >
                          {isSelected ? "Selected" : "Select"}
                        </button>
                        {fix ? (
                          <button
                            type="button"
                            className="review-todo__chip"
                            aria-label={`Fix now: ${item.title}`}
                            disabled={fixDisabled}
                            onClick={() => fix([item])}
                          >
                            Fix now
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="review-todo__chip"
                          aria-label={`Decline finding: ${item.title}`}
                          disabled={busy}
                          onClick={() => void tracking.update({ itemId: item.id, status: "declined" })}
                        >
                          Decline
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="review-todo__chip"
                        aria-label={`Reopen finding: ${item.title}`}
                        disabled={busy}
                        onClick={() => void tracking.update({ itemId: item.id, status: "open" })}
                      >
                        Reopen
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
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
        {sendError ? (
          <p className="thread-todo-card__error" role="alert">{sendError}</p>
        ) : null}
      </div>
      <div className="thread-todo-card__footer">
        {props.pager ? <ThreadTodoCardPager pager={props.pager} /> : null}
        <div className="thread-todo-card__actions">{renderAction()}</div>
      </div>
      {copying.menu}
    </article>
  );
}

/**
 * The title row every card shares: kind glyph, title, then the tools. The
 * counts sit on the row below, so the title keeps the width.
 */
function ThreadTodoCardHead(props: {
  todo: ThreadTodo;
  titleId: string;
  copying: TodoCopying;
  onCollapse?: () => void;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  const { todo, copying } = props;
  const KindIcon = KIND_ICONS[todo.kind];
  return (
    <div className="thread-todo-card__head">
      <span className="thread-todo-card__kind" aria-hidden="true">
        {KindIcon ? <KindIcon size={13} /> : <span className="thread-todo-card__ring" />}
      </span>
      <h3 id={props.titleId} className="thread-todo-card__title">{todo.title}</h3>
      <div className="thread-todo-card__tools">
        <button
          ref={copying.buttonRef}
          type="button"
          className="thread-todo-card__icon-button"
          aria-label={copying.copied ? "To-do copied" : "Copy to-do"}
          title={copying.copied ? "Copied" : "Copy to-do"}
          onClick={copying.copyCard}
        >
          {copying.copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
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

/**
 * The row under the title: the card's project on the left, its progress and
 * age on the right.
 */
function ThreadTodoCardMeta(props: {
  todo: ThreadTodo;
  now?: number;
  /** Checked steps of a card with a checklist. */
  progress?: { checked: number; total: number };
  project?: ReactNode;
}) {
  return (
    <div className="thread-todo-card__meta">
      {props.project}
      <span className="thread-todo-card__stats">
        {props.progress ? (
          <span className="thread-todo-card__progress">
            {props.progress.checked} of {props.progress.total}
          </span>
        ) : null}
        <span className="thread-todo-card__age">
          {formatTodoAge(props.todo.createdAt, props.now)}
        </span>
      </span>
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
  const dispatch = useTodoDispatchContext();
  const [localPick, setLocalPick] = useState<ThreadTodoModelSettings>();
  const selection = resolveThreadTodoModelSettings({
    thread: todo.dispatchDefaults?.thread ?? { backend: todo.backend },
    action: todo.action,
    lastDispatch: todo.dispatchDefaults?.lastDispatch,
    pick: dispatch.picks.get(todoDispatchPickKey(todo)) ?? localPick,
  });
  const pickModel = (settings: ThreadTodoModelSettings) => {
    dispatch.pick(todo, settings);
    setLocalPick(settings);
  };
  const target = useTodoDispatchTarget({
    todo,
    ...(props.instances ? { instances: props.instances } : {}),
    ...(props.localMachine ? { localMachine: props.localMachine } : {}),
    ownerSelection: selection,
    pickOwnerModel: pickModel,
  });
  const [confirmingMerge, setConfirmingMerge] = useState<MergeConfirmation>();
  const [confirmingSteps, setConfirmingSteps] = useState<OpenStepsConfirmation>();
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const wasConfirmingRef = useRef(false);
  const confirmTextId = useId();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const promptId = useId();
  const resting = useRestingCard(todo);
  const copying = useTodoCopy(todo, {
    markdown: () => threadTodoMarkdown(todo),
    copyAllTodos: props.copyAllTodos,
  });
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);
  const action = todo.action;
  const titleId = `thread-todo-title-${todo.id}`;
  const prompt = action?.type === "start_thread" ? action.prompt : undefined;
  const hasFacts = action?.type === "merge_pull_request";
  const runningLabel = action?.type === "merge_pull_request" ? "Merging…" : "Starting…";
  const progress = threadTodoItemProgress(todo);
  const prerequisites = threadTodoPrerequisites(todo);
  const blocking = threadTodoBlockingItems(todo);
  const openSteps = blocking.length;
  const openStepsText = `${openSteps} ${threadTodoItemNoun(blocking)} still open.`;
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
   * Runs `complete` now when no blocking step is open; otherwise asks first
   * and runs it with `allowOpenItems` once the operator confirms.
   */
  const completeCard = (
    confirmation: Omit<OpenStepsConfirmation, "proceed">,
    complete: (allowOpenItems: boolean) => void,
  ): void => {
    if (openSteps === 0) {
      // A start_thread card's open steps do not block here. A federation
      // peer on an older version blocks on every open step, so the
      // override goes along to a peer's card. A local card's owner applies
      // the same rule as this card, and still refuses a prerequisite added
      // since it rendered.
      complete(
        todo.federationTarget !== undefined && threadTodoOpenItems(todo).length > 0,
      );
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
      (allowOpenItems) => {
        // Freeze the attempted settings too: a failed start's Retry uses them
        // even if another card changes the thread's memory in the meantime.
        if (target.onOwner) pickModel(selection.settings);
        props.onRun(todo, {
          ...(action?.type === "start_thread" ? target.runOptions() : {}),
          ...options,
          ...(allowOpenItems ? { allowOpenItems } : {}),
        });
      },
    );

  const copyPrompt = (): void => {
    if (!prompt) return;
    void copyTodoMarkdown(prompt).then(() => {
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

  // Under what it opens: the step window when steps are hidden, else the
  // description. Below the whole body it read as the prompt's control.
  const restingToggle = resting.toggleLabel ? (
    <button
      type="button"
      className="thread-todo-card__more"
      aria-expanded={resting.expanded}
      aria-controls={resting.bodyId}
      ref={resting.toggleRef}
      onClick={resting.toggle}
    >
      {resting.expanded ? <ChevronUpIcon size={11} /> : <ChevronDownIcon size={11} />}
      {resting.toggleLabel}
      {resting.toggleDetail ? (
        <span className="thread-todo-card__more-detail">{` ${resting.toggleDetail}`}</span>
      ) : null}
    </button>
  ) : null;

  return (
    <article
      className="thread-todo-card"
      data-kind={todo.kind}
      data-todo-id={todo.id}
      aria-labelledby={titleId}
      onMouseDown={copying.onMouseDown}
      onContextMenu={copying.onContextMenu}
    >
      <ThreadTodoCardHead
        todo={todo}
        titleId={titleId}
        copying={copying}
        onCollapse={props.onCollapse}
        dismissLabel={`Dismiss to-do: ${todo.title}`}
        onDismiss={() => props.onResolve(todo, "dismissed")}
      />
      <ThreadTodoCardMeta
        todo={todo}
        now={props.now}
        progress={progress}
        project={(
          // A review starts on the card's own thread, so it has no project to change.
          <TodoProjectPicker
            todo={todo}
            menu={todo.kind === "review" ? undefined : props.projectMenu}
            disabled={props.running}
          />
        )}
      />

      {todo.detail || progress || prerequisites.length > 0 || hasFacts || prompt || todo.error
        || action?.type === "start_thread" ? (
        <div
          id={resting.bodyId}
          className={`thread-todo-card__body${resting.expanded ? " is-expanded" : ""}`}
        >
          {todo.detail ? (
            <p
              ref={resting.detailRef}
              className={`thread-todo-card__detail${resting.expanded ? "" : " is-clamped"}`}
            >
              {todo.detail}
            </p>
          ) : null}
          {resting.toggleAfter === "detail" ? restingToggle : null}
          {prerequisites.length > 0 ? (
            <>
              <p className="thread-todo-card__group-label" aria-hidden="true">
                Before you start
              </p>
              <ThreadTodoChecklist
                todo={todo}
                label="Before you start"
                items={prerequisites}
                progress={{
                  checked: prerequisites.filter((item) => item.checked).length,
                  total: prerequisites.length,
                }}
                onSetItemChecked={props.onSetItemChecked}
              />
            </>
          ) : null}
          {resting.steps.length > 0 && action?.type === "start_thread" ? (
            <>
              <p className="thread-todo-card__group-label" aria-hidden="true">
                Plan for the new thread
              </p>
              <ThreadTodoPlan items={resting.steps} />
            </>
          ) : resting.steps.length > 0 && progress ? (
            <ThreadTodoChecklist
              todo={todo}
              label="Steps"
              items={resting.steps}
              progress={progress}
              onSetItemChecked={props.onSetItemChecked}
            />
          ) : null}
          {resting.toggleAfter === "steps" ? restingToggle : null}
          {action?.type === "start_thread" ? (
            <TodoDispatchFacts
              todo={todo}
              target={target}
              {...(action.executionMode ? { access: formatExecutionModeLabel(action.executionMode) } : {})}
              disabled={props.running}
            />
          ) : action?.type === "merge_pull_request" ? (
            <dl className="thread-todo-card__facts">
              <div className="thread-todo-card__fact thread-todo-card__fact--pr">
                <dt>PR</dt>
                <dd>
                  <TodoPullRequestChip todo={todo} pullRequest={action.pullRequest} />
                </dd>
              </div>
            </dl>
          ) : null}
          {prompt ? (
            <div className="thread-todo-card__prompt-block">
              <div
                className={`thread-todo-card__prompt${promptExpanded ? " is-expanded" : ""}`}
              >
                <div
                  id={promptId}
                  role="region"
                  aria-label="Proposed prompt"
                  className="thread-todo-card__prompt-text"
                  tabIndex={promptExpanded ? 0 : undefined}
                  inert={!promptExpanded}
                >
                  <ThreadMarkdown text={prompt} variant="summary" />
                </div>
                <button
                  type="button"
                  className="thread-todo-card__more"
                  aria-expanded={promptExpanded}
                  aria-controls={promptId}
                  aria-label={promptExpanded ? "Collapse proposed prompt" : "Show the whole proposed prompt"}
                  onClick={() => setPromptExpanded((current) => !current)}
                >
                  {promptExpanded ? <ChevronUpIcon size={11} /> : <ChevronDownIcon size={11} />}
                  {promptExpanded ? "Show less" : "Show prompt"}
                </button>
              </div>
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
        {props.pager ? <ThreadTodoCardPager pager={props.pager} /> : null}
        <div ref={actionsRef} className="thread-todo-card__actions">{renderAction()}</div>
      </div>
      {copying.menu}
    </article>
  );
}

type TodoCopying = ReturnType<typeof useTodoCopy>;

/**
 * The card's Copy tool and its right-click menu. Both copy the stored card
 * as Markdown, never the DOM, so a resting card's step window does not cut
 * what lands on the clipboard. Any copy flashes the tool's check.
 */
function useTodoCopy(
  todo: ThreadTodo,
  options: { markdown: () => string; copyAllTodos?: readonly ThreadTodo[] },
) {
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<{
    position: ChipContextMenuPosition;
    items: ChipContextMenuItem[];
    returnFocusTo: HTMLElement;
  }>();
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copy = (text: string, markdown = false): void => {
    void (markdown ? copyTodoMarkdown(text) : copyText(text)).then(() => {
      clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
    }).catch((error: unknown) => {
      console.warn("Copying the to-do failed.", error);
    });
  };

  return {
    copied,
    buttonRef,
    copyCard: () => copy(options.markdown(), true),
    /**
     * A right press selects the word under the pointer on macOS, which
     * would replace a selection the operator made in order to copy it.
     */
    onMouseDown: (event: ReactMouseEvent<HTMLElement>): void => {
      if (event.button !== 2 || !inCard(event) || isTextField(event.target)) return;
      event.preventDefault();
    },
    onContextMenu: (event: ReactMouseEvent<HTMLElement>): void => {
      // The project picker's search box keeps the native text menu.
      if (!inCard(event) || isTextField(event.target)) return;
      event.preventDefault();
      const card = event.currentTarget;
      const items: ChipContextMenuItem[] = [];
      const selection = selectedTextWithin(card);
      if (selection) {
        items.push({ label: "Copy selection", action: () => copy(selection) });
      }
      const steps = threadTodoSteps(todo);
      const stepId = event.target instanceof Element
        ? event.target.closest("[data-todo-item-id]")?.getAttribute("data-todo-item-id")
        : undefined;
      // A prerequisite copies as a step too; the counts below are steps only.
      const step = todo.items?.find((item) => item.id === stepId);
      if (step) {
        items.push({ label: "Copy step", action: () => copy(step.text) });
      }
      items.push({
        label: "Copy to-do",
        aside: steps.length > 0 ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}` : undefined,
        separated: items.length > 0,
        action: () => copy(options.markdown(), true),
      });
      const openSteps = steps.filter((item) => !item.checked);
      // With nothing ticked it would copy the same list as Copy to-do.
      if (openSteps.length > 0 && openSteps.length < steps.length) {
        items.push({
          label: "Copy open steps",
          aside: String(openSteps.length),
          action: () => copy(threadTodoStepsMarkdown(openSteps), true),
        });
      }
      const all = options.copyAllTodos;
      if (all && all.length > 1) {
        items.push({
          label: "Copy all to-dos",
          aside: String(all.length),
          action: () => copy(threadTodosMarkdown(all), true),
        });
      }
      setMenu({
        position: { x: event.clientX, y: event.clientY },
        items,
        returnFocusTo: buttonRef.current ?? card,
      });
    },
    menu: menu ? (
      <ChipContextMenu
        items={menu.items}
        position={menu.position}
        returnFocusTo={menu.returnFocusTo}
        onClose={() => setMenu(undefined)}
      />
    ) : null,
  };
}

/**
 * The event happened in the card's own DOM. React bubbles a portal's events
 * through the card too, and the menu is one.
 */
function inCard(event: ReactMouseEvent<HTMLElement>): boolean {
  return event.target instanceof Node && event.currentTarget.contains(event.target);
}

function isTextField(target: EventTarget): boolean {
  return target instanceof Element
    && target.closest("input:not([type='checkbox']), textarea, [contenteditable='true']") !== null;
}

/** Text the operator selected inside the card, when both ends are in it. */
function selectedTextWithin(card: HTMLElement): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return undefined;
  if (!card.contains(selection.anchorNode) || !card.contains(selection.focusNode)) {
    return undefined;
  }
  return selection.toString().trim() || undefined;
}

/**
 * Where a resting card's step window starts: the first open step, moved
 * back so the window stays full near the end of the list.
 */
function restingStepStart(items: ThreadTodoItem[]): number {
  const firstOpen = items.findIndex((item) => !item.checked);
  return Math.max(0, Math.min(firstOpen < 0 ? 0 : firstOpen, items.length - RESTING_STEP_ROWS));
}

/**
 * A card's resting height. Until the operator opens it, the description is
 * clamped to three lines and the checklist shows a window of steps from the
 * first open one; a toggle under those opens the rest. A tick inside
 * the window leaves it in place, so a mis-click can be undone where it
 * happened, and the window moves on once every step in it is checked.
 *
 * A start-thread card's steps are the new thread's plan, which nothing on
 * this card ticks. They stay behind the toggle, which says they are there.
 */
function useRestingCard(todo: ThreadTodo) {
  // Prerequisites always show in full above the window; they are few, and
  // they are what holds the card back.
  const items = threadTodoSteps(todo);
  const plan = todo.action?.type === "start_thread";
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState(() => restingStepStart(items));
  const [detailCut, setDetailCut] = useState(false);
  const detailRef = useRef<HTMLParagraphElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const revealToggleRef = useRef(false);
  const bodyId = useId();

  let start = Math.max(0, Math.min(anchor, items.length - RESTING_STEP_ROWS));
  const inWindow = items.slice(start, start + RESTING_STEP_ROWS);
  if (inWindow.every((item) => item.checked) && items.some((item) => !item.checked)) {
    start = restingStepStart(items);
    if (start !== anchor) setAnchor(start);
  }
  const hiddenSteps = expanded ? 0 : plan ? items.length : Math.max(0, items.length - RESTING_STEP_ROWS);

  // Measured, not guessed from the length: the clamp cuts at the card's
  // width, which the rail and the transcript corner set differently.
  useLayoutEffect(() => {
    const detail = detailRef.current;
    if (expanded || !detail) return;
    const measure = () => setDetailCut(detail.scrollHeight > detail.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(detail);
    return () => observer.disconnect();
  }, [expanded, todo.detail]);

  // Opening grows the text above the toggle, and the body starts at its
  // top. A keyboard user's focus stays on the toggle, so scroll it just
  // into view: in the body, and in the rail panel when the card sits there.
  // Its scroll margin leaves room for the focus ring. A click keeps the top
  // of the text in view instead.
  useLayoutEffect(() => {
    if (!revealToggleRef.current) return;
    revealToggleRef.current = false;
    toggleRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [expanded]);

  const toggleLabel = expanded
    ? "Show less"
    : plan && hiddenSteps > 0
      ? "Show more"
      : hiddenSteps > 0
        ? `Show all ${items.length} steps`
        : detailCut ? "Show more" : undefined;
  const toggleDetail = plan && hiddenSteps > 0 ? `· ${items.length}-step plan` : undefined;
  // Set by the step count alone, not by whether the card is open, so Show
  // less sits where Show more was. A plan opens under the description.
  const toggleAfter: "steps" | "detail" = !plan && items.length > RESTING_STEP_ROWS ? "steps" : "detail";

  return {
    expanded,
    bodyId,
    detailRef,
    steps: expanded ? items : plan ? [] : items.slice(start, start + RESTING_STEP_ROWS),
    toggleLabel,
    toggleDetail,
    toggleAfter,
    toggleRef,
    toggle: (event: ReactMouseEvent<HTMLButtonElement>) => {
      // Enter and Space dispatch a click with no pointer presses.
      revealToggleRef.current = event.detail === 0;
      setExpanded((current) => !current);
    },
  };
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
  /** The list's accessible name, before its count. */
  label: string;
  items: ThreadTodoItem[];
  progress: { checked: number; total: number };
  onSetItemChecked: ThreadTodoCardHandlers["onSetItemChecked"];
}) {
  const { todo, onSetItemChecked } = props;
  return (
    <ul
      className="thread-todo-checklist"
      aria-label={`${props.label}, ${props.progress.checked} of ${props.progress.total} checked`}
    >
      {props.items.map((item) => (
        <li key={item.id} className="thread-todo-checklist__item" data-todo-item-id={item.id}>
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

/**
 * A start-thread card's steps: the plan the new thread is asked to carry
 * out. The start sends only the prompt, so nothing here can be ticked.
 */
function ThreadTodoPlan(props: { items: ThreadTodoItem[] }) {
  return (
    <ol className="thread-todo-plan" aria-label="Plan for the new thread">
      {props.items.map((item) => (
        <li key={item.id} className="thread-todo-plan__step" data-todo-item-id={item.id}>
          {item.text}
        </li>
      ))}
    </ol>
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

export function formatTodoAge(createdAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
