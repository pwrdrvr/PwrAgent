import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  AppServerBackendKind,
  NavigationRow,
  NavigationThreadSummary,
  ThreadDependency,
  ThreadDependencyCondition,
  ThreadDependencyEvidence,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { Select } from "../../../components/Select";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { useThreadLinks } from "../../../lib/thread-links";
import { ThreadChip } from "../ThreadChip";
import { RailStatusChip, type RailChipTone } from "./RailStatusChip";

type When = ThreadDependencyCondition["when"];

const CONDITIONS: readonly { value: When; label: string }[] = [
  { value: "turn_completed", label: "Finishes its turn" },
  { value: "pr_attached", label: "Has a reviewable PR" },
  { value: "ci_passed", label: "Passes CI" },
  { value: "pr_merged", label: "Is merged" },
];
const CONDITION_PHRASES: Record<When, string> = {
  turn_completed: "finishes its turn",
  pr_attached: "has a reviewable PR",
  ci_passed: "passes CI",
  pr_merged: "is merged",
};
const DEPENDENT_PHRASES: Record<When, string> = {
  turn_completed: "until its turn finishes",
  pr_attached: "until it has a reviewable PR",
  ci_passed: "until it passes CI",
  pr_merged: "until it is merged",
};
const ACTIVE = new Set<ThreadDependency["status"]>(["waiting", "ready", "dispatching"]);
const SEARCH_DEBOUNCE_MS = 200;
const MAX_CONDITIONS = 16;
const MAX_TITLE_LENGTH = 200;
let nextTargetQuery = 0;

type DraftCondition = {
  backend: AppServerBackendKind;
  threadId: string;
  title: string;
  when: When;
  prUrl: string;
  prs: { url: string; number: number }[];
};

const threadKey = (value: { backend: string; threadId: string }): string => JSON.stringify([value.backend, value.threadId]);
const rowKey = (row: NavigationRow): string => threadKey({ backend: row.source, threadId: row.id });
const messageFrom = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);

/**
 * Thread Info → Continue after. Registers durable prerequisites for this
 * thread and lists the threads that wait on it. Picking a search result adds
 * a prerequisite row, so the form always submits exactly what it shows.
 */
export function ThreadDependenciesPanel({ thread, desktopApi }: { thread: NavigationThreadSummary; desktopApi?: DesktopApi }) {
  const [dependencies, setDependencies] = useState<ThreadDependency[]>([]);
  const [dependents, setDependents] = useState<ThreadDependency[]>([]);
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [targetFilter, setTargetFilter] = useState("");
  const [targets, setTargets] = useState<NavigationRow[]>([]);
  const [targetsIncomplete, setTargetsIncomplete] = useState(false);
  const [searching, setSearching] = useState(false);
  const [rows, setRows] = useState<DraftCondition[]>([]);
  const [mode, setMode] = useState<"all" | "any">("all");
  const [onFailure, setOnFailure] = useState<"notify" | "wait">("wait");
  const [continuation, setContinuation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const labelId = useId();
  const key = JSON.stringify([thread.source, thread.id]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const remote = (thread.federation?.ref.target ?? readRendererFederationTarget())?.scope === "remote";
  const available = Boolean(desktopApi?.manageThreadDependencies) && !remote;

  useEffect(() => {
    let disposed = false;
    setDependencies([]); setDependents([]); setOpen(false); setHistoryOpen(false); setRows([]); setTargets([]);
    setTargetFilter(""); setTargetsIncomplete(false); setSearching(false);
    setMode("all"); setOnFailure("wait"); setError(undefined); setBusy(false); setContinuation("");
    const refresh = async () => {
      if (!available) return;
      try {
        const response = await desktopApi!.manageThreadDependencies!({ action: "list", backend: thread.source, threadId: thread.id });
        if (disposed) return;
        setDependencies(response.dependencies);
        setDependents(response.dependents ?? []);
      } catch (reason) {
        if (!disposed) setError(messageFrom(reason));
      }
    };
    void refresh();
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      if (event.federationTarget?.scope !== "remote" && event.backend === thread.source
        && event.notification.method === "thread/dependencies/updated" && event.notification.params.threadId === thread.id) void refresh();
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, [available, desktopApi, thread.source, thread.id]);

  // Search as the operator types. Each page releases its navigation consumer.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const consumerId = `thread-dependency-targets:${++nextTargetQuery}`;
      setSearching(true);
      try {
        if (!desktopApi?.getNavigationQueryPage || !desktopApi.releaseNavigationQuery) {
          throw new Error("Thread selection requires bounded navigation support. Upgrade this instance.");
        }
        const filter = targetFilter.trim();
        const page = await desktopApi.getNavigationQueryPage({
          protocol: 2, consumer: "search", inventory: "owner",
          query: { kind: "lens", lens: "recents", ...(filter ? { filter } : {}) },
          pageSize: 100,
        }, consumerId);
        if (cancelled) return;
        setTargets(page.entries.map((entry) => entry.row).filter((candidate) => candidate.federation?.ref.target.scope !== "remote"
          && (candidate.id !== thread.id || candidate.source !== thread.source)));
        setTargetsIncomplete(!page.complete || page.coverage.state !== "complete");
      } catch (reason) {
        if (!cancelled) setError(messageFrom(reason));
      } finally {
        await desktopApi?.releaseNavigationQuery?.(consumerId).catch(() => {});
        if (!cancelled) setSearching(false);
      }
    }, targetFilter ? SEARCH_DEBOUNCE_MS : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, targetFilter, desktopApi, thread.id, thread.source]);

  // A thread waiting on this one cannot also be its prerequisite.
  const waitingOnThis = useMemo(() => new Set(dependents.map(threadKey)), [dependents]);
  const active = dependencies.filter((dependency) => ACTIVE.has(dependency.status));
  const history = dependencies.filter((dependency) => !ACTIVE.has(dependency.status));
  const pickedKeys = new Set(rows.map(threadKey));
  const waitsOnCi = rows.some((row) => row.when === "ci_passed");
  const needsPrChoice = rows.some((row) => row.when !== "turn_completed" && row.prs.length > 1 && !row.prUrl);

  const toggleTarget = (target: NavigationRow) => {
    const targetKey = rowKey(target);
    if (waitingOnThis.has(targetKey)) return;
    if (pickedKeys.has(targetKey)) {
      setRows(rows.filter((row) => threadKey(row) !== targetKey));
      return;
    }
    if (rows.length >= MAX_CONDITIONS) return;
    setRows([...rows, {
      backend: target.source, threadId: target.id,
      title: (target.title || target.id).slice(0, MAX_TITLE_LENGTH),
      when: "ci_passed", prUrl: "",
      prs: (target.prs ?? []).filter((pr) => pr.url).map((pr) => ({ url: pr.url!, number: pr.number })),
    }]);
  };
  const updateRow = (index: number, patch: Partial<DraftCondition>) => {
    setRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  };
  const closeForm = () => {
    setOpen(false); setRows([]); setTargetFilter(""); setContinuation(""); setMode("all"); setOnFailure("wait");
  };

  const submit = async (action: "create" | "cancel" | "dismiss", dependencyId?: string) => {
    setBusy(true); setError(undefined);
    try {
      const response = await desktopApi!.manageThreadDependencies!({
        action, backend: thread.source, threadId: thread.id,
        ...(action === "create" ? {
          conditions: rows.map((row): ThreadDependencyCondition => ({
            backend: row.backend, threadId: row.threadId, when: row.when, title: row.title,
            ...(row.when !== "turn_completed" && row.prUrl ? { prUrl: row.prUrl } : {}),
          })),
          mode: rows.length > 1 ? mode : "all", onFailure,
          ...(continuation.trim() ? { continuation: continuation.trim() } : {}),
        } : { dependencyId }),
      });
      if (currentKey.current !== key) return;
      setDependencies(response.dependencies);
      setDependents(response.dependents ?? []);
      if (action === "create") closeForm();
    } catch (reason) {
      if (currentKey.current === key) setError(messageFrom(reason));
    } finally {
      if (currentKey.current === key) setBusy(false);
    }
  };

  return (
    <section className="context-panel__section thread-dependencies">
      <div className="thread-dependencies__header">
        <h3>Continue after</h3>
        {!open && !remote ? (
          <button
            aria-label="Add prerequisites"
            className="context-list__action"
            disabled={!available || busy}
            type="button"
            onClick={() => { setError(undefined); setOpen(true); }}
          >
            Add…
          </button>
        ) : null}
      </div>
      {remote ? <p className="thread-dependencies__hint">Dependencies are available for local threads.</p> : null}
      {open ? (
        <form className="thread-dependencies__form" onSubmit={(event) => { event.preventDefault(); if (rows.length && !needsPrChoice) void submit("create"); }}>
          <input
            aria-label="Find a thread"
            autoFocus
            className="thread-dependencies__search"
            disabled={busy}
            placeholder="Search threads"
            type="text"
            value={targetFilter}
            onChange={(event) => setTargetFilter(event.target.value)}
          />
          <ul aria-busy={searching} aria-label="Threads" className="thread-dependencies__results">
            {targets.map((target) => {
              const targetKey = rowKey(target);
              const blocked = waitingOnThis.has(targetKey);
              const picked = pickedKeys.has(targetKey);
              return (
                <li key={targetKey}>
                  <button
                    aria-disabled={blocked || undefined}
                    aria-pressed={picked}
                    className="thread-dependencies__result"
                    disabled={busy}
                    type="button"
                    onClick={() => toggleTarget(target)}
                  >
                    <span className="thread-dependencies__result-title">{target.title || target.id}</span>
                    {blocked ? <span className="thread-dependencies__result-note">Waits on this</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {!searching && targets.length === 0 ? <p className="thread-dependencies__hint">No matching threads.</p> : null}
          {targetsIncomplete ? <p className="thread-dependencies__hint">Showing recent matches. Refine the search to find another thread.</p> : null}
          {rows.map((row, index) => (
            <div className="thread-dependencies__row" key={threadKey(row)}>
              <div className="thread-dependencies__row-head">
                <span className="thread-dependencies__row-title" title={row.title}>{row.title}</span>
                <button
                  aria-label={`Remove ${row.title}`}
                  className="context-list__action thread-dependencies__remove"
                  disabled={busy}
                  type="button"
                  onClick={() => setRows(rows.filter((_, rowIndex) => rowIndex !== index))}
                >
                  ×
                </button>
              </div>
              <Select
                aria-label={`Continue when ${row.title}`}
                disabled={busy}
                options={CONDITIONS}
                value={row.when}
                onChange={(when) => updateRow(index, { when })}
              />
              {row.when === "turn_completed" ? (
                <p className="thread-dependencies__hint">Watches its current or latest turn.</p>
              ) : row.prs.length > 1 ? (
                <Select
                  aria-label={`Pull request for ${row.title}`}
                  disabled={busy}
                  options={row.prs.map((pr) => ({ value: pr.url, label: `#${pr.number}` }))}
                  placeholder="Choose a PR"
                  value={row.prUrl}
                  onChange={(prUrl) => updateRow(index, { prUrl })}
                />
              ) : row.prs.length === 1 ? (
                <p className="thread-dependencies__hint">Follows #{row.prs[0]!.number} at its current head.</p>
              ) : (
                <p className="thread-dependencies__hint">Its PR can be attached later.</p>
              )}
            </div>
          ))}
          {rows.length > 1 ? (
            <div className="thread-dependencies__choice">
              <span id={`${labelId}-mode`}>Continue when</span>
              <div aria-labelledby={`${labelId}-mode`} className="thread-dependencies__segments" role="group">
                <button aria-pressed={mode === "all"} className="thread-dependencies__segment" disabled={busy} type="button" onClick={() => setMode("all")}>All are met</button>
                <button aria-pressed={mode === "any"} className="thread-dependencies__segment" disabled={busy} type="button" onClick={() => setMode("any")}>Any is met</button>
              </div>
            </div>
          ) : null}
          {waitsOnCi ? (
            <div className="thread-dependencies__choice">
              <span id={`${labelId}-failure`}>If CI fails</span>
              <div aria-labelledby={`${labelId}-failure`} className="thread-dependencies__segments" role="group">
                <button aria-pressed={onFailure === "wait"} className="thread-dependencies__segment" disabled={busy} type="button" onClick={() => setOnFailure("wait")}>Wait for repair</button>
                <button aria-pressed={onFailure === "notify"} className="thread-dependencies__segment" disabled={busy} type="button" onClick={() => setOnFailure("notify")}>Report it</button>
              </div>
            </div>
          ) : null}
          {waitsOnCi ? (
            <p className="thread-dependencies__hint">
              {onFailure === "wait"
                ? "Keeps waiting while failing checks or conflicts are repaired."
                : "Continues once to report the failure, then stays blocked."}
            </p>
          ) : null}
          <label className="thread-dependencies__field">Instructions (optional)
            <textarea value={continuation} onChange={(event) => setContinuation(event.target.value)} disabled={busy} maxLength={8000} placeholder="Continue the previously requested work" />
          </label>
          <div className="thread-dependencies__actions">
            <button className="context-list__action" type="button" disabled={busy} onClick={closeForm}>Cancel</button>
            <button className="context-list__action thread-dependencies__save" type="submit" disabled={busy || rows.length === 0 || needsPrChoice}>Save</button>
          </div>
        </form>
      ) : null}
      {!open && active.length === 0 && !remote ? <p className="thread-dependencies__hint">Not waiting on other threads.</p> : null}
      {active.length ? (
        <ul className="thread-dependencies__cards">
          {active.map((dependency) => (
            <DependencyCard busy={busy} dependency={dependency} key={dependency.id} onAction={(action) => void submit(action, dependency.id)} />
          ))}
        </ul>
      ) : null}
      {history.length ? (
        <>
          <button
            aria-expanded={historyOpen}
            className="thread-dependencies__history-toggle"
            type="button"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            History ({history.length})
          </button>
          {historyOpen ? (
            <ul className="thread-dependencies__cards">
              {history.map((dependency) => (
                <DependencyCard busy={busy} dependency={dependency} key={dependency.id} onAction={(action) => void submit(action, dependency.id)} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {dependents.length ? (
        <>
          <h4 className="thread-dependencies__subheading">Waiting on this thread</h4>
          <ul className="thread-dependencies__conditions">
            {dependents.map((dependent) => {
              const own = dependent.conditions.find((condition) => condition.backend === thread.source && condition.threadId === thread.id);
              return (
                <li className="thread-dependencies__condition" key={dependent.id}>
                  <span aria-hidden="true" className="thread-dependencies__mark thread-dependencies__mark--waiting" />
                  <span className="thread-dependencies__condition-head">
                    <DependencyThreadLink backend={dependent.backend} threadId={dependent.threadId} />
                    {own ? <span className="thread-dependencies__when">{DEPENDENT_PHRASES[own.when]}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {error ? <p className="rail-card__error" role="alert">{error}</p> : null}
    </section>
  );
}

function DependencyCard(props: { dependency: ThreadDependency; busy: boolean; onAction: (action: "cancel" | "dismiss") => void }) {
  const { dependency } = props;
  const status = describeStatus(dependency);
  const met = dependency.conditions.filter((_, index) => evidenceFor(dependency, index)?.state === "satisfied").length;
  const label = dependency.status === "waiting"
    ? dependency.conditions.length > 1
      ? dependency.mode === "all" ? `Waiting · ${met} of ${dependency.conditions.length} met` : `Waiting for any of ${dependency.conditions.length}`
      : "Waiting"
    : status.label;
  const details = [
    dependency.conditions.some((condition) => condition.when === "ci_passed")
      ? dependency.onFailure === "wait" ? "Waits through CI repairs" : "Reports a CI failure"
      : undefined,
    dependency.continuation ? `Instructions: ${dependency.continuation}` : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <li className={`rail-card thread-dependencies__card${status.alert ? " thread-dependencies__card--alert" : ""}`}>
      <p className="rail-card__status-line">
        <RailStatusChip alert={status.alert} blink={status.blink} tone={status.tone}>{label}</RailStatusChip>
      </p>
      <ul className="thread-dependencies__conditions">
        {dependency.conditions.map((condition, index) => {
          const evidence = evidenceFor(dependency, index);
          const state = evidence?.state ?? "waiting";
          const reason = evidence && state !== "satisfied" ? evidence.reason : undefined;
          return (
            <li className="thread-dependencies__condition" key={index}>
              <span
                aria-label={state === "satisfied" ? "Met" : state === "failed" ? "Failed" : "Waiting"}
                className={`thread-dependencies__mark thread-dependencies__mark--${state}`}
                role="img"
              />
              <span className="thread-dependencies__condition-head">
                <DependencyThreadLink backend={condition.backend} threadId={condition.threadId} title={condition.title} />
                <span className="thread-dependencies__when">{CONDITION_PHRASES[condition.when]}</span>
              </span>
              {reason ? (
                <span className="thread-dependencies__reason">
                  {reason}{evidence?.headSha ? ` · ${evidence.headSha.slice(0, 8)}` : ""}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {details ? <p className="rail-card__meta thread-dependencies__details" title={details}>{details}</p> : null}
      {dependency.error ? <p className="rail-card__error" role="status">{dependency.error}</p> : null}
      {dependency.status === "waiting" || dependency.status === "ready" ? (
        <div className="context-list__actions rail-card__actions">
          <button className="context-list__action" type="button" disabled={props.busy} onClick={() => props.onAction("cancel")}>Cancel</button>
        </div>
      ) : null}
      {dependency.status === "dispatching" && dependency.error ? (
        <div className="context-list__actions rail-card__actions">
          <button className="context-list__action" type="button" disabled={props.busy} onClick={() => props.onAction("dismiss")}>Dismiss after review</button>
        </div>
      ) : null}
    </li>
  );
}

/** Evidence is stored in condition order; ignore a slot that names another thread. */
function evidenceFor(dependency: ThreadDependency, index: number): ThreadDependencyEvidence | undefined {
  const evidence = dependency.evidence[index];
  const condition = dependency.conditions[index];
  return evidence && condition && threadKey(evidence.condition) === threadKey(condition) && evidence.condition.when === condition.when
    ? evidence : undefined;
}

function describeStatus(dependency: ThreadDependency): { label: string; tone: RailChipTone; alert?: boolean; blink?: boolean } {
  switch (dependency.status) {
    case "waiting":
      return { label: "Waiting", tone: "active", blink: true };
    case "ready":
      if (dependency.outcome !== "failure") return { label: "Ready · continues after this turn", tone: "ok" };
      return dependency.onFailure === "wait"
        && dependency.evidence.filter((entry) => entry.state === "failed").every((entry) => entry.reason === "CI failed" || entry.reason === "Merge conflict")
        ? { label: "Waiting for CI repair", tone: "warning" }
        : { label: "Ready · reports the failure after this turn", tone: "error" };
    case "dispatching":
      return dependency.error
        ? { label: "Delivery needs review", tone: "error", alert: true }
        : { label: "Continuing", tone: "active", blink: true };
    case "delivered":
      return dependency.outcome === "failure"
        ? { label: "Prerequisite failed", tone: "error", alert: true }
        : { label: "Continued", tone: "ok" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "dismissed":
      return { label: "Dismissed", tone: "neutral" };
  }
}

/** Live thread title that opens the thread, like a transcript thread chip. */
function DependencyThreadLink(props: { backend: AppServerBackendKind; threadId: string; title?: string }) {
  const threadLinks = useThreadLinks();
  const link = useMemo(
    () => threadLinks?.resolve({ backend: props.backend, threadId: props.threadId }),
    [threadLinks, props.backend, props.threadId],
  );
  if (!threadLinks || !link) {
    return <span className="thread-dependencies__thread">{props.title || props.threadId}</span>;
  }
  return <ThreadChip fallbackLabel={props.title} link={link} onOpen={threadLinks.show} />;
}
