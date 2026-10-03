import { useState } from "react";
import {
  DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, MCP_REVIEWER_MODEL_TYPES, normalizeMcpAutoApprovalSettings,
  type BackendSummary, type DesktopMcpAutoApprovalSettings,
} from "@pwragent/shared";
import { Select } from "../../components/Select";
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { useSettingsDraft } from "./useSettingsDraft";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";

const TYPE_LABELS = { harness: "Harness", completions: "Chat Completions API", responses: "Responses API", claude: "Claude API", "system-one": "System One (planned)" };

export function McpAutoApprovalSettings(props: {
  settings?: DesktopMcpAutoApprovalSettings;
  backends: readonly BackendSummary[];
  saving: boolean;
  onSave: (settings: DesktopMcpAutoApprovalSettings) => Promise<unknown>;
}) {
  const configuration = useSettingsDraft(props.settings ?? DEFAULT_MCP_AUTO_APPROVAL_SETTINGS);
  const draft = configuration.values;
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const change = <K extends keyof DesktopMcpAutoApprovalSettings>(key: K, value: DesktopMcpAutoApprovalSettings[K]) => {
    configuration.set(key, value);
    setError(undefined);
  };
  const disabled = saving || props.saving;
  const models = props.backends.find((backend) => backend.kind === draft.provider)?.launchpadOptions?.models ?? [];
  const providerOptions: Array<{ value: string; label: string }> = props.backends.filter((backend) => backend.kind === "codex" || backend.kind === "acp:grok").map((backend) => ({ value: backend.kind, label: backend.label }));
  if (!providerOptions.some((entry) => entry.value === draft.provider)) providerOptions.push({ value: draft.provider, label: draft.provider });
  const save = async (): Promise<boolean> => {
    if (disabled) return false;
    try {
      const settings = normalizeMcpAutoApprovalSettings(draft);
      setSaving(true);
      const result = await props.onSave(settings);
      if (result === false) {
        setError("MCP reviewer settings could not be saved.");
        return false;
      }
      configuration.discard();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MCP reviewer settings could not be saved.");
      return false;
    } finally {
      setSaving(false);
    }
  };
  useUnsavedSettingsChanges(configuration.dirty ? {
    label: "MCP reviewer",
    save,
    discard: configuration.discard,
  } : undefined);
  return (
    <SettingsSection eyebrow="MCP" title="Auto approval reviewer" sectionId="mcp-auto-approval" description="Reviews automation MCP requests and supplies MCP Auto approval where the harness cannot review them.">
      <SettingsField label="Use MCP reviewer" help="Automations inherit this reviewer unless their MCP policy overrides it. Full Access alone does not answer MCP questions." control={
        <SettingsSwitch label="Use MCP reviewer" checked={draft.enabled} disabled={disabled} onChange={(checked) => change("enabled", checked)} />
      } />
      <SettingsField label="Model type" control={<Select aria-label="Reviewer model type" className="settings-select settings-select--chip" value={draft.modelType} disabled={disabled} options={MCP_REVIEWER_MODEL_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))} onChange={(value) => change("modelType", value)} />} />
      <SettingsField label="Provider" help={draft.modelType === "harness" ? "Uses an isolated Codex or Grok helper with execution and MCP tools removed." : "Provider name for this direct API connection."} control={draft.modelType === "harness"
        ? <Select aria-label="Reviewer provider" className="settings-select settings-select--chip" value={draft.provider} disabled={disabled} options={providerOptions} onChange={(value) => change("provider", value)} />
        : <input aria-label="Reviewer provider" className="settings-input" value={draft.provider} disabled={disabled} onChange={(event) => change("provider", event.currentTarget.value)} />
      } />
      <SettingsField label="Model" help="Use the exact model ID. GPT-6.1-Sol and GPT-6-Luna can use the configured Codex harness or an API connection." control={<input aria-label="Reviewer model" className="settings-input" list="mcp-reviewer-models" value={draft.model} disabled={disabled} onChange={(event) => change("model", event.currentTarget.value)} />} />
      <datalist id="mcp-reviewer-models">{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
      <SettingsField label="Reasoning effort" help="Leave blank for the provider default. Direct APIs must support the chosen effort." control={<input aria-label="Reviewer reasoning effort" className="settings-input" value={draft.reasoningEffort} placeholder="low, medium, high" disabled={disabled} onChange={(event) => change("reasoningEffort", event.currentTarget.value)} />} />
      {draft.modelType !== "harness" ? <>
        <SettingsField label="API endpoint" help="Full POST endpoint for the chosen API. Redirects are not followed." control={<input aria-label="Reviewer API endpoint" className="settings-input" value={draft.endpoint} placeholder="https://api.example.com/v1/responses" disabled={disabled} onChange={(event) => change("endpoint", event.currentTarget.value)} />} />
        <SettingsField label="API key environment variable" help="Name an environment variable available to PwrAgent. The key is never saved in this form." control={<input aria-label="Reviewer API key environment variable" className="settings-input" value={draft.apiKeyEnv} placeholder="OPENAI_API_KEY" disabled={disabled} onChange={(event) => change("apiKeyEnv", event.currentTarget.value)} />} />
      </> : null}
      <SettingsField label="MCP request prompt" help="Operator policy sent to the reviewer together with the task, request, and question schema." control={<textarea aria-label="Reviewer approval prompt" className="settings-input settings-mcp-reviewer__prompt" rows={5} value={draft.prompt} disabled={disabled} onChange={(event) => change("prompt", event.currentTarget.value)} />} />
      <SettingsField label="Review Default Access escalations" help="Codex Auto reviews native tool decisions itself. This option reviews command and file-change escalation requests in Default Access using the separate prompt below." control={<SettingsSwitch label="Review Default Access escalations" checked={draft.reviewEscalations} disabled={disabled} onChange={(checked) => change("reviewEscalations", checked)} />} />
      <SettingsField label="Harness escalation prompt" help="Separate policy for shell execution, file changes, and permission escalation." control={<textarea aria-label="Reviewer escalation prompt" className="settings-input settings-mcp-reviewer__prompt" rows={4} value={draft.escalationPrompt} disabled={disabled} onChange={(event) => change("escalationPrompt", event.currentTarget.value)} />} />
      {draft.modelType === "system-one" ? <SettingsField label="Minimum confidence" help="Saved for the future decision-model adapter. System One is not callable in this build; selecting it rejects reviews until the adapter is installed." control={<input aria-label="Reviewer minimum confidence" className="settings-input" type="number" min={0.5} max={1} step={0.01} value={draft.confidenceThreshold} disabled={disabled} onChange={(event) => change("confidenceThreshold", Number(event.currentTarget.value))} />} /> : null}
      <SettingsField label="Review timeout (seconds)" help="A timeout, invalid answer, or provider failure never grants approval." control={<input aria-label="Reviewer timeout seconds" className="settings-input" type="number" min={1} max={120} value={draft.timeoutMs / 1000} disabled={disabled} onChange={(event) => change("timeoutMs", Number(event.currentTarget.value) * 1000)} />} />
      {error ? <p role="alert" className="settings-field__error">{error}</p> : null}
      <button className="button button--primary" type="button" disabled={disabled} onClick={() => void save()}>{saving ? "Saving…" : "Save MCP reviewer"}</button>
    </SettingsSection>
  );
}
