import type { BackendModelOption, BackendSummary } from "@pwragent/shared/contracts/backend";
import type {
  BoundedCommandHelperMode,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
  TokenMiserGateProvider,
  TokenMiserSummarizerMode,
} from "@pwragent/shared/contracts/settings";
import {
  CAPTURE_HELPER_IDS,
  getHelperModelDefinition,
  resolveHelperModel,
  type DesktopHelperModelChoice,
  type DesktopHelperModelSettings,
} from "@pwragent/shared/helper-models";

export type CaptureOrigin = keyof typeof CAPTURE_HELPER_IDS;
export type CaptureHelperId = (typeof CAPTURE_HELPER_IDS)[CaptureOrigin];

export const CAPTURE_ORIGINS: readonly { origin: CaptureOrigin; label: string; harness: string }[] = [
  { origin: "codex", label: "Codex threads", harness: "Codex" },
  { origin: "claude", label: "Claude threads", harness: "Claude" },
  { origin: "acp:antigravity", label: "Antigravity threads", harness: "Antigravity" },
];

/**
 * Backends that can run an isolated summarizing turn. Antigravity is a
 * capture origin only; it never runs the summarizer.
 */
export const CAPTURE_RUNNERS = ["codex", "claude", "acp:grok"] as const;
export type CaptureRunner = (typeof CAPTURE_RUNNERS)[number];

const RUNNER_FALLBACK_LABELS: Record<CaptureRunner, string> = {
  codex: "Codex",
  claude: "Claude",
  "acp:grok": "Grok",
};

export function isCaptureRunner(value: string | undefined): value is CaptureRunner {
  return (CAPTURE_RUNNERS as readonly string[]).includes(value ?? "");
}

export function captureRunnerLabel(
  backend: string,
  backends: readonly BackendSummary[],
): string {
  const summary = backends.find((candidate) => candidate.kind === backend);
  return summary?.label
    ?? (isCaptureRunner(backend) ? RUNNER_FALLBACK_LABELS[backend] : backend);
}

export type TokenMiserModelChoices = {
  gate: DesktopSettingsValue<TokenMiserGateProvider>;
  summarizer: DesktopSettingsValue<TokenMiserSummarizerMode>;
  /**
   * An excerpt-picker choice saved by an earlier build. It no longer runs and
   * is reported only until the operator chooses a gate or a summarizer.
   */
  earlier?: Exclude<BoundedCommandHelperMode, "deterministic">;
};

/**
 * The gate and summarizer Settings shows. Each comes only from its own key,
 * defaulting to none and off; the earlier `token_miser_bounded_helper` choice
 * never selects either, whatever it names.
 */
export function tokenMiserModelChoices(
  experimental: Pick<
    DesktopSettingsSnapshot["experimental"],
    "tokenMiserBoundedHelper" | "tokenMiserGate" | "tokenMiserSummarizer"
  >,
): TokenMiserModelChoices {
  const gate = experimental.tokenMiserGate ?? { value: "none", source: "default" };
  const summarizer = experimental.tokenMiserSummarizer ?? { value: "off", source: "default" };
  const legacy = experimental.tokenMiserBoundedHelper;
  const chosen = gate.source !== "default" || summarizer.source !== "default";
  const earlier = !chosen && legacy && legacy.source !== "default" && legacy.value !== "deterministic"
    ? legacy.value
    : undefined;
  return { gate, summarizer, ...(earlier ? { earlier } : {}) };
}

export type CaptureRowStatus =
  | { kind: "ready" }
  /** The row names a backend other than Codex but no model on it. */
  | { kind: "needs-model" }
  /** The saved backend is not one that can run the summarizer. */
  | { kind: "unsupported-backend" }
  | { kind: "backend-loading" }
  | { kind: "backend-unavailable" }
  /** The backend's catalog was read and does not list the model. */
  | { kind: "model-not-offered" };

export type CaptureRowState = {
  origin: CaptureOrigin;
  helper: CaptureHelperId;
  /** The saved row, as config.toml holds it. */
  saved?: DesktopHelperModelChoice;
  /** The backend the summary runs on. */
  backend: string;
  /** The model the owner requests, when one resolves. */
  model?: string;
  /** The model that answers, from the backend's catalog when it is read. */
  displayModel?: string;
  /** Where `model` comes from. */
  modelSource?: "row" | "helper-default";
  /** The effort that will run with `model`. */
  effort?: string;
  /** The owner requires exactly `model`; otherwise Codex may fall back. */
  exact: boolean;
  /** The backend's catalog, when it has been read. */
  models: readonly BackendModelOption[];
  status: CaptureRowStatus;
};

function catalogFor(summary: BackendSummary | undefined): readonly BackendModelOption[] {
  return summary?.available ? summary.launchpadOptions?.models ?? [] : [];
}

function finishState(
  base: Omit<CaptureRowState, "status">,
  summary: BackendSummary | undefined,
): CaptureRowState {
  if (summary?.discoveryPending) return { ...base, status: { kind: "backend-loading" } };
  if (!summary?.available) return { ...base, status: { kind: "backend-unavailable" } };
  const offered = (id?: string) => !!id && base.models.some((entry) => entry.id === id);
  if (base.models.length > 0 && !offered(base.exact ? base.model : base.displayModel)) {
    return { ...base, status: { kind: "model-not-offered" } };
  }
  return { ...base, status: { kind: "ready" } };
}

/**
 * The Helper model on Codex, as the owner's `helperDefaultTarget` requests
 * it. Automatic asks for its first choice and lets Codex fall back through
 * the catalog, so `displayModel` is what the catalog resolves to.
 */
function helperDefaultState(
  origin: CaptureOrigin,
  settings: DesktopHelperModelSettings,
  backends: readonly BackendSummary[],
  saved: DesktopHelperModelChoice | undefined,
): CaptureRowState {
  const helper = CAPTURE_HELPER_IDS[origin];
  const summary = backends.find((candidate) => candidate.kind === "codex");
  const models = catalogFor(summary);
  const requested = resolveHelperModel({ helper, settings, backend: "codex", models: [] });
  const exact = Boolean(settings.defaultModel?.trim());
  const answered = exact || models.length === 0
    ? requested.model
    : resolveHelperModel({ helper, settings, backend: "codex", models }).model;
  return finishState({
    origin,
    helper,
    ...(saved ? { saved } : {}),
    backend: "codex",
    ...(requested.model ? { model: requested.model } : {}),
    ...(answered ? { displayModel: answered } : {}),
    modelSource: "helper-default",
    ...(requested.reasoningEffort ? { effort: requested.reasoningEffort } : {}),
    exact,
    models,
  }, summary);
}

/**
 * What one thread type's summarizer runs. Mirrors the owner's
 * `captureTarget` in `bounded-command-helper.ts`: in `helper` mode every
 * thread type uses the Helper model and rows are ignored; in `configured`
 * mode a row with a model runs that model on its backend, and a row without
 * one uses the Helper model, unless it names a backend other than Codex.
 */
export function captureRowState(
  origin: CaptureOrigin,
  settings: DesktopHelperModelSettings,
  backends: readonly BackendSummary[],
  mode: Exclude<TokenMiserSummarizerMode, "off"> = "configured",
): CaptureRowState {
  const helper = CAPTURE_HELPER_IDS[origin];
  if (mode === "helper") return helperDefaultState(origin, { ...settings, helpers: {} }, backends, undefined);
  const saved = settings.helpers[helper];
  const rowModel = saved?.model?.trim() || undefined;
  if (!rowModel && (!saved?.backend || saved.backend === "codex")) {
    return helperDefaultState(origin, settings, backends, saved);
  }
  const backend = saved?.backend ?? getHelperModelDefinition(helper).backends[0]!;
  const summary = backends.find((candidate) => candidate.kind === backend);
  const models = catalogFor(summary);
  const base = { origin, helper, ...(saved ? { saved } : {}), backend, exact: true, models };
  if (!isCaptureRunner(backend)) return { ...base, status: { kind: "unsupported-backend" } };
  if (!rowModel) return { ...base, status: { kind: "needs-model" } };
  const effort = resolveHelperModel({
    helper,
    settings,
    backend,
    models: [],
    requestedModel: rowModel,
  }).reasoningEffort;
  return finishState({
    ...base,
    model: rowModel,
    displayModel: rowModel,
    modelSource: "row",
    ...(effort ? { effort } : {}),
  }, summary);
}

/**
 * The whole helper-model settings with one capture row replaced, or removed
 * when `next` is empty. Every other row, the Helper model and its effort are
 * kept as saved, including rows this build does not know.
 */
export function withCaptureRow(
  settings: DesktopHelperModelSettings,
  helper: CaptureHelperId,
  next: DesktopHelperModelChoice | undefined,
): DesktopHelperModelSettings {
  const helpers = { ...settings.helpers };
  const backend = next?.backend?.trim();
  const model = next?.model?.trim();
  const reasoningEffort = next?.reasoningEffort?.trim();
  if (backend || model || reasoningEffort) {
    helpers[helper] = {
      ...(backend ? { backend } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  } else {
    delete helpers[helper];
  }
  return { ...settings, helpers };
}
