import { useEffect, useState } from "react";
import { SettingsField, SettingsSection } from "./SettingsLayout";

export function UsageAccountSettings(props: {
  backend: string;
  groups: Record<string, string>;
  saving: boolean;
  onSave: (groups: Record<string, string>) => Promise<unknown>;
}) {
  const saved = props.groups[props.backend] ?? "";
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setDraft(saved); setError(undefined); }, [saved, props.backend]);
  const save = async () => {
    const group = draft.trim();
    const groups = { ...props.groups };
    if (group) groups[props.backend] = group;
    else delete groups[props.backend];
    setBusy(true);
    setError(undefined);
    try {
      if (await props.onSave(groups) === false) setError("Could not save the account group.");
    } catch {
      setError("Could not save the account group.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection eyebrow="Usage Activity" title="Account grouping">
      <SettingsField
        label="Account group"
        sub="For accounts whose provider does not report a stable identity."
        help="Use the same group on profiles using the same provider account. Leave blank for automatic identity. Changes apply to future requests, including helpers."
        error={error}
        control={
          <input
            className="settings-input"
            aria-label="Account group"
            placeholder="Automatic"
            maxLength={120}
            value={draft}
            disabled={props.saving || busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim() !== saved && !props.saving && !busy) void save();
            }}
          />
        }
        actions={
          <div className="settings-inline-actions">
            <button
              className="button button--primary"
              type="button"
              disabled={props.saving || busy || draft.trim() === saved}
              onClick={() => { void save(); }}
            >
              {busy ? "Saving…" : "Save account group"}
            </button>
          </div>
        }
      />
    </SettingsSection>
  );
}
