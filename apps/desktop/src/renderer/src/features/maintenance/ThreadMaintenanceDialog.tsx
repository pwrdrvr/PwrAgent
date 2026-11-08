import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  defaultThreadMaintenanceRules,
  normalizeCheckoutHibernationPolicy,
  normalizeThreadArchivePolicy,
  THREAD_MAINTENANCE_SCAN_STEPS,
  type DesktopCheckoutHibernationPolicy,
  type DesktopThreadArchivePolicy,
  type ThreadMaintenanceArchivedCheckout,
  type ThreadMaintenanceBuildOutput,
  type ThreadMaintenanceCoverage,
  type ThreadMaintenanceHibernateCheckout,
  type ThreadMaintenanceIdleThread,
  type ThreadMaintenanceKeptCheckout,
  type ThreadMaintenanceProblem,
  type ThreadMaintenanceProject,
  type ThreadMaintenanceRules,
  type ThreadMaintenanceRun,
  type ThreadMaintenanceScan,
  type ThreadMaintenanceScanProgress,
  type ThreadMaintenanceScanStep,
  type ThreadMaintenanceSpace,
  type ThreadMaintenanceStep,
} from "@pwragent/shared";
import { PendingSpinner } from "../../components/PendingSpinner";
import { CloseIcon, MinimizeIcon } from "../../icons";
import { openExternalUrl } from "../../lib/open-external-url";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { useModalDialog } from "../../lib/useModalDialog";
import {
  allIdleThreads,
  allocationTotal,
  buildApplyRequest,
  buildOutputCoveredBy,
  buildOutputOwned,
  buildOutputsToClean,
  buildOutputType,
  DEFAULT_THREAD_MAINTENANCE_PLAN,
  defaultSelection,
  formatAge,
  formatAllocation,
  rebuildableOutputLabels,
  formatBytes,
  formatElapsed,
  groupProblems,
  hibernateItems,
  idleThreadKey,
  keptEntries,
  keptTotal,
  largestFirst,
  needsDecision,
  runSteps,
  workspaceLead,
  type OverLimitDecision,
  type ThreadMaintenanceMode,
  type ThreadMaintenancePlan,
  type ThreadMaintenanceSelection,
} from "./thread-maintenance-selection";
import {
  newerRun,
  threadMaintenancePhase,
  type ThreadMaintenancePhase,
  type ThreadMaintenanceStoredPhase,
} from "./thread-maintenance-run-state";
import type { ThreadMaintenanceSessionStatus } from "./thread-maintenance-session";
import { groupKeptCheckouts, keptGuidance, pullRequestHref, spaceOf, type KeptGroup } from "./thread-maintenance-kept";

type Phase = ThreadMaintenancePhase;

const MODE_TABS: { mode: ThreadMaintenanceMode; label: string }[] = [
  { mode: "combined", label: "Combined" },
  { mode: "threads", label: "Idle threads" },
  { mode: "hibernate", label: "Idle checkouts" },
  { mode: "checkouts", label: "Archived checkouts" },
];

type ReviewStep = ThreadMaintenanceScanStep;

/** The review after `step`, or undefined when the run comes next. */
function nextReview(steps: readonly ReviewStep[], step: ReviewStep): ReviewStep | undefined {
  return steps[steps.indexOf(step) + 1];
}

const STOPS_TEXT = ["Stops once for you", "Stops twice for you", "Stops three times for you"];

const RULE_MODE_OPTIONS = [
  { value: "count", label: "Keep a number per project" },
  { value: "age", label: "Archive after inactivity" },
] as const;

const OVER_LIMIT_CHOICES: { value: OverLimitDecision; label: (bytes: string) => string }[] = [
  { value: "keep", label: () => "Keep thread" },
  { value: "keepCheckout", label: () => "Archive, keep checkout" },
  { value: "snapshotAll", label: (bytes) => `Snapshot all ${bytes}` },
];

/** Idle rows shown per project before "Show all". */
const ROWS_PER_PROJECT = 8;

let nextProgressId = 0;

/**
 * Thread maintenance: a plan, a review for each step, then one run. Nothing
 * changes until the operator presses the final button. Modelled on PwrGit's
 * Repository maintenance, with PwrAgent's archive rules.
 *
 * The dialog keeps one size from open to close. Tabs, the scan, each review
 * and the run swap what the body shows; only the body scrolls.
 */
export function ThreadMaintenanceDialog(props: {
  desktopApi?: DesktopApi;
  policy?: DesktopThreadArchivePolicy;
  /** Checkout hibernation's settings, for the plan's wording. */
  hibernationPolicy?: DesktopCheckoutHibernationPolicy;
  projectKey?: string;
  /** Shows a thread from a kept row or an outcome row. The host minimizes
   * the dialog first, so the session is there to reopen. */
  onOpenThread?: (thread: { backend: string; threadId: string }) => void;
  /** Discards the session: its plan, scan, selections and review. A run
   * already started keeps going in main and shows on the next open. */
  onClose: () => void;
  /** Hides the dialog and keeps the session. Without it, Escape closes. */
  onMinimize?: () => void;
  /** Hidden but mounted: the scan and run keep landing in this session, and
   * the dialog neither traps focus nor answers Escape. */
  minimized?: boolean;
  /** Tells the host where the session is, for its minimized notice. */
  onStatus?: (status: ThreadMaintenanceSessionStatus) => void;
}) {
  const api = props.desktopApi;
  const policy = useMemo(() => normalizeThreadArchivePolicy(props.policy), [props.policy]);
  const hibernationPolicy = useMemo(
    () => normalizeCheckoutHibernationPolicy(props.hibernationPolicy),
    [props.hibernationPolicy],
  );
  const [mode, setMode] = useState<ThreadMaintenanceMode>("combined");
  const [plan, setPlan] = useState<ThreadMaintenancePlan>(DEFAULT_THREAD_MAINTENANCE_PLAN);
  const [rules, setRules] = useState<ThreadMaintenanceRules>(() => defaultThreadMaintenanceRules(policy));
  // This scan's idle days for hibernation. Settings, and the hourly sweep, keep
  // theirs. Until edited, the field follows Settings, which can load after open.
  const [editedIdleDays, setHibernateIdleDays] = useState<number>();
  const hibernateIdleDays = editedIdleDays ?? hibernationPolicy.idleDays;
  const [storedPhase, setPhase] = useState<ThreadMaintenanceStoredPhase>("plan");
  const [scan, setScan] = useState<ThreadMaintenanceScan>();
  const [scanProgress, setScanProgress] = useState<ThreadMaintenanceScanProgress>();
  const progressIdRef = useRef<string | undefined>(undefined);
  // When this scan, and each step it reached, started. Read by the status
  // card's elapsed time; set from events, never during render.
  const [scanClock, setScanClock] = useState<{ startedAt: number; steps: Partial<Record<ReviewStep, number>> }>();
  const [selection, setSelection] = useState<ThreadMaintenanceSelection>();
  const [run, setRun] = useState<ThreadMaintenanceRun>();
  const [error, setError] = useState<string>();
  const phase = threadMaintenancePhase(storedPhase, run);
  const busy = phase === "running";
  // The plan can change only before a scan, so these stay the scanned steps
  // through every review.
  const steps = useMemo(() => runSteps(mode, plan), [mode, plan]);
  // Closing never stops a run: it keeps going in the background, and opening
  // the dialog again shows it. With a host that keeps sessions, Escape
  // minimizes: an edited plan is worth keeping too. Only Close discards.
  const canMinimize = Boolean(props.onMinimize);
  const dialogRef = useModalDialog<HTMLDivElement>({
    open: !props.minimized,
    onClose: () => (canMinimize ? props.onMinimize! : props.onClose)(),
  });

  // Every snapshot goes through newerRun, so a late apply reply cannot undo
  // a result that already arrived as an event.
  const showRun = useCallback((next: ThreadMaintenanceRun | null | undefined) => {
    if (!next) return;
    setRun((current) => newerRun(current, next));
    setPhase("run");
  }, []);

  // A run another surface started (an agent tool) shows here as it goes.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const unsubscribe = api.onThreadMaintenanceRunChanged?.((next) => {
      if (!cancelled) showRun(next);
    });
    void api.getThreadMaintenanceRun?.().then((current) => {
      if (!cancelled && current?.running) showRun(current);
    }, () => {});
    return () => { cancelled = true; unsubscribe?.(); };
  }, [api, showRun]);

  // Only this dialog's current scan moves the status card.
  useEffect(() => api?.onThreadMaintenanceScanProgress?.((next) => {
    if (next.progressId !== progressIdRef.current) return;
    setScanProgress(next);
    setScanClock((clock) => !clock || clock.steps[next.step] !== undefined ? clock
      : { ...clock, steps: { ...clock.steps, [next.step]: Date.now() } });
  }), [api]);

  const startScan = useCallback(async () => {
    if (!api?.scanThreadMaintenance || !steps.length) return;
    const progressId = `thread-maintenance-scan-${++nextProgressId}`;
    progressIdRef.current = progressId;
    setScanProgress(undefined);
    setScanClock({ startedAt: Date.now(), steps: {} });
    setPhase("scanning");
    setError(undefined);
    try {
      const next = await api.scanThreadMaintenance({
        // Ignored files never keep a checkout; an older owner reads this field.
        rules: { ...rules, rebuildableOutputIsClean: true }, steps, progressId,
        ...(props.projectKey ? { projectKey: props.projectKey } : {}),
        ...(steps.includes("hibernate") ? { hibernateIdleDays: clampIdleDays(hibernateIdleDays, hibernationPolicy.idleDays) } : {}),
      });
      if (progressIdRef.current !== progressId) return;
      setScan(next);
      setSelection(defaultSelection(next));
      setPhase(steps[0]!);
    } catch (scanError) {
      if (progressIdRef.current !== progressId) return;
      setError(scanError instanceof Error ? scanError.message : String(scanError));
      setPhase("plan");
    } finally {
      if (progressIdRef.current === progressId) {
        progressIdRef.current = undefined;
        setScanProgress(undefined);
      }
    }
  }, [api, hibernateIdleDays, hibernationPolicy.idleDays, props.projectKey, rules, steps]);

  const startRun = useCallback(async (chosen = selection) => {
    if (!api?.applyThreadMaintenance || !scan || !chosen) return;
    setError(undefined);
    try {
      showRun(await api.applyThreadMaintenance(buildApplyRequest(scan, chosen, steps)));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    }
  }, [api, scan, selection, showRun, steps]);

  // Pressing a review's primary button moves on, or runs after the last one.
  const finishReview = (step: ReviewStep, chosen = selection) => {
    const next = nextReview(steps, step);
    if (next) setPhase(next);
    else void startRun(chosen);
  };

  // Skipping clears the step's selection. A tab that runs one step closes;
  // the last step closes too when no earlier step chose anything.
  const skipReview = (step: ReviewStep, cleared: ThreadMaintenanceSelection) => {
    setSelection(cleared);
    const next = nextReview(steps, step);
    if (next) setPhase(next);
    else if (!scan || isEmptyRequest(buildApplyRequest(scan, cleared, steps))) props.onClose();
    else void startRun(cleared);
  };

  const headChip = phase === "scanning" && scanProgress?.stage === "checking"
    ? `${scanProgress.processed} / ${scanProgress.total}`
    : phase === "threads" && scan
      ? `${allIdleThreads(scan).length} found`
      : phase === "hibernate" && scan
        ? `${hibernateItems(scan, selection, steps).length} found`
        : phase === "checkouts" && scan
          ? `${scan.checkouts.items.length} found`
          : phase === "running" && run?.current
            ? `${run.current.processed} / ${run.current.total}`
            : undefined;

  const statusDetail = phase === "finished" && run ? ` · ${receiptLine(run, scan)}` : headChip ? ` · ${headChip}` : "";
  const onStatus = props.onStatus;
  useEffect(() => {
    onStatus?.({ phase, ...(statusDetail ? { detail: statusDetail.slice(3) } : {}) });
  }, [onStatus, phase, statusDetail]);

  const closeLabel = !props.onMinimize || phase === "finished"
    ? "Close thread maintenance"
    : phase === "plan"
      ? "Discard this plan and close"
      : phase === "running"
        ? "Close thread maintenance; the run keeps going"
        : "Discard this scan and close";
  const keptContext: KeptContext = {
    idleDays: scan?.hibernate?.idleDays,
    inactivityDays: scan?.rules.mode === "age" ? scan.rules.inactivityDays : undefined,
    buildOutputs: steps.includes("checkouts") && scan?.checkouts.buildOutputs !== undefined,
    checkoutsStep: steps.includes("checkouts"),
    ...(scan ? { scanAt: scan.finishedAt ?? scan.startedAt } : {}),
    ...(props.onOpenThread ? { onOpenThread: props.onOpenThread } : {}),
  };

  return (
    <div className="thread-maintenance-modal" hidden={props.minimized}>
      <div ref={dialogRef} aria-labelledby="thread-maintenance-title" aria-modal="true"
        className="thread-maintenance" role="dialog" tabIndex={-1}>
        <div className="thread-maintenance__head">
          <div>
            <h2 id="thread-maintenance-title">Thread maintenance</h2>
            <p>Find idle threads and the checkouts they keep on disk. Archive what you are done with. Changes are saved before any checkout is removed.</p>
          </div>
          <div className="thread-maintenance__head-side">
            {headChip ? <span className="settings-pathrow__chip">{headChip}</span> : null}
            {canMinimize ? (
              <button aria-label="Minimise thread maintenance" className="workspace-handoff-dialog__close tooltip-target"
                data-tooltip="Keep this session in a notice. Reopen it to continue where you left off."
                type="button" onClick={props.onMinimize}><MinimizeIcon size={14} /></button>
            ) : null}
            <button aria-label={closeLabel} className="workspace-handoff-dialog__close tooltip-target" data-tooltip={closeLabel}
              type="button" onClick={props.onClose}><CloseIcon size={14} /></button>
          </div>
        </div>
        <ModeTabs mode={mode} disabled={phase !== "plan"} onChange={setMode} />
        <div className="thread-maintenance__body">
          {phase === "plan" ? (
            <PlanView mode={mode} plan={plan} rules={rules} policy={policy} hibernationPolicy={hibernationPolicy}
              hibernateIdleDays={hibernateIdleDays} onHibernateIdleDays={setHibernateIdleDays}
              onPlan={setPlan} onRules={setRules} />
          ) : null}
          {phase === "scanning" ? (
            <>
              <Rail steps={steps} phase={phase} scanning={scanProgress} />
              <ScanStatus steps={steps} progress={scanProgress}
                startedAt={(scanProgress && scanClock?.steps[scanProgress.step]) ?? scanClock?.startedAt} />
            </>
          ) : null}
          {(phase === "threads" || phase === "hibernate" || phase === "checkouts") && scan && selection ? (
            <>
              <Rail steps={steps} phase={phase} scan={scan} selection={selection} />
              {phase === "threads"
                ? <IdleThreadsReview scan={scan} selection={selection} onSelection={setSelection} />
                : phase === "hibernate"
                  ? <HibernateReview scan={scan} selection={selection} steps={steps} kept={keptContext} onSelection={setSelection} />
                  : <CheckoutsReview scan={scan} selection={selection} steps={steps} kept={keptContext} onSelection={setSelection} />}
            </>
          ) : null}
          {(phase === "running" || phase === "finished") && run ? (
            <RunView run={run} scan={scan} mode={mode} steps={steps} onOpenThread={busy ? undefined : props.onOpenThread} />
          ) : null}
          {error ? <p className="thread-maintenance__error" role="alert">{error}</p> : null}
        </div>
        <div className="thread-maintenance__foot">
          <Footer phase={phase} steps={steps} scan={scan} selection={selection} run={run}
            onClose={props.onClose}
            onScan={() => { void startScan(); }}
            onRescan={() => { setScan(undefined); setSelection(undefined); setPhase("plan"); }}
            onSkip={(step) => {
              if (!selection) return;
              skipReview(step, step === "threads"
                ? { ...selection, threads: new Set() }
                : step === "hibernate"
                  ? { ...selection, hibernate: new Set() }
                  : { ...selection, checkouts: new Set<string>(), buildOutputs: new Set<string>(), emptyFolders: false });
            }}
            onFinish={(step) => finishReview(step)}
            onStop={() => {
              // Read main's run back as well, so a lost event cannot leave
              // the dialog showing a run that has ended.
              void Promise.resolve(api?.stopThreadMaintenance?.())
                .then(() => api?.getThreadMaintenanceRun?.())
                .then((current) => { if (current) setRun((shown) => newerRun(shown, current)); }, () => {});
            }}
            onNewScan={() => { setRun(undefined); setScan(undefined); setSelection(undefined); setPhase("plan"); }}
          />
        </div>
      </div>
    </div>
  );

}

function ModeTabs(props: { mode: ThreadMaintenanceMode; disabled: boolean; onChange: (mode: ThreadMaintenanceMode) => void }) {
  return (
    <div className="thread-maintenance__tabs" role="radiogroup" aria-label="Steps to run">
      {MODE_TABS.map((tab) => (
        <button key={tab.mode} aria-checked={props.mode === tab.mode} role="radio" type="button"
          className={`thread-maintenance__tab${props.mode === tab.mode ? " is-active" : ""}`}
          disabled={props.disabled} onClick={() => props.onChange(tab.mode)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function Checkbox(props: { checked: boolean; mixed?: boolean; label: string; onChange: () => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <label className="thread-maintenance__check">
      <input aria-label={props.label} checked={props.checked} className="settings-thread-management__checkbox-input"
        disabled={props.disabled} type="checkbox" onChange={props.onChange}
        ref={(input) => { if (input) input.indeterminate = props.mixed === true; }} />
      <span aria-hidden="true" className={`settings-thread-management__checkbox${
        props.mixed ? " is-mixed" : props.checked ? " is-checked" : ""}`} />
      {props.children ? <span className="thread-maintenance__check-text">{props.children}</span> : null}
    </label>
  );
}

/** Combined's step numbers, and each step's heading. */
const PLAN_STEPS: { step: ReviewStep; title: string }[] = [
  { step: "threads", title: "Archive idle threads" },
  { step: "hibernate", title: "Hibernate idle checkouts" },
  { step: "checkouts", title: "Remove archived checkouts" },
];

function PlanView(props: {
  mode: ThreadMaintenanceMode;
  plan: ThreadMaintenancePlan;
  rules: ThreadMaintenanceRules;
  policy: DesktopThreadArchivePolicy;
  hibernationPolicy: DesktopCheckoutHibernationPolicy;
  hibernateIdleDays: number;
  onHibernateIdleDays: (days: number) => void;
  onPlan: (plan: ThreadMaintenancePlan) => void;
  onRules: (rules: ThreadMaintenanceRules) => void;
}) {
  const { rules } = props;
  const combined = props.mode === "combined";
  const steps = runSteps(props.mode, props.plan);
  const shown = PLAN_STEPS.filter(({ step }) => combined || props.mode === step);
  const description = (step: ReviewStep): string => {
    switch (step) {
      case "threads":
        return `Threads past each project's keep count, or untouched for the chosen days. ${SAVED_AND_DELETED}`;
      case "hibernate": {
        const days = clampIdleDays(props.hibernateIdleDays, props.hibernationPolicy.idleDays);
        return `Threads idle ${days} ${days === 1 ? "day" : "days"}${steps.includes("threads") ? " that aren't being archived" : ""}. ${SAVED_AND_DELETED} Each checkout comes back when you send its thread a message.`;
      }
      case "checkouts":
        return "Worktrees still on disk for this profile's archived threads, empty worktree folders, checkouts whose repository is gone, and Cargo build output in checkouts a known thread uses.";
    }
  };
  return (
    <>
      <p className="thread-maintenance__lead">
        {combined
          ? "Runs top to bottom over the active profile's threads and the checkouts they use on this machine. Each step you tick stops for your review."
          : "Runs one step over the active profile's threads and the checkouts they use on this machine, and stops for your review."}
      </p>
      {shown.map(({ step, title }, index) => {
        const on = !combined || props.plan[step];
        return (
          <section key={step} className={`thread-maintenance__plan${on ? "" : " is-off"}`} aria-label={title}>
            <div className={`thread-maintenance__plan-top${combined ? " has-check" : ""}`}>
              {combined ? (
                <Checkbox checked={on} label={title}
                  onChange={() => props.onPlan({ ...props.plan, [step]: !props.plan[step] })} />
              ) : null}
              <span className="thread-maintenance__num">{combined ? PLAN_STEPS.findIndex((item) => item.step === step) + 1 : index + 1}</span>
              <div>
                <h3>{title}</h3>
                <p>{description(step)}</p>
              </div>
              <span className={`settings-pathrow__chip${on ? " settings-pathrow__chip--warn" : ""}`}>
                {on ? "Pauses for review" : "Off"}
              </span>
            </div>
            {step === "threads" && on ? (
              <div className="thread-maintenance__rules">
                <div className="thread-maintenance__rule">
                  <Select aria-label="Which threads are idle" className="settings-input select-trigger thread-maintenance__select"
                    value={rules.mode} options={RULE_MODE_OPTIONS}
                    onChange={(mode) => props.onRules({ ...rules, mode })} />
                  {rules.mode === "count" ? (
                    <label className="thread-maintenance__number">
                      <span>Keep the newest</span>
                      <input aria-label="Threads to keep per project" className="settings-input" min={0} max={10000} type="number"
                        value={rules.keepPerProject}
                        onChange={(event) => props.onRules({ ...rules, keepPerProject: Number(event.target.value) })} />
                      <span>in each project</span>
                    </label>
                  ) : (
                    <label className="thread-maintenance__number">
                      <span>Untouched for</span>
                      <input aria-label="Days untouched" className="settings-input" min={0} max={3650} type="number"
                        value={rules.inactivityDays}
                        onChange={(event) => props.onRules({ ...rules, inactivityDays: Number(event.target.value) })} />
                      <span>days</span>
                    </label>
                  )}
                </div>
              </div>
            ) : null}
            {step === "hibernate" && on ? (
              <div className="thread-maintenance__rules">
                <div className="thread-maintenance__rule">
                  <label className="thread-maintenance__number">
                    <span>Idle for at least</span>
                    <input aria-label="Days idle before a checkout can hibernate" className="settings-input" min={1} max={3650}
                      type="number" value={props.hibernateIdleDays}
                      onChange={(event) => props.onHibernateIdleDays(Number(event.target.value))} />
                    <span>days</span>
                  </label>
                </div>
                <span className="thread-maintenance__hint">
                  {`For this scan only. The hourly sweep uses ${props.hibernationPolicy.idleDays} ${
                    props.hibernationPolicy.idleDays === 1 ? "day" : "days"}, set in Settings → Worktrees.`}
                </span>
              </div>
            ) : null}
          </section>
        );
      })}
      {combined ? (
        <section className="thread-maintenance__plan is-off" aria-label="Delete expired archives">
          <div className="thread-maintenance__plan-top has-check">
            <span aria-hidden="true" className="thread-maintenance__check-spacer" />
            <span className="thread-maintenance__num">4</span>
            <div>
              <h3>Delete expired archives</h3>
              <p>{props.policy.retentionDays > 0
                ? `The hourly sweep deletes archives after ${props.policy.retentionDays} days. Change this in Settings.`
                : "Off in Settings. Archives and their recovery snapshots are kept until you choose a deletion period."}</p>
            </div>
            <span className="settings-pathrow__chip">{props.policy.retentionDays > 0 ? "Hourly" : "Off"}</span>
          </div>
        </section>
      ) : null}
      <div className="thread-maintenance__never">
        <p className="thread-maintenance__eyebrow">Never removed</p>
        <dl>
          <dt>threads</dt><dd>Pinned, Agent, running or blocked, watching a PR, scheduled, or running remotely</dd>
          <dt>checkouts</dt><dd>A main checkout, a locked worktree, one another thread still uses, or changes over the snapshot limit you have not approved</dd>
          <dt>files</dt><dd>Anything outside a managed worktree folder</dd>
        </dl>
      </div>
    </>
  );
}

/** What a removed checkout keeps and loses, said the same way everywhere. */
const SAVED_AND_DELETED = "Tracked and non-ignored changes are saved to a snapshot first. Ignored files are deleted and are not in the snapshot.";
const IGNORED_RULE = "ignored files are deleted, not saved";

/** The idle days a scan sends: a whole number from 1 to 3650, or Settings'
 * value while the field is empty or invalid. */
function clampIdleDays(days: number, fallback: number): number {
  return Number.isFinite(days) && days >= 1 ? Math.min(3650, Math.floor(days)) : fallback;
}

/** What a scanning step is doing, in words. */
function scanTitle(progress: ThreadMaintenanceScanProgress): string {
  if (progress.stage === "listing") {
    return progress.step === "checkouts" ? "Reading archived checkouts…" : "Reading threads…";
  }
  switch (progress.step) {
    case "threads": return "Checking idle threads";
    case "hibernate": return "Measuring idle checkouts";
    case "checkouts": return "Checking archived checkouts";
  }
}

/** The scan's live status: the step, how far it is, and what it is reading
 * now. Its height never changes, so the rows under it stay put. */
function ScanStatus(props: { steps: readonly ReviewStep[]; progress?: ThreadMaintenanceScanProgress; startedAt?: number }) {
  const { progress } = props;
  const title = progress ? scanTitle(progress) : "Starting the scan…";
  const checking = progress?.stage === "checking";
  const fraction = checking ? progress.processed / Math.max(1, progress.total) : 0;
  const stepNumber = progress ? props.steps.indexOf(progress.step) + 1 : 1;
  const count = checking ? `${progress.processed} of ${progress.total}`
    : progress?.found !== undefined ? `${progress.found} found`
      : `step ${stepNumber} of ${props.steps.length}`;
  // What it reads now: the items in flight, else the listing's own words.
  const now = progress?.inFlight.length ? `${progress.detail ? `${progress.detail} · ` : ""}now: ${progress.inFlight.join(" · ")}`
    : progress?.detail || progress?.root ? [progress.detail, progress.root].filter(Boolean).join(" · ")
      : "\u00a0";
  return (
    <div className="thread-maintenance__scan-card">
      <div className="thread-maintenance__progress-top">
        <span className="thread-maintenance__scan-title">
          <PendingSpinner size="sm" pairing="paired" />
          <span role="status">{title}</span>
        </span>
        <span className="thread-maintenance__mono">
          <span>{count}</span>
          {props.startedAt !== undefined ? <Elapsed since={props.startedAt} /> : null}
        </span>
      </div>
      <div aria-hidden="true" className={`thread-maintenance__bar${checking ? "" : " is-waiting"}`}>
        <span style={{ width: `${Math.round(100 * fraction)}%` }} />
      </div>
      <p className="thread-maintenance__path thread-maintenance__scan-now">{now}</p>
    </div>
  );
}

/** Time since `since`, counting up once a second, so a long step reads as
 * working rather than stuck. Outside the live region: it is not announced. */
function Elapsed(props: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="thread-maintenance__elapsed">{` · ${formatElapsed(now - props.since)}`}</span>;
}

/** Roots listed before "N more roots". */
const COVERAGE_ROOTS = 5;

/** What a step read: each root with its checkouts and allocation, the
 * threads read per backend, and what it left out and why. */
function Coverage(props: { coverage?: ThreadMaintenanceCoverage; kept: KeptContext & { step: ReviewStep } }) {
  const coverage = props.coverage;
  // Any registered repository's worktrees can be a root, so the list folds.
  const [allRoots, setAllRoots] = useState(false);
  const rootsId = useId();
  if (!coverage || (!coverage.roots.length && !coverage.providers?.length && !coverage.excluded?.length
    && !coverage.largestKept?.length && !coverage.keptCheckouts?.length)) return null;
  const roots = largestFirst(coverage.roots.map((root) => ({
    ...root, space: root.allocatedBytes === undefined ? undefined : { allocatedBytes: root.allocatedBytes, lowerBound: root.lowerBound },
  })));
  const checkouts = coverage.roots.reduce((sum, root) => sum + root.checkouts, 0);
  const total = allocationTotal(roots);
  const shownRoots = allRoots ? roots : roots.slice(0, COVERAGE_ROOTS);
  const hidden = roots.slice(COVERAGE_ROOTS);
  const hiddenTotal = allocationTotal(hidden);
  return (
    <section className="thread-maintenance__coverage" aria-label="What the scan read">
      <p className="thread-maintenance__eyebrow">
        {`Scanned ${roots.length} ${roots.length === 1 ? "root" : "roots"} · ${checkouts} ${checkouts === 1 ? "checkout" : "checkouts"}`}
        {total ? ` · ${formatAllocation(total)} on disk` : ""}
      </p>
      {roots.length ? (
        <ul className="thread-maintenance__coverage-rows" id={rootsId}>
          {shownRoots.map((root) => (
            <li key={root.path}>
              <span className="thread-maintenance__path">{root.path}</span>
              <span className="thread-maintenance__coverage-owner">{root.owner}</span>
              <span className="thread-maintenance__mono">{root.checkouts}</span>
              <span className="thread-maintenance__mono">{root.space ? formatAllocation({ bytes: root.space.allocatedBytes!, lowerBound: !!root.lowerBound }) : "—"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {hidden.length ? (
        <button aria-controls={rootsId} aria-expanded={allRoots} className="thread-maintenance__kept-toggle" type="button"
          onClick={() => setAllRoots(!allRoots)}>
          {allRoots ? "Show fewer roots"
            : `${hidden.length} more ${hidden.length === 1 ? "root" : "roots"}${hiddenTotal ? ` · ${formatAllocation(hiddenTotal)}` : ""}`}
        </button>
      ) : null}
      {coverage.providers?.length ? (
        <p className="thread-maintenance__coverage-line">
          <span className="thread-maintenance__eyebrow">Threads read</span>
          {coverage.providers.map((provider) => `${provider.backend} ${provider.threads}`).join(" · ")}
        </p>
      ) : null}
      {coverage.excluded?.length ? (
        <p className="thread-maintenance__coverage-line">
          <span className="thread-maintenance__eyebrow">Not offered</span>
          {[...coverage.excluded].sort((a, b) => (b.allocatedBytes ?? -1) - (a.allocatedBytes ?? -1) || b.count - a.count)
            .map((item) => `${item.count} ${item.reason}${item.allocatedBytes !== undefined ? ` (${formatBytes(item.allocatedBytes)})` : ""}`)
            .join(" · ")}
        </p>
      ) : null}
      {coverage.keptCheckouts?.length || coverage.largestKept?.length
        ? <KeptCheckouts coverage={coverage} context={props.kept} /> : null}
    </section>
  );
}

/** What a kept list needs from the scan around it. */
type KeptContext = {
  idleDays?: number;
  inactivityDays?: number;
  /** This scan reviews build output (Cargo) on its own. */
  buildOutputs: boolean;
  checkoutsStep: boolean;
  /** Shows a thread; the host minimizes the dialog first. */
  onOpenThread?: OpenThread;
  /** When the scan finished, for "active 3 days ago". */
  scanAt?: number;
};

/** Kept checkouts listed per reason before "Show all". */
const KEPT_ROWS_PER_REASON = 3;

/**
 * Every checkout the step kept, grouped by why, with the threads known to
 * own it, so the operator can see what holds the space and go and change it.
 * Nothing here can be selected. An owner that predates `keptCheckouts` sends
 * only its ten largest, without threads, and the list says so.
 */
function KeptCheckouts(props: { coverage: ThreadMaintenanceCoverage; context: KeptContext & { step: ReviewStep } }) {
  const complete = props.coverage.keptCheckouts !== undefined;
  const rows = props.coverage.keptCheckouts ?? props.coverage.largestKept ?? [];
  const groups = groupKeptCheckouts(rows);
  const count = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const total = allocationTotal(rows.map((row) => ({ worktreePath: row.path, space: spaceOf(row) })));
  const shared = groups.some((group) => group.rows.some((row) => (row.threads?.length ?? 0) > 1));
  const { step, buildOutputs } = props.context;
  return (
    <section className="thread-maintenance__kept" aria-label="Kept checkouts">
      <p className="thread-maintenance__eyebrow">
        {complete
          ? `Kept · ${count} ${count === 1 ? "checkout" : "checkouts"}${total ? ` · ${formatAllocation(total)} on disk` : ""}`
          : "Largest kept"}
      </p>
      <p className="thread-maintenance__kept-note">
        {"These stay on disk and are not offered here. Each reason says what keeps a checkout; change that, then re-scan."}
        {shared ? " A checkout shared by several threads stays while any of them keeps it, so resolving one thread may leave another keeping it." : ""}
        {buildOutputs
          ? step === "checkouts"
            ? " Cargo output inside a kept checkout is reviewed on its own, under Build output."
            : " Cargo output inside a kept checkout is reviewed on its own, in the Archived checkouts step."
          : step === "hibernate" && !props.context.checkoutsStep
            ? " Cargo output inside a kept checkout is reviewed on its own: scan Archived checkouts to see it."
            : ""}
        {complete ? "" : " This scan sent only the largest, without their threads."}
      </p>
      {groups.map((group) => <KeptReasonGroup key={group.reason} group={group} context={props.context} complete={complete} />)}
    </section>
  );
}

function KeptReasonGroup(props: { group: KeptGroup; context: KeptContext & { step: ReviewStep }; complete: boolean }) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  const listId = useId();
  const shown = open ? group.rows : group.rows.slice(0, KEPT_ROWS_PER_REASON);
  const guidance = keptGuidance(group.reason, props.context);
  return (
    <div className="thread-maintenance__kept-group">
      <p className="thread-maintenance__kept-head">
        <span className="thread-maintenance__kept-reason">{group.reason}</span>
        <span className="thread-maintenance__mono">
          {`${group.rows.length} ${group.rows.length === 1 ? "checkout" : "checkouts"}${group.total ? ` · ${formatAllocation(group.total)}` : ""}`}
        </span>
      </p>
      {guidance ? <p className="thread-maintenance__kept-guidance">{guidance}</p> : null}
      <ul id={listId} aria-label={`Kept: ${group.reason}`} className="thread-maintenance__kept-rows">
        {shown.map((row) => <KeptRow key={row.path} row={row} context={props.context} complete={props.complete} />)}
      </ul>
      {group.rows.length > KEPT_ROWS_PER_REASON ? (
        <button aria-controls={listId} aria-expanded={open} className="thread-maintenance__kept-toggle" type="button"
          onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `Show all ${group.rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

function KeptRow(props: { row: ThreadMaintenanceKeptCheckout; context: KeptContext & { step: ReviewStep }; complete: boolean }) {
  const { row, context } = props;
  const threads = row.threads ?? [];
  return (
    <li>
      <div className="thread-maintenance__kept-main">
        {threads.map((thread) => (
          <div className="thread-maintenance__kept-owner" key={`${thread.backend}:${thread.threadId}`}>
            <div className="thread-maintenance__kept-owner-text">
              <p className="thread-maintenance__row-title">{thread.title || "Untitled thread"}</p>
              <p className="thread-maintenance__kept-meta">
                {[thread.backend, thread.branch,
                  thread.lastActivityAt !== undefined && context.scanAt !== undefined
                    // Hibernation judges work and restores, not views.
                    ? `${context.step === "hibernate" ? "last work" : "active"} ${formatAge(thread.lastActivityAt, context.scanAt)}` : undefined]
                  .filter(Boolean).join(" · ")}
                {(thread.pullRequests ?? []).map((pr) => {
                  const href = pullRequestHref(pr.url);
                  if (!href) return null;
                  const label = pr.number !== undefined ? `PR #${pr.number}` : "Pull request";
                  return (
                    <a key={pr.url} className="thread-maintenance__pr-link" href={href}
                      {...(pr.title ? { title: pr.title } : {})}
                      onClick={(event) => { event.preventDefault(); openExternalUrl(href); }}>
                      {label}
                    </a>
                  );
                })}
              </p>
            </div>
            {context.onOpenThread ? (
              <button className="thread-maintenance__open-thread" type="button"
                aria-label={`Open thread ${thread.title || thread.threadId}`}
                onClick={() => context.onOpenThread!({ backend: thread.backend, threadId: thread.threadId })}>
                Open thread
              </button>
            ) : null}
          </div>
        ))}
        {!threads.length && props.complete ? <p className="thread-maintenance__kept-meta">Thread not identified in this scan</p> : null}
        {threads.length > 1 ? (
          <p className="thread-maintenance__kept-shared">
            {`Shared by ${threads.length} threads. Any one of them can keep it, so it stays until none does.`}
          </p>
        ) : null}
        <OutputClass output={row.rebuildableOutput} />
        <p className="thread-maintenance__path">{row.path}</p>
      </div>
      <span className="thread-maintenance__size">{row.allocatedBytes === undefined ? "—" : formatBytes(row.allocatedBytes)}</span>
    </li>
  );
}

/** "Cargo output · 9 GB": what the owned checkout holds. It describes the
 * checkout and never changes whether it is offered. */
function OutputClass(props: { output: ThreadMaintenanceSpace["rebuildableOutput"] }) {
  const labels = rebuildableOutputLabels(props.output);
  if (!labels.length) return null;
  return (
    <p className="thread-maintenance__output-class">
      {labels.map((label) => <span key={label}>{label}</span>)}
    </p>
  );
}

/** A row's allocation on disk, right-aligned; private allocation in the
 * tooltip. Neither is space a removal is sure to free. */
function SizeCell(props: { space?: ThreadMaintenanceSpace }) {
  const space = props.space;
  if (space?.allocatedBytes === undefined) return null;
  const tip = space.privateBytes !== undefined
    ? `${formatBytes(space.allocatedBytes)} on disk · ${formatBytes(space.privateBytes)} private allocation`
    : `${formatBytes(space.allocatedBytes)} on disk`;
  return (
    <span className="thread-maintenance__size tooltip-target" data-tooltip={tip}>
      {formatAllocation({ bytes: space.allocatedBytes, lowerBound: !!space.lowerBound })}
    </span>
  );
}

function Rail(props: {
  steps: readonly ReviewStep[];
  phase: Phase;
  scan?: ThreadMaintenanceScan;
  selection?: ThreadMaintenanceSelection;
  run?: ThreadMaintenanceRun;
  scanning?: ThreadMaintenanceScanProgress;
}) {
  const steps: { step: ThreadMaintenanceStep; title: string }[] = props.steps
    .map((step) => ({ step, title: STEP_TITLES[step] }));
  // While scanning, the step being read is current; the ones before it are read.
  const current: ThreadMaintenanceStep | undefined = props.phase === "scanning"
    ? props.scanning?.step ?? props.steps[0]
    : props.phase === "threads" || props.phase === "hibernate" || props.phase === "checkouts" ? props.phase : undefined;
  return (
    <ol className="thread-maintenance__rail" aria-label="Steps">
      {steps.map((item, index) => {
        const result = props.run?.steps.find((step) => step.step === item.step);
        const active = props.run
          ? props.run.running && props.run.current?.step === item.step
          : current === item.step;
        const done = props.run
          ? !!result && !active && (!props.run.running || props.run.current?.step !== item.step)
          : index < steps.findIndex((step) => step.step === current);
        const failed = !!result && result.failed > 0;
        const subtitle = props.run
          ? active ? `${props.run.current?.processed ?? 0} of ${props.run.current?.total ?? 0}`
            : result ? `${result.done} done${result.kept ? ` · ${result.kept} kept` : ""}${result.failed ? ` · ${result.failed} failed` : ""}` : "next"
          : props.phase === "scanning"
            ? active ? props.scanning?.stage === "checking" ? `scanning ${props.scanning.processed} of ${props.scanning.total}` : "scanning"
              : done ? "scanned" : "next"
            : active ? "review" : done ? "reviewed" : "next · pauses for review";
        return (
          <li key={item.step} aria-current={active ? "step" : undefined}
            className={`thread-maintenance__rail-step${active ? " is-active" : ""}`}>
            <span className={`thread-maintenance__num${failed ? " is-failed" : done ? " is-done" : ""}`}>
              {done && !failed ? "✓" : index + 1}
            </span>
            <span>
              <span className="thread-maintenance__rail-title">{item.title}</span>
              <span className="thread-maintenance__rail-sub">{subtitle}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Why the scan kept what it kept. `collapsible` folds the chips behind
 * Show, for a step whose kept list is long and rarely read. */
function KeptChips(props: { kept: Record<string, number>; collapsible?: boolean }) {
  const [open, setOpen] = useState(!props.collapsible);
  const chipsId = useId();
  const entries = keptEntries(props.kept);
  if (!entries.length) return null;
  return (
    <div className="thread-maintenance__kept">
      <p className="thread-maintenance__eyebrow">
        Kept {keptTotal(props.kept)}
        {props.collapsible ? (
          <>
            {" · "}
            <button aria-controls={chipsId} aria-expanded={open} className="thread-maintenance__kept-toggle" type="button"
              onClick={() => setOpen(!open)}>
              {open ? "Hide" : "Show"}
            </button>
          </>
        ) : null}
      </p>
      {open ? (
        <div className="thread-maintenance__chips" id={chipsId}>
          {entries.map(([reason, count]) => (
            <span key={reason} className="settings-pathrow__chip thread-maintenance__chip"><b>{count}</b> {reason}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function IdleThreadsReview(props: {
  scan: ThreadMaintenanceScan;
  selection: ThreadMaintenanceSelection;
  onSelection: (selection: ThreadMaintenanceSelection) => void;
}) {
  const { scan, selection } = props;
  const rows = allIdleThreads(scan);
  const decidable = rows.filter((row) => !needsDecision(row));
  const chosen = decidable.filter((row) => selection.threads.has(idleThreadKey(row))).length;
  const decisions = rows.length - decidable.length;
  const toggle = (row: ThreadMaintenanceIdleThread) => {
    const threads = new Set(selection.threads);
    const key = idleThreadKey(row);
    if (threads.has(key)) threads.delete(key);
    else threads.add(key);
    const overLimit = new Map(selection.overLimit);
    if (needsDecision(row)) {
      if (threads.has(key) && (overLimit.get(key) ?? "keep") === "keep") overLimit.set(key, "keepCheckout");
      if (!threads.has(key)) overLimit.set(key, "keep");
    }
    props.onSelection({ ...selection, threads, overLimit });
  };
  const decide = (row: ThreadMaintenanceIdleThread, decision: OverLimitDecision) => {
    const key = idleThreadKey(row);
    const threads = new Set(selection.threads);
    if (decision === "keep") threads.delete(key);
    else threads.add(key);
    props.onSelection({ ...selection, threads, overLimit: new Map(selection.overLimit).set(key, decision) });
  };
  const selectAll = () => {
    const threads = new Set(selection.threads);
    const allChosen = chosen === decidable.length;
    for (const row of decidable) {
      if (allChosen) threads.delete(idleThreadKey(row));
      else threads.add(idleThreadKey(row));
    }
    props.onSelection({ ...selection, threads });
  };
  const ruleText = scan.rules.mode === "count"
    ? `Keep newest ${scan.rules.keepPerProject} per project`
    : `Untouched for ${scan.rules.inactivityDays} days`;
  return (
    <>
      <div className="thread-maintenance__summary">
        <div>
          <p className="thread-maintenance__summary-title">
            {rows.length ? `${rows.length} idle ${rows.length === 1 ? "thread" : "threads"}` : "No idle threads"}
          </p>
          <p className="thread-maintenance__summary-sub">
            {`${scan.threads.checked} checked · ${rows.length} idle · ${keptTotal(scan.threads.kept)} kept`}
            {scan.threads.skipped ? ` · ${scan.threads.skipped}` : ""}
          </p>
        </div>
      </div>
      <div className="thread-maintenance__rules-strip">
        <span className="thread-maintenance__eyebrow">Rules</span>
        <span>{ruleText} · snapshots up to the limit · {IGNORED_RULE}</span>
        <span className="thread-maintenance__eyebrow">Never</span>
        <span className="thread-maintenance__never-inline">pinned · Agent · running or blocked · watching a PR</span>
      </div>
      {decidable.length ? (
        <Checkbox checked={chosen === decidable.length} mixed={chosen > 0 && chosen < decidable.length}
          label="Select every idle thread that needs no decision" onChange={selectAll}>
          Select all {decidable.length} that need no decision
          {decisions ? <span className="thread-maintenance__hint"> · {decisions} {decisions === 1 ? "needs" : "need"} your choice</span> : null}
        </Checkbox>
      ) : null}
      <div className="thread-maintenance__groups">
        {scan.threads.projects.map((project) => (
          <ProjectGroup key={project.key} project={project} scanAt={scan.startedAt} selection={selection}
            showSpace={scan.spaceSource !== "none"} onToggle={toggle} onDecide={decide} />
        ))}
      </div>
    </>
  );
}

function ProjectGroup(props: {
  project: ThreadMaintenanceProject;
  scanAt: number;
  selection: ThreadMaintenanceSelection;
  showSpace: boolean;
  onToggle: (row: ThreadMaintenanceIdleThread) => void;
  onDecide: (row: ThreadMaintenanceIdleThread, decision: OverLimitDecision) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { project } = props;
  const rows = expanded ? project.idle : project.idle.slice(0, ROWS_PER_PROJECT);
  const chosen = project.idle.filter((row) => props.selection.threads.has(idleThreadKey(row))).length;
  return (
    <section className="thread-maintenance__group" aria-label={project.label}>
      <div className="thread-maintenance__group-head">
        <span className="thread-maintenance__group-name">{project.label}</span>
        {project.path ? <span className="thread-maintenance__path">{project.path}</span> : null}
        <span className="thread-maintenance__group-side">
          {`${chosen} of ${project.idle.length}`}
          {props.showSpace && project.space ? ` · ${formatBytes(project.space.idleBytes)}` : ""}
        </span>
      </div>
      {project.idle.length ? (
        <ul className="thread-maintenance__rows">
          {rows.map((row) => (
            <IdleRow key={idleThreadKey(row)} row={row} scanAt={props.scanAt} selection={props.selection}
              showSpace={props.showSpace} onToggle={props.onToggle} onDecide={props.onDecide} />
          ))}
        </ul>
      ) : null}
      {project.idle.length > ROWS_PER_PROJECT ? (
        <button className="thread-maintenance__more" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${project.idle.length}`}
        </button>
      ) : null}
      <KeptChips kept={project.kept} />
    </section>
  );
}

function IdleRow(props: {
  row: ThreadMaintenanceIdleThread;
  scanAt: number;
  selection: ThreadMaintenanceSelection;
  showSpace: boolean;
  onToggle: (row: ThreadMaintenanceIdleThread) => void;
  onDecide: (row: ThreadMaintenanceIdleThread, decision: OverLimitDecision) => void;
}) {
  const { row } = props;
  const key = idleThreadKey(row);
  const lead = workspaceLead(row.workspace);
  const decision = props.selection.overLimit.get(key) ?? "keep";
  const overLimit = row.workspace.kind === "overLimit" ? row.workspace : undefined;
  const rebuildable = row.workspace.kind === "clean" || row.workspace.kind === "changes" ? row.workspace.rebuildableOutput : undefined;
  return (
    <li className={`thread-maintenance__row${overLimit ? " needs-decision" : ""}`}>
      <Checkbox checked={props.selection.threads.has(key)} label={`Archive ${row.title}`} onChange={() => props.onToggle(row)} />
      <div className="thread-maintenance__row-body">
        <p className="thread-maintenance__row-title">
          {row.title}
          {row.branch ? <span className="thread-maintenance__branch">{row.branch}</span> : null}
        </p>
        <p className="thread-maintenance__row-meta">
          <span className={`thread-maintenance__lead-text is-${lead.tone}`}>{lead.text}</span>
          {` · touched ${formatAge(row.lastActivityAt, props.scanAt)}`}
          {row.subThreads ? ` · ${row.subThreads} ${row.subThreads === 1 ? "sub-thread" : "sub-threads"}` : ""}
          {rebuildable?.length ? ` · removes ${rebuildable.join(", ")}` : ""}
          {overLimit?.largest[0] ? ` · largest: ${overLimit.largest[0].path} ${formatBytes(overLimit.largest[0].bytes)}` : ""}
        </p>
        {row.worktreePath ? <p className="thread-maintenance__path">{row.worktreePath}</p> : null}
        {overLimit ? (
          <div className="thread-maintenance__choices" role="radiogroup" aria-label={`What to do with ${row.title}`}>
            {OVER_LIMIT_CHOICES.map((choice) => (
              <button key={choice.value} aria-checked={decision === choice.value} role="radio" type="button"
                className={`thread-maintenance__choice${decision === choice.value ? " is-active" : ""}`}
                onClick={() => props.onDecide(row, choice.value)}>
                {choice.label(formatBytes(overLimit.bytes))}
              </button>
            ))}
          </div>
        ) : null}
        {overLimit && decision === "snapshotAll" ? (
          <p className="thread-maintenance__hint">
            Saved as a Git snapshot in its repository, which grows by about {formatBytes(overLimit.bytes)} until the archive is deleted.
          </p>
        ) : null}
      </div>
      {props.showSpace && row.space?.allocatedBytes !== undefined ? (
        <span className="thread-maintenance__size">{row.space.lowerBound ? "≥ " : ""}{formatBytes(row.space.allocatedBytes)}</span>
      ) : null}
    </li>
  );
}

function CheckoutsReview(props: {
  scan: ThreadMaintenanceScan;
  selection: ThreadMaintenanceSelection;
  steps: readonly ReviewStep[];
  kept: KeptContext;
  onSelection: (selection: ThreadMaintenanceSelection) => void;
}) {
  const { scan, selection } = props;
  // A checkout no thread refers to is not offered, even from an older owner.
  const items = largestFirst(scan.checkouts.items.filter((item) => item.kind !== "unreferenced"));
  const removable = items.filter((item) => item.kind === "removable");
  const gone = items.filter((item) => item.kind === "repositoryGone");
  const outputs = (scan.checkouts.buildOutputs ?? []).filter(buildOutputOwned).length;
  const total = allocationTotal(items);
  const toggle = (item: ThreadMaintenanceArchivedCheckout) => {
    const checkouts = new Set(selection.checkouts);
    if (checkouts.has(item.worktreePath)) checkouts.delete(item.worktreePath);
    else checkouts.add(item.worktreePath);
    props.onSelection({ ...selection, checkouts });
  };
  return (
    <>
      <div className="thread-maintenance__summary">
        <div>
          <p className="thread-maintenance__summary-title">
            {removable.length ? `${removable.length} archived ${removable.length === 1 ? "checkout is" : "checkouts are"} still on disk`
              : outputs
                ? `${outputs} Cargo build ${outputs === 1 ? "output" : "outputs"} can be cleaned`
                : "No archived checkouts to remove"}
          </p>
          <p className="thread-maintenance__summary-sub">
            {total ? `${formatAllocation(total)} on disk · ` : ""}
            {`${keptTotal(scan.checkouts.kept)} kept · ${scan.checkouts.emptyFolders} empty ${scan.checkouts.emptyFolders === 1 ? "folder" : "folders"}`}
            {scan.checkouts.skipped ? ` · ${scan.checkouts.skipped}` : ""}
          </p>
        </div>
      </div>
      <Coverage coverage={scan.checkouts.coverage} kept={{ ...props.kept, step: "checkouts" }} />
      {removable.length ? (
        <section className="thread-maintenance__group" aria-label="Still on disk">
          <div className="thread-maintenance__group-head">
            <span className="thread-maintenance__eyebrow">Still on disk · {removable.length}</span>
          </div>
          <ul className="thread-maintenance__rows">
            {removable.map((item) => {
              const lead = item.workspace ? workspaceLead(item.workspace) : undefined;
              return (
                <li key={item.worktreePath} className="thread-maintenance__row">
                  <Checkbox checked={selection.checkouts.has(item.worktreePath)} label={`Remove ${item.worktreePath}`} onChange={() => toggle(item)} />
                  <div className="thread-maintenance__row-body">
                    <p className="thread-maintenance__row-title">{item.title ?? item.worktreePath}</p>
                    {lead ? <p className="thread-maintenance__row-meta"><span className={`thread-maintenance__lead-text is-${lead.tone}`}>{lead.text}</span></p> : null}
                    <p className="thread-maintenance__path">{item.worktreePath}</p>
                  </div>
                  <SizeCell space={item.space} />
                </li>
              );
            })}
          </ul>
          <KeptChips kept={scan.checkouts.kept} />
        </section>
      ) : <KeptChips kept={scan.checkouts.kept} />}
      {gone.length ? (
        <section className="thread-maintenance__group" aria-label="Repository gone">
          <div className="thread-maintenance__group-head">
            <span className="thread-maintenance__eyebrow">Repository gone · {gone.length}</span>
          </div>
          <ul className="thread-maintenance__rows">
            {gone.map((item) => (
              <li key={item.worktreePath} className="thread-maintenance__row">
                <Checkbox checked={selection.checkouts.has(item.worktreePath)} label={`Move ${item.worktreePath} to the Trash`} onChange={() => toggle(item)} />
                <div className="thread-maintenance__row-body">
                  <p className="thread-maintenance__row-title is-path">{item.worktreePath}</p>
                  <p className="thread-maintenance__row-meta">
                    <span className="thread-maintenance__lead-text is-info">Repository no longer exists:</span>
                    {` ${item.missingRepositoryPath ?? "unknown"}. Git cannot save anything from it. Selected checkouts go to the Trash.`}
                  </p>
                </div>
                <SizeCell space={item.space} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {scan.checkouts.buildOutputs?.length ? (
        <BuildOutputsReview scan={scan} selection={selection} steps={props.steps} onOpenThread={props.kept.onOpenThread}
          onSelection={props.onSelection} />
      ) : null}
      {scan.checkouts.emptyFolders ? (
        <Checkbox checked={selection.emptyFolders} label="Remove empty worktree folders"
          onChange={() => props.onSelection({ ...selection, emptyFolders: !selection.emptyFolders })}>
          Remove {scan.checkouts.emptyFolders} empty worktree {scan.checkouts.emptyFolders === 1 ? "folder" : "folders"}
        </Checkbox>
      ) : null}
    </>
  );
}

/** Build output rows shown before "Show all". */
const BUILD_OUTPUT_ROWS = 8;

/** `path` relative to `root` when inside it, else `path`. */
function relativeTo(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** Build profile folders, reviewed apart from whole checkouts: cleaning one
 * deletes compiled files only. Offered whatever keeps its checkout, only
 * when the scan identified a thread that uses it, and never selected by
 * default, since each costs a rebuild. */
function BuildOutputsReview(props: {
  scan: ThreadMaintenanceScan;
  selection: ThreadMaintenanceSelection;
  steps: readonly ReviewStep[];
  onOpenThread?: OpenThread;
  onSelection: (selection: ThreadMaintenanceSelection) => void;
}) {
  const { scan, selection, steps } = props;
  const [open, setOpen] = useState(false);
  const rowsId = useId();
  const outputs = largestFirst((scan.checkouts.buildOutputs ?? []).filter(buildOutputOwned));
  const unowned = (scan.checkouts.buildOutputs ?? []).length - outputs.length;
  const chosen = selection.buildOutputs ?? new Set<string>();
  const covered = (output: ThreadMaintenanceBuildOutput) => buildOutputCoveredBy(scan, selection, steps, output);
  const offered = outputs.filter((output) => !covered(output));
  const picked = offered.filter((output) => chosen.has(output.outputPath)).length;
  const toClean = buildOutputsToClean(scan, selection, steps);
  const size = allocationTotal(toClean.map((output) => ({ ...output, worktreePath: output.outputPath })));
  const all = allocationTotal(outputs.map((output) => ({ ...output, worktreePath: output.outputPath })));
  const shown = open ? outputs : outputs.slice(0, BUILD_OUTPUT_ROWS);
  const write = (next: Set<string>) => props.onSelection({ ...selection, buildOutputs: next });
  const toggle = (output: ThreadMaintenanceBuildOutput) => {
    const next = new Set(chosen);
    if (next.has(output.outputPath)) next.delete(output.outputPath);
    else next.add(output.outputPath);
    write(next);
  };
  const selectAll = () => {
    const next = new Set(chosen);
    for (const output of offered) {
      if (picked === offered.length) next.delete(output.outputPath);
      else next.add(output.outputPath);
    }
    write(next);
  };
  return (
    <section className="thread-maintenance__group" aria-label="Build output">
      <div className="thread-maintenance__group-head">
        <span className="thread-maintenance__eyebrow">Build output · {outputs.length}</span>
        {all ? <span className="thread-maintenance__eyebrow thread-maintenance__group-aside">{`${formatAllocation(all)} on disk`}</span> : null}
      </div>
      <p className="thread-maintenance__group-note">
        Detected type: Cargo. Deletes the compiled files in each selected Cargo profile folder of a checkout a known thread uses. The checkout, its source and its thread stay; the next build of that profile compiles again. A folder in use by a build is skipped.
        {unowned ? ` ${unowned} more ${unowned === 1 ? "is" : "are"} not offered: thread not identified in this scan.` : ""}
        {size ? ` Selected: ${formatAllocation(size)} on disk.` : ""}
      </p>
      {offered.length > 1 ? (
        <div className="thread-maintenance__group-select">
          <Checkbox checked={picked === offered.length} mixed={picked > 0 && picked < offered.length}
            label="Select every build output" onChange={selectAll}>
            Select all {offered.length}
          </Checkbox>
        </div>
      ) : null}
      <ul className="thread-maintenance__rows" id={rowsId}>
        {shown.map((output) => {
          const holder = covered(output);
          return (
            <li key={output.outputPath} className="thread-maintenance__row">
              <Checkbox checked={!!holder || chosen.has(output.outputPath)} disabled={!!holder}
                label={`Clean ${output.outputPath}`} onChange={() => toggle(output)} />
              <div className="thread-maintenance__row-body">
                {(output.threads ?? []).map((thread) => (
                  <div className="thread-maintenance__kept-owner" key={`${thread.backend}:${thread.threadId}`}>
                    <p className="thread-maintenance__row-title">
                      {thread.title || "Untitled thread"}
                      {thread.branch ? <span className="thread-maintenance__branch">{thread.branch}</span> : null}
                    </p>
                    {props.onOpenThread ? (
                      <button className="thread-maintenance__open-thread" type="button"
                        aria-label={`Open thread ${thread.title || thread.threadId}`}
                        onClick={() => props.onOpenThread!({ backend: thread.backend, threadId: thread.threadId })}>
                        Open thread
                      </button>
                    ) : null}
                  </div>
                ))}
                <p className="thread-maintenance__row-meta">
                  {holder
                    ? <span className="thread-maintenance__lead-text is-muted">Removed with its checkout</span>
                    : <span className="thread-maintenance__lead-text is-ok">{`${buildOutputType(output.kind)} · ${relativeTo(output.outputPath, output.checkoutPath)}`}</span>}
                  {holder ? ` · ${relativeTo(output.outputPath, output.checkoutPath)}` : ""}
                  {` · ${relativeTo(output.manifestPath, output.checkoutPath)}`}
                </p>
                <p className="thread-maintenance__path">{output.checkoutPath}</p>
              </div>
              <SizeCell space={output.space} />
            </li>
          );
        })}
      </ul>
      {outputs.length > BUILD_OUTPUT_ROWS ? (
        <div className="thread-maintenance__group-select">
          <button aria-controls={rowsId} aria-expanded={open} className="thread-maintenance__kept-toggle" type="button"
            onClick={() => setOpen(!open)}>
            {open ? "Show fewer" : `Show all ${outputs.length}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** "node_modules, target": each removed output folder's name, once. */
function outputNames(removedOutput: readonly string[] | undefined): string | undefined {
  const names = [...new Set((removedOutput ?? []).map((folder) => folder.split("/").pop() ?? folder))];
  return names.length ? names.join(", ") : undefined;
}

function HibernateReview(props: {
  scan: ThreadMaintenanceScan;
  selection: ThreadMaintenanceSelection;
  steps: readonly ReviewStep[];
  kept: KeptContext;
  onSelection: (selection: ThreadMaintenanceSelection) => void;
}) {
  const { scan, selection } = props;
  const section = scan.hibernate;
  const items = largestFirst(hibernateItems(scan, selection, props.steps));
  const total = allocationTotal(items);
  const chosen = items.filter((item) => selection.hibernate.has(idleThreadKey(item))).length;
  const toggle = (item: ThreadMaintenanceHibernateCheckout) => {
    const hibernate = new Set(selection.hibernate);
    const key = idleThreadKey(item);
    if (hibernate.has(key)) hibernate.delete(key);
    else hibernate.add(key);
    props.onSelection({ ...selection, hibernate });
  };
  const selectAll = () => {
    const hibernate = new Set(selection.hibernate);
    for (const item of items) {
      if (chosen === items.length) hibernate.delete(idleThreadKey(item));
      else hibernate.add(idleThreadKey(item));
    }
    props.onSelection({ ...selection, hibernate });
  };
  if (!section) {
    return (
      <div className="thread-maintenance__summary">
        <div>
          <p className="thread-maintenance__summary-title">No idle checkouts to hibernate</p>
          <p className="thread-maintenance__summary-sub">This machine&apos;s PwrAgent cannot hibernate checkouts.</p>
        </div>
      </div>
    );
  }
  const kept = keptTotal(section.kept);
  // Rows the archive step already takes in this run.
  const archiving = section.items.length - items.length;
  const days = `${section.idleDays} ${section.idleDays === 1 ? "day" : "days"}`;
  return (
    <>
      <div className="thread-maintenance__summary">
        <div>
          <p className="thread-maintenance__summary-title">
            {items.length
              ? `${items.length} idle ${items.length === 1 ? "checkout" : "checkouts"} can hibernate`
              : "No idle checkouts to hibernate"}
          </p>
          <p className="thread-maintenance__summary-sub">
            {`${section.checked} ${section.checked === 1 ? "checkout" : "checkouts"} on disk checked`}
            {total ? ` · candidates hold ${formatAllocation(total)} on disk` : ""}
            {section.skipped ? ` · ${section.skipped}` : ""}
          </p>
        </div>
        <dl className="thread-maintenance__dispositions">
          <div className="is-candidates">
            <dt>Can hibernate</dt>
            <dd>{items.length}</dd>
            {archiving > 0 ? <dd className="thread-maintenance__disposition-note">{`${archiving} more being archived`}</dd> : null}
          </div>
          {section.notIdleYet !== undefined ? (
            <div>
              <dt>Not idle yet</dt>
              <dd>{section.notIdleYet}</dd>
              <dd className="thread-maintenance__disposition-note">{`active in the last ${days}`}</dd>
            </div>
          ) : null}
          <div>
            <dt>Kept</dt>
            <dd>{kept}</dd>
            <dd className="thread-maintenance__disposition-note">{kept ? "reasons below" : "none"}</dd>
          </div>
          {section.alreadyHibernated !== undefined ? (
            <div className="is-aside">
              <dt>Already hibernated</dt>
              <dd>{section.alreadyHibernated}</dd>
              <dd className="thread-maintenance__disposition-note">not counted above</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="thread-maintenance__rules-strip">
        <span className="thread-maintenance__eyebrow">Rules</span>
        <span>
          {`Idle ${section.idleDays} ${section.idleDays === 1 ? "day" : "days"} · snapshots up to ${section.maxSnapshotMb} MB · ${IGNORED_RULE}`}
        </span>
        <span className="thread-maintenance__eyebrow">Never</span>
        <span className="thread-maintenance__never-inline">kept awake · Agent · running or blocked · watching a PR · shared checkouts</span>
      </div>
      <Coverage coverage={section.coverage} kept={{ ...props.kept, step: "hibernate" }} />
      {items.length > 1 ? (
        <Checkbox checked={chosen === items.length} mixed={chosen > 0 && chosen < items.length}
          label="Select every idle checkout" onChange={selectAll}>
          Select all {items.length}
        </Checkbox>
      ) : null}
      {items.length ? (
        <section className="thread-maintenance__group" aria-label="Can hibernate">
          <div className="thread-maintenance__group-head">
            <span className="thread-maintenance__eyebrow">Can hibernate · {items.length}</span>
            {total ? <span className="thread-maintenance__eyebrow thread-maintenance__group-aside">Largest first · on disk</span> : null}
          </div>
          <ul className="thread-maintenance__rows">
            {items.map((item) => {
              const output = outputNames(item.removedOutput);
              return (
                <li key={idleThreadKey(item)} className="thread-maintenance__row">
                  <Checkbox checked={selection.hibernate.has(idleThreadKey(item))} label={`Hibernate ${item.title}`}
                    onChange={() => toggle(item)} />
                  <div className="thread-maintenance__row-body">
                    <p className="thread-maintenance__row-title">
                      {item.title}
                      {item.branch ? <span className="thread-maintenance__branch">{item.branch}</span> : null}
                    </p>
                    <p className="thread-maintenance__row-meta">
                      <span className={`thread-maintenance__lead-text is-${item.files ? "warn" : "ok"}`}>
                        {item.files ? `${item.files} changed ${item.files === 1 ? "file" : "files"}` : "Clean"}
                      </span>
                      {item.files ? ` · ${formatBytes(item.bytes)} snapshot` : ""}
                      {output ? ` · ${output}` : ""}
                      {` · idle ${formatAge(item.lastActivityAt, scan.startedAt).replace(/ ago$/, "")}`}
                    </p>
                    <OutputClass output={item.space?.rebuildableOutput} />
                    <p className="thread-maintenance__path">{item.worktreePath}</p>
                  </div>
                  <SizeCell space={item.space} />
                </li>
              );
            })}
          </ul>
          <KeptChips kept={section.kept} collapsible />
        </section>
      ) : <KeptChips kept={section.kept} collapsible />}
    </>
  );
}

const STEP_TITLES: Record<ThreadMaintenanceStep, string> = {
  threads: "Idle threads",
  hibernate: "Idle checkouts",
  checkouts: "Archived checkouts",
  expired: "Expired archives",
};

/** Receipt numbers follow the combined run's order. */
const STEP_NUMBERS: Record<ThreadMaintenanceStep, number> = { threads: 1, hibernate: 2, checkouts: 3, expired: 4 };

const STEP_PROGRESS: Record<ThreadMaintenanceStep, string> = {
  threads: "Archiving idle threads",
  hibernate: "Hibernating idle checkouts",
  checkouts: "Removing archived checkouts",
  expired: "Deleting expired archives",
};

/** Whether a request would change nothing. */
function isEmptyRequest(request: ReturnType<typeof buildApplyRequest>): boolean {
  return request.archive.length + request.removeCheckouts.length + request.trashCheckouts.length
    + (request.hibernate?.length ?? 0)
    + (request.removeBuildOutputs?.length ?? 0) === 0
    && !request.removeEmptyFolders;
}

type OpenThread = (thread: { backend: string; threadId: string }) => void;

function RunView(props: {
  run: ThreadMaintenanceRun;
  scan?: ThreadMaintenanceScan;
  mode: ThreadMaintenanceMode;
  steps: readonly ReviewStep[];
  onOpenThread?: OpenThread;
}) {
  const { run, mode } = props;
  // A run an agent started may include steps this dialog's plan does not.
  const railSteps = THREAD_MAINTENANCE_SCAN_STEPS.filter((step) => props.steps.includes(step) || run.current?.step === step
    || run.steps.some((result) => result.step === step && result.ran));
  const failed = run.problems.filter((problem) => problem.kind === "failed");
  const done = run.steps.reduce((sum, step) => sum + step.done, 0);
  return (
    <>
      {run.running ? null : (
        <div className={`thread-maintenance__summary${failed.length ? " is-failed" : ""}`}>
          <div>
            <p className="thread-maintenance__summary-title">
              {failed.length
                ? `Maintenance finished with ${failed.length} ${failed.length === 1 ? "problem" : "problems"}`
                : "Maintenance finished"}
            </p>
            <p className="thread-maintenance__summary-sub">{receiptLine(run, props.scan)}{done === 0 ? " · nothing changed" : ""}</p>
          </div>
        </div>
      )}
      {run.running ? <Rail steps={railSteps} phase="running" run={run} /> : null}
      {THREAD_MAINTENANCE_SCAN_STEPS.map((step) => (
        <ProblemCards key={step} step={step} problems={run.problems.filter((problem) => problem.step === step)} run={run}
          onOpenThread={props.onOpenThread} />
      ))}
      {run.running && run.current ? (
        <div className="thread-maintenance__progress-card" role="status">
          <div className="thread-maintenance__progress-top">
            <span>{STEP_PROGRESS[run.current.step]}</span>
            <span className="thread-maintenance__mono">
              <span>{`${run.current.processed} of ${run.current.total}`}</span>
              <Elapsed since={run.startedAt} />
            </span>
          </div>
          <div aria-hidden="true" className="thread-maintenance__bar">
            <span style={{ width: `${Math.round(100 * run.current.processed / Math.max(1, run.current.total))}%` }} />
          </div>
          {run.current.object ? <p className="thread-maintenance__path">now: {run.current.object}</p> : null}
          {run.stopRequested ? <p className="thread-maintenance__hint">Stopping after this item.</p> : null}
        </div>
      ) : null}
      {run.running ? null : (
        <ul className="thread-maintenance__receipt" aria-label="Steps">
          {run.steps.filter((step) => step.step === "expired" ? mode === "combined" : railSteps.includes(step.step)).map((step) => (
            <li key={step.step}>
              <span className={`thread-maintenance__num${step.failed ? " is-failed" : step.ran ? " is-done" : ""}`}>
                {step.ran && !step.failed ? "✓" : STEP_NUMBERS[step.step]}
              </span>
              <span className="thread-maintenance__rail-title">{STEP_TITLES[step.step]}</span>
              <span className="thread-maintenance__mono">
                {step.step === "expired"
                  ? props.scan?.expired.enabled ? `Hourly sweep · after ${props.scan.expired.retentionDays} days` : "Off"
                  : step.ran
                    ? `${step.done} done${step.kept ? ` · ${step.kept} kept` : ""}${step.failed ? ` · ${step.failed} failed` : ""}`
                    : "Skipped"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function receiptLine(run: ThreadMaintenanceRun, scan?: ThreadMaintenanceScan): string {
  const threads = run.steps.find((step) => step.step === "threads");
  const hibernate = run.steps.find((step) => step.step === "hibernate");
  const checkouts = run.steps.find((step) => step.step === "checkouts");
  return [
    threads?.ran ? `${threads.done} ${threads.done === 1 ? "thread" : "threads"} archived` : undefined,
    hibernate?.ran ? `${hibernate.done} ${hibernate.done === 1 ? "checkout" : "checkouts"} hibernated${removedAllocation(hibernate)}` : undefined,
    checkouts?.ran
      ? `${checkouts.done} ${scan?.checkouts.buildOutputs?.length
        ? checkouts.done === 1 ? "checkout, folder or build output" : "checkouts, folders and build outputs"
        : checkouts.done === 1 ? "checkout or folder" : "checkouts and folders"} removed${removedAllocation(checkouts)}`
      : undefined,
  ].filter(Boolean).join(" · ") || "No steps ran";
}

/** " (18 GB allocation removed)". Summed checkout sizes, not space freed:
 * shared extents can stay allocated. */
function removedAllocation(step: ThreadMaintenanceRun["steps"][number]): string {
  return step.allocatedBytesRemoved ? ` (${formatBytes(step.allocatedBytesRemoved)} allocation removed)` : "";
}

/** One red card for what failed and one blue card for what was kept on
 * purpose, per step. Headline is count + object + what happened. */
function ProblemCards(props: {
  step: ThreadMaintenanceStep;
  problems: ThreadMaintenanceProblem[];
  run: ThreadMaintenanceRun;
  onOpenThread?: OpenThread;
}) {
  const failed = props.problems.filter((problem) => problem.kind === "failed");
  const kept = props.problems.filter((problem) => problem.kind === "kept");
  const noun = props.step === "threads" ? ["thread", "threads"] : ["checkout", "checkouts"];
  const verb = props.step === "threads" ? "archived" : props.step === "hibernate" ? "hibernated" : "removed";
  const result = props.run.steps.find((step) => step.step === props.step);
  return (
    <>
      {failed.length ? (
        <ProblemCard tone="failed" problems={failed} onOpenThread={props.onOpenThread}
          title={`${failed.length} ${failed.length === 1 ? noun[0] : noun[1]} weren't ${verb}`.replace(/^1 (\w+) weren't/, "1 $1 wasn't")}
          sub={`${failed.length === 1 ? "It is" : "They are"} unchanged.${result?.done ? ` The other ${result.done} were ${verb}.` : ""}`} />
      ) : null}
      {kept.length ? (
        <ProblemCard tone="kept" problems={kept} onOpenThread={props.onOpenThread}
          title={`${kept.length} ${kept.length === 1 ? noun[0] : noun[1]} kept`}
          sub="Kept on purpose. Nothing about them changed." />
      ) : null}
    </>
  );
}

function ProblemCard(props: {
  tone: "failed" | "kept";
  title: string;
  sub: string;
  problems: ThreadMaintenanceProblem[];
  onOpenThread?: OpenThread;
}) {
  return (
    <section className={`thread-maintenance__problem is-${props.tone}`} aria-label={props.title}>
      <div className="thread-maintenance__problem-head">
        <span aria-hidden="true" className="thread-maintenance__mark">{props.tone === "failed" ? "!" : "i"}</span>
        <div>
          <p className="thread-maintenance__summary-title">{props.title}</p>
          <p className="thread-maintenance__summary-sub">{props.sub}</p>
        </div>
      </div>
      <ul className="thread-maintenance__problem-rows" tabIndex={props.problems.length > 4 ? 0 : undefined}>
        {groupProblems(props.problems).map((group) => group.problems.length === 1
          ? <ProblemRow key={group.reason} problem={group.problems[0]!} showReason onOpenThread={props.onOpenThread} />
          : <ProblemGroup key={group.reason} reason={group.reason} problems={group.problems} onOpenThread={props.onOpenThread} />)}
      </ul>
    </section>
  );
}

/** Rows shown per reason before "Show all". */
const ROWS_PER_REASON = 3;

/** Rows that share a reason, under one heading with their count, so 22
 * rows with one reason read as one fact. */
function ProblemGroup(props: { reason: string; problems: ThreadMaintenanceProblem[]; onOpenThread?: OpenThread }) {
  const [open, setOpen] = useState(false);
  const rowsId = useId();
  const shown = open ? props.problems : props.problems.slice(0, ROWS_PER_REASON);
  const size = allocationTotal(props.problems.map((problem) => ({
    space: problem.bytes === undefined ? undefined : { allocatedBytes: problem.bytes },
  })));
  // A detail every row shares is said once, in the heading.
  const shared = props.problems.every((problem) => problem.detail === props.problems[0]!.detail)
    ? props.problems[0]!.detail : undefined;
  return (
    <li className="thread-maintenance__problem-group">
      <p className="thread-maintenance__problem-why">
        <b>{props.reason}</b>{` · ${props.problems.length}`}{size ? ` · ${formatAllocation(size)} on disk` : ""}
        {shared ? ` · ${shared}` : ""}
      </p>
      <ul id={rowsId} aria-label={props.reason}>
        {shown.map((problem, index) => (
          <ProblemRow key={`${problem.object}:${index}`} problem={shared ? { ...problem, detail: undefined } : problem}
            onOpenThread={props.onOpenThread} />
        ))}
      </ul>
      {props.problems.length > ROWS_PER_REASON ? (
        <button aria-controls={rowsId} aria-expanded={open} className="thread-maintenance__kept-toggle" type="button"
          onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `Show all ${props.problems.length}`}
        </button>
      ) : null}
    </li>
  );
}

function ProblemRow(props: { problem: ThreadMaintenanceProblem; showReason?: boolean; onOpenThread?: OpenThread }) {
  const { problem } = props;
  const why = [
    problem.detail,
    problem.bytes !== undefined ? `${formatBytes(problem.bytes)} on disk.` : undefined,
  ].filter(Boolean).join(" ");
  return (
    <li>
      <div className="thread-maintenance__problem-text">
        <p className="thread-maintenance__problem-object">{problem.object}</p>
        {props.showReason || why ? (
          <p className="thread-maintenance__problem-why">
            {props.showReason ? <b>{problem.reason}.</b> : null}{why ? `${props.showReason ? " " : ""}${why}` : ""}
          </p>
        ) : null}
      </div>
      {props.onOpenThread && problem.backend && problem.threadId ? (
        <button className="thread-maintenance__open-thread" type="button"
          aria-label={`Open thread ${problem.object}`}
          onClick={() => props.onOpenThread!({ backend: problem.backend!, threadId: problem.threadId! })}>
          Open thread
        </button>
      ) : null}
    </li>
  );
}

/** A run's footnote follows the steps it runs; a run an agent started may
 * not match this dialog's plan. */
function runFootnote(steps: readonly ReviewStep[], run?: ThreadMaintenanceRun): string {
  const ran = run
    ? THREAD_MAINTENANCE_SCAN_STEPS.filter((step) => run.current?.step === step
      || run.steps.some((result) => result.step === step && result.ran))
    : [];
  const shown = ran.length ? ran : steps;
  return !shown.includes("threads") && !shown.includes("checkouts")
    ? "Each checkout comes back when its thread gets a message"
    : "Archived threads can be restored from Settings → Archived Threads";
}

function Footer(props: {
  phase: Phase;
  steps: readonly ReviewStep[];
  scan?: ThreadMaintenanceScan;
  selection?: ThreadMaintenanceSelection;
  run?: ThreadMaintenanceRun;
  onClose: () => void;
  onScan: () => void;
  onRescan: () => void;
  onSkip: (step: ReviewStep) => void;
  onFinish: (step: ReviewStep) => void;
  onStop: () => void;
  onNewScan: () => void;
}) {
  const { scan, selection, steps } = props;
  if (props.phase === "plan" || props.phase === "scanning") {
    const scanning = props.phase === "scanning";
    const none = steps.length === 0;
    return (
      <>
        <span className="thread-maintenance__footnote">{none ? "Tick a step to run" : STOPS_TEXT[steps.length - 1]}</span>
        <span className="thread-maintenance__actions">
          <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onClose}>Close</button>
          <button className="button button--primary thread-maintenance__button" type="button"
            aria-disabled={scanning || none || undefined}
            onClick={() => { if (!scanning && !none) props.onScan(); }}>
            {scanning ? "Scanning…" : "Scan"}
          </button>
        </span>
      </>
    );
  }
  if ((props.phase === "threads" || props.phase === "hibernate") && scan && selection) {
    const step = props.phase;
    const request = buildApplyRequest(scan, selection, step);
    const count = step === "threads" ? request.archive.length : request.hibernate?.length ?? 0;
    const chosenKeys = new Set((request.hibernate ?? []).map(idleThreadKey));
    const size = step === "hibernate"
      ? allocationTotal((scan.hibernate?.items ?? []).filter((item) => chosenKeys.has(idleThreadKey(item))))
      : undefined;
    const next = nextReview(steps, step);
    const [verb, one, many, skip] = step === "threads"
      ? ["Archive", "thread", "threads", "Skip idle threads"]
      : ["Hibernate", "checkout", "checkouts", "Skip idle checkouts"];
    return (
      <>
        <span className="thread-maintenance__footnote">
          <b>{count} selected</b>{size ? ` · ${formatAllocation(size)} on disk` : ""}{next ? ` · then ${STEP_TITLES[next].toLowerCase()}` : ""}
        </span>
        <span className="thread-maintenance__actions">
          {steps[0] === step ? (
            <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onRescan}>Re-scan</button>
          ) : null}
          <button className="button button--ghost thread-maintenance__button" type="button" onClick={() => props.onSkip(step)}>
            {steps.length === 1 ? "Close" : skip}
          </button>
          <button className="button button--primary thread-maintenance__button" type="button"
            aria-disabled={(!next && count === 0) || undefined}
            onClick={() => { if (next || count > 0) props.onFinish(step); }}>
            {!next ? `${verb} ${count} ${count === 1 ? one : many}` : count ? `${verb} ${count} and continue` : "Continue"}
          </button>
        </span>
      </>
    );
  }
  if (props.phase === "checkouts" && scan && selection) {
    const request = buildApplyRequest(scan, selection, steps);
    const checkouts = request.removeCheckouts.length + request.trashCheckouts.length;
    const outputs = request.removeBuildOutputs?.length ?? 0;
    const hibernate = request.hibernate?.length ?? 0;
    const nothing = isEmptyRequest(request);
    const paths = new Set([...request.removeCheckouts, ...request.trashCheckouts].map((item) => item.worktreePath));
    const cleaned = new Set((request.removeBuildOutputs ?? []).map((item) => item.outputPath));
    // An output inside a removed checkout is never in the request, so
    // nothing here is counted twice.
    const size = allocationTotal([
      ...scan.checkouts.items.filter((item) => paths.has(item.worktreePath)),
      ...(scan.checkouts.buildOutputs ?? []).filter((output) => cleaned.has(output.outputPath))
        .map((output) => ({ space: output.space, worktreePath: output.outputPath })),
    ]);
    return (
      <>
        <span className="thread-maintenance__footnote">
          <b>{checkouts + outputs} selected</b>
          {outputs ? ` · ${outputs} build ${outputs === 1 ? "output" : "outputs"}` : ""}
          {size ? ` · ${formatAllocation(size)} on disk` : ""}
          {request.archive.length ? ` · ${request.archive.length} ${request.archive.length === 1 ? "thread" : "threads"} to archive first` : ""}
          {hibernate ? ` · ${hibernate} to hibernate first` : ""}
        </span>
        <span className="thread-maintenance__actions">
          <button className="button button--ghost thread-maintenance__button" type="button" onClick={() => props.onSkip("checkouts")}>Skip checkouts</button>
          <button className="button button--primary thread-maintenance__button" type="button"
            aria-disabled={nothing || undefined}
            onClick={() => { if (!nothing) props.onFinish("checkouts"); }}>
            {checkouts + outputs ? `Remove ${checkouts + outputs} and finish` : "Finish"}
          </button>
        </span>
      </>
    );
  }
  if (props.phase === "running") {
    return (
      <>
        <span className="thread-maintenance__footnote">{runFootnote(steps, props.run)}</span>
        <span className="thread-maintenance__actions">
          <button className="button button--ghost thread-maintenance__button" type="button"
            aria-disabled={props.run?.stopRequested || undefined}
            onClick={() => { if (!props.run?.stopRequested) props.onStop(); }}>
            Stop after this item
          </button>
        </span>
      </>
    );
  }
  return (
    <>
      <span className="thread-maintenance__footnote">{runFootnote(steps, props.run)}</span>
      <span className="thread-maintenance__actions">
        <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onClose}>Close</button>
        <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onNewScan}>New scan</button>
      </span>
    </>
  );
}
