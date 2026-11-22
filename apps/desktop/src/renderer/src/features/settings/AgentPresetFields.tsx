import type { AgentPresetDefaults } from "@pwragent/shared/contracts/agent-presets";
import { canSeedNewThreadMcpConnection, type McpConnectionStatus } from "@pwragent/shared/contracts/mcp-connections";
import { SettingsSwitch } from "./SettingsSwitch";

export function AgentPresetFields(props: {
  value: AgentPresetDefaults;
  connections: readonly McpConnectionStatus[];
  disabled?: boolean;
  onChange: (value: AgentPresetDefaults) => void;
}) {
  const { value, connections, onChange, disabled } = props;
  const selected = new Set(value.mcpConnectionIds);
  const choices = connections.filter((entry) => selected.has(entry.id) || canSeedNewThreadMcpConnection(entry));
  const known = new Set(choices.map(({ id }) => id));
  const missing = value.mcpConnectionIds.filter((id) => !known.has(id));
  const changeConnection = (id: string, enabled: boolean) => onChange({
    ...value,
    mcpConnectionIds: enabled ? [...selected, id] : value.mcpConnectionIds.filter((item) => item !== id),
  });
  return (
    <div className="settings-fields">
      <label className="settings-field">
        <span>Name</span>
        <input className="settings-input" disabled={disabled} maxLength={120} required value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })} />
      </label>
      <label className="settings-field">
        <span>Instructions</span>
        <textarea className="settings-input agent-preset-instructions" disabled={disabled} maxLength={65_536}
          rows={4} value={value.instructions ?? ""} onChange={(event) => onChange({ ...value, instructions: event.target.value })} />
      </label>
      <div className="settings-field">
        <span>PwrAgent MCPs</span>
        <div className="settings-fields">
          {choices.length === 0 && missing.length === 0 ? <span>No available connections</span> : null}
          {choices.map((entry) => (
            <div className="settings-field" key={entry.id}>
              <span>{entry.displayName}{canSeedNewThreadMcpConnection(entry) ? "" : " · Unavailable"}</span>
              <SettingsSwitch checked={selected.has(entry.id)} disabled={disabled} label={entry.displayName}
                onChange={(enabled) => changeConnection(entry.id, enabled)} />
            </div>
          ))}
          {missing.map((id) => (
            <div className="settings-field" key={id}>
              <span>{id} · Unavailable</span>
              <SettingsSwitch checked disabled={disabled} label={`Keep connection ${id}`}
                onChange={() => changeConnection(id, false)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
