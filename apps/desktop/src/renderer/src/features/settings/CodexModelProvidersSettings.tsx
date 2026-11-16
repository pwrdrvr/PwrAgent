import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  BONSAI_2_27B_MODEL_ID,
  CODEX_MODEL_PROVIDER_LIMIT,
  RESERVED_CODEX_MODEL_PROVIDER_IDS,
  isValidCodexModelProviderId,
  parseCodexProviderModelId,
  suggestCodexModelProviderId,
  validateCodexBaseUrl,
  validateCodexModelProviders,
  type BackendSummary,
  type CodexModelProviderCatalogState,
  type CodexModelProviderImportCandidate,
  type CodexModelProviderImportScan,
  type CodexModelProviderRate,
  type CodexModelProviderSettings,
  type CodexModelProviderTestResult,
  type CodexProviderCatalogModel,
  type DesktopCodexModelProvider,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { cleanComposerErrorMessage } from "../composer/composer-error-message";
import { formatRelativeTime } from "../navigation/thread-time";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsPathRow, type SettingsPathRowChip } from "./SettingsPathRow";
import { SettingsSwitch } from "./SettingsSwitch";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";
import { Select } from "../../components/Select";

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
  /** Model ids the operator added, beyond what the endpoint lists. */
  listed: string[];
  discoverModels: boolean;
  local: boolean;
  rates: Record<string, RateDraft>;
  /** The Codex config provider this draft was prefilled from. */
  imported?: CodexModelProviderImportCandidate;
  compatibility?: "bonsai";
  toolDiscovery?: "portable";
  catalogPath?: string;
  modelMetadata?: CodexProviderCatalogModel[];
  testModel?: string;
};

const EMPTY_RATE: RateDraft = { input: "", output: "", cached: "" };

type ProviderTest = {
  running: boolean;
  result?: CodexModelProviderTestResult;
  error?: string;
  /** The base URL the test read, so a later URL edit does not show its models. */
  baseUrl?: string;
};

/** A saved provider's models as the owner last read them, with that read's state. */
type ProviderCatalog = {
  /** The saved base URL the owner read. */
  baseUrl: string;
  state?: CodexModelProviderCatalogState;
  models: CodexProviderCatalogModel[];
};

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
 *
 * On open, the section also lists the providers that Codex config files
 * already define. Import prefills the add form; it copies no key.
 */
export function CodexModelProvidersSettings(props: {
  desktopApi?: DesktopApi;
  providers: DesktopCodexModelProvider[];
  /** Changes when the Codex homes change, so the import list is read again. */
  codexHomesKey?: string;
  saving: boolean;
  /** The owner's backend summaries, which carry each provider's last model read. */
  backends?: readonly BackendSummary[];
  onSave: (providers: CodexModelProviderSettings[]) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  /** Read one saved provider's model list again, then the summaries. */
  onRefreshCatalogs?: (providerId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProviderDraft>();
  const testGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<ProviderTest>();
  const [refresh, setRefresh] = useState<{ running: boolean; error?: string }>();
  const [imports, setImports] = useState<CodexModelProviderImportScan>();
  const scanImports = props.desktopApi?.scanCodexModelProviderImports;
  useEffect(() => {
    if (!scanImports) return;
    let current = true;
    scanImports().then(
      (scan) => {
        if (current) setImports(scan);
      },
      () => {
        // Importing is an offer. Without the list, the form still works.
        if (current) setImports(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [scanImports, props.codexHomesKey]);
  const editing = draft
    ? props.providers.find((provider) => provider.id === draft.existingId)
    : undefined;
  const dirty = draft ? isDraftDirty(draft, editing) : false;
  // Rebuilt when the owner's summaries change, not on every keystroke.
  const editingCatalog = useMemo(
    () => editing ? savedProviderCatalog(props.backends, editing) : undefined,
    [editing, props.backends],
  );

  const close = () => {
    testGeneration.current += 1;
    setDraft(undefined);
    setError(undefined);
    setTest(undefined);
    setRefresh(undefined);
  };

  const save = async (): Promise<boolean> => {
    if (!draft) return true;
    let next: CodexModelProviderSettings[];
    try {
      const provider = providerFromDraft(draft, providerModelSource(draft, editingCatalog, test).models);
      if (provider.toolDiscovery === "portable" && !provider.modelMetadata?.some(model => model.supportsPortableDiscovery)) {
        throw new Error("Choose a model and run Test connection to verify portable discovery before saving.");
      }
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
      [provider] = validateCodexModelProviders([
        providerFromDraft(draft, providerModelSource(draft, editingCatalog, test).models),
      ]);
      const offered = providerModelRows(providerModelSource(draft, editingCatalog, test).models, draft.listed);
      if (draft.testModel && offered.some((model) => model.id === draft.testModel)) {
        provider = { ...provider, models: [draft.testModel] };
      }
    } catch (problem) {
      setTest({ running: false, error: describeError(problem) });
      return;
    }
    // The URL as the form holds it, so the table can tell when it changes.
    const testedUrl = draft.baseUrl.trim();
    const generation = testGeneration.current;
    setTest({ running: true, baseUrl: testedUrl });
    try {
      const result = await props.desktopApi.testCodexModelProvider({
        provider,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft.removeKey ? { useStoredApiKey: false } : {}),
      });
      if (generation !== testGeneration.current) return;
      setTest({ running: false, result, baseUrl: testedUrl });
      if ((result.models.ok && result.models.items) || result.discovery || result.portableDiscovery) {
        setDraft((current) => {
          if (!current || current.id !== draft.id || !sameBaseUrl(current.baseUrl, testedUrl)
            || current.apiKey !== draft.apiKey || current.removeKey !== draft.removeKey
            || current.toolDiscovery !== draft.toolDiscovery) return current;
          const previous = new Map((current.modelMetadata ?? []).map((model) => [model.id, model]));
          for (const model of result.models.ok ? result.models.items ?? [] : []) previous.set(model.id, {
            ...model, ...(previous.get(model.id)?.supportsSearchTool === undefined ? {} : {
              supportsSearchTool: previous.get(model.id)!.supportsSearchTool,
            }),
            ...(previous.get(model.id)?.supportsPortableDiscovery === undefined ? {} : {
              supportsPortableDiscovery: previous.get(model.id)!.supportsPortableDiscovery,
            }),
          });
          if (result.discovery) previous.set(result.discovery.model, {
            ...(previous.get(result.discovery.model) ?? { id: result.discovery.model }), supportsSearchTool: result.discovery.ok,
          });
          if (result.portableDiscovery) previous.set(result.portableDiscovery.model, {
            ...(previous.get(result.portableDiscovery.model) ?? { id: result.portableDiscovery.model }),
            supportsPortableDiscovery: result.portableDiscovery.ok,
          });
          return { ...current, modelMetadata: [...previous.values()] };
        });
      }
    } catch (problem) {
      if (generation !== testGeneration.current) return;
      setTest({ running: false, error: describeError(problem), baseUrl: testedUrl });
    }
  };

  const refreshCatalogs = async (): Promise<void> => {
    if (!props.onRefreshCatalogs || !editing) return;
    setRefresh({ running: true });
    try {
      await props.onRefreshCatalogs(editing.id);
      // A refresh is newer than the last test, so the table follows it.
      setTest((current) => current?.result ? { ...current, result: undefined } : current);
      setRefresh({ running: false });
    } catch (problem) {
      setRefresh({ running: false, error: describeError(problem) });
    }
  };

  useUnsavedSettingsChanges(
    draft && dirty
      ? { label: "Model providers", save, discard: close }
      : undefined,
  );

  const disabled = props.saving || busy;
  const atLimit = props.providers.length >= CODEX_MODEL_PROVIDER_LIMIT;
  // An endpoint that is already a provider has nothing left to import.
  const importable = imports?.candidates.filter((candidate) =>
    !props.providers.some((provider) => provider.baseUrl === candidate.baseUrl)) ?? [];
  const skipped = imports?.skipped ?? [];
  // `editing` is the saved provider the draft edits, so it is found only
  // while that provider is still in the list.
  const editingListed = Boolean(editing);
  const editor = draft ? (
    <ProviderEditor
      draft={draft}
      editing={editing}
      catalog={editingCatalog}
      disabled={disabled}
      canTest={Boolean(props.desktopApi?.testCodexModelProvider)}
      test={test}
      refresh={refresh}
      error={error}
      onChange={(patch) => {
        if (patch.baseUrl !== undefined || patch.apiKey !== undefined || patch.removeKey !== undefined || "toolDiscovery" in patch) {
          testGeneration.current += 1;
          setTest(undefined);
        }
        setDraft((current) => current ? applyPatch(current, patch) : current);
      }}
      onSave={() => void save()}
      onCancel={close}
      onRemove={draft.existingId ? () => void remove() : undefined}
      onTest={() => void runTest()}
      onRefresh={props.onRefreshCatalogs ? () => void refreshCatalogs() : undefined}
    />
  ) : null;

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
        {props.providers.map((provider) => {
          const row = (
            <SettingsPathRow
              title={provider.name}
              meta={provider.id}
              path={provider.baseUrl}
              chips={providerChips(provider, codexCatalogState(props.backends, provider.id))}
              selected={false}
              useLabel="Edit"
              disabled={disabled || Boolean(draft)}
              onUse={draft?.existingId === provider.id ? undefined : () => {
                setDraft(draftFromProvider(provider));
                setError(undefined);
                setTest(undefined);
              }}
            />
          );
          // The form opens inside the card of the row whose Edit was pressed,
          // as a Plugins connection drawer and an Environments action do. Under
          // the whole list, the top row's form landed below every other row.
          return (
            <Fragment key={provider.id}>
              {draft?.existingId === provider.id ? (
                <div className="codex-provider-card">
                  {row}
                  {editor}
                </div>
              ) : row}
            </Fragment>
          );
        })}
        {/* A new provider's form, or one whose provider has left the list (a
            removal whose key cleanup failed, or another window's edit): it
            still needs a place, or the open draft disables every Edit and
            hides Add with no form on screen. */}
        {draft && !editingListed ? (
          <div className="codex-provider-card">
            <SettingsPathRow
              title={draft.existingId
                ? draft.name.trim() || draft.existingId
                : draft.imported ? `Import ${draft.imported.name}` : "New provider"}
              selected={false}
            />
            {editor}
          </div>
        ) : null}
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
      {!draft && (importable.length || skipped.length) ? (
        <div
          aria-label="Providers in Codex config files"
          className="settings-paths codex-provider-imports"
          role="group"
        >
          <p className="codex-provider-imports__title">In Codex config files</p>
          {importable.map((candidate) => (
            <SettingsPathRow
              key={candidate.baseUrl}
              title={candidate.name}
              meta={candidate.sources.map((source) => source.label).join(", ")}
              path={candidate.baseUrl}
              chips={importChips(candidate)}
              selected={false}
              extraAction={
                <button
                  aria-label={`Import ${candidate.name}`}
                  className="button button--secondary"
                  disabled={disabled || atLimit}
                  title={candidate.sources.map((source) => source.configPath).join("\n")}
                  type="button"
                  onClick={() => {
                    setDraft(draftFromImport(candidate, new Set(props.providers.map((provider) => provider.id))));
                    setError(undefined);
                    setTest(undefined);
                  }}
                >
                  Import
                </button>
              }
            />
          ))}
          {skipped.length ? (
            <ul aria-label="Not importable" className="codex-provider-imports__skipped">
              {skipped.map((skip) => (
                <li key={`${skip.sourceId ?? ""}\n${skip.reason}`}>
                  <strong>{skip.name ?? skip.sourceId ?? skip.sources[0]?.configPath}</strong>
                  {" · "}
                  {skip.sources.map((source) => source.label).join(", ")}
                  {": "}
                  {skip.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}

function ProviderEditor(props: {
  draft: ProviderDraft;
  editing?: DesktopCodexModelProvider;
  /** What the owner's last read of this provider found, for a saved provider. */
  catalog?: ProviderCatalog;
  disabled: boolean;
  canTest: boolean;
  test?: ProviderTest;
  refresh?: { running: boolean; error?: string };
  error?: string;
  onChange: (patch: Partial<ProviderDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove?: () => void;
  onTest: () => void;
  onRefresh?: () => void;
}) {
  const draft = props.draft;
  const testModels = providerModelRows(providerModelSource(draft, props.catalog, props.test).models, draft.listed);
  const idProblem = draft.id && !isValidCodexModelProviderId(draft.id)
    ? RESERVED_CODEX_MODEL_PROVIDER_IDS.has(draft.id)
      ? `"${draft.id}" is reserved. Choose another id.`
      : "Lowercase letters, digits, - or _, starting with a letter."
    : undefined;
  const keyHelp = props.editing?.hasApiKey
    ? draft.removeKey
      ? "The stored key is removed when you save."
      : "A key is stored. Leave blank to keep it."
    : draft.imported?.needsApiKey
      ? `Codex ${draft.imported.apiKeyEnv ? `read it from $${draft.imported.apiKeyEnv}` : "sent a key"}. Keys are not copied from files, so paste it here. It is stored in the system keychain.`
      : "Stored in the system keychain. Codex receives it in its environment; commands a model runs do not.";

  return (
    <div
      aria-label={draft.existingId ? `Edit ${props.editing?.name ?? draft.existingId}` : "Add model provider"}
      className="settings-fields codex-provider-editor"
      role="group"
    >
      {draft.imported ? (
        <p className="settings-field__help">
          {[
            `Imported from ${draft.imported.sources.map((source) => source.configPath).join(", ")}.`,
            ...draft.imported.notes,
          ].join(" ")}
        </p>
      ) : null}
      <p className="codex-provider-editor__group">Connection</p>
      <SettingsField
        label="Name"
        sub="Shown in the Provider picker, on thread chips and in model pickers."
        control={
          <input
            aria-label="Provider name"
            // The Edit button that opened the form is gone, so focus starts
            // here rather than falling to the page.
            autoFocus
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
        sub="The endpoint's OpenAI API root. Codex calls {base}/responses; the model list comes from {base}/models."
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
        label="Tool discovery"
        sub="Portable loads tool definitions as needed through ordinary function calls. Test each model before using it. Start a new thread when changing discovery mode."
        control={<Select
          aria-label="Tool discovery"
          className="settings-input"
          disabled={props.disabled || props.test?.running}
          value={draft.toolDiscovery ?? "default"}
          options={[{ value: "default", label: "Provider default" }, { value: "portable", label: "Portable" }]}
          onChange={(value) => props.onChange({ toolDiscovery: value === "portable" ? "portable" : undefined })}
        />}
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
            {props.canTest && testModels.length ? (
              <Select
                aria-label="Model to test"
                className="settings-input"
                disabled={props.disabled || props.test?.running}
                value={draft.testModel ?? ""}
                onChange={(value) => props.onChange({ testModel: value || undefined })}
                options={[{ value: "", label: "First available model" }, ...testModels.map((model) => ({
                  value: model.id, label: model.label ?? model.id,
                }))]}
              />
            ) : null}
            <div className="settings-inline-actions">
              {props.canTest ? (
                <button
                  className="button button--secondary"
                  disabled={props.disabled || props.test?.running}
                  type="button"
                  onClick={props.onTest}
                >
                  {props.test?.running ? "Testing…" : "Test connection"}
                </button>
              ) : null}
              {props.editing?.hasApiKey ? (
                <button
                  className="button button--ghost"
                  disabled={props.disabled}
                  type="button"
                  onClick={() => props.onChange({ removeKey: !draft.removeKey, apiKey: "" })}
                >
                  {draft.removeKey ? "Keep stored key" : "Remove stored key"}
                </button>
              ) : null}
            </div>
            {props.test && !props.test.running ? <ProviderTestResult test={props.test} /> : null}
            {props.canTest ? (
              <p className="settings-field__help">
                The test reads /models and sends up to {draft.toolDiscovery === "portable" ? "ten" : "four"} short /responses requests, which the provider may bill.
                {draft.toolDiscovery === "portable"
                  ? " It also runs a read-only fixture through Codex to check portable discovery and execution."
                  : " It checks ordinary tools and discovery through a read-only fixture."}
                {" "}Save to apply the model metadata.
                {draft.toolDiscovery !== "portable" ? " A passing check does not validate a full PwrAgent turn." : null}
              </p>
            ) : null}
          </>
        }
      />
      <p className="codex-provider-editor__group">Models</p>
      <ProviderModels
        catalog={props.catalog}
        disabled={props.disabled}
        draft={draft}
        refresh={props.refresh}
        test={props.test}
        onChange={props.onChange}
        onRefresh={props.onRefresh}
      />
      <SettingsField
        label="Runs locally"
        sub="Records this provider's usage at no cost, as for a server on this machine, and hides the rate columns."
        control={
          <SettingsSwitch
            checked={draft.local}
            disabled={props.disabled}
            label="Runs locally"
            onChange={(local) => props.onChange({ local })}
          />
        }
      />
      {/* Sticky to the pane's bottom edge while the card is on screen, so
          Save and Cancel stay in reach from the top of a long form. */}
      <div className="codex-provider-editor__footer">
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
      </div>
      <p className="settings-field__help">
        Codex reconnects when no turn is running. Threads already on this provider keep it.
      </p>
    </div>
  );
}

/** Rows the model table shows at once; the filter narrows a longer list. */
export const PROVIDER_MODEL_TABLE_ROWS = 50;
/** The filter appears past this many rows, as the composer's Model menu would scroll. */
export const PROVIDER_MODEL_FILTER_MIN_ROWS = 10;

/**
 * Every model the provider offers: the ones its `GET /models` listed, with
 * the effort levels it named, and the ones added here. Each takes a rate.
 */
function ProviderModels(props: {
  draft: ProviderDraft;
  catalog?: ProviderCatalog;
  test?: ProviderTest;
  refresh?: { running: boolean; error?: string };
  disabled: boolean;
  onChange: (patch: Partial<ProviderDraft>) => void;
  onRefresh?: () => void;
}) {
  const draft = props.draft;
  const [query, setQuery] = useState("");
  const [newModel, setNewModel] = useState("");
  const source = useMemo(
    () => providerModelSource(draft, props.catalog, props.test),
    [draft, props.catalog, props.test],
  );
  const rows = useMemo(() => providerModelRows(source.models, draft.listed), [source.models, draft.listed]);
  // The query applies only while its field is shown, so a list that shrinks
  // below the field's threshold never stays filtered by a hidden query.
  const filtering = rows.length > PROVIDER_MODEL_FILTER_MIN_ROWS;
  const visible = useMemo(
    () => filtering ? filterProviderModelRows(rows, query) : rows,
    [filtering, query, rows],
  );
  const shown = visible.slice(0, PROVIDER_MODEL_TABLE_ROWS);
  const addModel = (): void => {
    const model = newModel.trim();
    if (!model || draft.listed.includes(model)) {
      setNewModel("");
      return;
    }
    props.onChange({ listed: [...draft.listed, model] });
    setNewModel("");
  };

  return (
    <div className="codex-provider-models">
      <div className="codex-provider-catalog-head">
        <span role="status">{source.line}</span>
        <span className="codex-provider-catalog-head__spacer" />
        <SettingsSwitch
          checked={draft.discoverModels}
          disabled={props.disabled}
          label="List the endpoint's models"
          onChange={(discoverModels) => props.onChange({ discoverModels })}
        />
        {source.refreshable && props.onRefresh ? (
          <button
            className="button button--secondary"
            disabled={props.disabled || props.refresh?.running}
            type="button"
            onClick={props.onRefresh}
          >
            {props.refresh?.running ? "Refreshing…" : "Refresh"}
          </button>
        ) : null}
      </div>
      {props.refresh?.error ? <p className="settings-error" role="alert">{props.refresh.error}</p> : null}
      {filtering ? (
        <input
          aria-label="Find a model"
          className="settings-input"
          placeholder="Find a model"
          spellCheck={false}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      ) : null}
      {shown.length ? (
        <div className="codex-provider-models__scroll">
          <table aria-label="Provider models" className="codex-provider-rates codex-provider-models__table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Effort</th>
                {draft.local ? null : (
                  <>
                    <th scope="col">Input</th>
                    <th scope="col">Output</th>
                    <th scope="col">Cached input</th>
                  </>
                )}
                <th aria-label="Remove" scope="col" />
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const rate = draft.rates[row.id] ?? EMPTY_RATE;
                const metadata = draft.modelMetadata?.find((model) => model.id === row.id);
                const setRate = (patch: Partial<RateDraft>) =>
                  props.onChange({ rates: { ...draft.rates, [row.id]: { ...rate, ...patch } } });
                return (
                  <tr key={row.id}>
                    <th scope="row" title={row.id}>
                      <span className="codex-provider-models__name">
                        <span>
                          {row.label ?? row.id}
                          {row.added ? <span className="codex-provider-models__tag">Added</span> : null}
                        </span>
                        {row.label ? <code>{row.id}</code> : null}
                        {metadata ? <span className="codex-provider-models__muted">
                          {metadata.contextWindow ? `${metadata.contextWindow.toLocaleString("en-US")} token context` : "Context unknown"}
                          {" · "}{draft.toolDiscovery === "portable"
                            ? metadata.supportsPortableDiscovery ? "Portable discovery verified" : "Portable discovery not verified"
                            : draft.compatibility === "bonsai" || metadata.supportsSearchTool === true ? "Tool discovery enabled" : "Tool discovery not enabled"}
                        </span> : null}
                      </span>
                    </th>
                    <td>
                      {row.reasoningEfforts?.length ? (
                        <span className="codex-provider-levels" aria-label={`Effort levels: ${row.reasoningEfforts.join(", ")}${
                          row.defaultReasoningEffort ? `; default ${row.defaultReasoningEffort}` : ""
                        }`}>
                          {row.reasoningEfforts.map((effort) => (
                            <span
                              aria-hidden="true"
                              className={`codex-provider-level${effort === row.defaultReasoningEffort ? " codex-provider-level--default" : ""}`}
                              key={effort}
                            >
                              {effort}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="codex-provider-models__muted">{row.discovered ? "None listed" : "Unknown"}</span>
                      )}
                    </td>
                    {draft.local ? null : (
                      <>
                        <td>
                          <RateInput
                            label={`${row.id} input rate`}
                            disabled={props.disabled}
                            value={rate.input}
                            onChange={(input) => setRate({ input })}
                          />
                        </td>
                        <td>
                          <RateInput
                            label={`${row.id} output rate`}
                            disabled={props.disabled}
                            value={rate.output}
                            onChange={(output) => setRate({ output })}
                          />
                        </td>
                        <td>
                          <RateInput
                            label={`${row.id} cached input rate`}
                            disabled={props.disabled}
                            placeholder={rate.input || undefined}
                            value={rate.cached}
                            onChange={(cached) => setRate({ cached })}
                          />
                        </td>
                      </>
                    )}
                    <td>
                      {row.added ? (
                        <button
                          aria-label={`Remove ${row.id}`}
                          className="button button--ghost"
                          disabled={props.disabled}
                          type="button"
                          onClick={() => {
                            // A model the endpoint does not list leaves the table, so
                            // its rate goes with it rather than staying out of sight.
                            const { [row.id]: _removed, ...rates } = draft.rates;
                            props.onChange({
                              listed: draft.listed.filter((model) => model !== row.id),
                              ...(row.discovered ? {} : { rates }),
                            });
                          }}
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : rows.length ? (
        <p className="settings-empty">No models match “{query.trim()}”.</p>
      ) : null}
      <p className="settings-field__help">
        {visible.length > shown.length
          ? `Showing ${shown.length.toLocaleString("en-US")} of ${visible.length.toLocaleString("en-US")}. Type to narrow the list. `
          : ""}
        {draft.local
          ? "This provider is recorded at no cost."
          : "Rates are USD per 1M tokens, from the provider's price list. A model without one is recorded as unpriced."}
      </p>
      <div className="settings-inline-actions">
        <input
          aria-label="Model id to add"
          className="settings-input codex-provider-models__add"
          disabled={props.disabled}
          placeholder="A model id the list leaves out"
          spellCheck={false}
          value={newModel}
          onChange={(event) => setNewModel(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addModel();
            }
          }}
        />
        <button
          className="button button--secondary"
          disabled={props.disabled || !newModel.trim()}
          type="button"
          onClick={addModel}
        >
          Add model
        </button>
      </div>
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
          ? `${result.models.count.toLocaleString("en-US")} model${result.models.count === 1 ? "" : "s"}${
            result.models.pages ? ` over ${result.models.pages} pages` : ""
          }${result.models.truncated ? " (more not loaded)" : ""}${
            result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : ""
          }`
          : result.models.error ?? "Failed"}
      </li>
      {result.discovery ? (
        <li className={result.discovery.ok ? "is-ok" : "is-err"}>
          <strong>Provider discovery</strong>{" "}
          {result.discovery.ok ? `Verified for ${result.discovery.model}` : result.discovery.error ?? "Not verified"}
        </li>
      ) : null}
      {result.portableDiscovery ? (
        <li className={result.portableDiscovery.ok ? "is-ok" : "is-err"}>
          <strong>Portable discovery</strong>{" "}
          {result.portableDiscovery.ok ? `Verified through Codex for ${result.portableDiscovery.model}` : result.portableDiscovery.error ?? "Not verified"}
          {result.portableDiscovery.ok ? ` · ${result.portableDiscovery.requests} requests` : null}
          {result.portableDiscovery.initialToolBytes === undefined ? null : ` · ${(result.portableDiscovery.initialToolBytes / 1024).toFixed(1)} KiB initial tool definitions`}
          {result.portableDiscovery.initialRequestBytes === undefined ? null : ` · ${(result.portableDiscovery.initialRequestBytes / 1024).toFixed(1)} KiB initial request`}
        </li>
      ) : null}
      <li className={responses.ok ? "is-ok" : responses.skipped ? "is-skip" : "is-err"}>
        <strong>/responses</strong>{" "}
        {responses.ok
          ? `Answered with ${responses.model}`
          : responses.error ?? "Failed"}
        {!responses.ok && !responses.skipped
          ? " Codex needs Responses API compatibility for instructions and namespaced function tools."
          : null}
      </li>
    </ul>
  );
}

function codexCatalogState(
  backends: readonly BackendSummary[] | undefined,
  providerId: string,
): CodexModelProviderCatalogState | undefined {
  return backends
    ?.find((backend) => backend.kind === "codex")
    ?.codexModelProviders
    ?.find((state) => state.id === providerId);
}

function providerChips(
  provider: DesktopCodexModelProvider,
  catalog: CodexModelProviderCatalogState | undefined,
): SettingsPathRowChip[] {
  const modelCount = provider.models?.length ?? 0;
  const chips: SettingsPathRowChip[] = [
    { key: "key", label: provider.hasApiKey ? "key" : "no key", tone: provider.hasApiKey ? "muted" : "warn" },
  ];
  if (provider.compatibility) chips.push({ key: "runtime", label: "isolated runtime", tone: "muted" });
  // What the owner's last read found, when the endpoint's list is on.
  if (provider.discoverModels !== false && catalog?.status === "ready") {
    const count = catalog.discoveredCount ?? 0;
    chips.push({
      key: "models",
      label: `${count.toLocaleString("en-US")} model${count === 1 ? "" : "s"}${catalog.truncated ? "+" : ""}`,
      tone: "muted",
      title: "Models the endpoint's GET /models listed in its last read",
    });
  } else if (provider.discoverModels !== false && catalog?.status === "unavailable") {
    chips.push({
      key: "models",
      label: "list unavailable",
      tone: "warn",
      title: catalog.error ?? "The last read of the endpoint's model list failed",
    });
  } else if (modelCount > 0 || provider.discoverModels !== false) {
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

function importChips(candidate: CodexModelProviderImportCandidate): SettingsPathRowChip[] {
  const chips: SettingsPathRowChip[] = [];
  if (candidate.models.length) {
    chips.push({
      key: "models",
      label: candidate.models.length === 1 ? "1 model" : `${candidate.models.length} models`,
      tone: "muted",
      title: candidate.models.join("\n"),
    });
  }
  if (candidate.local) chips.push({ key: "local", label: "local", tone: "muted" });
  if (candidate.needsApiKey) {
    chips.push({
      key: "key",
      label: "needs key",
      tone: "warn",
      title: "Keys are not copied from files. Paste it in the form.",
    });
  }
  return chips;
}

function draftFromImport(
  candidate: CodexModelProviderImportCandidate,
  takenIds: ReadonlySet<string>,
): ProviderDraft {
  return {
    ...emptyDraft(),
    name: candidate.name,
    // The Codex key, such as `bonsai`, reads better than a slug of the name.
    id: suggestCodexModelProviderId(candidate.sourceId, takenIds),
    idEdited: true,
    baseUrl: candidate.baseUrl,
    listed: [...candidate.models],
    local: candidate.local,
    imported: candidate,
    compatibility: candidate.compatibility,
    catalogPath: candidate.catalogPath,
  };
}

function emptyDraft(): ProviderDraft {
  return {
    name: "",
    id: "",
    idEdited: false,
    baseUrl: "",
    apiKey: "",
    removeKey: false,
    listed: [],
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
    listed: [...(provider.models ?? [])],
    discoverModels: provider.discoverModels !== false,
    local: provider.local === true,
    rates,
    compatibility: provider.compatibility,
    toolDiscovery: provider.toolDiscovery,
    catalogPath: provider.catalogPath,
    modelMetadata: provider.modelMetadata,
  };
}

function applyPatch(draft: ProviderDraft, patch: Partial<ProviderDraft>): ProviderDraft {
  const next = { ...draft, ...patch };
  if ((patch.baseUrl !== undefined && patch.baseUrl !== draft.baseUrl)
    || (patch.apiKey !== undefined && patch.apiKey !== draft.apiKey)
    || (patch.removeKey !== undefined && patch.removeKey !== draft.removeKey)) {
    next.modelMetadata = undefined;
  }
  if (patch.baseUrl !== undefined && patch.baseUrl !== draft.baseUrl) next.testModel = undefined;
  if (patch.name !== undefined && !next.idEdited && !next.existingId) {
    next.id = slugifyProviderId(patch.name);
  }
  return next;
}

function providerFromDraft(draft: ProviderDraft, discovered: readonly CodexProviderCatalogModel[] = []): CodexModelProviderSettings {
  const models = [...new Set(draft.listed.map((model) => model.trim()).filter(Boolean))];
  // An existing Bonsai runtime needs one explicit model even when its choice
  // came from discovery. A generic endpoint advertising the alias does not
  // establish Bonsai compatibility or opt the provider into its bridge.
  if (!models.length && draft.compatibility === "bonsai") {
    const alias = discovered.find((model) => model.id === BONSAI_2_27B_MODEL_ID);
    if (alias) models.push(alias.id);
    else if (discovered.length === 1) models.push(discovered[0].id);
  }
  const rates: CodexModelProviderRate[] = [];
  if (!draft.local) {
    // A rate is kept for any model, listed by the endpoint or added here.
    for (const [model, rate] of Object.entries(draft.rates)) {
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
    ...(draft.compatibility ? { compatibility: draft.compatibility } : {}),
    ...(draft.toolDiscovery ? { toolDiscovery: draft.toolDiscovery } : {}),
    ...(draft.catalogPath ? { catalogPath: draft.catalogPath } : {}),
    ...(draft.modelMetadata?.length ? { modelMetadata: draft.modelMetadata } : {}),
  };
}

function isDraftDirty(draft: ProviderDraft, saved: DesktopCodexModelProvider | undefined): boolean {
  if (draft.apiKey.trim() || draft.removeKey) return true;
  if (!saved) {
    return Boolean(draft.name.trim() || draft.id.trim() || draft.baseUrl.trim() || draft.listed.length);
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

/** A saved provider's models from the owner's Codex summary. */
function savedProviderCatalog(
  backends: readonly BackendSummary[] | undefined,
  provider: Pick<DesktopCodexModelProvider, "id" | "baseUrl">,
): ProviderCatalog {
  const providerId = provider.id;
  const codex = backends?.find((backend) => backend.kind === "codex");
  return {
    baseUrl: provider.baseUrl,
    state: codex?.codexModelProviders?.find((state) => state.id === providerId),
    models: (codex?.launchpadOptions?.models ?? []).flatMap((model): CodexProviderCatalogModel[] => {
      const parsed = parseCodexProviderModelId(model.id);
      if (parsed.providerId !== providerId) return [];
      return [{
        id: parsed.model,
        ...(model.label && model.label !== parsed.model ? { label: model.label } : {}),
        ...(model.reasoningEfforts?.length ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
        ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
        ...(model.supportsImage === undefined ? {} : { supportsImage: model.supportsImage }),
      }];
    }),
  };
}

/**
 * Where the model table's models come from, and the line above it. A test
 * of the URL in the form is the newest read; otherwise a saved provider
 * shows the owner's last read of its saved URL.
 */
export function providerModelSource(
  draft: Pick<ProviderDraft, "existingId" | "baseUrl" | "discoverModels">,
  catalog: ProviderCatalog | undefined,
  test: ProviderTest | undefined,
): { models: CodexProviderCatalogModel[]; line: string; refreshable: boolean } {
  if (!draft.discoverModels) {
    return { models: [], line: "Only the models added here are offered.", refreshable: false };
  }
  const tested = test?.result?.models;
  if (tested?.ok && tested.items && sameBaseUrl(test?.baseUrl, draft.baseUrl)) {
    return {
      models: tested.items,
      line: `${countModels(tested.items.length)} from GET /models · from this test${tested.truncated ? " (more not loaded)" : ""}`,
      refreshable: false,
    };
  }
  // The owner's read is of the saved URL; an edited URL is another endpoint.
  const saved = Boolean(draft.existingId && catalog && sameBaseUrl(catalog.baseUrl, draft.baseUrl));
  const state = catalog?.state;
  if (!saved || !state) {
    return {
      models: [],
      line: "Test the connection to read the endpoint's models.",
      refreshable: false,
    };
  }
  if (state.status === "off") {
    // Saved with the list off, so the owner has not read it.
    return { models: [], line: "Save, or test the connection, to read the endpoint's models.", refreshable: false };
  }
  if (state.status === "unavailable") {
    return {
      models: [],
      line: `Couldn't read the model list${state.error ? `: ${state.error}` : "."}`,
      refreshable: true,
    };
  }
  if (state.status === "pending") {
    return { models: catalog?.models ?? [], line: "Reading the endpoint's models…", refreshable: true };
  }
  const discovered = state.discoveredCount ?? 0;
  const age = state.readAt === undefined ? undefined : formatRelativeTime(state.readAt);
  // `formatRelativeTime` prints "now", "42m", "8h", "6d", then a date.
  const read = age === undefined
    ? ""
    : age === "now" ? " · read just now" : /^\d+[mhd]$/u.test(age) ? ` · read ${age} ago` : ` · read ${age}`;
  return {
    models: catalog?.models ?? [],
    line: `${countModels(discovered)} from GET /models${state.truncated ? " (more not loaded)" : ""}${read}`,
    refreshable: true,
  };
}

type ProviderModelRow = CodexProviderCatalogModel & {
  /** The endpoint listed it. */
  discovered: boolean;
  /** The operator added it. */
  added: boolean;
};

/** The endpoint's models in its order, then the added ones it does not list. */
export function providerModelRows(
  catalog: readonly CodexProviderCatalogModel[],
  listed: readonly string[],
): ProviderModelRow[] {
  const added = new Set(listed);
  const rows: ProviderModelRow[] = catalog.map((model) => ({ ...model, discovered: true, added: added.has(model.id) }));
  const seen = new Set(rows.map((row) => row.id));
  for (const model of listed) {
    if (!seen.has(model)) {
      seen.add(model);
      rows.push({ id: model, discovered: false, added: true });
    }
  }
  return rows;
}

/** Every word must appear in the model's name or id, in any order, ignoring case. */
export function filterProviderModelRows<T extends { id: string; label?: string }>(
  rows: readonly T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const text = `${row.label ?? ""} ${row.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

function countModels(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "model" : "models"}`;
}

/** Two base URLs name one endpoint when they validate to the same URL. */
function sameBaseUrl(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const normalize = (value: string): string => {
    try {
      return validateCodexBaseUrl(value);
    } catch {
      return value.trim();
    }
  };
  return normalize(left) === normalize(right);
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

