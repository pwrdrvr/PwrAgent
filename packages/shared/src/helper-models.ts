import type { BackendModelOption } from "./contracts/backend";

/**
 * Model turns PwrAgent starts on the operator's behalf. Each one resolves its
 * model through `resolveHelperModel`, never through a constant at the call
 * site, so Settings → AI Providers → Default Models can name what will run.
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
  "federation_instance_names",
] as const;

export type HelperModelId = (typeof HELPER_MODEL_IDS)[number];

export type HelperModelGroup =
  | "threads"
  | "token_miser"
  | "tools"
  | "federation";

export type HelperModelDefinition = {
  id: HelperModelId;
  group: HelperModelGroup;
  label: string;
  description: string;
  /** Effort used when neither the row nor the request names one. */
  defaultReasoningEffort: string;
  /** Backends whose models the row may choose. The first is the default. */
  backends: readonly string[];
};

export const HELPER_MODEL_GROUPS: readonly {
  id: HelperModelGroup;
  eyebrow: string;
  title: string;
  description?: string;
}[] = [
  { id: "threads", eyebrow: "Threads", title: "Thread helpers" },
  {
    id: "token_miser",
    eyebrow: "Token Miser",
    title: "Tool output",
    description: "Runs on Codex. Turn these on or off in Experimental.",
  },
  { id: "tools", eyebrow: "Tools", title: "Tool helpers" },
  { id: "federation", eyebrow: "Federation", title: "Gateway helpers" },
];

export const HELPER_MODEL_DEFINITIONS: readonly HelperModelDefinition[] = [
  {
    id: "thread_titles",
    group: "threads",
    label: "Thread titles",
    description: "Names a thread after its first turn.",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
  {
    id: "task_monitors",
    group: "threads",
    label: "Task monitors",
    description: "Watches a long-running job the agent hands off.",
    defaultReasoningEffort: "medium",
    backends: ["codex"],
  },
  {
    id: "token_miser_evaluation",
    group: "token_miser",
    label: "Output evaluation",
    description: "Decides whether a large tool result is condensed.",
    defaultReasoningEffort: "medium",
    backends: ["codex"],
  },
  {
    id: "token_miser_focused_summaries",
    group: "token_miser",
    label: "Focused summaries",
    description: "Writes the summary the agent reads in place of the full output.",
    defaultReasoningEffort: "medium",
    backends: ["codex"],
  },
  {
    id: "token_miser_polling_reviews",
    group: "token_miser",
    label: "Polling reviews",
    description: "Suggests a monitor job when the agent keeps polling.",
    defaultReasoningEffort: "medium",
    backends: ["codex"],
  },
  {
    id: "diff_condensation",
    group: "tools",
    label: "Diff condensation",
    description: "Groups a large diff into focused changes.",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
  {
    id: "automation_prompts",
    group: "tools",
    label: "Automation prompts",
    description: "Drafts the prompt from your description of an automation.",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
  {
    id: "star_map_intake",
    group: "tools",
    label: "Star Map intake",
    description: "Picks a directory and starts the [+] intake agent.",
    defaultReasoningEffort: "low",
    backends: ["codex"],
  },
  {
    id: "usage_analysis",
    group: "tools",
    label: "Usage analysis",
    description: "Default for Analyze in Usage Activity. Each run can still pick.",
    defaultReasoningEffort: "low",
    backends: ["codex", "acp:grok"],
  },
  {
    id: "federation_instance_names",
    group: "federation",
    label: "Instance names",
    description: "Gives each gateway machine a short name.",
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
  /** Codex model every helper left on Helper default uses. Absent = Automatic. */
  defaultModel?: string;
  /**
   * Per-helper choices keyed by helper id. Ids this build does not know are
   * kept, so saving from an older build does not drop a newer build's rows.
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
  /** The saved Helper default, when the catalog does not offer it. */
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
 * request → helper row → Helper default → Automatic → the backend's current
 * model, then its first. A rung whose model the catalog does not offer is skipped, so a saved
 * choice never fails the helper; the resolution reports what was skipped.
 *
 * Helper default and Automatic name Codex models, so they apply only when
 * `backend` is Codex. An empty catalog that was never read returns the first
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
