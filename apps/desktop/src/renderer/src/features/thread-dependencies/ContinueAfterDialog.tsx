import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type {
  AppServerBackendKind,
  NavigationRow,
  NavigationThreadSummary,
  PrSummary,
  ThreadDependency,
  ThreadDependencyCondition,
  ThreadDependencyDeliveryTarget,
} from "@pwragent/shared";
import { THREAD_DEPENDENCY_CONDITION_PHRASES, pullRequestMatchesRepositoryKey, threadDependencyDeliveryTarget } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { Select } from "../../components/Select";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useModalDialog } from "../../lib/useModalDialog";
import { useThreadLinks } from "../../lib/thread-links";
import { ThreadChip } from "../thread-detail/ThreadChip";
import { RailStatusChip, type RailChipTone } from "../thread-detail/context-panels/RailStatusChip";
import {
  ACTIVE_DEPENDENCY_STATUSES,
  dependencyThreadKey as threadKey,
  evidenceFor,
  isRepairWait,
  needsDeliveryReview,
} from "./dependency-labels";

type When = ThreadDependencyCondition["when"];

const CONDITIONS: readonly { value: When; label: string }[] = [
  { value: "turn_completed", label: "Finishes its turn" },
  { value: "pr_attached", label: "Has a reviewable PR" },
  { value: "ci_passed", label: "Passes CI" },
  { value: "pr_merged", label: "Is merged" },
];
const DEPENDENT_PHRASES: Record<When, string> = {
  turn_completed: "until its turn finishes",
  pr_attached: "until it has a reviewable PR",
  ci_passed: "until it passes CI",
  pr_merged: "until it is merged",
};
const SEARCH_DEBOUNCE_MS = 200;
const MAX_CONDITIONS = 16;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTINUATION_LENGTH = 8000;
let nextTargetQuery = 0;

type DraftCondition = {
  backend: AppServerBackendKind;
  threadId: string;
  title: string;
  when: When;
  prUrl: string;
  prs: { url: string; number: number }[];
};

const rowKey = (row: NavigationRow): string => threadKey({ backend: row.source, threadId: row.id });
const messageFrom = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);

/** Main follows only primary-workspace PRs, keyed like `collectPrPollTargets`. */
function primaryPullRequests(row: NavigationRow): PrSummary[] {
  return (row.prs ?? []).filter((pr) =>
    Boolean(pr.url) && pullRequestMatchesRepositoryKey(pr, row.primaryGitRepository));
}

export type ContinueAfterDialogProps = {
  thread: NavigationThreadSummary;
  desktopApi?: DesktopApi;
  /** Where focus goes on close when the opener is gone, as from a menu. */
  returnFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
};

/**
 * Thread menu → Continue After. Opens on the thread's registrations, or on
 * the add form when there is nothing to show. Picking a search result adds a
 * prerequisite row, so the form always submits exactly what it shows. Cancel
 * and Dismiss apply at once, so the list view closes with Done. Portalled to
 * the body like the other thread dialogs.
 */
export function ContinueAfterDialog({ thread, desktopApi, returnFocus, onClose }: ContinueAfterDialogProps) {
  const [dependencies, setDependencies] = useState<ThreadDependency[]>([]);
  const [dependents, setDependents] = useState<ThreadDependency[]>([]);
  const [view, setView] = useState<"loading" | "list" | "add">("loading");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [targetFilter, setTargetFilter] = useState("");
  const [targets, setTargets] = useState<NavigationRow[]>([]);
  const [targetsIncomplete, setTargetsIncomplete] = useState(false);
  const [searching, setSearching] = useState(false);
  const [rows, setRows] = useState<DraftCondition[]>([]);
  const [mode, setMode] = useState<"all" | "any">("all");
  const [onFailure, setOnFailure] = useState<"notify" | "wait">("wait");
  const [continuation, setContinuation] = useState("");
  const [deliver, setDeliver] = useState<ThreadDependencyDeliveryTarget>("agent");
  const [handoff, setHandoff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const labelId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const formId = useId();
  const key = JSON.stringify([thread.source, thread.id]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const remote = (thread.federation?.ref.target ?? readRendererFederationTarget())?.scope === "remote";
  const available = Boolean(desktopApi?.manageThreadDependencies) && !remote;
  const threadTitle = thread.title?.trim() || "This thread";
  const dialogRef = useModalDialog<HTMLElement>({
    // A request in flight cannot be called back, so the dialog waits for it.
    onClose: () => {
      if (!busy) onClose();
    },
    initialFocus: "dialog",
    ...(returnFocus ? { returnFocus } : {}),
  });

  useEffect(() => {
    let disposed = false;
    setDependencies([]); setDependents([]); setView(available ? "loading" : "list"); setHistoryOpen(false);
    setRows([]); setTargets([]); setTargetFilter(""); setTargetsIncomplete(false); setSearching(false);
    setMode("all"); setOnFailure("wait"); setError(undefined); setBusy(false); setContinuation("");
    setDeliver("agent"); setHandoff(false);
    // Updates arrive in bursts; apply only the newest list response.
    let latestRefresh = 0;
    const refresh = async () => {
      if (!available) return;
      const sequence = ++latestRefresh;
      try {
        const response = await desktopApi!.manageThreadDependencies!({ action: "list", backend: thread.source, threadId: thread.id });
        if (disposed || sequence !== latestRefresh) return;
        setDependencies(response.dependencies);
        setDependents(response.dependents ?? []);
        // With nothing to show, open straight on the form.
        const empty = response.dependencies.length === 0 && !response.dependents?.length;
        setView((current) => current === "loading" ? empty ? "add" : "list" : current);
      } catch (reason) {
        if (disposed || sequence !== latestRefresh) return;
        setError(messageFrom(reason));
        setView((current) => current === "loading" ? "list" : current);
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
  const adding = view === "add";
  useEffect(() => {
    if (!adding) return;
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
  }, [adding, targetFilter, desktopApi, thread.id, thread.source]);

  // A thread waiting on this one cannot also be its prerequisite.
  const waitingOnThis = useMemo(() => new Set(dependents.map(threadKey)), [dependents]);
  const active = dependencies.filter((dependency) => ACTIVE_DEPENDENCY_STATUSES.has(dependency.status));
  const history = dependencies.filter((dependency) => !ACTIVE_DEPENDENCY_STATUSES.has(dependency.status));
  const hasRegistrations = dependencies.length > 0 || dependents.length > 0;
  const pickedKeys = new Set(rows.map(threadKey));
  const waitsOnCi = rows.some((row) => row.when === "ci_passed");
  const needsPrChoice = rows.some((row) => row.when !== "turn_completed" && row.prs.length > 1 && !row.prUrl);
  const canAdd = !busy && rows.length > 0 && !needsPrChoice && continuation.trim().length > 0;
  const reminds = deliver === "operator";
  const remindsOnly = active.length > 0 && active.every((dependency) => threadDependencyDeliveryTarget(dependency) === "operator");

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
      prs: primaryPullRequests(target).map((pr) => ({ url: pr.url, number: pr.number })),
    }]);
  };
  const updateRow = (index: number, patch: Partial<DraftCondition>) => {
    setRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  };
  const resetForm = () => {
    setRows([]); setTargetFilter(""); setContinuation(""); setMode("all"); setOnFailure("wait");
    setDeliver("agent"); setHandoff(false);
  };
  const leaveForm = () => {
    if (!hasRegistrations) {
      onClose();
      return;
    }
    resetForm(); setError(undefined); setView("list");
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
          continuation: continuation.trim(),
          ...(reminds ? { deliver } : {}),
          ...(reminds && handoff ? { handoff: true } : {}),
        } : { dependencyId }),
      });
      if (currentKey.current !== key) return;
      setDependencies(response.dependencies);
      setDependents(response.dependents ?? []);
      if (action === "create") { resetForm(); setView("list"); }
    } catch (reason) {
      if (currentKey.current === key) setError(messageFrom(reason));
    } finally {
      if (currentKey.current === key) setBusy(false);
    }
  };

  return createPortal(
    <div className="rename-thread-backdrop" role="presentation">
      <section
        ref={dialogRef}
        aria-busy={view === "loading" || undefined}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="rename-thread-dialog continue-after-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <h2 id={titleId}>Continue After</h2>
        <p className="continue-after-dialog__lede" id={descriptionId}>
          {adding
            ? `Choose what “${threadTitle}” waits for, and what it does next.`
            : remindsOnly
              ? `“${threadTitle}” reminds you when its prerequisites are met.`
              : `“${threadTitle}” starts a turn when its prerequisites are met.`}
        </p>
        {remote ? <p className="thread-dependencies__hint">Dependencies are available for local threads.</p> : null}
        {adding ? (
          <form
            className="thread-dependencies__form continue-after-dialog__form"
            id={formId}
            onSubmit={(event) => { event.preventDefault(); if (canAdd) void submit("create"); }}
          >
            <div className="continue-after-dialog__columns">
              <div className="continue-after-dialog__pick">
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
              </div>
              <div className="continue-after-dialog__setup">
                {rows.length === 0 ? <p className="thread-dependencies__hint">Choose one or more threads to wait for.</p> : null}
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
                      : reminds
                        ? "Reminds you once with the failure."
                        : "Continues once to report the failure, then stays blocked."}
                  </p>
                ) : null}
                <div className="thread-dependencies__choice">
                  <span id={`${labelId}-deliver`}>When met</span>
                  <div aria-labelledby={`${labelId}-deliver`} className="thread-dependencies__segments" role="group">
                    <button aria-pressed={!reminds} className="thread-dependencies__segment" disabled={busy} type="button" onClick={() => setDeliver("agent")}>Resume this thread</button>
                    <button aria-pressed={reminds} className="thread-dependencies__segment" disabled={busy} type="button" onClick={() => setDeliver("operator")}>Remind me</button>
                  </div>
                </div>
              </div>
            </div>
            <label className="thread-dependencies__field">
              <span>{reminds ? "Reminder" : "Instructions"}</span>
              <textarea
                aria-describedby={`${labelId}-instructions`}
                disabled={busy}
                maxLength={MAX_CONTINUATION_LENGTH}
                placeholder={reminds ? "What you need to do once the prerequisites are met" : "What this thread should do once the prerequisites are met"}
                required
                rows={3}
                value={continuation}
                onChange={(event) => setContinuation(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    if (canAdd) void submit("create");
                  }
                }}
              />
            </label>
            <p className="thread-dependencies__hint" id={`${labelId}-instructions`}>
              {reminds
                ? "Required. It becomes a to-do card on this thread, after the met prerequisites. No turn starts."
                : "Required. The first message of the resumed turn, so write it for a reader without this conversation."}
            </p>
            {reminds ? (
              <label className="composer__checkbox thread-dependencies__handoff">
                <input
                  checked={handoff}
                  disabled={busy}
                  type="checkbox"
                  onChange={(event) => setHandoff(event.currentTarget.checked)}
                />
                <span>Offer to start a thread with this reminder</span>
              </label>
            ) : null}
          </form>
        ) : view === "list" ? (
          <div className="continue-after-dialog__body">
            {active.length === 0 && !remote ? <p className="thread-dependencies__hint">Not waiting on other threads.</p> : null}
            {active.length ? (
              <ul className="thread-dependencies__cards">
                {active.map((dependency) => (
                  <DependencyCard busy={busy} dependency={dependency} key={dependency.id} onAction={(action) => void submit(action, dependency.id)} onNavigate={onClose} />
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
                      <DependencyCard busy={busy} dependency={dependency} key={dependency.id} onAction={(action) => void submit(action, dependency.id)} onNavigate={onClose} />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
            {dependents.length ? (
              <>
                <h3 className="thread-dependencies__subheading">Waiting on this thread</h3>
                <ul className="thread-dependencies__conditions">
                  {dependents.map((dependent) => {
                    const own = dependent.conditions.find((condition) => condition.backend === thread.source && condition.threadId === thread.id);
                    return (
                      <li className="thread-dependencies__condition" key={dependent.id}>
                        <span aria-hidden="true" className="thread-dependencies__mark thread-dependencies__mark--waiting" />
                        <span className="thread-dependencies__condition-head">
                          <DependencyThreadLink backend={dependent.backend} threadId={dependent.threadId} onNavigate={onClose} />
                          {own ? <span className="thread-dependencies__when">{DEPENDENT_PHRASES[own.when]}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </div>
        ) : (
          <p className="thread-dependencies__hint continue-after-dialog__body">Loading…</p>
        )}
        {error ? <p className="rename-thread-dialog__error" role="alert">{error}</p> : null}
        <div className="rename-thread-dialog__actions continue-after-dialog__actions">
          {adding ? (
            <>
              <button className="button button--secondary" disabled={busy} type="button" onClick={leaveForm}>
                {hasRegistrations ? "Back" : "Cancel"}
              </button>
              <button className="button button--primary" disabled={!canAdd} form={formId} type="submit">Add</button>
            </>
          ) : (
            <>
              {available ? (
                <button
                  className="button button--secondary continue-after-dialog__add"
                  disabled={busy || view === "loading"}
                  type="button"
                  onClick={() => { setError(undefined); setView("add"); }}
                >
                  Add Prerequisites…
                </button>
              ) : null}
              <button className="button button--primary" disabled={busy} type="button" onClick={onClose}>Done</button>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function DependencyCard(props: {
  dependency: ThreadDependency;
  busy: boolean;
  onAction: (action: "cancel" | "dismiss") => void;
  onNavigate: () => void;
}) {
  const { dependency } = props;
  const status = describeStatus(dependency);
  const met = dependency.conditions.filter((_, index) => evidenceFor(dependency, index)?.state === "satisfied").length;
  const label = dependency.status === "waiting"
    ? dependency.conditions.length > 1
      ? dependency.mode === "all" ? `Waiting · ${met} of ${dependency.conditions.length} met` : `Waiting for any of ${dependency.conditions.length}`
      : "Waiting"
    : status.label;
  const reminds = threadDependencyDeliveryTarget(dependency) === "operator";
  const policy = dependency.conditions.some((condition) => condition.when === "ci_passed")
    ? dependency.onFailure === "wait" ? "Waits through CI repairs" : "Reports a CI failure"
    : undefined;
  return (
    <li className={`rail-card thread-dependencies__card${status.alert ? " thread-dependencies__card--alert" : ""}`}>
      <p className="rail-card__status-line">
        <RailStatusChip alert={status.alert} blink={status.blink} tone={status.tone}>{label}</RailStatusChip>
        <span className="thread-dependencies__target">{reminds ? "Reminds you" : "Resumes this thread"}</span>
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
                <DependencyThreadLink backend={condition.backend} threadId={condition.threadId} title={condition.title} onNavigate={props.onNavigate} />
                <span className="thread-dependencies__when">{THREAD_DEPENDENCY_CONDITION_PHRASES[condition.when]}</span>
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
      {dependency.continuation ? <p className="thread-dependencies__continuation">{dependency.continuation}</p> : null}
      {policy ? <p className="rail-card__meta">{policy}</p> : null}
      {dependency.error ? <p className="rail-card__error" role="status">{dependency.error}</p> : null}
      {dependency.status === "waiting" || dependency.status === "ready" ? (
        <div className="context-list__actions rail-card__actions">
          <button className="context-list__action" type="button" disabled={props.busy} onClick={() => props.onAction("cancel")}>Cancel</button>
        </div>
      ) : null}
      {needsDeliveryReview(dependency) ? (
        <div className="context-list__actions rail-card__actions">
          <button className="context-list__action" type="button" disabled={props.busy} onClick={() => props.onAction("dismiss")}>Dismiss after review</button>
        </div>
      ) : null}
    </li>
  );
}

function describeStatus(dependency: ThreadDependency): { label: string; tone: RailChipTone; alert?: boolean; blink?: boolean } {
  switch (dependency.status) {
    case "waiting":
      return { label: "Waiting", tone: "active", blink: true };
    case "ready":
      // Admission can also wait on a lock or on PR polling, not only a turn.
      if (dependency.outcome !== "failure") {
        return { label: threadDependencyDeliveryTarget(dependency) === "operator" ? "Ready to remind" : "Ready to continue", tone: "ok" };
      }
      return isRepairWait(dependency)
        ? { label: "Waiting for CI repair", tone: "warning" }
        : { label: "Ready to report the failure", tone: "error" };
    case "dispatching":
      return dependency.error
        ? { label: "Delivery needs review", tone: "error", alert: true }
        : { label: "Continuing", tone: "active", blink: true };
    case "delivered":
      return dependency.outcome === "failure"
        ? { label: "Prerequisite failed", tone: "error", alert: true }
        : { label: threadDependencyDeliveryTarget(dependency) === "operator" ? "Reminded" : "Continued", tone: "ok" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "dismissed":
      return { label: "Dismissed", tone: "neutral" };
  }
}

/** Live thread title that opens the thread and closes the dialog, like a transcript thread chip. */
function DependencyThreadLink(props: { backend: AppServerBackendKind; threadId: string; title?: string; onNavigate: () => void }) {
  const threadLinks = useThreadLinks();
  const link = useMemo(
    () => threadLinks?.resolve({ backend: props.backend, threadId: props.threadId }),
    [threadLinks, props.backend, props.threadId],
  );
  if (!threadLinks || !link) {
    return <span className="thread-dependencies__thread">{props.title || props.threadId}</span>;
  }
  return (
    <ThreadChip
      fallbackLabel={props.title}
      link={link}
      onOpen={(opened) => {
        props.onNavigate();
        threadLinks.show(opened);
      }}
    />
  );
}
