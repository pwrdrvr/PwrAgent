import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import { applyNavigationPage, beginNavigationPageRead, createNavigationPageState } from "./navigation-query-state";

/** Complete compact metadata/exact demand, never an eager full thread-lens reader. */
export async function readNavigationQueryRange(params: {
  request: NavigationQueryRequest;
  read: (request: NavigationQueryRequest) => Promise<NavigationQueryPage>;
  isCancelled: () => boolean;
  maxBytes: number;
  reserveBytes?: (bytes: number) => void;
  releaseBytes?: (bytes: number) => void;
}): Promise<NavigationQueryPage> {
  if (!["directory-index", "star-map-geometry", "exact", "model-inventory"].includes(params.request.query.kind)) {
    throw new Error("Only compact metadata and explicit identities may request a complete navigation range.");
  }
  const deadlineAt = Math.min(params.request.deadlineAt ?? Infinity, Date.now() + 10_000);
  let state = createNavigationPageState(params.request);
  let restarted = false;
  let retainedBytes = 0;
  const encoder = new TextEncoder();
  while (true) {
    if (params.isCancelled()) throw new Error("Navigation metadata read cancelled.");
    if (Date.now() >= deadlineAt) throw new Error("Navigation metadata read deadline expired.");
    const cursor = state.page?.nextCursor;
    state = beginNavigationPageRead(state);
    let page: NavigationQueryPage;
    try {
      page = await params.read({ ...params.request, cursor, deadlineAt, completeBaselineRevision: undefined });
    } catch (error) {
      if (!restarted && cursor && (error as { code?: string }).code === "navigation_cursor_expired") {
        restarted = true;
        state = createNavigationPageState(params.request);
        params.releaseBytes?.(retainedBytes);
        retainedBytes = 0;
        continue;
      }
      throw error;
    }
    if (params.isCancelled()) throw new Error("Navigation metadata read cancelled.");
    if (Date.now() >= deadlineAt) throw new Error("Navigation metadata read deadline expired.");
    if (page.protocol !== params.request.protocol || page.unchanged || page.coverage.state !== "complete") {
      throw new Error("Navigation metadata has no complete owner baseline. Retry after the owner finishes refreshing.");
    }
    // Count serialized backing incrementally; do not repeatedly encode the accumulated range.
    const pageBytes = encoder.encode(JSON.stringify(page)).byteLength;
    if (pageBytes > NAVIGATION_QUERY_MAX_RESULT_BYTES) throw new Error("Navigation metadata page exceeds its wire-byte budget.");
    params.reserveBytes?.(pageBytes);
    retainedBytes += pageBytes;
    if (retainedBytes > params.maxBytes) throw new Error("Navigation metadata exceeds its retained byte budget.");
    state = applyNavigationPage({ state, page, sequence: state.pendingSequence, cursor });
    if (state.page!.complete) return state.page!;
  }
}
