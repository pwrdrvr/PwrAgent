import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  defaultThreadMaintenanceRules,
  normalizeThreadArchivePolicy,
  type DesktopThreadArchivePolicy,
  type ThreadMaintenanceArchivedCheckout,
  type ThreadMaintenanceIdleThread,
  type ThreadMaintenanceProblem,
  type ThreadMaintenanceProject,
  type ThreadMaintenanceRules,
  type ThreadMaintenanceRun,
  type ThreadMaintenanceScan,
  type ThreadMaintenanceStep,
} from "@pwragent/shared";
import { PendingSpinner } from "../../components/PendingSpinner";
import { CloseIcon } from "../../icons";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { useModalDialog } from "../../lib/useModalDialog";
import {
  allIdleThreads,
  buildApplyRequest,
  defaultSelection,
  formatAge,
  formatBytes,
  idleThreadKey,
  keptEntries,
  keptTotal,
  needsDecision,
  workspaceLead,
  type OverLimitDecision,
  type ThreadMaintenanceMode,
  type ThreadMaintenanceSelection,
} from "./thread-maintenance-selection";
import {
  newerRun,
  threadMaintenancePhase,
  type ThreadMaintenancePhase,
  type ThreadMaintenanceStoredPhase,
} from "./thread-maintenance-run-state";

type Phase = ThreadMaintenancePhase;

const MODE_TABS: { mode: ThreadMaintenanceMode; label: string }[] = [
  { mode: "combined", label: "Combined" },
  { mode: "threads", label: "Idle threads" },
  { mode: "checkouts", label: "Archived checkouts" },
];

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

/**
 * Thread maintenance: a plan, a review for each step, then one run. Nothing
 * changes until the operator presses the final button. Modelled on PwrGit's
 * Repository maintenance, with PwrAgent's archive rules.
 */
export function ThreadMaintenanceDialog(props: {
  desktopApi?: DesktopApi;
  policy?: DesktopThreadArchivePolicy;
  projectKey?: string;
  /** Shows a thread from a finished run's outcome rows. The caller closes
   * the dialog; a run still in progress keeps it open. */
  onOpenThread?: (thread: { backend: string; threadId: string }) => void;
  onClose: () => void;
}) {
  const api = props.desktopApi;
  const policy = useMemo(() => normalizeThreadArchivePolicy(props.policy), [props.policy]);
  const [mode, setMode] = useState<ThreadMaintenanceMode>("combined");
  const [rules, setRules] = useState<ThreadMaintenanceRules>(() => defaultThreadMaintenanceRules(policy));
  const [storedPhase, setPhase] = useState<ThreadMaintenanceStoredPhase>("plan");
  const [scan, setScan] = useState<ThreadMaintenanceScan>();
  const [selection, setSelection] = useState<ThreadMaintenanceSelection>();
  const [run, setRun] = useState<ThreadMaintenanceRun>();
  const [error, setError] = useState<string>();
  const phase = threadMaintenancePhase(storedPhase, run);
  const busy = phase === "running";
  // Closing never stops a run: it keeps going in the background, and opening
  // the dialog again shows it.
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose: props.onClose });

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

  const startScan = useCallback(async () => {
    if (!api?.scanThreadMaintenance) return;
    setPhase("scanning");
    setError(undefined);
    try {
      const next = await api.scanThreadMaintenance({ rules, ...(props.projectKey ? { projectKey: props.projectKey } : {}) });
      setScan(next);
      setSelection(defaultSelection(next));
      setPhase(mode === "checkouts" ? "checkouts" : "threads");
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
      setPhase("plan");
    }
  }, [api, mode, props.projectKey, rules]);

  const startRun = useCallback(async (runMode: ThreadMaintenanceMode, chosen = selection) => {
    if (!api?.applyThreadMaintenance || !scan || !chosen) return;
    setError(undefined);
    try {
      showRun(await api.applyThreadMaintenance(buildApplyRequest(scan, chosen, runMode)));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    }
  }, [api, scan, selection, showRun]);

  const finishThreads = () => {
    if (mode === "threads") void startRun("threads");
    else setPhase("checkouts");
  };

  const headChip = phase === "threads" && scan
    ? `${allIdleThreads(scan).length} found`
    : phase === "checkouts" && scan
      ? `${scan.checkouts.items.length} found`
      : phase === "running" && run?.current
        ? `${run.current.processed} / ${run.current.total}`
        : undefined;

  return (
    <div className="thread-maintenance-modal"
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div ref={dialogRef} aria-labelledby="thread-maintenance-title" aria-modal="true"
        className="thread-maintenance" role="dialog" tabIndex={-1}>
        <div className="thread-maintenance__head">
          <div>
            <h2 id="thread-maintenance-title">Thread maintenance</h2>
            {phase === "plan" || phase === "scanning" || phase === "threads" ? (
              <p>Find idle threads and the checkouts they keep on disk. Archive what you are done with. Changes are saved before any checkout is removed.</p>
            ) : null}
          </div>
          <div className="thread-maintenance__head-side">
            {headChip ? <span className="settings-pathrow__chip">{headChip}</span> : null}
            <button aria-label="Close thread maintenance" className="workspace-handoff-dialog__close"
              type="button" onClick={props.onClose}><CloseIcon size={14} /></button>
          </div>
        </div>
        <div className="thread-maintenance__body">
          {phase === "plan" || phase === "scanning" ? (
            <ModeTabs mode={mode} disabled={phase === "scanning"} onChange={setMode} />
          ) : phase === "threads" || phase === "checkouts" ? (
            <ModeTabs mode={mode} disabled onChange={setMode} />
          ) : null}
          {phase === "plan" || phase === "scanning" ? (
            <PlanView mode={mode} rules={rules} policy={policy} onRules={setRules} />
          ) : null}
          {phase === "scanning" ? (
            <div className="thread-maintenance__progress" role="status">
              <PendingSpinner size="sm" pairing="paired" />
              <span>Reading threads and checkouts…</span>
            </div>
          ) : null}
          {(phase === "threads" || phase === "checkouts") && scan && selection ? (
            <>
              <Rail mode={mode} phase={phase} scan={scan} selection={selection} />
              {phase === "threads"
                ? <IdleThreadsReview scan={scan} selection={selection} onSelection={setSelection} />
                : <CheckoutsReview scan={scan} selection={selection} onSelection={setSelection} />}
            </>
          ) : null}
          {(phase === "running" || phase === "finished") && run ? (
            <RunView run={run} scan={scan} mode={mode} onOpenThread={busy ? undefined : props.onOpenThread} />
          ) : null}
          {error ? <p className="thread-maintenance__error" role="alert">{error}</p> : null}
        </div>
        <div className="thread-maintenance__foot">
          <Footer phase={phase} mode={mode} scan={scan} selection={selection} run={run}
            onClose={props.onClose}
            onScan={() => { void startScan(); }}
            onRescan={() => { setScan(undefined); setSelection(undefined); setPhase("plan"); }}
            onSkipThreads={() => {
              if (!selection) return;
              setSelection({ ...selection, threads: new Set() });
              if (mode === "threads") props.onClose();
              else setPhase("checkouts");
            }}
            onFinishThreads={finishThreads}
            onSkipCheckouts={() => {
              if (!selection) return;
              const next = { ...selection, checkouts: new Set<string>(), emptyFolders: false };
              setSelection(next);
              if (mode === "checkouts") props.onClose();
              else if (scan && buildApplyRequest(scan, next, "threads").archive.length === 0) props.onClose();
              else void startRun(mode, next);
            }}
            onFinishCheckouts={() => { void startRun(mode); }}
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

function PlanView(props: {
  mode: ThreadMaintenanceMode;
  rules: ThreadMaintenanceRules;
  policy: DesktopThreadArchivePolicy;
  onRules: (rules: ThreadMaintenanceRules) => void;
}) {
  const { rules } = props;
  const threads = props.mode !== "checkouts";
  const checkouts = props.mode !== "threads";
  return (
    <>
      <p className="thread-maintenance__lead">
        {props.mode === "combined"
          ? "Runs top to bottom on this machine. Each step stops for your review."
          : "Runs one step on this machine and stops for your review."}
      </p>
      {threads ? (
        <section className="thread-maintenance__plan" aria-label="Archive idle threads">
          <div className="thread-maintenance__plan-top">
            <span className="thread-maintenance__num">1</span>
            <div>
              <h3>Archive idle threads</h3>
              <p>Threads past each project&apos;s keep count, or untouched for the chosen days. Their worktrees are removed after any changes are saved.</p>
            </div>
            <span className="settings-pathrow__chip settings-pathrow__chip--warn">Pauses for review</span>
          </div>
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
            <Checkbox checked={rules.rebuildableOutputIsClean} label="Count dependencies and build output as clean"
              onChange={() => props.onRules({ ...rules, rebuildableOutputIsClean: !rules.rebuildableOutputIsClean })}>
              Count dependencies and build output as clean
              <span className="thread-maintenance__hint">node_modules, dist, target… Other ignored files, like .env.local, still keep the checkout.</span>
            </Checkbox>
          </div>
        </section>
      ) : null}
      {checkouts ? (
        <section className="thread-maintenance__plan" aria-label="Remove archived checkouts">
          <div className="thread-maintenance__plan-top">
            <span className="thread-maintenance__num">{threads ? 2 : 1}</span>
            <div>
              <h3>Remove archived checkouts</h3>
              <p>Worktrees still on disk for archived threads, empty worktree folders, and checkouts whose repository is gone.</p>
            </div>
            <span className="settings-pathrow__chip settings-pathrow__chip--warn">Pauses for review</span>
          </div>
        </section>
      ) : null}
      {props.mode === "combined" ? (
        <section className="thread-maintenance__plan is-off" aria-label="Delete expired archives">
          <div className="thread-maintenance__plan-top">
            <span className="thread-maintenance__num">3</span>
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
          <dt>files</dt><dd>Ignored files other than dependencies and build output, and anything outside a managed worktree folder</dd>
        </dl>
      </div>
    </>
  );
}

function Rail(props: { mode: ThreadMaintenanceMode; phase: Phase; scan?: ThreadMaintenanceScan; selection?: ThreadMaintenanceSelection; run?: ThreadMaintenanceRun }) {
  const steps: { step: ThreadMaintenanceStep; title: string }[] = [
    ...(props.mode !== "checkouts" ? [{ step: "threads" as const, title: "Idle threads" }] : []),
    ...(props.mode !== "threads" ? [{ step: "checkouts" as const, title: "Archived checkouts" }] : []),
  ];
  return (
    <ol className="thread-maintenance__rail" aria-label="Steps">
      {steps.map((item, index) => {
        const result = props.run?.steps.find((step) => step.step === item.step);
        const active = props.run
          ? props.run.running && props.run.current?.step === item.step
          : props.phase === item.step;
        const done = props.run ? !!result && !active && (!props.run.running || props.run.current?.step !== item.step) : index < steps.findIndex((step) => step.step === props.phase);
        const failed = !!result && result.failed > 0;
        const subtitle = props.run
          ? active ? `${props.run.current?.processed ?? 0} of ${props.run.current?.total ?? 0}`
            : result ? `${result.done} done${result.kept ? ` · ${result.kept} kept` : ""}${result.failed ? ` · ${result.failed} failed` : ""}` : "next"
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

function KeptChips(props: { kept: Record<string, number> }) {
  const entries = keptEntries(props.kept);
  if (!entries.length) return null;
  return (
    <div className="thread-maintenance__kept">
      <p className="thread-maintenance__eyebrow">Kept {keptTotal(props.kept)}</p>
      <div className="thread-maintenance__chips">
        {entries.map(([reason, count]) => (
          <span key={reason} className="settings-pathrow__chip thread-maintenance__chip"><b>{count}</b> {reason}</span>
        ))}
      </div>
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
        <span>{ruleText} · snapshots up to the limit · {scan.rules.rebuildableOutputIsClean ? "dependencies and build output count as clean" : "any ignored file keeps the checkout"}</span>
        <span className="thread-maintenance__eyebrow">Never</span>
        <span className="thread-maintenance__never-inline">pinned · Agent · running or blocked · watching a PR · other ignored files</span>
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
      {props.showSpace && row.space ? (
        <span className="thread-maintenance__size">{row.space.lowerBound ? "≥ " : ""}{formatBytes(row.space.privateBytes)}</span>
      ) : null}
    </li>
  );
}

function CheckoutsReview(props: {
  scan: ThreadMaintenanceScan;
  selection: ThreadMaintenanceSelection;
  onSelection: (selection: ThreadMaintenanceSelection) => void;
}) {
  const { scan, selection } = props;
  const owned = scan.checkouts.items.filter((item) => item.kind !== "unreferenced");
  const removable = owned.filter((item) => item.kind === "removable");
  const gone = owned.filter((item) => item.kind === "repositoryGone");
  const unreferenced = scan.checkouts.items.filter((item) => item.kind === "unreferenced");
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
            {removable.length ? `${removable.length} archived ${removable.length === 1 ? "checkout is" : "checkouts are"} still on disk` : "No archived checkouts to remove"}
          </p>
          <p className="thread-maintenance__summary-sub">
            {`${keptTotal(scan.checkouts.kept)} kept · ${scan.checkouts.emptyFolders} empty ${scan.checkouts.emptyFolders === 1 ? "folder" : "folders"}`}
            {scan.checkouts.skipped ? ` · ${scan.checkouts.skipped}` : ""}
          </p>
        </div>
      </div>
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
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {unreferenced.length ? (
        <section className="thread-maintenance__group" aria-label="No thread">
          <div className="thread-maintenance__group-head">
            <span className="thread-maintenance__eyebrow">No thread · {unreferenced.length}</span>
          </div>
          <ul className="thread-maintenance__rows">
            {unreferenced.map((item) => {
              const lead = workspaceLead(item.workspace);
              return (
                <li key={item.worktreePath} className="thread-maintenance__row">
                  <Checkbox checked={selection.checkouts.has(item.worktreePath)} label={`Remove ${item.worktreePath}`} onChange={() => toggle(item)} />
                  <div className="thread-maintenance__row-body">
                    <p className="thread-maintenance__row-title is-path">{item.worktreePath}</p>
                    <p className="thread-maintenance__row-meta">
                      <span className={`thread-maintenance__lead-text is-${lead.tone}`}>{lead.text}</span>
                      {" · No thread refers to this checkout. Git saves its changes to a recovery snapshot before it is removed."}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
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

const STEP_TITLES: Record<ThreadMaintenanceStep, string> = {
  threads: "Idle threads",
  checkouts: "Archived checkouts",
  expired: "Expired archives",
};

type OpenThread = (thread: { backend: string; threadId: string }) => void;

function RunView(props: { run: ThreadMaintenanceRun; scan?: ThreadMaintenanceScan; mode: ThreadMaintenanceMode; onOpenThread?: OpenThread }) {
  const { run, mode } = props;
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
            <p className="thread-maintenance__summary-sub">{receiptLine(run)}{done === 0 ? " · nothing changed" : ""}</p>
          </div>
        </div>
      )}
      {run.running ? <Rail mode={mode} phase="running" run={run} /> : null}
      {(["threads", "checkouts"] as const).map((step) => (
        <ProblemCards key={step} step={step} problems={run.problems.filter((problem) => problem.step === step)} run={run}
          onOpenThread={props.onOpenThread} />
      ))}
      {run.running && run.current ? (
        <div className="thread-maintenance__progress-card" role="status">
          <div className="thread-maintenance__progress-top">
            <span>{run.current.step === "threads" ? "Archiving idle threads" : "Removing archived checkouts"}</span>
            <span className="thread-maintenance__mono">{`${run.current.processed} of ${run.current.total}`}</span>
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
          {run.steps.filter((step) => mode === "combined" || step.step === mode).map((step) => (
            <li key={step.step}>
              <span className={`thread-maintenance__num${step.failed ? " is-failed" : step.ran ? " is-done" : ""}`}>
                {step.ran && !step.failed ? "✓" : step.step === "threads" ? 1 : step.step === "checkouts" ? 2 : 3}
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

function receiptLine(run: ThreadMaintenanceRun): string {
  const threads = run.steps.find((step) => step.step === "threads");
  const checkouts = run.steps.find((step) => step.step === "checkouts");
  return [
    threads?.ran ? `${threads.done} ${threads.done === 1 ? "thread" : "threads"} archived` : undefined,
    checkouts?.ran ? `${checkouts.done} ${checkouts.done === 1 ? "checkout or folder" : "checkouts and folders"} removed` : undefined,
  ].filter(Boolean).join(" · ") || "No steps ran";
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
  const result = props.run.steps.find((step) => step.step === props.step);
  return (
    <>
      {failed.length ? (
        <ProblemCard tone="failed" problems={failed} onOpenThread={props.onOpenThread}
          title={`${failed.length} ${failed.length === 1 ? noun[0] : noun[1]} ${props.step === "threads" ? "weren't archived" : "weren't removed"}`.replace(/^1 (\w+) weren't/, "1 $1 wasn't")}
          sub={`${failed.length === 1 ? "It is" : "They are"} unchanged.${result?.done ? ` The other ${result.done} ${props.step === "threads" ? "were archived" : "were removed"}.` : ""}`} />
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
        {props.problems.map((problem, index) => (
          <li key={`${problem.object}:${index}`}>
            <div className="thread-maintenance__problem-text">
              <p className="thread-maintenance__problem-object">{problem.object}</p>
              <p className="thread-maintenance__problem-why"><b>{problem.reason}.</b>{problem.detail ? ` ${problem.detail}` : ""}</p>
            </div>
            {props.onOpenThread && problem.backend && problem.threadId ? (
              <button className="thread-maintenance__open-thread" type="button"
                aria-label={`Open thread ${problem.object}`}
                onClick={() => props.onOpenThread!({ backend: problem.backend!, threadId: problem.threadId! })}>
                Open thread
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Footer(props: {
  phase: Phase;
  mode: ThreadMaintenanceMode;
  scan?: ThreadMaintenanceScan;
  selection?: ThreadMaintenanceSelection;
  run?: ThreadMaintenanceRun;
  onClose: () => void;
  onScan: () => void;
  onRescan: () => void;
  onSkipThreads: () => void;
  onFinishThreads: () => void;
  onSkipCheckouts: () => void;
  onFinishCheckouts: () => void;
  onStop: () => void;
  onNewScan: () => void;
}) {
  const { scan, selection } = props;
  if (props.phase === "plan" || props.phase === "scanning") {
    return (
      <>
        <span className="thread-maintenance__footnote">
          {props.mode === "combined" ? "Stops twice for you" : "Stops once for you"}
        </span>
        <span className="thread-maintenance__actions">
          <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onClose}>Close</button>
          <button className="button button--primary thread-maintenance__button" type="button"
            aria-disabled={props.phase === "scanning" || undefined}
            onClick={() => { if (props.phase !== "scanning") props.onScan(); }}>
            Scan
          </button>
        </span>
      </>
    );
  }
  if (props.phase === "threads" && scan && selection) {
    const count = buildApplyRequest(scan, selection, "threads").archive.length;
    const last = props.mode === "threads";
    return (
      <>
        <span className="thread-maintenance__footnote"><b>{count} selected</b>{last ? "" : " · then archived checkouts"}</span>
        <span className="thread-maintenance__actions">
          <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onRescan}>Re-scan</button>
          <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onSkipThreads}>
            {last ? "Close" : "Skip idle threads"}
          </button>
          <button className="button button--primary thread-maintenance__button" type="button"
            aria-disabled={(last && count === 0) || undefined}
            onClick={() => { if (!last || count > 0) props.onFinishThreads(); }}>
            {last ? `Archive ${count} ${count === 1 ? "thread" : "threads"}` : count ? `Archive ${count} and continue` : "Continue"}
          </button>
        </span>
      </>
    );
  }
  if (props.phase === "checkouts" && scan && selection) {
    const request = buildApplyRequest(scan, selection, props.mode);
    const checkouts = request.removeCheckouts.length + request.trashCheckouts.length + (request.removeUnreferenced?.length ?? 0);
    const nothing = request.archive.length + checkouts === 0 && !request.removeEmptyFolders;
    return (
      <>
        <span className="thread-maintenance__footnote">
          <b>{checkouts} selected</b>
          {request.archive.length ? ` · ${request.archive.length} ${request.archive.length === 1 ? "thread" : "threads"} to archive first` : ""}
        </span>
        <span className="thread-maintenance__actions">
          <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onSkipCheckouts}>Skip checkouts</button>
          <button className="button button--primary thread-maintenance__button" type="button"
            aria-disabled={nothing || undefined}
            onClick={() => { if (!nothing) props.onFinishCheckouts(); }}>
            {checkouts ? `Remove ${checkouts} and finish` : "Finish"}
          </button>
        </span>
      </>
    );
  }
  if (props.phase === "running") {
    return (
      <>
        <span className="thread-maintenance__footnote">Archived threads can be restored from Settings → Archived Threads</span>
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
      <span className="thread-maintenance__footnote">Archived threads can be restored from Settings → Archived Threads</span>
      <span className="thread-maintenance__actions">
        <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onClose}>Close</button>
        <button className="button button--ghost thread-maintenance__button" type="button" onClick={props.onNewScan}>New scan</button>
      </span>
    </>
  );
}
