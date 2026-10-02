import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeThreadArchivePolicy,
  type DesktopSettingsConfigPatch,
  type DesktopThreadArchivePolicy,
  type DesktopThreadArchiveSweepStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsCompOption, SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const sweepTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

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
      && next.archived + next.deleted > 0) onSweepChangedRef.current?.();
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
  const changed = (status?.archived ?? 0) + (status?.deleted ?? 0);
  const summary = status ? [
    status.archived > 0 ? `Archived ${status.archived} ${status.archived === 1 ? "thread" : "threads"}.` : "",
    status.deleted > 0 ? `Deleted ${status.deleted} expired ${status.deleted === 1 ? "archive" : "archives"}.` : "",
  ].filter(Boolean).join(" ") || (status.failed > 0 ? "" : "Nothing to archive.") : "";
  const error = requestError ?? (status?.running ? undefined : status?.error);
  return (
    <SettingsField label="Last sweep"
      sub={props.active ? "Sweeps run hourly and retry failures. Run now applies a changed policy right away." : "Sweeps run hourly and retry failures."}
      control={
        <div className="settings-archive-sweep">
          <div className="settings-archive-sweep__line">
            <span className="settings-archive-sweep__status" role="status">
              {!status ? null : status.running ? (
                <>
                  <span className="settings-pathrow__chip settings-pathrow__chip--warn">Running</span>
                  {status.startedAt !== undefined ? <span className="settings-archive-sweep__text">Started {time(status.startedAt)}.</span> : null}
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
                  {summary ? <span className="settings-archive-sweep__text">{summary}</span> : null}
                </>
              )}
            </span>
            {props.active && api.runThreadArchiveSweep ? (
              <button className="button button--ghost settings-section-controls__button settings-archive-sweep__run"
                type="button" aria-disabled={busy || undefined} onClick={() => { void run(); }}>
                Run now
              </button>
            ) : null}
          </div>
          {error ? <p className="settings-archive-sweep__error" role="alert">{error}</p> : null}
          {props.active && status && !status.running && status.nextAt !== undefined ? (
            <p className="settings-archive-sweep__next">
              {status.finishedAt === undefined ? "First" : "Next"} sweep about {time(status.nextAt)}
            </p>
          ) : null}
          {props.active ? null : (
            <p className="settings-archive-sweep__text">Automatic archiving and deletion are off, so sweeps do nothing.</p>
          )}
        </div>
      } />
  );
}
