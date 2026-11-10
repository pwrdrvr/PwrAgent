import { createHash } from "node:crypto";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES, NAVIGATION_QUERY_PROTOCOL_VERSION, type NavigationQueueProjection,
  type NavigationQueueProjectionRequest, type NavigationSelectedDetailRequest, type NavigationSelectedDetailResponse,
  type ThreadQueuedTurnSummary, type ThreadExecutionMode } from "@pwragent/shared";
import { NavigationQueryError } from "./navigation-query-store";

const SELECTED_COLLECTION_PAGE_RECORDS = 100;

function revision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

type QueueCursor = {
  offset: number;
  revision: string;
};

function encodeQueueCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeQueueCursor(value: string): QueueCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<QueueCursor>;
    if (
      typeof parsed.offset !== "number"
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0
      || typeof parsed.revision !== "string"
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as QueueCursor;
  } catch {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Queue projection cursor is malformed.",
    );
  }
}

export function readNavigationQueueProjection(request: NavigationQueueProjectionRequest,
  iterateEntries: () => Iterable<ThreadQueuedTurnSummary>, queuedExecutionMode?: ThreadExecutionMode): NavigationQueueProjection {
  if (request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
    );
  }
  // Hash one compact summary at a time. The independent FIFO may outlive
  // every navigation page; do not clone/stringify its complete population.
  const hash = createHash("sha256");
  let entryCount = 0;
  let projectionBytes = 0;
  for (const entry of iterateEntries()) {
    const encoded = JSON.stringify(entry);
    projectionBytes += Buffer.byteLength(encoded, "utf8");
    if (projectionBytes > 8 * 1024 * 1024) {
      throw new NavigationQueryError("navigation_busy", "Queue projection exceeds its 8 MiB admission budget.");
    }
    hash.update(encoded).update("\n");
    entryCount += 1;
  }
  const queueRevision = hash.update(JSON.stringify({ queuedExecutionMode })).digest("base64url");
  if (!request.cursor && request.knownRevision === queueRevision) {
    return {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      ref: request.ref,
      revision: queueRevision,
      readiness: "ready",
      complete: true,
      entries: [],
      unchanged: true,
    };
  }
  const cursor = request.cursor ? decodeQueueCursor(request.cursor) : undefined;
  if (cursor && cursor.revision !== queueRevision) {
    throw new NavigationQueryError(
      "navigation_cursor_expired",
      "Queue changed while paging; restart from its current revision.",
    );
  }
  const offset = cursor?.offset ?? 0;
  if (offset > entryCount) {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Queue projection cursor is outside its revision.",
    );
  }
  const response: NavigationQueueProjection = {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    ref: request.ref,
    revision: queueRevision,
    readiness: "ready",
    complete: false,
    entries: [],
    ...(queuedExecutionMode ? { queuedExecutionMode } : {}),
  };
  let nextOffset = offset;
  let position = 0;
  for (const entry of iterateEntries()) {
    if (position++ < offset) continue;
    if (nextOffset - offset >= 100) break;
    const candidate = {
      ...response,
      entries: [...response.entries, entry],
      complete: nextOffset + 1 >= entryCount,
      ...(nextOffset + 1 < entryCount ? { nextCursor: encodeQueueCursor({
        offset: nextOffset + 1,
        revision: queueRevision,
      }) } : {}),
    };
    if (responseBytes(candidate) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      if (nextOffset === offset) {
        throw new NavigationQueryError(
          "navigation_item_too_large",
          "One queue entry exceeds the result budget.",
        );
      }
      break;
    }
    response.entries.push(entry);
    nextOffset += 1;
  }
  response.complete = nextOffset >= entryCount;
  if (!response.complete) {
    response.nextCursor = encodeQueueCursor({
      offset: nextOffset,
      revision: queueRevision,
    });
  }
  return response;
}

/** Conditional selected configuration and byte budget shared by both hosts. */
export function projectNavigationSelectedDetail(request: NavigationSelectedDetailRequest,
  thread: NonNullable<NavigationSelectedDetailResponse["thread"]>,
  collections: NonNullable<NavigationSelectedDetailResponse["collections"]>,
  workspaceDirectories?: NavigationSelectedDetailResponse["workspaceDirectories"]): NavigationSelectedDetailResponse {
  const detailRevision = revision({ thread: thread, workspaceDirectories });
  if (request.knownRevision === detailRevision) {
    return {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      ref: request.ref,
      revision: detailRevision,
      readiness: "ready",
      identity: thread.archivedAt !== undefined ? "archived" : "present",
      unchanged: true,
      collections,
    };
  }
  const response: NavigationSelectedDetailResponse = {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    ref: request.ref,
    revision: detailRevision,
    readiness: "ready",
    identity: thread.archivedAt !== undefined ? "archived" : "present",
    thread: thread,
    collections,
    ...(workspaceDirectories ? { workspaceDirectories } : {}),
  };
  if (responseBytes(response) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
    throw new NavigationQueryError(
      "navigation_item_too_large",
      "Selected thread detail exceeds the result budget; read its collections separately.",
    );
  }
  return response;
}

export type NavigationDetailCollectionSource = {
  count: number; revision: string; read(offset: number, limit: number): Promise<unknown[]>;
};

/** The same bounded collection resource for local and peer owners. */
export async function readNavigationSelectedCollection(request: NavigationSelectedDetailRequest,
  source: NavigationDetailCollectionSource): Promise<NavigationSelectedDetailResponse> {
  if (!request.collection) throw new NavigationQueryError("navigation_invalid_request", "Expected a selected collection.");
    const { count } = source;
    const manifest = { name: request.collection!.name, revision: source.revision };
    const cursor = request.collection!.cursor ? decodeQueueCursor(request.collection!.cursor) : undefined;
    if (cursor && cursor.revision !== manifest.revision) {
      throw new NavigationQueryError("navigation_cursor_expired", "Selected collection changed while paging; restart this collection.");
    }
    const offset = cursor?.offset ?? 0;
    if (offset > count) throw new NavigationQueryError("navigation_invalid_request", "Selected collection cursor is outside its revision.");
    const limit = Math.min(SELECTED_COLLECTION_PAGE_RECORDS, count - offset);
    const values = await source.read(offset, limit);
    // A stored card that does not parse is counted but never read. A short
    // read is the collection's end, so a viewer is never left without one.
    const end = values.length < limit ? offset + values.length : count;
    const response: NavigationSelectedDetailResponse = {
      protocol: 2, ref: request.ref, revision: manifest.revision, readiness: "ready", identity: "present",
      collectionPage: { name: manifest.name, revision: manifest.revision,
        values: { [manifest.name]: [] }, complete: offset === end },
    };
    const envelopeBytes = responseBytes(response);
    let valuesBytes = 0;
    let accepted = 0;
    for (let taken = 1; taken <= values.length; taken += 1) {
      const next = offset + taken;
      const complete = next === end;
      const nextCursor = next < end ? encodeQueueCursor({ offset: next, revision: manifest.revision }) : undefined;
      // Size each record in array context (including JSON's null fallback),
      // without reserializing the admitted prefix. Brackets are in the envelope.
      valuesBytes += responseBytes([values[taken - 1]]) - 2 + (taken > 1 ? 1 : 0);
      // Nonempty pages start with complete:false; true is one byte shorter.
      // A base64url cursor needs no escaping, but its offset changes its length.
      const candidateBytes = envelopeBytes + valuesBytes - (complete ? 1 : 0)
        + (nextCursor === undefined ? 0 : ",\"nextCursor\":\"\"".length + nextCursor.length);
      if (candidateBytes > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
        if (taken === 1) throw new NavigationQueryError("navigation_item_too_large", "One selected collection record exceeds the result budget.");
        break;
      }
      accepted = taken;
      response.collectionPage!.complete = complete;
      response.collectionPage!.nextCursor = nextCursor;
    }
    if (accepted > 0) {
      response.collectionPage!.values = { [manifest.name]: values.slice(0, accepted) };
    }
    return response;
}

export { revision as navigationDetailRevision };
