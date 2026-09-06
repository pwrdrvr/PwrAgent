import { createHash } from "node:crypto";
import type {
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
  NavigationSelectedDetailRequest,
  NavigationSelectedDetailResponse,
  ThreadQueuedTurnSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  NAVIGATION_QUERY_PROTOCOL_VERSION,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "./backend-registry";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { resolveScratchProjectsRoots } from "./scratch-projects";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { NavigationQueryError } from "./navigation-query-store";

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

export class NavigationDetailService {
  constructor(
    private readonly registry: DesktopBackendRegistry = getDesktopBackendRegistry(),
  ) {}

  async readSelectedDetail(
    request: NavigationSelectedDetailRequest,
  ): Promise<NavigationSelectedDetailResponse> {
    if (request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
      );
    }
    const summary = this.registry.getCachedThreadSummary({
      backend: request.ref.backend,
      threadId: request.ref.threadId,
    }) ?? await this.registry.resolveThread({
      backend: request.ref.backend,
      threadId: request.ref.threadId,
    });
    if (!summary) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: revision({ identity: "unresolved", ref: request.ref }),
        readiness: "ready",
        identity: "unresolved",
      };
    }
    const threadKey = buildThreadIdentityKey(summary.source, summary.id);
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey([
      summary,
    ]);
    const snapshot = await getDesktopOverlayStore().reconcileNavigationSnapshot({
      backend: summary.source,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      partial: true,
      queuedExecutionModesByThreadKey:
        this.registry.getQueuedExecutionModesSnapshot(),
      queuedTurnsByThreadKey: this.registry.getQueuedTurnsSnapshot(),
      threads: [summary],
      workspaceRoots: resolveScratchProjectsRoots(),
    });
    const projected = snapshot.threads.find(
      (thread) => buildThreadIdentityKey(thread.source, thread.id) === threadKey,
    );
    const thread = projected
      ? (await this.registry.canonicalizeNavigationThreadPullRequests([
          projected,
        ]))[0]
      : undefined;
    if (!thread) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: revision({ identity: "unresolved", ref: request.ref }),
        readiness: "ready",
        identity: "unresolved",
      };
    }
    const detailRevision = revision(thread);
    if (request.knownRevision === detailRevision) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: detailRevision,
        readiness: "ready",
        identity: "present",
        unchanged: true,
      };
    }
    const response: NavigationSelectedDetailResponse = {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      ref: request.ref,
      revision: detailRevision,
      readiness: "ready",
      identity: "present",
      thread,
    };
    if (responseBytes(response) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      throw new NavigationQueryError(
        "navigation_item_too_large",
        "Selected thread detail exceeds the result budget; read its collections separately.",
      );
    }
    return response;
  }

  readQueueProjection(
    request: NavigationQueueProjectionRequest,
  ): NavigationQueueProjection {
    if (request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
      );
    }
    const threadKey = buildThreadIdentityKey(
      request.ref.backend,
      request.ref.threadId,
    );
    const entries = this.registry.getQueuedTurnsSnapshot()[threadKey] ?? [];
    const queuedExecutionMode =
      this.registry.getQueuedExecutionModesSnapshot()[threadKey]?.mode;
    const queueRevision = revision({ entries, queuedExecutionMode });
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
    if (offset > entries.length) {
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
    for (; nextOffset < entries.length && nextOffset - offset < 100; nextOffset += 1) {
      const candidate = {
        ...response,
        entries: [...response.entries, entries[nextOffset]!],
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
      response.entries.push(entries[nextOffset] as ThreadQueuedTurnSummary);
    }
    response.complete = nextOffset >= entries.length;
    if (!response.complete) {
      response.nextCursor = encodeQueueCursor({
        offset: nextOffset,
        revision: queueRevision,
      });
    }
    return response;
  }
}

let desktopNavigationDetailService: NavigationDetailService | undefined;

export function getDesktopNavigationDetailService(): NavigationDetailService {
  desktopNavigationDetailService ??= new NavigationDetailService();
  return desktopNavigationDetailService;
}
