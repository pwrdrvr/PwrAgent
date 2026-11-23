import { useEffect, useRef, useState, type FocusEvent } from "react";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { BanIcon, CheckIcon, CloseIcon, InfoIcon } from "../../icons";
import { PendingSpinner } from "../../components/PendingSpinner";
import { useNowWhileActive } from "../thread-detail/context-panels/RailCardTiming";
import { dismissThreadTodoLaunch, type ThreadTodoLaunch } from "./thread-todo-launches";

/** How long a successful start stays in the tray, while nothing pauses it. */
export const THREAD_TODO_LAUNCH_DISMISS_MS = 6_000;
/** The arrival wash's length; a row older than this is not new on mount. */
const ARRIVE_MS = 600;
const SHOW_CARD_AFTER_SECONDS = 60;

export type ThreadTodoLaunchTrayProps = {
  launches: readonly ThreadTodoLaunch[];
  onOpenThread: (todo: ThreadTodo) => void;
  onReturnCard: (launch: ThreadTodoLaunch) => void;
  onClose: (launch: ThreadTodoLaunch) => void;
  /** The row a started card is still flying into; it shows once the card lands. */
  landingId?: string;
};

/**
 * Starts the operator sent from the stack, below the deck. A success leaves
 * after a countdown that pointer or focus pauses; a failure stays until the
 * operator closes it or reviews the card.
 */
export function ThreadTodoLaunchTray(props: ThreadTodoLaunchTrayProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  // A focused row that leaves takes focus to the body without a blur here,
  // which would hold every countdown paused.
  useEffect(() => {
    if (focused && !sectionRef.current?.contains(document.activeElement)) setFocused(false);
  }, [focused, props.launches]);
  if (props.launches.length === 0) return null;
  const paused = hovered || focused;
  const leave = (event: FocusEvent<HTMLElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  };
  return (
    <section
      ref={sectionRef}
      className="thread-todo-launches"
      aria-label="Started to-dos"
      data-paused={paused || undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={leave}
    >
      <ul className="thread-todo-launches__list" aria-live="polite">
        {props.launches.map((launch) => (
          <ThreadTodoLaunchRow
            key={launch.id}
            launch={launch}
            landing={launch.id === props.landingId}
            paused={paused}
            onOpenThread={props.onOpenThread}
            onReturnCard={props.onReturnCard}
            onClose={props.onClose}
          />
        ))}
      </ul>
    </section>
  );
}

function ThreadTodoLaunchRow(props: {
  launch: ThreadTodoLaunch;
  landing: boolean;
  paused: boolean;
  onOpenThread: (todo: ThreadTodo) => void;
  onReturnCard: ThreadTodoLaunchTrayProps["onReturnCard"];
  onClose: ThreadTodoLaunchTrayProps["onClose"];
}) {
  const { launch } = props;
  const now = useNowWhileActive(launch.phase === "starting");
  const elapsed = Math.max(0, Math.floor((now - launch.startedAt) / 1_000));
  // Only a row that just arrived washes in; one shown again after a thread
  // switch does not.
  const [arriving] = useState(() => Date.now() - launch.startedAt < ARRIVE_MS);
  useDismissCountdown(launch.id, launch.phase === "started", props.paused);
  const started = launch.todo.startedThread;
  const state = launch.phase === "starting" ? "Starting…"
    : launch.phase === "started" ? (started?.instanceLabel ? `Started on ${started.instanceLabel}` : "Started")
    : launch.phase === "setup_failed" ? "Started · setup failed"
    : "Could not start";
  const returnLabel = launch.phase === "failed" ? "Review card"
    : launch.phase === "starting" && elapsed >= SHOW_CARD_AFTER_SECONDS ? "Show card"
    : undefined;
  return (
    <li
      className={`thread-todo-launches__row is-${launch.phase.replace("_", "-")}${
        arriving ? " is-arriving" : ""}${props.landing ? " is-landing" : ""}`}
      data-launch-id={launch.id}
    >
      <span className="thread-todo-launches__glyph" aria-hidden="true">
        {launch.phase === "starting" ? <PendingSpinner pairing="paired" size="sm" />
          : launch.phase === "started" ? <CheckIcon size={13} />
          : launch.phase === "setup_failed" ? <InfoIcon size={13} />
          : <BanIcon size={13} />}
      </span>
      <span className="thread-todo-launches__main">
        <span className="thread-todo-launches__title">{launch.title}</span>
        <span className="thread-todo-launches__state">
          {state}
          {launch.phase === "starting" ? <span aria-hidden="true"> {elapsed}s</span> : null}
        </span>
        {launch.message ? <span className="thread-todo-launches__message">{launch.message}</span> : null}
      </span>
      <span className="thread-todo-launches__actions">
        {launch.phase !== "starting" && launch.phase !== "failed" && started ? (
          <button
            type="button"
            className="thread-todo-launches__button"
            aria-label={`Open thread: ${launch.title}`}
            onClick={() => props.onOpenThread(launch.todo)}
          >
            Open thread
          </button>
        ) : null}
        {returnLabel ? (
          <button
            type="button"
            className="thread-todo-launches__button"
            aria-label={`${returnLabel}: ${launch.title}`}
            onClick={() => props.onReturnCard(launch)}
          >
            {returnLabel}
          </button>
        ) : null}
        {launch.phase !== "starting" ? (
          <button
            type="button"
            className="thread-todo-launches__close"
            aria-label={`Close: ${launch.title}`}
            onClick={() => props.onClose(launch)}
          >
            <CloseIcon size={12} />
          </button>
        ) : null}
      </span>
      {launch.phase === "started" ? (
        <span
          className="thread-todo-launches__countdown"
          style={{ animationDuration: `${THREAD_TODO_LAUNCH_DISMISS_MS}ms` }}
          aria-hidden="true"
        />
      ) : null}
    </li>
  );
}

/** Closes a successful row once its time is up, keeping what is left across pauses. */
function useDismissCountdown(id: string, active: boolean, paused: boolean): void {
  const remaining = useRef(THREAD_TODO_LAUNCH_DISMISS_MS);
  useEffect(() => {
    if (!active || paused) return;
    const began = Date.now();
    const timer = setTimeout(() => dismissThreadTodoLaunch(id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - began));
    };
  }, [id, active, paused]);
}
