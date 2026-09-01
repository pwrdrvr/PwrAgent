import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
} from "@pwragent/shared";

/**
 * Transcript rows PwrAgent mints itself, as opposed to rows a provider issued.
 *
 * A read path merges overlay-owned rows into the provider's replay: persisted
 * usage lines, managed review entries, and the Codex environment setup
 * activity. Their ids exist only inside PwrAgent. No provider can resolve one,
 * which is why `thread-replay-pagination` refuses to mint a pagination cursor
 * from any of them.
 *
 * Classifying a provider row as overlay-owned is safe: the cursor moves one
 * entry forward and the older page overlaps by that row, which
 * `prependTranscriptHistoryPage` already dedupes. Classifying an overlay row
 * as provider-owned is not, so keep this list wide rather than tight.
 */
const OVERLAY_OWNED_ENTRY_ID_PREFIXES = [
  // Renderer-minted turn totals persisted through `persistThreadUsageActivity`.
  "live-turn-usage-",
  // Per-request usage synthesized while normalizing a Codex rollout item.
  "live-token-usage-",
  // Managed review rows, which live in a hidden child session's overlay.
  "managed-review:",
  // Setup activity rebuilt from the overlay's Codex environment runtime.
  "codex-environment-setup-",
] as const;

export function isUsageActivityEntry(
  entry: AppServerThreadEntry,
): entry is AppServerThreadActivityEntry {
  return (
    entry.type === "activity" &&
    (entry.id.startsWith("live-token-usage-") ||
      entry.id.startsWith("live-turn-usage-") ||
      entry.summary.startsWith("Latest request usage:") ||
      entry.summary.startsWith("Turn usage:") ||
      entry.summary.startsWith("Monitor usage:") ||
      entry.summary.startsWith("Usage:"))
  );
}

export function usageActivityScope(
  entry: AppServerThreadActivityEntry,
): "latest-request" | "monitor" | "total" | "turn" | undefined {
  if (entry.id.startsWith("live-turn-usage-") || entry.summary.startsWith("Turn usage:")) {
    return "turn";
  }
  if (entry.summary.startsWith("Monitor usage:")) {
    return "monitor";
  }
  if (entry.summary.startsWith("Latest request usage:")) {
    return "latest-request";
  }
  if (entry.summary.startsWith("Usage:")) {
    return "total";
  }
  if (entry.id.startsWith("live-token-usage-")) {
    return "latest-request";
  }
  return undefined;
}

/**
 * True when no provider has ever seen this entry's id.
 *
 * Usage rows are matched by summary as well as by id, because
 * `persistThreadUsageActivity` accepts a monitor-scope row under any id as
 * long as its summary names the scope.
 */
export function isOverlayOwnedTranscriptEntry(
  entry: AppServerThreadEntry,
): boolean {
  return (
    OVERLAY_OWNED_ENTRY_ID_PREFIXES.some((prefix) => entry.id.startsWith(prefix))
    || isUsageActivityEntry(entry)
  );
}
