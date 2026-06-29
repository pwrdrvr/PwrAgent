import type { AutomationRunTranscriptEvent } from "@pwragent/shared";

/**
 * Merge transcript events by id (last write wins), order by timestamp, then
 * collapse duplicate `assistant_final` events that share the same trimmed text.
 *
 * The agent's final answer is recorded under two ids — the streamed
 * `item/completed` event (`<run>:assistant:<item>`) and the run-artifact builder
 * (`<run>:assistant-final`) — so id-keyed merging alone would surface the
 * response twice in the run detail. Both the store (single-event append) and the
 * service (artifact rebuild) merge transcripts, so this lives in one place to
 * keep the dedup rule from drifting between the two paths.
 */
export function mergeTranscriptEvents(
  existing: AutomationRunTranscriptEvent[],
  incoming: AutomationRunTranscriptEvent[],
): AutomationRunTranscriptEvent[] {
  const byId = new Map<string, AutomationRunTranscriptEvent>();
  for (const event of existing) {
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  const sorted = [...byId.values()].sort((left, right) => left.at - right.at);
  const seenFinalText = new Set<string>();
  return sorted.filter((event) => {
    if (event.kind !== "assistant_final") return true;
    const key = event.text?.trim();
    if (!key) return true;
    if (seenFinalText.has(key)) return false;
    seenFinalText.add(key);
    return true;
  });
}
