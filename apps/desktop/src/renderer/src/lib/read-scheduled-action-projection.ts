import type { ListScheduledThreadActionsRequest, ListScheduledThreadActionsResponse } from "@pwragent/shared";
import { isNavigationCursorExpired } from "./navigation-query-state";

/** Publish scheduled mirrors only after one complete, stable owner generation. */
export async function readScheduledActionProjection(params: {
  request: ListScheduledThreadActionsRequest;
  read: (request: ListScheduledThreadActionsRequest) => Promise<ListScheduledThreadActionsResponse>;
  isCancelled: () => boolean;
  allocation: { reserve: (bytes: number) => void; unreserve: (bytes: number) => void };
}): Promise<ListScheduledThreadActionsResponse> {
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let cursor: string | undefined;
    let result: ListScheduledThreadActionsResponse | undefined;
    let bytes = 0;
    const cursors = new Set<string>();
    const ids = new Set<string>();
    try {
      for (let pageIndex = 0; pageIndex < 128; pageIndex += 1) {
        if (params.isCancelled() || Date.now() >= deadline) throw new Error("Scheduled projection cancelled or expired.");
        const page = await params.read({ ...params.request, projectionProtocol: 2, cursor });
        if (params.isCancelled() || Date.now() >= deadline) throw new Error("Scheduled projection cancelled or expired.");
        if (page.projectionProtocol !== 2 || !page.revision || typeof page.complete !== "boolean") {
          throw new Error("Upgrade the owning instance to bounded scheduled projection protocol 2.");
        }
        if (result && page.revision !== result.revision) throw new Error("[navigation_cursor_expired] Scheduled generation changed.");
        const pageBytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
        if (page.actions.length > 100 || pageBytes > 252 * 1024 || bytes + pageBytes > 8 * 1024 * 1024) {
          throw new Error("Scheduled projection exceeds its page or complete-read byte budget.");
        }
        params.allocation.reserve(pageBytes);
        bytes += pageBytes;
        for (const action of page.actions) {
          if (ids.has(action.id)) throw new Error("Scheduled projection repeats an action.");
          ids.add(action.id);
        }
        const actions = result?.actions ?? [];
        actions.push(...page.actions);
        result = { ...page, actions, observedAt: result?.observedAt ?? page.observedAt };
        if (page.complete) {
          if (page.nextCursor) throw new Error("Complete scheduled projection has a continuation.");
          return result;
        }
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("Scheduled projection cursor did not advance.");
        cursors.add(cursor);
      }
      throw new Error("Scheduled projection exceeds its page budget.");
    } catch (error) {
      if (attempt === 0 && isNavigationCursorExpired(error)) {
        params.allocation.unreserve(bytes);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Scheduled projection could not establish a complete generation.");
}
