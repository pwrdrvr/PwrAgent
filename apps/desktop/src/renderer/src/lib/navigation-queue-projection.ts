import { NAVIGATION_QUERY_MAX_PAGE_ROWS, NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import type {
  ComposerThreadOwner,
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
} from "@pwragent/shared";
import type { ComposerQueuedTurnSnapshot } from "../features/composer/useComposerDraftStore";
import { isNavigationCursorExpired } from "./navigation-query-state";

export const NAVIGATION_QUEUE_MAX_BASELINE_BYTES = 8 * 1024 * 1024;
export const NAVIGATION_QUEUE_MAX_PAGES = 128;

/** A complete FIFO baseline has no dependency on a row page or its timestamp. */
export async function readCompleteNavigationQueue(params: {
  owner: ComposerThreadOwner;
  read: (request: NavigationQueueProjectionRequest) => Promise<NavigationQueueProjection>;
  previous?: NavigationQueueProjection;
  isCancelled: () => boolean;
}): Promise<NavigationQueueProjection> {
  const deadlineAt = Date.now() + 10_000;
  for (let restart = 0; restart < 2; restart += 1) {
    let cursor: string | undefined;
    let baseline: NavigationQueueProjection | undefined;
    const cursors = new Set<string>();
    const entryIds = new Set<string>();
    let retainedBytes = 0;
    let pageCount = 0;
    try {
      do {
        if (params.isCancelled()) throw new Error("Queue read cancelled.");
        if (Date.now() >= deadlineAt) throw new Error("Queue read deadline expired.");
        if (++pageCount > NAVIGATION_QUEUE_MAX_PAGES) throw new Error("Queue exceeds the complete-read page budget; existing queued replies were retained.");
        const page = await params.read({
          protocol: 2,
          ref: {
            backend: params.owner.backend,
            threadId: params.owner.threadId,
            ...(params.owner.target.scope === "remote"
              ? { ownerInstanceId: params.owner.target.instanceId }
              : {}),
          },
          federationTarget: params.owner.target,
          knownRevision: cursor ? undefined : params.previous?.revision,
          cursor,
          deadlineAt,
        });
        if (params.isCancelled()) throw new Error("Queue read cancelled.");
        if (Date.now() >= deadlineAt) throw new Error("Queue read deadline expired.");
        const pageBytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
        if (pageBytes > NAVIGATION_QUERY_MAX_RESULT_BYTES || page.entries.length > NAVIGATION_QUERY_MAX_PAGE_ROWS) {
          throw new Error("Queue page exceeds the bounded protocol budget.");
        }
        if (page.protocol !== 2 || page.readiness !== "ready"
          || page.ref.backend !== params.owner.backend
          || page.ref.threadId !== params.owner.threadId
          || page.ref.ownerInstanceId !== (params.owner.target.scope === "remote"
            ? params.owner.target.instanceId : undefined)) {
          throw new Error("Queue projection is not authoritative for this thread.");
        }
        if (page.unchanged) {
          if (!params.previous?.complete || params.previous.revision !== page.revision || cursor
            || !page.complete || page.entries.length || page.nextCursor
            || params.previous.ref.backend !== page.ref.backend
            || params.previous.ref.threadId !== page.ref.threadId
            || params.previous.ref.ownerInstanceId !== page.ref.ownerInstanceId) {
            throw new Error("Queue unchanged response has no complete matching baseline.");
          }
          return params.previous;
        }
        if (baseline && baseline.revision !== page.revision) {
          throw Object.assign(new Error("Queue changed while paging."), { code: "navigation_cursor_expired" });
        }
        retainedBytes += pageBytes;
        if (retainedBytes > NAVIGATION_QUEUE_MAX_BASELINE_BYTES) {
          throw new Error("Queue exceeds the complete-read memory budget; existing queued replies were retained.");
        }
        for (const entry of page.entries) {
          if (entryIds.has(entry.queueEntryId)) throw new Error("Queue pages contain a duplicate entry.");
          entryIds.add(entry.queueEntryId);
        }
        const entries = baseline?.entries ?? [];
        entries.push(...page.entries);
        baseline = { ...page, entries };
        if (page.complete) return baseline;
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("Queue cursor did not advance.");
        cursors.add(cursor);
      } while (cursor);
    } catch (error) {
      if (restart === 0 && isNavigationCursorExpired(error)) continue;
      throw error;
    }
  }
  throw new Error("Queue could not establish a complete baseline.");
}

/** Never prune a submission acknowledged or edited while this read was pending. */
export function reconcileCompleteNavigationQueue(params: {
  owner: ComposerThreadOwner;
  projection: NavigationQueueProjection;
  atReadStart: readonly ComposerQueuedTurnSnapshot[];
  current: readonly ComposerQueuedTurnSnapshot[];
}): ComposerQueuedTurnSnapshot[] {
  if (params.projection.readiness !== "ready" || !params.projection.complete) return [...params.current];
  const capturedById = new Map(params.atReadStart.map((entry) => [entry.id, entry]));
  const ownerKey = JSON.stringify(params.owner);
  const belongsToOwner = (entry: ComposerQueuedTurnSnapshot): boolean =>
    Boolean(entry.threadOwner) && JSON.stringify(entry.threadOwner) === ownerKey;
  const ownerById = new Map(params.projection.entries.map((entry) => [entry.queueEntryId, entry]));
  const retained = params.current.filter((entry) => !entry.queueEntryId
    || !entry.threadOwner
    || JSON.stringify(entry.threadOwner) !== ownerKey
    || entry.backendQueuePending
    || ownerById.has(entry.queueEntryId)
    || capturedById.get(entry.id) !== entry);
  const mirrorsById = new Map(retained
    .filter((entry) => entry.queueEntryId && belongsToOwner(entry))
    .map((entry) => [entry.queueEntryId!, entry]));
  const mirrors = params.projection.entries.map((entry): ComposerQueuedTurnSnapshot => {
    const existing = mirrorsById.get(entry.queueEntryId);
    return {
      ...(existing ?? {
        id: `backend-queued:${JSON.stringify([params.owner.target, params.owner.backend, params.owner.threadId, entry.queueEntryId])}`,
        queueEntryId: entry.queueEntryId,
        queueEntryCreatedAt: entry.createdAt,
        text: entry.displayText,
        imageAttachments: [],
        fileAttachments: [],
      }),
      threadOwner: params.owner,
      manualReleaseRequired: entry.manualReleaseRequired,
      holdReason: entry.holdReason,
    };
  });
  const isMirror = (entry: ComposerQueuedTurnSnapshot): boolean =>
    Boolean(entry.queueEntryId) && belongsToOwner(entry) && ownerById.has(entry.queueEntryId!);
  const firstMirror = retained.findIndex(isMirror);
  const local = retained.filter((entry) => !isMirror(entry));
  const position = firstMirror < 0 ? local.length : firstMirror;
  return [...local.slice(0, position), ...mirrors, ...local.slice(position)];
}
