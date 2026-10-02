import { useEffect, useState } from "react";
import {
  normalizeThreadArchivePolicy,
  type DesktopSettingsConfigPatch,
  type DesktopThreadArchivePolicy,
} from "@pwragent/shared";
import { SettingsCompOption, SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

export function ArchivePolicySettings(props: {
  value?: DesktopThreadArchivePolicy;
  onWriteConfig?: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
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
        ? <SettingsField label="Keep archives for days" sub="Measured from archival; cleanup runs hourly and retries failures."
          control={number("retentionDays", "Keep archives for days")} />
        : <p className="settings-section__description">Archived threads and their recovery snapshots are kept until you choose an automatic deletion period.</p>}
      {policy.retentionDays > 0 ? <p className="settings-section__description">Protected or restored threads do not expire. Existing archives without a recorded archive date start their retention period when first discovered. For ACP providers, deletion removes PwrAgent’s stored conversation; the provider may retain its own history.</p> : null}
      {error ? <p className="settings-archive-banner__text" role="alert">{error}</p> : null}
    </SettingsSection>
  );
}
