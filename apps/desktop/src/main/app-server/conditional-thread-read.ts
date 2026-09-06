import { createHash } from "node:crypto";
import type { AppServerReadThreadResponse } from "@pwragent/shared";

/**
 * Revalidate the whole page, including pending input and accounting. No owner
 * replay cache is retained. Only a viewer holding this exact page can opt in.
 * This reduces repeated catch-up reads without trusting navigation timestamps
 * as proof that a transcript (or an approval request) has not changed.
 */
export function conditionalThreadRead(
  response: AppServerReadThreadResponse,
  knownRevision: string | undefined,
): AppServerReadThreadResponse {
  if (knownRevision === undefined) return response;
  const revision = createHash("sha256").update(JSON.stringify({
    ...response,
    fetchedAt: undefined,
    readDurationMs: undefined,
    replayRevision: undefined,
    unchanged: undefined,
  })).digest("hex");
  if (revision !== knownRevision) {
    return { ...response, replayRevision: revision };
  }
  return {
    backend: response.backend,
    threadId: response.threadId,
    fetchedAt: response.fetchedAt,
    readDurationMs: response.readDurationMs,
    replayRevision: revision,
    unchanged: true,
    replay: {
      entries: [],
      messages: [],
      pagination: { supportsPagination: false, hasPreviousPage: false },
    },
  };
}
