import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadTodo, ThreadTodoCiApproval, ThreadTodoResolution } from "@pwragent/shared/contracts/thread-todos";
import { threadTodoItemProgress, threadTodoStartActionForRun } from "@pwragent/shared/contracts/thread-todos";
import { TodoIcon } from "../../icons";
import { ThreadTodoCard } from "./ThreadTodoCard";
import { consumeThreadTodoReveal, type ThreadTodoRevealRequest } from "./thread-todo-reveal";
import {
  dismissThreadTodoLaunch,
  followDeckSelection,
  launchThreadTodo,
  showStartingThreadTodoCard,
  type ThreadTodoLaunch,
  useThreadTodoLaunches,
} from "./thread-todo-launches";
import { ThreadTodoLaunchTray } from "./ThreadTodoLaunchTray";
import type {
  ThreadTodoDoHereOptions,
  ThreadTodoResolveOptions,
  ThreadTodoRunOptions,
  ThreadTodosView,
} from "./thread-todos-view";

const RESOLVED_NOTICE_MS = 4_000;
/** The started card's flight from the deck into its tray row. */
const LAUNCH_FLIGHT_MS = 280;

/** A started card in flight: where it left the deck, and its title. */
type LaunchFlight = { id: string; title: string; from: DOMRect };

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function focusLaunchAction(row: HTMLElement | undefined): boolean {
  if (!row || row.classList.contains("is-landing")) return false;
  const button = row.querySelector<HTMLButtonElement>("button:not(:disabled)");
  if (!button) return false;
  button.focus();
  return button.ownerDocument.activeElement === button;
}

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
  /** Where focus goes when a close leaves neither a deck nor a tray action. */
  onFocusTranscript?: () => void;
};

/**
 * The focused thread's open to-dos, as one card with a pager, in the top
 * right of the transcript. It pages like the notice toast; collapsing it
 * leaves a count chip in the same corner.
 */
export function ThreadTodoStack(props: ThreadTodoStackProps) {
  const { threadKey, view, onFocusTranscript } = props;
  const [selectedId, setSelectedId] = useState<string>();
  const { launches, returnedIds } = useThreadTodoLaunches(threadKey);
  // A started card is in the tray, not the deck, until its row is closed.
  const todos = launches.length === 0
    ? props.todos
    : props.todos.filter((entry) => !launches.some((launch) => launch.id === entry.id));
  const [flight, setFlight] = useState<LaunchFlight>();
  const [risingId, setRisingId] = useState<string>();
  const sectionRef = useRef<HTMLElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const detachedCardFocusRef = useRef<{ threadKey: string; id: string; card: HTMLElement }>(undefined);
  const chipRef = useRef<HTMLButtonElement>(null);
  const launchFocusRef = useRef<{ threadKey: string; closedRowIndex?: number }>(undefined);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [, setCollapseVersion] = useState(0);
  const [notice, setNotice] = useState<ResolvedNotice>();
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(noticeTimerRef.current), []);
  useEffect(() => {
    clearTimeout(noticeTimerRef.current);
    setNotice(undefined);
    setSelectedId(undefined);
    setFlight(undefined);
    setRisingId(undefined);
  }, [threadKey]);
  // Collapse state is per thread, so a request waits until its thread is
  // the one on screen.
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

  // The deck as last shown, so a card that leaves it hands its place to
  // the card after it rather than to the first card.
  const deckIds = todos.map((entry) => entry.id);
  const deckKey = deckIds.join("\n");
  const previousDeckRef = useRef<readonly string[]>(deckIds);
  const shownId = followDeckSelection(previousDeckRef.current, deckIds, selectedId);
  useEffect(() => {
    previousDeckRef.current = deckKey ? deckKey.split("\n") : [];
    // Keep the followed card, so the next change follows from it.
    if (shownId !== selectedId) setSelectedId(shownId);
  }, [deckKey, shownId, selectedId]);
  const selectedIndex = Math.max(
    0,
    todos.findIndex((todo) => todo.id === shownId),
  );
  const todo = todos[selectedIndex];
  const returnedId = todo && returnedIds.has(todo.id) ? todo.id : undefined;
  const setCardRef = useCallback((card: HTMLElement | null) => {
    const previous = cardRef.current;
    // Ref detachment runs before Chromium clears focus from the removed card.
    if (!card && returnedId && previous?.contains(previous.ownerDocument.activeElement)) {
      detachedCardFocusRef.current = { threadKey, id: returnedId, card: previous };
    }
    cardRef.current = card;
  }, [returnedId, threadKey]);

  // Read both the explicit tray action and any focused pending card removed
  // in this commit. The owner can remove a card from the open list before
  // the run reply arrives, so use the deck fallback if its row is absent.
  useLayoutEffect(() => {
    const requested = launchFocusRef.current;
    launchFocusRef.current = undefined;
    const focus = requested?.threadKey === threadKey ? requested : undefined;
    const detached = detachedCardFocusRef.current;
    detachedCardFocusRef.current = undefined;
    const removedId = detached?.threadKey === threadKey && !detached.card.isConnected
      && detached.card.ownerDocument.activeElement === detached.card.ownerDocument.body
      && !deckIds.includes(detached.id) ? detached.id : undefined;
    if (!focus && !removedId) return;

    const rows = Array.from(sectionRef.current?.querySelectorAll<HTMLElement>("[data-launch-id]") ?? []);
    if (focus?.closedRowIndex !== undefined) {
      const next = rows.slice(focus.closedRowIndex);
      const previous = rows.slice(0, focus.closedRowIndex).reverse();
      if ([...next, ...previous].some(focusLaunchAction)) return;
    } else if (!focus && removedId) {
      const row = rows.find((entry) => entry.dataset.launchId === removedId);
      if (focusLaunchAction(row)) return;
    }
    const card = cardRef.current;
    const primary = card?.querySelector<HTMLButtonElement>(
      "button:is(.todo-split__primary, .button--primary):not(:disabled)",
    );
    const target = primary ?? card ?? chipRef.current;
    if (target) target.focus();
    else onFocusTranscript?.();
  });

  // The ghost runs from the card's box to its new tray row's box.
  useLayoutEffect(() => {
    if (!flight) return;
    const ghost = ghostRef.current;
    const section = sectionRef.current;
    const row = section
      ? Array.from(section.querySelectorAll<HTMLElement>("[data-launch-id]"))
        .find((element) => element.dataset.launchId === flight.id)
      : undefined;
    if (!ghost || !section || !row || typeof ghost.animate !== "function") {
      setFlight(undefined);
      return;
    }
    const base = section.getBoundingClientRect();
    const to = row.getBoundingClientRect();
    const box = (rect: DOMRect) => ({
      top: `${rect.top - base.top}px`,
      left: `${rect.left - base.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    const animation = ghost.animate(
      [{ ...box(flight.from), opacity: 1 }, { ...box(to), opacity: 0.4 }],
      { duration: LAUNCH_FLIGHT_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" },
    );
    animation.onfinish = () => setFlight(undefined);
    return () => animation.cancel();
  }, [flight]);

  if (!todo && !notice && launches.length === 0) return null;

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
    // A start leaves the deck at once and reports in the tray, so the
    // operator can go on to the card under it while setup runs.
    if (threadTodoStartActionForRun(target.action, options)) {
      void launchThreadTodo({ todo: target, threadKey }, (begin) => view.run(target, options, {
        // After a Full Access prompt this runs later, so it reads the deck
        // as committed then, not as it was at the click.
        onBegin: () => {
          const shown = previousDeckRef.current;
          if (shown.includes(target.id)) {
            const next = followDeckSelection(shown, shown.filter((id) => id !== target.id), target.id);
            setSelectedId(next);
            setRisingId(next);
            const from = deckRef.current?.getBoundingClientRect();
            setFlight(from && !prefersReducedMotion() ? { id: target.id, title: target.title, from } : undefined);
          }
          begin();
        },
      }));
      return;
    }
    void view.run(target, options).then((ended) => {
      if (ended?.status === "done" && ended.result) {
        showNotice({ todo: ended, text: ended.result, undoable: false });
      }
    }).catch((error: unknown) => {
      showNotice({ todo: target, text: String(error), undoable: false });
    });
  };
  // GitHub's refusal stays on the card; a refusal before GitHub is asked is shown here.
  const reviewCiDeployment = view.reviewCiDeployment
    ? (target: ThreadTodo, approval: ThreadTodoCiApproval): void => {
        void view.reviewCiDeployment?.(target, approval).then((ended) => {
          if (ended?.status === "done" && ended.result) {
            showNotice({ todo: ended, text: ended.result, undoable: false });
          }
        }).catch((error: unknown) => {
          showNotice({ todo: target, text: String(error), undoable: false });
        });
      }
    : undefined;
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
  const returnCard = (launch: ThreadTodoLaunch): void => {
    launchFocusRef.current = { threadKey };
    collapsedIdsByThreadKey.delete(threadKey);
    setRisingId(launch.id);
    setSelectedId(launch.id);
    if (launch.phase === "starting") showStartingThreadTodoCard(launch.id);
    else dismissThreadTodoLaunch(launch.id);
  };
  const tray = launches.length > 0 ? (
    <ThreadTodoLaunchTray
      launches={launches}
      {...(flight ? { landingId: flight.id } : {})}
      onOpenThread={view.openStartedThread}
      onReturnCard={returnCard}
      onClose={(launch) => {
        if (launch.phase === "failed") {
          returnCard(launch);
          return;
        }
        launchFocusRef.current = {
          threadKey,
          closedRowIndex: launches.indexOf(launch),
        };
        dismissThreadTodoLaunch(launch.id);
      }}
    />
  ) : null;

  if (collapsed && todo) {
    const count = todos.length;
    // A lone collapsed card keeps its checklist progress in view; across
    // several cards one fraction would not say whose it is.
    const progress = count === 1 ? threadTodoItemProgress(todo) : undefined;
    return (
      <section ref={sectionRef} className={className} aria-label="To-dos for this thread">
        <button
          ref={chipRef}
          type="button"
          className="thread-todo-stack__chip"
          aria-expanded={false}
          aria-label={`Show to-dos: ${count} open${
            progress ? `, ${progress.checked} of ${progress.total} ${progress.noun} checked` : ""
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
        {tray}
      </section>
    );
  }

  return (
    <section ref={sectionRef} className={className} aria-label="To-dos for this thread">
      {todo ? (
        <div
          ref={deckRef}
          className="thread-todo-stack__deck"
          data-depth={Math.min(todos.length - 1, 2)}
        >
          <div
            key={todo.id}
            className={`thread-todo-stack__card${todo.id === risingId ? " is-rising" : ""}`}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) setRisingId(undefined);
            }}
          >
            <ThreadTodoCard
              cardRef={setCardRef}
              todo={todo}
              running={returnedId !== undefined || view.runningIds.has(todo.id)}
              threadRunning={props.threadRunning}
              copyAllTodos={todos}
              pager={{
                position: selectedIndex + 1,
                total: todos.length,
                onPrevious: () => {
                  setRisingId(undefined);
                  setSelectedId(todos[selectedIndex - 1]?.id);
                },
                onNext: () => {
                  setRisingId(undefined);
                  setSelectedId(todos[selectedIndex + 1]?.id);
                },
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
              {...(reviewCiDeployment ? { onReviewCiDeployment: reviewCiDeployment } : {})}
              onStartReview={props.onStartReview}
              onShowReview={view.openReview}
              onDoHere={doHere}
              onSetItemChecked={(target, item, checked) => {
                void view.setItemChecked(target, item.id, checked).catch((error: unknown) => {
                  showNotice({ todo: target, text: String(error), undoable: false });
                });
              }}
            />
          </div>
        </div>
      ) : null}
      {tray}
      {flight ? (
        <div ref={ghostRef} className="thread-todo-stack__flight" aria-hidden="true">
          <span className="thread-todo-stack__flight-title">{flight.title}</span>
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
