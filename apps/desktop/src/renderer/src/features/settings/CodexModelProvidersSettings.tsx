import { useState } from "react";
import {
  CODEX_MODEL_PROVIDER_LIMIT,
  RESERVED_CODEX_MODEL_PROVIDER_IDS,
  isValidCodexModelProviderId,
  validateCodexModelProviders,
  type CodexModelProviderRate,
  type CodexModelProviderSettings,
  type CodexModelProviderTestResult,
  type DesktopCodexModelProvider,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { cleanComposerErrorMessage } from "../composer/composer-error-message";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsPathRow, type SettingsPathRowChip } from "./SettingsPathRow";
import { SettingsSwitch } from "./SettingsSwitch";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";

type RateDraft = { input: string; output: string; cached: string };

type ProviderDraft = {
  /** The id of the provider being edited; absent while adding one. */
  existingId?: string;
  name: string;
  id: string;
  /** False until the operator types an id; until then it follows the name. */
  idEdited: boolean;
  baseUrl: string;
  apiKey: string;
  removeKey: boolean;
  models: string;
  discoverModels: boolean;
  local: boolean;
  rates: Record<string, RateDraft>;
};

const EMPTY_RATE: RateDraft = { input: "", output: "", cached: "" };

/**
 * Settings → Codex → Model providers.
 *
 * Each provider is an OpenAI Responses-compatible endpoint that Codex runs
 * threads on beside its default provider. Its models appear in every model
 * picker as `Provider · model`, and its usage is recorded under the provider,
 * priced with the rates entered here, never as OpenAI usage.
 *
 * The editor is an explicit-save form: Codex reconnects when a provider's
 * endpoint changes, so a half-typed URL must not be written on blur.
 */
export function CodexModelProvidersSettings(props: {
  desktopApi?: DesktopApi;
  providers: DesktopCodexModelProvider[];
  saving: boolean;
  onSave: (providers: CodexModelProviderSettings[]) => Promise<boolean>;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProviderDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<{ running: boolean; result?: CodexModelProviderTestResult; error?: string }>();
  const editing = draft
    ? props.providers.find((provider) => provider.id === draft.existingId)
    : undefined;
  const dirty = draft ? isDraftDirty(draft, editing) : false;

  const close = () => {
    setDraft(undefined);
    setError(undefined);
    setTest(undefined);
  };

  const save = async (): Promise<boolean> => {
    if (!draft) return true;
    let next: CodexModelProviderSettings[];
    try {
      const provider = providerFromDraft(draft);
      const others = props.providers
        .filter((entry) => entry.id !== draft.existingId)
        .map(stripKeyState);
      next = validateCodexModelProviders(
        draft.existingId
          ? props.providers.map((entry) => entry.id === draft.existingId ? provider : stripKeyState(entry))
          : [...others, provider],
      );
    } catch (problem) {
      setError(describeError(problem));
      return false;
    }
    setBusy(true);
    setError(undefined);
    try {
      const id = draft.id.trim();
      // The key goes first: the config write reconnects Codex, and the
      // reconnect should already see the key.
      if (draft.apiKey.trim() || draft.removeKey) {
        if (!props.desktopApi?.setCodexModelProviderApiKey) {
          setError("This window cannot store API keys.");
          return false;
        }
        await props.desktopApi.setCodexModelProviderApiKey({
          providerId: id,
          ...(draft.removeKey ? {} : { apiKey: draft.apiKey.trim() }),
        });
      }
      if (!await props.onSave(next)) {
        setError("Could not save the provider.");
        return false;
      }
      await props.onRefresh();
      close();
      return true;
    } catch (problem) {
      setError(describeError(problem));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!draft?.existingId) return;
    const id = draft.existingId;
    setBusy(true);
    setError(undefined);
    try {
      if (!await props.onSave(props.providers.filter((entry) => entry.id !== id).map(stripKeyState))) {
        setError("Could not remove the provider.");
        return;
      }
      if (editing?.hasApiKey) {
        await props.desktopApi?.setCodexModelProviderApiKey?.({ providerId: id });
      }
      await props.onRefresh();
      close();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (): Promise<void> => {
    if (!draft || !props.desktopApi?.testCodexModelProvider) return;
    let provider: CodexModelProviderSettings;
    try {
      [provider] = validateCodexModelProviders([providerFromDraft(draft)]);
    } catch (problem) {
      setTest({ running: false, error: describeError(problem) });
      return;
    }
    setTest({ running: true });
    try {
      const result = await props.desktopApi.testCodexModelProvider({
        provider,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      });
      setTest({ running: false, result });
    } catch (problem) {
      setTest({ running: false, error: describeError(problem) });
    }
  };

  useUnsavedSettingsChanges(
    draft && dirty
      ? { label: "Model providers", save, discard: close }
      : undefined,
  );

  const disabled = props.saving || busy;
  const atLimit = props.providers.length >= CODEX_MODEL_PROVIDER_LIMIT;

  return (
    <SettingsSection
      eyebrow="Codex"
      title="Model providers"
      description="OpenAI-compatible endpoints that Codex can run threads on, such as a second API account, a hosted open-weight model, or a local server. A thread keeps the provider it starts on."
      chip={props.providers.length ? String(props.providers.length) : undefined}
    >
      <div className="settings-paths" aria-label="Codex model providers" role="group">
        {props.providers.length === 0 && !draft ? (
          <p className="settings-empty">No model providers. Codex uses its default provider.</p>
        ) : null}
        {props.providers.map((provider) => (
          <SettingsPathRow
            key={provider.id}
            title={provider.name}
            meta={provider.id}
            path={provider.baseUrl}
            chips={providerChips(provider)}
            selected={false}
            useLabel={draft?.existingId === provider.id ? "Editing" : "Edit"}
            disabled={disabled || Boolean(draft)}
            onUse={() => {
              setDraft(draftFromProvider(provider));
              setError(undefined);
              setTest(undefined);
            }}
          />
        ))}
        {!draft ? (
          <div className="settings-inline-actions">
            <button
              className="button button--secondary"
              disabled={disabled || atLimit}
              type="button"
              onClick={() => {
                setDraft(emptyDraft());
                setError(undefined);
                setTest(undefined);
              }}
            >
              Add provider
            </button>
          </div>
        ) : null}
      </div>
      {draft ? (
        <ProviderEditor
          draft={draft}
          editing={editing}
          disabled={disabled}
          canTest={Boolean(props.desktopApi?.testCodexModelProvider)}
          test={test}
          error={error}
          onChange={(patch) => setDraft((current) => current ? applyPatch(current, patch) : current)}
          onSave={() => void save()}
          onCancel={close}
          onRemove={draft.existingId ? () => void remove() : undefined}
          onTest={() => void runTest()}
        />
      ) : null}
    </SettingsSection>
  );
}

function ProviderEditor(props: {
  draft: ProviderDraft;
  editing?: DesktopCodexModelProvider;
  disabled: boolean;
  canTest: boolean;
  test?: { running: boolean; result?: CodexModelProviderTestResult; error?: string };
  error?: string;
  onChange: (patch: Partial<ProviderDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove?: () => void;
  onTest: () => void;
}) {
  const draft = props.draft;
  const listedModels = parseModelList(draft.models);
  const idProblem = draft.id && !isValidCodexModelProviderId(draft.id)
    ? RESERVED_CODEX_MODEL_PROVIDER_IDS.has(draft.id)
      ? `"${draft.id}" is reserved. Choose another id.`
      : "Lowercase letters, digits, - or _, starting with a letter."
    : undefined;
  const keyHelp = props.editing?.hasApiKey
    ? draft.removeKey
      ? "The stored key is removed when you save."
      : "A key is stored. Leave blank to keep it."
    : "Stored in the system keychain. Codex receives it in its environment; commands a model runs do not.";

  return (
    <div
      aria-label={draft.existingId ? `Edit ${props.editing?.name ?? draft.existingId}` : "Add model provider"}
      className="settings-fields codex-provider-editor"
      role="group"
    >
      <SettingsField
        label="Name"
        sub="Shown in model pickers, as in Refuseless · GLM 5.3."
        control={
          <input
            aria-label="Provider name"
            className="settings-input"
            disabled={props.disabled}
            maxLength={60}
            placeholder="Refuseless"
            value={draft.name}
            onChange={(event) => props.onChange({ name: event.currentTarget.value })}
          />
        }
      />
      <SettingsField
        label="ID"
        sub={draft.existingId
          ? "Threads and usage refer to this id, so it cannot change. Remove the provider to use another."
          : "Prefixes this provider's model ids, as in @refuseless/glm-5.3."}
        error={idProblem}
        control={
          <input
            aria-label="Provider ID"
            className={`settings-input${idProblem ? " settings-input--invalid" : ""}`}
            disabled={props.disabled}
            maxLength={32}
            placeholder="refuseless"
            readOnly={Boolean(draft.existingId)}
            spellCheck={false}
            value={draft.id}
            onChange={(event) => props.onChange({ id: event.currentTarget.value.toLowerCase(), idEdited: true })}
          />
        }
      />
      <SettingsField
        label="Base URL"
        sub="The endpoint's OpenAI API root. Codex calls {base}/responses; model discovery calls {base}/models."
        control={
          <input
            aria-label="Base URL"
            className="settings-input"
            disabled={props.disabled}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            value={draft.baseUrl}
            onChange={(event) => props.onChange({ baseUrl: event.currentTarget.value })}
          />
        }
      />
      <SettingsField
        label="API key"
        sub={keyHelp}
        control={
          <>
            <input
              aria-label="API key"
              autoComplete="off"
              className="settings-input"
              disabled={props.disabled || draft.removeKey}
              placeholder={props.editing?.hasApiKey ? "Stored" : "Not set"}
              spellCheck={false}
              type="password"
              value={draft.apiKey}
              onChange={(event) => props.onChange({ apiKey: event.currentTarget.value })}
            />
            {props.editing?.hasApiKey ? (
              <div className="settings-inline-actions">
                <button
                  className="button button--ghost"
                  disabled={props.disabled}
                  type="button"
                  onClick={() => props.onChange({ removeKey: !draft.removeKey, apiKey: "" })}
                >
                  {draft.removeKey ? "Keep stored key" : "Remove stored key"}
                </button>
              </div>
            ) : null}
          </>
        }
      />
      <SettingsField
        label="Models"
        sub="One model id per line, exactly as the endpoint names it."
        control={
          <textarea
            aria-label="Model ids"
            className="settings-input settings-input--multiline"
            disabled={props.disabled}
            placeholder={"glm-5.3-abliterated\ndeepseek-v4.1-flash"}
            rows={Math.min(8, Math.max(3, listedModels.length + 1))}
            spellCheck={false}
            value={draft.models}
            onChange={(event) => props.onChange({ models: event.currentTarget.value })}
          />
        }
      />
      <SettingsField
        label="List the endpoint's models"
        sub="Adds the ids GET /models returns, checked every ten minutes."
        control={
          <SettingsSwitch
            checked={draft.discoverModels}
            disabled={props.disabled}
            label="List the endpoint's models"
            onChange={(discoverModels) => props.onChange({ discoverModels })}
          />
        }
      />
      <SettingsField
        label="Runs locally"
        sub="Records this provider's usage at no cost, as for a server on this machine."
        control={
          <SettingsSwitch
            checked={draft.local}
            disabled={props.disabled}
            label="Runs locally"
            onChange={(local) => props.onChange({ local })}
          />
        }
      />
      {!draft.local ? (
        <SettingsField
          label="Rates"
          sub="USD per 1M tokens, from the provider's price list. A model without a rate is recorded as unpriced."
          control={
            listedModels.length === 0 ? (
              <p className="settings-empty">List a model above to give it a rate.</p>
            ) : (
              <table className="codex-provider-rates">
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Input</th>
                    <th scope="col">Output</th>
                    <th scope="col">Cached input</th>
                  </tr>
                </thead>
                <tbody>
                  {listedModels.map((model) => {
                    const rate = draft.rates[model] ?? EMPTY_RATE;
                    const setRate = (patch: Partial<RateDraft>) =>
                      props.onChange({ rates: { ...draft.rates, [model]: { ...rate, ...patch } } });
                    return (
                      <tr key={model}>
                        <th scope="row" title={model}>{model}</th>
                        <td>
                          <RateInput
                            label={`${model} input rate`}
                            disabled={props.disabled}
                            value={rate.input}
                            onChange={(input) => setRate({ input })}
                          />
                        </td>
                        <td>
                          <RateInput
                            label={`${model} output rate`}
                            disabled={props.disabled}
                            value={rate.output}
                            onChange={(output) => setRate({ output })}
                          />
                        </td>
                        <td>
                          <RateInput
                            label={`${model} cached input rate`}
                            disabled={props.disabled}
                            placeholder={rate.input || undefined}
                            value={rate.cached}
                            onChange={(cached) => setRate({ cached })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          }
        />
      ) : null}
      {props.canTest ? (
        <SettingsField
          label="Connection test"
          sub="Reads /models and sends one short request to /responses, which the provider may bill."
          control={
            <>
              <div className="settings-inline-actions">
                <button
                  className="button button--secondary"
                  disabled={props.disabled || props.test?.running}
                  type="button"
                  onClick={props.onTest}
                >
                  {props.test?.running ? "Testing…" : "Test connection"}
                </button>
              </div>
              {props.test && !props.test.running ? <ProviderTestResult test={props.test} /> : null}
            </>
          }
        />
      ) : null}
      {props.error ? (
        <p className="settings-error" role="alert">{props.error}</p>
      ) : null}
      <div className="settings-inline-actions">
        <button
          className="button button--primary"
          disabled={props.disabled || Boolean(idProblem)}
          type="button"
          onClick={props.onSave}
        >
          {draft.existingId ? "Save and reconnect" : "Add and reconnect"}
        </button>
        <button
          className="button button--secondary"
          disabled={props.disabled}
          type="button"
          onClick={props.onCancel}
        >
          Cancel
        </button>
        {props.onRemove ? (
          <button
            className="button button--ghost"
            disabled={props.disabled}
            type="button"
            onClick={props.onRemove}
          >
            Remove provider
          </button>
        ) : null}
      </div>
      <p className="settings-field__help">
        Codex reconnects when no turn is running. Threads already on this provider keep it.
      </p>
    </div>
  );
}

function RateInput(props: {
  label: string;
  disabled: boolean;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      aria-label={props.label}
      className="settings-input settings-input--inline"
      disabled={props.disabled}
      inputMode="decimal"
      placeholder={props.placeholder ?? "—"}
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    />
  );
}

function ProviderTestResult(props: {
  test: { result?: CodexModelProviderTestResult; error?: string };
}) {
  if (props.test.error) {
    return <p className="settings-error" role="status">{props.test.error}</p>;
  }
  const result = props.test.result;
  if (!result) return null;
  const responses = result.responses;
  return (
    <ul className="codex-provider-test" role="status">
      <li className={result.models.ok ? "is-ok" : "is-err"}>
        <strong>/models</strong>{" "}
        {result.models.ok
          ? `${result.models.count} model${result.models.count === 1 ? "" : "s"}${
            result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : ""
          }`
          : result.models.error ?? "Failed"}
      </li>
      <li className={responses.ok ? "is-ok" : responses.skipped ? "is-skip" : "is-err"}>
        <strong>/responses</strong>{" "}
        {responses.ok
          ? `Answered with ${responses.model}`
          : responses.error ?? "Failed"}
        {!responses.ok && !responses.skipped
          ? " Codex needs the Responses API; an endpoint that serves only Chat Completions cannot run threads."
          : null}
      </li>
    </ul>
  );
}

function providerChips(provider: DesktopCodexModelProvider): SettingsPathRowChip[] {
  const modelCount = provider.models?.length ?? 0;
  const chips: SettingsPathRowChip[] = [
    { key: "key", label: provider.hasApiKey ? "key" : "no key", tone: provider.hasApiKey ? "muted" : "warn" },
  ];
  if (modelCount > 0 || provider.discoverModels !== false) {
    chips.push({
      key: "models",
      label: provider.discoverModels === false
        ? `${modelCount} model${modelCount === 1 ? "" : "s"}`
        : modelCount ? `${modelCount} + listed` : "listed",
      tone: "muted",
      title: provider.discoverModels === false
        ? undefined
        : "Also lists the models the endpoint reports",
    });
  }
  chips.push(provider.local
    ? { key: "price", label: "local · free", tone: "muted" }
    : provider.rates?.length
      ? { key: "price", label: `${provider.rates.length} rate${provider.rates.length === 1 ? "" : "s"}`, tone: "muted" }
      : { key: "price", label: "unpriced", tone: "warn", title: "Usage is recorded without a cost until rates are entered" });
  return chips;
}

function emptyDraft(): ProviderDraft {
  return {
    name: "",
    id: "",
    idEdited: false,
    baseUrl: "",
    apiKey: "",
    removeKey: false,
    models: "",
    discoverModels: true,
    local: false,
    rates: {},
  };
}

function draftFromProvider(provider: DesktopCodexModelProvider): ProviderDraft {
  const rates: Record<string, RateDraft> = {};
  for (const rate of provider.rates ?? []) {
    rates[rate.model] = {
      input: formatRate(rate.inputPerMillion),
      output: formatRate(rate.outputPerMillion),
      cached: formatRate(rate.cachedInputPerMillion),
    };
  }
  return {
    existingId: provider.id,
    name: provider.name,
    id: provider.id,
    idEdited: true,
    baseUrl: provider.baseUrl,
    apiKey: "",
    removeKey: false,
    models: (provider.models ?? []).join("\n"),
    discoverModels: provider.discoverModels !== false,
    local: provider.local === true,
    rates,
  };
}

function applyPatch(draft: ProviderDraft, patch: Partial<ProviderDraft>): ProviderDraft {
  const next = { ...draft, ...patch };
  if (patch.name !== undefined && !next.idEdited && !next.existingId) {
    next.id = slugifyProviderId(patch.name);
  }
  return next;
}

function providerFromDraft(draft: ProviderDraft): CodexModelProviderSettings {
  const models = parseModelList(draft.models);
  const rates: CodexModelProviderRate[] = [];
  if (!draft.local) {
    for (const model of models) {
      const rate = draft.rates[model];
      if (!rate) continue;
      const inputPerMillion = parseRate(rate.input, `${model} input`);
      const outputPerMillion = parseRate(rate.output, `${model} output`);
      const cachedInputPerMillion = parseRate(rate.cached, `${model} cached input`);
      if (inputPerMillion === undefined && outputPerMillion === undefined && cachedInputPerMillion === undefined) continue;
      rates.push({
        model,
        ...(inputPerMillion === undefined ? {} : { inputPerMillion }),
        ...(outputPerMillion === undefined ? {} : { outputPerMillion }),
        ...(cachedInputPerMillion === undefined ? {} : { cachedInputPerMillion }),
      });
    }
  }
  return {
    id: draft.id.trim(),
    name: draft.name.trim() || draft.id.trim(),
    baseUrl: draft.baseUrl.trim(),
    ...(models.length ? { models } : {}),
    ...(draft.discoverModels ? {} : { discoverModels: false }),
    ...(draft.local ? { local: true } : {}),
    ...(rates.length ? { rates } : {}),
  };
}

function isDraftDirty(draft: ProviderDraft, saved: DesktopCodexModelProvider | undefined): boolean {
  if (draft.apiKey.trim() || draft.removeKey) return true;
  if (!saved) {
    return Boolean(draft.name.trim() || draft.id.trim() || draft.baseUrl.trim() || draft.models.trim());
  }
  try {
    return JSON.stringify(providerFromDraft(draft)) !== JSON.stringify(stripKeyState(saved));
  } catch {
    // A rate that does not parse is an edit.
    return true;
  }
}

function stripKeyState(provider: DesktopCodexModelProvider): CodexModelProviderSettings {
  const { hasApiKey: _hasApiKey, ...settings } = provider;
  return settings;
}

function parseModelList(value: string): string[] {
  return [...new Set(value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))];
}

function parseRate(value: string, label: string): number | undefined {
  const trimmed = value.trim().replace(/^\$/u, "");
  if (!trimmed) return undefined;
  const rate = Number(trimmed);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error(`The ${label} rate must be a number of dollars, such as 2 or 0.35.`);
  }
  return rate;
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** `Refuseless AI` → `refuseless-ai`, kept to the id rules. */
export function slugifyProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 32)
    .replace(/-+$/u, "");
  return slug;
}

function describeError(error: unknown): string {
  return cleanComposerErrorMessage(error instanceof Error ? error.message : String(error));
}

