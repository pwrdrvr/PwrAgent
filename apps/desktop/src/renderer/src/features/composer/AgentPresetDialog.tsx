import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { resolveAgentPresetConnections, type AgentPreset, type AgentPresetDefaults } from "@pwragent/shared/contracts/agent-presets";
import type { NavigationLaunchpadDraft } from "@pwragent/shared/contracts/navigation";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { createDesktopAgentThread } from "../../lib/agent-thread";
import { useModalDialog } from "../../lib/useModalDialog";
import { AgentPresetFields } from "../settings/AgentPresetFields";
import { useAgentPresetCatalog } from "../settings/useAgentPresetCatalog";

export function AgentPresetDialog(props: {
  launchpad: NavigationLaunchpadDraft;
  desktopApi: DesktopApi;
  onClose: () => void;
  onApply: (value: AgentPresetDefaults, id?: string) => Promise<void>;
}) {
  const headingId = useId();
  const pickerId = useId();
  const { manage, presets, setPresets, connections, connectionError, presetError } = useAgentPresetCatalog(props.desktopApi);
  const [selectedPreset, setSelectedPreset] = useState(props.launchpad.agentPresetId ?? "");
  const [values, setValues] = useState<AgentPresetDefaults>({
    name: props.launchpad.agent?.name ?? createDesktopAgentThread().name,
    instructions: props.launchpad.agent ? props.launchpad.agent.instructions : createDesktopAgentThread().instructions,
    mcpConnectionIds: props.launchpad.mcpConnectionIds ?? [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useModalDialog({ onClose: () => { if (!busy) props.onClose(); } });

  const preset = presets?.find((item) => item.id === selectedPreset);
  const unavailablePreset = Boolean(selectedPreset && presets && !preset);
  const resolve = (ids: string[]) => connections ? resolveAgentPresetConnections(ids, connections) : { selected: ids, skipped: [] };
  const resolved = resolve(preset?.mcpConnectionIds ?? []);
  const connectionNames = new Map(connections?.map(({ id, displayName }) => [id, displayName]));
  const edited = preset && (values.name !== preset.name || values.instructions !== preset.instructions
    || JSON.stringify(values.mcpConnectionIds) !== JSON.stringify(resolved.selected));
  const choosePreset = (id: string) => {
    setSelectedPreset(id);
    const selected = presets?.find((item) => item.id === id);
    if (selected) {
      setValues({
        name: selected.name,
        instructions: selected.instructions,
        mcpConnectionIds: resolve(selected.mcpConnectionIds).selected,
      });
    }
  };
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const save = (source?: AgentPreset) => void perform(async () => {
    if (!manage) return;
    const updated = await manage({ action: "save", preset: {
      ...values,
      id: source?.id,
      preserveMessagingAvailability: source ? true : undefined,
      mcpConnectionIds: source ? [...new Set([...values.mcpConnectionIds, ...resolved.skipped])] : values.mcpConnectionIds,
    } });
    setPresets(updated);
    setSelectedPreset(updated.find((item) => item.name === values.name.trim())?.id ?? "");
  });

  return createPortal(
    <div className="settings-confirm-modal" role="presentation">
      <div className="settings-confirm-dialog agent-preset-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
        <h2 id={headingId}>Agent for this thread</h2>
        <label className="settings-field" htmlFor={pickerId}>
          <span>Start from</span>
          <Select id={pickerId} className="settings-select" value={preset?.id ?? (unavailablePreset ? selectedPreset : "")} disabled={busy || (!presets?.length && !unavailablePreset)}
            options={[{ value: "", label: "Custom" },
              ...(unavailablePreset ? [{ value: selectedPreset, label: "Preset unavailable", disabled: true }] : []),
              ...(presets ?? []).map((item) => ({ value: item.id, label: item.name }))]}
            onChange={choosePreset} />
        </label>
        <AgentPresetFields value={values} connections={connections} connectionError={connectionError} disabled={busy || !presets} onChange={setValues} />
        {resolved.skipped.length > 0 ? <p role="status">Unavailable connections will be skipped. {resolved.skipped.map((id) => connectionNames.get(id) ?? id).join(", ")}</p> : null}
        {error || presetError ? <p className="settings-row__error" role="alert">{error ?? presetError}</p> : null}
        <div className="settings-confirm-dialog__actions">
          <button className="button button--ghost" disabled={busy || !presets || !values.name.trim()} type="button" onClick={() => save()}>Save as new preset</button>
          {preset && edited ? <button className="button button--ghost" disabled={busy || !values.name.trim()} type="button" onClick={() => save(preset)}>Update {preset.name}</button> : null}
          <button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Cancel</button>
          <button className="button button--primary" disabled={busy || !presets || !values.name.trim()} type="button" onClick={() => void perform(async () => {
            const { selected } = resolve(values.mcpConnectionIds);
            await props.onApply({ ...values, name: values.name.trim(), instructions: values.instructions?.trim() || undefined, mcpConnectionIds: selected }, selectedPreset || undefined);
            props.onClose();
          })}>Done</button>
        </div>
      </div>
    </div>, document.body,
  );
}
