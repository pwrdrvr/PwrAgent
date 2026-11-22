import { useEffect, useRef, useState, type FocusEvent } from "react";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { BanIcon, CheckIcon, CloseIcon, InfoIcon } from "../../icons";
import { PendingSpinner } from "../../components/PendingSpinner";
import { dismissThreadTodoLaunch, type ThreadTodoLaunch } from "./thread-todo-launches";

/** How long a successful start stays in the tray, while nothing pauses it. */
export const THREAD_TODO_LAUNCH_DISMISS_MS = 6_000;

export type ThreadTodoLaunchTrayProps = {
  launches: readonly ThreadTodoLaunch[];
  onOpenThread: (todo: ThreadTodo) => void;
  /** Returns a failed card to the top of the deck. */
  onReview: (id: string) => void;
  /** The row a started card is still flying into; it shows once the card lands. */
  landingId?: string;
};

/**
 * Starts the operator sent from the stack, below the deck. A success leaves
 * after a countdown that pointer or focus pauses; a failure stays until the
 * operator closes it or reviews the card.
 */
export function ThreadTodoLaunchTray(props: ThreadTodoLaunchTrayProps) {
  const [paused, setPaused] = useState(false);
  if (props.launches.length === 0) return null;
  const leave = (event: FocusEvent<HTMLElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
  };
  return (
    <section
      className="thread-todo-launches"
      aria-label="Started to-dos"
      data-paused={paused || undefined}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
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
            onReview={props.onReview}
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
  onReview: (id: string) => void;
}) {
  const { launch } = props;
  const elapsed = useElapsedSeconds(launch.phase === "starting" ? launch.startedAt : undefined);
  useDismissCountdown(launch.id, launch.phase === "started", props.paused);
  const started = launch.todo.startedThread;
  const state = launch.phase === "starting" ? "Starting…"
    : launch.phase === "started" ? (started?.instanceLabel ? `Started on ${started.instanceLabel}` : "Started")
    : launch.phase === "setup_failed" ? "Started · setup failed"
    : "Could not start";
  return (
    <li
      className={`thread-todo-launches__row is-${launch.phase.replace("_", "-")}${props.landing ? " is-landing" : ""}`}
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
        {launch.phase === "failed" ? (
          <button
            type="button"
            className="thread-todo-launches__button"
            aria-label={`Review card: ${launch.title}`}
            onClick={() => props.onReview(launch.id)}
          >
            Review card
          </button>
        ) : null}
        {launch.phase !== "starting" ? (
          <button
            type="button"
            className="thread-todo-launches__close"
            aria-label={`Close: ${launch.title}`}
            onClick={() => (launch.phase === "failed" ? props.onReview(launch.id) : dismissThreadTodoLaunch(launch.id))}
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

/** Whole seconds since `since`, ticking once a second while it is set. */
function useElapsedSeconds(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1_000));
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
