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
        metadata.backendId,
        metadata.sessionId,
        metadata.createdAt,
        metadata.updatedAt,
        JSON.stringify(metadata),
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
