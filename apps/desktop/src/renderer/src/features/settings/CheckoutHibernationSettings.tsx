import { useEffect, useState } from "react";
import {
  CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES,
  normalizeCheckoutHibernationPolicy,
  type DesktopCheckoutHibernationPolicy,
  type DesktopSettingsConfigPatch,
  type DesktopThreadArchivePolicy,
} from "@pwragent/shared";
import { Select } from "../../components/Select";
import { SegmentedField, SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const SNAPSHOT_OPTIONS = CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES.map((mb) => ({ value: String(mb), label: `${mb} MB` }));

const RESTORE_OPTIONS: Array<{ label: string; value: DesktopCheckoutHibernationPolicy["restoreOn"] }> = [
  { label: "On send", value: "send" },
  { label: "On open", value: "open" },
];

/**
 * Settings → Worktrees → Hibernate idle checkouts. Each change writes at
 * once, like the archive policy beside it in Archived Threads.
 */
export function CheckoutHibernationSettings(props: {
  value?: DesktopCheckoutHibernationPolicy;
  archive?: DesktopThreadArchivePolicy;
  onWriteConfig?: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  const normalize = (value?: Partial<DesktopCheckoutHibernationPolicy>) => normalizeCheckoutHibernationPolicy(value, props.archive);
  const [policy, setPolicy] = useState(() => normalize(props.value));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setPolicy(normalizeCheckoutHibernationPolicy(props.value, props.archive));
  }, [props.value, props.archive]);
  const save = async (patch: Partial<DesktopCheckoutHibernationPolicy>) => {
    if (!props.onWriteConfig || pending) return;
    const next = normalize({ ...policy, ...patch });
    setPolicy(next);
    setPending(true);
    setError(undefined);
    try {
      if (!await props.onWriteConfig({ worktrees: { hibernate: next } })) {
        setError("Hibernation settings could not be saved.");
        setPolicy(normalize(props.value));
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setPolicy(normalize(props.value));
    } finally { setPending(false); }
  };
  const disabled = pending || !props.onWriteConfig;
  const archiveCeiling = props.archive?.enabled && props.archive.mode === "age"
    ? props.archive.inactivityDays - 1
    : undefined;
  return (
    <SettingsSection
      sectionId="checkout-hibernation"
      eyebrow="Worktrees"
      title="Hibernate idle checkouts"
      description="Remove an idle thread's worktree after saving its uncommitted changes to a recovery snapshot. The thread stays in your lists, and its checkout comes back on the same branch when you next use it."
    >
      <div className="settings-fields">
        <SettingsField label="Hibernate idle checkouts"
          sub="A checkout is kept when it has commits on no branch, an operation or stash in progress, an open terminal, or another thread using it."
          control={<SettingsSwitch label="Hibernate idle checkouts" checked={policy.enabled}
            disabled={disabled || archiveCeiling !== undefined && archiveCeiling < 1} pending={pending}
            onChange={(enabled) => { void save({ enabled }); }} />} />
        <SettingsField label="Days idle"
          sub={archiveCeiling !== undefined
            ? `Below the ${props.archive!.inactivityDays} days after which threads are archived.`
            : "Viewing or sending to a thread counts as activity."}
          control={<input aria-label="Days idle" className="settings-input" disabled={disabled} type="number"
            min={1} max={archiveCeiling ?? 3650} key={`idle:${policy.idleDays}`} defaultValue={policy.idleDays}
            onBlur={(event) => { void save({ idleDays: Number(event.target.value) }); }} />} />
        <SettingsField label="Largest snapshot"
          sub="A checkout with more uncommitted changes than this is kept."
          control={<Select aria-label="Largest snapshot" className="settings-input select-trigger"
            disabled={disabled} options={SNAPSHOT_OPTIONS} value={String(policy.maxSnapshotMb)}
            onChange={(value) => { void save({ maxSnapshotMb: Number(value) }); }} />} />
        <SettingsField label="Remove rebuildable output"
          sub="Ignored folders such as node_modules and build output go with the checkout. Off, any ignored file keeps it."
          control={<SettingsSwitch label="Remove rebuildable output" checked={policy.removeRebuildableOutput}
            disabled={disabled} onChange={(removeRebuildableOutput) => { void save({ removeRebuildableOutput }); }} />} />
        <SegmentedField label="Restore the checkout"
          sub="Project environment setup runs again after a restore."
          disabled={disabled}
          options={RESTORE_OPTIONS}
          value={policy.restoreOn}
          onChange={async (restoreOn) => { await save({ restoreOn }); }} />
        {error ? <p className="settings-panel__hint" role="alert">{error}</p> : null}
      </div>
    </SettingsSection>
  );
}
