import { useEffect, useState } from "react";
import {
  CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES,
  normalizeCheckoutHibernationPolicy,
  type DesktopCheckoutHibernationPolicy,
  type DesktopSettingsConfigPatch,
} from "@pwragent/shared";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { ArchiveSweepField } from "./ArchivePolicySettings";
import { SegmentedField, SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const SNAPSHOT_OPTIONS = CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES.map((mb) => ({ value: String(mb), label: `${mb} MB` }));

const RESTORE_OPTIONS: Array<{ label: string; value: DesktopCheckoutHibernationPolicy["restoreOn"] }> = [
  { label: "On send", value: "send" },
  { label: "On open", value: "open" },
];

/**
 * Settings → Worktrees → Hibernate idle checkouts, the automatic way to
 * reclaim disk, with the hourly sweep that runs it. Each change writes at once.
 */
export function CheckoutHibernationSettings(props: {
  value?: DesktopCheckoutHibernationPolicy;
  onWriteConfig?: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  desktopApi?: DesktopApi;
}) {
  const normalize = (value?: Partial<DesktopCheckoutHibernationPolicy>) => normalizeCheckoutHibernationPolicy(value);
  const [policy, setPolicy] = useState(() => normalize(props.value));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setPolicy(normalizeCheckoutHibernationPolicy(props.value));
  }, [props.value]);
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
            disabled={disabled} pending={pending}
            onChange={(enabled) => { void save({ enabled }); }} />} />
        <SettingsField label="Days idle"
          sub="Viewing or sending to a thread counts as activity."
          control={<input aria-label="Days idle" className="settings-input" disabled={disabled} type="number"
            min={1} max={3650} key={`idle:${policy.idleDays}`} defaultValue={policy.idleDays}
            onBlur={(event) => { void save({ idleDays: Number(event.target.value) }); }} />} />
        <SettingsField label="Largest snapshot"
          sub="Tracked and non-ignored changes are saved; a checkout with more than this is kept. Ignored files are deleted and not restored."
          control={<Select aria-label="Largest snapshot" className="settings-input select-trigger"
            disabled={disabled} options={SNAPSHOT_OPTIONS} value={String(policy.maxSnapshotMb)}
            onChange={(value) => { void save({ maxSnapshotMb: Number(value) }); }} />} />
        <SegmentedField label="Restore the checkout"
          sub="Project environment setup runs again after a restore."
          disabled={disabled}
          options={RESTORE_OPTIONS}
          value={policy.restoreOn}
          onChange={async (restoreOn) => { await save({ restoreOn }); }} />
        {error ? <p className="settings-panel__hint" role="alert">{error}</p> : null}
        <ArchiveSweepField desktopApi={props.desktopApi} />
      </div>
    </SettingsSection>
  );
}
