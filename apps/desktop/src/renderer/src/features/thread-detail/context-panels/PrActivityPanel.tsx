import { useEffect, useState } from "react";
import type { NavigationThreadSummary, PrActivityEvent, PrActivitySnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { readRendererFederationTarget } from "../../../lib/federation-window";

export function PrActivityPanel({ desktopApi, thread }: {
  desktopApi?: Pick<DesktopApi, "getPrActivity">;
  thread?: NavigationThreadSummary;
}) {
  const [snapshot, setSnapshot] = useState<PrActivitySnapshot>();
  const [scope, setScope] = useState<"thread" | "all">("thread");
  const [budgetOnly, setBudgetOnly] = useState(false);
  const [error, setError] = useState(false);
  const [beforeEvent, setBeforeEvent] = useState<PrActivityEvent>();
  const remote = Boolean(thread?.federation?.ref.target ?? readRendererFederationTarget());
  const getActivity = desktopApi?.getPrActivity;
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
  }, [getActivity, remote]);

  const threadKey = thread ? `${thread.source}:${thread.id}` : undefined;
  const events = snapshot?.events.filter((event) =>
    (scope === "all" || (threadKey !== undefined && event.threadKeys.includes(threadKey)))
    && (!budgetOnly || event.category === "budget")
    && (!beforeEvent || event.id < beforeEvent.id)
  ) ?? [];
  const latestBudget = (kind: "polling" | "repair"): PrActivityEvent | undefined =>
    snapshot?.events.find((event) => event.budget === kind);

  return (
    <section className="context-panel__section pr-activity">
      <h3>PR activity</h3>
      {remote ? <p>Activity is available on the instance that owns this thread.</p> : !getActivity ? (
        <p>PR activity is unavailable in this window.</p>
      ) : <>
        {snapshot?.monitoring ? <p className="pr-activity__status">
          {!snapshot.monitoring.backgroundPollingEnabled ? "Background PR checks are off. " : "Background PR checks are on. "}
          {!snapshot.monitoring.autoFixAllowed ? "Auto-fix is disabled globally."
            : snapshot.monitoring.repairBudgetPaused ? "Auto-fix is paused by the repair budget."
            : scope === "thread" && !thread?.prAutoDispatchEnabled ? "Auto-fix is off for this thread."
            : "Auto-fix is enabled."}
        </p> : null}
        <div className="pr-activity__filters" aria-label="Activity scope">
          <button type="button" aria-pressed={scope === "thread"} onClick={() => setScope("thread")}>This thread</button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All threads</button>
        </div>
        <p className="pr-activity__help">Local instance · Last 2,000 events since app startup. History resets on restart.</p>
        <dl className="pr-activity__budgets">
          <dt>PR request tokens</dt><dd>{latestBudget("polling")?.availableTokens ?? "—"}</dd>
          <dt>Repair tokens</dt><dd>{latestBudget("repair")?.availableTokens ?? "—"}</dd>
        </dl>
        <p className="pr-activity__help">Last recorded balances across all threads; refill may have occurred since. These are rate limits, not model tokens.</p>
        <div className="pr-activity__filters" aria-label="Activity type">
          <button type="button" aria-pressed={!budgetOnly} onClick={() => setBudgetOnly(false)}>All events</button>
          <button type="button" aria-pressed={budgetOnly} onClick={() => setBudgetOnly(true)}>Token history</button>
        </div>
        {beforeEvent ? <div className="pr-activity__filters">
          <span className="pr-activity__help">Token use before {new Date(beforeEvent.occurredAt).toLocaleTimeString()}</span>
          <button type="button" onClick={() => setBeforeEvent(undefined)}>Show latest</button>
        </div> : null}
        {error ? <p role="status">Could not refresh activity. Retrying…</p> : null}
        {!snapshot && !error ? <p role="status">Loading activity…</p> : null}
        {snapshot && events.length === 0 ? <p>No recorded events for this view.</p> : null}
        {snapshot && snapshot.droppedEvents > 0 ? <p className="pr-activity__help">{snapshot.droppedEvents.toLocaleString()} older events no longer retained.</p> : null}
        <ol className="pr-activity__events">
          {events.slice(0, 200).map((event) => <li key={event.id}>
            <div className="pr-activity__meta"><time dateTime={new Date(event.occurredAt).toISOString()}>{new Date(event.occurredAt).toLocaleTimeString()}</time><span>{event.source}</span></div>
            <p>{event.message}</p>
            {event.budget ? <p className="pr-activity__token">{event.budget === "repair" ? "Repair" : "PR request"}: {event.delta && event.delta > 0 ? "+" : ""}{event.delta ?? 0}{event.availableTokens !== undefined ? ` · ${event.availableTokens} remaining` : ""}</p> : null}
            {event.budget && event.delta === 0 ? <div className="pr-activity__filters">
              <button type="button" onClick={() => { setBeforeEvent(event); setScope("all"); setBudgetOnly(true); }}>Earlier token use</button>
            </div> : null}
            {event.prKeys.map((key) => <div className="pr-activity__identity" key={key}>{key}</div>)}
            {scope === "all" ? event.threadKeys.map((key) => <div className="pr-activity__identity" key={key}>{key}</div>) : null}
          </li>)}
        </ol>
        {events.length > 200 ? <p className="pr-activity__help">Showing the most recent 200 matching events. Choose a thread or Token history to narrow the list.</p> : null}
      </>}
    </section>
  );
}
