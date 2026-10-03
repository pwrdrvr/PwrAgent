import { useState } from "react";
import {
  DEFAULT_MCP_AUTO_APPROVAL_SETTINGS, normalizeMcpAutoApprovalSettings, resolveHelperModel,
  type BackendModelOption, type BackendSummary, type DesktopHelperModelSettings,
  type DesktopMcpAutoApprovalSettings, type McpReviewerModelType,
} from "@pwragent/shared";
import { Select, type SelectOption } from "../../components/Select";
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { useSettingsDraft } from "./useSettingsDraft";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";

const PICKER_CLASS = "settings-select settings-select--chip";
/** Providers with an isolated structured helper the reviewer can run on. */
const REVIEWER_BACKENDS = ["codex", "acp:grok"];
const DIRECT_API = "api";
const API_LABELS: Partial<Record<McpReviewerModelType, string>> = {
  responses: "Responses API",
  completions: "Chat Completions API",
  claude: "Claude Messages API",
};
const API_EFFORTS = ["low", "medium", "high"];

/** One picker value for a provider and model; an empty Codex model is Helper model. */
const pickerValue = (provider: string, model: string) => `${provider}\n${model}`;

function modelsFor(backend: BackendSummary | undefined): BackendModelOption[] {
  return backend?.available ? backend.launchpadOptions?.models ?? [] : [];
}

/**
 * Settings → AI Providers → Approval reviewer: the model that answers approval
 * requests nobody is present for. Automation runs and threads in Auto use it;
 * Default Access threads keep asking the operator.
 */
export function McpAutoApprovalSettings(props: {
  settings?: DesktopMcpAutoApprovalSettings;
  backends: readonly BackendSummary[];
  helperModels?: DesktopHelperModelSettings;
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
  const direct = draft.modelType !== "harness";

  const codex = props.backends.find((backend) => backend.kind === "codex");
  const codexModels = modelsFor(codex);
  const helper = resolveHelperModel({
    helper: "mcp_auto_review",
    settings: props.helperModels,
    backend: "codex",
    models: codexModels,
    catalogRead: Boolean(codex?.available),
  });
  const helperLabel = codexModels.find((model) => model.id === helper.model)?.label ?? helper.model;
  const modelOptions: SelectOption[] = [
    { value: pickerValue("codex", ""), label: helperLabel ? `Helper model (${helperLabel})` : "Helper model" },
  ];
  for (const kind of REVIEWER_BACKENDS) {
    const backend = props.backends.find((entry) => entry.kind === kind);
    for (const model of modelsFor(backend)) {
      modelOptions.push({ value: pickerValue(kind, model.id), label: `${backend?.label ?? kind} · ${model.label ?? model.id}` });
    }
  }
  const current = direct ? DIRECT_API : pickerValue(draft.provider, draft.model);
  if (!direct && !modelOptions.some((option) => option.value === current)) {
    modelOptions.push({ value: current, label: `${draft.model || draft.provider} (not offered)` });
  }
  modelOptions.push({ value: DIRECT_API, label: "Direct API…", description: "Your endpoint and API key" });

  const selectedBackend = props.backends.find((backend) => backend.kind === draft.provider);
  const selectedModel = modelsFor(selectedBackend).find((model) => model.id === (draft.model || helper.model));
  const efforts = direct
    ? API_EFFORTS
    : selectedModel?.reasoningEfforts ?? selectedBackend?.launchpadOptions?.reasoningEfforts ?? [];
  const effortOptions: SelectOption[] = [
    { value: "", label: direct ? "Provider default" : draft.model ? "Model default" : "Helper default" },
    ...(draft.reasoningEffort && !efforts.includes(draft.reasoningEffort) ? [{ value: draft.reasoningEffort, label: `${draft.reasoningEffort} (not offered)` }] : []),
    ...efforts.map((effort) => ({ value: effort, label: effort })),
  ];
  const apiOptions: SelectOption<McpReviewerModelType>[] = (Object.keys(API_LABELS) as McpReviewerModelType[])
    .map((type) => ({ value: type, label: API_LABELS[type] ?? type }));
  // A saved type with no adapter in this build stays visible rather than
  // being silently rewritten, but it is never offered as a new choice.
  if (direct && !API_LABELS[draft.modelType]) apiOptions.push({ value: draft.modelType, label: `${draft.modelType} (not available)`, disabled: true });

  const chooseModel = (value: string) => {
    if (value === DIRECT_API) {
      if (!direct) {
        change("modelType", "responses");
        change("model", "");
        change("reasoningEffort", "");
      }
      return;
    }
    const [provider = "codex", model = ""] = value.split("\n");
    change("modelType", "harness");
    change("provider", provider);
    change("model", model);
    const nextModel = modelsFor(props.backends.find((backend) => backend.kind === provider)).find((entry) => entry.id === model);
    if (draft.reasoningEffort && nextModel?.reasoningEfforts && !nextModel.reasoningEfforts.includes(draft.reasoningEffort)) {
      change("reasoningEffort", "");
    }
  };

  const save = async (): Promise<boolean> => {
    if (disabled) return false;
    try {
      const settings = normalizeMcpAutoApprovalSettings(direct ? draft : { ...draft, endpoint: "", apiKeyEnv: "" });
      setSaving(true);
      const result = await props.onSave(settings);
      if (result === false) {
        setError("The approval reviewer could not be saved.");
        return false;
      }
      configuration.discard();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The approval reviewer could not be saved.");
      return false;
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    configuration.discard();
    setError(undefined);
  };
  useUnsavedSettingsChanges(configuration.dirty ? { label: "Approval reviewer", save, discard } : undefined);

  return (
    <SettingsSection
      eyebrow="Approvals"
      title="Approval reviewer"
      sectionId="mcp-auto-approval"
      description="A model that answers approval requests when nobody is there to answer them. A timeout or failed review never approves."
    >
      <div className="settings-fields">
        <SettingsField
          label="Use reviewer"
          control={<SettingsSwitch label="Use approval reviewer" checked={draft.enabled} disabled={disabled} onChange={(checked) => change("enabled", checked)} />}
          help={draft.enabled ? (
            <ul className="settings-mcp-reviewer__scope">
              <li><strong>Automation runs:</strong> MCP tool calls and questions, unless an automation chooses otherwise.</li>
              <li><strong>Threads in Auto:</strong> PwrAgent gateway calls and MCP questions. Codex Auto still decides everything else.</li>
              <li>Threads in Default Access keep asking you.</li>
            </ul>
          ) : "Automations pre-approve their allowed MCP tools and cancel MCP questions. Gateway calls in Auto ask you."}
        />
        {draft.enabled ? <>
          <SettingsField
            label="Model"
            sub="Runs isolated, with no tools."
            control={
              <div className="settings-provider-defaults__selectors">
                <Select aria-label="Reviewer model" className={PICKER_CLASS} disabled={disabled} value={current} options={modelOptions} onChange={chooseModel} />
                {effortOptions.length > 1 ? (
                  <Select aria-label="Reviewer reasoning" className={PICKER_CLASS} disabled={disabled} value={draft.reasoningEffort} options={effortOptions} onChange={(value) => change("reasoningEffort", value)} />
                ) : null}
              </div>
            }
          />
          {direct ? <>
            <SettingsField label="API" control={<Select aria-label="Reviewer API" className={PICKER_CLASS} disabled={disabled} value={draft.modelType} options={apiOptions} onChange={(value) => change("modelType", value)} />} />
            <SettingsField label="Endpoint" help="The full POST URL. Redirects are not followed." control={<input aria-label="Reviewer API endpoint" className="settings-input" value={draft.endpoint} placeholder="https://api.example.com/v1/responses" disabled={disabled} onChange={(event) => change("endpoint", event.currentTarget.value)} />} />
            <SettingsField label="Model ID" control={<input aria-label="Reviewer API model" className="settings-input" value={draft.model} disabled={disabled} onChange={(event) => change("model", event.currentTarget.value)} />} />
            <SettingsField label="API key variable" help="An environment variable available to PwrAgent. The key itself is never saved." control={<input aria-label="Reviewer API key environment variable" className="settings-input" value={draft.apiKeyEnv} placeholder="OPENAI_API_KEY" disabled={disabled} onChange={(event) => change("apiKeyEnv", event.currentTarget.value)} />} />
          </> : null}
          <SettingsField
            label="MCP policy"
            sub="Sent with the task, the request, and the question’s form."
            control={<textarea aria-label="Reviewer MCP policy" className="settings-input settings-mcp-reviewer__prompt" rows={5} value={draft.prompt} disabled={disabled} onChange={(event) => change("prompt", event.currentTarget.value)} />}
          />
          <SettingsField
            label="Escalations"
            sub="Default Access automation runs only."
            control={
              <div className="settings-mcp-reviewer__escalations">
                <SettingsSwitch label="Review escalations" checked={draft.reviewEscalations} disabled={disabled} onChange={(checked) => change("reviewEscalations", checked)} />
                {draft.reviewEscalations ? (
                  <textarea aria-label="Reviewer escalation policy" className="settings-input settings-mcp-reviewer__prompt" rows={4} value={draft.escalationPrompt} disabled={disabled} onChange={(event) => change("escalationPrompt", event.currentTarget.value)} />
                ) : null}
              </div>
            }
            help={draft.reviewEscalations
              ? "Commands and file changes outside the sandbox go to the reviewer with this policy."
              : "Off: a run stays in its sandbox, and nothing is asked."}
          />
          <SettingsField
            label="Time limit"
            control={
              <span className="settings-mcp-reviewer__seconds">
                <input aria-label="Reviewer time limit seconds" className="settings-input" type="number" min={1} max={120} value={draft.timeoutMs / 1000} disabled={disabled} onChange={(event) => change("timeoutMs", Number(event.currentTarget.value) * 1000)} />
                seconds
              </span>
            }
          />
        </> : null}
        {error ? <p role="alert" className="settings-row__error">{error}</p> : null}
        {configuration.dirty ? (
          <div className="settings-mcp-reviewer__actions">
            <span className="settings-mcp-reviewer__dirty">Unsaved changes</span>
            <button className="button button--secondary" type="button" disabled={disabled} onClick={discard}>Discard</button>
            <button className="button button--primary" type="button" disabled={disabled} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
