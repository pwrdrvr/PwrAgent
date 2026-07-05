import type {
  AppServerBackendKind,
  GetMessagingActivitySummaryResponse,
  MessagingActivityEntry,
  MessagingActivityKind,
  MessagingChannelKind,
  ThreadIdentifier,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export type RecordMessagingActivityInput = {
  platform: MessagingChannelKind;
  kind: MessagingActivityKind;
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  bindingId?: string;
  conversationId?: string;
  conversationTitle?: string;
  actorId?: string;
  actorDisplayName?: string;
  summary: string;
  createdAt?: number;
  /**
   * Free-form bag of fields the row should remember without growing
   * dedicated columns. Renderer may show these in the activity detail
   * panel; consumers must treat the shape as opaque.
   */
  payload?: Record<string, unknown>;
};

export type RecordMessagingPlatformResponseActivityInput = {
  platform: MessagingChannelKind;
  createdAt?: number;
};

/**
 * Persisted messaging activity log. Rows live in the same sqlite DB as
 * other desktop state; per-platform FIFO eviction happens in
 * `StateDb.cleanupExpired`. Writes are best-effort and fail-soft —
 * `record()` callers must not block message routing on a write error.
 */
export class MessagingActivityLog {
  constructor(private readonly stateDb: StateDb) {}

  record(entry: RecordMessagingActivityInput): MessagingActivityEntry {
    const createdAt = entry.createdAt ?? Date.now();
    const payload = entry.payload ?? {};
    const result = this.stateDb.raw
      .prepare(
        `INSERT INTO messaging_activity_log(
           platform, kind, thread_id, binding_id, conversation_id,
           conversation_title, actor_id, actor_display_name,
           summary, created_at, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.platform,
        entry.kind,
        entry.threadId ?? null,
        entry.bindingId ?? null,
        entry.conversationId ?? null,
        entry.conversationTitle ?? null,
        entry.actorId ?? null,
        entry.actorDisplayName ?? null,
        entry.summary,
        createdAt,
        JSON.stringify({ backend: entry.backend, ...payload }),
      );
    return {
      id: Number(result.lastInsertRowid),
      platform: entry.platform,
      kind: entry.kind,
      backend: entry.backend,
      threadId: entry.threadId,
      bindingId: entry.bindingId,
      conversationId: entry.conversationId,
      conversationTitle: entry.conversationTitle,
      actorId: entry.actorId,
      actorDisplayName: entry.actorDisplayName,
      summary: entry.summary,
      createdAt,
      payload: Object.keys(payload).length > 0 ? payload : undefined,
    };
  }

  recordPlatformResponseActivity(
    entry: RecordMessagingPlatformResponseActivityInput,
  ): void {
    const createdAt = entry.createdAt ?? Date.now();
    this.stateDb.raw
      .prepare(
        `INSERT INTO messaging_activity_summary(
           platform, last_response_at, updated_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(platform) DO UPDATE SET
           last_response_at = MAX(
             COALESCE(messaging_activity_summary.last_response_at, 0),
             excluded.last_response_at
           ),
           updated_at = MAX(
             messaging_activity_summary.updated_at,
             excluded.updated_at
           )`,
      )
      .run(entry.platform, createdAt, createdAt);
  }

  list(
    params: {
      limit?: number;
      sinceId?: number;
    } = {},
  ): MessagingActivityEntry[] {
    const limit = Math.min(
      Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_LIMIT,
    );
    const rows =
      params.sinceId !== undefined
        ? (this.stateDb.raw
            .prepare(
              `SELECT id, platform, kind, thread_id, binding_id, conversation_id,
                    conversation_title, actor_id, actor_display_name, summary,
                    created_at, payload
             FROM messaging_activity_log
             WHERE id > ? AND kind <> 'outbound'
             ORDER BY id DESC
             LIMIT ?`,
            )
            .all(params.sinceId, limit) as RawActivityRow[])
        : (this.stateDb.raw
            .prepare(
              `SELECT id, platform, kind, thread_id, binding_id, conversation_id,
                    conversation_title, actor_id, actor_display_name, summary,
                    created_at, payload
             FROM messaging_activity_log
             WHERE kind <> 'outbound'
             ORDER BY id DESC
             LIMIT ?`,
            )
            .all(limit) as RawActivityRow[]);
    return rows.map(rowToEntry);
  }

  getPlatformActivitySummary(): GetMessagingActivitySummaryResponse {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT
           platforms.platform,
           inbound.last_request_at,
           outbound.last_response_at
         FROM (
           SELECT platform
           FROM messaging_activity_log
           WHERE kind IN ('inbound-routed', 'inbound-rejected', 'inbound-ignored')
           UNION
           SELECT platform
           FROM messaging_activity_summary
           WHERE last_response_at IS NOT NULL
           UNION
           SELECT platform
           FROM messaging_activity_log
           WHERE kind = 'outbound'
         ) AS platforms
         LEFT JOIN (
           SELECT platform, MAX(created_at) AS last_request_at
           FROM messaging_activity_log
           WHERE kind IN ('inbound-routed', 'inbound-rejected', 'inbound-ignored')
           GROUP BY platform
         ) AS inbound
           ON inbound.platform = platforms.platform
         LEFT JOIN (
           SELECT platform, MAX(last_response_at) AS last_response_at
           FROM (
             SELECT platform, last_response_at
             FROM messaging_activity_summary
             WHERE last_response_at IS NOT NULL
             UNION ALL
             SELECT platform, created_at AS last_response_at
             FROM messaging_activity_log
             WHERE kind = 'outbound'
           )
           GROUP BY platform
         ) AS outbound
           ON outbound.platform = platforms.platform
         WHERE inbound.last_request_at IS NOT NULL
            OR outbound.last_response_at IS NOT NULL`,
      )
      .all() as RawActivitySummaryRow[];
    return {
      summaries: rows.map((row) => ({
        platform: row.platform as MessagingChannelKind,
        ...(row.last_request_at !== null
          ? { lastRequestAt: row.last_request_at }
          : {}),
        ...(row.last_response_at !== null
          ? { lastResponseAt: row.last_response_at }
          : {}),
      })),
    };
  }
}

type RawActivityRow = {
  id: number;
  platform: string;
  kind: string;
  thread_id: string | null;
  binding_id: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  actor_id: string | null;
  actor_display_name: string | null;
  summary: string;
  created_at: number;
  payload: string;
};

type RawActivitySummaryRow = {
  platform: string;
  last_request_at: number | null;
  last_response_at: number | null;
};

function rowToEntry(row: RawActivityRow): MessagingActivityEntry {
  // The payload column stores `{ backend, ...callerExtras }` as JSON.
  // We split `backend` out (it's a typed top-level field on the entry)
  // and surface the remaining keys as the opaque `payload` bag the
  // renderer's activity detail panel can render.
  let backend: AppServerBackendKind | undefined;
  let extras: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(row.payload) as Record<string, unknown> & {
      backend?: AppServerBackendKind;
    };
    backend = parsed.backend;
    const { backend: _ignored, ...rest } = parsed;
    if (Object.keys(rest).length > 0) {
      extras = rest;
    }
  } catch {
    // Malformed JSON — treat as if there's no backend hint and no
    // extras. The row still surfaces; only the opaque bag is lost.
  }
  return {
    id: row.id,
    platform: row.platform as MessagingChannelKind,
    kind: row.kind as MessagingActivityKind,
    backend,
    threadId: row.thread_id ?? undefined,
    bindingId: row.binding_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    conversationTitle: row.conversation_title ?? undefined,
    actorId: row.actor_id ?? undefined,
    actorDisplayName: row.actor_display_name ?? undefined,
    summary: row.summary,
    createdAt: row.created_at,
    payload: extras,
  };
}
