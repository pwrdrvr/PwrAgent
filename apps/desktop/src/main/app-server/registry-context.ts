import type { AgentEvent } from "@pwragent/shared";
import type { ClaudeBackend } from "../claude/claude-backend";
import type { AcpBackendAdapter } from "./acp-backend-adapter";
import type { BackendClient, BackendRegistryOverlayStoreLike } from "./backend-registry-types";

export type RegistryThreadStore = Pick<BackendRegistryOverlayStoreLike,
  "getThreadOverlayState" | "getThreadOverlayStates" | "getThreadMetadata" | "updateThreadMetadata"
>;

export type RegistryUsageStore = Pick<BackendRegistryOverlayStoreLike,
  "upsertThreadUsageLines" | "readThreadPricing" | "completeThreadUsageTurn"
  | "completeThreadUsageTurns" | "readThreadUsageActivities" | "readThreadUsageActivityForTurn"
>;

export type RegistrySubAgentStore = Pick<BackendRegistryOverlayStoreLike,
  "upsertThreadSubAgents" | "reconcileOrphanedThreadSubAgents" | "moveLegacyThreadSubAgents"
>;

export type RegistryWorkspaceStore = Pick<BackendRegistryOverlayStoreLike,
  "readThreadGitWorkingStateCache" | "writeThreadGitWorkingStateCacheEntry"
  | "acknowledgeThreadEnvironmentFailure"
>;

export type RegistryPullRequestStore = Pick<BackendRegistryOverlayStoreLike, "addThreadPullRequestReference">;

export type RegistryToolAccountingStore = Pick<BackendRegistryOverlayStoreLike,
  "readThreadToolAccounting" | "persistThreadToolInvocationBoundary"
  | "markThreadToolInvocationsNoisy" | "setThreadSpendAlertPending"
>;

/** Domain modules receive these capabilities and import this type, never the registry. */
export interface RegistryContext {
  readonly stores: {
    readonly threads: RegistryThreadStore;
    readonly usage: RegistryUsageStore;
    readonly subAgents: RegistrySubAgentStore;
    readonly workspaces: RegistryWorkspaceStore;
    readonly toolAccounting: RegistryToolAccountingStore;
    readonly pullRequests: RegistryPullRequestStore;
  };
  readonly providers: {
    readonly codex: BackendClient;
    readonly claude: ClaudeBackend;
    readonly acp: AcpBackendAdapter;
  };
  readonly lifecycle: { readonly closed: boolean };
  readonly emit: (event: AgentEvent) => Promise<void>;
}
