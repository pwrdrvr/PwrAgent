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
  /** No model on the row, and nothing it may inherit. */
  | { kind: "needs-model" }
  /** Antigravity rows must name the backend that runs the summarizer. */
  | { kind: "needs-backend" }
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
  /** The backend the row runs on: the saved one, else the helper's first. */
  backend: string;
  /** The model that will run, when one resolves. */
  model?: string;
  /** Where `model` comes from. */
  modelSource?: "row" | "helper-default";
  /** The effort that will run with `model`. */
  effort?: string;
  /** The backend's catalog, when it has been read. */
  models: readonly BackendModelOption[];
  status: CaptureRowStatus;
};

/**
 * What one capture origin's row will run. Mirrors the owner's routing in
 * `bounded-command-helper.ts`: only Codex threads inherit the saved Helper
 * model (Automatic does not count), Claude and Antigravity need a model on
 * their own row, and an Antigravity row must name its backend.
 */
export function captureRowState(
  origin: CaptureOrigin,
  settings: DesktopHelperModelSettings,
  backends: readonly BackendSummary[],
): CaptureRowState {
  const helper = CAPTURE_HELPER_IDS[origin];
  const saved = settings.helpers[helper];
  const definition = getHelperModelDefinition(helper);
  const backend = saved?.backend ?? definition.backends[0]!;
  const summary = backends.find((candidate) => candidate.kind === backend);
  const models = summary?.available ? summary.launchpadOptions?.models ?? [] : [];
  const base = { origin, helper, ...(saved ? { saved } : {}), backend, models };

  if (!isCaptureRunner(backend)) return { ...base, status: { kind: "unsupported-backend" } };
  if (origin === "acp:antigravity" && !saved?.backend) {
    return { ...base, status: { kind: "needs-backend" } };
  }
  const rowModel = saved?.model?.trim() || undefined;
  const inherited = !rowModel && origin === "codex" && backend === "codex"
    ? settings.defaultModel?.trim() || undefined
    : undefined;
  const model = rowModel ?? inherited;
  if (!model) return { ...base, status: { kind: "needs-model" } };
  const effort = resolveHelperModel({
    helper,
    settings,
    backend,
    models: [],
    requestedModel: model,
  }).reasoningEffort;
  const resolved = {
    ...base,
    model,
    modelSource: rowModel ? "row" as const : "helper-default" as const,
    ...(effort ? { effort } : {}),
  };
  if (summary?.discoveryPending) return { ...resolved, status: { kind: "backend-loading" } };
  if (!summary?.available) return { ...resolved, status: { kind: "backend-unavailable" } };
  if (models.length > 0 && !models.some((entry) => entry.id === model)) {
    return { ...resolved, status: { kind: "model-not-offered" } };
  }
  return { ...resolved, status: { kind: "ready" } };
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
