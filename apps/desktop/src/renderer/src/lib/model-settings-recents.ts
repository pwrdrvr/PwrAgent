import { codexSpeedOptions, selectedCodexSpeed, type CodexSpeed } from "@pwragent/shared/codex-speed";
import type { ModelSettingsRecent } from "@pwragent/shared/contracts/agent";
import type { BackendModelOption, BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationLaunchpadDraft } from "@pwragent/shared/contracts/navigation";

/** How many Recent rows a new-thread panel offers. */
export const NEW_THREAD_RECENTS_LIMIT = 6;

/**
 * The combination a new thread started with, as the "composer" recents
 * scope stores it. Speed belongs to Codex alone, and only a tier that is on
 * is worth replaying.
 */
export function newThreadModelSettingsRecent(
  launchpad: Pick<NavigationLaunchpadDraft, "backend" | "model" | "reasoningEffort" | "fastMode" | "serviceTier">,
): ModelSettingsRecent {
  const codex = launchpad.backend === "codex";
  return {
    backend: launchpad.backend,
    ...(launchpad.model ? { model: launchpad.model } : {}),
    ...(launchpad.reasoningEffort ? { reasoningEffort: launchpad.reasoningEffort } : {}),
    ...(codex && launchpad.serviceTier ? { serviceTier: launchpad.serviceTier } : {}),
    ...(codex && launchpad.fastMode ? { fastMode: true } : {}),
  };
}

function recentKey(recent: ModelSettingsRecent): string {
  return JSON.stringify([
    recent.backend,
    recent.model ?? "",
    recent.reasoningEffort ?? "",
    recent.serviceTier ?? "",
    recent.fastMode ?? false,
  ]);
}

/** One Recent row, resolved against the catalog that would run it. */
export type NewThreadRecent = {
  recent: ModelSettingsRecent;
  backend: BackendSummary;
  model: BackendModelOption | undefined;
  /** The speed the row runs at; Standard when the model offers no tier. */
  speed: CodexSpeed;
};

/**
 * A recent that this catalog can still start: its provider can start
 * threads, its model is listed, and its effort is one the model offers.
 */
function resolve(recent: ModelSettingsRecent, backends: readonly BackendSummary[]): NewThreadRecent | undefined {
  const backend = backends.find((entry) => entry.kind === recent.backend && entry.available && entry.capabilities.createThread);
  if (!backend) return undefined;
  const models = backend.launchpadOptions?.models ?? [];
  const model = recent.model ? models.find((entry) => entry.id === recent.model) : undefined;
  if (recent.model && !model) return undefined;
  if (recent.reasoningEffort) {
    if (model?.supportsReasoning === false) return undefined;
    const efforts = model?.reasoningEfforts ?? backend.launchpadOptions?.reasoningEfforts ?? [];
    if (efforts.length > 0 && !efforts.includes(recent.reasoningEffort)) return undefined;
  }
  // A tier the model no longer offers would not run, so the row does not
  // claim it.
  const wanted = backend.kind === "codex" ? selectedCodexSpeed(recent) : "standard";
  const offered = backend.kind === "codex"
    ? codexSpeedOptions(model, backend.codexFastAllowed !== false, backend.launchpadOptions?.supportsFastMode ?? false)
    : ["standard"];
  return { recent, backend, model, speed: offered.includes(wanted) ? wanted : "standard" };
}

/**
 * The Recent rows of a new-thread panel: the settings new threads started
 * with, then a to-do card's custom starts, newest first within each, without
 * repeats, keeping only those this catalog can still start.
 */
export function newThreadRecents(params: {
  composer: readonly ModelSettingsRecent[];
  todoDispatch: readonly ModelSettingsRecent[];
  backends: readonly BackendSummary[];
  limit?: number;
}): NewThreadRecent[] {
  const limit = params.limit ?? NEW_THREAD_RECENTS_LIMIT;
  const seen = new Set<string>();
  const rows: NewThreadRecent[] = [];
  for (const recent of [...params.composer, ...params.todoDispatch]) {
    if (rows.length >= limit) break;
    const key = recentKey(recent);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = resolve(recent, params.backends);
    if (row) rows.push(row);
  }
  return rows;
}
