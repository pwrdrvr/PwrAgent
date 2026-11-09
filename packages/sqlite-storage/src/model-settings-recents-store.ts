import type {
  ModelSettingsRecent,
  ModelSettingsRecentsScope,
} from "@pwragent/shared";
import type { StateDb } from "./state-db.js";

/**
 * Tiny persisted list of provider/model/reasoning combinations the operator
 * picked explicitly, so a picker can offer "run that again" instead of making
 * them set three chips. Lives as a JSON object of scope -> entries under a
 * single `meta` key — the meta table is a generic key/value store, so no
 * schema migration is needed. Most-recent-first, deduped by the whole
 * combination, capped per scope.
 *
 * Scoped rather than review-specific because the composer's own model-settings
 * row is the intended second consumer, and one store keeps both honest about
 * the shape they persist.
 */
const MODEL_SETTINGS_RECENTS_META_KEY = "modelSettingsRecents";
const MODEL_SETTINGS_RECENTS_CAP = 10;

function readEntry(value: unknown): ModelSettingsRecent | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.backend !== "string" || candidate.backend.length === 0) {
    return undefined;
  }
  return {
    backend: candidate.backend as ModelSettingsRecent["backend"],
    ...(typeof candidate.model === "string" && candidate.model.length > 0
      ? { model: candidate.model }
      : {}),
    ...(typeof candidate.reasoningEffort === "string"
      && candidate.reasoningEffort.length > 0
      ? { reasoningEffort: candidate.reasoningEffort }
      : {}),
    ...(typeof candidate.serviceTier === "string"
      && candidate.serviceTier.length > 0
      ? { serviceTier: candidate.serviceTier }
      : {}),
    ...(typeof candidate.fastMode === "boolean"
      ? { fastMode: candidate.fastMode }
      : {}),
  };
}

function readAllScopes(
  stateDb: StateDb,
): Partial<Record<ModelSettingsRecentsScope, ModelSettingsRecent[]>> {
  const raw = stateDb.getMeta(MODEL_SETTINGS_RECENTS_META_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const scopes: Partial<
      Record<ModelSettingsRecentsScope, ModelSettingsRecent[]>
    > = {};
    for (const [scope, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const entries = value
        .map((entry) => readEntry(entry))
        .filter((entry): entry is ModelSettingsRecent => entry !== undefined);
      scopes[scope as ModelSettingsRecentsScope] = entries;
    }
    return scopes;
  } catch {
    // A corrupt value self-heals on the next record.
    return {};
  }
}

/** Stable identity of a combination, so re-picking one bumps it to the front. */
function recentKey(recent: ModelSettingsRecent): string {
  return JSON.stringify([
    recent.backend,
    recent.model ?? "",
    recent.reasoningEffort ?? "",
    recent.serviceTier ?? "",
    recent.fastMode ?? false,
  ]);
}

export function listModelSettingsRecents(
  stateDb: StateDb,
  scope: ModelSettingsRecentsScope,
): ModelSettingsRecent[] {
  return readAllScopes(stateDb)[scope] ?? [];
}

export function recordModelSettingsRecent(
  stateDb: StateDb,
  scope: ModelSettingsRecentsScope,
  recent: ModelSettingsRecent,
): void {
  const incoming = readEntry(recent);
  if (!incoming) {
    return;
  }
  const scopes = readAllScopes(stateDb);
  const merged: ModelSettingsRecent[] = [];
  const seen = new Set<string>();
  for (const entry of [incoming, ...(scopes[scope] ?? [])]) {
    const key = recentKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
    if (merged.length >= MODEL_SETTINGS_RECENTS_CAP) {
      break;
    }
  }
  scopes[scope] = merged;
  stateDb.setMeta(MODEL_SETTINGS_RECENTS_META_KEY, JSON.stringify(scopes));
}
