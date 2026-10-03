import type { BackendModelOption } from "./contracts/backend";

/**
 * Model turns PwrAgent starts on the operator's behalf. Each one resolves its
 * model through `resolveHelperModel`, never through a constant at the call
 * site, so the Helper model row on Settings → AI Providers can name what
 * will run.
 *
 * Ids are persisted in the profile `config.toml`; never rename one.
 */
export const HELPER_MODEL_IDS = [
  "thread_titles",
  "task_monitors",
  "token_miser_evaluation",
  "token_miser_focused_summaries",
  "token_miser_polling_reviews",
  "diff_condensation",
  "automation_prompts",
  "star_map_intake",
  "usage_analysis",
  "mcp_auto_review",
  "federation_instance_names",
] as const;

export type HelperModelId = (typeof HELPER_MODEL_IDS)[number];

export type HelperModelDefinition = {
  id: HelperModelId;
  label: string;
  /** Effort used when neither a setting nor the request names one. */
  defaultReasoningEffort: string;
  /** Backends whose models the helper may run. The first is the default. */
  backends: readonly string[];
};

export const HELPER_MODEL_DEFINITIONS: readonly HelperModelDefinition[] = [
  {
    id: "thread_titles",
    label: "Thread titles",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
  {
    id: "task_monitors",
    label: "Task monitors",
    defaultReasoningEffort: "medium",
    backends: ["codex"],
  },
  {
    id: "token_miser_evaluation",
    label: "Output evaluation",
    defaultReasoningEffort: "medium",
    backends: ["codex"],
  },
  {
    id: "token_miser_focused_summaries",
    label: "Focused summaries",
    defaultReasoningEffort: "medium",
    backends: ["codex"],
  },
  {
    id: "token_miser_polling_reviews",
    label: "Polling reviews",
    defaultReasoningEffort: "medium",
    backends: ["codex"],
  },
  {
    id: "diff_condensation",
    label: "Diff condensation",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
  {
    id: "automation_prompts",
    label: "Automation prompts",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
  {
    id: "star_map_intake",
    label: "Star Map intake",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
  {
    id: "usage_analysis",
    label: "Usage analysis",
    defaultReasoningEffort: "low",
    backends: ["codex", "acp:grok"],
  },
  {
    id: "mcp_auto_review",
    label: "MCP Auto review",
    defaultReasoningEffort: "low",
    backends: ["codex", "acp:grok"],
  },
  {
    id: "federation_instance_names",
    label: "Instance names",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
];

/**
 * What Automatic resolves to, in order, when the connected backend offers it.
 * The only place helper model ids are written down. When Codex offers none of
 * them, Automatic takes its first `mini` model before the current model, so a
 * helper does not fall back to the operator's heaviest model.
 */
export const HELPER_MODEL_AUTOMATIC_ORDER: readonly string[] = [
  "gpt-6-luna",
  "gpt-5.6-luna",
];

export const HELPER_MODEL_DEFAULT_BACKEND = "codex";

export type DesktopHelperModelChoice = {
  /** Backend the model belongs to. Absent means the helper's first backend. */
  backend?: string;
  model?: string;
  reasoningEffort?: string;
};

export type DesktopHelperModelSettings = {
  /** Codex model every helper runs unless its own row names one. Absent = Automatic. */
  defaultModel?: string;
  /**
   * Effort every Codex helper runs unless its own row names one. Absent =
   * each helper's built-in effort.
   */
  defaultReasoningEffort?: string;
  /**
   * Per-helper choices keyed by helper id. Only a hand edit of `config.toml`
   * creates one; Settings lists them and can clear them. Ids this build does
   * not know are kept, so saving from an older build does not drop a newer
   * build's rows.
   */
  helpers: Record<string, DesktopHelperModelChoice>;
};

export type HelperModelSource =
  | "requested"
  | "helper"
  | "helper_default"
  | "automatic"
  | "backend_current";

export type HelperModelResolution = {
  /** Absent only when nothing is configured and the catalog is empty. */
  model?: string;
  reasoningEffort?: string;
  source: HelperModelSource;
  /** False when no catalog was available to check the model against. */
  verified: boolean;
  /** The helper's saved model, when the catalog does not offer it. */
  unavailableHelperModel?: string;
  /** The saved Helper model, when the catalog does not offer it. */
  unavailableDefaultModel?: string;
};

export type HelperModelCatalogEntry = Pick<
  BackendModelOption,
  "id" | "current" | "defaultReasoningEffort" | "reasoningEfforts" | "supportsReasoning"
>;

export function isHelperModelId(value: string): value is HelperModelId {
  return (HELPER_MODEL_IDS as readonly string[]).includes(value);
}

export function getHelperModelDefinition(id: HelperModelId): HelperModelDefinition {
  const definition = HELPER_MODEL_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) {
    throw new Error(`Unknown helper model id: ${id}`);
  }
  return definition;
}

export function helperChoiceBackend(
  helper: HelperModelId,
  choice: DesktopHelperModelChoice | undefined,
): string {
  const backends = getHelperModelDefinition(helper).backends;
  const backend = choice?.backend?.trim();
  return backend && backends.includes(backend) ? backend : backends[0];
}

/**
 * The one rule every helper call site uses to pick its model:
 * request → helper row → Helper model → Automatic → the backend's current
 * model, then its first. A rung whose model the catalog does not offer is skipped, so a saved
 * choice never fails the helper; the resolution reports what was skipped.
 *
 * The Helper model, its effort, and Automatic name Codex models, so they
 * apply only when `backend` is Codex. An empty catalog that was never read returns the first
 * configured rung unverified rather than guessing it away; one that was read
 * and offered nothing returns no model, so no helper invents one.
 */
export function resolveHelperModel(params: {
  helper: HelperModelId;
  settings?: DesktopHelperModelSettings;
  models: readonly HelperModelCatalogEntry[];
  backend?: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  /** `models` is a completed read, even when it is empty. */
  catalogRead?: boolean;
}): HelperModelResolution {
  const definition = getHelperModelDefinition(params.helper);
  const choice = params.settings?.helpers[params.helper];
  const backend = params.backend ?? helperChoiceBackend(params.helper, choice);
  const choiceModel =
    helperChoiceBackend(params.helper, choice) === backend
      ? trimmed(choice?.model)
      : undefined;
  const isCodex = backend === HELPER_MODEL_DEFAULT_BACKEND;
  const defaultModel = isCodex ? trimmed(params.settings?.defaultModel) : undefined;
  const defaultEffort = isCodex
    ? trimmed(params.settings?.defaultReasoningEffort)
    : undefined;
  const candidates: { model: string; source: HelperModelSource }[] = [];
  const requestedModel = trimmed(params.requestedModel);
  if (requestedModel) candidates.push({ model: requestedModel, source: "requested" });
  if (choiceModel) candidates.push({ model: choiceModel, source: "helper" });
  if (defaultModel) candidates.push({ model: defaultModel, source: "helper_default" });
  if (isCodex) {
    for (const model of HELPER_MODEL_AUTOMATIC_ORDER) {
      candidates.push({ model, source: "automatic" });
    }
  }

  const efforts = [
    trimmed(params.requestedReasoningEffort),
    trimmed(choice?.reasoningEffort),
    defaultEffort,
    definition.defaultReasoningEffort,
  ];

  if (params.models.length === 0) {
    if (params.catalogRead) {
      return { source: "backend_current", verified: true };
    }
    const first = candidates[0];
    return {
      ...(first ? { model: first.model } : {}),
      ...(first ? { reasoningEffort: firstDefined(efforts) } : {}),
      source: first?.source ?? "backend_current",
      verified: false,
    };
  }

  const offered = (model: string) =>
    params.models.find((entry) => entry.id === model);
  const unavailable = {
    ...(choiceModel && !offered(choiceModel)
      ? { unavailableHelperModel: choiceModel }
      : {}),
    ...(defaultModel && !offered(defaultModel)
      ? { unavailableDefaultModel: defaultModel }
      : {}),
  };
  for (const candidate of candidates) {
    const entry = offered(candidate.model);
    if (entry) {
      return {
        model: entry.id,
        reasoningEffort: resolveHelperReasoningEffort(entry, efforts),
        source: candidate.source,
        verified: true,
        ...unavailable,
      };
    }
  }
  const lightweight = isCodex
    ? params.models.find((entry) => /mini/i.test(entry.id))
    : undefined;
  if (lightweight) {
    return {
      model: lightweight.id,
      reasoningEffort: resolveHelperReasoningEffort(lightweight, efforts),
      source: "automatic",
      verified: true,
      ...unavailable,
    };
  }
  const fallback =
    params.models.find((entry) => entry.current) ?? params.models[0];
  return {
    model: fallback.id,
    reasoningEffort: resolveHelperReasoningEffort(fallback, efforts),
    source: "backend_current",
    verified: true,
    ...unavailable,
  };
}

function resolveHelperReasoningEffort(
  model: HelperModelCatalogEntry,
  preferred: readonly (string | undefined)[],
): string | undefined {
  const efforts = model.reasoningEfforts;
  if (model.supportsReasoning === false || efforts?.length === 0) {
    return undefined;
  }
  if (efforts === undefined) {
    return firstDefined(preferred);
  }
  return (
    preferred.find(
      (effort): effort is string => effort !== undefined && efforts.includes(effort),
    )
    ?? (model.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : efforts[0])
  );
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function firstDefined(values: readonly (string | undefined)[]): string | undefined {
  return values.find((value): value is string => value !== undefined);
}
