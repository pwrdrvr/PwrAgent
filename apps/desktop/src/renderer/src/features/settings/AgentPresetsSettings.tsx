import { useId, useState } from "react";
import type { AgentPreset, AgentPresetDefaults, ManageAgentPresetsRequest, SaveAgentPresetRequest } from "@pwragent/shared/contracts/agent-presets";
import type { McpConnectionStatus } from "@pwragent/shared/contracts/mcp-connections";
import type { DesktopApi } from "../../lib/desktop-api";
import { useModalDialog } from "../../lib/useModalDialog";
import { AgentPresetFields } from "./AgentPresetFields";
import { SettingsPanelHead, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";
import { useSettingsDraft } from "./useSettingsDraft";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";
import { useAgentPresetCatalog } from "./useAgentPresetCatalog";

const NEW_PRESET: AgentPresetDefaults = { name: "", mcpConnectionIds: [] };

export function AgentPresetsSettings({ desktopApi }: { desktopApi?: DesktopApi }) {
  const { manage, presets, setPresets, connections, connectionError, presetError } = useAgentPresetCatalog(desktopApi);
  const [editing, setEditing] = useState<SaveAgentPresetRequest>();
  const [deleting, setDeleting] = useState<AgentPreset>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const change = async (request: ManageAgentPresetsRequest) => {
    if (!manage) return false;
    setBusy(true);
    setError(undefined);
    try {
      setPresets(await manage(request));
      setEditing(undefined);
      setDeleting(undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const editor = editing ? <PresetEditor key={editing.id ?? "new"} preset={editing} connections={connections} connectionError={connectionError} busy={busy}
    onSave={(preset) => change({ action: "save", preset })} onCancel={() => { setEditing(undefined); setError(undefined); }} /> : null;
  const names = new Map(connections?.map(({ id, displayName }) => [id, displayName]));
  return (
    <>
      <SettingsPanelHead eyebrow="Agents" title="Agent Presets" help="Save an Agent’s name, instructions, and PwrAgent MCPs for new threads." />
      <SettingsSection title="Saved presets">
        <div className="settings-button-row">
          <button className="button button--primary" disabled={!presets || Boolean(editing) || busy} type="button"
            onClick={() => setEditing(NEW_PRESET)}>New preset</button>
        </div>
        {!manage ? <p className="settings-empty">Agent presets are unavailable in this window.</p> : null}
        {manage && !presets && !presetError ? <p className="settings-empty">Loading Agent presets…</p> : null}
        {presetError ? <p className="settings-row__error" role="alert">{presetError}</p> : null}
        {connectionError && !editing ? <p className="settings-empty" role="status">Connection status is unavailable.</p> : null}
        {presets?.length === 0 && !editing ? <p className="settings-empty">No Agent presets saved.</p> : null}
        {presets?.map((preset) => (
          <div className="agent-preset-row" key={preset.id}>
            <div className="agent-preset-row__header">
              <div>
                <strong>{preset.name}</strong>
                {preset.availableInMessaging ? <span className="settings-pathrow__chip">Messaging</span> : null}
                <p className="agent-preset-preview">{preset.instructions?.split(/\r?\n/, 1)[0] || "No instructions"}</p>
                <div className="agent-preset-connections">
                  {preset.mcpConnectionIds.map((id) => <span className="settings-pathrow__chip" key={id}>{names.get(id) ?? id}</span>)}
                </div>
              </div>
              <div className="settings-button-row">
                <button className="button button--secondary" disabled={Boolean(editing) || busy} type="button" onClick={() => setEditing(preset)}>Edit</button>
                <button className="button button--ghost" disabled={Boolean(editing) || busy} type="button" onClick={() => setDeleting(preset)}>Delete…</button>
              </div>
            </div>
            {editing?.id === preset.id ? editor : null}
          </div>
        ))}
        {editing && !editing.id ? editor : null}
        {error && !deleting ? <p className="settings-row__error" role="alert">{error}</p> : null}
      </SettingsSection>
      {deleting ? <DeletePresetDialog preset={deleting} busy={busy} error={error}
        onCancel={() => { setDeleting(undefined); setError(undefined); }} onConfirm={() => void change({ action: "delete", id: deleting.id })} /> : null}
    </>
  );
}

function PresetEditor(props: {
  preset: SaveAgentPresetRequest;
  connections?: McpConnectionStatus[];
  connectionError: boolean;
  busy: boolean;
  onSave: (preset: SaveAgentPresetRequest) => Promise<boolean>;
  onCancel: () => void;
}) {
  const draft = useSettingsDraft({
    name: props.preset.name,
    instructions: props.preset.instructions ?? "",
    connections: JSON.stringify(props.preset.mcpConnectionIds),
    availableInMessaging: props.preset.availableInMessaging === true,
  });
  const value: AgentPresetDefaults = {
    name: draft.values.name,
    instructions: draft.values.instructions,
    mcpConnectionIds: JSON.parse(draft.values.connections) as string[],
    availableInMessaging: draft.values.availableInMessaging ? true : undefined,
  };
  const save = () => value.name.trim() ? props.onSave({ ...value, id: props.preset.id,
    preserveMessagingAvailability: props.preset.id && value.availableInMessaging === props.preset.availableInMessaging ? true : undefined,
  }) : Promise.resolve(false);
  useUnsavedSettingsChanges(draft.dirty ? { label: "Agent Presets", save, discard: props.onCancel } : undefined);
  return (
    <form className="agent-preset-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <AgentPresetFields value={value} connections={props.connections} connectionError={props.connectionError} disabled={props.busy} onChange={(next) => {
        draft.set("name", next.name);
        draft.set("instructions", next.instructions ?? "");
        draft.set("connections", JSON.stringify(next.mcpConnectionIds));
      }} />
      <div className="settings-field">
        <span>Offer in messaging</span>
        <SettingsSwitch label="Offer this preset in messaging" checked={draft.values.availableInMessaging} disabled={props.busy}
          onChange={(next) => draft.set("availableInMessaging", next)} />
      </div>
      <p className="settings-empty">People allowed to create threads through messaging can start an Agent with these defaults.</p>
      <div className="settings-button-row">
        <button className="button button--primary" type="submit" disabled={props.busy || !value.name.trim()}>Save preset</button>
        <button className="button button--secondary" type="button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function DeletePresetDialog(props: { preset: AgentPreset; busy: boolean; error?: string; onCancel: () => void; onConfirm: () => void }) {
  const headingId = useId();
  const ref = useModalDialog({ onClose: () => { if (!props.busy) props.onCancel(); } });
  return (
    <div className="settings-confirm-modal" role="presentation">
      <div className="settings-confirm-dialog settings-confirm-dialog--danger" role="dialog" aria-modal="true" aria-labelledby={headingId} ref={ref} tabIndex={-1}>
        <h2 id={headingId}>Delete Agent preset?</h2>
        <p>Remove <strong>{props.preset.name}</strong> from the preset picker.</p>
        {props.error ? <p className="settings-row__error" role="alert">{props.error}</p> : null}
        <div className="settings-confirm-dialog__actions">
          <button className="button button--secondary" disabled={props.busy} type="button" onClick={props.onCancel}>Cancel</button>
          <button className="button button--ghost settings-danger-button" disabled={props.busy} type="button" onClick={props.onConfirm}>Delete preset</button>
        </div>
      </div>
    </div>
  );
}
