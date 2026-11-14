import type { AgentEvent } from "@pwragent/shared";
import type { ClaudeBackend } from "../claude/claude-backend";
import type { AcpBackendAdapter } from "./acp-backend-adapter";
import type { BackendClient, BackendRegistryOverlayStoreLike } from "./backend-registry-types";

export type RegistryThreadStore = Pick<BackendRegistryOverlayStoreLike,
  "getThreadOverlayState" | "getThreadOverlayStates" | "getThreadListingOverlayStates"
  | "getThreadMetadata" | "updateThreadMetadata" | "setThreadMcpConnectionIds" | "setThreadModelSettings"
>;

export type RegistryUsageStore = Pick<BackendRegistryOverlayStoreLike,
  "upsertThreadUsageLine" | "upsertThreadUsageLines" | "readThreadPricing" | "completeThreadUsageTurn"
  | "completeThreadUsageTurns" | "readThreadUsageActivities" | "readThreadUsageActivityForTurn"
>;

export type RegistrySubAgentStore = Pick<BackendRegistryOverlayStoreLike,
  "upsertThreadSubAgents" | "reconcileOrphanedThreadSubAgents" | "moveLegacyThreadSubAgents"
  | "getThreadSubAgent" | "getThreadSubAgents" | "listThreadSubAgents"
  | "listThreadSubAgentsByMonitorIdPrefix" | "upsertThreadSubAgent"
>;

export type RegistryWorkspaceStore = Pick<BackendRegistryOverlayStoreLike,
  "readThreadGitWorkingStateCache" | "writeThreadGitWorkingStateCacheEntry"
  | "acknowledgeThreadEnvironmentFailure"
>;

export type RegistryPullRequestStore = Pick<BackendRegistryOverlayStoreLike, "addThreadPullRequestReference">;

export type RegistryReviewStore = Pick<BackendRegistryOverlayStoreLike, "upsertManagedReviewEntry">;

export type RegistryToolAccountingStore = Pick<BackendRegistryOverlayStoreLike,
  "readThreadToolAccounting" | "persistThreadToolInvocationBoundary"
  | "markThreadToolInvocationsNoisy" | "setThreadSpendAlertPending"
>;

/**
 * A module's view of registry-owned state that it does not own. The
 * composition root passes `() => ports`: the registry's construction ports
 * structurally satisfy each module's host interface, and they are bound only
 * once the registry connects them. Read it at call time, never while
 * constructing.
 */
export type RegistryHost<Host> = () => Host;

/**
 * Domain modules receive these capabilities and import this type, never the
 * registry. Store ports read the overlay store's current method on each call,
 * so read them where they are used: never destructure or keep one, and never
 * read one while constructing. backend-registry-wiring.property.test.ts holds
 * that rule for every module.
 */
export interface RegistryContext {
  readonly stores: {
    readonly threads: RegistryThreadStore;
    readonly usage: RegistryUsageStore;
    readonly subAgents: RegistrySubAgentStore;
    readonly workspaces: RegistryWorkspaceStore;
    readonly toolAccounting: RegistryToolAccountingStore;
    readonly pullRequests: RegistryPullRequestStore;
    readonly reviews: RegistryReviewStore;
  };
  readonly providers: {
    readonly codex: BackendClient;
    readonly claude: ClaudeBackend;
    readonly acp: AcpBackendAdapter;
  };
  readonly lifecycle: { readonly closed: boolean };
  readonly emit: (event: AgentEvent) => Promise<void>;
}
