import type { ForgeReadHandler } from "../agent-tools/pwragent-forge-agent-tools";
import type { ForgePrToolHandler, ForgePrToolPreflight } from "../agent-tools/pwragent-forge-pr-agent-tools";
import type { ForgeAgentToolPolicy } from "@pwragent/shared";
import type {
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  AppServerBackendKind,
  CreateScheduledThreadActionRequest,
  ScheduledThreadActionMutationResponse,
  PwrAgentThreadInspectionResponse,
} from "@pwragent/shared";
import type { AutomationInspectionHandler } from "../automations/automation-inspection-codex-tools";
import type { PwrAgentAppManagementHandler } from "../agent-tools/pwragent-app-agent-tools";
import type {
  PwrAgentFederatedThreadInspectionHandler,
  PwrAgentFederatedThreadMutationHandler,
} from "../agent-tools/pwragent-thread-agent-tools";
import type {
  PwrAgentFederatedThreadControlHandler,
  PwrAgentFederatedThreadMessageHandler,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import type { PwrAgentStarMapHandler } from "../agent-tools/pwragent-star-map-agent-tools";
import type { PwrAgentThreadTodoHandler } from "../agent-tools/pwragent-thread-todo-agent-tools";
import type { MessagingAgentToolService } from "../messaging/messaging-agent-tool-service";
import type {
  AgentThreadActions,
  DirectoryGitStatusWriter,
  ForgeToolRuleWriter,
  LocalPullRequestAuthorityResolver,
  MessagingArchiveCleaner,
  ProjectForgeAutomationHandler,
  PullRequestReferenceResolver,
  ThreadGitWorkingStateRefreshHandler,
  ThreadMaintenanceToolHandler,
  ThreadPrAutoDispatchHandler,
  ThreadPrWatchesPeerHandler,
  ThreadPullRequestCanonicalizer,
  ThreadPullRequestDetachHandler,
  ThreadPullRequestRefreshHandler,
  ThreadPullRequestStatusToolHandler,
  ThreadPullRequestWatchToolHandler,
} from "./backend-registry-types";

/** Bindings whose owners may be constructed before the registry. */
export interface RegistryHandlers {
  localForgeReadHandler?: ForgeReadHandler;
  forgeReadHandler?: ForgeReadHandler;
  forgePrToolHandler?: ForgePrToolHandler;
  forgePrToolPreflight?: ForgePrToolPreflight;
  forgeToolPolicyResolver?: () => ForgeAgentToolPolicy;
  forgeToolRuleWriter?: ForgeToolRuleWriter;
  forgeProjectLabelResolver?: (repository: string) => Promise<string | undefined>;
  createScheduledThreadActionFn?: (
    request: CreateScheduledThreadActionRequest,
    options: { id: string },
  ) => Promise<ScheduledThreadActionMutationResponse>;
  messagingArchiveCleaner?: MessagingArchiveCleaner | null;
  messagingAgentToolService?: MessagingAgentToolService;
  automationInspectionHandler?: AutomationInspectionHandler;
  appManagementHandler?: PwrAgentAppManagementHandler;
  federationHandler?: PwrAgentFederationHandler;
  starMapIntakeFederationHandlerFactory?: ((attachments: AppServerTurnInputItem[]) => PwrAgentFederationHandler);
  agentThreadActions?: AgentThreadActions;
  starMapHandler?: PwrAgentStarMapHandler;
  threadTodoHandler?: PwrAgentThreadTodoHandler;
  federatedThreadMessageHandler?: PwrAgentFederatedThreadMessageHandler;
  federatedThreadInspectionHandler?: PwrAgentFederatedThreadInspectionHandler;
  federatedThreadMutationHandler?: PwrAgentFederatedThreadMutationHandler;
  federatedThreadControlHandler?: PwrAgentFederatedThreadControlHandler;
  threadPullRequestStatusToolHandler?: ThreadPullRequestStatusToolHandler;
  threadPullRequestCanonicalizer?: ThreadPullRequestCanonicalizer;
  pullRequestReferenceResolver?: PullRequestReferenceResolver;
  threadProjectRepositoryResolver?: (backend: AppServerBackendKind, threadId: string) => Promise<string | undefined>;
  threadPrimaryGitRepositoryReader?: (backend: AppServerBackendKind, threadId: string) => string;
  localPullRequestAuthorityResolver?: LocalPullRequestAuthorityResolver;
  threadPullRequestWatchToolHandler?: ThreadPullRequestWatchToolHandler;
  threadMaintenanceToolHandler?: ThreadMaintenanceToolHandler;
  threadDependencyToolHandler?: ((args: import("@pwragent/shared").ManageThreadDependenciesRequest, provenance?: Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">, actor?: string) => Promise<PwrAgentThreadInspectionResponse>);
  agentFollowUpToolHandler?: AgentFollowUpToolHandler;
  directoryGitStatusWriter?: DirectoryGitStatusWriter;
  threadPrAutoDispatchHandler?: ThreadPrAutoDispatchHandler;
  threadPullRequestDetachHandler?: ThreadPullRequestDetachHandler;
  threadDependenciesPeerHandler?: (
    request: import("@pwragent/shared").ManageThreadDependenciesRequest,
    requesterInstanceId: string | undefined,
    provenance?: import("@pwragent/shared").CausalMessagingContext,
  ) => Promise<import("@pwragent/shared").ManageThreadDependenciesResponse>;
  threadPrWatchesPeerHandler?: ThreadPrWatchesPeerHandler;
  projectForgeAutomationHandler?: ProjectForgeAutomationHandler;
  threadPullRequestRefreshHandler?: ThreadPullRequestRefreshHandler;
  threadGitWorkingStateRefreshHandler?: ThreadGitWorkingStateRefreshHandler;
}

/**
 * `schedule_follow_up` for the calling thread. `thread` comes from the tool
 * call's trusted context and `provenance` from that turn's stored origin;
 * neither is a tool argument.
 */
export type AgentFollowUpToolHandler = (
  args: import("@pwragent/shared").ScheduleFollowUpToolArgs,
  thread: { backend: AppServerBackendKind; threadId: string },
  provenance: Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">,
) => Promise<PwrAgentThreadInspectionResponse>;
