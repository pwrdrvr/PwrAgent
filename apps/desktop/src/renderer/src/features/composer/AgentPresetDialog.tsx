import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { resolveAgentPresetConnections, type AgentPreset, type AgentPresetDefaults } from "@pwragent/shared/contracts/agent-presets";
import type { McpConnectionStatus } from "@pwragent/shared/contracts/mcp-connections";
import type { NavigationLaunchpadDraft } from "@pwragent/shared/contracts/navigation";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { createDesktopAgentThread } from "../../lib/agent-thread";
import { useModalDialog } from "../../lib/useModalDialog";
import { AgentPresetFields } from "../settings/AgentPresetFields";

export function AgentPresetDialog(props: {
  launchpad: NavigationLaunchpadDraft;
  desktopApi: DesktopApi;
  onClose: () => void;
  onApply: (value: AgentPresetDefaults, id?: string) => Promise<void>;
}) {
  const headingId = useId();
  const pickerId = useId();
  const manage = props.desktopApi.manageAgentPresets;
  const listMcp = props.desktopApi.listMcpConnections;
  const [presets, setPresets] = useState<AgentPreset[]>();
  const [connections, setConnections] = useState<McpConnectionStatus[]>([]);
  const [selectedPreset, setSelectedPreset] = useState(props.launchpad.agentPresetId ?? "");
  const [values, setValues] = useState<AgentPresetDefaults>({
    name: props.launchpad.agent?.name ?? createDesktopAgentThread().name,
    instructions: props.launchpad.agent ? props.launchpad.agent.instructions : createDesktopAgentThread().instructions,
    mcpConnectionIds: props.launchpad.mcpConnectionIds ?? [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useModalDialog({ onClose: () => { if (!busy) props.onClose(); } });

  useEffect(() => {
    if (!manage) return;
    let current = true;
    void Promise.all([manage({ action: "list" }), listMcp?.()]).then(([items, inventory]) => {
      if (!current) return;
      setPresets(items);
      setConnections(inventory?.connections ?? []);
    }, (cause: unknown) => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [manage, listMcp]);

  const preset = presets?.find((item) => item.id === selectedPreset);
  const resolved = resolveAgentPresetConnections(preset?.mcpConnectionIds ?? [], connections);
  const connectionNames = new Map(connections.map(({ id, displayName }) => [id, displayName]));
  const edited = preset && (values.name !== preset.name || values.instructions !== preset.instructions
    || JSON.stringify(values.mcpConnectionIds) !== JSON.stringify(resolved.selected));
  const choosePreset = (id: string) => {
    setSelectedPreset(id);
    const selected = presets?.find((item) => item.id === id);
    if (selected) {
      setValues({
        name: selected.name,
        instructions: selected.instructions,
        mcpConnectionIds: resolveAgentPresetConnections(selected.mcpConnectionIds, connections).selected,
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
      availableInMessaging: source?.availableInMessaging,
      mcpConnectionIds: source ? [...new Set([...values.mcpConnectionIds, ...resolved.skipped])] : values.mcpConnectionIds,
    } });
    setPresets(updated);
    setSelectedPreset(updated.find((item) => item.name === values.name.trim())?.id ?? "");
  });

  return createPortal(
    <div className="settings-confirm-modal" role="presentation">
      <div className="settings-confirm-dialog agent-preset-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <h2 id={headingId}>Agent for this thread</h2>
        <label className="settings-field" htmlFor={pickerId}>
          <span>Start from</span>
          <Select id={pickerId} className="settings-select" value={preset?.id ?? ""} disabled={busy || !presets?.length}
            options={[{ value: "", label: "Custom" }, ...(presets ?? []).map((item) => ({ value: item.id, label: item.name }))]}
            onChange={choosePreset} />
        </label>
        <AgentPresetFields value={values} connections={connections} disabled={busy || !presets} onChange={setValues} />
        {resolved.skipped.length > 0 ? <p role="status">Unavailable connections will be skipped. {resolved.skipped.map((id) => connectionNames.get(id) ?? id).join(", ")}</p> : null}
        {error ? <p className="settings-row__error" role="alert">{error}</p> : null}
        <div className="settings-confirm-dialog__actions">
          <button className="button button--ghost" disabled={busy || !presets || !values.name.trim()} type="button" onClick={() => save()}>Save as new preset</button>
          {preset && edited ? <button className="button button--ghost" disabled={busy || !values.name.trim()} type="button" onClick={() => save(preset)}>Update {preset.name}</button> : null}
          <button className="button button--secondary" disabled={busy} type="button" onClick={props.onClose}>Cancel</button>
          <button className="button button--primary" disabled={busy || !presets || !values.name.trim()} type="button" onClick={() => void perform(async () => {
            const { selected } = resolveAgentPresetConnections(values.mcpConnectionIds, connections);
            await props.onApply({ ...values, name: values.name.trim(), instructions: values.instructions?.trim() || undefined, mcpConnectionIds: selected }, preset?.id ?? props.launchpad.agentPresetId);
            props.onClose();
          })}>Done</button>
        </div>
      </div>
    </div>, document.body,
  );
}
