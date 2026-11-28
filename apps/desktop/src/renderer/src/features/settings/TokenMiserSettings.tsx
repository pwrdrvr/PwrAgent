import { formatFilesystemPath } from "@pwragent/shared/path-display";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import {
  type DesktopSettingsConfigPatch,
  type DesktopSettingsSnapshot,
  type DesktopTokenMiserUsage,
  type TokenMiserGateProvider,
  type TokenMiserSummarizerMode,
} from "@pwragent/shared/contracts/settings";
import { resolveDecisionModelSettings } from "@pwragent/shared/decision-models";
import {
  resolveHelperModel,
  type DesktopHelperModelSettings,
} from "@pwragent/shared/helper-models";
import {
  OPENAI_DECISIONS_MODEL,
  OPENAI_DECISIONS_RATES_MICROS_PER_MILLION,
} from "@pwragent/shared/openai-decisions";
import { useRef, useState, type ReactNode } from "react";
import { Select, type SelectOption } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { ModelSettingsPicker } from "../composer/ModelSettingsPicker";
import { splitEffortChoices } from "../composer/model-settings-picker-model";
import {
  ManagedRuntimeProgressStrip,
  useManagedRuntimeProgress,
} from "./ManagedRuntimeProgress";
import {
  SettingsField,
  SettingsSection,
  ToggleField,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";
import {
  CAPTURE_ORIGINS,
  CAPTURE_RUNNERS,
  captureRowState,
  captureRunnerLabel,
  tokenMiserModelChoices,
  withCaptureRow,
  type CaptureOrigin,
  type CaptureRowState,
  type TokenMiserModelChoices,
} from "./token-miser-capture-helpers";

const PICKER_CLASS = "settings-select settings-select--chip";

const DEFAULT_TOKEN_MISER_ENABLED = {
  value: false,
  source: "default" as const,
};

const DEFAULT_TOKEN_MISER_DEFAULT_ENABLED = {
  value: true,
  source: "default" as const,
};

const PROVIDERS_PAGE = "AI Providers";

function Line(props: { warn?: boolean; children: ReactNode }) {
  return (
    <span
      className={
        props.warn
          ? "settings-helper-model__line settings-field__value--warn"
          : "settings-helper-model__line"
      }
    >
      {props.children}
    </span>
  );
}

function modelLabel(id: string, models: readonly { id: string; label?: string }[]): string {
  return models.find((model) => model.id === id)?.label ?? id;
}

function openAIInputRate(): string {
  const dollars = OPENAI_DECISIONS_RATES_MICROS_PER_MILLION.uncachedInput / 1_000_000;
  return `$${dollars.toFixed(2)}`;
}

type ProviderStatus = { ready: boolean; lines: ReactNode[] };

/**
 * The selected decision provider, its model, whether it can score now and
 * what a call costs. Mirrors the owner's provider checks; a provider that is
 * not ready leaves the agent with the digest only.
 */
function decisionProviderStatus(
  provider: Exclude<TokenMiserGateProvider, "none">,
  snapshot: DesktopSettingsSnapshot,
): ProviderStatus {
  const models = snapshot.models;
  const decisions = resolveDecisionModelSettings(models.decisionModels);
  const fallback = "Until then the agent gets the digest only.";
  if (provider === "openai") {
    const account = models.openaiDecisions;
    const cost = (
      <Line key="cost">
        Paid per call to your OpenAI API project, not a ChatGPT plan, at {openAIInputRate()} per
        million input tokens. Every finished capture is one call.
      </Line>
    );
    if (!account) {
      return { ready: false, lines: [<Line key="state" warn>This build cannot reach OpenAI Decisions. The agent gets the digest only.</Line>, cost] };
    }
    if (account.enabled === false) {
      return { ready: false, lines: [<Line key="state" warn>OpenAI Decisions is off in {PROVIDERS_PAGE} → OpenAI Decisions. {fallback}</Line>, cost] };
    }
    if (!account.apiKey.configured) {
      return { ready: false, lines: [<Line key="state" warn><strong>{OPENAI_DECISIONS_MODEL}</strong> needs an API key in {PROVIDERS_PAGE} → OpenAI Decisions. {fallback}</Line>, cost] };
    }
    return { ready: true, lines: [<Line key="state">Runs <strong>{OPENAI_DECISIONS_MODEL}</strong> on OpenAI Decisions. API key stored.</Line>, cost] };
  }
  if (provider === "jev") {
    const cost = <Line key="cost">Billed by TypeSafe per call to your Jev account. Every finished capture is one call.</Line>;
    if (!decisions.enabled.jev) {
      return { ready: false, lines: [<Line key="state" warn>TypeSafe Jev is off in {PROVIDERS_PAGE} → TypeSafe Jev. {fallback}</Line>, cost] };
    }
    if (!models.decisionSecrets?.jevApiKey.configured) {
      return { ready: false, lines: [<Line key="state" warn><strong>{decisions.jevModel}</strong> needs an API key in {PROVIDERS_PAGE} → TypeSafe Jev. {fallback}</Line>, cost] };
    }
    return { ready: true, lines: [<Line key="state">Runs <strong>{decisions.jevModel}</strong> on TypeSafe Jev. API key stored.</Line>, cost] };
  }
  const cost = <Line key="cost">Free. If the server does not answer within 3 seconds, the agent gets the digest only.</Line>;
  if (!decisions.enabled.local) {
    return { ready: false, lines: [<Line key="state" warn>The local decision model is off in {PROVIDERS_PAGE} → Local decision model. {fallback}</Line>, cost] };
  }
  return { ready: true, lines: [<Line key="state">Runs <strong>{decisions.localModel}</strong> on this Mac at {decisions.localEndpoint}.</Line>, cost] };
}

const EARLIER_CHOICE_LABELS: Record<NonNullable<TokenMiserModelChoices["earlier"]>, string> = {
  configured: "a Helper model for each thread type",
  codex: "the Codex Token Miser helper",
  decision: "your default decision model",
  openai: "OpenAI Decisions",
  jev: "TypeSafe Jev",
  local: "the local decision model",
};

function captureRowLine(
  state: CaptureRowState,
  harness: string,
  backends: readonly BackendSummary[],
): ReactNode {
  const runner = captureRunnerLabel(state.backend, backends);
  const fallback = `Until then ${harness} threads get the digest only.`;
  switch (state.status.kind) {
    case "needs-backend":
      return <Line warn>Antigravity can’t run the summarizer. Choose Codex, Claude or Grok to run it. {fallback}</Line>;
    case "unsupported-backend":
      return <Line warn>{runner} can’t run the summarizer. Choose Codex, Claude or Grok. {fallback}</Line>;
    case "needs-model":
      return state.origin === "codex" && state.backend === "codex"
        ? <Line warn>Choose a model, or save a Helper model in {PROVIDERS_PAGE} → Helpers. {fallback}</Line>
        : <Line warn>Choose a model on {runner}. {fallback}</Line>;
    case "backend-loading":
      return <Line>Checking {runner} models…</Line>;
    case "backend-unavailable":
      return <Line warn>{runner} is not connected. {harness} threads get the digest only until it is.</Line>;
    case "model-not-offered":
      return <Line warn>{runner} does not offer {state.model}. {harness} threads get the digest only.</Line>;
    case "ready": {
      const name = modelLabel(state.model ?? "", state.models);
      return state.modelSource === "helper-default"
        ? <Line>Runs <strong>{name}</strong> on Codex, your Helper model from {PROVIDERS_PAGE} → Helpers{state.effort ? `, ${state.effort} effort` : ""}.</Line>
        : <Line>Runs <strong>{name}</strong> on {runner}{state.effort ? `, ${state.effort} effort` : ""}.</Line>;
    }
  }
}

/** One capture origin's summarizer: the backend that runs it, its model and effort. */
function CaptureOriginRow(props: {
  origin: CaptureOrigin;
  label: string;
  harness: string;
  backends: readonly BackendSummary[];
  helperModels: DesktopHelperModelSettings;
  disabled: boolean;
  onSave: (next: DesktopHelperModelSettings) => void;
}) {
  const state = captureRowState(props.origin, props.helperModels, props.backends);
  const saved = state.saved;
  const backendSummary = props.backends.find((backend) => backend.kind === state.backend);
  const models = state.models;
  const efforts = (models.find((model) => model.id === state.model)?.reasoningEfforts
    ?? backendSummary?.launchpadOptions?.reasoningEfforts) ?? [];
  const runnerLabel = captureRunnerLabel(state.backend, props.backends);
  const defaultEffort = resolveHelperModel({
    helper: state.helper,
    settings: withCaptureRow(props.helperModels, state.helper, saved && { ...saved, reasoningEffort: undefined }),
    backend: state.backend,
    models: [],
    requestedModel: state.model ?? "pending",
  }).reasoningEffort ?? "low";
  const save = (next: { backend?: string; model?: string; reasoningEffort?: string }) => {
    props.onSave(withCaptureRow(props.helperModels, state.helper, next));
  };
  const savedModel = saved?.model;
  const inheritLabel = props.origin === "codex" && state.backend === "codex"
    ? props.helperModels.defaultModel
      ? `Helper model (${modelLabel(props.helperModels.defaultModel, models)})`
      : "Helper model (not saved)"
    : "Choose a model";
  const pillLabel = state.status.kind === "needs-backend"
    ? "Choose who runs it"
    : savedModel
      ? models.length > 0 && !models.some((model) => model.id === savedModel)
        ? `${savedModel} (not offered)`
        : modelLabel(savedModel, models)
      : inheritLabel;

  return (
    <div className="settings-token-miser__origin">
      <span className="settings-token-miser__origin-name" id={`token-miser-origin-${props.origin}`}>
        {props.label}
      </span>
      <div className="settings-token-miser__origin-cell">
        <ModelSettingsPicker
          ariaLabel={`Summarizer for ${props.label}`}
          disabled={props.disabled}
          size="setting"
          provider={{
            label: state.status.kind === "needs-backend" ? "Choose who runs it" : runnerLabel,
            showInPill: true,
            choices: {
              options: CAPTURE_RUNNERS
                .filter((runner) => runner === state.backend
                  || props.backends.some((backend) => backend.kind === runner && backend.available))
                .map((runner) => ({ value: runner, label: captureRunnerLabel(runner, props.backends) })),
              unavailable: CAPTURE_RUNNERS
                .filter((runner) => runner !== state.backend
                  && !props.backends.some((backend) => backend.kind === runner && backend.available))
                .map((runner) => ({
                  value: runner,
                  label: captureRunnerLabel(runner, props.backends),
                  disabled: true,
                  description: "Not connected",
                })),
              unavailableLabel: "Not connected",
              // An Antigravity row without a saved backend has chosen nothing yet.
              value: state.status.kind === "needs-backend" ? "" : state.backend,
              onChange: (backend) => {
                if (backend === saved?.backend && backend) return;
                // A model and effort belong to one backend's catalog.
                save({ backend });
              },
            },
          }}
          model={{
            value: savedModel ?? "",
            label: pillLabel,
            kind: backendSummary?.kind,
            models,
            disabled: state.status.kind === "needs-backend",
            leadingOptions: [
              {
                value: "",
                label: inheritLabel,
                ...(props.origin === "codex" && state.backend === "codex"
                  ? { description: "Uses the Helper model saved in AI Providers → Helpers." }
                  : { description: "No model chosen yet." }),
              },
              ...(savedModel && !models.some((model) => model.id === savedModel)
                ? [{ value: savedModel, label: `${savedModel} (not offered)` }]
                : []),
            ],
            onChange: (model) => {
              const next = models.find((entry) => entry.id === model);
              const nextEfforts = next?.reasoningEfforts ?? backendSummary?.launchpadOptions?.reasoningEfforts;
              const keepEffort = saved?.reasoningEffort
                && next?.supportsReasoning !== false
                && (!nextEfforts || nextEfforts.includes(saved.reasoningEffort));
              save({
                ...(saved?.backend ? { backend: saved.backend } : {}),
                model,
                ...(keepEffort ? { reasoningEffort: saved?.reasoningEffort } : {}),
              });
            },
          }}
          {...(efforts.length > 0 || saved?.reasoningEffort ? {
            effort: {
              stops: splitEffortChoices(efforts).stops,
              value: saved?.reasoningEffort ?? "",
              defaultOption: { value: "", label: `Default (${defaultEffort})` },
              disabled: state.status.kind === "needs-backend",
              onChange: (reasoningEffort: string) => {
                save({
                  ...(saved?.backend ? { backend: saved.backend } : {}),
                  ...(saved?.model ? { model: saved.model } : {}),
                  reasoningEffort,
                });
              },
            },
          } : {})}
          {...(saved ? {
            reset: {
              label: props.origin === "codex" ? "Use the Helper model" : "Clear this row",
              onSelect: () => save({}),
            },
          } : {})}
        />
        {captureRowLine(state, props.harness, props.backends)}
      </div>
    </div>
  );
}

function gateOptions(snapshot: DesktopSettingsSnapshot): SelectOption<TokenMiserGateProvider>[] {
  const decisions = resolveDecisionModelSettings(snapshot.models.decisionModels);
  return [
    { value: "none", label: "Don’t check", description: "The agent gets the digest. Free." },
    {
      value: "openai",
      label: "OpenAI Decisions",
      description: `${OPENAI_DECISIONS_MODEL}. Paid per call to your OpenAI API project.`,
      group: "Decision providers",
    },
    {
      value: "jev",
      label: "TypeSafe Jev",
      description: `${decisions.jevModel}. Billed by TypeSafe.`,
      group: "Decision providers",
    },
    {
      value: "local",
      label: "Local decision model",
      description: `${decisions.localModel} on this Mac. Free.`,
      group: "Decision providers",
    },
  ];
}

const SUMMARIZER_OPTIONS: SelectOption<TokenMiserSummarizerMode>[] = [
  { value: "off", label: "Off", description: "The agent gets the digest." },
  {
    value: "configured",
    label: "Helper model for each thread type",
    description: "Choose a model for Codex, Claude and Antigravity threads.",
  },
];

/**
 * Settings → Experimental → Token Miser (v2): command capture in Codex,
 * Claude and Antigravity threads, the decision model that scores each
 * finished capture, and the helper model that summarizes.
 */
export function TokenMiserV2Settings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  backends: readonly BackendSummary[];
  onWriteConfig: (patch: DesktopSettingsConfigPatch, onError?: (message: string) => void) => Promise<boolean>;
  onSaveHelperModels: (helperModels: DesktopHelperModelSettings) => Promise<unknown>;
  onTokenMiserDefaultEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const experimental = props.snapshot.experimental;
  const boundedCommands = experimental.tokenMiserBoundedCommands ?? DEFAULT_TOKEN_MISER_ENABLED;
  const tokenMiserEnabled = experimental.tokenMiserEnabled ?? DEFAULT_TOKEN_MISER_ENABLED;
  const defaultEnabled = experimental.tokenMiserDefaultEnabled ?? DEFAULT_TOKEN_MISER_DEFAULT_ENABLED;
  const captureSupported = props.snapshot.runtime.tokenMiser?.boundedCommandsSupported === true;
  const captureEnabled = captureSupported && boundedCommands.value;
  const helperModels = props.snapshot.models.helperModels ?? { helpers: {} };
  const { gate, summarizer, earlier } = tokenMiserModelChoices(experimental);
  const gateStatus = gate.value === "none" ? undefined : decisionProviderStatus(gate.value, props.snapshot);
  const controlsDisabled = props.saving || !captureEnabled;

  return (
    <SettingsSection
      eyebrow="Experimental"
      title="Token Miser (v2)"
      sectionId="token-miser-v2"
      description="Keep long command output out of the agent’s context. The full output stays on this Mac; the agent gets a short result and can read exact lines when it needs them."
      chip={!captureSupported ? "Unavailable" : captureEnabled ? "On" : "Off"}
      chipKind={captureEnabled ? "ok" : "default"}
    >
      <div className="settings-fields">
        <ToggleField
          checked={captureEnabled}
          disabled={props.saving || !captureSupported}
          label="Capture command output"
          switchQualifier="Token Miser (v2)"
          sub={captureSupported
            ? "For Git diffs and focused test runs in Codex, Claude and Antigravity threads. You approve each capture in the thread."
            : "Needs macOS or Linux. This machine cannot capture command output."}
          help="Off: commands print into the thread as they always have. Codex threads need a Codex build that can stop one captured terminal."
          source={sourceBadge(boundedCommands)}
          onChange={(enabled) => props.onWriteConfig({ experimental: { tokenMiserBoundedCommands: enabled } })}
        />
        <SettingsField
          label="What the agent gets"
          sub="After the command finishes, a digest of about 1.4 KB plus a handle. The agent reads exact lines with the handle for up to five minutes."
          control={
            <div className="settings-token-miser__examples">
              <div className="settings-token-miser__example">
                <p className="settings-token-miser__example-title">A test prints 1,100 progress lines and fails twice</p>
                <p>
                  The digest: the exit status, each failing test with the lines around its error, and the first and last lines,
                  with repeats collapsed. Rules on this Mac write the digest; no model writes it.
                </p>
              </div>
              <div className="settings-token-miser__example">
                <p className="settings-token-miser__example-title">A diff touches 40 files and 9,000 lines</p>
                <p>
                  With the summarizer on, the thread’s helper model writes a short summary before the agent sees the result. With
                  a decision model too, only when it scores the output as needing one.
                </p>
              </div>
              <div className="settings-token-miser__example">
                <p className="settings-token-miser__example-title">The command missed what the agent wanted</p>
                <p>
                  With a decision model, the agent gets the digest plus its scores and a note: read exact lines with the
                  handle, or run a corrected command. Nothing is summarized.
                </p>
              </div>
            </div>
          }
        />
        <SettingsField
          label="Check each result with a decision model"
          labelId="token-miser-gate-label"
          sub="Scores every finished capture once: does it need a summary, did it miss what the agent asked for, is it too noisy. The model sees the command, its exit status and line counts, up to 384 bytes of what the agent said just before, and up to 512 bytes of the output, never the full output."
          source={sourceBadge(gate)}
          control={
            <Select<TokenMiserGateProvider>
              aria-labelledby="token-miser-gate-label"
              className={PICKER_CLASS}
              disabled={controlsDisabled}
              value={gate.value}
              options={gateOptions(props.snapshot)}
              onChange={(next) => {
                if (next === gate.value && gate.source !== "default") return;
                void props.onWriteConfig({ experimental: { tokenMiserGate: next } });
              }}
            />
          }
          actions={
            // A div, not the field's help span: status lines are blocks.
            <div className="settings-field__help settings-token-miser__status">
              {earlier ? (
                <Line key="earlier">
                  Earlier you chose {EARLIER_CHOICE_LABELS[earlier]} to pick an excerpt. That no longer runs. Choose a decision
                  model here or a summarizer below to use a model again.
                </Line>
              ) : null}
              {gateStatus
                ? gateStatus.lines
                : <Line key="state">No check runs. Free, and nothing leaves this Mac.</Line>}
            </div>
          }
        />
        <SettingsField
          label="Summarize with a helper model"
          labelId="token-miser-summarizer-label"
          sub={gate.value === "none"
            ? "When on, summarizes every capture of 8 KB or more before the agent sees it, since no decision model is checking."
            : "When on, summarizes only the captures the decision model scores as needing a summary, before the agent sees them."}
          source={sourceBadge(summarizer)}
          control={
            <Select<TokenMiserSummarizerMode>
              aria-labelledby="token-miser-summarizer-label"
              className={PICKER_CLASS}
              disabled={controlsDisabled}
              value={summarizer.value}
              options={SUMMARIZER_OPTIONS}
              onChange={(next) => {
                if (next === summarizer.value && summarizer.source !== "default") return;
                void props.onWriteConfig({ experimental: { tokenMiserSummarizer: next } });
              }}
            />
          }
          actions={
            <div className="settings-field__help settings-token-miser__status">
              {summarizer.value === "configured" ? (
                <>
                  {gateStatus && !gateStatus.ready ? (
                    // The owner summarizes only what a working gate recommends.
                    <Line warn>Nothing is summarized until the decision model above is ready.</Line>
                  ) : null}
                  <Line>
                    Reads up to 2 KB of the output and writes a summary of at most 640 bytes, in its own turn on the backend you
                    choose, not in the thread. If a thread type has no model that can run, that thread type gets the digest only.
                  </Line>
                  <div className="settings-token-miser__origins">
                    {CAPTURE_ORIGINS.map((entry) => (
                      <CaptureOriginRow
                        key={entry.origin}
                        origin={entry.origin}
                        label={entry.label}
                        harness={entry.harness}
                        backends={props.backends}
                        helperModels={helperModels}
                        disabled={controlsDisabled}
                        onSave={(next) => { void props.onSaveHelperModels(next); }}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <Line>Off. No summary is written.</Line>
              )}
            </div>
          }
        />
        <ToggleField
          checked={defaultEnabled.value}
          disabled={props.saving || (!tokenMiserEnabled.value && !captureEnabled)}
          label="Use on threads by default"
          switchQualifier="Token Miser"
          sub="Threads you have not changed from the composer menu use Token Miser. A thread’s own choice always wins."
          help={tokenMiserEnabled.value ? "Also applies to Token Miser (Legacy) while it is on." : undefined}
          source={sourceBadge(defaultEnabled)}
          onChange={(enabled) => props.onTokenMiserDefaultEnabledChange(enabled)}
        />
      </div>
    </SettingsSection>
  );
}

/**
 * Where diagnostic samples land, shown whether or not capture is on: the
 * operator turned capture on to read these files, and saved files outlive
 * the switch. The folder is created by the first batch write, so opening it
 * earlier is the expected miss, not an error.
 */
function TokenMiserDiagnosticsFolder(props: {
  directory: string;
  openPath?: DesktopApi["openPath"];
}) {
  const [note, setNote] = useState<string>();
  const opening = useRef(false);
  const openPath = props.openPath;

  const open = async () => {
    if (!openPath || opening.current) return;
    opening.current = true;
    try {
      const response = await openPath({ path: props.directory });
      setNote(response.opened
        ? undefined
        : response.missing
          ? "No samples saved yet."
          : response.error ?? "The folder could not be opened.");
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : String(caught));
    } finally {
      opening.current = false;
    }
  };

  return (
    <div className="settings-folder-line">
      <span className="settings-folder-line__path">
        {formatFilesystemPath(props.directory)}
      </span>
      <span className="settings-folder-line__actions">
        <span className="settings-folder-line__note" role="status">
          {note}
        </span>
        {openPath ? (
          <button
            type="button"
            className="button button--ghost settings-folder-line__action"
            onClick={() => void open()}
          >
            Open folder
          </button>
        ) : null}
      </span>
    </div>
  );
}

export type TokenMiserLegacyState = {
  enabled: boolean;
  writeTarget: boolean | undefined;
  setWriteTarget: (target: boolean | undefined) => void;
};

/** The managed-Codex Token Miser: on, or about to be. */
export function useTokenMiserLegacyState(snapshot: DesktopSettingsSnapshot): TokenMiserLegacyState {
  const [writeTarget, setWriteTarget] = useState<boolean | undefined>();
  const enabled = (snapshot.experimental.tokenMiserEnabled ?? DEFAULT_TOKEN_MISER_ENABLED).value;
  return { enabled, writeTarget, setWriteTarget };
}

/**
 * Settings → Experimental → Soon to be removed → Token Miser (Legacy): the
 * managed Codex build that shortens tool results, and the switches only it
 * reads. Every switch keeps its key and behavior.
 */
export function TokenMiserLegacySettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  legacy: TokenMiserLegacyState;
  usage?: DesktopTokenMiserUsage;
  onTokenMiserEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserFocusedSummariesEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserDiagnosticsEnabledChange: (enabled: boolean) => Promise<void>;
  onTokenMiserPollingReviewsEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const experimental = props.snapshot.experimental;
  const tokenMiserWriteTarget = props.legacy.writeTarget;
  const tokenMiserEnabled = experimental.tokenMiserEnabled ?? DEFAULT_TOKEN_MISER_ENABLED;
  const defaultEnabled = experimental.tokenMiserDefaultEnabled ?? DEFAULT_TOKEN_MISER_DEFAULT_ENABLED;
  const focusedSummariesEnabled = experimental.tokenMiserFocusedSummariesEnabled
    ?? { value: false, source: "default" as const };
  const diagnosticsEnabled = experimental.tokenMiserDiagnosticsEnabled
    ?? { value: false, source: "default" as const };
  const diagnosticsDirectory = props.snapshot.runtime.tokenMiserDiagnosticsDirectory;
  const pollingReviewsEnabled = experimental.tokenMiserPollingReviewsEnabled
    ?? { value: false, source: "default" as const };
  const activation = props.snapshot.runtime.tokenMiser?.activation;
  const managedCodex = props.snapshot.runtime.tokenMiser?.managedCodex;
  const managedCodexProgress = useManagedRuntimeProgress(props.desktopApi, "codex");
  const switchPending = tokenMiserEnabled.value && managedCodex?.state === "pending-switch";
  // Only a contradiction is worth reporting: switched on, but the Codex side
  // never loaded. Off-and-unavailable is just off.
  const inert =
    tokenMiserEnabled.value
    && tokenMiserWriteTarget === undefined
    && !switchPending
    && (managedCodex?.state === "unavailable" || activation?.state === "unavailable");
  const starting =
    tokenMiserEnabled.value
    && !inert
    && (switchPending || activation?.state !== "active");
  const status = tokenMiserWriteTarget === true ? "Installing"
    : tokenMiserWriteTarget === false ? "Turning off"
    : inert ? "Not running"
    : switchPending ? "Waiting for idle"
    : starting ? "Starting"
    : undefined;
  const running = tokenMiserEnabled.value && !status;

  return (
    <SettingsSection
      eyebrow="Deprecated"
      title="Token Miser (Legacy)"
      sectionId="token-miser-legacy"
      description="Shortens large tool results inside PwrAgent’s managed Codex build, including in Code Mode. Codex threads only. Token Miser (v2) replaces it."
      chip={running ? defaultEnabled.value ? "Default on" : "Opt-in" : status ?? "Off"}
      chipKind={running ? "ok" : inert ? "warn" : "default"}
    >
      <div className="settings-fields">
        <ToggleField
          checked={tokenMiserWriteTarget ?? tokenMiserEnabled.value}
          disabled={props.saving || tokenMiserWriteTarget !== undefined}
          label="Reduce tool output in managed Codex"
          switchQualifier="Token Miser (Legacy)"
          sub="Download PwrAgent's verified Codex build to summarize large tool results, including in Code Mode."
          help="PwrAgent checks for updates while this setting is on and switches builds after active Codex turns finish. If a summary is unavailable, the thread receives the original output."
          source={sourceBadge(tokenMiserEnabled)}
          actions={managedCodexProgress ? (
            <ManagedRuntimeProgressStrip
              progress={managedCodexProgress}
              waitingForIdle={managedCodex?.state === "pending-switch"}
            />
          ) : status ? (
            // The chip shows it too, but only a status region is announced.
            <span role="status">{status}</span>
          ) : undefined}
          onChange={(enabled) => {
            props.legacy.setWriteTarget(enabled);
            return props.onTokenMiserEnabledChange(enabled).finally(() => {
              props.legacy.setWriteTarget(undefined);
            });
          }}
        />
        <ToggleField
          checked={focusedSummariesEnabled.value}
          disabled={props.saving || !tokenMiserEnabled.value}
          label="Focused summaries"
          switchQualifier="Token Miser (Legacy)"
          sub="Let agents ask specific questions about preserved output without reading the full source into context."
          help="Off by default. Uses the configured Token Miser model and incurs additional helper usage. Turning this off stops new focused summaries; ordinary Token Miser summaries and exact-source reads remain available."
          source={sourceBadge(focusedSummariesEnabled)}
          onChange={props.onTokenMiserFocusedSummariesEnabledChange}
        />
        <ToggleField
          checked={pollingReviewsEnabled.value}
          disabled={props.saving || !tokenMiserEnabled.value}
          label="Review hidden polling loops"
          switchQualifier="Token Miser (Legacy)"
          sub="Ask the helper model to review ambiguous repeated tool calls before suggesting a Job Monitor."
          help="Off by default. Obvious polling is still detected locally. This review sends only bounded timing, tool metadata, redacted Code Mode snippets, and recent assistant updates to the same helper-model selector Token Miser uses; it never includes full tool output. A review that finds productive work leaves the turn alone."
          source={sourceBadge(pollingReviewsEnabled)}
          onChange={props.onTokenMiserPollingReviewsEnabledChange}
        />
        <ToggleField
          checked={diagnosticsEnabled.value}
          disabled={props.saving || !tokenMiserEnabled.value}
          label="Capture diagnostic samples"
          switchQualifier="Token Miser (Legacy)"
          sub="Save local samples of tool output, summaries, retrievals, and suspected retry bursts for offline review."
          help="Off by default. Samples can include tool output and intermediate assistant commentary, which may contain sensitive data. Final answers are never saved. Files stay on this machine, at most 24 files of 8 MB. Turning this off discards samples not yet written; saved files remain until you delete them."
          source={sourceBadge(diagnosticsEnabled)}
          actions={
            diagnosticsDirectory ? (
              <TokenMiserDiagnosticsFolder
                directory={diagnosticsDirectory}
                openPath={props.desktopApi?.openPath}
              />
            ) : undefined
          }
          onChange={props.onTokenMiserDiagnosticsEnabledChange}
        />
        {inert ? (
          <SettingsField
            label="Codex could not load the gate"
            sub={managedCodex?.reason
              ?? activation?.reason
              ?? "Managed Codex activation did not complete."}
            help="Token Miser fails open, so turns keep running with tool output unchanged — nothing is gated until this clears. Toggle availability off and on to retry the verified download and activation."
            control={
              <span className="settings-field__value settings-field__value--warn">
                Enabled, not running
              </span>
            }
          />
        ) : null}
        {props.usage && props.usage.interceptionCount > 0 ? (
          <SettingsField
            label="Estimated parent-context savings"
            sub={`${props.usage.interceptionCount.toLocaleString()} intercepted results · ${props.usage.baselineParentTokens.toLocaleString()} baseline tokens − ${props.usage.replacementTokens.toLocaleString()} summary tokens − ${props.usage.retrievedTokens.toLocaleString()} retrieved tokens.`}
            help="This estimate measures tokens kept out of the parent thread after Codex's model-visible output cap. It is separate from the helper model's own token cost. Repeated retrievals count each time, so reading everything can make the savings negative."
            control={
              <span className="settings-field__value">
                {props.usage.estimatedParentTokensSaved >= 0 ? "Saved " : "Added "}
                {Math.abs(props.usage.estimatedParentTokensSaved).toLocaleString()} tokens
              </span>
            }
          />
        ) : null}
      </div>
    </SettingsSection>
  );
}
