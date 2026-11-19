import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type {
  AppServerBackendKind,
  FederationTarget,
  NavigationThreadSummary,
  PrSummary,
  ThreadDependency,
  ThreadDependencyCondition,
  ThreadDependencyDeliveryTarget,
  CompactionRecoveryProtection,
} from "@pwragent/shared";
import {
  THREAD_DEPENDENCY_MARK_DONE_NOTE_MAX_LENGTH,
  THREAD_DEPENDENCY_MAX_STEPS,
  THREAD_DEPENDENCY_STEP_MAX_LENGTH,
  THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH,
  pullRequestMatchesRepositoryKey,
  summarizeThreadDependencyCiRun,
  threadDependencyConditionName,
  threadDependencyConditionPhrase,
  threadDependencyDeliveryTarget,
  threadDependencyMarkDoneIndex,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { Select } from "../../components/Select";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { openExternalUrl } from "../../lib/open-external-url";
import { useModalDialog } from "../../lib/useModalDialog";
import { useThreadLinks } from "../../lib/thread-links";
import { ThreadChip } from "../thread-detail/ThreadChip";
import { RailStatusChip, type RailChipTone } from "../thread-detail/context-panels/RailStatusChip";
import { ThreadSearchPicker } from "../thread-search/ThreadSearchPicker";
import {
  ACTIVE_DEPENDENCY_STATUSES,
  conditionName,
  evidenceFor,
  groupDeliveryReviews,
  isRepairWait,
  needsDeliveryReview,
  type DeliveryReviewGroup,
} from "./dependency-labels";
import {
  dependencyThreadCandidates,
  dependencyThreadIdentity,
  type DependencyThread,
  type WaitingThread,
} from "./dependency-condition";
import { markDoneWaitsOnThread, type MarkDoneWait } from "./useThreadDependencyList";

type When = ThreadDependencyCondition["when"];

const CONDITIONS: readonly { value: When; label: string }[] = [
  { value: "turn_completed", label: "Finishes its turn" },
  { value: "pr_attached", label: "Has a reviewable PR" },
  { value: "ci_passed", label: "Passes CI" },
  { value: "pr_merged", label: "Is merged" },
  { value: "marked_done", label: "Is marked done" },
];
const DEPENDENT_PHRASES: Record<When, string> = {
  turn_completed: "until its turn finishes",
  pr_attached: "until it has a reviewable PR",
  ci_passed: "until it passes CI",
  pr_merged: "until it is merged",
  marked_done: "until it is marked done",
  compaction_completed: "after its compaction finishes",
  // A CI run and a file marker name no prerequisite thread.
  ci_run: "until its run reaches its milestone",
  local_file: "until its watcher writes a result",
};
const MAX_CONDITIONS = 16;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTINUATION_LENGTH = 8000;
const NO_THREADS: readonly NavigationThreadSummary[] = [];
let nextSubjectRow = 0;

type DraftCondition = {
  /** Stable while the row is on screen. */
  key: string;
  backend: AppServerBackendKind;
  threadId: string;
  title: string;
  when: When;
  prUrl: string;
  prs: { url: string; number: number }[];
  /** A thread on another machine than the waiting thread's owner: marked done only. */
  target?: Extract<FederationTarget, { scope: "remote" }>;
  /** "Something else": what is awaited, when it is not a thread. */
  subject?: string;
};

/** A registration's mark-done in progress: one of its own, or one another thread keeps on this one. */
type Marking = MarkDoneWait & { name: string; dependent: boolean };

const messageFrom = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);

/** One step per line; list markers and blank lines are dropped. */
export function parseReminderSteps(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

/** Main follows only primary-workspace PRs, keyed like `collectPrPollTargets`. */
function primaryPullRequests(row: Pick<NavigationThreadSummary, "prs" | "primaryGitRepository">): PrSummary[] {
  return (row.prs ?? []).filter((pr) =>
    Boolean(pr.url) && pullRequestMatchesRepositoryKey(pr, row.primaryGitRepository));
}

export type ContinueAfterDialogProps = {
  thread: NavigationThreadSummary;
  desktopApi?: DesktopApi;
  /** This window's own machine id. Without it, a peer's thread cannot wait on a thread here. */
  localInstanceId?: string;
  /** Where focus goes on close when the opener is gone, as from a menu. */
  returnFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
};

/**
 * Thread menu → Continue After. Opens on the thread's registrations, or on
 * the add form when there is nothing to show. Each search pick or Add
 * Something Else adds a prerequisite row, so the form always submits exactly
 * what it shows. Cancel, Dismiss and Mark Done apply at once, so the list
 * view closes with Done. A peer's thread is managed on its owner. Portalled
 * to the body like the other thread dialogs.
 */
export function ContinueAfterDialog({ thread, desktopApi, localInstanceId, returnFocus, onClose }: ContinueAfterDialogProps) {
  const [dependencies, setDependencies] = useState<ThreadDependency[]>([]);
  const [dependents, setDependents] = useState<ThreadDependency[]>([]);
  const [peerDependents, setPeerDependents] = useState<Array<{ dependency: ThreadDependency; owner: FederationTarget }>>([]);
  const [view, setView] = useState<"loading" | "list" | "add">("loading");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rows, setRows] = useState<DraftCondition[]>([]);
  const [mode, setMode] = useState<"all" | "any">("all");
  const [onFailure, setOnFailure] = useState<"notify" | "wait">("wait");
  const [continuation, setContinuation] = useState("");
  const [deliver, setDeliver] = useState<ThreadDependencyDeliveryTarget>("agent");
  const [handoff, setHandoff] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [recoveryProtection, setRecoveryProtection] = useState<CompactionRecoveryProtection>();
  // Absent until the operator chooses; the default follows the rows.
  const [holdMergeChoice, setHoldMergeChoice] = useState<boolean>();
  const [marking, setMarking] = useState<Marking>();
  /** What the last reviewed cleanup retired, after its section is gone. */
  const [reviewNotice, setReviewNotice] = useState<string>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const labelId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const formId = useId();
  const links = useThreadLinks();
  const owner = thread.federation?.ref.target ?? readRendererFederationTarget();
  const ownerId = owner?.scope === "remote" ? owner.instanceId : undefined;
  const key = JSON.stringify([ownerId, thread.source, thread.id]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const available = Boolean(desktopApi?.manageThreadDependencies);
  const threadTitle = thread.title?.trim() || "This thread";
  const waiting = useMemo<WaitingThread>(
    () => ({ backend: thread.source, threadId: thread.id, ...(ownerId ? { owner: { scope: "remote", instanceId: ownerId } } : {}) }),
    [thread.source, thread.id, ownerId],
  );
  // Every request about this thread goes to its owner.
  const addressed = useMemo(
    () => ({ backend: thread.source, threadId: thread.id, ...(ownerId ? { federationTarget: { scope: "remote" as const, instanceId: ownerId } } : {}) }),
    [thread.source, thread.id, ownerId],
  );
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
    setDependencies([]); setDependents([]); setPeerDependents([]); setView(available ? "loading" : "list"); setHistoryOpen(false);
    setRecoveryProtection(undefined);
    setRows([]); setMode("all"); setOnFailure("wait"); setError(undefined); setBusy(false); setContinuation("");
    setDeliver("agent"); setHandoff(false); setRepeat(false); setHoldMergeChoice(undefined); setMarking(undefined); setNote("");
    setReviewNotice(undefined);
    // Updates arrive in bursts; apply only the newest list response.
    let latestRefresh = 0;
    const refresh = async () => {
      if (!available) return;
      const sequence = ++latestRefresh;
      try {
        const response = await desktopApi!.manageThreadDependencies!({ action: "list", ...addressed });
        if (disposed || sequence !== latestRefresh) return;
        setDependencies(response.dependencies);
        setRecoveryProtection(response.recoveryProtection);
        setDependents(response.dependents ?? []);
        setPeerDependents(response.peerDependents ?? []);
        // With nothing to show, open straight on the form.
        const empty = response.dependencies.length === 0 && !response.dependents?.length && !response.peerDependents?.length;
        setView((current) => current === "loading" ? empty ? "add" : "list" : current);
      } catch (reason) {
        if (disposed || sequence !== latestRefresh) return;
        setError(messageFrom(reason));
        setView((current) => current === "loading" ? "list" : current);
      }
    };
    refreshRef.current = refresh;
    void refresh();
    // A wait on another thread can change this thread's list too.
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      if (event.notification.method === "thread/dependencies/updated") void refresh();
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, [available, desktopApi, addressed]);

  const adding = view === "add";
  // A thread waiting on this one cannot also be its prerequisite.
  const waitingOnThis = useMemo(() => new Set(dependents.map((dependent) => dependencyThreadIdentity(dependent))), [dependents]);
  const pickedIdentities = rows.flatMap((row) => row.subject === undefined ? [dependencyThreadIdentity(row)] : []).join("\n");
  const toCandidates = useCallback((threads: readonly NavigationThreadSummary[]) => {
    const picked = new Set(pickedIdentities.split("\n"));
    return dependencyThreadCandidates(threads, waiting, localInstanceId).filter(({ target }) => {
      const identity = dependencyThreadIdentity(target);
      return !picked.has(identity) && !waitingOnThis.has(identity);
    });
  }, [waiting, localInstanceId, waitingOnThis, pickedIdentities]);
  const searchApi = desktopApi?.getNavigationQueryPage ? desktopApi : undefined;
  const active = dependencies.filter((dependency) => ACTIVE_DEPENDENCY_STATUSES.has(dependency.status));
  // Uncertain deliveries are reviewed together, above the ordinary waits.
  const reviewGroups = useMemo(() => groupDeliveryReviews(dependencies), [dependencies]);
  const waits = active.filter((dependency) => !needsDeliveryReview(dependency));
  const history = dependencies.filter((dependency) => !ACTIVE_DEPENDENCY_STATUSES.has(dependency.status));
  const hasRegistrations = dependencies.length > 0 || dependents.length > 0 || peerDependents.length > 0;
  const waitsOnCi = rows.some((row) => row.when === "ci_passed");
  const waitsForDone = rows.some((row) => row.when === "marked_done");
  const recoversCompaction = rows[0]?.when === "compaction_completed";
  const holdMerge = holdMergeChoice ?? waitsForDone;
  const reminds = deliver === "operator";
  const steps = reminds ? parseReminderSteps(continuation) : [];
  const stepsTooLong = steps.length > THREAD_DEPENDENCY_MAX_STEPS
    || steps.some((step) => step.length > THREAD_DEPENDENCY_STEP_MAX_LENGTH);
  const needsPrChoice = rows.some((row) => row.when !== "turn_completed" && row.when !== "marked_done" && row.when !== "compaction_completed" && row.prs.length > 1 && !row.prUrl);
  const blankSubject = rows.some((row) => row.subject !== undefined && !row.subject.trim());
  const canAdd = !busy && rows.length > 0 && !needsPrChoice && !blankSubject && !stepsTooLong && continuation.trim().length > 0;
  const remindsOnly = active.length > 0 && active.every((dependency) => threadDependencyDeliveryTarget(dependency) === "operator");

  const addThread = (target: DependencyThread, picked: NavigationThreadSummary) => {
    if (rows.length >= MAX_CONDITIONS) return;
    setRows([...rows, {
      key: dependencyThreadIdentity(target),
      backend: target.backend, threadId: target.threadId,
      title: (target.title || target.threadId).slice(0, MAX_TITLE_LENGTH),
      // Another machine's thread can only be marked done.
      when: target.target ? "marked_done" : "ci_passed", prUrl: "",
      prs: target.target ? [] : primaryPullRequests(picked).map((pr) => ({ url: pr.url, number: pr.number })),
      ...(target.target ? { target: target.target } : {}),
    }]);
  };
  const addSomethingElse = () => {
    if (rows.length >= MAX_CONDITIONS) return;
    setRows([...rows, {
      key: `subject:${++nextSubjectRow}`, backend: thread.source, threadId: "", title: "",
      when: "marked_done", prUrl: "", prs: [], subject: "",
    }]);
  };
  const addCompactionRecovery = () => {
    setRows([{ key: "compaction", backend: thread.source, threadId: thread.id,
      title: threadTitle, when: "compaction_completed", prUrl: "", prs: [] }]);
    setDeliver("agent"); setHandoff(false); setHoldMergeChoice(false); setRepeat(false);
  };
  const updateRow = (index: number, patch: Partial<DraftCondition>) => {
    setRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  };
  const resetForm = () => {
    setRows([]); setContinuation(""); setMode("all"); setOnFailure("wait");
    setDeliver("agent"); setHandoff(false); setRepeat(false); setHoldMergeChoice(undefined);
  };
  const leaveForm = () => {
    if (!hasRegistrations) {
      onClose();
      return;
    }
    resetForm(); setError(undefined); setView("list");
  };
  const startMarking = (next: Marking) => {
    setMarking(next); setNote(""); setError(undefined);
  };

  const submit = async (action: "create" | "cancel" | "dismiss" | "rearm_compaction", target?: string | readonly string[]): Promise<boolean> => {
    setBusy(true); setError(undefined);
    // One reviewed claim keeps the single-id request an older owner knows.
    const ids = typeof target === "string" ? [target] : target ?? [];
    try {
      const response = await desktopApi!.manageThreadDependencies!({
        action, ...addressed,
        ...(action === "create" ? {
          conditions: rows.map((row): ThreadDependencyCondition => row.subject !== undefined
            ? { backend: thread.source, threadId: "", when: "marked_done", subject: row.subject.trim().slice(0, THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH) }
            : {
              backend: row.backend, threadId: row.threadId, when: row.when, title: row.title,
              ...(row.when !== "turn_completed" && row.when !== "marked_done" && row.prUrl ? { prUrl: row.prUrl } : {}),
              ...(row.target ? { target: row.target } : {}),
            }),
          mode: rows.length > 1 ? mode : "all", onFailure,
          // The steps are the reminder, one per line, without list markers.
          continuation: steps.length ? steps.join("\n") : continuation.trim(),
          ...(reminds ? { deliver } : {}),
          ...(reminds && handoff ? { handoff: true } : {}),
          ...(steps.length ? { steps } : {}),
          ...(holdMerge ? { holdMerge: true } : {}),
          ...(recoversCompaction && repeat ? { repeat: true } : {}),
        } : action === "rearm_compaction" ? {} : ids.length === 1 ? { dependencyId: ids[0] } : { dependencyIds: [...ids] }),
      });
      if (currentKey.current !== key) return false;
      setDependencies(response.dependencies);
      setRecoveryProtection(response.recoveryProtection);
      setDependents(response.dependents ?? []);
      setPeerDependents(response.peerDependents ?? []);
      if (action === "create") { resetForm(); setView("list"); }
      return true;
    } catch (reason) {
      if (currentKey.current === key) setError(messageFrom(reason));
      return false;
    } finally {
      if (currentKey.current === key) setBusy(false);
    }
  };

  const markDone = async () => {
    if (!marking) return;
    setBusy(true); setError(undefined);
    try {
      // A dependent's wait lives on its own thread, on its own owner.
      await desktopApi!.manageThreadDependencies!({
        action: "mark_done", backend: marking.dependency.backend, threadId: marking.dependency.threadId,
        ...(marking.owner?.scope === "remote" ? { federationTarget: marking.owner } : {}),
        dependencyId: marking.dependency.id, conditionIndex: marking.conditionIndex,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (currentKey.current !== key) return;
      setMarking(undefined); setNote("");
      await refreshRef.current();
    } catch (reason) {
      if (currentKey.current === key) setError(messageFrom(reason));
    } finally {
      if (currentKey.current === key) setBusy(false);
    }
  };

  const ownMarkDone = (dependency: ThreadDependency, conditionIndex: number) => startMarking({
    dependency, conditionIndex, name: conditionName(dependency.conditions[conditionIndex]!), dependent: false,
    ...(ownerId ? { owner: { scope: "remote", instanceId: ownerId } } : {}),
  });

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
            : active.some((dependency) => dependency.conditions[0]?.when === "compaction_completed")
              ? `“${threadTitle}” has recovery subscriptions. Recovery steers only the compacted active turn.`
            : remindsOnly
              ? `“${threadTitle}” reminds you when its prerequisites are met.`
              : `“${threadTitle}” starts a turn when its prerequisites are met.`}
        </p>
        {adding ? (
          <form
            className="thread-dependencies__form continue-after-dialog__form"
            id={formId}
            onSubmit={(event) => { event.preventDefault(); if (canAdd) void submit("create"); }}
          >
            <div className="continue-after-dialog__columns">
              <div className="continue-after-dialog__pick">
                {searchApi ? (
                  <ThreadSearchPicker
                    toCandidates={toCandidates}
                    fieldLabel="Find a thread to wait for"
                    listLabel="Threads"
                    disabled={busy || recoversCompaction || rows.length >= MAX_CONDITIONS}
                    api={searchApi}
                    threads={links?.readLoadedThreads?.() ?? NO_THREADS}
                    focusOnOpen
                    clearOnPick
                    onPick={addThread}
                  />
                ) : <p className="thread-dependencies__hint">Thread search is unavailable in this window.</p>}
                <button
                  className="button button--secondary continue-after-dialog__something-else"
                  disabled={busy || recoversCompaction || rows.length >= MAX_CONDITIONS}
                  type="button"
                  onClick={addSomethingElse}
                >
                  Add Something Else
                </button>
                {thread.source === "codex" ? (
                  <button className="button button--secondary continue-after-dialog__something-else"
                    disabled={busy || rows.length > 0} type="button" onClick={addCompactionRecovery}>
                    Add Compaction Recovery
                  </button>
                ) : null}
              </div>
              <div className="continue-after-dialog__setup">
                {rows.length === 0 ? <p className="thread-dependencies__hint">Choose one or more threads to wait for, or something else that is not a thread.</p> : null}
                {rows.map((row, index) => (
                  <div className="thread-dependencies__row" key={row.key}>
                    <div className="thread-dependencies__row-head">
                      {row.subject !== undefined ? (
                        <input
                          aria-label="Something else to wait for"
                          className="thread-dependencies__search thread-dependencies__subject"
                          disabled={busy}
                          maxLength={THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH}
                          placeholder="Windows validation of the shutdown fix"
                          type="text"
                          value={row.subject}
                          onChange={(event) => updateRow(index, { subject: event.target.value })}
                        />
                      ) : <span className="thread-dependencies__row-title" title={row.title}>{row.title}</span>}
                      <button
                        aria-label={`Remove ${row.subject !== undefined ? row.subject.trim() || "something else" : row.title}`}
                        className="context-list__action thread-dependencies__remove"
                        disabled={busy}
                        type="button"
                        onClick={() => setRows(rows.filter((_, rowIndex) => rowIndex !== index))}
                      >
                        ×
                      </button>
                    </div>
                    {row.when === "compaction_completed" ? (
                      <p className="thread-dependencies__hint">After a future compaction finishes on this thread.</p>
                    ) : row.subject !== undefined || row.target ? (
                      <p className="thread-dependencies__hint">
                        {row.subject !== undefined
                          ? "Waits until you, or an agent, mark it done."
                          : "On another machine. Waits until that thread, you, or an agent mark it done."}
                      </p>
                    ) : (
                      <Select
                        aria-label={`Continue when ${row.title}`}
                        disabled={busy}
                        options={CONDITIONS}
                        value={row.when}
                        onChange={(when) => updateRow(index, { when })}
                      />
                    )}
                    {row.subject !== undefined || row.target || row.when === "compaction_completed" ? null : row.when === "turn_completed" ? (
                      <p className="thread-dependencies__hint">Watches its current or latest turn.</p>
                    ) : row.when === "marked_done" ? (
                      <p className="thread-dependencies__hint">Waits until that thread, you, or an agent mark it done.</p>
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
                {recoversCompaction ? (
                  <label className="composer__checkbox thread-dependencies__handoff">
                    <input checked={repeat} disabled={busy} type="checkbox" onChange={(event) => setRepeat(event.currentTarget.checked)} />
                    <span>Repeat after each future compaction</span>
                  </label>
                ) : <>
                <div className="thread-dependencies__choice">
                  <span id={`${labelId}-deliver`}>When met</span>
                  <div aria-labelledby={`${labelId}-deliver`} className="thread-dependencies__segments" role="group">
                    <button aria-pressed={!reminds} className="thread-dependencies__segment" disabled={busy} type="button" onClick={() => setDeliver("agent")}>Resume this thread</button>
                    <button aria-pressed={reminds} className="thread-dependencies__segment" disabled={busy} type="button" onClick={() => setDeliver("operator")}>Remind me</button>
                  </div>
                </div>
                <label className="composer__checkbox thread-dependencies__handoff">
                  <input
                    aria-describedby={`${labelId}-hold`}
                    checked={holdMerge}
                    disabled={busy}
                    type="checkbox"
                    onChange={(event) => setHoldMergeChoice(event.currentTarget.checked)}
                  />
                  <span>Hold merging until then</span>
                </label>
                <p className="thread-dependencies__hint" id={`${labelId}-hold`}>
                  Merge cards and agent merges of this thread wait. Replies, rebase and CI repair continue.
                </p>
                </>}
              </div>
            </div>
            <label className="thread-dependencies__field">
              <span>{reminds ? "Remind me to" : "Instructions"}</span>
              <textarea
                aria-describedby={`${labelId}-instructions`}
                disabled={busy}
                maxLength={MAX_CONTINUATION_LENGTH}
                placeholder={reminds ? "Rebase onto the fix\nRe-run the Windows E2E lane\nMerge" : "What this thread should do once the prerequisites are met"}
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
              {recoversCompaction
                ? "Name the authorized instruction files to re-read and recovery tools to check. Steers the compacted turn if it is still active; skips ended assignments. No new task starts, and delivery cannot be guaranteed before the next action."
                : reminds
                ? stepsTooLong
                  ? `Use at most ${THREAD_DEPENDENCY_MAX_STEPS} steps of ${THREAD_DEPENDENCY_STEP_MAX_LENGTH} characters.`
                  : "Required. One step per line. They become a checklist on a to-do card on this thread. No turn starts."
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
            {recoveryProtection?.suspendedAt !== undefined ? (
              <div className="thread-dependencies__form" role="status">
                <strong>Automatic recovery suspended</strong>
                <p className="thread-dependencies__hint">Loop protection stopped further recovery attempts. Inspect the recovery instructions before rearming.</p>
                {!ownerId ? <button className="button button--secondary" disabled={busy} type="button" onClick={() => void submit("rearm_compaction")}>Rearm recovery</button> : <p className="thread-dependencies__hint">Rearm on the owning instance.</p>}
              </div>
            ) : null}
            {marking ? (
              <div className="thread-dependencies__form continue-after-dialog__mark">
                <strong>Mark “{marking.name}” done</strong>
                <label className="thread-dependencies__field">
                  <span>What finished (optional)</span>
                  <textarea
                    aria-describedby={`${labelId}-note`}
                    autoFocus
                    disabled={busy}
                    maxLength={THREAD_DEPENDENCY_MARK_DONE_NOTE_MAX_LENGTH}
                    rows={3}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <p className="thread-dependencies__hint" id={`${labelId}-note`}>
                  {marking.dependent
                    ? "The waiting thread sees this note when it continues or reminds."
                    : "Saved with the wait. When every prerequisite is met, it continues or reminds you."}
                </p>
                <div className="context-list__actions rail-card__actions">
                  <button className="button button--primary" disabled={busy} type="button" onClick={() => void markDone()}>Mark Done</button>
                  <button className="button button--secondary" disabled={busy} type="button" onClick={() => setMarking(undefined)}>Keep Waiting</button>
                </div>
              </div>
            ) : null}
            {active.length === 0 ? <p className="thread-dependencies__hint">Not waiting on anything.</p> : null}
            {reviewGroups.length ? (
              <DeliveryReview
                busy={busy}
                groups={reviewGroups}
                key={key}
                onDismiss={async (ids) => {
                  const dismissed = await submit("dismiss", ids);
                  if (dismissed) {
                    setReviewNotice(`${ids.length === 1 ? "1 delivery" : `${ids.length} deliveries`} dismissed after review. ${ids.length === 1 ? "It is" : "They are"} in History.`);
                  }
                  return dismissed;
                }}
                onReview={() => setReviewNotice(undefined)}
              />
            ) : null}
            {reviewNotice ? <p className="thread-dependencies__hint" role="status">{reviewNotice}</p> : null}
            {waits.length ? (
              <ul className="thread-dependencies__cards">
                {waits.map((dependency) => (
                  <DependencyCard
                    busy={busy}
                    dependency={dependency}
                    key={dependency.id}
                    ownerId={ownerId}
                    onAction={(action) => void submit(action, dependency.id)}
                    onMarkDone={(index) => ownMarkDone(dependency, index)}
                    onNavigate={onClose}
                  />
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
                      <DependencyCard busy={busy} dependency={dependency} key={dependency.id} ownerId={ownerId} onAction={(action) => void submit(action, dependency.id)} onNavigate={onClose} />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
            {dependents.length || peerDependents.length ? (
              <>
                <h3 className="thread-dependencies__subheading">Waiting on this thread</h3>
                <ul className="thread-dependencies__conditions">
                  {[
                    ...dependents.map((dependency) => ({ dependency, owner: owner?.scope === "remote" ? owner : undefined, peer: false })),
                    ...peerDependents.map(({ dependency, owner: peerOwner }) => ({ dependency, owner: peerOwner, peer: true })),
                  ].map(({ dependency: dependent, owner: dependentOwner, peer }) => {
                    const own = dependent.conditions.find((condition) => condition.subject === undefined && Boolean(condition.target) === peer
                      && condition.backend === thread.source && condition.threadId === thread.id);
                    const wait = markDoneWaitsOnThread(peer && dependentOwner
                      ? { dependencies: [], peerDependents: [{ dependency: dependent, owner: dependentOwner }] }
                      : { dependencies: [], dependents: [dependent] }, waiting)[0];
                    const dependentInstance = dependentOwner?.scope === "remote" ? dependentOwner.instanceId : undefined;
                    return (
                      <li className="thread-dependencies__condition" key={`${dependentInstance ?? "local"}:${dependent.id}`}>
                        <span aria-hidden="true" className="thread-dependencies__mark thread-dependencies__mark--waiting" />
                        <span className="thread-dependencies__condition-head">
                          <DependencyThreadLink backend={dependent.backend} instanceId={dependentInstance} threadId={dependent.threadId} onNavigate={onClose} />
                          {own ? <span className="thread-dependencies__when">{DEPENDENT_PHRASES[own.when]}</span> : null}
                        </span>
                        {wait ? (
                          <span className="context-list__actions">
                            <button
                              className="context-list__action"
                              disabled={busy}
                              type="button"
                              onClick={() => startMarking({ ...wait, name: threadTitle, dependent: true })}
                            >
                              Mark Done…
                            </button>
                          </span>
                        ) : null}
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
                  onClick={() => { setError(undefined); setMarking(undefined); setView("add"); }}
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

const REVIEW_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Every uncertain delivery on this thread, grouped by its exact error so a
 * repeated cause is read once. Each group lists its registrations. The
 * operator chooses groups and confirms; one request retires them all, and
 * nothing is started, replayed or stopped.
 */
function DeliveryReview(props: {
  groups: readonly DeliveryReviewGroup[];
  busy: boolean;
  onDismiss: (ids: readonly string[]) => Promise<boolean>;
  /** A new review began; the last cleanup's notice no longer applies. */
  onReview: () => void;
}) {
  // Kept out rather than chosen, so a newly arriving group starts chosen.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The claims the operator was shown when confirming. A refresh can bring a
  // new claim into a chosen group; it is never dismissed unseen.
  const [confirmed, setConfirmed] = useState<readonly string[]>();
  const id = useId();
  const total = props.groups.reduce((count, group) => count + group.items.length, 0);
  const chosen = props.groups.filter((group) => !kept.has(group.error)).flatMap((group) => group.items.map((item) => item.id));
  const present = new Set(props.groups.flatMap((group) => group.items.map((item) => item.id)));
  const confirming = confirmed?.filter((claim) => present.has(claim)) ?? [];
  const plural = (count: number) => count === 1 ? "1 delivery" : `${count} deliveries`;
  const toggle = (set: ReadonlySet<string>, value: string) => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };
  const dismiss = async () => {
    if (await props.onDismiss(confirming)) setConfirmed(undefined);
  };
  return (
    <section aria-labelledby={`${id}-title`} className="continue-after-review">
      <p className="rail-card__status-line">
        <RailStatusChip alert tone="error"><span id={`${id}-title`}>{`${plural(total)} ${total === 1 ? "needs" : "need"} review`}</span></RailStatusChip>
      </p>
      <p className="continue-after-review__lead">
        PwrAgent asked to start {total === 1 ? "this continuation" : "these continuations"} and could not confirm whether {total === 1 ? "it" : "they"} started. It does not retry them.{" "}
        <strong>Check this thread’s transcript for turns labeled Continue after</strong>, then dismiss the ones you have reviewed. Dismissing does not start, replay or stop any turn.
      </p>
      {props.groups.map((group, index) => {
        const open = expanded.has(group.error);
        const first = group.items[0]!.createdAt;
        const last = group.items.at(-1)!.createdAt;
        return (
          <div className="continue-after-review__group" key={group.error}>
            <label className="composer__checkbox continue-after-review__choice">
              <input
                aria-describedby={`${id}-error-${index}`}
                checked={!kept.has(group.error)}
                disabled={props.busy}
                type="checkbox"
                onChange={() => { setKept(toggle(kept, group.error)); setConfirmed(undefined); }}
              />
              <span>
                <strong>{plural(group.items.length)}</strong>
                <span className="continue-after-review__when">
                  {first === last ? REVIEW_TIME.format(first) : `${REVIEW_TIME.format(first)} – ${REVIEW_TIME.format(last)}`}
                </span>
              </span>
            </label>
            <p className="continue-after-review__error" id={`${id}-error-${index}`}>{group.cause}</p>
            <button
              aria-controls={`${id}-rows-${index}`}
              aria-expanded={open}
              className="thread-dependencies__history-toggle continue-after-review__toggle"
              type="button"
              onClick={() => setExpanded(toggle(expanded, group.error))}
            >
              {open ? "Hide registrations" : group.items.length === 1 ? "Show the registration" : `Show ${group.items.length} registrations`}
            </button>
            {open ? (
              <ul aria-label={`Registrations with this error`} className="continue-after-review__rows" id={`${id}-rows-${index}`}>
                {group.items.map((item) => (
                  <li className="continue-after-review__row" key={item.id}>
                    <code>{item.id.slice(0, 8)}</code>
                    <span className="continue-after-review__what">
                      <span>
                        {item.conditions.length > 1 ? `${item.mode === "any" ? "Any" : "All"} of: ` : ""}
                        {item.conditions.map(conditionName).join(", ")}
                      </span>
                      {item.continuation ? <span className="continue-after-review__plan">{item.continuation}</span> : null}
                    </span>
                    <span className="continue-after-review__time">{REVIEW_TIME.format(item.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
      {confirming.length ? (
        <div aria-labelledby={`${id}-confirm`} className="continue-after-review__confirm" role="group">
          <strong id={`${id}-confirm`}>{`Dismiss ${plural(confirming.length)} after review?`}</strong>
          <ul>
            <li>They leave the active list and move to History as Dismissed after review.</li>
            <li>A continuation that did start keeps running. Nothing is cancelled or sent again.</li>
            <li>Waits held behind them can continue when this thread is idle.</li>
          </ul>
          <div className="context-list__actions rail-card__actions">
            <button className="button button--primary" disabled={props.busy} type="button" onClick={() => void dismiss()}>
              {`Dismiss ${confirming.length}`}
            </button>
            <button autoFocus className="button button--secondary" disabled={props.busy} type="button" onClick={() => setConfirmed(undefined)}>
              Keep for Review
            </button>
          </div>
        </div>
      ) : (
        <div className="context-list__actions rail-card__actions">
          <button
            className="context-list__action"
            disabled={props.busy || chosen.length === 0}
            type="button"
            onClick={() => { props.onReview(); setConfirmed(chosen); }}
          >
            {chosen.length ? `Dismiss ${chosen.length} Reviewed…` : "Choose deliveries to dismiss"}
          </button>
        </div>
      )}
    </section>
  );
}

function DependencyCard(props: {
  dependency: ThreadDependency;
  busy: boolean;
  /** The waiting thread's owner, when it is a peer: its threads live there. */
  ownerId?: string;
  onAction: (action: "cancel") => void;
  /** Absent in history, where nothing can be marked done. */
  onMarkDone?: (conditionIndex: number) => void;
  onNavigate: () => void;
}) {
  const { dependency } = props;
  const status = describeStatus(dependency);
  const met = dependency.conditions.filter((_, index) => evidenceFor(dependency, index)?.state === "satisfied").length;
  const label = dependency.status === "waiting"
    ? dependency.repeat ? "Waiting for future compaction" : dependency.conditions.length > 1
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
        <span className="thread-dependencies__target">{dependency.conditions[0]?.when === "compaction_completed" ? "Steers current turn" : reminds ? "Reminds you" : "Resumes this thread"}</span>
      </p>
      <ul className="thread-dependencies__conditions">
        {dependency.conditions.map((condition, index) => {
          const evidence = evidenceFor(dependency, index);
          const state = evidence?.state ?? "waiting";
          // A marked-done prerequisite shows what finished, and a CI run what
          // it reached; others, why they wait.
          const reason = evidence && (state !== "satisfied" || condition.when === "marked_done" || condition.ciRun) ? evidence.reason : undefined;
          // A waiting CI run carries its owner's latest check, in memory.
          const run = state === "waiting" ? evidence?.ciRun : undefined;
          const markable = props.onMarkDone && threadDependencyMarkDoneIndex(dependency, index) !== undefined;
          return (
            <li className="thread-dependencies__condition" key={index}>
              <span
                aria-label={state === "satisfied" ? "Met" : state === "failed" ? "Failed" : "Waiting"}
                className={`thread-dependencies__mark thread-dependencies__mark--${state}`}
                role="img"
              />
              <span className="thread-dependencies__condition-head">
                {condition.ciRun ? (
                  <button
                    className="thread-dependencies__thread thread-dependencies__run"
                    title={condition.ciRun.url}
                    type="button"
                    onClick={() => openExternalUrl(condition.ciRun!.url)}
                  >
                    {threadDependencyConditionName(condition)}
                  </button>
                ) : condition.subject !== undefined ? (
                  <span className="thread-dependencies__thread">{condition.subject}</span>
                ) : (
                  <DependencyThreadLink
                    backend={condition.backend}
                    instanceId={condition.target?.instanceId ?? props.ownerId}
                    threadId={condition.threadId}
                    title={condition.title}
                    onNavigate={props.onNavigate}
                  />
                )}
                <span className="thread-dependencies__when">{threadDependencyConditionPhrase(condition)}</span>
              </span>
              {condition.ciRun?.environments?.length ? (
                <span className="thread-dependencies__reason">{`Approval gates: ${condition.ciRun.environments.join(", ")} only`}</span>
              ) : null}
              {reason ? (
                <span className="thread-dependencies__reason">
                  {reason}{evidence?.headSha ? ` · ${evidence.headSha.slice(0, 8)}` : ""}
                </span>
              ) : null}
              {run ? <span className="thread-dependencies__reason">{summarizeThreadDependencyCiRun(run)}</span> : null}
              {markable ? (
                <span className="context-list__actions">
                  <button
                    aria-label={`Mark Done… ${conditionName(condition)}`}
                    className="context-list__action"
                    disabled={props.busy}
                    type="button"
                    onClick={() => props.onMarkDone!(index)}
                  >
                    Mark Done…
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {dependency.steps?.length ? (
        <ol className="thread-dependencies__steps">
          {dependency.steps.map((step, index) => <li key={index}>{step}</li>)}
        </ol>
      ) : dependency.continuation ? <p className="thread-dependencies__continuation">{dependency.continuation}</p> : null}
      {dependency.holdMerge && (dependency.status === "waiting" || dependency.status === "ready") ? <p className="rail-card__meta">Merge held</p> : null}
      {policy ? <p className="rail-card__meta">{policy}</p> : null}
      {dependency.supersededBy ? <p className="rail-card__meta">Replaced by a newer wait for the same plan on later turns.</p> : null}
      {dependency.error ? <p className="rail-card__error" role="status">{dependency.error}</p> : null}
      {dependency.status === "waiting" || dependency.status === "ready" ? (
        <div className="context-list__actions rail-card__actions">
          <button className="context-list__action" type="button" disabled={props.busy} onClick={() => props.onAction("cancel")}>Cancel</button>
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
      return { label: dependency.supersededBy ? "Replaced" : "Cancelled", tone: "neutral" };
    case "dismissed":
      return { label: "Dismissed after review", tone: "neutral" };
  }
}

/** Live thread title that opens the thread and closes the dialog, like a transcript thread chip. */
function DependencyThreadLink(props: { backend: AppServerBackendKind; threadId: string; instanceId?: string; title?: string; onNavigate: () => void }) {
  const threadLinks = useThreadLinks();
  const link = useMemo(
    () => threadLinks?.resolve({ backend: props.backend, threadId: props.threadId, ...(props.instanceId ? { instanceId: props.instanceId } : {}) }),
    [threadLinks, props.backend, props.threadId, props.instanceId],
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
