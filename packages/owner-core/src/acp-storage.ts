import type {
  AcpBackendId,
  AppServerAvailableCommandSummary,
  AppServerThreadTitleSource,
  BackendAcpSessionRuntimeState,
  ThreadExecutionMode,
} from "@pwragent/shared";

/** Registry and installed-agent records belong to the host's ACP integration. */
export interface AcpAgentStorage<RegistrySnapshot, InstalledAgentRecord> {
  saveRegistrySnapshot(snapshot: RegistrySnapshot): void;
  readRegistrySnapshot(): RegistrySnapshot | undefined;
  upsertInstalledAgent(record: InstalledAgentRecord): void;
  listInstalledAgents(): InstalledAgentRecord[];
  getInstalledAgent(backendId: AcpBackendId): InstalledAgentRecord | undefined;
}

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
  /** Host-enforced policy for helpers that must never request user approval. */
  approvalPolicy?: "deny-all";
  acpRuntime?: BackendAcpSessionRuntimeState;
  availableCommands?: AppServerAvailableCommandSummary[];
  status: "active" | "idle" | "failed" | "unknown";
  hidden?: boolean;
  hasConversationHistory?: boolean;
  requiresAgentSessionRebind?: boolean;
  archivedAt?: number;
  lastError?: string;
};

export interface AcpSessionStorage {
  /** Stored sessions retain ownership even after an agent is uninstalled. */
  listBackendIds?(): AcpBackendId[];
  /** Complete local metadata discovery, including archives and uninstalled backends. */
  listAllSessions(params?: { includeHidden?: boolean }): AcpSessionMetadata[];
  upsertSession(metadata: AcpSessionMetadata): void;
  listSessions(
    backendId: AcpBackendId,
    params?: { archived?: boolean; includeHidden?: boolean },
  ): AcpSessionMetadata[];
  /** Identity-keyset pages omit transcript history and runtime command data. */
  listArchiveCleanupSessionsPage(backendId: AcpBackendId, params: {
    archived: boolean;
    after?: string;
    limit: number;
  }): { sessions: AcpSessionMetadata[]; nextCursor?: string };
  deleteSession(backendId: AcpBackendId, sessionId: string): void;
  getSession(backendId: AcpBackendId, sessionId: string): AcpSessionMetadata | undefined;
}

export type AcpAvailableCommandsRecord = {
  backendId: AcpBackendId;
  repositoryPath: string;
  commands: AppServerAvailableCommandSummary[];
  observedAt: number;
};

/**
 * Durable last-observed slash-command list per (ACP agent, repository root).
 *
 * ACP advertises `availableCommands` only through `session/update` on a live
 * session, so a launchpad draft — no thread, no session — cannot ask for them.
 * Live sessions write through here as they report, and launchpad requests read
 * back the repo's last-known list. Rows are keyed by repository root rather
 * than by cwd so every worktree of a checkout shares one entry.
 */
export interface AcpAvailableCommandsStorage {
  get(
    backendId: AcpBackendId,
    repositoryPath: string,
  ): AcpAvailableCommandsRecord | undefined;
  upsert(record: AcpAvailableCommandsRecord): void;
}
