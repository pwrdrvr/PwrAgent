import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  normalizeThreadArchivePolicy,
  type DesktopSettingsConfigPatch,
  type DesktopThreadArchivePolicy,
  type DesktopThreadArchiveSweepStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { ThreadMaintenanceLauncherContext } from "../maintenance/thread-maintenance-launcher";
import { SettingsCompOption, SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const sweepTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** "Kept 12: Uncommitted changes (8), Pinned thread (4)." The three largest
 * reasons, then a count of the rest. */
function describeKept(kept: Record<string, number> | undefined): string {
  const entries = Object.entries(kept ?? {}).filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return "";
  const shown = entries.slice(0, 3).map(([reason, count]) => `${reason} (${count})`);
  const rest = entries.length - shown.length;
  return `Kept ${total}: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more ${rest === 1 ? "reason" : "reasons"}` : ""}.`;
}

/** One sentence per phase of a finished sweep: threads, retention, worktrees. */
export function archiveSweepSummaryLines(status: DesktopThreadArchiveSweepStatus): string[] {
  const lines: string[] = [];
  const threads = status.threads;
  if (threads?.skipped) lines.push(`Threads: ${threads.skipped}.`);
  else if (threads) {
    lines.push([
      `Checked ${threads.checked} ${threads.checked === 1 ? "thread" : "threads"}.`,
      `Archived ${threads.archived}.`,
      describeKept(threads.kept),
    ].filter(Boolean).join(" "));
  } else if (status.archived > 0) {
    lines.push(`Archived ${status.archived} ${status.archived === 1 ? "thread" : "threads"}.`);
  }
  // A pass that is off says nothing here; its own setting lives in Worktrees.
  const hibernation = status.hibernation;
  if (hibernation && !hibernation.skipped && hibernation.checked > 0) {
    lines.push([
      `Hibernated ${hibernation.hibernated} idle ${hibernation.hibernated === 1 ? "checkout" : "checkouts"}.`,
      describeKept(hibernation.kept),
    ].filter(Boolean).join(" "));
  }
  if (status.deleted > 0) lines.push(`Deleted ${status.deleted} expired ${status.deleted === 1 ? "archive" : "archives"}.`);
  const worktrees = status.worktrees;
  if (worktrees) {
    lines.push([
      `Cleaned ${worktrees.removed} of ${worktrees.candidates} archived worktrees.`,
      worktrees.kept ? describeKept(worktrees.kept) : `Protected ${worktrees.protected}.`,
    ].filter(Boolean).join(" "));
    if (worktrees.emptyContainers) {
      lines.push(`Cleaned ${worktrees.removedContainers ?? 0} of ${worktrees.emptyContainers} empty worktree folders.`);
    }
  }
  return lines;
}

export function ArchivePolicySettings(props: {
  value?: DesktopThreadArchivePolicy;
  onWriteConfig?: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  desktopApi?: DesktopApi;
  /** A finished sweep archived or deleted threads. */
  onSweepChanged?: () => void;
}) {
  const [policy, setPolicy] = useState(() => normalizeThreadArchivePolicy(props.value));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setPolicy(normalizeThreadArchivePolicy(props.value)); }, [props.value]);
  const save = async (patch: Partial<DesktopThreadArchivePolicy>) => {
    if (!props.onWriteConfig || pending) return;
    const next = normalizeThreadArchivePolicy({ ...policy, ...patch });
    setPolicy(next);
    setPending(true);
    setError(undefined);
    try {
      if (!await props.onWriteConfig({ worktrees: { archive: next } })) {
        setError("Archive settings could not be saved.");
        setPolicy(normalizeThreadArchivePolicy(props.value));
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setPolicy(normalizeThreadArchivePolicy(props.value));
    } finally { setPending(false); }
  };
  const disabled = pending || !props.onWriteConfig;
  const number = (key: "keepPerProject" | "inactivityDays" | "retentionDays", label: string, minimum = 1) => (
    <input aria-label={label} className="settings-input" disabled={disabled} min={minimum}
      max={key === "keepPerProject" ? 10000 : 3650} type="number" key={`${key}:${policy[key]}`} defaultValue={policy[key]}
      onBlur={(event) => { void save({ [key]: Number(event.target.value) }); }} />
  );
  return (
    <SettingsSection sectionId="archive-policy" title="Automatic archiving" description="Pinned threads, Agent threads, active chats, and other protected work are always kept.">
      <SettingsField label="Automatically archive threads" control={<SettingsSwitch label="Automatically archive threads"
        checked={policy.enabled} disabled={disabled} pending={pending} onChange={(enabled) => { void save({ enabled }); }} />} />
      <div className="settings-comp-opts" role="radiogroup" aria-label="Automatic archive mode">
        <SettingsCompOption value="count" title="Keep a number per project" sub="Keep the newest eligible threads separately in each project. Protected threads are kept in addition to this number."
          active={policy.mode === "count"} isDefault disabled={disabled} onSelect={(mode) => { void save({ mode }); }} />
        <SettingsCompOption value="age" title="Archive after inactivity" sub="Archive eligible threads after they have been untouched for the selected number of days."
          active={policy.mode === "age"} disabled={disabled} onSelect={(mode) => { void save({ mode }); }} />
      </div>
      {policy.mode === "count"
        ? <SettingsField label="Eligible threads per project" sub={`Keep ${policy.keepPerProject} eligible threads in every project, plus all of its pinned, Agent, active, and other protected threads.`}
          control={number("keepPerProject", "Eligible threads per project")} />
        : <SettingsField label="Days untouched" sub="Viewing or restoring a thread counts as activity."
          control={number("inactivityDays", "Days untouched")} />}
      <SettingsField label="Permanently delete expired archives" sub="Delete expired conversations and their retained recovery snapshots. This cannot be undone."
        control={<SettingsSwitch label="Permanently delete expired archives" checked={policy.retentionDays > 0}
          disabled={disabled} onChange={(enabled) => { void save({ retentionDays: enabled ? 30 : 0 }); }} />} />
      {policy.retentionDays > 0
        ? <SettingsField label="Keep archives for days" sub="Measured from archival."
          control={number("retentionDays", "Keep archives for days")} />
        : <p className="settings-panel__hint">Archived threads and their recovery snapshots are kept until you choose an automatic deletion period.</p>}
      {policy.retentionDays > 0 ? <p className="settings-panel__hint">Protected or restored threads do not expire. Existing archives without a recorded archive date start their retention period when first discovered. For ACP providers, deletion removes PwrAgent’s stored conversation; the provider may retain its own history.</p> : null}
      <ArchiveSweepField desktopApi={props.desktopApi} active={policy.enabled || policy.retentionDays > 0}
        onSweepChanged={props.onSweepChanged} />
      {error ? <p className="settings-panel__hint" role="alert">{error}</p> : null}
    </SettingsSection>
  );
}

function ArchiveSweepField(props: { desktopApi?: DesktopApi; active: boolean; onSweepChanged?: () => void }) {
  const api = props.desktopApi;
  const [status, setStatus] = useState<DesktopThreadArchiveSweepStatus>();
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string>();
  const onSweepChangedRef = useRef(props.onSweepChanged);
  useEffect(() => { onSweepChangedRef.current = props.onSweepChanged; }, [props.onSweepChanged]);
  // Undefined until the first status arrives: the sweep that finished before
  // this pane mounted is already reflected in the list it loaded.
  const seenFinishedAtRef = useRef<number | null | undefined>(undefined);
  const receive = useCallback((next: DesktopThreadArchiveSweepStatus) => {
    setStatus(next);
    if (next.running) return;
    const seen = seenFinishedAtRef.current;
    seenFinishedAtRef.current = next.finishedAt ?? null;
    if (seen !== undefined && next.finishedAt !== undefined && next.finishedAt !== seen
      && next.archived + next.deleted + (next.worktrees?.removed ?? 0) + (next.worktrees?.removedContainers ?? 0) > 0) onSweepChangedRef.current?.();
  }, []);
  useEffect(() => {
    if (!api?.getThreadArchiveSweepStatus) return;
    let cancelled = false;
    const unsubscribe = api.onThreadArchiveSweepStatusChanged?.((next) => { if (!cancelled) receive(next); });
    api.getThreadArchiveSweepStatus().then(
      (next) => { if (!cancelled) receive(next); },
      (error: unknown) => { if (!cancelled) setRequestError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { cancelled = true; unsubscribe?.(); };
  }, [api, receive]);
  const openThreadMaintenance = useContext(ThreadMaintenanceLauncherContext);
  if (!api?.getThreadArchiveSweepStatus) return null;

  const busy = requesting || status?.running === true;
  const run = async () => {
    if (!api.runThreadArchiveSweep || busy) return;
    setRequesting(true);
    setRequestError(undefined);
    try { receive(await api.runThreadArchiveSweep()); }
    catch (error) { setRequestError(error instanceof Error ? error.message : String(error)); }
    finally { setRequesting(false); }
  };
  const time = (at: number) => sweepTimeFormatter.format(at);
  const changed = (status?.archived ?? 0) + (status?.deleted ?? 0)
    + (status?.worktrees?.removed ?? 0) + (status?.worktrees?.removedContainers ?? 0);
  const finished = status !== undefined && !status.running && status.finishedAt !== undefined;
  const summaryLines = finished ? archiveSweepSummaryLines(status) : [];
  if (finished && summaryLines.length === 0 && status.failed === 0) summaryLines.push("Nothing to archive.");
  // Every recorded failure, not only the first; `failed` counts any beyond the cap.
  const failures = finished
    ? status.failures?.map((failure) => failure.path && !failure.message.includes(failure.path)
      ? `${failure.message} (${failure.path})`
      : failure.message) ?? (status.error ? [status.error] : [])
    : [];
  const unlisted = finished ? Math.max(0, status.failed - failures.length) : 0;
  return (
    <SettingsField label="Last sweep"
      sub={openThreadMaintenance
        ? "Sweeps run hourly. Review shows which threads are idle and why each was kept."
        : "Run now also retries archived worktree cleanup. Recovery snapshots exclude ignored files and keep oversized checkouts in place."}
      control={
        <div className="settings-archive-sweep">
          <div className="settings-archive-sweep__line">
            <span className="settings-archive-sweep__status" role="status">
              {!status ? null : status.running ? (
                <>
                  <span className="settings-pathrow__chip settings-pathrow__chip--warn">Running</span>
                  {status.startedAt !== undefined ? <span className="settings-archive-sweep__text">Started {time(status.startedAt)}.</span> : null}
                  {status.worktrees ? <span className="settings-archive-sweep__text">Worktrees: {status.worktrees.processed} of {status.worktrees.candidates} checked, {status.worktrees.removed} cleaned, {status.worktrees.protected} protected.</span> : null}
                  {status.worktrees?.emptyContainers ? <span className="settings-archive-sweep__text">Folders: {status.worktrees.processedContainers ?? 0} of {status.worktrees.emptyContainers} checked, {status.worktrees.removedContainers ?? 0} cleaned.</span> : null}
                </>
              ) : status.finishedAt === undefined ? (
                <span className="settings-pathrow__chip">Not run yet</span>
              ) : (
                <>
                  {status.failed > 0 ? (
                    <span className="settings-pathrow__chip settings-pathrow__chip--err">
                      {changed > 0 ? `${status.failed} failed` : "Failed"}
                    </span>
                  ) : null}
                  <span className="settings-archive-sweep__time">{time(status.finishedAt)}</span>
                </>
              )}
            </span>
            <span className="settings-archive-sweep__buttons">
              {openThreadMaintenance ? (
                <button className="button button--ghost settings-section-controls__button settings-archive-sweep__run"
                  type="button" onClick={() => openThreadMaintenance()}>
                  Review…
                </button>
              ) : null}
              {api.runThreadArchiveSweep ? (
                <button className="button button--ghost settings-section-controls__button settings-archive-sweep__run"
                  type="button" aria-disabled={busy || undefined} onClick={() => { void run(); }}>
                  Run now
                </button>
              ) : null}
            </span>
          </div>
          {summaryLines.map((line) => <p key={line} className="settings-archive-sweep__text">{line}</p>)}
          {requestError ? <p className="settings-archive-sweep__error" role="alert">{requestError}</p> : null}
          {failures.length ? (
            <div role="alert">
              {failures.map((failure, index) => <p key={index} className="settings-archive-sweep__error">{failure}</p>)}
              {unlisted > 0 ? <p className="settings-archive-sweep__error">and {unlisted} more</p> : null}
            </div>
          ) : null}
          {props.active && status && !status.running && status.nextAt !== undefined ? (
            <p className="settings-archive-sweep__next">
              {status.finishedAt === undefined ? "First" : "Next"} sweep about {time(status.nextAt)}
            </p>
          ) : null}
          {props.active ? null : (
            <p className="settings-archive-sweep__text">Automatic archiving and deletion are off. Run now can still clean up worktrees of already archived threads.</p>
          )}
        </div>
      } />
  );
}
