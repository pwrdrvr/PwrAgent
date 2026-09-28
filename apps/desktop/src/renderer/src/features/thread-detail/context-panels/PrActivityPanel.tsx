import { useCallback, useEffect, useState } from "react";
import {
  parseThreadIdentityKey,
  type NavigationThreadSummary,
  type PrActivityEvent,
  type PrActivitySnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { useThreadLinks } from "../../../lib/thread-links";
import { RailStatusChip } from "./RailStatusChip";

type ActivityView = "thread" | "all" | "budget";

const VIEWS: Array<{ id: ActivityView; label: string }> = [
  { id: "thread", label: "This thread" },
  { id: "all", label: "All threads" },
  { id: "budget", label: "Budget" },
];

const MAX_ROWS = 200;

/**
 * PR activity tab: why Auto-fix did or did not repair a PR. The order is the
 * operator's question order: is anything stopped (status chips + the pause
 * callout), how much budget is left, then the timeline. The history is the
 * main process's in-memory journal, so nothing here writes SQLite.
 */
export function PrActivityPanel({ desktopApi, thread }: {
  desktopApi?: Pick<DesktopApi, "getPrActivity" | "resumePrAutoDispatchBudget">;
  thread?: NavigationThreadSummary;
}) {
  const [snapshot, setSnapshot] = useState<PrActivitySnapshot>();
  const [view, setView] = useState<ActivityView>("thread");
  const [error, setError] = useState(false);
  const [beforeEvent, setBeforeEvent] = useState<PrActivityEvent>();
  const [resuming, setResuming] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const remote = Boolean(thread?.federation?.ref.target ?? readRendererFederationTarget());
  const getActivity = desktopApi?.getPrActivity;
  const resumeBudget = desktopApi?.resumePrAutoDispatchBudget;
  useEffect(() => {
    if (remote || !getActivity) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        const result = await getActivity();
        if (!disposed) { setSnapshot(result); setError(false); }
      } catch {
        if (!disposed) setError(true);
      } finally {
        if (!disposed) timer = setTimeout(() => { void refresh(); }, 5_000);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [getActivity, remote, refreshToken]);

  const showBudgetBefore = useCallback((event: PrActivityEvent | undefined) => {
    setView("budget");
    setBeforeEvent(event);
  }, []);
  const selectView = (next: ActivityView): void => {
    setView(next);
    setBeforeEvent(undefined);
  };
  const resume = (): void => {
    if (!resumeBudget) return;
    setResuming(true);
    void resumeBudget()
      .catch(() => undefined)
      .finally(() => {
        setResuming(false);
        setRefreshToken((token) => token + 1);
      });
  };

  if (remote) {
    return (
      <section className="context-panel__section pr-activity">
        <h3>PR activity</h3>
        <p className="context-empty">PR activity is recorded on the instance that owns this thread.</p>
      </section>
    );
  }
  if (!getActivity) {
    return (
      <section className="context-panel__section pr-activity">
        <h3>PR activity</h3>
        <p className="context-empty">PR activity is unavailable in this window.</p>
      </section>
    );
  }

  const threadKey = thread ? `${thread.source}:${thread.id}` : undefined;
  const events = snapshot?.events.filter((event) => {
    if (view === "budget") {
      return event.category === "budget" && (!beforeEvent || event.id < beforeEvent.id);
    }
    // Every PR check spends a request; those admissions are ledger entries
    // and only drown the decisions out of the timeline.
    if (isRoutineAdmission(event)) return false;
    return view === "all" || (threadKey !== undefined && event.threadKeys.includes(threadKey));
  }) ?? [];
  const monitoring = snapshot?.monitoring;
  const latestRepairBalance = snapshot?.events.find((event) =>
    event.budget === "repair" && event.availableTokens !== undefined
  );
  const latestPollingBalance = snapshot?.events.find((event) =>
    event.budget === "polling" && event.availableTokens !== undefined
  );
  const pollingAvailable = monitoring?.pollingBudget?.availableTokens
    ?? latestPollingBalance?.availableTokens;
  const latestBlock = snapshot?.events.find(isBudgetBlock);
  const pausedNotice = monitoring?.autoFixAllowed === true && monitoring.repairBudgetPaused;
  const threadAutoFixOff = thread !== undefined && thread.prAutoDispatchEnabled !== true;

  return (
    <section className="context-panel__section pr-activity">
      <h3>PR activity</h3>
      {monitoring ? (
        <p className="rail-card__status-line">
          <RailStatusChip tone={monitoring.backgroundPollingEnabled ? "ok" : "neutral"}>
            {monitoring.backgroundPollingEnabled ? "Checks on" : "Checks off"}
          </RailStatusChip>
          {!monitoring.autoFixAllowed ? (
            <RailStatusChip tone="neutral">Auto-fix off</RailStatusChip>
          ) : monitoring.repairBudgetPaused ? (
            <RailStatusChip tone="warning">Auto-fix paused</RailStatusChip>
          ) : threadAutoFixOff ? (
            <RailStatusChip tone="neutral">Auto-fix off for this thread</RailStatusChip>
          ) : (
            <RailStatusChip tone="ok">Auto-fix on</RailStatusChip>
          )}
        </p>
      ) : null}
      {pausedNotice ? (
        <div className="pr-activity__notice" role="status">
          <p className="pr-activity__notice-title">Auto-fix PR is paused</p>
          <p className="pr-activity__notice-body">
            The repair budget ran out. Thread settings are unchanged, and repairs stay budget-gated after you resume.
          </p>
          <div className="pr-activity__notice-actions">
            {resumeBudget ? (
              <button
                className="button button--primary pr-activity__notice-button"
                disabled={resuming}
                type="button"
                onClick={resume}
              >
                {resuming ? "Resuming…" : "Resume"}
              </button>
            ) : null}
            <button
              className="pr-activity__link"
              type="button"
              onClick={() => showBudgetBefore(latestBlock)}
            >
              What used the budget?
            </button>
          </div>
        </div>
      ) : null}
      {snapshot ? (
        <div className="pr-activity__budget-card">
          <dl className="pr-activity__budgets">
            <BudgetRow
              available={pollingAvailable}
              capacity={monitoring?.pollingBudget?.capacity}
              label="PR checks"
            />
            <BudgetRow
              available={latestRepairBalance?.availableTokens}
              capacity={monitoring?.repairBudget?.capacity}
              label="Repairs"
            />
          </dl>
          <p className="pr-activity__budget-note">
            Shared by every thread.
            {latestRepairBalance
              ? ` Repairs as of ${formatEventTime(latestRepairBalance.occurredAt)}.`
              : " No repair recorded since startup."}
          </p>
        </div>
      ) : null}
      <div className="pr-activity__views" role="group" aria-label="Activity view">
        {VIEWS.map((option) => (
          <button
            aria-pressed={view === option.id}
            className="pr-activity__view"
            key={option.id}
            type="button"
            onClick={() => selectView(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {view === "budget" && beforeEvent ? (
        <p className="pr-activity__filter">
          <span>Before <b>{formatEventTime(beforeEvent.occurredAt)}</b></span>
          <button
            aria-label="Show the latest budget activity"
            className="pr-activity__filter-clear"
            type="button"
            onClick={() => setBeforeEvent(undefined)}
          >
            ×
          </button>
        </p>
      ) : null}
      {error ? <p className="context-empty" role="status">Could not refresh activity. Retrying…</p> : null}
      {!snapshot && !error ? <p className="context-empty" role="status">Loading activity…</p> : null}
      {snapshot && events.length === 0 ? (
        <p className="context-empty">{emptyMessage(view, beforeEvent !== undefined, snapshot.startedAt)}</p>
      ) : null}
      {events.length > 0 ? (
        <ol className="pr-activity__events">
          {events.slice(0, MAX_ROWS).map((event) => (
            <ActivityRow
              event={event}
              key={event.id}
              quiet={view === "budget"}
              showThreads={view !== "thread"}
              traceable={isBudgetBlock(event) && !(pausedNotice && event.id === latestBlock?.id)}
              onShowBudgetBefore={showBudgetBefore}
            />
          ))}
        </ol>
      ) : null}
      {snapshot ? (
        <p className="pr-activity__footnote">
          This PwrAgent instance · since {formatEventTime(snapshot.startedAt)} · newest 2,000 events
          {snapshot.droppedEvents > 0
            ? ` · ${snapshot.droppedEvents.toLocaleString()} older not kept`
            : ""}
          {events.length > MAX_ROWS ? ` · showing the latest ${MAX_ROWS}` : ""}
        </p>
      ) : null}
    </section>
  );
}

function BudgetRow(props: { available?: number; capacity?: number; label: string }) {
  const { available, capacity } = props;
  const fraction = available !== undefined && capacity
    ? Math.max(0, Math.min(1, available / capacity))
    : undefined;
  return (
    <div className="pr-activity__budget">
      <dt>{props.label}</dt>
      <dd>
        <span className="pr-activity__meter" aria-hidden="true">
          {fraction !== undefined ? (
            <span
              className={`pr-activity__meter-fill${fraction === 0 ? " is-empty" : ""}`}
              style={{ width: `${fraction * 100}%` }}
            />
          ) : null}
        </span>
        <span className={`pr-activity__count${available === 0 ? " is-empty" : ""}`}>
          {available ?? "—"}
          {capacity !== undefined ? <small>/{capacity}</small> : null}
        </span>
      </dd>
    </div>
  );
}

function ActivityRow(props: {
  event: PrActivityEvent;
  quiet: boolean;
  showThreads: boolean;
  /** A budget block whose cause the pause callout does not already trace. */
  traceable: boolean;
  onShowBudgetBefore: (event: PrActivityEvent) => void;
}) {
  const { event } = props;
  const occurredAt = new Date(event.occurredAt);
  return (
    <li
      className={`pr-activity__event pr-activity__event--${event.tone ?? "neutral"}${
        props.quiet ? " is-quiet" : ""
      }`}
    >
      <span className="pr-activity__dot" aria-hidden="true" />
      <div className="pr-activity__event-body">
        <p className="pr-activity__message">{event.message}</p>
        <p className="pr-activity__meta">
          {event.prKeys.map((key) => (
            <span className="pr-activity__pr" key={key} title={key}>
              {formatPrKey(key, props.showThreads)}
            </span>
          ))}
          {props.quiet ? null : <span>{formatSource(event.source)}</span>}
          {event.budget ? <BudgetDelta event={event} /> : null}
        </p>
        {props.showThreads && event.threadKeys.length > 0 ? (
          <p className="pr-activity__meta pr-activity__threads">
            {event.threadKeys.map((key) => <ActivityThread key={key} threadKey={key} />)}
          </p>
        ) : null}
        {props.traceable && !props.quiet ? (
          <button
            className="pr-activity__link"
            type="button"
            onClick={() => props.onShowBudgetBefore(event)}
          >
            What used it?
          </button>
        ) : null}
      </div>
      <time
        className="pr-activity__time"
        dateTime={occurredAt.toISOString()}
        title={occurredAt.toLocaleString()}
      >
        {formatEventTime(event.occurredAt)}
      </time>
    </li>
  );
}

function BudgetDelta({ event }: { event: PrActivityEvent }) {
  const delta = event.delta ?? 0;
  const left = event.availableTokens !== undefined ? `${event.availableTokens} left` : undefined;
  // A block without a recorded balance says everything in its message.
  if (delta === 0 && !left) return null;
  const label = delta === 0
    ? left
    : [`${delta > 0 ? "+" : "−"}${Math.abs(delta)}`, left].filter(Boolean).join(" · ");
  const unit = event.budget === "repair" ? "repair" : "PR check";
  return (
    <span
      className={`pr-activity__delta${delta > 0 ? " is-refund" : delta === 0 ? " is-blocked" : ""}`}
      title={`${unit} budget`}
    >
      {label}
    </span>
  );
}

/**
 * A quiet text link rather than `ThreadChip`: across threads the same thread
 * repeats on most rows, and a filled chip per row outweighs the event itself.
 */
function ActivityThread({ threadKey }: { threadKey: string }) {
  const threadLinks = useThreadLinks();
  const identity = parseThreadIdentityKey(threadKey);
  const link = identity
    ? threadLinks?.resolve({ backend: identity.backend, threadId: identity.threadId })
    : undefined;
  const title = link?.title.trim();
  if (link && threadLinks && title) {
    return (
      <button
        className="pr-activity__thread-link"
        title={`${title}\nOpen thread`}
        type="button"
        onClick={() => threadLinks.show(link)}
      >
        {title}
      </button>
    );
  }
  return <span className="pr-activity__thread" title={threadKey}>Thread not in this window</span>;
}

function isRoutineAdmission(event: PrActivityEvent): boolean {
  return event.budget === "polling" && (event.delta ?? 0) < 0;
}

function isBudgetBlock(event: PrActivityEvent): boolean {
  return event.budget === "repair" && event.delta === 0;
}

/** `github.com/acme/widgets#128` → `#128`, or `acme/widgets#128` across threads. */
function formatPrKey(key: string, withRepository: boolean): string {
  const hash = key.lastIndexOf("#");
  if (hash < 0) return key;
  const number = key.slice(hash);
  if (!withRepository) return number;
  const segments = key.slice(0, hash).split("/");
  return `${segments.slice(-2).join("/")}${number}`;
}

const SOURCE_LABELS: Record<string, string> = {
  "thread lookup (user)": "Refresh",
  "thread lookup (scheduled)": "Scheduled check",
  "thread lookup (post-turn)": "After turn",
  "background poll": "Background check",
};

function formatSource(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Clock time today; other days carry the date, since history spans uptime. */
function formatEventTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function emptyMessage(view: ActivityView, filtered: boolean, startedAt: number): string {
  const since = formatEventTime(startedAt);
  if (view === "budget") {
    return filtered ? "No budget use before this block." : `No budget use since ${since}.`;
  }
  return view === "thread"
    ? `No PR checks or Auto-fix decisions for this thread since ${since}.`
    : `No PR checks or Auto-fix decisions since ${since}.`;
}
