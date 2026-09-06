import type {
  ComposerThreadOwner,
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
} from "@pwragent/shared";
import type { ComposerQueuedTurnSnapshot } from "../features/composer/useComposerDraftStore";

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
    try {
      do {
        if (params.isCancelled()) throw new Error("Queue read cancelled.");
        if (Date.now() >= deadlineAt) throw new Error("Queue read deadline expired.");
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
        if (page.protocol !== 2 || page.readiness !== "ready"
          || page.ref.backend !== params.owner.backend
          || page.ref.threadId !== params.owner.threadId
          || page.ref.ownerInstanceId !== (params.owner.target.scope === "remote"
            ? params.owner.target.instanceId : undefined)) {
          throw new Error("Queue projection is not authoritative for this thread.");
        }
        if (page.unchanged) {
          if (!params.previous?.complete || params.previous.revision !== page.revision || cursor) {
            throw new Error("Queue unchanged response has no complete matching baseline.");
          }
          return params.previous;
        }
        if (baseline && baseline.revision !== page.revision) {
          throw Object.assign(new Error("Queue changed while paging."), { code: "navigation_cursor_expired" });
        }
        baseline = { ...page, entries: [...(baseline?.entries ?? []), ...page.entries] };
        if (page.complete) return baseline;
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("Queue cursor did not advance.");
        cursors.add(cursor);
      } while (cursor);
    } catch (error) {
      if (restart === 0 && typeof error === "object" && error !== null
        && "code" in error && error.code === "navigation_cursor_expired") continue;
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
