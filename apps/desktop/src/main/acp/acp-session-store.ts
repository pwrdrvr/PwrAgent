import type {
  AcpBackendId,
  AppServerThreadTitleSource,
  BackendAcpSessionRuntimeState,
  ThreadExecutionMode,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db.js";

export type AcpSessionMetadata = {
  backendId: AcpBackendId;
  /**
   * Stable PwrAgent thread id. For ACP agents whose session ids are scoped to
   * immutable project directories, this can differ from the protocol session id.
   */
  sessionId: string;
  agentSessionId?: string;
  title: string;
  titleSource?: AppServerThreadTitleSource;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  executionMode: ThreadExecutionMode;
  acpRuntime?: BackendAcpSessionRuntimeState;
  status: "active" | "idle" | "failed" | "unknown";
  requiresAgentSessionRebind?: boolean;
  archivedAt?: number;
  lastError?: string;
  transcriptUpdates?: AcpPersistedTranscriptUpdate[];
};

export type AcpPersistedTranscriptUpdate = {
  receivedAt: number;
  update: Record<string, unknown>;
};

export class AcpSessionStore {
  constructor(private readonly stateDb: StateDb) {}

  upsertSession(metadata: AcpSessionMetadata): void {
    const compactedMetadata = compactAcpSessionMetadata(metadata);
    this.stateDb.raw
      .prepare(
        `INSERT OR REPLACE INTO acp_sessions(
           backend_id,
           session_id,
           created_at,
           updated_at,
           payload
         )
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        compactedMetadata.backendId,
        compactedMetadata.sessionId,
        compactedMetadata.createdAt,
        compactedMetadata.updatedAt,
        JSON.stringify(compactedMetadata),
      );
  }

  listSessions(
    backendId: AcpBackendId,
    params?: { archived?: boolean },
  ): AcpSessionMetadata[] {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT payload FROM acp_sessions
         WHERE backend_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(backendId) as Array<{ payload: string }>;
    const archived = params?.archived === true;
    return rows.flatMap((row) => {
      const parsed = parseJson(row.payload);
      if (!isSessionMetadata(parsed)) {
        return [];
      }
      return Boolean(parsed.archivedAt) === archived ? [parsed] : [];
    });
  }

  getSession(
    backendId: AcpBackendId,
    sessionId: string,
  ): AcpSessionMetadata | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT payload FROM acp_sessions
         WHERE backend_id = ? AND session_id = ?`,
      )
      .get(backendId, sessionId) as { payload: string } | undefined;
    const parsed = row ? parseJson(row.payload) : undefined;
    return isSessionMetadata(parsed) ? parsed : undefined;
  }
}

function compactAcpSessionMetadata(metadata: AcpSessionMetadata): AcpSessionMetadata {
  if (!metadata.transcriptUpdates?.length) {
    return metadata;
  }
  return {
    ...metadata,
    transcriptUpdates: compactAcpTranscriptUpdates(metadata.transcriptUpdates),
  };
}

export function compactAcpTranscriptUpdates(
  updates: AcpPersistedTranscriptUpdate[],
): AcpPersistedTranscriptUpdate[] {
  const compacted: AcpPersistedTranscriptUpdate[] = [];
  for (const update of updates) {
    appendCoalescedTranscriptUpdate(compacted, update);
  }
  return compacted;
}

export function appendCoalescedTranscriptUpdate(
  updates: AcpPersistedTranscriptUpdate[],
  next: AcpPersistedTranscriptUpdate,
): void {
  const previous = updates.at(-1);
  const coalesced = previous ? coalesceTranscriptUpdate(previous, next) : undefined;
  if (coalesced) {
    updates[updates.length - 1] = coalesced;
    return;
  }
  updates.push(next);
}

function coalesceTranscriptUpdate(
  previous: AcpPersistedTranscriptUpdate,
  next: AcpPersistedTranscriptUpdate,
): AcpPersistedTranscriptUpdate | undefined {
  const previousKind = readUpdateKind(previous.update);
  const nextKind = readUpdateKind(next.update);
  if (
    previousKind !== nextKind ||
    !isCoalescibleTranscriptChunkKind(previousKind)
  ) {
    return undefined;
  }
  if (messageIdentity(previous.update) !== messageIdentity(next.update)) {
    return undefined;
  }
  const previousText = readUpdateText(previous.update);
  const nextText = readUpdateText(next.update);
  if (previousText === undefined || nextText === undefined) {
    return undefined;
  }
  return {
    receivedAt: next.receivedAt,
    update: writeUpdateText(previous.update, `${previousText}${nextText}`),
  };
}

function readUpdateKind(update: Record<string, unknown>): string | undefined {
  const kind = update.sessionUpdate ?? update.kind ?? update.type;
  return typeof kind === "string" ? kind : undefined;
}

function isCoalescibleTranscriptChunkKind(kind: string | undefined): boolean {
  return (
    kind === "agent_message_chunk" ||
    kind === "agent_thought_chunk" ||
    kind === "user_message_chunk"
  );
}

function messageIdentity(update: Record<string, unknown>): string {
  const messageId = update.messageId ?? update.id;
  return typeof messageId === "string" ? messageId : "";
}

function readUpdateText(update: Record<string, unknown>): string | undefined {
  if (typeof update.text === "string") {
    return update.text;
  }
  const content = update.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return undefined;
  }
  const contentRecord = content as Record<string, unknown>;
  return contentRecord.type === "text" && typeof contentRecord.text === "string"
    ? contentRecord.text
    : undefined;
}

function writeUpdateText(
  update: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  if (typeof update.text === "string") {
    return { ...update, text };
  }
  const content = update.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const contentRecord = content as Record<string, unknown>;
    if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
      return {
        ...update,
        content: {
          ...contentRecord,
          text,
        },
      };
    }
  }
  return update;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isSessionMetadata(value: unknown): value is AcpSessionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.backendId === "string" &&
    record.backendId.startsWith("acp:") &&
    typeof record.sessionId === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}
