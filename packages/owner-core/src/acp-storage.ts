import type {
  AcpBackendId,
  AppServerAvailableCommandSummary,
  AppServerThreadTitleSource,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendAcpSessionRuntimeState } from "@pwragent/shared/contracts/backend";

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
  /** Full Access was committed by the owner after selecting the privileged process. */
  antigravityFullAccessConfirmed?: true;
  /** Host-enforced policy for helpers that must never request user approval. */
  approvalPolicy?: "deny-all";
  acpRuntime?: BackendAcpSessionRuntimeState;
  availableCommands?: AppServerAvailableCommandSummary[];
  status: "active" | "idle" | "failed" | "unknown";
  hidden?: boolean;
  hasConversationHistory?: boolean;
  /** The provider session was opened after a workspace handoff. Older turns are in the ACP rollout. */
  antigravityWorkspaceRebound?: true;
  /** The destination provider accepted the prior workspace context. Local messages do not set this. */
  antigravityWorkspaceContextDelivered?: true;
  /** Primary cwd established by session/new, before any pending workspace change. */
  antigravityPrimaryCwd?: string;
  requiresAgentSessionRebind?: boolean;
  /**
   * Digest of the Agent instruction block this agent session was last sent.
   * Absent when it was sent none, or was told they were removed.
   */
  agentInstructionsDigest?: string;
  archivedAt?: number;
  lastError?: string;
};

export function acpSessionExecutionMode(session: AcpSessionMetadata): ThreadExecutionMode {
  // Older owners could record Full Access without starting a privileged process.
  if (session.backendId === "acp:antigravity") {
    return session.executionMode === "full-access" && session.antigravityFullAccessConfirmed === true
      ? "full-access" : "default";
  }
  return session.executionMode;
}

export type AcpSessionInventoryGroup = {
  backendId: AcpBackendId;
  sessions: AcpSessionMetadata[];
};

export interface AcpSessionStorage {
  /** Stored sessions retain ownership even after an agent is uninstalled. */
  listBackendIds?(): AcpBackendId[];
  /** Complete local metadata discovery, including archives and uninstalled backends. */
  listAllSessions(params?: { includeHidden?: boolean }): AcpSessionMetadata[];
  /** Ordered visible sessions for the requested archive state, grouped by listing backend. */
  listInventorySessions(options?: { archived?: boolean }): AcpSessionInventoryGroup[];
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
  /** A worktree can report different commands from the shared repository. */
  workspaceCwd?: string;
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
