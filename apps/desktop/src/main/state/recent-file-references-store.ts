import type { StateDb } from "./state-db.js";

/**
 * Tiny persisted list of recently referenced file paths, backing the
 * composer reference picker's Files tab. Lives as a JSON array under a
 * single `meta` key — the meta table is a generic key/value store, so no
 * schema migration is needed. Most-recent-first, deduped by path, capped.
 */
const RECENT_FILE_REFERENCES_META_KEY = "recentFileReferences";
const RECENT_FILE_REFERENCES_CAP = 20;

export function listRecentFileReferencePaths(stateDb: StateDb): string[] {
  const raw = stateDb.getMeta(RECENT_FILE_REFERENCES_META_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
  } catch {
    // A corrupt value self-heals on the next record.
    return [];
  }
}

export function recordRecentFileReferencePaths(
  stateDb: StateDb,
  paths: string[],
): void {
  const incoming = paths.filter(
    (entry) => typeof entry === "string" && entry.length > 0,
  );
  if (incoming.length === 0) {
    return;
  }
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...incoming, ...listRecentFileReferencePaths(stateDb)]) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    merged.push(entry);
    if (merged.length >= RECENT_FILE_REFERENCES_CAP) {
      break;
    }
  }
  stateDb.setMeta(RECENT_FILE_REFERENCES_META_KEY, JSON.stringify(merged));
}
